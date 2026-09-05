"""一单多货（多货打包）规则：合并多条订单商品 → 打包用的纸箱/人工 维护与查询。"""
import re

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


class BoxItemIn(BaseModel):
    product_id: int | None = None  # 关联的包材纸箱，可为空
    name: str = ""  # 箱型号显示名，如 3号 / 邮政6号
    quantity: float = 1.0


class PackRuleIn(BaseModel):
    items: list[RuleItemIn]
    box_items: list[BoxItemIn] = []
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


def _model_from_box_product(name: str) -> str:
    """包材商品名 → 箱型号显示名：'3号纸箱'→'3号'；'松茸6号箱'→'松茸6号'；'8号拖箱'/'高珍果箱'保持原样。"""
    n = (name or "").strip()
    if n.endswith("纸箱"):
        return n[:-2]
    if n.endswith("号箱"):
        return n[:-1]
    return n


def _resolve_box_product(db: Session, name: str) -> Product | None:
    """按箱型号名匹配包材纸箱商品：精确 / +'纸箱' / +'箱'。"""
    for cand in (name, name + "纸箱", name + "箱"):
        p = db.scalar(select(Product).where(Product.name == cand))
        if p:
            return p
    return None


def _box_type_to_items(box_type: str) -> list[dict]:
    """把 '7号+8号' / '6号*2+7号*2' 解析成 [{name, quantity}]。"""
    out = []
    for part in str(box_type or "").split("+"):
        part = part.strip()
        if not part:
            continue
        m = re.search(r"\*(\d+)$", part)
        if m:
            name, qty = part[: m.start()], int(m.group(1))
        else:
            name, qty = part, 1
        if name:
            out.append({"name": name, "quantity": qty})
    return out


def _link_box_items(db: Session, items: list[dict]) -> list[dict]:
    """把箱条目关联到包材商品：有 product_id 则校验；否则按型号名解析。存显示名=箱型号。"""
    out = []
    for it in items:
        name = (it.get("name") or "").strip()
        qty = float(it.get("quantity") or 1) or 1
        pid = it.get("product_id")
        if pid and not db.get(Product, pid):
            pid = None
        p = db.get(Product, pid) if pid else None
        if not p:
            p = _resolve_box_product(db, name)
        if p:
            out.append({"product_id": p.id, "name": _model_from_box_product(p.name), "quantity": qty})
        else:
            out.append({"product_id": None, "name": name, "quantity": qty})
    return out


def _box_type_from_items(items: list[dict]) -> str:
    """由箱条目生成箱型号文本：'7号' / '6号*2+7号*2'。"""
    return "+".join(f"{it['name']}*{int(it['quantity'])}" if int(it["quantity"]) > 1 else it["name"] for it in items)


def _to_dict(r: PackRule) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "items": r.items or [],
        "box_type": r.box_type,
        "box_items": r.box_items or [],
        "labor_price": r.labor_price,
        "box_ratio": r.box_ratio,
        "remark": r.remark,
        "is_active": r.is_active,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.get("/pack-rules")
def list_pack_rules(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.execute(select(PackRule).order_by(PackRule.name)).scalars()
    return [_to_dict(r) for r in rows]


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


def _prepare(db: Session, data: PackRuleIn):
    """规范化组合与箱型：校验 items，解析 box_items 并生成 box_type。"""
    _validate_items(db, data.items)
    name = _gen_name(data.items)
    box_items = [it.model_dump() for it in data.box_items]
    if not box_items:
        box_items = _box_type_to_items(data.box_type)
    if box_items:
        box_items = _link_box_items(db, box_items)
        box_type = _box_type_from_items(box_items)
    else:
        box_type = ""
    for it in box_items:
        if (it.get("quantity") or 1) <= 0:
            raise HTTPException(400, f"箱型「{it.get('name')}」的数量必须大于 0")
    return name, box_items, box_type


@router.post("/pack-rules")
def create_pack_rule(data: PackRuleIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    name, box_items, box_type = _prepare(db, data)
    if db.scalar(select(PackRule).where(PackRule.name == name)):
        raise HTTPException(400, f"该一单多货组合「{name}」已存在")
    r = PackRule(
        name=name,
        items=[it.model_dump() for it in data.items],
        box_type=box_type,
        box_items=box_items,
        labor_price=data.labor_price,
        box_ratio=data.box_ratio or 1,
        remark=data.remark.strip(),
        is_active=data.is_active,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return _to_dict(r)


@router.put("/pack-rules/{rid}")
def update_pack_rule(rid: int, data: PackRuleIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.get(PackRule, rid)
    if not r:
        raise HTTPException(404, "规则不存在")
    name, box_items, box_type = _prepare(db, data)
    dup = db.scalar(select(PackRule).where(PackRule.name == name, PackRule.id != rid))
    if dup:
        raise HTTPException(400, f"该一单多货组合「{name}」已存在")
    r.name = name
    r.items = [it.model_dump() for it in data.items]
    r.box_type = box_type
    r.box_items = box_items
    r.labor_price = data.labor_price
    r.box_ratio = data.box_ratio or 1
    r.remark = data.remark.strip()
    r.is_active = data.is_active
    db.commit()
    db.refresh(r)
    return _to_dict(r)


@router.delete("/pack-rules/{rid}")
def delete_pack_rule(rid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.get(PackRule, rid)
    if not r:
        raise HTTPException(404, "规则不存在")
    db.delete(r)
    db.commit()
    return {"ok": True}