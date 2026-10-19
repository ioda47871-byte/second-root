# design worker の 1 回分の cycle（DEV-052）

Staging の design bridge と worker を、安全な 1 回分の「cycle」として repo の script から動かす。
これまでは人が root で貼り付ける WSL script（DEV-046 の `dev046_window3.sh`、R2 で修正）でしか動かなかった。
その安全ガード（resource preflight・時間予算・STOP 条件・claim 1 件・deliver-only）を、そのまま repo に置いた。

- script: `scripts/sales-design-worker/cycle.sh`（root が root だけの clone `/root/sr-capture-admin` から動かす）
- unit: `scripts/sales-design-worker/systemd/sr-design-cycle.service` / `.timer`（**repo は install も enable もしない**）
- test: `tests/unit/design-worker-cycle.test.ts`（fake の bridge・worker・preflight で STOP 条件・時間・lock・出力を確かめる）

**この文書の install・enable は人が行う。timer の enable には人の承認が要る（DEV-052 の human approval trigger）。**
cycle は DB・Vercel・jail・helper・admin.sh・bridge の権限・`SR_DESIGN_*` の安全設定を変えない。

設計は `docs/ARCHITECTURE.md` §10、bridge は `design-bridge.md`、worker は `design-worker-wsl.md`、jail は `design-wsl-isolation.md`、
Vercel Authentication を維持したまま bridge を通す方式は `design-bridge-access.md`（DEV-059）。
その設定（bridge の bypass file・env の 2 行・接続の確認・この文書の conf があるときだけ `SR_DESIGN_CYCLE_VERCEL_BYPASS=on` と `cycle.sh --dry-run`）は、
人が 1 回貼る `sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh`（DEV-063、`design-bridge-access.md` §6）が行う。
その script は conf が無ければ作らない（§4 の install は HUMAN-010 のまま）。

## 1. 1 回の cycle で何が起きるか

```
root（systemd の sr-design-cycle.service、または人の sudo）
  cycle.sh（/root/sr-capture-admin。許可した環境変数だけで自分を起動し直す）
   0. flock（1 本だけ）。予算 4500 秒の締め切りを最初に決める（延ばさない）
   1. resource preflight（scripts/ops/wsl-resource-preflight.sh）。STOP なら何も始めない
   2. 読むだけの確認（下の表）
   3. idle の worker run（admin.sh run sr-designgen -- … run.sh --max=1）
        heartbeat を書き、bridge が閉じた job の結果 file を消す。imported 0・no jobs・exported 0 であること
   4. bridge --deliver-only（sr-designbridge として）。delivered / superseded / refused / expired がすべて 0 であること
   5. 残り 4220 秒以上なら bridge --once。claim はちょうど 1 件か、0 件（CYCLE_IDLE で終わる）
   6. 残り 3960 秒以上なら worker --max=1（予算 3300 秒、jail の中、RuntimeMaxSec=3500）
        出力に STOP の符号があれば止まる。imported 1・その job の claimed・exported 1 であること
   7. 残り 260 秒以上なら bridge --deliver-only。その job だけが delivered 1 であること
```

権限の経路は既存のものだけ:

| 何を | どう動かす | 理由 |
|---|---|---|
| worker | `bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- /usr/bin/env SR_DESIGN_WORKER_REF=develop SR_DESIGN_BRIDGE_SPOOL=/srv/sr-design-bridge SR_DESIGN_WORKER_BUDGET_SECONDS=3300 /home/sr-designgen/work/second-root/scripts/sales-design-worker/run.sh --max=1` | DEV-046 の R2 と同じ。`sr-designgen` は jail の中でしか動かさない（`design-wsl-isolation.md`） |
| bridge | `runuser -u sr-designbridge -- … ~sr-designbridge/second-root/scripts/sales-design-bridge/run.sh --deliver-only / --once` | `design-bridge.md` §6 の `sudo -u sr-designbridge` と同じ利用者。root 用の `runuser` を使うのは、unit の `NoNewPrivileges=yes` の下では sudo が動かないため。token は bridge が自分の 0600 file から読み、cycle は読まない |
| bridge の checkout の git・ledger・env file を読む | `sr-designbridge` として | root が他の利用者の `.git/config` や link を辿って何かを実行・読むことをしない |

