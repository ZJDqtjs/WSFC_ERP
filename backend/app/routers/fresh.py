"""鲜货现采：展示鲜货（蔬菜/干货）库存；导入今日订单预演算需求（只做采购参考，不实际扣库存）。

展示的商品清单可自主配置（增删/排序），配置保存在项目根 json/fresh_config.json，
默认清单参考《每日库存及订单需求统计.py》sheet2「订货单」的品类顺序。
"""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import Product, User
from ..routers.imports import parse_jushuitan_draft
from ..services import unit_to_base

router = APIRouter(prefix="/api/fresh", tags=["fresh"])

ROOT = Path(__file__).resolve().parent.parent.parent


def _config_file() -> Path:
    """鲜货展示清单按分仓隔离：backend/json/fresh_config_{key}.json。"""
    from ..database import get_current_key

    return ROOT / "json" / f"fresh_config_{get_current_key()}.json"


# 鲜货分类（可扩充）
FRESH_CATS = ["蔬菜", "干货"]

# 这些分类在「商品」页默认不显示（各自有独立入口），候选商品与商品页保持一致，不列进来
EXCLUDED_CATS = ["包材", "人工", "快递"]


def _unit(p: Product) -> str:
    return p.default_unit or p.base_unit


def _factor(p: Product, du: str) -> float:
    return (p.conversions or {}).get(du, 1) or 1


def _load_config() -> list[int]:
    """读取展示清单（有序商品 id）。文件缺失/异常返回空（此时展示全部鲜货）。"""
    try:
        d = json.loads(_config_file().read_text(encoding="utf-8"))
        return [int(x) for x in (d.get("ids") or [])]
    except Exception:
        return []


