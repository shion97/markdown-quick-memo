---
name: Markdown Quick Memo
description: ホットキーから素早く作業へ戻る、本文中心のMarkdown編集画面
colors:
  app-background: "#f3f4f6"
  surface: "#ffffff"
  surface-muted: "#eef0f3"
  surface-raised: "#ffffff"
  tabs-background: "#f3f4f6"
  control: "rgb(255 255 255 / 70%)"
  control-hover: "#f9f9f9"
  control-pressed: "#f0f0f0"
  text: "#263345"
  muted: "#596779"
  border: "#d9dfe7"
  border-strong: "#bdc8d8"
  accent: "#405675"
  accent-hover: "#334762"
  accent-pressed: "#273a53"
  focus-ring: "#245cc4"
  selection: "#e8edf3"
  error: "#a52234"
  error-surface: "#fff0f1"
  success: "#286049"
  on-accent: "white"
  close-hover: "#c42b1c"
  syntax-keyword: "#cf222e"
  syntax-string: "#0a3069"
  syntax-constant: "#0550ae"
  syntax-comment: "#6e7781"
  syntax-type: "#8250df"
  syntax-variable: "#953800"
typography:
  display:
    fontFamily: "Yu Mincho, Iowan Old Style, serif"
    fontSize: "1.72em"
    fontWeight: 700
    lineHeight: 1.35
  headline:
    fontFamily: "Yu Mincho, Iowan Old Style, serif"
    fontSize: "1.48em"
    fontWeight: 700
    lineHeight: 1.35
  title:
    fontFamily: "Yu Mincho, Iowan Old Style, serif"
    fontSize: "1.28em"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "BIZ UDGothic, Yu Gothic UI, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, BIZ UDGothic, sans-serif"
    fontSize: "12px"
rounded:
  small: "4px"
  control: "5px"
  surface: "12px"
spacing:
  toolbar-height: "48px"
  content-top: "42px"
  content-inline: "clamp(24px, 5vw, 62px)"
  content-bottom: "76px"
  panel-width: "240px"
  panel-max-width: "480px"
  editor-min-width: "560px"
  statusbar-height: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "5px 7px"
  save-status:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "4px 7px"
  save-error:
    backgroundColor: "{colors.error-surface}"
    textColor: "{colors.error}"
    padding: "8px 14px"
  input-field:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "9px 10px"
  tab-item:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "5px 36px 5px 7px"
  outline-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "5px 7px"
  menu-popover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.surface}"
    padding: "6px"
  editor-paper:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    width: "800px"

---

# Design System: Markdown Quick Memo

## Overview

**Creative North Star: "静かな校正紙"**

これはホットキーから入力を再開し、保存状態を確認して元の作業へ戻るための Operate 系エディタである。白い本文面を中心に、淡いグレーの補助領域と青みの墨色を置く。UI の密度は作業を止めない程度に抑え、タブ・目次・メニューは必要なときだけ前面に出す。

本文は CodeMirror が Markdown 原文の所有権を持つ。日本語本文の読みやすさ、コード・表・数式の原文保持を優先し、装飾は本文の意味を補助する範囲に留める。ライト／ダークは OS 設定に追従し、狭幅では補助パネルを本文に重ねて編集領域を守る。

**Key Characteristics:**

- 白い校正紙と青みの墨色による静かなコントラスト
- 最大800pxの本文と、固定された上部・下部情報帯
- 240〜480pxの補助パネルを必要時だけ開く構成
- 保存状態、フォーカス、失敗を色だけに頼らず文言でも示す

## Colors

配色は青みの墨を一つのアクセントにし、本文の白／淡いグレーと、青みを含むダーク面を対にする。アクセントは操作対象と選択状態に限定し、コードの色は意味ごとに分ける。

### Primary

- **青みの墨（accent）**: ツールバーのアイコン、主ボタン、リンク、選択中の目次、キャレットに使う。ホバーと押下は `accent-hover` / `accent-pressed` へ段階的に暗くする。

### Neutral

