# 画像の無人実行 — WSL 実機への導入準備（DEV-188、OFF のまま）

**この文書のコマンドは、Claude も誰も実行していない。** §2 はオーナーが WSL で読むだけの確認、§3 はオーナーが別途 OK したあとに 1 回だけ貼るもの。
画像の無人実行（real Codex）は **OFF のまま**。この準備は ON・timer の enable・jail の Claude の停止を承認しない。

突き合わせた正本: `docs/operations/design-worker-cycle.md`（§4 install・§5 戻す）、`docs/operations/image-autorun-approval-sheet.md`、
`scripts/sales-design-worker/cycle.sh`、`scripts/sales-design-worker/systemd/sr-design-cycle.{service,timer}`、
`docs/operations/design-bridge.md` §4・`design-capture-helper.md`（root だけの clone の更新の形）、`scripts/sales-design-capture/admin.sh`（jail・`claude-stop`）、
`.ai/progress.md`・`.ai/blockers.md`（実機の記録）。

## 0. 実機について分かっていること / 不明なこと

| 項目 | 記録 | 今の値 |
|---|---|---|
| root だけの clone `/root/sr-capture-admin` の commit | 2026-10-23 に人が A-3 を X2 `679c3c214c03d0b88515e2396bd6831705e5e2d1` で適用（`.ai/blockers.md`） | **不明**（§2 の出力が要る） |
| `/etc/second-root/design-cycle.conf` | 2026-10-20 に人が作成、`CYCLE_DRY_RUN_OK`（HUMAN-014） | **不明** |
| `sr-design-cycle.service` / `.timer` が `/etc/systemd/system` にあるか | 記録なし（HUMAN-010 は保留のまま。timer は enable しない決定） | **不明** |
| `sr-design-bridge.*` / `sr-design-worker.*`（旧 unit） | 2026-10-17 の読み取りで「無し・inactive」 | **不明** |
| `sr-jail-claude.service`（Remote Control） | jail は install 済み。enable / active は日による | **不明** |
| `/etc/sr-design-worker/image-autorun.json` | 作った記録なし（承認シートは OFF・未承認） | **不明**（無いか `enabled:false` であること） |

**「導入済み」とは書かない。** §2 の出力を見るまで、上の「不明」は不明のまま扱う。

## 1. #228 より前と #229 の違い（実機に効くもの）

### 1.1 root が動かすファイルの差

`git diff --stat` で確かめた事実（repo の中の比較。実機ではない）:

| 比べたもの | root が動かすファイル（`admin.sh`・`jail/*`・`cycle.sh`・unit・`scripts/ops/*`・`scripts/sales-design-bridge/*`）の差 |
|---|---|
| X2 `679c3c2` → `bb7da4f`（#229） | **`cycle.sh` と `sr-design-cycle.service` の 2 つだけ**。`admin.sh`・jail・preflight・bridge の script は同じバイト列 |
| `c066618` → `bb7da4f` | 上の 2 つに加えて `admin.sh`・`jail/jail.properties`・`jail/probe.py`（A-3 の DNS 規則）も変わる |

clone 全体では約 1040 file が変わる（アプリ・研究の file。root は動かさない）。clone が `679c3c2` でも `c066618` でもなければ、§3 の前に止まってオーナーが判断する。

### 1.2 unit（`sr-design-cycle.service`）に増えた 3 つの設定（`CacheDirectory`・`CacheDirectoryMode`・`ExecStopPost`）

