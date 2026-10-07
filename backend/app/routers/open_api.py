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
"""
import json
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import load_rules
from ..database import get_sessionmaker, get_warehouses
from ..models import WarehouseIn, WarehouseProduct
from .report import _summary_of

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
_CACHE_TTL = timedelta(minutes=10)


def _configured_token() -> str:
    return str((load_rules().get("open_api") or {}).get("token") or "").strip()


def _require_token(x_api_token: str, authorization: str) -> None:
    expected = _configured_token()
    if not expected:
        raise HTTPException(503, "未配置 open_api.token，接口未开放")
    got = (x_api_token or "").strip()
    if not got and authorization.lower().startswith("bearer "):
        got = authorization[7:].strip()
    if not got or got != expected:
        raise HTTPException(401, "Token 无效")


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
    return out


# ---------------- 入仓品 ----------------
def _sku_rows_warehouse(db: Session) -> dict:
    """按入仓品 sku 汇总入仓记录 → 每袋结算收入（京东采购价）/ 运费 / 包材 / 毛利率。"""
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
        )
        .select_from(WarehouseIn)
        .join(WarehouseProduct, WarehouseProduct.id == WarehouseIn.product_id, isouter=True)
        .where(func.coalesce(WarehouseIn.pay_status, PAID) != "unpaid")
        .group_by(WarehouseProduct.sku)
    ).all()
    out: dict = {}
    for sku, qty, amount, gross, freight, pack, cogs, profit, ded, name in rows:
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
        }
    return out


def _merge_into(dst: dict, src: dict) -> dict:
    """把一个仓的汇总累加进总表；同一 skuId 两边都有时以出库口径为准。"""
    for code, d in src.items():
        cur = dst.get(code)
        if cur is None:
            dst[code] = dict(d)
        elif cur.get("_source") != "warehouse":      # 已有出库口径 → 继续累加
            for k, v in d.items():
                if k in ("_name", "_deduction", "_source"):
                    continue
                cur[k] = float(cur.get(k) or 0) + float(v or 0)
        else:                                        # 已有入仓口径，被出库口径覆盖
            dst[code] = dict(d)
    return dst


def _collect(date_from: str, date_to: str) -> dict:
    """跨全部分仓汇总（单仓读取失败只记一条，不影响其它仓）。"""
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
    return {"sale": sale, "warehouse": wh, "failed": failed}


# ---------------- 输出 ----------------
def _r(v, n: int = 4):
    return round(float(v), n)


def _sale_item(d: dict) -> dict:
    """订单商品 → 对方成本表的一行。"""
    qty = d["_qty"]
    amount = d["_amount"]
    gross = d["_gross"] or amount
    return {
        # 京东结算给我们的单件金额（卖家实收 ÷ 件数）——对方口径里的「真实供货价」
        "supply": _r(amount / qty),
        "supplyGross": _r(gross / qty),
        # 单件扣点前售价：对方留空则继续用它报表里的真实客单价
        "price": None,
        "shipping": _r(d["_express"] / qty),
        "package": _r(d["_material"] / qty),
        "labor": _r(d["_labor"] / qty),
        # 导入时已按店铺扣点从销售额里扣掉，这里反推真实扣点比例
        "platformRate": _r((gross - amount) / gross, 6) if gross else None,
        "returnRate": None,   # ERP 不记退货率，交给对方 default
        # 以下为附带信息，便于人工核对（对方可忽略）
        "_name": d["_name"],
        "_source": "sale",
        "_qty": _r(qty, 2),
        "_turnover": _r(amount, 2),
        "_goodsCost": _r(d["_cogs"] / qty),   # 我方买货成本，仅供参考，不等于 supply
    }


def _warehouse_item(d: dict) -> dict:
    """入仓品 → 对方成本表的一行。"""
    qty = d["_qty"]
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
        "_qty": _r(qty, 2),
        "_turnover": _r(d["_amount"], 2),
        "_goodsCost": _r(d["_cogs"] / qty),
        "_marginRate": _r(d["_profit"] / d["_amount"] * 100, 2) if d["_amount"] else None,
    }


@router.get("/sku-costs")
def sku_costs(
    date_from: str = "",
    date_to: str = "",
    x_api_token: str = Header(""),
    authorization: str = Header(""),
):
    """按京东 skuId 返回单件成本口径（对方成本表的直接替代）。

    查询参数：
    - ``date_from`` / ``date_to``：统计区间（YYYY-MM-DD），只影响**出库商品**的单件均值；
      留空表示全量历史。入仓品始终按全部记录汇总。

    鉴权：请求头 ``X-Api-Token: <token>``（或 ``Authorization: Bearer <token>``）。
    """
    _require_token(x_api_token, authorization)

    ck = (date_from, date_to)
    hit = _CACHE.get(ck)
    if hit and datetime.now() - hit[0] < _CACHE_TTL:
        return hit[1]

    data = _collect(date_from, date_to)
    skus: dict = {}
    for code, d in data["warehouse"].items():
        skus[code] = _warehouse_item(d)
    for code, d in data["sale"].items():      # 同码时出库口径覆盖入仓品口径
        skus[code] = _sale_item(d)

    payload = {
        "updatedAt": date.today().isoformat(),
        "default": _defaults(),
        "skus": skus,
        "meta": {
            "date_from": date_from,
            "date_to": date_to,
            "warehouse_count": len(get_warehouses()),
            "sku_count": len(skus),
            "sale_sku_count": len(data["sale"]),
            "warehouse_sku_count": len(data["warehouse"]),
            "failed": data["failed"],
            "note": "supply=结算给我们的单件金额；price 留空请用报表真实客单价；"
                    "null 字段回落到 default；_ 前缀为附带信息可忽略",
        },
    }
    _CACHE.clear()
    _CACHE[ck] = (datetime.now(), payload)
    return payload