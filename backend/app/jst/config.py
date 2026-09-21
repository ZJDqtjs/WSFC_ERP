"""时间区间规则与定时点的解析。

移植自 AutoExp_ERP321/src/jst_export/config.py，去掉 .env 读取：
区间规则与定时点在「自动出库设置」里配置，这里只负责解析与校验。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

WINDOW_YESTERDAY = "yesterday"
WINDOW_TODAY = "today"
WINDOW_LAST24H = "last24h"

_RE_DAY_AGO = re.compile(r"^d(\d+)$")  # d1=昨天, d2=前天
_RE_LAST_DAYS = re.compile(r"^last(\d+)d$")  # last7d=最近 7 个整天
_RE_LAST_HOURS = re.compile(r"^last(\d+)h$")  # last2h=最近 2 小时（含 last24h）

WINDOW_HELP = (
    "可用的区间规则：\n"
    "  today            今天 00:00 ~ 明天 00:00\n"
    "  yesterday / d1   昨天 00:00 ~ 今天 00:00\n"
    "  dN               第 N 天前那一整天，如 d2=前天、d3=大前天\n"
    "  lastNd           最近 N 个整天，如 last7d=今天往前 7 天\n"
    "  lastNh           最近 N 小时（向上取整到整点），如 last2h、last24h"
)

# 前端下拉用：值 → 说明
WINDOW_CHOICES: list[tuple[str, str]] = [
    ("yesterday", "昨天 00:00 ~ 今天 00:00"),
    ("today", "今天 00:00 ~ 明天 00:00"),
    ("d2", "前天那一天"),
    ("d3", "大前天那一天"),
    ("last3d", "最近 3 个整天"),
    ("last7d", "最近 7 个整天"),
    ("last24h", "最近 24 小时（按整点）"),
    ("last2h", "最近 2 小时（按整点）"),
]


def resolve_window(window: str, now: datetime) -> tuple[datetime, datetime]:
    """把区间规则解析成 [start, end)（左闭右开）。"""
    window = (window or WINDOW_YESTERDAY).strip().lower()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)

    if window == WINDOW_TODAY:
        return today, today + timedelta(days=1)
    if window in (WINDOW_YESTERDAY, "d1"):
        return today - timedelta(days=1), today

    match = _RE_DAY_AGO.match(window)
    if match:
        days = int(match.group(1))
        if days < 1:
            raise ValueError(f"区间规则 {window!r} 无效：N 必须 >= 1\n{WINDOW_HELP}")
        end = today - timedelta(days=days - 1)
        return end - timedelta(days=1), end

    match = _RE_LAST_DAYS.match(window)
    if match:
        days = int(match.group(1))
        if days < 1:
            raise ValueError(f"区间规则 {window!r} 无效：N 必须 >= 1\n{WINDOW_HELP}")
        return today - timedelta(days=days), today

    match = _RE_LAST_HOURS.match(window)
    if match:
        hours = int(match.group(1))
        if hours < 1:
            raise ValueError(f"区间规则 {window!r} 无效：N 必须 >= 1\n{WINDOW_HELP}")
        # 结束点向上取整到下一个整点，保证同一小时内多次运行结果稳定
        end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        return end - timedelta(hours=hours), end

    raise ValueError(f"无法识别的区间规则 {window!r}\n{WINDOW_HELP}")


def valid_window(window: str) -> bool:
    try:
        resolve_window(window, datetime.now())
        return True
    except ValueError:
        return False


@dataclass(frozen=True, order=True)
class Schedule:
    """一个定时执行点。window 为空表示用该分仓配置的区间规则。"""

    hour: int
    minute: int
    window: str = ""

    def __str__(self) -> str:
        base = f"{self.hour:02d}:{self.minute:02d}"
        return f"{base}({self.window})" if self.window else base

    @property
    def text(self) -> str:
        """回写到设置里的文本形式（HH:MM 或 HH:MM:区间规则）。"""
        return str(self)


def parse_schedule(items: list[str] | str) -> list[Schedule]:
    """解析定时点。支持 ["07:30", "19:30:today"]，也支持 "07:30,19:30:today" 逗号串。

    每一项可单独指定区间规则（冒号后），不写则用该分仓的默认区间。
    """
    if isinstance(items, str):
        raw_items = items.split(",")
    else:
        raw_items = list(items or [])
    slots: list[Schedule] = []
    for item in raw_items:
        item = (item or "").strip()
        if not item:
            continue
        parts = item.split(":", 2)
        if len(parts) < 2 or not parts[0].strip().isdigit() or not parts[1].strip().isdigit():
            raise ValueError(f"无法解析定时时间 {item!r}，应为 HH:MM 或 HH:MM:区间规则（如 07:30、19:30:today）")
        hour, minute = int(parts[0]), int(parts[1])
        if not (0 <= hour < 24 and 0 <= minute < 60):
            raise ValueError(f"定时时间超出范围: {item!r}（小时 0-23，分钟 0-59）")
        window = parts[2].strip().lower() if len(parts) > 2 else ""
        if window and not valid_window(window):
            raise ValueError(f"定时时间 {item!r} 里的区间规则无法识别\n{WINDOW_HELP}")
        slots.append(Schedule(hour, minute, window))
    return sorted(set(slots))


DATETIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d")


def parse_datetime(raw: str) -> datetime:
    """解析 2026-09-18 / 2026-09-18 08:00 / 2026-09-18 08:00:00。"""
    for fmt in DATETIME_FORMATS:
        try:
            return datetime.strptime(raw.strip(), fmt)
        except ValueError:
            continue
    raise ValueError(f"无法解析时间 {raw!r}，支持 YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]")


@dataclass
class JstConfig:
    """一次导出所需的全部参数（由「自动出库设置」+ 当前分仓配置组装）。"""

    cookie: str = ""
    account: str = ""
    password: str = ""
    owner_co_id: str = ""
    authorize_co_id: str = ""
    output_dir: Path = Path(".")
    window: str = WINDOW_YESTERDAY
    fixed_range: tuple[datetime, datetime] | None = None
    io_date_field: str = "io_date"
    min_interval: float = 10.0
    timeout: float = 120.0
    max_retries: int = 3
    flag: int = 0
    schedule: list[Schedule] = field(default_factory=list)
    filename_template: str = "销售出库单_{start:%Y%m%d}_{authorize_co_id}.xlsx"
    keep_raw_name: bool = False

    @property
    def can_relogin(self) -> bool:
        return bool(self.account and self.password)

    def resolve_window(self, now: datetime | None = None) -> tuple[datetime, datetime]:
        """按配置的区间规则算出本次要导出的 [start, end)。"""
        return resolve_window(self.window, now or datetime.now())
