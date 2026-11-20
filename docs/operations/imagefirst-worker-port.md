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
| (f) 毎時の起動（Issue #302 P1） | `docs/operations/kaii-image-worker-wsl.md` §6: `~/kaii-image-worker/run.sh`（`flock -n`、`timeout` で各段を切る、`git fetch` → detach → install → worker）、`kaii-image-worker.service`（oneshot、`TimeoutStartSec=3600`）と `.timer`（毎時 `:17`、`Persistent=true`）。原本は unit をリポジトリに置かず runbook に書く | **形を再利用、置き場所と権限を変えた（§6）。** wrapper `scripts/sales-design-worker/imagefirst-autostart.sh`（`flock -n`・各段の `timeout`・fetch → 早送り → 必要なら `npm ci` → worker 1 回、は原本と `run.sh` の形）。unit/timer `scripts/sales-design-worker/systemd/sr-imagefirst-autostart.{service,timer}`（oneshot・毎時・`Persistent=true` は原本どおり、`TimeoutStartSec=3900`。user unit ではなく root の system unit にしたのは、使い切りの印を worker が作れない場所に置くため。**install も enable もしない**） |

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
（Issue #302 P1 で、OFF のままの自動起動を §6・§7 に足した。手で起動するこの手順はそのまま使える。）

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
# node with the tsx loader: the tsx CLI would pass Ctrl-C on a second time (= the hard stop, no graceful receipt)
node --import tsx scripts/sales-design-worker/imagefirst-worker.ts
```

承認が未記入なら `{"status":"no_job","code":"PACKET_NOT_APPROVED",...}` で何もせずに終わる。`succeeded` なら `run_dir` と `receipt` の場所が出る。
受け渡しは従来どおり `tar` と `SHA256SUMS` でオーナーへ（receipt の SHA と照合する）。**GitHub へは push しない**（画像・プロンプト・manifest のどれも）。

停止: 端末なら Ctrl-C（入口が呼び出しを `aborted` として記録する）。別の端末からなら
`pkill -TERM -f scripts/sales-design-worker/imagefirst-worker.ts`。止めても承認は使用済みのまま（作り直しには新しい承認 ID）。
止めた実行も**必ず receipt と audit の 1 行で終わる**（停止コード `WORKER_INTERRUPTED`、`interrupted: true`。Issue #302 P0、PR #301 review L1）。
時間の順（`cycle.ts` の `WORKER_STOP`）: 入口は自分の 20 秒の hard stop と 10 秒の後片付けで止まる → worker は 35 秒待ってから入口の group を
SIGKILL し、receipt を書く → worker 自身が 50 秒たってもまだ待っている（または 2 回目の Ctrl-C）ときだけ、すべてを kill して、ディスク上の
画像から receipt を書く（最大 10 秒）。どの経路でも再試行はしない。

印（`claims/<承認 ID>.used`）は、`stateDir` と `claims` を `O_DIRECTORY|O_NOFOLLOW` で開いた handle に対して作る（Linux の `/proc/self/fd`
経由。PR #303 review L1）。lstat の確認のあとで path が差し替えられても、印は外へ向かない。

戻し方: adapter は状態を 3 か所にしか書かない（§3 の置き場所）。使わなくするには起動しないだけでよい（timer は無い）。
コードを戻すときは develop で revert する。`claims/` と入口の ledger は**消さない**（消すと同じ承認 ID が再び使える状態になる）。

## 6. 自動起動（Issue #302 P1、pull 方式、既定で OFF）

**状態: コードと手順だけ。WSL には install も enable もしていない。** この節のコードが develop に入っても、オーナーが §7 の手順を
WSL の root で行うまで何も動かない。入れたあとも、オーナーの switch と使い切りの印（どちらも root 所有）が無ければ何もしない。
実 Codex での最初の生成は、従来どおり承認パケット §10 と P3 の個別承認が要る。

クラウドの Claude は WSL に入らない（SSH・公開ポート・self-hosted runner なし）。WSL 側の timer が毎時、GitHub の `origin/develop` を
自分で取りに行き、オーナーが §10 を記入して develop に入れたコミットを見つけたときだけ、既存の worker（`imagefirst-worker.ts`）を 1 回起動する。

```
sr-imagefirst-autostart.timer（毎時 :41 + 最大 10 分の揺らぎ、Persistent=true）
  → sr-imagefirst-autostart.service（root、oneshot）
  → /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-autostart.sh（root 専用の admin clone。cycle.sh と同じ場所）
      1. switch /etc/sr-design-worker/imagefirst-autostart.json   無い・{"enabled": false} → OFF、exit 0、何も触らない
      2. lock（2 本目は exit 11）
      3. 使い切りの印 /etc/sr-design-worker/imagefirst-run.json    無い・期限切れ・使用済み → exit 10
      4. 排他: sr-jail-claude.service と sr-design-cycle.service が止まっている（inactive / failed 以外・エラーは busy）、
         sr-jail-claude.service が disabled か masked（cycle.sh の DEV-187 と同じ。enabled なら sr-jail-net が起こし直す。エラー・
         not-found も busy）、sr-designgen のプロセスが 1 つも無い、cycle.sh の lock をこの実行の間ずっと持つ → どれか欠ければ exit 12
      5. sr-designgen として: 専用 clone で git fetch origin develop（失敗は exit 20、印は使わない）→ 作業木がきれい →
         HEAD が origin/develop の祖先 → origin/develop へ detach（早送り。--force も clean もしない）→ lockfile が変わったときだけ npm ci
      6. worker 自身の事前確認 `imagefirst-worker.ts --precheck`（sr-designgen として、印の承認 ID を渡す）: claim の直前までの
         cycle の確認すべて（HEAD・作業木・HEAD のパケットを readApprovalPacket・範囲・承認 ID・期限・ピン・計画の作り直し・
         ledger）。lock も audit も書き込みも無い。「動く」でなければ（未承認・期限切れ・ピン不一致・別の承認 ID・使用済み…）exit 10、
         印は使わない。wrapper は承認パケットを自分では読まない
      7. 排他をもう一度 → 印を使い切る（root の state に atomic mkdir、消さない）→ worker を sr-designgen として 1 回
         （SR_IMAGEFIRST_EXPECT_APPROVAL_ID = 印の承認 ID。パケットの承認 ID が違えば worker が APPROVAL_NOT_GRANTED で拒否）
