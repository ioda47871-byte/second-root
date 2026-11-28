# Sveltia CMS Additions の評価（Issue #380、案 B）

2026-11-28。状態: **調べだけ**。サインイン・アカウント作成・Deploy・送信・公開の変更は何もしていない。
出典はすべて公式の頁か一次の資料（Sveltia の文書、`sveltia/sveltia-cms-additions` の README・ソース、Cloudflare と GitHub の文書）で、**アクセス日はすべて 2026-11-28**。引用は原文のまま（長いものは一部）。
資料に書かれていないものは **未確認**、資料にはあるが実機で確かめていないものは **未検証**、Second Root の見積もりは **見積もり** と書く。
「技術的にできるか」（§1〜§7）と「商用で提供できるか」（§8）は分けて書く。**顧客への約束は書かない**。

背景:
- 写真の 413 と選択肢: [`cms-upload-limit-options.md`](cms-upload-limit-options.md)
- 案 A（オーナーが fine-grained token で入る）の試験の手順: 枝 `feature/dev380-sveltia-poc` の `docs/design/cms-sveltia-trial-owner-steps.md`
  （その文書の「GitHub App の権限の一覧は公式に書かれていない」は、**ソースに書かれていた**ので本書 §1.3 で更新する。インストール画面での確認は引き続き行う）

## 0. 結論（先に）

- **技術**: Additions は「Cloudflare Worker + Durable Object（SQLite）+ サイト専用の GitHub App」で、顧客は **ID とパスワードだけ**で入れる（GitHub のアカウント不要）。ブラウザには **1 時間で切れる、1 つの repo だけの GitHub token** が渡り、内容は Worker を通らず GitHub に直接保存される。Workers の Free プラン（SQLite の Durable Object は Free で使える）で動く設計。
- **安全**: 案 A（長く有効な個人 token をブラウザに置く）より良い。ただし **2FA・パスキーは未対応（予定）**、パスワードの再設定は管理者が手で行う（メールは送らない）、サーバー側のハッシュは 1 回の SHA-256（総当たりへの強さはブラウザ側の PBKDF2 600,000 回に依存）。
- **成熟度が最大の懸念**: npm の版は `1.0.0`、repo は 6 commits・2 stars・Releases が空（2026-11-28 時点）。Sveltia CMS 本体も安定版になって 2 日（v5.0.0 が 2026-11-26）。
- **自立運用**: MIT・顧客の口座で動くので、Second Root が抜けても動き続けうる。ただし **誰かが Dependabot の PR をマージし続ける**ことが前提。データの書き出し・別の Cloudflare アカウントへの移行の機能は **無い（未確認）** ので、**最初から顧客の Cloudflare アカウントに Deploy する**のが引き渡しの手間が最も少ない。
- **推奨（技術）**: 試験専用の Organization と Cloudflare アカウントで試す価値はある。正式の納品方法にするかは、試験の結果と §8 の未決事項を見てオーナーが判断する。

## 1. 認証の仕組み

### 1.1 全体の形

| 項目 | 内容 | 出典 |
|---|---|---|
| 構成 | 「It runs as a Cloudflare Worker registered as a GitHub App.」「a Durable Object per site, whose SQLite storage is the site's database」 | https://github.com/sveltia/sveltia-cms-additions （README） |
| サインインの流れ | 「It checks their account and role, then gives the browser a short-lived GitHub token limited to your site's repository」 | https://sveltiacms.app/en/docs/additions |
| 内容の通り道 | 「Content never passes through the service」（CMS が token で GitHub と直接話す） | 同上 |
| Worker が止まったとき | 「people who are already signed in keep working until their GitHub token expires, which takes an hour at most.」 | 同上 |
| 認証のライブラリ | Better Auth。`disableSignUp: true`（自分で登録できない）、`bearer({ requireSignature: true })`、`admin({ defaultRole: 'viewer', adminRoles: ['admin'] })`。「Better Auth's own HTTP handler is never exposed」 | https://github.com/sveltia/sveltia-cms-additions/blob/main/lib/core/auth/options.js |
| 要件 | 「Sveltia CMS v0.271.0 or later.」（5.0.3 は満たす）「GitHub Enterprise isn't supported yet.」「A Cloudflare account. The Free plan is enough.」 | https://sveltiacms.app/en/docs/additions |