- `CacheDirectory=sr-design-image-grant` と `CacheDirectoryMode=0755`: systemd が unit の起動時に `/var/cache/sr-design-image-grant`（root、0755）を作る。grant（`grant.json`、root 0644）の置き場所。jail からは `/var/cache` が読み取り専用で見え、`/run` は見えないのでここにした。
- `ExecStopPost=-/bin/sh -c 'rm -f /var/cache/sr-design-image-grant/grant.json /var/cache/sr-design-image-grant/.grant.*'`: cycle が SIGKILL・OOM で落ちても grant を残さない。
- ほかの行（`ExecStart`・`TimeoutStartSec=4800`・`SuccessExitStatus=10 11`・`StateDirectory=sr-design-cycle`・hardening）と `.timer` は変わっていない。
- systemd が `CacheDirectory=` を知らないと unit は読まれても設定が無視される。§2 で `systemctl --version` を見る（`CacheDirectory=` は systemd 235 以降。WSL の Ubuntu の systemd は通常これより新しいが、**実機の版は不明**）。

### 1.3 `cycle.sh` に増えたもの（#229）

- idle の worker 実行（段 3）の直前に `image_grant`。スイッチ（`/etc/sr-design-worker/image-autorun.json`）が無ければ **何もしない**（ファイルが無い = 1 行目で return）。
- grant を出した回だけ `CYCLE_IMAGE_RUN`（exit 0）で終わる。出さない回の流れ・STOP 条件・時間予算・`CYCLE_RESULT` は今までどおり。
- `--dry-run` は段 3 より前で終わるので、grant を出さない（開始時に古い grant を消すだけ）。
- cycle の開始時と終了時（lock を持つ cycle だけ）に grant を消す。使用の印 `/var/lib/sr-design-cycle/image-{approval,job}-used/` は消さない。

### 1.4 root の clone は #229 を含む commit に、worker は develop に

- unit の `ExecStart` は `/root/sr-capture-admin/scripts/sales-design-worker/cycle.sh`。**unit だけ新しくしても、clone が古ければ cycle.sh は #229 の前のまま**（grant を出さない。CacheDirectory は空のまま作られるだけ）。逆に clone だけ新しく unit が古いと、`ExecStopPost` の守りが無い。**2 つをそろえる。**
- worker の checkout（`~sr-designgen/work/second-root`）は `run.sh` が毎回 `origin/develop` に合わせる（`SR_DESIGN_WORKER_REF=develop`）。root の clone を動かさなくても、worker の hook（`image-autorun.ts`）は develop の版になる。
  - 今の状態（root が #228 前、worker が develop）でも安全側: hook はスイッチが無ければ `HELD_AUTORUN_DISABLED`、grant が無ければ `REFUSED_NO_GRANT` で Codex を呼ばない。
  - grant の形（`version:1`・承認 ID・job_id・SHA256・boot_id・期限）を変えると root と worker が食い違う。変える PR は、この文書の pin を更新するまで root と合わない（DEV-188 は形を変えていない）。

### 1.5 前提

- `design-worker-cycle.md` §4 の前提（bridge・spool・jail・capture helper）と `/etc/second-root/design-cycle.conf` が済んでいること（2026-10-20 の記録。今は不明）。
- root だけの clone は手で編集しない。fetch → 承認した commit に detach → clean の確認（`design-bridge.md` §4 と同じ形）。
- WSL の resource preflight（`docs/operations/wsl-resource-preflight.md`）は cycle 自身が段 1 で行う。§3 は重い処理を動かさない。

### 1.6 旧 unit との timer の競合

- `cycle.sh` は `sr-design-bridge.{timer,service}`・`sr-design-worker.{timer,service}` のどれかが active なら `CHECK_UNIT_ACTIVE`、2 つの timer が enabled なら `CHECK_UNIT_ENABLED` で何もしない（unit に `Conflicts=` は無い。動いているものを途中で止めないため）。
- `sr-design-cycle.timer` は毎時 17 分 + 最大 10 分。**enable は HUMAN-010 の承認事項で、今は保留。** §3 は timer の enable 状態を変えない。
- `sr-capture.timer` / `.path`（capture helper）は cycle と競合しない（別の checkout、今までどおり）。`sr-claude-auth-watch.timer` は repo に定義が無い（`passt-update-plan.md`）。§2 で状態だけ見る。

### 1.7 jail と Remote Control との共存

