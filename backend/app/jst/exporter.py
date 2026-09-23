"""聚水潭销售出库单导出。

实测流程（对应 HAR 中的请求链）：
  1. GET  /app/wms/saleout/saleout.aspx            -> 取 __VIEWSTATE / __VIEWSTATEGENERATOR
  2. POST /app/wms/saleout/saleout.aspx?am___=ExportSaleOut
                                                   -> 返回导出令牌 JTable:<uid>-<hash>
  3. GET  /app/wms/saleout/ExportSaleoutV2.aspx?s=<令牌>
                                                   -> 302 到 www-do.erp321.com
  4. GET  www-do.erp321.com/.../ExportSaleoutV2.aspx?s=<令牌>
                                                   -> 302 到 OSS 签名地址（xlsx）
  5. GET  OSS 地址                                  -> 真正的 Excel 文件

移植自 AutoExp_ERP321/src/jst_export/exporter.py。唯一改动：新 Cookie 不再写 .env，
改为回调 on_cookie 交给 runner 写回「自动出库设置」。
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

from ._http import httpx
from .client import BASE_URL, JstSession, NotLoggedIn
from .config import JstConfig
from .login import CaptchaRequired, LoginError, build_relogin

log = logging.getLogger(__name__)

SALEOUT_PATH = "/app/wms/saleout/saleout.aspx"
EXPORT_PAGE_PATH = "/app/wms/saleout/ExportSaleoutV2.aspx"
PAGE_QUERY = "?_c=jst-epaas&epaas=true"

_VIEWSTATE_RE = re.compile(r'id="__VIEWSTATE" value="([^"]*)"')
_VIEWGEN_RE = re.compile(r'id="__VIEWSTATEGENERATOR" value="([^"]*)"')
_TOKEN_RE = re.compile(r'"ReturnValue":"(JTable:[^"]+)"')
_MOVED_RE = re.compile(r'href="([^"]+)"')
_TIME_FMT = "%Y-%m-%d %H:%M:%S"

# 基础表单字段，取自 HAR 中 ExportSaleOut 的真实请求体
_BASE_FIELDS = {
    "set_type": "1",
    "l_id2": "", "l_id4": "", "sorted_ioids": "", "is_tpw_wms": "0", "insurePrice": "",
    "o_id": "", "sku_id": "", "lc_ids": "", "lc_id_dom": "", "status": "", "is_weight": "",
    "labels": "", "nolabels": "", "seller_flag": "", "node": "", "is_print_express": "",
    "is_print": "", "shop_name": "", "receiver_nameCtrl": "", "remark": "", "outer_so_id": "",
    "platformId": "", "print_count": "", "drp_co_id_id": "", "drp_co_id": "", "sku_count": "",
    "sWeight": "", "bWeight": "", "receiver_state": "", "carryId": "", "wms_co_id_select_id": "",
    "wms_co_id_select": "", "cus_id": "", "cus": "", "creator": "", "goodType": "skus",
    "has_ipc": "", "_jt_page_count_enabled": "", "_jt_page_increament_enabled": "true",
    "_jt_page_increament_page_mode": "", "_jt_page_increament_key_value": "",
    "_jt_page_increament_business_values": "", "_jt_page_increament_key_name": "io_id",
    "_jt_page_size": "500", "receiver_city": "", "receiver_district": "", "receiver_address": "",
    "receiver_name": "", "receiver_phone": "", "receiver_mobile": "", "check_name": "",
    "check_address": "", "_cbb_lc_id_dom": "", "_cbb_status": "", "_cbb_shop_name": "",
    "_cbb_receiver_state": "", "_cbb_wms_co_id_select": "", "_cbb_cus": "",
    "__CALLBACKID": "JTable1",
}


class ExportError(RuntimeError):
    pass


# 聚水潭「导出出库单要先过短信验证」的识别：
# 返回 IsSuccess=false，且 Message=910001（msg 为「导出出库单要求验证身份，已发送验证码到您手机…」）。
# 这类不是程序错误，而是要人工介入（填验证码 / 换 Cookie），必须归到「待办」而不是普通导出失败。
_CAPTCHA_CODES = ("910001",)
_CAPTCHA_MARKERS = ("验证码", "验证身份", "身份验证")
_MSG_RE = re.compile(r'"msg":"([^"]*)"')


def _captcha_hint(text: str) -> str | None:
    """识别「要求短信验证」的返回并给出提示文案；不是这种情况返回 None。"""
    code_hit = any(f'"Message":"{c}"' in text for c in _CAPTCHA_CODES)
    m = _MSG_RE.search(text)
    hint = (m.group(1) if m else "").strip()
    if not code_hit and not any(k in hint for k in _CAPTCHA_MARKERS):
        return None
    return hint or "聚水潭要求验证身份"


def make_relogin(cfg: JstConfig, on_cookie: Callable[[str], None] | None = None):
    """Cookie 失效时用账号密码换一套新的，并通过 on_cookie 回调持久化。

    未配置账号密码时返回 None，此时 Cookie 失效只能人工处理。
    """
    base = build_relogin(cfg.account, cfg.password, cfg.cookie, timeout=cfg.timeout,
                         verify_code=getattr(cfg, "verify_code", "") or "")
    if base is None:
        return None

    def _relogin() -> str:
        cookie = base()
        cfg.cookie = cookie
        if on_cookie is not None:
            try:
                on_cookie(cookie)
            except Exception as e:  # noqa: BLE001 - 写盘失败不该让导出失败
                log.warning("新 Cookie 写回设置失败：%s", e)
        else:
            log.info("已获取新 Cookie（未持久化）")
        return cookie

    return _relogin


class Exporter:
    def __init__(
        self,
        cfg: JstConfig,
        session: JstSession | None = None,
        on_cookie: Callable[[str], None] | None = None,
    ):
        self.cfg = cfg
        if session is not None:
            self._session = session
            self._owns_session = False
        else:
            self._session = JstSession(
                cfg.cookie, cfg.min_interval, cfg.timeout, relogin=make_relogin(cfg, on_cookie)
            )
            self._owns_session = True

    def __enter__(self) -> "Exporter":
        return self

    def __exit__(self, *exc) -> None:
        if self._owns_session:
            self._session.close()

    # ---------- 步骤 1：取表单隐藏字段 ----------
    def _load_viewstate(self) -> tuple[str, str]:
        resp = self._session.get(BASE_URL + SALEOUT_PATH + PAGE_QUERY)
        JstSession.ensure_logged_in(resp)
        resp.raise_for_status()
        vs = _VIEWSTATE_RE.search(resp.text)
        vg = _VIEWGEN_RE.search(resp.text)
        if not vs or not vg:
            raise ExportError("未能从出库单页面解析出 __VIEWSTATE，页面结构可能已变更")
        return vs.group(1), vg.group(1)

    # ---------- 步骤 2：创建导出（返回导出令牌） ----------
    def create_export_task(self, start: datetime, end: datetime) -> str:
        viewstate, viewgen = self._load_viewstate()

        filters = [
            {"k": self.cfg.io_date_field, "v": start.strftime(_TIME_FMT), "c": ">="},
            {"k": self.cfg.io_date_field, "v": end.strftime(_TIME_FMT), "c": "<"},
        ]
        export_par = {
            "Filter": json.dumps(filters, separators=(",", ":")),
            "CheckIoIds": [],
            "Flag": self.cfg.flag,
            "CheckoutAfterSend": [],
            "IsExportSonInouts": False,
            "IsExportNoTask": True,
        }
        callback = {
            "Method": "ExportSaleOut",
            "Args": [json.dumps(export_par, separators=(",", ":"))],
            "CallControl": "{page}",
        }

        data = dict(_BASE_FIELDS)
        data.update({
            "__VIEWSTATE": viewstate,
            "__VIEWSTATEGENERATOR": viewgen,
            "owner_co_id": self.cfg.owner_co_id,
            "authorize_co_id": self.cfg.authorize_co_id,
            "__CALLBACKPARAM": json.dumps(callback, separators=(",", ":")),
        })

        url = f"{BASE_URL}{SALEOUT_PATH}{PAGE_QUERY}&ts___={int(time.time() * 1000)}&am___=ExportSaleOut"
        resp = self._session.post(url, data=data)
        JstSession.ensure_logged_in(resp)
        resp.raise_for_status()

        if '"IsSuccess":false' in resp.text:
            hint = _captcha_hint(resp.text)
            if hint:
                # 要人工过短信验证：交给 runner 生成「待办」（填验证码 / 粘 Cookie），不要当普通失败吞掉
                raise CaptchaRequired(
                    f"聚水潭要求短信验证（导出出库单）：{hint}"
                    " —— 处理方式：① 直接把验证码填进「待办」后点重跑（会带着验证码先重新登录，再导出）；"
                    "② 或在浏览器登录聚水潭、手动导出一次并输入验证码后，把该会话的 Cookie 粘到「待办」里（最稳）"
                )
            raise ExportError(f"创建导出任务失败：{resp.text[:300]}")
        match = _TOKEN_RE.search(resp.text)
        if not match:
            raise ExportError(f"未能解析导出令牌，返回内容：{resp.text[:300]}")
        token = match.group(1)
        log.info("导出任务已创建，令牌 %s（区间 %s ~ %s）", token, start, end)
        return token

    # ---------- 步骤 3~5：取文件 ----------
    def fetch_file(self, token: str) -> tuple[bytes, str]:
        params = {
            "s": token,
            "owner_co_id": self.cfg.owner_co_id,
            "authorize_co_id": self.cfg.authorize_co_id,
        }
        url = BASE_URL + EXPORT_PAGE_PATH
        resp = self._session.get(url, params=params)

        # 首次可能直接 302，也可能先返回"正在生成"的页面
        target = None
        for attempt in range(1, self.cfg.max_retries + 1):
            JstSession.ensure_logged_in(resp, redirect_ok=True)
            target = self._extract_redirect(resp)
            if target:
                break
            log.info("导出文件尚未生成，%ds 后重试（%d/%d）", int(self.cfg.min_interval), attempt, self.cfg.max_retries)
            if attempt == self.cfg.max_retries:
                raise ExportError(f"导出文件生成超时，最后一次响应：{resp.text[:300]}")
            time.sleep(self.cfg.min_interval)
            resp = self._session.get(url, params=params)

        log.info("导出文件地址已下发，开始下载")
        download = self._session.get(
            target,
            headers={"referer": BASE_URL + SALEOUT_PATH + PAGE_QUERY},
            follow_redirects=True,
        )
        JstSession.ensure_logged_in(download, redirect_ok=True)
        download.raise_for_status()

        content_type = download.headers.get("content-type", "")
        if "html" in content_type and not download.content.startswith(b"PK"):
            raise ExportError(f"下载到的不是 Excel 文件：{download.text[:300]}")

        filename = self._extract_filename(download, target)
        return download.content, filename

    @staticmethod
    def _extract_redirect(resp: httpx.Response) -> str | None:
        location = resp.headers.get("location")
        if location:
            return location
        if resp.status_code == 200 and "text/html" in resp.headers.get("content-type", ""):
            match = _MOVED_RE.search(resp.text)
            if match:
                return match.group(1).replace("&amp;", "&")
        return None

    @staticmethod
    def _extract_filename(resp: httpx.Response, fallback_url: str) -> str:
        disposition = resp.headers.get("content-disposition", "")
        match = re.search(r"filename=([^;]+)", disposition)
        if match:
            return unquote(match.group(1).strip().strip('"'))
        return unquote(Path(urlparse(fallback_url).path).name)

    # ---------- 对外入口 ----------
    def export(self, start: datetime, end: datetime) -> Path:
        token = self.create_export_task(start, end)
        content, remote_name = self.fetch_file(token)

        self.cfg.output_dir.mkdir(parents=True, exist_ok=True)
        if self.cfg.keep_raw_name:
            name = remote_name
        else:
            try:
                name = self.cfg.filename_template.format(
                    start=start, end=end,
                    authorize_co_id=self.cfg.authorize_co_id,
                    owner_co_id=self.cfg.owner_co_id,
                )
            except (KeyError, IndexError, ValueError) as e:  # 模板写错不该让导出失败
                log.warning("文件名模板 %r 不可用（%s），改用聚水潭原始文件名", self.cfg.filename_template, e)
                name = remote_name
        path = self.cfg.output_dir / name
        path.write_bytes(content)
        log.info("已保存 %s（%.1f KB）", path, len(content) / 1024)
        return path

    def export_with_retries(self, start: datetime, end: datetime) -> Path:
        last_error: Exception | None = None
        relogged = False  # 同一次导出最多续登一次，避免拿新 Cookie 反复登录
        # 「待办」里人工填了验证码：先带着它重新登录一次再导出。
        # 聚水潭要求短信验证时（登录 301105/301109、导出 910001 是同一套安全校验），
        # 验证码就是登录接口的 verifyCode；如果只在 Cookie 失效时才续登，用户填的码就永远用不上。
        # 登录不成功（比如码不适用于登录）不算致命：保留原 Cookie 继续走正常导出，失败信息照样进待办。
        if self.cfg.verify_code:
            try:
                if self._session.relogin():
                    relogged = True
                    log.info("已带「待办」里人工填写的验证码重新登录，继续导出")
            except Exception as e:  # noqa: BLE001 - 登录不成功不该直接失败：原 Cookie 还能继续试，失败信息照样进待办
                log.warning("带「待办」验证码重新登录未成功：%s（保留原 Cookie 继续导出）", e)
        for attempt in range(1, self.cfg.max_retries + 1):
            try:
                return self.export(start, end)
            except NotLoggedIn as exc:
                last_error = exc
                if relogged:
                    raise
                if not self._session.relogin():
                    raise
                relogged = True
                log.warning("Cookie 已失效并完成自动续登，重试导出")
            except CaptchaRequired:
                # 需要人工过验证码：重试只会再发一条短信，还会把「待办」需要的信息吞掉，直接上报
                raise
            except Exception as exc:  # noqa: BLE001 - 网络抖动等一律重试
                last_error = exc
                log.warning("第 %d/%d 次导出失败：%s", attempt, self.cfg.max_retries, exc)
                if attempt < self.cfg.max_retries:
                    time.sleep(self.cfg.min_interval)
        raise ExportError(f"导出失败，已重试 {self.cfg.max_retries} 次：{last_error}")
