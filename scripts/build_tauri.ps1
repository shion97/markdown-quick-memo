$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$Cargo = Join-Path $CargoBin "cargo.exe"
$ReleaseExecutable = Join-Path $ProjectRoot "src-tauri\target\release\MarkdownQuickMemo.exe"
$ReleaseLauncher = Join-Path $ProjectRoot "src-tauri\target\release\MarkdownQuickMemoHotkey.exe"
$DistributionDirectory = Join-Path $ProjectRoot "dist\MarkdownQuickMemo"
$DistributionExecutable = Join-Path $DistributionDirectory "MarkdownQuickMemo.exe"
$LauncherDistributionDirectory = Join-Path $ProjectRoot "dist\MarkdownQuickMemoHotkey"
$LauncherDistributionExecutable = Join-Path $LauncherDistributionDirectory "MarkdownQuickMemoHotkey.exe"

if (-not (Test-Path -LiteralPath $Cargo)) {
    throw "cargo.exe was not found. Install Rustup first."
}

$VisualStudioInstaller = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $VisualStudioInstaller)) {
    throw "Visual Studio Build Tools was not found."
}

$VisualStudioPath = & $VisualStudioInstaller `
    -latest `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
if (-not $VisualStudioPath) {
    throw "Visual Studio C++ Build Tools was not found."
}

$RunningApplication = @(Get-Process -Name "MarkdownQuickMemo" -ErrorAction SilentlyContinue)
if ($RunningApplication.Count -gt 0) {
    throw "MarkdownQuickMemo.exe is running. Close it with Alt + F4 before rebuilding."
}
Get-Process -Name "MarkdownQuickMemoHotkey" -ErrorAction SilentlyContinue |
    Stop-Process -Force

$env:PATH = "$CargoBin;$env:PATH"
Push-Location $ProjectRoot
try {
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed."
    }

    & pnpm test
    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript tests failed."
    }

    & pnpm lint
    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript lint failed."
    }

    & $Cargo test --manifest-path ".\src-tauri\Cargo.toml" --locked
    if ($LASTEXITCODE -ne 0) {
        throw "Rust tests failed."
    }

    & $Cargo build `
        --manifest-path ".\src-tauri\Cargo.toml" `
        --locked `
        --release `
        --bin MarkdownQuickMemoHotkey
    if ($LASTEXITCODE -ne 0) {
        throw "Rust hotkey launcher build failed."
    }

    & pnpm tauri build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri release build failed."
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $ReleaseExecutable)) {
    throw "Tauri executable was not created: $ReleaseExecutable"
}
if (-not (Test-Path -LiteralPath $ReleaseLauncher)) {
    throw "Rust hotkey launcher was not created: $ReleaseLauncher"
}

New-Item -ItemType Directory -Path $DistributionDirectory -Force | Out-Null
Copy-Item -LiteralPath $ReleaseExecutable -Destination $DistributionExecutable -Force
New-Item -ItemType Directory -Path $LauncherDistributionDirectory -Force | Out-Null
Copy-Item -LiteralPath $ReleaseLauncher -Destination $LauncherDistributionExecutable -Force

Write-Host "Tauri build complete: dist\MarkdownQuickMemo\MarkdownQuickMemo.exe"
Write-Host "Rust hotkey launcher: dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe"
Write-Host "Installers: src-tauri\target\release\bundle"
