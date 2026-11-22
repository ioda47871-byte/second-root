# IMAGE_FIRST の自動実行（承認コマンド 1 行 → 生成 1 回、Issue #302）

> **状態: コードと手順だけ。WSL には install も enable もしていない。** 下の §2 の設置は、オーナーが承認したうえで WSL の root が行う
> **安全境界の操作**である（systemd の unit と timer を入れ、Remote Control を自動で止めて戻すことを許す）。Claude は行わない。
> 入れた後も、オーナーの switch と承認コマンドが書く使い切りの印（どちらも root 所有）が無ければ何もせず、Remote Control にも触らない。
> この文書と仕組みは、承認パケット（§10）の承認を置き換えない。生成 1 回ごとに、今まで通りパケットの承認とマージが要る。

## 1. 流れ（オーナーの操作はマージと root の 1 行だけ）

1. Claude がパケットの PR を作り、オーナーが Claude アプリで中身を確かめて承認し、PR をマージする（今まで通り）。
2. オーナーが WSL の root で **1 行だけ** 打つ（`<ID>` は承認 ID、例 `hoshigama-imagefirst-d4-20261122-01`）:

   ```bash
   sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach origin/develop && sudo bash /root/sr-capture-admin/scripts/sales-design-worker/imagefirst-approve.sh <ID>
   ```

   最後の行が `IMAGEFIRST_APPROVE APPROVE_RECORDED approval=<ID> exit=0`（または `APPROVE_RECORDED_DEFERRED`）なら終わり。
3. あとは自動（Remote Control の Claude はその間止まる）:

   ```
   sr-imagefirst-autorun.timer（10 分ごと + 最大 90 秒の揺らぎ、Persistent=false）
     → sr-imagefirst-autorun.service（root、oneshot）→ imagefirst-autorun.sh
         1. switch・印・使用済み・試行済みを見る。root の admin clone がきれいで HEAD = origin の develop（admin clone 自身の
            URL への ls-remote）であること。どれかが違えば静かに終わる（Remote Control に触らない）
         2. 試行を記録（autorun/<ID>、その commit も。消さない）→ sr-jail-claude が enable だったかを復元フラグに書く
            → admin.sh claude-stop → sr-designgen のプロセスが無くなるまで待つ（最大 180 秒）
         3. 1 の確認をもう一度（同じ commit でなければ pilot なし）→ imagefirst-pilot.sh --autorun <ID> <commit>
              使い回しの clone は使わず、root が決めた新しい場所（~/imagefirst/autorun-<ID>-<UTC>）に root の origin URL から
              新しく clone し（利用者・システムの git 設定なし）、HEAD = origin/develop = <commit>、status --ignored が空、npm ci
              → preflight（全部 PASS でなければ何も使わずに終わる）→ used/<ID> を作る → worker 1 回（Codex 1 回）
              → 受け渡し（必要なら再送 1 回）→ 監査の dry-run → 監査 1 回 → 要約
         4. 必ず: review-ready ファイルを書く → claude-start（実行前に enable だったときだけ）→ 復元フラグを消す
            （EXIT trap。sr-designgen のプロセスがまだ残っていれば、claude-start は unit の ExecStopPost に任せてフラグを残す。
            SIGKILL などで trap が飛んだときも、ExecStopPost が `--restore` でフラグを見て claude-start を 1 回）
   ```

4. 次に Claude アプリで新しいセッションを開くと、Claude が `~/sr-runs/review-inbox/runs/<ID>.share.txt` を読み、
   inbox の bundle・プレビュー・監査を照合してオーナーに出す（d4 の実行シートの「Claude が引き受ける後処理」と同じ）。

時間: 承認コマンドから最長でおよそ 10〜12 分で始まる。生成と監査で最長およそ 1 時間 50 分（各段階の timeout の合計。普段はずっと短い）。

## 2. 一度だけの設置（オーナーの承認が要る安全境界の操作。WSL の root で）

