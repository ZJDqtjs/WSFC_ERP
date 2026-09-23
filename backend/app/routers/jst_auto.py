"""自动出库设置（聚水潭销售出库单定时自动导出并导入）。

接口：
    GET  /api/jst-auto/settings        读设置（口令类只回"是否已设置"）
    POST /api/jst-auto/settings        保存设置（全局 + 当前分仓）
    POST /api/jst-auto/check           检查聚水潭登录态
    POST /api/jst-auto/jst-warehouses  拉取聚水潭分仓列表（供勾选）
    POST /api/jst-auto/run             立即执行一次（后台跑，前端轮询 status）
    GET  /api/jst-auto/status          当前执行状态 / 最近一次结果
    GET  /api/jst-auto/history         最近执行记录

设置按 ERP 分仓隔离：一个登录会话只看到/修改自己分仓的配置，全局账号是所有分仓共用。
"""

from __future__ import annotations

import threading
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ..database import get_current_key, get_warehouses
from ..jst import runner
from ..jst import settings as st
from ..jst.config import WINDOW_CHOICES, WINDOW_HELP, parse_datetime, parse_schedule, resolve_window
from ..models import User

router = APIRouter(prefix="/api/jst-auto", tags=["jst-auto"])


class TargetIn(BaseModel):
    co_id: str
    name: str = ""


class WhSettingsIn(BaseModel):
    enabled: bool | None = None
    targets: list[TargetIn] | None = None
    window: str = ""
    fixed_from: str = ""
    fixed_to: str = ""
    schedule: list[str] | None = None
    auto_import: bool | None = None
    skip_imported: bool | None = None
    operator: str = ""


class GlobalSettingsIn(BaseModel):
    account: str = ""
    password: str = ""       # 留空 = 不修改
    cookie: str = ""         # 留空 = 不修改（清空请用 clear_cookie）
    owner_co_id: str = ""
    min_interval: float | None = None
    timeout: float | None = None
    max_retries: int | None = None
    io_date_field: str = ""
    filename_template: str = ""
    clear_cookie: bool = False
    notify_webhook: str = ""        # 待办 webhook（企业微信/钉钉机器人、Server酱、Bark 都能收）
    notify_users: list[str] | None = None   # 登录后弹窗提醒的账号名单，空 = 所有管理员


class MappingItemIn(BaseModel):
    external_code: str
    product_id: int | None = None


class ResolvePendingIn(BaseModel):
    mappings: list[MappingItemIn] = []   # 商品资料待补全：聚水潭商品名 → 系统商品
    verify_code: str = ""                # 需要验证码时：人工填的验证码
    cookie: str = ""                     # 或直接粘贴浏览器里的 Cookie（最稳）
    note: str = ""


class SaveIn(BaseModel):
    globals: GlobalSettingsIn | None = None
    warehouse: WhSettingsIn | None = None


class RunIn(BaseModel):
    targets: list[str] | None = None   # 只跑指定的聚水潭分仓（co_id），留空=按设置
    window: str = ""                   # 临时覆盖区间规则
    start: str = ""                    # 固定区间（与 end 成对）
    end: str = ""
    do_import: bool | None = None      # False = 只下载不建单（试跑）


def _validate_wh(data: WhSettingsIn) -> None:
    """保存前校验：定时时间与区间规则写错要立刻报错，而不是等定时到点才失败。"""
    if data.schedule:
        try:
            parse_schedule(data.schedule)
        except ValueError as e:
            raise HTTPException(400, str(e))
    if data.window:
        try:
            resolve_window(data.window, datetime.now())
        except ValueError as e:
            raise HTTPException(400, str(e))
    if data.fixed_from or data.fixed_to:
        if not (data.fixed_from and data.fixed_to):
            raise HTTPException(400, "固定区间必须同时填写开始与结束时间（留空则用区间规则）")
        try:
            start, end = parse_datetime(data.fixed_from), parse_datetime(data.fixed_to)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if start >= end:
            raise HTTPException(400, "固定区间的开始时间必须早于结束时间")


