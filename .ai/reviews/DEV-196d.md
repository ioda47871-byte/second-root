# DEV-196d: 店舗デモの版の管理者プレビューと品質承認の画面

オーナー承認 2026-11-11 (196d-1〜7)。仕様は `docs/design/DEV-196-demo-admin-spec.md` (§3・§6.1〜§6.8・§7・§8・§9・§12・§15)、MVP_SPEC §4・§7・§7.1、ARCHITECTURE §11、SECURITY §12、DEV-196c の migration `supabase/migrations/20261111000000_sales_demo_versions.sql` と `.ai/reviews/DEV-196c.md`。

**全 PR に共通**: 旗 `SALES_DEMO_VERSIONS_ENABLED` (既定で無効) の後ろ。無効のとき新しい route は 404、今日の画面・React のデモ・送信は変わらない。環境変数は名前だけで、値はどこにも登録しない (Vercel・`.env` の値・workflow の変更なし)。共有の scope `p` は作らない (常に 404)。新しい migration・Protected Scope の変更・権限の拡大が要るときは実装せずに止まって報告する。

## 196d-1: 旗・文言・比較・view model (unit だけ)

branch `feature/dev-196d-1-foundation` (`origin/develop` ae2720a から)。route・頁・component・DB・next.config の変更なし。足したのは `lib/sales/demo-version/` の 4 つの module とその unit テストだけで、どの app の route・頁・component からもまだ import されていない (`purity.test.ts` の「app から import されない」の検査はそのまま通る)。

| module | 中身 | 仕様 |
|---|---|---|
| `flags.ts` (`server-only`) | `SALES_DEMO_VERSIONS_ENABLED` は `"true"` ちょうどだけ有効 (`TRUE`・`1`・前後の空白は無効)。無効なら他の設定を読まない (テストで固定)。`SALES_DEMO_VIEW_SIGNING_KEY` は base64 / base64url (padding 任意、正準の綴りだけ、2 つの alphabet の混在・空白・改行は拒否) で 32 bytes 以上。足りない・形が違えば null (token を発行しない)。`SALES_DEMO_ARTIFACT_ORIGIN` は unset / set / invalid (空文字も invalid。unset と取り違えない)。env は引数で、この module は env を読まない (purity の規則を緩めずに済む) | §6.2・§6.4 手順 1・§6.8、ARCHITECTURE §9 |
| `admin-messages.ts` | 管理画面の文言をすべて固定の符号から引く。管理者の 5 つの RPC 関数 (品質承認・取り下げ・版の取り消し・画像の取り消し・`sales_demo_assert_no_open_send`) が raise する符号すべてに日本語がある (テストが migration から符号を読んで照合)。状態・権利・7 項目 (3・4・5 に「どうなら問題あり」の hint)・取り消しの固定の理由 (`^[A-Z][A-Z0-9_]{2,47}$`)・取り下げ / 取り消しの確認文・AI の赤い印・「事実の偽装なし」の固定の文 | §4.6・§6.6・§7.2・§8.1・§9.5 |
| `compare.ts` | manifest の差分 (名前と sha256)、copy の行の LCS 差分 (事実の行と創作の見出しを区別、上限: 片側 2000 行・1 行 2000 字・共通の頭と尾を除いた DP 200 万 cell。超えたら `TOO_LARGE`)、構造記述子の 8 つの観点の差分 (structure の module は import しない。語彙の形 `[a-z_]` の語だけを表示し、自由文は出さない)、hash・事実・worker commit・検査の符号・権利の要約の差分、既定の比較相手 (承認済みの版 → 親 → なし) | §4.1・§7.2・§7.5 |
| `view-model.ts` | 管理者の RLS のセッションが読む行から画面の内容を導く。プレビューは `canAdminPreview` と全画像の権利 (`sales_demo_image_previewable` と同じ: 許された状態・取り消しなし・JST の暦日で期限内) の両方。画像の行の sha256 がファイルと違えば権利は無いものとして扱う。1 枚でも使えなければ版ごと出さない。判定の可否は `sales_review_demo_version` が全判定に課す条件 (状態・demo の無効・事実の変化・検査・権利)、承認はさらに必須の描画 2 つ、版のすべての描画画像を画面で表示できること (`RENDER_UNVIEWABLE`: RPC は版の render のファイルすべてを見たことを承認に要求するので、表示できない viewport や寸法の無い render があれば承認を出さない)、`send_opened` が無いこと。阻む理由ごとの固定の文言は `APPROVE_BLOCKER_LABEL`。事実の hash が読めないときは「同じ」と言わない。出所は日付・承認 ID の有無・prompt の hash の頭 8 字だけ (モデル名・生成の手段の自由文は出さない) | §4.6・§6.1・§7.2・§8.1〜§8.3・§9.2〜§9.5 |

### オーナーの要求と DEV-196c の Low

- **品質基準を正しく判断できる**: 7 項目の文言と hint (3「店名を入れ替えても成り立つなら問題あり」、4「帯やカードを積み重ねただけなら問題あり」、5「SP が PC の縮小・横はみ出し・読めない・PC の間延びなら問題あり」)。テンプレート化の警告は「参考」と明記 (止めない)。画面に使うのは 196d-3・196d-5。
- **Low (a)** (note の規則が `style.css` などを拒否する): `INVALID_NOTE_MESSAGE` に「`style.css`・`example.com` のように『.』の後に英字が続く語は書けない、言い換えるか『.』を外す」と具体的に書いた。form での事前の確認と表示は 196d-5。
- **Low (d)** (品質承認で送信が止まる警告): `APPROVAL_STOPS_SENDING_BEFORE` / `_AFTER` と、view model の `sendStoppedBy` (承認済みの版があれば理由の一覧。今は版での共有が無効なので常に `versioned_sharing_disabled`、AI 画像・写真があればそれも)。画面に出すのは 196d-5・196d-7。
- **Low (c)** (画像ごとの偽装なしの確認を管理者の操作に): view model に `needsImpersonationConfirm` / `impersonationConfirmImageIds` と固定の文 `NO_IMPERSONATION_STATEMENT`。**記録の方法は DB の変更が要る見込み** (下の「判断が要ること」)。
- **Low (b)** (生成時の事実の hash の照合): **DEV-196e (WSL ingest) へ送る** (coordinator 決定 2026-11-11)。196d のどの PR でも扱わない。
- 権利不明・事実の未確認は fail closed (画像 1 枚で版ごと不可、事実が読めなければ「同じ」と言わない)。取り消し後に別のデモへ切り替えないことは確認文に明記 (`REVOKE_CONFIRM_TEXT`)。

### 判断が要ること (coordinator へ) と決定 (2026-11-11)

1. **Low (c)**: `sales_demo_images` の `no_factual_impersonation_confirmed_at/_by` は ingest の挿入時に入り、行は trigger で不変 (`demo_image_immutable`)。`ai_concept_internal` の table の check もこの 2 列を挿入時に要求する。管理画面のボタンで画像ごとに記録するには、新しい管理者の関数 (例: 画像 id と sha256 を受け、確認した管理者と時刻を別の列か別の表に追記する SECURITY DEFINER の関数) と、品質承認の関数がその確認を要求する変更が要る = **新しい migration**。196d-5 では DB を変えずにできる範囲 (画面で画像ごとの確認を必須にし、sha256 を server action で照合) まで実装し、DB の変更は止まって報告する予定。**決定**: そのとおり。196d-5 で関数の signature・grant・trigger・テストまで具体的に報告し、migration は書かない。
2. **Low (b)**: `sales_ingest_demo_version` は事実の hash を DB で計算するだけで、worker の申告を受ける引数が無い。照合するには ingest の関数の引数 (または upload の API の begin の段) の変更 = **DB の変更**。7 つの PR の中に ingest / upload の API は無いので、どの PR で扱うか (または DEV-196i へ送るか) の判断が要る。**決定**: DEV-196e (WSL ingest) へ送る。

### テスト

