#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WSFC_ERP 云备份 - 接收端

运行在备份服务器上，监听指定端口，接收发送端(backup_push.py)推送的 tar.gz 备份，
按时间保留最近 N 份，自动清理更早的备份。

依赖：仅 Python 标准库，无需 pip 安装任何第三方包。

用法
----
    # 前台运行
    python scripts/backup_receiver.py --port 8765 --token 你的密钥 --dir /data/erp-backups --keep 30

    # 后台运行（Linux，systemd 建议）
    nohup python scripts/backup_receiver.py --port 8765 --token 你的密钥 --dir /data/erp-backups --keep 30 > /var/log/erp-backup-receiver.log 2>&1 &

环境变量（命令行参数优先）
--------------------------
    BACKUP_PORT   监听端口
    BACKUP_TOKEN  共享密钥（与发送端 --token 一致）
    BACKUP_DIR    备份保存目录
    BACKUP_KEEP   保留份数

安全提示
--------
    token 仅用于防误传，非强加密；建议仅监听内网地址、用防火墙限制来源，
    或置于 SSH 隧道之后。公网直连时务必配合反向代理 HTTPS。
"""
import os
import sys
import json
import time
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


class BackupHandler(BaseHTTPRequestHandler):
    server_version = "WSFCBackup/1.0"
    token = ""
    save_dir = ""
    keep = 30
    max_size = 0  # 单次接收上限（字节），0=不限制

    # ---- 工具 ----
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _safe_name(name):
        base = os.path.basename(name)
        return name == base and base.endswith(".tar.gz")

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), fmt % args))

    # ---- 路由 ----
    def do_GET(self):
        if self.path in ("/", "/health", "/ping"):
            self._send(200, {"ok": True, "service": "wsfc-backup-receiver",
                             "time": time.strftime("%Y-%m-%d %H:%M:%S")})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def _drain_body(self):
        """读取并丢弃尚未读取的请求体，避免发送端因连接被提前关闭而报错。"""
        try:
            size = int(self.headers.get("Content-Length", "0") or 0)
            remaining = size
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
        except Exception:
            pass

    def do_POST(self):
        if self.path != "/upload":
            self._drain_body()
            self._send(404, {"ok": False, "error": "not found"})
            return
        if self.headers.get("X-Backup-Token", "") != self.token:
            self._drain_body()
            self._send(403, {"ok": False, "error": "token 校验失败"})
            return
        filename = self.headers.get("X-Backup-Filename", "")
        if not filename or not self._safe_name(filename):
            self._drain_body()
            self._send(400, {"ok": False, "error": "非法文件名"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if self.max_size and size > self.max_size:
            self._drain_body()
            self._send(413, {"ok": False, "error": f"超过单次接收上限 {self.max_size} 字节"})
            return

        dest = os.path.join(self.save_dir, filename)
        tmp = dest + ".part"
        try:
            received = 0
            with open(tmp, "wb") as f:
                remaining = size
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    received += len(chunk)
                    remaining -= len(chunk)
            if size and received != size:
                raise IOError(f"接收不完整（{received}/{size} 字节）")
            os.replace(tmp, dest)
            self._send(200, {"ok": True, "saved": filename, "size": received})
            self._prune()
        except Exception as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            self._send(500, {"ok": False, "error": str(e)})

    # ---- 保留策略 ----
    def _prune(self):
        if self.keep <= 0:
            return
        files = sorted(
            [f for f in os.listdir(self.save_dir) if f.endswith(".tar.gz")],
            key=lambda f: os.path.getmtime(os.path.join(self.save_dir, f)),
        )
        while len(files) > self.keep:
            old = files.pop(0)
            try:
                os.remove(os.path.join(self.save_dir, old))
                sys.stderr.write("[%s] 已清理旧备份：%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), old))
            except OSError:
                pass


def main():
    ap = argparse.ArgumentParser(description="WSFC_ERP 云备份接收端")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    ap.add_argument("--port", type=int, default=int(os.environ.get("BACKUP_PORT", "8765")), help="监听端口")
    ap.add_argument("--token", default=os.environ.get("BACKUP_TOKEN", ""), help="共享密钥")
    ap.add_argument("--dir", default=os.environ.get("BACKUP_DIR", "./backups_received"), help="保存目录")
    ap.add_argument("--keep", type=int, default=int(os.environ.get("BACKUP_KEEP", "30")), help="保留份数")
    ap.add_argument("--max-size", type=int, default=0, help="单次接收上限（MB），0=不限制")
    args = ap.parse_args()

    if not args.token:
        print("必须提供 --token（或环境变量 BACKUP_TOKEN）作为共享密钥", file=sys.stderr)
        sys.exit(2)

    os.makedirs(args.dir, exist_ok=True)
    BackupHandler.token = args.token
    BackupHandler.save_dir = args.dir
    BackupHandler.keep = args.keep
    BackupHandler.max_size = args.max_size * 1024 * 1024 if args.max_size > 0 else 0

    srv = ThreadingHTTPServer((args.host, args.port), BackupHandler)
    print(f"WSFC_ERP 备份接收端已启动：http://{args.host}:{args.port}")
    print(f"  保存目录：{os.path.abspath(args.dir)}（保留最近 {args.keep} 份）")
    print(f"  健康检查：GET /health")
    print("  按 Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
