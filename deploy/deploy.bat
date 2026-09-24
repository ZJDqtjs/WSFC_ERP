@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  WSFC ERP - Windows deploy / stop / start / status
rem    deploy.bat            full deploy (stop all + install deps + start all)
rem    deploy.bat api        restart BACKEND only (frontend keeps running)
rem    deploy.bat start      stop all + start all (no dependency install)
rem    deploy.bat stop       stop backend + frontend
rem    deploy.bat status     show related processes and port owners
rem
rem  Notes:
rem   * stop logic lives in deploy\win_stop.ps1 - it kills by PORT OWNER +
rem     command line + whole process tree, several rounds, because:
rem       - uvicorn reload spawns children (python -c "...spawn_main...")
rem         that carry no project path in their command line;
rem       - a uv venv python.exe is a launcher that re-execs the real
rem         interpreter, so ONE backend normally shows 3 python processes
rem         (launcher + interpreter + reload worker) - that is NOT a leak;
rem       - the frontend serve.py shows 2 of them.
rem   * win_stop.ps1 exits 1 when the ports are still occupied; this script
rem     then ABORTS the start step on purpose. Otherwise the old backend
rem     keeps the port, the new one fails to bind, and you end up with
rem     "old backend still running + new backend dead".
rem   * keep this file ASCII-only: Chinese text mixed with "chcp 65001"
rem     makes cmd mis-parse the file on some systems.
rem   * labels use a single colon: ":label". "::label" is a comment in cmd.
rem   * avoid nested "if ( ... )" blocks containing '^' escapes: cmd's
rem     parser miscounts the parentheses and runs the block body anyway.
rem     Error paths below use "goto" for that reason.
rem ============================================================

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "APP_DIR=%CD%"
popd
set "BACKEND=%APP_DIR%\backend"
set "PY=%BACKEND%\.venv\Scripts\python.exe"
set "WIN_STOP=%APP_DIR%\deploy\win_stop.ps1"
set "LOG_DIR=%BACKEND%\data\logs"

