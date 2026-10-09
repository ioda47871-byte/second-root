# Claude が WSL で DEV-028 を自分で回す（Remote Control）

目標: 人が毎回 `git fetch` → コマンド実行 → 結果のコピー → Claude へ貼り付け、をしなくてよい形にする。
同時に、**Instagram の session だけは Claude にも Codex にも取れない**ままにする。

## 方式

新しい遠隔操作の仕組みは作らない。Claude Code の **Remote Control** を使う。

```
Claude アプリ（スマホ / PC）
   │  Remote Control
   ▼
requester jail（systemd の sr-jail-claude.service。design-wsl-isolation.md）
   └─ 利用者 sr-designgen が動かす `claude remote-control`（~/work/second-root）
        │  git fetch / switch・npm test・worker・sales:design-capture・commit / push・CI の確認
        ├─ Codex   → さらに bubblewrap の中だけ（design-worker-wsl.md「Codex の sandbox」）
        └─ capture → /srv/sr-capture の request を置くだけ（design-capture-helper.md）
                           ▼
                    利用者 sr-igcapture の helper だけが Instagram profile を使う（jail の外、root が入れた unit）
```

jail の中からは WSL の interop socket・vsock・Windows の drive・display・Windows host / LAN が見えない・届かない。
WSL2 では、Linux の利用者を分けただけではこれらから Windows を経て root に届くので、jail が境界の前提になる。

### 怪異読本の方式との違い

怪異読本（curiosity-media）は WSL で 2 つを使っている。

- self-hosted GitHub Actions runner（`curiosity-media-wsl`）: PR の CI を WSL で動かす
- pull 型の worker（別の Linux 利用者、systemd timer）: GitHub から仕事を受けない

Second Root では**後者の考え方（利用者を分ける・pull 型）を使い、前者（self-hosted runner）は使わない**。
second-root は public repository なので、fork からの PR が workflow を書き換えて self-hosted runner の上で
任意のコードを動かせてしまう。怪異読本は private なのでこの問題が小さい。

## 重い処理の前に（実機 resource preflight）

jail の中の Claude も、full unit suite・Chromium・worker・Codex を始める前に `scripts/ops/wsl-resource-preflight.sh` を実行し、判定に従う。
- `STOP` なら始めない。`SERIAL` ならテストを `--maxWorkers=1 --no-file-parallelism` にする
- 突然 `Killed` されたら `--oom-check` で確かめ、OOM なら resource failure として止まる
- jail の中では kernel log が読めないことがある（`OOM_UNKNOWN`）。その場合は人に確認を頼む
- `.wslconfig` は変えない（`docs/operations/wsl-resource-preflight.md` §4）

## Claude（sr-designgen）にできること・できないこと

| できる（jail の中で） | できない（OS が止める） |
|---|---|
| repo の操作、test、lint、build、commit / push（feature branch） | jail の外に出る・jail の外で process を動かす（login shell なし、cgroup は root だけが変えられる） |
| 外の公開 address への通信（pasta 経由、DNS は jail 専用） | Windows（interop socket・vsock）、Windows の drive（`/mnt`）、display、Windows host・LAN・VM の localhost に届く |
| | `sr-igcapture` のホーム（Instagram profile・cookie）を読む |
| worker を動かす（Codex は sandbox の中） | `sr-igcapture` の process の `/proc` を読む、その利用者になる（sudo なし） |
| `npm run -s sales:design-capture`（撮影を頼む・PNG を受け取る） | helper のコードを変える（承認済み commit しか動かない） |
| 結果（report.json・before / after）を読む | 生の（privacy 処理前の）スクリーンショットを得る |

Codex は `sr-designgen` のファイル（Meta token・git の鍵・Claude のサインインなど）も読めない（sandbox）。

## 1. 用意（人が 1 回）

