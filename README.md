# Markdown Quick Memo

Windows向けの、キーボード中心のMarkdownメモアプリです。Markdown原文を正本として保持しながら、CodeMirror 6の編集欄へ見出し、表、引用、リスト、KaTeX数式などを装飾表示します。

## 技術構成

- Rust
- Tauri 2 / WebView2
- TypeScript
- CodeMirror 6
- KaTeX

編集中の本文、選択範囲、Undo・Redo、カーソル、スクロール位置はCodeMirrorの`EditorState`だけが所有します。Rust側へ本文を定期同期せず、保存やPDF出力など必要な操作でだけ本文とリビジョン番号を渡します。

## 開発環境

必要なツールは次のとおりです。

- Node.js 24
- pnpm 11
- Rust stable MSVC
- Visual Studio 2022 Build Tools
  - Desktop development with C++相当のMSVC・Windows SDK
- WebView2 Runtime

依存関係を導入します。

```powershell
pnpm install --frozen-lockfile
```

開発起動には、Visual Studio Developer PowerShellまたはMSVC環境を読み込んだシェルを使用します。

```powershell
pnpm tauri dev
```

## Windowsホットキー

`MarkdownQuickMemoHotkey.exe`は、本文を持たない小さなRust製ランチャーです。Windowsの`RegisterHotKey`で`Ctrl + Alt + M`を監視し、Tauri本体を起動します。

- ログオン時にランチャーを起動する。
- ランチャーは本体を`--background`で起動し、WebView2とCodeMirrorを非表示で先読みする。
- ホットキー押下時は本体EXEを起動する。
- 本体が起動済みなら、Tauriの単一起動機能が既存プロセスへ表示要求を転送する。
- 本体が完全終了済みなら、新しい本体プロセスを起動する。
- `Ctrl + Q`は本体を非表示にし、編集状態を保持する。
- `Alt + F4`は本体を完全終了するが、ランチャーは残るため再度ホットキーから起動できる。

ランチャーと本体の間でMarkdown本文は同期しません。通信対象は表示要求とホットキー設定だけです。

## 操作

| 操作 | キー |
| --- | --- |
| アプリを表示・再起動 | `Ctrl + Alt + M` |
| 新規 | `Ctrl + N` |
| 開く | `Ctrl + O` |
| 保存 | `Ctrl + S` |
| 名前を付けて保存 | `Ctrl + Shift + S` |
| ファイル名を変更 | `Ctrl + Shift + R` |
| 保存先を開く | `Ctrl + Shift + E` |
| PDFへ書き出す | `Ctrl + Shift + P` |
| 待機状態へ戻す | `Ctrl + Q` |
| 完全に終了する | `Alt + F4` |
| 元に戻す / やり直す | `Ctrl + Z` / `Ctrl + Y` |
| 検索 | `Ctrl + F` |
| 表を挿入 | `Ctrl + T` |
| 太字 / 斜体 / 取り消し線 | `Ctrl + B` / `Ctrl + I` / `Ctrl + Shift + X` |
| リストを深くする / 浅くする | `Tab` / `Shift + Tab` |
| 構造を継続しない改行 | `Shift + Enter` |
| 半透明表示 | `Ctrl + Shift + O` |
| リンク・画像を開く | 対象を`Ctrl + クリック` |

## 編集と保存

- UTF-8 BOM付きMarkdownを読み込めます。
- 保存はUTF-8 BOMなしです。
- 保存先と同じフォルダへ一時ファイルを書き、成功時だけ既存ファイルを置換します。
- Decoration、数式DOM、表DOMなどの表示要素は保存内容へ含めません。
- 保存要求には単調増加するリビジョン番号を付けます。保存中に新しい編集が発生した場合、古い保存結果で未保存状態を解除しません。
- 新規作成やファイルを開く前は、「保存」「保存せず続行」「キャンセル」を区別できます。

## Markdown表示

