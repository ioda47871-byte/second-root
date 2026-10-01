# Instagram capture helper（DEV-028 Phase 3）

ログイン済みの Instagram 専用 browser profile を、**それ専用の Linux 利用者 `sr-igcapture`** に移す。
worker・Codex・Claude（`sr-designgen`）は profile を一切読めない。
頼めるのは「この公開プロフィールを 1 件撮って」だけで、返ってくるのは符号と privacy 処理済みの PNG だけになる。

```
Claude（Remote Control）/ worker / Codex          ← 利用者 sr-designgen
   │  request: { id, 公開プロフィールの URL } だけ
   ▼
/srv/sr-capture/requests/   （sr-designgen は作れるだけ。一覧・読む・消すはできない）
   │  systemd が request を見て起動
   ▼
capture helper                                     ← 利用者 sr-igcapture（ホーム 0700）
   │  人が承認した commit の checkout だけを実行（自分では更新しない）
   │  ~sr-igcapture/.local/share/sr-instagram-browser/  ← ここに触れるのはこの利用者だけ
   ▼
/srv/sr-capture/results/<id>/ （sr-designgen は読むだけ）
   status.json（符号）＋ profile.png / grid-top.png / grid-lower.png（privacy 処理済み）
```

## 境界（OS が守る）

| 何を | どう守るか |
|---|---|
| profile・cookie・session | `sr-igcapture` のホーム 0700。`sr-designgen` は別の利用者で、その group にも入らない |
| `sr-igcapture` の process（Chromium） | 別の uid。`/proc/<pid>/environ`・`cwd`・`fd`・`root`・`mem` は読めない |
| helper のコード | `sr-igcapture` のホームの checkout。人が `admin.sh approve <sha>` で承認した commit だけを `run.sh` が実行する。helper は fetch も更新もしない |
| 頼める内容 | request は id と公開 Instagram プロフィール URL だけ（strict schema）。path・command・option・出力先は書けない |
| request の読み方 | link を辿らない・通常ファイル・link 数 1・4 KiB 以下。それ以外は `REQUEST_INVALID` |
| 返すもの | 固定の符号と、固定名の PNG（最大 3 枚）だけ。PNG は撮った時点で画像を blur → 画素化済み（生の画像は disk に書かない） |
| 濫用 | 1 回の起動で 3 件、撮影の間は 60 秒、1 日 30 件まで。結果は 24 時間で消す |
| ログイン | helper は**ログインしない**。session が切れていれば `LOGIN_REQUIRED` で止まり、人が headed login をする |

`sr-designgen` が自由な shell を持っていても（Claude の Remote Control session など）、これらは Unix の権限で守られる。
`tests/unit/design-agent/cross-user.test.ts` が本物の利用者 2 人で確かめている（CI では root の段で実行）。

## 1. 入れる（人が 1 回、sudo で）

前提:
- WSL で systemd が有効（`/etc/wsl.conf` に `[boot]` `systemd=true`）
- **system 全体の Node 22**（`/usr/local/bin` か `/usr/bin`）。`sr-designgen` の nvm の node は `sr-igcapture` から読めないので使えない
  （例: NodeSource の手順 https://github.com/nodesource/distributions ）

```bash
cd ~/work/second-root && git fetch -q origin feature/dev-028-ai-art-direction
sudo bash scripts/sales-design-capture/admin.sh install "$(git rev-parse origin/feature/dev-028-ai-art-direction)"
```

- 利用者 `sr-igcapture`（パスワードなし、ホーム 0700）と group `sr-capture` を作る
- `sr-designgen` を `sr-capture` に入れる（`sr-igcapture` の group には入れない）
- `/srv/sr-capture/{requests,results}` を正しい権限で作る
- 承認の確認（commit の先頭 12 文字を打つ）の後、`sr-igcapture` のホームに repo を clone し、指定した commit を checkout、
  `npm ci --ignore-scripts`（依存の install script は動かさない）、Chromium を入れる。使う node の場所も記録する
- systemd の `sr-capture.path` / `sr-capture.timer` を有効にする

`sr-designgen` は group の変更を反映するため、一度ログインし直す（WSL なら `wsl --shutdown` 後に開き直すのが確実）。

