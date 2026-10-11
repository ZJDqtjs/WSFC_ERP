"""对外只读接口：给京东投放工具（JD_AdOperation）提供「按 SKU 的单件成本」口径。

对方的成本表（config/costs.json）要每个京东 SKU 的单件供货价/运费/扣点/包材/人工/退货率，
用来算保本 ROI。这里把 ERP 已经算好的数据按京东 skuId 汇总成同一份结构对外输出。

SKU 口径（两边靠这个对上）：
- **订单商品**：``products.code`` 存的就是京东 skuId。单件结算收入 = 出库明细 ``amount``
  （卖家实收，即京东结算给我们的钱）÷ 件数。
- **入仓品**：``warehouse_products.sku`` 也是京东 skuId，入仓单的收入就是京东向我们下的
  采购单，毛利 = 收入 − 商品成本 − 运费 − 随货包材成本。

分仓：对方不需要感知分仓，这里跨全部分仓合并后按 skuId 汇总（分仓是各自独立的账套，
但同一 SKU 的结算口径一致，合并后覆盖面更全）。

鉴权：请求头 ``X-Api-Token: <token>``（也兼容 ``Authorization: Bearer <token>``）。
令牌读 ``config.local.json`` 的 ``open_api.token``（本机私有、已 gitignore）；
未配置时本接口返回 503，不会无鉴权裸奔。

令牌连续错误按客户端 IP 分级锁定（复用 app/login_guard.py 的规则：每累计 3 次失败依次等待
1 分钟 → 3 分钟 → 5 分钟 → 1 小时 → 24 小时），锁定期内即使令牌正确也一律拒绝。
"""
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import login_guard as guard
from ..config import load_rules
from ..database import get_sessionmaker, get_warehouses
from ..maintenance import client_ip
from ..models import Outbound, OutboundLine, Product, WarehouseIn, WarehouseProduct
from .report import _summary_of
# 入仓品的随货包材结算与「入仓品扣点」都只有一处实现（warehouse_in），这里复用它算每袋包材成本
from .warehouse_in import _settle_pack_items, _warehouse_deduction

router = APIRouter(prefix="/api/open", tags=["open"])

JSON_DIR = Path(__file__).resolve().parent.parent.parent / "json"
DEFAULTS_FILE = JSON_DIR / "sku_cost_defaults.json"

# 兜底默认值：JSON 配置缺失时的出厂口径（运费 5 元、扣点 0、退货率 5%）
FALLBACK_DEFAULTS = {
    "shipping": 5.0,
    "platformRate": 0.0,
    "package": 0.0,
    "labor": 0.0,
    "returnRate": 0.05,
}

PAID = "paid"

# 进程内短缓存：汇总要扫区间内全部出库单，对方一天可能拉多次，10 分钟内相同参数直接复用
_CACHE: dict = {}
# 单仓汇总结果缓存（key = (date_from, date_to)）：方案 B 每次请求要用「区间」+「全量」两份
_SUMMARY_CACHE: dict = {}
_CACHE_TTL = timedelta(minutes=10)


def _configured_token() -> str:
    return str((load_rules().get("open_api") or {}).get("token") or "").strip()


def _require_token(request: Request, x_api_token: str, authorization: str) -> None:
    """校验令牌；错误按客户端 IP 复用登录那套分级锁定（见 app/login_guard.py）。

    - 未配置令牌 → 503（服务端配置问题，不计入失败）；
    - 该 IP 处于锁定期 → 429，并给出剩余时长；
    - 令牌缺失/错误 → 记一次失败，到档位返回 429，否则 401；
    - 校验通过 → 清零该 IP 的失败计数。
    """
    expected = _configured_token()
    if not expected:
        raise HTTPException(503, "未配置 open_api.token，接口未开放")
    ip = client_ip(request) or "-"
    left = guard.locked_left(guard.SCOPE_OPEN_API, ip)
    if left:
        raise HTTPException(
            429, f"Token 连续错误次数过多，该 IP 已锁定 {guard.humanize(left)}，请稍后再试"
        )
    got = (x_api_token or "").strip()
    if not got and authorization.lower().startswith("bearer "):
        got = authorization[7:].strip()
    if not got or got != expected:
        wait = guard.record_fail(guard.SCOPE_OPEN_API, ip)
        if wait:
            raise HTTPException(
                429, f"Token 连续错误次数过多，该 IP 已锁定 {guard.humanize(wait)}，请稍后再试"
            )
        raise HTTPException(401, "Token 无效")
    guard.reset(guard.SCOPE_OPEN_API, ip)


