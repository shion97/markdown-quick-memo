# Markdown Quick Memo

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Windowsでキーボードを中心に素早くMarkdownメモを書き、元の作業へ戻る利用者。

## Product Purpose

ホットキーで呼び出し、Markdown原文を保持しながら読み書きし、保存して待機状態へ戻る。

## Operating Context

Tauri 2 / WebView2、TypeScript、CodeMirror 6、Rust。日本語入力、複数文書、表、コード、KaTeX数式を扱う。

## Capabilities and Constraints

- 既存ショートカット、Markdown原文、保存・復元、Undo・Redoを維持する。
- 保存先のある文書は入力から1秒後に自動保存する。無題は初回保存が必要。
- タブと目次はキーボードとマウスの両方で操作できること。
- ライト／ダークと狭いウィンドウに対応する。
- 依存追加や本体の強制終了はしない。

## Evidence on Hand

README.md、docs/設計書.md、docs/UIUX改善案.md、既存のアプリとテスト。2026-10-28に利用者がPhase 0〜5の段階的導入と上記の維持条件を確認。

## Product Principles

- 入力の開始を待たせない。
- 状態を文字で伝え、保存失敗から回復できる。
- 本文を優先し、補助操作を必要なときに開く。
- 自動検証とWindows実機の受け入れ確認を区別する。
