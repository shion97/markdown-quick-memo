# Markdownファイル管理

- id: `file-management`
- 最終確認日: `2026-07-27`

### 概要

Markdownファイルの新規作成、読み込み、安全な保存、ファイル名変更、保存先フォルダ表示を扱う。ファイル名変更は`Ctrl+Shift+R`、保存先表示は`Ctrl+Shift+E`から実行できる。

## 実装箇所

- `markdown_quick_memo/app.py#MarkdownQuickMemoApp.open_document` — ファイル選択ダイアログからMarkdownを開く。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp.open_path` — 指定パスを読み込み、編集中の文書へ反映する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._save_to` — エディタのMarkdown原文を保存する。
- `markdown_quick_memo/document.py#read_markdown` — UTF-8 BOMの有無を許容して読み込む。
- `markdown_quick_memo/document.py#write_markdown` — 拡張子を補完し、一時ファイルを経由して保存する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp.rename_current_file` — 保存済みファイルを同一フォルダ内でリネームする。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp.open_save_folder` — 保存先フォルダをOSの既定アプリで開く。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._bind_shortcuts` — ファイル名変更と保存先表示のキーボードショートカットを登録する。

### 関連

- `pdf-export`

### テスト

- `tests/test_document.py`
- `tests/test_app_file_actions.py`
- `tests/test_gui_smoke.py`
