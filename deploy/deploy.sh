#!/usr/bin/env bash
# 企业台账系统 - 服务器端一键部署脚本
# 前置：代码已同步到 /opt/erp（含 deploy/ 目录），以 azureuser 运行本脚本
# 用法：bash /opt/erp/deploy/deploy.sh
set -euo pipefail

APP_DIR="/opt/erp"
SERVICE="erp"
APP_USER="${1:-azureuser}"

echo "==> [1/6] 停止旧服务（若有）"
sudo systemctl stop "$SERVICE" 2>/dev/null || true

echo "==> [2/6] 检查依赖（python3-venv / nginx）"
if ! command -v nginx >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y nginx python3-venv
fi
if ! command -v python3 >/dev/null 2>&1; then
  sudo apt-get install -y python3
fi

echo "==> [3/6] 创建 Python 虚拟环境并安装依赖"
cd "$APP_DIR"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

echo "==> [4/6] 修正目录权限"
sudo mkdir -p "$APP_DIR/data/uploads" "$APP_DIR/data/backups"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo chmod -R o+rX "$APP_DIR"

echo "==> [5/6] 安装 nginx 站点配置（监听 80）"
sudo cp "$APP_DIR/deploy/nginx.conf" "/etc/nginx/sites-available/$SERVICE"
sudo ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx || sudo systemctl restart nginx

echo "==> [6/6] 安装并启动 systemd 服务"
sudo cp "$APP_DIR/deploy/erp.service" "/etc/systemd/system/$SERVICE.service"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
sudo systemctl restart "$SERVICE"

echo ""
echo "=================================================================="
echo "  部署完成！"
echo "  访问地址:  http://<服务器IP>/            (nginx 80 -> 静态前端)"
echo "  后端 API:  http://127.0.0.1:8000          (仅本机，由 nginx 反代)"
echo "=================================================================="
sleep 1
systemctl --no-pager --full status "$SERVICE" | head -n 12 || true
