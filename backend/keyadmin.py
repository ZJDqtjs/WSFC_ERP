"""私钥管理工具启动脚本（独立端口，不随 ERP 一起启动）。

用法（在 backend 目录内执行）:
    cd backend
    uv run python keyadmin.py                     # 私钥管理后台 -> http://127.0.0.1:8001
    KEYADMIN_PORT=9001 uv run python keyadmin.py  # 自定义端口
    KEYADMIN_HOST=127.0.0.1 uv run python keyadmin.py  # 仅本机访问
"""
import json
import os
import socket

import uvicorn

from pathlib import Path

BACKEND = Path(__file__).resolve().parent
WSFC_ROOT = BACKEND.parent
with (WSFC_ROOT / "config.json").open(encoding="utf-8") as f:
    CONFIG = json.load(f)

KEYADMIN_HOST = os.getenv("KEYADMIN_HOST", "0.0.0.0")
KEYADMIN_PORT = int(os.getenv("KEYADMIN_PORT", CONFIG.get("server", {}).get("keyadmin_port", 8001)))


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
    print("=" * 46)
    print("  企业台账系统 - 私钥管理后台")
    print("-" * 46)
    print(f"  后台地址:  http://127.0.0.1:{KEYADMIN_PORT}")
    for ip in lan_ips():
        print(f"  局域网后台: http://{ip}:{KEYADMIN_PORT}")
    print("-" * 46)
    print("  首次进入需输入「管理员账号 + 密码」（config.local.json 的 accounts，或库中已有口令的管理员）")
    print("  关闭服务:  按 Ctrl+C")
    print("=" * 46)

    # uvicorn 自带对 Ctrl+C(SIGINT)/kill(SIGTERM) 的优雅退出处理；
    # run() 返回后统一 os._exit(0) 彻底结束进程，避免任何非守护线程残留而占用端口。
    server = uvicorn.Server(uvicorn.Config("keyadmin.main:app", host=KEYADMIN_HOST, port=KEYADMIN_PORT))
    server.run()
    os._exit(0)  # run 结束后确保彻底退出，并即时释放端口