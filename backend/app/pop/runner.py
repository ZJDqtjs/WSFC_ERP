"""京东 POP 店订单定时导入 → 出库单。

流程（每轮、每个启用分仓）：
    1. 按窗口（默认最近 7 天，jdfenxi 每晚重抓覆盖）拉 /api/pop/orders（只读缓存）
    2. 只导「已出库(16) / 已完成(19)」；待出库/锁定/未付款/已取消 不导
    3. SKU（京东 skuId）→ ERP 商品：code → 多端 codes[] → code_mappings(jdpop) → 名称唯一匹配
       解析不了的订单整单跳过，进「未匹配 SKU」待办（不建半张单，避免库存/收入对不上）
    4. 金额：price_mode=supply 用京东供货价（supplyPrice），=pay 用买家实付（amount）；
       再按 deduction_config.json 的店铺扣点（如 沛沛佳pop 0.6%）折算净收入，
       gross_sales 保留扣点前金额 —— 与聚水潭导入完全同一口径
    5. create_outbound 落库（import_group=pop…，代发/扣库存、包材、快递费、成本全沿用现有逻辑）
       outbounds.external_no 写平台订单号 → 重跑幂等
    6. 已建单的订单后来变「已取消」→ 自动红冲（create_sales_return，代发只冲收入成本、不回补库存）
"""

from __future__ import annotations

import hashlib
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select

from ..database import get_sessionmaker
from ..models import CodeMapping, Outbound, Product
from ..services import create_outbound, create_sales_return, recompute_product
from . import client
from . import settings as st

# ---------------------------------------------------------------- 运行状态
_JOB_LOCK = threading.Lock()
STATE: dict[str, Any] = {
    "running": False, "warehouse": None, "trigger": "", "step": "",
    "message": "", "ok": None, "error": None,
    "started_at": None, "finished_at": None, "stats": {},
}


def _set_state(**kw) -> None:
    STATE.update(kw)


def status() -> dict[str, Any]:
    with _JOB_LOCK:
        return dict(STATE)


# ---------------------------------------------------------------- 工具
def _today() -> date:
    return date.today()


def _iso(d: Any) -> str:
    if isinstance(d, datetime):
        return f"{d:%Y-%m-%d}"
    if isinstance(d, date):
        return f"{d:%Y-%m-%d}"
    return str(d or "")


def _chunks(seq: list, n: int = 400):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _pick_unit(p: Product) -> str:
    """选一个商品实际配置过的销售单位（默认单位 → 基础单位 → 第一个）。"""
    conv = p.conversions or {}
    for u in (p.default_unit, p.base_unit):
        if u and u in conv:
            return u
    return next(iter(conv), p.base_unit or "单")


def _resolve_product(db, sku: str, name: str = "") -> Product | None:
    """京东 skuId → ERP 商品：精确编码 → 多端 codes[] → 映射表（source=jdpop）。

    有 SKU 但没匹配上时**不做名称猜测**：京东商品名是长标题（含规格/卖点），
    和 ERP 商品名几乎不会完全一致，猜错了会把订单记到别的商品上（默默改账）。
    只有订单里完全没有 SKU 时，才退回到「同名且唯一」的商品。
    """
    sku = (sku or "").strip()
    if sku:
        p = db.scalar(select(Product).where(Product.code == sku))
        if p:
            return p
        for p in db.execute(select(Product).where(Product.multi_code.is_(True))).scalars():
            for it in (p.codes or []):
                if isinstance(it, dict) and str(it.get("code") or "").strip() == sku:
                    return p
        m = db.scalar(select(CodeMapping).where(
            CodeMapping.source == "jdpop", CodeMapping.external_code == sku))
        if m and m.product_id:
            return db.get(Product, m.product_id)
        return None
    name = (name or "").strip()
    if name:
        rows = list(db.execute(select(Product).where(Product.name == name)).scalars())
        if len(rows) == 1:
            return rows[0]
    return None


def _shop_rule(customer: str) -> dict | None:
    """店铺扣点规则（与聚水潭导入共用 json/deduction_config.json）。"""
    from ..routers.imports import _load_shop_deductions

    return _load_shop_deductions().get((customer or "").strip())


