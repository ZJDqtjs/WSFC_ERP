#!/usr/bin/env bash
# 企业台账系统 - 服务器端一键部署脚本
# 前置：代码已同步到 /home/azureuser/WSFC_ERP（含 deploy/ 目录），以 azureuser 运行本脚本
# 用法：bash /home/azureuser/WSFC_ERP/deploy/deploy.sh
set -euo pipefail

APP_DIR="/home/azureuser/WSFC_ERP"
SERVICE="erp"
APP_USER="${1:-azureuser}"

echo "==> [1/7] 停止旧服务（若有）"
sudo systemctl stop "$SERVICE" 2>/dev/null || true

echo "==> [2/7] 检查依赖（python3-venv / nginx）"
if ! command -v nginx >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y nginx python3-venv
fi
if ! command -v python3 >/dev/null 2>&1; then
  sudo apt-get install -y python3
fi

echo "==> [3/7] 创建 Python 虚拟环境并安装依赖"
cd "$APP_DIR"
if command -v uv >/dev/null 2>&1; then
  if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c 'import sys; raise SystemExit(sys.version_info < (3, 12))'; then
    rm -rf .venv
    uv venv --python 3.12 .venv
  fi
  uv pip install --python .venv/bin/python -r requirements.txt -q
else
  if [ ! -d .venv ]; then
    python3 -m venv .venv
  fi
  .venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 || true
  .venv/bin/python -m pip install --upgrade pip -q
  .venv/bin/python -m pip install -r requirements.txt -q
fi

echo "==> [4/7] 修正目录权限"
sudo mkdir -p "$APP_DIR/data/uploads" "$APP_DIR/data/backups"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> [5/7] 同步前端静态到 /var/www/erp（nginx 可读，家目录默认 www-data 不可穿越）"
sudo mkdir -p /var/www/erp
sudo rm -rf /var/www/erp/*
sudo cp -r "$APP_DIR/static/." /var/www/erp/
sudo cp "$APP_DIR/config.json" /var/www/erp/config.json
sudo cp -r "$APP_DIR/mobile/." /var/www/erp/mobile/
sudo chown -R www-data:www-data /var/www/erp

echo "==> [6/7] 安装 nginx 站点配置（监听 80）"
API_ROUTE=$(python3 -c 'import json; print(json.load(open("config.json"))["routes"]["api"].rstrip("/"))')
UPLOAD_ROUTE=$(python3 -c 'import json; print(json.load(open("config.json"))["routes"]["uploads"].rstrip("/"))')
MOBILE_ROUTE=$(python3 -c 'import json; print(json.load(open("config.json"))["routes"]["mobile"].rstrip("/"))')
API_HOST=$(python3 -c 'import json; print(json.load(open("config.json"))["server"]["api_host"])')
API_PORT=$(python3 -c 'import json; print(json.load(open("config.json"))["server"]["api_port"])')
sed -e "s|__API_ROUTE__|$API_ROUTE|g" -e "s|__UPLOAD_ROUTE__|$UPLOAD_ROUTE|g" -e "s|__MOBILE_ROUTE__|$MOBILE_ROUTE|g" \
  "$APP_DIR/deploy/nginx.conf" | sudo tee "/etc/nginx/sites-available/$SERVICE" >/dev/null
sudo ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx || sudo systemctl restart nginx

echo "==> [7/7] 安装并启动 systemd 服务"
sed -e "s|__API_HOST__|$API_HOST|g" -e "s|__API_PORT__|$API_PORT|g" \
  "$APP_DIR/deploy/erp.service" | sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null
# 兼容此前手工启动或旧部署遗留的进程，避免占用 systemd 要使用的端口。
sudo fuser -k "$API_PORT/tcp" 2>/dev/null || true
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
