# Sveltia CMS Additions の実環境の試験: オーナーの手順（Issue #380、案 B）

2026-11-28。前提: オーナーが Step B1 を終えた（Worker `sveltia-cms-additions`、repo `sr-cms-trial/sveltia-cms-additions`、Production の URL `https://sveltia-cms-additions.ioda-receipt.workers.dev`、Preview は無効）。
Second Root がしたのは**ローカルの作業だけ**（サインイン・ウィザード・試験用 repo への push はしていない）。背景は [`cms-auth-choice.md`](cms-auth-choice.md)、Sveltia 全般は [`cms-sveltia-trial-owner-steps.md`](cms-sveltia-trial-owner-steps.md)。

> **秘密の扱い（毎回）**: `ADMIN_SECRET` とパスワード（仮パスワードを含む）は、**チャット・ファイル・スクリーンショット・GitHub の issue に書かない**。パスワード管理アプリにだけ入れる。撮影の前に入力欄が空か伏せ字かを見る。

## 0. 渡すもの

| ファイル | sha256 |
|---|---|
| `additions-update.zip`（更新、4 ファイル） | `c2dea122d7c64e3aa385404d961a061d3f53242b20667e2ce101d30769f1f85c` |
| `additions-rollback.zip`（戻し、同じ 4 ファイル。token/GitHub のログインに戻し、#398 の CSP は残す。§9） | `e9c2318e787b5d5849d5e43f6b3c5e83f560c4811c75e059ca81e800b115a882` |
| `manifest.json`（各ファイルの sha256） | — |

更新の ZIP の中身（全て「変更」。追加・削除なし。`content/`・`media/` は含まない）:

| パス | 変わる点 |
|---|---|
| `admin/config.yml` | `backend` に `auth_type: "additions"` と `base_url: "https://sveltia-cms-additions.ioda-receipt.workers.dev"` |
| `admin/index.html` | CSP: `script-src` に `'wasm-unsafe-eval'`（iPhone の「Load failed」の修正、#398）、`connect-src` に Worker の `https://`・`wss://`、`form-action` に `https://github.com`（ウィザードの GitHub App の作成に要る、§7） |
| `site.config.json` | `sveltia` に `auth_type`・`base_url` |
| `site/sveltia-config.ts` | 上の 2 つを作る元（`build.mjs` がこれで照合するので**必ず一緒に上げる**） |

基準は今の試験用 repo（trial commit `d9fbaa3` = snapshot + uuid の ZIP + sveltia の ZIP。wasm の ZIP は当てていない前提）。wasm の ZIP の変更はこの ZIP に含まれるので、wasm の ZIP は**当てない**。

## 1. ZIP を当てる（ウィザードより先）

1. ZIP を手元で展開し、`manifest.json` の sha256 と ZIP の sha256 を見比べる（PowerShell: `Get-FileHash .\additions-update.zip`）。
2. GitHub の `sr-cms-trial/sr-cms-trial-autocare` → **Add file → Upload files**。展開した `admin` フォルダ・`site` フォルダ・`site.config.json` をまとめてドラッグする（フォルダの中の位置が保たれる）。
3. 画面の一覧が次の 4 つだけか見る: `admin/config.yml`、`admin/index.html`、`site.config.json`、`site/sveltia-config.ts`。
4. Commit message（コピー用）:
   ```
   Sveltia CMS Additions: auth_type additions + CSP (wasm, Worker https/wss, form-action github.com)
   ```
   **Commit directly to the main branch** で Commit。
5. 記録: commit SHA。Cloudflare Pages の構築が **Success** になったら deploy ID。
6. 確かめ: `https://sr-cms-trial-autocare.pages.dev/admin/` を開くと **Username / Password / Sign In / Use Admin Secret** が出る（「Sign In with GitHub」「Sign In Using Access Token」は出ない）。出なければ止まって §9 で戻す。

## 2. ウィザード（Use Admin Secret）

**必ず `https://sr-cms-trial-autocare.pages.dev/admin/` で開く**（ウィザードは開いているサイトのドメインを許可ドメインに入れる）。PC のブラウザで行う。

1. **Use Admin Secret** → `ADMIN_SECRET` をパスワード管理アプリから貼る（間違いを繰り返すと最大 10 分ロックされる）。
2. 手順 1: 最初の admin を作る。
   - username（例 `owner-admin`、3〜30 文字、英小文字・数字・`.` `-` `_`。後で変えられない）。
   - パスワード: パスワード管理アプリで**乱数 16 文字以上**を作る（12 文字以上が必須）。
3. 手順 2: GitHub App を作る（§3）。
4. 終わったら、ウィザードを開き直すと要約（**Reset Admin Password** など）が出る。ここで **Start Over は押さない**（全員サインアウト・private key の入れ直しになる）。

## 3. GitHub App（ウィザードの手順 2）

