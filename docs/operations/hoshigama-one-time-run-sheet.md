# ほし窯 d2-v2 の AI 写真 3 枚を 1 回だけ本生成する — オーナー用コマンドシート（DEV-139）

> **状態: 使用済み・クローズ (2026-11-19、Issue #290 P0)。** 1 回限りの実生成は実行・検証済み（Issue #139 comment 6990007019:
> `IMAGE_GRANT_ISSUED` → `APPROVAL_RESERVED` → `GENERATED`（images=3、image_tool_calls=3）→ `DONE`、`CYCLE_IMAGE_RUN`、オーナーが `SWITCH_REMOVED` を確認）。
> **このシートの (a)〜(f) はもう実行しない。同じ ID でも新しい ID でも再生成しない。** ほし窯は worker の `AUTORUN_SHOPS` から外し
> （`CLOSED_SHOPS` に記録。載っていればモジュールが読み込みを拒否する）、root の `cycle.sh` は `IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'`
> （334f771 とバイト単位で同じファイル）に戻した。worker は毎回 origin/develop を使うので merge で閉じる。root の clone は (k) でオーナーが合わせる。
> 残すもの: `HOSHIGAMA_APPROVAL`・2 つのプロンプト SHA・差し替えの `aiDemoAllowed`・取り込み/差し替え/包み（(j)）— 生成済みの写真の照合とオフラインの包みのためだけ。
> 以下は記録として残す（当時の手順）。

> **状態: 承認済み (2026-11-18)。** 証跡: Issue #139 comment 6970468763 follow-up, owner message 2026-11-18
> （オーナーの文: 「d2-v2 に写真を入れて続行; 写真3枚 (石窯の口PC・石窯の口SP・田舎パン); docs/design/hoshigama-ai-photo-prompt.txt の本文を
> そのままの内容・SHAで承認; 1回限りの実生成 (最大3 image calls、Codex 1回、15分、再試行なし、ほし窯 d2-v2 のみ、WSL実行); 生成を有効化するコード変更は
> PR＋レビュー付き; ローカル DB の許可は localhost のみ・test shop のみ・Staging/Production なし」。拡大の案 (ph-mouth-pc と ph-loaf、どちらも 2 倍以内) に異議なし）。
>
> 範囲は ほし窯（架空のパン屋 `poc/bakery/facts-pack.json`）d2-v2 の研究用デモ写真の **1 ジョブ・画像呼び出し最大 3 回・Codex 1 回・15 分・再試行なし**。
> **常時の無人実行の許可ではない**（timer は入れない。終わったら OFF に戻し、(g) の PR で一覧から外す）。Claude はこのシートのコマンドを 1 つも実行していない。
> 上から順に、オーナーが WSL で貼る。写真は**デモ用のイメージ**で、実在の店・商品・人・窯ではない。

- 承認済みの実行プロンプト: SHA256 `a7b7d524470a6e271503ca1820db0f0693cecd28e9c51bf4b19b3543f62be7f1`（2668 文字）、核の写真本文
  `docs/design/hoshigama-ai-photo-prompt.txt` SHA256 `372f7802101f679a519bca9ee2af57a07cbd6faf9df5371b70888e9a7ce3a8f6`（2007 バイト・1988 文字。
  先頭 3 行の見出しを含むファイルのバイトそのもの）。**どちらかが違えば承認は失効 → STOP。** テスト（`photo-swap-hoshigama.test.ts`）がこの 2 つの値を固定している。
- 決まり（輪のシートと同じ）: 各ブロックは `( set -euo pipefail … )` の中で動き、門で止まると `STOP_*` を出してそのブロックを終える（端末は閉じない）。
  **`STOP_*`・想定外の出力が出たら先へ進まず、出力をそのまま Claude に見せる。** 秘密（token・auth.json・env の中身・鍵）は表示しない（`stat` だけ）。
- 使用済みの `tsugute-photos-20261106-01` と、輪の run で使った承認 ID・job ID は絶対に使わない（worker も root も拒否する）。

## 1. 決定（2026-11-18）

| # | 項目 | 決定 |
|---|---|---|
| A1 | d2-v2 に写真を入れる価値 | **入れて続行**（オーナーの決定） |
| A2 | 枚数 | **3 枚**: ph-mouth-pc（石窯の口 PC、1:1）・ph-mouth-sp（石窯の口 SP、2:3）・ph-loaf（田舎パン、4:3） |
| A3 | プロンプトの本文 | `docs/design/hoshigama-ai-photo-prompt.txt` を**そのままの内容・SHA で承認**: SHA-256 `372f7802…a8f6`・2007 バイト・1988 文字 |
| A4 | 実行プロンプト | `buildHoshigamaRunPromptCandidate` が組むもの: SHA-256 `a7b7d524…62be7f1`・2668 文字 |
| A5 | 寸法と拡大 | 拡大を許すのは ph-mouth-pc と ph-loaf だけ、どちらも既存の 2 倍以内（lanczos3）。上限 `HOSHIGAMA_MAX_UPSCALE` = 2 のまま（異議なし） |
| A6 | 1 回限りの実生成 | **1 ジョブ・画像呼び出し最大 3 回・Codex 1 回・15 分・再試行なし・ほし窯 d2-v2 だけ・WSL で実行**。承認 ID・job ID・期限は実行の直前にオーナーが決める（コードに書かない） |
| A7 | コードの差分 | この PR（`feature/dev-139-hoshigama-photo-run-enable`、レビュー付き）。中身は §3 |
| A8 | ローカル DB の許可 | **localhost のみ・test shop（S0 の ほし窯）のみ・Staging/Production なし**。§4 のローカル専用 patch と取り込みの許可 |
| A9 | 文章入りの v2 の包み | d2-v2（`<wbr>` の無い版）で写真＋文章の v2 を作る（§2 の (j)） |

記録: `lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts` の `HOSHIGAMA_APPROVAL`
（`approval_record: "hoshigama-one-time-run-20261118"`、`decided_on: "2026-11-18"`、`jobs: 1`、`max_image_calls: 3`、`codex_runs: 1`、`timeout_minutes: 15`、
`retry: false`、`upscale_allowed: ["ph-mouth-pc", "ph-loaf"]`、両方の SHA と長さ）。

## 2. オーナーの WSL 手順

前提: この PR が develop に merge されている。`<MERGE_SHA>` はその merge commit（40 文字）。Claude が merge 後に知らせる値をそのまま入れる。
root の clone `/root/sr-capture-admin` は輪の run の (b) で `334f771fed0c953158aefc3926a208adf8a8ddc5`（DEV-192 の merge）に合わせてある前提。違えば (a) が止まる。

### (a) 読むだけの事前確認（何も変えない）

```bash
sudo bash /root/sr-capture-admin/scripts/ops/wsl-resource-preflight.sh; echo "preflight rc=$?"   # OK(0) か SERIAL(10) なら進む。STOP(20) なら始めない
```

```bash
( set -euo pipefail
systemctl show sr-design-cycle.service -p UnitFileState -p ActiveState --no-pager      # 期待: UnitFileState=static / ActiveState=inactive
[ "$(systemctl show sr-design-cycle.service -p ActiveState --value)" = inactive ] || { echo STOP_CYCLE_RUNNING; exit 1; }
[ "$(systemctl show sr-design-cycle.timer -p LoadState --value)" = not-found ] || { echo STOP_TIMER_PRESENT; exit 1; }; echo TIMER_NOT_FOUND
sudo test ! -e /etc/sr-design-worker/image-autorun.json || { echo STOP_SWITCH_PRESENT; exit 1; }; echo SWITCH_ABSENT
[ "$(sudo git --no-optional-locks -C /root/sr-capture-admin rev-parse HEAD)" = 334f771fed0c953158aefc3926a208adf8a8ddc5 ] || { echo STOP_CLONE_NOT_334F771; exit 1; }; echo CLONE_AT_334F771
[ -z "$(sudo git --no-optional-locks -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }; echo CLONE_CLEAN
printf 'sr-jail-claude: enabled=%s active=%s\n' "$(systemctl is-enabled sr-jail-claude.service 2>&1 || true)" "$(systemctl is-active sr-jail-claude.service 2>&1 || true)"
sudo test ! -e /home/sr-designgen/.local/state/sr-design-worker/image-autorun/STOPPED || { echo STOP_WORKER_STOPPED_MARKER; exit 1; }; echo NO_STOPPED_MARKER
for d in /home/sr-designgen/sr-design-jobs/image-autorun/inbox /home/sr-designgen/sr-design-jobs/image-autorun/processing; do
  sudo test ! -e "$d" || [ -z "$(sudo find "$d" -maxdepth 1 -type f -print -quit)" ] || { echo STOP_IMAGE_INBOX_NOT_EMPTY; exit 1; }
done; echo IMAGE_INBOX_EMPTY
sudo stat -c '%U %a %s bytes %n' /home/sr-designgen/.codex/auth.json || { echo STOP_NO_CODEX_SIGNIN; exit 1; }   # 中身は出さない
sudo test ! -e /home/sr-designgen/.codex/.env || { echo STOP_CODEX_DOTENV; exit 1; }; echo CODEX_SIGNIN_PRESENT_NO_DOTENV
echo PREFLIGHT_OK )
```

期待: `TIMER_NOT_FOUND`・`SWITCH_ABSENT`・`CLONE_AT_334F771`・`CLONE_CLEAN`・`NO_STOPPED_MARKER`・`IMAGE_INBOX_EMPTY`・`sr-designgen … auth.json`・`PREFLIGHT_OK`。
jail の Claude はこの時点では動いていてよい（(c) で止める）。

### (b) コード・範囲・SHA の照合と root clone の更新（バックアップしてから）

root が動かすファイルで 334f771 から変わるのは `cycle.sh` の 2 行（コメント 1 行と allowlist 1 行）だけ。その差を SHA-256 で固定してある:

- 差（`git diff --no-color --full-index 334f771f… <PIN> -- scripts/sales-design-worker/cycle.sh` の出力）の SHA-256: `520fb507180e257a8892c47b8ee243ebf45b67b96e640747be209eae0a511b5a`
- 更新後の `cycle.sh` ファイルそのものの SHA-256: `000a566b49f794b9e358400ddc404ba929a167f09bdf38f9f160ed2b68464a58`（更新前 334f771 は `8beb350dcc7b85a78c0ea060638d4922362d02d25e8eba1d798152fe2d146dab`）

（輪の (b) は `--full-index` なしの差を固定した。短縮した blob 名は clone によって長さが変わりうるので、今回は `--full-index` にした。）

```bash
( set -euo pipefail
PIN=<MERGE_SHA>
OLD=334f771fed0c953158aefc3926a208adf8a8ddc5
C=/root/sr-capture-admin
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || { echo STOP_PIN_NOT_40_HEX; exit 1; }
BK=/root/sr-dev139-backup-$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o root -g root -m 0700 "$BK"
sudo git -C "$C" rev-parse HEAD | sudo tee "$BK/clone-head" >/dev/null                # 旧 HEAD の控え（戻し方で使う）
sudo git -C "$C" fetch -q origin
sudo git -C "$C" merge-base --is-ancestor "$OLD" "$PIN" || { echo STOP_PIN_NOT_AFTER_334F771; exit 1; }
sudo git -C "$C" merge-base --is-ancestor "$PIN" origin/develop || { echo STOP_PIN_NOT_ON_DEVELOP; exit 1; }
# worker は毎回 origin/develop を使う: hook・prompt・写真の流れが PIN と同じバイトであること（違えば STOP してオーナーに確認）
sudo git -C "$C" diff --quiet "$PIN" origin/develop -- scripts/sales-design-worker scripts/design-artifact lib/design-agent docs/design/hoshigama-ai-photo-prompt.txt || { echo STOP_DEVELOP_MOVED_WORKER_CODE; exit 1; }
echo PIN_OK
# root が動かすファイルの差（期待: cycle.sh の 1 ファイルだけ。unit・admin.sh・jail・ops・bridge は 0）
sudo git -C "$C" diff --stat "$OLD" "$PIN" -- scripts/sales-design-capture scripts/sales-design-worker/cycle.sh scripts/sales-design-worker/systemd scripts/ops scripts/sales-design-bridge
sudo git -C "$C" diff "$OLD" "$PIN" -- scripts/sales-design-worker/cycle.sh | grep '^[-+][^-+]' || true
[ "$(sudo git -C "$C" diff --name-only "$OLD" "$PIN" -- scripts/sales-design-capture scripts/sales-design-worker/cycle.sh scripts/sales-design-worker/systemd scripts/ops scripts/sales-design-bridge)" = scripts/sales-design-worker/cycle.sh ] || { echo STOP_ROOT_FILES_NOT_ONLY_CYCLE; exit 1; }
# 差そのものを固定する（DEV-139 のレビュー済みの差。違えば STOP）
[ "$(sudo git -C "$C" diff --no-color --full-index "$OLD" "$PIN" -- scripts/sales-design-worker/cycle.sh | sha256sum | cut -d' ' -f1)" = 520fb507180e257a8892c47b8ee243ebf45b67b96e640747be209eae0a511b5a ] || { echo STOP_ROOT_DIFF_NOT_REVIEWED; exit 1; }; echo ROOT_DIFF_PINNED
read -r -p "差が cycle.sh の allowlist に 'bakery:3' を足す 1 行（と DEV-139 のコメント 1 行）だけなら yes: " a; [ "$a" = yes ] || { echo NOT_CONFIRMED; exit 1; }
sudo git -C "$C" checkout -q --detach "$PIN"
[ "$(sudo git -C "$C" rev-parse HEAD)" = "$PIN" ] || { echo STOP_CLONE_NOT_AT_PIN; exit 1; }
[ -z "$(sudo git -C "$C" status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }
[ "$(sudo sha256sum "$C/scripts/sales-design-worker/cycle.sh" | cut -d' ' -f1)" = 000a566b49f794b9e358400ddc404ba929a167f09bdf38f9f160ed2b68464a58 ] || { echo STOP_CYCLE_SHA; exit 1; }; echo CYCLE_SHA_OK
sudo cmp /etc/systemd/system/sr-design-cycle.service "$C/scripts/sales-design-worker/systemd/sr-design-cycle.service" || { echo STOP_UNIT_DIFFERS; exit 1; }; echo UNIT_SAME
[ "$(sudo grep -c "^IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6 bakery:3'$" "$C/scripts/sales-design-worker/cycle.sh")" = 1 ] || { echo STOP_ROOT_ALLOWLIST; exit 1; }; echo ROOT_ALLOWLIST_OK
[ "$(sudo sha256sum "$C/docs/design/hoshigama-ai-photo-prompt.txt" | cut -d' ' -f1)" = 372f7802101f679a519bca9ee2af57a07cbd6faf9df5371b70888e9a7ce3a8f6 ] || { echo STOP_CORE_PROMPT_SHA; exit 1; }
[ "$(sudo stat -c %s "$C/docs/design/hoshigama-ai-photo-prompt.txt")" = 2007 ] || { echo STOP_CORE_PROMPT_BYTES; exit 1; }
sudo grep -q 'HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256 = "a7b7d524470a6e271503ca1820db0f0693cecd28e9c51bf4b19b3543f62be7f1"' "$C/lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts" || { echo STOP_RUN_PROMPT_PIN; exit 1; }
sudo grep -q 'HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS = 2668;' "$C/lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts" || { echo STOP_RUN_PROMPT_CHARS; exit 1; }
sudo grep -q 'approval_record: "hoshigama-one-time-run-20261118",' "$C/lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts" || { echo STOP_APPROVAL_RECORD; exit 1; }
echo PROMPT_SHAS_OK
echo "BK=$BK   # 控えておく" )
```

期待: `PIN_OK`、diff --stat は `scripts/sales-design-worker/cycle.sh | 3 ++-` の 1 行だけ、`ROOT_DIFF_PINNED`、`yes`、`CYCLE_SHA_OK`・`UNIT_SAME`・`ROOT_ALLOWLIST_OK`・`PROMPT_SHAS_OK`。
実行プロンプト本体の SHA は worker が実行の前に組み立て直して照合し、違えば `REFUSED_JOB_INVALID`（生成 0 回）で止まる。

### (c) jail の Claude（Remote Control）を止める

**注意: これで Remote Control のセッション（Claude との会話）が切れる。** ここまでの出力を先に Claude に渡しておく。

```bash
( set -euo pipefail
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-stop      # 期待: CLAUDE_STOPPED
[[ "$(systemctl show -p ActiveState --value sr-jail-claude.service)" =~ ^(inactive|failed)$ ]] || { echo STOP_CLAUDE_STILL_ACTIVE; exit 1; }
[[ "$(systemctl is-enabled sr-jail-claude.service 2>&1 || true)" =~ ^(disabled|masked)$ ]] || { echo STOP_CLAUDE_STILL_ENABLED; exit 1; }
r=0; pgrep -U sr-designgen >/dev/null 2>&1 || r=$?; [ "$r" -eq 1 ] || { echo STOP_WORKER_USER_BUSY; exit 1; }
echo JAIL_IDLE )
```

### (d) 承認 ID・期限を入れ、スイッチ 1 件とジョブを置く

**上の 4 行をオーナーが埋める。** 承認 ID の提案は `s0-hoshigama-photos-20261118-01`（実行日が違えば日付を変えてよい。**新しい ID**であること）。
`EXP`（`expires_at`）は**置く時点から 24 時間以内の未来**（短くてよい。例: 2 時間後）、`REQ`（`requested_at`）は今より少し前。どちらも UTC の `YYYY-MM-DDTHH:MM:SSZ`。

```bash
( set -euo pipefail
APPROVAL='s0-hoshigama-photos-20261118-01'          # <APPROVAL_ID> 提案値（新しい ID）
JOB='job-s0-hoshigama-20261118-01'                   # <JOB_ID>（ジョブのファイル名。新しい ID）
EXP='<EXPIRES_AT>'                                   # 例: 出力をそのまま貼る → date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ
REQ='<REQUESTED_AT>'                                 # 例: 出力をそのまま貼る → date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ
[[ "$APPROVAL" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] && [[ "$JOB" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || { echo STOP_ID_FORMAT; exit 1; }
[[ "$EXP" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && [[ "$REQ" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo STOP_TIME_FORMAT; exit 1; }
NOW=$(date -u +%s); E=$(date -u -d "$EXP" +%s); Q=$(date -u -d "$REQ" +%s)
[ "$E" -gt "$NOW" ] && [ $((E - NOW)) -le 86400 ] || { echo STOP_EXPIRY_NOT_WITHIN_24H; exit 1; }
[ "$Q" -le "$NOW" ] && [ $((NOW - Q)) -le 3600 ] || { echo STOP_REQUESTED_AT; exit 1; }
[ "$APPROVAL" != tsugute-photos-20261106-01 ] || { echo STOP_CONSUMED_ID; exit 1; }
sudo test ! -e "/var/lib/sr-design-cycle/image-approval-used/$APPROVAL" || { echo STOP_APPROVAL_USED; exit 1; }
sudo test ! -e "/var/lib/sr-design-cycle/image-job-used/$JOB" || { echo STOP_JOB_USED; exit 1; }
sudo test ! -e "/home/sr-designgen/.local/state/sr-design-worker/poc-approval-used/$APPROVAL" || { echo STOP_WORKER_APPROVAL_USED; exit 1; }
sudo install -d -o root -g root -m 0755 /etc/sr-design-worker
sudo tee /etc/sr-design-worker/image-autorun.json >/dev/null <<JSON
{ "version": 1, "enabled": true,
  "approvals": [ { "approval_id": "$APPROVAL", "job_id": "$JOB", "shop": "bakery", "max_images": 3, "max_jobs": 1, "expires_at": "$EXP" } ] }
JSON
sudo chmod 0644 /etc/sr-design-worker/image-autorun.json
T=$(mktemp); cat >"$T" <<JSON
{"version":1,"shop_id":"bakery","page":"d2-v2","slot_ids":["ph-mouth-pc","ph-mouth-sp","ph-loaf"],"brief_sha256":"a7b7d524470a6e271503ca1820db0f0693cecd28e9c51bf4b19b3543f62be7f1","approval_id":"$APPROVAL","approval_scope":{"shop":"bakery","max_images":3,"max_jobs":1,"expires_at":"$EXP"},"requested_at":"$REQ"}
JSON
Q2=/home/sr-designgen/sr-design-jobs/image-autorun
sudo install -d -o sr-designgen -g sr-designgen -m 0700 "$Q2" "$Q2/inbox"
sudo install -o sr-designgen -g sr-designgen -m 0600 "$T" "$Q2/inbox/$JOB.json"; rm -f "$T"
sudo stat -c '%U:%G %a %n' /etc/sr-design-worker/image-autorun.json "$Q2/inbox/$JOB.json"
echo "APPROVAL=$APPROVAL JOB=$JOB EXPIRES=$EXP   # 控えておく" )
```

期待: `root:root 644 …image-autorun.json`、`sr-designgen:sr-designgen 600 …/inbox/job-s0-hoshigama-….json`、最後の行の 3 つの値（以後 `APPROVAL`・`JOB` に入れて使う）。

### (e) サービスを 1 回だけ起動し、固定の符号を読む（worker の one-shot）

```bash
T0=$(date '+%Y-%m-%d %H:%M:%S')
sudo systemctl start sr-design-cycle.service; echo "start rc=$?"       # 終わるまで戻らない（最大80分、画像の段は15分以内）
( set -uo pipefail
J=$(journalctl -u sr-design-cycle.service --since "$T0" --no-pager | grep -E 'image grant:|image job:|CYCLE_RESULT|image-autorun: ' || true)
printf '%s\n' "$J" | tail -20
sudo python3 -I -c 'import json,sys
for l in open(sys.argv[1]).read().splitlines()[-6:]: d=json.loads(l); print(d.get("at"), d.get("code"), d.get("job_id"), d.get("images", ""), d.get("stop_code", ""))' /home/sr-designgen/.local/state/sr-design-worker/image-autorun/audit.jsonl 2>/dev/null || echo "audit.jsonl: none"
grep -q 'image grant: IMAGE_GRANT_ISSUED' <<<"$J" || { echo STOP_IMAGE_GRANT_NOT_ISSUED; exit 1; }
grep -q 'CYCLE_RESULT CYCLE_IMAGE_RUN ' <<<"$J" || { echo STOP_CYCLE_NOT_IMAGE_RUN; exit 1; }
echo GRANT_ISSUED_AND_IMAGE_RUN )
```

期待（順に）: `image grant: IMAGE_GRANT_ISSUED (job job-s0-hoshigama-…`、`"APPROVAL_RESERVED"`・`"GENERATED"`・`"DONE"`、`CYCLE_RESULT CYCLE_IMAGE_RUN …`、`GRANT_ISSUED_AND_IMAGE_RUN`。
**`IMAGE_GRANT_ISSUED` が無ければ STOP**（(i) へ）。

### (f) 確かめる（中身は Git・PR・Issue に貼らない。path と符号だけ）

```bash
( set -euo pipefail
APPROVAL=<(d) の値>; JOB=<(d) の値>; PIN=<MERGE_SHA>
sudo test ! -e /var/cache/sr-design-image-grant/grant.json || { echo STOP_GRANT_LEFT; exit 1; }; echo GRANT_GONE
sudo test -d "/var/lib/sr-design-cycle/image-approval-used/$APPROVAL" && sudo test -d "/var/lib/sr-design-cycle/image-job-used/$JOB" || { echo STOP_ROOT_MARKERS_MISSING; exit 1; }; echo ROOT_USE_MARKERS_PRESENT
sudo test -d "/home/sr-designgen/.local/state/sr-design-worker/poc-approval-used/$APPROVAL" || { echo STOP_WORKER_MARKER_MISSING; exit 1; }; echo WORKER_USE_MARKER_PRESENT
R=/home/sr-designgen/sr-design-jobs/image-autorun/done/$JOB.result.json
sudo python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("RESULT", r["code"]); sys.exit(r["code"]!="DONE")' "$R" || { echo STOP_RESULT_NOT_DONE; exit 1; }
WC=$(sudo python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["worker_commit"])' "/home/sr-designgen/.local/state/sr-design-worker/poc-approval-used/$APPROVAL/receipt.json") || { echo STOP_RECEIPT_UNREADABLE; exit 1; }
[[ "$WC" =~ ^[0-9a-f]{40}$ ]] || { echo STOP_RECEIPT_COMMIT; exit 1; }
sudo git -C /root/sr-capture-admin fetch -q origin
sudo git -C /root/sr-capture-admin cat-file -e "$WC^{commit}" || { echo "STOP_WORKER_COMMIT_UNKNOWN $WC"; exit 1; }
sudo git -C /root/sr-capture-admin diff --quiet "$PIN" "$WC" -- scripts/sales-design-worker scripts/design-artifact lib/design-agent docs/design/hoshigama-ai-photo-prompt.txt package.json package-lock.json \
  && echo "WORKER_CODE_MATCH $WC" || { echo "STOP_WORKER_CODE_DIFFERS $WC"; exit 1; }
O=/home/sr-designgen/.local/share/second-root-design/image-autorun/$JOB
B=$(sudo find "$O/photos" -mindepth 1 -maxdepth 1 -type d -name 'hoshigama-photos-*' 2>/dev/null | head -1 || true)
[ -n "$B" ] || { echo STOP_BUNDLE_MISSING; exit 1; }
[ "$(sudo find "$B" -maxdepth 1 -name 'ph-*.png' | wc -l)" = 3 ] && sudo test -f "$B/manifest.json" || { echo STOP_BUNDLE_INCOMPLETE; exit 1; }; echo BUNDLE_3_PHOTOS_AND_MANIFEST
[ "$(sudo find "$O/pipeline/.intake/photos" -maxdepth 1 -name 'hoshigama-ai-ph-*.png' | wc -l)" = 3 ] || { echo STOP_INTAKE_INCOMPLETE; exit 1; }; echo INTAKE_3_PHOTOS
for v in desktop_1440 mobile_390; do sudo test -f "$O/swap/renders/$v.png" || { echo "STOP_RENDER_MISSING $v"; exit 1; }; done; echo RENDERS_PC_SP
sudo ls -1 "$B" "$O/swap/renders"; echo "OUT=$O" )
```

期待: `GRANT_GONE`・`ROOT_USE_MARKERS_PRESENT`・`WORKER_USE_MARKER_PRESENT`・`RESULT DONE`・`WORKER_CODE_MATCH <40文字>`・`BUNDLE_3_PHOTOS_AND_MANIFEST`・`INTAKE_3_PHOTOS`・`RENDERS_PC_SP`。
画像は `OUT` の下（`photos/`・`pipeline/.intake/photos/`・`swap/page/`・`swap/renders/`、`swap/rights.private.json`）にだけある。**画像・manifest・private の path を Git・PR・Issue に上げない。**
目視は `docs/design/hoshigama-ai-photo-brief.md` §5 の V1〜V8（MOCK・stub の写真では 1 つも合格にしない）。

### (g) OFF に戻す（成功でも失敗でも）と、一覧から外す PR

```bash
( set -euo pipefail
sudo rm -f /etc/sr-design-worker/image-autorun.json
sudo test ! -e /etc/sr-design-worker/image-autorun.json || { echo STOP_SWITCH_STILL_PRESENT; exit 1; }; echo SWITCH_REMOVED_OFF
[ "$(systemctl show sr-design-cycle.timer -p LoadState --value)" = not-found ] || { echo STOP_TIMER_PRESENT; exit 1; }; echo TIMER_STILL_NOT_FOUND
sudo ls /var/lib/sr-design-cycle/image-approval-used /var/lib/sr-design-cycle/image-job-used )   # 使用の印は消さない
```

**実行の後に必ずすること（承認は 1 回限り）:** 同じ承認 ID・job ID は root と worker の使用の印が拒否するが、**新しい ID を作れば技術的にはもう一度走れてしまう**。
そのため実行の後すぐ（成功でも失敗でも）、Claude が**後続の PR** を出す: ほし窯を worker の `AUTORUN_SHOPS`（`scripts/sales-design-worker/autorun-shops.ts`）と
root の `IMAGE_AUTORUN_SHOPS`（`cycle.sh`、`'tsugute:6 bicycle:6'` に戻す）から外し、`autorun-shops.test.ts`・`hoshigama-real-path.test.ts`・
`photo-swap-hoshigama.test.ts` を外した状態に合わせる（差し替えの `aiDemoAllowed` と `HOSHIGAMA_APPROVAL` は、生成済みの写真の取り込み・包みに要るので残す）。
merge の後、オーナーが root の clone をその merge SHA に合わせる（(b) と同じ形で、差は cycle.sh の allowlist を戻す行だけ）。それまで、新しい承認 ID で (d)・(e) をやり直さない。

**(g) の後続 PR = Issue #290 P0（このシートの状態欄）。** 中身: `AUTORUN_SHOPS.bakery` と worker の ほし窯 の run bundle writer を外し、`CLOSED_SHOPS` に記録、
`cycle.sh` を 334f771 と同じバイトに戻す（`bakery:3` と DEV-139 のコメント 1 行を消す）。テストは「閉じていること」を確かめる形に変えた
（`hoshigama-real-path.test.ts`: owner のエントリ・root の grant・新しい ID が揃っても `REFUSED_JOB_INVALID`・生成 0 回、root の matcher は `IMAGE_GRANT_SCOPE_MISMATCH`。
`design-worker-cycle.test.ts`: 本物の cycle.sh が新しい ID の ほし窯 に grant を出さず、何も消費しない）。root の clone の更新は (k)。

### (h) 任意: Remote Control を戻す

```bash
sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start      # 期待: CLAUDE_STARTED (jailed)
```

### (i) 失敗したとき

- **再試行しない。** 同じ ID でも新しい ID でも、もう一度 (d)・(e) をしない。まず (g) で OFF に戻す。
- `STOP_IMAGE_GRANT_NOT_ISSUED`（cycle が `CYCLE_STOP_IMAGE_NOT_GRANTED`、exit 26）: grant が出なかった。承認 ID・job ID は使われていない、worker も bridge も動いていない。`image grant:` の行の符号を見る。
- 符号を集めて Claude に見せる（中身は貼らない）:
  `journalctl -u sr-design-cycle.service --since "$T0" --no-pager | grep -E 'image grant:|CYCLE_RESULT|image-autorun: '`、
  `sudo ls /home/sr-designgen/sr-design-jobs/image-autorun/{done,failed,held}`、`sudo cat …/failed/$JOB.result.json`（codes と path だけの JSON）、
  `sudo test -e /home/sr-designgen/.local/state/sr-design-worker/image-autorun/STOPPED && echo STOPPED_PRESENT`（STOPPED は消さない）。
- よくある符号: `IMAGE_GRANT_USER_BUSY`・`REFUSED_NO_GRANT`（起動が 20 分を超えた。ID は使用済み）・`REFUSED_JOB_INVALID`（ジョブかプロンプトの SHA の不一致）・
  `FAILED_GENERATION` / `CODEX_QUOTA`・`FAILED_INTAKE`（例: `UPSCALE_EXCEEDS_MAX:ph-mouth-pc` = 2 倍を超える拡大が要る大きさ、`BELOW_TARGET:ph-mouth-sp` = 拡大を許していない写真が目標に届かない）・`FAILED_SWAP`。
  どれも作り直しは別の承認（オーナーが決める）。
- root clone を元に戻す必要があるとき（オーナーが決める）:
  `( set -euo pipefail; sudo git -C /root/sr-capture-admin checkout -q --detach 334f771fed0c953158aefc3926a208adf8a8ddc5; [ -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }; echo CLONE_RESTORED_334F771 )`

### (j) ローカルで包み・取り込み・管理画面（オーナーの普段の WSL ユーザー、localhost だけ）

輪の `docs/operations/rin-ai-photos-local.md` と同じ形。**DB の変更はこのローカルの stack だけ**（localhost・test shop の S0 ほし窯だけ・Staging/Production には当てない）。
Docker が要る（`docker ps` が通らなければ止める）。重い処理は (a) の判定が `SERIAL` なら一つずつ。

**j-1. checkout と依存とローカルの Supabase**

```bash
cd ~/sr-rin-local/second-root 2>/dev/null || { mkdir -p ~/sr-rin-local && cd ~/sr-rin-local && git clone https://github.com/ioda47871-byte/second-root.git && cd second-root; }
git fetch -q origin && git checkout -q --detach <MERGE_SHA> && [ -z "$(git status --porcelain)" ] && echo LOCAL_AT_PIN
scripts/ops/wsl-resource-preflight.sh; echo "preflight rc=$?"
npm ci
npx playwright install chromium          # --with-deps は付けない
npx supabase start -x studio,imgproxy,realtime,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE
set -a; . <(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)='); set +a
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" SUPABASE_DB_URL="$DB_URL"
docker exec -i supabase_db_second-root psql -U postgres -tAc "select count(*) from public.sales_demo_images where source_kind = 'ai_generated_demo' or rights_status = 'ai_demo_internal'"
```

最後の数が `0` でなければ（輪のローカルの写真が残っている）**止めて Claude に知らせる**。ほし窯の patch は S0 だけを許すので、その stack では当てられない
（`OTHER_AI_DEMO_ROWS_PRESENT`）。輪のローカルの版を消してよいとオーナーが決めたときだけ `npx supabase db reset` で空にしてから進む。

**j-2. 入力を読むだけでコピーする（sudo）** — `O` は (f) の `OUT`。

```bash
O='<(f) の OUT>'
T=$(mktemp -d "$HOME/hoshigama-input.XXXXXX")
sudo test -f "$O/swap/swap-summary.json" || echo STOP_NO_SUMMARY
sudo find "$O/pipeline/.intake/photos" "$O/swap" -type f -exec sha256sum {} + | sort -k2 > "$T/before.sha256"
sudo cp -r "$O/swap/page" "$T/page"
sudo cp -r "$O/swap/renders" "$T/renders"
sudo cp "$O/swap/rights.private.json" "$O/swap/swap-summary.json" "$T/"
sudo mkdir "$T/originals" && sudo cp "$O/pipeline/.intake/photos"/hoshigama-ai-ph-*.png "$T/originals/"
sudo chown -R "$(id -un):$(id -gn)" "$T" && chmod -R go-rwx "$T"
sudo find "$O/pipeline/.intake/photos" "$O/swap" -type f -exec sha256sum {} + | sort -k2 | diff - "$T/before.sha256" && echo ORIGINALS_UNCHANGED
ls "$T/originals" | wc -l                          # 3
```

（`originals` は取り込みが検めて写した 3 枚。拡大した ph-mouth-pc・ph-loaf は拡大後のもの。権利の記録はこのバイトを指す。）

**j-3. 描写の確認（オーナーが 1 枚ずつ目で見て書く）** — 形は輪の `rin-ai-photos-local.md` §5 と同じ（`rin_depiction_confirmation_v0`、`confirmation` の文もそのまま）。
`sha256sum "$T/originals"/*.png` の 3 行の値を入れ、`~/hoshigama-depiction.json`（0600、Git に入れない）に置く。1 枚でも実在のものを写していれば `true` にする（包みは `DEPICTS_REAL` で止まる）。

**j-4. 包む（写真＋文章の v2。書くのは `$T/pkg` だけ）**

```bash
npx tsx scripts/sales/demo-version/package-local.ts --out "$T/pkg" \
  --page "$T/page" --rights "$T/rights.private.json" --summary "$T/swap-summary.json" \
  --originals "$T/originals" --depiction-confirmation ~/hoshigama-depiction.json \
  --facts design-library/research/quality-pipeline/poc/bakery/facts-pack.json \
  --compare-renders "$T/renders" --png-out "$T/full"
```

期待: `"status": "OK"`、`"format": "sales_demo_version_package_v2"`、`photos` に 5 件（田舎パンの SP は PC と同じ切り抜きを共有）、`compare` に desktop_1440 / mobile_390。
`FAIL` ならその `code` だけを Claude に渡す。

**j-5. 管理者と S0 の seed（ローカルだけ）**

```bash
ADMIN_EMAIL=hoshigama-preview@test.example.com; ADMIN_PW="$(openssl rand -base64 18)"
ADMIN_ID=$(curl -sS -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\",\"email_confirm\":true}" \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["id"])')
docker exec -i supabase_db_second-root psql -U postgres -c "insert into public.sales_admins (user_id) values ('$ADMIN_ID')"
echo "$ADMIN_PW"                                   # この端末に出るだけ。どこにも書かない
REC="$HOME/s0-seed-record.json"
npx tsx scripts/sales/demo-version/s0-local-seed.ts seed --admin "$ADMIN_ID" --record "$REC" --owner-approved-local-seed
```

期待: `prospect_id` が `13900000-5e00-4d00-8a00-000000000001`（`docs/operations/s0-local-db-seed.md` §2 の 5 行）。

**j-6. ローカルだけの patch（S0 だけ）**

```bash
npx tsx scripts/sales/demo-version/apply-local-hoshigama-patch.ts --owner-approved-local-patch
```

- 期待: `{"status":"OK","patch":"local-hoshigama-ai-photos","scope":"local only","prospect":"s0 fictional bakery","revert":"npx supabase db reset"}`。何度実行しても同じ。
- 変えるのは 2 つだけ（`scripts/sales/demo-version/local-hoshigama-ai-photos.sql`、migration ではない）: check `sales_demo_images_real_shop_no_ai_demo` を S0 の id のときだけ AI のデモ画像を許す形に、
  関数 `sales_check_demo_image_write()` を「S0 の id で、その行に S0 の架空の印があるときだけ `ai_generated_demo`、depicts_* がすべて false・出所が正しい・public_web が false のときだけ `ai_demo_internal`、それ以外は `unknown`」に。
- **S0 の架空の印**（`lib/demo-version-package/local-hoshigama-patch.ts`）: 名前 `架空パン店 ほし窯`・正規化名 `架空ぱん店ほし窯`・住所 `名古屋市瑞穂区架空町四丁目2-6`・正規化住所 `愛知県名古屋市瑞穂区架空町4-2-6`
  （facts pack から `s0RegistryRow` が作る値）、Instagram なし、メール・サイトは空か `info@s0-bakery.example.com`・`https://s0-bakery.example.com/`（`s0-bakery.example.com`）だけ、推奨チャネルは空か email、
  出典（`sales_sources`）はすべて `info@s0-bakery.example.com` のメールで出典 URL がその example のサイトの下。どれか 1 つでも崩れれば拒否。
- 止まる符号: `HOSHIGAMA_PATCH_FLAG_MISSING`（旗なし）・`DB_URL_*`（ローカルでない DB）・`S0_SEED_MISSING` / `S0_SEED_MARKERS`（j-5 の seed がない・印が違う）・
  `OTHER_AI_DEMO_ROWS_PRESENT`（ほかの店の AI 画像がある。j-1 の注意）。どれも何も変えない。
- 元に戻す: `npx supabase db reset`（この stack の DB と Storage の行が消え、migration どおりに戻る）。

**j-7. 取り込み（facts は S0 の seed が保存したもの）**

```bash
npx tsx scripts/sales/demo-version/import-local.ts --package "$T/pkg" --prospect 13900000-5e00-4d00-8a00-000000000001 --facts-from-store
```

期待: `"status": "OK"`、`created: true`、files がすべて upload して照合済み、`copy` は `sendable: false`。写真入りの版は `ai_demo_internal`（管理画面の確認だけ）で、**送信・共有には出ない**。
j-6 の patch を当てていなければ `INGEST_REFUSED` で止まり、何も残らない。S0 以外の prospect には `AI_DEMO_NOT_ALLOWED`（取り込みのコードが拒む）。

**j-8. 管理画面（preview の旗だけ）**

```bash
SALES_DEMO_VERSIONS_ENABLED=true SALES_DEMO_VIEW_SIGNING_KEY="$(openssl rand -base64 32)" npx next dev --webpack -p 3140 -H 127.0.0.1
```

Windows のブラウザで `http://localhost:3140/admin/login` → j-5 の利用者でログイン → `/admin/sales/demos/13900000-5e00-4d00-8a00-000000000001`。
見ること: 写真 2 枠（石窯の口・田舎パン）が PC と SP で出ている（SP の石窯の口は SP 用の写真）、文章、「AI 生成のデモ画像を含む (デモ専用・共有不可)」、共有の欄が無い、390 で横にはみ出さない。
screenshot は自分の PC にだけ置く。

**j-9. 後片付け**

```bash
# app を Ctrl-C で止めてから
npx supabase db reset                # j-6 の patch を外し、migration どおりに戻す（この stack だけ。S0 の seed と版も消える）
npx supabase stop --no-backup        # 任意: container と volume を消す
rm -rf -- "$T"                       # 一時のコピーと包み（元の job の出力はそのまま）
unset SERVICE_ROLE_KEY SUPABASE_SERVICE_ROLE_KEY ANON_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY DB_URL SUPABASE_DB_URL ADMIN_PW
```

### (k) クローズの後: root の clone をクローズの merge に合わせる（Issue #290 P0、オーナーが WSL で。サービスは起動しない）

前提: Issue #290 P0 の PR が develop に merge されている。`<CLOSE_MERGE_SHA>` はその merge commit（40 文字）。Claude が merge 後に知らせる値をそのまま入れる。
root の clone `/root/sr-capture-admin` は (b) で DEV-139 の merge `573e7935afa7dc7ddf66ac4fbbd81206900f9987` に合わせてある前提。違えば止まる（出力を Claude に見せる）。
**この手順は `sr-design-cycle.service` を起動しない・スイッチを置かない・使用の印を消さない。** jail の Claude は止めなくてよい。

root が動かすファイルで 573e793 から変わるのは `cycle.sh` の 2 行（DEV-139 のコメント 1 行と allowlist 1 行）を消すことだけ。その結果、`cycle.sh` は 334f771 とバイト単位で同じになる:

- 差（`git diff --no-color --full-index 573e7935… <CLOSE_MERGE_SHA> -- scripts/sales-design-worker/cycle.sh` の出力）の SHA-256: `c2dc2d2058bb3db2cef0c6bd39b545b7b9cb56130d2a11c8e7c53f02c29f83e7`
- 更新後の `cycle.sh` ファイルそのものの SHA-256: `8beb350dcc7b85a78c0ea060638d4922362d02d25e8eba1d798152fe2d146dab`（= 334f771 のもの。更新前 573e793 は `000a566b…4a58`）

k-1. 読むだけの確認（何も変えない）

```bash
( set -euo pipefail
[ "$(systemctl show sr-design-cycle.service -p ActiveState --value)" = inactive ] || { echo STOP_CYCLE_RUNNING; exit 1; }; echo CYCLE_INACTIVE
[ "$(systemctl show sr-design-cycle.timer -p LoadState --value)" = not-found ] || { echo STOP_TIMER_PRESENT; exit 1; }; echo TIMER_NOT_FOUND
sudo test ! -e /etc/sr-design-worker/image-autorun.json || { echo STOP_SWITCH_PRESENT; exit 1; }; echo SWITCH_ABSENT
sudo test ! -e /var/cache/sr-design-image-grant/grant.json || { echo STOP_GRANT_PRESENT; exit 1; }; echo GRANT_ABSENT
[ "$(sudo git --no-optional-locks -C /root/sr-capture-admin rev-parse HEAD)" = 573e7935afa7dc7ddf66ac4fbbd81206900f9987 ] || { echo STOP_CLONE_NOT_573E793; exit 1; }; echo CLONE_AT_573E793
[ -z "$(sudo git --no-optional-locks -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }; echo CLONE_CLEAN
sudo ls /var/lib/sr-design-cycle/image-approval-used /var/lib/sr-design-cycle/image-job-used   # 使用の印（消さない）
echo CLOSE_PREFLIGHT_OK )
```

期待: `CYCLE_INACTIVE`・`TIMER_NOT_FOUND`・`SWITCH_ABSENT`・`GRANT_ABSENT`・`CLONE_AT_573E793`・`CLONE_CLEAN`・使用の印の一覧・`CLOSE_PREFLIGHT_OK`。

k-2. 照合して clone を更新（バックアップしてから）

```bash
( set -euo pipefail
PIN=<CLOSE_MERGE_SHA>
OLD=573e7935afa7dc7ddf66ac4fbbd81206900f9987
PRE=334f771fed0c953158aefc3926a208adf8a8ddc5
C=/root/sr-capture-admin
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || { echo STOP_PIN_NOT_40_HEX; exit 1; }
BK=/root/sr-dev139-close-backup-$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o root -g root -m 0700 "$BK"
sudo git -C "$C" rev-parse HEAD | sudo tee "$BK/clone-head" >/dev/null                # 旧 HEAD の控え
sudo git -C "$C" fetch -q origin
sudo git -C "$C" merge-base --is-ancestor "$OLD" "$PIN" || { echo STOP_PIN_NOT_AFTER_573E793; exit 1; }
sudo git -C "$C" merge-base --is-ancestor "$PIN" origin/develop || { echo STOP_PIN_NOT_ON_DEVELOP; exit 1; }
echo PIN_OK
# root が動かすファイルの差（期待: cycle.sh の 1 ファイルだけ。unit・admin.sh・jail・ops・bridge は 0）
sudo git -C "$C" diff --stat "$OLD" "$PIN" -- scripts/sales-design-capture scripts/sales-design-worker/cycle.sh scripts/sales-design-worker/systemd scripts/ops scripts/sales-design-bridge
sudo git -C "$C" diff "$OLD" "$PIN" -- scripts/sales-design-worker/cycle.sh | grep '^[-+][^-+]' || true
[ "$(sudo git -C "$C" diff --name-only "$OLD" "$PIN" -- scripts/sales-design-capture scripts/sales-design-worker/cycle.sh scripts/sales-design-worker/systemd scripts/ops scripts/sales-design-bridge)" = scripts/sales-design-worker/cycle.sh ] || { echo STOP_ROOT_FILES_NOT_ONLY_CYCLE; exit 1; }
[ "$(sudo git -C "$C" diff --no-color --full-index "$OLD" "$PIN" -- scripts/sales-design-worker/cycle.sh | sha256sum | cut -d' ' -f1)" = c2dc2d2058bb3db2cef0c6bd39b545b7b9cb56130d2a11c8e7c53f02c29f83e7 ] || { echo STOP_CLOSE_DIFF_NOT_REVIEWED; exit 1; }; echo CLOSE_DIFF_PINNED
sudo git -C "$C" diff --quiet "$PRE" "$PIN" -- scripts/sales-design-worker/cycle.sh || { echo STOP_CYCLE_NOT_334F771_BYTES; exit 1; }; echo CYCLE_SAME_AS_334F771
read -r -p "差が cycle.sh から 'bakery:3' の allowlist 1 行と DEV-139 のコメント 1 行を消すだけ（追加は 'tsugute:6 bicycle:6' の 1 行）なら yes: " a; [ "$a" = yes ] || { echo NOT_CONFIRMED; exit 1; }
sudo git -C "$C" checkout -q --detach "$PIN"
[ "$(sudo git -C "$C" rev-parse HEAD)" = "$PIN" ] || { echo STOP_CLONE_NOT_AT_PIN; exit 1; }
[ -z "$(sudo git -C "$C" status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }
[ "$(sudo sha256sum "$C/scripts/sales-design-worker/cycle.sh" | cut -d' ' -f1)" = 8beb350dcc7b85a78c0ea060638d4922362d02d25e8eba1d798152fe2d146dab ] || { echo STOP_CLOSE_CYCLE_SHA; exit 1; }; echo CYCLE_SHA_OK
sudo cmp /etc/systemd/system/sr-design-cycle.service "$C/scripts/sales-design-worker/systemd/sr-design-cycle.service" || { echo STOP_UNIT_DIFFERS; exit 1; }; echo UNIT_SAME
[ "$(sudo grep -c "^IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'$" "$C/scripts/sales-design-worker/cycle.sh")" = 1 ] || { echo STOP_ROOT_ALLOWLIST; exit 1; }; echo ROOT_ALLOWLIST_CLOSED
r=0; sudo grep -q bakery "$C/scripts/sales-design-worker/cycle.sh" || r=$?; [ "$r" -eq 1 ] || { echo STOP_BAKERY_STILL_IN_CYCLE; exit 1; }; echo NO_BAKERY_IN_CYCLE
echo "BK=$BK   # 控えておく" )
```

期待: `PIN_OK`、diff --stat は `scripts/sales-design-worker/cycle.sh | 3 +--` の 1 行だけ、`CLOSE_DIFF_PINNED`・`CYCLE_SAME_AS_334F771`・`yes`・`CYCLE_SHA_OK`・`UNIT_SAME`・`ROOT_ALLOWLIST_CLOSED`・`NO_BAKERY_IN_CYCLE`。
出力（`STOP_*` を含め）を Claude に見せる。秘密は出ない（path と符号だけ）。

- **戻し方（オーナーが決める）:** 573e793 へは戻さない（`bakery:3` が root に戻る）。戻す必要があれば 334f771（ほし窯 を載せる前・同じ cycle.sh）へ:
  `( set -euo pipefail; sudo git -C /root/sr-capture-admin checkout -q --detach 334f771fed0c953158aefc3926a208adf8a8ddc5; [ -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" ] || { echo STOP_CLONE_DIRTY; exit 1; }; echo CLONE_AT_334F771 )`
- worker（`sr-designgen` の checkout）は毎回 origin/develop を使うので、merge の時点で ほし窯 のジョブを `REFUSED_JOB_INVALID` で拒否する。worker 側の操作は無い。
- `systemctl daemon-reload`・unit の入れ替え・timer の導入・スイッチの作成は**この手順に含まない**（unit は変わっていない: `UNIT_SAME`）。

## 3. この PR の差分（§4 (1)〜(6) と §5 を入れたもの）

| # | ファイル | 中身 |
|---|---|---|
| (1) | `lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts` | `HOSHIGAMA_APPROVAL` の記録（§1） |
| (2) | `lib/design-agent/quality-pipeline/photo-swap-shops.ts` | `bakery`: `aiDemoAllowed: true`、`aiDemoPromptSha256: HOSHIGAMA_PROMPT_DRAFT_SHA256` |
| (3) | `scripts/sales-design-worker/autorun-shops.ts` | `AUTORUN_SHOPS.bakery`（d2-v2、3 枚、実行プロンプトの pin、`promptApproval`、`hoshigama_ai_photos_v0`、取り込み、2 倍） |
| (4) | `scripts/sales-design-worker/image-autorun.ts` | `BUNDLE_WRITERS.hoshigama_ai_photos_v0`（`writeHoshigamaPhotosForRun`） |
| (5) | `scripts/sales-design-worker/cycle.sh` | `IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6 bakery:3'`（root の clone の更新は (b)、差の SHA を固定） |
| (6) | テスト | `autorun-shops.test.ts`（manifest と allowlist の一致）、`photo-swap-hoshigama.test.ts`（承認後の値・2 つの SHA を文字どおり固定）、`hoshigama-photo-pipeline.test.ts`（CLI が v2 を書く・取り込みの許可）、`hoshigama-real-path.test.ts`（worker の鎖: 欠ければ生成 0 回、揃えば 1 回だけ）、`bicycle-real-path-off.test.ts`（一覧の値） |
| §5 | `scripts/sales/demo-version/local-hoshigama-ai-photos.sql`・`lib/demo-version-package/local-hoshigama-patch.ts`・`scripts/sales/demo-version/apply-local-hoshigama-patch.ts`・`lib/demo-version-package/import.ts` | ローカル専用の patch（migration ではない）と、取り込みの許可（`AI_DEMO_PROSPECT_IDS` = 輪と S0、写真がすべて `ai_demo_internal` のときだけ）。テスト: `local-hoshigama-patch.test.ts`（単体）、`tests/integration/hoshigama-local-patch.test.ts`（CI の使い捨てローカル Supabase、rollback する transaction の中） |

残した門（緩めていない）: root のスイッチのエントリ（1 ジョブ）・root の使用の印・20 分の grant・worker の使用の台帳・timer なし・再試行なし・拡大 2 倍の上限・
プロンプトの 2 つの SHA の照合・差し替えの権利の検査・包みの描写の確認・送信/共有の不可。

## 4. 寸法と拡大（既存の 2 倍の規則は緩めていない）

| 写真 | 比 | 2 倍の目標 | 1.5 倍の下限 (例外の記録が要る) | よくある生成の大きさから |
|---|---|---|---|---|
| ph-mouth-pc | 1:1 | 1370×1370 | 1020×1020 | 1536² → 拡大なし。1024² → 1.338 倍（許可の一覧にあるので通る）。640² → 2.14 倍 → `UPSCALE_EXCEEDS_MAX` |
| ph-mouth-sp | 2:3 | 650×975 | 490×735 | 1024×1536 → 拡大なし（拡大は許していない） |
| ph-loaf | 4:3 | 1750×1313 | 1310×983 | 1536×1024 (3:2) → 4:3 に切って 1.283 倍（許可の一覧にある）。1024×768 → 1.709 倍 |

- 2 倍に届かない写真（例 1280²、1920 の端で 1.88 倍）は差し替えが `SCALE_EXCEPTION_REQUIRED`。オーナーの例外の記録（`scale_exception`、1.5 以上）があれば通る。
- ph-loaf はどの幅でも板の形が 1.2 で、PC 1440 と SP 390 の切り抜きが同じ矩形になる。差し替えは同じ切り抜きを 1 つのファイルで共有する（`shareIdenticalCrops`）。

## 5. 実生成の後

- 写真・manifest・権利の記録は私有の成果物のまま、リポジトリに入れない（`docs/design/photo-intake.md` §3）。
- 指示書 §5 の V1〜V8 をオーナーが目で埋める。MOCK・stub の写真では 1 つも合格にしない。
- 包みの前に、オーナーが写真ごとに描写の確認を書く（j-3）。
- (g) の後続 PR で、ほし窯を `AUTORUN_SHOPS` と `IMAGE_AUTORUN_SHOPS` から外す。→ **済み（Issue #290 P0、状態欄）。root の clone は (k)。**
