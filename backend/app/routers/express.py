"""快递费规则：多快递公司 + 多段计费配置，出库时按重量自动计算快递费。"""
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ..models import User
from ..services import (
    EXPRESS_CARRIER_FIELDS,
    express_carrier_cfg,
    load_express_config,
    normalize_express_config,
    save_express_config,
)

router = APIRouter(prefix="/api", tags=["express"])


class ExpressRuleIn(BaseModel):
    """旧版单条规则（移动端 / Flutter 仍在用）：更新「默认快递」的规则。"""

    mode: str = "tiered"          # tiered=首重+续重；flat=每kg单价
    first_kg_fee: float = 3.6      # 1kg 以内
    per_extra_kg: float = 1.0      # 每超 1kg 加收
    rate_per_kg: float = 3.6       # flat 模式：每 1kg 单价
    round_up: bool = True


EXPRESS_RULE_KEYS = ("mode", "first_kg_fee", "per_extra_kg", "rate_per_kg", "round_up")


def _flatten(doc: dict) -> dict:
    """接口返回：整份配置 + 默认快递公司的扁平字段（兼容只认单条规则的旧客户端）。"""
    cur = express_carrier_cfg(doc)
    return {"default_carrier": doc["default_carrier"], "carriers": doc["carriers"], **cur}


def _validate_carrier(c: dict):
    name = str(c.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "快递公司名称不能为空")
    if (c.get("mode") or "tiered") not in ("tiered", "flat"):
        raise HTTPException(400, f"「{name}」的计费方式需为 tiered 或 flat")
    for k, label in (("first_kg_fee", "1kg 以内"), ("per_extra_kg", "每超 1kg 加收"),
                     ("rate_per_kg", "每 1kg 单价")):
        if c.get(k) is None or c.get(k) == "":
            continue      # 不填 = 用默认值
        try:
            v = float(c.get(k))
        except (TypeError, ValueError):
            raise HTTPException(400, f"「{name}」的{label}需为数字")
        if v < 0 or v > 10000:
            raise HTTPException(400, f"「{name}」的{label}需在 0 ~ 10000 之间")


@router.get("/express/rule")
def get_express_rule(user: User = Depends(get_current_user)):
    """返回快递费计费配置（多快递公司）+ 默认快递的扁平字段（旧客户端兼容）。"""
    return _flatten(load_express_config())


@router.put("/express/rule")
def set_express_rule(payload: dict = Body(...), user: User = Depends(get_current_user)):
    """更新快递费计费配置（实时生效）。

    - 传 {default_carrier, carriers:[...]}：整份保存（新页面用这个）；
    - 传 {mode, first_kg_fee, ...}：只更新「默认快递」的规则（旧客户端兼容）。
    """
    if "carriers" in payload:
        raw = payload.get("carriers") or []
        if not isinstance(raw, list) or not raw:
            raise HTTPException(400, "至少要保留一家快递公司的计费规则")
        for item in raw:      # 先校验原始输入（名称不能空），再规范化
            _validate_carrier(item if isinstance(item, dict) else {})
        doc = normalize_express_config(payload)
        for c in doc["carriers"]:
            _validate_carrier(c)
        saved = save_express_config(doc)
        return _flatten(saved)

    # 旧格式：单条规则 → 并入默认快递
    doc = load_express_config()
    legacy = ExpressRuleIn(**{k: v for k, v in payload.items() if k in EXPRESS_RULE_KEYS})
    patch = {k: getattr(legacy, k) for k in EXPRESS_CARRIER_FIELDS}
    carriers = []
    for c in doc["carriers"]:
        carriers.append({**c, **patch} if c["id"] == doc["default_carrier"] else c)
    doc = normalize_express_config({"default_carrier": doc["default_carrier"], "carriers": carriers})
    _validate_carrier(express_carrier_cfg(doc))
    saved = save_express_config(doc)
    return _flatten(saved)
