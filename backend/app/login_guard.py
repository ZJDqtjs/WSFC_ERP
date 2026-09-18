"""登录失败分级锁定（业务主系统与 keyadmin 共用同一套规则）。

规则（按「账号」计数，连续失败累加，登录成功立即清零）：

    第 1 档：累计失败  3 次 → 等待 1 分钟
    第 2 档：再失败    3 次 → 等待 3 分钟
    第 3 档：再失败    3 次 → 等待 5 分钟
    第 4 档：再失败    3 次 → 等待 1 小时
    第 5 档：再失败    3 次 → 等待 24 小时
    之后：每再失败 3 次继续等待 24 小时，直到登录成功清零。

锁定期内即使凭证正确也一律拒绝，直到倒计时结束 —— 否则爆破者可以"试到对为止"。

状态存在 `backend/data/login_locks.json`（不落库、不改表结构），原因：
- keyadmin(8001) 与主系统(8000) 是两个进程，内存状态不互通，放文件才能互相查看/解锁；
- 重启服务不会把锁定状态清零，也便于人工直接删文件应急解锁；
- 该文件位于已 gitignore 的 backend/data 下，不会进仓库。

对外接口：
    locked_left(scope, username) -> int      剩余锁定秒数（0 = 未锁定）
    record_fail(scope, username) -> int      记一次失败；返回本次触发的锁定秒数
    reset(scope, username)                   登录成功时清零
    locked_list(scope) -> list[dict]         当前锁定中的账号
    clear(scope, username="")                手动解锁（username 为空 = 清空该 scope）
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from .database import DATA_DIR

SCOPE_ERP = "erp"
SCOPE_KEYADMIN = "keyadmin"

FAILS_PER_STEP = 3
LADDER_SECONDS = (60, 180, 300, 3600, 86400)

# 超过这个时间没有任何失败记录就丢弃（避免文件无限增长）
_STALE_SECONDS = 7 * 86400

_LOCKS_FILE: Path = DATA_DIR / "login_locks.json"


def humanize(seconds: int) -> str:
    """把秒数写成中文时长，用于错误提示。"""
    seconds = max(int(seconds), 1)
    if seconds >= 86400:
        days, rest = divmod(seconds, 86400)
        return f"{days} 天" if rest == 0 else f"{days} 天 {rest // 3600} 小时"
    if seconds >= 3600:
        hours, rest = divmod(seconds, 3600)
        return f"{hours} 小时" if rest == 0 else f"{hours} 小时 {rest // 60} 分钟"
    if seconds >= 60:
        minutes, rest = divmod(seconds, 60)
        return f"{minutes} 分钟" if rest == 0 else f"{minutes} 分 {rest} 秒"
    return f"{seconds} 秒"


def _key(scope: str, username: str) -> str:
    return f"{scope}:{(username or '').strip().lower()}"


def _load() -> dict:
    try:
        data = json.loads(_LOCKS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _save(records: dict) -> None:
    """原子写盘，并顺手清理过期条目。"""
    now = time.time()
    keep = {
        key: rec
        for key, rec in records.items()
        if isinstance(rec, dict)
        and (rec.get("fails", 0) or 0) > 0
        and now - float(rec.get("ts", 0) or 0) < _STALE_SECONDS
    }
    tmp = _LOCKS_FILE.with_suffix(".json.tmp")
    try:
        _LOCKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(keep, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, _LOCKS_FILE)
    except Exception:
        # 记不上就算了：锁定是"尽力而为"的防护，不能因为磁盘问题让登录整体失败
        pass


def _record(records: dict, key: str) -> dict:
    rec = records.get(key)
    if not isinstance(rec, dict):
        rec = {"fails": 0, "until": 0.0, "level": 0, "ts": 0.0}
    rec.setdefault("fails", 0)
    rec.setdefault("until", 0.0)
    rec.setdefault("level", 0)
    rec.setdefault("ts", 0.0)
    return rec


def locked_left(scope: str, username: str) -> int:
    """剩余锁定秒数；0 表示当前未锁定（失败次数会被保留，下次再错继续进档）。"""
    rec = _load().get(_key(scope, username))
    if not isinstance(rec, dict):
        return 0
    left = int(float(rec.get("until", 0) or 0) - time.time())
    return left if left > 0 else 0


def record_fail(scope: str, username: str) -> int:
    """记一次失败。返回本次新触发的锁定秒数（0 = 还没到档位，不锁定）。"""
    records = _load()
    key = _key(scope, username)
    rec = _record(records, key)
    rec["fails"] = int(rec["fails"]) + 1
    rec["ts"] = time.time()
    wait = 0
    if rec["fails"] % FAILS_PER_STEP == 0:
        level = rec["fails"] // FAILS_PER_STEP
        wait = LADDER_SECONDS[min(level, len(LADDER_SECONDS)) - 1]
        rec["level"] = level
        rec["until"] = time.time() + wait
    records[key] = rec
    _save(records)
    return wait


def reset(scope: str, username: str) -> None:
    """登录成功：清零，回到起始状态。"""
    records = _load()
    if records.pop(_key(scope, username), None) is not None:
        _save(records)


def locked_list(scope: str) -> list[dict]:
    """当前仍在锁定中的账号（供 keyadmin 展示/手动解锁）。"""
    now = time.time()
    out = []
    for key, rec in _load().items():
        if not isinstance(rec, dict):
            continue
        sc, _, user = key.partition(":")
        if sc != scope:
            continue
        left = int(float(rec.get("until", 0) or 0) - now)
        if left <= 0:
            continue
        out.append({
            "username": user,
            "fails": int(rec.get("fails", 0)),
            "level": int(rec.get("level", 0)),
            "left": left,
            "left_text": humanize(left),
        })
    return sorted(out, key=lambda item: -item["left"])


def clear(scope: str, username: str = "") -> int:
    """手动解除锁定。username 为空表示清空该 scope 下所有账号。返回清除条数。"""
    records = _load()
    if not username:
        targets = [k for k in records if k.partition(":")[0] == scope]
    else:
        key = _key(scope, username)
        targets = [key] if key in records else []
    for key in targets:
        records.pop(key, None)
    if targets:
        _save(records)
    return len(targets)
