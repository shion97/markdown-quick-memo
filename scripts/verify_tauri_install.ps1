param(
    [string]$ExpectedHotkey = "CTRL+ALT+M"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExpectedExecutable = Join-Path $ProjectRoot "dist\MarkdownQuickMemo\MarkdownQuickMemo.exe"
$ExpectedLauncher = Join-Path $ProjectRoot "dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe"
$HotkeyConfig = Join-Path $env:LOCALAPPDATA "com.markdownquickmemo.app\hotkey.txt"
$ScheduledTaskName = "Markdown Quick Memo Hotkey"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$NewRunValueName = "MarkdownQuickMemoLauncher"
$LegacyRunValueNames = @("MarkdownQuickMemo", "MarkdownQuickMemoHotkey")
$Task = Get-ScheduledTask -TaskName $ScheduledTaskName -ErrorAction SilentlyContinue
$Processes = @(Get-Process -Name "MarkdownQuickMemo" -ErrorAction SilentlyContinue)
$LauncherProcesses = @(Get-Process -Name "MarkdownQuickMemoHotkey" -ErrorAction SilentlyContinue)
$RunValue = (
    Get-ItemProperty `
        -Path $RunKeyPath `
        -Name $NewRunValueName `
        -ErrorAction SilentlyContinue
).$NewRunValueName
$LegacyRunValues = @{}
foreach ($ValueName in $LegacyRunValueNames) {
    $LegacyRunValues[$ValueName] = (
        Get-ItemProperty `
            -Path $RunKeyPath `
            -Name $ValueName `
            -ErrorAction SilentlyContinue
    ).$ValueName
}
$ConfiguredHotkey = if (Test-Path -LiteralPath $HotkeyConfig) {
    [System.IO.File]::ReadAllText($HotkeyConfig).Trim()
}
else {
    $null
}

$Result = [ordered]@{
    ExecutableExists = Test-Path -LiteralPath $ExpectedExecutable
    LauncherExists = Test-Path -LiteralPath $ExpectedLauncher
    ScheduledTaskExists = $null -ne $Task
    ScheduledTaskExecutable = if ($Task) { $Task.Actions.Execute } else { $null }
    ScheduledTaskArguments = if ($Task) { $Task.Actions.Arguments } else { $null }
    ScheduledTaskPriority = if ($Task) { $Task.Settings.Priority } else { $null }
    ScheduledTaskMultipleInstances = if ($Task) { "$($Task.Settings.MultipleInstances)" } else { $null }
    ScheduledTaskState = if ($Task) { "$($Task.State)" } else { $null }
    RunFallback = $RunValue
    LegacyRunValuesRemoved = -not ($LegacyRunValues.Values | Where-Object { $null -ne $_ })
    ConfiguredHotkey = $ConfiguredHotkey
    TauriProcessCount = $Processes.Count
    RustLauncherProcessCount = $LauncherProcesses.Count
}

$Result | ConvertTo-Json -Depth 4

if (-not $Result.ExecutableExists) {
    throw "Tauri executable is missing."
}
if (-not $Result.LauncherExists) {
    throw "Rust hotkey launcher is missing."
}
if ($Task) {
    if ($Task.Actions.Execute -ne $ExpectedLauncher) {
        throw "Scheduled task points to an unexpected executable."
    }
    if ($Task.Settings.Priority -ne 4) {
        throw "Scheduled task priority is not 4."
    }
}
elseif (-not $RunValue) {
    throw "Neither the scheduled task nor the Run fallback is registered."
}
if (-not $Result.LegacyRunValuesRemoved) {
    throw "A legacy startup Run value still exists."
}
if ($ConfiguredHotkey -ne $ExpectedHotkey) {
    throw "Configured hotkey does not match."
}
if ($Processes.Count -lt 1) {
    throw "Tauri background process is not running."
}
if ($LauncherProcesses.Count -ne 1) {
    throw "Rust hotkey launcher is not running as a single process."
}
