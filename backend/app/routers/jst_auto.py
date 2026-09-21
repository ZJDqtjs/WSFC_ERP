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
    return {
        "globals": st.public_globals(d),
        "warehouse": {**wh, "key": key, "name": name},
        "warehouse_key": key,
        "warehouse_name": name,
        "all_warehouses": [{"key": w.get("key"), "name": w.get("name") or w.get("key")} for w in get_warehouses()],
        "windows": [{"value": v, "label": lb} for v, lb in WINDOW_CHOICES],
        "window_help": WINDOW_HELP,
        "next_runs": st.next_runs(wh.get("schedule") or []),
        "status": runner.status(),
        "last_run": wh.get("last_run") or {},
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
