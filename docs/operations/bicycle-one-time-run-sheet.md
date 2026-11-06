# 輪 d1-v9 の AI 写真6枚を1回だけ本生成する — オーナー用コマンドシート（DEV-192）

**オーナーの GO: 2026-11-07（Issue #193 コメント `6689664215`）。** 範囲は輪（架空の自転車修理店）d1-v9 の研究用デモ写真の **1ジョブ・画像呼び出し最大6回・Codex 1回・15分・再試行なし**。
**常時の無人実行の許可ではない**（timer は入れない。終わったら OFF に戻す）。Claude はこのシートのコマンドを1つも実行していない。上から順に、オーナーが WSL で貼る。

- 承認済みの実行プロンプト: SHA256 `4b8081e02c08e1d0842c27bf28afab2bc647a9c80acce8464c23acf20e6d7447`（4566 文字）、核の写真本文 `docs/design/bicycle-ai-photo-prompt.txt` SHA256 `83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594`（3865 バイト）。**どちらかが違えば承認は失効 → STOP。**
- 決まり: 各ブロックは `( set -euo pipefail … )` の中で動き、門で止まると `CODE` を出してそのブロックを終える（端末は閉じない）。**`STOP_*`・想定外の出力が出たら先へ進まず、出力をそのまま Claude に見せる。** 秘密（token・auth.json・env の中身）は表示しない（`stat` だけ）。
- 使用済みの `tsugute-photos-20261106-01` は絶対に使わない（worker も root も拒否する）。

## (a) 読むだけの事前確認（何も変えない）

```bash
( set -euo pipefail
systemctl show sr-design-cycle.service -p UnitFileState -p ActiveState --no-pager      # 期待: UnitFileState=static / ActiveState=inactive
[ "$(systemctl show sr-design-cycle.service -p ActiveState --value)" = inactive ] || { echo STOP_CYCLE_RUNNING; exit 1; }
[ "$(systemctl show sr-design-cycle.timer -p LoadState --value)" = not-found ] || { echo STOP_TIMER_PRESENT; exit 1; }; echo TIMER_NOT_FOUND
sudo test ! -e /etc/sr-design-worker/image-autorun.json || { echo STOP_SWITCH_PRESENT; exit 1; }; echo SWITCH_ABSENT
[ "$(sudo git --no-optional-locks -C /root/sr-capture-admin rev-parse HEAD)" = bb7da4fa42817ae1c8f0a2ef86587368e84f418e ] || { echo STOP_CLONE_NOT_BB7DA4F; exit 1; }; echo CLONE_AT_BB7DA4F
[ -z "$(sudo git --no-optional-locks -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }; echo CLONE_CLEAN
printf 'sr-jail-claude: enabled=%s active=%s\n' "$(systemctl is-enabled sr-jail-claude.service 2>&1 || true)" "$(systemctl is-active sr-jail-claude.service 2>&1 || true)"
sudo test ! -e /home/sr-designgen/.local/state/sr-design-worker/image-autorun/STOPPED || { echo STOP_WORKER_STOPPED_MARKER; exit 1; }; echo NO_STOPPED_MARKER
for d in /home/sr-designgen/sr-design-jobs/image-autorun/inbox /home/sr-designgen/sr-design-jobs/image-autorun/processing; do   # 無いのが普通（その時は空と同じ）
  sudo test ! -e "$d" || [ -z "$(sudo find "$d" -maxdepth 1 -type f -print -quit)" ] || { echo STOP_IMAGE_INBOX_NOT_EMPTY; exit 1; }
done; echo IMAGE_INBOX_EMPTY
sudo stat -c '%U %a %s bytes %n' /home/sr-designgen/.codex/auth.json || { echo STOP_NO_CODEX_SIGNIN; exit 1; }   # 中身は出さない
sudo test ! -e /home/sr-designgen/.codex/.env || { echo STOP_CODEX_DOTENV; exit 1; }; echo CODEX_SIGNIN_PRESENT_NO_DOTENV
echo PREFLIGHT_OK )
```

