# デモ design worker を WSL で動かす（DEV-028 worker）

営業デモの AI アートディレクションを、WSL 上の専用 local worker が人の操作なしで 1 件ずつ処理する。
Claude Cloud から PC へ直接触る方式ではない。怪異読本の入口画像 worker
（curiosity-media `docs/operations/kaii-image-worker-wsl.md`、D-139 / D-141 / D-143）と同じ形である。

- 専用の Linux 利用者 `sr-designgen` で動く（ホームは 700）
- `run.sh` が 1 回ずつ起動する。今は人が手で起動する。systemd timer はまだ enable しない
- job は repo の外の file queue から取る。営業 Agent・DB・Supabase・Production・Staging・Routine には繋がない
- 結果は Linux 側の run directory が正本。Windows へのコピーは best effort
- worker は commit も push も PR 作成もしない。renderer のコードも変えない

手動 CLI（`npm run sales:design-demo`）の説明は `design-agent-wsl.md` にある。
worker は同じ pipeline（brief → render → review → 最大 2 回の profile 修正 → final）を使う。

## 1 件の job で何が起きるか

```
./scripts/sales-design-worker/run.sh --max=1
  run.sh
    - 許可した環境変数だけで自分を起動し直す（API キー・token・DB の鍵は子に渡らない）
    - flock で 1 本だけ動く
    - checkout を origin/$SR_DESIGN_WORKER_REF に揃える（fetch → detach → clean。package-lock.json が変われば npm ci）
    - 残り時間を --budget-seconds で worker に渡す（各段に timeout(1)）
  worker（scripts/sales-design-worker/worker.ts → lib/design-agent/worker/run.ts）
    1. worker.lock を取る（pid・boot id・process の開始時刻・token）
    2. 古い一時ディレクトリを消す（/tmp/sr-design-worker-* と /tmp/sr-design-codex-* だけ）
    3. processing/ に残った job を調べる
       - 持ち主が生きている → 触らない
       - 持ち主が死んでいる / claim が 3 時間を超えた → inbox へ戻す（2 回目は failed へ）
       - 結果が既にある → done へ移すだけ
    4. inbox が空なら終わる
    5. Codex が ChatGPT でサインインしているか確かめる（API キーのサインインは断る）
    6. next build → next start（127.0.0.1 の空き port、SR_DESIGN_PREVIEW_ROOT 付き）
    7. job を 1 つ取る: inbox/<id>.json → processing/<id>.json（atomic rename）
    8. job を検査する（形・facts・Instagram URL）。結果のある job id は二度と作らない
    9. 公開 Instagram プロフィールを未ログインの使い捨て browser で撮る
       → 撮れなければ PUBLIC_SOURCE_UNAVAILABLE（想定された結果として done へ）
    10. スクリーンショットを検査する（枚数・形式・8 MB・symlink でない・所有者・600）
    11. Codex brief → DesignProfile → ProfileRenderer → PC / mobile を撮る → Codex VisualReview
        → 最大 2 回 profile を直す → final。renderer の機能が要れば BLOCKED
    12. 参考スクリーンショットを消す
    13. run directory に記録し、許可したファイルだけを Windows へコピーする
    14. job を done/ へ移す
```

`PUBLIC_SOURCE_UNAVAILABLE` は失敗ではなく、想定された job の結果である。
ネットワークの失敗、5xx、browser の予期しない失敗は店の状態を示さないので、この結果にはしない。
`SOURCE_CAPTURE_FAILED` として次の run でもう 1 回だけ試す。
次のどれかで出る。

- ログイン壁・challenge・CAPTCHA
- rate limit
- 非公開または存在しないアカウント
- 空のページ
- Instagram の外への redirect

回避はしない。ログインの自動化、cookie の再利用、別サービスでの取得はしない。

## Instagram の取得

- 開いてよいのは `https://instagram.com/<profile>/` と `https://www.instagram.com/<profile>/` だけ
  （`lib/design-agent/worker/source-url.ts`）
  - https のみ
  - username 1 段のパスのみ
  - credentials・port・IP・localhost・投稿や login のパスは断る
  - query と fragment は捨てる
- redirect は 1 段ずつ手で追う。どの段も、最後のページも instagram.com でなければ PUBLIC_SOURCE_UNAVAILABLE
  （script による遷移も同じ）