### 1.2 アカウント・パスワード・セッション

- **ID**: 「3 to 30 lowercase letters, digits, dots, hyphens or underscores, used to sign in. It can't be changed later.」（https://sveltiacms.app/en/docs/additions/users）
- **メール**: 「optional. It's used as the commit author's email」。ログインには使わない。
- **パスワード**: 「Passwords must have at least 12 characters.」
- **ハッシュ**:
  - ブラウザ: 「The CMS derives a hash from the password with PBKDF2 (600,000 iterations) before sending it」「and the service hashes that again before storing it.」（https://sveltiacms.app/en/docs/additions）
  - サーバー: 16 バイトの乱数の salt + `SHA-256(salt + "$" + prehash)`、`v1$<salt>$<hash>` で保存、比較は `timingSafeEqualStrings`。コメント「The browser has already done the slow work (PBKDF2 with 600,000 iterations), so a single SHA-256 is enough here」、理由は「fits the Workers Free plan's CPU limit」（https://github.com/sveltia/sveltia-cms-additions/blob/main/lib/core/auth/password.js）。
  - 読み: 保存された値が漏れた場合、総当たりへの強さはブラウザ側の PBKDF2 の値（＝送られる値）に対して 1 回の SHA-256 だけ。PBKDF2 の salt の作り方・内部のハッシュ関数は **未確認**。DB の中身は「stored encrypted, under a key protected by the admin secret」（下記）なので、Worker の外に出にくい設計。
- **セッション**: 「Sessions end after a day without use, and after 7 days in any case.」（users の頁）。ソースでも `SESSION_IDLE_TIMEOUT = 24h`、`SESSION_MAX_AGE = 7d`。セッションは Cookie ではなく `Authorization` ヘッダーの bearer token。
- **GitHub の token**: 「Tokens last one hour」（`lib/git/github/app.js` のコメント）。残り 10 分を切ると取り直す（`lib/core/git-tokens.js`）。CMS は「about once an hour」取り直す。
- **2FA・パスキー**: **無い**。「Passkeys and two-factor authentication」は Planned Features（https://sveltiacms.app/en/docs/additions）。
- **パスワードの再設定**: 「Sveltia CMS Additions never sends email itself, so there are no automatic invitations or password reset emails」。管理者の Reset Password が「gives the user a new temporary password and signs them out everywhere.」（users の頁）。管理者自身を忘れたら「open the wizard with the admin secret, and reset the password of an admin or create a new admin.」（https://sveltiacms.app/en/docs/additions/setup）
- **回数の制限**: 「Repeated failed sign-ins are rate limited.」（users の頁）。ソース（https://github.com/sveltia/sveltia-cms-additions/blob/main/lib/core/routes/auth.js）: `SIGN_IN_LIMITS = { client: 30, username: 10, windowSeconds: 600 }`（IP ごとに 10 分 30 回、ID ごとに失敗 10 回／10 分）。超えると HTTP 429 `too_many_attempts` と `Retry-After`。**恒久のロックは無い**（窓が過ぎれば再開）。admin secret の誤りは「rate limited, for each visitor and for everyone together」で「can lock the wizard for up to 10 minutes, even for the right secret.」（setup の頁）。
- **監査の記録**: ソースに `logAudit`（`auth.sign_in`・`auth.password_change`・`github.app_create`・`github.app_install`・`github.private_key_replace` など、「Never include secrets.」）がある（https://github.com/sveltia/sveltia-cms-additions/blob/main/lib/core/audit.js）。**見る画面・保存期間は未確認**（文書に記載なし、保存部分のファイルは取得時 HTTP 503）。内容の変更そのものは GitHub の commit の履歴に残る（作者のメールは users の頁の通り）。

### 1.3 GitHub への権限

- サイトごとに GitHub App をウィザードが manifest から作る（`public: false`、Webhook は `active: false`「Webhooks aren't used yet」）。
- **App が求める権限（ソースの `default_permissions`）**（https://github.com/sveltia/sveltia-cms-additions/blob/main/lib/git/github/routes.js）:
  - Repository: `contents: write`、`metadata: read`、`pull_requests: write`、`statuses: read`
  - Organization: `members: read`（コメント「to check who belongs to the organization of a sign-up rule」）
  - `default_events: []`