- 見出し、太字、斜体、取り消し線、インラインコード、コードブロック、引用、リスト、チェックリスト、表、水平線、リンク、画像を装飾します。
- カーソルまたは選択範囲に重なる箇所はMarkdown原文へ戻し、直接編集できます。
- 斜体フォントを持たない日本語フォントでも、疑似斜体を使って斜体表示を維持します。
- 行番号ガターは表示せず、行・列、文字数、単語数を上部へ表示します。
- `#`から`######`の見出しから目次を作成します。画面幅1200px以上では右側へ常時表示し、狭い画面では右端へマウスを置くと表示します。
- 目次の項目を選ぶと、対応する見出しへカーソルと表示位置が移動します。
- 右上の三点メニューには、ファイル操作などの主な操作とショートカットをコンパクトに表示します。
- インライン数式は`$E=mc^2$`、独立数式は`$$\frac{a}{b}$$`で記述します。
- KaTeXは`trust: false`で実行し、入力長、展開数、表示サイズに上限を設けます。
- 不正または上限を超える数式は、UIを停止させず原文へフォールバックします。
- ローカル画像はMarkdownの保存フォルダ配下かつ20 MB以下だけを読み込みます。
- 外部画像URLは取得しません。
- 外部リンクとしてOSへ渡すのは`http`、`https`、`mailto`だけです。

## 入力支援

- 箇条書き、番号付きリスト、チェックリスト、引用をEnterで継続します。
- 継続後の空項目で再度Enterを押すと、余分な空行を追加せず構造を終了します。
- 左右キーは装飾表示内でもMarkdown原文を一文字ずつ移動します。
- `Tab`と`Shift + Tab`でリスト階層を変更します。
- コードフェンス内ではMarkdown構造の補完を抑止します。
- 対括弧、引用符、バッククォートを補完します。
- バッククォート3個の入力時は閉じフェンスを生成します。
- 補完結果はMarkdown原文へ通常の編集として入り、Undo・Redoできます。

## PDF

PDF出力時は、Markdownから印刷用HTMLを作成し、編集画面と同じKaTeXとCSSを使用します。WebView2の`PrintToPdf`で一時PDFへ出力し、成功時だけ既存PDFを置換します。PDF用のMarkdown変換コードは操作時に動的読み込みし、通常起動の負荷から分離しています。

## テスト

```powershell
pnpm test
pnpm lint
cargo test --manifest-path .\src-tauri\Cargo.toml --locked --all-targets
cargo clippy --manifest-path .\src-tauri\Cargo.toml --locked --all-targets -- -D warnings
```

RustコマンドはMSVC環境を読み込んだシェルで実行してください。

旧Python/Tkinter版の回帰基準を確認する場合は次を使用します。

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

## releaseビルド

Tauri本体、Rustランチャー、NSIS、MSIを作成します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

`build.ps1`はTauri版の`build_tauri.ps1`を呼び出す標準入口です。

主な生成物は次のとおりです。

- `dist\MarkdownQuickMemo\MarkdownQuickMemo.exe`
- `dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe`
- `src-tauri\target\release\bundle\nsis\Markdown Quick Memo_2.0.0_x64-setup.exe`
- `src-tauri\target\release\bundle\msi\Markdown Quick Memo_2.0.0_x64_en-US.msi`

## ログオン登録

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\create_shortcut.ps1
```

別のキーを初期設定する場合は、例えば次のように指定します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\create_shortcut.ps1 -Hotkey "CTRL+ALT+Q"
```

`create_shortcut.ps1`はTauri版の`create_tauri_shortcut.ps1`を呼び出す標準入口です。

スクリプトは優先度4、多重起動`IgnoreNew`のログオンタスクを登録します。登録できない場合は現在ユーザーの`Run`キーへフォールバックします。アプリ内のホットキー設定では、登録失敗時に元のキーへロールバックします。

登録状態は次で確認できます。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify_tauri_install.ps1
```