期待: `UnitFileState=static`・`ActiveState=inactive`・`TIMER_NOT_FOUND`・`SWITCH_ABSENT`・`CLONE_AT_BB7DA4F`・`CLONE_CLEAN`・`NO_STOPPED_MARKER`・`IMAGE_INBOX_EMPTY`・`sr-designgen … auth.json`（所有者が sr-designgen、他から読めない mode）・`PREFLIGHT_OK`。jail の Claude はこの時点では動いていてよい（(c) で止める）。

## (b) コード・範囲・SHA の照合と root clone の更新（バックアップしてから）

`<MERGE_SHA>` は DEV-192 の PR が develop に merge された commit（40 文字）。Claude が merge 後に知らせる値をそのまま入れる。

```bash
( set -euo pipefail
PIN=<MERGE_SHA>
OLD=bb7da4fa42817ae1c8f0a2ef86587368e84f418e
C=/root/sr-capture-admin
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || { echo STOP_PIN_NOT_40_HEX; exit 1; }
BK=/root/sr-dev192-backup-$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o root -g root -m 0700 "$BK"
sudo git -C "$C" rev-parse HEAD | sudo tee "$BK/clone-head" >/dev/null                # 旧 HEAD の控え（戻し方で使う）
sudo git -C "$C" fetch -q origin
sudo git -C "$C" merge-base --is-ancestor "$OLD" "$PIN" || { echo STOP_PIN_NOT_AFTER_BB7DA4F; exit 1; }
sudo git -C "$C" merge-base --is-ancestor "$PIN" origin/develop || { echo STOP_PIN_NOT_ON_DEVELOP; exit 1; }
# worker は毎回 origin/develop を使う: hook・prompt・写真の流れが PIN と同じバイトであること（違えば STOP してオーナーに確認）
sudo git -C "$C" diff --quiet "$PIN" origin/develop -- scripts/sales-design-worker scripts/design-artifact lib/design-agent docs/design/bicycle-ai-photo-prompt.txt || { echo STOP_DEVELOP_MOVED_WORKER_CODE; exit 1; }
echo PIN_OK
# root が動かすファイルの差（期待: cycle.sh の 1 ファイルだけ。unit・admin.sh・jail・ops・bridge は 0）
sudo git -C "$C" diff --stat "$OLD" "$PIN" -- scripts/sales-design-capture scripts/sales-design-worker/cycle.sh scripts/sales-design-worker/systemd scripts/ops scripts/sales-design-bridge
sudo git -C "$C" diff "$OLD" "$PIN" -- scripts/sales-design-worker/cycle.sh | grep '^[-+][^-+]' || true
# 差そのものを固定する（DEV-192 のレビュー済みの差。違えば STOP）
[ "$(sudo git -C "$C" diff "$OLD" "$PIN" -- scripts/sales-design-worker/cycle.sh | sha256sum | cut -d' ' -f1)" = 094175c663143d7c8442d90d13f8e5969dbd2fef3ed2a96e3f4ffc9e685d0527 ] || { echo STOP_ROOT_DIFF_NOT_REVIEWED; exit 1; }; echo ROOT_DIFF_PINNED
read -r -p "差が cycle.sh の (1) allowlist（'tsugute:6 bicycle:6'）とその照合、(2) grant が出なければ止まる CYCLE_STOP_IMAGE_NOT_GRANTED（動きを狭めるだけ）の2つだけなら yes: " a; [ "$a" = yes ] || { echo NOT_CONFIRMED; exit 1; }
sudo git -C "$C" checkout -q --detach "$PIN"
[ "$(sudo git -C "$C" rev-parse HEAD)" = "$PIN" ] || { echo STOP_CLONE_NOT_AT_PIN; exit 1; }
[ -z "$(sudo git -C "$C" status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }
sudo cmp /etc/systemd/system/sr-design-cycle.service "$C/scripts/sales-design-worker/systemd/sr-design-cycle.service" || { echo STOP_UNIT_DIFFERS; exit 1; }; echo UNIT_SAME
[ "$(sudo grep -c "^IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'$" "$C/scripts/sales-design-worker/cycle.sh")" = 1 ] || { echo STOP_ROOT_ALLOWLIST; exit 1; }; echo ROOT_ALLOWLIST_OK
[ "$(sudo sha256sum "$C/docs/design/bicycle-ai-photo-prompt.txt" | cut -d' ' -f1)" = 83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594 ] || { echo STOP_CORE_PROMPT_SHA; exit 1; }
[ "$(sudo stat -c %s "$C/docs/design/bicycle-ai-photo-prompt.txt")" = 3865 ] || { echo STOP_CORE_PROMPT_BYTES; exit 1; }
sudo grep -q 'BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 = "4b8081e02c08e1d0842c27bf28afab2bc647a9c80acce8464c23acf20e6d7447"' "$C/lib/design-agent/quality-pipeline/bicycle-ai-photos.ts" || { echo STOP_RUN_PROMPT_PIN; exit 1; }
sudo grep -q 'BICYCLE_RUN_PROMPT_CANDIDATE_CHARS = 4566;' "$C/lib/design-agent/quality-pipeline/bicycle-ai-photos.ts" || { echo STOP_RUN_PROMPT_CHARS; exit 1; }
echo PROMPT_SHAS_OK
echo "BK=$BK   # 控えておく" )
```