- **役割ごとに渡す token の権限**（https://github.com/sveltia/sveltia-cms-additions/blob/main/lib/git/github/index.js）:
  - viewer: contents read / metadata read / pull_requests read / statuses read
  - editor・admin: contents **write** / metadata read / pull_requests **write** / statuses read
  - 「`workflows`, `administration`, `secrets` and `actions` are never requested.」 不明な役割は viewer に落ちる。
- token は `repository_ids: [repositoryId]` で **1 つの repo に限定**（`lib/git/github/app.js`）。GitHub の仕様でも「The installation access token will expire after 1 hour.」「cannot be granted access to repositories that the installation was not granted access to.」（https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app）
- インストールは「**Only select repositories**, with just the site's repository.」（setup の頁）。
- **限界**: 「GitHub tokens can't be limited to certain files or branches, so roles apply to the whole repository.」（additions の頁）。editor は repo のどのファイル（`build.mjs` など構築の仕組みも）でも書き換えられる。
- **確かめ方（試験の時）**: App のインストール画面と、GitHub の Settings → Applications → Installed GitHub Apps → Configure の「Permissions」で上の一覧と同じか撮影して記録する（https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps）。ソースと実際の画面が違えば止まる。

### 1.4 役割

| 役割 | できること（https://sveltiacms.app/en/docs/additions/users） |
|---|---|
| admin | 「Everything an editor can, plus manage users and settings on the Administration page」 |
| editor | 「Create, edit, delete and publish content and assets, and trigger deployments」 |
| viewer | 「Browse content and assets, and comment on entries, without changing anything」 |

- 降格・無効化・サインアウトは「revokes their GitHub tokens on GitHub's side right away」（additions の頁）。
- 管理者は GitHub でのサインインを有効にもできるが「GitHub sign-in never creates an account by itself.」。GitHub で入った人は自分の GitHub の権限の token を使う（「A viewer who can write to the repository on GitHub can write through the CMS.」、repo の `docs/setup.md`）。**店の運用では無効のままにする**（推奨、技術）。

## 2. 誰が何を持つか

### 2.1 顧客（店の編集者）

- **必要なアカウント: 無し**（Additions の ID とパスワードだけ。管理者が作って手で渡す。メールは任意）。
- スマートフォンのブラウザで `/admin/` を開いて入る。

### 2.2 自立運用のために店（オーナー）が持つもの

| もの | 理由 |
|---|---|
| GitHub の Organization（または個人アカウント）: サイトの repo、Deploy で写される Additions の小さな repo、GitHub App の登録 | App の登録の持ち主が private key を作り直せる。App の登録は他の account に移せる（「You can transfer apps from a user or organization to another account.」https://docs.github.com/en/apps/maintaining-github-apps/transferring-ownership-of-a-github-app） |
| Cloudflare のアカウント: Pages（店の頁）と Worker・Durable Object（Additions） | Durable Object の中に利用者・設定・暗号化された App の private key がある |
| `ADMIN_SECRET`（32 文字以上） | 管理者の復旧、ウィザードの再実行に要る。DB の暗号化の鍵を守る |
| 最初の admin の ID とパスワード | |

### 2.3 Second Root が持つもの

- **納品の間**: 構築と設定の作成（`admin/config.yml`、`admin/index.html` の SRI・CSP）、手順書。可能なら顧客の Organization・Cloudflare アカウントに **メンバー（権限は最小）として招かれる**形にし、Second Root 名義の資源を作らない（推奨、技術）。
- **引き渡しの後**: 何も持たないのが原則。保守を請けるならメンバーとして残る（§8 で別に決める）。`ADMIN_SECRET` を Second Root が保管し続けるかは決める必要がある（持たないほうが安全、持たないと復旧の手伝いができない）。
- メモ: README の「a registry object」・`/v1/tenants*` から、1 つの Worker で複数のサイトを扱える作りに見えるが、文書の説明は **未確認**。顧客の独立と障害の分離のため、**店ごとに顧客の口座に 1 つ**を前提にする。

## 3. 無料枠