def _norm_date(raw: str, field: str) -> str:
    """把各种写法统一成 ``YYYY-MM-DD``；空串原样返回。

    **这个函数是必需的，不是严谨癖**：出库日期在库里就是 ``YYYY-MM-DD`` 字符串，
    区间过滤走的是字符串比较。调用方若传 ``2026-10-1``（缺前导零），
    ``'2026-10-06' >= '2026-10-1'`` 会因为第 9 位 '0' < '1' 判为假，
    于是 10-01~10-09 的数据被整段过滤掉，区间看起来「没有出库」。
    支持 ``2026-10-1`` / ``2026/10/1`` / ``2026.10.1`` / ``20261001``。
    """
    s = (raw or "").strip()
    if not s:
        return ""
    m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s) or re.fullmatch(r"(\d{4})(\d{2})(\d{2})", s)
    if not m:
        raise HTTPException(422, f"{field} 日期格式应为 YYYY-MM-DD（可省略前导零），收到：{raw}")
    y, mo, d = (int(x) for x in m.groups())
    try:
        return date(y, mo, d).isoformat()
    except ValueError as e:
        raise HTTPException(422, f"{field} 日期无效：{raw}（{e}）")


def _defaults() -> dict:
    """全店默认成本：可在 backend/json/sku_cost_defaults.json 里维护（缺项回落到出厂默认）。"""
    out = dict(FALLBACK_DEFAULTS)
    try:
        data = json.loads(DEFAULTS_FILE.read_text(encoding="utf-8-sig"))
        if isinstance(data, dict):
            for k in out:
                v = data.get(k)
                if isinstance(v, (int, float)):
                    out[k] = v
    except Exception:  # noqa: BLE001 - 配置缺失/损坏都用出厂默认，不影响接口
        pass
    return out


# ---------------- 订单商品（聚水潭出库单） ----------------
def _sku_rows_sale(db: Session, date_from: str, date_to: str, key: str) -> dict:
    """按商品编码汇总出库明细 → 单件结算收入 / 运费 / 包材 / 人工 / 扣点。

    直接复用报表的 ``_summary_of``：出库时结算的快递费、包材、人工的归属与分摊规则都在那儿
    （有关联销售商品的直接归它，无归属的按单内销售金额占比分摊），这里不另写一套口径。
    """
    data = _summary_of(db, date_from, date_to, key, False)
    out: dict = {}
    for r in data.get("by_product") or []:
        code = str(r.get("code") or "").strip()
        if not code:
            continue  # 没填编码的订单商品对不上京东 SKU，跳过
        qty = float(r.get("qty") or 0)
        if not qty:
            continue
        amount = float(r.get("amount") or 0)                # 京东结算给我们的实收（已扣店铺扣点）
        gross = float(r.get("gross_sales") or 0) or amount  # 扣点前销售金额
        d = out.setdefault(code, {
            "_qty": 0.0, "_amount": 0.0, "_gross": 0.0, "_labor": 0.0,
            "_material": 0.0, "_express": 0.0, "_cogs": 0.0, "_name": "",
        })
        d["_qty"] += qty
        d["_amount"] += amount
        d["_gross"] += gross
        d["_labor"] += float(r.get("labor_cogs") or 0)
        d["_material"] += float(r.get("material_cogs") or 0) + float(r.get("other_cogs") or 0)
        d["_express"] += float(r.get("express_cogs") or 0)
        d["_cogs"] += float(r.get("goods_cogs") or 0)
        if not d["_name"]:
            d["_name"] = r.get("name") or ""

    # 该商品在区间内**实际有出库**的日期范围：用来判断「数据是落在我选的那段时间，还是区间内根本没卖」。
    # 这是另外查一次得到的（_summary_of 不返回日期），代价很小。
    conds = [
        OutboundLine.line_type == "sale",
        func.coalesce(Outbound.pay_status, PAID) != "unpaid",
        Product.code != "",
    ]
    if date_from:
        conds.append(Outbound.date >= date_from)
    if date_to:
        conds.append(Outbound.date <= date_to)
    for code, d0, d1 in db.execute(
        select(Product.code, func.min(Outbound.date), func.max(Outbound.date))
        .select_from(OutboundLine)
        .join(Outbound, Outbound.id == OutboundLine.outbound_id)
        .join(Product, Product.id == OutboundLine.product_id)
        .where(*conds)
        .group_by(Product.code)
    ):
        d = out.get(str(code or "").strip())
        if d is not None:
            d["_firstDate"] = d0 or ""
            d["_lastDate"] = d1 or ""
    return out


