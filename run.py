"""局域网启动脚本：打印访问地址后启动服务。用法: uv run python run.py"""
import socket

import uvicorn


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
    print("  企业台账系统 - 库存与财务一体")
    print("-" * 46)
    print("  本机访问: http://127.0.0.1:8000")
    for ip in lan_ips():
        print(f"  局域网访问: http://{ip}:8000   (同一局域网内其他电脑用这个地址)")
    print("  关闭服务: 按 Ctrl+C")
    print("=" * 46)
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)