| 項目 | Workers Free の値 | 出典 |
|---|---|---|
| Worker の要求 | 100,000／日（UTC 0 時に戻る） | https://developers.cloudflare.com/workers/platform/limits/ |
| CPU | 10 ms／HTTP 要求。超えると Error 1102「Worker exceeded resource limits」 | 同上 |
| 外への要求 | 50／回（Additions は token の取り消しを「batches of 40」で行う。理由「Workers on the Free plan may make 50 outgoing requests per invocation」） | 同上、`lib/core/git-tokens.js` |
| 日の上限を超えたとき | 「Cloudflare returns **Error 1027**」。fail open／closed はルートの設定で、workers.dev での扱いは **未確認** | https://developers.cloudflare.com/workers/platform/limits/ |
| Durable Object が Free で使えるか | 「Durable Objects are available both on Workers Free and Workers Paid plans.」「Workers Free plan: Only Durable Objects with SQLite storage backend are available.」（Additions は `new_sqlite_classes` で SQLite 型） | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| DO の無料枠 | 要求 100,000／日、Duration 13,000 GB-s／日、行の読み 500 万／日、行の書き 100,000／日、保存 5 GB（合計） | 同上 |
| DO の上限を超えたとき | 「If you exceed any one of the free tier limits, further operations of that type will fail with an error.」「Daily free limits reset at 00:00 UTC.」 | 同上 |
| 静的アセット | 「Requests to static assets are free and unlimited.」 | https://developers.cloudflare.com/workers/platform/pricing/ |
| カードの登録 | **未確認** | |

- **費用が出うる場面**: Free のままなら請求は出ず、超えた分が **エラーで止まる**（課金ではなく停止）。Paid に上げる操作をしない限り費用は出ない、と読める（Free のまま自動で課金に移る記載は無い、**未確認**）。
- **使用量の見込み（見積もり）**: 1 店の編集者 1〜3 人なら、サインイン・1 時間ごとの token の取り直し・WebSocket（hibernating）で 1 日数百要求程度と見込み、100,000／日に遠い。**未検証**（試験で Cloudflare のダッシュボードの数字を記録する）。
- **注意**: CPU 10 ms はサーバー側のハッシュを 1 回の SHA-256 にした理由そのもの。将来の版で処理が重くなると 1102 が出うる（**未確認**）。
- 内容の保存は GitHub、公開は Cloudflare Pages の無料枠に依存する（これは案 A と同じ）。

## 4. 安全

### 4.1 秘密の置き場所

| 秘密 | 置き場所 | 出典 |
|---|---|---|
| `ADMIN_SECRET` | Worker の secret（Deploy ボタンが聞く、CLI なら `wrangler secret put ADMIN_SECRET`）。「secret values are not visible within Wrangler or Cloudflare dashboard after you define them.」 | https://sveltiacms.app/en/docs/additions/setup 、https://developers.cloudflare.com/workers/configuration/secrets/ |
| GitHub App の private key・client secret | Durable Object の DB に暗号化して保存。「Secret values, such as the GitHub App's private key, are write-only」「Every setting lives in the service's database, not in the CMS configuration or in Cloudflare.」 | https://sveltiacms.app/en/docs/additions/administration |
| GitHub の installation token | DB に暗号化して保存、ブラウザにも渡る（1 時間） | `lib/core/git-tokens.js` |
| セッションの token | ブラウザ（保存の場所は **未確認**、localStorage と推定） | |

- GitHub の注意: 「Private keys do not expire and instead need to be manually revoked.」「The private key is the single most valuable secret for a GitHub App.」（https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps）。Additions の作りでは private key は Worker の DB の外に出ない（取り出す画面は無い、write-only）。

### 4.2 公開の Worker の URL の攻撃面

