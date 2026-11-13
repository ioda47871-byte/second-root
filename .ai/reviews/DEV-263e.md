# DEV-263e — 営業 MVP の全体のローカル E2E と運用手順 (Issue #263 の 4・5)

Base: `origin/develop` 5fc19463 (DEV-199b/e・DEV-196p/q・DEV-263a) に、PR #267 (DEV-196g、`feature/dev-196g-versioned-sharing`) を merge commit で取り込んだ上。**PR #267 が先に merge される前提**。migration なし。
Staging / Production・環境変数・DNS / Vercel・実送信・Codex / 画像 / LLM・輪 のデータには触れていない。

## 1. E2E: `tests/e2e/sales-mvp-flow.spec.ts`

旗をすべて on にした 2 つ目の `next start` (同じ build。署名鍵はテストの process の中で作る。アプリ `http://127.0.0.1:<port>`、成果物 `http://localhost:<port>`、`SALES_DEMO_BASE_URL` はアプリ、`SALES_LOCAL_E2E_TEST_RECIPIENTS=true`)。suite のサーバーは旗 off のまま。ローカル DB の共有スイッチはこのファイルの間だけ on。

**メールの経路** (1 本の test):

1. 候補: `import-local.ts --seed-sendable --seed-only` (環、固定の id、outreach なし)。
2. `package-local.ts --copy <環のカンプ> --facts <facts pack>` (repo の外へ) → `import-local.ts --package … --seed-sendable --trusted-facts <facts pack>`。出力の `copy.facts_from_facts_path === true`。
3. 管理画面の版の頁: 文章の監査が facts の経路から・approve_candidate・オーナーの判断なし。PC 1440 と SP 390 の描画を最後まで見る。
4. 品質 7 項目「問題なし」+ 確認 → 品質承認 (`approved_version_id` がこの版、審査はこの管理者)。
5. 文章の確認で「文章を承認」(decideCopyReview)。送信の止まり (`data-copy-send-block`・`data-send-stop`) が無くなる。
6. 今日のカード: 宛先 `info@tamaki-demo.example.com`、文面に共有 URL。送信承認 → approval が `demo_version_id` = 承認した版・`demo_share_eligible` true。
7. 承認の後に新しい版 (品質未承認) を足す。
8. 送信済み前: cookie の無い context で共有 URL は 404。
9. メールを作成: mailto は捕まえる (端末に渡さない)。本文に共有 URL。
10. 手動で送信済みにする → `sent`。
11. **受信者**: 新しい cookie の無い context で `/demo/<token>` → 200・`X-Robots-Tag: noindex`・注記・iframe 1 つ (`sandbox=""`・`no-referrer`・src は成果物の origin)。frame の中は 環 の頁 (h1「環」、見出し「修理のご案内」)、新しい版の文は出ない。frame の要求は成果物の origin だけ。成果物の HTML のバイトの sha256 が承認した版の `page/index.html` の記録と一致。CSP `frame-ancestors <app>`・sandbox、noindex、cookie なし。
12. 返信 → 興味あり → 商談へ (`meeting`・`interested`)。
13. 管理者の browser の要求はローカルの 2 つの origin だけ (外へ何も送らない)。

**Instagram の経路**: 環 を消して作り直し (包みの job id は 1 つのデモに結び付くので、同じ包みを別の店へは入れられない)、架空の Instagram のハンドルの店にして (スキーマどおり website なし・email なし)、`--prospect` で取り込み → 同じ承認 → 送信承認 → **DMを送る** (文面をコピーし、Instagram のプロフィールを開く。stub) → クリップボードの文面 = 承認の本文 (共有 URL を含む)、`opened_via = instagram_profile`、API の host への要求なし・`sales_ig_sends` は増えない → 送信済み → 受信者の確認 (上の 11 と同じ)。

片付け: 環 (固定の id) と下の行・Storage のファイルを、前・間・後に消す (DB の所有者として trigger off)。共有スイッチは off に戻す。**ローカルで試した 環 の記録も消える** (runbook に記載)。

CI: CI の stack は `storage-api` を外しているので、このファイルは skip (`storageStatus` の理由を出す)。既存の demo-share / demo-review と同じ扱い。また `--trusted-facts` は facts pack が `refs/remotes/origin/develop` と同じ blob であることを要求するので、CI の shallow checkout では通らない (skip されるので問題にならない)。

