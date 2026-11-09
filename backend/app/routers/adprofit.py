"""广告利润：在 ERP 财务报表口径上叠加挂载服务（jdfenxi）的 CPS / 京准通花费。

数据来源
--------
财务数据  ERP 本仓（或全仓合计）的报表口径：直接复用 report._summary_of / _summary_all，
          与「财务报表」页完全同一套计算与缓存（同一个 _heavy_cached key）。
广告花费  挂载服务 jdfenxi（默认 http://127.0.0.1:18011，frp 隧道只绑本机）的「花费一览」本地缓存：
            /api/paycomm/cache       CPS 花费（付款佣金）
            /api/paycomm/spend/cache 京准通花费
          只读缓存，**不触发**京东抓取：没有缓存的区间由前端提示去 jdfenxi 抓一次。

口径
----
    广告费合计 = CPS 花费 + 京准通花费
    广告后毛利 = 毛利 − 广告费合计
    广告后净利 = 净利润 − 广告费合计

广告费按店铺账号汇总。缓存是「一次抓取 = 一个账号 + 一个区间」的落地文件，
本接口只累加「能正好拼满所选区间」的缓存段（与 jdfenxi 月度利润页的读缓存规则一致），
拼不满的日期单列为缺口，绝不用区间外的数据凑数。
"""
from __future__ import annotations

import io
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import DATA_DIR, get_db_wh, get_sessionmaker, load_warehouses, resolve_key
from ..models import Product, User, WarehouseProduct
from .report import ALL_WH, _heavy_cached, _summary_all, _summary_of

router = APIRouter(prefix="/api", tags=["adprofit"])

# 挂载服务地址：只给后端到后端用（前端不接触这个内网端口）
AD_SERVICE_URL = os.getenv("ERP_AD_SERVICE_URL", "http://127.0.0.1:18011").rstrip("/")
AD_TIMEOUT = float(os.getenv("ERP_AD_TIMEOUT", "8"))

# 花费缓存清单变动不频繁：60 秒内复用，避免页面反复刷新时每次都打挂载服务
_AD_TTL = 60.0
_AD_CACHE: dict[str, tuple[float, object]] = {}

# 各缓存只在读取时判断 TTL、过期项从不删除，长跑下来条目只增不减；写入时顺带清扫并封顶。
_CACHE_MAX = 200

# 店铺账号 → 分仓 key 的对照表（余额表按仓算「广告充值预付余额」用）。
# 路径：backend/data/ad_account_wh.json，内容 {"main":"aosidi","b":"wh01",...}；
# 文件缺失 = 未配置，此时单仓余额表不计算广告预付（避免拿全公司花费去减单仓充值）。
AD_ACCOUNT_WH_FILE = DATA_DIR / "ad_account_wh.json"


