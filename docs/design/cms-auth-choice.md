# CMS のサインイン方式の選択（Issue #380）: Additions か「Sign In with GitHub」か

2026-11-28。状態: **調べだけ**。サインイン・アカウント作成・Deploy・送信・公開の変更は何もしていない。
対象: 架空の車の店の試験サイト（GitHub の Organization の repo + Cloudflare Pages、Sveltia CMS 5.0.3、GitHub backend）。
オーナーは「顧客が token を作って貼る」サインインを不可とした。残る 2 案を、オーナーの必須条件で比べる。

- **案 1. Sveltia CMS Additions**: ID とパスワードで入る。Cloudflare Worker + Durable Object（SQLite）+ サイト専用の GitHub App。詳細は [`cms-sveltia-additions-evaluation.md`](cms-sveltia-additions-evaluation.md)（以下「評価書」）。
- **案 2. 通常の「Sign In with GitHub」**: OAuth のクライアント（公式の Sveltia CMS Authenticator を Cloudflare Workers に置く）+ 顧客の **自分の GitHub アカウント**（repo への書き込み権限つき）。

出典は公式の頁か一次の資料で、**アクセス日はすべて 2026-11-28**。引用は原文のまま（長いものは一部）。
資料に書かれていないものは **未確認**、資料にはあるが実機で確かめていないものは **未検証**、Second Root の見積もりは **見積もり** と書く。
「技術的にできるか」と「商用で提供できるか」（§7）は分ける。**顧客への約束は書かない**。

## 0. 結論（先に）

- **推奨（技術）: 案 1（Additions）を第一候補として iPhone の実機で試験する。** 案 2 は「スマートフォンだけで簡単に始められる」を満たしにくい（GitHub のアカウント作成・2FA の設定・2FA を失うと復旧できないことがある）ため、顧客向けの既定にはしない。
- 案 1 が勝つ点: 顧客は GitHub のアカウント不要、ID とパスワードだけ、token は 1 時間・1 repo・役割で制限。
- 案 1 が負ける点: **2FA・パスキーが無い**（予定）、**パスワードの再設定は管理者の手作業**（メールは送らない）、**成熟度**（npm 1.0.2、2026-11-22 公開）。
- 案 2 が勝つ点: GitHub の 2FA・パスキーが使える、パスワードはメールで自分で再設定できる、Authenticator は小さく保守が軽い。
- 案 2 で必ず守ること（もし採るなら）: Authenticator は **GitHub App** で登録する（今の README の方式）。**古い OAuth App で登録すると、既定の scope が `repo,user` になり、本人が触れる全ての repo に書き込める token になる**（§3.2）。
- どちらも **月額 0 円で動く設計**（Workers Free）。ただし Free の継続・規約は Cloudflare と GitHub の裁量（§7）。
- 残る最大の危険: 案 1 の成熟度と 2FA 無し、店の admin が自分のパスワードと `ADMIN_SECRET` の両方を失う場合。案 2 の 2FA 喪失によるアカウントの永久喪失。

## 1. 必須条件ごとの採点

記号: ○ 満たす、△ 条件つき・一部、× 満たさない、? 未確認が大きい。

