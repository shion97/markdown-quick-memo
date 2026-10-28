---
version: 1
slug: "src-app-ts"
primary_target: "src/app.ts"
related_targets: ["src/styles.css","src/editor/editor.ts"]
---

# Markdown編集画面

Mode: Operate

採用案: `.impeccable/mocks/decision/paper.html`（静かな校正紙、利用者選択済み）。code-led。製品の前提はPRODUCT.md、仕様と検証結果はdocs/UIUX導入記録.md。

## Direction contract

THESIS: ホットキーから入力を再開する作業画面。本文の余白を中心に、操作と状態の位置を固定する。

OWN-WORLD: 白い本文、淡いグレーの補助領域、青みの墨色。選択は青灰色、失敗は文言と赤、フォーカスは輪郭。見出しは明朝体、本文は既存の日本語システム書体。

STORY: 文書を選び、書き、保存状態を確認して元の作業へ戻る。

FIRST VIEWPORT: 上部48pxのツールバー、左のタブ、最大800pxの本文、右の目次、下部の文書情報。狭幅では本文を押さずにパネルを重ねる。

FORM: 利用者選択のpaper。seed:ca6bd29329ee6e7e。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 検証

全10状態のキャプチャと既存機能の自動テストを確認済み。最終レビューはA11Y-01を修正してship。アプリに新しいラスタ画像は配布しない。Windows実機のIME・表示倍率・実ホットキー手操作は未確認。
