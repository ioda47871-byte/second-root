# DEV-196g: 店舗デモの版の共有 URL (旗とDBのスイッチ、どちらも既定で無効)

オーナー Issue #263 の 2 (営業相手に届く共有デモ)。承認済みの範囲は「コード・テスト・ローカル DB の検証・PR 作成・CI」。
**Staging / Production の DB 変更・deploy・DNS / Vercel の設定・旗やスイッチの有効化・実送信・画像生成・LLM の呼び出しはしていない。**
branch `feature/dev-196g-versioned-sharing` (`origin/develop` da46c83b から作り、PR #265 が merge された後に `origin/develop` 1232c480 を merge)。
ローカルの検証は、scratch に複製した別の project id (`sr-dev196g`、port 5967x) のスタックで行った。「輪」(SR-001) のデータには触れていない。

## 何をしたか

### DB: `supabase/migrations/20261114000100_sales_demo_share_switch.sql` (ローカルだけ)

- DEV-196c の定数 `sales_demo_versioned_sharing_enabled() = false` を、1 行の設定表 `sales_demo_share_settings` (`versioned_sharing_enabled`、既定 **false**) を読む関数に置き換えた (名前・引数・権限 (service_role だけ) は同じ。`stable`、security definer ではない。呼び出し元は security definer の送信の RPC と service role で、どちらも RLS の外で読む)。
- 変えられるのは DB の所有者だけ (SQL editor や migration から)。trigger が API の role (anon / authenticated / service_role) からの書き込みをすべて拒否する (`share_switch_owner_only`)。行の追加と削除もできない。RLS で、どの API の role からも行は見えない。
- migration の直後の挙動は前と同じ: resolver は `version` を返さない。版を使う送信は `demo_not_shareable` で止まる。
- 写真の共有 (`sales_demo_share_photos_enabled()`) は定数 false のまま (MVP_SPEC §7)。resolver・`sales_demo_version_shareable`・送信の guard の規則は変えていない。
- `scripts/staging/lib.mjs` の Staging の照合 `demo_version_sharing_disabled` は、関数の本文が `select false` であることを見ていた。関数そのものを呼んで false であることを見るように変えた (関数があるときだけ評価する)。意味は同じで「DB で共有が off」。hosted でスイッチを on にするときは、この照合も一緒に変える必要がある (別の承認)。

rollback (ローカル。DEV-196c の定数に戻す):

```sql
create or replace function public.sales_demo_versioned_sharing_enabled()
  returns boolean language sql immutable set search_path = '' as $$ select false $$;
drop table public.sales_demo_share_settings;
drop function public.sales_check_demo_share_settings_write();
```

### server

- `lib/sales/demo-version/flags.ts`:
  - `SALES_DEMO_SHARE_ENABLED`: 厳密に `"true"` のときだけ on、既定は off。`SALES_DEMO_VERSIONS_ENABLED` も on であることが要る。
  - `SALES_DEMO_APP_ORIGIN`: 共有の成果物の `frame-ancestors` に名指しするアプリの origin。
  - `demoShareConfig`: 鍵・artifact origin・app origin がすべて正しく、app origin と artifact origin が違うときだけ `ready`。それ以外は版を出さない (React のデモにも落とさない)。
- `lib/sales/demo-version/view-model.ts`: 定数 `VERSIONED_SHARING_ENABLED` を `versionedSharingEnabled` (= server の旗) に置き換えた。管理画面と Today の loader が渡す。既定は off なので、旗が off の画面は前と同じ。
- `/demo/[publicToken]` (`app/demo/[publicToken]/page.tsx`・`lib/sales/demo-share.ts`・`components/demo/VersionShareFrame.tsx`):
  - 旗が off: 前と全く同じ (`loadPublicDemo` だけ。resolver を呼ばない)。
  - 旗が on: `sales_resolve_demo_share` (service role。判断はここ 1 か所) の答えで分ける。
    - `version`: 信頼できる外枠を描く (注記と footer は React のデモと同じ文言)。その中に `sandbox=""`・`referrerpolicy="no-referrer"`・`allow` なしの iframe を置き、`<artifact origin>/demo-frame/p/<30 分の scope p の token>/index.html` を読む。
    - `legacy`: 既存の React のデモ。
    - `none`・読めない・設定が不完全: 404。
- `/demo-frame/p/[token]/[...path]` (新しい route、`lib/demo-frame/serve.ts` の判断を scope `"p"` で使う)。条件はすべて満たす必要がある:
  - 両方の旗が on で、設定が `ready`。要求が artifact origin に来ている (アプリの origin では 404)。
  - token の HMAC・期限・scope が正しい (scope `a` の token は使えない)。
  - query がない。対象が render ではない。`Sec-Fetch-Dest` が合っている (HTML は iframe からだけ。直接開くと 404)。
  - 版が取り消されていない。demo が無効化されていない。
  - **DB の resolver が、ちょうどこの版を答える** (ファイルごとに毎回問い合わせる)。
  - 写真の権利が今も共有可 (今は写真があれば 404)。
  - manifest どおりの bytes・hash であることを検めてから返す。

  拒否はすべて同じ 404。応答の header は §6.7 のまま: CSP の `frame-ancestors <app origin>`・`sandbox`・`script-src 'none'`、`X-Robots-Tag: noindex, nofollow, noarchive`、`Cache-Control: private, no-store`。cookie は読まず、発行もしない。
- 管理者プレビュー (scope `a`): 前は artifact origin が設定されていると 404 (fail closed) だった。これを、artifact origin が正しく設定されていてもアプリの origin で配るように変えた (spec §6.8 の管理者だけの暫定で、cookie を読まない route・CSP の sandbox・iframe の sandbox は同じ)。artifact origin に来た scope `a` の要求は 404。形の正しくない設定は、今までどおり何も配らない。共有のために origin を設定しても管理画面のプレビューが止まらないようにするための変更。
- `next.config.ts`: 旗が on のとき (build 時) だけ、`/demo/*` に `frame-ancestors 'none'; frame-src <artifact origin>` を足す。設定が不正なら `frame-src 'none'`。旗が off なら規則を足さず、header は前と同じ。
- Today の badge (`lib/admin/demo-version-badges.ts`): 旗が on で copy の段まで進んだ店だけ、版の copy gate を読む (管理者のセッションで、その店ごとに 1 回)。これで「読めない」ではなく本当の止まった理由を出す。旗が off なら何も読まない。

### PR #265 の delta review (coordinator の指示でこの PR に入れた)

- `precheckStructureFindings`:
  - 既存の版を探す条件に `status <> 'rejected'` を足した (unique index `sales_demo_versions_bundle_key` と同じ行を見るため)。
  - replay 先の版が live (draft / approved / superseded) でなければ、書く前に `STRUCTURE_FINDINGS_VERSION_UNAVAILABLE` で拒否する。
  - 統合テストを追加した。
- `.ai/tasks.json`: DEV-196p / DEV-196q を done にした (PR #265 merged 1232c480)。

## テスト

- unit:
  - 新規 `tests/unit/demo-frame/serve-share.test.ts`: scope p の配信と、拒否がすべて同じ 404 になること。
  - 新規 `tests/unit/sales/demo-share.test.ts`: 旗・設定・next.config の規則・外枠の判断。
  - 更新: `serve.test` (artifact origin が設定されたときの管理者プレビュー)、`route.test`、`guardrails.test` (route の一覧に p を追加し、p は scope "p" で判断を走らせる)、`purity.test` (承認された importer に共有の頁を追加)、`view-model.test`、`demo-versions-page.test`。
  - `tests/unit` の全体で失敗したのは、この worktree の環境によるものだけ。Chromium (playwright 1.62 用) が無いことと、worktree に `node_modules/.bin/tsx` が無いことで、`design-agent/*`・`swap-photos`・`structure` の描画が落ちる。変更前から同じ。
- 統合 (ローカル Supabase、Storage あり):
  - 新規 `tests/integration/demo-share.test.ts`: スイッチ (既定 off、API の role は読めず変えられない、所有者だけが変えられる)。resolver (off は前と同じ、on は固定した写真なしの版だけ。写真あり・取り消し・期限切れ・無効化は none、legacy は legacy、新しい版には切り替わらない)。外枠の判断。実際の store を使った scope p の配信 (別の版・render・旗 off・スイッチ off は 404)。
  - `staging-checks` に追加: スイッチを on にすると `demo_version_sharing_disabled` が落ちる (fail closed)。
  - 統合の全体: 32 ファイル・509 件が通った (develop を merge する前)。
- e2e (production build、`PLAYWRIGHT_CHROMIUM_EXECUTABLE` でこの環境の Chromium を使用):
  - 新規 `tests/e2e/demo-share.spec.ts`:
    - suite の server (旗 off) では、版を固定した demo でも React のデモで、CSP も前と同じ `frame-ancestors 'none'`。
    - 共有を on にした 2 つ目の server (app `http://127.0.0.1:<port>`、artifact `http://localhost:<port>` の 2 つの origin) を、**cookie の無い独立した browser context** で開く。注記がある。iframe は `sandbox=""`・`no-referrer`・`allow` なしで、src は artifact origin。**送信時に固定した版**の文が出て、新しい別の版は出ない。script は動かず、CSS は効く。frame の要求は artifact origin だけ。成果物の header が正しい。直接開く・アプリの origin で開く・render は 404。
    - legacy は React のデモのまま。固定した版を取り消すと 404 (別の版にも React にも切り替わらない)。DB のスイッチが off なら 404。
  - 回した既存の spec: `demo.spec`・`demo-frame.spec`・`demo-versions-page`・`demo-today-badge`・`today`・`demo-compare`・`demo-review`・`existing-site`。すべて通った。1 回だけ Today の件数の上限で落ちたのは、fixture が作った outreach が drafted のまま Today に残ったためで、fixture を `status = 'sent'` にして直した。
- `tsc --noEmit`・eslint (変更したファイル)・`check:secrets`・`npm run build`。

## 承認が要ること・未解決

1. **hosted に当てる (オーナーの承認、どれも未実施)**:
   - Staging / Production に migration を当てる。`20261114000000_sales_demo_structure_findings.sql` (#265) の後に `20261114000100_sales_demo_share_switch.sql`。
   - DB のスイッチを on にする (`update public.sales_demo_share_settings set versioned_sharing_enabled = true;`、所有者だけ)。同時に `scripts/staging/lib.mjs` の `demo_version_sharing_disabled` の照合を変える。
   - Vercel の環境変数 (server だけ): `SALES_DEMO_VERSIONS_ENABLED=true`・`SALES_DEMO_SHARE_ENABLED=true`・`SALES_DEMO_VIEW_SIGNING_KEY` (32 bytes 以上、新しく作る)・`SALES_DEMO_ARTIFACT_ORIGIN=https://<artifact の sub domain>`・`SALES_DEMO_APP_ORIGIN=https://<アプリの origin>`。`next.config.ts` の規則は build 時に読むので、設定した後に deploy し直す必要がある。
   - artifact origin の DNS と、Vercel の project への domain の追加。同じ deploy で、cookie は host-only のまま。
   - rollback: 旗を off にして deploy し直すか、DB のスイッチを false に戻す (どちらか片方で共有は止まり、URL は React のデモか 404 に戻る)。
2. **実際の送信で版を固定するには** DEV-199e の copy gate が通る必要がある。それには facts の経路 (DEV-263a、並行の builder) が要る。今のテストの「送信済みの承認」は、fixture が DB の所有者として書いている。
3. 写真は共有しない (MVP_SPEC §7)。写真のある版は 404。写真なしの版が先 (Issue #263 の方針)。
4. 管理者プレビューを artifact origin に移すのは後の段 (spec §6.8 の「使えるようになったら移す」)。今はアプリの origin の暫定のまま。
5. 共有の頁の `frame-src` は build 時の header なので、e2e の共有 build では確かめていない (unit で next.config の規則を固定した)。

## PR #267 Fresh Review (eb90631: C0 H0 M1 L5) の修正

- **M1** 旗 off のときに版を固定した送信が React のデモに落ちる問題:
  - `/demo/[publicToken]` は、旗 off でも `sales_resolve_demo_share` で決める (`resolveLegacyOnly`)。`legacy` だけ React のデモで、版を固定した demo (DB のスイッチが on でも off でも) と未送信・不一致は 404。
  - resolver の関数が無い DB (版の migration が当たっていない project。版は存在し得ない) は `legacy` 扱いで、今の React のデモを壊さない。それ以外のエラーは 404。
  - アプリは、旗が off の間、版を使う送信の承認 (`approveSend`) と送信画面を開く操作 (`markSendOpened`) を断る (`VERSIONED_SEND_SHARE_OFF`)。「手動で送信済み」は断らない (実際の送信の事実を失わない、DEV-195)。
  - 送信と共有は「DB のスイッチ AND server の旗」の両方で開く。旗が off なら、固定された版は 404。
  - テスト: unit `send-guard` (旗 off の承認・開く・legacy はそのまま)、`demo-share` (`resolveLegacyOnly`)、統合 `demo-share` (旗 off: legacy → React、固定した版 → スイッチ on / off とも 404、未送信 → 404)、e2e `demo-share` (suite の server、旗 off: legacy は React、固定した版はスイッチ on / off とも 404)。
- **L1** 管理者プレビューを artifact origin に移す作業を `.ai/tasks.json` の DEV-196t (backlog) に記録した。**オーナーへ**: 今は spec §6.8 の暫定どおり、artifact origin を設定しても管理者プレビューはアプリの origin に残す (cookie を読まない route・CSP の sandbox・iframe の sandbox は同じ)。spec の「移す」からの一時的な逸脱で、DEV-196t で解消する。
- **L2** host の gate: `proxy.ts` の matcher を「`/demo-frame` と Next の static (`_next/static`・`_next/image`) を除く全部」に広げた。artifact origin の host では 404 (`lib/sales/artifact-host.ts`、`/demo-frame/p/…` 以外。`/demo-frame/*` は matcher の外で、route 自身が拒否する)。session の処理は今までどおり `/admin` (ちょうど) だけ。`SALES_DEMO_ARTIFACT_ORIGIN` が未設定なら何もしない。テスト: unit `guardrails` (matcher の固定と、一致する path / しない path) と `demo-share` (`artifactHostRefused`)、e2e (artifact host の `/`・`/admin/login`・`/admin/sales`・`/demo/<token>`・`/api/internal/x` は 404、cookie なし。app host は変わらない)。
- **L3** Staging の照合 `demo_version_sharing_disabled` を強くした: 関数の本文 (正規化した後) が既知の 2 つ (DEV-196c の `select false`、DEV-196g のスイッチの読み出し) のどちらかであること、設定の行がちょうど 1 行で off であることを直接見る (表があるときだけ評価する)。統合テスト: 未知の本文と 2 行目は落ちる。スイッチを on にすると function と setting の両方が落ちる。
- **L4** 管理画面と Today は、server の旗 AND DB の `sales_demo_versioned_sharing_enabled()` (service role、旗が on のときだけ読む、失敗は false) で「共有が on」を決める。画面の表示が DB の判断と一致する。
- **L5** 旗・`SALES_DEMO_ARTIFACT_ORIGIN`・`SALES_DEMO_APP_ORIGIN` を変えたら **deploy し直す必要がある** (共有の頁の `frame-src` は build 時の header)。`flags.ts` と `next.config.ts` に書いた。hosted に当てるときの手順にも含める。

再実行: unit (対象 1489 件)、統合の全体 (33 ファイル・517 件)、e2e (`demo-share`・`demo`・`demo-frame`・`admin`・`existing-site`・`demo-today-badge`・`demo-versions-page`・`instagram-send`・`email-send`: 82 passed)、`tsc`・eslint・`npm run build`・`check:secrets`。
