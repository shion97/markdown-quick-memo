## EXE再作成とホットキー動作確認

実装後にWindows向けEXEとログオン設定へ変更を反映するときは、以下の分担と手順に従う。

### 分担

| 担当 | 対象 |
| --- | --- |
| Codex | 関連テスト、EXE再作成、ログオンタスク登録、タスク・プロセス・設定値の非UI検証 |
| ユーザー | 実際のホットキー入力、ウィンドウ表示、フォーカス、再待機、再呼び出しの目視・操作確認 |

Codexは、この確認フローではComputer Useを使用しない。実際のキー入力やウィンドウ操作を自動化せず、ユーザーへ確認手順を案内する。ユーザーから結果が報告されるまでは、「実際のホットキー動作を確認済み」と報告しない。

### Codexが行う手順

1. 変更箇所に近いテストを実行し、成功を確認する。
2. `git status --short --branch` で現在のブランチとユーザーの未コミット変更を確認する。
3. `MarkdownQuickMemo.exe` が起動中か確認する。
   - 起動中の場合は強制終了しない。
   - 未保存内容を失う可能性があるため、ユーザーへ `Ctrl + Q` で完全終了するよう依頼し、終了報告を待つ。
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
8. 以下の「ユーザーが行う確認」を提示し、結果の報告を依頼する。

### ユーザーが行う確認

1. `Ctrl + Alt + M` を押す。
2. Markdown Quick Memoのウィンドウが表示され、編集欄へすぐ入力できることを確認する。
3. `Alt + F4` またはウィンドウの閉じるボタンで画面を閉じる。
4. タスクマネージャー上でアプリが終了せず、バックグラウンド待機へ戻ることを確認する。
5. 再度 `Ctrl + Alt + M` を押し、同じウィンドウが速やかに再表示されることを確認する。
6. 必要に応じて短い文字列を入力して手順3から5を繰り返し、待機中も編集内容が保持されることを確認する。
7. 確認後、完全終了したい場合は `Ctrl + Q` を押す。

### 完了判定

- Codex側のビルド・登録・非UI検証が成功している。
- ユーザーから初回表示、再待機、2回目以降の再表示が正常だったと報告されている。
- 問題があった場合は、発生した手順、待ち時間、表示状態、エラーダイアログの内容をユーザーから確認してから原因調査へ進む。
