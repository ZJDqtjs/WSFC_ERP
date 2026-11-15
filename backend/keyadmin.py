"""私钥管理工具启动脚本（独立端口，不随 ERP 一起启动）。

默认监听 0.0.0.0（按原使用习惯可用公网地址直接打开，本工具也不是常开）。
登录口已有防护：强口令 + 「账号/IP」与「IP」双维度分级锁定（见 app/login_guard.py），
访问与操作都会落到 backend/data/logs/keyadmin.log / keyadmin_audit.log。

若确实想只在本机访问（再自己开 SSH 隧道）：KEYADMIN_HOST=127.0.0.1 uv run python keyadmin.py

用法（在 backend 目录内执行）:
    cd backend
    uv run python keyadmin.py                     # 私钥管理后台 -> http://127.0.0.1:8001
    KEYADMIN_PORT=9001 uv run python keyadmin.py  # 自定义端口
"""
import json
import logging
import os
import socket
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

BACKEND = Path(__file__).resolve().parent
WSFC_ROOT = BACKEND.parent
with (WSFC_ROOT / "config.json").open(encoding="utf-8") as f:
    CONFIG = json.load(f)

KEYADMIN_HOST = os.getenv("KEYADMIN_HOST", "0.0.0.0")
KEYADMIN_PORT = int(os.getenv("KEYADMIN_PORT", CONFIG.get("server", {}).get("keyadmin_port", 8001)))
LOG_FILE = BACKEND / "data" / "logs" / "keyadmin.log"


def setup_logging() -> None:
    """把 uvicorn 的启动/访问/错误日志同时写到 data/logs/keyadmin.log。

    之前只打到终端：SSH 一断或换个窗口，登录爆破与清库操作就查不到了。
    """
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    file_handler = RotatingFileHandler(
        LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)


def lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return ips


if __name__ == "__main__":
    setup_logging()
    print("=" * 46)
    print("  企业台账系统 - 私钥管理后台")
    print("-" * 46)
    print(f"  后台地址:  http://127.0.0.1:{KEYADMIN_PORT}")
    if KEYADMIN_HOST in ("127.0.0.1", "localhost", "::1"):
        print(f"  远程访问:  ssh -L {KEYADMIN_PORT}:127.0.0.1:{KEYADMIN_PORT} <user>@<server>")
    else:
        for ip in lan_ips():
            print(f"  局域网后台: http://{ip}:{KEYADMIN_PORT}")
    print(f"  日志文件:  {LOG_FILE}")
    print("-" * 46)
    print("  首次进入需输入「管理员账号 + 密码」（config.local.json 的 accounts，或库中已有口令的管理员）")
    print("  关闭服务:  按 Ctrl+C")
    print("=" * 46)

    # uvicorn 自带对 Ctrl+C(SIGINT)/kill(SIGTERM) 的优雅退出处理；
    # log_config=None 让上面配置的 root handler 接管 uvicorn 的启动/访问日志（同时落盘）。
    # run() 返回后统一 os._exit(0) 彻底结束进程，避免任何非守护线程残留而占用端口。
    server = uvicorn.Server(
        uvicorn.Config(
            "keyadmin.main:app",
            host=KEYADMIN_HOST,
            port=KEYADMIN_PORT,
            log_config=None,
        )
    )
    server.run()
    os._exit(0)  # run 结束后确保彻底退出，并即时释放端口