| 必須条件 | 案 1. Additions | 案 2. Sign In with GitHub |
|---|---|---|
| スマートフォンだけで簡単に入れる（初回の準備を含む） | ○ ID とパスワードをフォームに入れるだけ（§2.1）。ポップアップを使わない（**未検証**） | △ GitHub のアカウント作成・メールの確認・（多くの場合）2FA の設定が要る。CMS の OAuth はポップアップ（§5） |
| token を手で発行しない | ○ | ○（Authenticator が OAuth で発行） |
| 月額 0 円 | ○ Workers Free・SQLite の DO は Free で可（§6） | ○ Workers Free（§6） |
| 商用で使える | ○ MIT（運営者の利用料なし）。GitHub・Cloudflare の規約の扱いは §7 | ○ MIT。同上 |
| 顧客の名義で運用できる | △ 顧客の Cloudflare と GitHub（App の持ち主）に作る。編集者は GitHub 不要だが、**店の持ち主は GitHub と Cloudflare のアカウントを持つ必要がある** | ○ 顧客の Organization・顧客の Cloudflare・編集者それぞれの GitHub アカウント |
| Second Root の保守が少ない | △ Dependabot の PR のマージ、利用者の管理、`ADMIN_SECRET`。見積もり 1 店 年 3〜20 時間（評価書 §6） | ○ Worker は小さい（「just a small, short-lived script」）。App の client secret の管理 |
| 安全な認証と権限の制御 | △ token 1 時間・1 repo・役割（admin/editor/viewer）。**2FA 無し** | ○（GitHub App の場合）token 8 時間・App を入れた repo だけ・本人の 2FA。役割は GitHub の repo 権限（Free の Organization は固定の役割だけ）。× OAuth App の場合（`repo` scope で全 repo） |
| パスワードを忘れたときに簡単に戻せる | △ 管理者が仮パスワードを発行（メールなし）。admin が忘れたら `ADMIN_SECRET` でウィザード | ○ パスワードはメールで自分で再設定。× ただし **2FA の手段を全て失うと、GitHub Support でも戻せず永久に失う**ことがある |

**読み**: 「スマートフォンだけで簡単」と「token を作らない」を同時に、顧客に GitHub の知識なしで満たすのは案 1 だけ。安全（2FA）と自己復旧は案 2 が上。どちらも全条件を満たすわけではない。オーナーの条件の中で「簡単さ」が最優先と読み、案 1 を推奨とする。「2FA 必須」を譲れない条件にするなら案 2（GitHub App 版）になる。

## 2. 案 1. Additions（評価書の要点と、本書での追加）

### 2.1 サインインと初回

- 「sign-in with a username and password, so people don't need a GitHub account」（https://sveltiacms.app/en/docs/additions）
- 利用者は管理者が作る。「Sveltia CMS Additions never sends email itself, so there are no automatic invitations or password reset emails」（https://sveltiacms.app/en/docs/additions/users）。管理者は「Email to」で自分のメールアプリに下書きを作れる（同上）。
- 「Passwords must have at least 12 characters.」「Repeated failed sign-ins are rate limited.」（同上）
- セッション: 「Sessions end after a day without use, and after 7 days in any case.」（同上）→ スマートフォンでは **1 日使わないと入り直し**。パスワード管理（iOS のパスワード）に保存すれば負担は小さい（**未検証**）。
- 「For now, people can only sign in with a username and password, or with GitHub. Other identity providers are planned.」（https://sveltiacms.app/en/docs/additions）

### 2.2 権限

- 「a short-lived GitHub token limited to your site's repository and to what their role allows.」「the CMS gets a new GitHub token from the service about once an hour.」（https://sveltiacms.app/en/docs/additions）
- 「The role is enforced by GitHub as well as by the CMS: the token a viewer gets can only read the repository」（https://sveltiacms.app/en/docs/additions/users）
- 「GitHub tokens can't be limited to certain files or branches, so roles apply to the whole repository.」（https://sveltiacms.app/en/docs/additions）
- 降格・無効化・サインアウトで「revokes their GitHub tokens on GitHub's side right away」（同上）。

### 2.3 2FA と復旧

- 2FA・パスキー: Planned Features に「Passkeys and two-factor authentication」（https://sveltiacms.app/en/docs/additions）。**今は無い**。
- 再設定: 「Reset Password」が「gives the user a new temporary password and signs them out everywhere」（https://sveltiacms.app/en/docs/additions/users）。
- admin が忘れた: 「open the wizard with the admin secret, and reset the password of an admin or create a new admin.」（https://sveltiacms.app/en/docs/additions/setup）
- `ADMIN_SECRET` も失った: Cloudflare で新しい値を設定し「Start Over」。パスワードは残るが全員サインアウト、GitHub App の private key を入れ直す（setup の頁、取得した agent の要約による。手順の細部は **未検証**）。
- 運用の工夫（推奨、技術）: 店の中に **admin を 2 人**置き、互いに再設定できるようにする。`ADMIN_SECRET` は店の持ち主がパスワード管理か紙で保管する。

### 2.4 Second Root が用意するもの