- unit: `tests/unit/sales/demo-version/` に `flags.test.ts`・`admin-messages.test.ts`・`compare.test.ts`・`view-model.test.ts` を追加、`purity.test.ts` の module 一覧に 4 つを追加 (env を読まない・I/O なし・app から import されない、の規則は変えていない)。
- 結果 (2026-11-11、worktree、develop ae2720a + この branch): `npx vitest run tests/unit/sales/demo-version tests/unit/ai-tasks.test.ts tests/unit/guardrails.test.ts` 20 files / 647 tests 合格。`tests/unit/sales` 全体も合格。`npx tsc --noEmit`・eslint (変更した dir)・`npm run check:secrets`・`npm run build` 合格。
- 全 unit (`npx vitest run`) では `tests/unit/design-agent/**` の Chromium を起動するテストだけが落ちる。container の `/opt/pw-browsers` にあるのは `chromium_headless_shell-1194` で、repo の Playwright が探す `-1234` が無いため (環境の問題。この PR は触れていない)。196d-2 以降の e2e では対処が要る。**決定**: ローカルだけ、commit しない上書き (env か未 commit の config で `executablePath: '/opt/pw-browsers/chromium'`) で既存の browser を使う。commit する Playwright の設定と CI は変えない。e2e の正本は CI。各 PR で、ローカルで何をどう走らせたかをこの記録に残す。

### review round 1 (coordinator の独立レビュー、d456ee9: C0 H0 M0 L5) と修正

| # | 指摘 | 修正 | 回帰テスト |
|---|---|---|---|
| L1 | `compare.ts` の `rightsCounts` が素の `{}` で、`constructor` などの key が `Object.prototype` を読み抜ける | 結果は `Object.create(null)`、読むのは `RIGHTS_STATUSES` の既知の状態だけ (`Object.hasOwn`)。`compareVersionMeta` の権利の行も既知の状態だけ (`RIGHTS_STATUSES` の順) | `compare.test.ts` 「review round 1 L1」(`constructor`・`__proto__`・`toString`・未知の状態) |
| L2 | `lineage` が再帰で、20,000 版の鎖で stack overflow。`children.set` の spread と版ごとの `o.files.filter` が二乗 | 明示の stack で辿る (pre-order は同じ)、子の一覧は push、ファイルと判定は Map で 1 回だけ版ごとに分ける。画面の系譜は `LINEAGE_DISPLAY_LIMIT` (200) 行までで、残りは `lineageHidden` の件数 | `view-model.test.ts` 「review round 1 L2」(20,000 版の鎖、`lineage` と `buildDemoVersionsView` の両方) |
| L3 | 読めない `expires_at` が NaN で期限切れ扱いにならない | 読めない日時は期限切れ (判定できない)。`canAdminPreview` と同じ fail closed | 「review round 1 L3」 |
| L4 | `sendStoppedBy` が共有できるかだけ | `sendStop: { code, reasons, factsUnknown }`。`sales_demo_version_send_block` と同じ順で `demo_version_unavailable` (行が無い・approved でない・取り消し・期限切れ・読めない期限) → `demo_quality_not_approved` (bundle と facts が一致する有効な品質承認が無い) → `demo_facts_changed` → `demo_not_shareable` (+ 理由)。事実が読めなければ `factsUnknown`。文言は `SEND_BLOCK_LABEL` / `SEND_BLOCK_FACTS_UNKNOWN_TEXT`。`QualityReviewDb` に `bundle_sha256`・`facts_sha256` を足した | 「review round 1 L4」(view model の全分岐) と `admin-messages.test.ts` (migration の関数が返す符号すべてに文言) |
| L5 | `facts: "unknown"` が承認を止めない | 承認の阻む理由に `FACTS_UNKNOWN` (修正の依頼と却下は止めない)。文言は `APPROVE_BLOCKER_LABEL.FACTS_UNKNOWN` | 「review round 1 L5」 |

196d-5 への申し送り (coordinator):
- 画像ごとの AI の確認は `approveBlockers` に無い。server action が画像 id と sha256 をサーバーで照合して強制する。
- `ReviewView.invalidatedReason` は `INVALIDATED_REASON_LABEL` を通してだけ表示し、生の文字列は出さない (型の注記に書いた)。

結果 (2026-11-11): `npx vitest run tests/unit/sales/demo-version tests/unit/ai-tasks.test.ts tests/unit/guardrails.test.ts` 653 tests 合格。`npm run typecheck`・eslint (変更した dir)・`npm run check:secrets`・`npm run build` 合格。

## 196d-2: 成果物の route `/demo-frame/a/[token]/[...path]` と Storage の読み出し (p は常に 404)

branch `feature/dev-196d-2-preview-route` (`origin/develop` 68298eb から)。DB・migration・next.config・proxy.ts・workflow の変更なし。旗 `SALES_DEMO_VERSIONS_ENABLED` は既定で無効のまま (値はどこにも登録していない。旗を立てるのはテストの process の中だけ)。

| file | 中身 |
|---|---|
| `lib/demo-frame/serve.ts` (`server-only`) | 判定の本体。読み出しは注入 (`FrameStore`)。§6.4 の 7 つの検査: (1) 旗が `"true"`・署名鍵あり・この origin が scope `a` を出してよい (2) token の形・HMAC・期限・scope (3) 版が在り token の demo に属し、取り消しなし・draft / approved / superseded・`expires_at` 内、`storage_prefix` が `v1/<demo>/<version>/` (5) URL の path を §5.2 の表で manifest の名前に写し、版のファイルに在り、役割と型が名前どおり (query・`%`・`..`・`page/…` は落ちる) (6) `Sec-Fetch-Dest` が役割どおり (DB を読む前に確かめる) (7) bucket から読み、大きさ・sha256・UTF-8 / magic bytes・画素の大きさ・metadata を manifest と照合してから返す。加えて版の全写真の権利が今プレビューできること (§8.1、1 枚でも不可なら版のどのファイルも 404。view model と同じ規則)。どれが外れても**同じ 404** (`demoFrameNotFound`: 状態・本文・ヘッダが同一、`no-store`)。例外も 404。ログを書かない。応答のヘッダは DEV-196b の `artifactResponseHeaders` |
| `lib/demo-frame/store.ts` (`server-only`) | service role の読み出し (版・ファイル・画像の権利の行・bucket の object)。失敗はすべて「無い」(null / [])。object は manifest の bytes を超えたら読まない |
| `app/demo-frame/a/[token]/[...path]/route.ts` | GET だけが判定へ。他の method は同じ 404。cookie を読まない (`proxy.ts` の matcher は `/admin/:path*` のまま) |
| `app/demo-frame/[[...rest]]/route.ts` | それ以外の `/demo-frame/**` (共有の scope `p` を含む) は旗に関係なく同じ 404。`p` の route は作っていない |

判断したこと:
- **origin**: `next start` の `request.nextUrl.origin` は設定の hostname (`localhost`) を返し、ブラウザが使った host (`127.0.0.1`) と違うことを e2e で見つけた。そのままだと `frame-ancestors` が本物の親を拒む。`Host` と `x-forwarded-proto` (Vercel が付ける) から求め (`requestOrigin`)、`servingOrigin` / `normaliseOrigin` が https (またはローカルの http) 以外を落とす。値はこの要求の、cache されない応答の CSP にだけ入る。
- **専用の artifact origin が設定されたとき** (`SALES_DEMO_ARTIFACT_ORIGIN`) は 404 にした。その origin から出すには `frame-ancestors` に名指すアプリの origin の設定が要り、DEV-196g の承認の範囲のため。未設定 (今の状態) ではアプリの origin から管理者だけの暫定 (§6.8) で出す。**coordinator 確認済み (2026-11-11)**: DEV-196g の範囲、fail closed のまま。
- view model の `effectiveRights` の引数の型を `Pick<DemoImageDb, "revoked_at" | "rights_status" | "rights_expiry">` に広げた (中身は不変。route は権利の 3 列だけを読む)。

テストの fixture:
- `tests/support/solid-webp.ts`: 単色の可逆 WebP (VP8L) を書く小さな encoder (依存を足さない)。画像の sha256 は表で unique なので、run ごとに違うバイト列が要る。libwebp (sharp、確認の 1 回だけで commit していない) で復号できることと、`checkFileBytes` を通ることを確かめた。
- `tests/support/seed-demo-version.ts`: 架空の店の demo に `sales_ingest_demo_version` (service role) で版を 1 つ入れ、storage の API があればローカルの非公開 bucket へ upload する。

### テスト

