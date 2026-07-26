# PDF書き出し

- id: `pdf-export`
- 最終確認日: `2026-07-27`

### 概要

保存済みMarkdownを同名PDFへ変換し、生成成功後にPCの既定アプリで開く。既存PDFの上書きは事前に確認する。

## 実装箇所

- `markdown_quick_memo/app.py#MarkdownQuickMemoApp.export_pdf` — Markdown保存、上書き確認、PDF変換、自動オープンを順に制御する。
- `markdown_quick_memo/pdf_exporter.py#export_markdown_to_pdf` — Markdown構造をPDFへ変換し、完成ファイルを安全に配置する。
- `markdown_quick_memo/app.py#open_with_default_app` — 生成したPDFをOSの関連付けに従って開く。

### 関連

- `file-management`
- `markdown-editing-assistance`

### テスト

- `tests/test_pdf_exporter.py`
- `tests/test_app_file_actions.py`
- `tests/test_gui_smoke.py`
