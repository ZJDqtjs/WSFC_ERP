# 企业台账系统 - Windows 端一键部署到 Linux（nginx 反向代理到 80 端口）
# 用法（在项目根目录 PowerShell）:
#   powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
# 或带参数:  deploy\deploy.ps1 -Key E:\other.pem -Srv 1.2.3.4 -User ubuntu
param(
  [string]$Key = "E:/ZJDqtjs_key..pem",
  [string]$Srv = "20.24.210.119",
  [string]$User = "azureuser"
)
$ErrorActionPreference = "Stop"

$Remote   = "$User@$Srv"
$Root     = Split-Path -Parent $PSScriptRoot
$Tgz      = Join-Path $Root "_deploy.tgz"
$Stage    = Join-Path $Root "_deploy_stage"
$SSHOpts  = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new")
Push-Location $Root

function Invoke-SSH([string]$Cmd) {
  & ssh @SSHOpts $Remote $Cmd
  if ($LASTEXITCODE -ne 0) { throw "ssh 远程命令失败：$Cmd" }
}

try {
  Write-Host "==> [0] 用 SQLite 备份接口制作一致的 data/erp.db（后端运行中也可读）"
  Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path "$Stage\data" -Force | Out-Null
  & uv run python -c "import sqlite3; s=sqlite3.connect('data/erp.db'); d=sqlite3.connect(r'$Stage\data\erp.db'); s.backup(d); d.close(); s.close()"
  if ($LASTEXITCODE -ne 0) { throw "数据库备份失败" }

  Write-Host "==> [1] 组装部署目录（代码 + 配置 + 数据，排除 .venv/缓存/备份）"
  foreach ($dir in @("app", "static", "json", "deploy")) {
    Copy-Item $dir -Destination $Stage -Recurse
  }
  Copy-Item product_rules.json, requirements.txt, pyproject.toml -Destination $Stage
  Copy-Item data\.secret, data\backup_config.json -Destination "$Stage\data" -ErrorAction SilentlyContinue
  if (Test-Path data\uploads) { Copy-Item data\uploads -Destination "$Stage\data" -Recurse }
  # 清理打包进来的无关文件
  Get-ChildItem $Stage -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem $Stage -Recurse -File -Include "*.pyc" | Remove-Item -Force -ErrorAction SilentlyContinue

  Write-Host "==> [2] 打包上传包"
  & tar -czf $Tgz -C $Stage .
  if ($LASTEXITCODE -ne 0) { throw "本地打包失败" }

  Write-Host "==> [3] 停止服务器旧服务并准备目录"
  Invoke-SSH "sudo systemctl stop erp 2>/dev/null; sudo mkdir -p /opt/erp; sudo chown -R $User:$User /opt/erp"

  Write-Host "==> [4] 上传到 $Remote"
  & scp @SSHOpts $Tgz "${Remote}:/tmp/erp_deploy.tgz"
  if ($LASTEXITCODE -ne 0) { throw "scp 上传失败，请检查密钥与网络" }

  Write-Host "==> [5] 解压到 /opt/erp"
  Invoke-SSH "sudo tar -xzf /tmp/erp_deploy.tgz -C /opt/erp && sudo chown -R $User:$User /opt/erp && rm -f /tmp/erp_deploy.tgz"

  Write-Host "==> [6] 执行服务器端部署脚本（装依赖 / nginx / systemd）"
  Invoke-SSH "bash /opt/erp/deploy/deploy.sh $User"

  Write-Host ""
  Write-Host "======================================================"
  Write-Host "  部署完成！浏览器访问:  http://$Srv/"
  Write-Host "======================================================"
}
finally {
  Pop-Location
  if (Test-Path $Tgz) { Remove-Item $Tgz -Force }
  if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
}
