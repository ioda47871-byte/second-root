# 専用ブラウザで Instagram を撮る（DEV-028 PoC）

design worker の参考画像を、**ログイン済みの専用 Chromium profile** で撮る方式の PoC。
worker にはまだ組み込まない。Meta Business Discovery は保留中。

- Claude Cloud は Instagram にログインしない
- ログインは、人が WSL の画面で 1 回だけ手で行う
  - password・2FA・確認画面は人が入力する
  - この道具は入力・クリック・自動ログインをしない
- 以降の撮影は、同じ profile を使ってローカルで行う
- 普段使いの Windows Chrome profile は使わない

## 使う前に知っておくこと（人間の判断）

- **Instagram の利用規約**: 自動的な手段での情報収集を制限している
  - ログイン済みのアカウントで自動撮影すると、そのアカウントに制限・停止がかかる可能性がある
  - 撮影は 1 件ずつ・最小限（ページを開く、待つ、最大 1 回のスクロール、撮影）にしてある
  - それでもこのリスクは無くならない
- **どのアカウントでログインするか**
  - Messaging API（`docs/INSTAGRAM_SETUP.md`）で DM を受ける Second Root の業務アカウントでは**ログインしない**
  - 制限がかかると、DM の窓口まで止まる
- **Codex との関係（worker に組み込む前の課題）**
  - Codex の read-only sandbox は、同じ Linux 利用者のファイルを読める
  - 参考画像の中の文字（bio など）に紛れた指示で、Codex が profile の中身を読みにいく可能性はゼロではない
  - worker に組み込む前に、次のどちらかを決める
    - Codex からこの profile を隠す（例: bubblewrap で profile のディレクトリを空にして見せる）
    - profile を別の Linux 利用者に分ける
  - 今の PoC では Codex を呼ばない

## profile の置き場所と扱い

`~/.local/share/sr-instagram-browser/`（`sr-designgen` のホーム、0700）

- **置き場所の検査**
  - 実行する利用者が `sr-designgen` であること
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
| `A` | headless、capture と同じ navigation guard（`route.fetch` → `route.fulfill`） |
| `C` | headless、route interception なし（診断専用。Instagram の外への移動が見えたら `STOPPED_OFF_SITE` で止める。ただし interception が無いので、外への最初の 1 リクエストは止められない。popup はすぐ閉じる） |
| `B` | 画面あり（WSLg）、guard あり。入力・クリック・スクロールはしない。画面が無ければ `SKIPPED_NO_DISPLAY` |

- A と B は capture と同じく、Instagram 内の redirect を 1 hop ずつ手で辿る
- 各 run の最後に、新しいタブで Instagram のホームを開き、最大 15 秒待って `SESSION_OK` / `SESSION_MISSING` を出す
- どの run も browser が起動できなかったときは `DIAGNOSE_FAILED`（終了コード 4）
- 出る符号は `HTTP_200` / `HTTP_404` / `HTTP_OTHER`、`MAIN_*` / `HEADER_*` / `POSTS_*`（`PRESENT` / `MISSING`）、`BODY_PRIVATE_MARKER`、`BODY_UNAVAILABLE_MARKER`、`SIGNED_IN_NAV_PRESENT`、`CHALLENGE_PRESENT`、`CAPTCHA_PRESENT` だけ
- username・bio・キャプション・cookie・token・ページの文・URL は出さない。画像も保存しない
- capture の安全ガードは変えていない（C は diagnose の中だけ）

読み方:
- A だけ unavailable、C は posts あり → guard の `route.fetch` が原因（browser 自身の `sec-fetch-*` / `accept-language` header が付かない）
- A と C が unavailable、B は posts あり → headless の違い
- 全部 unavailable で `SESSION_MISSING` → ログインが切れている
- 最初だけ `BODY_UNAVAILABLE_MARKER` で後から `POSTS_PRESENT` → 表示途中の文を拾っている（capture は 5 秒後に判断する）
- 全部 unavailable で `SESSION_OK` → 残る違いは capture 共通の設定（service worker を止める・CSP 無視・画面サイズ固定・`ja-JP`）

## 3. 状態の確認・後片付け

```bash
npm run -s sales:design-browser -- check    # PROFILE_OK / PROFILE_MISSING / PROFILE_*
```

ログインを捨てるときは、次の 2 つを行う。
1. Instagram の「ログインアクティビティ」でこの端末をログアウトさせる
2. `rm -rf ~/.local/share/sr-instagram-browser` を実行する

## 次の段階（まだしない）

撮影の成功を確かめた後、worker の取得順に組み込む。

1. 確認済みの公式サイト（fresh context、Instagram の session は使わない）
2. ログイン済みの専用 profile
3. 今の未ログインの撮影
4. `PUBLIC_SOURCE_UNAVAILABLE`

組み込む前に、上の「Codex との関係」を解決する。
