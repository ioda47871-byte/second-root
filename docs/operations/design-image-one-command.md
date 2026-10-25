# DEV-110 — 承認済みデザイン画像をワンコマンド実行（WSL / local only）

**状態:** PRレビュー用のオフライン実装。実機WSLでは未実行、画像生成0回。既存の和菓子A v4の**未使用承認1回**に限定。実行前に独立Fresh Review・最新HEADの必須CI合格・feature→developマージが必要。既存の `docs/operations/design-image-poc.md` と `wsl-resource-preflight.md` が優先。

## 何が簡単になったか

以前はメモリ確認、worker run.lock、fetch+checkout、prompt SHA確認、Codex実行を複数コマンドで操作していた。新しい `run-wagashi-a-v4-once.sh` は1回の命令で**既存wrapper**を呼び、その中で以下を順番に行う。

1. 明示された承認フラグと固定値（direction v4, **独立Fresh Reviewを通ったマージ後のdevelopコミットSHAを実行時に明示指定**, prompt SHA256 `4e34f760ccde3f28df58316e9b55e6d21d6ac78d397bf770f6295fb1699157d9`, 4714文字、承認ID `wagashi-a-v4-20261025-01`）を照合する。これ以外には使えない。
2. WSLメモリを計測し、STOPなら中止。workerの同時実行は共有 `run.lock` で排他。workerのtimerは**変更しない**（途中で起動されたworkerも既存lockにより同時実行できない）。ほかのmanual Codexなどlockを使わない重い作業はユーザーが避ける必要がある。
3. 今回のオーナーから**明示されたreview済みdevelopのコミットSHA**を使い、checkoutを変更せず、同じworker lockの下で HEAD・origin/develop・クリーンな作業ツリーを検証する。Git fetch / checkout / clean / npm ciはしない。そのままv4プロンプトを再組立てしてSHA256・4714文字を照合する。不一致ならCodex呼び出しも承認消費もせずSTOPする。
4. privateな `~/.local/state/sr-design-worker/poc-approval-used/wagashi-a-v4-20261025-01` をatomic `mkdir` で作成。**既にあれば即停止**（前回の成否に関わらず同じ承認は二度使えない）。この時点以降は、起動に失敗・中断・タイムアウトしても**再実行禁止**。誤った結果を「生成未実施」と断定しない。
5. 既存のPoCで許された1回のCodex image generationを試行し、`POC_IMAGE_READY` か `POC_STOP`・`POC_DIAG_SUMMARY` を表示する。55分・15分の既存制限を維持し、自動リトライはしない。

**重要:** SHA不一致なら同一ロック内で実行を拒否し、さらに`run.ts`が**Codexに実際に渡すプロンプト**のSHA/文字数を再確認する。パスワードや認証データをログに書かず、worker/timerも変更しない。モデル呼出後の結果不明は承認消費扱いとして再試行しない。

**重要:** 従来のv1〜v3実行手順は変更しない。v4を旧方式でpinなしに実行することはブロックする。これで「承認済みSHAと違うのに実行された」「1回の承認を間違えて繰り返す」を防ぐ。ただし同一ユーザー `sr-designgen` は自分の私有stateを削除・改変できるため、このマーカーは誤再実行を防ぐ安全装置であり、悪意ある同一ユーザーを防ぐ強固な権限境界ではない。オーナーの1回承認と分離した隔離設定は引き続き必須。

## 1. 一度だけセットアップ

PRが**review+CI greenでdevelopに統合された後**、オーナーがWSL管理者で `sr-designgen` のworker checkoutがそのdevelopを参照することを確認する。worker実行中はcheckoutを変更しない。既存runbookの「SHA確認」（lockを取得してfetch/checkoutするコマンド）で一度だけ更新する。初回は新ファイルをworker checkoutへ置くために必要。**この入口は実行時引数`--expected-commit`でレビュー・マージ後の正確なHEADを指定する。** 入力したHEADと実機HEAD・origin/developが一致しない場合はSTOPし、承認済みの画像生成は使わない。すでに現在の実checkoutのHEADが`9b79163825368d53bc066693b03cc21f7702b67d`まで更新されたことはオーナーのread-only確認で既知だが、DEV-110新ファイルを使うには**独立review後にマージされたdevelopのコミットへ更新**が必要。そのコミットSHAをオーナーが確認して一度だけ実行時に指定する。

セットアップ時に画像生成やCodexを実行してはいけない。既存のWSL/runbook、`admin.sh` の実パスが想定と異なれば停止。

## 2. ブラウザのClaude Remote Controlから実行する（既存の隔離版のみ）

2026-10-25、オーナーがブラウザから操作する**既存の**`sr-jail-claude.service` の Claude を確認済み：
`whoami=sr-designgen`、`pwd=/home/sr-designgen/work/second-root`、
`/proc/self/cgroup=0::/system.slice/sr-jail-claude.service`。
通常の `ioda0` ユーザーで作成したテスト用 Remote Control からは起動しない。

**実行する前**：最新HEADの必要CIと独立Fresh Review PASSの後にこのPRを`develop`へマージすること。
既存セッション内では `git status --short` が空であること、`HEAD`が想定の承認済み`develop`であること、
メモリpreflightがSTOPでないこと、ほかの重い作業が同時に走っていないこと、
前回の承認IDのレシートが存在しないことを先に確認する。
SHA pinは、wrapperが自分でworkerロックを取得し、**チェックアウトを更新せず**、承認済みコミット・クリーンな作業ツリーと実際のプロンプトを**同じロック保持中**に再検証する。コミットやプロンプトが違えばCodexは起動せず、承認IDも消費されない。
`bash -n`とオフラインテスト・reviewを通していないコードでは絶対に実行しない。

