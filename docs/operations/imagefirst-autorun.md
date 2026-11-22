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
              worker の clone をその commit に固定（.git/config を固定の中身に置き換え、root の origin URL から fetch、
              hooks・fsmonitor・credential helper を切り、HEAD = origin/develop = <commit>、npm ci を必ず実行）
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
  （読めない・24 時間より先なら「今 + 24 時間」と注記。`APPROVE_RECORDED_DEFERRED`）。確認はすべて実行時に Remote Control を止めてから行う。
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
- **worker の clone は root が確かめた commit に固定される**: Remote Control が動いていた間、jail の Claude（同じ利用者）は worker の clone の
  `.git/config`（origin の URL・hooks・fsmonitor・filter・credential helper）、`.git/info/attributes`、`node_modules`、npm のハッシュの記録を
  書き換えられた。だから実行時は、Remote Control を止めて sr-designgen の process が 0 になってから、
  1. root が自分の admin clone（きれい・HEAD = admin clone 自身の URL で `ls-remote` した origin の develop）でその commit を決め（止める前と後に 2 回）、
  2. pilot が sr-designgen として worker の clone の `.git/config` を固定の中身（root の origin URL、`hooksPath = /dev/null`、`fsmonitor = false`）に
     置き換え、`info/attributes` を消し、すべての git に `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= -c protocol.ext.allow=never`
     を付け、root の URL から fetch し、origin/develop = HEAD = その commit でなければ止める（`PILOT_AUTORUN_DEVELOP_MOVED` など。claim の前）、
  3. `npm ci` を必ず実行する（`node_modules` とハッシュの記録は信じない。利用者・全体の npm の設定は `/dev/null`）、
  4. preflight の `clone` の行も root の URL と commit で同じことを確かめ、worker の事前確認（この ID・残り 20 分以上・使用歴なし）を含む
     全項目を見て、worker が claim の前にもう一度全部を確かめる。
  印の期限（最長 24 時間）は「いつまで拾うか」だけを決め、パケットの期限は worker が守る。
  残る前提: `~/.codex` や codex 本体など、worker の clone の外にある sr-designgen の持ち物は今まで通り信頼している（手動のパイロットと同じ）。
- review-ready ファイルは root ではなく sr-designgen として、sr-designgen の process が無い間に書く（`setpriv`）。中身は pilot の `share:` の行・
  最後の行・自動実行の結果 1 行だけ（`local-only:` の行・SHA-256・場所・画像・プロンプト・秘密は入らない）。既にあれば上書きしない。
  dir が symlink なら書かない。

## 7. 未決事項（オーナーに決めてほしいこと）

1. preflight で止まった（何も使っていない）承認 ID を、自動でもう一度試せるようにするか（今は `autorun/<ID>` があると承認コマンドも断る。
   手で消すのは推奨しない。新しいパケットか、Remote Control を止めて手でパイロット）。
2. admin clone が origin の develop と違うと（承認の後に develop へ別のマージがあると）、自動実行は Remote Control に触らずに断り続ける
   （`AUTORUN_ADMIN_NOT_DEVELOP`）。そのときは admin clone を更新する 1 行を打つ。承認から実行までの 10 分ほどの間のマージは避ける。
3. unit の hardening（`ProtectSystem=strict` など）の下で `admin.sh claude-stop / claude-start` が実機で動くかは未確認（§2 の確認 1・2）。
4. `Conflicts=` により、自動実行の service が動くと古い自動起動の service と timer は止まる（両方を入れること自体を断っているので、普通は起きない）。

## 8. テスト

```
npx vitest run tests/unit/design-agent/imagefirst-worker/autorun.test.ts tests/unit/design-agent/imagefirst-worker/approve.test.ts
```

pilot の偽 WSL（`tests/unit/design-agent/imagefirst-worker/pilot-world.ts`）の上で、本物の自動実行・承認コマンド・pilot・preflight・再送を動かす。
admin.sh は claude-stop / claude-start を記録して偽の jail の状態を切り替える代役、cgroup は test の root の中のファイル。本物の root・systemd・
Remote Control・Codex・Claude・ネットワークは使わない。
