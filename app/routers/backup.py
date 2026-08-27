"""备份与恢复：SQLite 在线备份 / 恢复、自动备份配置。

备份文件保存在 data/backups（erp_backup_YYYYMMDD_HHMMSS.db）。
自动备份配置保存在 data/backup_config.json，默认开启、每 2 小时一次、保留最近 30 份。
"""
import json
import sqlite3
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ..database import DATA_DIR, DB_PATH
from ..models import User

router = APIRouter(prefix="/api", tags=["backup"])

BACKUP_DIR = DATA_DIR / "backups"
BACKUP_DIR.mkdir(exist_ok=True)
CONFIG_FILE = DATA_DIR / "backup_config.json"
DEFAULT_CONFIG = {"enabled": True, "interval_hours": 2, "keep": 30}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        if CONFIG_FILE.exists():
            cfg.update(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> dict:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def create_backup_file() -> str:
    """使用 SQLite 在线备份接口（兼容 WAL），返回备份文件名。"""
    BACKUP_DIR.mkdir(exist_ok=True)
    name = "erp_backup_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".db"
    target = BACKUP_DIR / name
    src = sqlite3.connect(str(DB_PATH))
    dst = sqlite3.connect(str(target))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    _prune()
    return name


def _prune() -> None:
    cfg = load_config()
    keep = max(1, int(cfg.get("keep", 30)))
    files = sorted(
        BACKUP_DIR.glob("erp_backup_*.db"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    for f in files[keep:]:
        try:
            f.unlink()
        except OSError:
            pass


def _human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _list_backups() -> list[dict]:
    rows = []
    for f in sorted(
        BACKUP_DIR.glob("erp_backup_*.db"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    ):
        st = f.stat()
        rows.append(
            {
                "name": f.name,
                "size": st.st_size,
                "size_human": _human_size(st.st_size),
                "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            }
        )
    return rows


def _safe_path(name: str) -> Path:
    """校验备份文件名，防止路径穿越。"""
    p = (BACKUP_DIR / name).resolve()
    if not p.is_relative_to(BACKUP_DIR.resolve()):
        raise HTTPException(400, "非法文件名")
    return p


class RestoreIn(BaseModel):
    name: str


class ConfigIn(BaseModel):
    enabled: bool = True
    interval_hours: float = 2
    keep: int = 30


@router.get("/backups")
def list_backups(user: User = Depends(get_current_user)):
    return {"config": load_config(), "backups": _list_backups()}


@router.post("/backup")
def create_backup(user: User = Depends(get_current_user)):
    name = create_backup_file()
    return {"ok": True, "name": name, "backups": _list_backups()}


@router.post("/backup/restore")
def restore_backup(data: RestoreIn, user: User = Depends(get_current_user)):
    src_path = _safe_path(data.name)
    if not src_path.exists():
        raise HTTPException(404, "备份文件不存在")
    src = sqlite3.connect(str(src_path))
    dst = sqlite3.connect(str(DB_PATH))
    try:
        # 在线备份接口把备份内容覆盖写入当前数据库（含 WAL 一致性处理）
        src.backup(dst)
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"恢复失败：{e}")
    finally:
        dst.close()
        src.close()
    return {"ok": True}


@router.delete("/backup/{name}")
def delete_backup(name: str, user: User = Depends(get_current_user)):
    src_path = _safe_path(name)
    if not src_path.exists():
        raise HTTPException(404, "备份文件不存在")
    src_path.unlink()
    return {"ok": True, "backups": _list_backups()}


@router.post("/backup/config")
def update_config(data: ConfigIn, user: User = Depends(get_current_user)):
    cfg = save_config(
        {
            "enabled": bool(data.enabled),
            "interval_hours": max(0.5, float(data.interval_hours)),
            "keep": max(1, int(data.keep)),
        }
    )
    return {"ok": True, "config": cfg}