### 確認（2.）

どれかが成り立たなければ `CYCLE_STOP_CHECK`（exit 21）で、何も動かさない。出力は固定の符号だけで、値は出さない。

| 符号 | 確かめること |
|---|---|
| `CHECK_SCRIPT_UNTRUSTED` | cycle.sh・preflight・admin.sh・設定 file と、その上のすべての directory が root の所有で、他から書けない |
| `CHECK_ROOT_CLONE_DIRTY` | `/root/sr-capture-admin` に変更がない |
| `CHECK_CONFIG_MISSING` / `_UNSAFE` / `_INVALID` | `/etc/second-root/design-cycle.conf` に `SR_DESIGN_CYCLE_BRIDGE_SHA=<承認した bridge の commit、40 文字>` が 1 行だけある。root の所有、他から書けない。任意の `SR_DESIGN_CYCLE_VERCEL_BYPASS=on\|off` は 1 行まで（無ければ off） |
| `CHECK_UNIT_ACTIVE` / `CHECK_UNIT_ENABLED` | `sr-design-bridge.{timer,service}`・`sr-design-worker.{timer,service}` が動いていない。2 つの timer が enable されていない（claim は cycle だけが行う） |
| `CHECK_BRIDGE_RUNNING` / `CHECK_WORKER_RUNNING` | `sr-designbridge` の process も、`sr-designgen` の worker / bridge の process もない |
| `CHECK_BRIDGE_NOT_AT_SHA` / `CHECK_BRIDGE_DIRTY` / `CHECK_BRIDGE_MISSING` | bridge の checkout が設定の commit にあり、clean |
| `CHECK_ENV_FILE_UNSAFE` / `CHECK_ENV_INVALID` | `design-bridge.env` が `sr-designbridge` の 0600 の通常 file で、`SR_DESIGN_BRIDGE_API_URL=https://…` が 1 行 |
| `CHECK_TOKEN_FILE_UNSAFE` | token file が `sr-designbridge` の 0600 の通常 file（中身は読まない） |
| `CHECK_BYPASS_INVALID` / `CHECK_BYPASS_FILE_UNSAFE` | `SR_DESIGN_CYCLE_VERCEL_BYPASS=on` のときだけ（DEV-059。このスイッチは cycle が bypass を渡すかだけを決め、env の 2 行があれば bridge の unit・手での実行は使う）: `design-bridge.env` に `SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=<絶対 path>` と `SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=https://<name>.vercel.app` が 1 行ずつあり、origin が API URL の origin と同じ。bypass file が `sr-designbridge` の 0600 の通常 file（中身は読まない）。`design-bridge-access.md` |
| `CHECK_LEDGER_INVALID` / `CHECK_LEDGER_OPEN` | bridge の ledger が読め、開いている job が 0 件（前の cycle が claim の後で止まっていない） |
| `CHECK_SPOOL_MISSING` / `CHECK_SPOOL_PENDING` | spool の 2 つの directory があり、`to-worker/` に job file がない |
| `CHECK_WORKER_QUEUE_BUSY` / `CHECK_WORKER_MISSING` | worker の `inbox/`・`processing/` が空、worker の checkout に `run.sh` がある |

### STOP の符号（6. の worker 出力、3. の idle run）