- `admin.sh claude-start` は `sr-jail-claude.service` を `enable --now`、`claude-stop` は `disable --now` と `sr-jail-net` 以外の `sr-jail-*` の停止（`stop_jail_units`）。`sr-jail-net.service` は `Restart=always` で、`ExecStartPost` が「Claude が enabled なら起動する」。
- **画像の grant は、`sr-jail-claude.service` が `inactive`/`failed` かつ `disabled`/`masked`、かつ `sr-designgen` のプロセスが 0 のときだけ出る**（`IMAGE_GRANT_USER_BUSY`、何も消費しない）。つまり画像ジョブの回は Remote Control を同時に使えない。
- 画像ジョブの無い普通の cycle は、jail の Claude が動いていても今までどおり（`CHECK_WORKER_RUNNING` は worker・bridge の script のプロセスだけを見る）。
- unit の入れ替え（§3）は jail の unit・`sr-jail-net`・Claude に触れない。**`claude-stop` は §3 に含まない。**

## 2. 読むだけの確認シート（オーナーが WSL で実行）

決まり:
- すべて読むだけ。systemd・ファイル・git の状態を変えない（`git fetch` もしない）。
- 秘密を出さない: env・token・bypass のファイルは **`stat` だけ**で、中身を表示しない。`design-cycle.conf` はキーの名前だけ。`image-autorun.json` は `enabled` と件数だけ。
- **想定外の root のファイル（下の「期待」と違う所有者・mode、知らないファイル・drop-in）があったら、そこで止まって Claude にそのまま見せ、オーナーが判断する。** §3 に進まない。

```bash
# A. systemd の版と unit の状態（cycle・jail・旧 unit）
systemctl --version | head -1
for u in sr-design-cycle.service sr-design-cycle.timer sr-jail-claude.service sr-jail-net.service \
         sr-design-bridge.service sr-design-bridge.timer sr-design-worker.service sr-design-worker.timer \
         sr-capture.timer sr-capture.path sr-claude-auth-watch.timer; do
  printf '%-30s enabled=%-10s active=%s\n' "$u" "$(systemctl is-enabled "$u" 2>&1)" "$(systemctl is-active "$u" 2>&1)"
done
systemctl list-timers --all 'sr-*' --no-pager
systemctl list-units --all 'sr-jail-run-*' --no-pager

# B. いま入っている cycle の unit（無ければ "No files found"）
#    drop-in があると systemctl cat はその中身（Environment= など）も出す。先に drop-in の有無だけを見て、空のときだけ cat する
DROPINS="$(systemctl show sr-design-cycle.service sr-design-cycle.timer -p DropInPaths --value 2>&1 | tr -d '[:space:]')"
echo "DropInPaths: ${DROPINS:-none}"
if [ -z "$DROPINS" ]; then systemctl cat sr-design-cycle.service sr-design-cycle.timer --no-pager 2>&1; else echo "DROPIN_PRESENT: cat しない。ここで止まってオーナーが判断する"; fi
systemctl show sr-design-cycle.service -p FragmentPath -p UnitFileState -p ActiveState -p CacheDirectory -p StateDirectory -p ExecStopPost --no-pager
systemctl status sr-design-cycle.service sr-design-cycle.timer --no-pager -n 5 2>&1 | head -40
ls -l /etc/systemd/system/sr-design-cycle.* 2>&1
ls -ld /etc/systemd/system/sr-design-cycle.service.d /etc/systemd/system/sr-design-cycle.timer.d 2>&1

# C. root だけの clone の commit と状態
#    --no-optional-locks: git status が index を書き直さない（読むだけ）
sudo git --no-optional-locks -C /root/sr-capture-admin rev-parse HEAD
sudo git --no-optional-locks -C /root/sr-capture-admin status --porcelain --untracked-files=normal | head -20; echo "status lines: $(sudo git --no-optional-locks -C /root/sr-capture-admin status --porcelain --untracked-files=normal | wc -l)"
sudo git --no-optional-locks -C /root/sr-capture-admin cat-file -e bb7da4fa42817ae1c8f0a2ef86587368e84f418e^{commit} 2>/dev/null && echo "has #229 object" || echo "no #229 object (fetch needed in §3)"
sudo grep -c 'image_grant' /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh
sudo stat -c '%U:%G %a %n' /root /root/sr-capture-admin /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh /root/sr-capture-admin/scripts/sales-design-capture/admin.sh

# D. root のファイルの所有者と mode（中身は出さない）
sudo stat -c '%U:%G %a %F %n' /etc/sr-design-worker /etc/sr-design-worker/image-autorun.json \
  /etc/second-root /etc/second-root/design-cycle.conf \
  /var/lib/sr-design-cycle /var/cache/sr-design-image-grant 2>&1
sudo ls -la /var/lib/sr-design-cycle /var/cache/sr-design-image-grant 2>&1
sudo cut -s -d= -f1 /etc/second-root/design-cycle.conf 2>&1   # -s: = の無い行は出さない（キーの名前だけ）
sudo python3 -I -c 'import json,sys
try: c=json.load(open(sys.argv[1]))
except FileNotFoundError: print("image-autorun.json: absent"); sys.exit()
print("image-autorun.json: enabled=%r approvals=%d" % (c.get("enabled"), len(c.get("approvals") or [])))' /etc/sr-design-worker/image-autorun.json

# E. worker の queue（ファイル名だけ）
sudo ls -la /home/sr-designgen/sr-design-jobs/inbox /home/sr-designgen/sr-design-jobs/processing 2>&1
sudo ls -la /home/sr-designgen/sr-design-jobs/image-autorun 2>&1
sudo ls -la /home/sr-designgen/sr-design-jobs/image-autorun/inbox 2>&1
# cycle.sh と同じ 2 つ（実 uid と実効 uid）。コマンド行は出さず、終了コードだけ（0 = あり、1 = 無し、2 以上 = 判定できない）
pg_real=0; pgrep -U sr-designgen >/dev/null 2>&1 || pg_real=$?
pg_eff=0; pgrep -u sr-designgen >/dev/null 2>&1 || pg_eff=$?
echo "pgrep -U exit=$pg_real  pgrep -u exit=$pg_eff"
```