- **パスワードの推測**: 上の回数の制限（IP 30 回・ID 10 回／10 分）。2FA が無いので、パスワードの強さと使い回しの無さが頼り。12 文字以上で、管理者が乱数で作って渡す運用にする（推奨）。
- **admin secret の推測**: 全体での制限あり。32 文字の乱数なら推測は現実的でない。
- **CORS・CSRF**: 許可したドメイン以外の Origin は「refused outright」（HTTP 403 `origin_not_allowed`）。セッションは Cookie ではなく bearer なので、他のサイトから「乗っ取って送る」ための資格情報がブラウザに自動で付かない（https://github.com/sveltia/sveltia-cms-additions/blob/main/lib/core/http/cors.js）。Origin が無い要求（curl など）は通るが、通常の認証を受ける。許可ドメインは HTTPS のみ、ワイルドカードは `*.` + 2 段以上（`lib/core/allowed-domains.js`）。**`*.pages.dev` のような誰でも取れるドメインを許可しない**（setup の頁も「careful allowed domains」）。
- **XSS**: Worker が返す HTML は版番号を escape した根の頁だけ（`lib/core/app.js`）。本当の危険は **CMS の頁（`/admin/`）での XSS** で、そこで token とセッションが盗まれうる。対策は今の `admin/index.html` の **CSP と SRI**（Sveltia 本体の固定）。Additions を使うなら CSP の `connect-src` に `https://<worker>` と `wss://<worker>` を足す（setup の頁）。HEIC の変換器は版が固定されず SRI も付かない（PoC の文書の注意のまま）。
- **Worker の更新の供給網**: Worker のコードは npm の `@sveltia/cms-additions`。Dependabot の PR をマージすると即 Deploy される。Sveltia は npm の provenance・「Newer releases are immutable」を挙げる（https://sveltiacms.app/en/docs/security）。マージの前に release notes を読む運用にする。
- **repo の保護**: setup の頁は、force push と削除を止める ruleset（App を bypass に入れない）、Deploy の秘密を environment secrets に移すことを勧める。editor が `build.mjs` 等を書き換えられる点（§1.3）は、構築の検査（設定ファイルの差分で止まる仕組み）で一部を受け止める。

### 4.3 取り消し

- 1 人: Additions の管理画面で無効化・降格 → その人の GitHub token が即取り消される。
- 全部: GitHub で App を Suspend または Uninstall（「Suspend」は「temporarily block it from accessing resources」、https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps）。最悪でも配った token は 1 時間で切れる。
- private key の漏えいを疑うとき: App の設定で新しい key を作り、古い key を消す（「you must regenerate a new key before you can delete the existing key.」）。Additions には key を入れ替える操作がある（監査の動作名 `github.private_key_replace`、手順の文書は **未確認**）。

### 4.4 案 A（ブラウザの localStorage の fine-grained token）との比較

| 観点 | A. fine-grained token | B. Additions |
|---|---|---|
| ブラウザにある GitHub の資格情報 | 個人の token。期限は作る人が選ぶ（「Infinite lifetimes are allowed」、組織の方針で制限可。https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens） | installation token、**1 時間** |
| 範囲 | 選んだ repo・Contents R/W（作る人次第で広くもなる） | 1 つの repo、役割で R か W。workflows・secrets 等は求めない |
| 盗まれたとき | 期限まで有効、持ち主が気づいて消すまで | 最長 1 時間 + セッション（最長 7 日、管理者がサインアウトさせれば即無効） |
| 顧客に要るもの | GitHub のアカウントと token の作成・貼り付け | ID とパスワードだけ |
| 2FA | GitHub のアカウント側で可（token そのものには効かない） | 無し（予定） |
| 増える運用 | token の期限切れの作り直し | Worker の更新・利用者の管理・`ADMIN_SECRET` の保管 |
| 誰の名義で commit されるか | token の持ち主 | App（作者のメールは利用者の設定、users の頁）。細部は **未検証** |

→ 安全の面では B が A より良い。A は試験とオーナー自身の作業に限る（PoC の文書の通り）。

## 5. Second Root が抜けた後

### 5.1 動き続けるか

- MIT、顧客の Cloudflare と GitHub で動くので、Second Root が居なくても止まらない（技術）。
- **更新**: 「Dependabot opens a pull request in your copy of the repository when a new version is released. Merge it, and Workers Builds deploys the update.」（setup の頁）。テンプレートの `.github/dependabot.yml` は `@sveltia/cms-additions` と `wrangler` だけを週 1 で提案し、コメント「Nothing is updated without review.」。→ **マージする人が要る**。店のオーナーに GitHub の PR のマージは難しいと見込む（見積もり）。
- 管理画面に新しい版の通知が出る（「the page shows a notice with a link to the release notes.」、administration の頁）。
- 「Don't change `wrangler.jsonc` unless the release notes ask you to.」（setup の頁）。release notes が手作業を求める版では、技術者が要る。
- 「Within a major version, an update only adds to the database, so going back to the previous release keeps working.」（repo の `docs/setup.md`）。

