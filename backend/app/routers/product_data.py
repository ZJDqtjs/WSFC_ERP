"""商品资料解耦 API：页面导出 JSON、设置页一键导出到 json 目录 / 一键导入、状态查看。

所有操作基于 app.product_master，商品相互引用用名称表达，导入时按名称解析成 id，
因此可跨库/跨设备迁移。
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ..database import get_db
from ..models import User
from ..product_master import KINDS, export_all, export_payload, import_all, import_from_file, import_payload, status

router = APIRouter(prefix="/api/product-data", tags=["product-data"])


class UploadIn(BaseModel):
    payload: dict


@router.get("/kinds")
def kinds(user: User = Depends(get_current_user)):
    return {"kinds": [{"kind": k, "file": f, "label": l} for k, (f, l, _kl) in KINDS.items()]}


@router.get("/status")
def get_status(db=Depends(get_db), user: User = Depends(get_current_user)):
    """json 目录与数据库的对照状态。"""
    return status(db)


@router.get("/{kind}")
def get_payload(kind: str, db=Depends(get_db), user: User = Depends(get_current_user)):
    """返回某一类商品资料的导出内容（不落盘，供页面导出/下载 JSON）。"""
    if kind not in KINDS:
        return {"error": f"未知类型 {kind}", "kinds": list(KINDS)}
    return export_payload(db, kind)


@router.post("/export")
def do_export(db=Depends(get_db), user: User = Depends(get_current_user)):
    """一键导出全部 5 类到 json 目录。"""
    return export_all(db)


@router.post("/import")
def do_import(db=Depends(get_db), user: User = Depends(get_current_user)):
    """从 json 目录一键导入全部 5 类（按依赖顺序，名称 upsert）。"""
    return import_all(db)


@router.post("/import-one")
def import_upload(data: UploadIn, db=Depends(get_db), user: User = Depends(get_current_user)):
    """接收前端上传的单个 json 载荷并导入（按名称 upsert）。"""
    try:
        return import_payload(db, data.payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/import/{kind}")
def import_one(kind: str, db=Depends(get_db), user: User = Depends(get_current_user)):
    """从 json 目录导入某一类。"""
    if kind not in KINDS:
        return {"error": f"未知类型 {kind}", "kinds": list(KINDS)}
    try:
        return import_from_file(db, kind)
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))