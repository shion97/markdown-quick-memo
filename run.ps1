$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$Pythonw = Join-Path $ProjectRoot "venv\Scripts\pythonw.exe"

if (-not (Test-Path $Pythonw)) {
    throw "venv\Scripts\pythonw.exe was not found."
}

Start-Process -FilePath $Pythonw -ArgumentList "-m", "markdown_quick_memo" -WorkingDirectory $ProjectRoot
