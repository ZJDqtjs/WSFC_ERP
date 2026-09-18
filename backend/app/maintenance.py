"""维护模式开关 + 网站访问活动日志（ERP 主服务与私钥管理后台共用）。

一、维护模式

状态落在 ``data/maintenance.json``（原子写），由私钥管理后台 keyadmin 写入，
ERP 主服务读取后通过 ``GET /api/maintenance/status`` 暴露给前端（无需登录）：

- ``off``         正常服务
- ``announce``    倒计时公告：前端顶部滚动提示 + 倒计时，到点自动切维护页
- ``maintenance`` 维护中：前端整屏维护页，禁止继续使用

典型停服流程：

    在 keyadmin「更新维护」发布公告（deadline = now + 提前分钟数）
    → 到点前端自动进入维护页
    → 停主服务、部署新版本
    → 再次启动主服务时由 :func:`on_service_start` 自动结束维护（可关）

二、访问活动日志

独立的 ``data/activity.db``（与业务库分离，避免拖慢/污染业务数据）。
中间件只做一次入队（O(1)），由后台线程批量写盘，因此对请求延迟几乎没有影响。
keyadmin 读它回答"现在谁在访问、点了哪些功能、有没有报错"。
"""
from __future__ import annotations

import json
import os
import queue
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from .database import DATA_DIR

MAINTENANCE_FILE: Path = DATA_DIR / "maintenance.json"
ACTIVITY_DB: Path = DATA_DIR / "activity.db"

MODE_OFF = "off"
MODE_ANNOUNCE = "announce"
MODE_MAINTENANCE = "maintenance"
_MODES = (MODE_OFF, MODE_ANNOUNCE, MODE_MAINTENANCE)

# 日志上限：超过后按最旧优先裁剪，避免长期运行把磁盘写满
ACTIVITY_MAX_ROWS = 50000


# ============================================================
#  维护状态
# ============================================================
def _default_state() -> dict:
    return {
        "mode": MODE_OFF,
        "message": "",               # 自定义公告文案（空则用默认模板）
        "lead_minutes": 10,          # 提前多少分钟发公告（倒计时时长）
        "eta_minutes": 30,           # 预计维护耗时（分钟）
        "deadline": None,            # 倒计时终点（时间戳），仅 announce 有效
        "started_at": None,
        "updated_at": None,
        "auto_resume_on_start": True,  # 主服务再次启动时自动结束维护
    }


def load_state() -> dict:
    """读取维护状态；文件缺失/损坏一律回退为「正常」，绝不因状态文件影响主服务。"""
    st = _default_state()
    try:
        if MAINTENANCE_FILE.exists():
            data = json.loads(MAINTENANCE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                st.update({k: v for k, v in data.items() if k in st})
    except Exception:
        pass
    if st.get("mode") not in _MODES:
        st["mode"] = MODE_OFF
    return st


def save_state(state: dict) -> dict:
    """原子写维护状态（tmp + replace），避免读写竞争读到半个文件。"""
    tmp = MAINTENANCE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, MAINTENANCE_FILE)
    return state


def _announce_over(st: dict) -> bool:
    dl = st.get("deadline")
    try:
        return bool(dl) and time.time() >= float(dl)
    except Exception:
        return False


def effective_mode(st: dict | None = None) -> str:
    """实际生效的模式：公告倒计时归零即视为「维护中」。"""
    st = st or load_state()
    mode = st.get("mode") or MODE_OFF
    if mode == MODE_ANNOUNCE and _announce_over(st):
        return MODE_MAINTENANCE
    return mode


def remaining_seconds(st: dict | None = None) -> int | None:
    """公告倒计时剩余秒数；非公告态返回 None。"""
    st = st or load_state()
    if st.get("mode") != MODE_ANNOUNCE or not st.get("deadline"):
        return None
    try:
        return max(0, int(float(st["deadline"]) - time.time()))
    except Exception:
        return None


def public_status() -> dict:
    """给前端的公开状态（不含任何敏感信息）。"""
    st = load_state()
    return {
        "mode": effective_mode(st),
        "raw_mode": st.get("mode"),
        "message": st.get("message") or "",
        "eta_minutes": int(st.get("eta_minutes") or 0),
        "lead_minutes": int(st.get("lead_minutes") or 0),
        "remaining_seconds": remaining_seconds(st),
        "server_time": time.time(),
    }


def admin_state() -> dict:
    """给 keyadmin 的完整状态。"""
    st = load_state()
    st["effective_mode"] = effective_mode(st)
    st["remaining_seconds"] = remaining_seconds(st)
    st["server_time"] = time.time()
    return st


