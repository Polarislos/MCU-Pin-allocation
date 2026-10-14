<#
  引脚规划器启动器。桌面快捷方式指向这个脚本。

  为什么必须起服务器：页面用了 ES 模块和 type=module 的 Web Worker，
  从 file:// 直接打开会被浏览器的 CORS 规则挡住，只能走 http://。

  行为：
  - 服务器已经在跑  → 直接开浏览器，不重复启动
  - 没跑            → 起一个最小化的服务器窗口，轮询到能响应了再开浏览器
  - 缺 node_modules → 先装依赖

  注意：这个文件必须存成 **带 BOM 的 UTF-8**。快捷方式调的是 powershell.exe
  (5.1)，它把无 BOM 的文件按 ANSI 代码页读，中文会变成乱码字节并直接把语法
  拆坏（报 "Missing ')' in method call"）。cmd 窗口标题保持纯 ASCII，
  避免控制台代码页再糊一次。
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 4173
$url  = "http://127.0.0.1:$port/"

function Show-Problem($text) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($text, 'MCU 引脚规划器', 'OK', 'Error') | Out-Null
}

function Test-Serving {
    try {
        $instance = Invoke-RestMethod -Uri ($url + 'api/planner-instance') -TimeoutSec 2
        $instance.app -eq 'MCU-Planner' -and [IO.Path]::GetFullPath($instance.root).TrimEnd('\','/') -eq [IO.Path]::GetFullPath($root).TrimEnd('\','/')
    } catch { $false }
}

if (-not (Test-Path (Join-Path $root 'package.json'))) {
    Show-Problem "找不到工程：$root`n`n是不是把快捷方式的目标移动过了？"
    exit 1
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Show-Problem "PATH 里找不到 npm。请先安装 Node.js：https://nodejs.org/"
    exit 1
}

# 端口已被占用但不是我们的服务器时，下面的轮询会一直失败，最后弹窗提示，
# 不会把用户带到别人的页面上去。
$alreadyUp = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

if (-not $alreadyUp) {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        Start-Process -FilePath 'cmd.exe' `
            -ArgumentList '/c', 'title Installing dependencies - MCU Pin Planner && npm.cmd install' `
            -WorkingDirectory $root -Wait
    }

    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', 'title MCU Pin Planner server - close this window to stop && npm.cmd run dev -- --host 127.0.0.1 --port 4173 --strictPort' `
        -WorkingDirectory $root -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        if (Test-Serving) { break }
        Start-Sleep -Milliseconds 400
    }
}

if (-not (Test-Serving)) {
    Show-Problem "最新版服务器没能在 $url 上响应，或该端口正在运行其他目录的旧版本。`n`n端口 $port 可能被别的程序占用了，或者依赖没装好。`n请在工程目录里手动跑一次 npm run dev 看报什么错。"
    exit 1
}

Start-Process $url
