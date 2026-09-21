"""自动出库执行器：导出聚水潭销售出库单 → 落到本地 → 复用 ERP 现有导入链路建出库单。

设计要点：
- 复用现有导入链路（routers/imports.py 的 parse_jushuitan_draft + _confirm_orders），
  不另写一套解析/结算逻辑，避免两套口径不一致；
- 导入前按「出库单号」去重（现有导入没有幂等，重复上传会重复建单）：
  出库单号只写在 remark 里（"聚水潭导入 单XXX …"），所以按草稿涉及的日期取 remark 反查；
- 整个执行过程有全局锁，定时与手动不会并发跑；运行状态放 STATE 供前端轮询；
- 定时调度用守护线程（与 maintenance.ActivityStore 一致的做法），每 20 秒检查一次到点未执行的任务，
  已执行的定时点记在设置文件里，服务重启也不会在同一分钟内重复执行。
"""

from __future__ import annotations

import io
import logging
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from ..database import DATA_DIR, get_sessionmaker, get_warehouses
from ..models import Outbound, User
from . import settings as st
from .client import BASE_URL, JstSession, NotLoggedIn
from .config import JstConfig, parse_datetime, parse_schedule, resolve_window
from .exporter import EXPORT_PAGE_PATH, SALEOUT_PATH, PAGE_QUERY, ExportError, Exporter
from .login import LoginError, login, parse_warehouses

log = logging.getLogger("jst")


def _ensure_logger() -> None:
    """给 jst 日志挂一个 handler。

    默认情况下 INFO 级日志没人接收（uvicorn 只配自己的 logger），
    自动出库是在后台跑的，日志看不到就没法排查，所以这里自己挂一个并输出到服务日志。
    """
    if not log.handlers:
        h = logging.StreamHandler()
        h.setFormatter(logging.Formatter("[自动出库] %(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S"))
        log.addHandler(h)
    log.setLevel(logging.INFO)
    log.propagate = False


_ensure_logger()

SALEOUT_URL = f"{BASE_URL}{SALEOUT_PATH}{PAGE_QUERY}"
EXPORT_DIR_NAME = "jst_exports"  # backend/data/jst_exports/<分仓 key>/

# 出库单号在备注里的形态：f"聚水潭导入 单{doc_no} {快递}{单号}"
_DOC_NO_RE = re.compile(r"聚水潭导入\s*单(\S+)")

_JOB_LOCK = threading.Lock()  # 同一时间只允许一轮自动出库
_STATE_LOCK = threading.Lock()
STATE: dict[str, Any] = {
    "running": False,
    "warehouse": "",
    "trigger": "",
    "step": "",
    "started_at": "",
    "last": {},  # 最近一轮结果（含明细）
}


class _NamedUser:
    """设置里填的操作员在库里找不到时的兜底身份（只用到 .name）。"""

    def __init__(self, name: str):
        self.name = name


class _UploadShim:
    """给 imports.read_rows 用的最小文件对象（它只访问 .file）。"""

    def __init__(self, path: Path):
        self.file = io.BytesIO(path.read_bytes())
        self.filename = path.name


# ---------------------------------------------------------------- 状态
def _set_state(**kw) -> None:
    with _STATE_LOCK:
        STATE.update(kw)


def status() -> dict[str, Any]:
    with _STATE_LOCK:
        out = dict(STATE)
    out["scheduler"] = scheduler_alive()
    return out


def _update_last(patch: dict[str, Any]) -> None:
    with _STATE_LOCK:
        STATE["last"] = patch


# ---------------------------------------------------------------- 配置组装
def _build_config(key: str, target_co_id: str, out_dir: Path) -> JstConfig:
    d = st.load()
    g = st.globals_of(d)
    wh = st.wh_of(d, key)
    return JstConfig(
        cookie=g.get("cookie") or "",
        account=g.get("account") or "",
        password=g.get("password") or "",
        owner_co_id=g.get("owner_co_id") or "",
        authorize_co_id=target_co_id,
        output_dir=out_dir,
        window=wh.get("window") or "yesterday",
        fixed_range=_fixed_range(wh),
        io_date_field=g.get("io_date_field") or "io_date",
        min_interval=float(g.get("min_interval") or 10),
        timeout=float(g.get("timeout") or 120),
        max_retries=int(g.get("max_retries") or 3),
        schedule=_safe_schedule(wh.get("schedule") or []),
        filename_template=g.get("filename_template") or "销售出库单_{start:%Y%m%d}_{authorize_co_id}.xlsx",
    )


