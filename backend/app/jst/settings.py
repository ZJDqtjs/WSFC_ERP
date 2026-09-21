"""「自动出库设置」的读写。

存放位置：backend/json/jst_auto.json（backend/json 未被 git 跟踪，含聚水潭账号口令）。

一个文件同时装全局账号与各 ERP 分仓的配置，方便定时线程一次读完：

{
  "account": "聚水潭账号", "password": "…", "cookie": "…",
  "owner_co_id": "13662884", "min_interval": 10, "timeout": 120, "max_retries": 3,
  "io_date_field": "io_date",
  "warehouses": {
    "wh01": {
      "enabled": true,
      "targets": [{"co_id": "123456", "name": "昆明蔬菜仓"}],   # 要导入哪些聚水潭分仓
      "window": "yesterday",          # 导出时间段规则（或用 fixed_from/fixed_to 固定区间）
      "fixed_from": "", "fixed_to": "",
      "schedule": ["07:30", "19:30"], # 每天几点执行
      "auto_import": true,            # 下载后是否直接建出库单
      "skip_imported": true,          # 跳过已导入过的单据号
      "operator": "",                 # 以哪个账号落库（留空=第一个管理员）
      "last_run": {…}, "runs": [ {…} ],
      "done_slots": ["2026-09-21 07:30"]
    }
  }
}
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent  # backend/
FILE = ROOT / "json" / "jst_auto.json"

LOCK = threading.RLock()

# 全局默认值（原项目 jst_export 的 .env 默认值，改成在这里维护）
GLOBAL_DEFAULTS: dict[str, Any] = {
    "account": "",
    "password": "",
    "cookie": "",
    "owner_co_id": "13662884",
    "min_interval": 10.0,
    "timeout": 120.0,
    "max_retries": 3,
    "io_date_field": "io_date",
    "filename_template": "销售出库单_{start:%Y%m%d}_{authorize_co_id}.xlsx",
    # 需要人工介入时的通知：站内弹窗 + 可选 webhook（企业微信/钉钉机器人、Server酱、Bark 都能收）
    "notify_webhook": "",
    "notify_users": [],     # 登录后弹窗提醒的账号名单；留空 = 所有管理员
}

# 每个分仓的默认值
WH_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "targets": [],          # [{co_id, name}]
    "window": "yesterday",
    "fixed_from": "",
    "fixed_to": "",
    "schedule": [],         # ["07:30", "19:30:today"]
    "auto_import": True,
    "skip_imported": True,
    "operator": "",
    "last_run": {},
    "runs": [],
    "done_slots": [],
    "pending": [],          # 需要人工介入的待办（商品资料待补全 / 验证码 / 导出失败）
}

MAX_RUNS = 50  # 每个分仓保留的执行记录条数

# 字段长度上限，防止误填超长内容把 json 写坏 / 页面撑爆
_MAX_TEXT = 4000


def _clean_str(v: Any, limit: int = _MAX_TEXT) -> str:
    return str(v if v is not None else "").strip()[:limit]


def _clean_num(v: Any, default: float, lo: float, hi: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return min(max(f, lo), hi)


def _clean_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on", "是")
    return default if v is None else bool(v)


@dataclass
class _View:
    """对外（前端）展示用的脱敏视图。"""

    data: dict[str, Any]


def load() -> dict[str, Any]:
    """读整个设置文件（缺失/损坏返回空结构，不会抛异常）。"""
    with LOCK:
        try:
            d = json.loads(FILE.read_text(encoding="utf-8"))
            if not isinstance(d, dict):
                return {"warehouses": {}}
        except Exception:  # noqa: BLE001 - 文件缺失/损坏都不该让接口 500
            return {"warehouses": {}}
        if not isinstance(d.get("warehouses"), dict):
            d["warehouses"] = {}
        return d


def save(d: dict[str, Any]) -> None:
    with LOCK:
        FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(FILE)  # 原子替换，避免定时线程读到写一半的文件


def globals_of(d: dict[str, Any] | None = None) -> dict[str, Any]:
    """全局配置（补默认值）。"""
    d = d or load()
    out = dict(GLOBAL_DEFAULTS)
    for k in GLOBAL_DEFAULTS:
        if k in d:
            out[k] = d[k]
    out["min_interval"] = _clean_num(out.get("min_interval"), 10.0, 0.0, 600.0)
    out["timeout"] = _clean_num(out.get("timeout"), 120.0, 5.0, 600.0)
    out["max_retries"] = int(_clean_num(out.get("max_retries"), 3, 1, 10))
    return out


def wh_of(d: dict[str, Any] | None, key: str) -> dict[str, Any]:
    """某个 ERP 分仓的配置（补默认值 + 归一化）。"""
    d = d or load()
    raw = (d.get("warehouses") or {}).get(key) or {}
    out = dict(WH_DEFAULTS)
    out.update({k: v for k, v in raw.items() if k not in ("last_run", "runs", "done_slots")})
    out["targets"] = [
        {"co_id": _clean_str(t.get("co_id"), 32), "name": _clean_str(t.get("name"), 128)}
        for t in (raw.get("targets") or [])
        if isinstance(t, dict) and _clean_str(t.get("co_id"), 32)
    ]
    out["schedule"] = [_clean_str(s, 48) for s in (raw.get("schedule") or []) if _clean_str(s, 48)]
    out["last_run"] = raw.get("last_run") if isinstance(raw.get("last_run"), dict) else {}
    out["runs"] = raw.get("runs") if isinstance(raw.get("runs"), list) else []
    out["done_slots"] = [s for s in (raw.get("done_slots") or []) if isinstance(s, str)]
    out["pending"] = [t for t in (raw.get("pending") or []) if isinstance(t, dict) and t.get("id")]
    out["enabled"] = _clean_bool(out.get("enabled"))
    out["auto_import"] = _clean_bool(out.get("auto_import"), True)
    out["skip_imported"] = _clean_bool(out.get("skip_imported"), True)
    return out


def patch_globals(patch: dict[str, Any]) -> dict[str, Any]:
    """保存全局配置；password/cookie 传空串表示「不修改」。"""
    with LOCK:
        d = load()
        for k in ("account", "cookie", "owner_co_id", "io_date_field", "filename_template"):
            if k in patch and patch[k] is not None:
                d[k] = _clean_str(patch[k])
        # 口令类：留空 = 保持不变（前端不回显）
        for k in ("password",):
            if k in patch and _clean_str(patch[k]):
                d[k] = _clean_str(patch[k])
        for k, lo, hi in (("min_interval", 0.0, 600.0), ("timeout", 5.0, 600.0), ("max_retries", 1.0, 10.0)):
            if k in patch and patch[k] not in (None, ""):
                d[k] = _clean_num(patch[k], GLOBAL_DEFAULTS[k], lo, hi)
        if "notify_webhook" in patch and patch["notify_webhook"] is not None:
            d["notify_webhook"] = _clean_str(patch["notify_webhook"], 500)
        if "notify_users" in patch and patch["notify_users"] is not None:
            d["notify_users"] = [_clean_str(x, 64) for x in patch["notify_users"] if _clean_str(x, 64)]
        save(d)
        return globals_of(d)


def patch_wh(key: str, patch: dict[str, Any]) -> dict[str, Any]:
    """保存某个分仓的配置（只接受白名单字段）。"""
    with LOCK:
        d = load()
        cur = wh_of(d, key)
        for k in ("window", "fixed_from", "fixed_to", "operator"):
            if k in patch and patch[k] is not None:
                cur[k] = _clean_str(patch[k], 64)
        for k in ("enabled", "auto_import", "skip_imported"):
            if k in patch and patch[k] is not None:
                cur[k] = _clean_bool(patch[k], cur.get(k, False))
        if "targets" in patch and patch["targets"] is not None:
            cur["targets"] = [
                {"co_id": _clean_str((t or {}).get("co_id"), 32), "name": _clean_str((t or {}).get("name"), 128)}
                for t in patch["targets"]
                if isinstance(t, dict) and _clean_str(t.get("co_id"), 32)
            ]
        if "schedule" in patch and patch["schedule"] is not None:
            cur["schedule"] = [_clean_str(s, 48) for s in patch["schedule"] if _clean_str(s, 48)]
        # 运行时数据（执行记录 / 定时点标记 / 待办）不参与本次写入，但要原样带回去，否则会被覆盖掉
        runtime = {k: cur[k] for k in ("last_run", "runs", "done_slots", "pending") if k in cur}
        for k in ("last_run", "runs", "done_slots", "pending"):
            cur.pop(k, None)
        cur.update(runtime)
        d.setdefault("warehouses", {})[key] = cur
        save(d)
        return wh_of(d, key)


def set_cookie(cookie: str) -> None:
    """Cookie 续登成功后写回。"""
    with LOCK:
        d = load()
        d["cookie"] = _clean_str(cookie, 20000)
        save(d)


def record_run(key: str, entry: dict[str, Any]) -> None:
    """追加一条执行记录（最新的在前，最多保留 MAX_RUNS 条）。"""
    with LOCK:
        d = load()
        wh = d.setdefault("warehouses", {}).setdefault(key, {})
        runs = wh.get("runs") if isinstance(wh.get("runs"), list) else []
        runs.insert(0, entry)
        wh["runs"] = runs[:MAX_RUNS]
        wh["last_run"] = entry
        save(d)


def mark_slot(key: str, slot_text: str, day: str) -> bool:
    """标记某分仓某天某个定时点已执行。

    返回 True 表示这次是首次标记（可以执行）；False 表示本次运行周期内已执行过
    （避免服务重启后在同一分钟内重复导出）。
    """
    with LOCK:
        d = load()
        wh = d.setdefault("warehouses", {}).setdefault(key, {})
        done = [s for s in (wh.get("done_slots") or []) if isinstance(s, str) and s.startswith(day)]
        if slot_text in done:
            wh["done_slots"] = done
            save(d)
            return False
        done.append(slot_text)
        wh["done_slots"] = done
        save(d)
        return True


def prune_slots(day: str) -> None:
    """清掉非今天的定时点标记（每天一次即可，避免文件无限增长）。"""
    with LOCK:
        d = load()
        changed = False
        for wh in (d.get("warehouses") or {}).values():
            if not isinstance(wh, dict):
                continue
            done = [s for s in (wh.get("done_slots") or []) if isinstance(s, str) and s.startswith(day)]
            if done != (wh.get("done_slots") or []):
                wh["done_slots"] = done
                changed = True
        if changed:
            save(d)


def globals_view(d: dict[str, Any] | None = None) -> dict[str, Any]:
    """全局配置（含通知设置，非口令类），供前端编辑。"""
    g = globals_of(d)
    g["notify_webhook"] = _clean_str(g.get("notify_webhook"), 500)
    g["notify_users"] = [_clean_str(x, 64) for x in (g.get("notify_users") or []) if _clean_str(x, 64)]
    return g


# ---------------------------------------------------------------- 待办（人工介入）
MAX_PENDING = 20          # 一个分仓最多保留的未完成待办数
MAX_PENDING_ITEMS = 200   # 单个待办里最多列出的明细条数


def pending_open(key: str) -> list[dict[str, Any]]:
    """该分仓未完成的待办（新→旧）。"""
    return [t for t in wh_of(load(), key).get("pending") or [] if t.get("status", "open") == "open"]


def upsert_pending(key: str, task: dict[str, Any]) -> dict[str, Any]:
    """写入/更新一条待办。

    同一个「类型 + 文件」的待办会就地更新（避免同一次失败反复产生多条），
    并把原有的人工填写内容（如已填的验证码）保留下来。
    """
    with LOCK:
        d = load()
        wh = d.setdefault("warehouses", {}).setdefault(key, {})
        items = [t for t in (wh.get("pending") or []) if isinstance(t, dict)]
        if len(task.get("items") or []) > MAX_PENDING_ITEMS:
            task["items"] = task["items"][:MAX_PENDING_ITEMS]
        old = next((t for t in items
                    if t.get("type") == task.get("type") and t.get("files") == task.get("files")), None)
        if old:
            keep = {k: old[k] for k in ("id", "verify_code", "cookie", "created_at") if old.get(k)}
            old.update(task)
            old.update(keep)
            task = old
        else:
            task.setdefault("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            items.insert(0, task)
        wh["pending"] = items[:MAX_PENDING]
        save(d)
        return task


def pending_verify_code(key: str) -> str:
    """待办里人工填的验证码（供自动续登时带上）。取最新一条。"""
    for t in pending_open(key):
        code = _clean_str(t.get("verify_code"), 32)
        if code:
            return code
    return ""


def close_pending(key: str, task_id: str, *, status: str = "done", note: str = "") -> dict[str, Any] | None:
    """把一条待办标记为已完成/已忽略。"""
    with LOCK:
        d = load()
        wh = d.setdefault("warehouses", {}).setdefault(key, {})
        found = None
        for t in wh.get("pending") or []:
            if isinstance(t, dict) and t.get("id") == task_id:
                t["status"] = status
                t["closed_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if note:
                    t["close_note"] = note
                found = t
        if found:
            save(d)
        return found


def patch_pending_item(key: str, task_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    """更新待办里的少量字段（如人工填的验证码 / Cookie）。"""
    with LOCK:
        d = load()
        wh = d.setdefault("warehouses", {}).setdefault(key, {})
        found = None
        for t in wh.get("pending") or []:
            if isinstance(t, dict) and t.get("id") == task_id:
                t.update({k: v for k, v in patch.items() if k not in ("id", "status")})
                found = t
        if found:
            save(d)
        return found


def public_globals(d: dict[str, Any] | None = None) -> dict[str, Any]:
    """回给前端的全局配置：口令类只回「是否已设置」，不回明文。"""
    g = globals_of(d)
    g["has_password"] = bool(g.pop("password", ""))
    cookie = g.pop("cookie", "") or ""
    g["has_cookie"] = bool(cookie)
    g["cookie_len"] = len(cookie)
    return g


def next_runs(slots: list[str], now: datetime | None = None, limit: int = 3) -> list[str]:
    """算出接下来几个执行时间（只做展示，不参与调度判定）。"""
    from .config import parse_schedule

    now = now or datetime.now()
    times: list[datetime] = []
    try:
        parsed = parse_schedule(slots)
    except ValueError:
        return []
    for day_offset in range(0, 8):
        day = now.date().fromordinal(now.date().toordinal() + day_offset)
        for s in parsed:
            t = datetime(day.year, day.month, day.day, s.hour, s.minute)
            if t > now:
                times.append(t)
        if len(times) >= limit:
            break
    return [t.strftime("%Y-%m-%d %H:%M") for t in sorted(times)[:limit]]
