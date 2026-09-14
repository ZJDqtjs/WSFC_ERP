"""通用附件上传：手动入库/出库的备注可挂图片或其他格式的文件。

- 文件落盘 backend/data/uploads（与 AI 票据同目录，由 main.py 以 /uploads 静态托管）
- 返回 {url, name, size, is_image}；前端把 url 追加进备注（换行分隔），随单据一起保存
- 记录列表按扩展名渲染：图片显示缩略图，其他显示下载链接
- 落盘文件名做字符净化（仅中英文/数字/下划线/短横线/点），保证前端能稳定识别备注里的附件路径
"""
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from ..auth import get_current_user
from ..models import User

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

ROOT = Path(__file__).resolve().parent.parent.parent
UPLOAD_DIR = ROOT / "data" / "uploads"

# 与 nginx client_max_body_size 20m 对齐，避免反向代理先 413
MAX_BYTES = 20 * 1024 * 1024

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}

# 白名单外字符一律替换为下划线：既防目录穿越，也让前端正则能匹配备注里的路径
_UNSAFE = re.compile(r"[^\w.\-\u4e00-\u9fff]+")


def _clean_filename(filename: str) -> tuple[str, str]:
    """把上传文件名净化成 (安全基名, 小写扩展名)。"""
    name = Path(filename or "").name  # 去掉可能的路径部分
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    stem = _UNSAFE.sub("_", stem)[:40].strip("._-") or "file"
    ext = _UNSAFE.sub("", ext)[:10]
    return stem, ext


def save_attachment(data: bytes, filename: str) -> tuple[str, str, bool]:
    """落盘并返回 (可访问 url, 展示名, 是否图片)。"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stem, ext = _clean_filename(filename)
    # attach_<时间戳>_<原基名><扩展名>：既避免同名覆盖，又保留可读名字供列表展示
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    fname = f"attach_{stamp}_{stem}{ext}"
    (UPLOAD_DIR / fname).write_bytes(data)
    return f"/uploads/{fname}", f"{stem}{ext}", ext in IMAGE_EXTS


@router.post("")
async def upload_attachment(file: UploadFile = File(...), user: User = Depends(get_current_user)):
    """上传一个备注附件（任意格式，≤20MB）。"""
    data = await file.read()
    if not data:
        raise HTTPException(400, "未读取到文件内容")
    if len(data) > MAX_BYTES:
        raise HTTPException(400, "文件超过 20MB 上限")
    url, name, is_image = save_attachment(data, file.filename or "")
    return {"url": url, "name": name, "size": len(data), "is_image": is_image}