def _safe_schedule(slots: list[str]):
    try:
        return parse_schedule(slots)
    except ValueError as e:
        log.warning("定时时间配置有问题，本次忽略：%s", e)
        return []


def _fixed_range(wh: dict[str, Any]) -> tuple[datetime, datetime] | None:
    """固定区间（补数据用）：两个都填才生效。"""
    raw_from = (wh.get("fixed_from") or "").strip()
    raw_to = (wh.get("fixed_to") or "").strip()
    if not raw_from or not raw_to:
        return None
    start, end = parse_datetime(raw_from), parse_datetime(raw_to)
    if start >= end:
        raise ValueError(f"固定区间起止时间不对：{raw_from} 必须早于 {raw_to}")
    return start, end


def resolve_range(wh: dict[str, Any], window: str | None = None, now: datetime | None = None):
    """本次导出的时间区间：固定区间优先，其次定时点自带的规则，最后分仓默认规则。"""
    fixed = _fixed_range(wh)
    if fixed:
        return fixed
    return resolve_window(window or wh.get("window") or "yesterday", now or datetime.now())


def export_dir(key: str) -> Path:
    return DATA_DIR / EXPORT_DIR_NAME / key


# ---------------------------------------------------------------- 登录态 / 分仓
def check_login() -> dict[str, Any]:
    """检查聚水潭登录态（Cookie 有效则返回 ok）。"""
    d = st.load()
    g = st.globals_of(d)
    if not g.get("cookie") and not (g.get("account") and g.get("password")):
        return {"ok": False, "message": "还没配置聚水潭账号密码或 Cookie"}
    session = JstSession(
        g.get("cookie") or "",
        float(g.get("min_interval") or 10),
        float(g.get("timeout") or 120),
        relogin=_relogin(g),
    )
    try:
        resp = session.get(SALEOUT_URL)
        JstSession.ensure_logged_in(resp)
        return {
            "ok": True,
            "message": "登录态正常，可以正常导出销售出库单",
            "cookie_refreshed": session.cookie != (g.get("cookie") or ""),
        }
    except NotLoggedIn as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:  # noqa: BLE001 - 网络异常也按"检查失败"返回
        return {"ok": False, "message": f"检查失败：{e}"}
    finally:
        session.close()


def fetch_jst_warehouses() -> dict[str, Any]:
    """拉取聚水潭账号可见的分仓列表（供设置里勾选）。"""
    d = st.load()
    g = st.globals_of(d)
    session = JstSession(
        g.get("cookie") or "",
        float(g.get("min_interval") or 10),
        float(g.get("timeout") or 120),
        relogin=_relogin(g),
    )
    try:
        resp = session.get(SALEOUT_URL)
        JstSession.ensure_logged_in(resp)
        resp.raise_for_status()
        items = parse_warehouses(resp.text)
        return {"ok": True, "warehouses": [{"co_id": w.co_id, "name": w.name} for w in items]}
    except (NotLoggedIn, LoginError) as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"拉取失败：{e}"}
    finally:
        session.close()


def _relogin(g: dict[str, Any]):
    """构造续登回调：成功后把新 Cookie 写回设置。"""
    account, password = g.get("account") or "", g.get("password") or ""
    if not (account and password):
        return None
    from .login import build_relogin

    base = build_relogin(account, password, g.get("cookie") or "", timeout=float(g.get("timeout") or 120))
    if base is None:
        return None

    def _do() -> str:
        cookie = base()
        st.set_cookie(cookie)
        return cookie

    return _do


# ---------------------------------------------------------------- 导入
def _operator_user(db, name: str):
    """落库用的操作员：设置里指定的 → 第一个管理员 → 兜底只有名字的对象。"""
    if name:
        u = db.scalar(select(User).where(User.name == name))
        if u:
            return u
    u = db.scalars(select(User).where(User.role == "admin").order_by(User.id)).first()
    return u or _NamedUser(name or "自动出库")


