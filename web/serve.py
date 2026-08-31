"""本地前端开发/预览服务器（前后端分离）。

- 托管 web/static 下的桌面 Web 前端（纯静态）
- 将 /api、/uploads 请求反向代理到后端 FastAPI（默认 http://127.0.0.1:8000）
- 网页默认端口 80（原 8000 改为 80），可用 WEB_PORT 覆盖；
  非管理员绑定 80 失败时自动改用 8001 并给出提示。

用法:
    python web/serve.py                              # 前端 -> http://localhost (80)
    WEB_PORT=8001 python web/serve.py                # 指定端口
    API_TARGET=http://127.0.0.1:9000 python web/serve.py  # 指定后端地址
"""
import http.client
import http.server
import os
import sys
import urllib.parse
import json
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent.parent / "static"
ROOT = WEB_ROOT.parent
with (ROOT / "config.json").open(encoding="utf-8") as f:
    CONFIG = json.load(f)
SERVER_CONFIG = CONFIG.get("server", {})
ROUTE_CONFIG = CONFIG.get("routes", {})

WEB_HOST = os.getenv("WEB_HOST", SERVER_CONFIG.get("web_host", "0.0.0.0"))
WEB_PORT = int(os.getenv("WEB_PORT", SERVER_CONFIG.get("web_port", 80)))
API_TARGET = os.getenv("API_TARGET", CONFIG.get("api_target", "http://127.0.0.1:8000")).rstrip("/")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}

# 需要反代到后端的路径前缀
PROXY_PREFIXES = tuple(ROUTE_CONFIG.get(name, default) for name, default in (("api", "/api"), ("uploads", "/uploads")))


def _split_target(target: str):
    p = urllib.parse.urlsplit(target)
    host = p.hostname or "127.0.0.1"
    port = p.port or (443 if p.scheme == "https" else 80)
    return host, port, p.scheme == "https"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ERPPreview/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- 代理 ----
    def proxy(self, method):
        path = self.path
        host, port, is_https = _split_target(API_TARGET)
        # 读取请求体（上传/JSON）
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        conn_cls = http.client.HTTPSConnection if is_https else http.client.HTTPConnection
        conn = conn_cls(host, port, timeout=120)
        try:
            headers = {}
            for k, v in self.headers.items():
                lk = k.lower()
                if lk in ("host", "connection", "content-length", "transfer-encoding", "accept-encoding"):
                    continue
                headers[k] = v
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            out_headers = {}
            for k, v in resp.getheaders():
                lk = k.lower()
                if lk in ("transfer-encoding", "connection", "content-length"):
                    continue
                # 保留 set-cookie（登录会话），去除压缩相关头
                if lk in ("content-encoding", "content-length"):
                    continue
                out_headers[k] = v
            # 后端不压缩输出，直接转发
            out_headers["Content-Encoding"] = "identity"
            for k, v in out_headers.items():
                self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception as e:
            try:
                self.send_error(502, f"后端代理失败: {e}")
            except Exception:
                pass
        finally:
            conn.close()

    # ---- 静态文件 ----
    def serve_static(self):
        p = urllib.parse.urlsplit(self.path).path
        if p.endswith("/") or p == "":
            p = "/index.html"
        rel = p.lstrip("/")
        # 防目录穿越
        target = (ROOT / "config.json").resolve() if rel == "config.json" else (WEB_ROOT / rel).resolve()
        if target != (ROOT / "config.json").resolve() and WEB_ROOT not in target.parents and target != WEB_ROOT:
            self.send_error(403)
            return
        if target.is_dir():
            target = target / "index.html"
        if target.is_file():
            ext = target.suffix.lower()
            ctype = MIME.get(ext, "application/octet-stream")
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
        else:
            # 未命中的路径回退到 index.html（单页入口）
            idx = WEB_ROOT / "index.html"
            if idx.is_file():
                data = idx.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_error(404)

    def _dispatch(self, method):
        if self.path.startswith(PROXY_PREFIXES):
            self.proxy(method)
        else:
            self.serve_static()

    do_GET = lambda self: self._dispatch("GET")
    do_POST = lambda self: self._dispatch("POST")
    do_PUT = lambda self: self._dispatch("PUT")
    do_DELETE = lambda self: self._dispatch("DELETE")
    do_PATCH = lambda self: self._dispatch("PATCH")
    do_OPTIONS = lambda self: self._dispatch("OPTIONS")


def main():
    if not WEB_ROOT.is_dir():
        print(f"错误：找不到前端目录 {WEB_ROOT}")
        sys.exit(1)
    port = WEB_PORT
    try:
        srv = http.server.ThreadingHTTPServer((WEB_HOST, port), Handler)
    except PermissionError:
        print(f"提示：{port} 端口需要管理员权限（Windows），已自动改用 8001。")
        port = 8001
        srv = http.server.ThreadingHTTPServer((WEB_HOST, port), Handler)
    except OSError as e:
        print(f"错误：端口 {port} 绑定失败：{e}")
        sys.exit(1)
    print("=" * 46)
    print("  企业台账系统 - 前端页面（前后端分离预览）")
    print("-" * 46)
    print(f"  前端页面:  http://localhost:{port}   (默认 80，可 WEB_PORT 覆盖)")
    print(f"  后端 API:  {API_TARGET}   (可 API_TARGET 覆盖)")
    print("  先启动后端: python run.py")
    print("  关闭服务:   按 Ctrl+C")
    print("=" * 46)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