- unit: `tests/unit/demo-frame/serve.test.ts` (21 件: 4 種類のファイルの 200 とヘッダの一致、旗の無効 6 通りで store を一度も作らない、鍵・artifact origin・method・query・origin、path の 15 通り、token 7 通り、`Sec-Fetch-Dest` 9 通り、版 11 通り、manifest、権利 7 通り × 全ファイル、バイト列 5 通り、store の例外、`splitFramePath`・`requestOrigin`)、`tests/unit/demo-frame/guardrails.test.ts` (9 件: route のファイルの一覧、cookie・session・ログ・Storage の URL・`srcdoc` を持たない、env を読むのは admin の route だけ、`p` の route が無い、proxy の matcher、next.config のどの規則も `/demo-frame` に当たらない = `X-Frame-Options` が付かない)。
- 統合 (`tests/integration/demo-frame.test.ts`、7 件): store の読み出し、旗の無効で 404、draft の版の全ファイルを bucket からバイト単位で返す、管理者の `sales_revoke_demo_version` の直後から全ファイル 404、`sales_revoke_demo_image` で版の全ファイル 404、bucket の object の差し替え・削除で 404、別の版を指す token で 404。Storage を読む 2 件は storage の API が無いとき (CI の `-x storage-api`) skip。
- e2e (`tests/e2e/demo-frame.spec.ts`、desktop だけ 5 件): suite の server (旗は無効) で有効な token も同じ 404。旗を立てた**2 つ目の server** (同じ build、このテストの process の中だけで旗と鍵を渡す) で: 拒否 8 通りの 404 が旗の無効の 404 と同一、scope `p` は全ファイル 404、直接開く (`document`)・`Sec-Fetch-Dest` なし・POST は 404、管理者の外枠の代わりの頁の `sandbox=""` の iframe で **opaque origin** (`window.origin === "null"`、親から `contentDocument` が null)、inline の script が動かない、`document.cookie` に管理者の cookie が無い、写真が sandbox の中で表示される、外部 (`example.com` の css・`@import`・背景・img) への要求はすべて CSP で止まり network に出ない (route の網でも 0 件)、成果物の副要求に cookie が付かない、管理者の関数で取り消すと次の要求から全ファイル 404。Storage を読む 2 件は storage の API が無いとき skip (CI)。
- ローカルで走らせたもの (2026-11-11、隔離した stack `sr-dev196d`・port 564xx、scratch の config。repo の `config.toml` は変えていない。Storage あり): unit `tests/unit/demo-frame tests/unit/sales tests/unit/ai-tasks.test.ts tests/unit/guardrails.test.ts` 1181 件合格。全 unit は `tests/unit/design-agent/**` の Chromium の版の不一致 (196d-1 と同じ環境の問題) 以外すべて合格。統合の全体 24 files / 446 件合格。e2e の全体 123 passed / 5 skipped (新しい spec の mobile の複製)。storage の container だけ止めて CI と同じ状態でも確かめた: e2e 3 passed / 2 skipped、統合 5 passed / 2 skipped。`npm run lint`・`typecheck`・`check:secrets`・`build` 合格。
- Chromium (coordinator の決定どおり): commit しない上書きとして、既存の `playwright.config.ts` が読む環境変数 `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` を scratch の env file で渡した。commit する設定・CI は変えていない。

### 判断が要ること (coordinator へ)

- CI の `e2e-sales` と `integration` は Supabase を `-x storage-api` で起動するため、bucket を読む e2e 2 件 (opaque origin・cookie・外部要求 0 件・取り消し) と統合 2 件は CI では skip になる (DEV-196c と同じ扱い)。CI でも走らせるには workflow の変更 (storage-api を除外から外す) が要り、これは人の承認が要る。

### 196d-2 review round 1 (coordinator の独立レビュー、296ed93: C0 H0 M0 L3) と CI で走る検査の追加

| # | 指摘 | 修正 | 回帰テスト |
|---|---|---|---|
| L1 | 統合の「版の取り消し」「写真の取り消し」は、storage の無い CI では object が無いことで 404 になり、取り消し・権利の検査を消しても通ってしまう | その 2 件 (と別の版を指す token の 1 件) は、本物の DB の store に、**テストの中で** `object()` だけを seed したバイト列に差し替えた store を渡す (`serveDbOnly`。本番の route に切り替えは無い)。まず 200 を確かめてから取り消し、404 を確かめる | storage を止め、`serve.ts` から取り消し・権利・demo の無効の検査を消すと、この 3 件が落ちることを確かめた (変異の確認、元に戻した) |
| L2 | `storageAvailable` が bucket の欠落なども「届かない」として静かに skip する | `storageStatus`: skip するのは network の失敗か、gateway (Kong) 自身の応答 (`message` だけの body) の 404 / 500 / 502 / 503 / 504 だけ (storage の container を止めたときの実際の応答は 500 `{"message":"An unexpected error occurred"}`)。bucket の欠落 (storage-api の `NoSuchBucket`)・公開の bucket・認証の誤り・storage-api の 500・HTML の 502 などは**throw してテストを落とす**。skip には理由を出す | `tests/unit/demo-frame/storage-status.test.ts` (4 件) |
| L3 | scope `a` が `sales_demos.disabled_at` を見ていない | store に `demo()` を足し、demo が無い・別の demo・無効 (管理者の判断か DNC) なら全ファイルで同じ 404 (fail safe)。管理者のプレビューも止まる | unit「review round 1 L3」(3 通り × 全ファイル、store の例外にも `demo`)、統合「review round 1 L3」(200 の後に `disabled_at` を立てて全ファイル 404、CI でも走る) |

