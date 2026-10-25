# DEV-110 — 承認済みデザイン画像をワンコマンド実行（WSL / local only）

**状態:** PRレビュー用のオフライン実装。実機WSLでは未実行、画像生成0回。既存の和菓子A v4の**未使用承認1回**に限定。実行前に独立Fresh Review・最新HEADの必須CI合格・feature→developマージが必要。既存の `docs/operations/design-image-poc.md` と `wsl-resource-preflight.md` が優先。

## 何が簡単になったか

以前はメモリ確認、worker run.lock、fetch+checkout、prompt SHA確認、Codex実行を複数コマンドで操作していた。新しい `run-wagashi-a-v4-once.sh` は1回の命令で**既存wrapper**を呼び、その中で以下を順番に行う。

1. 明示された承認フラグと固定値（direction v4, prompt SHA256 `4e34f760ccde3f28df58316e9b55e6d21d6ac78d397bf770f6295fb1699157d9`, 4714文字、承認ID `wagashi-a-v4-20261025-01`）を照合する。これ以外には使えない。
2. WSLメモリを計測し、STOPなら中止。workerの同時実行は共有 `run.lock` で排他。workerのtimerは**変更しない**（途中で起動されたworkerも既存lockにより同時実行できない）。ほかのmanual Codexなどlockを使わない重い作業はユーザーが避ける必要がある。
3. checkoutを `origin/develop` へ同期。現在のlockを保持したまま、**実際に送るv4プロンプト**を再組立てしてSHA256・文字数を照合。不一致なら画像生成せず、承認も消費しない。
4. privateな `~/.local/state/sr-design-worker/poc-approval-used/wagashi-a-v4-20261025-01` をatomic `mkdir` で作成。**既にあれば即停止**（前回の成否に関わらず同じ承認は二度使えない）。この時点以降は、起動に失敗・中断・タイムアウトしても**再実行禁止**。誤った結果を「生成未実施」と断定しない。
5. 既存のPoCで許された1回のCodex image generationを試行し、`POC_IMAGE_READY` か `POC_STOP`・`POC_DIAG_SUMMARY` を表示する。55分・15分の既存制限を維持し、自動リトライはしない。

**重要:** 従来のv1〜v3実行手順は変更しない。v4を旧方式でpinなしに実行することはブロックする。これで「承認済みSHAと違うのに実行された」「1回の承認を間違えて繰り返す」を防ぐ。ただしローカルのroot権限保有者が状態ディレクトリを削除する等の悪意ある操作まで技術的に防ぐものではない。

## 1. 一度だけセットアップ

PRが**review+CI greenでdevelopに統合された後**、オーナーがWSL管理者で `sr-designgen` のworker checkoutがそのdevelopを参照することを確認する。worker実行中はcheckoutを変更しない。既存runbookの「SHA確認」（lockを取得してfetch/checkoutするコマンド）を**初回セットアップに限り**実施する。初回は新ファイルをworker checkoutへ置くために必要。

セットアップ時に画像生成やCodexを実行してはいけない。既存のWSL/runbook、`admin.sh` の実パスが想定と異なれば停止。

## 2. 次回からはWindows PowerShellのワンコマンド

（ユーザーの明示承認済みの一回分だけ。実行時に本当に使う意図があることを確認する。）

```powershell
wsl -u root --exec /bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /bin/bash /home/sr-designgen/work/second-root/scripts/sales-design-worker/run-wagashi-a-v4-once.sh --human-approval-confirmed
```

PowerShell内でさらに細かい4コマンドを打つ必要はない。rootがリポジトリの新スクリプトを直接実行するのではなく、**既存の管理用admin.sh**から `sr-designgen` の制限環境で実行する。実PCのsystemd/adminの状態をこのクラウドセッションから確認したわけではない。

## 3. 結果

- `POC_PIN_OK`: 送信予定プロンプトを照合。**生成成功ではない**。
- `POC_APPROVAL_RESERVED`: 1回分を消費扱いにした。**画像生成が成功したという意味ではない**。
- `POC_IMAGE_READY: .../mockup.png`: 画像あり。原本は非公開/リポジトリ外。
- `STOP: POC_PIN_MISMATCH`: Codex未実行、承認未使用。新しいpromptで再承認するか検証。
- `STOP: POC_APPROVAL_ALREADY_USED`: この承認IDは既に使われた。**勝手に消して再試行しない**。
- `POC_STOP` / `POC_DIAG_SUMMARY`: 結果・原因を報告し、再試行しない。
- 上記以外の停止は、`POC_APPROVAL_RESERVED` の有無を確認。予約後なら実際に画像呼出が行われたか不明でも再実行しない。

生成した場合、既存runbookの「Viewing」を用いて**原本を変更せず**、`mockup.png` と `report.json` を管理者経由でWindowsの私用ディレクトリへコピーして確認する。Gitへcommitしない。実画像に人の評価（hard failなし、22/25点以上、各4点以上）が付くまではcomp→siteを実装しない。390px別画像、どら焼き単独素材、公開は別の承認が必要。

## 4. 今回の承認境界と将来の拡張

この入口は**和菓子A v4専用**であり、別店舗・別モデル・別SHAに流用しない。将来のワンコマンド生成には各画像の承認IDとpinを新規で作り、オーナーが**その1回を承認**してから使う。店舗分析・デザイン作成までの自動化を理由に画像利用枠や課金を勝手に使わない。

この開発とtest自体には実Codex、WSL、Worker、Supabase、Production、Staging、develop→mainへの操作を含めない。差分は独立Fresh ReviewとCIで確認する。
