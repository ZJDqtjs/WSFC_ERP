"""本地一键开发：同时启动 后端 API + 前端预览（前后端分离）。

用法:
    python dev.py                 # 后端 :8000  +  前端 :80（绑定 80 失败自动改 8001）
    API_PORT=8000 WEB_PORT=80 python dev.py   # 自定义端口
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API_PORT = os.getenv("API_PORT", "8000")
WEB_PORT = os.getenv("WEB_PORT", "80")


def _run(cmd, cwd, tag):
    return subprocess.Popen(
        cmd, cwd=str(cwd), shell=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )


def _pump(proc, tag):
    for line in proc.stdout:
        sys.stdout.write(f"[{tag}] {line}")
        sys.stdout.flush()


def main():
    print("=" * 46)
    print("  企业台账系统 - 本地开发（前后端分离）")
    print("-" * 46)
    print(f"  后端 API: http://127.0.0.1:{API_PORT}")
    print(f"  前端页面: http://localhost:{WEB_PORT}")
    print("=" * 46)

    backend = _run(f"uv run python run.py", ROOT, "API")
    frontend = _run(f"uv run python web\\serve.py", ROOT, "WEB")

    import threading
    t1 = threading.Thread(target=_pump, args=(backend, "API"), daemon=True)
    t2 = threading.Thread(target=_pump, args=(frontend, "WEB"), daemon=True)
    t1.start()
    t2.start()

    try:
        backend.wait()
        frontend.wait()
    except KeyboardInterrupt:
        print("\n正在关闭…")
        for p in (backend, frontend):
            if p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass
    sys.exit(0)


if __name__ == "__main__":
    main()
