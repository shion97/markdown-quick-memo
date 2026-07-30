- 機能・修正実装後、以下を実行する
## EXE再作成とホットキー動作確認
実装後にWindows向けEXEとログオン設定へ変更を反映するときは、以下の手順に従う。

### 分担

| 担当 | 対象 |
| --- | --- |
| Codex | 関連テスト、EXE再作成、ログオンタスク登録、タスク・プロセス・設定値の非UI検証 |
|  |

Codexは、この確認フローに限ってはComputer Useを使用しない。

### Codexが行う手順

1. 変更箇所に近いテストを実行し、成功を確認する。(既に行なっているならテストは実行しない)
2. `git status --short --branch` で現在のブランチとユーザーの未コミット変更を確認する。
3. `MarkdownQuickMemo.exe` が起動中か確認する。
   - 起動中の場合は強制終了しない。
   - 未保存内容を失う可能性があるため、ユーザーへ `Alt + F4` で完全終了するよう依頼し、終了報告を待つ。
4. 次のコマンドでアプリ本体とホットキーランチャーを再作成する。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

5. ビルドログで、次の2つが正常に作成されたことを確認する。
   - `dist\MarkdownQuickMemo\MarkdownQuickMemo.exe`
   - `dist\MarkdownQuickMemoHotkey\MarkdownQuickMemoHotkey.exe`
6. 次のコマンドでスタートメニューショートカットとログオンタスクを登録する。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\create_shortcut.ps1
```

7. UIを操作せず、次の項目を確認する。
   - タスク `Markdown Quick Memo Hotkey` が存在する。
   - タスクの引数が想定したホットキーになっている。
   - タスクが実行中で、優先度が設定どおりになっている。
   - 旧 `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\MarkdownQuickMemoHotkey` が削除されている。タスク登録に失敗してRunキーへフォールバックした場合は、その事実を報告する。
   - `MarkdownQuickMemoHotkey` と、バックグラウンド待機用の `MarkdownQuickMemo` が起動している。
   - 待機用ウィンドウが準備されるまで必要に応じて短時間待ち、プロセスが異常終了していない。

### 完了判定

- Codex側のビルド・登録・非UI検証が成功している。
- ユーザーから初回表示、再待機、2回目以降の再表示が正常だったと報告されている。
- 問題があった場合は、発生した手順、待ち時間、表示状態、エラーダイアログの内容をユーザーから確認してから原因調査へ進む。
