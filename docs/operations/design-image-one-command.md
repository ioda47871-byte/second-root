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

## 6. DEV-185 — つぐ手の AI デモ写真6枚（1回の real Codex、最大6枚）

**状態:** オフライン実装のみ。この PR の作成時に real Codex・画像生成は**0回**。オーナー承認（Option A）: つぐ手専用、既存の WSL の隔離・画像モデル・制限のまま、1回の Codex 実行で最大6枚。失敗で止まり再試行しない。新しい課金・契約・本番変更なし。画像は**デモ用のイメージ（AI 生成）**で、実在の商品・工房・職人ではない。

**仕組み:** `run-tsugute-photos-once.sh`（user・HOME・cgroup を確認）→ `tsugute-photos-gate.sh`（env allowlist、resource preflight、共有 `run.lock`、HEAD = origin/develop = `--expected-commit`・クリーン、prompt pin をロック中にオフライン照合、承認マーカー `~/.local/state/sr-design-worker/poc-approval-used/tsugute-photos-20261106-01` を atomic `mkdir`）→ `tsugute-photos.ts`（受領レシートを再確認し、既存の bubblewrap sandbox で `codex exec` を**1回**、最大15分、全体3300秒）。プロンプトは `docs/design/tsugute-ai-photo-brief.md` §1・§2 の本文そのまま（SHA256 `dab7f2603c7495c4381035391a24ae98cc8bd07064295233fab034964ec33ed0`、4133文字）で、画像ツールを順に6回呼ぶよう指示する。実行後、Codex 自身のセッションログと画像フォルダで、呼び出し7回以上・PNG 7枚以上なら全体を拒む（画像を渡さない）、失敗した呼び出しがあればそこで止まる。モデルが指示に従わない場合、7回目の呼び出しを実行中に止めることはできない（終了後に拒む）。時間: 過去の実測は1回 33〜55 秒・Codex 全体 98 秒で、6回でも15分に収まる見込み（既存の制限は変えていない）。

**前提:** この PR が独立レビュー・CI green の後に develop へマージ済み。`sr-jail-claude.service` の Claude で `whoami=sr-designgen`、`git status --short` が空、HEAD = origin/develop = マージ後の SHA（§1 の手順で一度だけ更新）、メモリ preflight が STOP でない、ほかの重い作業なし、マーカー `poc-approval-used/tsugute-photos-20261106-01` が**無い**こと。

### 6.1 オーナーが隔離版 Claude に貼るコマンド（1回だけ）

```bash
# EXPECTED_COMMIT を、マージ後の develop の40文字SHAに書き換える。foreground で起動しない。
set -euo pipefail
umask 077
EXPECTED_COMMIT="REPLACE_WITH_REVIEWED_40_CHARACTER_SHA"
[[ "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "STOP: REVIEWED_COMMIT_REQUIRED"; exit 2; }
LOG_DIR="$HOME/sr-design-poc-launch-logs"
install -d -m 0700 "$LOG_DIR"
LOG="$(mktemp "$LOG_DIR/tsugute-photos.XXXXXXXX.log")"
nohup setsid bash "$HOME/work/second-root/scripts/sales-design-worker/run-tsugute-photos-once.sh" \
  --human-approval-confirmed --expected-commit "$EXPECTED_COMMIT" \
  >"$LOG" 2>&1 </dev/null &
echo "POC_LAUNCHED_PID=$! LOG=$LOG"
```

起動直後に PID の生存を確かめ、その後は数分おきに別の短いコマンドで `tail -n 30 <LOG>` とプロセスの生存を見る（§2 と同じ。開始後は service の停止・再起動、同じ checkout の変更、別の Codex/worker をしない）。

### 6.2 結果の読み方