- browser の条件
  - 毎回新しい非永続 context
  - Service Worker を止める
  - 自分の Chrome profile や Windows の cookie は使わない
  - browser の一時 profile は worker の一時ディレクトリの中に作られ、job の後に消える
- ページの操作
  - クリック・入力・ダイアログを閉じる操作はしない
  - スクロールは 1 回だけ。投稿が 10 件以上あるとき、グリッドの 2 画面目のためにする
  - コメント・DM・通知は開かない
- 撮るもの
  - `profile.png`（ヘッダー：公開 bio・店名）
  - `grid-top.png`
  - 必要なときだけ `grid-lower.png`
- ページ内の画像・動画・背景画像は 2 段で処理する。配色・密度・構図は残し、人物や細部は識別しにくくする
  1. 撮る前に CSS で blur する（CSP を越えて必ず当たる）
  2. 撮った PNG の中で、ページ上のすべての media の矩形（shadow DOM の中も含む）を 1/10 に縮めて blur をかけて戻す。ページの DOM や CSS に頼らない
- 公開 bio・店名などヘッダーの文字はそのまま残す
- 参考画像の扱い
  - Codex のデザイン判断にだけ使う
  - Codex CLI は呼び出しごとに session log（`~/.codex/sessions/.../rollout-*.jsonl`）を残し、そこに画像が入りうる。worker は各呼び出しの後に、その thread の log を消す
  - run directory にも Windows にも置かない
  - デモや公開 asset には絶対に使わない

## 1. 利用者と道具

`design-agent-wsl.md` の 1〜3 と同じ手順で揃える。

- 利用者 `sr-designgen`
- Node 22
- `codex login --device-auth`
- `npm ci`
- Playwright の Chromium

`codex login status` が「ChatGPT」を示すこと。
`OPENAI_API_KEY` / `CODEX_API_KEY` は設定しない。設定されていても、run.sh と worker は子 process に渡さない。

worker 専用の clone を使う（run.sh は checkout を `--force` で origin に揃え、追跡外のファイルを消す）。

```bash
sudo -iu sr-designgen
git clone https://github.com/ioda47871-byte/second-root.git ~/work/second-root
```

`.env` / `.env.local` を clone に置かない。置くと worker は `WORKER_ENV_FILE_PRESENT` で止まる。

## 2. job を入れる

job は repo の外に置く。実在の店舗名・Instagram URL・facts を repo・commit・PR に書かない。
job id に店舗名を使わない（例: `shop-001`）。

```bash
cd ~/work/second-root
npm run -s sales:design-worker -- enqueue --job-id shop-001 \
  --facts ~/sr-design-input/shop-001/facts.json \
  --instagram https://www.instagram.com/<profile>/
```

- `~/sr-design-jobs/inbox/shop-001.json` ができる（0600、ディレクトリは 0700）
- facts は `sales_demos.content` の形で、fact-only filter を通ること
- URL は上の許可形だけ
- 同じ id が inbox・processing・done にあれば断る

## 3. 1 回動かす（正規の入口）

```bash
cd ~/work/second-root
SR_DESIGN_WORKER_REF=<branch> \
SR_DESIGN_EXPORT_DIR=/mnt/c/Users/<windows-user>/Desktop/second-root-codex-result \
  ./scripts/sales-design-worker/run.sh --max=1
```

| 変数 | 既定 | 意味 |
|---|---|---|
| `SR_DESIGN_WORKER_REF` | `develop` | run.sh が checkout を揃える origin の branch |
| `SR_DESIGN_EXPORT_DIR` | なし | Windows から見るコピー先。無い・書けないときは `windows_copy: unavailable / failed` になるだけ |
| `SR_DESIGN_JOBS` | `~/sr-design-jobs` | job queue |
| `SR_DESIGN_WORKER_NO_UPDATE` | なし | `1` で fetch / checkout / npm ci をしない（開発用。作業木はきれいであること） |
| `SR_DESIGN_WORKER_BUDGET_SECONDS` | `3300` | run.sh 全体の時間（3300 秒が上限） |

終了コード:

- 0: job が想定どおりの結果になった（done / fallback_template / blocked / PUBLIC_SOURCE_UNAVAILABLE を含む）。または job が無かった、別の run が動いていた
- 1: job が失敗した、または次の run でやり直す
- 3: 環境の都合で止まった（サインイン・利用枠・build・時間切れ・signal）。job は inbox に戻り、失敗に数えない

## 4. 結果

