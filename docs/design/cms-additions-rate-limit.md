# Sveltia CMS Additions: setup の「Connect to GitHub」が 403 rate limit で止まる件（DEV-380）

2026-11-28。状態: **調べだけ**。サインイン・Deploy・オーナーの Worker への要求・送信は何もしていない。
出典はすべて 2026-11-28 に読んだ。コードは `sveltia/sveltia-cms-additions` の `main`（= v1.0.2、tree `4bbfa8c`）とタグ `v1.0.1`。

## 0. 結論（先に）

- **起きたこと**: オーナーの Worker は **Additions 1.0.0** で動いている。Deploy ボタンのテンプレートが `"@sveltia/cms-additions": "1.0.0"` を**固定で**指定しているため（lockfile 無し、この指定は一度も変わっていない）。
  1.0.0 / 1.0.1 の `POST /v1/setup/github` は、App の作成ページ（個人用か Organization 用か）を選ぶために、Worker から **認証無しで `GET https://api.github.com/users/<owner>`** を必ず送る。
  GitHub は認証無しの要求を**送信元 IP ごとに 1 時間 60 回**に制限する。Worker の送信元は Cloudflare の共有 egress IP（172.64.0.0/13、今回 172.71.159.112）なので、**他の利用者の分で枠が尽きていた**。オーナーの操作回数は関係ない。
- **直し方（推奨）**: オーナーの写し `sr-cms-trial/sveltia-cms-additions` の `package.json` を **`1.0.2` に上げる**（公式の版。改造ではない）。
  1.0.2 は CMS がブラウザで調べた `owner_type` を受け取り、Worker からの問い合わせをしない（commit `64eba2f`）。
  Sveltia CMS 5.0.3 はブラウザで `/users/<owner>` を調べて `owner_type` を送る。admin の CSP は `connect-src` に `https://api.github.com` を入れてあるので、ブラウザの問い合わせは通る。
- **既存の admin と Worker はそのまま**。Start Over は不要。§6 の手順。
- **日常運用**: App ができた後の Worker の GitHub 要求は、すべて App の JWT・installation token・利用者の token・client secret のどれかで認証される（1.0.2 のコードで確認）。**同じ 403 は日常運用では起きない**見込み。
  残る危険は setup 中の 1 か所だけ。manifest の code を交換する要求（`POST /app-manifests/{code}/conversions`）は認証無しなので、共有 IP の枠が尽きていると失敗しうる（§7）。
- **今後の顧客の setup**: テンプレートが 1.0.0 のままなので、**Deploy の直後、ウィザードの前に `package.json` を最新版に上げる**手順を、納品手順に足す（§5）。

## 1. setup で Worker が送る GitHub の要求

### 1.1 共通の送信関数（認証は任意）

`lib/git/github/api.js`（https://raw.githubusercontent.com/sveltia/sveltia-cms-additions/main/lib/git/github/api.js）:

```js
export const GITHUB_API_ROOT = 'https://api.github.com';
export const sendGitHubRequest = (path, { method = 'GET', auth, body } = {}) =>
  fetch(`${GITHUB_API_ROOT}${path}`, {
    ...
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sveltia-cms-additions',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(auth ? { Authorization: auth } : {}),
```

`auth` を渡さなければ `Authorization` は付かない。

### 1.2 持ち主の種類の問い合わせ（認証無し）

`lib/git/github/app.js`（https://raw.githubusercontent.com/sveltia/sveltia-cms-additions/main/lib/git/github/app.js）:

```js
export const getAccountType = async (login) => {
  const account = await fetchGitHub(`/users/${encodeURIComponent(login)}`);
  return account.type === 'Organization' ? 'Organization' : 'User';
};
```

`auth` を渡していない = **認証無しの `GET https://api.github.com/users/<owner>`**。`/orgs/<owner>` は呼ばない。

### 1.3 v1.0.1 以前の `POST /v1/setup/github`（オーナーの Worker が動かしている版の系統）

