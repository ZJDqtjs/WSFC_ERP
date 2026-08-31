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
CONFIG_FILE = ROOT / "json" / "fresh_config.json"

# 鲜货分类（可扩充）
FRESH_CATS = ["蔬菜", "干货"]


def _unit(p: Product) -> str:
    return p.default_unit or p.base_unit


def _factor(p: Product, du: str) -> float:
    return (p.conversions or {}).get(du, 1) or 1


def _load_config() -> list[int]:
    """读取展示清单（有序商品 id）。文件缺失/异常返回空（此时展示全部鲜货）。"""
    try:
        d = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return [int(x) for x in (d.get("ids") or [])]
    except Exception:
        return []


def _save_config(ids: list[int]) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        json.dumps({"ids": [int(x) for x in ids]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _fresh_rows(db: Session) -> dict[int, Product]:
    q = db.query(Product).filter(
        Product.category.in_(FRESH_CATS), Product.product_type == "stock", Product.is_active.is_(True)
    )
    return {p.id: p for p in q.all()}


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
def fresh_stock(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """按展示清单顺序返回鲜货库存；清单外仍属鲜货分类的商品追加在末尾。"""
    rows = _fresh_rows(db)
    ids = _load_config()
    if ids:
        ordered = [rows[i] for i in ids if i in rows]
        ordered += sorted((p for p in rows.values() if p.id not in ids), key=lambda p: p.name)
    else:
        ordered = sorted(rows.values(), key=lambda p: p.name)
    return {"items": [_serialize(p) for p in ordered], "ids": ids}


@router.get("/options")
def fresh_options(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """全部可选的鲜货商品（用于管理展示清单）。"""
    q = db.query(Product).filter(
        Product.category.in_(FRESH_CATS), Product.product_type == "stock", Product.is_active.is_(True)
    ).order_by(Product.name)
    return {
        "items": [
            {"id": p.id, "name": p.name, "category": p.category, "unit": p.default_unit or p.base_unit}
            for p in q.all()
        ]
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
    drafts, failed, skip, unmapped = parse_jushuitan_draft(file, db, user)

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
                base *= p.multiplier or 1
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
        "skip": len(skip),
        "unmapped": sorted(unmapped),
    }
