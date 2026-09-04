from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import (
    CodeMapping,
    Inbound,
    OutboundLine,
    Product,
    StockMovement,
    Unit,
    User,
)
from ..services import default_conversions, seed_units

router = APIRouter(prefix="/api", tags=["products"])


class PackItem(BaseModel):
    product_id: int
    quantity: float
    unit: str = "个"


class ProductIn(BaseModel):
    code: str = ""
    name: str
    category: str = ""
    product_type: str = "stock"  # stock 库存商品 / order 订单商品
    base_unit: str = "克"
    default_unit: str = ""
    spec: str = ""
    sale_price: float = 0.0
    unit_cost: float = 0.0
    conversions: dict[str, float] = {}
    pack_items: list[PackItem] = []
    pack_fee: float = 0.0
    stock_product_id: int | None = None  # 订单商品关联的库存商品
    multiplier: float = 1.0  # 1单订单商品 = multiplier × 库存商品默认单位
    is_active: bool = True


def _to_dict(p: Product, db: Session | None = None) -> dict:
    sp_name = ""
    if p.stock_product_id and db:
        sp = db.get(Product, p.stock_product_id)
        sp_name = sp.name if sp else ""
    return {
        "id": p.id,
        "code": p.code,
        "name": p.name,
        "category": p.category,
        "product_type": p.product_type,
        "base_unit": p.base_unit,
        "default_unit": p.default_unit,
        "spec": p.spec,
        "sale_price": p.sale_price,
        "unit_cost": p.unit_cost,
        "conversions": p.conversions or {},
        "pack_items": p.pack_items or [],
        "pack_fee": p.pack_fee,
        "stock_product_id": p.stock_product_id,
        "stock_product_name": sp_name,
        "multiplier": p.multiplier,
        "is_active": p.is_active,
        "stock": p.stock,
        "avg_cost": p.avg_cost,
        "stock_value": p.stock_value,
        "workload": getattr(p, "workload", 0) or 0,
    }


def _validate_stock_link(db: Session, data: ProductIn) -> int | None:
    """订单商品关联的库存商品校验（必须存在且是库存商品）。"""
    if not data.stock_product_id:
        return None
    sp = db.get(Product, data.stock_product_id)
    if not sp:
        raise HTTPException(400, "关联的库存商品不存在")
    if sp.product_type != "stock":
        raise HTTPException(400, "只能关联「库存商品」（大类）作为扣减对象")
    return sp.id