前提: `docs/operations/imagefirst-worker-port.md` §7.2 の専用 clone（`/home/sr-designgen/imagefirst/second-root`）と、
`~sr-designgen/sr-runs`（sr-designgen の 0700）があること。古い毎時の自動起動（`sr-imagefirst-autostart.timer`）は**入れない・入っていれば止める**
（同じ印を読むため。承認コマンド・自動実行・preflight のどれも、それが enable か active なら断る）。

```bash
sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach origin/develop
sudo systemctl disable --now sr-imagefirst-autostart.timer 2>/dev/null || true
sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-imagefirst-autorun.service /etc/systemd/system/
sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-imagefirst-autorun.timer /etc/systemd/system/
sudo systemctl daemon-reload
# enable の前の確認 1（Remote Control は止まらない）: unit と同じ hardening の下で admin.sh status が動くこと
sudo systemd-run --wait --pipe --collect -p ProtectSystem=strict -p ProtectHome=read-only -p ReadWritePaths=/home/sr-designgen -p PrivateTmp=yes -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK" /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh status
sudo install -d -o root -g root -m 0755 /etc/sr-design-worker
# the reviewed Codex config for the run's own CODEX_HOME (§6 設定の信頼境界; without it every run stops at config_trust)
sudo install -o root -g root -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/codex-config.toml /etc/sr-design-worker/codex-config.toml
echo '{"enabled": true}' | sudo tee /etc/sr-design-worker/imagefirst-autostart.json >/dev/null && sudo chmod 0644 /etc/sr-design-worker/imagefirst-autostart.json
sudo systemctl enable --now sr-imagefirst-autorun.timer
systemctl list-timers --all | grep -i sr-imagefirst || true
```

確認 1 で `status` の表が出ず `Permission denied`・`Read-only file system` などで止まったら、**timer を enable しない**（最後の行は打たない）。
その行を Claude に見せる（hardening の調整は別の承認）。

enable の前の確認 2（任意。**Remote Control が数秒止まり、この Claude のセッションも切れる**。WSL の端末で、オーナーが打つ）:
同じ hardening で `claude-stop` → `claude-start` が動くか。`CLAUDE_STOPPED` と `CLAUDE_STARTED (jailed)` が出れば合格。
`claude-start` が失敗したら、hardening なしで `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start` を 1 回打って戻す
（ExecStopPost の `--restore` は `+` で hardening なしに動くので、本番でも最後は戻せる）。

```bash
H='-p ProtectSystem=strict -p ProtectHome=read-only -p ReadWritePaths=/home/sr-designgen -p PrivateTmp=yes -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes'
sudo systemd-run --wait --pipe --collect $H /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop
sudo systemd-run --wait --pipe --collect $H /usr/bin/bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start
```

設置した後も、印が無ければ 10 分ごとに switch と印を 1〜2 個読んで終わる（ネットワークなし、Remote Control に触らない）。
印があるときだけ、Remote Control を止める前に admin clone から origin の develop を `ls-remote` で読む（数秒）。

## 3. 止める・外す

| したいこと | すること |
|---|---|
| 自動実行を止める（すぐ） | `sudo systemctl disable --now sr-imagefirst-autorun.timer` |
| 実行中の 1 回を止める | `sudo systemctl stop sr-imagefirst-autorun.service`（pilot が worker・監査へ止める合図を渡して記録を待ち、その後 claude-start する。承認 ID は使った扱い） |
| OFF にする（timer は残す） | `echo '{"enabled": false}' \| sudo tee /etc/sr-design-worker/imagefirst-autostart.json` |
| 1 回の許可を取り消す（まだ始まっていなければ） | `sudo rm /etc/sr-design-worker/imagefirst-run.json` |
| すべて外す | timer を disable → `sudo rm /etc/systemd/system/sr-imagefirst-autorun.{service,timer}` → `sudo systemctl daemon-reload` |
| Remote Control が戻っていない | `sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh status` を見てから `claude-start` を 1 回 |

`/var/lib/sr-imagefirst-autostart/used/`・`autorun/`、worker の `claims/`、入口の ledger は**消さない**（消すと同じ承認 ID がもう一度使える状態になる）。
自動実行の timer が enable の間は、手で動かすパイロット（`imagefirst-pilot.sh <ID>`）の preflight が `timers` の行で FAIL する
（自動実行が途中で Remote Control を戻すのを防ぐため）。手で動かすときは先に timer を止める。

