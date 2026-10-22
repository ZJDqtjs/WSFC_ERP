package erp

// 本文件是远程备份接收端的脚本文本生成，逐字符对齐 app/routers/backup.py 里的
// _RECEIVER_PY / _deploy_script / _stop_script。这两个接口是纯文本下载（.sh），
// 运维直接传到备份服务器执行，所以正文（缩进、shell 引号转义、heredoc 标记、结尾换行）
// 必须与 Python 一模一样；同时 Go 侧只生成文本，绝不连备份服务器、绝不执行任何远端命令。

import (
	"fmt"
	"strings"
)

// receiverPY 是随部署脚本下发到备份服务器的接收端程序（纯 Python 标准库）。
// 内容 = Python 的 _RECEIVER_PY.strip("\n")，从 backup.py 原样抄录，一行都不能差。
const receiverPY = `import os
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
    main()`

// DeployScript 生成一键部署脚本。参数取自 backup_config.json：
// 端口/路径来自 remote_url，token 为空时临时生成一个（与 Python 一样只在脚本里用，不落盘由调用方决定），
// keep 取 remote_keep（falsy 时回 100）。Python 用 "\n".join(lines) 且末元素是空串，所以结尾是一个换行。
// remote_url 的端口非法时（Python 的 .port 抛 ValueError）返回错误，由接口层回 500。
func DeployScript(cfg map[string]any) (string, error) {
	port, prefix, token, keep, err := RemoteScriptParams(cfg)
	if err != nil {
		return "", err
	}
	lines := []string{
		"#!/usr/bin/env bash",
		"# ERP 远程备份接收端 - 一键部署脚本（由 ERP 系统自动生成，请勿手动修改）",
		"# 用法：上传到备份服务器后执行：  bash deploy_erp_backup_receiver.sh",
		"set -e",
		"",
		fmt.Sprintf(`PORT="%d"`, port),
		fmt.Sprintf(`PREFIX="%s"`, prefix),
		fmt.Sprintf(`TOKEN="%s"`, token),
		fmt.Sprintf(`KEEP="%d"`, keep),
		fmt.Sprintf(`APP_DIR="%s"`, RemoteAppDir()),
		`DATA_DIR="$APP_DIR/data"`,
		"",
		"if ! command -v python3 >/dev/null 2>&1; then",
		`  echo "未找到 python3，请先安装：apt install -y python3 或 yum install -y python3" >&2`,
		"  exit 1",
		"fi",
		"",
		`mkdir -p "$DATA_DIR"`,
		"",
		"# 写入接收端程序",
		`cat > "$APP_DIR/receiver.py" <<'PYEOF'`,
		receiverPY,
		"PYEOF",
		"",
		"# 若已在运行则先停止旧进程",
		`if [ -f "$APP_DIR/receiver.pid" ]; then`,
		`  kill "$(cat "$APP_DIR/receiver.pid")" 2>/dev/null || true`,
		"  sleep 1",
		"fi",
		"",
		`nohup python3 "$APP_DIR/receiver.py" --host 0.0.0.0 --port "$PORT" --prefix "$PREFIX" --dir "$DATA_DIR" --token "$TOKEN" --keep "$KEEP" > "$APP_DIR/receiver.log" 2>&1 &`,
		`echo $! > "$APP_DIR/receiver.pid"`,
		"sleep 1",
		"",
		`echo "接收端已启动，PID=$(cat "$APP_DIR/receiver.pid")"`,
		`echo "接收地址： http://<本机IP>:$PORT$PREFIX      （与本页填写的地址保持一致）"`,
		`echo "健康检查： curl http://127.0.0.1:$PORT$PREFIX/health"`,
		`echo "查看日志： tail -f $APP_DIR/receiver.log"`,
		"",
	}
	return strings.Join(lines, "\n"), nil
}

// StopScript 生成一键停止脚本（不含任何配置参数，纯固定文本）。
func StopScript(cfg map[string]any) string {
	lines := []string{
		"#!/usr/bin/env bash",
		"# ERP 远程备份接收端 - 一键停止脚本（由 ERP 系统自动生成）",
		"# 用法：上传到备份服务器后执行：  bash stop_erp_backup_receiver.sh",
		fmt.Sprintf(`APP_DIR="%s"`, RemoteAppDir()),
		`if [ -f "$APP_DIR/receiver.pid" ]; then`,
		`  PID="$(cat "$APP_DIR/receiver.pid")"`,
		`  if kill "$PID" 2>/dev/null; then echo "已停止接收端 (PID=$PID)"; else echo "接收端未在运行"; fi`,
		`  rm -f "$APP_DIR/receiver.pid"`,
		"else",
		`  pkill -f "$APP_DIR/receiver.py" && echo "已停止接收端" || echo "未找到运行中的接收端"`,
		"fi",
		"",
	}
	return strings.Join(lines, "\n")
}