rem ---- ports from config.json (fallback to defaults) ----
set "API_PORT=8000"
set "WEB_PORT=80"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-Content -Raw -LiteralPath '%APP_DIR%\config.json' | ConvertFrom-Json).server.api_port"`) do set "API_PORT=%%p"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-Content -Raw -LiteralPath '%APP_DIR%\config.json' | ConvertFrom-Json).server.web_port"`) do set "WEB_PORT=%%p"
for /f "tokens=* delims= " %%p in ("!API_PORT!") do set "API_PORT=%%p"
for /f "tokens=* delims= " %%p in ("!WEB_PORT!") do set "WEB_PORT=%%p"

rem ---- dispatch ----
if /i "%~1"=="status" goto do_status
if /i "%~1"=="stop" goto do_stop
if /i "%~1"=="api" goto do_api
if /i "%~1"=="start" goto do_start
call :stop_services all
if errorlevel 1 exit /b 1
call :ensure_venv
if errorlevel 1 exit /b 1
call :start_services all
goto :eof

:do_stop
call :stop_services all
if errorlevel 1 goto stop_not_clean
echo Done: services stopped.
goto :eof

:do_start
call :stop_services all
if errorlevel 1 exit /b 1
call :start_services all
goto :eof

:do_api
call :stop_services api
if errorlevel 1 exit /b 1
call :ensure_venv
if errorlevel 1 exit /b 1
call :start_services api
goto :eof

:do_status
call :show_status
goto :eof

:stop_not_clean
echo Done: stop attempted, but some ports are STILL occupied - see PIDs above.
exit /b 1

rem ==================== subroutines ====================
rem  call :stop_services all|api     call :start_services all|api

:stop_services
set "ONLY=%~1"
if "%ONLY%"=="" set "ONLY=all"
echo ==^> Stopping old services (mode: %ONLY%) ...
if not exist "%WIN_STOP%" goto stop_services_fallback
powershell -NoProfile -ExecutionPolicy Bypass -File "%WIN_STOP%" -AppDir "%APP_DIR%" -Only %ONLY%
if errorlevel 1 goto stop_services_failed
goto :eof

:stop_services_fallback
echo   ... deploy\win_stop.ps1 not found, using fallback matcher
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*run.py*' -or $_.CommandLine -like '*serve.py*' -or $_.CommandLine -like '*multiprocessing.spawn*') } | ForEach-Object { taskkill /F /T /PID $_.ProcessId }" >nul 2>nul
goto :eof

:stop_services_failed
echo.
echo [ERROR] Ports are still occupied after stopping - START ABORTED on purpose.
echo         Starting now would leave the OLD backend on the port and the NEW
echo         one dead, so nothing was started.
echo         How to fix:
echo           1. run deploy.bat as Administrator, or
echo           2. end the PIDs listed above in Task Manager, then re-run
echo              deploy.bat %ONLY%
exit /b 1

:show_status
echo ==^> Service status
if not exist "%WIN_STOP%" goto show_status_fallback
powershell -NoProfile -ExecutionPolicy Bypass -File "%WIN_STOP%" -AppDir "%APP_DIR%" -Only all -DryRun
echo.
echo   Legend: one backend = launcher + interpreter + reload worker, which is
echo           normal; one frontend = launcher + interpreter. Processes such as
echo           "python -m http.server" are NOT part of this project and are
echo           never killed by this script.
goto :eof

:show_status_fallback
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*run.py*' -or $_.CommandLine -like '*serve.py*') } | Select-Object ProcessId, Name | Format-Table -AutoSize"
goto :eof

:ensure_venv
if not exist "%PY%" (
  echo ==^> Creating virtualenv and installing dependencies
  where uv >nul 2>nul
  if !errorlevel!==0 (
    echo   ... uv venv .venv
    pushd "%BACKEND%"
    uv venv --python 3.12 .venv
    popd
  ) else (
    echo   ... python -m venv .venv
    pushd "%BACKEND%"
    python -m venv .venv
    popd
  )
)
if not exist "%PY%" (
  echo [ERROR] Failed to create virtualenv, install Python 3.12 or uv first.
  exit /b 1
)
where uv >nul 2>nul
if !errorlevel!==0 (
  echo   ... uv pip install -r requirements.txt
  uv pip install --python "%PY%" -q -r "%BACKEND%\requirements.txt"
) else (
  "%PY%" -m pip --version >nul 2>nul
  if errorlevel 1 "%PY%" -m ensurepip --upgrade >nul 2>nul
  echo   ... pip install -r requirements.txt
  "%PY%" -m pip install -q --upgrade pip
  "%PY%" -m pip install -q -r "%BACKEND%\requirements.txt"
)
if errorlevel 1 (
  echo [ERROR] Dependency install failed.
  exit /b 1
)
goto :eof

:start_services
set "ONLY=%~1"
if "%ONLY%"=="" set "ONLY=all"
if not exist "%BACKEND%\data\uploads" mkdir "%BACKEND%\data\uploads" >nul 2>nul
if not exist "%BACKEND%\data\backups" mkdir "%BACKEND%\data\backups" >nul 2>nul
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
if not exist "%PY%" goto start_services_no_python

echo ==^> Starting backend (run.py)
echo     logs: %LOG_DIR%\api.out.log / api.err.log
powershell -NoProfile -Command "Start-Process -FilePath '%PY%' -ArgumentList 'run.py' -WorkingDirectory '%BACKEND%' -WindowStyle Hidden -RedirectStandardOutput '%LOG_DIR%\api.out.log' -RedirectStandardError '%LOG_DIR%\api.err.log'"

if /i "%ONLY%"=="api" goto start_services_wait
echo ==^> Starting frontend (serve.py)
powershell -NoProfile -Command "Start-Process -FilePath '%PY%' -ArgumentList 'serve.py' -WorkingDirectory '%APP_DIR%\web' -WindowStyle Hidden -RedirectStandardOutput '%LOG_DIR%\web.out.log' -RedirectStandardError '%LOG_DIR%\web.err.log'"

:start_services_wait
echo ==^> Waiting for backend on port %API_PORT% ...
set "API_UP=0"
for /l %%i in (1,1,20) do (
  if "!API_UP!"=="0" (
    netstat -ano -p TCP | findstr /c:":%API_PORT% " | findstr /c:"LISTENING" >nul 2>nul
    if !errorlevel!==0 (
      set "API_UP=1"
    ) else (
      ping -n 2 127.0.0.1 >nul
    )
  )
)
set "API_PID="
if not "!API_UP!"=="1" goto start_services_not_up
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort %API_PORT% -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do set "API_PID=%%p"
echo     Backend is listening on :%API_PORT%  -  PID !API_PID!
goto start_services_done

:start_services_not_up
echo [WARN] Backend did not listen on %API_PORT% within 20s, see %LOG_DIR%\api.err.log
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort %API_PORT% -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do echo [WARN] Port %API_PORT% is held by PID %%p - run deploy.bat stop, then retry.

:start_services_done
echo.
echo ============================================================
echo   Done. (mode: %ONLY%)
echo   Web UI  : http://localhost:%WEB_PORT%     (serve.py serves web/static)
echo   API     : http://127.0.0.1:%API_PORT%     (/api proxied by serve.py)
echo   Control : deploy.bat [stop^|start^|api^|status]
echo ============================================================
goto :eof

:start_services_no_python
echo [ERROR] Missing python: %PY%
exit /b 1