## 4. 承認コマンド（`imagefirst-approve.sh`）がすること・しないこと

- する: ID の形（`hoshigama-imagefirst-<d3|d4>-YYYYMMDD-NN`、日付 `00000000` は拒否）、admin clone がきれいで fetch 後の
  origin/develop と同じこと（違えば実行すべき `checkout` の 1 行を出して断る。自分では更新しない）、switch が `{"enabled": true}`
  （無い・false なら作り方を出して断る）、古い自動起動が off、自動実行の lock、`used/<ID>`・`autorun/<ID>` が無いこと、
  今の印が別の未使用・未試行・期限内の ID を指していないこと。そのうえで印を atomic に書く（同じ dir の一時ファイル → rename、root の 0644、
  中身は `{"approval_id": "<ID>", "expires_at": "<UTC>Z"}` だけ）。
- パケットの確認（どちらの場合も）: root は**自分の admin clone だけ**を、確かめたその commit で読む（`git show`。パーサは使わず、行の形を
  bash の pattern で見るだけ）。ID の方向性のパケット（d3 → p3 のパケット、d4 → d4 のパケット）の §10 が `承認済み` で、`<d> の承認 ID` の行が
  ちょうどこの ID であること（違えば `APPROVE_PACKET_NO_ID`）。`期限` の行が UTC の時刻ならそれがパケットの期限（過ぎていれば
  `APPROVE_PACKET_EXPIRED`）。本当の確認は今まで通り worker の `readApprovalPacket`。
- worker の事前確認: **sr-designgen が何も動かしていないとき（Remote Control が止まっているとき）だけ**、自動起動と同じ手順で専用 clone を
  早送りし、`imagefirst-worker.ts --precheck` を sr-designgen として jail の外で動かす。`{"status":"would_run","code":null,"invoked":false,"approval_id":"<ID>","expires_at":"…Z"}`
  の 1 行・exit 0・期限がパケットの期限と同じ・残り 20 分以上のときだけ受け付け、その期限を印に書く（`APPROVE_RECORDED`）。
- **Remote Control が動いているとき（普通はこちら）は、sr-designgen として何も動かさない**。印にはパケットの期限を書く
  （`APPROVE_RECORDED_DEFERRED`）。確認はすべて実行時に Remote Control を止めてから行う。
- **期限はパケットの §10 だけ**（オーナー方針、Issue #302）: §10 の `期限` が UTC の時刻として読めなければ `APPROVE_PACKET_EXPIRY_UNREADABLE`、
  24 時間より先なら `APPROVE_EXPIRY_INVALID`（後でもう一度打つ）で断る。「今 + 24 時間」のような推測は書かない。期限を引数で渡す方法も無い。
- しない: worker・pilot の起動、Remote Control の停止、claim、`used/`・`autorun/` の作成、systemd の変更。

## 5. 1 回限り・必ず戻す・の守り方

- **生成は印 1 つにつき 1 回まで**: 自動実行は Remote Control を止める前に `autorun/<ID>` を atomic mkdir で作る（root の 0700、消さない）。
  2 回目以降の timer は `AUTORUN_IDLE_ATTEMPTED` で静かに終わる。pilot は worker を起動する直前に `used/<ID>` を作る（自動起動の手順 7 と同じ）。
  その下に、worker 自身の claim と入口の ledger（今まで通り）。再試行はどこにも無い。
- **preflight で止まったとき**（未承認・期限が近い・メモリ・サインインなど）: 何も使っていない（`used/<ID>` も claim も無い）が、
  試行は記録されるので自動ではもう動かない。Remote Control は戻る。同じ ID でやり直すかはオーナーが決める（§7 の未決事項）。