期待: `PIN_OK`、diff --stat は `scripts/sales-design-worker/cycle.sh | 30 ++++++++++++++++++++++++++----` の1行だけ、`ROOT_DIFF_PINNED`、`yes`、`UNIT_SAME`・`ROOT_ALLOWLIST_OK`・`PROMPT_SHAS_OK`。実行プロンプト本体の SHA は worker が実行の前に組み立て直して照合し、違えば `REFUSED_JOB_INVALID`（生成0回）で止まる。

## (c) jail の Claude（Remote Control）を止める

**注意: これで Remote Control のセッション（Claude との会話）が切れる。** ここまでの出力を先に Claude に渡しておく。grant は jail の Claude が停止かつ無効で、`sr-designgen` のプロセスが0のときだけ出る。

```bash
( set -euo pipefail
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop      # 期待: CLAUDE_STOPPED
[[ "$(systemctl show -p ActiveState --value sr-jail-claude.service)" =~ ^(inactive|failed)$ ]] || { echo STOP_CLAUDE_STILL_ACTIVE; exit 1; }
[[ "$(systemctl is-enabled sr-jail-claude.service 2>&1 || true)" =~ ^(disabled|masked)$ ]] || { echo STOP_CLAUDE_STILL_ENABLED; exit 1; }
r=0; pgrep -U sr-designgen >/dev/null 2>&1 || r=$?; [ "$r" -eq 1 ] || { echo STOP_WORKER_USER_BUSY; exit 1; }
echo JAIL_IDLE )
```

## (d) 使い捨ての承認 ID・job ID を今つくり、スイッチ1件とジョブを置く