## 2. PR #266 の review の Low

1. `lib/demo-version-package/local-inputs.ts` `FACTS_BASE_REF = "refs/remotes/origin/develop"` (ローカルの branch や tag の `origin/develop` で代わりにならない)。テスト: branch と tag を `origin/develop` の名で HEAD に作っても `TRUSTED_FACTS_NOT_ON_DEVELOP`。
2. `lib/sales/test-recipient.ts`: ドメインを NFKC → `domainToASCII` (WHATWG IDNA) → 小文字 → 末尾の点をすべて除く、の後に予約済みの判定。IDNA が拒否するドメインは予約済み扱い (fail closed)。テスト: 全角・「。」・末尾の点 1 つと複数・ZWJ。
3. 同: `SALES_LOCAL_E2E_TEST_RECIPIENTS` は `NEXT_PUBLIC_SUPABASE_URL` が loopback (localhost / 127.0.0.0/8 / [::1]) のときだけ効く。テスト: hosted の URL・`localhost.example.com`・`127.0.0.1.nip.io`・私設の IP では止まる。action の段でも hosted の URL なら RPC を呼ばない。

## 3. PR #267 の delta review の Low (coordinator の指示)

- (a) `lib/sales/demo-share.ts` `resolverMissing`: 「関数が無い」は `PGRST202`、または `42883` で message が `sales_resolve_demo_share(` を名指すときだけ。それ以外の 42883 (中の補助関数・演算子の欠落) やほかの code は 404。テスト。
- (b) `app/admin/sales/_actions/send.ts`: 旗 off で copy gate が読めなかった (`unread`) ときの送信承認を拒否。旗 off で approval の固定の版を読めなかったときの `markSendOpened` を拒否。旗 on の unread は従来どおり DB の guard に任せる。テスト (`send-guard.test.ts`)。
- (c) `proxy.ts` の matcher: `favicon.ico`・`robots.txt`・`sitemap.xml` と拡張子付きの静的ファイル (svg/png/jpe?g/gif/webp/avif/ico/css/js/map/txt/xml/webmanifest/woff2?/ttf/otf) を除く。guardrails のテストが文字列と通る / 通らない path を固定。

## 4. 運用手順

`docs/operations/sales-mvp-runbook.md`: (A) ローカルで 環 を管理画面で通す手順 (stack・`.env.local` の旗・seed・包み・取り込み・スイッチ・下書き・クリックの順)、(B) 承認待ちの本番計画 (migration の順、未完了の安全装置、成果物の origin と host の制限、環境変数、DB スイッチ、最初の実店舗、rollback)。止まる所に 🛑。

## 既存のテストの変更

- `tests/e2e/support/flag-on-server.ts`: `env` の option (このサーバーだけの追加の変数)。既存の呼び出しは不変。
- `tests/unit/sales/test-recipient.test.ts`: ローカル旗の期待に loopback の URL を足した (旗だけでは通らなくなったため)。
- `tests/unit/demo-frame/guardrails.test.ts`: matcher の文字列の更新と path の追加。
- `tests/unit/sales/demo-share.test.ts`: 42883 の message を名指しのものに (汎用の "function not found" は今は 404)。
- `tests/unit/sales/copy-review/send-guard.test.ts`: 読み込みの error を返せる mock と 2 件。

## テスト

- e2e (scratch のローカル stack `sr-dev263e`、port 5987x、Storage あり、production build、`PLAYWRIGHT_CHROMIUM_EXECUTABLE`): `sales-mvp-flow` 2 件 pass。関係する既存の spec (`demo-share`・`email-send`・`instagram-send`・`outcomes`・`demo-review`・`demo`・`today`) と合わせて desktop 37 件 pass。全体の結果は PR に記す。
- unit: `tests/unit/sales`・`demo-version-package`・`admin`・`demo-frame/guardrails` 66 ファイル 1281 件 pass。
- `tsc --noEmit`・eslint (変更したファイル)・`check:secrets`・`next build`。

## Fresh Review (PR #268 @ e65d0fc: C0 H1 M1 L4) への対応