評価書 §5.4・§7 の通り。要点:
1. 顧客の GitHub Organization と Cloudflare アカウント（持ち主は顧客。Second Root は最小権限のメンバー）。
2. 顧客の Cloudflare で Deploy ボタン（Worker・Durable Object・小さな repo）、`ADMIN_SECRET`（32 文字以上）。
3. ウィザード: 最初の admin、許可ドメイン（そのサイトのホスト名だけ）、GitHub App（Only select repositories = サイトの repo だけ）。
4. `admin/config.yml` に `auth_type: additions` と `base_url`、CSP の `connect-src` に Worker の `https://`・`wss://`。
5. 保守: Dependabot の PR（`@sveltia/cms-additions`・`wrangler`）を誰がマージするか決める。

## 3. 案 2. Sign In with GitHub（Sveltia CMS Authenticator）

### 3.1 仕組みと位置づけ

- 「Authorization code flow ... requires you to register a GitHub App or an OAuth app on GitHub and deploy an OAuth client server」（https://sveltiacms.app/en/docs/backends/github）。クライアントの選択肢は Sveltia CMS Authenticator・Decap 用の他のクライアント・Netlify。
- 何も設定しないと Netlify が既定（`base_url` の既定は `https://api.netlify.com`、`auth_endpoint` は `auth`。https://sveltiacms.app/en/docs/backends ）。Netlify を使わないので、Authenticator を置いて `base_url` をその URL にする。
- PKCE（サーバーなし）は「Unimplemented」「We're waiting for GitHub to support client-side PKCE authentication for single-page apps.」（https://sveltiacms.app/en/docs/backends/github）→ **OAuth のクライアントのサーバーは必須**。
- Authenticator の README: 「**In most cases, you don't need this authenticator**」「**We now recommend Sveltia CMS Additions instead.**」「remains available for those who only need GitHub sign-in.」「the authenticator is not offered as SaaS and you have to install it yourself.」（https://github.com/sveltia/sveltia-cms-auth）
- 作者自身が Additions を勧めている点は、案 2 の将来の保守の優先度が下がりうる兆し（読み、**未確認**）。

### 3.2 GitHub App か OAuth App か（重要）

- 今の README は **GitHub App** で登録する手順（「An OAuth app still works with this authenticator, but it's no longer documented here.」）。
- GitHub App の場合:
  - 「It works with a GitHub App, which only gets access to the repositories it's installed on」（https://sveltiacms.app/en/docs/backends/github）
  - 「a user access token expires after 8 hours, and Sveltia CMS refreshes it automatically ... refresh token, which is valid for 6 months.」（README）
  - 「The `auth_scope` backend option in Sveltia CMS has no effect with a GitHub App」（README）。コードのコメント「A GitHub App ignores the `scope` parameter」（https://github.com/sveltia/sveltia-cms-auth/blob/main/src/index.js）
  - 「GitHub Apps aren't subject to organization application policies.」（https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps）
  - 制限: 「Open Authoring isn't supported with a GitHub App.」（店の運用では使わない）
- OAuth App の場合（**採らない**）:
  - Authenticator のコードの既定: `GITHUB_SCOPES = { default: 'repo,user', allowed: ['repo', 'public_repo', 'user', 'read:user', 'user:email'] }`（src/index.js）。
  - GitHub: `repo` は「Grants full access to public and private repositories including read and write access to code, commit statuses, repository invitations, collaborators, deployment statuses, and repository webhooks.」（https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps）
  - 「An *authorized* OAuth app has access to all of the user's or organization owner's accessible resources.」「OAuth apps can't use granular permissions.」（differences の頁）
  - 「OAuth app tokens re long-lived by default.」（原文の誤字のまま、同上）。使われない token は「hasn't been used in one year」で自動の取り消し（https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation）。
  - 新しい Organization では「OAuth app access restrictions are enabled by default」、承認のない OAuth App は「API access to private organization resources is not available」（https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions）→ Organization の持ち主の承認作業が増える。
  - → **問いへの答え**: OAuth App で入ると Sveltia（Authenticator）は既定で `repo,user` を求め、`repo` は本人が触れる **全ての** public・private repo（と組織の一部の資源）に及ぶ。GitHub App ならこの問題は無い。

### 3.3 顧客の GitHub アカウントと 2FA

