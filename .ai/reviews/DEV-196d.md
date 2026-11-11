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
- **専用の artifact origin が設定されたとき** (`SALES_DEMO_ARTIFACT_ORIGIN`) は 404 にした。その origin から出すには `frame-ancestors` に名指すアプリの origin の設定が要り、DEV-196g の承認の範囲のため。未設定 (今の状態) ではアプリの origin から管理者だけの暫定 (§6.8) で出す。
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
