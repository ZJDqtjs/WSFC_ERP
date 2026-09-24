#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WSFC_ERP 云备份 - 发送端

功能
----
1. 对 backend/data 下的 SQLite 数据库做「在线一致性快照」（运行中的服务不受影响）；
2. 连同 backend/json、根目录 config.json / product_rules.json 一起打包为 tar.gz；
3. 通过 HTTP POST 推送到备份服务器的指定端口；
4. 支持一次性执行（配合系统计划任务 / crontab 定时触发），
   或用 --interval 常驻进程定时推送。

依赖：仅 Python 标准库，无需 pip 安装任何第三方包。

用法
----
    # 一次性推送
    python scripts/backup_push.py --host 1.2.3.4 --port 8765 --token 你的密钥

    # 常驻模式：每 6 小时自动推送一次
    python scripts/backup_push.py --host 1.2.3.4 --port 8765 --token 你的密钥 --interval 21600

    # 只做本地打包、不推送（测试）
    python scripts/backup_push.py --dry-run

    # 排除体积大的历史数据库备份目录（路径相对项目根）
    python scripts/backup_push.py --host 1.2.3.4 --port 8765 --token 你的密钥 --exclude "backend/data/backups/*"

环境变量（命令行参数优先）
--------------------------
    BACKUP_HOST   接收端主机
    BACKUP_PORT   接收端端口
    BACKUP_TOKEN  共享密钥（与接收端 --token 一致）

安全提示
--------
    token 仅用于防误连/防误传，不是强加密；建议仅在内网 / 可信网络使用，
    或通过 SSH 隧道 / 防火墙限制来源。备份包内含业务数据与配置，请妥善保管。
"""
import os
import sys
import time
import json
import shutil
import sqlite3
import tarfile
import argparse
import tempfile
import http.client
import fnmatch

# Windows 控制台中文输出兼容
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

PROJ_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 默认备份清单：(相对项目根的源, 打包内的目标名)
DEFAULT_SOURCES = [
    ("backend/data", "data"),
    ("backend/json", "json"),
    ("config.json", "config.json"),
    ("product_rules.json", "product_rules.json"),
]
# 永远不打包的临时文件（相对项目根的路径，可用 fnmatch 通配，* 可跨目录）
DEFAULT_EXCLUDES = ["*.pyc", "*.part", "*.DS_Store"]


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def snapshot_db(src, dst):
    """用 SQLite 在线备份 API 生成一致性快照；失败(非SQLite/损坏)返回 False。"""
    try:
        src_con = sqlite3.connect(src, timeout=15)
        try:
            dst_con = sqlite3.connect(dst)
            try:
                src_con.backup(dst_con)
            finally:
                dst_con.close()
        finally:
            src_con.close()
        return True
    except (sqlite3.Error, OSError):
        return False


def _match(rel, patterns):
    """rel 为相对项目根的路径（/ 分隔）。* 可跨目录；目录 pattern 会额外匹配其下内容。"""
    rel = rel.replace(os.sep, "/").strip("/")
    for p in patterns:
        p = p.replace(os.sep, "/").strip("/")
        if fnmatch.fnmatch(rel, p):
            return True
        if not p.endswith("*") and fnmatch.fnmatch(rel, p + "/*"):
            return True
    return False


def stage_source(proj_root, rel_src, rel_dst, staging, excludes):
    """把单个源(文件或目录)复制到临时打包目录。"""
    src = os.path.join(proj_root, rel_src)
    if not os.path.exists(src):
        log(f"  [跳过] 源不存在：{rel_src}")
        return

    dst = os.path.join(staging, rel_dst)

    if os.path.isfile(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        return

    os.makedirs(dst, exist_ok=True)
    for root, dirs, files in os.walk(src):
        rel_root = os.path.relpath(root, src)
        rel_root = "" if rel_root == "." else rel_root
        # 目录级排除（相对项目根）
        dirs[:] = [d for d in dirs
                   if not _match(os.path.join(rel_src, rel_root, d), excludes)]
        for f in files:
            rel_file = os.path.join(rel_root, f)  # 相对 src，用于打包内结构
            rel_full = os.path.join(rel_src, rel_file)  # 相对项目根，用于排除匹配
            if _match(rel_full, excludes):
                continue
            full_src = os.path.join(root, f)
            full_dst = os.path.join(dst, rel_file)
            os.makedirs(os.path.dirname(full_dst), exist_ok=True)
            if f.endswith(("-wal", "-shm", "-journal")):
                # SQLite 的 WAL 临时文件：在线快照已包含其最新数据，无需复制
                continue
            if f.endswith(".db"):
                if snapshot_db(full_src, full_dst):
                    pass
                else:
                    shutil.copy2(full_src, full_dst)
                    log(f"  [复制] {rel_file}（非 SQLite / 快照失败，直接复制）")
            else:
                shutil.copy2(full_src, full_dst)


def build_archive(sources, excludes):
    """打包到临时 tar.gz，返回 (归档文件路径, 归档显示名)。"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"erp-backup-{stamp}"
    staging = tempfile.mkdtemp(prefix="wsfc-backup-")
    root_dir = os.path.join(staging, name)
    os.makedirs(root_dir, exist_ok=True)
    try:
        for rel_src, rel_dst in sources:
            log(f"  打包 {rel_src} -> {rel_dst}")
            stage_source(PROJ_ROOT, rel_src, rel_dst, root_dir, excludes)
        tarball = os.path.join(tempfile.gettempdir(), name + ".tar.gz")
        with tarfile.open(tarball, "w:gz") as tar:
            tar.add(root_dir, arcname=name)
        return tarball, name + ".tar.gz"
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def push(host, port, token, path):
    """流式上传 tar.gz 到接收端 /upload。返回接收端 JSON 响应。"""
    size = os.path.getsize(path)
    conn = http.client.HTTPConnection(host, int(port), timeout=1800)
    try:
        conn.putrequest("POST", "/upload")
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(size))
        conn.putheader("X-Backup-Token", token)
        conn.putheader("X-Backup-Filename", os.path.basename(path))
        conn.endheaders()
        sent = 0
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                conn.send(chunk)
                sent += len(chunk)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", "replace")
        if resp.status != 200:
            raise RuntimeError(f"接收端返回 HTTP {resp.status}: {body}")
        return json.loads(body)
    finally:
        conn.close()


