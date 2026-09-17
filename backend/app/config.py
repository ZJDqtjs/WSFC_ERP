"""集中式配置加载：默认配置 + 本机私有配置。

配置来源与优先级（后者覆盖前者）：

1. ``<仓库根>/product_rules.json`` —— 入库的默认配置，**不放任何密钥/真实口令**
2. ``<仓库根>/config.local.json``  —— 本机私有配置，已被 .gitignore 忽略，只写需要覆盖的字段
3. 环境变量                        —— 见 ``_ENV_OVERRIDES``，便于 systemd / 容器注入

合并规则：深合并（dict 递归合并），列表与标量整体覆盖。
例如 ``config.local.json`` 里只写 ``{"llm": {"api_key": "xxx"}}``，其余 llm 字段仍沿用默认值。

用法::

    from app.config import load_rules, llm_config, seed_accounts

    cfg = load_rules()        # 合并后的完整配置
    llm = llm_config()        # llm 段（enabled=false 时返回 {}）
    users = seed_accounts()   # 种子账号列表
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
RULES_FILE = REPO_ROOT / "product_rules.json"
LOCAL_FILE = REPO_ROOT / "config.local.json"

# 环境变量覆盖：{环境变量名: 配置中的点分路径}
_ENV_OVERRIDES: dict[str, tuple[str, ...]] = {
    "ERP_LLM_API_KEY": ("llm", "api_key"),
    "ERP_LLM_BASE_URL": ("llm", "base_url"),
    "ERP_LLM_MODEL": ("llm", "model"),
}


def _read_json(path: Path) -> dict:
    """读 JSON；文件不存在或格式错误时返回空 dict，避免拖垮启动。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _apply_env(cfg: dict) -> dict:
    for env_name, path in _ENV_OVERRIDES.items():
        value = os.getenv(env_name)
        if not value:
            continue
        node: Any = cfg
        for key in path[:-1]:
            child = node.get(key)
            if not isinstance(child, dict):
                child = {}
                node[key] = child
            node = child
        node[path[-1]] = value
    return cfg


def load_rules() -> dict:
    """默认配置 + 本机私有配置 + 环境变量，合并后的完整配置（每次调用重新读取）。"""
    return _apply_env(_deep_merge(_read_json(RULES_FILE), _read_json(LOCAL_FILE)))


def llm_config() -> dict:
    """``llm`` 段配置；``enabled`` 显式为 false 或缺失时返回空 dict。

    这里不校验 api_key：调用方需自行判断 ``not cfg.get("api_key")`` 并给出提示。
    """
    cfg = load_rules().get("llm") or {}
    if not isinstance(cfg, dict) or not cfg.get("enabled", True):
        return {}
    return cfg


def seed_accounts() -> list[dict]:
    """``accounts`` 段：建库/启动时同步的种子账号（用户名 / 口令 / 姓名 / 角色）。

    口令以配置为准，每次启动 ``ensure_seed_users`` 都会校验收口，因此改
    ``config.local.json`` 里的口令即可完成管理员改密。配置为空时不内置任何默认账号。
    """
    accounts = load_rules().get("accounts") or []
    result: list[dict] = []
    for acc in accounts:
        if not isinstance(acc, dict):
            continue
        username = str(acc.get("username", "")).strip()
        if not username:
            continue
        result.append({
            "username": username,
            "password": str(acc.get("password", "")),
            "name": str(acc.get("name", "")).strip(),
            "role": str(acc.get("role", "user")).strip() or "user",
        })
    return result