推奨（人の判断）: WSL の Windows 連携を切る（`/etc/wsl.conf` に `[interop]` `enabled=false`）。Codex の sandbox は `/run` を隠すので
連携の口は見えないが、二重に塞いでおく。

## 2. ログイン（人が、headed で）

```bash
sudo bash /home/sr-igcapture/second-root/scripts/sales-design-capture/admin.sh login
```

- **先に `sr-designgen` の process（Claude の Remote Control・worker）を全部止める。**画面（X の display）は共有なので、
  動いていれば窓の中身や入力を読めてしまう。動いている間は `REQUESTER_RUNNING` で止まる（`sudo pkill -u sr-designgen`）
- ログインが済んだら（`LOGIN_OK`）、helper の「待ち」の印も消える。Claude の session は起動し直す

窓の中で自分でログインする（password・2FA・確認画面も自分で）。この道具は入力もクリックもしない。

**以前の profile（`sr-designgen` のホームのもの）は移さない。**コピーは cookie の持ち出しと同じなので行わない。
新しくログインした後、古いものは消す。

```bash
rm -rf /home/sr-designgen/.local/share/sr-instagram-browser
```

## 3. 頼む（Claude・worker・人、`sr-designgen` で）

```bash
cd ~/work/second-root
npm run -s sales:design-capture -- --request-id shop-001 --source-file ~/sr-design-input/shop-001/source.json
```

| 表示 | 意味 | 終了コード |
|---|---|---|
| `CAPTURED` | 撮れた。PNG は `~/.local/share/second-root-design/helper-captures/<id>/`（24 時間で消える） | 0 |
| `LOGIN_REQUIRED (NO_PROFILE など)` | session が無い・切れた。表示された login コマンドを**人が**打つ。`(WAITING_FOR_PERSON)` は「前に壁に当たったので、人がログインするまで browser を開かない」 | 5 |
| `INSTAGRAM_CHALLENGE` / `INSTAGRAM_CAPTCHA` | 確認を求められた。回避しない。人が様子を見る | 6 |
| `PUBLIC_SOURCE_UNAVAILABLE (理由)` | 非公開・存在しない・外への移動など | 4 |
| `RATE_CAPPED` | 1 日の上限 | 4 |
| `REQUEST_INVALID` | request の形が違う | 4 |
| `CAPTURE_HELPER_TIMEOUT` | 時間内に答えが無い（helper が止まっている、順番待ち） | 4 |
| `CAPTURE_HELPER_UNAVAILABLE` | helper が入っていない（spool が無い） | 3 |

worker は helper が入っていれば自動で使う（公式サイトが無いとき、公開 Instagram より先に）。

## 4. helper を新しい版にする（人が、sudo で）

helper のコードは自動では変わらない。新しい commit を使うときは、差分を**全部**確かめてから承認する。
`lib/` や `scripts/` だけでなく、`package.json`・`package-lock.json`・`tsconfig.json`・`.npmrc` の変更も helper の動きを変えうる。

```bash
sudo bash /home/sr-igcapture/second-root/scripts/sales-design-capture/admin.sh approve <新しい sha>
```

- 承認済みの commit からの変更（`git diff --stat`）を表示し、全文の見方を示す
- commit の先頭 12 文字を打つと承認される（打たなければ何も変わらない）
- `sr-designgen` の repo ではなく `sr-igcapture` 側の checkout から、systemd unit を入れ直す

## 5. 状態と後片付け

```bash
sudo bash /home/sr-igcapture/second-root/scripts/sales-design-capture/admin.sh status
journalctl -u sr-capture.service -n 50     # 符号だけが出る
```

ログインを捨てるとき:
1. Instagram の「ログインアクティビティ」でこの端末をログアウトさせる
2. `sudo rm -rf /home/sr-igcapture/.local/share/sr-instagram-browser`

## 残るリスク（承知の上）

- Instagram の利用規約は自動的な収集を制限している。1 件ずつ・少数・最小の操作にしてあるが、アカウント制限のリスクは無くならない（`design-browser-wsl.md`）
- root を持つ人（sudo）は何でも読める。sudo を Claude に渡さない
- `sr-capture` の group に入った別の利用者は、results の PNG を読める（今は `sr-designgen` だけ）
