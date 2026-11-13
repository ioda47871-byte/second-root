# DEV-263i — hosted の取り込み: 管理画面の「版を取り込む」(Issue #263)

branch `feature/dev-263i-hosted-import`。Base: `origin/develop` 558f9cb1 (PR #270 DEV-263g の merge)。その後 PR #271 (DEV-263h、squash aadcc6cd) を merge commit で取り込んだ。範囲: コード・テスト・ローカルの検証・PR。**hosted (Staging / Production) には何も当てていない・送っていない。** migration なし。Vercel / env / DNS・bucket の作成・実店舗のデータ・実送信・Codex / 画像 / LLM・輪・workflow / package.json / lockfile / prompt / skill には触れていない。ローカルの検証は scratch に複製した別 project id のスタック (`sr-dev263i`、port 599xx、Storage あり) だけ。

## 何が足りなかったか

`import-local.ts` はローカルの Supabase だけ (`assertLocalSupabaseUrl`)。オーナーが本番で使うには、レビュー済みの v2 の包みを hosted の DB と private bucket へ入れる経路が要る。

## 選んだ形: 管理画面のアップロード (CLI ではなく)

CLI で hosted へ入れる案は、取り込みの RPC (`sales_ingest_demo_version`・`sales_record_copy_review`・構造の所見) と private bucket が **service role だけ**なので、admin の session では呼べない。呼べるようにするには、関数の grant と storage policy を広げる migration が要る (権限の拡大)。service role の鍵をオーナーの手元に置くのは避けたい。管理画面なら、server が admin の session を確かめた後に、server にある service role で書く — 既存の ingest API と同じ形で、権限を広げない。

### 3 段 (begin / put / finalize)、migration なし

Vercel の関数の要求は約 4.5MB まで、包みは頁のファイルだけで 15MiB まであり得る。1 回では送れないので、DEV-196e-1 の begin / put / finalize の考え方を使う。ただし DEV-196e-1 の設計 (版の行の 'uploading' 状態、15 分の upload token の sha256 を DB に保存) は migration が要る。ここでは次の形で migration を避けた:

- **put は content-addressed**: 頁のファイルを private bucket の `staging/<sha256>` に置く (上書きしない。同じバイトは replay、違うバイトがあれば `STAGED_OBJECT_DIFFERS`)。bucket の MIME の許可 (html / css / webp / jpeg) に収まるのは頁のファイルだけなので、それだけを置く。
- **finalize の要求が残りを全部持つ**: `package.json` と文章のファイル (copy/…) を multipart で送る。server が頁のファイルを manifest の sha256 で staging から読み直す。session の状態が無いので、token も 'uploading' の行も要らない。各要求は admin の session と origin の確認で認証する。
- **版を作るのは finalize だけ**: すべてのファイルがそろい、検査を通った時だけ `importPackage` を呼ぶ。途中で止まった取り込みは版にならず (統合テスト)、同じフォルダでやり直すと続きから入る。
- 15 分の期限は無い (状態が無い)。staging に残った一時ファイルは配られない (成果物の route は DB の版の prefix しか読まない) が、片付けは無い (未解決 1)。

### 検査 (import-local と同じもの、同じ順)

- `lib/demo-version-package/verify.ts` (新規): `package.ts` から純粋な検査 (`PackageError`・形式・`checkPackageFiles`・`checkPackageImages`・`packageRightsSummary`・`checkPackageCopy`) を**変えずに**移し、`readPackage` の本体を `packageFromSource(meta, source)` にした。`readPackage` (ディレクトリ) と finalize (要求と bucket のバイト) が同じ関数を通る。`package.ts` は再 export するので既存の import は不変。移した理由は、`package.ts` が `sharp` を import するため (server に持ち込まない)。`import.ts` は `./verify` から import する。
- finalize: `packageFromSource` (再 hash・manifest・HTML の安全・画像の記録・権利の要約・copy manifest・文章の検査と監査の再実行) → `importPackage(…, { factsFromStore: true })`。facts は facts の保存先だけ (`trustedFactsPack` を渡さない)。その前に `demoForUpload` が、保存先の今の pack がこの demo の行であり、demo の content がその pack のバイトから作られていること (`assertDemoContentFromFacts`) を確かめる — `import-local.ts --facts-from-store` と同じ。文章・facts・権利・HTML の検査はすべて `importPackage` の書き込みの前 (既存の順のまま)。client の判定は何も受けない (返す copy の status は `importPackage` が計算したもの)。
- v2 の包みだけ (`PACKAGE_NOT_REVIEWED`): v1 は `copy_unreviewed` にしかならない。
- begin: バイトの要らない検査を先に (形式・manifest・bundle・validator・画像・権利の要約・copy manifest・finalize の大きさ) と demo の facts。何も書かない。staging にあるファイルを答える。

### 上限・path・圧縮ファイル

- 本文は読みながら上限を守る (`readBoundedBody`: Content-Length と実際に読んだバイトの両方): package.json 512KiB、put 4MiB (`ARTIFACT_LIMITS.fileBytes`、bucket と DB の 1 ファイルの上限)、finalize 4MiB (文章のファイルの合計がこれを超える包みは begin で `COPY_TOO_LARGE_FOR_UPLOAD`。包み自体の上限 6MiB より厳しい側)。
- put: 種類は html / css / webp / jpeg だけ、中身の頭 (RIFF…WEBP / FFD8FF)、テキストは UTF-8 で NUL なし・HTML 384KiB / CSS 256KiB、宣言した `x-content-sha256` = 再計算。完全な検査は finalize で再び。
- path: 頁のファイルの名前は `validateManifest` の固定の形、文章のファイルは copy manifest の固定の名前 (`copyRoleOfName`) だけ。finalize の part の名前が copy manifest に無ければ `COPY_PART_NOT_IN_MANIFEST` (`../../package.json` などを含む)。bucket の key は `staging/<sha256>` と `v1/<demo>/<version>/<manifest の名前>` だけで、client の文字列から作らない。
- **圧縮ファイル (zip / tar) は受けない**: 依存を足さない (package.json を変えない) ため、また展開そのものを無くすため。zip bomb の余地が無い。ブラウザは `webkitdirectory` でフォルダの中のファイルを 1 つずつ送る。zip / gzip のバイトは put の種類の検査で落ちる (テスト)。

### 認可・CSRF

route `app/admin/sales/demos/[prospectId]/import/route.ts` (POST ?step=begin|put|finalize) の順: `SALES_DEMO_VERSIONS_ENABLED` (off → 頁と同じ 404) → `SALES_DEMO_QUALITY_REVIEW_ENABLED` (off → 403、何も読まない) → origin (`Origin` の host = `X-Forwarded-Host` / `Host`、Next の server action と同じ比べ方。`Sec-Fetch-Site` があれば `same-origin`。`Origin` が無ければ拒否) → `getAdminState` (未ログイン 401、sales_admins でない 404) → service role の client を作る。lib の各段も旗を先に見る。応答は固定の code と文言だけ (DB の message・stack・鍵を出さない)。`/admin/:path*` の header (no-store・noindex・frame 不可) がそのまま掛かる。

### 画面

`components/admin/demo/VersionImport.tsx`: 版の頁の「店舗の事実の登録」の下。旗 2 つ・demo が無効でない・facts が登録済み、のときだけ出る。フォルダを選ぶ → begin → staging に無いファイルだけ put (ブラウザでも sha256 を比べ、違えば送らない。判定ではなく早めに止めるだけ) → finalize → `router.refresh()`。

## PR #271 の delta Low (coordinator の指示でこの PR に)

- `lib/sales/facts-onboarding.ts` の `near()`: 片方がもう片方に含まれれば一致としていたため、pack の住所が「名古屋市」だけでもほぼどの住所とも一致した。比べる前に先頭の都道府県を両方から外し、包含は**短い方が長い方の 65% 以上** (`NEAR_MIN_RATIO`、code point で数える) のときだけ一致とする。等しいものは従来どおり一致、空は不一致。unit (`tests/unit/sales/facts-onboarding.test.ts`): 建物名つきの登録住所は一致、市だけ・県だけ・1 文字は不一致、片側だけの都道府県は無視。既存の fixture の登録住所 (「愛知県名古屋市（登録用） 架空市…」) は新しい規則では不一致になるため、「愛知県架空市架空区試験町1-2-3 架空ビル」に変えた (意図した変更)。
- `docs/operations/real-shop-demo-workflow.md` §6 の hosted の注記を runbook B-5a を指すよう直した。

## テスト

| 種類 | file | 何を |
|---|---|---|
| unit | `tests/unit/admin/demo-version-upload.test.ts` (12) | 本文の上限 (宣言・stream)、CSRF (Origin なし・別 host・`null`・cross-site・javascript:)、begin (書かない、staged)、旗 off (3 段とも何も読まない)、v1・形式違い・JSON でない・bundle・manifest の `../`・copy manifest の `copy/../../etc/passwd`・validator・権利の要約・大きすぎ、保存先でない facts (無い・別 demo・別バイト・content の不一致・demo なし・uuid でない)、put (replay・上書きしない・hash の違い・種類・空・4MiB 超・zip / gzip・大きな HTML)、finalize (検査済みの包みで importPackage を factsFromStore だけで 1 回、未送信・staging の改ざん・余分な part・欠けた part・変えた文章・facts なしは importPackage の前に拒否、別の facts pack の包みは文章の検査で拒否)、route (旗 off 404 / 403、cross-site 403、未ログイン 401、管理者でない 404、step 違い 400、どれも service role の client を作らない) |
| 統合 | `tests/integration/demo-version-upload.test.ts` (3、ローカルの Storage あり) | facts 未登録は begin で拒否 → オーナーが自分の session で登録 → begin / put / finalize → 下書きの v1 (manual_import)、admin の session (RLS) で見える、承認・品質の審査は無い、文章の照合の証拠 1 件、送信の門は `demo_copy_owner_confirmation_missing` (オーナー待ち)、bucket の版の prefix に全ファイルがバイトどおり → 再取り込みは同じ版 (created false)、全部 staged。1 ファイル欠けの finalize は `FILE_NOT_STAGED` で版も文章の監査も 0 → 送れば v1。staging は admin から直接読めない・書けない |
| e2e | `tests/e2e/demo-version-upload.spec.ts` (desktop) | 旗 off の server では route が 404、旗 on で別 origin は 403。画面で facts を登録 (未登録の間は欄が出ない) → 改ざんした包み (copy.json に 1 バイト) は `COPY_INVALID` で版 0 → そのままの包みで「版 v1 を取り込みました」、文章の監査は facts の経路・オーナーの判断なし、DB は draft・未承認・送信の門はオーナー待ち → 同じ包みでもう一度は「すでに版 v1」、版は 1 つ |

既存のテストの変更 (意図したもの): `tests/unit/demo-version-package/copy-package.test.ts` の isolation (包みの module を import する file の一覧に verify.ts・upload の lib・route を足し、対象に verify を足した。送信の経路は依然として無い)、`tests/unit/sales/demo-version/purity.test.ts` (旗を読む画面の一覧に route を足した)。

実行の結果は PR の本文に書く (unit の全体、統合の全体、e2e、tsc・eslint・check:secrets・build)。

## 未解決・承認が要るもの

1. **staging の後始末**: 版にならなかった `staging/<sha256>` は残る (配られない)。消す仕組みは別 Task (DEV-196e-1 の「object を取り返せない形では消さない」に合わせ、版のファイルと照らしてから)。
2. **hosted で使う前の承認** (runbook B-5a): B-1 の migration、private bucket `sales-demo-versions` の作成 (public でない、4MiB、MIME 4 種、anon / authenticated の policy なし)、B-4 の旗 2 つ。新しい環境変数は無い。
3. DEV-196e-1 は backlog のまま: worker (WSL) の経路 (bridge token、生成時の事実と取り込み時の事実の比べ直し) が残る。この PR はオーナーの手動の取り込みだけ。
4. 1 回の要求の上限のため、文章のファイルの合計が約 4MiB を超える包み (改稿の round が多い包み) は画面から送れない (`COPY_TOO_LARGE_FOR_UPLOAD`)。今の包みは数十 KiB。