`LOGIN_REQUIRED`・`LOGIN_WALL`・`LOGIN_ABORTED`・`INSTAGRAM_CHALLENGE`・`INSTAGRAM_CAPTCHA`・`CHALLENGE`・`CAPTCHA`・`WAITING_FOR_PERSON`・`SKIPPED_NO_TIME`・`RATE_CAPPED`・`RATE_LIMITED`・
`JAIL_UNSAFE`・`JAIL_NOT_INSTALLED`・`JAIL_PROPS_FAILED`・`JAIL_UNIT_REJECTED`・`HOST_UNSAFE`・`ADMIN_SCRIPT_UNTRUSTED`・`REQUESTER_*`・`WSL_INTEROP_*`・
`BRIDGE_*`・`CODEX_SANDBOX_*`・`CODEX_API_KEY_AUTH`・`CODEX_NOT_SIGNED_IN`・`CODEX_NOT_INSTALLED`・`CODEX_QUOTA`・`SPOOL_UNSAFE`・
`WORKER_NOT_ON_REF`・`WORKER_TREE_DIRTY`・`WORKER_ENV_FILE_PRESENT`・`WORKER_LOCK_FAILED`・`WORKER_RUN_TIME_BUDGET`・`RUN_TIME_BUDGET`・`WORKER_STOPPED_BY_SIGNAL`・`WORKER_UNEXPECTED`・`WORKER_SYSTEM_ERROR`・`OOM`・`Killed`

- 符号は単語全体で比べる。`JAIL_OK`・`LOGIN_OK` などは一致しない（DEV-046 Window 5 の誤検出を繰り返さない）
- worker が exit 0 でも、これらの符号があれば止まり、結果を届けない。例: `LOGIN_WALL` で `PUBLIC_SOURCE_UNAVAILABLE` になった job を届けると、demo は終端の `blocked` になる（Window 6）。セッションの問題で demo を閉じないため
- `RATE_LIMITED`（`job <id>: PUBLIC_SOURCE_UNAVAILABLE (RATE_LIMITED)`、Instagram・website の 429 や「しばらくしてから」の画面）も一時的なものなので止まる
- capture helper が答えなかったとき（`signed-in capture` が `BROWSER_BUSY`・`HELPER_BUSY`・`HELPER_ERROR`・`CAPTURE_FAILED`・`CAPTURE_HELPER_TIMEOUT`・`CAPTURE_HELPER_UNAVAILABLE`・`CAPTURE_RESULT_INVALID`・`CAPTURE_REQUEST_INVALID`・`REQUEST_INVALID`）、worker は公開 capture に切り替える。その job が `PUBLIC_SOURCE_UNAVAILABLE` で終わったら、店の答えではなく helper の問題なので止まる（`CYCLE_STOP_WORKER_SIGNAL`）。公開 capture で撮れたときは届ける
- 回避しない。再試行しない。符号の一覧を緩めるのは STOP 条件の緩和なので、人の判断が要る

## 2. 時間の予算（R2 と同じ考え方）

| 値 | 秒 | 根拠 |
|---|---|---|
| cycle の予算 | 4500 | R2 の時間窓の下限。開始時に締め切りを決め、延ばさない |
| claim の前に残っていること | 4220 | claim の 1 回の最悪（260）+ worker の前の 3960 |
| worker の前に残っていること | 3960 | worker の最悪（admin.sh run の RuntimeMaxSec 3500 + systemd の停止の猶予 90）+ 最後の bridge 1 回（260）+ 余裕 110 |
| worker の予算 | 3300 | `SR_DESIGN_WORKER_BUDGET_SECONDS`（run.sh の上限。変えない） |
| bridge 1 回 | 最大 260 | bridge run.sh の `timeout --kill-after=10 240`、cycle 側でも 250 + 5 で切る |
| unit の `TimeoutStartSec` | 4800 | cycle は 4500 の中で終わる。これは最後の手段 |

- 開始から 280 秒以内に claim、540 秒以内に worker を始められなければ止まる（idle run で `npm ci` が走った回など）。claim の前なら何も変わらない
- この関係は `budget_ok`（script の起動時）と test（admin.sh・run.sh・bridge run.sh の値との突き合わせ）が確かめる