@router.get("/stocks")
def list_stock_products(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """库存商品（大类）列表，供订单商品关联选择。"""
    rows = db.execute(
        select(Product).where(Product.product_type == "stock").order_by(Product.category, Product.name)
    ).scalars()
    return [
        {
            "id": p.id, "name": p.name, "category": p.category,
            "base_unit": p.base_unit, "default_unit": p.default_unit or p.base_unit,
            "conversions": p.conversions or {}, "stock": p.stock,
        }
        for p in rows
    ]


@router.get("/units")
def list_units(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    seed_units(db)
    return [
        {"id": u.id, "name": u.name, "category": u.category, "gram_per_unit": u.gram_per_unit}
        for u in db.execute(select(Unit).order_by(Unit.id)).scalars()
    ]


class UnitIn(BaseModel):
    name: str
    category: str  # weight / count
    gram_per_unit: float | None = None


@router.post("/units")
def create_unit(data: UnitIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "单位名称不能为空")
    if data.category not in ("weight", "count"):
        raise HTTPException(400, "类型必须为 weight 或 count")
    if db.scalar(select(Unit).where(Unit.name == name)):
        raise HTTPException(400, f"单位「{name}」已存在")
    if data.category == "weight" and (not data.gram_per_unit or data.gram_per_unit <= 0):
        raise HTTPException(400, "重量类单位必须填写每单位克数")
    u = Unit(
        name=name,
        category=data.category,
        gram_per_unit=data.gram_per_unit if data.category == "weight" else None,
        is_standard=False,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return {"id": u.id, "name": u.name, "category": u.category, "gram_per_unit": u.gram_per_unit}


@router.delete("/units/{uid}")
def delete_unit(uid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    u = db.get(Unit, uid)
    if not u:
        raise HTTPException(404, "单位不存在")
    if u.is_standard:
        raise HTTPException(400, "标准单位不可删除")
    db.delete(u)
    db.commit()
    return {"ok": True}


@router.get("/products")
def list_products(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.execute(select(Product).order_by(Product.is_active.desc(), Product.category, Product.name)).scalars()
    return [_to_dict(p, db) for p in rows]


@router.post("/products")
def create_product(data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if db.scalar(select(Product).where(Product.name == data.name.strip())):
        raise HTTPException(400, f"商品「{data.name}」已存在")
    if data.product_type not in ("stock", "order"):
        raise HTTPException(400, "商品类型必须为 stock 或 order")
    sp_id = _validate_stock_link(db, data)
    conversions = data.conversions or default_conversions(data.base_unit)
    p = Product(
        code=data.code.strip(),
        name=data.name.strip(),
        category=data.category.strip(),
        product_type=data.product_type,
        base_unit=data.base_unit,
        default_unit=(data.default_unit or data.base_unit),
        spec=data.spec.strip(),
        sale_price=data.sale_price,
        unit_cost=data.unit_cost,
        conversions=conversions,
        pack_items=[item.model_dump() for item in data.pack_items],
        pack_fee=data.pack_fee,
        stock_product_id=sp_id,
        multiplier=data.multiplier,
        is_active=data.is_active,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _to_dict(p, db)


@router.put("/products/{pid}")
def update_product(pid: int, data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(Product, pid)
    if not p:
        raise HTTPException(404, "商品不存在")
    dup = db.scalar(select(Product).where(Product.name == data.name.strip(), Product.id != pid))
    if dup:
        raise HTTPException(400, f"商品「{data.name}」已存在")
    if data.product_type not in ("stock", "order"):
        raise HTTPException(400, "商品类型必须为 stock 或 order")
    sp_id = _validate_stock_link(db, data)
    p.code = data.code.strip()
    p.name = data.name.strip()
    p.category = data.category.strip()
    p.product_type = data.product_type
    p.base_unit = data.base_unit
    p.default_unit = data.default_unit or data.base_unit
    p.spec = data.spec.strip()
    p.sale_price = data.sale_price
    p.unit_cost = data.unit_cost
    p.conversions = data.conversions or default_conversions(data.base_unit)
    p.pack_items = [item.model_dump() for item in data.pack_items]
    p.pack_fee = data.pack_fee
    p.stock_product_id = sp_id
    p.multiplier = data.multiplier
    p.is_active = data.is_active
    db.commit()
    db.refresh(p)
    return _to_dict(p, db)


@router.delete("/products/{pid}")
def delete_product(pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(Product, pid)
    if not p:
        raise HTTPException(404, "商品不存在")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ---------- 批量操作 ----------
class BatchIds(BaseModel):
    ids: list[int]


class BatchProductUpdate(BaseModel):
    ids: list[int]
    category: str | None = None
    default_unit: str | None = None
    is_active: bool | None = None
    sale_price: float | None = None
    unit_cost: float | None = None
    pack_fee: float | None = None


def _product_referenced(db: Session, pid: int) -> bool:
    """该商品是否已被单据/流水/编码关联/其他商品关联或订单商品引用。"""
    for model in (StockMovement, Inbound, OutboundLine, CodeMapping):
        if db.scalar(select(func.count()).select_from(model).where(model.product_id == pid)):
            return True
    # 被其他商品的关联结算清单引用，或被订单商品作为库存关联引用
    for o in db.execute(select(Product).where(Product.id != pid)).scalars():
        if o.stock_product_id == pid:
            return True
        if any((it or {}).get("product_id") == pid for it in (o.pack_items or [])):
            return True
    return False


@router.post("/products/batch-delete")
def batch_delete_products(data: BatchIds, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    deleted, blocked = 0, []
    for pid in data.ids:
        p = db.get(Product, pid)
        if not p:
            continue
        if _product_referenced(db, pid):
            blocked.append(p.name)
            continue
        db.delete(p)
        deleted += 1
    db.commit()
    return {"ok": True, "deleted": deleted, "blocked": blocked}


@router.post("/products/batch-update")
def batch_update_products(data: BatchProductUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    updated = 0
    for pid in data.ids:
        p = db.get(Product, pid)
        if not p:
            continue
        if data.category is not None:
            p.category = data.category.strip()
        if data.default_unit is not None and data.default_unit in (p.conversions or {}):
            p.default_unit = data.default_unit
        if data.is_active is not None:
            p.is_active = data.is_active
        if data.sale_price is not None:
            p.sale_price = data.sale_price
        if data.unit_cost is not None:
            p.unit_cost = data.unit_cost
        if data.pack_fee is not None:
            p.pack_fee = data.pack_fee
        updated += 1
    db.commit()
    return {"ok": True, "updated": updated}