# ---------------- 入仓品 ----------------
def _sku_rows_warehouse(db: Session) -> dict:
    """按入仓品 sku 汇总 → 每袋结算收入（京东采购价）/ 运费 / 包材 / 毛利率。

    两条来源（缺一不可，否则「只建了入仓品资料、还没录入仓记录」的仓会查不到任何东西）：
    1. **入仓记录**（``warehouse_ins``）：真实结算，带扣点/运费/包材快照，优先；
    2. **入仓品资料**（``warehouse_products``）：有记录的商品跳过；没记录的用资料上的
       采购价/运费 + 「入仓品」扣点 + 随货包材清单兜底，单价按「1 袋」虚拟基准算，
       输出时标 ``_period=spec``（资料价，不是实际结算价），销量记 0。
    """
    rows = db.execute(
        select(
            WarehouseProduct.sku,
            func.coalesce(func.sum(WarehouseIn.quantity), 0.0),
            func.coalesce(func.sum(WarehouseIn.amount), 0.0),   # 收入（已扣点）
            func.coalesce(func.sum(WarehouseIn.unit_price * WarehouseIn.quantity), 0.0),  # 扣点前采购价
            func.coalesce(func.sum(WarehouseIn.freight_total), 0.0),
            func.coalesce(func.sum(WarehouseIn.pack_cost), 0.0),
            func.coalesce(func.sum(WarehouseIn.cogs), 0.0),
            func.coalesce(func.sum(WarehouseIn.profit), 0.0),
            func.max(WarehouseIn.deduction_percent),
            func.max(WarehouseProduct.name),
            func.max(WarehouseIn.date),
        )
        .select_from(WarehouseIn)
        .join(WarehouseProduct, WarehouseProduct.id == WarehouseIn.product_id, isouter=True)
        .where(func.coalesce(WarehouseIn.pay_status, PAID) != "unpaid")
        .group_by(WarehouseProduct.sku)
    ).all()
    out: dict = {}
    for sku, qty, amount, gross, freight, pack, cogs, profit, ded, name, last in rows:
        code = str(sku or "").strip()
        if not code or not float(qty or 0):
            continue  # 没维护 sku 的入仓品无法与京东 SKU 对应
        out[code] = {
            "_qty": float(qty or 0),
            "_amount": float(amount or 0),
            "_gross": float(gross or 0),
            "_freight": float(freight or 0),
            "_pack": float(pack or 0),
            "_cogs": float(cogs or 0),
            "_profit": float(profit or 0),
            "_deduction": round(float(ded or 0) / 100, 6),
            "_name": name or "",
            "_source": "warehouse",
            # 入仓品不按区间过滤（采购价是快照，用最近已知价），但要让人看清这个价是什么时候的
            "_lastDate": last or "",
        }

    # ② 只有入仓品资料、还没有入仓记录的：用资料价兜底（否则新建仓「建了资料但没录记录」就查不到）
    ded = float(_warehouse_deduction(db) or 0) / 100
    for wp in db.execute(
        select(WarehouseProduct).where(func.coalesce(WarehouseProduct.is_active, 1) != 0)
    ).scalars():
        code = str(wp.sku or "").strip()
        if not code or code in out:
            continue
        if not (wp.purchase_price or 0):
            continue  # 连采购价都没维护，给不出成本
        _items, pack_cost = _settle_pack_items(db, wp, 1.0)   # 按「1 袋」算随货包材成本（只读，不落库）
        gross = float(wp.purchase_price or 0)
        out[code] = {
            "_qty": 1.0,                                   # 虚拟基准：单件价 = 总额 ÷ 1
            "_amount": round(gross * (1 - ded), 6),
            "_gross": gross,
            "_freight": float(wp.freight or 0),
            "_pack": float(pack_cost or 0),
            "_cogs": 0.0,                                  # 没有实际入仓，商品成本无从得知
            "_profit": 0.0,
            "_deduction": round(ded, 6),
            "_name": wp.name or "",
            "_source": "warehouse",
            "_specOnly": True,                             # 标记：资料价，不是实际结算价
            "_lastDate": "",
        }
    return out