期待（違えば止まる）:

| 段 | 期待 |
|---|---|
| A | `sr-design-cycle.timer` は `disabled` か `not-found`、`inactive`。`sr-design-bridge.*`・`sr-design-worker.*` は `not-found` か `disabled`/`inactive`（enabled・active なら止まる）。`sr-jail-run-*` は 0 件。systemd は 235 以上 |
| B | `DropInPaths: none`（`DROPIN_PRESENT` なら止まる）。unit が無い（`No files found`）か、`FragmentPath=/etc/systemd/system/sr-design-cycle.service` で drop-in 無し。`CacheDirectory=` が空なら #229 前の unit。`ActiveState=inactive`（`activating` なら cycle が動いている。終わるまで待つ） |
| C | HEAD が 40 文字（記録では `679c3c2…`。違えばそのまま見せる）。status の行が 0。`image_grant` の数は #229 前なら 0。`/root` 以下が root の所有で他から書けない |
| D | `/etc/sr-design-worker` と `image-autorun.json` は **無い**のが期待（あれば `root:root`・`644` 以下・`enabled=False`）。`/etc/second-root` は `root:root 755`、`design-cycle.conf` は `root:root 644`、キーは `SR_DESIGN_CYCLE_BRIDGE_SHA`（と任意で `SR_DESIGN_CYCLE_VERCEL_BYPASS`）だけ。`/var/lib/sr-design-cycle` は無いか `root:root 700`（中身は `cycle.lock`、`run.*`、#229 後なら `image-*-used`）。`/var/cache/sr-design-image-grant` は無いか `root:root 755` で `grant.json` が無い |
| E | `inbox`・`processing` は空。`image-autorun` は無い（DEV-186 以降もジョブを置いていなければ無い）。`pgrep -U exit=1  pgrep -u exit=1`（jail の Claude が動いていれば 0。それ自体は異常ではないが、画像の grant は出ない。2 以上なら止まる） |

