# 引継ぎメモ

## 2026-07-27 修正・追加機能

- リスト項目の折り返し行を本文先頭へ揃える吊り下げインデントを追加。
- 保存先フォルダをエクスプローラーで開くファイルメニューを追加。
- PDF生成成功後、OSの既定アプリでPDFを自動的に開く処理を追加。
- 開いている保存済みファイルを同一フォルダ内でリネームする機能を追加。既存ファイルは上書きしない。
- GUIテストとMarkdown解析テストを追加・更新。

## 検証状況

- `venv\Scripts\python.exe -m unittest discover -s tests -v`
  - 79件成功、失敗0件、32件スキップ。
  - スキップは実行環境のTcl/Tk不足（`Can't find a usable init.tcl`）によるGUIスモークテスト。
  - Tkを生成しないファイルリネーム、保存先オープン、PDF自動オープンの単体テストは成功。
- `venv\Scripts\python.exe -m compileall -q markdown_quick_memo tests`
  - 成功。
- `git diff --check`
  - 問題なし。
