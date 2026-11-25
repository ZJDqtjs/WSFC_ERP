"""「京麦（POP 店）」自动导入设置的读写。

存放位置：backend/json/pop_auto.json（与 jst_auto.json 并列，同目录已被自动备份覆盖）。
按 ERP 分仓隔离，一个文件装全局 + 各分仓，方便调度线程一次读完：

{
  "service_url": "",                 # 覆盖 jdfenxi 地址，空 = 用 ERP_AD_SERVICE_URL/默认 127.0.0.1:18011
  "warehouses": {
    "wh01": {
      "enabled": true,
      "accounts": [{"account": "acct4", "customer": "沛沛佳pop", "label": "沛沛佳pop"}],
      "price_mode": "supply",        # supply=京东供货价 / pay=买家实付
      "statuses": [16, 19],          # 可导入的状态码：16 已出库、19 已完成
      "days": 7,                     # 每次拉的滚动窗口（jdfenxi 每晚重抓最近 7 天）
      "schedule": ["19:40"],         # 每天执行时间（jdfenxi 19:00 抓完之后）
      "jitter_minutes": 10,
      "auto_express": true,          # 按整单毛重自动算快递费（代发按商品净重）
      "auto_reverse": true,          # 订单变「已取消」时自动红冲已建的单
      "skip_imported": true,
      "operator": "",
      "last_run": {}, "runs": [], "done_slots": [], "pending": []
    }
  }
}
"""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent  # backend/
FILE = ROOT / "json" / "pop_auto.json"

LOCK = threading.RLock()

MAX_RUNS = 50
MAX_PENDING = 20
MAX_PENDING_ITEMS = 200

# 京东 POP 订单状态码（按 jdfenxi 实际返回统计：8 待出库、16 已出库、19 已完成、29 已取消）
STATUS_CHOICES = [
    {"code": 16, "label": "已出库"},
    {"code": 19, "label": "已完成"},
    {"code": 8, "label": "待出库"},
    {"code": 29, "label": "已取消"},
]

PRICE_MODES = [{"value": "supply", "label": "京东供货价（supplyPrice）"},
               {"value": "pay", "label": "买家实付（amount）"}]

WH_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "accounts": [],          # [{account, customer, label}]
    "price_mode": "supply",
    "statuses": [16, 19],
    # 日切时间（点）：16 = 「昨天 16:00 ~ 今天 16:00 下的单算今天」，0 = 自然日。
    # 出库单日期、每日单量、报表都已按这个业务日归集（见 runner._biz_date）。
    "day_cutoff_hour": 16,
    "days": 7,
    # jdfenxi 每晚 19:00 抓取，导入排在其后（带 ±10 分钟抖动）
    "schedule": ["19:40"],
    "jitter_minutes": 10,
    "auto_express": True,
    "auto_reverse": True,
    "skip_imported": True,
    "operator": "",
    "last_run": {},
    "runs": [],
    "done_slots": [],
    "pending": [],
}

_MAX_TEXT = 4000


def _clean_str(v: Any, limit: int = _MAX_TEXT) -> str:
    return str(v if v is not None else "").strip()[:limit]


def _clean_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on", "是")
    return default if v is None else bool(v)