1. 対象の repo に `sr-cms-trial/sr-cms-trial-autocare` を指定する。ウィザードが github.com の App の作成の頁へ送る（Organization `sr-cms-trial` の owner でサインインしておく）。
2. **作る前に権限を見比べる**。GitHub の頁の表示と、次の表が全て一致したら作る。**1 つでも違えば（多い・少ない・Read と Write の違い）作らずに止まり、画面を撮って Second Root に送る**。
   - 表の出典: Sveltia の文書には一覧が無い。Worker のコード `sveltia/sveltia-cms-additions` の `lib/git/github/routes.js` の `buildManifest`（`default_permissions`、main の `4bbfa8c8`、2026-11-22。2026-11-28 に読んだ）。同じ所で `default_events` は空、webhook は無効（`active: false`）。
   - **注意**: オーナーの Worker は Deploy ボタンで写した repo（`sr-cms-trial/sveltia-cms-additions`）から動くので、main より古い・新しいことがある。だから表を信じ切らず、**画面で見比べ、違えば止まる**。

   | 区分 | 権限 | 期待 |
   |---|---|---|
   | Repository | Contents | Read and write |
   | Repository | Metadata | Read-only |
   | Repository | Pull requests | Read and write |
   | Repository | Commit statuses | Read-only |
   | Organization | Members | Read-only |

3. 作った後、Install: **Only select repositories** → `sr-cms-trial-autocare` **だけ**を選ぶ。**All repositories は選ばない**。
4. GitHub が CMS に戻す。記録: App の名前、Install の画面（権限と repo が見える状態、秘密は写らない）。

## 4. 管理の設定（admin でサインインして Administration）

1. **Domains**: 一覧が `sr-cms-trial-autocare.pages.dev` **1 行だけ**か見る。`localhost`・`*.pages.dev` などワイルドカードがあれば消す。
2. **Sign-in methods**: 「Allow signing in with GitHub」は**無効のまま**（案 B の条件）。
3. **Commit Author**: 既定の「The person who made the change」のまま（記録だけ）。
4. 画面に ruleset の警告が出ても、今回は repo の設定を変えない（記録だけ）。

## 5. 利用者を作る（Administration → Users → Add User）

GitHub username は**空**にする。作ると仮パスワードが**1 回だけ**出るので、その場でパスワード管理アプリに入れる（チャットに貼らない）。

| 役 | username（例） | Role | 使う場面 |
|---|---|---|---|
| 2 人目の admin | `backup-admin` | admin | 互いに再設定できるように（[`cms-auth-choice.md`](cms-auth-choice.md) §8 の条件: admin 2 人、乱数 12 文字以上、GitHub サインイン無効） |
| 顧客役（編集者） | `shop-editor` | editor | §6 の写真の試験 |
| 閲覧の試験 | `shop-viewer` | viewer | §6 の権限の試験 |

Email は空でよい（入れるならコミットのメールに使われる。実在の顧客のメールは使わない）。各利用者は初回のサインインで自分のパスワードに変える（12 文字以上）。

## 6. 実機の試験（この順）

### 6.1 iPhone の Safari（`shop-editor` で）

1. `https://sr-cms-trial-autocare.pages.dev/admin/` → username・仮パスワード → 新しいパスワードに変える。
2. 施工実績を 1 件追加し、写真 **1 枚**（カメラロールのまま）→ 保存。
3. 新しい 1 件に写真 **3 枚** → 保存。
4. **HEIC** の写真（「設定 → カメラ → フォーマット → 高効率」で撮ったもの）→ 保存。
5. 各回、公開の頁に出るまで待って見る。

### 6.2 iPhone の Brave

同じ 3 つ（1 枚・3 枚・HEIC）。Brave の Shields で止まったら、止まった表示を撮って記録する（Shields は変えずに 1 回、変えて 1 回）。

### 6.3 アカウントの試験

| # | 操作 | 期待 |
|---|---|---|
| 1 | `shop-editor` で Administration を探す | 出ない・開けない |
| 2 | `shop-viewer` で entry を編集して保存 | 保存できない（全体が読み取り専用） |
| 3 | admin で `shop-viewer` を **Disable** → viewer の端末で操作 | すぐ使えなくなる（再サインインも不可） |
| 4 | admin で `shop-viewer` を **Delete** | 一覧から消える（元に戻せない） |
| 5 | admin で `shop-editor` を **Reset Password** | editor は全端末でサインアウト。新しい仮パスワードで入り、自分のパスワードに変えられる |
| 6 | `shop-editor` でサインアウト → サインイン | 入れる |
| 7 | （任意）`backup-admin` で `owner-admin` の Reset Password | 互いに戻せる |

## 7. 記録すること（各試験ごと）