@router.get("/settings")
def get_settings(user: User = Depends(get_current_user)):
    key = get_current_key()
    d = st.load()
    wh = st.wh_of(d, key)
    name = next((w.get("name") or key for w in get_warehouses() if w.get("key") == key), key)
    pending = st.pending_open(key)
    return {
        "globals": {**st.public_globals(d), "notify_webhook": st.globals_view(d).get("notify_webhook", ""),
                    "notify_users": st.globals_view(d).get("notify_users", [])},
        "warehouse": {**wh, "key": key, "name": name},
        "warehouse_key": key,
        "warehouse_name": name,
        "all_warehouses": [{"key": w.get("key"), "name": w.get("name") or w.get("key")} for w in get_warehouses()],
        "windows": [{"value": v, "label": lb} for v, lb in WINDOW_CHOICES],
        "window_help": WINDOW_HELP,
        "next_runs": st.next_runs(wh.get("schedule") or []),
        "status": runner.status(),
        "last_run": wh.get("last_run") or {},
        "pending": [{"id": t.get("id"), "type": t.get("type"), "message": t.get("message"),
                     "created_at": t.get("created_at")} for t in pending],
        "pending_count": len(pending),
    }


@router.post("/settings")
def save_settings(data: SaveIn, user: User = Depends(get_current_user)):
    key = get_current_key()
    if data.globals is not None:
        g = data.globals.model_dump()
        # 普通字段照原样保存（清空就是清空）；口令类留空表示「不修改」，
        # 想清掉 Cookie 请显式勾选 clear_cookie（避免前端不回显导致每次保存都被清空）。
        patch = {
            "account": g["account"],
            "owner_co_id": g["owner_co_id"],
            "io_date_field": g["io_date_field"],
            "filename_template": g["filename_template"],
            "min_interval": g["min_interval"],
            "timeout": g["timeout"],
            "max_retries": g["max_retries"],
        }
        if g.get("password"):
            patch["password"] = g["password"]
        if g.get("cookie"):
            patch["cookie"] = g["cookie"]
        elif g.get("clear_cookie"):
            patch["cookie"] = ""
        patch["notify_webhook"] = g.get("notify_webhook", "")
        if g.get("notify_users") is not None:
            patch["notify_users"] = g["notify_users"]
        st.patch_globals(patch)
    if data.warehouse is not None:
        _validate_wh(data.warehouse)
        st.patch_wh(key, data.warehouse.model_dump())
    return get_settings(user)


@router.post("/check")
def check(_: User = Depends(get_current_user)):
    return runner.check_login()


@router.post("/jst-warehouses")
def jst_warehouses(_: User = Depends(get_current_user)):
    return runner.fetch_jst_warehouses()


@router.post("/run")
def run_once(data: RunIn, user: User = Depends(get_current_user)):
    """立即执行一次（后台跑；用 /status 看进度，/history 看结果）。"""
    key = get_current_key()
    state = runner.status()
    if state.get("running"):
        raise HTTPException(409, f"已有一轮在执行中（{state.get('warehouse')} · {state.get('step')}），请等它结束")

    start = end = None
    if data.start and data.end:
        try:
            start, end = parse_datetime(data.start), parse_datetime(data.end)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if start >= end:
            raise HTTPException(400, "开始时间必须早于结束时间")
    elif data.window:
        try:
            resolve_window(data.window, datetime.now())
        except ValueError as e:
            raise HTTPException(400, str(e))

    wh = st.wh_of(st.load(), key)
    if not (wh.get("targets") or data.targets):
        raise HTTPException(400, "请先在「自动出库设置」里勾选要导入的聚水潭分仓")

    threading.Thread(
        target=runner.run_once,
        args=(key,),
        kwargs={
            "target_co_ids": data.targets,
            "window": data.window or None,
            "start": start,
            "end": end,
            "trigger": f"手动·{user.name}",
            "do_import": data.do_import,
        },
        name=f"jst-auto-manual-{key}",
        daemon=True,
    ).start()
    return {"ok": True, "started": True, "warehouse": key, "message": "已开始执行，可点「刷新状态」查看进度"}


@router.get("/status")
def run_status(_: User = Depends(get_current_user)):
    return runner.status()