CI で走る、header の検査 (coordinator の指示):
- `tests/unit/demo-frame/route.test.ts` (9 件): **本物の route handler** を import し、store の module だけを `vi.mock` でテストの中で差し替える (本番の route にテスト用の道・実行時の切り替えは無い)。HTML の応答で: CSP の `sandbox` が token なし・`allow-` がどこにも無い、`default-src 'none'`、`script-src`・`connect-src`・`frame-src`・`form-action` など 12 の指令が `'none'`、`style-src` / `img-src` はこの token の path だけ、`frame-ancestors` はブラウザが使った host、どの指令もそれ以外の host を名指さない (= 外部への要求 0 件の根拠)、`Set-Cookie` なし、`X-Frame-Options`・CORP・CORS なし、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy` は全部 `=()`、`Cross-Origin-Opener-Policy: same-origin`、`no-store`。要求の cookie で応答が変わらない。CSS と画像は `default-src 'none'`・nosniff・cookie なし。旗の無効・artifact origin の設定・他の method・catch-all は同じ 404 で store を作らない。

**ローカルだけで確かめている性質** (owner の承認で CI の workflow が変わるまで。coordinator が owner に上げる):
- ブラウザの中での振る舞い: 本物の 200 の HTML を `sandbox=""` の iframe に入れたときの opaque origin (`window.origin === "null"`、親から `contentDocument` が null)、inline の script が動かないこと、`document.cookie` から管理者の cookie が読めないこと、外部の css・`@import`・背景・img が CSP で止まり network に出ないこと、成果物の副要求に cookie が付かないこと、本物の 200 での `frame-ancestors`、写真が sandbox の中で表示されること (e2e の 2 件)。
- bucket からバイト列をそのまま返すこと、object の差し替え・削除で 404 になること (統合の 2 件)。
- CI で走るのは、それらの根拠となるヘッダ (上の route test)・判定のすべての分岐 (serve test)・DB の検査 (統合、`object()` を差し替えた 6 件) と、e2e の 3 件 (旗の無効の 404 の同一性、scope `p`、直接開く)。

結果 (2026-11-11): unit `tests/unit/demo-frame` 44 件、`tests/unit/demo-frame tests/unit/sales tests/unit/ai-tasks.test.ts tests/unit/guardrails.test.ts` 全部合格。統合 `demo-frame` 8 件 (storage あり 8 passed / storage を止めて 6 passed・2 skipped)。e2e `demo-frame` (storage あり 5 passed / 止めて 3 passed・2 skipped)。lint・typecheck・check:secrets・build 合格。unit (demo-frame + sales + ai-tasks + guardrails) 1195 件、統合の全体 24 files / 447 件合格。

## 196d-3: 閲覧だけの版の頁 `/admin/sales/demos/[prospectId]` と next.config の CSP

branch `feature/dev-196d-3-preview-page` (`origin/develop` 59260b9 から)。DB・migration・workflow・依存の変更なし。承認・取り消し・今日の印は入れていない (196d-5〜7)。

| file | 中身 |
|---|---|
| `app/admin/sales/demos/[prospectId]/layout.tsx` | 門: 旗が無効なら何も読まずに 404 → `requireAdminPage` → 店に demo があるか (管理者の session)。**loading.tsx の境界の外**に置いた。境界の中の `notFound()` は 200 で流れ始めた後なので状態を変えられない (Next の docs「loading.js › Status Codes」「not-found › trade-off」)。e2e で 200 になるのを見つけて直した |
| `app/admin/sales/demos/[prospectId]/page.tsx` + `loading.tsx` | 版の一覧と系譜、選んだ版 (`?v=`、無ければプレビューできる最新) の描画画像と生の頁のタブ、事実、権利、送信が止まる理由と承認の前の警告、阻む理由。空 (版なし)・DB の誤り (`role=alert`)・署名鍵なし / 形の誤り / artifact origin の設定 (表示しない)・取り消し / 権利不明 / 期限切れ (表示しない、ほかの版へ切り替えない)・読み込み中 (skeleton)・15 分の token の期限 (再読み込み) |
| `lib/admin/demo-versions.ts` (`server-only`) | 行はすべて管理者の session (RLS) で読む。例外は今の事実の hash: `sales_demo_facts_sha256` は service role だけが実行できるので、管理者を確かめた後に、その 1 つの demo の computed field として service role で読む。失敗したら「不明」(同じとは言わない、承認は FACTS_UNKNOWN で止まる)。view token は view model がプレビューできると言う版だけ、鍵があり artifact origin が未設定で demo が無効でないときだけ署名する |
| `components/admin/demo/` | `RenderPane` (PC1440 / SP390 / あれば tablet 768 を、それぞれの縦の scroll 枠に全ページ。PC は枠に合わせる / 実寸、SP は常に 390px の 1:1。画像の下の sentinel が枠の中で見えたら「最後まで表示しました」と `data-viewed="true"`、196d-5 の確認で使う)、`LiveFrame` (`sandbox=""`・`referrerPolicy="no-referrer"`・`loading="lazy"`・`allow` なし・srcdoc なし、PC/SP の幅の切り替え、「判断の基準は描画画像」)、`PreviewTabs` (生の頁はタブを選ぶまで mount しない)、`VersionList`・`FactsPanel` (無い事実は 未確認、email は出さない、事実が同じ / 変わった / 不明)・`RightsPanel` (AI 概念画像に赤い「AI生成・管理者だけ・共有不可」、権利不明は「権利不明のため使用不可」で画像を出さない、出所は日付・承認の記録の有無・prompt の頭 8 字だけ)・`VersionNotices` (送信が止まる理由 `SEND_BLOCK_LABEL`、`send_opened` の件数と今日の画面へのリンク、承認の前の警告 `APPROVAL_STOPS_SENDING_BEFORE`、阻む理由)・`TokenExpiry`。文言はすべて固定の label。操作のボタン・form は無い |
| `next.config.ts` | `/admin/sales/demos/:path*` の規則を `/admin/:path*` の**後**に足し、CSP だけを `frame-ancestors 'none'; frame-src 'self'` にする (同じ key は後の規則が勝つ: Next「headers › Header Overriding Behavior」)。`X-Frame-Options: DENY` ほか管理画面のヘッダは不変。ほかの管理画面の CSP は `frame-ancestors 'none'` のまま。値は DEV-196b の `outerFrameSrc` (管理者の頁・artifact origin なし) と一致することをテストで固定。専用の origin (DEV-196g) で `'self'` を置き換える |

### テスト

- unit `tests/unit/admin/demo-versions-page.test.tsx` (19 件): 描画の枠 (PC は fit、SP は 390px、画像は全体の寸法、sentinel、未表示から始まる)、iframe の属性が `sandbox=""` ちょうど・`allow`・srcdoc なし、生の頁はタブまで mount しない、事実の 未確認 と email の除外、権利の赤い印・権利不明で画像なし、警告と阻む理由・送信が止まる理由、系譜の順と選択、next.config のヘッダの解決 (demos の頁 / ほかの管理画面)、**`allow-same-origin` が app・components・lib のどこにも無い** guardrail と、管理画面の demo の iframe がすべて `sandbox=""`、loader (旗の無効と id の形で何も読まない、取り消した版に token を出さない、鍵なし・形の誤り・artifact origin・demo の無効で token なし、事実の不明、DB の誤り / 行なし)。
- 統合 `tests/integration/demo-versions-page.test.ts` (3 件、CI でも走る): RLS の読み出しと service role の computed field の事実の hash が ingest の値と一致 (`same`)、事実を変えると `changed`、demo の無効で token なし、管理者でない session は not found。
- e2e `tests/e2e/demo-versions-page.spec.ts` (desktop で 7 件。1440 と 390 は test の中で viewport を設定): suite の server (旗は無効) で管理者にも 404・`/admin/sales` の DENY と CSP は不変、旗を立てた server で頁のヘッダ (`frame-ancestors 'none'; frame-src 'self'`・DENY・no-store)、ほかの管理画面は不変、知らない prospect は 404、一覧・事実 (未確認)・権利・警告、操作のボタン無し、iframe の `sandbox=""` ちょうど (`allow`・srcdoc なし)。Storage があるとき: PC 1440 と SP 390 の両方で 2 つの描画画像が縦に最後まで scroll でき (画像は自分の縦横比のまま全体が配置され、枠の scrollHeight ≥ 画像の高さ、最下端まで届く)、sentinel で「最後まで表示しました」、PC の実寸は 1440px で頁は横にはみ出さない、frame の中は opaque origin。Storage が無いとき (CI) は表示の 2 件だけを理由つきで skip。
- `tests/unit/sales/demo-version/purity.test.ts`: DEV-196b の「app から import されない」を、**承認された DEV-196d の頁と component の正確な一覧だけが import してよい**に変えた (それ以外の頁・`proxy.ts`・今日の画面からの import は落ちる)。緩めたのではなく、許す範囲を名指しで固定した。
- 結果 (2026-11-11、隔離した stack `sr-dev196d`、Storage あり): unit `tests/unit/admin tests/unit/demo-frame tests/unit/sales tests/unit/ai-tasks.test.ts tests/unit/guardrails.test.ts` 1214 件合格。全 unit は環境の Chromium を `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で渡すと design-agent の browser のテストも実際に走る (遅い)。その実行で design-agent 以外の失敗は上の purity の 1 件だけで、直した。統合の全体 25 files / 450 件合格。e2e の全体 130 passed / 12 skipped (旗を立てる 2 つの spec の mobile の複製)。lint・typecheck・check:secrets・build 合格。
- 目で見た確認: 1440 と 390 の全ページの screenshot (commit しない一時の spec で撮り、消した)。1440 は PC と SP が横に並び、390 は縦に積まれ、頁は横にはみ出さない。

### 判断が要ること (coordinator へ)

- **事実の hash の読み出しに service role を使った** (上の `lib/admin/demo-versions.ts`)。DB の権限は変えていない。代わりに管理者の session で読むには、`sales_demo_facts_sha256` の `authenticated` への grant (= DB の変更) が要る。読まなければ全部の版が「事実が不明」になり、196d-5 で品質承認が常に止まる。
  **決定 (coordinator、2026-11-11)**: 次の条件をすべて満たす限り可。`authenticated` への execute の grant はしない。
  1. server だけ (`lib/admin/demo-versions.ts` は `server-only`)。
  2. 旗の確認と管理者の確認の後: layout と page が `requireAdminPage` を先に呼び、loader も旗を確かめ、さらに**管理者の session (RLS) でその demo の行が読めた後**にだけ読む (管理者でない session には行が無く、ここに届かない)。
  3. 検証した route の prospect id から RLS で引いた、1 つの demo の id だけ。
  4. 返すのは hash だけ (`id, facts:sales_demo_facts_sha256`)。
  5. client へは出さない: view model が same / changed / unknown に変える。
  6. どんな失敗 (誤り・例外・sha256 でない値) も「不明」で、承認は FACTS_UNKNOWN で止まる (`readFactsSafely`)。
  テスト (`tests/unit/admin/demo-versions-page.test.tsx`、3 件): 旗の無効・prospect が無い (RLS)・demo が無い・demo の誤り・版の誤りでは一度も呼ばれず、正常なときに 1 回だけその demo の id で呼ばれる。例外・null・sha256 でない値・大文字は不明で承認が止まる。読み出した hash は頁のデータのどこにも入らない。統合 (`tests/integration/demo-versions-page.test.ts`) で、本物の computed field の値が ingest の値と一致することを確かめている。

### 196d-3 review round 1 (coordinator の独立レビュー、5ef01a5: C0 H0 M0 L2 + nit) と修正