def _merge_into(dst: dict, src: dict) -> dict:
    """把一个仓的汇总累加进总表；同一 skuId 两边都有时以出库口径为准。"""
    for code, d in src.items():
        cur = dst.get(code)
        if cur is None:
            dst[code] = dict(d)
            continue
        if cur.get("_source") == "warehouse":        # 已有入仓口径，被出库口径覆盖
            # 两个仓都有这个入仓品时，优先保留**有实际入仓记录**的那份：资料价不该盖掉真实结算价
            if cur.get("_specOnly") and not d.get("_specOnly"):
                dst[code] = dict(d)
            continue
        for k, v in d.items():                       # 已有出库口径 → 金额累加，日期取并集
            if k in ("_name", "_deduction", "_source"):
                continue
            if k == "_firstDate":
                cur[k] = min(x for x in (cur.get(k) or "", v or "") if x) if (cur.get(k) or v) else ""
                continue
            if k == "_lastDate":
                cur[k] = max(cur.get(k) or "", v or "")
                continue
            cur[k] = float(cur.get(k) or 0) + float(v or 0)
    return dst


def _collect(date_from: str, date_to: str) -> dict:
    """跨全部分仓汇总（单仓读取失败只记一条，不影响其它仓）。

    带进程内缓存：方案 B 每次请求都要「区间」和「全量」两份汇总，全量那份很重，
    缓存后同一份在 TTL 内只算一次（对方一天可能拉很多次）。
    """
    ck = (date_from, date_to)
    hit = _SUMMARY_CACHE.get(ck)
    if hit and datetime.now() - hit[0] < _CACHE_TTL:
        return hit[1]
    sale: dict = {}
    wh: dict = {}
    failed: list = []
    for w in get_warehouses():
        key = w["key"]
        db = None
        try:
            db = get_sessionmaker(key)()
            for code, d in _sku_rows_sale(db, date_from, date_to, key).items():
                d["_source"] = "sale"
                _merge_into(sale, {code: d})
            _merge_into(wh, _sku_rows_warehouse(db))
        except Exception as e:  # noqa: BLE001 - 单仓失败不拖累整体
            failed.append({"key": key, "error": f"读取失败：{e}"})
            print(f"[对外成本表] {key} 读取失败:", e)
        finally:
            if db is not None:
                db.close()
    out = {"sale": sale, "warehouse": wh, "failed": failed}
    _SUMMARY_CACHE.clear()
    _SUMMARY_CACHE[ck] = (datetime.now(), out)
    return out


# ---------------- 输出 ----------------
def _r(v, n: int = 4):
    return round(float(v), n)


