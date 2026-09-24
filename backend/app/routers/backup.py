"""备份与恢复：SQLite 在线备份 / 恢复、自动备份配置（按分仓隔离）。

备份文件保存在 data/backups，命名 {prefix}_backup_YYYYMMDD_HHMMSS.db（奥斯迪仓 prefix=erp，兼容历史）。
「当前分仓」= 本次登录会话所在分仓（分仓随会话，不再是进程全局）：列表/自动清理/恢复均只针对它，
恢复时校验文件名属于该仓，防止跨仓恢复。自动备份由 main.py 的后台任务逐个分仓执行。

除数据库外，backend/json 目录也纳入备份：该目录里有若干**不在 .db 内**的业务配置
（jst_auto.json 聚水潭账号、deduction_config.json 店铺扣点、fresh_config_*.json 鲜货清单、
labor.json / packaging.json 等），且不被 git 跟踪，只有服务器本地一份，因此整体打成
json_backup_YYYYMMDD_HHMMSS.tar.gz 并走同一条远程推送通道。打包前算内容指纹，目录无变化
则跳过，避免每轮都往接收端塞一个文件、挤占其 keep 配额。
"""
import hashlib
import json
import os
import re
import time
import sqlite3
import secrets
import tarfile
import threading
import http.client
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from ..auth import get_current_user
from ..database import DATA_DIR, get_current_key, warehouse_db_path
from ..models import User

router = APIRouter(prefix="/api", tags=["backup"])

BACKUP_DIR = DATA_DIR / "backups"
BACKUP_DIR.mkdir(exist_ok=True)
CONFIG_FILE = DATA_DIR / "backup_config.json"
STATUS_FILE = DATA_DIR / "backup_remote_status.json"
JSON_HASH_FILE = DATA_DIR / "json_backup_hash.txt"

# 商品资料与业务配置所在的 json 目录（backend/json，奥斯迪仓直接在根、其他仓在 {key}/ 子目录）
JSON_DIR = DATA_DIR.parent / "json"
JSON_BACKUP_PREFIX = "json_backup_"
JSON_AUTO_RE = re.compile(r"^json_backup_\d{8}_\d{6}\.tar\.gz$")
# 打包时忽略的临时/缓存文件
JSON_SKIP_NAMES = {".DS_Store"}
JSON_SKIP_SUFFIXES = (".tmp", ".part", "~")
JSON_SKIP_DIRS = {"__pycache__"}

DEFAULT_CONFIG = {
    "enabled": True,
    "interval_hours": 2,
    "keep": 30,
    "remote_enabled": False,
    "remote_url": "",
    "remote_token": "",
    "remote_keep": 100,
    "json_backup_enabled": True,
}

# 系统自动生成备份的命名格式：{prefix}_backup_YYYYMMDD_HHMMSS.db（只匹配此格式参与自动清理）
AUTO_BACKUP_RE = re.compile(r"^([A-Za-z0-9_-]+)_backup_\d{8}_\d{6}\.db$")


def _backup_prefix(key: str) -> str:
    """奥斯迪仓沿用历史 erp_backup_* 前缀，其他仓用仓 key。"""
    return "erp" if key == "aosidi" else key


def _belongs(name: str, key: str) -> bool:
    """备份文件是否属于指定分仓（前缀匹配）。"""
    prefix = _backup_prefix(key)
    return (name or "").startswith(prefix + "_")


def is_auto_backup(name: str) -> bool:
    return bool(AUTO_BACKUP_RE.match(name or ""))


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


def create_backup_file(key: str | None = None) -> str:
    """使用 SQLite 在线备份接口（兼容 WAL），备份指定分仓（缺省本登录会话的分仓），返回备份文件名。"""
    key = key or get_current_key()
    BACKUP_DIR.mkdir(exist_ok=True)
    name = f"{_backup_prefix(key)}_backup_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".db"
    target = BACKUP_DIR / name
    src = sqlite3.connect(str(warehouse_db_path(key)))
    dst = sqlite3.connect(str(target))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    _prune(key)
    _maybe_push_remote(target)  # 配置了远程备份则异步推送一份
    return name