| # | 指摘 | 修正 | 回帰テスト |
|---|---|---|---|
| L1 (承認) | 「最後まで表示しました」の sentinel を mount 時から見ていた。描画画像が 404 (token の期限切れ・object なし) だと画像が alt の文に縮み、sentinel がすぐ見えて「見た」になる。196d-5 はこれで承認を許す | 画像が読み込まれ、**natural の幅と高さが manifest の値とちょうど一致したとき**にだけ見始める (`data-image="ok"`)。`onError`・大きさの違いは `broken` にして「見た」を戻し、「描画画像を表示できませんでした（表示期限切れの可能性…再読み込み）」を出す。src が変わる (token・版) と component ごと作り直す (`key={r.src}`)。hydration の前に読み込みが終わっていた画像も mount の後に一度確かめる | e2e「review round 1 L1」(**Storage なしで CI でも走る**): PC の描画を 404、SP を大きさの違う本物の WebP にして、枠を最下まで scroll し sentinel が枠の中に見えていても `data-viewed="false"` のまま、表示できない旨が出る。unit: server の markup は `loading`、見始める条件・`onError` の戻し・src の key を固定 |
| L2 (正確さ) | email を含む事実を 未確認 と表示していた (未確認ではない) | 固定の別の文「非表示（メールアドレスを含む）」(`data-fact-state="hidden"`、未確認の赤ではない)。上限で切った値には「…（以下略）」。メニューは email を含む項目を「（メールアドレスを含む項目は非表示）」と添え、13 件以上は「…（以下略）」 | unit「review round 1 L2」(電話の email、600 字の紹介文、ちょうど上限は切らない、未確認との区別、メニューの 2 通り) |
| nit | 文書は「取り消し・期限切れはリンクなし」だが全部リンクしていた。`expires_at` を過ぎた下書きは灰色にならなかった | 文書どおりにした: 取り消し、または期限切れ (状態・`expires_at`・読めない `expires_at`) の版は灰色でリンクなし (`versionGone`)、「表示しません」。頁から `now` を渡す | unit「review round 1 nit」(5 通り) |

結果 (2026-11-11): unit `tests/unit/admin` 25 件、`tests/unit/admin tests/unit/demo-frame tests/unit/sales tests/unit/ai-tasks.test.ts tests/unit/guardrails.test.ts` 1220 件合格。e2e `demo-versions-page` 8 件 (Storage あり 8 passed / 止めて 6 passed・2 skipped、L1 の検査は止めても走る)。lint・typecheck・check:secrets・build 合格。

### 196d-3 review round 2 (coordinator、差分 dc6dce4 → 89bda06)

