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

現在の環境を変更せず、必要なツールとバージョンを確認します。

```powershell
pwsh -NoProfile -File .\scripts\check-env.ps1
```

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
| ファイル名を変更 | `Ctrl + R` |
| 保存先を開く | `Ctrl + E` |
| PDFへ書き出す | `Ctrl + P` |
| 待機状態へ戻す | `Ctrl + Q` |
| 完全に終了する | `Alt + F4` |
| 元に戻す / やり直す | `Ctrl + Z` / `Ctrl + Y` |
| 検索パネルを表示 / 閉じる | `Ctrl + F` |
| 表を挿入 | `Ctrl + T` |
| 太字 / 斜体 / 取り消し線 | `Ctrl + B` / `Ctrl + I` / `Ctrl + X` |
| 字下げ / 字上げ | `Tab` / `Shift + Tab` |
| 構造を継続しない改行 | `Shift + Enter` |
| 閲覧モード / 編集モード | `Ctrl + M` |
| 半透明表示 | `Ctrl + H` |
| リンク・画像を開く | 対象を`Ctrl + クリック` |
| 目次を広げる / 狭める | `Ctrl + ←` / `Ctrl + →` |
| 目次操作を開始 / 終了 | `Ctrl + L` |
| 目次項目を上 / 下へ移動 | 目次操作中に`Ctrl + ↑` / `Ctrl + ↓` |

## 編集と保存

- UTF-8 BOM付きMarkdownを読み込めます。
- 保存はUTF-8 BOMなしです。
- 保存先と同じフォルダへ一時ファイルを書き、成功時だけ既存ファイルを置換します。
- 開いた文書、または一度保存先を決めた文書は、最後の入力から1秒後に自動保存します。未保存の新規文書は自動で保存ダイアログを開きません。
- Decoration、数式DOM、表DOMなどの表示要素は保存内容へ含めません。
- 保存要求には単調増加するリビジョン番号を付けます。保存中に新しい編集が発生した場合、古い保存結果で未保存状態を解除しません。
- 自動保存に失敗した場合は未保存状態を維持してエラーを表示し、次の入力または手動保存まで再試行しません。
- 新規作成やファイルを開く前は、「保存」「保存せず続行」「キャンセル」を区別できます。

## Markdown表示

- 見出し、太字、斜体、取り消し線、インラインコード、コードブロック、引用、リスト、チェックリスト、表、水平線、リンク、画像を装飾します。
- カーソルまたは選択範囲に重なる箇所は、見出しサイズ、表の枠、コード背景などの装飾を維持したまま、編集に必要なMarkdown記号だけを原文へ戻します。数式と水平線は装飾と原文を併記し、数式原文は通常本文と同じ表示にします。
- インラインコードとコードブロックは、背景や構文色を維持しながら通常本文と同じ字体で表示します。
- 行全体を占める独立数式に空行が隣接する場合、Markdown原文を保持したまま上下各1行を表示上だけ折りたたみます。折りたたんだ行へカーソルまたは選択範囲を移すと再表示します。
- 表は枠と列配置を維持したまま、各セルのMarkdown原文を直接編集できます。
- 上部の「閲覧モード」で本文変更を禁止できます。閲覧中も選択、コピー、検索、スクロール、目次移動、リンク操作を利用でき、選択によって装飾は解除されません。
- 斜体フォントを持たない日本語フォントでも、疑似斜体を使って斜体表示を維持します。
- 行番号ガターは表示せず、行・列、文字数、単語数を上部へ表示します。
- `#`から`######`の見出しから階層目次を作成します。長い項目は折り返し、項目が多い場合は目次内を縦スクロールできます。
- `#`、`##`、`###`の開閉ボタンで配下の見出しをまとめて開閉できます。開閉状態は実行中の目次更新では維持しますが、文書や設定には保存しません。
- 画面幅1200px以上では目次を右側へ常時表示し、狭い画面では右端へマウスを置くかキーボードフォーカスを移すと表示します。`<`と`>`、または`Ctrl + ←`と`Ctrl + →`で240～480ピクセルの範囲を40ピクセルずつ変更できます。
- 目次の項目を選ぶと、対応する見出しが編集領域の中央付近へ来るようにカーソルと表示位置が移動します。
- `Ctrl + L`で目次操作を開始すると、最上部の表示中項目が選択されます。`Ctrl + ↑`と`Ctrl + ↓`で項目と編集位置を同時に移動し、長押しすると移動幅が加速します。同じショートカットで終了します。
- 目次操作中も編集欄がフォーカスを保持するため、通常の文字入力とIME入力は選択した見出し位置へそのまま書き込めます。
- 右上の三点メニューには実装済みのアプリ固有ショートカットをコンパクトに表示します。メニュー外をクリックすると閉じます。
- 検索パネルは編集欄の右上へ表示します。日本語の検索と置換、大文字・小文字、正規表現、単語単位の条件を使用でき、現在位置と総件数を`N / M 件`で表示します。表示中に`Ctrl + F`を押すと閉じます。
- インライン数式は`$E=mc^2$`、独立数式は`$$\frac{a}{b}$$`で記述します。
- KaTeXは`trust: false`で実行し、入力長、展開数、表示サイズに上限を設けます。
- 不正または上限を超える数式は、UIを停止させず原文へフォールバックします。
- ローカル画像はMarkdownの保存フォルダ配下かつ20 MB以下だけを読み込みます。
- 外部画像URLは取得しません。
- 外部リンクとしてOSへ渡すのは`http`、`https`、`mailto`だけです。