```

- **再試行はどこにも無い。** 印は worker の結果にかかわらず使用済みのまま。worker 自身の claim と入口の ledger も 1 回限り（三重）。
- **未承認なら 0 回・0 課金**: §10 が未記入・期限切れ・ピン不一致なら 6 で止まり、印も残る（直った次の毎時の実行で動く）。worker と事前確認は
  `node --import tsx` で起動する（tsx の CLI は止める信号をもう一度送るので、worker が hard stop と受け取ってしまう）。
- **印が使われても呼び出しが 0 回になる場合（すべて安全側。作り直しは新しい承認 ID と新しい印）**: 事前確認は期限まで 5 分未満なら
  「動かない」と答える（`APPROVAL_EXPIRES_SOON`）が、それでも残るのは次のとき。
  (a) 事前確認と本番の間に HEAD・パケット・ledger が変わった（worker が `no_job` → `AUTOSTART_USED_NO_JOB`、または `refused`）、
  (b) 手で起動した worker が同時に lock を持っていた（`AUTOSTART_USED_LOCKED`。直前の pgrep で普通は起きない）、
  (c) state / runs の dir が作れない（`CLAIMS_DIR_UNSAFE` / `RUNS_DIR_UNSAFE`）、
  (d) claim のあと入口自身の確認で止まった（Codex のサインイン切れ・sandbox など。worker の receipt に停止コード、承認は使用済み）。
  どれも Codex は呼ばれないか、呼ばれても 1 回だけで、再試行は無い。
- **権限の分離**: switch と印は root 所有（`/etc` から上のすべての dir が root 所有で、group / other が書けないこと）。使用済みの記録は
  `/var/lib/sr-imagefirst-autostart/used/<承認 ID>/`（root、0700）。sr-designgen は印を作れず、使用済みを消せない。root は sr-designgen の
  clone で git・node・パーサを動かさない（すべて sr-designgen として。cycle.sh の約束と同じ）。権限は `setpriv` で落とす（exec するので
  親が残らない。runuser は SIGTERM を渡した 2 秒後に子を SIGKILL するので、worker の receipt が書けない）。
- **止める信号**: `systemctl stop` の SIGTERM は script だけに届き（`KillMode=mixed`）、script が timeout(1) へ 1 回渡し（timeout が worker へ
  渡す）、終わるまで待つ。worker は receipt（`WORKER_INTERRUPTED`）と audit の 1 行で終わる（§5 の時間の順、最悪 60 秒）。
  timeout の SIGKILL は 90 秒後、`TimeoutStopSec=120` はそれより長い。
- **出力**: journal に固定の行と worker の JSON 1 行。最後の行は
  `IMAGEFIRST_AUTOSTART <CODE> phase=<before_claim|after_claim> approval=<id|none> exit=<n>`。
  exit: 0 = OFF / 実行した（worker の行を見る）、10 = 何もすること無し（印を使ったあとで worker が no_job なら `AUTOSTART_USED_NO_JOB`）、11 = 別の実行中、12 = busy、20 = 印の前に環境で停止、
  2 = switch / 印が不正・危険、または worker が拒否、1 = worker が止まった、40 / 41 = signal / 内部エラー。unit は 10・11・12 を成功扱い。

置き場所: switch `/etc/sr-design-worker/imagefirst-autostart.json`、印 `/etc/sr-design-worker/imagefirst-run.json`、
root の state `/var/lib/sr-imagefirst-autostart/`（lock、`used/`）、専用 clone `/home/sr-designgen/imagefirst/second-root`
（旧 worker の clone とは別。run.sh の fetch と混ざらない）。worker 側は §3 のまま（`~/.local/state/sr-design-worker/`、`~/sr-runs/`）。

偽 WSL の E2E（`tests/unit/design-agent/imagefirst-worker/autostart.test.ts`）: 本物の wrapper を、一時 dir の /etc・/var/lib・home と
一時の bare origin（fetch はこの機械の中だけ）、systemctl・pgrep・npm の stub、偽 Codex の worker（`fixtures/fake-worker.ts`、本物の
cycle を使う）で走らせる。確かめること: 未承認 → 0 回・印は残る、承認コミット → poll → 1 回 → receipt、2 回目 → 0 回、switch OFF・不正、
印なし・期限切れ・使用済み・不正、jail / cycle が動いている・不明、sr-designgen のプロセス、cycle.sh の lock、fetch 失敗・作業木の変更・
分岐 → 印の前に停止、同時 2 本 → 1 本だけ、実行中の SIGTERM → worker の receipt（`WORKER_INTERRUPTED`）・再試行なし。unit の予算と
上限、リポジトリの中に install / enable するものが無いことも検査する。

## 7. オーナーの手順（自動起動。別のオーナー承認の後だけ。いまは読むだけ）

**ここに書いた操作は、まだ誰も行っていない。** Claude はクラウドから root で操作しない。すべてオーナーが WSL で、一度だけ行う。

### 7.1 読むだけの事前確認（何も変えない）

```
sudo bash /root/sr-capture-admin/scripts/ops/wsl-resource-preflight.sh     # STOP なら入れない
sudo git -C /root/sr-capture-admin fetch --quiet origin develop && sudo git -C /root/sr-capture-admin status -sb   # admin clone が承認済みの develop か
systemctl list-timers --all | grep -i sr- || true                           # 何が enable されているか（sr-design-cycle.timer の時刻 :17 と重ならないこと）
systemctl show -p ActiveState --value sr-jail-claude.service sr-design-cycle.service   # どちらも inactive か failed
systemctl is-enabled sr-jail-claude.service                                  # disabled か masked（でなければ毎回 busy）
command -v setpriv                                                          # util-linux の setpriv
sudo -u sr-designgen -H bash -c 'command -v node git npm python3 && codex login status'   # /usr/local/bin か /usr/bin の node、ChatGPT サインイン
ls -ld /etc/sr-design-worker /home/sr-designgen/imagefirst/second-root 2>&1   # まだ無ければ 7.2 で作る
free -h && nproc                                                            # unit の MemoryMax=4G・CPUWeight=20 が合うか
```

### 7.2 一度だけの設置（WSL の root で）

```
# 専用 clone（sr-designgen の。旧 worker の clone とは別）
sudo -u sr-designgen -H git clone --branch develop https://github.com/<owner>/<repo>.git /home/sr-designgen/imagefirst/second-root
sudo -u sr-designgen -H bash -c 'cd ~/imagefirst/second-root && npm ci --no-audit --no-fund'