### 5.2 誰も保守しないと何が壊れるか（見込み、未検証）

- すぐには壊れない（Worker は固定の版で動き続ける）。
- 壊れうるもの: GitHub の API・token の形式の変更（例: 2026-04-27 から installation token の形式が `ghs_APPID_JWT` に段階的に変わった、と GitHub の文書）、Cloudflare の compatibility date・Free の条件の変更、Sveltia CMS 本体（版を固定した場合）と Additions の組み合わせ、見つかった脆弱性の放置。
- 本体を版の固定なしで読み込めば本体は自動で新しくなるが、Additions を更新しないと組み合わせがずれうる（**未確認**）。

### 5.3 Sveltia の更新の方針と Second Root の方針

- 公式: 「As long as you use the CDN script without pinning to a specific version, there is no maintenance overhead」、正確な版の固定は「discouraged ... for long-term use」、`@sveltia/cms@^5`（major の固定）は可（https://sveltiacms.app/en/docs/releases）。
- 一方 repo の setup の checklist（`docs/setup.md` の 7）は「Pin the version of Sveltia CMS your site loads, and add a Content Security Policy to the CMS page.」。サイトの同じ checklist は CSP だけ。**公式の中で食い違う**（どちらが新しいかは未確認）。
- SRI については公式に記載なし（**未確認**）。
- Second Root の今の方針（正確な版 + SRI）は、CMS の頁が書き込みの token を持つので安全の面で筋が通るが、**更新しないと古い版のまま残る**＝保守が要る。`^5` の範囲指定では SRI を付けられない（中身が変わるため）。
- 選択肢（技術）: ① 正確な版 + SRI（今、保守が要る） ② `^5` + SRI なし + 厳しい CSP（保守が減る、供給網の危険を受け入れる） ③ 本体のファイルを店の repo に置いて自分で配る（SRI 不要・外への読み込みなし、更新は手作業）。決めるのはオーナー。

### 5.4 引き渡しの手順（案）

最初から顧客の口座に作る場合（推奨、技術）:
1. 顧客の GitHub Organization（持ち主は顧客）と Cloudflare アカウント（持ち主は顧客）を作ってもらい、Second Root は最小の権限のメンバーとして入る。
2. 顧客の口座で Deploy ボタン → Worker と Durable Object と小さな repo が顧客の側にできる。
3. 引き渡し: `ADMIN_SECRET` と admin のパスワードを顧客に渡し（または顧客の前で作り直し）、Second Root を各口座から外す。Second Root 側の写しを消す。

Second Root の口座で作ってしまった場合:
- GitHub の repo・Organization の移管、App の登録の移管（上の GitHub の文書）はできる。
- **Cloudflare の Worker と Durable Object を別のアカウントに移す方法は未確認**、データの書き出しの機能も無い（`docs/portability.md` は「Out of scope: ... moving data between platforms.」）。→ 顧客の口座で **作り直し**（Deploy・ウィザード・利用者の作り直し・App の再インストール）になる。repo の持ち主が変わったら「Install the app for the new owner, with the repository selected, then run the setup wizard again」（setup の頁）。
- Durable Object の消し方は **未確認**（PoC の文書と同じ）。

## 6. Second Root の保守の負担（1 店あたり）

| 作業 | 頻度（見積もり） | 1 回の時間（見積もり） |
|---|---|---|
| Sveltia 本体の版の更新（`admin/index.html` の版と SRI の計算・CSP の確認・ローカルの起動の確認・ZIP） | 年 4〜12 回（5.x は出たばかりで頻繁と見込む） | 15〜45 分（店が増えれば生成の仕組みで一括） |
| Additions の Dependabot の PR（release notes を読みマージ、ログインの確認） | 年 4〜12 回（版の出方は未確認、Releases は空） | 10〜30 分 |
| 利用者の追加・パスワードの再設定の依頼（顧客の admin が自分でできない場合） | 年 0〜6 回 | 10〜20 分 |
| 手作業を求める版・Cloudflare や GitHub の変更への対応 | 年 0〜2 回 | 1〜4 時間 |