`lib/git/github/routes.js`（https://raw.githubusercontent.com/sveltia/sveltia-cms-additions/v1.0.1/lib/git/github/routes.js）:

```js
    const { repo, return_url: returnUrl, replace } = await readJson(c);
    ...
    const owner = repo.split('/')[0];
    const ownerType = await getAccountType(owner);
    ...
    const actionUrl = new URL(
      ownerType === 'Organization'
        ? `https://github.com/organizations/${owner}/settings/apps/new`
        : 'https://github.com/settings/apps/new',
    );
```

`owner_type` を受け取らないので、**毎回** Worker から問い合わせる。目的は、manifest を POST する先（個人用か Organization 用の「新しい App」ページ）を選ぶことだけ。
これは GitHub の manifest 手順どおりの分岐: 「sends a `POST` request to `https://github.com/settings/apps/new` for a personal account or `https://github.com/organizations/ORGANIZATION/settings/apps/new` for an organization account」（https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest）。
この handler では、これ以外の GitHub 要求は無い（manifest はローカルで組み立てる）。

### 1.4 v1.0.2 の `POST /v1/setup/github`

https://raw.githubusercontent.com/sveltia/sveltia-cms-additions/main/lib/git/github/routes.js:

```js
    const { repo, return_url: returnUrl, replace, owner_type: givenOwnerType } = await readJson(c);
    ...
    // The CMS looks the owner up from the browser and sends its type, as GitHub limits requests
    // without credentials by IP address, which a Worker shares with others. Only an older CMS
    // leaves it to this service. A wrong type only opens the wrong page on GitHub
    const ownerType = ['Organization', 'User'].includes(givenOwnerType)
      ? givenOwnerType
      : await getAccountType(owner);
```

`owner_type` が `Organization` か `User` なら問い合わせない。それ以外か無ければ、従来どおり Worker から問い合わせる。

### 1.5 その他の setup の route

- `GET /v1/setup/github/callback`（GitHub で App を作った後の戻り先）: `POST /app-manifests/{code}/conversions` を **認証無し**で 1 回送る。
  ```js
  export const convertManifestCode = (code) =>
    fetchGitHub(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
  ```
  一度きりの code が資格の代わり（コードのコメント「needs no other authentication」）。GitHub の文書も「This endpoint is rate limited.」と書く。失敗したら setup の段階を戻して 502 `github_error` になる。その後の `https://github.com/apps/<slug>/installations/new` はブラウザの移動で、Worker は取りに行かない。
- `GET /v1/setup/github/installed`（インストール後）: App ができているので、App の JWT で `GET /app/installations/{id}` と `POST /app/installations/{id}/access_tokens`、installation token で `DELETE /installation/token`。**認証あり**。

### 1.6 エラーの形（今回の本文の出どころ）

```js
// api.js（1.0.2）
      const rateLimitMessage = getRateLimitMessage(response, details?.message, !!options?.auth);
      if (rateLimitMessage) {
        throw new GitHubError(response.status, rateLimitMessage, { rateLimited: true });
      }
      throw new GitHubError(
        response.status,
        `GitHub responded with ${response.status}${details?.message ? `: ${details.message}` : ''}.`,
      );
```

`GitHubError` → `ProviderError`（`super(502, code, message)`、`lib/core/git-provider.js`）→ `Response.json({ error: { code, message } }, { status })`（`lib/core/http/errors.js`）。

1.0.2 なら本文の「API rate limit exceeded」は `/rate limit/i` に当たり、メッセージは
「GitHub is limiting requests from the network address this service shares with others. Try again in N minutes.」になる（`getRateLimitMessage`、https://raw.githubusercontent.com/sveltia/sveltia-cms-additions/v1.0.2/lib/git/github/api.js）。
今回の本文は `GitHub responded with 403: API rate limit exceeded for 172.71.159.112.` という**古い形**。つまり Worker は 1.0.2 ではない。これはテンプレートの固定（§4）とも合う。