develop (a6e95d13、#267 の squash) を merge commit で取り込んだ後 (4e0881b) に直した。

- **H1 (旗 off で、版の schema が無い DB の読み込みの誤りが React の送信まで止める)**: `lib/sales/version-schema.ts` `versionSchemaMissing` — 42703・PGRST200・PGRST204 で、message / details / hint が `approved_version_id`・`demo_version_id`・`sales_demo_versions` を名指すときだけ「版の schema が無い」。`outreachCopyGate` はその誤りを plain の `legacy` (unread ではない) で返し、`approveSend` は DB へ進む。`markSendOpened` も固定の版の読み込みのその誤りでは DB へ進む。それ以外の誤りは旗 off の間 fail closed で、専用の文言 (`DEMO_STATE_UNREADABLE`「デモの版の状態を読み込めませんでした…」/ `APPROVAL_UNREADABLE`)。`VERSIONED_SEND_SHARE_OFF` は版が確かにあるときだけ。テスト (`send-guard.test.ts`): 本物の `outreachCopyGate` を mock の client で、3 つの code で RPC に届く / 別の列の 42703・42501・名指しの無い PGRST200 は専用の拒否で RPC に届かない。mock は「表 + select」ごとに誤りを返せるようにした。ファイルを `lib/sales/demo-version/` の外に置いたのは、そのディレクトリの純粋さのテストのモジュール一覧 (固定) を変えないため。runbook B-1 に追記。
- **M1 (固定した版と approved_version_id を区別していない)**: 送信済みの後、新しい版 (v2) を管理画面で品質承認し (`approved_version_id` が v2 に動くことを確かめる)、受信者の確認をもう一度: HTML の sha256 は v1 の `page/index.html` のまま、新しい版の文は出ない。`approveOnAdmin` から品質承認を `qualityApprove` に切り出した (`?v=` で版を選ぶ)。
- **L1**: `proxy.ts` の matcher を #267 の広い形に戻し、`proxy()` の中で host の門の後に `STATIC_PATH` (favicon・robots・sitemap・拡張子) の session の処理だけを飛ばす。テスト: 成果物の host で `/robots.txt`・`/x.js`・`/admin/x.png`・`/favicon.ico`・`/sitemap.xml`・`/admin` が 404、`/demo-frame/p/…` は通る、アプリの host の `/robots.txt` は素通り。proxy の冒頭の注記と runbook を直した。
- **L2**: 送信画面を開いた後 (`send_opened`)、送信済みの前に、共有 URL と成果物の URL (テストの鍵で正しく署名した scope p の token) が 404 であることをもう一度見る (メールと Instagram の両方)。開く前にも同じ確認。
- **L3**: `resolverMissing` の PGRST202 も message が `sales_resolve_demo_share(` を名指すときだけ。テスト。runbook の migration の段に schema cache の読み直し (`notify pgrst, 'reload schema';`)。
- **L4**: runbook A-2 に管理者の作り方 (auth の admin API + `sales_admins`、パスワードは端末に出すだけ)。rollback 1 に「legacy の token は React に戻り、版を固定した token は 404」。

- **CI unit (4e0881b) の `ai-tasks.test.ts`**: DEV-263e の依存 DEV-263a (PR #266) と DEV-196g (PR #267) は merge 済みなので `.ai/tasks.json` で done にした。`ai-tasks.test.ts` 230 件 pass。

再実行: unit (sales・demo-frame・demo-version-package・admin) 70 ファイル 1332 件 pass。e2e: `sales-mvp-flow` (2)・`demo-share`・`email-send`・`instagram-send`・`demo` の desktop 21 件 pass、全体 158 passed・40 skipped (mobile)・0 failed。tsc・eslint・check:secrets・build。

## 開いている項目 (承認待ち)

- runbook B-1〜B-6 はどれもオーナーの承認 (未実施)。
- hosted の facts の保存先・送信時の facts の比べ直し・DB 側のテスト宛先の guard (DEV-263a から)。実店舗に送る前に必須。
- 下書きの作成は E2E では fixture が書く (worker の段は対象外)。
- 写真のある版は共有しない (MVP_SPEC §7)。写真なしの版だけ。