```bash
( set -euo pipefail
RUN=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
APPROVAL=bicycle-run-$RUN; JOB=job-bicycle-$RUN
EXP=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ); REQ=$(date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ)
[ "$APPROVAL" != tsugute-photos-20261106-01 ] || { echo STOP_CONSUMED_ID; exit 1; }
sudo test ! -e "/var/lib/sr-design-cycle/image-approval-used/$APPROVAL" || { echo STOP_APPROVAL_USED; exit 1; }
sudo test ! -e "/var/lib/sr-design-cycle/image-job-used/$JOB" || { echo STOP_JOB_USED; exit 1; }
sudo install -d -o root -g root -m 0755 /etc/sr-design-worker
sudo tee /etc/sr-design-worker/image-autorun.json >/dev/null <<JSON
{ "version": 1, "enabled": true,
  "approvals": [ { "approval_id": "$APPROVAL", "job_id": "$JOB", "shop": "bicycle", "max_images": 6, "max_jobs": 1, "expires_at": "$EXP" } ] }
JSON
sudo chmod 0644 /etc/sr-design-worker/image-autorun.json
T=$(mktemp); cat >"$T" <<JSON
{"version":1,"shop_id":"bicycle","page":"d1-v9","slot_ids":["ph-d","ph-a","ph-c","ph-b","ph-bench-pc","ph-bench-sp"],"brief_sha256":"4b8081e02c08e1d0842c27bf28afab2bc647a9c80acce8464c23acf20e6d7447","approval_id":"$APPROVAL","approval_scope":{"shop":"bicycle","max_images":6,"max_jobs":1,"expires_at":"$EXP"},"requested_at":"$REQ"}
JSON
Q=/home/sr-designgen/sr-design-jobs/image-autorun
sudo install -d -o sr-designgen -g sr-designgen -m 0700 "$Q" "$Q/inbox"
sudo install -o sr-designgen -g sr-designgen -m 0600 "$T" "$Q/inbox/$JOB.json"; rm -f "$T"
sudo stat -c '%U:%G %a %n' /etc/sr-design-worker/image-autorun.json "$Q/inbox/$JOB.json"
echo "APPROVAL=$APPROVAL JOB=$JOB EXPIRES=$EXP   # 控えておく" )
```

期待: `root:root 644 …image-autorun.json`、`sr-designgen:sr-designgen 600 …/inbox/job-bicycle-….json`、最後の行の3つの値（以後 `APPROVAL`・`JOB` に入れて使う）。期限は短く（2時間。上限は24時間）。

## (e) サービスを1回だけ起動し、固定の符号を読む

```bash
T0=$(date '+%Y-%m-%d %H:%M:%S')
sudo systemctl start sr-design-cycle.service; echo "start rc=$?"       # 終わるまで戻らない（最大80分、画像の段は15分以内）
( set -uo pipefail
J=$(journalctl -u sr-design-cycle.service --since "$T0" --no-pager | grep -E 'image grant:|image job:|CYCLE_RESULT|image-autorun: ' || true)
printf '%s\n' "$J" | tail -20
# worker 側の判定（符号だけ。プロンプト・画像は書かれていない）
sudo python3 -I -c 'import json,sys
for l in open(sys.argv[1]).read().splitlines()[-6:]: d=json.loads(l); print(d.get("at"), d.get("code"), d.get("job_id"), d.get("images", ""), d.get("stop_code", ""))' /home/sr-designgen/.local/state/sr-design-worker/image-autorun/audit.jsonl 2>/dev/null || echo "audit.jsonl: none"
grep -q 'image grant: IMAGE_GRANT_ISSUED' <<<"$J" || { echo STOP_IMAGE_GRANT_NOT_ISSUED; exit 1; }
grep -q 'CYCLE_RESULT CYCLE_IMAGE_RUN ' <<<"$J" || { echo STOP_CYCLE_NOT_IMAGE_RUN; exit 1; }
echo GRANT_ISSUED_AND_IMAGE_RUN )
```

期待（順に）: `image grant: IMAGE_GRANT_ISSUED (job job-bicycle-…`、`image-autorun: {"…","code":"APPROVAL_RESERVED"…}`・`"GENERATED"`・`"DONE"`、`CYCLE_RESULT CYCLE_IMAGE_RUN …`、最後に `GRANT_ISSUED_AND_IMAGE_RUN`。
**`IMAGE_GRANT_ISSUED` が無ければ STOP**（(i) へ）。grant が出ないとき、cycle は `CYCLE_RESULT CYCLE_STOP_IMAGE_NOT_GRANTED … exit=26` で worker も bridge も動かさずに止まる（営業の job を claim しない）。