**合計の見積もり: 1 店あたり年 およそ 3〜20 時間**（中央は 6〜10 時間程度と見込む）。**見積もりで、実績は無い**。
- 店の数が増えると、本体の版の更新は生成の仕組みで一括でき、1 店あたりは下がる。Additions の PR は店ごとの repo に別々に来る（一括の仕組みは未設計）。
- 顧客が自分で Dependabot の PR をマージできるなら Additions の分は顧客に移る。

## 7. 試験の手順（オーナー、承認の後）

前提: 架空の店・**試験専用の GitHub Organization と Cloudflare アカウント**（本物の店の名前は使わない）。

1. GitHub と Cloudflare の両方で 2FA を有効にする。
2. `ADMIN_SECRET` を作る（`openssl rand -base64 32`、32 文字以上）。パスワード管理に保存。
3. setup の頁の Deploy ボタンで Worker を作る（小さな repo が GitHub に写される）。Workers & Pages → Worker → Domains で `workers.dev` の Production を有効にし、URL を Second Root に伝える。
4. Second Root が作った更新の ZIP（`admin/config.yml` に `auth_type: additions` と `base_url`、CSP に Worker の `https://`・`wss://`）を試験用 repo に上げる。
5. `/admin/` → 「Use Admin Secret」でウィザード: 最初の admin を作る、許可ドメインに試験用の `*.pages.dev` の **そのサイトのホスト名だけ** を入れる、GitHub App を作り **Only select repositories = 試験用 repo だけ** で入れる。インストール画面の権限を撮影（§1.3 と照合）。
6. editor の利用者を 1 人作り、iPhone の Safari でその ID・パスワードで入る。施工実績を 1 件、写真（HEIC と 5 MB 超の JPEG）つきで保存（PoC の文書 §4 の記録をそのまま）。
7. 追加で記録: commit の作者、Cloudflare の Worker と DO の使用量（1 日）、viewer で保存できないこと、利用者の無効化で token が切れること、ブラウザの保存場所（セッションの token）。
8. 後片付け: PoC の文書 §5 の B の手順。

Claude がローカルで準備できるもの: `admin/config.yml` の Additions 版の生成（`--sveltia-additions-url`）、CSP の追加、記録の表のひな形、ソースの権限一覧と画面の照合表、`ADMIN_SECRET` を作るコマンドの案内。**Claude はサインイン・Deploy・App のインストールをしない**。

## 8. 商用の提供について（技術とは別）

- 決まっていないこと（オーナーの判断）:
  - 正式の納品方法にするか（成熟度: Additions 1.0.0・Releases 空、本体は安定版 2 日目）。
  - 引き渡しの後の Worker の更新を誰が行うか（顧客／Second Root の有償の保守／しない）。
  - `ADMIN_SECRET` と管理者の復旧の責任。
  - 2FA が無いことを顧客にどう説明するか。
- Additions は「a free, open-source service」「MIT-licensed, with no subscription and no usage fees of its own.」（https://sveltiacms.app/en/docs/additions）。運営者の規約の問題は無いが、Cloudflare と GitHub の無料枠・規約に依存する。
- **約束しないこと**: 無料が続くこと、2FA などの今後の機能・時期、iPhone での動き（実機の試験の前）、Second Root が居なくても保守なしで動き続けること。

## 9. 未確認の一覧

- Workers Free にカードの登録が要るか。日の上限で workers.dev が fail open か closed か。
- 監査の記録を見る画面と保存期間。
- PBKDF2 の salt と内部のハッシュ関数。セッションの token のブラウザでの保存場所。
- データの書き出し、別の Cloudflare アカウントへの移行、Durable Object の消し方。
- 1 つの Worker で複数サイトを扱う作りの公式の説明。
- Additions の版の出方（Releases が空）、正式に stable か beta か。
- Sveltia の「版を固定する」かの公式の食い違いの新旧。SRI への公式の見解。
- private key の入れ替えの手順の文書。
