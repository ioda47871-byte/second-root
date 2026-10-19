# 専用ブラウザで Instagram を撮る（DEV-028 PoC）

design worker の参考画像を、**ログイン済みの専用 Chromium profile** で撮る方式の PoC。
worker にはまだ組み込まない。Meta Business Discovery は保留中。

- Claude Cloud は Instagram にログインしない
- ログインは、人が WSL の画面で 1 回だけ手で行う
  - password・2FA・確認画面は人が入力する
  - この道具は入力・クリック・自動ログインをしない
- 以降の撮影は、同じ profile を使ってローカルで行う
- 普段使いの Windows Chrome profile は使わない

> **2026-10-01 から profile は専用の利用者 `sr-igcapture` が持つ。**worker・Codex・Claude（`sr-designgen`）からは読めない。
> 撮影は capture helper に頼む（`design-capture-helper.md`）。この文書のコマンドは `sr-igcapture` として打つ
> （例: `sudo -u sr-igcapture -H env DISPLAY=:0 bash -lc 'cd ~/second-root && npm run -s sales:design-browser -- login'`）。

## 使う前に知っておくこと（人間の判断）

- **Instagram の利用規約**: 自動的な手段での情報収集を制限している
  - ログイン済みのアカウントで自動撮影すると、そのアカウントに制限・停止がかかる可能性がある
  - 撮影は 1 件ずつ・最小限（ページを開く、待つ、最大 1 回のスクロール、撮影）にしてある
  - それでもこのリスクは無くならない
- **どのアカウントでログインするか**
  - Messaging API（`docs/INSTAGRAM_SETUP.md`）で DM を受ける Second Root の業務アカウントでは**ログインしない**
  - 制限がかかると、DM の窓口まで止まる
- **Codex との関係（2026-10-01 に解決）**
  - Codex の read-only sandbox は、同じ Linux 利用者のファイルを読める。そこで 2 重に分けた
    - profile は別の Linux 利用者 `sr-igcapture` のホーム（0700）に置く（`design-capture-helper.md`）
    - Codex は bubblewrap の中でだけ動き、どの利用者のホームも見えない（`design-worker-wsl.md`「Codex の sandbox」）
  - どちらも本物の利用者・本物の bubblewrap で試験している（`cross-user.test.ts`・`sandbox.test.ts`）

## profile の置き場所と扱い

`~/.local/share/sr-instagram-browser/`（`sr-igcapture` のホーム、0700）

- **置き場所の検査**
  - 実行する利用者が `sr-igcapture` であること
  - ホームの中にあること
  - repo の中・`/mnt/`（Windows のドライブ）・link を辿った先ではないこと
- **中身の検査**
  - すべての entry が自分の所有であること
  - link は Chromium 自身のロック用のものだけ許す
  - 使った後は、group / other の権限を毎回外す
- **してはいけないこと**
  - cookie を読む・書き出す・コピーする
  - tar / zip にまとめる
  - バックアップする
  - repo・GitHub・Vercel・Supabase・Claude に渡す
- **worker・Codex との関係**
  - worker と Codex はこの profile の場所を知らない
  - 子 process の環境変数にも入れない

## 1. ログイン（最初の 1 回、人が行う）

WSLg（Windows 11 の WSL の画面表示）が必要。

```bash
cd ~/work/second-root && npm run -s sales:design-browser -- login
```

1. Chromium の窓が開き、instagram.com が表示される
2. **自分で**ログインする（password・2FA・確認画面も自分で）
   - 「ログイン情報を保存」「通知をオンにする」などの確認も自分で選ぶ
3. ホーム画面が出たら、窓は自動で閉じて `LOGIN_OK` と出る
   - 途中で窓を閉じると `LOGIN_NOT_COMPLETED`
   - 15 分で `LOGIN_TIMEOUT`

## 2. 撮影を試す（1 件）

```bash
printf '{"instagram_url":"https://www.instagram.com/<profile>/"}\n' > ~/sr-design-input/shop-001/source.json
cd ~/work/second-root && npm run -s sales:design-browser -- capture --source-file ~/sr-design-input/shop-001/source.json
```

**してよい操作**
- 公開プロフィールを開く
- 待つ
- グリッドが続くときだけ 1 回スクロールする
- 最大 3 枚撮る（`profile.png` / `grid-top.png` / `grid-lower.png`）

**しない操作**
- いいね・フォロー・コメント・DM・保存・共有
- 入力・クリック
- 設定の変更
- 通知の操作

**撮る前に隠すもの**
- 自分のアカウントのナビゲーション（アバター・通知・メッセージ）
- メッセージのドック、ダイアログ
- 「〇〇さんがフォローしています」の行と、おすすめのアカウント

