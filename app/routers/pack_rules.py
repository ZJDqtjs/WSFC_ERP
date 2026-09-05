"""一单多货（多货打包）规则：合并多条订单商品 → 打包用的纸箱/人工 维护与查询。"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import PackRule, Product, User

router = APIRouter(prefix="/api", tags=["pack-rules"])


class RuleItemIn(BaseModel):
    product_id: int | None = None  # 关联的订单商品，可为空
    name: str  # 商品名（关联时使用订单商品名；未关联时为原文）
    quantity: float = 1.0


class PackRuleIn(BaseModel):
    items: list[RuleItemIn]
    box_type: str = ""
    labor_price: float | None = None
    box_ratio: float = 1.0
    remark: str = ""
    is_active: bool = True


def _gen_name(items: list[RuleItemIn]) -> str:
    """组合标识：如 '七彩土豆3斤*1,京鲜生七彩花生1斤*1'。quantity 为 1 时省略 *1。"""
    parts = []
    for it in items:
        n = (it.name or "").strip()
        q = it.quantity or 0
        parts.append(f"{n}*{q}" if q != 1 else n)
    return ",".join(p for p in parts if p)


def _to_dict(r: PackRule, db: Session) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "items": r.items or [],
        "box_type": r.box_type,
        "labor_price": r.labor_price,
        "box_ratio": r.box_ratio,
        "remark": r.remark,
        "is_active": r.is_active,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.get("/pack-rules")
def list_pack_rules(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.execute(select(PackRule).order_by(PackRule.name)).scalars()
    return [_to_dict(r, db) for r in rows]


def _validate_items(db: Session, items: list[RuleItemIn]):
    if not items:
        raise HTTPException(400, "至少需要一条组合商品")
    for it in items:
        if not (it.name or "").strip():
            raise HTTPException(400, "组合商品名不能为空")
        if (it.quantity or 0) <= 0:
            raise HTTPException(400, f"商品「{it.name}」的数量必须大于 0")
        if it.product_id:
            p = db.get(Product, it.product_id)
            if not p:
                raise HTTPException(400, f"关联的订单商品「{it.name}」不存在")
            # 关联时以订单商品名称为准
            if it.name:
                it.name = p.name


@router.post("/pack-rules")
def create_pack_rule(data: PackRuleIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _validate_items(db, data.items)
    name = _gen_name(data.items)
    if db.scalar(select(PackRule).where(PackRule.name == name)):
        raise HTTPException(400, f"该一单多货组合「{name}」已存在")
    r = PackRule(
        name=name,
        items=[it.model_dump() for it in data.items],
        box_type=data.box_type.strip(),
        labor_price=data.labor_price,
        box_ratio=data.box_ratio or 1,
        remark=data.remark.strip(),
        is_active=data.is_active,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return _to_dict(r, db)


@router.put("/pack-rules/{rid}")
def update_pack_rule(rid: int, data: PackRuleIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.get(PackRule, rid)
    if not r:
        raise HTTPException(404, "规则不存在")
    _validate_items(db, data.items)
    name = _gen_name(data.items)
    dup = db.scalar(select(PackRule).where(PackRule.name == name, PackRule.id != rid))
    if dup:
        raise HTTPException(400, f"该一单多货组合「{name}」已存在")
    r.name = name
    r.items = [it.model_dump() for it in data.items]
    r.box_type = data.box_type.strip()
    r.labor_price = data.labor_price
    r.box_ratio = data.box_ratio or 1
    r.remark = data.remark.strip()
    r.is_active = data.is_active
    db.commit()
    db.refresh(r)
    return _to_dict(r, db)


@router.delete("/pack-rules/{rid}")
def delete_pack_rule(rid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.get(PackRule, rid)
    if not r:
        raise HTTPException(404, "规则不存在")
    db.delete(r)
    db.commit()
    return {"ok": True}