- **Remote Control は必ず元に戻す**: claude-stop の直前に、sr-jail-claude が enable だったかを root の復元フラグ
  （`/var/lib/sr-imagefirst-autostart/autorun.restore-pending`、`was_enabled=yes|no`）に書き、同時に「止めた」と記録する
  （その間に止める合図が来たら、claude-stop はせずにフラグを消して exit 40）。EXIT trap で、成功・失敗・止める合図のどれでも、
  enable だったときだけ `admin.sh claude-start`（オーナーが止めていた Remote Control は止めたまま。`remote_control=left_stopped`）。
  終わりに sr-designgen のプロセスがまだ残っていれば（例: pilot の timeout の後に残った worker。この unit の cgroup にいて、script が
  終わると systemd が止める）、claude-start はせずフラグを残し（`remote_control=deferred`）、unit の `ExecStopPost`（`+` で sandbox なし、
  同じ cgroup。`--restore`）が 1 回だけ claude-start する。SIGKILL・`TimeoutStopSec` 超え・クラッシュでも同じ。WSL ごと止まったときは
  どちらも動かない（オーナーが `claude-start`）。claude-start が失敗したら終了コード 3（`AUTORUN_RC_NOT_RESTORED`）。
- **排他**: Remote Control を止める前に、古い自動起動の unit が off・設計サイクルの timer が off で service が停止・自動起動 / pilot / サイクルの
  lock が空いていることを確かめる（そうでなければ触らずに終わる）。止めた後は、自動起動の `busy()` が idle と言うまで待つ。
  preflight は自分の cgroup が `sr-imagefirst-autorun.service` のときだけ、その service（activating / active）と timer を許す。
- **`--autorun` は service の中だけ**: pilot と自動実行は自分の `/proc/self/cgroup` を読み、`0::/system.slice/sr-imagefirst-autorun.service`
  でなければ断る（引数や環境変数では選べない）。手で打つパイロットの動き（`imagefirst-pilot.sh <ID>`・`--sync-clone`）は変わらない。
  ただし preflight の `timers` の行は、自動実行の timer / service も off であることを見るようになった（表示も 1 項目増えた）。

## 6. 信頼の根拠（Remote Control が動いている間の承認）

- 承認コマンドが Remote Control の動いている間に書くのは、**オーナーが打った ID と root が作った期限だけ**である。jail の中の process は
  `/etc/sr-design-worker` に書けず、印の中身にも関われない。印はパケットの承認の代わりにならない（worker が HEAD のパケットで確かめる）。
- sr-designgen の process が生きている間は、root は sr-designgen として何も動かさない（git・node・npm も。jail の process が仕込んだ
  git の設定や node のコードが jail の外で同時に動くのを避ける。自動起動・pilot・preflight・再送と同じ規則）。
