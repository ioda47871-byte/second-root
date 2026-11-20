# IMAGE_FIRST worker adapter — 怪異読本 WSL Worker からの移植表と手順（Issue #298 P1）

2026-11-20。Issue #298 P1（オフライン、実 Codex なし）。**これは承認ではない。** このコードが develop に入っても、
オーナーが承認パケット（`docs/design/image-first-hoshigama-p3-packet.md`）の §10 を記入して develop に入れるまで、
worker は何も呼ばない（`no_job`）。実機への導入と最初の実画像生成は P2（別のオーナー承認）である。

- 移植元（読むだけ。変更していない）: curiosity-media `main` `2e7a673b10c1cc61ed60aeb60bd9be5f16701437`
- 追加したもの: `lib/design-agent/imagefirst-worker/cycle.ts`（1 回の cycle）、`scripts/sales-design-worker/imagefirst-worker.ts`（手で起動する入口）、
  `tests/unit/design-agent/imagefirst-worker/cycle.test.ts`（偽 Codex の E2E と fail-closed）
- 渡す先: 既存の入口 `scripts/design-artifact/image-first-generate.ts`（変更なし）。承認・コミット pin・一度使い切り・再試行なし・6 枚・15 分は、
  すべてこの入口と `lib/design-agent/phase2f-live/{full-page-call,ledger,steps}.ts` が持つまま。adapter は条件を足すだけで、緩めない。

## 1. 移植表

| 関心事 | 怪異読本の原本（2e7a673） | Second Root での扱い |
|---|---|---|
| (a) ChatGPT サインインだけ・API キーの隔離・環境の除去 | `packages/automation/src/codex-image.ts`（`CODEX_BLOCKED_ENV`、`codexEnvironment`、`assertChatGptSignIn`）、`scripts/entry-image-worker.mts`（設定 dir をリポジトリの外に） | **移植しない: Second Root に既にある。** `lib/design-agent/codex.ts`（同じ `CODEX_BLOCKED_ENV`・`codexEnvironment`・`assertChatGptSignIn`・`.env` 拒否、原本を引用済み）、`lib/design-agent/worker/env.ts`（許可した名前だけを子へ渡す allowlist。原本の「消す名前の一覧」より強い）、`lib/design-agent/sandbox.ts`（bubblewrap の jail）。adapter は入口を `childEnvironment(process.env)` で起動し、入口の中の `generateImagesInOneRun` がサインインと `.env` を確かめる |
| (b) 無人起動・期限・process group の kill・排他 | `bounded-process.ts`（`runBounded`、`killAllBoundedChildren`、`WorkerDeadline`）、`entry-image-worker.ts` `acquireLock`、`scripts/entry-image-worker.mts`（signal と watchdog） | **移植しない: 既にある。** `lib/design-agent/bounded-process.ts`（原本の移植。group へ SIGTERM→SIGKILL、`signal` 対応）、`lib/design-agent/worker/state.ts` `acquireLock`（原本の移植に boot id と開始時刻を足したもの）、`scripts/design-artifact/phase2f-live-cli.ts` `stopSignals`/`runMain`。adapter は lock 名 `imagefirst.lock` で `acquireLock` を使い、入口を `runBounded` で 1 回起動する（入口の watchdog 20 分 + 2 分で group ごと kill）。**直したもの 1 つ**: `runBounded` が出力を chunk ごとに UTF-8 へ変えていたため、読みが割れると日本語が壊れることがあった（`git show` で読むパケットが負荷の下で `PACKET_NOT_APPROVED` になった）。stream の decoder に変えた |
| (c) 承認されたコミットからだけ動く | `entry-image-worker.ts` `assertOnOriginMain`（HEAD = origin/main、作業木がきれい）、承認 file は pin の直後に読む | **移植（考え方）**: `cycle.ts` の最初の段。origin/main → **origin/develop**、承認の正本は main 上の JSON → **HEAD のコミットに入っているパケット**（`fileAtCommit` で `git show`。作業木は読まない）。fetch と detach は既存の `run.sh` と同じ手順を手で行う（§5）。入口自身も HEAD = origin/develop = `--expected-commit` を確かめ直す |
| (d) 一度だけの消費 | `body-image-approvals.ts` `claimBodyImageApproval`（使う直前に state dir へ `O_EXCL` の印。EEXIST = 使用済み、他の失敗も OFF） | **移植**: `cycle.ts` `claim`（`<state>/claims/<承認 ID>.used`、`O_EXCL|O_NOFOLLOW`、0600）。印は入口を起動する直前に作り、結果にかかわらず消さない。入口の ledger（`phase2f-live/ledger.ts`、atomic mkdir）は**そのまま**で、adapter はその `precheck` を読むだけ。二重の一度使い切り（adapter の印 + 入口の ledger） |
| (e) 出力と検証 | `codex-image-diagnostics.ts`（セッション記録から画像ツールの事実）、`entry-image-worker.ts` の検査と記録 | **移植しない: 既にある。** `lib/design-agent/design-image/capability.ts`・`diagnostics.ts`・`image-once.ts`（セッション記録の読み取り、PNG 検査、停止コード）。adapter が足したのは**非公開の受け取り**だけ: run ディレクトリ（`~/sr-runs/<承認 ID>-<UTC>/`、0700、入口が作る）を読み直し、各画像の SHA-256 をディスク上で計算して入口の `call.json` の SHA と照合し、`<承認 ID>-<UTC>.receipt.json`（0600）にコード・SHA・枚数・時刻だけを書く（プロンプト文も秘密も書かない） |
| GitHub の認証 | `scripts/worker-github-client.mts`（App の短期 token / PAT） | **移植しない。** adapter は GitHub に何も書かない（画像・PR・Issue なし）。読むのは `git fetch` だけで、既存の worker clone の手順（`run.sh` と同じ）を使う |

