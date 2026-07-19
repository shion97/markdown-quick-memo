$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot "venv\Scripts\python.exe"
$LauncherExecutable = Join-Path $ProjectRoot "dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe"
$LauncherProcesses = @(Get-Process -Name "MarkdownQuickMemoHotkey" -ErrorAction SilentlyContinue)
$LauncherWasRunning = $LauncherProcesses.Count -gt 0
$LauncherArguments = "--hotkey CTRL+ALT+M"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "MarkdownQuickMemoHotkey"

$SavedRunCommand = (Get-ItemProperty -Path $RunKeyPath -Name $RunValueName -ErrorAction SilentlyContinue).$RunValueName
if ($SavedRunCommand -match '--hotkey\s+([^\s"]+)') {
    $LauncherArguments = "--hotkey $($Matches[1])"
}

$LauncherShortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Markdown Quick Memo Hotkey.lnk"
if (-not $SavedRunCommand -and (Test-Path -LiteralPath $LauncherShortcutPath)) {
    $Shell = New-Object -ComObject WScript.Shell
    $SavedArguments = $Shell.CreateShortcut($LauncherShortcutPath).Arguments
    if ($SavedArguments -match '--hotkey\s+([^\s]+)') {
        $LauncherArguments = "--hotkey $($Matches[1])"
    }
}

if (-not (Test-Path $Python)) {
    throw "venv\Scripts\python.exe was not found."
}

if ($LauncherWasRunning) {
    $LauncherProcesses | Stop-Process -Force
    $LauncherProcesses | Wait-Process -ErrorAction SilentlyContinue
}

Push-Location $ProjectRoot
try {
    & $Python -m pip install -r requirements-build.txt
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed."
    }
    & $Python -m PyInstaller --noconfirm --clean --windowed --add-data "assets\fonts;assets\fonts" --name MarkdownQuickMemo run_app.py
    if ($LASTEXITCODE -ne 0) {
        throw "MarkdownQuickMemo build failed."
    }
    & $Python -m PyInstaller --noconfirm --clean --windowed --exclude-module tkinter --exclude-module matplotlib --exclude-module PIL --name MarkdownQuickMemoHotkey run_hotkey_launcher.py
    if ($LASTEXITCODE -ne 0) {
        throw "MarkdownQuickMemoHotkey build failed."
    }
}
finally {
    Pop-Location
    if ($LauncherWasRunning -and (Test-Path -LiteralPath $LauncherExecutable)) {
        Start-Process -FilePath $LauncherExecutable -ArgumentList $LauncherArguments -WorkingDirectory $ProjectRoot
    }
}

Write-Host "Build complete: dist\MarkdownQuickMemo\MarkdownQuickMemo.exe"
Write-Host "Hotkey launcher: dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe"