- 規約: 「a human must create your Account; you must be 13 or over; you must provide a valid email address; and you may not have more than one free Account.」「Your login may only be used by one person」（https://docs.github.com/en/site-policy/github-terms/github-terms-of-service）→ **編集者 1 人に 1 アカウント**。店で共有のアカウントは不可。
- スマートフォンでのアカウント作成: GitHub Mobile の頁は既存のアカウントでのサインインだけを書き、**アプリでの作成は未確認**。スマートフォンのブラウザで github.com から作れるかも **未確認**（文書に記載なし。実機の試験で確かめる）。
- GitHub Mobile の Google・Apple でのサインインは、そのアカウントを「originally created ... using the respective social login provider」の場合だけ（https://docs.github.com/en/get-started/using-github/github-mobile）。
- **2FA の義務**:
  - 「As of March 2023, GitHub required all users who contribute code on GitHub.com to enable one or more forms of two-factor authentication (2FA).」選ばれる条件は「taken some action on GitHub that shows you are a contributor」（https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/about-mandatory-two-factor-authentication）
  - 列挙された条件に「Being an organization owner for an organization containing repositories or other users」がある → **店の持ち主が Organization の owner なら対象になりうる**。
  - CMS（API）経由の commit だけの編集者が対象になるかは **未確認**（列挙は release の作成・重要な repo への貢献などで、API の commit への言及なし）。「these criteria may change over time.」
  - 対象になると 45 日の登録期間 + 7 日の猶予の後「you will not be able to access GitHub.com until you enable 2FA.」
  - Organization の設定で 2FA を必須にできる（「require organization members, outside collaborators, and billing managers to enable two-factor authentication」、https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization）。Free で使えるかの記載は無い（**未確認**。plans の頁は個人の Free に「Two-factor authentication enforcement」と書く）。
- **2FA の方法とスマートフォン**:
  - 最初の方法は TOTP のアプリか SMS: 「You can configure two-factor authentication (2FA) using a TOTP app on mobile or desktop or via text message.」パスキー・セキュリティキー・GitHub Mobile は「You must have already configured 2FA via a TOTP mobile app or via SMS.」（https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/configuring-two-factor-authentication）
  - 「we don't support passkeys or security keys as primary 2FA methods」（mandatory 2FA の頁）
  - SMS は「not supported in all countries」。日本の SMS の可否は **未確認**。
  - パスキーを足せば「passkeys satisfy both password and 2FA requirements, so you can complete your sign in with a single step.」（https://docs.github.com/en/authentication/authenticating-with-a-passkey/about-passkeys）→ **設定後のサインインは簡単になりうる**が、設定の手順（TOTP のアプリを入れ、QR を読む…を 1 台のスマートフォンで）は店の人には難しいと見込む（見積もり）。

### 3.4 復旧

- パスワード: 「Enter the email address associated with your account, then click Send password reset email.」「You must click on this link within 3 hours」。2FA があればその確認も求められる（https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/updating-your-github-access-credentials）。パスキーでも再設定できる（about-passkeys の頁）。
- 2FA を失った: 「GitHub Support will not be able to restore access to accounts with two-factor authentication enabled if you lose your two-factor authentication credentials...」「If you cannot use any recovery methods, you have permanently lost access to your account.」審査は「within three business days」、「If your request is denied」もある（https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/recovering-your-account-if-you-lose-your-2fa-credentials）
- → 機種変更・端末の紛失で TOTP と recovery codes を失うと、**店の人のアカウントが戻らない**ことがある。その場合は新しいアカウントを作り、Organization の持ち主が repo に招き直す（持ち主自身なら Organization の扱いが重くなる、**未確認**）。

### 3.5 権限（Organization 側）