**移動の見張り（guard）**
- capture のタブの document request（本体・frame・redirect の各 hop）は、送る前に Chromium の中（CDP Fetch）で止めて確かめる
- Instagram 内なら、browser が作ったままの request を送る（`sec-fetch-*`・言語・cookie・user agent を変えない）
- 許可は対象の profile のページと、ログイン・確認画面（止めるため）だけ。それ以外は送らずに止める。本体がそこへ行こうとしたら `PUBLIC_SOURCE_UNAVAILABLE`。理由は行き先の種類の固定 code（URL は出さない）:
  - `OFF_SITE_OTHER_HOST`: Instagram 以外の host
  - `OFF_SITE_SAME_SITE_PATH`: Instagram の別のページ（ホーム・explore など）
  - `OFF_SITE_IN_PAGE`: request を伴わないページ内の移動（history API）など
- ログイン・確認画面への redirect も、読み込まずに止める。Instagram のアカウント用ページ（`/auth_platform/`・`/accounts/suspended|disabled|onetap|consent/`・`/consent/`・`/privacy/checks/`・`/terms/unblock/` など）も同じく確認画面として `INSTAGRAM_CHALLENGE` で止める（2026-10-13 まではこれらが `OFF_SITE_REDIRECT` になり、helper が止まらなかった）。許可の範囲は変えていない
- 別 process で動く frame（sandbox 付きの iframe など）も、始まる前に止めて同じ確認を付けてから動かす
- prerender は止める。それでも本体が Instagram の外に出たら、その時点で撮影をやめる
- popup は一切移動させない。外の frame は止めるが、本体の移動とは数えない
- 見張りの外（従来どおり）: 画像・script などの読み込みと、Chromium 自身の先読み（speculation rules の prefetch など）。どれも撮る画面にはならない

画像はメイン部分だけを切り出す。投稿の画像はぼかしと画素化で、人や細部が分からないようにする。公開 bio と店名は残す。

| 表示 | 意味 | 終了コード |
|---|---|---|
| `CAPTURED n image(s)` | 撮れた。フォルダは 24 時間後に自動で消える | 0 |
| `LOGIN_REQUIRED` | ログインが切れた、またはまだしていない。1 をやり直す | 5 |
| `INSTAGRAM_CHALLENGE` / `INSTAGRAM_CAPTCHA` | Instagram が確認を求めた。回避しない。止めて様子を見る | 6 |
| `PUBLIC_SOURCE_UNAVAILABLE (理由)` | 非公開・存在しない・Instagram の外など。存在しない・非公開は `HTTP_404` / `HTTP_410` / `BODY_PRIVATE` / `BODY_PAGE_UNAVAILABLE` のどれで判断したかを出す | 4 |
| `CAPTURE_FAILED` | ネットワークや browser の失敗 | 4 |
| `BROWSER_BUSY` | 別の login / capture が profile を使っている | 3 |
| `WRONG_USER` / `PROFILE_*` / `DISPLAY_UNAVAILABLE` | 実行する利用者・置き場所・画面表示の問題 | 2 |

撮った画像はデザイン分析専用で、デモや公開 asset には使わない。repo や Windows にはコピーしない。

## 2b. 撮れない原因を調べる（diagnose）

人が見えるのに `PUBLIC_SOURCE_UNAVAILABLE` になるときに使う。撮影はせず、同じページを次の 3 通りで 1 回ずつ開いて、1・3・8・15 秒後の様子を符号で出す（全部で約 1 分）。

```bash
cd ~/work/second-root && npm run -s sales:design-browser -- diagnose --source-file ~/sr-design-input/shop-001/source.json
```

| 行の頭 | 開き方 |
|---|---|
| `A` | headless、capture と同じ navigation guard（Chromium の中で document request を 1 hop ずつ確かめ、許すものはそのまま送る） |
| `C` | headless、route interception なし（診断専用。Instagram の外への移動が見えたら `STOPPED_OFF_SITE` で止める。ただし interception が無いので、外への最初の 1 リクエストは止められない。popup はすぐ閉じる） |
| `B` | 画面あり（WSLg）、guard あり。入力・クリック・スクロールはしない。画面が無ければ `SKIPPED_NO_DISPLAY` |

