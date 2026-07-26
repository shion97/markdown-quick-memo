# Markdown編集入力支援

- id: `markdown-editing-assistance`
- 最終確認日: `2026-07-27`

### 概要

Markdown原文を正本として、リスト・引用・インデント・対記号の入力補完と装飾表示を行う。番号付きリストの改行では原文へ`1. `を追加し、リスト記号は操作状態にかかわらず原文のまま表示する。

## 実装箇所

- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._bind_shortcuts` — エディタのキーイベントを入力支援へ接続する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._on_return` — 現在行の構造を判定して次行のMarkdown原文を生成する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._continuation_list_marker` — 番号付きリストの継続記号を`1.`へ正規化する。
- `markdown_quick_memo/markdown_styler.py#analyze_markdown` — リスト階層、原文マーカー、本文開始位置を解析する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp.render_markdown` — リスト原文マーカーへ書式を適用し、非アクティブ行でも隠さず表示する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._apply_list_wrap_indents` — 原文マーカーの最大幅から共通列を決め、右揃えと一定の階層差を適用する。
- `markdown_quick_memo/app.py#MarkdownQuickMemoApp._collect_block_decorations` — リストを置換対象に含めず、他のブロック装飾だけを収集する。

### 関連

- `pdf-export`

### テスト

- `tests/test_gui_smoke.py`
- `tests/test_markdown_styler.py`