- **生成に使う clone は毎回新しく作り、root が確かめた commit に固定する**: Remote Control が動いていた間、jail の Claude（同じ利用者）は
  使い回しの clone（`~/imagefirst/second-root`）の `.git/config`・hooks・index のフラグ（skip-worktree など）・objects や alternates・
  無視されたファイル（`.env*`・cache）・`node_modules`、そして home の git 設定（`~/.gitconfig` とその include、`~/.config/git/config`・`attributes`）を
  書き換えられた。だから実行時は、Remote Control を止めて sr-designgen の process が 0 になってから、
  1. root が自分の admin clone（きれい・HEAD = admin clone 自身の URL で `ls-remote` した origin の develop）でその commit を決め（止める前と後に 2 回）、
  2. pilot が sr-designgen として、root が決めた新しい場所 `~/imagefirst/autorun-<ID>-<UTC>` を `mkdir` で作り（symlink・既にある場所は断る）、
     root の origin URL から `git clone --no-local --no-checkout` し（objects は git が受け取って確かめたものだけ。何も共有しない）、
     origin/develop = その commit でなければ止め、`checkout --detach` し、HEAD = その commit、`git status --porcelain --ignored` が空でなければ止める
     （`PILOT_AUTORUN_DEVELOP_MOVED` / `PILOT_AUTORUN_TREE_DIRTY`。claim の前）、
  3. その clone で `npm ci`（利用者・全体の npm の設定は `/dev/null`）、
  4. preflight・worker の実行・再送（`--deliver-review`）・監査はすべてその clone で動く（preflight は root の state ファイル `autorun-clone` で場所を知り、
     形を確かめる）。worker が claim の前にもう一度全部を確かめる。
  - worker の git はすべて `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`（node の worker が起動する git にも `worker/env.ts` が渡す）。
    pilot・preflight が直接起動する git には、さらに `-c core.attributesFile=/dev/null -c core.excludesFile=/dev/null -c core.hooksPath=/dev/null
    -c core.fsmonitor=false -c credential.helper= -c protocol.ext.allow=never` を付ける。node の worker の git は `~/.config/git/attributes` を読みうるが、
    filter などの実行の定義は利用者の設定にしか置けず、それを読まないので何も起動しない。
  - 古い新規 clone: `~/imagefirst` の直下で `autorun-hoshigama-imagefirst-*` という名前の本物のディレクトリだけを対象に、いちばん新しい 1 つを残し、
    それより古いものを pilot が sr-designgen として消す（自動実行が lock を持ち Remote Control を止めている間なので、使っている run は無い）。
    symlink・ほかの名前・ほかの場所は消さない。画像・receipt・bundle は `~/sr-runs` にあり、clone を消しても残る。
  - Node は clone の親ディレクトリと全体のフォルダからも module や `package.json` を探す。だから `~/node_modules`・`~/.node_modules`・
    `~/.node_libraries`・`~/imagefirst/node_modules`・`~/package.json`・`~/imagefirst/package.json` のどれかがあれば（symlink も）、clone を作る前と
    npm ci の後に `PILOT_AUTORUN_NODE_PATHS` で止まる（claim の前）。`NODE_PATH` は worker に渡らない（`env -i`、`worker/env.ts` も渡さない）。
  - node の worker が起動する git にも `core.attributesFile=/dev/null` が効く（`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.attributesFile GIT_CONFIG_VALUE_0=/dev/null`）。
  - 古い clone の掃除は NUL 区切りで名前を読み、名前全体が `autorun-hoshigama-imagefirst-d[34]-YYYYMMDD-NN-<UTC>` で、親がちょうど `~/imagefirst`、
    本物のディレクトリのものだけを対象にする（改行を含む名前などは触らない）。
  - ディスク: 新しい clone と `node_modules` で約 1 GiB、さらに 1 つ前のものを残す。自動実行の中では preflight の `disk` の行が
    4096 + 2048 = 6144 MiB 以上の空きを求める（手動のパイロットは 4096 MiB のまま）。
  - 手で動かすパイロットは今まで通り `~/imagefirst/second-root` を使う（変えていない）。
  印の期限（最長 24 時間）は「いつまで拾うか」だけを決め、パケットの期限は worker が守る。

### 設定の信頼境界（モデル CLI の設定。Issue #302 オーナー方針 1、OWNER MERGE ONLY の PR）

jail の外で sr-designgen として動くモデル CLI（生成の Codex、監査の Claude CLI、preflight の Codex サインイン確認と claude の auth 確認）は、
何もしなければ `~/.codex`（`config.toml` の `mcp_servers`・`notify`・`model_providers`・`profiles`、`AGENTS.md`、prompts）と
`~/.claude`（`CLAUDE.md`、settings の hooks、plugins・agents・commands）・`~/.claude.json` を読む。どれも jail の Claude が書ける。

**選んだ方式 (a)（自動実行だけ）**: 1 回の実行ごとに、pilot が sr-designgen として、新しい clone の隣に root が決めた新しい場所
`~/imagefirst/autorun-<ID>-<UTC>.cfg/` を作り（既にある場所・symlink は断る）、その中に
- `codex/`（`CODEX_HOME`）: root の `/etc/sr-design-worker/codex-config.toml`（root 所有・他人が書けない・SHA-256 がリポジトリに固定されたものと同じ）の写しの
  `config.toml` と、`~/.codex/auth.json`（Codex のサインイン）の写し**だけ**、
- `claude/`（`CLAUDE_CONFIG_DIR`）: `~/.claude/.credentials.json`（Claude のサインイン）の写し**だけ**

