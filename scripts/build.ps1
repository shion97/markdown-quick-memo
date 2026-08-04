$ErrorActionPreference = "Stop"

$TauriBuildScript = Join-Path $PSScriptRoot "build_tauri.ps1"
if (-not (Test-Path -LiteralPath $TauriBuildScript)) {
    throw "Tauri build script was not found: $TauriBuildScript"
}

& $TauriBuildScript