## (f) 確かめる（中身は Git・PR・Issue に貼らない。path と符号だけ）

```bash
( set -euo pipefail
APPROVAL=<(d) の値>; JOB=<(d) の値>; PIN=<MERGE_SHA>
sudo test ! -e /var/cache/sr-design-image-grant/grant.json || { echo STOP_GRANT_LEFT; exit 1; }; echo GRANT_GONE
sudo test -d "/var/lib/sr-design-cycle/image-approval-used/$APPROVAL" && sudo test -d "/var/lib/sr-design-cycle/image-job-used/$JOB" || { echo STOP_ROOT_MARKERS_MISSING; exit 1; }; echo ROOT_USE_MARKERS_PRESENT
sudo test -d "/home/sr-designgen/.local/state/sr-design-worker/poc-approval-used/$APPROVAL" || { echo STOP_WORKER_MARKER_MISSING; exit 1; }; echo WORKER_USE_MARKER_PRESENT
R=/home/sr-designgen/sr-design-jobs/image-autorun/done/$JOB.result.json
sudo python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("RESULT", r["code"]); sys.exit(r["code"]!="DONE")' "$R" || { echo STOP_RESULT_NOT_DONE; exit 1; }
# 生成に使った worker のコードが PIN と同じか（worker は毎回 origin/develop を使う）
WC=$(sudo python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["worker_commit"])' "/home/sr-designgen/.local/state/sr-design-worker/poc-approval-used/$APPROVAL/receipt.json") || { echo STOP_RECEIPT_UNREADABLE; exit 1; }
[[ "$WC" =~ ^[0-9a-f]{40}$ ]] || { echo STOP_RECEIPT_COMMIT; exit 1; }
sudo git -C /root/sr-capture-admin fetch -q origin
sudo git -C /root/sr-capture-admin cat-file -e "$WC^{commit}" || { echo "STOP_WORKER_COMMIT_UNKNOWN $WC"; exit 1; }
sudo git -C /root/sr-capture-admin diff --quiet "$PIN" "$WC" -- scripts/sales-design-worker scripts/design-artifact lib/design-agent docs/design/bicycle-ai-photo-prompt.txt package.json package-lock.json \
  && echo "WORKER_CODE_MATCH $WC" || { echo "STOP_WORKER_CODE_DIFFERS $WC"; exit 1; }
O=/home/sr-designgen/.local/share/second-root-design/image-autorun/$JOB
B=$(sudo find "$O/photos" -mindepth 1 -maxdepth 1 -type d -name 'bicycle-photos-*' 2>/dev/null | head -1 || true)
[ -n "$B" ] || { echo STOP_BUNDLE_MISSING; exit 1; }
[ "$(sudo find "$B" -maxdepth 1 -name 'ph-*.png' | wc -l)" = 6 ] && sudo test -f "$B/manifest.json" || { echo STOP_BUNDLE_INCOMPLETE; exit 1; }; echo BUNDLE_6_PHOTOS_AND_MANIFEST
for v in desktop_1440 tablet_768 mobile_390; do sudo test -f "$O/swap/renders/$v.png" || { echo "STOP_RENDER_MISSING $v"; exit 1; }; done; echo RENDERS_PC_TABLET_SP
sudo ls -1 "$B" "$O/swap/renders"; echo "OUT=$O" )
```

期待: `GRANT_GONE`・`ROOT_USE_MARKERS_PRESENT`・`WORKER_USE_MARKER_PRESENT`・`RESULT DONE`・`WORKER_CODE_MATCH <40文字>`・`BUNDLE_6_PHOTOS_AND_MANIFEST`・`RENDERS_PC_TABLET_SP`。画像は `OUT` の下（`photos/`・`swap/page/`・`swap/renders/`、`swap/rights.private.json`）にだけある。**画像・manifest・private の path を Git・PR・Issue に上げない。** 目視は `docs/design/bicycle-ai-photo-brief.md` §6（V1〜V8・1500/1920 の V7a/V7b）。合格まで SR-001 を「AI写真入り完成」と記録しない。

