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
cd "$APP_DIR/backend"
if command -v uv >/dev/null 2>&1; then
  # 关键：以 root 跑本脚本时，uv 默认把 Python 装到 /root/.local/share/uv，
  # 导致运行用户（APP_USER）无权执行解释器 => systemd 203/EXEC。
  # 强制装到应用目录内，使其对运行用户可访问。
  export UV_PYTHON_INSTALL_DIR="$APP_DIR/.uv-python"
  VENV_PY="$PWD/.venv/bin/python"
  if [ ! -x "$VENV_PY" ] || ! printf '%s' "$(readlink -f "$VENV_PY" 2>/dev/null)" | grep -q "$APP_DIR"; then
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
sudo mkdir -p "$APP_DIR/backend/data/uploads" "$APP_DIR/backend/data/backups"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> [5/7] 同步前端静态到 /var/www/erp（nginx 可读，家目录默认 www-data 不可穿越）"
sudo mkdir -p /var/www/erp
sudo rm -rf /var/www/erp/*
sudo cp -r "$APP_DIR/web/static/." /var/www/erp/
sudo cp "$APP_DIR/config.json" /var/www/erp/config.json
# 给桌面端 index.html 里的 app.js / style.css 追加部署时间戳（?v=...）：
# 这样每次部署浏览器都会重新取这两个文件，即使某台机器此前把它们按「启发式缓存」长期缓存了，
# 也会因为 URL 变化立刻拿到新版本，根治「新 index.html + 旧 app.js」导致的 is not defined / 点击没反应。
# 只改 /var/www/erp 下的副本，仓库里的 index.html 保持干净。
STAMP="$(date +%Y%m%d%H%M%S)"
sudo sed -i -E \
  -e 's#(src="/app\.js)(\?v=[^"]*)?(")#\1?v='"$STAMP"'\3#' \
  -e 's#(href="/style\.css)(\?v=[^"]*)?(")#\1?v='"$STAMP"'\3#' \
  /var/www/erp/index.html
if [ ! -f "$APP_DIR/mobile/dist/index.html" ]; then
  echo "错误：找不到移动端生产构建 mobile/dist，请先在本地执行 npm --prefix mobile run build 并上传 mobile/dist" >&2
  exit 1
fi
sudo mkdir -p /var/www/erp/mobile
sudo cp -r "$APP_DIR/mobile/dist/." /var/www/erp/mobile/
sudo chown -R www-data:www-data /var/www/erp

echo "==> [6/7] 安装 nginx 站点配置（监听 80）"
API_ROUTE=$(python3 -c 'import json; print(json.load(open("'$APP_DIR'/config.json"))["routes"]["api"].rstrip("/"))')
UPLOAD_ROUTE=$(python3 -c 'import json; print(json.load(open("'$APP_DIR'/config.json"))["routes"]["uploads"].rstrip("/"))')
MOBILE_ROUTE=$(python3 -c 'import json; print(json.load(open("'$APP_DIR'/config.json"))["routes"]["mobile"].rstrip("/"))')
API_HOST=$(python3 -c 'import json; print(json.load(open("'$APP_DIR'/config.json"))["server"]["api_host"])')
API_PORT=$(python3 -c 'import json; print(json.load(open("'$APP_DIR'/config.json"))["server"]["api_port"])')
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