- repo の役割: Read・Triage・Moderate・Write・Maintain・Admin。「Write: Recommended for contributors who actively push to your project」。独自の役割は「If your organization uses GitHub Enterprise Cloud」だけ（https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization）。
- 編集者は Write を外部コラボレーターとして付けるのが最小（推奨、技術）。「Unless you are on a free plan, adding an outside collaborator to a private repository will use one of your paid licenses.」→ Free の Organization では費用なし（https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-outside-collaborators/adding-outside-collaborators-to-repositories-in-your-organization）。
- 注意: Write の人は GitHub の画面からも repo を直接触れる（CMS の外）。案 1 の editor も repo 全体に書ける点は同じ（token の範囲）だが、案 1 の人は GitHub の画面に入れない。
- Free の Organization の private repo では「Protected branches」等が使えない（https://docs.github.com/en/get-started/learning-about-github/githubs-plans、Team の機能として列挙）。ruleset の可否は **未確認**。

### 3.6 Second Root が用意するもの

1. 顧客の Organization（持ち主は顧客）。
2. 顧客の Cloudflare で Authenticator を Deploy（Deploy ボタンか `wrangler deploy`）。URL は `https://sveltia-cms-auth.<SUBDOMAIN>.workers.dev`。
3. GitHub App を登録（持ち主は顧客の Organization）: Redirect URI `<WORKER_URL>/callback`、「Expire user authorization tokens: Checked」、Contents R/W・Metadata R・Pull requests R/W、Workflows なし、Webhook 無効、client secret を作成、Only select repositories でサイトの repo だけに入れる（README）。
4. Worker の環境変数: `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`（Secret）、`ALLOWED_DOMAINS`（「setting it is strongly recommended.」サイトのホスト名だけ）、`GITHUB_HOSTNAME` は不要（既定 `github.com`）、`GITHUB_ALLOW_WORKFLOW_SCOPE` は設定しない。
5. `admin/config.yml` の `backend` に `base_url: <WORKER_URL>`、`auth_methods: [oauth]`（token のボタンを消す。https://sveltiacms.app/en/docs/backends ）。CSP の調整（**未検証**）。
6. 編集者ごとに: GitHub アカウントの作成の案内、Organization への招待（Write）、2FA の設定の案内。**ここが店ごと・人ごとに繰り返す手間**。
- 保守: Authenticator の更新（頻度は **未確認**）、client secret の入れ替え（期限の有無は **未確認**）。

## 4. 安全の比較

| 観点 | 案 1. Additions | 案 2. GitHub App + Authenticator | 参考: 案 2 を OAuth App で |
|---|---|---|---|
| ブラウザの GitHub token | installation token、1 時間 | user access token、8 時間（refresh token 6 か月） | 長命（既定）、1 年使わないと取り消し |
| 範囲 | サイトの repo 1 つ、役割で R/W | App を入れた repo ∩ 本人の権限 | 本人が触れる全 repo（`repo`）+ `user` |
| 2FA | 無し（予定） | GitHub の 2FA・パスキー | 同左 |
| 取り消し | 管理画面で即 | App の Suspend・本人の認可の取り消し・repo から外す | Organization の承認の取り消し等 |
| 盗まれたときの最長 | token 1 時間 + セッション（最長 7 日） | token 8 時間 + refresh token（最長 6 か月、取り消すまで） | 取り消すまで |

- refresh token のブラウザでの保存場所は **未確認**（localStorage と推定）。CMS の頁の XSS で盗まれると、案 2 は最長 6 か月更新され続けうる（読み）。案 1 はセッションの token（最長 7 日）。
- 案 1 のパスワードの推測には回数の制限（評価書 §1.2）があるが、2FA が無いのでパスワードの強さ頼み。管理者が乱数で作って渡す運用にする。

## 5. iOS（Safari・Brave）での動き

