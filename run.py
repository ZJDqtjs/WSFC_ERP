"""后端 API 启动脚本（前后端分离）：只启动 FastAPI，不托管前端。

前端由 web/serve.py（本地开发，默认 80 端口）或 nginx（Linux 生产）托管。
用法（在项目根目录执行）:
    uv run python run.py            # 后端 API -> http://127.0.0.1:8000
    API_PORT=9000 uv run python run.py   # 自定义端口
    SERVE_STATIC=1 uv run python run.py  # 单进程一体化预览（后端顺带托管 static/）
"""
import os
import socket

import uvicorn

API_PORT = int(os.getenv("API_PORT", "8000"))


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
    print("  企业台账系统 - 后端 API（前后端分离）")
    print("-" * 46)
    print(f"  后端 API:   http://127.0.0.1:{API_PORT}")
    for ip in lan_ips():
        print(f"  局域网 API: http://{ip}:{API_PORT}")
    print("-" * 46)
    print("  前端页面:   运行  python web/serve.py   (默认 http://localhost:80)")
    print("  或一键开发: 运行  python dev.py")
    print("  关闭服务:   按 Ctrl+C")
    print("=" * 46)
    uvicorn.run("app.main:app", host="0.0.0.0", port=API_PORT)