## 2. 原因: 共有 IP の「認証無し 60 回/時」

- GitHub: 「Unauthenticated requests are associated with the originating IP address, not with the user or application that made the request.」「The primary rate limit for unauthenticated requests is 60 requests per hour.」「If you exceed your primary rate limit, you will receive a `403` or `429` response, and the `x-ratelimit-remaining` header will be `0`.」「You should not retry your request until after the time specified by the `x-ratelimit-reset` header.」「Continuing to make requests while you are rate limited may result in the banning of your integration.」（https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api）
  - 認証ありの場合: installation token は「minimum rate limit of 5,000 requests per hour」、利用者の token は利用者の枠（同ページ）。
- Cloudflare: 「Cloudflare uses **172.64.0.0/13** (172.64.0.0–172.71.255.255) as public egress IP space.」（https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/）。172.64.0.0/13 は https://www.cloudflare.com/ips-v4 にも載る。172.71.159.112 はこの範囲。
  - Workers の送信元 IP が他の顧客と共有されることを、Workers の文書は明記していない（limits・how-workers-works・fetch の各ページに記載無し）。共有なのは推論。ただし Additions の作者が commit `64eba2f` に「as Cloudflare's shared IP addresses can use up the limit for requests without credentials」と書いており、テストの例も `API rate limit exceeded for 172.70.206.75.`。
- まとめ: オーナーの Worker は setup の中でまだ 1 回しか GitHub に問い合わせていないはず。それでも枠が尽きていたのは、**同じ egress IP を使う他の Worker の分**。

## 3. その問い合わせは App 作成の前に要るか

- **要らない**。目的は manifest の POST 先を選ぶことだけで、ブラウザが代わりに調べられる。作者のコメントのとおり「A wrong type only opens the wrong page on GitHub」。
- **ブラウザ（Sveltia CMS 5.0.3）はすでに調べている**。`dist/chunks/additions.js`（https://unpkg.com/@sveltia/cms@5.0.3/dist/chunks/additions.js）:
  ```js
  Aa=async e=>{try{let t=await fetch(`https://api.github.com/users/${encodeURIComponent(e)}`,
  {headers:{Accept:`application/vnd.github+json`},signal:AbortSignal.timeout(1e4)});
  if(t.ok){let{type:e}=await t.json();return e===`Organization`?`Organization`:`User`}}catch{}}
  ```
  ```js
  ja=async({repo:e,replace:t=!1})=>{let{action_url:n,manifest:r}=await Ca(`/v1/setup/github`,
  {method:`POST`,body:{repo:e,return_url:window.location.href,replace:t,owner_type:await Aa(e.split(`/`)[0])}});ka(n,r)}
  ```
  ブラウザの問い合わせは**オーナーの端末の IP** の枠を使う（共有ではない）。失敗すると `owner_type` は空になり、1.0.2 では Worker の問い合わせに戻る。
  admin の CSP（`experiments/pages-cms/sveltia-config.ts`）は `connect-src` に `https://api.github.com` を入れている。
- **Additions の設定で避ける方法は無い**:
  - 変数は `ADMIN_SECRET` だけ（`templates/cloudflare/.dev.vars.example`:「The only variable of Sveltia CMS Additions.」）。`GITHUB_TOKEN`・`OWNER_TYPE`・App ID・private key の変数は無い。`wrangler.jsonc` は Durable Object の binding だけ。
  - **App を手で登録して App ID・private key・client secret を入れる道は無い**。App の資格を保存するのは manifest の callback だけ（`saveGitHubApp`）。手で入れられるのは、既存の App の private key の差し替え（`PUT /v1/settings/github/private-key`、App が無ければ 409 `github_app_missing`）だけ。
  - したがって **個人の token（PAT）を使う設定もそもそも無い**。オーナーの禁止事項（恒久的な個人 token・広い repo 権限）に触れる選択肢は出てこない。

## 4. 公式の対応と版