```bash
# ブラウザの隔離版Claudeに頼む「一度だけ」の実行手順。
# EXPECTED_COMMITの右側を、独立レビュー後のdevelopコミット40文字SHAへ変更する。
# foregroundで起動しない。ClaudeのBashコマンド時間切れが
# Codexを停止させ、1回だけの承認を失う可能性があるため。
set -euo pipefail
umask 077
EXPECTED_COMMIT="REPLACE_WITH_REVIEWED_40_CHARACTER_SHA"
[[ "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "STOP: REVIEWED_COMMIT_REQUIRED"; exit 2; }
LOG_DIR="$HOME/sr-design-poc-launch-logs"
install -d -m 0700 "$LOG_DIR"
LOG="$(mktemp "$LOG_DIR/wagashi-a-v4.XXXXXXXX.log")"
nohup setsid bash "$HOME/work/second-root/scripts/sales-design-worker/run-wagashi-a-v4-once.sh" \
  --human-approval-confirmed --expected-commit "$EXPECTED_COMMIT" \
  >"$LOG" 2>&1 </dev/null &
echo "POC_LAUNCHED_PID=$! LOG=$LOG"
```

**起動直後の最初の短い確認でPIDが生存していることを確かめる**（Claude CodeのBash隔離機構がバックグラウンドを即時終了する環境もある）。数分おきに**別の短いコマンド**で `tail -n 35 <LOGの実際のパス>` とプロセスの生存を確認する。最初の短い起動コマンドが返っただけでは生成成功でも失敗でもない。終了したら `POC_IMAGE_READY`／`POC_STOP`／`POC_APPROVAL_RESERVED` の有無とプロセス終了状態を記録する。**ログは0600、保存先は0700、Gitへ追加しない**。画面共有・ログの全文貼付で認証情報を漏らさない。

**開始後は `sr-jail-claude.service`、`sr-jail-net.service`を停止・再起動・更新しない**。同じcheckoutでGit更新・ファイル変更・別のCodex/workerを行わない。WSLやPCをシャットダウンしない。起動プロセスは独立したsessionになっても**同じsystemd cgroupに属する**ため、service再起動で終了する。この残余リスクは残る。タイムアウト／再起動／クラッシュで承認レシートが存在した場合、画像がなくても勝手に再試行・レシート削除しない。

ここで起動するのはroot権限のない `sr-jail-claude.service` に属するプロセスだけ。
スクリプトは実効ユーザー、HOME、cgroupを確認してから既存のworker wrapperを呼ぶ。
Codexには既存のbubblewrap、env allowlist、image-toolの検証、最大15分の制限を適用。
whole-PoCはwrapper独自の最大3300秒budgetで終了する。
root運用の`admin.sh run`には別にsystemdの`RuntimeMaxSec=3500`があるため、
**両経路が完全に同一というわけではない**（Remote Control経路は同じ既設jailのcgroupに入る）。
期限・途中停止・異常結果では追加呼び出しは行わず報告する。

なお、これは **v4 / 4714 chars / 承認済みのSHAに限る one-time entrypoint** である。
承認記録フォルダを消して再利用することも、画像や資産を転用することも禁止。

## 3. 代替経路について

今回のワンショット入口は、ブラウザから接続済みの `sr-jail-claude.service` 専用。`admin.sh run` は別のcgroupで動くため、この入口はそこで実行するとSTOPする。rootの既存runbookを用いる場合は専用の手順と事前承認条件を別途確認すること。root権限の拡張や新しいsudoersは行わない。

## 4. 結果

- `POC_PIN_OK`: 送信予定プロンプトをモデル無しで照合（さらにCodex実行時も同一SHAを検査）。**生成成功ではない**。
- `POC_APPROVAL_RESERVED`: 1回分を消費扱いにした。**画像生成が成功したという意味ではない**。
- `POC_IMAGE_READY: .../mockup.png`: 画像あり。原本は非公開/リポジトリ外。
- `STOP: POC_PIN_MISMATCH` / `POC_PIN_MISMATCH_OR_CHECK_ERROR`: Codex未実行、承認未使用。新しいpromptで再承認するか検証。
- `STOP: POC_APPROVAL_ALREADY_USED`: この承認IDは既に使われた。**勝手に消して再試行しない**。
- `POC_STOP` / `POC_DIAG_SUMMARY`: 結果・原因を報告し、再試行しない。
- 上記以外の停止は、`POC_APPROVAL_RESERVED` の有無を確認。予約後なら実際に画像呼出が行われたか不明でも再実行しない。

生成した場合、既存runbookの「Viewing」を用いて**原本を変更せず**、`mockup.png` と `report.json` を管理者経由でWindowsの私用ディレクトリへコピーして確認する。Gitへcommitしない。実画像に人の評価（hard failなし、22/25点以上、各4点以上）が付くまではcomp→siteを実装しない。390px別画像、どら焼き単独素材、公開は別の承認が必要。

## 5. 今回の承認境界と将来の拡張

この入口は**和菓子A v4専用**であり、別店舗・別モデル・別SHAに流用しない。将来のワンコマンド生成には各画像の承認IDとpinを新規で作り、オーナーが**その1回を承認**してから使う。店舗分析・デザイン作成までの自動化を理由に画像利用枠や課金を勝手に使わない。

この開発とtest自体には実Codex、WSL、Worker、Supabase、Production、Staging、develop→mainへの操作を含めない。差分は独立Fresh ReviewとCIで確認する。
