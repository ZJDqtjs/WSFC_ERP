"""维护状态公开接口（前端轮询用，必须免登录）。

前端行为：
- ``mode == announce``    → 顶部滚动公告 + 倒计时，到点自动切维护页
- ``mode == maintenance`` → 整屏维护页，直到主服务恢复（本接口恢复 off）
- 本接口请求失败（主服务已停）→ 前端同样展示维护页并持续重试

维护状态本身由私钥管理后台（keyadmin）写入 data/maintenance.json，本服务只读。
"""
from fastapi import APIRouter

from ..maintenance import public_status

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


@router.get("/status")
def maintenance_status():
    """当前维护状态（免登录：服务维护时用户还没法登录，必须先看到提示）。"""
    return public_status()