def imported_doc_nos(db, dates: set[str]) -> set[str]:
    """找出这些日期里已经导入过的聚水潭出库单号（从出库单备注里反查）。"""
    if not dates:
        return set()
    rows = db.execute(select(Outbound.remark).where(Outbound.date.in_(sorted(dates)))).scalars()
    found: set[str] = set()
    for remark in rows:
        m = _DOC_NO_RE.search(remark or "")
        if m:
            found.add(m.group(1))
    return found


def import_file(key: str, path: Path, operator: str = "", skip_imported: bool = True) -> dict[str, Any]:
    """把一个聚水潭导出的 xlsx 导入指定分仓（复用现有导入链路）。"""
    from ..routers.imports import _confirm_orders, parse_jushuitan_draft

    maker = get_sessionmaker(key)
    db = maker()
    try:
        user = _operator_user(db, operator)
        drafts, failed, skip, unmapped_codes, unmapped_list, unmatched_multi = parse_jushuitan_draft(
            _UploadShim(path), db, user
        )
        dup: list[str] = []
        if skip_imported and drafts:
            done = imported_doc_nos(db, {o.date for o in drafts if o.date})
            keep = []
            for o in drafts:
                (dup if (o.doc_no and o.doc_no in done) else keep).append(o)
            drafts = keep
        res = _confirm_orders(db, user, drafts) if drafts else {"created": 0, "failed": [], "warnings": []}
        return {
            "orders": len(drafts) + len(dup),
            "drafted": len(drafts),
            "created": res.get("created", 0),
            "duplicate_skipped": len(dup),
            "status_skipped": skip if isinstance(skip, dict) else {},
            "failed": (failed or []) + (res.get("failed") or []),
            "warnings": res.get("warnings") or [],
            "unmapped": sorted(unmapped_codes or []),
            "unmatched_multi": len(unmatched_multi or []),
            "operator": getattr(user, "name", "") or "",
        }
    finally:
        db.close()


# ---------------------------------------------------------------- 主流程
def run_once(
    key: str,
    *,
    target_co_ids: list[str] | None = None,
    window: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    trigger: str = "手动",
    do_import: bool | None = None,
) -> dict[str, Any]:
    """跑一轮：导出所有勾选的聚水潭分仓 → （可选）导入当前 ERP 分仓。

    do_import=None 表示按分仓设置里的 auto_import；False 时只下载不建单（用于试跑）。
    """
    if not _JOB_LOCK.acquire(blocking=False):
        return {"ok": False, "message": "已有一轮自动出库在跑，请稍后再试"}

    started = datetime.now()
    _set_state(running=True, warehouse=key, trigger=trigger, step="准备中", started_at=started.strftime("%Y-%m-%d %H:%M:%S"))
    result: dict[str, Any] = {
        "at": started.strftime("%Y-%m-%d %H:%M:%S"),
        "trigger": trigger,
        "ok": False,
        "warehouse": key,
        "warehouse_name": _wh_name(key),
        "targets": [],
        "files": [],
        "message": "",
        "stats": {},
    }
    try:
        d = st.load()
        wh = st.wh_of(d, key)
        targets = wh.get("targets") or []
        if target_co_ids:
            wanted = {str(c) for c in target_co_ids}
            targets = [t for t in targets if str(t.get("co_id")) in wanted] or [
                {"co_id": str(c), "name": ""} for c in target_co_ids
            ]
        if not targets:
            raise ValueError("这个分仓还没勾选要导入的聚水潭分仓，请先在「自动出库设置」里设置")

        if start and end:
            rng = (start, end)
        else:
            rng = resolve_range(wh, window)
        result["window"] = f"{rng[0]:%Y-%m-%d %H:%M} ~ {rng[1]:%Y-%m-%d %H:%M}"

        out_dir = export_dir(key)
        files: list[Path] = []
        for t in targets:
            co_id = str(t.get("co_id"))
            name = t.get("name") or co_id
            _set_state(step=f"正在导出聚水潭分仓「{name}」…")
            cfg = _build_config(key, co_id, out_dir)
            with Exporter(cfg, on_cookie=st.set_cookie) as exporter:
                files.append(exporter.export_with_retries(*rng))
            result["targets"].append({"co_id": co_id, "name": name, "file": files[-1].name})

        result["files"] = [f.name for f in files]
        should_import = wh.get("auto_import", True) if do_import is None else do_import
        if should_import:
            agg: dict[str, Any] = {"orders": 0, "created": 0, "duplicate_skipped": 0, "failed": [], "unmapped": set()}
            status_skipped: dict[str, int] = {}
            for f in files:
                _set_state(step=f"正在导入 {f.name} …")
                stt = import_file(key, f, operator=wh.get("operator") or "", skip_imported=wh.get("skip_imported", True))
                agg["orders"] += stt.get("orders", 0)
                agg["created"] += stt.get("created", 0)
                agg["duplicate_skipped"] += stt.get("duplicate_skipped", 0)
                agg["failed"] += stt.get("failed") or []
                agg["unmapped"] |= set(stt.get("unmapped") or [])
                for k, v in (stt.get("status_skipped") or {}).items():
                    status_skipped[k] = status_skipped.get(k, 0) + int(v or 0)
            agg["unmapped"] = sorted(agg["unmapped"])
            agg["status_skipped"] = status_skipped
            result["stats"] = agg
            result["ok"] = True
            result["message"] = (
                f"导出 {len(files)} 个文件，新建出库单 {agg['created']} 张"
                + (f"，跳过重复 {agg['duplicate_skipped']} 张" if agg["duplicate_skipped"] else "")
                + (f"，未关联商品 {len(agg['unmapped'])} 种" if agg["unmapped"] else "")
                + (f"，失败 {len(agg['failed'])} 条" if agg["failed"] else "")
            )
        else:
            result["ok"] = True
            result["message"] = f"已导出 {len(files)} 个文件（按设置未自动导入）"
    except (ExportError, NotLoggedIn, LoginError, ValueError) as e:
        result["message"] = str(e)
    except Exception as e:  # noqa: BLE001 - 任何异常都要落到执行记录里，不能只进日志
        log.exception("自动出库执行失败")
        result["message"] = f"{type(e).__name__}: {e}"
    finally:
        if not result["stats"]:
            result.pop("stats", None)
        st.record_run(key, result)
        _update_last(result)
        _set_state(running=False, step="", warehouse="", trigger="")
        _JOB_LOCK.release()
        log.info("自动出库[%s] %s：%s", trigger, key, result.get("message"))
    return result


