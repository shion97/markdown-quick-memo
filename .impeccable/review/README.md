# UI/UX改善の画面検証

2026-10-28。ユーザー採用案: `../mocks/decision/paper.html`。

保存だけを模擬したブラウザー画面を、同梱Playwrightと既存Edgeで記録した。元の確認ページは `tmp/uiux-preview.html`、同じ内容を `tests/fixtures/uiux-preview.html` に保存している。通常のVite開発サーバーから後者を開いて再現できる。実ファイルへの保存やWindowsのネイティブダイアログは検証対象外。

| キャプチャ | 条件 |
| --- | --- |
| desktop.png | 1440×900、ライト |
| dark.png | 1440×900、ダーク |
| narrow.png | 664×524、ライト |
| minimum.png | 560×420、ダーク（アプリの最小サイズ） |
| menu.png | 664×524、実行メニュー・下部の設定／終了 |
| empty.png | 664×524、空文書 |
| error.png | 664×524、模擬保存失敗・原因・再試行 |
| tabs.png / outline.png | 664×524、パネルを開いた状態 |
| shortcuts.png | 560×420、説明専用の一覧 |

再現時は `?theme=dark`、`?menu`、`?empty`、`?error`、`?tabs`、`?outline`、`?shortcuts` を付ける。ブラウザーの実メディア設定でもライト／ダークを指定した。本文とファイル名は画面検証用サンプル。

最終レビューの指摘A11Y-01は、保存エラーの同値DOM再設定による読み上げの反復。回帰条件の失敗を確認してから修正し、同じ10状態を再撮影した。全キャプチャの寸法・更新時刻・正常内容を確認。指摘の再評価は`ship`、A11Y-01は解消済み。

機械検査の残る警告は既存のMarkdown引用とPDF引用の4px左線の2件。今回のUIで追加した装飾ではない。

Windows実機のIME・表示倍率・実ホットキー・ネイティブ保存操作は別途受入が必要。配布EXE更新と登録の非UI検証は `docs/UIUX導入記録.md` に記録する。