| 項目 | 例 |
|---|---|
| 時刻（JST、開始と終了） | 10:02–10:04 |
| 端末・ブラウザ・利用者 | iPhone 15 / Safari / shop-editor |
| 操作と結果 | 写真 3 枚で保存、成功 |
| commit SHA（GitHub の履歴） | `abc1234` |
| Cloudflare Pages の deploy ID | `1a2b3c4d` |
| `media/` に入ったファイルの名前・大きさ | `img_0001.webp` 812 KB |
| 画面の写真 | エラーの表示・成功の表示。**秘密・パスワードの欄が写らないもの** |

保存が失敗したら、その時刻と画面の文言をそのまま記録し、続けずに Second Root に送る（[`cms-sveltia-load-failed.md`](cms-sveltia-load-failed.md) の調べ方）。Sveltia は約 2 MB ごとに分けて保存するので、途中まで保存されることがある。GitHub の履歴も撮る。

## 8. Second Root がローカルで確かめたこと（2026-11-28）

- 重ねた確かめ: snapshot の写しに uuid の ZIP → sveltia の ZIP → この ZIP を当て、`npm ci`・`npm run build`・`npm test`（8/8）が通った。`dist/admin/index.html` に SRI（sha384）と上の CSP、`dist/admin/config.yml` に `auth_type`・`base_url`。
- Additions が出す通信（Sveltia 5.0.3 の本体と `chunks/additions.js` の中身、公式の文書）と CSP:

  | 通信 | いつ | CSP |
  |---|---|---|
  | `https://unpkg.com/@sveltia/cms@5.0.3/dist/chunks/additions.js` と共有の部品 | `/admin/` を開いたとき | `script-src https://unpkg.com` |
  | Worker の `GET /version` | ログイン画面を出すとき | `connect-src` の Worker の `https://` |
  | Worker の `/v1/auth/*`（サインイン・token・セッション）、`/v1/users`・`/v1/settings` など | サインインの後 | 同上 |
  | Worker の `wss://…/v1/socket`（ロック・コメント） | サインインの後 | `connect-src` の Worker の `wss://` |
  | `https://api.github.com`（1 時間の token で GitHub に直接） | 読み込み・保存 | `connect-src https://api.github.com` |
  | `https://github.com/...settings/apps/new` へのフォームの POST | ウィザードの手順 2 | `form-action https://github.com`（**今回足した**。前の `form-action 'self'` では止まることをローカルの Chromium で確かめた）。送り先は `routes.js` の `https://github.com/organizations/<owner>/settings/apps/new` か `https://github.com/settings/apps/new` の 2 つだが、CSP は**origin だけ**にした: `form-action` は POST の後の redirect にも掛かり、GitHub が未サインイン時などにどこへ redirect するかは github.com へ実際に送らないと確かめられない（今回の範囲外）。止まると App を作れないので、確かめられない狭め方はしない |

- 実際の Worker で起動の確かめ（ローカルの Chromium、`/admin/` を開くだけ）: 送ったのは `GET /version` だけ（200）。**CSP の違反 0 件**。ログイン画面に Username・Password・Sign In・Use Admin Secret が出た。資格情報の入力・ウィザード・管理の通信はしていない（他の Worker への通信は全て止める設定で、0 件だった）。ローカルの起動なので「Work with Local Repository」も出たが、pages.dev では出ない見込み（未検証）。
- **未検証**: サインインの後の通信（REST・WebSocket）の実際、GitHub App の権限の一覧、iPhone の Safari と Brave、HEIC。

## 9. 戻し方

- **repo を戻す（既定）**: `additions-rollback.zip` を §1 と同じ手順で上げる。token/GitHub のログイン（Additions なし）に戻り、**#398 の CSP（`'wasm-unsafe-eval'`）は残る**:
  - `admin/config.yml`・`site.config.json` は今の版（`d9fbaa3`、Additions の設定なし）。
  - `admin/index.html`・`site/sveltia-config.ts` は wasm の ZIP の版（sha256 `138e43b8…`・`b7b76f99…`）。CSP は `form-action 'self'` だけで、Worker の origin は入らない。
  - Second Root の確かめ: snapshot に uuid → sveltia → additions → この ZIP を当て、`npm ci`・構築・`npm test`（8/8）が通り、`dist/admin` の CSP が上の通り（wasm の ZIP を当てた状態と同じ中身）。
- **すぐ戻す（repo を変えない、別の方法）**: Cloudflare Pages の Deployments で、ZIP の前の deploy の **Rollback to this deployment**。repo は Additions のままなので、次の push で Additions に戻る。落ち着いたら上の ZIP で repo も戻す。
- Additions をやめる: GitHub の `sr-cms-trial` → Settings → GitHub Apps で App を Uninstall し、App を削除。Cloudflare で Worker を削除（Durable Object の消し方は公式に記載なし、未確認）。
- `ADMIN_SECRET` が漏れた疑い: Cloudflare で新しい値に変え、ウィザードで前の値を聞かれたら入れる（全員そのまま）。前の値が分からなければ Start Over（全員サインアウト、private key の入れ直し）。
- 保存された写真と entry は content として残る（消すなら CMS で消す）。