@router.get("/history")
def history(limit: int = 20, _: User = Depends(get_current_user)):
    key = get_current_key()
    runs = st.wh_of(st.load(), key).get("runs") or []
    return {"runs": runs[: max(1, min(limit, 50))]}


# ---------------------------------------------------------------- 待办（人工介入）
def _public_task(t: dict) -> dict:
    """给前端看的待办内容（不返回 Cookie，只返回是否已填过验证码）。"""
    return {
        "id": t.get("id"),
        "type": t.get("type"),
        "reason": t.get("reason", ""),
        "message": t.get("message", ""),
        "created_at": t.get("created_at", ""),
        # 有 action 说明这条待办可以「填验证码 → 调聚水潭校验 → 放行导出」（不是只能换 Cookie）
        "sms_verifiable": bool((t.get("sms_auth") or {}).get("action")),
        "files": t.get("files") or [],
        "window": t.get("window", ""),
        "targets": t.get("targets") or [],
        "items": t.get("items") or [],
        "has_verify_code": bool(t.get("verify_code")),
        "status": t.get("status", "open"),
    }


def _wh_label(key: str) -> str:
    return next((w.get("name") or key for w in get_warehouses() if w.get("key") == key), key)


@router.get("/pending")
def pending_list(user: User = Depends(get_current_user)):
    """当前分仓的待办（商品资料待补全 / 需要验证码 / 导出失败）。

    站内通知就靠它：前端登录后拉一次，有待办且当前账号在提醒名单里就弹窗。
    """
    key = get_current_key()
    g = st.globals_view()
    tasks = st.pending_open(key)
    users = [x for x in (g.get("notify_users") or []) if x]
    notify = (user.name in users) if users else (user.role == "admin")
    return {
        "warehouse": key,
        "warehouse_name": _wh_label(key),
        "count": len(tasks),
        "tasks": [_public_task(t) for t in tasks],
        "notify": notify,
        "notify_users": users,
        "notify_webhook": g.get("notify_webhook") or "",
        "running": bool(runner.status().get("running")),
    }


def _run_resolve(key: str, task_id: str, **kw) -> None:
    """后台线程里跑重跑流程（失败只记日志，避免线程里异常被吞掉）。"""
    try:
        res = runner.resolve_pending(key, task_id, **kw)
        print(f"[自动出库] 待办 {task_id} 处理完成：{res.get('message')}")
    except Exception as e:  # noqa: BLE001
        print(f"[自动出库] 待办 {task_id} 处理失败：{type(e).__name__}: {e}")


@router.post("/pending/{task_id}/resolve")
def pending_resolve(task_id: str, data: ResolvePendingIn, user: User = Depends(get_current_user)):
    """完成一条待办：保存商品关联 / 记录验证码或 Cookie，然后自动重跑。"""
    key = get_current_key()
    if not any(t.get("id") == task_id for t in st.pending_open(key)):
        raise HTTPException(404, "待办不存在或已被处理")
    if not (data.mappings or data.verify_code or data.cookie):
        raise HTTPException(400, "没有可提交的内容：请至少选择商品关联，或填写验证码 / Cookie")
    state = runner.status()
    if state.get("running"):
        raise HTTPException(409, f"已有一轮在执行中（{state.get('warehouse')} · {state.get('step')}），等它结束后再提交")

    threading.Thread(
        target=_run_resolve,
        args=(key, task_id),
        kwargs={
            "mappings": [m.model_dump() for m in data.mappings],
            "verify_code": data.verify_code,
            "cookie": data.cookie,
            "user_name": user.name,
        },
        name=f"jst-pending-{task_id}",
        daemon=True,
    ).start()
    return {"ok": True, "started": True,
            "message": "已提交，正在自动重跑（可点「刷新状态」看进度）"}


@router.post("/pending/{task_id}/dismiss")
def pending_dismiss(task_id: str, user: User = Depends(get_current_user)):
    """忽略一条待办（不再提醒；不影响已导入的数据）。"""
    key = get_current_key()
    t = st.close_pending(key, task_id, status="dismissed", note=f"由 {user.name} 忽略")
    if not t:
        raise HTTPException(404, "待办不存在")
    return {"ok": True, "task": _public_task(t)}
