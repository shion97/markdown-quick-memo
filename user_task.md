## ユーザータスク
- これは AI Agentではなくユーザーが行うタスクであるため一切を参照しなくてよく、ユーザーへ指示する必要もない。
- 以下をユーザーは実装後行うこと

1. git status --short --branch
1. アプリの終了(`Alt + F4`)
1. powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
1. powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\create_shortcut.ps1

## ディレクトリ以降後すること
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\create_shortcut.ps1