# unit と timer（root 専用の admin clone から写す。enable はまだしない）
sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-imagefirst-autostart.service /etc/systemd/system/
sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-imagefirst-autostart.timer /etc/systemd/system/
sudo systemctl daemon-reload

# switch（root 所有、0644。dir も root 所有で group / other が書けないこと）
sudo install -d -o root -g root -m 0755 /etc/sr-design-worker
echo '{"enabled": true}' | sudo tee /etc/sr-design-worker/imagefirst-autostart.json >/dev/null
sudo chmod 0644 /etc/sr-design-worker/imagefirst-autostart.json
```

### 7.3 1 回の実行を許す（承認ごとに。§10 を develop に入れたあと）

```
# 印: §10 の d3 承認 ID と、§10 の期限（24 時間以内）。使い切ると二度と動かない
printf '{"approval_id": "%s", "expires_at": "%s"}\n' hoshigama-imagefirst-d3-YYYYMMDD-NN YYYY-MM-DDTHH:MM:SSZ | sudo tee /etc/sr-design-worker/imagefirst-run.json >/dev/null
sudo chmod 0644 /etc/sr-design-worker/imagefirst-run.json
sudo systemctl enable --now sr-imagefirst-autostart.timer        # 毎時の poll を始める（すぐ 1 回試すなら次の行）
sudo systemctl start sr-imagefirst-autostart.service
journalctl -u sr-imagefirst-autostart.service -n 30 --no-pager    # 最後の行 IMAGEFIRST_AUTOSTART ... と worker の JSON
```

PC が止まっていた場合は、起動後の最初の poll で動く（`Persistent=true`）。印の期限か §10 の期限を過ぎていれば何もしない。

### 7.4 止める・戻す

| したいこと | すること |
|---|---|
| 毎時の poll を止める（すぐ） | `sudo systemctl disable --now sr-imagefirst-autostart.timer` |
| 実行中の 1 回を止める | `sudo systemctl stop sr-imagefirst-autostart.service`（worker が receipt を書いて終わる。承認は使用済みのまま） |
| OFF にする（timer は残す） | `echo '{"enabled": false}' \| sudo tee /etc/sr-design-worker/imagefirst-autostart.json` か、switch を消す |
| 1 回の許可を取り消す | `sudo rm /etc/sr-design-worker/imagefirst-run.json` |
| すべて外す | timer を disable → `sudo rm /etc/systemd/system/sr-imagefirst-autostart.{service,timer}` → `sudo systemctl daemon-reload` |

`/var/lib/sr-imagefirst-autostart/used/`、worker の `claims/`、入口の ledger は**消さない**（消すと同じ承認 ID がもう一度使える状態になる）。
コードを戻すときは develop で revert する。

### 7.5 何もしていないときの負荷

毎時 1 回、switch が無い（OFF）ならファイルを 1 つ見て終わる（1 秒未満、ネットワークなし、state も作らない）。switch が ON で印が無い・
使用済み・期限切れなら、lock と JSON の確認だけで終わる（python3 を 1〜2 回、1 秒程度）。印が有効なときだけ `git fetch`（数秒）と worker の
事前確認（node、数秒）をする。Codex・node の worker が動くのは、§10 と印がそろった 1 回だけ（上限 30 分、unit の `MemoryMax=4G`・`CPUWeight=20`・`Nice=10`）。

注意: W0 の窓の確認（`docs/operations/passt-update-plan.md` の `sr_w0_facts`）は、未知の `sr-*` timer を `UNKNOWN` として保留にする。timer を入れたら、
その確認の一覧に足すかは別に判断する（この変更では触っていない）。