def start_announce(
    lead_minutes: int = 10,
    eta_minutes: int = 30,
    message: str = "",
    auto_resume_on_start: bool = True,
) -> dict:
    """发布停服公告并开始倒计时（前端滚动提示 X 分钟后停服）。"""
    lead = max(1, int(lead_minutes))
    now = time.time()
    st = _default_state()
    st.update(
        {
            "mode": MODE_ANNOUNCE,
            "message": (message or "").strip(),
            "lead_minutes": lead,
            "eta_minutes": max(1, int(eta_minutes)),
            "deadline": now + lead * 60,
            "started_at": now,
            "updated_at": now,
            "auto_resume_on_start": bool(auto_resume_on_start),
        }
    )
    return admin_state() if save_state(st) else st


def start_maintenance(
    eta_minutes: int = 30,
    message: str = "",
    auto_resume_on_start: bool = True,
) -> dict:
    """立即进入维护模式（跳过倒计时）。"""
    prev = load_state()
    now = time.time()
    st = _default_state()
    st.update(
        {
            "mode": MODE_MAINTENANCE,
            "message": (message or prev.get("message") or "").strip(),
            "eta_minutes": max(1, int(eta_minutes or prev.get("eta_minutes") or 30)),
            "lead_minutes": int(prev.get("lead_minutes") or 10),
            "deadline": None,
            "started_at": prev.get("started_at") or now,
            "updated_at": now,
            "auto_resume_on_start": bool(auto_resume_on_start),
        }
    )
    save_state(st)
    return admin_state()


def cancel_maintenance() -> dict:
    """结束维护 / 取消公告，恢复正常访问。"""
    st = load_state()
    st.update({"mode": MODE_OFF, "deadline": None, "updated_at": time.time()})
    save_state(st)
    return admin_state()


def on_service_start() -> str | None:
    """ERP 主服务启动时调用。

    约定：维护期间停服 → 部署 → 再次启动主服务即视为维护完成，自动恢复正常访问。
    - ``mode == maintenance``：直接恢复。
    - ``mode == announce``：倒计时未结束的（只是重启了一下服务）保留公告计划；
      倒计时早已结束的（已进入维护时间）恢复。
    - ``auto_resume_on_start`` 为 False 时不自动恢复，需在 keyadmin 手动结束。

    返回被结束的模式（未变更返回 None），便于启动日志打印。
    """
    st = load_state()
    mode = st.get("mode")
    if mode == MODE_OFF or not st.get("auto_resume_on_start", True):
        return None
    if mode == MODE_ANNOUNCE and not _announce_over(st):
        return None
    st.update({"mode": MODE_OFF, "deadline": None, "updated_at": time.time()})
    save_state(st)
    return mode


# ============================================================
#  访问活动日志
# ============================================================
_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS access_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL    NOT NULL,
    method    TEXT,
    path      TEXT,
    query     TEXT,
    status    INTEGER,
    ms        INTEGER,
    ip        TEXT,
    ua        TEXT,
    uid       INTEGER,
    username  TEXT,
    warehouse TEXT,
    ok        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_access_ts ON access_log(ts);