- `POC_PIN_OK` … プロンプト照合のみ。生成ではない。
- `POC_APPROVAL_RESERVED` … 承認を消費した。以後、結果がどうであれ**再実行しない**・マーカーを消さない。
- `POC_IMAGES_READY: ~/sr-tsugute-photos/tsugute-photos-XXXXXX` … 6枚あり（`status: complete`）。直前の JSON 行に枚数・呼び出し回数・モデル・各枠の画素（`(<2x)` は 2倍未満、`(<1.5x)` は 1.5倍未満）。
- `POC_MANIFEST: …/manifest.json` … slot → ファイル・SHA256・画素・プロンプトの SHA・generator・model・generated_at。止まった場合も残る。
- `POC_STOP: CODEX_IMAGE_CALLS_EXCEEDED` … 7回以上呼ばれた。画像は保存されない。`CODEX_IMAGE_TOOL_FAILED` / `CODEX_TIMEOUT` / `CODEX_QUOTA` / `CODEX_IMAGES_INCOMPLETE` / `CODEX_IMAGE_COUNT_MISMATCH` / `CODEX_SESSION_LOG_UNVERIFIED` … 止まった（それまでの画像は記録用に残るが取り込みは拒む）。報告して止まる。
- `STOP: POC_PIN_MISMATCH*` / `POC_COMMIT_PIN_MISMATCH` / `POC_TSUGUTE_APPROVAL_SCOPE_MISMATCH` … Codex 未実行・承認未使用。
- `STOP: POC_APPROVAL_ALREADY_USED` … 既に使った。**消して再試行しない**。

出力ディレクトリは 0700、各ファイルは 0600、リポジトリの外。Git に入れない。

### 6.3 続き（Claude が行う）: d1-v10 への取り込みと PC/SP の描画

オーナーは `~/sr-tsugute-photos/tsugute-photos-XXXXXX/` を**丸ごと**（6枚の PNG と `manifest.json`、改変しない）、Claude が作業する機械の**リポジトリの外**の私用の場所へコピーする（例: 既存 runbook の Viewing と同じく管理者経由で Windows の私用フォルダ → Claude のセッションの scratchpad）。公開の場所・Issue・PR には置かない。その上で Claude が、クリーンな作業用 checkout（worker の checkout ではない）で:

```bash
RUN_DIR=/path/outside/repo/tsugute-photos-XXXXXX
npx tsx scripts/design-artifact/tsugute-ai-intake.ts --from "$RUN_DIR" \
  --manifest-out design-library/research/quality-pipeline/.intake/tsugute-ai-swap.json
npx tsx scripts/design-artifact/photo-swap.ts \
  --page design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v10 \
  --manifest design-library/research/quality-pipeline/.intake/tsugute-ai-swap.json \
  --out /path/outside/repo/tsugute-ai-swap
```

- 取り込みは `status: complete`・6枚・SHA・画素・model の報告を確かめ、PNG を `.intake/photos/tsugute-ai-<slot>.png`（git が無視）へそのまま写し、`source_kind: ai_generated_demo`（来歴: generator・model・generated_at・prompt_sha256・approval_id・demo_only）の権利の記録を作る。
- 差し替えは既存の検査（SHA・画素・2倍、主役の箱、全部か無し）を通った時だけ `renders/desktop_1440.png`・`mobile_390.png` と `swap-summary.json`（各写真に「AI-generated demo image… Not a real product, workshop or craftsperson」）を作る。
- 枠への割り当ては画像ファイルの保存順（呼び出し順）による。オーナーは描画で**各枠に正しい被写体が写っていること**（割れ・欠け・ひび・乾燥・手元・机）を目で確かめる。
- オーナー承認 (a): `ai_generated_demo` の画像だけ、枠の 2倍の目標に届かない時に限り、届く最小の倍率（最大2倍、既存の sharp lanczos3）で取り込み時に拡大し、元の大きさ・倍率・方法を来歴と公開の記録に残す。2倍でも届かない枠は `UPSCALE_EXCEEDS_2X` で拒み採用しない。差し替えの密度の検査は拡大後のファイルに掛かる。実写真の規則は不変。
- 取り込みは manifest が承認済みの実行のものか（prompt SHA256・文字数、各枠のプロンプト SHA256、generator、デモのラベル）を照合し、違えば拒む。
- **オーナーの判断が要りうる点:** 2倍の拡大でも届かない枠（`UPSCALE_EXCEEDS_2X`）、ph-dry が SP で主役を失う場合（`SP_PHOTO_REQUIRED`）。いずれも Claude は勝手に例外を書かず、生成もやり直さず、オーナーへ報告する。
