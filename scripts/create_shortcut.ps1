param(
    [string]$Hotkey = "CTRL+ALT+M"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Executable = Join-Path $ProjectRoot "dist\MarkdownQuickMemo\MarkdownQuickMemo.exe"
$LauncherExecutable = Join-Path $ProjectRoot "dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe"
$Arguments = ""

if (-not (Test-Path $Executable)) {
    $Executable = Join-Path $ProjectRoot "venv\Scripts\pythonw.exe"
    if (-not (Test-Path $Executable)) {
        throw "venv\Scripts\pythonw.exe was not found. Create the virtual environment first."
    }
    $Arguments = '-m markdown_quick_memo'
}

$LauncherArguments = "--hotkey $Hotkey"
if (-not (Test-Path $LauncherExecutable)) {
    $LauncherExecutable = Join-Path $ProjectRoot "venv\Scripts\pythonw.exe"
    if (-not (Test-Path $LauncherExecutable)) {
        throw "The hotkey launcher executable and venv\Scripts\pythonw.exe were not found."
    }
    $LauncherArguments = "-m markdown_quick_memo.hotkey_launcher --hotkey $Hotkey"
}

$Programs = [Environment]::GetFolderPath("Programs")
$ShortcutPath = Join-Path $Programs "Markdown Quick Memo.lnk"
$Startup = [Environment]::GetFolderPath("Startup")
$LauncherShortcutPath = Join-Path $Startup "Markdown Quick Memo Hotkey.lnk"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "MarkdownQuickMemoHotkey"
$LegacyShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Markdown Quick Memo.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Executable
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.Description = "Markdown Quick Memo"
$Shortcut.Hotkey = ""
$Shortcut.Save()

$RunCommand = '"{0}" {1}' -f $LauncherExecutable, $LauncherArguments
New-Item -Path $RunKeyPath -Force | Out-Null
New-ItemProperty -Path $RunKeyPath -Name $RunValueName -Value $RunCommand -PropertyType String -Force | Out-Null

if (Test-Path -LiteralPath $LauncherShortcutPath) {
    Remove-Item -LiteralPath $LauncherShortcutPath
    Write-Host "Old startup shortcut removed: $LauncherShortcutPath"
}

if (Test-Path -LiteralPath $LegacyShortcutPath) {
    Remove-Item -LiteralPath $LegacyShortcutPath
    Write-Host "Old desktop shortcut removed: $LegacyShortcutPath"
}

Get-Process -Name "MarkdownQuickMemoHotkey" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath $LauncherExecutable -ArgumentList $LauncherArguments -WorkingDirectory $ProjectRoot

Write-Host "Start menu shortcut created: $ShortcutPath"
Write-Host "Logon hotkey launcher registered: $RunKeyPath\$RunValueName"
Write-Host "Native hotkey: $Hotkey"
