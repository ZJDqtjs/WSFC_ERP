"""快递费规则：多段计费配置，出库时按重量自动计算快递费。"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ..models import User
from ..services import DEFAULT_EXPRESS_CONFIG, load_express_config, save_express_config

router = APIRouter(prefix="/api", tags=["express"])


class ExpressRuleIn(BaseModel):
    mode: str = "tiered"          # tiered=首重+续重；flat=每kg单价
    first_kg_fee: float = 3.6      # 1kg 以内
    per_extra_kg: float = 1.0      # 每超 1kg 加收
    rate_per_kg: float = 3.6       # flat 模式：每 1kg 单价
    round_up: bool = True


def _validate(cfg: ExpressRuleIn):
    if cfg.mode not in ("tiered", "flat"):
        raise HTTPException(400, "计费方式需为 tiered 或 flat")
    for k in ("first_kg_fee", "per_extra_kg", "rate_per_kg"):
        v = float(getattr(cfg, k))
        if v < 0 or v > 10000:
            raise HTTPException(400, f"费用「{k}」需在 0 ~ 10000 之间")


@router.get("/express/rule")
def get_express_rule(user: User = Depends(get_current_user)):
    """返回当前快递费计费配置。"""
    return {**DEFAULT_EXPRESS_CONFIG, **load_express_config()}


@router.put("/express/rule")
def set_express_rule(data: ExpressRuleIn, user: User = Depends(get_current_user)):
    """更新快递费计费配置（实时生效）。"""
    _validate(data)
    saved = save_express_config(data.model_dump())
    return {**DEFAULT_EXPRESS_CONFIG, **saved}