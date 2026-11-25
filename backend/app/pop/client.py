"""jdfenxi 挂载服务的「POP 店订单」只读客户端。

接口（与 ERP 广告利润模块打的是同一个挂载服务，默认 127.0.0.1:18011）：
    GET /api/pop/orders?start&end&start_time&end_time&account&status&keyword
    GET /api/pop/orders/status

约定（与 adprofit 一致）：只读缓存，**不**调用 /api/pop/orders/run 触发浏览器抓取；
任何异常都降级成 {"ok": False, "error": "..."}，绝不把异常抛给定时线程或接口。
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request

DEFAULT_URL = os.getenv("ERP_AD_SERVICE_URL", "http://127.0.0.1:18011").rstrip("/")
TIMEOUT = float(os.getenv("ERP_POP_TIMEOUT", "20"))


def service_url(override: str = "") -> str:
    """本次使用的挂载服务地址：设置里填了就用它，否则用环境变量/默认值。"""
    return (override or DEFAULT_URL).rstrip("/")


def _get(path: str, url: str = "") -> dict:
    req = urllib.request.Request(
        service_url(url) + path,
        headers={"Accept": "application/json", "User-Agent": "WSFC-ERP"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310 - 固定内网地址
        return json.loads(resp.read().decode("utf-8"))


def fetch_orders(
    start: str,
    end: str,
    *,
    start_time: str = "00:00:00",
    end_time: str = "23:59:59",
    account: str = "",
    status: str = "",
    keyword: str = "",
    url: str = "",
) -> dict:
    """拉一个区间的订单（含明细行）。start/end 为 YYYY-MM-DD。

    返回 jdfenxi 原始报文：ok / rows[{orderId, orderTime, day, status, statusCode,
    amount, orderSum, items[{skuId, name, num, jdPrice, supplyPrice}], ...}] / cachedDays / missingDays。
    """
    qs = urllib.parse.urlencode({
        "start": start, "end": end,
        "start_time": start_time, "end_time": end_time,
        "account": account, "status": status, "keyword": keyword,
    })
    try:
        data = _get("/api/pop/orders?" + qs, url)
    except Exception as exc:  # noqa: BLE001 - 挂载服务没起/隧道断，降级即可
        return {"ok": False, "error": f"读取 jdfenxi POP 订单失败：{type(exc).__name__}: {exc}", "rows": []}
    if not isinstance(data, dict):
        return {"ok": False, "error": "jdfenxi 返回格式异常（不是 JSON 对象）", "rows": []}
    return data


def fetch_status(url: str = "") -> dict:
    """抓取任务状态（只看它在不在跑，用来避免定时导入和抓取撞车）。"""
    try:
        return _get("/api/pop/orders/status", url)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "running": False}
