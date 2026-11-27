"""「京麦（POP 店）」自动导入设置与手动入口。

接口（全部要求登录）：
    GET  /api/pop-auto/settings      读设置（含扣点规则预览、下次执行时间）
    POST /api/pop-auto/settings      保存设置（全局 service_url + 当前分仓）
    POST /api/pop-auto/check         探测 jdfenxi 连通与缓存情况
    POST /api/pop-auto/run           立即执行一次（后台线程，前端轮询 status）
    GET  /api/pop-auto/status        当前执行状态
    GET  /api/pop-auto/history       最近执行记录
    POST /api/pop-auto/pending/resolve  未匹配 SKU → 系统商品（写 code_mappings，source=jdpop）
    POST /api/pop-auto/pending/close    关掉一条待办

设置按 ERP 分仓隔离（与「聚水潭」自动出库同一思路），配置存 backend/json/pop_auto.json。
"""

from __future__ import annotations

import threading
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import get_current_user
from ..database import get_current_key, get_db, get_warehouses
from ..models import CodeMapping, User
from ..pop import client, runner
from ..pop import settings as st

router = APIRouter(prefix="/api/pop-auto", tags=["pop-auto"])


class AccountIn(BaseModel):
    account: str
    customer: str = ""      # 写入出库单的店铺名（必须与扣点规则的 shop 一致）
    label: str = ""


class SettingsIn(BaseModel):
    service_url: str | None = None
    enabled: bool | None = None
    accounts: list[AccountIn] | None = None
    price_mode: str = ""
    statuses: list[int] | None = None
    day_cutoff_hour: int | None = None   # 日切点：16 = 昨天16:00~今天16:00 算今天，0 = 自然日
    days: int | None = None
    schedule: list[str] | None = None
    jitter_minutes: int | None = None
    auto_express: bool | None = None
    auto_reverse: bool | None = None
    skip_imported: bool | None = None
    operator: str = ""


class RunIn(BaseModel):
    start: str = ""
    end: str = ""
    dry_run: bool = False
    account: str = ""


class MappingIn(BaseModel):
    external_code: str
    product_id: int


class ResolveIn(BaseModel):
    mappings: list[MappingIn] = []
    close_id: str = ""


class CloseIn(BaseModel):
    id: str
    status: str = "done"


def _shop_deductions() -> dict:
    """店铺扣点规则（与聚水潭导入共用 deduction_config.json）。"""
    from ..routers.imports import _load_shop_deductions

    return _load_shop_deductions()


def _deduction_view(customer: str) -> dict:
    rule = _shop_deductions().get((customer or "").strip())
    if not rule:
        return {"shop": customer, "matched": False, "percent": None, "categories": {},
                "note": "未配置扣点（收入按 100% 计入）"}
    if "percent" in rule:
        pct = float(rule.get("percent") or 0)
        return {"shop": customer, "matched": True, "percent": pct, "categories": {},
                "note": f"店铺扣点 {pct:g}%"}
    cats = {str(k): float(v) for k, v in (rule.get("categories") or {}).items()}
    return {"shop": customer, "matched": True, "percent": None, "categories": cats,
            "note": "分类扣点：" + "、".join(f"{k}{v:g}%" for k, v in cats.items())}


def _validate(data: SettingsIn) -> None:
    if data.schedule:
        from ..jst.config import parse_schedule

        try:
            parse_schedule(data.schedule)
        except ValueError as e:
            raise HTTPException(400, str(e))
    if data.accounts is not None:
        for a in data.accounts:
            if not a.account.strip():
                raise HTTPException(400, "POP 店铺账号不能为空")
            if not (a.customer or a.label or a.account).strip():
                raise HTTPException(400, f"账号 {a.account} 需要填写店铺名（用于扣点与出库单客户）")
    if data.statuses is not None:
        allowed = {c["code"] for c in st.STATUS_CHOICES}
        bad = [x for x in data.statuses if int(x) not in allowed]
        if bad:
            raise HTTPException(400, f"未知的订单状态码：{bad}")
        if 29 in {int(x) for x in data.statuses}:
            raise HTTPException(400, "「已取消」不能作为可导入状态：它只用于把已建的单自动红冲")
    if data.price_mode and data.price_mode not in ("supply", "pay"):
        raise HTTPException(400, "价格口径只能是 supply（供货价）或 pay（买家实付）")
    if data.day_cutoff_hour is not None and not (0 <= int(data.day_cutoff_hour) <= 23):
        raise HTTPException(400, "日切时间只能是 0~23 点（0 = 自然日）")