def _save_config(ids: list[int]) -> None:
    fp = _config_file()
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(
        json.dumps({"ids": [int(x) for x in ids]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _fresh_rows(db: Session) -> dict[int, Product]:
    q = db.query(Product).filter(
        Product.category.in_(FRESH_CATS), Product.product_type == "stock", Product.is_active.is_(True)
    )
    return {p.id: p for p in q.all()}


def _list_rows(db: Session, ids: list[int]) -> list[Product]:
    """按展示清单取商品，**不限分类**，顺序跟随清单。

    「鲜货入库」页用它：清单里挑过的商品（哪怕是常温/包材）都要能入库，
    所以这里不按 FRESH_CATS 过滤；已停用 / 不存在 / 非库存商品的 id 直接跳过。
    """
    if not ids:
        return []
    rows = {
        p.id: p
        for p in db.query(Product)
        .filter(
            Product.id.in_(ids), Product.product_type == "stock", Product.is_active.is_(True)
        )
        .all()
    }
    return [rows[i] for i in ids if i in rows]


def _serialize(p: Product) -> dict:
    du, f = _unit(p), _factor(p, _unit(p))
    return {
        "id": p.id,
        "name": p.name,
        "category": p.category,
        "unit": du,
        "stock": round(p.stock / f, 2),
        "avg_cost": round(p.avg_cost * f, 4),
        "stock_value": p.stock_value,
    }


@router.get("")
def fresh_stock(
    only_list: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """按展示清单顺序返回鲜货库存。

    默认（only_list=false）：清单外仍属鲜货分类的商品追加在末尾（鲜货现采页看全量库存用）；
    only_list=true：只返回展示清单里的商品，清单为空就返回空——
    「鲜货入库」页用它，保证「没在清单里挑过的商品不会自己冒出来让入库」。
    """
    rows = _fresh_rows(db)
    ids = _load_config()
    if only_list:
        # 清单里挑过什么就返回什么（不限分类，常温/包材也能进「鲜货入库」）
        ordered = _list_rows(db, ids)
    elif ids:
        ordered = [rows[i] for i in ids if i in rows]
        ordered += sorted((p for p in rows.values() if p.id not in ids), key=lambda p: p.name)
    else:
        ordered = sorted(rows.values(), key=lambda p: p.name)
    return {"items": [_serialize(p) for p in ordered], "ids": ids}


@router.get("/options")
def fresh_options(
    scope: str = "fresh",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """可加入展示清单的候选商品（用于「管理展示商品」）。

    scope=fresh（默认）：只列鲜货分类（蔬菜/干货）；
    scope=all：所有在用的库存商品（不限分类，**与「商品」页口径一致**：
    排除 包材/人工/快递 —— 这几个分类各自有入口，不该混进鲜货入库），
    这样任意正经商品都能放进展示清单、走「鲜货入库」流程。
    """
    q = db.query(Product).filter(Product.product_type == "stock", Product.is_active.is_(True))
    if scope == "all":
        q = q.filter(Product.category.not_in(EXCLUDED_CATS))
    else:
        q = q.filter(Product.category.in_(FRESH_CATS))
    rows = q.order_by(Product.category, Product.name).all()
    return {
        "items": [
            {"id": p.id, "name": p.name, "category": p.category, "unit": p.default_unit or p.base_unit}
            for p in rows
        ],
        "scope": scope,
        "fresh_cats": FRESH_CATS,
    }


class FreshConfigIn(BaseModel):
    ids: list[int] = []


@router.post("/config")
def fresh_config(data: FreshConfigIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """保存展示清单（有序商品 id）。"""
    _save_config(data.ids)
    return {"ok": True, "count": len(data.ids)}


@router.post("/plan")
def fresh_plan(
    file: UploadFile,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """导入今日聚水潭订单，预演算每个蔬菜将消耗的数量（不落库、不扣库存）。

    规则：订单商品（已关联库存商品）→ 按倍数折算到其关联的蔬菜；
          直接销售的库存蔬菜 → 按原数量折算。只统计蔬菜分类。
    """
    # statuses=None：接受「待出库/已出库」等全部状态（需求预演算），仅排除作废单
    drafts, failed, skip, unmapped = parse_jushuitan_draft(file, db, user, statuses=None)

    consume: dict[int, float] = {}  # 蔬菜 product_id -> 需求(基础单位)
    detail: list[dict] = []
    for o in drafts:
        for ln in o.lines:
            p = db.get(Product, ln.product_id)
            if not p:
                continue
            try:
                base = unit_to_base(p, ln.unit, ln.quantity)
            except ValueError:
                continue
            if p.product_type == "order":
                sp = db.get(Product, p.stock_product_id) if p.stock_product_id else None
                if not sp or sp.category not in FRESH_CATS:
                    continue
                # multiplier 以库存默认单位计（如 0.5公斤）；再乘「默认单位→基础单位」系数，
                # 统一折算到库存基础单位累计，与 stock_deduction 扣减口径一致
                du = _unit(sp)
                f = _factor(sp, du)
                base = base * (p.multiplier or 1) * f
                target = sp
            else:
                if p.category not in FRESH_CATS:
                    continue
                target = p
            consume[target.id] = consume.get(target.id, 0) + base
            detail.append({"product": target.name, "qty_base": round(base, 2)})

    items = []
    for pid, need_base in consume.items():
        sp = db.get(Product, pid)
        if not sp:
            continue
        du, f = _unit(sp), _factor(sp, _unit(sp))
        stock = sp.stock / f
        need = need_base / f
        remain = stock - need
        items.append(
            {
                "id": sp.id,
                "name": sp.name,
                "unit": du,
                "stock": round(stock, 2),
                "need": round(need, 2),
                "remain": round(remain, 2),
                "suggest": round(max(0, -remain), 2),
            }
        )
    items.sort(key=lambda x: (x["remain"], x["name"]))

    return {
        "items": items,
        "order_count": len(drafts),
        "failed_count": len(failed),
        "skip": sum(skip.values()),
        "unmapped": sorted(unmapped),
    }