- A と B は capture と同じく、Instagram 内の redirect を 1 hop ずつ手で辿る
- 各 run の最後に、新しいタブで Instagram のホームを開き、最大 15 秒待って `SESSION_OK` / `SESSION_MISSING` を出す。ただし capture と同じ target（対象の profile だけを許可）ではホームを開かず `SESSION_NOT_CHECKED` を出す（2026-10-01 以降の本番。ログインが生きているかは、対象ページの `SIGNED_IN_NAV_PRESENT` で見る）
- 読み込んだ後でアカウント用のページへ移ろうとしたときは `STOPPED_WALL`。C（interception なし）でも、アカウント用のページは A と同じく `HTTP_OTHER CHALLENGE_PRESENT` と出す（ただし C は最初の 1 リクエストを止められない）
- 外へ出て止めたときは `STOPPED_OFF_SITE` の後に、分かれば行き先の種類（`OFF_SITE_OTHER_HOST` / `OFF_SITE_SAME_SITE_PATH` / `OFF_SITE_IN_PAGE`）を出す。C は移動を止められず、request と移動のどちらが先に見えるかも決まらないので、行き先の種類（`OTHER_HOST` / `SAME_SITE_PATH`）だけで名付ける（ページ内の移動も `SAME_SITE_PATH`）
- どの run も browser が起動できなかったときは `DIAGNOSE_FAILED`（終了コード 4）
- ページや browser の close が 10 秒で終わらないときは、その run の browser を終わらせて次へ進む（DEV-035。負荷の高い時に close が終わらず止まることがあった）。ページの close が 10 秒で終わらないときは、そのページ自身の target を CDP で閉じ、Chromium の target 一覧から消えたら閉じたものとする（DEV-041。target は開いたときにそのページ自身の CDP session から取っておくので、同じ URL の別のページは閉じない。これも 10 秒まで。1 つのページの close は最大 20 秒、close にかかる時間は 1 つの mode で最大およそ 1 分。ページを開くときに id を取る分が最大 2 秒）。それでも閉じなかったときだけ run を打ち切って `CLOSE_TIMEOUT`、browser も終わったと確かめられなかったときは `BROWSER_STUCK`（Playwright の close は process の終了を待つだけで強制終了はしない。応答しない browser は diagnose の process が終わるときに Playwright が終わらせる。test のように close の上限が短くても、browser を終わらせる待ちは最低 5 秒、DEV-060）。C で外への移動を見つけたときは、request の handler の中ではページを閉じず、run の側がすぐに（読み込み中・様子を見る間・ホームを待つ間のどこでも）1 回だけ閉じる
- 出る符号は `HTTP_200` / `HTTP_404` / `HTTP_OTHER`、`MAIN_*` / `HEADER_*` / `POSTS_*`（`PRESENT` / `MISSING`）、`BODY_PRIVATE_MARKER`、`BODY_UNAVAILABLE_MARKER`、`SIGNED_IN_NAV_PRESENT`、`CHALLENGE_PRESENT`、`CAPTCHA_PRESENT` だけ
- username・bio・キャプション・cookie・token・ページの文・URL は出さない。画像も保存しない
- capture の安全ガードは変えていない（C は diagnose の中だけ）

読み方:
- A だけ unavailable、C は posts あり → guard が原因（2026-09-30 に見つけた旧 guard の問題: 送り直した request に browser 自身の `sec-fetch-*` / `accept-language` が付かなかった。修正済み）
- A と C が unavailable、B は posts あり → headless の違い
- 全部 unavailable で `SESSION_MISSING` → ログインが切れている（本番の target では `SESSION_NOT_CHECKED` になるので、対象ページで `SIGNED_IN_NAV_PRESENT` が出るかで見る。出なければログインが切れている）
- `STOPPED_WALL`（`CHALLENGE_PRESENT` 付きのことがある）→ 読み込んだ後で、ページがログイン・確認・アカウント用のページへ移ろうとした（読み込まずに止めた）
- A が `HTTP_OTHER CHALLENGE_PRESENT` → Instagram がログイン・確認・アカウント用のページへ送っている。回避しない。人が headed login で様子を見る
- A が `STOPPED_OFF_SITE OFF_SITE_SAME_SITE_PATH` → 対象以外の Instagram のページへ送られている（未知のアカウント用ページの可能性。許可は広げずに報告する）
- 最初だけ `BODY_UNAVAILABLE_MARKER` で後から `POSTS_PRESENT` → 表示途中の文を拾っている（capture は 5 秒後に判断する）
- 全部 unavailable で `SESSION_OK` → 残る違いは capture 共通の設定（service worker を止める・CSP 無視・画面サイズ固定・`ja-JP`）

## 3. 状態の確認・後片付け

```bash
npm run -s sales:design-browser -- check    # PROFILE_OK / PROFILE_MISSING / PROFILE_*
```

ログインを捨てるときは、次の 2 つを行う。
1. Instagram の「ログインアクティビティ」でこの端末をログアウトさせる
2. `rm -rf ~/.local/share/sr-instagram-browser` を実行する

## worker の取得順（組み込み済み）

1. 確認済みの公式サイト（fresh context、Instagram の session は使わない）
2. ログイン済みの専用 profile（capture helper 経由）
3. 未ログインの撮影
4. `PUBLIC_SOURCE_UNAVAILABLE`
