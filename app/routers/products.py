from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import Product, Unit, User
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
    base_unit: str = "克"
    spec: str = ""
    sale_price: float = 0.0
    conversions: dict[str, float] = {}
    pack_items: list[PackItem] = []
    pack_fee: float = 0.0
    is_active: bool = True


def _to_dict(p: Product) -> dict:
    return {
        "id": p.id,
        "code": p.code,
        "name": p.name,
        "category": p.category,
        "base_unit": p.base_unit,
        "spec": p.spec,
        "sale_price": p.sale_price,
        "conversions": p.conversions or {},
        "pack_items": p.pack_items or [],
        "pack_fee": p.pack_fee,
        "is_active": p.is_active,
        "stock": p.stock,
        "avg_cost": p.avg_cost,
        "stock_value": p.stock_value,
    }


@router.get("/units")
def list_units(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    seed_units(db)
    return [
        {"id": u.id, "name": u.name, "category": u.category, "gram_per_unit": u.gram_per_unit}
        for u in db.execute(select(Unit).order_by(Unit.id)).scalars()
    ]


@router.get("/products")
def list_products(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.execute(select(Product).order_by(Product.is_active.desc(), Product.category, Product.name)).scalars()
    return [_to_dict(p) for p in rows]


@router.post("/products")
def create_product(data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if db.scalar(select(Product).where(Product.name == data.name.strip())):
        raise HTTPException(400, f"商品「{data.name}」已存在")
    conversions = data.conversions or default_conversions(data.base_unit)
    p = Product(
        code=data.code.strip(),
        name=data.name.strip(),
        category=data.category.strip(),
        base_unit=data.base_unit,
        spec=data.spec.strip(),
        sale_price=data.sale_price,
        conversions=conversions,
        pack_items=[item.model_dump() for item in data.pack_items],
        pack_fee=data.pack_fee,
        is_active=data.is_active,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _to_dict(p)


@router.put("/products/{pid}")
def update_product(pid: int, data: ProductIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(Product, pid)
    if not p:
        raise HTTPException(404, "商品不存在")
    dup = db.scalar(select(Product).where(Product.name == data.name.strip(), Product.id != pid))
    if dup:
        raise HTTPException(400, f"商品「{data.name}」已存在")
    p.code = data.code.strip()
    p.name = data.name.strip()
    p.category = data.category.strip()
    p.base_unit = data.base_unit
    p.spec = data.spec.strip()
    p.sale_price = data.sale_price
    p.conversions = data.conversions or default_conversions(data.base_unit)
    p.pack_items = [item.model_dump() for item in data.pack_items]
    p.pack_fee = data.pack_fee
    p.is_active = data.is_active
    db.commit()
    db.refresh(p)
    return _to_dict(p)


@router.delete("/products/{pid}")
def delete_product(pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = db.get(Product, pid)
    if not p:
        raise HTTPException(404, "商品不存在")
    db.delete(p)
    db.commit()
    return {"ok": True}