def _deduction_pct(db, product: Product, customer: str) -> tuple[float, str]:
    """返回 (该行扣点百分比, 备注片段)。"""
    from ..routers.imports import _line_deduct_stock_category, _shop_deduction_note, _shop_line_percent

    rule = _shop_rule(customer)
    if not rule:
        return 0.0, ""
    pct = _shop_line_percent(rule, _line_deduct_stock_category(db, product))
    note = _shop_deduction_note(rule) if pct > 0 else ""
    return float(pct or 0.0), note


def _order_lines(order: dict, price_mode: str) -> list[dict]:
    """把一张订单的明细行算成 [{skuId, name, qty, gross}]（扣点前金额）。"""
    items = [it for it in (order.get("items") or []) if isinstance(it, dict)]
    rows = []
    for it in items:
        qty = float(it.get("num") or 0)
        if qty <= 0:
            continue
        sup = it.get("supplyPrice")
        try:
            sup_f = float(sup) if sup not in (None, "") else 0.0
        except (TypeError, ValueError):
            sup_f = 0.0
        rows.append({
            "skuId": str(it.get("skuId") or "").strip(),
            "name": str(it.get("name") or "").strip(),
            "qty": qty,
            "supply": sup_f,
            "weight": sup_f * qty if sup_f > 0 else qty,
        })
    if not rows:
        return []
    supply_total = round(sum(r["supply"] * r["qty"] for r in rows), 2)
    try:
        pay_total = float(order.get("amount") or 0)
    except (TypeError, ValueError):
        pay_total = 0.0
    # 供货价口径：优先整单供货价合计；缺供货价的商品退回买家实付，避免出现 0 元行
    gross_total = pay_total if (price_mode == "pay" or supply_total <= 0) else supply_total
    total_w = sum(r["weight"] for r in rows) or float(len(rows))
    alloc = [gross_total * (r["weight"] / total_w) for r in rows]
    # 尾差补到第一行，保证各行合计 == gross_total
    if alloc:
        alloc[0] = round(gross_total - sum(round(a, 2) for a in alloc[1:]), 2)
    for r, amt in zip(rows, alloc):
        r["gross"] = round(amt, 2)
    return rows


def _build_payload(db, order: dict, cfg: dict, customer: str, operator: str) -> tuple[dict | None, list[dict]]:
    """一张订单 → create_outbound 的 payload；返回 (payload, 未匹配明细)。"""
    rows = _order_lines(order, cfg.get("price_mode") or "supply")
    if not rows:
        return None, []
    lines, unmapped = [], []
    notes: list[str] = []
    for r in rows:
        p = _resolve_product(db, r["skuId"], r["name"])
        if not p:
            unmapped.append({"sku": r["skuId"], "name": r["name"], "qty": r["qty"]})
            continue
        pct, note = _deduction_pct(db, p, customer)
        net = round(r["gross"] * (1 - pct / 100.0), 2) if pct > 0 else r["gross"]
        if note and note not in notes:
            notes.append(note)
        unit = _pick_unit(p)
        lines.append({
            "product_id": p.id, "unit": unit, "quantity": r["qty"],
            "price": round(net / r["qty"], 4) if r["qty"] else 0,
            "gross_sales": r["gross"],
            "spec": (p.spec or "").strip(),
        })
    if unmapped:
        return None, unmapped
    if not lines:
        return None, []
    day = _iso(order.get("day") or order.get("orderTime") or "")
    remark = f"京东POP 单{order.get('orderId') or ''}" + ("".join(notes))
    payload = {
        "customer": customer,
        "operator": operator,
        "date": day,
        "remark": remark[:250],
        "external_no": str(order.get("orderId") or "").strip(),
        "lines": lines,
        "auto_express": bool(cfg.get("auto_express", True)),
    }
    return payload, []


def _reverse_canceled(db, order: dict, operator: str) -> tuple[bool, str]:
    """已建单的订单变「已取消」→ 按原单全量红冲。返回 (是否红冲, 说明)。"""
    ext = str(order.get("orderId") or "").strip()
    if not ext:
        return False, "缺订单号"
    orig = db.scalar(select(Outbound).where(
        Outbound.external_no == ext, Outbound.is_return.is_(False)))
    if not orig:
        return False, "没有已建的单（跳过）"
    done = db.scalar(select(Outbound.id).where(Outbound.return_of_id == orig.id))
    if done:
        return False, f"{orig.code} 已红冲过"
    items = [
        {"line_id": ln.id, "quantity": float(ln.quantity or 0)}
        for ln in orig.lines if ln.line_type == "sale"
    ]
    if not items:
        return False, f"{orig.code} 没有销售行"
    create_sales_return(
        db, orig.id, items, _today().isoformat(),
        operator=operator, remark=f"京东POP 订单取消 单{ext}",
    )
    return True, f"已红冲 {orig.code}"