## 3. 出力と `CYCLE_RESULT`

子の出力は 1 行ずつ `  <段>| …` で表示する。その前に次を消す: URL（`[url]`）、メールアドレス（`[email]`）、Bearer の値・`token=` / `"access_token": "…"` などの値・`Cookie:` / `Set-Cookie:` の行のすべての値・`x-api-key <値>`・JWT・既知の key の接頭辞・32 文字以上の 16 進（job id の `b-<uuid>` と UUID は残る）・長い乱数らしい文字列（`[redacted]`）、制御文字。1 行 300 文字、1 段 200 行まで。
`*bypass*` という名前の値（`x-vercel-protection-bypass: <値>` など）も `[redacted]` になる（DEV-059）。
worker と bridge はもともと符号と定型文だけを出す。これは二重の守り。env file の URL と token は表示しない（token は読みもしない）。Vercel の bypass の値も読まず、path と origin だけを bridge に渡す。確認の段で `cycle: vercel bypass: on|off` を 1 行出す。

最後の行は機械で読む 1 行:

```
CYCLE_RESULT <CODE> phase=<before_claim|claim_unknown|after_claim|done> job=<b-…|none> exit=<n>
```

| CODE | exit | phase | 意味 | すること |
|---|---|---|---|---|
| `CYCLE_OK` | 0 | done | 1 件を claim → worker → delivered 1 | `/admin/sales` で確認。人が DM を送る |
| `CYCLE_DRY_RUN_OK` | 0 | before_claim | `--dry-run` で preflight と確認が通った | なし |
| `CYCLE_IDLE` | 10 | before_claim | claim する job がない | なし（unit では失敗扱いにしない） |
| `CYCLE_LOCKED` | 11 | before_claim | 別の cycle が動いている。何もしていない | なし |
| `CYCLE_USAGE` | 2 | before_claim | 引数が違う、root でない、root だけの clone の外から起動した、test の hook を本番で渡した | 起動の仕方を直す |
| `CYCLE_STOP_PREFLIGHT` | 20 | before_claim | resource preflight が STOP | `wsl-resource-preflight.md` §4・§5。`.wslconfig` は人の承認なしに変えない |
| `CYCLE_STOP_CHECK` | 21 | before_claim | §1 の確認のどれか | 表示された `CHECK_*` を直す。`CHECK_LEDGER_OPEN` は §6 |
| `CYCLE_STOP_IDLE_RUN` | 22 | before_claim | idle run が失敗・符号あり・idle でない・結果 file が残った | 出力の符号を見る（`LOGIN_REQUIRED` なら `admin.sh login`、`JAIL_UNSAFE` なら `admin.sh jail-check`） |
| `CYCLE_STOP_DELIVER_BEFORE` | 23 | before_claim | 最初の `--deliver-only` がすべて 0 でない | 想定外の ledger・spool。読むだけで調べる |
| `CYCLE_STOP_TIME_BEFORE_CLAIM` | 24 | before_claim | claim の前に 4220 秒残っていない | 次の回でよい（続くなら idle run の時間を調べる） |
| `CYCLE_STOP_CLAIM` | 25 | before_claim / after_claim | `--once` が失敗した、ちょうど 1 件でない、`BRIDGE_WORKER_IDLE` | `stopped: BRIDGE_*` を見る（§7）。phase が after_claim なら §6 |
| `CYCLE_STOP_TIME_BEFORE_WORKER` | 30 | after_claim | claim の後、worker の前に 3960 秒残っていない | §6 |
| `CYCLE_STOP_WORKER_SIGNAL` | 31 | after_claim | worker の出力に STOP の符号 | 符号の原因（login・jail・bridge）を先に直し、§6 |
| `CYCLE_STOP_WORKER_EXIT` | 32 | after_claim | worker が 0 以外で終わった（137 なら OOM の確認を自動で 1 回表示） | `OOM_KILL_FOUND` なら resource failure として止まる。§6 |
| `CYCLE_STOP_WORKER_RESULT` | 33 | after_claim | imported 1・その job の claimed・exported 1 がそろわない | §6 |
| `CYCLE_STOP_DELIVER_AFTER` | 34 | after_claim | 最後の `--deliver-only` がその job だけを届けなかった | §6 |
| `CYCLE_STOP_TIME_BEFORE_DELIVER` | 35 | after_claim | 最後の bridge の前に 260 秒残っていない（予算の上では起きない） | §6 |
| `CYCLE_STOP_SIGNAL` | 40 | どれでも | systemd の停止・Ctrl-C | after_claim なら §6。jail の worker unit（`sr-jail-run-*`）は別の unit なので、RuntimeMaxSec まで残りうる: `systemctl list-units 'sr-jail-run-*'` |
| `CYCLE_STOP_INTERNAL` | 41 | どれでも | script の想定外のエラー | 出力を見て直す。after_claim なら §6 |

