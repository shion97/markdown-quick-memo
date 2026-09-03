$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CargoManifestPath = Join-Path $ProjectRoot "src-tauri\Cargo.toml"

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Description,
        [Parameter(Mandatory)][scriptblock]$Command
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed."
    }
}

& (Join-Path $PSScriptRoot "check-env.ps1")

Push-Location $ProjectRoot
try {
    Invoke-Checked "TypeScript tests" { pnpm test }
    Invoke-Checked "TypeScript lint" { pnpm lint }
    Invoke-Checked "TypeScript build" { pnpm build }
    Invoke-Checked "Rust format check" { cargo fmt --manifest-path $CargoManifestPath -- --check }
    Invoke-Checked "Rust tests" { cargo test --manifest-path $CargoManifestPath --locked --all-targets }
    Invoke-Checked "Rust lint" { cargo clippy --manifest-path $CargoManifestPath --locked --all-targets -- -D warnings }
}
finally {
    Pop-Location
}

Write-Output "Verification passed."
