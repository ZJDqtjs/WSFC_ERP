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

import json
import os
import time
import urllib.request
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db_wh, resolve_key
from ..models import User
from .report import ALL_WH, _heavy_cached, _summary_all, _summary_of

router = APIRouter(prefix="/api", tags=["adprofit"])

# 挂载服务地址：只给后端到后端用（前端不接触这个内网端口）
AD_SERVICE_URL = os.getenv("ERP_AD_SERVICE_URL", "http://127.0.0.1:18011").rstrip("/")
AD_TIMEOUT = float(os.getenv("ERP_AD_TIMEOUT", "8"))

# 花费缓存清单变动不频繁：60 秒内复用，避免页面反复刷新时每次都打挂载服务
_AD_TTL = 60.0
_AD_CACHE: dict[str, tuple[float, object]] = {}


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
    _AD_CACHE[key] = (now, got)
    return got


def _load_entries(kind: str, refresh: bool = False) -> list[dict]:
    """花费缓存清单（按账号+区间去重）。kind: cps / spend。"""
    path = "/api/paycomm/cache" if kind == "cps" else "/api/paycomm/spend/cache"

    def _load():
        data = _ad_get(path)
        entries = data.get("entries") if isinstance(data, dict) else None
        return entries if isinstance(entries, list) else []

    return _ad_cached("entries:" + kind, _load, refresh)


def _load_accounts(refresh: bool = False) -> list[dict]:
    """挂载服务里配置的店铺账号（用于提示「有账号还没有花费缓存」）。"""
    def _load():
        data = _ad_get("/api/accounts")
        accounts = data.get("accounts") if isinstance(data, dict) else None
        return accounts if isinstance(accounts, list) else []

    return _ad_cached("accounts", _load, refresh)


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
    today = date.today()
    start = _day(date_from) if date_from else today.replace(day=1)
    end = _day(date_to) if date_to else today
    if not start or not end:
        raise HTTPException(400, "日期格式不对（要 YYYY-MM-DD）")
    if start > end:
        start, end = end, start
    if (end - start).days > 366:
        raise HTTPException(400, "区间最长 366 天")

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

    # ---- 有账号但该区间没有缓存：单列出来，提醒去抓取 ----
    # 只提醒「曾经抓过花费」的账号（有缓存文件、但没覆盖本区间），
    # 一次都没抓过的账号多半没在投广告，天天提示反而淹没真正需要补抓的。
    missing_accounts: list[dict] = []
    if service_ok:
        try:
            accounts = _load_accounts(bool(refresh))
        except Exception:  # noqa: BLE001
            accounts = []
        known: set[str] = set()
        for kind in ("cps", "spend"):
            try:
                for e in _load_entries(kind, bool(refresh)):
                    k = str(e.get("account") or "")
                    if k:
                        known.add(k)
            except Exception:  # noqa: BLE001
                continue
        seen = {a["key"] for a in cps["accounts"]} | {a["key"] for a in jzt["accounts"]}
        for acc in accounts:
            key_ = str(acc.get("key") or "")
            if key_ and key_ not in seen and key_ in known:
                missing_accounts.append({"key": key_, "label": str(acc.get("label") or key_)})
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