## 4. install と dry-run（人、承認の後）

前提: `design-bridge.md` の §1〜§5（migration・token・利用者と spool・jail・bridge の checkout）と、capture helper・jail（`design-capture-helper.md`・`design-wsl-isolation.md`）が終わっていること。

1. root だけの clone を、承認した commit に合わせて clean を確かめる（`design-bridge.md` §4 と同じ 1 行の形）:
   ```bash
   sudo git -C /root/sr-capture-admin fetch -q origin \
     && sudo git -C /root/sr-capture-admin checkout -q --detach <承認した commit（40 文字）> \
     && test -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" && echo CLONE_OK
   ```
2. bridge の checkout（`~sr-designbridge/second-root`）が承認した commit にあることを確かめ、その commit を設定 file に書く:
   ```bash
   sudo install -d -o root -g root -m 0755 /etc/second-root
   printf 'SR_DESIGN_CYCLE_BRIDGE_SHA=%s\n' '<bridge の承認した commit（40 文字）>' | sudo tee /etc/second-root/design-cycle.conf >/dev/null
   sudo chmod 0644 /etc/second-root/design-cycle.conf
   ```
3. dry-run（preflight と読むだけの確認。worker も bridge も動かさない）:
   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run
   ```
   最後の行が `CYCLE_RESULT CYCLE_DRY_RUN_OK …` であること。
4. 手で 1 回（承認した window の中で。Staging の flag と Vercel は §7）:
   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh
   ```
5. unit を置く（enable はしない）:
   ```bash
   sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-design-cycle.service /etc/systemd/system/
   sudo install -m 0644 /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-design-cycle.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemd-analyze verify /etc/systemd/system/sr-design-cycle.service
   sudo systemctl start sr-design-cycle.service     # unit の中で 1 回（timer なし）
   journalctl -u sr-design-cycle.service -n 80 --no-pager
   ```
   unit の hardening（`ProtectSystem=strict` など）の下で admin.sh run・runuser・bridge が動くことは、実機ではまだ確かめていない。
   ここで `CYCLE_STOP_INTERNAL` や権限のエラーが出たら、enable しない。

## 5. enable・止める・戻す

**timer の enable は人の承認の後だけ。**承認の前提: §4 の手での 1 回と unit での 1 回が `CYCLE_OK` か `CYCLE_IDLE`、Staging の flag を常時 ON にする判断（§7）が済んでいること。

```bash
sudo systemctl enable --now sr-design-cycle.timer      # 承認の後
systemctl list-timers sr-design-cycle.timer
```