- 案 2 の OAuth は **ポップアップ**: Authenticator のコードは `window.opener?.postMessage(...)`（コメント「who opened this popup」、src/index.js）。Sveltia の troubleshooting も COOP が「known to break the OAuth flow with a popup window」と書く（https://sveltiacms.app/en/docs/troubleshooting）。リダイレクトの方式は **記載なし**。
- 既知の問題: Issue #835「Gitlab signing stuck with Safari on iOS」。作者「I can confirm the issue with Safari on macOS, which is blocking the authentication popup window.」、commit「Pre-open auth popup for Safari compatibility」、「Fixed in v0.172.1」、報告者「I can confirm that the issue is fixed and I can login on iOS now.」（https://github.com/sveltia/sveltia-cms/issues/835 、2026-07-19 closed）。GitLab での報告だが、ポップアップの開き方は共通と読める（GitHub での iOS の確認は **未確認**）。
- PR #700「fall back to redirect when OAuth popup is blocked on mobile」は不採用（「no one has reported the issue.」、https://github.com/sveltia/sveltia-cms/pull/700 、2026-03-28 closed）。→ ポップアップが塞がれた時の逃げ道は無い。
- MDN: 「Popup windows must be opened in direct response to user input」、塞がれると `null`（https://developer.mozilla.org/en-US/docs/Web/API/Window/open）。iOS Safari での新しいタブとしての開き方・`window.opener` の扱いは **記載なし**。
- **Brave（iOS）のポップアップの既定**: **未確認**（一次の資料を取得していない）。
- 案 2 ではさらに、ポップアップの中で **github.com へのサインイン（パスワード + 2FA）** が要る。ブラウザが github.com のセッションを持っていなければ毎回（8 時間の token と refresh で頻度は下がる）。
- 案 1 は CMS の頁の中のフォームで、文書上ポップアップの記載は無い（**未検証**）。WebSocket（`wss://`）を使う（評価書 §4.2）。iOS のバックグラウンドでの切断の影響は **未確認**。
- → どちらも **iPhone の Safari と Brave の実機で試す**まで「動く」とは言わない。

## 6. 費用（月額 0 円か）

| 項目 | 内容 | 出典 |
|---|---|---|
| Workers Free | 「100,000 per day」「10 milliseconds of CPU time per invocation」「No charge for duration」「By default, users have access to the Workers Free plan.」 | https://developers.cloudflare.com/workers/platform/pricing/ |
| 超えたとき | 「Cloudflare returns Error 1027」（日の上限）、CPU は Error 1102 → **課金でなく停止** | https://developers.cloudflare.com/workers/platform/limits/ |
| Durable Objects（案 1） | 「Workers Free plan: Only Durable Objects with SQLite storage backend are available.」超えると「further operations of that type will fail with an error.」 | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Pages Free | 月 500 builds、1 build ずつ、100 projects／アカウント、20,000 files | https://developers.cloudflare.com/pages/platform/limits/ |
| カード | 有料の Service に要る（「In order to access those Services for which we require a fee ... credit card information」）。Free にカードが要らないとは明記なし（**未確認**） | https://www.cloudflare.com/terms/ §4.1 |
| GitHub Free の Organization | 「unlimited private repositories with a limited feature set」、外部コラボレーターは Free なら席を使わない | https://docs.github.com/en/get-started/learning-about-github/githubs-plans |

- 費用が出うる場面: 顧客か誰かが Workers Paid（「a minimum charge of $5 USD per month」）や GitHub の有料プランに上げたとき。Free のままの自動課金の記載は無い（**未確認**）。
- 使用量: 案 2 の Authenticator はサインインと refresh のときだけ動く。案 1 は 1 時間ごとの token と WebSocket。どちらも 1 店なら上限に遠いと見込む（見積もり、**未検証**）。

## 7. 商用の提供について（技術とは別）

- ライセンス: Sveltia CMS は「MIT License」（https://github.com/sveltia/sveltia-cms/blob/main/LICENSE.txt）、Authenticator は MIT（repo の表示）、Additions は「MIT-licensed, with no subscription and no usage fees of its own.」。MIT は「use, copy, modify, merge, publish, distribute, sublicense, and/or sell」を許す。
- Cloudflare（Self-Serve Subscription Agreement、Last Updated September 12, 2025、https://www.cloudflare.com/terms/）:
  - Free を非商用に限る条項は **見当たらない**。
  - §2.2.1(a) 「sign up for the Services on behalf of a third party」の禁止 → **顧客自身が自分の Cloudflare アカウントを作る**のが筋（Second Root が顧客の代わりに登録しない）。両案とも同じ。
  - §2.2.1(h) Free の Service を受ける web の資産でカード情報を扱わない（店のサイトで決済をしない限り関係なし）。
  - §2.6 Free は「termination of the Free Service by Cloudflare in our sole discretion」、「We will have no liability ... in connection with any Free Services.」
  - Service-Specific Terms は **未取得**（Workers・Pages の個別条項は **未確認**）。