### 移植しないもの（Issue #298 の指定）

- 記事の自動発見（画像の無い公開済み記録を並べる）、自動公開、記事 PR への重ね合わせ
- 最大 3 回の再試行・記録ごとの再挑戦（`record-retryable`）。**IMAGE_FIRST は 1 承認 = 1 回、再試行なし**
- 画像の GitHub への commit / PR、Issue の自動作成
- サイト識別子（`kaii-dokuhon`）、Claude の長期 token、監査用の Claude 呼び出し
- 写真生成の旧 `bakery` manifest・root の grant（`image-autorun.ts`、`/etc/sr-design-worker/image-autorun.json`）。IMAGE_FIRST はこれを使わない

## 2. 入口の呼び方（設計の選択）

adapter は既存の入口を**別の process として 1 回起動する**（`runBounded`、自分の process group、許可した環境だけ）。in-process で
`runFullPageCall` を呼ばない理由:

1. 入口が**そのまま**動く。サンドボックスの準備・`.env` の確認・watchdog・signal・ledger・コミット pin・パケットの再読み込みは入口のコードで、
   adapter は同じ確認をもう一度するだけ（二重の確認）。adapter に不具合があっても、入口の門は残る。
2. adapter は Codex・画像ツール・サンドボックスを一切 import しない（テストで固定）。画像を呼べるコードの一覧
   （`generateImagesInOneRun` を呼ぶファイルの固定リスト）は**増えない**。
3. 15 分を超えた・止められたときは、入口ごと group で終わる。

引数はすべて、承認コミットのパケット（§10 の承認 ID・期限・計画 ID、パケット自身の SHA-256）と、コードに固定した許可一覧
（`IMAGEFIRST_ALLOWLIST`: `hoshigama`、`d3` だけ、§3 の d3 の計画 SHA・バッチ SHA・文字数）から作る。ジョブファイルも自由な文字列も無い。
`--human-approval-confirmed` は、オーナーが記入して develop に入れた §10 を指す（入口がその §10 を自分で読み直す）。

## 3. 1 回の cycle

lock → HEAD = origin/develop かつ作業木がきれい → HEAD のパケットを読む → 未承認なら `no_job` →
方向性が `d3` だけ（`d1`・`d1,d3` は `SCOPE_NOT_ALLOWED`）→ 承認 ID が `hoshigama-imagefirst-d3-YYYYMMDD-NN`（他の店は `SHOP_NOT_ALLOWED`）→
期限が過ぎていない・24 時間以内 → §3 の d3 のピンと、HEAD の入力から作り直した計画が固定値と同じ（`PACKET_PIN_MISMATCH` / `PLAN_*`）→
この worker が使っていない（`APPROVAL_ALREADY_CLAIMED`）・入口の ledger で未使用（`APPROVAL_ALREADY_USED`）→ 印 → 入口を 1 回 →
run ディレクトリを読み直して receipt → unlock。拒否はどれも何も起動しない。2 本目の同時起動は `locked`（`WORKER_LOCKED`）。