def _sale_item(cost: dict, period: str, rq: float, ra: float, tq: float, ta: float) -> dict:
    """订单商品 → 对方成本表的一行。

    参数说明（方案 B：区间内没卖的商品也要有成本，否则对方回落全店口径算歪保本线）：
    - ``cost``：算单件单价用的那份汇总——区间内有出库就是区间那份，否则是全量历史兜底那份；
    - ``rq`` / ``ra``：**区间内**销量与结算额（区间内没卖就是 0，不能拿全量数顶替，否则会误读成「卖得好」）；
    - ``tq`` / ``ta``：全量历史销量与成交额，给对方判断这个成本样本有多大。
    """
    qty = cost["_qty"]
    amount = cost["_amount"]
    gross = cost["_gross"] or amount
    return {
        # 京东结算给我们的单件金额（卖家实收 ÷ 件数）——对方口径里的「真实供货价」
        "supply": _r(amount / qty),
        "supplyGross": _r(gross / qty),
        # 单件扣点前售价：对方留空则继续用它报表里的真实客单价
        "price": None,
        "shipping": _r(cost["_express"] / qty),
        "package": _r(cost["_material"] / qty),
        "labor": _r(cost["_labor"] / qty),
        # 导入时已按店铺扣点从销售额里扣掉，这里反推真实扣点比例
        "platformRate": _r((gross - amount) / gross, 6) if gross else None,
        "returnRate": None,   # ERP 不记退货率，交给对方 default
        # 以下为附带信息，便于人工核对（对方可忽略）
        "_name": cost["_name"],
        "_source": "sale",
        # 成本取自哪个口径：range=所选区间的均值，all=区间内没卖，用了全量历史兜底
        "_period": period,
        "_qty": _r(rq, 2),
        "_turnover": _r(ra, 2),
        "_totalQty": _r(tq, 2),
        "_totalTurnover": _r(ta, 2),
        "_goodsCost": _r(cost["_cogs"] / qty),   # 我方买货成本，仅供参考，不等于 supply
        # 成本所依据的日期范围：period=range 时是区间内实际出库的日子，=all 时是全量历史上的日子
        "_firstDate": cost.get("_firstDate") or "",
        "_lastDate": cost.get("_lastDate") or "",
    }


def _warehouse_item(d: dict) -> dict:
    """入仓品 → 对方成本表的一行。"""
    qty = d["_qty"]
    spec_only = bool(d.get("_specOnly"))
    return {
        # 入仓品的采购价就是京东向我们下的采购单单价（入仓收入 ÷ 袋数，已扣入仓品扣点）
        "supply": _r(d["_amount"] / qty),
        "supplyGross": _r(d["_gross"] / qty),
        "price": None,
        "shipping": _r(d["_freight"] / qty),
        "package": _r(d["_pack"] / qty),
        "labor": 0.0,          # 入仓品没有出库时的打包人工
        "platformRate": _r(d["_deduction"], 6),
        "returnRate": None,
        "_name": d["_name"],
        "_source": "warehouse",
        # all=按入仓记录汇总；spec=只有入仓品资料、还没录入仓记录，用的是资料上的采购价
        "_period": "spec" if spec_only else "all",
        # 资料价没有实际入仓量，销量如实记 0（虚拟基准不对外暴露）
        "_qty": 0.0 if spec_only else _r(qty, 2),
        "_turnover": 0.0 if spec_only else _r(d["_amount"], 2),
        "_totalQty": 0.0 if spec_only else _r(qty, 2),
        "_totalTurnover": 0.0 if spec_only else _r(d["_amount"], 2),
        "_goodsCost": None if spec_only else _r(d["_cogs"] / qty),
        "_marginRate": None if spec_only else (_r(d["_profit"] / d["_amount"] * 100, 2) if d["_amount"] else None),
        # 按入仓记录汇总时给出「这批采购价最后一次入仓的日期」，便于判断价格是否还新鲜
        "_lastDate": d.get("_lastDate") or "",
    }