**Claude に返すもの:** 上の出力をそのまま。ただし、知らない人名・メールアドレス・URL・ホスト名が出たら伏せてよい。env・token・bypass の中身はこのシートでは出ない（出ていたら貼らずに止まる）。

## 3. 1 回だけの導入コマンド（オーナー実行。別途の OK まで誰も実行しない）

前提: §2 がすべて「期待」どおり。`sr-design-cycle.service` が `inactive`。jail の Claude の状態はそのまま（止めない）。
`PIN` は develop の上の、#229（`bb7da4fa42817ae1c8f0a2ef86587368e84f418e`）を含む commit。既定は `bb7da4f` そのもの。別の commit にするなら、3-2 の差の確認を同じようにやり直す。

```bash
( # 1 つの subshell で実行する（どこかで失敗したら、そこで止まり以降を実行しない。端末は閉じない）
set -euo pipefail
PIN=bb7da4fa42817ae1c8f0a2ef86587368e84f418e        # オーナーが承認した develop の commit（40 文字）
BK=/root/sr-dev188-backup-$(date -u +%Y%m%dT%H%M%SZ)

# 3-1. 退避（unit・clone の commit・enable の状態）
sudo install -d -o root -g root -m 0700 "$BK"
for f in /etc/systemd/system/sr-design-cycle.service /etc/systemd/system/sr-design-cycle.timer; do
  if sudo test -e "$f"; then sudo cp -a "$f" "$BK/"; fi
done
sudo git -C /root/sr-capture-admin rev-parse HEAD | sudo tee "$BK/clone-head" >/dev/null
for u in sr-design-cycle.service sr-design-cycle.timer; do
  printf '%s %s %s\n' "$u" "$(systemctl is-enabled "$u" 2>&1 || true)" "$(systemctl is-active "$u" 2>&1 || true)"
done | sudo tee "$BK/unit-state" >/dev/null
sudo sh -c "cd '$BK' && sha256sum * > SHA256SUMS"; sudo cat "$BK/clone-head" "$BK/unit-state"

# 3-2. root だけの clone を PIN へ（確かめてから）
OLD=$(sudo cat "$BK/clone-head")
sudo git -C /root/sr-capture-admin fetch -q origin
# どれも門: 通らなければ checkout・install の前に subshell ごと終わる（`cmd && echo X` の形は set -e では止まらないので使わない）
sudo git -C /root/sr-capture-admin merge-base --is-ancestor bb7da4fa42817ae1c8f0a2ef86587368e84f418e "$PIN" || { echo PIN_NOT_ON_229; exit 1; }
echo PIN_HAS_229
sudo git -C /root/sr-capture-admin merge-base --is-ancestor "$PIN" origin/develop || { echo PIN_NOT_ON_DEVELOP; exit 1; }
echo PIN_ON_DEVELOP
# root が動かすファイルの差。X2 からなら cycle.sh と sr-design-cycle.service の 2 行だけのはず。ほかが出たら止まる
sudo git -C /root/sr-capture-admin diff --stat "$OLD" "$PIN" -- scripts/sales-design-capture scripts/sales-design-worker/cycle.sh \
  scripts/sales-design-worker/systemd scripts/ops scripts/sales-design-bridge
read -r -p "差が cycle.sh と sr-design-cycle.service だけなら yes: " a; [ "$a" = yes ] || { echo NOT_CONFIRMED; exit 1; }
sudo git -C /root/sr-capture-admin checkout -q --detach "$PIN"
[ "$(sudo git -C /root/sr-capture-admin rev-parse HEAD)" = "$PIN" ] || { echo CLONE_NOT_AT_PIN; exit 1; }
test -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" || { echo CLONE_DIRTY; exit 1; }
echo CLONE_OK

# 3-3. unit を置いて daemon-reload（enable・start・stop はしない）
S=/root/sr-capture-admin/scripts/sales-design-worker/systemd
sudo install -o root -g root -m 0644 "$S/sr-design-cycle.service" /etc/systemd/system/sr-design-cycle.service
# timer は前から置いてあった時だけ同じ内容で置き直す（#229 で変わっていない）。enable の状態は変えない
if sudo test -e "$BK/sr-design-cycle.timer"; then sudo install -o root -g root -m 0644 "$S/sr-design-cycle.timer" /etc/systemd/system/sr-design-cycle.timer; fi
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/sr-design-cycle.service || { echo UNIT_VERIFY_FAILED; exit 1; }
echo UNIT_VERIFY_OK

# 3-4. スイッチは作らない（無いまま。あるなら enabled:false のまま触らない）
sudo test ! -e /etc/sr-design-worker/image-autorun.json && echo SWITCH_ABSENT || echo "SWITCH_PRESENT (enabled:false であることを §4 で確かめる)"
echo "BK=$BK   # §4 と戻し方で使う。控えておく"
)
```