# ---------------------------------------------------------------- 主流程
def run_once(
    key: str | None = None,
    *,
    start: date | None = None,
    end: date | None = None,
    dry_run: bool = False,
    trigger: str = "手动",
    account: str = "",
) -> dict[str, Any]:
    """跑一轮（指定分仓；key=None 时遍历所有启用分仓）。dry_run=True 只算不建单。"""
    if key:
        keys = [key]
    else:
        from ..database import get_warehouses

        keys = [w.get("key") for w in get_warehouses() if w.get("key")]
    results = []
    for k in keys:
        results.append(_run_warehouse(k, start=start, end=end, dry_run=dry_run,
                                      trigger=trigger, account=account))
    return results[0] if key and results else {"ok": True, "results": results}


def _run_warehouse(key: str, *, start=None, end=None, dry_run=False,
                   trigger="手动", account="") -> dict[str, Any]:
    cfg = st.wh_of(st.load(), key)
    accounts = cfg.get("accounts") or []
    if account:
        accounts = [a for a in accounts if a.get("account") == account]
    if not accounts:
        return {"ok": False, "error": "本分仓还没有配置 POP 店铺账号（京麦模块）"}

    with _JOB_LOCK:
        if STATE["running"]:
            return {"ok": False, "error": "已有一轮 POP 导入在执行中"}
        STATE.update({
            "running": True, "warehouse": key, "trigger": trigger, "step": "开始",
            "message": "", "ok": None, "error": None, "stats": {},
            "started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "finished_at": None,
        })

    end_d = end or _today()
    start_d = start or (end_d - timedelta(days=max(1, int(cfg.get("days") or 7)) - 1))
    stats = {"orders": 0, "created": 0, "duplicate_skipped": 0, "status_skipped": 0,
             "unmapped": 0, "reversed": 0, "failed": 0, "dry_run": 0}
    warnings: list[str] = []
    failed: list[dict] = []
    unmapped: dict[str, dict] = {}
    flapped: list[str] = []   # 已红冲过、状态又变回可导入的订单：不自动重建，进待办
    missing_days: list[str] = []
    try:
        db = get_sessionmaker(key)()
        try:
            from ..jst.runner import _operator_user

            operator = getattr(_operator_user(db, cfg.get("operator") or ""), "name", "") or "自动出库"
            group = f"pop{datetime.now():%Y%m%d}{uuid.uuid4().hex[:6]}"
            affected: list[int] = []
            # 已取消(29) 永远不导入（它只用于红冲判断），这里再兜一道，防止配置里误勾
            statuses = {int(x) for x in (cfg.get("statuses") or [16, 19])} - {29}
            auto_reverse = bool(cfg.get("auto_reverse", True))

            for acc in accounts:
                acct = acc.get("account") or ""
                customer = (acc.get("customer") or acc.get("label") or acct).strip()
                _set_state(step=f"拉取 {acct} 订单", message=f"{start_d} ~ {end_d}")
                data = client.fetch_orders(_iso(start_d), _iso(end_d), account=acct,
                                           url=st.service_url())
                if not data.get("ok"):
                    failed.append({"account": acct, "reason": data.get("error") or "拉取失败"})
                    continue
                missing_days += [str(d) for d in (data.get("missingDays") or [])]
                rows = [r for r in (data.get("rows") or []) if isinstance(r, dict)]
                stats["orders"] += len(rows)
                if not rows:
                    continue

                # 已建单的平台单号（含红冲判断用）
                ids = [str(r.get("orderId") or "").strip() for r in rows if r.get("orderId")]
                existing: set[str] = set()
                for part in _chunks(sorted(set(ids))):
                    existing |= set(db.execute(
                        select(Outbound.external_no).where(Outbound.external_no.in_(part))
                    ).scalars())

                for order in rows:
                    ext = str(order.get("orderId") or "").strip()
                    try:
                        code = int(order.get("statusCode") or 0)
                    except (TypeError, ValueError):
                        code = 0
                    if code in statuses:
                        if not ext:
                            continue
                        if ext in existing:
                            stats["duplicate_skipped"] += 1
                            # 之前红冲过、现在又变成可导入状态（取消→又出库）：不自动重建单，交给人工判断
                            orig = db.scalar(select(Outbound).where(
                                Outbound.external_no == ext, Outbound.is_return.is_(False)))
                            if orig and db.scalar(select(Outbound.id).where(
                                    Outbound.return_of_id == orig.id)):
                                flapped.append(ext)
                            continue
                        payload, bad = _build_payload(db, order, cfg, customer, operator)
                        if bad:
                            for b in bad:
                                d = unmapped.setdefault(b["sku"] or b["name"], {
                                    "sku": b["sku"], "name": b["name"], "count": 0, "orders": []})
                                d["count"] += 1
                                if ext and ext not in d["orders"]:
                                    d["orders"].append(ext)
                            stats["unmapped"] += 1
                            continue
                        if not payload:
                            stats["status_skipped"] += 1
                            continue
                        if dry_run:
                            stats["dry_run"] += 1
                            continue
                        rec, warns = create_outbound(
                            db, payload, operator=operator, import_group=group,
                            defer_recompute=True, affected_out=affected,
                        )
                        db.flush()
                        stats["created"] += 1
                        existing.add(ext)
                        for w in warns:
                            warnings.append(f"{rec.code}: {w}")
                    elif code == 29 and auto_reverse:
                        stats["status_skipped"] += 1
                        if dry_run:
                            continue
                        ok, msg = _reverse_canceled(db, order, operator)
                        if ok:
                            stats["reversed"] += 1
                        elif "已红冲过" not in msg:
                            warnings.append(f"单{ext} 取消：{msg}")
                    else:
                        stats["status_skipped"] += 1

            for pid in dict.fromkeys(affected):
                recompute_product(db, pid)
            if dry_run:
                db.rollback()
            else:
                db.commit()

            if unmapped:
                st.upsert_pending(key, {
                    "type": "pop_unmapped",
                    "title": "POP 订单有商品没对上系统商品",
                    "message": f"{len(unmapped)} 种京东 SKU 没匹配到 ERP 商品，对应订单已跳过（未建单）",
                    "items": sorted(unmapped.values(), key=lambda x: -x["count"]),
                })
            if flapped:
                st.upsert_pending(key, {
                    "type": "pop_flap",
                    "title": "POP 订单取消红冲后又变回已出库",
                    "message": "这些订单已经红冲过，系统不会自动重新建单，请人工确认要不要补一张",
                    "items": [{"sku": "", "name": f"单{x}", "count": 1, "orders": [x]}
                              for x in sorted(set(flapped))[:50]],
                })
                stats["flapped"] = len(set(flapped))
            if missing_days:
                warnings.append("jdfenxi 有未抓取日期：" + "、".join(sorted(set(missing_days))[:7]))

            entry = {
                "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "trigger": trigger, "ok": not failed, "warehouse": key,
                "window": f"{_iso(start_d)} ~ {_iso(end_d)}",
                "stats": stats,
                "message": (f"新建 {stats['created']} 张，跳过重复 {stats['duplicate_skipped']}，"
                            f"红冲 {stats['reversed']}，未匹配 {stats['unmapped']}"
                            + (f"，状态反复 {stats.get('flapped')}" if stats.get("flapped") else "")),
                "warnings": warnings[:20],
                "failed": failed[:20],
            }
            st.record_run(key, entry, update_last=not dry_run)
            out = {"ok": not failed, **entry}
            _set_state(running=False, ok=out["ok"], step="完成", stats=stats,
                       message=out["message"], error=None,
                       finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            return out
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001 - 定时线程不能因单仓异常退出
        err = f"{type(exc).__name__}: {exc}"
        st.record_run(key, {
            "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "trigger": trigger, "ok": False, "warehouse": key, "stats": stats,
            "window": f"{_iso(start_d)} ~ {_iso(end_d)}", "message": "执行失败", "error": err,
        })
        _set_state(running=False, ok=False, step="失败", error=err,
                   finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        return {"ok": False, "error": err}


# ---------------------------------------------------------------- 连通检测
def check(url: str = "") -> dict[str, Any]:
    """探测 jdfenxi 是否可达，并回带最近 3 天的缓存情况（只读，不触发抓取）。"""
    stt = client.fetch_status(url)
    end = _today()
    start = end - timedelta(days=2)
    data = client.fetch_orders(_iso(start), _iso(end), url=url)
    if not data.get("ok"):
        return {"ok": False, "message": data.get("error") or "连接失败",
                "running": bool(stt.get("running")), "status": stt}
    return {
        "ok": True,
        "message": (f"连接正常：{data.get('label') or data.get('account') or ''} · "
                    f"已缓存 {data.get('cachedDays') or 0} 天"
                    + (f"，未抓取 {len(data.get('missingDays') or [])} 天"
                       if data.get("missingDays") else "")),
        "accounts": data.get("accounts") or [],
        "cached_days": data.get("cachedDays") or 0,
        "missing_days": data.get("missingDays") or [],
        "running": bool(stt.get("running")),
        "status": stt,
    }


# ---------------------------------------------------------------- 定时调度
_scheduler_started = False
_sched_lock = threading.Lock()


def start_scheduler() -> None:
    """启动 POP 导入定时线程（幂等）。"""
    global _scheduler_started
    with _sched_lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    threading.Thread(target=_loop, name="pop-scheduler", daemon=True).start()


def scheduler_alive() -> bool:
    if not _scheduler_started:
        return False
    return any(t.name == "pop-scheduler" and t.is_alive() for t in threading.enumerate())


def _loop() -> None:
    while True:
        try:
            _tick(datetime.now())
        except Exception:  # noqa: BLE001 - 调度线程不能因单次异常退出
            pass
        time.sleep(20)


def _jitter_seconds(key: str, day: str, slot_text: str, span: int) -> int:
    """按 (分仓, 日期, 定时点) 生成稳定偏移秒数，范围 [-span, +span]（与聚水潭自动出库同一套做法）。"""
    if span <= 0:
        return 0
    h = int(hashlib.md5(f"pop|{key}|{day}|{slot_text}".encode()).hexdigest()[:8], 16)
    return (h % (2 * span + 1)) - span


def next_runs_with_jitter(key: str, wh: dict[str, Any], limit: int = 3) -> list[str]:
    """界面展示用的「接下来几次实际执行时间」（已含抖动）。"""
    from ..jst.config import parse_schedule

    span = int(wh.get("jitter_minutes") or 0) * 60
    try:
        parsed = parse_schedule(wh.get("schedule") or [])
    except ValueError:
        return []
    now = datetime.now()
    out: list[datetime] = []
    for day_offset in range(0, 8):
        day = now.date().fromordinal(now.date().toordinal() + day_offset)
        day_str = f"{day:%Y-%m-%d}"
        for s in parsed:
            base = datetime(day.year, day.month, day.day, s.hour, s.minute)
            off = _jitter_seconds(key, day_str, f"{day_str} {s.hour:02d}:{s.minute:02d}", span)
            target = base + timedelta(seconds=off)
            if target.date() != base.date():
                target = base
            if target > now:
                out.append(target)
        if len(out) >= limit:
            break
    return [f"{t:%Y-%m-%d %H:%M}" for t in sorted(out)[:limit]]


def _tick(now: datetime) -> None:
    from ..jst.config import parse_schedule

    day = f"{now:%Y-%m-%d}"
    d = st.load()
    for key in list((d.get("warehouses") or {}).keys()):
        wh = st.wh_of(d, key)
        if not wh.get("enabled") or not wh.get("accounts"):
            continue
        try:
            slots = parse_schedule(wh.get("schedule") or [])
        except ValueError:
            continue
        span = int(wh.get("jitter_minutes") or 0) * 60
        for slot in slots:
            stamp = f"{day} {slot.hour:02d}:{slot.minute:02d}"
            base = now.replace(hour=slot.hour, minute=slot.minute, second=0, microsecond=0)
            target = base + timedelta(seconds=_jitter_seconds(key, day, stamp, span))
            if target.date() != now.date():
                target = base
            if now < target or (now - target).total_seconds() >= 60:
                continue  # 还没到点 / 已错过这一分钟（不补跑，次日窗口会自动覆盖）
            if STATE["running"]:
                continue
            if not st.mark_slot(key, stamp, day):
                continue
            threading.Thread(
                target=_run_warehouse, args=(key,),
                kwargs={"trigger": "定时"}, name=f"pop-run-{key}", daemon=True,
            ).start()
    st.prune_slots(day)
