#!/usr/bin/env bash
# 企业台账系统 - 服务管理脚本（后端 erp + nginx）
# 部署到服务器后直接运行：bash /home/azureuser/WSFC_ERP/deploy/service.sh {start|stop|restart|status}
set -euo pipefail

SERVICE="erp"
CASE="${1:-status}"
ACTION="${CASE,,}"   # 转小写，兼容 stop / STOP

case "$ACTION" in
  start)
    echo "==> 启动后端服务与 nginx"
    sudo systemctl start "$SERVICE"
    sudo systemctl start nginx 2>/dev/null || true
    ;;
  stop)
    echo "==> 停止后端服务与 nginx"
    sudo systemctl stop nginx 2>/dev/null || true
    sudo systemctl stop "$SERVICE"
    ;;
  restart)
    echo "==> 重启后端服务与 nginx"
    sudo systemctl restart "$SERVICE"
    sudo systemctl restart nginx 2>/dev/null || true
    ;;
  status)
    echo "==> 服务状态"
    systemctl --no-pager --full status "$SERVICE" nginx 2>/dev/null | head -n 40 || true
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac

# status/restart/start/stop 后都给出简要确认，restart 额外等待启动完成
if [ "$ACTION" != "status" ]; then
  sleep 1
  echo ""
  echo "---- $ACTION 完成，当前状态 ----"
  systemctl --no-pager --full is-active "$SERVICE" | xargs echo "后端 erp      :"
  systemctl --no-pager --full is-active nginx     | xargs echo "nginx         :"
fi