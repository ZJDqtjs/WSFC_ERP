<#
  企业台账系统 - Windows 停止脚本（后端 run.py / 前端 serve.py）

  ==== 为什么"结束不了旧后端" ====
  1) run.py 默认开启 uvicorn 热重载（RELOAD=1）。热重载是"父进程绑定 8000 端口 + 派生一个子进程真正干活"，
     子进程命令行是：python -c "from multiprocessing.spawn import spawn_main; spawn_main(...)" --multiprocessing-fork
     —— 里面既没有 run.py，也没有项目路径。
  2) 用 uv 建的 venv 启动时，实际是两层：
       .venv\Scripts\python.exe run.py            ← uv 的转调壳（launcher）
         └ uv\python\cpython-3.12\python.exe run.py   ← 真正占端口的解释器
              └ python -c "from multiprocessing.spawn ..."  ← 热重载干活子进程
     只匹配"命令行含项目路径且含 run.py"会漏掉热重载子进程；即使杀掉子进程，父进程还会把它拉起来。
  3) 启动方式不同（uv run / dev.py / IDE / 手工 python）命令行形态都不一样，单靠一种匹配必然漏。

  ==== 本脚本的做法（每轮取并集，多轮清杀） ====
  ① 按端口找占用者（最可靠：谁占着 8000/80 就杀谁，不限进程名）
  ② 按命令行找项目进程：run.py / serve.py / dev.py / uvicorn / app.main，以及热重载的 multiprocessing.spawn 子进程
  ③ 递归带上这些进程的子孙进程（/T 进程树）
  ④ 重复 ①②③ 最多 3 轮（防热重载"复活"），再做一轮 Stop-Process 兜底
  ⑤ 最后轮询校验端口确实释放；没释放就把占用 PID 明确报出来，并以退出码 1 结束
     —— deploy.bat 看到 1 会【中止启动】，避免"旧后端占着端口、新后端起不来"的假重启。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\win_stop.ps1 -AppDir D:\code\WSFC_ERP
    powershell ... -File deploy\win_stop.ps1 -AppDir D:\code\WSFC_ERP -Only api    # 只停后端
    powershell ... -File deploy\win_stop.ps1 -AppDir D:\code\WSFC_ERP -Only web    # 只停前端
    powershell ... -File deploy\win_stop.ps1 -AppDir D:\code\WSFC_ERP -DryRun      # 只看，不杀
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
    # 排除"用本项目 venv 起的其它工具"（如预览用 python -m http.server 8899），它们不是 ERP 服务
    if ($cl -like '*http.server*' -or $cl -like '*-m http*') { continue }
    # 后端：run.py / dev.py / uvicorn / app.main，以及热重载派生的 multiprocessing spawn 子进程
    $isApi = ($cl -like '*run.py*') -or ($cl -like '*dev.py*') -or ($cl -like '*uvicorn*') `
      -or ($cl -like '*app.main*') -or ($cl -like '*multiprocessing.spawn*') -or ($cl -like '*spawn_main*')
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

function Stop-Pid([int]$procId, [string]$why, $procMap) {
  $exe = '?'
  if ($procMap.ContainsKey($procId)) { $exe = $procMap[$procId] }
  if ($DryRun) {
    Write-Host ("    [预览] 待结束 PID {0,-7} ({1,-12} {2})" -f $procId, $exe, $why)
  } else {
    Write-Host ("    结束进程  PID {0,-7} ({1,-12} {2})" -f $procId, $exe, $why)
    taskkill /F /T /PID $procId 2>$null | Out-Null
  }
}

# ---------- ④ 多轮清杀（防热重载把子进程重新拉起来） ----------
$killed = 0
for ($round = 1; $round -le 3; $round++) {
  $allProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $procMap = @{}
  foreach ($pr in $allProcs) { $procMap[[int]$pr.ProcessId] = '' + $pr.Name }

  $byPort = @(Get-PortOwnerPids -portList $ports)
  $byCmd = @(Get-ProjectPids -api $wantApi -web $wantWeb)
  $targets = @($byPort + $byCmd | Sort-Object -Unique)

  if (-not $targets.Count) {
    if ($round -eq 1) { Write-Host "    没有发现需要停止的进程（端口本来就是空的）" }
    break
  }

  $expanded = @(Expand-Children -pids $targets -allProcs $allProcs)
  if ($round -gt 1) { Write-Host "    第 $round 轮：仍有进程存活（热重载复活），继续清理" }
  # 先杀"占端口/命中的本体"，再杀子进程，避免父进程把子进程又拉起来
  foreach ($procId in $expanded) {
    $why = '命令行匹配'
    if ($byPort -contains $procId) { $why = '占用端口' }
    elseif (-not ($byCmd -contains $procId)) { $why = '子进程' }
    if ($procMap.ContainsKey($procId) -and $procMap[$procId] -eq 'conhost.exe') { continue }
    Stop-Pid -procId $procId -why $why -procMap $procMap
    $killed++
  }
  if ($DryRun) { break }
  Start-Sleep -Milliseconds 600
}

# ---------- ⑤ 兜底：再强制收一次（taskkill 偶发失败时） ----------
if (-not $DryRun) {
  $left = @()
  for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Milliseconds 300
    $left = @(Get-PortOwnerPids -portList $ports)
    if (-not $left.Count) { break }
  }
  if ($left.Count) {
    Write-Host "    兜底清理：端口仍被 PID $($left -join ', ') 占用，改用 Stop-Process 强杀"
    foreach ($procId in $left) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      $killed++
    }
    Start-Sleep -Milliseconds 500
  }
}

if ($killed -gt 0) {
  if ($DryRun) { Write-Host "    共发现 $killed 个相关进程（预览模式，未实际结束）" }
  else { Write-Host "    共结束 $killed 个进程" }
}

if ($DryRun) {
  $now = @(Get-PortOwnerPids -portList $ports)
  if ($now.Count) { Write-Host "    当前端口占用：$($ports -join ' / ') <- PID $($now -join ', ')" }
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
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $left -contains [int]$_.ProcessId } |
    ForEach-Object { "PID $($_.ProcessId) $($_.Name)" })
  if ($procs) { Write-Host "       $($procs -join '；')" }
  Write-Host "       常见原因：进程属于别的用户/服务，或被杀后立刻被守护进程拉起。"
  Write-Host "       可【以管理员身份】重跑 deploy.bat，或手动结束上面列出的 PID 后重试。"
  exit 1
}

Write-Host "    端口 $($ports -join ' / ') 已全部释放"
exit 0