- 3-2 の門（`PIN_NOT_ON_229`・`PIN_NOT_ON_DEVELOP`・`NOT_CONFIRMED`）で終わったら何も変わらない（clone は fetch しただけ、unit は触らない）。
- `CLONE_NOT_AT_PIN`・`CLONE_DIRTY` で終わったら unit は install されていない。clone だけを §4 の戻し方で元の commit に戻す。
- `UNIT_VERIFY_FAILED` で終わったら（unit は置かれ daemon-reload 済み、enable・start はしていない）§4 の戻し方。
- timer が enabled だった場合（§2 の期待外。止まってオーナーが判断済みのときだけここに来る）も、`enable`/`disable` はしない。
- 動いている cycle は無いこと（§2 B）。`daemon-reload` は動いている cycle を止めないが、念のため inactive の時だけ行う。

## 4. 導入後の確認（OFF のまま であること）と戻し方

```bash
BK=/root/sr-dev188-backup-YYYYMMDDTHHMMSSZ   # 3-1 の最後に表示された名前
systemctl show sr-design-cycle.service -p FragmentPath -p CacheDirectory -p CacheDirectoryMode -p ExecStopPost -p ActiveState -p UnitFileState --no-pager
sudo cmp /etc/systemd/system/sr-design-cycle.service /root/sr-capture-admin/scripts/sales-design-worker/systemd/sr-design-cycle.service && echo UNIT_SAME
sudo git -C /root/sr-capture-admin rev-parse HEAD
for u in sr-design-cycle.service sr-design-cycle.timer sr-jail-claude.service; do printf '%s %s %s\n' "$u" "$(systemctl is-enabled "$u" 2>&1)" "$(systemctl is-active "$u" 2>&1)"; done
diff <(sudo cat "$BK/unit-state") <(for u in sr-design-cycle.service sr-design-cycle.timer; do printf '%s %s %s\n' "$u" "$(systemctl is-enabled "$u" 2>&1 || true)" "$(systemctl is-active "$u" 2>&1 || true)"; done) && echo ENABLE_STATE_UNCHANGED
sudo python3 -I -c 'import json,sys
try: c=json.load(open(sys.argv[1]))
except FileNotFoundError: print("SWITCH_ABSENT (OFF)"); sys.exit()
print("SWITCH enabled=%r (OFF only when False)" % c.get("enabled"))' /etc/sr-design-worker/image-autorun.json
sudo ls -la /var/cache/sr-design-image-grant 2>&1   # 無いか、grant.json が無いこと
systemctl list-timers --all 'sr-design-*' --no-pager
```