を置き、worker・監査・preflight の worker の行をすべて `CODEX_HOME` / `CLAUDE_CONFIG_DIR` をそこへ向けて動かす（`worker/env.ts` が両方を子へ渡す。
Codex の sandbox は `CODEX_HOME` だけを読み書きで bind する）。サインインの写しは sr-designgen が作る（root は中身を読まない。本物のファイル・symlink でない・
1 MiB 以下）。実行の後（成功・失敗・止める合図のどれでも、worker の process が全部終わってから）、CLI が更新したサインインだけを、変わっていれば
元の場所へ sr-designgen として戻し（同じ dir の一時ファイル → rename。symlink の先・symlink の dir には書かない）、`.cfg` を写しごと消す。
前の実行が残した `.cfg` は次の実行の始めに消す。監査の既存のフラグ（`--tools ""`・`--strict-mcp-config`・`--setting-sources ""`・`--no-session-persistence`）は変えていない。

**FAIL CLOSED（claim の前）**: preflight の新しい行 `config_trust`（自動実行の中だけ）が、root の config が無い・root だけのものでない（他人が書ける・symlink）・
SHA-256 が違う、`.cfg` に予定外のもの（`codex/` は `auth.json` と `config.toml` だけ、`claude/` は `.credentials.json` だけ、symlink なし）がある、
監査の作業 dir（`~/.local/state/...`）の親に `CLAUDE.md` / `CLAUDE.local.md` がある、のどれかで FAIL にし、pilot は何も始めない。

**Claude のサインインのファイル（確かめたこと・前提）**: この WSL の sr-designgen では、claude.ai のサインインは `~/.claude/.credentials.json` にある
（Linux の Claude Code の既定の置き場所。`CLAUDE_CONFIG_DIR` を指定すると `$CLAUDE_CONFIG_DIR/.credentials.json` を読む）。`~/.claude.json`
（アカウントの表示用の情報のほか、利用者の MCP 設定なども入る）は**写さない**。**前提**: `claude auth status` と `-p` の呼び出しが
`.credentials.json` だけで claude.ai のサインインとして通ること。本物の claude はこの開発では動かしていないので未確認。通らなければ preflight の
`claude_auth` の行が `CLAUDE_NOT_SIGNED_IN` などで FAIL し、claim の前に止まる（その場合の対応は §7）。

**手で動かすパイロットは変えていない**: 承認済みのコミットに固定して run sheet で動かす手順（d4 の実行シート）の見える動きを変えないため、
(a) は自動実行（`--autorun`）だけに入れた。手動のパイロットは今まで通り `~/.codex` と `~/.claude` を使う（既知の前提として残る）。

**(a) と (b) の比較**

| | (a) 実行ごとの専用の設定 dir（採用） | (b) home の設定を既知の正しい写しとバイト比較 |
|---|---|---|
| jail からの書き換え | CLI は home の設定をそもそも読まない。未知のファイルが増えても見えない | 比べたファイルは守れるが、CLI が読む新しい場所（新しい版の設定ファイル・plugins など）が増えると漏れる |
| 運用 | root の config を一度置くだけ。サインインの更新は写して戻す | 正しい写しを root が持ち、CLI の更新・オーナーの設定変更のたびに写しを更新する必要 |
| 失敗の形 | 予定外のものがあれば claim の前に FAIL | 差分があれば claim の前に FAIL（正当な変更でも止まる） |
| 弱点 | サインインの写しと戻しが要る。Claude が `.credentials.json` だけで動くことが前提 | 比べる対象の一覧を正しく保ち続ける必要。比較と実行の間の書き換えは RC 停止で防ぐ |

(a) を選んだ理由: 守る対象を「読ませるものの一覧」（config 1 つ + サインイン 2 つ）に絞れ、CLI の版が上がって読む場所が増えても既定で見えないため。

**オーナーの一度だけの root 操作（承認が要る。まだ誰も行っていない）**: リポジトリの `scripts/sales-design-worker/codex-config.toml` を置く。
中身はコメントだけ（MCP サーバー・notify・provider・profile なし）。SHA-256 `697ade397a322574f3b9693811ad257e6a6f1bb511bbed37626c849c7a53b9dd`
（`imagefirst-pilot.sh` と `imagefirst-pilot-preflight.sh` の `CODEX_CONFIG_SHA256`。テストがリポジトリのファイルと一致することを固定）。

