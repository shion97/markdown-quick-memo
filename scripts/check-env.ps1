$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$CargoManifestPath = Join-Path $ProjectRoot "src-tauri\Cargo.toml"
$VisualStudioInstaller = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$Failures = [System.Collections.Generic.List[string]]::new()

function Add-Failure {
    param([Parameter(Mandatory)][string]$Message)

    $Failures.Add($Message)
    Write-Host "[FAIL] $Message"
}

function Get-ToolVersion {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Add-Failure "$Name was not found."
        return $null
    }

    $Version = (& $Name --version 2>&1 | Select-Object -First 1).ToString().Trim()
    if ($LASTEXITCODE -ne 0) {
        Add-Failure "$Name --version failed."
        return $null
    }

    Write-Host "[ OK ] $Name $Version"
    return $Version
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Add-Failure "PowerShell 7 or later is required. Run this script with pwsh."
}
else {
    Write-Output "[ OK ] pwsh $($PSVersionTable.PSVersion)"
}

foreach ($Path in @($PackageJsonPath, (Join-Path $ProjectRoot "pnpm-lock.yaml"), $CargoManifestPath, (Join-Path $ProjectRoot "src-tauri\Cargo.lock"))) {
    if (-not (Test-Path -LiteralPath $Path)) {
        Add-Failure "Required file is missing: $Path"
    }
}

$NodeVersion = Get-ToolVersion "node"
$PnpmVersion = Get-ToolVersion "pnpm"
$RustVersion = Get-ToolVersion "rustc"
$CargoVersion = Get-ToolVersion "cargo"

if ($PnpmVersion -and (Test-Path -LiteralPath $PackageJsonPath)) {
    $PackageJson = Get-Content -LiteralPath $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExpectedPnpmVersion = $PackageJson.packageManager -replace '^pnpm@', ''
    if (($PnpmVersion -split '\.')[0] -ne ($ExpectedPnpmVersion -split '\.')[0]) {
        Add-Failure "pnpm $PnpmVersion is incompatible with packageManager $($PackageJson.packageManager)."
    }
    elseif ($PnpmVersion -ne $ExpectedPnpmVersion) {
        Write-Output "[WARN] pnpm $PnpmVersion differs from packageManager $($PackageJson.packageManager), but the major version matches."
    }
}

if ($RustVersion -and $CargoVersion -and (Test-Path -LiteralPath $CargoManifestPath)) {
    $Metadata = & cargo metadata --manifest-path $CargoManifestPath --no-deps --format-version 1 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) {
        Add-Failure "cargo metadata failed."
    }
    else {
        $RequiredRustVersion = [version]$Metadata.packages[0].rust_version
        $InstalledRustVersion = [version](($RustVersion -split ' ')[1])
        if ($InstalledRustVersion -lt $RequiredRustVersion) {
            Add-Failure "rustc $InstalledRustVersion is older than the required $RequiredRustVersion."
        }
    }
}

if (-not (Test-Path -LiteralPath $VisualStudioInstaller)) {
    Add-Failure "Visual Studio Build Tools was not found."
}
else {
    $VisualStudioPath = & $VisualStudioInstaller -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($VisualStudioPath) {
        Write-Output "[ OK ] Visual Studio C++ Build Tools $VisualStudioPath"
    }
    else {
        Add-Failure "Visual Studio C++ Build Tools was not found."
    }
}

if ($Failures.Count -gt 0) {
    throw "Environment check failed with $($Failures.Count) problem(s)."
}

Write-Output "Environment check passed."
