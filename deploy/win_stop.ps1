<#
  企业台账系统 - Windows 停止脚本（后端 run.py / 前端 serve.py）

  ==== 旧 deploy.bat 为什么"结束不了旧后端" ====
  1) run.py 默认开启 uvicorn 热重载（RELOAD=1）。热重载是"父进程绑定 8000 端口 + 派生一个子进程真正干活"，
     子进程命令行是：python -c "from multiprocessing.spawn import spawn_main; spawn_main(...)" --multiprocessing-fork
     —— 里面既没有 run.py，也没有项目路径。
  2) 用 `uv run python run.py` 启动时，python 进程命令行里是 uv 自带 Python 的路径
     （...\AppData\Roaming\uv\python\cpython-3.12...\python.exe run.py），**不含项目路径**。
  3) 旧脚本只按「python.exe 且命令行包含项目路径且包含 run.py」匹配 →
     匹配不到 uv 启动的进程，也匹配不到热重载子进程；即使杀掉了子进程，热重载父进程还会把它重新拉起来，
     端口始终被占 → 于是"结束不了旧后端"，多启动几次就攒下一堆孤儿进程抢同一个端口。

  ==== 本脚本的做法（每轮取并集，多轮清杀） ====
  ① 按端口找占用者（最可靠：谁占着 8000/80 就杀谁）
  ② 按命令行找项目进程：run.py / serve.py / uvicorn / app.main，以及热重载的 multiprocessing.spawn 子进程
  ③ 递归带上这些进程的子孙进程（/T 进程树）
  ④ 重复 ①②③ 最多 3 轮（防热重载"复活"），最后轮询校验端口确实释放，没释放就明确报出来

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\win_stop.ps1 -AppDir D:\code\WSFC_ERP
    powershell ... -File deploy\win_stop.ps1 -AppDir D:\code\WSFC_ERP -Only api    # 只停后端
    powershell ... -File deploy\win_stop.ps1 -AppDir D:\code\WSFC_ERP -Only web    # 只停前端
  退出码：0 = 端口已释放；1 = 仍有端口被占（详见输出）
#>
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [ValidateSet('all', 'api', 'web')][string]$Only = 'all',
  [switch]$DryRun   # 只列出"将要结束的进程"与端口占用情况，不真杀（供 status 复用）
)

$ErrorActionPreference = 'SilentlyContinue'

# ---------- 端口（从 config.json 读，读不到用默认值） ----------
$apiPort = 8000
$webPort = 80
$cfgPath = Join-Path $AppDir 'config.json'
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.server.api_port) { $apiPort = [int]$cfg.server.api_port }
    if ($cfg.server.web_port) { $webPort = [int]$cfg.server.web_port }
  } catch { }
}

$wantApi = ($Only -eq 'all') -or ($Only -eq 'api')
$wantWeb = ($Only -eq 'all') -or ($Only -eq 'web')
$ports = @()
if ($wantApi) { $ports += $apiPort }
if ($wantWeb) { $ports += $webPort }
$ports = @($ports | Sort-Object -Unique)

Write-Host "==> 停止服务（模式：$Only，端口：$($ports -join ' / ')）"

# ---------- ① 端口占用者 ----------
function Get-PortOwnerPids([int[]]$portList) {
  $found = @()
  foreach ($p in $portList) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
    if ($conn) { $found += @($conn | Select-Object -ExpandProperty OwningProcess -Unique) }
  }
  if (-not $found) {
    # 兜底：没有 Get-NetTCPConnection（老系统 / 受限环境）时解析 netstat
    $lines = @(netstat -ano -p TCP)
    foreach ($p in $portList) {
      foreach ($l in $lines) {
        $parts = ($l -replace '\s+', ' ').Trim().Split(' ')
        if ($parts.Length -ge 5 -and $parts[1] -like "*:$p" -and $parts[3] -eq 'LISTENING') {
          $found += [int]$parts[4]
        }
      }
    }
  }
  # 0 = 空闲，4 = System（杀不掉也不该杀）
  return @($found | Where-Object { $_ -and $_ -ne 0 -and $_ -ne 4 } | Sort-Object -Unique)
}