def _prune(key: str | None = None) -> None:
    """仅清理指定分仓（缺省当前分仓）的自动生成备份，手动放入的文件不清理。"""
    key = key or get_current_key()
    cfg = load_config()
    keep = max(1, int(cfg.get("keep", 30)))
    files = sorted(
        (f for f in BACKUP_DIR.glob("*.db")
         if _belongs(f.name, key) and is_auto_backup(f.name)),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    for f in files[keep:]:
        try:
            f.unlink()
        except OSError:
            pass


# ============ 远程（云）备份：自动备份时向远程接收端推送一份 ============


def _parse_remote_url(raw: str):
    """把用户输入的 ip:port/path（或完整 URL）拆成 (scheme, host, port, path)。"""
    raw = (raw or "").strip()
    if not raw:
        return None
    if "://" not in raw:
        raw = "http://" + raw
    u = urlparse(raw)
    host = u.hostname
    if not host:
        return None
    scheme = u.scheme or "http"
    port = u.port or (443 if scheme == "https" else 80)
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    return scheme, host, port, path


def load_remote_status() -> dict:
    try:
        if STATUS_FILE.exists():
            return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_remote_status(**kw) -> None:
    try:
        STATUS_FILE.write_text(
            json.dumps({"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), **kw}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass


def push_file_remote(path: Path, cfg: dict) -> tuple[bool, str]:
    """把单个备份文件流式 POST 到远程接收端。返回 (是否成功, 说明)。"""
    parsed = _parse_remote_url(cfg.get("remote_url", ""))
    if not parsed:
        return False, "未配置远程地址"
    scheme, host, port, url_path = parsed
    token = cfg.get("remote_token", "") or ""
    size = path.stat().st_size
    conn = http.client.HTTPSConnection(host, port, timeout=300) if scheme == "https" \
        else http.client.HTTPConnection(host, port, timeout=300)
    try:
        conn.putrequest("POST", url_path)
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(size))
        conn.putheader("X-Backup-Token", token)
        conn.putheader("X-Backup-Filename", path.name)
        conn.endheaders()
        with path.open("rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                conn.send(chunk)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", "replace")
        if resp.status != 200:
            return False, f"HTTP {resp.status}: {body[:200]}"
        return True, body[:200] or "ok"
    except Exception as e:  # noqa: BLE001 - 网络异常不该影响本地备份
        return False, f"{type(e).__name__}: {e}"
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _do_push_all(paths: list[Path]) -> None:
    cfg = load_config()
    if not cfg.get("remote_enabled"):
        return
    last_ok = False
    last_msg = ""
    for p in paths:
        if not p.exists():
            continue
        ok, msg = push_file_remote(p, cfg)
        last_ok, last_msg = ok, msg
        print(f"[远程备份] {p.name} -> {'成功' if ok else '失败'}：{msg}")
    if paths:
        _save_remote_status(ok=last_ok, message=last_msg, file=paths[-1].name)


def _maybe_push_remote(path: Path) -> None:
    """在自动备份生成文件后异步推送（守护线程，不阻塞备份/请求）。"""
    cfg = load_config()
    if not cfg.get("remote_enabled") or not cfg.get("remote_url"):
        return
    threading.Thread(target=_do_push_all, args=([path],), daemon=True).start()


# ============ backend/json 目录整体备份（含不在 .db 里的业务配置） ============

def _iter_json_files():
    """列出 JSON_DIR 下需要纳入备份的文件（跳过临时/缓存），返回 (绝对路径, 相对路径)。"""
    if not JSON_DIR.is_dir():
        return
    for p in sorted(JSON_DIR.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(JSON_DIR).as_posix()
        if any(part in JSON_SKIP_DIRS for part in p.relative_to(JSON_DIR).parts[:-1]):
            continue
        if p.name in JSON_SKIP_NAMES or p.name.endswith(JSON_SKIP_SUFFIXES):
            continue
        yield p, rel


def _json_fingerprint() -> str:
    """目录内容指纹：相对路径 + 大小 + mtime 逐文件求和，目录无变化则指纹不变。"""
    h = hashlib.sha256()
    any_file = False
    for p, rel in _iter_json_files():
        any_file = True
        try:
            st = p.stat()
        except OSError:
            continue
        h.update(f"{rel}\0{st.st_size}\0{int(st.st_mtime)}\n".encode("utf-8"))
    return h.hexdigest() if any_file else ""


def _prune_json() -> None:
    """本地 json 备份单独清理，保留份数沿用 keep 配置。"""
    cfg = load_config()
    keep = max(1, int(cfg.get("keep", 30)))
    files = sorted(
        (f for f in BACKUP_DIR.glob(JSON_BACKUP_PREFIX + "*.tar.gz") if JSON_AUTO_RE.match(f.name)),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    for f in files[keep:]:
        try:
            f.unlink()
        except OSError:
            pass


def create_json_backup_file(force: bool = False) -> str | None:
    """把整个 backend/json 目录打成 data/backups/json_backup_时间戳.tar.gz。

    目录内容相比上次备份没有变化时跳过（force=True 可强制）。返回生成的文件名，跳过时返回 None。
    生成后按 remote_enabled 走与 .db 相同的远程推送通道（守护线程，不阻塞）。
    """
    digest = _json_fingerprint()
    if not digest:
        print("[json备份] 未找到 backend/json 目录或目录为空，跳过")
        return None
    last = ""
    try:
        if JSON_HASH_FILE.exists():
            last = JSON_HASH_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        last = ""
    if digest == last and not force:
        return None  # 无变化，不产文件也不推送
    BACKUP_DIR.mkdir(exist_ok=True)
    name = JSON_BACKUP_PREFIX + datetime.now().strftime("%Y%m%d_%H%M%S") + ".tar.gz"
    target = BACKUP_DIR / name
    tmp = target.with_suffix(".gz.part")
    try:
        with tarfile.open(tmp, "w:gz") as tf:
            for p, rel in _iter_json_files():
                try:
                    tf.add(p, arcname=rel, recursive=False)
                except OSError:
                    pass
        os.replace(tmp, target)
    except Exception as e:  # noqa: BLE001 - 打包失败不影响数据库备份主流程
        try:
            tmp.unlink()
        except OSError:
            pass
        print(f"[json备份] 打包失败：{e}")
        return None
    try:
        JSON_HASH_FILE.write_text(digest, encoding="utf-8")
    except OSError:
        pass
    _prune_json()
    _maybe_push_remote(target)  # 复用同一条远程推送通道
    return name


def _list_json_backups() -> list[dict]:
    rows = []
    for f in sorted(
        (f for f in BACKUP_DIR.glob(JSON_BACKUP_PREFIX + "*.tar.gz") if JSON_AUTO_RE.match(f.name)),
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


def _human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _list_backups(key: str | None = None) -> list[dict]:
    key = key or get_current_key()
    rows = []
    for f in sorted(
        BACKUP_DIR.glob("*.db"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    ):
        if not _belongs(f.name, key):
            continue  # 只展示指定分仓的备份（隔离语义）
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
    remote_enabled: bool = False
    remote_url: str = ""
    remote_keep: int = 100
    json_backup_enabled: bool = True


@router.get("/backups")
def list_backups(user: User = Depends(get_current_user)):
    return {
        "config": load_config(),
        "backups": _list_backups(),
        "json_backups": _list_json_backups(),
        "remote_status": load_remote_status(),
    }


@router.post("/backup")
def create_backup(user: User = Depends(get_current_user)):
    name = create_backup_file()
    jb = create_json_backup_file() if load_config().get("json_backup_enabled", True) else None
    return {"ok": True, "name": name, "json_backup": jb, "backups": _list_backups()}


@router.post("/backup/restore")
def restore_backup(data: RestoreIn, user: User = Depends(get_current_user)):
    key = get_current_key()
    if not _belongs(data.name, key):
        raise HTTPException(400, "备份文件不属于当前分仓，无法恢复")
    src_path = _safe_path(data.name)
    if not src_path.exists():
        raise HTTPException(404, "备份文件不存在")
    src = sqlite3.connect(str(src_path))
    dst = sqlite3.connect(str(warehouse_db_path(key)))
    try:
        # 在线备份接口把备份内容覆盖写入当前分仓数据库（含 WAL 一致性处理）
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
    old = load_config()
    remote_url = (data.remote_url or "").strip()
    token = old.get("remote_token") or ""
    # 开启远程备份但尚无密钥时，自动生成一个作为收发双方的共享密钥
    if data.remote_enabled and remote_url and not token:
        token = secrets.token_urlsafe(24)
    cfg = save_config(
        {
            "enabled": bool(data.enabled),
            "interval_hours": max(0.5, float(data.interval_hours)),
            "keep": max(1, int(data.keep)),
            "remote_enabled": bool(data.remote_enabled),
            "remote_url": remote_url,
            "remote_token": token,
            "remote_keep": max(1, int(data.remote_keep or 100)),
            "json_backup_enabled": bool(data.json_backup_enabled),
        }
    )
    return {"ok": True, "config": cfg}


# ============ 远程服务器一键部署/停止脚本（下载给备份服务器执行） ============

# 远程接收端程序：纯标准库，随部署脚本一起下发到备份服务器
_RECEIVER_PY = r'''
import os
import sys
import json
import time
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    server_version = "ERPBackupReceiver/1.0"
    token = ""
    save_dir = ""
    keep = 100
    prefix = "/cloudback"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _drain(self):
        try:
            n = int(self.headers.get("Content-Length", "0") or 0)
            while n > 0:
                c = self.rfile.read(min(1024 * 1024, n))
                if not c:
                    break
                n -= len(c)
        except Exception:
            pass

    def _path(self):
        p = self.path.split("?", 1)[0]
        return (p.rstrip("/") or "/")

    def _is_upload(self):
        pre = self.prefix.rstrip("/")
        p = self._path()
        return pre == "" or p in (pre, pre + "/upload")

    def do_GET(self):
        pre = self.prefix.rstrip("/")
        p = self._path()
        if p in ("/", "/health", "/ping") or p == pre + "/health":
            self._send(200, {"ok": True, "service": "erp-backup-receiver", "keep": self.keep})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._is_upload():
            self._drain()
            self._send(404, {"ok": False, "error": "not found"})
            return
        if self.headers.get("X-Backup-Token", "") != self.token:
            self._drain()
            self._send(403, {"ok": False, "error": "token invalid"})
            return
        raw = self.headers.get("X-Backup-Filename", "") or ""
        name = os.path.basename(raw)
        if not name or name != raw:
            self._drain()
            self._send(400, {"ok": False, "error": "bad filename"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        dest = os.path.join(self.save_dir, name)
        tmp = dest + ".part"
        try:
            got = 0
            left = size
            with open(tmp, "wb") as fh:
                while left > 0:
                    chunk = self.rfile.read(min(1024 * 1024, left))
                    if not chunk:
                        break
                    fh.write(chunk)
                    got += len(chunk)
                    left -= len(chunk)
            if size and got != size:
                raise IOError("incomplete %d/%d" % (got, size))
            os.replace(tmp, dest)
            self._send(200, {"ok": True, "saved": name, "size": got})
            self._prune()
        except Exception as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            self._send(500, {"ok": False, "error": str(e)})

    def _prune(self):
        if self.keep <= 0:
            return
        files = []
        for f in os.listdir(self.save_dir):
            fp = os.path.join(self.save_dir, f)
            if os.path.isfile(fp) and not f.endswith(".part"):
                files.append(fp)
        files.sort(key=lambda p: os.path.getmtime(p))
        while len(files) > self.keep:
            old = files.pop(0)
            try:
                os.remove(old)
                sys.stderr.write("[%s] pruned %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), old))
            except OSError:
                pass

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), fmt % args))


def main():
    ap = argparse.ArgumentParser(description="ERP backup receiver")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--prefix", default="/cloudback")
    ap.add_argument("--dir", default="./erp-backups")
    ap.add_argument("--token", default="")
    ap.add_argument("--keep", type=int, default=100)
    a = ap.parse_args()
    os.makedirs(a.dir, exist_ok=True)
    Handler.token = a.token
    Handler.save_dir = a.dir
    Handler.keep = a.keep
    Handler.prefix = a.prefix or ""
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print("ERP backup receiver listening on http://%s:%d%s (dir=%s, keep=%d)"
          % (a.host, a.port, a.prefix, os.path.abspath(a.dir), a.keep))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
'''

_REMOTE_APP_DIR = "/opt/erp-backup-receiver"


def _remote_params(cfg: dict):
    parsed = _parse_remote_url(cfg.get("remote_url", "")) or ("http", "0.0.0.0", 8080, "/cloudback")
    _, _host, port, path = parsed
    token = cfg.get("remote_token") or secrets.token_urlsafe(24)
    keep = int(cfg.get("remote_keep") or 100)
    return port, (path if path.startswith("/") else "/" + path), token, keep


def _deploy_script(cfg: dict) -> str:
    port, prefix, token, keep = _remote_params(cfg)
    lines = [
        "#!/usr/bin/env bash",
        "# ERP 远程备份接收端 - 一键部署脚本（由 ERP 系统自动生成，请勿手动修改）",
        "# 用法：上传到备份服务器后执行：  bash deploy_erp_backup_receiver.sh",
        "set -e",
        "",
        'PORT="%d"' % port,
        'PREFIX="%s"' % prefix,
        'TOKEN="%s"' % token,
        'KEEP="%d"' % keep,
        'APP_DIR="%s"' % _REMOTE_APP_DIR,
        'DATA_DIR="$APP_DIR/data"',
        "",
        "if ! command -v python3 >/dev/null 2>&1; then",
        '  echo "未找到 python3，请先安装：apt install -y python3 或 yum install -y python3" >&2',
        "  exit 1",
        "fi",
        "",
        'mkdir -p "$DATA_DIR"',
        "",
        "# 写入接收端程序",
        "cat > \"$APP_DIR/receiver.py\" <<'PYEOF'",
        _RECEIVER_PY.strip("\n"),
        "PYEOF",
        "",
        "# 若已在运行则先停止旧进程",
        'if [ -f "$APP_DIR/receiver.pid" ]; then',
        '  kill "$(cat "$APP_DIR/receiver.pid")" 2>/dev/null || true',
        "  sleep 1",
        "fi",
        "",
        "nohup python3 \"$APP_DIR/receiver.py\" --host 0.0.0.0 --port \"$PORT\" --prefix \"$PREFIX\""
        " --dir \"$DATA_DIR\" --token \"$TOKEN\" --keep \"$KEEP\" > \"$APP_DIR/receiver.log\" 2>&1 &",
        'echo $! > "$APP_DIR/receiver.pid"',
        "sleep 1",
        "",
        'echo "接收端已启动，PID=$(cat "$APP_DIR/receiver.pid")"',
        'echo "接收地址： http://<本机IP>:$PORT$PREFIX      （与本页填写的地址保持一致）"',
        'echo "健康检查： curl http://127.0.0.1:$PORT$PREFIX/health"',
        'echo "查看日志： tail -f $APP_DIR/receiver.log"',
        "",
    ]
    return "\n".join(lines)


def _stop_script(cfg: dict) -> str:
    lines = [
        "#!/usr/bin/env bash",
        "# ERP 远程备份接收端 - 一键停止脚本（由 ERP 系统自动生成）",
        "# 用法：上传到备份服务器后执行：  bash stop_erp_backup_receiver.sh",
        'APP_DIR="%s"' % _REMOTE_APP_DIR,
        'if [ -f "$APP_DIR/receiver.pid" ]; then',
        '  PID="$(cat "$APP_DIR/receiver.pid")"',
        '  if kill "$PID" 2>/dev/null; then echo "已停止接收端 (PID=$PID)"; else echo "接收端未在运行"; fi',
        '  rm -f "$APP_DIR/receiver.pid"',
        "else",
        '  pkill -f "$APP_DIR/receiver.py" && echo "已停止接收端" || echo "未找到运行中的接收端"',
        "fi",
        "",
    ]
    return "\n".join(lines)


@router.get("/backup/remote/deploy-script")
def remote_deploy_script(user: User = Depends(get_current_user)):
    cfg = load_config()
    if not cfg.get("remote_token"):
        cfg["remote_token"] = secrets.token_urlsafe(24)
        save_config(cfg)
    return PlainTextResponse(
        _deploy_script(cfg),
        headers={"Content-Disposition": 'attachment; filename="deploy_erp_backup_receiver.sh"'},
    )


@router.get("/backup/remote/stop-script")
def remote_stop_script(user: User = Depends(get_current_user)):
    return PlainTextResponse(
        _stop_script(load_config()),
        headers={"Content-Disposition": 'attachment; filename="stop_erp_backup_receiver.sh"'},
    )
