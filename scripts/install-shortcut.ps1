<#
  在桌面和开始菜单里创建"MCU 引脚规划器"快捷方式。
  工程目录从脚本自身位置推出来，所以整个工程挪了位置重跑一次就行。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Remove

  注意：这个文件必须存成**带 BOM 的 UTF-8**，理由见 start-pin-planner.ps1 顶部。
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

# WScript.Shell 的 CreateShortcut 走 ANSI 代码页，中文文件名会被写成 "?????"。
# 用 Unicode 的 IShellLinkW；COM 的 QueryInterface 转换必须在 C# 里做，
# PowerShell 的类型转换运算符不会对 __ComObject 发起 QI。
if (-not ('UnicodeShortcut' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class ShellLinkCoClass { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int cch, IntPtr pfd, int flags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
    void GetHotkey(out short k);
    void SetHotkey(short k);
    void GetShowCmd(out int c);
    void SetShowCmd(int c);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int cch, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int reserved);
    void Resolve(IntPtr hwnd, int flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
}

public static class UnicodeShortcut {
    public static void Create(string lnkPath, string target, string arguments,
                              string workingDir, string iconPath, string description, int showCmd) {
        IShellLinkW link = (IShellLinkW)new ShellLinkCoClass();
        link.SetPath(target);
        link.SetArguments(arguments);
        link.SetWorkingDirectory(workingDir);
        link.SetIconLocation(iconPath, 0);
        link.SetDescription(description);
        link.SetShowCmd(showCmd);
        ((IPersistFile)link).Save(lnkPath, true);
        Marshal.ReleaseComObject(link);
    }
}
'@
}

$root     = Split-Path -Parent $PSScriptRoot
$name     = 'MCU 引脚规划器.lnk'
$launcher = Join-Path $PSScriptRoot 'start-pin-planner.ps1'
$icon     = Join-Path $PSScriptRoot 'pin-planner.ico'
$ps51     = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$argLine  = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$launcher`""

$targets = @(
    [Environment]::GetFolderPath('Desktop')
    Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
)

if ($Remove) {
    foreach ($folder in $targets) {
        $lnk = Join-Path $folder $name
        if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Output "removed $lnk" }
    }
    return
}

if (-not (Test-Path -LiteralPath $launcher)) { throw "找不到启动器：$launcher" }
if (-not (Test-Path -LiteralPath $icon))     { throw "找不到图标：$icon" }

foreach ($folder in $targets) {
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    $lnk = Join-Path $folder $name
    [UnicodeShortcut]::Create($lnk, $ps51, $argLine, $root, $icon,
        'MCU 引脚规划器 — 启动本地服务器并在浏览器中打开', 7)
    if (Test-Path -LiteralPath $lnk) { Write-Output "created $lnk" } else { Write-Output "FAILED  $lnk" }
}