def _wh_name(key: str) -> str:
    for w in get_warehouses():
        if w.get("key") == key:
            return w.get("name") or key
    return key


# ---------------------------------------------------------------- 定时调度
_scheduler_started = False
_sched_lock = threading.Lock()


def start_scheduler() -> None:
    """启动定时调度守护线程（幂等）。"""
    global _scheduler_started
    with _sched_lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    threading.Thread(target=_loop, name="jst-auto-scheduler", daemon=True).start()
    log.info("定时调度已启动（每 20 秒检查一次）")


def scheduler_alive() -> bool:
    """调度线程是否活着（设置页与 /status 用它显示「定时调度：运行中/未启动」）。"""
    if not _scheduler_started:
        return False
    return any(t.name == "jst-auto-scheduler" and t.is_alive() for t in threading.enumerate())


def _loop() -> None:
    while True:
        try:
            _tick(datetime.now())
        except Exception as e:  # noqa: BLE001 - 调度线程不能因单次异常退出
            log.warning("自动出库调度检查出错：%s", e)
        time.sleep(20)


def _tick(now: datetime) -> None:
    day = f"{now:%Y-%m-%d}"
    d = st.load()
    for key in list((d.get("warehouses") or {}).keys()):
        wh = st.wh_of(d, key)
        if not wh.get("enabled") or not wh.get("targets"):
            continue
        try:
            slots = parse_schedule(wh.get("schedule") or [])
        except ValueError as e:
            log.warning("分仓 %s 的定时时间配置有问题：%s", key, e)
            continue
        for slot in slots:
            if (now.hour, now.minute) != (slot.hour, slot.minute):
                continue
            stamp = f"{day} {slot.hour:02d}:{slot.minute:02d}"
            if not st.mark_slot(key, stamp, day):
                continue  # 这一分钟内已经跑过（或服务刚重启但已记录）
            log.info("到点触发自动出库：%s %s（区间规则 %s）", key, stamp, slot.window or wh.get("window"))
            threading.Thread(
                target=run_once,
                args=(key,),
                kwargs={"window": slot.window or None, "trigger": "定时"},
                name=f"jst-auto-run-{key}",
                daemon=True,
            ).start()
    st.prune_slots(day)