L1 (RenderPane: 読み込みと大きさが一致してから「最後まで表示しました」)、L2 (FactsPanel: 「非表示（メールアドレスを含む）」と「…（以下略）」)、VersionList の nit (取り消し・期限切れはリンクなし・灰色) は、すべて直っていることを確認。新しい指摘なし: **C=0 H=0 M=0 L=0**。CI 11/11 green (89bda06)。merged (#248 → a178892)。

## 196d-4: 版の比較の頁 `/admin/sales/demos/[prospectId]/compare`

branch `feature/dev-196d-4-compare-page` (`origin/develop` a178892 から)。DB・migration・next.config・workflow・依存の変更なし。閲覧だけ (承認・取り消しなし)。

| file | 中身 |
|---|---|
| `app/admin/sales/demos/[prospectId]/compare/page.tsx` | 196d-3 の `[prospectId]/layout.tsx` の門 (旗・管理者・demo の有無で本物の 404) の下。頁でも旗と `requireAdminPage` を確かめてから読む。比べる 2 つ (`?a=&b=`、GET の form で選ぶ。書き込みなし)、見た目、中身・事実・検査・権利、構造記述子、頁の文、ファイル。空 (版なし)・比べる元なし (選ぶよう促す)・DB の誤り・鍵なしの状態。版の頁から「版を比べる」へリンク (版が 2 つ以上のとき) |
| `lib/admin/demo-compare.ts` (`server-only`) | `b` は指定 (無ければ最新)、`a` は指定 (無ければ承認済みの版 → `b` の親、DEV-196d-1 の `defaultBaseVersion`)。この demo の版だけ、`a = b`・形の違う id・別の demo の id は既定へ。中身・事実・worker commit・検査の符号・権利の数 (`compareVersionMeta`)、ファイル (`diffManifests`)、構造 (`diffStructure`、語彙の語だけ) は管理者の session で読んだ行から。**頁の文**は 2 つの版の `index.html` を server が非公開の bucket から読み (service role、spec §5.1・§6.8 の「Storage は server だけが読む」)、manifest と照合 (大きさ・sha256・UTF-8) してから DEV-196b の `checkArtifactHtml(...).texts` で見える文を取り出し、上限つきの LCS で行の差分 (`diffLines`) |
| `components/admin/demo/CompareVisual.tsx` | 2 つの版の全ページの描画画像を並べる (縦の位置の同期あり、切り替え可) か重ねる (不透明度の slider)。PC / SP の切り替え。画素の差分は出さない。読み込めない描画は「表示できませんでした」と出す。700px 未満では 2 枚を縦に積む (横に並べると 170px 幅になり、枠が scroll しなくなるため。e2e で見つけた) |
| `components/admin/demo/CompareTables.tsx` | 中身・事実・検査・権利の表、構造の 8 観点 (どちらも計測なしは同じと扱わない)、頁の文 (追加・削除・同じ、事実の行に「事実」)、ファイル。文言はすべて固定の label・固定の符号・語彙の語・頁自身の見える文 |
| `lib/admin/demo-versions.ts` | loader が読んだ行 (`rows`: 版とファイル) も server の中で返す (比較の頁が使う)。client へは出さない |
| `tests/unit/sales/demo-version/purity.test.ts` | import してよい正確な一覧に compare の頁と `CompareTables` を足した |

判断したこと・止まったこと:
- **copy record の差分は DEV-196e へ送る** (coordinator 決定 2026-11-11)。
- **copy record (`copy.json`) が保存されていない**: 計画の「copy.json の行の差分 (事実の行と創作の見出し)」は、DEV-196c が copy record を DB にも Storage にも保存しない (manifest の名前の規則と `sales_demo_version_files` の check に `copy.json` が無い) ため、元の資料が無い。保存するには **DB / manifest の変更** が要るので、その部分は作らずに止めた (coordinator へ報告)。代わりに頁の見える文の行で差分を出し、店舗の保存された事実と同じ文の行だけを「事実」とし、それ以外は「区別しない」(creative とは言わない) と画面に書いた。
- **頁の文のための Storage の読み出し (service role)**: coordinator 承認 (2026-11-11、下の round 1 の L1 の条件つき)。196d-3 の事実の hash と同じ条件で読む — server だけ、旗と管理者の確認の後、検証した prospect の demo の版だけ、**プレビューできる版 (取り消し・期限切れ・権利不明でない) で demo が無効でないとき**だけ (view token と同じ規則)、`index.html` だけ、manifest と照合してから、取り出すのは頁自身の見える文だけ (管理者は frame で同じものを見られる)。読めない・照合に落ちたら「文の差分は出せません」。

### テスト

- unit `tests/unit/admin/demo-compare.test.tsx` (9 件): 既定の組 (親 / 承認済みを優先)、指定・`a = b`・形の違う id・別の demo の id、版が 1 つ / 0、中身・ファイル・構造 (自由文を出さない)・文の差分 (事実の行、creative と呼ばない)、Storage は previewable な版の `index.html` だけを読み、取り消しの版・無効の demo では store を作らない、manifest と違うバイト列・無い object は使わない、表と見た目の component。
- 統合 `tests/integration/demo-versions-page.test.ts` に 2 件: 本物の行から既定の組と差分 (object はテストの中で差し替え、CI でも走る)、本物の bucket から 2 つの頁を読む (storage の service が止まっているときだけ理由つきで skip)。
- e2e `tests/e2e/demo-compare.spec.ts` (desktop で 6 件、1440 と 390): 旗の無効で 404、旗を立てた server で既定の組 v1-v2・ヘッダ (`frame-src 'self'`・DENY)・表、知らない prospect は 404、GET の picker で組を入れ替え・版の頁からのリンク。Storage があるとき: 文の差分 (変えた文の削除と追加、店名の行が「事実」)、PC 1440 と SP 390 で 2 枚が scroll でき、片方を最下まで動かすともう片方も最下へ、SP の切り替え、重ねる表示の slider、頁は横にはみ出さない。
- 結果 (2026-11-11、隔離した stack `sr-dev196d`): unit (admin・demo-frame・sales・ai-tasks・guardrails) 1229 件、統合の全体 25 files / 452 件、e2e の全体 137 passed / 19 skipped (旗を立てる 3 つの spec の mobile の複製)。storage の container を止めた状態 (CI と同じ): e2e `demo-compare` 3 passed / 3 skipped、統合 `demo-versions-page` 4 passed / 1 skipped。lint・typecheck・check:secrets・build 合格。

### 196d-4 review round 1 (coordinator の独立レビュー、cddd8c1: C0 H0 M0 L3) と修正

| # | 指摘 | 修正 | 回帰テスト |
|---|---|---|---|
| L1 (安全) | `pageTexts` が `checkArtifactHtml` の合否を見ずに文を使っていた。読み出しの大きさに上限がない。`<title>`・属性の文なども行に入る | サーバーの HTML の検査 (`checkArtifactHtml(...).ok`) に落ちた頁は文を一切出さない (`unavailable`)。`ARTIFACT_LIMITS.htmlBytes` を超える entry は**読み出す前に**断り、読み出した object が超えていても断る。文は `visibleBodyText`: `<body>` の見える text node だけ (head・`<title>`・svg の title / desc・`hidden` 属性の要素とその中・script / style / template / noscript・comment・属性の文は入れない)。DEV-196b の bounded parser と操作の予算で読む | unit: `<title>` だけの行・svg の title / desc・`[hidden]` の文が差分に出ない、`visibleBodyText` の 9 通り、`<script>` を含む頁は `unavailable`、上限を超える entry は v2 を読み出さない、上限を超える object も断る |
| L2 (正確さ) | 印のない行の説明が「創作の見出しか…」と決めつけていた | 「店舗の事実と完全には一致しない行（創作・事実を含む文などを区別しません）」に | unit (文言の一致と旧い文言の不在) |
| L3 (個人情報) | email を含む事実が `factValues` に入り、email を含む頁の行がそのまま表示されうる | email の判定と文言を `admin-messages.ts` に 1 つにし (`containsEmail`・`HIDDEN_EMAIL_LABEL`、FactsPanel も同じものを使う)、`factValues` は email を含む事実を入れない、頁の行で email を含むものは「非表示（メールアドレスを含む）」に置き換え、「事実」にしない | unit: `factValues` / `copyLines`、email の行が差分にも描いた一覧にもそのまま出ず、事実と同じでも「事実」にならない |

e2e の fixture: 架空の店の名前に「テスト」を含めない `shopName` を seed に足した (サーバーの HTML の検査は「テスト」を拒むため、L1 の後は文の差分が出なくなる)。

結果 (2026-11-11): unit (admin・demo-frame・sales・ai-tasks・guardrails) 1235 件、統合 `demo-versions-page`・`demo-frame` 13 件、e2e `demo-compare` 6 件・`demo-versions-page` 8 件 (Storage あり)。lint・typecheck・check:secrets・build 合格。

### 196d-4 review round 2 (coordinator、差分 cddd8c1 → b72efd7)

L1 (検査に通った頁の見える本文だけ・大きさの上限)・L2 (中立の説明)・L3 (email を出さない・事実にしない) は、すべて直っていることを確認。新しい指摘なし: **C0 H0 M0 L0**。
CI (b72efd7): `unit (1/2)` が一度だけ `tests/unit/design-agent/phase2f-live/steps.test.ts` の ENOENT (`image-request-A1.json`) で落ちた。この PR の外のテストで、ローカルでは 27/27 通る。落ちた job を一度だけ再実行して green、merge の時点 (9e2a1ae) ですべての検査が green。merged (#249 → 9e2a1ae)。

## 196d-5: 7 項目の品質承認と、画像ごとの「事実の偽装なし」の確認

branch `feature/dev-196d-5-quality-approval` (`origin/develop` 9e2a1ae から)。DB・migration・DB の関数・grant・next.config・workflow・依存の変更なし。書き込みは DEV-196c の `sales_review_demo_version` だけ (管理者の session)。

| file | 中身 |
|---|---|
| `lib/sales/demo-version/review-input.ts` (純粋) | `ReviewInput` (zod): 7 項目すべての `ok` / `ng` (既定なし・推測なし)、最後まで見た描画画像 (viewport → sha256)、画面の bundle hash、AI 概念画像ごとの確認 (画像 id と sha256)、送信が止まることの確認、メモ。`checkReview`: **今の DB から導き直した版** (view model) と照らす — bundle が違えば `STALE`、view model の阻む理由 (状態・demo の無効・事実の変化 / 不明・検査・権利不明 / 取り消し / 期限切れ・描画の欠け / 表示できない描画・`send_opened`) があれば `BLOCKED`、承認は 7 項目すべて ok・版のすべての描画を最後まで見た (`evaluateQualityDecision`)・確認あり・AI 概念画像のすべてを id と**今の** sha256 で確認 (欠け・余分・重複・違う sha は拒否)、修正 / 却下は ng が 1 つ以上、見たと言う描画はこの版の描画だけ、メモは下の規則 |
| `lib/sales/demo-version/review-client.ts` (純粋・import なし) | ブラウザが要る部分: メモの規則 `normaliseNote` (`sales_demo_note_valid` の写し、Low (a))、7 項目の順と強調 (quality.ts の写し。テストで一致を固定)。manifest / quality は node の組み込みを読むので client の form から import できない |
| `lib/admin/demo-review.ts` (`server-only`) | 旗 (無効なら何も読まず書かず拒否) → 入力の形 → 版を管理者の session で読み直して `checkReview` → `sales_review_demo_version` (管理者の session)。DB の拒否は固定の文言 (`demoVersionErrorMessage`) |
| `app/admin/sales/_actions/demo-versions.ts` | server action `reviewDemoVersion`: 旗 → `requireAdmin` → 上の core → `revalidatePath` |
| `components/admin/demo/QualityReviewForm.tsx` | 7 項目 (3・4・5 は強調と「どうなら問題あり」)、画像ごとの確認 (固定の文 `NO_IMPERSONATION_STATEMENT`・赤い印・縮小画像)、メモ (その場で Low (a) の文言)、**承認の前の目立つ警告** `APPROVAL_STOPS_SENDING_BEFORE` と明示の確認 `SEND_STOP_ACKNOWLEDGEMENT` (Low (d))、承認の後に `APPROVAL_STOPS_SENDING_AFTER`。初めから選ばれているものは無い。品質承認は「7 項目すべて問題なし・PC と SP (と tablet) を最後まで見た・画像をすべて確認・送信停止を確認・view model の阻む理由なし・メモが正しい」まで押せず、押せない理由を並べる。修正を依頼 / 却下は問題ありが 1 つ以上。下に貼りつく要約 (「7項目 5/7・PC✓・SP–・画像 0/1」) と 44px のボタン |
| `components/admin/demo/ReviewWorkspace.tsx` | 描画画像・生の頁・form が「最後まで見た」状態を共有する。form が受け取るのは RenderPane の (読み込みと大きさで守った) sentinel の結果だけで、手で入れられない |
| `components/admin/demo/ReviewHistory.tsx` | この版の判定の記録。判定・状態・無効の理由は固定の label だけ (`INVALIDATED_REASON_LABEL`、知らない符号は「理由を表示できません」、行の文字列は出さない) |
| `tests/support/seed-demo-version.ts` | AI 概念画像の版を作る option (取り込み時の確認は管理者の user id。画面での画像ごとの確認とは別) |

### DEV-196c の Low

- **(a) メモ**: form がその場で `INVALID_NOTE_MESSAGE` を出し、判定のボタンを止める。server も同じ規則で拒否し、DB の `invalid_note` も同じ文言。**規則の写しが DB の `sales_demo_note_valid` と一致することを、統合テストが 20 の例で照合**。
- **(d) 送信が止まる警告**: 承認の前に目立つ警告と明示の確認 (確認が無ければ server が `SEND_STOP_NOT_ACKNOWLEDGED` で拒否)、承認の後に止まった旨。頁の上部には 196d-3 の `sendStop` (DB の `sales_demo_version_send_block` と同じ順の理由)。
- **(c) 画像ごとの偽装なしの確認**: 画面で画像ごとの明示の確認、server が画像 id と今の sha256 で照合 (欠け・余分・違う sha は拒否、権利不明は版ごと拒否)。**DB に管理者の操作として記録する部分は作っていない (DB の変更が要る)。下に必要な変更を書いた。coordinator が owner に報告する。**

### Low (c) に要る DB の変更 (提案。migration は書いていない)

今の DB では: `sales_demo_images.no_factual_impersonation_confirmed_at/_by` は取り込み (`sales_ingest_demo_version`) の時に入り、行は `demo_image_immutable` の trigger で変えられない。`sales_review_demo_version` は画像の確認を受け取る引数を持たず、確認を調べない。だから「この管理者がこの品質承認のときに、この sha256 の画像を見て確認した」は DB に残らない (server action の照合だけ)。

1. **新しい表** `public.sales_demo_review_image_confirmations`
   - `review_id uuid not null references public.sales_demo_quality_reviews (id) on delete restrict`
   - `image_id uuid not null references public.sales_demo_images (id) on delete restrict`
   - `image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$')`
   - `confirmed_by uuid not null`、`confirmed_at timestamptz not null default now()`
   - `primary key (review_id, image_id)`
   - trigger: insert は下の関数の中からだけ (`confirmed_by = auth.uid()` かつ `sales_admins` に在る)、update / delete は拒否 (不変)。
   - RLS: `for select to authenticated using ((select public.is_sales_admin()))`。grant: `revoke all … from public, anon, authenticated, service_role`、`grant select to authenticated`、`grant select to service_role`。staging の `SECURITY_CHECKS` に「client の書き込み grant なし」を足す。
2. **`sales_review_demo_version` の変更**: 引数 `p_image_confirmations jsonb` (`[{"image_id": uuid, "sha256": hex}]`) を足す (旧い 6 引数の関数は drop して 7 引数で作り直す。`revoke all … from public, anon` / `grant execute … to authenticated`)。`p_decision = 'approved'` のとき:
   - 版の `role = 'photo'` のファイルが指す画像のうち `source_kind = 'ai_concept_internal'` の集合と、`p_image_confirmations` の `image_id` の集合が**ちょうど一致** (欠け・余分・重複は `impersonation_not_confirmed`)。
   - それぞれ `sha256` が `sales_demo_images.sha256` とファイルの `sha256` の両方に一致 (違えば `impersonation_not_confirmed`)。
   - 画像が `sales_demo_image_previewable` (既存の `rights_not_previewable` の検査の後)。
   - 品質承認の行を入れた後、同じ transaction で確認の行を入れる (`confirmed_by = auth.uid()`)。replay (同じ版の承認済み) は確認の行を足さない。
   - `p_decision` が承認でないとき、`p_image_confirmations` は空でなければならない (`invalid_input`)。
3. **テスト**: `tests/integration/demo-versions.test.ts` に — AI 概念画像の版は確認なし・一部・違う sha・余分で拒否、全部で承認され確認の行が管理者の id で残る、確認の行は update / delete できない、client の role から直接 insert できない、`db-security-audit` の grant の一覧、staging の検査。
4. **画面の側** (この PR で済み): `lib/admin/demo-review.ts` の rpc 呼び出しに `p_image_confirmations` を足すだけ (server の照合はそのまま残す)。

### 示さないもの

- 計画の「テンプレート化の警告 (3・4 の横に参考)」は出していない。`templateWarnings` は構造記述子の検査の結果 (`StructureFindingInput`) を要るが、DEV-196c はそれを保存していない (worker の検査の結果の保存は DEV-196e / 196i の範囲)。作り話の警告は出さない。

### テスト

- unit `tests/unit/admin/demo-review.test.tsx` (16 件): `ReviewInput` の形 (7 項目の欠け・余分・値、hash・id、余分な key)、`review-client` の写しが quality.ts と一致し import なし・client の form が node を読む module を import しない、`normaliseNote` (Low (a))、`checkReview` のすべての拒否 (STALE・BLOCKED (事実の不明・`send_opened`・承認済み)・ng・送り返しに ng なし・描画の未表示 / 違う sha / この版に無い描画・確認なし・メモ) と画像の確認 (欠け・違う sha・重複・余分・権利不明 / 取り消しで全判定を拒否)、core が RPC だけに決めた値で書くこと・旗の無効で何も読まない・拒否で RPC を呼ばない・DB の生の文を出さない、server action の順 (旗 → 管理者、管理者でなければ throw で何も書かない)、form の markup (何も選ばれていない・3 つのボタンが押せない・3・4・5 の強調・画像ごとの確認・警告と確認・要約)、履歴 (固定の label だけ)。
- 統合 `tests/integration/demo-review.test.ts` (8 件、CI でも走る): 承認が管理者の id・7 項目・見た描画とともに記録され `approved_version_id` が付く、旗の無効と管理者でない session で何も書かれない、STALE・項目の欠け・承認に ng・SP の未表示・違う描画・確認なし・知らない画像の確認で何も書かれない、AI 概念画像は id と今の sha256 で確認するまで承認できない、画像の取り消しで全判定を拒否、修正を依頼は ng が要り描画と確認は要らない、`style.css` のメモは Low (a) の文言で DB の前に拒否、メモの規則と DB の `sales_demo_note_valid` の一致 (20 例)。
- e2e `tests/e2e/demo-review.spec.ts` (desktop で 6 件、1440 と 390): 何も選ばれていない・修正を依頼は ng が要り管理者として記録 (Storage なしで走る)、`style.css` のメモで文言が出てボタンが止まる (Storage なし)、Storage があるとき: 7 項目 ok だけでは押せず、両方の描画を最後まで見ても確認が無ければ押せず、確認して承認 → 承認の後の文言・承認済み・送信停止の理由・form が消える (1440 と 390)、AI 概念画像は画像ごとの確認まで押せない。
- 196d-3 の e2e: 「操作のボタンなし」を「取り消しはまだ無く、判定のボタンは初め押せない」に変えた (196d-5 で判定が入ったため)。
- 結果 (2026-11-11、隔離した stack `sr-dev196d`、Storage あり): unit (admin・demo-frame・sales・ai-tasks・guardrails) 1253 件、統合の全体 26 files / 460 件、e2e の全体 143 passed / 25 skipped (旗を立てる 4 つの spec の mobile の複製)。storage の container を止めた状態 (CI と同じ): e2e `demo-review` 3 passed / 3 skipped (3 回続けて)。lint・typecheck・check:secrets・build 合格。
- 注: storage の container を**止めているその瞬間**に e2e を始めると、`storageStatus` が `beforeAll` で 1 度 throw した (止まりかけの storage-api 自身が答えたため。gateway の 503 `name resolution failed` は正しく「動いていない」と判定することを確かめた)。ローカルで container を止める操作の間だけの現象で、storage-api を起動しない CI では起きない。「想定外の答えは skip にせず落とす」は review of #247 L2 の意図どおり。

### 196d-5 review round 1 (coordinator の独立レビュー、5cfedb4: C0 H0 M0 L1) と修正

| # | 指摘 | 修正 | 回帰テスト |
|---|---|---|---|
| L1 (正確さ) | DB の `sales_demo_note_valid` の `\M` (語の終わり) は日本語の文字を語の文字として扱う。だから「style.cssです」「style.cssを直してください」は DB では通るが、`normaliseNote` は拒み、DB が受ける note で判定のボタンがすべて止まっていた | 語の終わりの判定を DB に合わせた: `(?=[/:]|[^\p{L}\p{N}_]|$)` (`u` flag。文字・数字・`_` が語の文字)。規則に頭の錨は無いので、前の文字 (「修正style.css」) は結果に関わらない (DB と同じ) | 統合のコーパス (`tests/integration/demo-review.test.ts`) に 18 例を足し、**全例で app = DB** を照合: 「style.cssを直す」「example.comです」「style.cssです」「index.htmlの余白」(通る)、「修正style.css」(前が日本語でも拒否)、「修正style.cssを直す」(通る)、「style.css。」「example.com、」「style.css）」(全角の句読点は語の文字でない → 拒否)、空白・`_`・ー・々・数字・`-`・全角コロン・`!` の後、「見出しv1.de」。DB が受けるものと拒むものの両方を含むことと、日本語に隣る 4 例の DB の値も明示して固定。unit にも 8 例 |

**DB の locale への依存**: `\M` の語の文字は DB の locale (`LC_CTYPE`) で決まる。ローカルと CI の DB は `datcollate = datctype = en_US.UTF-8`、encoding `UTF8` (確かめた)。この locale では日本語は語の文字。Staging / Production の locale が違って日本語を語の文字と見ない (たとえば UTF-8 でない `C`) なら、「style.cssを直す」は DB で拒まれ、app の事前の確認とずれる (app は通し、DB が `invalid_note` を返す。DB が判定者なので書き込みは安全側。画面は DB の拒否を Low (a) の同じ文言で出す)。上の統合テストは「style.cssを直す」などの DB の値を明示しているので、**その DB に対して走らせれば違いで落ちる**。Staging で確かめるなら (DEV-196h の Staging の承認の範囲で、今はしない): `select datctype from pg_database where datname = current_database()` と `select public.sales_demo_note_valid('style.cssを直す')` (true のはず)。DB は変えていない。

結果 (2026-11-11): unit (admin・demo-frame・sales・ai-tasks・guardrails) 1253 件合格、統合 `demo-review` 8 件、e2e `demo-review` 6 件、lint・typecheck・check:secrets・build 合格。

### 196d-5 review round 2 (coordinator、差分 5cfedb4 → 1616645)

L1 は直っている: app のメモの規則は DB と両方向で一致 (生成した 868 例と手で選んだ 35 例)。新しい指摘なし: **C0 H0 M0 L0**。CI (1616645) すべて green。merged (#250 → 11c44b7)。

## 196d-6: 品質承認の取り下げと版の取り消し (通常・急ぎ)

branch `feature/dev-196d-6-withdraw-revoke` (`origin/develop` 11c44b7 から)。DB・migration・DB の関数・grant・workflow・依存の変更なし。書き込みは DEV-196c の `sales_withdraw_demo_quality_review` と `sales_revoke_demo_version` だけ (管理者の session、service role の書き込みなし)。

| file | 中身 |
|---|---|
| `lib/sales/demo-version/lifecycle-input.ts` (純粋) | `WithdrawInput` (画面が見せた有効な品質承認の id・bundle hash・**2 段目の明示の確認 `confirmed: true`**)、`RevokeInput` (bundle hash・固定の理由 `REVOKE_REASONS`・急ぎかどうか・確認)。急ぎの理由は `URGENT_REVOKE_REASONS` (事実の誤り・権利の苦情・安全上の懸念) だけ。`checkWithdraw` / `checkRevoke`: 今の DB から導いた版と照らし、版がない・`STALE`・もう有効な承認でない・取り消せない状態・`send_opened` がある (`APPROVAL_OPEN`)・急ぎに普通の理由、を拒否 |
| `lib/admin/demo-lifecycle.ts` (`server-only`) | 旗 (無効なら何も読まず書かず) → 形 → 管理者の session で読み直し → 照合 → DEV-196c の関数。DB の拒否は固定の文言 |
| `app/admin/sales/_actions/demo-versions.ts` | `withdrawDemoApproval`・`revokeDemoVersion`: 旗 → `requireAdmin` → core → `revalidatePath` |
| `components/admin/demo/VersionLifecycle.tsx` | 取り下げ (`WITHDRAW_CONFIRM_TEXT` と送信への効果 `WITHDRAW_SEND_EFFECT_TEXT`)、通常の取り消し (理由は既定なしで選ぶ)、**見た目の違う急ぎの取り消し** (赤い枠・`URGENT_REVOKE_TEXT`・急ぎの理由だけ)。どれも 2 段 (選ぶ → 何が起きるかを読む → 確かめる)。`send_opened` があればすべて押せず、`APPROVAL_OPEN_MESSAGE` と今日の画面へのリンク (ここからは決着も取り消しもしない)。成功の後は**取り消した / 取り下げた版のまま** (`?v=` で同じ版に留まる、別の版や demo へ切り替えない、勝手に動く提案はしない) |
| `lib/sales/demo-version/view-model.ts` | `revokeCode` (`REVOKE_REASONS` の固定の符号だけ、それ以外は null) |
| 頁 | 取り消した版は「取り消し済みです（理由: …）。表示しません。ほかの版や React のデモへは切り替えません」で、描画画像・frame・判定の form・取り下げ / 取り消しの欄は出さない。理由は `REVOKE_REASON_LABEL` だけ |
| `lib/sales/demo-version/admin-messages.ts` | `WITHDRAW_SEND_EFFECT_TEXT`・`REVOKE_EFFECTS`・`URGENT_REVOKE_TEXT`・`LIFECYCLE_REFUSAL_LABEL` |

### 送信への効果 (DB がすることをそのまま書いた。coordinator の確認が要る点)

- DEV-196c の両方の関数は `sales_demos.approved_version_id` を null にする。`sales_demo_version_send_block` は承認済みの版が無ければ何も拒まない。だから**取り下げ・取り消し (承認版のとき) の後、この店舗の新しい送信は React のデモで承認できるようになる** (「デモを共有できない」の停止は外れる)。指示の「the send block returns」「sending blocked」とは逆なので、画面は DB の実際の動きを書いた (`WITHDRAW_SEND_EFFECT_TEXT`・`REVOKE_EFFECTS` の 3 つ目)。ほかの版を自動で品質承認することはない (テストで固定)。
- 送信済みの相手の共有 URL は、取り消した版を出さず 404 (ほかの版や React のデモへ切り替えない。共有の route は DEV-196g で、今は作っていない)。
- 取り消しの後、その版の view token と成果物の route は 404 (統合で、取り消し前に署名した token が 200 → 404 になることを確かめた)。

### 止めたこと (DB の変更が要る。coordinator へ)

1. **取り下げの理由**: 指示は「取り下げに必須の理由」だが、`sales_withdraw_demo_quality_review(p_review_id uuid)` は理由を受け取らず、`sales_demo_quality_reviews` に理由の列も無い。記録されない理由を選ばせるのは誤解を招くので、取り下げは**理由なしの 2 段の確認**で作った。理由を記録するには: 列 `withdrawn_code text check (withdrawn_code ~ '^[A-Z][A-Z0-9_]{2,47}$')` (`state = 'withdrawn'` のとき not null) と、関数の引数 `p_code text` (旧い 1 引数の関数は drop、`revoke … from public, anon` / `grant execute … to authenticated`)、`quality_review_final` の trigger の許す列への追加、テスト。
2. **急ぎの取り消しの記録**: DB は急ぎかどうかを記録しない (同じ `sales_revoke_demo_version`、違いは理由の符号の範囲と画面だけ)。急ぎの記録 (と、計画の「急ぎ」の DB の部分) は DEV-196f の範囲。記録するなら `sales_demo_versions` に `revoke_urgent boolean` と関数の引数。

### テスト

- unit `tests/unit/admin/demo-lifecycle.test.tsx` (11 件): 入力の形 (確認なし / false・知らない理由・余分な key)、`checkWithdraw` / `checkRevoke` の全分岐、view model の `revokeCode`、core が DEV-196c の関数だけに決めた値で書く・旗の無効で何も読まない・拒否で DB を呼ばない・DB の拒否を固定の文言で、server action の順 (旗 → 管理者)、panel の markup (1 段目だけ・理由の既定なし・急ぎは別の見た目と急ぎの理由だけ・`send_opened` で全部押せず文言とリンク)。
- 統合 `tests/integration/demo-lifecycle.test.ts` (6 件、CI でも走る、本物の関数): 取り下げ (管理者の id・下書きに戻る・承認版が外れる・送信停止が外れる・もう一つの版は下書きのまま)、旗の無効・管理者でない・STALE・別の判定・確認なし で何も変わらない、取り消し (管理者の id と理由・承認の無効化・承認版が外れる・親の版を代わりに承認しない・token を出さない)、**取り消しの後に成果物の route が 404** (取り消し前に署名した token、object はテストの中で差し替え)、急ぎの理由の範囲と拒否の各条件・二度目は取り消せない、`send_opened` のとき両方を固定の文言で拒否し送信の状態は変わらない (DB の関数も `approval_open` で拒む)。
- e2e `tests/e2e/demo-lifecycle.spec.ts` (desktop で 6 件、1440 と 390、Storage 不要): 取り下げの 2 段、取り消しの 2 段 (理由を選ぶまで押せない) と取り消した版に留まり描画も frame も form も出ない・もう一つの版はそのまま、390 で急ぎの取り消し (急ぎの理由だけ・404 を言う)、`send_opened` で押せず文言とリンク・送信の状態は変わらない。
- 196d-3 の e2e: 「取り消しはまだ無い」を「判定と取り消しのボタンは初め押せない」に変えた。
