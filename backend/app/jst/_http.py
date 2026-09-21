"""HTTP 客户端库兼容层。

本 ERP 环境的 openai 依赖的是 **httpx2**（backend/uv.lock 里就是 httpx2，没有 httpx），
而移植来源的独立项目 AutoExp_ERP321 用的是 **httpx**。两者 API 完全一致
（Client / Response / HTTPError / cookies…），这里统一成 httpx 这一个名字，
免得 client/login/exporter 里到处写兼容判断。
"""

from __future__ import annotations

try:  # 常规环境
    import httpx  # type: ignore
except ImportError:  # pragma: no cover - 本环境走这一支（openai 拉的是 httpx2）
    import httpx2 as httpx  # type: ignore

__all__ = ["httpx"]