def prune_local(local_dir, keep):
    if keep <= 0:
        return
    os.makedirs(local_dir, exist_ok=True)
    files = sorted(
        [f for f in os.listdir(local_dir) if f.endswith(".tar.gz")],
        key=lambda f: os.path.getmtime(os.path.join(local_dir, f)),
    )
    while len(files) > keep:
        try:
            os.remove(os.path.join(local_dir, files.pop(0)))
        except OSError:
            pass


def run_once(args):
    log("开始打包…")
    tarball, filename = build_archive(args.sources, args.excludes)
    size = os.path.getsize(tarball)
    log(f"打包完成：{filename}（{size / 1024 / 1024:.2f} MB）")

    if args.dry_run:
        log(f"[dry-run] 不推送，本地归档：{tarball}")
        return 0

    log(f"推送到 http://{args.host}:{args.port}/upload …")
    resp = push(args.host, args.port, args.token, tarball)
    log(f"推送成功：{json.dumps(resp, ensure_ascii=False)}")

    if args.keep_local > 0:
        local_dir = args.local_dir or os.path.join(PROJ_ROOT, "backups_local")
        os.makedirs(local_dir, exist_ok=True)
        shutil.move(tarball, os.path.join(local_dir, filename))
        prune_local(local_dir, args.keep_local)
        log(f"本地保留：{os.path.join(local_dir, filename)}（最多 {args.keep_local} 份）")
    else:
        try:
            os.remove(tarball)
        except OSError:
            pass
    return 0


def main():
    ap = argparse.ArgumentParser(description="WSFC_ERP 云备份发送端")
    ap.add_argument("--host", default=os.environ.get("BACKUP_HOST", ""), help="接收端主机")
    ap.add_argument("--port", default=os.environ.get("BACKUP_PORT", "8765"), help="接收端端口")
    ap.add_argument("--token", default=os.environ.get("BACKUP_TOKEN", ""), help="共享密钥")
    ap.add_argument("--interval", type=int, default=0, help="常驻模式：推送间隔（秒），0=只执行一次")
    ap.add_argument("--dry-run", action="store_true", help="只打包不推送")
    ap.add_argument("--keep-local", type=int, default=0, help="本地保留份数，0=不保留（仅推送）")
    ap.add_argument("--local-dir", default="", help="本地保留目录（默认 <项目根>/backups_local）")
    ap.add_argument("--exclude", action="append", default=[], help="排除的路径通配，可多次指定（相对项目根，如 backend/data/backups/*）")
    ap.add_argument("--source", action="append", default=[], help="额外备份路径（相对项目根），可多次指定")
    args = ap.parse_args()

    if not args.dry_run and (not args.host or not args.token):
        print("缺少 --host 或 --token（或环境变量 BACKUP_HOST / BACKUP_TOKEN）", file=sys.stderr)
        sys.exit(2)

    sources = list(DEFAULT_SOURCES)
    for s in args.source:
        base = os.path.basename(s.rstrip("/\\"))
        sources.append((s, base))
    args.sources = sources
    args.excludes = DEFAULT_EXCLUDES + list(args.exclude)

    log(f"项目根：{PROJ_ROOT}")
    log(f"备份项：{', '.join(s[0] for s in sources)}")

    if args.interval and args.interval > 0:
        while True:
            try:
                run_once(args)
            except KeyboardInterrupt:
                break
            except Exception as e:
                log(f"推送失败：{type(e).__name__}: {e}")
            log(f"下次推送：{args.interval} 秒后")
            time.sleep(args.interval)
    else:
        try:
            sys.exit(run_once(args))
        except KeyboardInterrupt:
            sys.exit(130)
        except Exception as e:
            log(f"推送失败：{type(e).__name__}: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()