- **校正紙（surface）**: 本文、ツールバー、ステータスバーの基準面。
- **淡い補助紙（app-background / surface-muted / tabs-background）**: アプリの外周、タブ帯、目次帯、引用・コード・表見出しの面。
- **青みの墨（text）**: 本文と主要ラベル。
- **控えめな注記（muted）**: 補助説明、目次見出し、文字数、カーソル位置。
- **細い罫線（border / border-strong）**: 1pxの区切り線と操作境界。

### Named Rules

**The Blue-Ink Scarcity Rule.** 青みの墨は操作対象、選択、リンク、重要な状態にだけ使い、面全体の装飾やグラデーションには使わない。

### Semantic States

- `selection` は選択・アクティブ状態の淡い青灰色、`focus-ring` は2pxの明確なキーボード輪郭。
- `success` は保存済み、`error` と `error-surface` は保存失敗と再試行領域に使う。失敗は必ず文言とボタンを併記する。
- `prefers-color-scheme: dark` では、面を `app-background #242a33`、`surface/surface-raised #343b46`、`surface-muted/tabs-background #2b323c`、文字を `text #edf1f6` / `muted #b1bbc8`、境界を `border #4a5564` / `border-strong #68768a`、アクセントを `accent #b7c8e2` / `accent-hover #c7d5ea` / `accent-pressed #a2b6d4`、フォーカスと選択を `focus-ring #a8c6ff` / `selection #3d4b5e`、失敗と成功を `error #ffb3bd` / `error-surface #492d37` / `success #9bdbbc` へ置き換える。

## Typography

**Display Font:** Yu Mincho, Iowan Old Style, serif

**Body Font:** BIZ UDGothic, Yu Gothic UI, Segoe UI, sans-serif
**Label/Mono Font:** UI ラベルは Segoe UI Variable Text 系、コード・数式の原文は既存の CodeMirror / monospace 設定を維持する。

**Character:** 本文は既存の日本語サンセリフで一定のリズムを保ち、見出しだけ明朝体へ切り替えて校正紙らしい階層を作る。ラベルは小さくても太さと輪郭で判別できるようにする。

### Hierarchy

- **Display** (700, 1.72em, 1.35): Markdown の H1。
- **Headline** (700, 1.48em, 1.35): Markdown の H2。下罫線を併用する。
- **Title** (700, 1.28em, 1.35): Markdown の H3。H4 は 1.14em を使う。
- **Body** (400, 16px, 1.75): CodeMirror の日本語本文。本文面の最大幅は800px。
- **Label** (12px): 保存状態、目次見出し、ステータスバー、補助説明。必要な見出しだけ600を使う。

### Named Rules

**The Source-Owner Rule.** Markdown 原文、コード、表、数式の入力と選択は CodeMirror の文字組みを所有者とし、見た目のために別の本文を重ねない。

## Layout

画面は48pxのツールバー、可変の作業領域、最小28pxの下部ステータスバーに分ける。本文は中央の最大800px面に置き、CodeMirror の本文パディングは上42px、左右 `clamp(24px, 5vw, 62px)`、下76pxである。補助パネルは初期幅240px、アプリの操作で最大480pxまで調整でき、本文には少なくとも560pxを残す。

1200px以上では目次を右側の固定グリッド列として表示する。1200px未満では目次を本文へ重ねて開き、タブも固定・縮退・明示開閉を使い分けて本文を横へ押さない。640px以下ではツールバーの余白とウィンドウ操作の幅を縮め、ラベルをアイコン中心へ寄せる。

## Elevation & Depth

基本は罫線と面の明度差で深さを示すフラットな構成で、ポップオーバー、検索パネル、ダイアログだけに柔らかな影を使う。目次の固定列とタブ帯は影で浮かせず、1pxの境界線で本文との関係を示す。ダークテーマでは同じ役割を黒い二重の柔らかな影へ置き換え、`prefers-reduced-motion` では状態遷移を止める。

### Shadow Vocabulary

- **Light surface lift** (`0 8px 22px rgb(40 52 70 / 12%)`): メニュー、検索、ダイアログの一時面。
- **Dark surface lift** (`0 8px 28px rgb(0 0 0 / 40%), 0 2px 8px rgb(0 0 0 / 24%)`): ダークテーマの一時面。