## (g) OFF に戻す（成功でも失敗でも）

```bash
( set -euo pipefail
sudo rm -f /etc/sr-design-worker/image-autorun.json
sudo test ! -e /etc/sr-design-worker/image-autorun.json || { echo STOP_SWITCH_STILL_PRESENT; exit 1; }; echo SWITCH_REMOVED_OFF
[ "$(systemctl show sr-design-cycle.timer -p LoadState --value)" = not-found ] || { echo STOP_TIMER_PRESENT; exit 1; }; echo TIMER_STILL_NOT_FOUND
sudo ls /var/lib/sr-design-cycle/image-approval-used /var/lib/sr-design-cycle/image-job-used )   # 使用の印は消さない（root の 0700 の下なので sudo ls で見る）
```

**実行の後に残ること（オーナーの承認は1回限り）:** コードの中には「輪は使い終わった」と記録するものが無い。同じ承認 ID・job ID は root と worker の使用の印が拒否するが、**新しい ID を作れば、技術的にはもう一度走れてしまう。** 次の PR（DEV-192 の後続）で、輪を `AUTORUN_SHOPS` と root の `IMAGE_AUTORUN_SHOPS` から外すか、台帳での拒否を足す。それまで、新しい承認 ID で (d)・(e) をやり直さない。

## (h) 任意: Remote Control を戻す

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start      # 期待: CLAUDE_STARTED (jailed)
```

## (i) 失敗したとき

- **再試行しない。** 同じ ID でも新しい ID でも、もう一度 (d)・(e) をしない。まず (g) で OFF に戻す。
- `STOP_IMAGE_GRANT_NOT_ISSUED`（cycle が `CYCLE_STOP_IMAGE_NOT_GRANTED`、exit 26）: grant が出なかった。承認 ID・job ID は**使われていない**、worker も bridge も動いていない、ジョブは inbox に残る（スイッチを消した後の普通の cycle で worker が `HELD_AUTORUN_DISABLED` として held へ移す）。`image grant:` の行の符号をオーナーが見る。
- 符号を集めて Claude に見せる（中身は貼らない）:
  `journalctl -u sr-design-cycle.service --since "$T0" --no-pager | grep -E 'image grant:|CYCLE_RESULT|image-autorun: '`、
  `sudo ls /home/sr-designgen/sr-design-jobs/image-autorun/{done,failed,held}`、`sudo cat …/failed/$JOB.result.json`（codes と path だけの JSON）、
  `sudo test -e /home/sr-designgen/.local/state/sr-design-worker/image-autorun/STOPPED && echo STOPPED_PRESENT`（STOPPED は消さない。オーナーが原因を見てから決める）。
- よくある符号: `IMAGE_GRANT_USER_BUSY`（jail の Claude か `sr-designgen` のプロセスが残っていた。何も使われていない）、`REFUSED_NO_GRANT`（起動が20分を超えた。ID は使用済み）、`REFUSED_JOB_INVALID`（ジョブかプロンプトの SHA の不一致）、`FAILED_GENERATION` / `CODEX_QUOTA`（生成が途中で止まった）、`FAILED_INTAKE` / `FAILED_SWAP`（写真の検査で拒否）。
- root clone を元に戻す必要があるとき（オーナーが決める）:
  `( set -euo pipefail; sudo git -C /root/sr-capture-admin checkout -q --detach bb7da4fa42817ae1c8f0a2ef86587368e84f418e; [ -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }; echo CLONE_RESTORED_BB7DA4F )`
- 次の一手（作り直し・寸法の判断・別の承認）は、オーナーが決める。