def load_account_warehouses() -> dict[str, str]:
    """读取店铺账号 → 分仓 key 对照表；文件缺失/格式不对时返回空表。

    以 `_` 开头的键是说明性元数据（如 `_associations` 记录某店铺关联了哪几个仓），
    不参与金额分摊，读取时跳过。
    """
    try:
        data = json.loads(AD_ACCOUNT_WH_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 未配置属正常情况
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in data.items():
        key, wh = str(k or "").strip(), str(v or "").strip()
        if not key or key.startswith("_"):
            continue
        if key and wh:
            out[key] = wh
    return out


def _cache_put(cache: dict, key, value, ttl: float) -> None:
    now = time.time()
    for k in [k for k, (t, _) in cache.items() if now - t >= ttl]:
        cache.pop(k, None)
    cache[key] = (now, value)
    while len(cache) > _CACHE_MAX:
        oldest = min(cache, key=lambda k: cache[k][0])
        cache.pop(oldest, None)


def _ad_get(path: str):
    """读挂载服务的 JSON 接口；异常由调用方降级处理（不能拖垮 ERP 报表）。"""
    req = urllib.request.Request(
        AD_SERVICE_URL + path,
        headers={"Accept": "application/json", "User-Agent": "WSFC-ERP"},
    )
    with urllib.request.urlopen(req, timeout=AD_TIMEOUT) as resp:  # noqa: S310 - 固定内网地址
        return json.loads(resp.read().decode("utf-8"))


def _ad_cached(key: str, loader, refresh: bool = False):
    now = time.time()
    hit = _AD_CACHE.get(key)
    if not refresh and hit and now - hit[0] < _AD_TTL:
        return hit[1]
    got = loader()
    _cache_put(_AD_CACHE, key, got, _AD_TTL)
    return got


# 零花费缓存：jdfenxi 的「花费一览」清单只列有行的缓存，京准通 0 元时写的 noSpend 空表
# 不会出现在 /api/paycomm/spend/cache 里。ERP 之前因此一直把这类账号当成「缺缓存」反复补抓。
# 补抓时一旦确认某账号某区间是 0 元，就记到 data/ad_zero_spend.json，后续按「已覆盖、0 元」处理。
AD_ZERO_SPEND_FILE = DATA_DIR / "ad_zero_spend.json"
_ZERO_LOCK = threading.Lock()


def _load_zero_spans(kind: str) -> list[dict]:
    try:
        data = json.loads(AD_ZERO_SPEND_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    items = data.get(kind) if isinstance(data, dict) else None
    return items if isinstance(items, list) else []


def _save_zero_span(kind: str, account: str, start: str, end: str,
                    label: str = "", saved_at: str = "") -> None:
    """记录一个「确认 0 元」的账号区间（幂等）。"""
    with _ZERO_LOCK:
        try:
            data = json.loads(AD_ZERO_SPEND_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except Exception:  # noqa: BLE001
            data = {}
        items = data.get(kind) if isinstance(data.get(kind), list) else []
        items = [x for x in items if not (
            str(x.get("account")) == account and x.get("start") == start and x.get("end") == end
        )]
        items.append({
            "mode": kind, "account": account, "accountLabel": label or account,
            "start": start, "end": end, "rows": 0, "total": 0.0,
            "savedAt": saved_at or datetime.now().strftime("%Y-%m-%d %H:%M"),
            "zeroSpend": True,
        })
        data[kind] = items
        tmp = AD_ZERO_SPEND_FILE.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, AD_ZERO_SPEND_FILE)
        except Exception:  # noqa: BLE001
            pass


def _zero_entries(kind: str) -> list[dict]:
    """把已确认的 0 元区间补成缓存清单条目，让拼区间时把它们当成已覆盖。"""
    return [dict(x, zeroSpend=True) for x in _load_zero_spans(kind)]


def _load_entries(kind: str, refresh: bool = False) -> list[dict]:
    """花费缓存清单（按账号+区间去重）。kind: cps / spend。

    真实缓存优先；noSpend 空表（0 元）用本地 ad_zero_spend.json 补进来。
    """
    path = "/api/paycomm/cache" if kind == "cps" else "/api/paycomm/spend/cache"

    def _load():
        data = _ad_get(path)
        entries = data.get("entries") if isinstance(data, dict) else None
        return entries if isinstance(entries, list) else []

    entries = _ad_cached("entries:" + kind, _load, refresh)
    zeros = _zero_entries(kind)
    if not zeros:
        return entries
    # 同一账号+区间已经有真实缓存（非 0 元）时，以真实缓存为准
    real = {(str(e.get("account") or ""), e.get("start"), e.get("end")) for e in entries}
    merged = list(entries) + [
        z for z in zeros
        if (str(z.get("account") or ""), z.get("start"), z.get("end")) not in real
    ]
    return merged


def _load_accounts(refresh: bool = False) -> list[dict]:
    """挂载服务里配置的店铺账号（用于提示「有账号还没有花费缓存」）。"""
    def _load():
        data = _ad_get("/api/accounts")
        accounts = data.get("accounts") if isinstance(data, dict) else None
        return accounts if isinstance(accounts, list) else []

    return _ad_cached("accounts", _load, refresh)


# ---------------------------------------------------------------- 广告费流水（jdfenxi 财务记录）
# jdfenxi 的「广告费流水」页直接抓京准通账户中心 → 财务记录，包含每个账号的
# 当前可用余额、区间充值、区间消费、每日消耗与结余。余额表的「广告充值预付余额」
# 改为直接读这份数据，不再依赖 ERP 里手工登记的「广告费充值」。
_CASHFLOW_TTL = 300.0
_CASHFLOW_CACHE: dict[str, tuple[float, dict]] = {}
_CASHFLOW_LOCK = threading.Lock()


def _cash_date_iso(v) -> str:
    if hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    s = str(v or "").strip()
    return s[:10]


def _cash_num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _parse_cashflow_export(data: bytes) -> dict:
    """解析 jdfenxi /api/cashflow/export：账号汇总 + 每日流水 + 数据区间。"""
    from openpyxl import load_workbook

    accounts: dict[str, dict] = {}
    daily: dict[str, list] = {}
    range_start = range_end = ""
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            title = str(ws.title or "")
            rows = ws.iter_rows(min_row=1, values_only=True)
            try:
                header = [str(c or "").strip() for c in next(rows)]
            except StopIteration:
                continue
            if not header:
                continue
            idx = {name: i for i, name in enumerate(header)}

            if "账号汇总" in title or title.startswith("01"):
                for r in rows:
                    if not r:
                        continue
                    label = str(r[idx.get("账号", 0)] or "").strip()
                    if not label or label == "合计":
                        continue
                    accounts[label] = {
                        "account_id": str(r[idx.get("账户ID", 1)] or "").strip(),
                        "balance_current": round(_cash_num(r[idx.get("当前可用余额(¥)", 2)]), 2),
                        "balance_start": round(_cash_num(r[idx.get("区间期初余额(¥)", 3)]), 2),
                        "recharge": round(_cash_num(r[idx.get("区间充值(¥)", 4)]), 2),
                        "spend": round(_cash_num(r[idx.get("区间消费(¥)", 5)]), 2),
                        "cash": round(_cash_num(r[idx.get("其中现金(¥)", 6)]), 2),
                        "red": round(_cash_num(r[idx.get("其中红包(¥)", 7)]), 2),
                        "assign": round(_cash_num(r[idx.get("分配净额(¥)", 8)]), 2),
                    }
            elif "每日流水" in title or title.startswith("02"):
                for r in rows:
                    if not r:
                        continue
                    label = str(r[idx.get("账号", 1)] or "").strip()
                    d = _cash_date_iso(r[idx.get("日期", 0)])
                    if not label or not d:
                        continue
                    bal = r[idx.get("结算后结余(¥)", 9)]
                    daily.setdefault(label, []).append({
                        "date": d,
                        "recharge": round(_cash_num(r[idx.get("当日充值(¥)", 7)]), 2),
                        "spend": round(_cash_num(r[idx.get("当日消费合计(¥)", 6)]), 2),
                        "balance": None if bal is None else round(_cash_num(bal), 2),
                    })
            elif "口径" in title or title.startswith("04"):
                for r in rows:
                    if not r:
                        continue
                    k = str(r[0] or "").strip()
                    if k == "数据区间":
                        m = re.search(r"(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})",
                                      str(r[1] or ""))
                        if m:
                            range_start, range_end = m.group(1), m.group(2)
    finally:
        wb.close()

    if not range_start:
        dates = [d["date"] for rows in daily.values() for d in rows if d.get("date")]
        if dates:
            range_start, range_end = min(dates), max(dates)
    for rows in daily.values():
        rows.sort(key=lambda x: x["date"])
    return {
        "ok": True,
        "range_start": range_start,
        "range_end": range_end,
        "accounts": accounts,
        "daily": daily,
        "warnings": [],
    }


def ad_cashflow_snapshot(refresh: bool = False) -> dict:
    """jdfenxi 广告费流水快照（10 分钟内复用；失败降级不拖垮余额表）。"""
    now = time.time()
    with _CASHFLOW_LOCK:
        hit = _CASHFLOW_CACHE.get("snap")
    if hit and not refresh and now - hit[0] < _CASHFLOW_TTL:
        return hit[1]
    try:
        raw = _ad_get_bytes("/api/cashflow/export")
        snap = _parse_cashflow_export(raw)
    except Exception as exc:  # noqa: BLE001
        snap = {
            "ok": False,
            "error": f"读取 jdfenxi 广告费流水失败：{type(exc).__name__}: {exc}",
            "range_start": "", "range_end": "",
            "accounts": {}, "daily": {}, "warnings": [],
        }
    with _CASHFLOW_LOCK:
        _CASHFLOW_CACHE["snap"] = (now, snap)
    return snap


def _day(value) -> date | None:
    try:
        return date.fromisoformat(str(value or "").strip()[:10])
    except ValueError:
        return None


def _span_text(s: date, e: date) -> str:
    return s.isoformat() if s == e else f"{s.isoformat()}~{e.isoformat()}"


def _tile_spans(spans: list[tuple[date, date]], start: date, end: date):
    """用缓存段正好拼满 [start, end]。

    只接受「从缺口后的第一天开始」的缓存段（段的总花费含整段金额，跨出所选区间就会多算），
    拼不满的部分返回缺口，交给调用方在前端提示。
    """
    chosen: list[tuple[date, date]] = []
    gaps: list[tuple[date, date]] = []
    ordered = sorted(spans)
    cur = start
    while cur <= end:
        best = None
        for s, e in ordered:
            if s == cur and e <= end and (best is None or e > best[1]):
                best = (s, e)
        if best:
            chosen.append(best)
            cur = best[1] + timedelta(days=1)
            continue
        nxt = min((s for s, _ in ordered if cur < s <= end), default=None)
        if nxt is None:
            gaps.append((cur, end))
            break
        gaps.append((cur, nxt - timedelta(days=1)))
        cur = nxt
    return chosen, gaps


def _spend_part(kind: str, start: date, end: date, refresh: bool):
    """某一类花费（cps / 京准通）在区间内的账号明细与合计。"""
    label = "CPS 花费" if kind == "cps" else "京准通花费"
    try:
        entries = _load_entries(kind, refresh)
    except Exception as exc:  # noqa: BLE001 - 挂载服务不可用时降级，不报 500
        print(f"[广告利润] 读取{label}缓存失败：{exc}")
        return {"ok": False, "error": f"挂载服务的「{label}」缓存读取失败，广告费未计入",
                "total": 0.0, "accounts": []}

    # 同账号同区间可能有多份历史文件：取最新抓取的那份
    by_acc: dict[str, dict[tuple[date, date], dict]] = {}
    for e in entries:
        s, t = _day(e.get("start")), _day(e.get("end"))
        if not s or not t or s > t:
            continue
        key = str(e.get("account") or "")
        slot = by_acc.setdefault(key, {})
        old = slot.get((s, t))
        if old is None or str(e.get("savedAt") or "") >= str(old.get("savedAt") or ""):
            slot[(s, t)] = e

    accounts: list[dict] = []
    total = 0.0
    for key, slots in by_acc.items():
        chosen, gaps = _tile_spans(sorted(slots), start, end)
        if not chosen:
            continue
        picked = [slots[span] for span in chosen]
        amount = round(sum(float(x.get("total") or 0) for x in picked), 2)
        total += amount
        accounts.append({
            "key": key,
            "label": str((picked[-1].get("accountLabel") or key)),
            "total": amount,
            "covered_days": sum((e - s).days + 1 for s, e in chosen),
            "spans": [_span_text(s, e) for s, e in chosen],
            "gaps": [_span_text(s, e) for s, e in gaps],
            "saved_at": max((str(x.get("savedAt") or "") for x in picked), default=""),
            "sku_rows": sum(int(x.get("rows") or 0) for x in picked),
        })
    accounts.sort(key=lambda a: -a["total"])
    return {"ok": True, "error": None, "total": round(total, 2), "accounts": accounts}


# ---------------------------------------------------------------- 缺失花费自动补抓
# 「刷新广告缓存」只是让 ERP 重新读一遍挂载服务的缓存清单，**不会**触发抓取。
# 真正的补抓要调用 jdfenxi 现有的 /api/paycomm/run（CPS）与 /api/paycomm/spend/run（京准通）：
# 这两个接口发现该账号+区间没有缓存时会启动浏览器抓取并写回缓存；两者共用浏览器登录态，
# 因此这里用后台线程串行排队，一次只跑一个任务，结束后再刷 ERP 的缓存清单。
_BF_LOCK = threading.Lock()
_BF_STATE: dict = {
    "running": False, "jobId": None, "message": "", "error": None,
    "startedAt": None, "finishedAt": None, "done": 0, "total": 0,
    "current": None, "tasks": [], "results": [],
}
_BF_STATUS_PATH = {"cps": "/api/paycomm/status", "spend": "/api/paycomm/spend/status"}
_BF_RUN_PATH = {"cps": "/api/paycomm/run", "spend": "/api/paycomm/spend/run"}
_BF_LABEL = {"cps": "CPS 花费", "spend": "京准通花费"}


def _ad_post(path: str, params: dict):
    """POST 到挂载服务（启动抓取任务用）；异常由调用方降级处理。"""
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        AD_SERVICE_URL + path + "?" + qs, method="POST",
        headers={"Accept": "application/json", "User-Agent": "WSFC-ERP"},
    )
    with urllib.request.urlopen(req, timeout=max(AD_TIMEOUT, 15)) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def _ad_busy() -> bool:
    """jdfenxi 的 CPS/京准通两个抓取器是否已有任务在跑（两者共用浏览器登录态）。"""
    for kind in ("cps", "spend"):
        try:
            s = _ad_get(_BF_STATUS_PATH[kind])
        except Exception:  # noqa: BLE001
            continue
        if s.get("active") or s.get("running"):
            return True
    return False


def _ad_scrape_busy() -> bool:
    """定时/夜间抓取是否占着浏览器（jdfenxi 的 scrape.lock）。"""
    try:
        st = _ad_get("/api/status")
    except Exception:  # noqa: BLE001
        return False
    sc = st.get("scrape") or {}
    return bool(sc.get("active") or (sc.get("lock") or {}).get("locked"))


def _bf_tasks(start: date, end: date) -> list[dict]:
    """按账号 + 花费类型算出所选区间缺失的缓存段（交给 jdfenxi 逐个补抓）。"""
    try:
        accounts = [str(a.get("key")) for a in _load_accounts(True) if a.get("key")]
    except Exception:  # noqa: BLE001
        accounts = []
    labels: dict[str, str] = {}
    try:
        for a in _load_accounts(False):
            labels[str(a.get("key"))] = str(a.get("label") or a.get("key"))
    except Exception:  # noqa: BLE001
        pass

    tasks: list[dict] = []
    for kind, label in (("cps", "CPS 花费"), ("spend", "京准通花费")):
        try:
            entries = _load_entries(kind, True)
        except Exception:  # noqa: BLE001
            continue
        slots_by_acc: dict[str, dict[tuple[date, date], dict]] = {}
        for e in entries:
            s, t = _day(e.get("start")), _day(e.get("end"))
            if not s or not t or s > t:
                continue
            acc = str(e.get("account") or "")
            slot = slots_by_acc.setdefault(acc, {})
            old = slot.get((s, t))
            if old is None or str(e.get("savedAt") or "") >= str(old.get("savedAt") or ""):
                slot[(s, t)] = e
        accs = accounts or sorted(slots_by_acc)
        for acc in accs:
            _chosen, gaps = _tile_spans(sorted(slots_by_acc.get(acc, {})), start, end)
            for gs, ge in gaps:
                tasks.append({
                    "kind": kind,
                    "label": label,
                    "account": acc,
                    "account_label": labels.get(acc) or acc,
                    "start": gs.isoformat(),
                    "end": ge.isoformat(),
                })
    return tasks


def _bf_run_one(task: dict) -> tuple[bool, str]:
    """跑一个（账号 + 类型 + 区间）任务：等空闲 → 启动 → 轮询到结束。"""
    kind = task["kind"]

    def _record_zero() -> None:
        # 0 元缓存不会出现在 jdfenxi 的缓存清单里，记进本地零花费清单，避免下次又判定为缺口
        _save_zero_span(kind, task["account"], task["start"], task["end"],
                        label=task.get("account_label") or "")

    # 等两个花费任务和定时抓取都空闲（夜间 catchup 会占浏览器登录态，可能十几分钟）
    deadline = time.time() + 1200
    while time.time() < deadline:
        if not _ad_busy() and not _ad_scrape_busy():
            break
        time.sleep(30)
    else:
        return False, "jdfenxi 有其它抓取任务/定时任务在跑，等待空闲超时"

    last_err = ""
    started = False
    for _ in range(8):
        try:
            r = _ad_post(_BF_RUN_PATH[kind], {
                "account": task["account"], "start": task["start"],
                "end": task["end"], "force": 0,
            })
        except Exception as exc:  # noqa: BLE001
            r = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        if r.get("ok") and r.get("jobId"):
            started = True
            break
        # 已经命中缓存 / 无需再抓：直接算完成
        if r.get("cached") or (r.get("jobId") and not r.get("error") and r.get("rows") is not None):
            if int(r.get("rows") or 0) == 0:
                _record_zero()   # exact 0 元缓存（CPS 与京准通都可能有）
            return True, "命中本地缓存，无需补抓"
        last_err = str(r.get("error") or "启动抓取失败")
        time.sleep(30)
    if not started:
        return False, last_err or "启动抓取失败"

    deadline = time.time() + 1800  # 单个任务最多 30 分钟
    while time.time() < deadline:
        time.sleep(5)
        try:
            s = _ad_get(_BF_STATUS_PATH[kind])
        except Exception:  # noqa: BLE001
            continue
        if not (s.get("active") or s.get("running")):
            if s.get("error"):
                return False, str(s.get("error"))
            msg = str(s.get("message") or "完成")
            # CPS 抓不到行时不会落盘，只有京准通会写 noSpend 空表，所以这里只给 spend 记零
            if kind == "spend" and ("没有任何花费数据" in msg
                                   or (int(s.get("done") or 0) == 0 and int(s.get("total") or 0) == 0)):
                _record_zero()
            return True, msg
    return False, "补抓超时（30 分钟）"


def _bf_worker(tasks: list[dict]) -> None:
    results: list[dict] = []
    try:
        for i, task in enumerate(tasks, 1):
            with _BF_LOCK:
                _BF_STATE.update({
                    "done": i - 1,
                    "current": task,
                    "message": (f"正在补抓 {i}/{len(tasks)}：{task['label']} · "
                                f"{task['account_label']} {task['start']} ~ {task['end']}"),
                })
            ok, msg = _bf_run_one(task)
            results.append({**task, "ok": ok, "message": msg})
            # 每完成一个就把该类型的缓存清单重新读一遍，后续任务能看到最新覆盖
            try:
                _load_entries(task["kind"], True)
            except Exception:  # noqa: BLE001
                pass
            with _BF_LOCK:
                _BF_STATE["results"] = list(results)
    except Exception as exc:  # noqa: BLE001
        with _BF_LOCK:
            _BF_STATE["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        ok_n = sum(1 for r in results if r.get("ok"))
        try:
            _load_entries("cps", True)
            _load_entries("spend", True)
        except Exception:  # noqa: BLE001
            pass
        _SKU_ROWS_CACHE.clear()
        with _BF_LOCK:
            _BF_STATE.update({
                "running": False,
                "done": len(tasks),
                "total": len(tasks),
                "finishedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "current": None,
                "results": list(results),
                "message": (f"补抓完成：成功 {ok_n}/{len(tasks)}；"
                            + ("失败项见下方明细" if ok_n < len(tasks) else "缓存已更新")),
            })


@router.post("/adprofit/backfill")
def ad_profit_backfill(
    date_from: str = "",
    date_to: str = "",
    db: Session = Depends(get_db_wh),
    user: User = Depends(get_current_user),
):
    """补齐所选区间缺失的 CPS / 京准通花费缓存（调用 jdfenxi 已有的抓取接口）。"""
    start, end = _parse_range(date_from, date_to)
    with _BF_LOCK:
        if _BF_STATE["running"]:
            return {"ok": False, "error": "已有补抓任务在运行，请等它结束"}
    tasks = _bf_tasks(start, end)
    if not tasks:
        return {"ok": True, "count": 0, "tasks": [], "message": "所选区间没有缺失的花费缓存"}
    if len(tasks) > 50:
        return {"ok": False,
                "error": f"缺失区间太多（{len(tasks)} 个），请把日期范围缩小后再补抓"}
    with _BF_LOCK:
        if _BF_STATE["running"]:
            return {"ok": False, "error": "已有补抓任务在运行，请等它结束"}
        job_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-adbackfill"
        _BF_STATE.update({
            "running": True, "jobId": job_id, "message": "准备补抓…", "error": None,
            "startedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "finishedAt": None, "done": 0, "total": len(tasks),
            "current": None, "tasks": tasks, "results": [],
        })
    threading.Thread(target=_bf_worker, args=(tasks,), name="adprofit-backfill", daemon=True).start()
    return {"ok": True, "count": len(tasks), "jobId": job_id, "tasks": tasks}


@router.get("/adprofit/backfill/status")
def ad_profit_backfill_status(user: User = Depends(get_current_user)):
    with _BF_LOCK:
        state = dict(_BF_STATE)
        state["tasks"] = list(_BF_STATE.get("tasks") or [])
        state["results"] = list(_BF_STATE.get("results") or [])
    return {"ok": True, **state}


# SKU 明细要用挂载服务「花费一览」的导出接口（现成的按 SKU 报表），
# 落地文件不会变，解析结果缓存久一点（10 分钟），避免翻页/改排序都重复解析 Excel。
_SKU_TTL = 600.0
_SKU_ROWS_CACHE: dict[tuple, tuple[float, list[dict]]] = {}

# 两类花费在导出 Excel 里的金额列（列名与挂载服务导出模板一致）
_SKU_AMOUNT_COL = {"cps": "付款佣金金额(元)", "spend": "京准通花费合计(元)"}


def _ad_get_bytes(path: str) -> bytes:
    """下载挂载服务的二进制接口（导出 Excel）；超时放宽一些，导出要现装配工作簿。"""
    req = urllib.request.Request(
        AD_SERVICE_URL + path,
        headers={"Accept": "*/*", "User-Agent": "WSFC-ERP"},
    )
    with urllib.request.urlopen(req, timeout=max(AD_TIMEOUT * 2, 15)) as resp:  # noqa: S310 - 固定内网地址
        return resp.read()


def _parse_sku_xlsx(data: bytes, kind: str) -> list[dict]:
    """解析挂载服务导出的按 SKU 明细（第一个工作表：SKU / 商品名称 / 金额）。

    少于两行（只有表头）或模板变动找不到列时返回空列表，由调用方按「无数据」处理，
    不影响店铺合计口径（合计来自缓存清单，不依赖这个明细）。
    """
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        ws = wb.worksheets[0]
        header = [str(c.value or "").strip() for c in next(ws.iter_rows(min_row=1, max_row=1))]
        try:
            i_sku, i_name = header.index("SKU"), header.index("商品名称")
            i_amt = header.index(_SKU_AMOUNT_COL[kind])
        except ValueError:
            return []
        rows: list[dict] = []
        for r in ws.iter_rows(min_row=2, values_only=True):
            if not r:
                continue
            sku = str(r[i_sku] or "").strip()
            if not sku or sku == "合计":
                break
            try:
                amount = float(r[i_amt] or 0)
            except (TypeError, ValueError):
                amount = 0.0
            rows.append({
                "sku": sku,
                "name": str(r[i_name] or "").strip(),
                "amount": round(amount, 2),
            })
        return rows
    finally:
        wb.close()


def _sku_rows_of(kind: str, account: str, s: date, e: date, refresh: bool = False) -> list[dict]:
    """某账号某缓存段的 SKU 明细（按落地文件解析，失败抛异常由调用方降级）。"""
    key = ("skurows", kind, account, s.isoformat(), e.isoformat())
    now = time.time()
    hit = _SKU_ROWS_CACHE.get(key)
    if not refresh and hit and now - hit[0] < _SKU_TTL:
        return hit[1]
    qs = urllib.parse.urlencode({
        "account": account, "start": s.isoformat(), "end": e.isoformat(), "dim": "sku",
    })
    raw = _ad_get_bytes(f"/api/paycomm{'' if kind == 'cps' else '/spend'}/export?" + qs)
    rows = _parse_sku_xlsx(raw, kind)
    _cache_put(_SKU_ROWS_CACHE, key, rows, _SKU_TTL)
    return rows


def _sku_ads_map(start: date, end: date, refresh: bool) -> tuple[dict[str, dict], list[str]]:
    """区间内各 SKU 的两类广告花费（按缓存段整段读取，拼不满的段不取）。

    返回 ({sku: {cps, jzt, name}}, warnings)；某项读取失败只降级该项，不阻塞另一项。
    """
    ads: dict[str, dict] = {}
    warnings: list[str] = []
    for kind, label in (("cps", "CPS 花费"), ("spend", "京准通花费")):
        field = "cps" if kind == "cps" else "jzt"
        try:
            entries = _load_entries(kind, refresh)
        except Exception as exc:  # noqa: BLE001 - 挂载服务不可用时降级
            print(f"[广告利润] 读取{label}缓存清单失败：{exc}")
            warnings.append(f"挂载服务的「{label}」缓存读取失败，该部分未计入 SKU 明细")
            continue

        by_acc: dict[str, dict[tuple[date, date], dict]] = {}
        for e in entries:
            s, t = _day(e.get("start")), _day(e.get("end"))
            if not s or not t or s > t:
                continue
            acc = str(e.get("account") or "")
            slot = by_acc.setdefault(acc, {})
            old = slot.get((s, t))
            if old is None or str(e.get("savedAt") or "") >= str(old.get("savedAt") or ""):
                slot[(s, t)] = e

        for acc, slots in by_acc.items():
            chosen, _gaps = _tile_spans(sorted(slots), start, end)
            for span in chosen:
                try:
                    rows = _sku_rows_of(kind, acc, span[0], span[1], refresh)
                except Exception as exc:  # noqa: BLE001
                    print(f"[广告利润] 读取 {acc} 的{label} SKU 明细失败：{exc}")
                    warnings.append(f"{label}（{acc}）{_span_text(*span)} 的 SKU 明细读取失败，已跳过")
                    continue
                for r in rows:
                    d = ads.setdefault(r["sku"], {"sku": r["sku"], "ad_name": "", "cps": 0.0, "jzt": 0.0})
                    d[field] = round(d[field] + r["amount"], 2)
                    if r["name"] and not d["ad_name"]:
                        d["ad_name"] = r["name"]
    return ads, warnings


# ---------------------------------------------------------------- 月度利润（入仓品）
# 入仓品的成交件数/毛利只有 jdfenxi「月度利润」里有（商智成交 + ERP 成本接口算出的毛利），
# 这里只读它的本地缓存（export 接口，缓存缺失时返回最新一份，用文件名里的区间校验），
# 不触发商智抓取；同一个月只有部分日期有缓存时按已有区间取数并在页面上标注截止日。
_PROFIT_TTL = 600.0
_PROFIT_CACHE: dict[tuple, tuple[float, dict]] = {}

# 月度利润 Excel「SKU利润」表的列名
_PROFIT_COLS = {
    "sku": "SKU",
    "name": "商品名称",
    "qty": "成交件数",
    "gross": "毛利(元)",
    "arrival": "到手金额(元)",
}


def _ad_get_with_headers(path: str) -> tuple[bytes, dict]:
    req = urllib.request.Request(
        AD_SERVICE_URL + path,
        headers={"Accept": "*/*", "User-Agent": "WSFC-ERP"},
    )
    with urllib.request.urlopen(req, timeout=max(AD_TIMEOUT * 2, 20)) as resp:  # noqa: S310
        # Starlette 下发的响应头是小写，统一转小写再取（别按 "Content-Disposition" 取）
        return resp.read(), {k.lower(): v for k, v in resp.headers.items()}


def _xlsx_response_range(disposition: str) -> tuple[date, date] | None:
    """从导出文件名里取真实数据区间（月度利润_账号_开始_结束.xlsx）。"""
    if not disposition:
        return None
    m = re.search(r"filename\*=UTF-8''([^;]+)", disposition)
    name = urllib.parse.unquote(m.group(1)) if m else disposition
    m2 = re.search(r"(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.xlsx", name)
    if not m2:
        return None
    s, e = _day(m2.group(1)), _day(m2.group(2))
    return (s, e) if s and e else None


def _parse_profit_xlsx(data: bytes) -> list[dict]:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        ws = wb.worksheets[0]
        header = [str(c.value or "").strip() for c in next(ws.iter_rows(min_row=1, max_row=1))]
        idx = {}
        for k, label in _PROFIT_COLS.items():
            try:
                idx[k] = header.index(label)
            except ValueError:
                return []
        rows: list[dict] = []
        for r in ws.iter_rows(min_row=2, values_only=True):
            if not r:
                continue
            sku = str(r[idx["sku"]] or "").strip()
            if not sku or sku == "合计":
                break
            try:
                qty = float(r[idx["qty"]] or 0)
                gross = float(r[idx["gross"]] or 0)
                arrival = float(r[idx["arrival"]] or 0)
            except (TypeError, ValueError):
                continue
            rows.append({
                "sku": sku,
                "name": str(r[idx["name"]] or "").strip(),
                "qty": qty,
                "gross": round(gross, 2),
                "arrival": round(arrival, 2),
            })
        return rows
    finally:
        wb.close()


def _profit_month(month_start: date, month_end: date, refresh: bool) -> tuple[dict[str, dict], list[str], dict]:
    """某个月各 SKU 的成交件数/毛利（各账号取本地利润缓存，同 SKU 取成交件数大的一份）。"""
    key = ("profit", month_start.isoformat())
    now = time.time()
    hit = _PROFIT_CACHE.get(key)
    if not refresh and hit and now - hit[0] < _PROFIT_TTL:
        return hit[1]["rows"], hit[1]["warnings"], hit[1]["meta"]

    accounts = ["main", "b"]
    rows: dict[str, dict] = {}
    warnings: list[str] = []
    used_ranges: list[str] = []
    rng: tuple[date, date] | None = None
    for acc in accounts:
        # 第一次先问 main，从导出文件名拿到该月真正缓存到的区间；
        # 之后各账号用这个精确区间去读，才能命中缓存并按账号拆行（否则 export 会回落成 main 的表）
        req_s, req_e = (month_start, month_end) if rng is None else rng
        qs = urllib.parse.urlencode({
            "account": acc, "start": req_s.isoformat(),
            "end": req_e.isoformat(), "dim": "sku",
        })
        try:
            raw, headers = _ad_get_with_headers("/api/profit/export?" + qs)
        except Exception as exc:  # noqa: BLE001 - 挂载服务不可用/无缓存
            print(f"[广告利润] 读取 {acc} 月度利润缓存失败：{exc}")
            continue
        got = _xlsx_response_range(headers.get("content-disposition", ""))
        if not got:
            continue
        if rng is None:
            # export 找不到该月缓存时会回落「最新一份」：只接受落在本月内的区间，避免拿错月份的数
            if got[0] < month_start or got[1] > month_end:
                continue
            rng = got
        elif got != rng:
            continue          # 读到的不是同一份缓存（该账号没有这张表）
        used_ranges.append(f"{got[0].isoformat()}~{got[1].isoformat()}")
        try:
            part = _parse_profit_xlsx(raw)
        except Exception as exc:  # noqa: BLE001
            print(f"[广告利润] 解析 {acc} 月度利润失败：{exc}")
            continue
        for r in part:
            cur = rows.get(r["sku"])
            # 同一 SKU 两个账号都有成交时不要相加（会重复计），取成交件数大的那份
            if cur is None or r["qty"] > cur["qty"]:
                rows[r["sku"]] = r

    if not used_ranges:
        warnings.append(
            f"{month_start.strftime('%Y-%m')} 没有月度利润缓存，入仓品的成交件数/毛利未补全"
            "（到 jdfenxi「月度利润」页算一次即可）"
        )
    else:
        r_s = min(x.split("~")[0] for x in used_ranges)
        r_e = max(x.split("~")[1] for x in used_ranges)
        if r_s != month_start.isoformat() or r_e != month_end.isoformat():
            warnings.append(
                f"入仓品的成交件数/毛利取自月度利润缓存 {r_s}~{r_e}"
                f"（{month_start.strftime('%Y-%m')} 未覆盖到最后一天）"
            )

    meta = {"label": "、".join(sorted(set(used_ranges)))}
    out = (rows, warnings, meta)
    _cache_put(_PROFIT_CACHE, key, {"rows": rows, "warnings": warnings, "meta": meta}, _PROFIT_TTL)
    return out


def _profit_for_range(start: date, end: date, refresh: bool) -> tuple[dict[str, dict], list[str], list[str]]:
    """所选区间覆盖的各月利润数据（按 SKU 合并各月）；返回 (rows, warnings, 用到的缓存区间)。"""
    rows: dict[str, dict] = {}
    warnings: list[str] = []
    ranges: list[str] = []
    cur = start.replace(day=1)
    while cur <= end:
        nxt = (cur.replace(day=1) + timedelta(days=32)).replace(day=1)
        m_end = nxt - timedelta(days=1)
        m_rows, m_warn, meta = _profit_month(cur, m_end, refresh)
        for sku, r in m_rows.items():
            cur_row = rows.get(sku)
            if cur_row is None:
                rows[sku] = dict(r)
            else:
                cur_row["qty"] += r["qty"]
                cur_row["gross"] = round(cur_row["gross"] + r["gross"], 2)
                cur_row["arrival"] = round(cur_row["arrival"] + r["arrival"], 2)
        warnings.extend(m_warn)
        if meta.get("label"):
            ranges.extend(meta["label"].split("、"))
        cur = nxt
    return rows, warnings, sorted(set(ranges))


def _warehouse_skus(wh_key: str, db: Session) -> dict[str, str]:
    """当前口径下的入仓品资料：SKU → 名称（全仓时把所有分仓的资料并起来）。"""

    def _scan(session) -> dict[str, str]:
        out: dict[str, str] = {}
        for p in session.execute(select(WarehouseProduct)).scalars():
            sku = str(p.sku or "").strip()
            if sku:
                out.setdefault(sku, p.name or "")
        return out

    if wh_key != ALL_WH:
        return _scan(db)
    out: dict[str, str] = {}
    for w in load_warehouses().get("list") or []:
        try:
            session = get_sessionmaker(str(w.get("key")) )()
        except Exception:  # noqa: BLE001 - 某个仓文件坏了不影响其他仓
            continue
        try:
            for sku, name in _scan(session).items():
                out.setdefault(sku, name)
        finally:
            session.close()
    return out


def _code_aliases(wh_key: str, db: Session) -> dict[str, list[str]]:
    """主编码 → 该商品的全部编码（多端商品多店铺多编码，如京东多家店的 skuId）。

    广告花费是按店铺 SKU 抓的：多编码商品要把**所有编码**的广告费累加到同一行商品上，
    否则没有主编码的那几个店铺会掉进「未匹配 ERP」行、利润被低估。
    全仓时把各分仓的资料并起来（只收真的有多个编码的商品，普通商品不进表）。
    """

    def _scan(session) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for p in session.execute(select(Product)).scalars():
            main = str(p.code or "").strip()
            if not main:
                continue
            codes = [main]
            if getattr(p, "multi_code", False):
                for it in (getattr(p, "codes", None) or []):
                    c = str((it or {}).get("code") or "").strip() if isinstance(it, dict) else ""
                    if c and c not in codes:
                        codes.append(c)
            if len(codes) > 1:
                out.setdefault(main, codes)
        return out

    if wh_key != ALL_WH:
        return _scan(db)
    out: dict[str, list[str]] = {}
    for w in load_warehouses().get("list") or []:
        try:
            session = get_sessionmaker(str(w.get("key")))()
        except Exception:  # noqa: BLE001 - 某个仓文件坏了不影响其他仓
            continue
        try:
            for main, codes in _scan(session).items():
                out.setdefault(main, codes)
        finally:
            session.close()
    return out


def _parse_range(date_from: str, date_to: str) -> tuple[date, date]:
    """接口入参的日期区间（默认本月到今天，最长 366 天）。"""
    today = date.today()
    start = _day(date_from) if date_from else today.replace(day=1)
    end = _day(date_to) if date_to else today
    if not start or not end:
        raise HTTPException(400, "日期格式不对（要 YYYY-MM-DD）")
    if start > end:
        start, end = end, start
    if (end - start).days > 366:
        raise HTTPException(400, "区间最长 366 天")
    return start, end


@router.get("/adprofit/summary")
def ad_profit_summary(
    date_from: str = "",
    date_to: str = "",
    wh: str = "",                 # 空 = 本登录会话分仓；wh=all = 全仓合计
    exclude_other: int = 1,       # 与「财务报表」默认口径一致：排除其他收支
    refresh: int = 0,             # 1 = 忽略 60 秒缓存，重新读挂载服务
    db: Session = Depends(get_db_wh),
    user: User = Depends(get_current_user),
):
    """含广告费的利润：ERP 财务口径 −（CPS 花费 + 京准通花费）。"""
    start, end = _parse_range(date_from, date_to)

    s_iso, e_iso = start.isoformat(), end.isoformat()
    wh_key = ALL_WH if wh == ALL_WH else resolve_key(wh)
    key = ("summary", wh_key, s_iso, e_iso, 1 if exclude_other else 0)

    def _compute():
        if wh_key == ALL_WH:
            return _summary_all(s_iso, e_iso, bool(exclude_other))
        return _summary_of(db, s_iso, e_iso, wh_key, bool(exclude_other))

    base = _heavy_cached(key, _compute)

    cps = _spend_part("cps", start, end, bool(refresh))
    jzt = _spend_part("spend", start, end, bool(refresh))
    service_ok = cps["ok"] and jzt["ok"]

    ads_total = round(cps["total"] + jzt["total"], 2)
    revenue = round(float(base.get("revenue") or 0), 2)
    gross = round(float(base.get("gross_profit") or 0), 2)
    net = round(float(base.get("net_profit") or 0), 2)
    days = (end - start).days + 1

    # ---- 覆盖提示：拼不满的日期必须在页面上说清楚，否则广告费会被低估 ----
    warnings: list[str] = []
    covered_accounts: dict[str, set[str]] = {}
    for part_name, part in (("CPS 花费", cps), ("京准通花费", jzt)):
        for acc in part["accounts"]:
            if acc["gaps"]:
                covered_accounts.setdefault(acc["label"], set()).add(
                    f"{part_name}缺 " + "、".join(acc["gaps"])
                )
    for label, items in covered_accounts.items():
        warnings.append(f"{label}：" + "；".join(sorted(items)))
    if not service_ok:
        if not cps["ok"]:
            warnings.append(cps["error"])
        if not jzt["ok"]:
            warnings.append(jzt["error"])
    elif ads_total <= 0:
        warnings.append("所选区间没有任何可用的花费缓存，广告费按 0 计入；请到挂载服务「花费一览」按该区间抓取一次")

    # ---- 账号清单：所有已配置店铺都进列表；该区间没有缓存的单列提醒 ----
    # 新加的店铺即使一次都没抓过，也要显示出来（0 + 无缓存），否则页面会一直停留在老账号。
    missing_accounts: list[dict] = []
    all_accounts: list[dict] = []
    if service_ok:
        try:
            accounts = _load_accounts(bool(refresh))
        except Exception:  # noqa: BLE001
            accounts = []
        seen_cps = {a["key"] for a in cps["accounts"]}
        seen_jzt = {a["key"] for a in jzt["accounts"]}
        seen = seen_cps | seen_jzt
        for acc in accounts:
            key_ = str(acc.get("key") or "")
            if not key_:
                continue
            label_ = str(acc.get("label") or key_)
            # 所有已配置店铺都返回：新加的店铺即使一次都没抓过缓存，也要出现在
            # 「按店铺账号的广告费」列表里（显示 0 + 无缓存提示），否则用户会以为没同步。
            all_accounts.append({
                "key": key_,
                "label": label_,
                "has_cps": key_ in seen_cps,
                "has_jzt": key_ in seen_jzt,
            })
            if key_ not in seen:
                missing_accounts.append({"key": key_, "label": label_})
        if missing_accounts:
            warnings.append("以下店铺账号该区间没有花费缓存（未计入广告费）："
                            + "、".join(a["label"] for a in missing_accounts))

    result = {
        "ok": True,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "range": {"start": s_iso, "end": e_iso, "days": days},
        "erp": {
            "warehouse": base.get("warehouse") or {"key": wh_key, "name": ""},
            "is_all": bool(base.get("is_all")),
            "revenue": revenue,
            "cogs": round(float(base.get("cogs") or 0), 2),
            "goods_cogs": round(float(base.get("goods_cogs") or 0), 2),
            "brush_cost": round(float(base.get("brush_cost") or 0), 2),
            "gross_profit": gross,
            "expense": round(float(base.get("expense") or 0), 2),
            "manual_expense": round(float(base.get("manual_expense") or 0), 2),
            "other_expense": round(float(base.get("other_expense") or 0), 2),
            # 广告费充值已从 ERP 期间费用里剔出（广告费只在本页按实际消耗扣一次）
            "ad_prepay_expense": round(float(base.get("ad_prepay_expense") or 0), 2),
            "excluded_other_expense": round(float(base.get("excluded_other_expense") or 0), 2),
            "exclude_other_expense": bool(base.get("exclude_other_expense")),
            "net_profit": net,
            "order_count": int(base.get("order_count") or 0),
            "warehouse_in_revenue": round(float(base.get("warehouse_in_revenue") or 0), 2),
            "warehouse_in_cogs": round(float(base.get("warehouse_in_cogs") or 0), 2),
            "warehouse_in_count": int(base.get("warehouse_in_count") or 0),
        },
        "ads": {
            "service_ok": service_ok,
            "total": ads_total,
            "cps": cps,
            "jzt": jzt,
            "missing_accounts": missing_accounts,
            "all_accounts": all_accounts,
        },
        "profit": {
            "ads_total": ads_total,
            "cps_total": cps["total"],
            "jzt_total": jzt["total"],
            "gross_before_ads": gross,
            "gross_after_ads": round(gross - ads_total, 2),
            "net_before_ads": net,
            "net_after_ads": round(net - ads_total, 2),
            "ad_rate": round(ads_total / revenue, 4) if revenue else None,
            "net_margin_before": round(net / revenue, 4) if revenue else None,
            "net_margin_after": round((net - ads_total) / revenue, 4) if revenue else None,
        },
        "warnings": warnings,
    }
    return result


@router.get("/adprofit/skus")
def ad_profit_skus(
    date_from: str = "",
    date_to: str = "",
    wh: str = "",
    exclude_other: int = 1,
    refresh: int = 0,
    sort: str = "ads",            # ads=按广告费倒序（默认） / revenue / gross
    db: Session = Depends(get_db_wh),
    user: User = Depends(get_current_user),
):
    """按 SKU 的含广告费利润：ERP 商品明细（按商品编码=京东 skuId 合并）+ 挂载服务按 SKU 的花费。

    匹配口径：ERP 商品的「编码」= 挂载服务花费明细里的 SKU（京东 skuId）。
    没填编码的商品按商品名称单列（不参与广告费匹配）；只有广告花费、没有 ERP 销售的 SKU
    也单独列出（收入为 0），方便看出「广告在烧、货没卖」的款。
    """
    start, end = _parse_range(date_from, date_to)
    s_iso, e_iso = start.isoformat(), end.isoformat()
    wh_key = ALL_WH if wh == ALL_WH else resolve_key(wh)
    key = ("summary", wh_key, s_iso, e_iso, 1 if exclude_other else 0)

    def _compute():
        if wh_key == ALL_WH:
            return _summary_all(s_iso, e_iso, bool(exclude_other))
        return _summary_of(db, s_iso, e_iso, wh_key, bool(exclude_other))

    # 与 summary 共用同一个缓存键：SKU 页不额外算一遍财务数据
    base = _heavy_cached(key, _compute)
    ads, warnings = _sku_ads_map(start, end, bool(refresh))

    # 入仓品：ERP 里没有它们的出库销售（只按袋入仓），成交件数/毛利只有 jdfenxi 月度利润有
    wh_skus = _warehouse_skus(wh_key, db)
    profit_rows, profit_warn, profit_ranges = _profit_for_range(start, end, bool(refresh))
    warnings.extend(profit_warn)

    # ---- ERP 商品明细按「编码」合并（同编码多规格/代发/入仓合并为一行）----
    buckets: dict[tuple[str, str], dict] = {}
    for p in base.get("by_product") or []:
        # 入仓台账（备货入库）不是 SKU 成交，且没有商品编码；入仓品由下面的月度利润行按 SKU 展示，
        # 两边都算会把同一批货的「入仓采购结算」和「京东成交」重复加进合计
        if p.get("is_warehouse_in"):
            continue
        code = str(p.get("code") or "").strip()
        bkey = ("sku", code) if code else ("name", str(p.get("name") or ""))
        b = buckets.get(bkey)
        if b is None:
            b = buckets[bkey] = {
                "code": code, "name": str(p.get("name") or ""), "unit": "",
                "qty": 0.0, "revenue": 0.0, "cogs": 0.0, "gross_before": 0.0,
            }
        b["qty"] += float(p.get("qty") or 0)
        # 收入口径与报表一致：商品销售金额 + 客户代收的关联结算（包材/人工/快递）
        b["revenue"] += float(p.get("amount") or 0) + float(p.get("settle_income") or 0)
        b["cogs"] += float(p.get("total_cogs") or 0)
        b["gross_before"] += float(p.get("gross_profit") or 0)
        if not b["unit"] and p.get("unit"):
            b["unit"] = str(p["unit"])

    # 多端商品（多店铺多编码）：广告费要把该商品所有编码的花费累加到同一行，避免掉进「未匹配 ERP」
    aliases = _code_aliases(wh_key, db)
    rows: list[dict] = []
    matched: set[str] = set()
    for b in buckets.values():
        codes = (aliases.get(b["code"]) or [b["code"]]) if b["code"] else []
        hits = [(c, ads[c]) for c in codes if ads.get(c)]
        matched.update(c for c, _ in hits)
        cps = round(sum(float(a.get("cps") or 0) for _, a in hits), 2)
        jzt = round(sum(float(a.get("jzt") or 0) for _, a in hits), 2)
        ads_total = round(cps + jzt, 2)
        revenue = round(b["revenue"], 2)
        gross = round(b["gross_before"], 2)
        rows.append({
            "sku": b["code"],
            # 该商品的全部编码（含多端商品其它店铺的 skuId），供页面提示/核对；普通商品只有一条
            "codes": codes,
            "name": b["name"],
            "qty": round(b["qty"], 4),
            "unit": b["unit"],
            "revenue": revenue,
            "cogs": round(b["cogs"], 2),
            "gross_before": gross,
            "cps": cps,
            "jzt": jzt,
            "ads_total": ads_total,
            "gross_after": round(gross - ads_total, 2),
            "ad_rate": round(ads_total / revenue, 4) if revenue else None,
            "roi": round(revenue / ads_total, 4) if ads_total else None,
            "has_sales": False if abs(revenue) < 0.005 else True,
            "no_code": not b["code"],
            "ad_only": False,
            "is_warehouse_in": False,
            "source": "erp",
        })

    # ---- 入仓品：成交件数/毛利取自月度利润缓存，利润 = 入仓品毛利 − 广告费 ----
    # 也要含多端商品的所有编码：这些 SKU 已经并到上面的商品行里了，不能再按入仓品列一遍
    erp_codes = {c for b in buckets.values() if b["code"]
                 for c in (aliases.get(b["code"]) or [b["code"]])}
    for sku, pr in profit_rows.items():
        if sku in erp_codes or sku not in wh_skus:
            continue          # 已在 ERP 销售明细里 / 不是入仓品
        a = ads.get(sku)
        if a:
            matched.add(sku)
        cps = round(float((a or {}).get("cps") or 0), 2)
        jzt = round(float((a or {}).get("jzt") or 0), 2)
        ads_total = round(cps + jzt, 2)
        revenue = round(float(pr["arrival"] or 0), 2)
        gross = round(float(pr["gross"] or 0), 2)
        rows.append({
            "sku": sku,
            "name": wh_skus.get(sku) or pr.get("name") or "",
            "qty": round(float(pr["qty"] or 0), 4),
            "unit": "件",      # 商智成交件数，不是入仓袋数
            "revenue": revenue,
            "cogs": round(revenue - gross, 2),
            "gross_before": gross,
            "cps": cps,
            "jzt": jzt,
            "ads_total": ads_total,
            "gross_after": round(gross - ads_total, 2),
            "ad_rate": round(ads_total / revenue, 4) if revenue else None,
            "roi": round(revenue / ads_total, 4) if ads_total else None,
            "has_sales": True,
            "no_code": False,
            "ad_only": False,
            "is_warehouse_in": True,
            "source": "profit",
        })

    # ---- 只有广告花费、没有 ERP 销售的 SKU（收入 0，单独列出）----
    for sku, a in ads.items():
        if sku in matched:
            continue
        cps = round(float(a.get("cps") or 0), 2)
        jzt = round(float(a.get("jzt") or 0), 2)
        ads_total = round(cps + jzt, 2)
        if not ads_total:
            continue
        rows.append({
            "sku": sku, "name": wh_skus.get(sku) or a.get("ad_name") or "",
            "qty": 0.0, "unit": "",
            "revenue": 0.0, "cogs": 0.0, "gross_before": 0.0,
            "cps": cps, "jzt": jzt, "ads_total": ads_total,
            "gross_after": round(-ads_total, 2),
            "ad_rate": None, "roi": None,
            "has_sales": False, "no_code": False, "ad_only": True,
            "is_warehouse_in": sku in wh_skus,
            "source": "ad",
        })

    sorters = {
        "revenue": lambda r: (-r["revenue"], -r["ads_total"]),
        "gross": lambda r: (-r["gross_before"], -r["ads_total"]),
    }
    rows.sort(key=sorters.get(sort, lambda r: (-r["ads_total"], -r["revenue"])))

    erp_revenue = round(sum(r["revenue"] for r in rows if r["source"] == "erp"), 2)
    wh_rows = [r for r in rows if r["is_warehouse_in"]]
    ads_total = round(sum(float(a.get("cps") or 0) + float(a.get("jzt") or 0) for a in ads.values()), 2)
    matched_ads = round(sum(float(ads[k].get("cps") or 0) + float(ads[k].get("jzt") or 0) for k in matched), 2)
    unmatched = round(ads_total - matched_ads, 2)
    if unmatched > 0.005:
        warnings.append(
            f"有 {fmt_money(unmatched)} 广告花费的 SKU 在 ERP 商品明细里找不到对应编码（京东 skuId），"
            "这部分已单列为「未匹配 ERP」行；如商品编码没填京东 skuId，请到商品资料补上"
        )

    return {
        "ok": True,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "range": {"start": s_iso, "end": e_iso, "days": (end - start).days + 1},
        "warehouse": base.get("warehouse") or {"key": wh_key, "name": ""},
        "is_all": bool(base.get("is_all")),
        "profit_ranges": profit_ranges,
        "rows": rows,
        "totals": {
            "sku_count": len(rows),
            "erp_revenue": erp_revenue,
            "revenue_total": round(sum(r["revenue"] for r in rows), 2),
            "warehouse_sku_count": len(wh_rows),
            "warehouse_qty": round(sum(r["qty"] for r in wh_rows), 4),
            "warehouse_revenue": round(sum(r["revenue"] for r in wh_rows), 2),
            "warehouse_gross": round(sum(r["gross_before"] for r in wh_rows), 2),
            "warehouse_ads": round(sum(r["ads_total"] for r in wh_rows), 2),
            "warehouse_net": round(sum(r["gross_after"] for r in wh_rows), 2),
            "gross_before": round(sum(r["gross_before"] for r in rows), 2),
            "cps_total": round(sum(r["cps"] for r in rows), 2),
            "jzt_total": round(sum(r["jzt"] for r in rows), 2),
            "ads_total": round(sum(r["ads_total"] for r in rows), 2),
            "gross_after": round(sum(r["gross_after"] for r in rows), 2),
            "matched_skus": len(matched),
            "ad_only_skus": sum(1 for r in rows if r["ad_only"]),
            "unmatched_ads": unmatched,
        },
        "warnings": warnings,
    }


def fmt_money(v: float) -> str:
    return f"¥{float(v or 0):,.2f}"