- 版: v1.0.0（2026-11-22 22:25Z）、v1.0.1（22:45Z）、**v1.0.2（23:31Z）が最新**。npm の `latest` も `1.0.2`。2026-11-28 時点でそれより新しい版・commit は無い。
- 直し: commit `64eba2f`（23:28Z）「Let the CMS send the repository owner's type and explain GitHub rate limits, as Cloudflare's shared IP addresses can use up the limit for requests without credentials」（https://github.com/sveltia/sveltia-cms-additions/commit/64eba2ffd215c7a7b7088413f0f4ffdbd821466c）。**v1.0.2 に入っている**。release notes は「Bug fixes and improvements.」だけ。
- issue は repo に 0 件。文書（https://sveltiacms.app/en/docs/additions/setup ほか）に GitHub の rate limit の説明は無い。
- **テンプレートが古い版を固定している**: https://raw.githubusercontent.com/sveltia/sveltia-cms-additions/main/templates/cloudflare/package.json は `"@sveltia/cms-additions": "1.0.0"`（caret 無し）。このファイルの履歴は最初の commit だけ。lockfile は無い。だから Deploy ボタンの写しは 1.0.0 で動き始める。
- 更新の公式の道: 「Dependabot opens a pull request in your copy of the repository when a new version is released. Merge it, and Workers Builds deploys the update. You can also change the version of `@sveltia/cms-additions` in its `package.json`.」「Don't change `wrangler.jsonc` unless the release notes ask you to.」（setup の頁）。Dependabot は週 1 なので、写した直後には PR がまだ来ていないことがある。

## 5. 待つ以外の選択肢（安全な順）

| 順 | 方法 | 判定 |
|---|---|---|
| 1 | **公式の 1.0.2 に上げる**（写しの `package.json` を `1.0.2` に。Dependabot の PR があればそれをマージ） | **推奨**。公式の版で、改造ではない。token も追加の権限も要らない。Worker と Durable Object のデータは残る |
| 2 | 時間を置いて再試行 | 確実ではない。枠は最長 1 時間で戻るが、共有 IP は他の利用者がすぐまた使い切りうる。送信元 IP は要求ごとに変わりうるので、偶然通ることはある。今後の顧客でも再発する |
| 3 | 写しの `routes.js` を手で直す | 不要。写しは npm の package を import する小さな repo なので、直すには package を差し替えることになる。1.0.2 が同じ直しを公式に持っている |
| 4 | App の手動登録 | Additions が対応していない |
| 5 | 短命の token・PAT | Additions に設定が無い。しかもオーナーの禁止事項に当たる |

**今後の顧客の setup で再発させない**: 納品手順の「Deploy ボタン」の直後に、次の 1 行を足す。
「写しの repo の `package.json` で `@sveltia/cms-additions` を最新版（2026-11-28 時点 `1.0.2`）にして commit し、Workers Builds の Deploy が終わってからウィザードを始める」。
上流のテンプレートが 1.0.0 を固定している件は、上流に知らせる価値がある（この調べでは何も送っていない）。

## 6. 復旧の手順（admin と Worker はそのまま、Start Over はしない）

1. GitHub をブラウザで開き、写しの repo `sr-cms-trial/sveltia-cms-additions` の `package.json` を開く。
2. Pull requests に Dependabot の「@sveltia/cms-additions を 1.0.2 に」があれば、それをマージして 4 へ。無ければ 3 へ。
3. 鉛筆（Edit）で `"@sveltia/cms-additions": "1.0.0"` を `"1.0.2"` に変え、`main` に commit する。**他の行と `wrangler.jsonc` は触らない**。
4. Cloudflare の Workers & Pages → その Worker → Deployments で、新しい Deploy が成功するのを待つ（数分）。
5. サイトの `/admin` を開き直す。`ADMIN_SECRET` を求められたら入れる。admin はすでにあるので、手順 2/2「Connect to GitHub」から続く。**Start Over は押さない**。
6. 「Connect to GitHub」を押す。GitHub の App 作成ページ（`sr-cms-trial` 用）が開けば直っている。作成 → インストール（**Only select repositories** でサイトの repo だけ）へ進む。
7. まだ 502 なら、本文を見る。
   - 「GitHub is limiting requests from the network address this service shares with others」なら、Worker は 1.0.2 になったが、ブラウザの問い合わせが失敗して Worker の問い合わせに戻っている。端末を変えるか Wi-Fi / モバイル回線を切り替えて、もう一度押す。
   - 「GitHub responded with 403」のままなら、まだ 1.0.0 で動いている。4 の Deploy を確かめる。