### Named Rules

**The Flat-By-Default Rule.** 常設の本文・タブ・目次には影を置かず、浮遊面の状態にだけ影を許可する。

## Shapes

コントロールは5px、ポップオーバーとダイアログは12pxの穏やかな角丸で統一する。罫線は1pxを基本とし、ウィンドウ操作だけはネイティブの矩形領域を保つ。選択中の目次は左側の3pxインセット線、引用は既存の4px左線を使い、厚いカード枠や装飾的なピル形状は追加しない。

## Components

### Buttons

- **Shape:** 5pxのコントロール角丸。
- **Primary:** `accent` 面に白文字、`7px 12px` の内側余白。保存・設定など確定操作に使う。
- **Quiet / Panel toggle:** 透明面に本文色、ホバーは `control-hover`、開いた状態は `selection` 面。
- **Hover / Focus:** 120msの背景・境界・文字色遷移。キーボードフォーカスは `focus-ring` の2px輪郭と2pxオフセットで示す。押下は `control-pressed` または `accent-pressed`。

### Cards / Containers

- **Popover / Search / Dialog:** `surface-raised`、12px、6px前後の内側余白、`shadow`。ポップオーバーの幅は最大360px、検索面は最大520px。
- **Editor paper:** `surface` の平面。本文は最大800pxで中央揃えにし、CodeMirror のスクロールとカーソルをそのまま使う。
- **Error banner:** `error-surface` 面に `error` 文字、8px 14pxの余白。原因文言と「再試行」を同じ帯に置く。

### Inputs / Fields

- **Style:** `control` 面、`border` の1px線、5px角丸。設定入力は `9px 10px`、検索入力は `4px 6px`。
- **Focus:** すべての `button`、`input`、`tabindex` 要素に2pxの `focus-ring` 輪郭。
- **Error / Disabled:** 失敗は `error` / `error-surface`、無効化は `muted` を透過させて操作不能を示す。

### Navigation

ツールバーは48pxで、タブ開閉、文書名、保存状態、編集／閲覧、目次、メニュー、ウィンドウ操作を固定順に並べる。タブは左の240〜480px帯、目次は右の240〜480px帯で、選択タブは淡い面と境界、選択中の目次は青みの左インセット線で示す。狭幅では各パネルを本文の上に重ね、閉じると本文へフォーカスを戻す。

### Save Status

保存状態は文書ごとに `未保存 · 初回保存`、`未保存`、`保存中`、`保存済み`、`保存失敗` を使い分ける。同一の失敗文言はDOMへ再設定せず、読み上げを繰り返さない。保存失敗時は本文を押し下げる通知帯を出し、次の成功まで再試行を残す。

### Signature Component: Markdown Editor

CodeMirror の本文領域が製品の中心で、16px・行間1.75の日本語本文、Yu Mincho の見出し、装飾された表・コード・数式を一つの原文面で扱う。空文書の案内は本文の外側に重ね、入力した瞬間に隠す。編集／閲覧モードはツールバーの文字とアイコンで明示し、閲覧時は原文変更を禁止する。

## Do's and Don'ts

### Do:

- **Do** 本文を最大800pxに収め、上下の情報帯と補助パネルの位置を毎画面で固定する。
- **Do** OS のライト／ダーク設定に合わせて、白／淡いグレーと青みのダーク面を対で使う。
- **Do** 保存、フォーカス、エラー、空文書を文言でも伝え、色だけに意味を持たせない。
- **Do** 補助パネルを必要時だけ開き、狭幅では本文を横へ押さない。
- **Do** Markdown 原文、表、コード、数式の編集を CodeMirror に委ねる。

### Don't:

- **Don't** グラデーション、厚い左右罫線、常設カード影、装飾的な新しいピル形状を追加しない。
- **Don't** 本文の代わりに別のプレビュー文字列を重ねたり、原文の入力・Undo・保存へ案内文を混入させたりしない。
- **Don't** アクセント色を面全体へ広げず、操作対象と状態以外を青くしない。
- **Don't** OS の IME、表示倍率、実ホットキーの受け入れ確認をブラウザーの模擬保存結果だけで済ませない。