@router.get("/settings")
def get_settings(user: User = Depends(get_current_user)):
    key = get_current_key()
    d = st.load()
    wh = st.wh_of(d, key)
    name = next((w.get("name") or key for w in get_warehouses() if w.get("key") == key), key)
    pending = st.pending_open(key)
    for a in wh["accounts"]:
        a["deduction"] = _deduction_view(a.get("customer") or a.get("label") or a.get("account") or "")
    return {
        "warehouse": {**wh, "key": key, "name": name},
        "warehouse_key": key,
        "warehouse_name": name,
        "service_url": st.service_url(d),
        "service_url_default": client.DEFAULT_URL,
        "statuses": st.STATUS_CHOICES,
        "price_modes": st.PRICE_MODES,
        "all_warehouses": [{"key": w.get("key"), "name": w.get("name") or w.get("key")}
                           for w in get_warehouses()],
        "next_runs": runner.next_runs_with_jitter(key, wh),
        "scheduler_alive": runner.scheduler_alive(),
        "status": runner.status(),
        "last_run": wh.get("last_run") or {},
        "pending": pending,
        "pending_count": len(pending),
    }


@router.post("/settings")
def save_settings(data: SettingsIn, user: User = Depends(get_current_user)):
    key = get_current_key()
    _validate(data)
    st.patch(st.load(), key, data.model_dump())
    return get_settings(user)


@router.post("/check")
def check(data: SettingsIn | None = None, user: User = Depends(get_current_user)):
    """探测连通性（只读缓存，不会触发 jdfenxi 打开浏览器）。"""
    url = (data.service_url if data and data.service_url else st.service_url())
    return runner.check(url)


@router.post("/run")
def run(data: RunIn, user: User = Depends(get_current_user)):
    """立即执行一次（后台跑；用 /status 看进度，/history 看结果）。"""
    key = get_current_key()
    cfg = st.wh_of(st.load(), key)
    if not cfg.get("accounts"):
        raise HTTPException(400, "请先配置 POP 店铺账号与店铺名")
    if runner.status().get("running"):
        raise HTTPException(409, "已有一轮 POP 导入在执行中，请等它结束")

    def _parse(s: str) -> date | None:
        s = (s or "").strip()
        if not s:
            return None
        try:
            return datetime.strptime(s[:10], "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, f"日期格式应为 YYYY-MM-DD：{s}")

    start, end = _parse(data.start), _parse(data.end)
    if start and end and start > end:
        raise HTTPException(400, "开始日期不能晚于结束日期")

    threading.Thread(
        target=runner.run_once,
        args=(key,),
        kwargs={
            "start": start, "end": end, "dry_run": data.dry_run,
            "trigger": f"{'试算' if data.dry_run else '手动'}·{user.name}",
            "account": data.account,
        },
        name=f"pop-manual-{key}", daemon=True,
    ).start()
    return {"ok": True, "started": True, "warehouse": key, "dry_run": data.dry_run,
            "message": "已开始执行，可点「刷新状态」查看进度"}


@router.get("/status")
def run_status(_: User = Depends(get_current_user)):
    return runner.status()


@router.get("/history")
def history(limit: int = 20, _: User = Depends(get_current_user)):
    key = get_current_key()
    runs = st.wh_of(st.load(), key).get("runs") or []
    return {"runs": runs[: max(1, min(limit, 50))]}


@router.post("/pending/resolve")
def resolve_pending(data: ResolveIn, db=Depends(get_db), user: User = Depends(get_current_user)):
    """把未匹配的京东 SKU 指到系统商品：写 code_mappings(source=jdpop)，之后重跑即可建单。"""
    key = get_current_key()
    saved = 0
    for m in data.mappings:
        code = (m.external_code or "").strip()
        if not code or not m.product_id:
            continue
        row = db.scalar(select(CodeMapping).where(
            CodeMapping.source == "jdpop", CodeMapping.external_code == code))
        if row:
            row.product_id = m.product_id
        else:
            db.add(CodeMapping(source="jdpop", external_code=code,
                               external_name="", product_id=m.product_id))
        saved += 1
    db.commit()
    if data.close_id or saved:
        for t in st.pending_open(key):
            if data.close_id and t.get("id") != data.close_id:
                continue
            st.close_pending(key, t.get("id"), status="done", note=f"已关联 {saved} 条")
            break
    return {"ok": True, "saved": saved, "pending_left": len(st.pending_open(key))}


@router.post("/pending/close")
def close_pending(data: CloseIn, _: User = Depends(get_current_user)):
    key = get_current_key()
    rec = st.close_pending(key, data.id, status=data.status or "done")
    if not rec:
        raise HTTPException(404, "待办不存在")
    return {"ok": True}
