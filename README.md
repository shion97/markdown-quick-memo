# Markdown Quick Memo

Windows向けの、小型でキーボード中心のMarkdownメモアプリです。Markdownの元データを保持したまま編集欄へ装飾を反映し、カーソル行以外のMarkdown記号を可能な範囲で隠します。保存したMarkdownは、任意のタイミングで同じフォルダへPDFとして書き出せます。

## セットアップと起動

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -m markdown_quick_memo
```

コンソールなしで起動する場合は次を使います。

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

## Windowsショートカット

スタートメニューへアプリのショートカットを作成し、現在のユーザーのログオン時自動起動へ軽量なホットキーランチャーを登録します。`Ctrl + Alt + M` はWindowsのネイティブAPIで検出するため、`.lnk`のホットキー処理で発生する約3秒の待ち時間を回避します。旧版のデスクトップショートカットとスタートアップフォルダーの登録がある場合は削除します。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create_shortcut.ps1
```

別のキーにする場合は `-Hotkey "CTRL+ALT+Q"` のように指定します。ランチャーはスクリプト実行直後から動作し、次回以降はWindowsへのサインイン時に自動起動します。

## 操作

| 操作 | キー |
| --- | --- |
| 新規 | `Ctrl + N` |
| 開く | `Ctrl + O` |
| 保存 | `Ctrl + S` |
| 名前を付けて保存 | `Ctrl + Shift + S` |
| PDFに書き出す | `Ctrl + Shift + P` |
| 閉じる | `Ctrl + Q` / `Alt + F4` |
| 元に戻す / やり直す | `Ctrl + Z` / `Ctrl + Y` |
| 検索 | `Ctrl + F` |
| 表を挿入 | `Ctrl + T` |
| ウィンドウの半透明表示を切り替え | `Ctrl + Shift + O` |
| 太字 / 斜体 / 取り消し線 | `Ctrl + B` / `Ctrl + I` / `Ctrl + Shift + X` |
| リンク・画像を開く | 対象を `Ctrl + クリック` |

ローカル画像は画像記法を `Ctrl + クリック` するとプレビューします。相対パスは、保存済みメモではメモの保存フォルダ、未保存メモではアプリの作業フォルダを基準に解決します。

PDF書き出しは「ファイル」メニューまたは `Ctrl + Shift + P` から実行します。未保存または変更中のメモは先にMarkdownとして保存し、`memo.md` と同じフォルダへ `memo.pdf` を生成します。同名PDFがある場合は上書きを確認します。ローカル画像はMarkdownファイルのフォルダを基準に埋め込み、外部画像URLは取得しません。

半透明表示はウィンドウ全体を60%の不透明度にし、背後の資料を確認しやすくします。アプリを再起動すると不透明表示へ戻ります。

## テスト

```powershell
.\venv\Scripts\python.exe -m unittest discover -s tests -v
```

## exeの作成

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

アプリ本体は `dist\MarkdownQuickMemo\MarkdownQuickMemo.exe`、ホットキーランチャーは `dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe` に作成されます。

## 実装上の方針

- 本文は日本語をBIZ UDGothic、英数字をSegoe UIで表示します。PDFではSegoe UIを利用できない場合に同梱Robotoへフォールバックします。コードは等幅フォント、数式プレビューはComputer Modernを使用します。
- 編集欄内の文字列が保存されるMarkdownそのものです。
- 記号を隠していても、カーソルがある行では編集できるよう記号を表示します。
- リストの点・番号と引用の灰色マーカーは、記号を隠す設定でも表示します。
- コードフェンスを隠したときも、指定した言語名をコードブロック上部へ残します。
- 水平線は編集欄の幅に合わせて描画し、表は縦線と外周線を使わず行間の横線だけで描画します。
- `Ctrl + T` では行数と列数を指定し、各セルを `q` で埋めたMarkdown表を選択範囲またはカーソル位置へ挿入します。
- `Ctrl + Shift + P` では、現在のMarkdownを正本として同一フォルダへ同名PDFを書き出します。PDF生成用ライブラリは操作時だけ読み込み、通常起動へ影響させません。
- 水平線または表へカーソルを移すと、編集できるMarkdown原文へ自動的に戻ります。
- インライン数式は `$E=mc^2$`、独立した数式は `$$\\frac{a}{b}$$` の形式で入力できます。カーソル行以外ではLaTeX数式をMathText画像として表示し、見出し内では見出しサイズへ連動します。
- MathTextはウィンドウ表示後にバックグラウンドで先読みし、生成した数式画像をキャッシュして初回変換と再描画の待ち時間を抑えます。
- 同じ階層へ `1. ` を連続して入力すると、プレビューでは `1.、2.、3.` の連番として表示します。保存されるMarkdown原文は変更しません。
- `-`、`*`、`+` の箇条書きは、最上位階層を黒丸 `●`、それより深い階層を白丸 `○` で表示します。
- 番号付きリストの中に箇条書き、その箇条書きの中に番号付きリストを置くなど、異なる種類のネストに対応します。
- 完全なWYSIWYG変換はカーソル位置と元データの不整合を招くため、元データを変更しない安全な方式を採用しています。

## 数式の対応範囲

- MathTextが扱う分数、根号、添字・上付き、ギリシャ文字、関数、極限、総和、積分、集合・論理・関係演算子、矢印、アクセント、フォント指定、短いテキストに対応します。
- MathTextが直接扱わない `\tfrac` は、プレビュー時だけ同等の `\frac` として描画します。保存されるMarkdownは変更しません。
- 独立数式では `matrix`、`pmatrix`、`bmatrix`、`Bmatrix`、`vmatrix`、`Vmatrix`、`cases`、`aligned`、`align`、`align*` に対応します。`\\`を行、`&`を列または揃え位置として扱い、`f(x)=\\begin{cases}...`のように環境の前後へ通常数式を置けます。
- 複合数式は最大20行・20列とし、インライン数式では使用できません。インラインへ入力した場合は数式原文を表示します。
- 通常文、見出し、リスト、引用、Markdown表のセルで数式を表示します。インラインコード、コードブロック、リンク先URL、画像パスは数式化しません。
- `\usepackage`、任意の `\newcommand`、数式番号・相互参照、TikZ、化学式パッケージ、LaTeX文書全体には対応しません。未対応または不正な式は原文へフォールバックします。

## 同梱フォント

PDF出力時のフォールバック用RobotoはSIL Open Font License 1.1に基づいて同梱し、アプリのプロセス内だけで登録します。ライセンス全文は `assets/fonts/OFL-Roboto.txt` にあります。
