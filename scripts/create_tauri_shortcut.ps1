param(
    [string]$Hotkey = "CTRL+ALT+M"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Executable = Join-Path $ProjectRoot "dist\MarkdownQuickMemo\MarkdownQuickMemo.exe"
$LauncherExecutable = Join-Path $ProjectRoot "dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe"
$HotkeyConfig = Join-Path $env:LOCALAPPDATA "com.markdownquickmemo.app\hotkey.txt"
$Programs = [Environment]::GetFolderPath("Programs")
$ShortcutPath = Join-Path $Programs "Markdown Quick Memo.lnk"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$NewRunValueName = "MarkdownQuickMemoLauncher"
$LegacyRunValueNames = @("MarkdownQuickMemo", "MarkdownQuickMemoHotkey")
$ScheduledTaskName = "Markdown Quick Memo Hotkey"

if (-not (Test-Path -LiteralPath $Executable)) {
    throw "Tauri executable was not found: $Executable"
}
if (-not (Test-Path -LiteralPath $LauncherExecutable)) {
    throw "Rust hotkey launcher was not found: $LauncherExecutable"
}

$HotkeyDirectory = Split-Path -Parent $HotkeyConfig
New-Item -ItemType Directory -Path $HotkeyDirectory -Force | Out-Null
[System.IO.File]::WriteAllText(
    $HotkeyConfig,
    $Hotkey,
    [System.Text.UTF8Encoding]::new($false)
)

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Executable
$Shortcut.Arguments = ""
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.Description = "Markdown Quick Memo"
$Shortcut.IconLocation = "$Executable,0"
$Shortcut.Hotkey = ""
$Shortcut.Save()

$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$TaskAction = New-ScheduledTaskAction `
    -Execute $LauncherExecutable `
    -WorkingDirectory $ProjectRoot
$TaskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$TaskPrincipal = New-ScheduledTaskPrincipal `
    -UserId $CurrentUser `
    -LogonType Interactive `
    -RunLevel Limited
$TaskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -Priority 4 `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$UsesScheduledTask = $false
try {
    Register-ScheduledTask `
        -TaskName $ScheduledTaskName `
        -Action $TaskAction `
        -Trigger $TaskTrigger `
        -Principal $TaskPrincipal `
        -Settings $TaskSettings `
        -Description "Starts the Rust hotkey launcher and warms Markdown Quick Memo in the background." `
        -Force | Out-Null
    foreach ($ValueName in @($NewRunValueName) + $LegacyRunValueNames) {
        Remove-ItemProperty `
            -Path $RunKeyPath `
            -Name $ValueName `
            -ErrorAction SilentlyContinue
    }
    $UsesScheduledTask = $true
}
catch {
    Write-Warning "Scheduled task registration failed; falling back to the Run key: $($_.Exception.Message)"
    New-Item -Path $RunKeyPath -Force | Out-Null
    $RunCommand = '"{0}"' -f $LauncherExecutable
    New-ItemProperty `
        -Path $RunKeyPath `
        -Name $NewRunValueName `
        -Value $RunCommand `
        -PropertyType String `
        -Force | Out-Null
    foreach ($ValueName in $LegacyRunValueNames) {
        Remove-ItemProperty `
            -Path $RunKeyPath `
            -Name $ValueName `
            -ErrorAction SilentlyContinue
    }
}

Get-Process -Name "MarkdownQuickMemoHotkey" -ErrorAction SilentlyContinue |
    Stop-Process -Force

if ($UsesScheduledTask) {
    Start-ScheduledTask -TaskName $ScheduledTaskName
}
else {
    Start-Process `
        -FilePath $LauncherExecutable `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden
}

Write-Host "Start menu shortcut created: $ShortcutPath"
if ($UsesScheduledTask) {
    Write-Host "Rust hotkey launcher task registered: $ScheduledTaskName"
}
else {
    Write-Host "Rust hotkey launcher startup registered: $RunKeyPath\$NewRunValueName"
}
Write-Host "Native hotkey: $Hotkey"