8. App を作った後の戻り（callback）で rate limit が出たら、1.0.2 の案内どおり、**App を作ってから 1 時間以内にそのページを再読み込み**する（§7）。

データは Durable Object に残る。文書は「Database migrations run automatically on the first request after an update」と書いている。

## 7. 日常運用で同じ 403 は起きるか

1.0.2 のコードで、App ができた後に Worker が送る要求:

| 目的 | 要求 | 認証 |
|---|---|---|
| App・鍵の確認 | `GET /app` | App の JWT |
| インストールの確認 | `GET /app/installations/{id}` | App の JWT |
| 役割ごとの token の発行 | `POST /app/installations/{id}/access_tokens` | App の JWT |
| token の失効 | `DELETE /installation/token` | installation token |
| ブランチ保護の確認 | `GET /repos/{o}/{r}` ほか | installation token |
| サインインの code 交換・更新 | `POST https://github.com/login/oauth/access_token` | client_id + client_secret |
| サインインした人 | `GET /user` | 利用者の token |
| login で人を探す | `GET /users/{login}` | installation token |
| Organization のメンバー確認 | `GET /orgs/{org}/members/{login}` | installation token |
| 利用者の許可の取り消し | `DELETE /applications/{clientId}/grant` | Basic（client_id:client_secret） |

- 認証無しになりうるのは `findUserByLogin` だけ: `...(token ? { auth: `Bearer ${token}` } : {})`。実際の呼び出しは常に installation token を渡す: `withToken({ metadata: 'read' }, (token) => findUserByLogin(login, token))`（`lib/git/github/index.js`）。コメントにも「a far higher rate limit than an anonymous request from a shared address」とある。
- 結論: **日常運用（サインイン・token の発行・人の検索）で、共有 IP の認証無しの枠は使わない**。同じ 403 は再発しない見込み。認証ありの枠（installation token は 1 時間 5,000 回以上）は、1 店舗の運用ではまず届かない（見積もり）。
- 例外は setup の中だけ:
  - `owner_type` が届かなかったときの `/users/<owner>`
  - App 作成直後の `POST /app-manifests/{code}/conversions`（認証無し、§1.5）

  どちらも App の作り直し（Replace）のときにしか通らない。
- 注: この表は 1.0.2（`main`）で確かめた。1.0.0 の日常のコードは読んでいない。いずれにせよ §6 で 1.0.2 に上げる。

## 8. 出典（2026-11-28 に参照）

- https://github.com/sveltia/sveltia-cms-additions （`lib/git/github/{routes,api,app,oauth,index}.js`、`lib/core/git-provider.js`、`lib/core/http/errors.js`、`templates/cloudflare/{package.json,.dev.vars.example,wrangler.jsonc,.github/dependabot.yml}`、タグ v1.0.1・v1.0.2）
- https://github.com/sveltia/sveltia-cms-additions/commit/64eba2ffd215c7a7b7088413f0f4ffdbd821466c
- https://api.github.com/repos/sveltia/sveltia-cms-additions/releases 、https://registry.npmjs.org/@sveltia/cms-additions
- https://sveltiacms.app/en/docs/additions/setup
- https://unpkg.com/@sveltia/cms@5.0.3/dist/chunks/additions.js
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest 、https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest
- https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/ 、https://www.cloudflare.com/ips-v4