0. **Claude は requester jail の中でだけ動かす（必須）。**WSL2 では interop を切っても `/run/WSL/*_interop` が誰でも開け、
   Windows 経由で root になれる。`sr-designgen` として jail の外で動くものがあれば、この表の「できない」が全部崩れる
   （`design-wsl-isolation.md`）。interop off（`/etc/wsl.conf`）は衛生として続ける。`sr-designgen` は Windows が開く既定の利用者にしない
1. bubblewrap（Codex の sandbox）:
   ```bash
   sudo apt install -y bubblewrap
   ```
2. capture helper を入れて、`sr-igcapture` で Instagram にログインする（`design-capture-helper.md` の 1・2）
3. `sr-designgen` に Claude Code を入れてサインインする（サブスクリプション。API キーは使わない）。
   `sudo -iu sr-designgen` は使わない（login shell は nologin。jail の外の shell になるため）。jail の中の shell を開く:
   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh shell
   # ここから jail の中（sr-designgen）
   npm config set prefix ~/.npm-global
   npm install -g @anthropic-ai/claude-code@latest
   claude    # /login → /exit
   exit
   ```
4. `sr-designgen` から GitHub へ push できるようにする（feature branch だけに使う。`admin.sh shell` の中で設定する）
   - 推奨: second-root だけに限った fine-grained token（Contents: read and write）を git の credential helper に預ける
   - `main` / `develop` は GitHub の branch protection で直接 push を禁止しておく
5. Remote Control を jail の中で起動したままにする（systemd の `sr-jail-claude.service`。起動のたびに probe が通ったときだけ動く）:
   ```bash
   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh claude-start
   ```
   Claude アプリの Claude Code にこの session が出る。以降はアプリから頼めば、WSL 上の jail の中で Claude が直接動く。
   止めるときは `admin.sh claude-stop`。

**`sudo` を `sr-designgen` に与えない**（`sudo` / `docker` / `lxd` などの group にも入れない）。sudo があれば jail も Unix の境界も意味を失う。
helper の install / login はこれも確かめて断る。`admin.sh` は root だけの clone（`/root/sr-capture-admin`）からだけ動く
（root が Claude や helper の書き換えたものを動かさないため）。
人が sudo を使う作業（helper の install / approve、bubblewrap）は、Claude に頼まず人が行う。

## 2. 人が行う操作（自動化しない）

- Instagram へのログイン・password・2FA・CAPTCHA / challenge（`LOGIN_REQUIRED` が出たときだけ。
  表示される 1 行 `sudo bash …/admin.sh login` を打つ。jail の Claude はその間 `admin.sh` が止め、終われば戻す。worker の timer は先に止める）
- helper と jail の install、新しい版の承認（root だけの clone をその commit に合わせてから `admin.sh approve <sha>`、差分を確かめてから）
- 基盤の unit（`sr-capture.path` / `.timer`、`sr-jail-net`・`sr-jail-claude`）の install / enable。人が root だけの clone の `admin.sh` を
  明示的に打ったときだけ。営業 Agent・prospecting・outreach・worker の自動実行の timer / Routine にはつながない
- Meta / Facebook / Instagram アカウントの設定、Instagram の DM
- Production / Staging / Supabase / Routine、PR の merge

## 3. 確かめ方

```bash
A=/root/sr-capture-admin/scripts/sales-design-capture/admin.sh
# jail が実機で成り立つこと（JAIL_OK。JAIL_UNSAFE ならその符号を Claude に伝える）
sudo bash $A jail-check
# jail の中から profile・Windows の口が見えないこと（どれも No such file / Permission denied）
sudo bash $A run sr-designgen -- /bin/bash -c 'ls /home/sr-igcapture /run/WSL /mnt/c 2>&1'
# jail の中で Codex の sandbox が組めること（fake ではなく本物の bubblewrap）
sudo bash $A run sr-designgen -- /bin/bash -lc 'cd ~/work/second-root && npx vitest run tests/unit/design-agent/sandbox.test.ts'
```