出力（標準出力 1 行の JSON、`<state>/audit.jsonl` にも同じ行）: `status` = `no_job` / `locked` / `refused` / `succeeded` / `stopped`、`code`、`invoked`。
終了コード: 0 = no_job・locked・succeeded、2 = refused（何も起動していない）、1 = 起動して止まった（承認は使用済み）。

置き場所（すべてリポジトリの外、0700）: state `~/.local/state/sr-design-worker/imagefirst-worker/`（`imagefirst.lock`、`claims/`、`audit.jsonl`）、
結果 `~/sr-runs/<承認 ID>-<UTC>/` と（`~/sr-runs` は無ければ 0700 で作る。既にあって group / other に開いている・link・他人の所有なら `RUNS_DIR_UNSAFE`） `~/sr-runs/<承認 ID>-<UTC>.receipt.json`、入口の ledger（`~/.local/state/sr-design-worker/phase2f-live/`、変更なし）。

## 4. 偽 Codex の E2E（`tests/unit/design-agent/imagefirst-worker/cycle.test.ts`）

一時 git リポジトリ（自前の origin/develop）に、テスト内で記入した d3 のパケット（リポジトリには commit しない）と 3 つの入力を置き、cycle を走らせる。
入口は `image-first-generate.ts` の main と同じ手順を in-process で再生し（同じフラグ・`runFullPageCall`・バッチの写し方。フラグの一致はソースから読んで検査）、
画像は image-once のテストと同じ in-process の偽サンドボックスが返す（PC 2 + SP 4）。確かめること: 1 回の起動・1 回の Codex 実行・6 枚・receipt の SHA = ファイル・停止コード null、
その後の 2 回目は拒否。fail-closed: 未承認、期限切れ・24 時間超、HEAD ≠ origin/develop・作業木が汚れている（作業木だけに承認済みパケットがある場合も）、
`d1`・`d1,d3`、他の店、ledger で使用済み、§3 のピンの改ざん・入力の改ざん、同時の 2 本目（lock）、偽 Codex の失敗（停止コードを記録、再試行なし）、
入口が kill された場合（承認は使用済み、再試行なし）。

## 5. オーナーの手順（P2 の承認の後だけ。いまは読むだけ）

**timer も systemd unit も作らない・enable しない。** root 所有の script と許可一覧（`image-autorun` の grant、`cycle.sh`）は変えない。

読むだけの確認（何も変えない。WSL の `sr-designgen` で）:

```
scripts/ops/wsl-resource-preflight.sh              # STOP なら始めない
cd <worker の clone> && git fetch --quiet --no-tags origin "+refs/heads/develop:refs/remotes/origin/develop"
git rev-parse HEAD origin/develop && git status --porcelain --untracked-files=all
git show origin/develop:docs/design/image-first-hoshigama-p3-packet.md | sed -n '/^## 10\./,$p'   # §10 が d3 だけで承認済みか
ls -ld ~/.local/state/sr-design-worker ~/sr-runs 2>/dev/null
systemctl --user list-timers --all | grep -i sr- || true   # 何も enable されていないこと
codex login status                                        # ChatGPT でサインインしていること（API キーではない）
```

起動（1 回。§10 の期限の 24 時間以内）:

```
cd <worker の clone>   # run.sh と同じ専用 clone。場所は実機で確かめる（P2）
git checkout --quiet --force --detach origin/develop && git clean -q -f -d
./node_modules/.bin/tsx scripts/sales-design-worker/imagefirst-worker.ts
```

承認が未記入なら `{"status":"no_job","code":"PACKET_NOT_APPROVED",...}` で何もせずに終わる。`succeeded` なら `run_dir` と `receipt` の場所が出る。
受け渡しは従来どおり `tar` と `SHA256SUMS` でオーナーへ（receipt の SHA と照合する）。**GitHub へは push しない**（画像・プロンプト・manifest のどれも）。

停止: 端末なら Ctrl-C（入口が呼び出しを `aborted` として記録する。20 秒後に group ごと kill）。別の端末からなら
`pkill -TERM -f scripts/sales-design-worker/imagefirst-worker.ts`。止めても承認は使用済みのまま（作り直しには新しい承認 ID）。

戻し方: adapter は状態を 3 か所にしか書かない（§3 の置き場所）。使わなくするには起動しないだけでよい（timer は無い）。
コードを戻すときは develop で revert する。`claims/` と入口の ledger は**消さない**（消すと同じ承認 ID が再び使える状態になる）。
