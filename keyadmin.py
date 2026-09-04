"""私钥管理工具启动脚本（独立端口，不随 ERP 一起启动）。

用法（在项目根目录执行）:
    uv run python keyadmin.py                # 私钥管理后台 -> http://127.0.0.1:8001
    KEYADMIN_PORT=9001 uv run python keyadmin.py   # 自定义端口
    KEYADMIN_HOST=127.0.0.1 uv run python keyadmin.py  # 仅本机访问
"""
import json
import os
import socket
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parent
with (ROOT / "config.json").open(encoding="utf-8") as f:
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
    if not ips:
        try:
            ips = [ip for ip in socket.gethostbyname_ex(socket.gethostname())[2] if not ip.startswith("127.")]
        except Exception:
            pass
    return ips


if __name__ == "__main__":
    print("=" * 46)
    print("  私钥管理工具（登录密钥生成 / 账号管理）")
    print("-" * 46)
    print(f"  本机地址:  http://127.0.0.1:{KEYADMIN_PORT}")
    for ip in lan_ips():
        print(f"  局域网:    http://{ip}:{KEYADMIN_PORT}")
    print("-" * 46)
    print("  首次进入需输入管理员密码（product_rules.json accounts 中的管理员，默认 admin1/admin1）")
    print("  关闭服务: 按 Ctrl+C")
    print("=" * 46)
    uvicorn.run("keyadmin.main:app", host=KEYADMIN_HOST, port=KEYADMIN_PORT)