CREATE INDEX IF NOT EXISTS idx_access_ip ON access_log(ip, ts);
"""


def _fmt_time(ts) -> str:
    try:
        return datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


class ActivityStore:
    """访问日志仓库：入队写入，后台线程批量落盘。"""

    def __init__(self, db_path: Path = ACTIVITY_DB):
        self.db_path = db_path
        self._q: "queue.Queue[tuple]" = queue.Queue(maxsize=50000)
        self._lock = threading.Lock()
        self._started = False
        self.dropped = 0
        self._last_prune = 0.0

    # ---- 连接 ----
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=15)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    def ensure_table(self) -> None:
        try:
            conn = self._connect()
            try:
                conn.executescript(_CREATE_SQL)
                conn.commit()
            finally:
                conn.close()
        except Exception:
            pass

    # ---- 写入侧 ----
    def start(self) -> None:
        """启动后台写盘线程（幂等）。"""
        with self._lock:
            if self._started:
                return
            self._started = True
        self.ensure_table()
        threading.Thread(target=self._worker, name="activity-writer", daemon=True).start()

    def record(
        self,
        *,
        method: str,
        path: str,
        query: str = "",
        status: int = 0,
        ms: int = 0,
        ip: str = "",
        ua: str = "",
        uid: int | None = None,
        username: str | None = None,
        warehouse: str = "",
    ) -> None:
        try:
            self._q.put_nowait(
                (
                    time.time(),
                    method,
                    path,
                    (query or "")[:500],
                    int(status or 0),
                    int(ms or 0),
                    (ip or "")[:64],
                    (ua or "")[:300],
                    uid,
                    username,
                    warehouse or "",
                    1 if 200 <= int(status or 0) < 400 else 0,
                )
            )
        except queue.Full:
            self.dropped += 1  # 极端情况下宁可丢日志，也不拖慢业务请求

    def _worker(self) -> None:
        while True:
            batch = []
            try:
                batch.append(self._q.get(timeout=1.0))
            except queue.Empty:
                self._maybe_prune()
                continue
            while len(batch) < 300:
                try:
                    batch.append(self._q.get_nowait())
                except queue.Empty:
                    break
            try:
                conn = self._connect()
                try:
                    conn.executemany(
                        "INSERT INTO access_log"
                        " (ts, method, path, query, status, ms, ip, ua, uid, username, warehouse, ok)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        batch,
                    )
                    conn.commit()
                finally:
                    conn.close()
            except Exception:
                # 写失败（磁盘/锁）不致命：丢掉本批，继续服务
                pass

    def _maybe_prune(self) -> None:
        now = time.time()
        if now - self._last_prune < 600:
            return
        self._last_prune = now
        try:
            conn = self._connect()
            try:
                n = conn.execute("SELECT COUNT(*) FROM access_log").fetchone()[0]
                if n > ACTIVITY_MAX_ROWS:
                    conn.execute(
                        "DELETE FROM access_log WHERE id IN"
                        " (SELECT id FROM access_log ORDER BY id LIMIT ?)",
                        (n - ACTIVITY_MAX_ROWS,),
                    )
                    conn.commit()
            finally:
                conn.close()
        except Exception:
            pass

    # ---- 读取侧（keyadmin 用） ----
    def query(
        self,
        limit: int = 200,
        offset: int = 0,
        keyword: str = "",
        only_error: bool = False,
        minutes: int = 0,
    ) -> dict:
        limit = max(1, min(int(limit or 200), 1000))
        where, args = [], []
        kw = (keyword or "").strip()
        if kw:
            where.append(
                "(username LIKE ? OR ip LIKE ? OR path LIKE ? OR ua LIKE ? OR method LIKE ?)"
            )
            args.extend([f"%{kw}%"] * 5)
        if only_error:
            where.append("(status >= 400 OR status = 0)")
        if minutes:
            where.append("ts >= ?")
            args.append(time.time() - int(minutes) * 60)
        sql_where = (" WHERE " + " AND ".join(where)) if where else ""
        try:
            conn = self._connect()
            try:
                total = conn.execute(
                    f"SELECT COUNT(*) FROM access_log{sql_where}", args
                ).fetchone()[0]
                rows = conn.execute(
                    "SELECT id, ts, method, path, query, status, ms, ip, ua, uid, username, warehouse, ok"
                    f" FROM access_log{sql_where} ORDER BY id DESC LIMIT ? OFFSET ?",
                    (*args, limit, max(0, int(offset or 0))),
                ).fetchall()
            finally:
                conn.close()
        except Exception:
            return {"total": 0, "items": []}
        items = [
            {
                "id": r[0],
                "time": _fmt_time(r[1]),
                "ts": r[1],
                "method": r[2],
                "path": r[3],
                "query": r[4],
                "status": r[5],
                "ms": r[6],
                "ip": r[7],
                "ua": r[8],
                "uid": r[9],
                "username": r[10],
                "warehouse": r[11],
                "ok": bool(r[12]),
            }
            for r in rows
        ]
        return {"total": total, "items": items}

    def online(self, minutes: int = 5) -> list[dict]:
        """近 N 分钟仍在活动的访问者（按 IP+账号 归并）。"""
        since = time.time() - max(1, int(minutes)) * 60
        try:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT COALESCE(username, ''), COALESCE(ip, ''), MAX(ts), COUNT(*),"
                    " (SELECT path FROM access_log a2 WHERE a2.ip = a.ip"
                    "   AND COALESCE(a2.username,'') = COALESCE(a.username,'')"
                    "   ORDER BY a2.ts DESC LIMIT 1)"
                    " FROM access_log a WHERE ts >= ?"
                    " GROUP BY COALESCE(username, ''), COALESCE(ip, '')"
                    " ORDER BY MAX(ts) DESC LIMIT 200",
                    (since,),
                ).fetchall()
            finally:
                conn.close()
        except Exception:
            return []
        return [
            {
                "username": r[0] or "（未登录）",
                "ip": r[1],
                "last_time": _fmt_time(r[2]),
                "last_ts": r[2],
                "requests": r[3],
                "last_path": r[4] or "",
            }
            for r in rows
        ]

    def summary(self, minutes: int = 5) -> dict:
        """概览：在线人数、今日请求量、错误数、平均耗时。"""
        today0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        since_today = today0.timestamp()
        out = {
            "online": [],
            "online_people": 0,
            "online_ips": 0,
            "today_requests": 0,
            "today_errors": 0,
            "today_logins": 0,
            "avg_ms": 0,
            "total_rows": 0,
            "dropped": self.dropped,
            "server_time": _fmt_time(time.time()),
            "window_minutes": int(minutes),
        }
        out["online"] = self.online(minutes)
        out["online_people"] = len(out["online"])
        out["online_ips"] = len({o["ip"] for o in out["online"] if o["ip"]})
        try:
            conn = self._connect()
            try:
                out["total_rows"] = conn.execute("SELECT COUNT(*) FROM access_log").fetchone()[0]
                row = conn.execute(
                    "SELECT COUNT(*),"
                    " SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END),"
                    " SUM(CASE WHEN path LIKE '%/auth/login%' THEN 1 ELSE 0 END),"
                    " AVG(ms) FROM access_log WHERE ts >= ?",
                    (since_today,),
                ).fetchone()
                if row:
                    out["today_requests"] = row[0] or 0
                    out["today_errors"] = row[1] or 0
                    out["today_logins"] = row[2] or 0
                    out["avg_ms"] = int(row[3] or 0)
            finally:
                conn.close()
        except Exception:
            pass
        return out

    def clear(self) -> int:
        """清空日志，返回删除行数。"""
        try:
            conn = self._connect()
            try:
                n = conn.execute("SELECT COUNT(*) FROM access_log").fetchone()[0]
                conn.execute("DELETE FROM access_log")
                conn.commit()
                return int(n)
            finally:
                conn.close()
        except Exception:
            return 0

    def export_rows(self, minutes: int = 0) -> list[dict]:
        """导出（最多 5000 条）供 keyadmin 生成 CSV。"""
        return self.query(limit=1000, minutes=minutes)["items"]


# 进程内单例
activity = ActivityStore()


def start_activity_store() -> None:
    activity.start()


# ============================================================
#  请求记录辅助（供 app.main 中间件调用）
# ============================================================
_uid_name_cache: dict[int, tuple[str | None, float]] = {}


def resolve_username(uid: int | None) -> str | None:
    """uid → 用户名（账号注册表固定在默认仓）；带 5 分钟缓存，避免每请求查库。"""
    if not uid:
        return None
    now = time.time()
    hit = _uid_name_cache.get(uid)
    if hit and now - hit[1] < 300:
        return hit[0]
    name: str | None = None
    try:
        from sqlalchemy import select

        from .database import DEFAULT_WAREHOUSE_KEY, get_sessionmaker
        from .models import User

        s = get_sessionmaker(DEFAULT_WAREHOUSE_KEY)()
        try:
            u = s.scalar(select(User).where(User.id == int(uid)))
            name = u.username if u else None
        finally:
            s.close()
    except Exception:
        name = None
    _uid_name_cache[uid] = (name, now)
    return name


def client_ip(request) -> str:
    """真实客户端 IP：nginx 反代时优先取 X-Real-IP / X-Forwarded-For。"""
    try:
        xri = request.headers.get("x-real-ip")
        if xri:
            return xri.strip()
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
        return request.client.host if request.client else ""
    except Exception:
        return ""


def should_record(path: str, api_route: str = "/api") -> bool:
    """只记录业务 API；静态资源由 nginx 托管，维护状态轮询太频繁也不记。"""
    if not path.startswith(api_route + "/"):
        return False
    if path in (f"{api_route}/maintenance/status", f"{api_route}/maintenance"):
        return False
    if path.startswith(f"{api_route}/activity"):
        return False
    return True


def record_request(request, path: str, status: int, ms: int) -> None:
    """把一条访问记录入队（中间件调用；任何异常都不应影响业务请求）。"""
    try:
        from .auth import COOKIE_NAME, decode_token

        payload = decode_token(request.cookies.get(COOKIE_NAME)) or {}
        uid = payload.get("uid")
        warehouse = payload.get("wh") or ""
    except Exception:
        uid, warehouse = None, ""
    try:
        activity.record(
            method=request.method,
            path=path,
            query=request.url.query or "",
            status=status,
            ms=ms,
            ip=client_ip(request),
            ua=request.headers.get("user-agent", ""),
            uid=int(uid) if uid else None,
            username=resolve_username(int(uid)) if uid else None,
            warehouse=warehouse,
        )
    except Exception:
        pass