# ---------- ② 命令行匹配的项目进程 ----------
function Get-ProjectPids([bool]$api, [bool]$web) {
  $result = @()
  foreach ($pr in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $cl = $pr.CommandLine
    if (-not $cl) { continue }
    $name = '' + $pr.Name
    if (-not (($name -like 'python*') -or ($name -like 'uv*') -or ($name -like 'uvicorn*'))) { continue }
    # 后端：run.py / uvicorn / app.main，以及热重载派生的 multiprocessing spawn 子进程
    $isApi = ($cl -like '*run.py*') -or ($cl -like '*uvicorn*') -or ($cl -like '*app.main*') `
      -or ($cl -like '*multiprocessing.spawn*') -or ($cl -like '*spawn_main*')
    $isWeb = ($cl -like '*serve.py*')
    if ($api -and $isApi) { $result += [int]$pr.ProcessId; continue }
    if ($web -and $isWeb) { $result += [int]$pr.ProcessId }
  }
  return @($result | Sort-Object -Unique)
}

# ---------- ③ 递归带上子孙进程 ----------
function Expand-Children([int[]]$pids, $allProcs) {
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($id in $pids) { [void]$set.Add([int]$id) }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($pr in $allProcs) {
      if ($set.Contains([int]$pr.ParentProcessId) -and -not $set.Contains([int]$pr.ProcessId)) {
        [void]$set.Add([int]$pr.ProcessId)
        $changed = $true
      }
    }
  }
  return @($set)
}

# ---------- ④ 多轮清杀（防热重载把子进程重新拉起来） ----------
$killed = 0
for ($round = 1; $round -le 3; $round++) {
  $allProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byPort = @(Get-PortOwnerPids -portList $ports)
  $byCmd = @(Get-ProjectPids -api $wantApi -web $wantWeb)
  $targets = @($byPort + $byCmd | Sort-Object -Unique)

  if (-not $targets.Count) {
    if ($round -eq 1) { Write-Host "    没有发现需要停止的进程（端口本来就是空的）" }
    break
  }

  $expanded = @(Expand-Children -pids $targets -allProcs $allProcs)
  if ($round -gt 1) { Write-Host "    第 $round 轮：仍有进程存活（热重载复活），继续清理" }
  foreach ($procId in $expanded) {
    $pr = $allProcs | Where-Object { [int]$_.ProcessId -eq $procId } | Select-Object -First 1
    $why = '命令行匹配'
    if ($byPort -contains $procId) { $why = '占用端口' }
    $exe = '?'
    if ($pr) { $exe = '' + $pr.Name }
    if ($DryRun) {
      Write-Host ("    [预览] 待结束 PID {0} ({1}, {2})" -f $procId, $exe, $why)
    } else {
      Write-Host ("    结束进程 PID {0} ({1}, {2})" -f $procId, $exe, $why)
      taskkill /F /T /PID $procId 2>$null | Out-Null
    }
    $killed++
  }
  if ($DryRun) { break }
  Start-Sleep -Milliseconds 600
}

if ($killed -gt 0) {
  if ($DryRun) { Write-Host "    共发现 $killed 个相关进程（预览模式，未实际结束）" }
  else { Write-Host "    共结束 $killed 个进程" }
}

if ($DryRun) {
  $now = @(Get-PortOwnerPids -portList $ports)
  if ($now.Count) { Write-Host "    当前端口占用：$($ports -join ' / ') ← PID $($now -join ', ')" }
  else { Write-Host "    当前端口 $($ports -join ' / ') 未被占用" }
  exit 0
}

# ---------- 校验端口是否真的释放 ----------
$left = @()
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 400
  $left = @(Get-PortOwnerPids -portList $ports)
  if (-not $left.Count) { break }
}

if ($left.Count) {
  Write-Host "[警告] 端口仍未释放：$($ports -join ' / ')（占用 PID：$($left -join ', ')）"
  Write-Host "       若占用者是系统进程(4) 或其它软件，请手动确认；本项目进程一般已清干净。"
  exit 1
}

Write-Host "    端口 $($ports -join ' / ') 已全部释放"
exit 0