```bash
sudo install -o root -g root -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/codex-config.toml /etc/sr-design-worker/codex-config.toml
sudo sha256sum /etc/sr-design-worker/codex-config.toml   # 697ade39...b9dd であること
```

**秘密の扱い**: リポジトリにも Issue にもサインインの中身・トークンを置かない。サインインのファイルは sr-designgen 自身の dir の間で
（`~/.codex` ↔ `.cfg/codex`、`~/.claude` ↔ `.cfg/claude`）sr-designgen が写すだけで、root は中身を読まず、表示もしない。`.cfg` は 0700、
ファイルは 0600 で、実行の後に消す。

### 再承認の提案（提案のみ。実装していない）

preflight で止まって何も使っていない（`used/<ID>` も claim も無い）承認 ID でも、自動では再試行しない（`autorun/<ID>` が残る）。
回復の提案: 使用済みの印・`autorun/`・worker の claim・入口の ledger は**どれも消さず**、新しい承認 ID（新しいパケットの §10 を記入した PR を
オーナーがマージ）で `imagefirst-approve.sh <新しい ID>` を 1 回打つ。古い ID は延長も流用もしない。これなら「1 つの ID は 1 回だけ」の約束が保たれ、
台帳を書き換える操作が要らない。
- review-ready ファイルは root ではなく sr-designgen として、sr-designgen の process が無い間に書く（`setpriv`）。中身は pilot の `share:` の行・
  最後の行・自動実行の結果 1 行だけ（`local-only:` の行・SHA-256・場所・画像・プロンプト・秘密は入らない）。既にあれば上書きしない。
  dir が symlink なら書かない。

## 7. 未決事項（オーナーに決めてほしいこと）

1. preflight で止まった（何も使っていない）承認 ID は自動では再試行しない（オーナー方針）。回復は §6 の「再承認の提案」（新しい ID）。
6. Claude CLI が `.credentials.json` だけ（`.claude.json` なし）で claude.ai のサインインとして通るかは未確認（§6）。通らない場合の選択肢:
   `.claude.json` のうちサインインに要る項目だけを root が決めた形で作る、または監査だけ手動のパイロットに残す。
7. `codex-config.toml` をコメントだけにした。Codex がサインインの保存先などを設定で求める版では、その 1 行を足して SHA-256 を更新する（別 PR）。
2. admin clone が origin の develop と違うと（承認の後に develop へ別のマージがあると）、自動実行は Remote Control に触らずに断り続ける
   （`AUTORUN_ADMIN_NOT_DEVELOP`）。そのときは admin clone を更新する 1 行を打つ。承認から実行までの 10 分ほどの間のマージは避ける。
3. unit の hardening（`ProtectSystem=strict` など）の下で `admin.sh claude-stop / claude-start` が実機で動くかは未確認（§2 の確認 1・2）。
4. `Conflicts=` は古い自動起動の **timer** にだけ付けた（自動実行の service が動くとその timer は止まる）。service には付けない
   （生成の途中の worker を止めてしまうため）。service が動いている・enable のときは、script・preflight・承認コマンドが断る。
5. 新しい clone と `npm ci` のぶん、ディスク（clone 1 つ + `node_modules`。古いものは 1 つだけ残す）と時間（clone 最大 10 分 + npm ci 最大 15 分）が
   増える。自動実行の中では preflight の `disk` の行が 6144 MiB 以上の空きを求める。unit の `TimeoutStartSec` は 10800 秒。

## 8. テスト

```
npx vitest run tests/unit/design-agent/imagefirst-worker/autorun.test.ts tests/unit/design-agent/imagefirst-worker/approve.test.ts
```

pilot の偽 WSL（`tests/unit/design-agent/imagefirst-worker/pilot-world.ts`）の上で、本物の自動実行・承認コマンド・pilot・preflight・再送を動かす。
admin.sh は claude-stop / claude-start を記録して偽の jail の状態を切り替える代役、cgroup は test の root の中のファイル。本物の root・systemd・
Remote Control・Codex・Claude・ネットワークは使わない。