def _clean_num(v: Any, default: float, lo: float, hi: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return min(max(f, lo), hi)


def load() -> dict[str, Any]:
    """读整个设置文件（缺失/损坏返回空结构，不抛异常）。"""
    with LOCK:
        try:
            d = json.loads(FILE.read_text(encoding="utf-8"))
            if not isinstance(d, dict):
                return {"warehouses": {}}
        except Exception:  # noqa: BLE001
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


def service_url(d: dict[str, Any] | None = None) -> str:
    return _clean_str((d or load()).get("service_url"), 300)


def wh_of(d: dict[str, Any] | None, key: str) -> dict[str, Any]:
    """某个 ERP 分仓的配置（补默认值 + 归一化）。"""
    d = d or load()
    raw = (d.get("warehouses") or {}).get(key) or {}
    out = dict(WH_DEFAULTS)
    out.update({k: v for k, v in raw.items() if k not in ("last_run", "runs", "done_slots", "pending")})
    out["accounts"] = [
        {
            "account": _clean_str(a.get("account"), 64),
            "customer": _clean_str(a.get("customer"), 64),
            "label": _clean_str(a.get("label"), 64),
        }
        for a in (raw.get("accounts") or [])
        if isinstance(a, dict) and _clean_str(a.get("account"), 64)
    ]
    out["statuses"] = sorted({
        int(_clean_num(x, 0, 0, 999)) for x in (raw.get("statuses") or WH_DEFAULTS["statuses"])
        if str(x).strip() != ""
    } - {0})
    raw_sched = raw.get("schedule") if isinstance(raw.get("schedule"), list) else WH_DEFAULTS["schedule"]
    out["schedule"] = [_clean_str(s, 48) for s in raw_sched if _clean_str(s, 48)]
    out["price_mode"] = "pay" if _clean_str(out.get("price_mode")) == "pay" else "supply"
    out["days"] = int(_clean_num(out.get("days"), 7, 1, 30))
    out["day_cutoff_hour"] = int(_clean_num(out.get("day_cutoff_hour"), 16, 0, 23))
    out["jitter_minutes"] = int(_clean_num(out.get("jitter_minutes"), 10, 0, 120))
    for k in ("enabled", "auto_express", "auto_reverse", "skip_imported"):
        out[k] = _clean_bool(out.get(k), bool(WH_DEFAULTS[k]))
    out["operator"] = _clean_str(out.get("operator"), 64)
    out["last_run"] = raw.get("last_run") if isinstance(raw.get("last_run"), dict) else {}
    out["runs"] = raw.get("runs") if isinstance(raw.get("runs"), list) else []
    out["done_slots"] = [s for s in (raw.get("done_slots") or []) if isinstance(s, str)]
    out["pending"] = [t for t in (raw.get("pending") or []) if isinstance(t, dict) and t.get("id")]
    return out


def patch(d: dict[str, Any], key: str, updates: dict[str, Any]) -> dict[str, Any]:
    """保存全局 + 某个分仓的配置（只接受白名单字段，运行时数据原样保留）。"""
    with LOCK:
        data = load()
        if "service_url" in updates and updates["service_url"] is not None:
            data["service_url"] = _clean_str(updates["service_url"], 300)
        cur = wh_of(data, key)
        for k in ("price_mode", "operator"):
            if k in updates and updates[k] is not None:
                cur[k] = _clean_str(updates[k], 64)
        for k in ("enabled", "auto_express", "auto_reverse", "skip_imported"):
            if k in updates and updates[k] is not None:
                cur[k] = _clean_bool(updates[k], cur.get(k, False))
        for k, lo, hi in (("days", 1, 30), ("jitter_minutes", 0, 120), ("day_cutoff_hour", 0, 23)):
            if k in updates and updates[k] not in (None, ""):
                cur[k] = int(_clean_num(updates[k], WH_DEFAULTS[k], lo, hi))
        if "accounts" in updates and updates["accounts"] is not None:
            cur["accounts"] = [
                {
                    "account": _clean_str((a or {}).get("account"), 64),
                    "customer": _clean_str((a or {}).get("customer"), 64),
                    "label": _clean_str((a or {}).get("label"), 64),
                }
                for a in updates["accounts"]
                if isinstance(a, dict) and _clean_str(a.get("account"), 64)
            ]
        if "statuses" in updates and updates["statuses"] is not None:
            cur["statuses"] = sorted({
                int(_clean_num(x, 0, 0, 999)) for x in updates["statuses"] if str(x).strip() != ""
            } - {0})
        if "schedule" in updates and updates["schedule"] is not None:
            cur["schedule"] = [_clean_str(s, 48) for s in updates["schedule"] if _clean_str(s, 48)]
        data.setdefault("warehouses", {})[key] = cur
        save(data)
        return wh_of(data, key)


def record_run(key: str, entry: dict[str, Any], update_last: bool = True) -> None:
    """追加一条执行记录（最新在前，最多 MAX_RUNS 条）。"""
    with LOCK:
        d = load()
        wh = d.setdefault("warehouses", {}).setdefault(key, {})
        runs = wh.get("runs") if isinstance(wh.get("runs"), list) else []
        runs.insert(0, entry)
        wh["runs"] = runs[:MAX_RUNS]
        if update_last:
            wh["last_run"] = entry
        save(d)


def mark_slot(key: str, slot_text: str, day: str) -> bool:
    """标记某分仓某天某个定时点已执行（同一分钟内不重复跑）。"""
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
    """清掉非今天的定时点标记，避免文件无限增长。"""
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


# ---------------------------------------------------------------- 待办（人工介入）
def pending_open(key: str) -> list[dict[str, Any]]:
    return [t for t in wh_of(load(), key).get("pending") or [] if t.get("status", "open") == "open"]


def upsert_pending(key: str, task: dict[str, Any]) -> dict[str, Any]:
    """写入/更新一条待办：同类型就地更新（同一次失败不会反复堆多条）。"""
    with LOCK:
        d = load()
        wh = d.setdefault("warehouses", {}).setdefault(key, {})
        items = [t for t in (wh.get("pending") or []) if isinstance(t, dict)]
        if len(task.get("items") or []) > MAX_PENDING_ITEMS:
            task["items"] = task["items"][:MAX_PENDING_ITEMS]
        old = next((t for t in items if t.get("type") == task.get("type")), None)
        if old:
            keep = {k: old[k] for k in ("id", "created_at") if old.get(k)}
            old.update(task)
            old.update(keep)
            task = old
        else:
            task.setdefault("id", f"pop-{datetime.now():%Y%m%d%H%M%S}-{task.get('type', 'x')}")
            task.setdefault("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            items.insert(0, task)
        wh["pending"] = items[:MAX_PENDING]
        save(d)
        return task


def close_pending(key: str, task_id: str, *, status: str = "done", note: str = "") -> dict[str, Any] | None:
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