- 毎時 17 分 + 最大 10 分の乱数。前の cycle が動いている間の起動は systemd が飛ばし、lock も断る
- `sr-design-bridge.timer` は enable しない（claim は cycle だけが行う。enable されていると cycle は `CHECK_UNIT_ENABLED` で止まる）
- 止める（すぐ。動いている cycle も止める）:
  ```bash
  sudo systemctl disable --now sr-design-cycle.timer
  sudo systemctl stop sr-design-cycle.service
  sudo systemctl stop 'sr-jail-run-*'     # jail の worker は admin.sh run の別の transient unit。cycle を止めても残る
  systemctl list-units 'sr-jail-run-*' --no-pager   # 何も残っていないこと
  ```
  claim の後に止めたときは §6。
- Instagram のログインの前（`admin.sh login`）は timer を止め、動いている cycle が終わるのを待つ（`systemctl is-active sr-design-cycle.service` が `inactive`）。終わったら timer を戻す
- 戻す（unit を消す）:
  ```bash
  sudo systemctl disable --now sr-design-cycle.timer
  sudo rm -f /etc/systemd/system/sr-design-cycle.service /etc/systemd/system/sr-design-cycle.timer
  sudo systemctl daemon-reload
  ```
  `/etc/second-root/design-cycle.conf` と `/var/lib/sr-design-cycle`（lock だけ）は残してよい。DB・spool・ledger は cycle が作るものではないので戻さない。

## 6. claim の後で止まったとき（`phase=after_claim` / `claim_unknown`）

その job は Staging で `processing` のまま残る。**cycle は DB を変えず、再試行もしない。**次の cycle は `CHECK_LEDGER_OPEN` で止まるので、人が片付けるまで先へ進まない。

### 6.1 読むだけで調べる

```bash
# cycle の出力（符号と job id だけ）
journalctl -u sr-design-cycle.service -n 200 --no-pager
# bridge の ledger で開いている job（id だけ）
sudo runuser -u sr-designbridge -- python3 -I -c 'import json,sys; j=json.load(open(sys.argv[1]))["jobs"]; print("\n".join(k for k,v in j.items() if not v.get("closed")))' /home/sr-designbridge/.local/state/sr-design-bridge/ledger.json
# spool の file 名だけ
sudo ls -l /srv/sr-design-bridge/to-worker /srv/sr-design-bridge/from-worker
# worker の記録（outcome と符号だけを見る。Codex の出力・URL は載っていない）
sudo ls /home/sr-designgen/sr-design-jobs/{inbox,processing,done,failed}
sudo python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("outcome"), r.get("code"))' /home/sr-designgen/sr-design-jobs/done/<job>.result.json
```

Staging の demo（`sales_demos` の `design_status`・`design_job_id`・`design_attempts`）も読むだけで確かめる。`design_job_id` は `<job>` から `b-` を除いた uuid。

### 6.2 片付け方（どれも人の判断。DB の書き込みは人の承認が要る）