## 入力支援

- 箇条書き、番号付きリスト、チェックリスト、引用をEnterで継続します。
- 継続後の空項目で再度Enterを押すと、余分な空行を追加せず構造を終了します。
- 空の引用ではEnterを押すたびに同じ行で1階層ずつ浅くなり、最浅階層では引用を終了します。引用接頭辞直後のBackspaceは末尾の半角スペースだけを削除します。
- 左右キーは装飾表示内でもMarkdown原文を一文字ずつ移動します。
- `Tab`と`Shift + Tab`で字下げ・字上げします。通常行は半角スペース4個、リスト行は2個単位です。複数行選択時も行種別ごとに同じ単位を使います。
- 行頭からカーソルまでが半角スペースだけの場合、`Backspace`は直前の最大4個をまとめて削除します。
- コードフェンス内ではMarkdown構造の補完を抑止します。
- 対括弧、引用符、バッククォートを補完します。
- 補完直後の次の入力が対応する閉じ記号なら、閉じ記号を重複させずカーソルだけ外側へ移動します。この処理は補完ごとに一度だけです。
- バッククォート3個の入力時は閉じフェンスを生成します。
- 補完結果はMarkdown原文へ通常の編集として入り、Undo・Redoできます。

## PDF

PDF出力時は、Markdownから印刷用HTMLを作成し、編集画面と同じKaTeXとCSSを使用します。コードフェンスの言語名を表示し、WebView2の印刷設定で引用、コード、表ヘッダーなどの背景色を保持します。フロントエンドが完了イベントの購読を開始してからWebView2の`PrintToPdf`を呼び出し、一時PDFの生成成功時だけ既存PDFを置換します。PDF用のMarkdown変換コードは操作時に動的読み込みし、通常起動の負荷から分離しています。

## テスト

```powershell
pwsh -NoProfile -File .\scripts\verify.ps1
```

このスクリプトは依存関係を導入せず、TypeScriptのtest・lint・buildとRustのformat・test・clippyを実行します。

## releaseビルド

Tauri本体、Rustランチャー、NSIS、MSIを作成します。

```powershell
pwsh -NoProfile -File .\scripts\build.ps1
```

`build.ps1`はTauri版の`build_tauri.ps1`を呼び出す標準入口です。

主な生成物は次のとおりです。

- `dist\MarkdownQuickMemo\MarkdownQuickMemo.exe`
- `dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe`
- `src-tauri\target\release\bundle\nsis\Markdown Quick Memo_2.0.0_x64-setup.exe`
- `src-tauri\target\release\bundle\msi\Markdown Quick Memo_2.0.0_x64_en-US.msi`

## ログオン登録

```powershell
pwsh -NoProfile -File .\scripts\create_shortcut.ps1
```

別のキーを初期設定する場合は、例えば次のように指定します。

```powershell
pwsh -NoProfile -File .\scripts\create_shortcut.ps1 -Hotkey "CTRL+ALT+Q"
```

`create_shortcut.ps1`はTauri版の`create_tauri_shortcut.ps1`を呼び出す標準入口です。

スクリプトは優先度4、多重起動`IgnoreNew`のログオンタスクを登録します。登録できない場合は現在ユーザーの`Run`キーへフォールバックします。アプリ内のホットキー設定では、登録失敗時に元のキーへロールバックします。

登録状態は次で確認できます。

```powershell
pwsh -NoProfile -File .\scripts\verify_tauri_install.ps1
```
