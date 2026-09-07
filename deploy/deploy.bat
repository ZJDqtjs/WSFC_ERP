@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
rem ============================================================
rem  企业台账系统 - Windows 一键部署脚本
rem  参考 deploy/deploy.sh，适配 Windows：
rem    - 后端：backend\.venv 虚拟环境 + run.py（FastAPI）
rem    - 前端：由 serve.py 直接托管 web/static（无 nginx/systemd）
rem  用法：deploy.bat              # 一键部署并启动
rem        deploy.bat stop         # 停止后端与前端
rem        deploy.bat start        # 启动后端与前端
rem        deploy.bat status       # 查看运行状态
rem ============================================================

rem ---- 以脚本所在目录推导项目根目录（deploy 的上一级），不写死 ----
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "APP_DIR=%CD%"
popd
set "BACKEND=%APP_DIR%\backend"
set "PY=%BACKEND%\.venv\Scripts\python.exe"

rem ---- 读取端口（config.json），读取失败则用默认值 ----
set "API_PORT=8000"
set "WEB_PORT=80"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-Content -Raw -LiteralPath '%APP_DIR%\config.json' | ConvertFrom-Json).server.api_port"`) do set "API_PORT=%%p"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-Content -Raw -LiteralPath '%APP_DIR%\config.json' | ConvertFrom-Json).server.web_port"`) do set "WEB_PORT=%%p"
for /f "tokens=* delims= " %%p in ("!API_PORT!") do set "API_PORT=%%p"
for /f "tokens=* delims= " %%p in ("!WEB_PORT!") do set "WEB_PORT=%%p"

rem ==== 命令分发：status 不停服；其余先停旧服务 ====
if /i "%~1"=="status" goto status
call :stop_services
if /i "%~1"=="stop" (
  echo ==^> 已停止后端与前端服务。
  exit /b 0
)

rem ==== 创建虚拟环境并安装依赖 ====
echo ==^> 创建 Python 虚拟环境并安装依赖
if not exist "%PY%" (
  where uv >nul 2>nul
  if !errorlevel!==0 (
    echo   ... 使用 uv 创建 .venv
    pushd "%BACKEND%"
    uv venv --python 3.12 .venv
    popd
  ) else (
    echo   ... 使用 python -m venv 创建 .venv
    pushd "%BACKEND%"
    python -m venv .venv
    popd
  )
)
if not exist "%PY%" (
  echo [错误] 虚拟环境创建失败，请确认已安装 Python 3.12 或 uv。 >&2
  exit /b 1
)
where uv >nul 2>nul
if !errorlevel!==0 (
  echo   ... 使用 uv 安装依赖 requirements.txt
  uv pip install --python "%PY%" -q -r "%BACKEND%\requirements.txt"
) else (
  "%PY%" -m pip --version >nul 2>nul
  if errorlevel 1 "%PY%" -m ensurepip --upgrade >nul 2>nul
  echo   ... 使用 pip 安装依赖 requirements.txt
  "%PY%" -m pip install -q --upgrade pip
  "%PY%" -m pip install -q -r "%BACKEND%\requirements.txt"
)
if errorlevel 1 (
  echo [错误] 依赖安装失败。 >&2
  exit /b 1
)

rem ==== 确保数据目录存在 ====
echo ==^> 确保数据目录存在
if not exist "%BACKEND%\data\uploads" mkdir "%BACKEND%\data\uploads" >nul 2>nul
if not exist "%BACKEND%\data\backups" mkdir "%BACKEND%\data\backups" >nul 2>nul

rem ==== 重新启动 后端 + 前端 ====
echo ==^> 启动后端 API（run.py）
if exist "%PY%" powershell -NoProfile -Command "Start-Process -FilePath '%PY%' -ArgumentList 'run.py' -WorkingDirectory '%BACKEND%' -WindowStyle Hidden"

echo ==^> 启动前端服务（serve.py）
if exist "%PY%" powershell -NoProfile -Command "Start-Process -FilePath '%PY%' -ArgumentList 'serve.py' -WorkingDirectory '%APP_DIR%\web' -WindowStyle Hidden"

rem 等待服务端口就绪（timeout 在非交互/重定向下会报错，改用 ping 实现等待）
ping -n 4 127.0.0.1 >nul

echo.
echo ============================================================
echo   部署完成！
echo   前端页面:  http://localhost:%WEB_PORT%     (serve.py 托管 web/static)
echo   后端 API:  http://127.0.0.1:%API_PORT%     (serve.py 反代 /api)
echo   管理操作:  deploy.bat stop / start / status
echo ============================================================
goto :eof

:stop_services
echo ==^> 停止旧服务（若有）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*%APP_DIR%*' -and ($_.CommandLine -like '*run.py*' -or $_.CommandLine -like '*serve.py*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
goto :eof

:status
echo ==^> 当前服务状态
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -clike '*%APP_DIR%*' } | Select-Object ProcessId, @{n='Cmd';e={if($_.CommandLine -like '*run.py*'){'backend:run.py'}elseif($_.CommandLine -like '*serve.py*'){'frontend:serve.py'}else{'other'}}} | Format-Table -AutoSize"
exit /b 0