| 状況 | 片付け方 |
|---|---|
| worker の結果は正しく、届けてよい（例: 最後の bridge が `BRIDGE_API_UNAVAILABLE` で失敗しただけ） | 原因を直してから bridge を手で 1 回: `design-bridge.md` §6 の 4.（`--deliver-only`）→ `delivered 1`・その job であること |
| 結果を届けてはいけない（`LOGIN_WALL`・`LOGIN_REQUIRED` などで `blocked` になると、demo が終端で閉じる） | job id を条件にして demo を `pending` に戻す（R1 と同じ。`design_attempts` は変えない）。次に `--deliver-only` で古い結果を `superseded` で閉じる（Window 6b）。ledger の open が 0 になったことを 6.1 で確かめる |
| worker が結果を出さずに止まった（`from-worker/` にその job の file がない。例: `CYCLE_STOP_SIGNAL`・`CYCLE_STOP_WORKER_EXIT`・`CYCLE_STOP_TIME_BEFORE_WORKER`） | 届けるものはない。worker・jail の unit が残っていないこと（§5 の `sr-jail-run-*`）を確かめ、bridge の local expiry（claim から 2 時間 15 分）を待つ → 人が `--deliver-only` を 1 回（`design-bridge.md` §6 の 4.）→ `expired 1`、その job であること（bridge は `to-worker/` の job file も消す）→ 手で worker を 1 回（§1 の表の worker の行と同じ `admin.sh run … --max=1`）。job が `inbox/` にあれば import がそれを取り下げる（`bridge: imported 0, withdrawn 1`・`no jobs in the inbox`）。job が `processing/` にあれば、worker 自身の stale recovery（持ち主の process がない `HOLDER_GONE` など）がその run の中で `inbox/` に戻し、`--max=1` で 1 回実行する（試行を 1 回数える）。その結果は bridge が閉じた job なので export されず、届かない → 6.1 で worker の `inbox/`・`processing/` が空、ledger の open が 0、spool が空であることを確かめる。demo は server の lease で次の claim の時に `pending` に戻る（`DESIGN_STALE`） |
| 急がない | 何もしない。server の lease（2 時間）と bridge の local expiry（2 時間 15 分）が過ぎた後、人が `--deliver-only` を 1 回 → ledger が `expired` で閉じる。次の claim で demo は `pending`（`DESIGN_STALE`、試行は 1 回使う。3 回目なら `failed`） |

job id を条件にした戻し方（Staging、人が承認して実行。`<uuid>` は 6.1 で確かめた値）:

```sql
update public.sales_demos
   set design_status = 'pending', design_job_id = null, design_claimed_at = null, design_updated_at = now()
 where design_job_id = '<uuid>' and design_status = 'processing'
returning id, design_status, design_attempts;
```

- 1 行だけが返ることを確かめる。0 行なら（もう lease で戻った・別の job になった）何もしない
- Production では行わない

原因（login・jail・時間・OOM）を直し、6.1 で ledger の open が 0・spool が空・worker の queue が空になってから、`--dry-run` → 次の cycle。

## 7. Vercel の flag との関係

- bridge が動くには、Staging（Vercel Preview）で `SALES_AI_DESIGN_ENABLED=true` で、bridge から Preview の API に届くことが要る
- **Vercel Authentication は外さない**（2026-10-19 の人の指示）。bridge は bridge 専用の Protection Bypass で届く（DEV-059、既定で無効）。bypass を有効にするのは `design-bridge.env` の 2 行（`SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE` / `_ORIGIN`）で、**この 2 行だけで `sr-design-bridge.service` と手での `run.sh` は header を付ける**。`design-cycle.conf` の `SR_DESIGN_CYCLE_VERCEL_BYPASS=on`（root）は `cycle.sh` だけのスイッチで、on のときだけ cycle が path と origin を bridge に渡す（off なら cycle は渡さないが、cycle 以外の実行は止めない）。**無効にするとは、env の 2 行を消すこと（と、このスイッチの行を消すこと）**（`design-bridge-access.md` §5・§8）
- **cycle は Vercel を変えない。**flag も Deployment Protection も触らない
- flag が無効なら claim は `stopped: BRIDGE_DISABLED`（503）、Vercel の保護で塞がれていれば `BRIDGE_PROTECTION_BLOCKED`（bypass が無い・値が違う・revoke 済み）、token が違えば `BRIDGE_UNAUTHORIZED` → `CYCLE_STOP_CLAIM`（phase=before_claim。何も変わらない）
- bypass の方式は HUMAN-010（timer の有効化）を承認しない。timer は別の人の判断のまま
- timer を enable したまま flag を無効にすると、毎時 `CYCLE_STOP_CLAIM` で unit が failed になる。flag を無効にする間は timer を止める
- Staging の flag を常時 ON にすること自体が人の承認事項（DEV-052 の human approval trigger）。それまでは、人が承認した window の中で手で cycle を動かす
- 即時に止める方法は `design-bridge.md` §9 と同じ（flag を外す）。claim の後で止まった job は §6