- GitHub（Terms of Service、2026-04-27 施行）:
  - Free のアカウントを業務に使うことの許可・禁止の明記は **見当たらない（未確認）**。法人として同意する場合は追加の情報が要る（「unless you are accepting these terms on behalf of a legal entity」）。
  - 「One person or legal entity may maintain no more than one free Account」「Your login may only be used by one person」→ 案 2 は人ごとのアカウント、案 1 でも店の持ち主のアカウントは共有しない。
  - Organization の owner は「we consider you responsible for the actions that are performed on or through that Organization.」→ 顧客の Organization なら責任は顧客。
  - Corporate Terms は「deprecated effective 30 November 2021」。業務の顧客は GitHub Customer Agreement（**未取得**）。
- 決まっていないこと（オーナーの判断）: 正式の納品方法にするか（案 1 の成熟度）、Worker の更新を誰がするか、`ADMIN_SECRET` と admin の復旧の責任、2FA が無いことの説明。
- **約束しないこと**: 無料が続くこと、2FA などの今後の機能・時期、iPhone での動き（実機の試験の前）、保守なしで動き続けること、GitHub の 2FA の義務の対象になるか否か。

## 8. 推奨と理由

1. **案 1（Additions）を顧客の編集者向けの第一候補**として、試験専用の Organization と Cloudflare アカウントで iPhone（Safari・Brave）の実機の試験をする（手順は評価書 §7）。
   - 理由: 「スマートフォンだけ」「token を作らない」「GitHub を知らなくてよい」を同時に満たすのは案 1 だけ。token は 1 時間・1 repo・役割で、案 2（8 時間 + 6 か月の refresh）より短い。
   - 条件: admin を 2 人、`ADMIN_SECRET` を店の持ち主が保管、パスワードは乱数 12 文字以上、GitHub でのサインインは無効のまま、Dependabot の PR のマージの担当を決める。
2. **案 2 は「2FA が必須」の顧客、または GitHub に慣れた顧客向けの代替**。採るなら **GitHub App で登録**し、OAuth App（`repo,user`）は使わない。
3. 店の持ち主（Organization と Cloudflare の owner）は、どちらの案でも GitHub と Cloudflare のアカウントが要り、GitHub では 2FA の義務の対象になりうる（「organization owner for an organization containing repositories」）。**持ち主の 2FA の設定と recovery codes の保管は両案共通の作業**として手順書に入れる。

## 9. 残る危険

- 案 1: 成熟度（npm 1.0.2、Releases が空）、2FA 無し、admin のパスワードと `ADMIN_SECRET` を両方失う場合（Start Over で App の private key の入れ替え）、Worker の更新が止まる場合、iOS で WebSocket と 1 日のセッションの体験（**未検証**）。
- 案 2: 店の人の GitHub アカウント作成と 2FA の設定の難しさ、2FA 喪失による永久喪失、iOS のポップアップ（#835 は修正済みだが GitHub での iOS は **未確認**、Brave は **未確認**、リダイレクトの逃げ道なし）、refresh token 6 か月の盗難の影響、Authenticator が作者の推奨から外れつつあること。
- 共通: Cloudflare と GitHub の Free の条件・規約の変更、Service-Specific Terms と GitHub Customer Agreement の未確認、CMS の頁の XSS（CSP と SRI で対策）。

## 10. 未確認の一覧

- スマートフォンのブラウザ・GitHub Mobile で GitHub のアカウントを作れるか。日本で SMS の 2FA が使えるか。
- CMS（API）経由の commit だけの利用者が GitHub の 2FA の義務の対象になるか。Free の Organization で 2FA の必須化が使えるか。
- 案 2 の refresh token・案 1 のセッションの token のブラウザでの保存場所。
- Authenticator の client secret の期限・入れ替えの手順、更新の頻度。
- iOS の Safari・Brave でのポップアップ（GitHub）と `window.opener`、Brave（iOS）のポップアップの既定。案 1 の iOS での WebSocket。
- Workers Free にカードが要らないこと（明記）。Cloudflare の Service-Specific Terms。GitHub Free の業務での利用（明記）、GitHub Customer Agreement。
- Free の Organization の private repo で ruleset が使えるか。