期待: `CacheDirectory=sr-design-image-grant`、`ExecStopPost` に `rm -f /var/cache/sr-design-image-grant/grant.json …`、`UNIT_SAME`、HEAD = `PIN`、`ENABLE_STATE_UNCHANGED`、`SWITCH_ABSENT (OFF)`（または `enabled=False`）、grant 無し、`sr-design-cycle.timer` が今までどおり（disabled か not-found）。
スイッチが無い限り、cycle を動かしても `image_grant` は 1 行目で戻り、grant は出ない（real Codex 0 回）。

任意（オーナーが別に OK したときだけ）: `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run` → 最後の行が `CYCLE_RESULT CYCLE_DRY_RUN_OK`。dry-run は段 3 の前で終わり、worker も bridge も grant も動かさない。

### 戻し方（unit を退避したものに、clone を元の commit に）

```bash
BK=/root/sr-dev188-backup-YYYYMMDDTHHMMSSZ   # 3-1 の最後に表示された名前
OLD=$(sudo cat "$BK/clone-head")
sudo git -C /root/sr-capture-admin checkout -q --detach "$OLD" \
  && test -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" && echo CLONE_RESTORED
for n in sr-design-cycle.service sr-design-cycle.timer; do
  if sudo test -e "$BK/$n"; then sudo install -o root -g root -m 0644 "$BK/$n" "/etc/systemd/system/$n"
  else sudo rm -f "/etc/systemd/system/$n"; fi        # 3-1 の前に無かったものは消す
done
sudo systemctl daemon-reload
sudo sh -c "cd '$BK' && sha256sum -c SHA256SUMS --ignore-missing"
for n in sr-design-cycle.service sr-design-cycle.timer; do sudo test -e "$BK/$n" && sudo cmp "$BK/$n" "/etc/systemd/system/$n" && echo "SAME $n"; done
```

- 戻しても enable の状態は変えない（3-3 も変えていない）。
- `/var/cache/sr-design-image-grant`（空）と `/var/lib/sr-design-cycle/image-*-used/` は残してよい（#229 前の cycle は使わない。使用の印は消さない）。

## 5. まだ禁止の操作（この文書では承認しない）

- スイッチを ON にする（`/etc/sr-design-worker/image-autorun.json` を作る・`enabled:true` にする・エントリを足す）
- `admin.sh claude-stop`（jail の Claude を止めて disable する）と `claude-start` の切り替え
- real Codex の実行（画像ジョブを `image-autorun/inbox/` に置くこと、`run-tsugute-photos-once.sh` を含む）
- `sr-design-cycle.timer` の enable（HUMAN-010 の承認が無いまま）、旧 bridge / worker の timer の enable
- `sr-design-cycle.service` の start（§3 には含めない。手での `cycle.sh` の実行も、承認した window の外ではしない）
- jail の再 install（`admin.sh jail-install`/`approve`）、passt・`.wslconfig`・ネットワーク・サインインの変更
- Production・Staging・DB・Vercel の変更、課金

## 6. 別の店舗への広がり（DEV-188 Phase B の状態）

- worker の hook は店ごとの固定の manifest（`scripts/sales-design-worker/autorun-shops.ts`）で動く。root の `cycle.sh` は同じ allowlist（`IMAGE_AUTORUN_SHOPS`、テストで manifest と一致を固定）で job の店を確かめ、無い店は `IMAGE_GRANT_SCOPE_MISMATCH` で grant を出さない。
- **実装済みは `tsugute`（つぐ手）だけ。** 輪（自転車修理）・ゆげ湯（銭湯）は **未対応**: 写真の差し替え（`photo-swap.ts`）が `tsugute` 専用（`SWAP_SHOPS`・`AI_DEMO_SHOPS`・つぐ手の CSS の breakpoint）、輪の slot の計測は古い版 `d1-v2` のものだけで `photo-slot-edges` が無く、オーナーが承認した写真の brief・プロンプトも無い。
- root の clone を §3 の `bb7da4f` に合わせた場合、root の allowlist は #229 の版（`tsugute` だけ）のまま。後の develop の commit に合わせ直すときは §3-2 の差の確認をやり直す。
