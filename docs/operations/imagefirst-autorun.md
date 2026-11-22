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
         1. switch・印・使用済み・試行済みを見る。何も無ければ静かに終わる（Remote Control に触らない）
         2. 試行を記録（autorun/<ID>、消さない）→ admin.sh claude-stop → sr-designgen のプロセスが無くなるまで待つ（最大 180 秒）
         3. imagefirst-pilot.sh --sync-clone → imagefirst-pilot.sh --autorun <ID>
              preflight（全部 PASS でなければ何も使わずに終わる）→ used/<ID> を作る → worker 1 回（Codex 1 回）
              → 受け渡し（必要なら再送 1 回）→ 監査の dry-run → 監査 1 回 → 要約
         4. 必ず: review-ready ファイルを書く → admin.sh claude-start → 印の後始末（EXIT trap。SIGKILL などで飛んだら
            unit の ExecStopPost が `--restore` で claude-start を 1 回）
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
sudo install -d -o root -g root -m 0755 /etc/sr-design-worker
echo '{"enabled": true}' | sudo tee /etc/sr-design-worker/imagefirst-autostart.json >/dev/null && sudo chmod 0644 /etc/sr-design-worker/imagefirst-autostart.json
sudo systemctl enable --now sr-imagefirst-autorun.timer
systemctl list-timers --all | grep -i sr-imagefirst || true
```

設置した後も、印が無ければ 10 分ごとに switch と印を 1〜2 個読んで終わる（ネットワークなし、Remote Control に触らない）。

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
- worker の事前確認: **sr-designgen が何も動かしていないとき（Remote Control が止まっているとき）だけ**、自動起動と同じ手順で専用 clone を
  早送りし、`imagefirst-worker.ts --precheck` を sr-designgen として jail の外で動かす。`{"status":"would_run","code":null,"invoked":false,"approval_id":"<ID>","expires_at":"…Z"}`
  の 1 行・exit 0・残り 20 分以上のときだけ受け付け、その期限を印に書く（`APPROVE_RECORDED`）。
- **Remote Control が動いているとき（普通はこちら）は、sr-designgen として何も動かさない**。印には 24 時間の窓を書き
  （`APPROVE_RECORDED_DEFERRED`）、確認はすべて実行時に Remote Control を止めてから行う。
- しない: worker・pilot の起動、Remote Control の停止、claim、`used/`・`autorun/` の作成、systemd の変更。

## 5. 1 回限り・必ず戻す・の守り方

- **生成は印 1 つにつき 1 回まで**: 自動実行は Remote Control を止める前に `autorun/<ID>` を atomic mkdir で作る（root の 0700、消さない）。
  2 回目以降の timer は `AUTORUN_IDLE_ATTEMPTED` で静かに終わる。pilot は worker を起動する直前に `used/<ID>` を作る（自動起動の手順 7 と同じ）。
  その下に、worker 自身の claim と入口の ledger（今まで通り）。再試行はどこにも無い。
- **preflight で止まったとき**（未承認・期限が近い・メモリ・サインインなど）: 何も使っていない（`used/<ID>` も claim も無い）が、
  試行は記録されるので自動ではもう動かない。Remote Control は戻る。同じ ID でやり直すかはオーナーが決める（§7 の未決事項）。
- **Remote Control は必ず戻す**: EXIT trap で、成功・失敗・止める合図のどれでも `admin.sh claude-start`。root の印
  （`autorun.restore-pending`）が残っていれば、unit の `ExecStopPost`（`--restore`）がもう 1 回だけ claude-start する
  （SIGKILL・`TimeoutStopSec` 超え・クラッシュ）。WSL ごと止まったときはどちらも動かない（オーナーが `claude-start`）。
  claude-start が失敗したら終了コード 3（`AUTORUN_RC_NOT_RESTORED`）。
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
- 実行時は Remote Control を止め、sr-designgen の process が 0 になってから、pilot が clone を origin/develop に早送りし、preflight が
  worker の事前確認（この ID・残り 20 分以上・使用歴なし）を含む全項目を見て、worker が claim の前にもう一度全部を確かめる。
  印の期限（最長 24 時間）は「いつまで拾うか」だけを決め、パケットの期限は worker が守る。
- review-ready ファイルは root ではなく sr-designgen として、sr-designgen の process が無い間に書く（`setpriv`）。中身は pilot の `share:` の行・
  最後の行・自動実行の結果 1 行だけ（`local-only:` の行・SHA-256・場所・画像・プロンプト・秘密は入らない）。既にあれば上書きしない。
  dir が symlink なら書かない。

## 7. 未決事項（オーナーに決めてほしいこと）

1. preflight で止まった（何も使っていない）承認 ID を、自動でもう一度試せるようにするか（今は `autorun/<ID>` があると承認コマンドも断る。
   手で消すのは推奨しない。新しいパケットか、Remote Control を止めて手でパイロット）。
2. オーナーが自分で Remote Control を止めていたときも、自動実行の後に必ず `claude-start` してよいか（今は「必ず戻す」）。
3. Remote Control が動いている間の承認では、印の期限が「今 + 24 時間」になる。パケットの期限を承認コマンドに渡す（2 つ目の引数）方がよいか。
4. unit の hardening（`ProtectSystem=strict` など）の下で `admin.sh claude-stop / claude-start` が実機で動くかは未確認（§2 の後に 1 回試す）。

## 8. テスト

```
npx vitest run tests/unit/design-agent/imagefirst-worker/autorun.test.ts tests/unit/design-agent/imagefirst-worker/approve.test.ts
```

pilot の偽 WSL（`tests/unit/design-agent/imagefirst-worker/pilot-world.ts`）の上で、本物の自動実行・承認コマンド・pilot・preflight・再送を動かす。
admin.sh は claude-stop / claude-start を記録して偽の jail の状態を切り替える代役、cgroup は test の root の中のファイル。本物の root・systemd・
Remote Control・Codex・Claude・ネットワークは使わない。
