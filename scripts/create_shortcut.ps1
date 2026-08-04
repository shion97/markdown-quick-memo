param(
    [string]$Hotkey = "CTRL+ALT+M"
)

$ErrorActionPreference = "Stop"

$TauriShortcutScript = Join-Path $PSScriptRoot "create_tauri_shortcut.ps1"
if (-not (Test-Path -LiteralPath $TauriShortcutScript)) {
    throw "Tauri shortcut script was not found: $TauriShortcutScript"
}

& $TauriShortcutScript -Hotkey $Hotkey
