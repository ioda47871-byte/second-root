# Claude が WSL で DEV-028 を自分で回す（Remote Control）

目標: 人が毎回 `git fetch` → コマンド実行 → 結果のコピー → Claude へ貼り付け、をしなくてよい形にする。
同時に、**Instagram の session だけは Claude にも Codex にも取れない**ままにする。

## 方式

新しい遠隔操作の仕組みは作らない。Claude Code の **Remote Control** を使う。

```
Claude アプリ（スマホ / PC）
   │  Remote Control
   ▼
WSL の利用者 sr-designgen が動かす `claude remote-control`（~/work/second-root）
   │  git fetch / switch・npm test・worker・sales:design-capture・commit / push・CI の確認
   ├─ Codex   → bubblewrap の中だけ（design-worker-wsl.md「Codex の sandbox」）
   └─ capture → /srv/sr-capture の request を置くだけ（design-capture-helper.md）
                      ▼
               利用者 sr-igcapture の helper だけが Instagram profile を使う
```

### 怪異読本の方式との違い

怪異読本（curiosity-media）は WSL で 2 つを使っている。

- self-hosted GitHub Actions runner（`curiosity-media-wsl`）: PR の CI を WSL で動かす
- pull 型の worker（別の Linux 利用者、systemd timer）: GitHub から仕事を受けない

Second Root では**後者の考え方（利用者を分ける・pull 型）を使い、前者（self-hosted runner）は使わない**。
second-root は public repository なので、fork からの PR が workflow を書き換えて self-hosted runner の上で
任意のコードを動かせてしまう。怪異読本は private なのでこの問題が小さい。

## Claude（sr-designgen）にできること・できないこと

| できる | できない（OS が止める） |
|---|---|
| repo の操作、test、lint、build、commit / push（feature branch） | `sr-igcapture` のホーム（Instagram profile・cookie）を読む |
| worker を動かす（Codex は sandbox の中） | `sr-igcapture` の process の `/proc` を読む、その利用者になる（sudo なし） |
| `npm run -s sales:design-capture`（撮影を頼む・PNG を受け取る） | helper のコードを変える（承認済み commit しか動かない） |
| 結果（report.json・before / after）を読む | 生の（privacy 処理前の）スクリーンショットを得る |

Codex は `sr-designgen` のファイル（Meta token・git の鍵・Claude のサインインなど）も読めない（sandbox）。

## 1. 用意（人が 1 回）

0. **WSL の Windows 連携（interop）を切る（必須）。**有効だと WSL の誰でも `wsl.exe -u root` で root になれ、
   この表の「できない」が全部崩れる。`/etc/wsl.conf` に `[interop]` `enabled=false` / `appendWindowsPath=false` を書き、
   Windows で `wsl --shutdown`（`design-capture-helper.md` §1）。`sr-designgen` は Windows が開く既定の利用者にしない
   （uid 1000 以外の、新しく作った利用者にする）。helper の install / login と毎回の撮影がこれを確かめ、満たさなければ止まる
1. bubblewrap（Codex の sandbox）:
   ```bash
   sudo apt install -y bubblewrap
   ```
2. capture helper を入れて、`sr-igcapture` で Instagram にログインする（`design-capture-helper.md` の 1・2）
3. `sr-designgen` に Claude Code を入れてサインインする（サブスクリプション。API キーは使わない）:
   ```bash
   sudo -iu sr-designgen
   npm install -g @anthropic-ai/claude-code@latest
   claude    # /login → /exit
   ```
4. `sr-designgen` から GitHub へ push できるようにする（feature branch だけに使う）
   - 推奨: second-root だけに限った fine-grained token（Contents: read and write）を git の credential helper に預ける
   - `main` / `develop` は GitHub の branch protection で直接 push を禁止しておく
5. Remote Control を起動したままにする（tmux など）:
   ```bash
   sudo -iu sr-designgen
   tmux new -s claude -d 'cd ~/work/second-root && claude remote-control'
   ```
   Claude アプリの Claude Code にこの session が出る。以降はアプリから頼めば、WSL 上で Claude が直接動く。

**`sudo` を `sr-designgen` に与えない**（`sudo` / `docker` / `lxd` などの group にも入れない）。sudo があれば Unix の境界は意味を失う。
helper の install / login はこれも確かめて断る。`admin.sh` は `sr-designgen` の checkout からは動かない（root が Claude の書いたものを動かさないため）。
人が sudo を使う作業（helper の install / approve、bubblewrap）は、Claude に頼まず人が行う。

## 2. 人が行う操作（自動化しない）

- Instagram へのログイン・password・2FA・CAPTCHA / challenge（`LOGIN_REQUIRED` が出たときだけ。
  Claude の session と worker を止めてから、表示される 1 行 `sudo bash …/admin.sh login` を打つ）
- helper の install と、新しい版の承認（`admin.sh approve <sha>`、差分を確かめてから）
- Meta / Facebook / Instagram アカウントの設定、Instagram の DM
- Production / Staging / Supabase / Routine、PR の merge

## 3. 確かめ方

```bash
# sr-designgen から profile が見えないこと（Permission denied になる）
ls /home/sr-igcapture
# Codex の sandbox が組めること（fake ではなく本物の bubblewrap）
cd ~/work/second-root && npx vitest run tests/unit/design-agent/sandbox.test.ts
```
