# Markdown編集入力支援

- id: `markdown-editing-assistance`
- 最終確認日: `2026-07-27`

### 概要

Markdown原文を正本として、リスト・引用・インデント・対記号の入力補完と装飾表示を行う。番号付きリストの改行では原文へ`1. `を追加し、表示時に連番へ変換する。

## 実装箇所

- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._bind_shortcuts` — エディタのキーイベントを入力支援へ接続する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._on_return` — 現在行の構造を判定して次行のMarkdown原文を生成する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._continuation_list_marker` — 番号付きリストの継続記号を`1.`へ正規化する。
- `markdown_quick_memo/markdown_styler.py#analyze_markdown` — リスト階層と表示用連番、本文開始位置を解析する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._apply_list_wrap_indents` — 原文の太字マーカーまたは表示用マーカーの実フォント幅から折り返し行の左余白を決める。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._create_list_marker_widget` — 非アクティブ行のリストマーカーを表示する。

### 関連

- `pdf-export`

### テスト

- `tests/test_gui_smoke.py`
- `tests/test_markdown_styler.py`