@router.get("/sku-costs")
def sku_costs(
    request: Request,
    date_from: str = "",
    date_to: str = "",
    x_api_token: str = Header(""),
    authorization: str = Header(""),
):
    """按京东 skuId 返回单件成本口径（对方成本表的直接替代）。

    查询参数：
    - ``date_from`` / ``date_to``：统计区间，``YYYY-MM-DD``（前导零可省，也支持 ``2026/10/1``）。
      只影响**出库商品**的单件均值，留空表示全量历史。
      入仓品不按区间过滤（采购价是快照，用最近已知价），但会给出 ``_lastDate`` 标明价格日期。
    - 区间内**没有出库记录**的商品不会出现在结果里；每个出库商品都带 ``_firstDate`` /
      ``_lastDate``，可用来确认数据到底落在哪几天。

    鉴权：请求头 ``X-Api-Token: <token>``（或 ``Authorization: Bearer <token>``）。
    令牌连续错误按客户端 IP 分级锁定（见 app/login_guard.py）。
    """
    _require_token(request, x_api_token, authorization)

    # 规范化日期：库里是 YYYY-MM-DD 字符串、区间走字符串比较，
    # 传 2026-10-1 会让 10-01~10-09 被整段过滤掉（详见 _norm_date 注释）
    df = _norm_date(date_from, "date_from")
    dt = _norm_date(date_to, "date_to")
    if df and dt and df > dt:
        df, dt = dt, df

    ck = (df, dt)
    hit = _CACHE.get(ck)
    if hit and datetime.now() - hit[0] < _CACHE_TTL:
        return hit[1]

    # 方案 B：区间汇总 + 全量历史汇总。
    # 区间内没卖的商品也用全量历史给出成本（不让对方回落全店口径），并标 _period=all 让人看得见。
    has_range = bool(df or dt)
    rng = _collect(df, dt) if has_range else None
    full = _collect("", "")
    if rng is None:
        rng = full

    skus: dict = {}
    for code, d in full["warehouse"].items():
        skus[code] = _warehouse_item(d)
    sale_codes = set(full["sale"]) | set(rng["sale"])
    period_count = {"range": 0, "all": 0}
    for code in sale_codes:
        in_range = code in rng["sale"]
        cost = rng["sale"][code] if in_range else full["sale"][code]
        tq, ta = full["sale"][code]["_qty"], full["sale"][code]["_amount"]
        if in_range:
            rq, ra = rng["sale"][code]["_qty"], rng["sale"][code]["_amount"]
            period = "range"
        else:
            rq = ra = 0.0        # 区间内一件没卖，销量如实记 0
            period = "all"
        period_count[period] += 1
        # 同码时出库口径覆盖入仓品口径
        skus[code] = _sale_item(cost, period, rq, ra, tq, ta)

    wh_spec = sum(1 for d in full["warehouse"].values() if d.get("_specOnly"))
    range_dates = sorted({v.get("_lastDate") or "" for v in rng["sale"].values() if v.get("_lastDate")})
    payload = {
        "updatedAt": date.today().isoformat(),
        "default": _defaults(),
        "skus": skus,
        "meta": {
            # 回显规范化后的区间：调用方据此就能发现「自己传的 2026-10-1 被当成别的区间」
            "date_from": df,
            "date_to": dt,
            "date_from_raw": date_from,
            "date_to_raw": date_to,
            # 区间内出库数据实际落在哪几天（可能比所选区间窄，也可能为空）
            "sale_date_range": [range_dates[0], range_dates[-1]] if range_dates else [],
            "warehouse_count": len(get_warehouses()),
            "sku_count": len(skus),
            # cost_period_range_count：成本取自所选区间；cost_period_all_count：区间内没卖、用全量历史兜底
            "cost_period_range_count": period_count["range"],
            "cost_period_all_count": period_count["all"],
            "sale_sku_count": len(rng["sale"]),
            "sale_sku_total": len(full["sale"]),
            "warehouse_sku_count": len(full["warehouse"]),
            # 入仓品里：有实际入仓记录的 / 只有资料价（还没录入仓记录）
            "warehouse_record_count": len(full["warehouse"]) - wh_spec,
            "warehouse_spec_count": wh_spec,
            "failed": full["failed"],
            "note": "supply=结算给我们的单件金额；price 留空请用报表真实客单价；null 回落到 default；"
                    "_period=range 成本取自所选区间，=all 区间内没卖用全量历史兜底，"
                    "=spec 入仓品只有资料、还没录入仓记录（用的是资料上的采购价）；"
                    "_qty/_turnover 是区间内销量，_totalQty/_totalTurnover 是全量历史（判断样本大小用）；"
                    "入仓品不按区间过滤，看 _lastDate 判断采购价日期",
        },
    }
    _CACHE.clear()
    _CACHE[ck] = (datetime.now(), payload)
    return payload