| 場所 | 中身 |
|---|---|
| `~/.local/share/second-root-design/<job_id>/`（正本、0700） | `report.json`、`facts.json`、`candidate-*.json`、`final.json`、`review-candidate-*.json`、`before-*.png` / `after-*.png`、`shots/` |
| `~/sr-design-jobs/done/<job_id>.result.json` | outcome、run directory、worker commit、windows_copy |
| `$SR_DESIGN_EXPORT_DIR/<job_id>/` | before / after（PC・mobile）、`report.json`、`final.json`、`review-candidate-*.json` だけ |
| `~/.local/state/sr-design-worker/` | `worker.lock`、`ledger.json`（job ごとのやり直し回数）、`run.lock` |

`report.json` の中身:

- `worker.commit`（worker の commit SHA）
- `outcome`
- `instagram`
  - `status`
  - `images`
  - 撮れなかったときの `reason`
  - `temp_deleted`
- `codex`
  - `direction`
  - `confidence`
  - `reviews`
  - `revisions`
  - `rounds` の点数
  - `fallback`
  - `blocked`
  - `renderer_change_needed`
  - `notes`（符号のみ）
- `windows_copy`

report・ログ・ledger・job の記録に載るのは符号と定型文だけである
（`lib/design-agent/worker/messages.ts`）。次のものは載せない。

- Codex の文章・stderr
- 例外の文面
- Instagram URL

Codex が選んだ profile の値は、成果物として `final.json` などに残る。

## 5. やり直しと片付け

- 同じ job id から結果は 1 つだけ
  - `report.json` のある run directory は作り直さない
  - done にある id を再投入すると `DUPLICATE_JOB_ID` で failed へ
- 途中で止まった job
  - SIGKILL・WSL の停止・PC の再起動で processing/ に残る
  - 次の run で持ち主（pid・boot id・開始時刻）が居ないと分かれば inbox へ戻る
  - 2 回目で failed へ
  - 結果の無い run directory は消してから作り直す
- job の失敗
  - render の失敗などは 1 回だけ次の run でやり直す
  - 2 回目で failed へ（`WORKER_JOB_FAILED`）
- 一時ディレクトリの片付け
  - 毎回の起動時に消す
  - 対象は次の条件をすべて満たすものだけ。`/tmp` の他のものには触らない
    - `/tmp` 直下で、名前が `sr-design-worker-XXXXXX` / `sr-design-codex-XXXXXX`
    - 本物のディレクトリ（symlink でない）
    - 所有者が自分
    - 持ち主の worker が死んでいる（すぐ消す）。印が無いものは 6 時間より古いこと

## 6. 後で: systemd timer（まだ enable しない）

営業 Agent と繋ぐ段階で使う。今は置くだけにする。

`~/.config/systemd/user/sr-design-worker.service`:

```ini
[Unit]
Description=Second Root design worker (one run)

[Service]
Type=oneshot
WorkingDirectory=%h/work/second-root
Environment=SR_DESIGN_WORKER_REF=develop
Environment=SR_DESIGN_EXPORT_DIR=/mnt/c/Users/<windows-user>/Desktop/second-root-codex-result
ExecStart=%h/work/second-root/scripts/sales-design-worker/run.sh --max=1
TimeoutStartSec=3600
```

`~/.config/systemd/user/sr-design-worker.timer`:

```ini
[Unit]
Description=Second Root design worker, hourly

[Timer]
OnCalendar=*-*-* *:23:00
Persistent=true

[Install]
WantedBy=timers.target
```

有効にするとき（まだしない）:

```bash
sudo loginctl enable-linger sr-designgen
systemctl --user daemon-reload
systemctl --user enable --now sr-design-worker.timer
```

run.sh の時間は 3300 秒が上限で、`TimeoutStartSec=3600` より先に終わる
（`tests/unit/design-agent/worker-run-sh.test.ts` が run.sh とこの節を突き合わせる）。

## 7. 止め方

- 手動の run: Ctrl-C
  - worker は子 process の group をすべて止める
  - 一時ディレクトリを消す
  - 作業中の job はその場で inbox に戻る。やり直しの回数には数えない
- timer（enable した後）: `systemctl --user disable --now sr-design-worker.timer`
- 結果・job・状態を捨てる:
  `rm -rf ~/.local/share/second-root-design/<job_id> ~/sr-design-jobs/*/<job_id>.* ~/.local/state/sr-design-worker/ledger.json`
