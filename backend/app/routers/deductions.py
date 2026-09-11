"""扣点规则：按商品类别配置入库扣点百分比（批量导入→入库 解析进货单价时折算）。"""
import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import Deduction, User

router = APIRouter(prefix="/api", tags=["deduction"])

# 店铺扣点规则 json（聚水潭订单按店铺名称扣减收入）
DEDUCTION_CONFIG_FILE = Path(__file__).resolve().parent.parent.parent / "json" / "deduction_config.json"


class DeductionIn(BaseModel):
    category: str
    percent: float = 0.0
    remark: str = ""


class ShopDeducIn(BaseModel):
    shop: str
    percent: float | None = None  # 固定扣点
    categories: dict[str, float] | None = None  # 按分类扣点


def _to_dict(d: Deduction) -> dict:
    return {
        "id": d.id,
        "category": d.category,
        "percent": d.percent,
        "remark": d.remark,
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "updated_at": d.updated_at.isoformat() if d.updated_at else None,
    }


@router.get("/deductions")
def list_deductions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.execute(select(Deduction).order_by(Deduction.category)).scalars()
    return [_to_dict(d) for d in rows]


def _read_shop_rules() -> list[dict]:
    try:
        data = json.loads(DEDUCTION_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    return [r for r in (data.get("rules") or []) if (r.get("shop") or "").strip()]


def _write_shop_rules(rules: list[dict]) -> None:
    DEDUCTION_CONFIG_FILE.write_text(
        json.dumps({"rules": rules}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/deductions/shops")
def list_shop_deductions(user: User = Depends(get_current_user)):
    """返回店铺扣点规则（供页面展示/编辑）。"""
    return {"file": str(DEDUCTION_CONFIG_FILE), "rules": _read_shop_rules()}


@router.post("/deductions/shops")
def upsert_shop_deduction(data: ShopDeducIn, user: User = Depends(get_current_user)):
    """按店铺名称新增或更新扣点规则（写入 deduction_config.json，实时生效）。"""
    shop = (data.shop or "").strip()
    if not shop:
        raise HTTPException(400, "店铺名称不能为空")
    if data.percent is not None:
        if data.percent < 0 or data.percent >= 100:
            raise HTTPException(400, "固定扣点百分比需在 0 ~ 100 之间（不含 100）")
        rule = {"shop": shop, "percent": round(float(data.percent), 4)}
    elif data.categories:
        cats = {
            str(k).strip(): round(float(v), 4)
            for k, v in (data.categories or {}).items()
            if v is not None and float(v) > 0 and str(k).strip()
        }
        if not cats:
            raise HTTPException(400, "请至少填写一个「分类 ≥ 0」的扣点")
        rule = {"shop": shop, "categories": cats}
    else:
        raise HTTPException(400, "请选择「固定扣点」或填写「按分类扣点」")
    rules = [r for r in _read_shop_rules() if (r.get("shop") or "").strip() != shop]
    rules.append(rule)
    _write_shop_rules(rules)
    return {"ok": True, "rules": rules}


@router.delete("/deductions/shops/{shop}")
def delete_shop_deduction(shop: str, user: User = Depends(get_current_user)):
    """按店铺名称删除扣点规则。"""
    shop = shop.strip()
    rules = [r for r in _read_shop_rules() if (r.get("shop") or "").strip() != shop]
    _write_shop_rules(rules)
    return {"ok": True, "rules": rules}


@router.post("/deductions")
def upsert_deduction(data: DeductionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """按商品类别新增或更新扣点规则（类别唯一）。"""
    category = data.category.strip()
    if not category:
        raise HTTPException(400, "商品类别不能为空")
    if data.percent < 0 or data.percent >= 100:
        raise HTTPException(400, "扣点百分比必须在 0 ~ 100 之间（不含 100）")
    d = db.scalar(select(Deduction).where(Deduction.category == category))
    if d:
        d.percent = data.percent
        d.remark = data.remark.strip()
        d.updated_at = datetime.now()
    else:
        d = Deduction(category=category, percent=data.percent, remark=data.remark.strip())
        db.add(d)
    db.commit()
    db.refresh(d)
    return _to_dict(d)


@router.delete("/deductions/{did}")
def delete_deduction(did: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    d = db.get(Deduction, did)
    if not d:
        raise HTTPException(404, "扣点规则不存在")
    db.delete(d)
    db.commit()
    return {"ok": True}
