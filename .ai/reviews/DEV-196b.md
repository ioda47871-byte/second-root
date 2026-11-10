# DEV-196b: 店舗デモの版の offline の純粋なライブラリ

2026-11-10。branch `feature/dev-196b-demo-lib` (`origin/develop` c57b7d6 から)。仕様は PR #241 の `docs/design/DEV-196-demo-admin-spec.md` (review round 3、ee1905e まで反映)。

**範囲 (オーナー決定 2026-11-10)**: §12 の DEV-196b だけ。offline の純粋な関数と unit test。DB・migration・Storage・環境変数・network・route・画面への配線は無い。どの route・page・component も import していない (`tests/unit/sales/demo-version/purity.test.ts` が固定)。

## 何を作ったか (`lib/sales/demo-version/`)

| module | 仕様 | 主な export |
|---|---|---|
| `manifest.ts` | §4.1・§4.2・§5.2・§6.4 手順 5・T9〜T11 | `urlPathToManifestName` / `manifestNameToUrlPath` (URL は `page/` を外す、`renders/` は scope `a` だけ)、`roleOfName`、`validateManifest` (strict、固定の符号)、`bundleSha256` / `canonicalManifest`、`checkFileBytes` (再ハッシュ・大きさ・UTF-8・magic bytes・形式・画素数・EXIF/XMP の拒否)、`manifestRenders`、`photoUrlPaths`、`ARTIFACT_LIMITS` |
| `html-safety.ts` + `rule-core.ts` | §7.3・T1〜T3 | `checkArtifactHtml(html, css, photoUrls)` (parse5)、`checkArtifactCss`、`cssDeclarations`、`isAllowedFontList` |
| `copy-check.ts` | §7.4・T14 | `checkArtifactCopy` (copy record と事実パック、`UNVERIFIED_COPY`。文そのものは結果に出さない) |
| `csp.ts` | §6.4 手順 6・§6.7・§6.8・T12・T13・T23 | `buildArtifactHtmlCsp` (sandbox 指令つき、`'self'`・`unsafe-*` なし)、`artifactResponseHeaders`、`servingOrigin`、`outerFrameSrc`、`fetchDestAllowed`、`normaliseOrigin` |
| `view-token.ts` | §6.2・§6.6・T7・T19 | `signViewToken` / `verifyViewToken` (HMAC-SHA256、`a` 15 分・`p` 30 分、scope と path の照合、`timingSafeEqual`、寿命の上限、正規の base64url だけ)。鍵は引数 (≥ 32 bytes)、env を読まない |
| `ai-concept-rights.ts` | §8.3・§8.3.1・T21 | `AiConceptRights` (`ai_concept_rights_v0`)、`checkAiConceptRights`、`AI_CONCEPT_ADMIN_LABEL`。結果の型に共有の欄が無い |
| `rights.ts` | §8.1・§8.3・§8.4・T6 | `deriveRightsStatus`、`shareEligible`、`deriveVersionRights`、`isShareableStatus`、`SHARE_PHOTOS_ENABLED = false` (literal) |
| `version-state.ts` | §4.6・§6.4 手順 3〜4・§6.6・§9.4・§9.5・T5・T8・T20・T22 | `VERSION_STATE_PERMISSIONS`、`canAdminPreview`、`resolveSharedVersion` (`version` / `legacy` / `not_found`)、`guardHashChange` (`approval_open`)、`versionRetentionUntil` |
| `quality.ts` | §4.4・§7.2・§7.5 | `QUALITY_CHECKLIST_ITEMS` (7 項目)、`evaluateQualityDecision`、`templateWarnings` (`blocking: false` 固定)、`StructureFindingInput` |

### 決めたこと・理由

- **共有の規則 (no fallback)**: `resolveSharedVersion` は `sent` の承認が固定した版だけを返す。取り消し・`revoked` / `expired` / `rejected` / `uploading`・共有不可・demo が非公開なら `not_found`。`legacy` (React のデモ) を返すのは `sent` の承認が版を固定していない (`demo_version_id = null`) ときだけで、版の取り消しから React のデモに落ちることは無い。`sent` の承認が 2 件あって版が食い違うときも `not_found` (どちらの頁を送ったか分からない)。版の `status` は「出せない状態か」だけを見る (`draft` に戻った版・`superseded` の版も送った版として出す、§6.4)。版の `expires_at` では止めない (共有の期限は `isDemoPublic`)。
- **権利 (fail closed)**: 人の写真・規約固定の素材・架空の店の AI デモ画像は `photo_rights_v0` を `checkPhotoRights` (変えていない) に通して導く。実店舗には `aiDemoAllowed` を決して渡さない (呼ぶ側が true を渡しても false にする)。期限切れだけが理由なら `expired`、ほかの不備は `unknown`。実店舗の AI 概念画像は別の schema と `checkAiConceptRights` で、出所 (`admin_preview_only: true`)・`depicts_real_*` がすべて false・オーナーの確認 (生成より後)・固定のラベル・bytes・禁止の hash・prospect の一致を**すべて**満たすときだけ `ai_concept_internal`。`ai_concept_rights_v0` は `checkPhotoRights` では通らない (テストで固定)。共有は写真 0 枚の版だけ (`SHARE_PHOTOS_ENABLED` は literal の false で、呼ぶ側から有効にできない)。AI の状態は共有不可。`ai_share_approved` は導かない。期限は JST の暦日 (`checkPhotoRights` に `jstDate(now)` を渡す)。
- **配信の origin**: 共有 `p` は設定済みでアプリと別の artifact origin からだけ (無い・同じ・不正なら null → 404)。管理者 `a` は artifact origin があればそこだけ、無ければアプリの origin。外枠の `frame-src` は、別 origin が無い間だけ**管理者の外枠**に `'self'`、共有の外枠には `'self'` を入れない (review round 3 L2)。
- **HTML の検査**: parse5 で解析し、`<template>` の中も含めて反復で歩く (深い入れ子でも stack を溢れさせない)。B方式の規則に加え、`style` 属性・`<style>`・`@font-face`・`font:` の一括指定・2 つ目の stylesheet・`#fragment` 以外の `href`・宣言していない写真を拒否。`font-family` は `var(--x)` を (4 段まで) 解決し、そのすべての定義が許可一覧であること。
- **書体の一覧は広げていない**: つぐ手の fidelity 頁 9 件は `"IPA明朝"` (一覧に無い) を名指すため `CSS_FONT_FAMILY_NOT_ALLOWED` で落ちる (テストで「その符号だけで落ちる」と固定)。輪 (bicycle) 13 件・銭湯 (sento) 10 件は通る。

### import 境界と rule-core の写し (要確認)

`lib/design-agent/phase2f/`・`lib/design-agent/comp-impl/`・`lib/design-agent/structure/` は、それぞれの isolation test が importer をオーナー承認済みの exact path で固定している (`tests/unit/design-agent/phase2f/isolation.test.ts`、`comp-impl/isolation.test.ts`、`structure/structure.test.ts`)。DEV-196b の承認はこれらを広げないので:

- B方式の規則の核 (`FORBIDDEN_ELEMENTS`・`URL_ATTRIBUTES`・`cssUrls`・`decodeEscapes`・`outsideStringsAndComments`・`cssProblems` の非 canonical の枝・`allowedUrl`) と書体の一覧 (`PAGE_FONT_FAMILIES`・総称) は `rule-core.ts` に**逐語で写した**。`rule-core-parity.test.ts` が、元のソースの宣言の文字列と一致すること、研究の CSS と敵対的な CSS の corpus で `cssProblems`・`cssUrls`・`outsideStringsAndComments` が同じ結果を返すことを検査する。写しがずれれば CI が落ちる。
- 構造記述子による類似の計算 (`structureFindings`) は呼ばない。`templateWarnings` は呼ぶ側が計算した findings を `StructureFindingInput` として受け取り、警告に写すだけ (DEV-196d 以降で、その importer の承認と一緒に)。
- `lib/design-agent/quality-pipeline/photo-rights.ts` と `copy-record.ts` は import だけ (変更なし、境界の test も無い)。
- 一度 `prototype-safety.ts`・`page-css.ts` に `export` を足したが、境界の test に触れるので develop の内容に戻した。**`lib/design-agent` は develop から変わっていない**。

## テスト

`tests/unit/sales/demo-version/` 10 ファイル・283 件 (rights 31・rule-core-parity 49・html-safety 101・copy-check 5・manifest 30・quality 14・version-state 16・csp 11・view-token 14・purity 12)。

- `npx vitest run tests/unit/sales`: 38 ファイル・781 件 すべて通過。
- 境界: `phase2f/isolation`・`comp-impl/isolation`・`three-methods`・`intelligence`・`phase2f-live` の isolation・`guardrails` は通過 (phase2f/isolation の「recorded route B answer」1 件は Chromium が無いため。下記)。`structure.test.ts` は Chromium の beforeAll で suite ごと落ちるので、その isolation の `git grep` を手で流し、`lib/sales`・`tests/unit/sales` に当たりが無いことを確かめた (exit 1)。
- `npx tsc --noEmit` (`next typegen` の後): エラー無し。eslint (`lib/sales/demo-version`・`tests/unit/sales/demo-version`): 指摘無し。`npm run check:secrets`: 秘密なし。
- `npx vitest run tests/unit/ai-tasks.test.ts`: DEV-196b → DEV-196 の依存の 2 件が落ちる (DEV-196 はまだ develop の台帳に無い。PR #241 の merge で解消)。
- 全 unit (`npx vitest run`): 68 ファイル・133 件が落ちるが、すべて `tests/unit/design-agent/**` と design worker の test で、原因はこの container に Playwright の Chromium が無いこと (`browserType.launch: Executable doesn't exist`) とその連鎖 (worker の report・ENOENT)。`tests/unit/sales` には無い。この PR は `lib/design-agent` を変えておらず、それらの test は `lib/sales/demo-version` を import しない。

## 依存の記録

| 項目 | 値 |
|---|---|
| 名前・版 | `parse5` **8.0.1** (`npm install --save-exact`、`dependencies`) |
| licence | MIT (推移的な `entities` 8.1.0 は BSD-2-Clause) |
| 公開日 | 8.0.1: 2026-04-19 (最新は 8.1.1 2026-11-07、8.1.0 2026-11-01。どちらも 2 週間未満なので使わない)。`entities` 8.1.0: 2026-09-07 |
| 依存の数 | 直接 1 (`entities` ^8.0.0)、推移的に合計 1。`entities` は依存 0 |
| 大きさ | parse5 約 337KB、entities 約 330KB (unpacked) |
| 保守 | 2026-11 にも release がある (inikulin/parse5)。jsdom などが使う HTML 仕様どおりの tokenizer と tree builder |
| 選んだ理由 | lockfile に HTML 解析器が無かった (parse5・htmlparser2・linkedom・node-html-parser・jsdom・cheerio を確認)。仕様 §7.3 が「HTML 仕様どおりの tokenizer、例: parse5」を挙げる。ブラウザ (Chromium の DOMParser) と同じ木を作るので、2 つの解析器の差を突くリスク (T2) が最も小さい。htmlparser2 は仕様どおりの木を作らず依存が 4 つ |
| `npm audit --omit=dev` | 追加の前後とも同じ 4 件 (critical 1: `next`、high 3: `sharp`・`source-map-js`・`zod`)。**parse5・entities には 0 件**。既存の 4 件はこの PR の範囲外 (zod の advisory は大きな配列の検証でのメモリ消費。`validateManifest` は zod の前に配列の長さを 40 で切る) |
| install | `--ignore-scripts` (parse5・entities に install script は無い) |

## 残る問い (オーナー・次の段)

1. **import 境界**: `lib/sales/demo-version` を phase2f / comp-impl / structure の importer として認めるか。認めれば `rule-core.ts` を re-export にでき、類似の計算 (`structureFindings`) を library の中で呼べる。認めなければ写しと parity test のまま。
2. **つぐ手の書体**: `"IPA明朝"` を許可一覧に足すか (comp-impl の一覧の変更なので別の承認)。足さなければ、つぐ手の頁は版として受け付けない。
3. **copy record の運び方**: §5.2 の key と bucket の型に `copy.json` が無い。`checkArtifactCopy` は copy record を引数で受ける (配信しない)。包みの中で運ぶか、DB に置くかを DEV-196c / 196e で決める。
4. **再直列化 (§14 Q8)**: 今は検めた HTML をそのまま配る前提。parse5 で再直列化して配るかは、DEV-196d で Chromium との差分テスト (§13、browser の job) と一緒に決める。
5. **送信承認の照合 (§9.2)** の純粋な部分 (`demo_version_unavailable` などの符号の導出) は DEV-196f に残した (DB の関数と一緒に)。

## レビュー 1 回目 (独立のセキュリティレビュー、0bdd8ef: C0 H0 M3 L4) への対応

各 probe に回帰テストを足した (`tests/unit/sales/demo-version/review-round-1.test.ts`、45 件)。修正前のライブラリ (HEAD の `html-safety.ts`・`manifest.ts`・`csp.ts`・`view-token.ts`) に戻して流し、probe の 36 件がすべて落ちることを確かめてから修正に戻した (通った 9 件は「許すものは許す」の対照と、修正前から成り立つ性質)。

- **M1 (url() の見落とし)**: `css-scan.ts` を新設。CSS Syntax §4 に沿った token の走査 (コメントは文字列の外の生の `/*` だけ、escape は token の単位で decode、文字列中の backslash-newline は行の継続、引用なしの url token、bad string / bad url / 文字列の外の backslash-newline は `CSS_SYNTAX_SUSPICIOUS` で拒否)。stylesheet と、CSS として解析される属性の両方に掛ける。probe (a) 文字列の中の `/*`、(b) `\2f\2a`、(c) `url('https://e\⏎x')` はすべて `CSS_URL_NOT_ALLOWED`。読み込む at-rule (`@namespace`・`@counter-style` など) と url() 以外の画像関数 (`cross-fade` など) もここで拒否。header の「規則は緩めない」は誤りだったので、Chromium の 2 回目 (再直列化した CSS) の代わりにこの走査を置く、と書き直した。
- **M2 (SVG 属性の escape)**: SVG の presentation 属性 (`fill`・`filter`・`mask`・`clip-path`・`marker-*`・`font-family` など、`CSS_ATTRIBUTES`) は `\` を含めば `HTML_ATTRIBUTE_ESCAPE`、値に token の走査を掛け、`font-family` は許可一覧。全属性で escape を decode してから `url(` を探す。
- **M3 (CSS の文字・属性の文字)**: 空でない文字列は `font-family`・`grid-template(-areas)`・`grid`・font feature 系・custom property だけ (url() の引数は URL として別に検査)。`content`・`quotes`・list marker・`text-overflow` などは文字列・`attr()`・`var()` を持てない (`CSS_TEXT_IN_CSS`)。研究の頁は `content: ""` だけなので通る。見える属性 (`alt`・`title`・`aria-label`・`aria-description`・`placeholder` など) の値は `texts` に入り、語の規則と `checkArtifactCopy` (`UNVERIFIED_COPY`) が見る。
- **L1 (blocklist)**: 要素と属性を**許可一覧**にした (`ALLOWED_ELEMENTS`・global / 要素ごと / SVG の属性)。blocklist (`FORBIDDEN_ELEMENTS`・`URL_ATTRIBUTES`) は 2 枚目として残す。`attributionsrc` ほかを URL 属性に足した (`ARTIFACT_EXTRA_URL_ATTRIBUTES`)。`feImage`・form の部品・`video` などは許可一覧に無い。`Permissions-Policy` に `attribution-reporting=()`・`browsing-topics=()`・`interest-cohort=()`。研究の頁 (bicycle・sento) は通り続ける。
- **L2 (時計のずれ)**: 寿命の上限だけに 5 秒の猶予 (`VIEW_TOKEN_SIGNER_SKEW_SECONDS`)。期限切れの判定は厳密なまま。
- **L3 (画像の metadata)**: `hasImageMetadata` を許可一覧にした。JPEG は SOI・APP0 "JFIF"・APP14 "Adobe"・DQT・DHT・DAC・DRI・SOF*・SOS (+ entropy data・RSTn)・EOI だけ。APP1 / APP2 (ICC) / APP13 (IPTC) / ほかの APPn / COM (scan の間も) は metadata。WebP は VP8・VP8L・ALPH と alpha の旗だけの VP8X。EXIF・XMP・ICCP・animation・未知の chunk・ファイルより長い chunk は metadata (fail closed)。
- **L4 (parity)**: `cssProblems` の 1 回目 (非 canonical の枝) の本文を source の文字列で比較するテストを足した。server の差は rule-core の**外で足すだけ** (css-scan・許可一覧・文字の規則) で、共有の 1 回目は文字列と挙動の両方で同一、とテストのコメントに書いた。

### 台帳

- DEV-196 の note の L1 の記述を直した: #241 が台帳で行ったのは DEV-197 を done にし、DEV-197 の note を更新し、`.ai/reviews/DEV-197.md` に Staging の節を足したことだけ (DEV-195 は #241 の前から develop で done)。

### 結果

`tests/unit/sales/demo-version` 11 ファイル・330 件、`tests/unit/sales` + `ai-tasks` 40 ファイル・1036 件 すべて通過。`tsc --noEmit`・eslint・`check:secrets` 問題なし。phase2f / comp-impl の isolation と guardrails は通過 (phase2f/isolation の「recorded route B answer」1 件は従来どおり Chromium が無いため)。

## レビュー 2 回目 (再レビュー、3ee4134: C0 H0 M1 L2) への対応

1 回目の指摘はすべて修正済み・全 probe が止まることを確認済みとされた。新しい指摘への対応。回帰テストは `tests/unit/sales/demo-version/review-round-2.test.ts` (14 件)。遅い入力は**上限で先に拒否する** (固定の符号を返し、遅い経路を走らせない) ので、テストは符号を確かめ、時間は余裕のある上限 (3 秒) を後ろ盾にする (修正後は数 ms〜数十 ms)。修正前のライブラリに戻して流すと、同期の遅い経路のため 280 秒で打ち切りになった (= 落ちる)。

- **M1 (遅い入力)**: `html-safety.ts` に `ARTIFACT_INPUT_LIMITS` と線形の事前検査を足した。上限を超えたら遅い経路を呼ばずに拒否する (fail closed)。
  - CSS (`cssComplexityProblem`): 256 KiB を超える → `CSS_TOO_LARGE`。escape を decode した後の `url(` が 200 を超える、または最後の `*/` より後の `/*` が 4 を超える → `CSS_TOO_COMPLEX`。rule core の `cssUrls` (`[^"')\s]*`) とコメントの正規表現は、作った入力で二次になるため、この検査を通ったときだけ呼ぶ。`rule-core.ts` は元のソースと**バイト単位で同じまま** (parity test はそのまま意味を持つ)。`"url(".repeat(64000)` は修正前 19.9 秒 → 約 20 ms で `CSS_TOO_COMPLEX`。
  - 属性: 1 つの属性値の `url(` が 8 を超えたら `cssUrls` を呼ばずに `HTML_ATTRIBUTE_URL` (`too many url(`)。
  - HTML (`htmlShapeProblem`、parse5 の前): 384 KiB を超える → `HTML_TOO_LARGE`。線形のタグの走査で、開いた要素の深さが 512 を超える → `HTML_TOO_DEEP`、開始タグが 8000 を超える → `HTML_TOO_MANY_ELEMENTS`、1 つの開始タグの属性 (引用の外で数える) が 64 を超える → `HTML_TOO_MANY_ATTRIBUTES` (parse5 の重複属性の検査は 1 タグの属性数について二次。3 万属性で約 1.7 秒を実測)。HTML の `<div/>` は parser と同じく深さを増やす。`/>` で閉じたとみなすのは許可した SVG 要素と void 要素だけ。`"<div>".repeat(76000)` は修正前 33.5 秒 → 数 ms で `HTML_TOO_DEEP`。研究の頁 (要素は最大約 380、深さは 20 未満、`url(` は最大 9) は通る。
  - あわせて、`font-family` の `var()` の解決を (custom property, 深さ) で memo した (同じ名前を何度も定義した連鎖が指数的にならないように)。
- **L1 (JPEG の EOI の後)**: EOI の後に 1 バイトでもあれば metadata とみなし拒否 (WebP は以前から拒否)。
- **L2 (作る側の約束)**: ICC は JPEG (APP2) でも WebP (ICCP・VP8X の旗) でも拒否する (fail closed)。**作る側 (worker) は、包む前に画像を sRGB に変換し、ICC と全 metadata (EXIF・XMP・IPTC・コメント) を落とすこと**。server は変換しない。`manifest.ts` の冒頭にこの約束を書いた (仕様の文書は変えていない。DEV-196e の photo-swap の書き出しで守る)。

### 結果

`tests/unit/sales/demo-version` 12 ファイル・344 件、`tests/unit/sales` + `ai-tasks` + `guardrails` + comp-impl の isolation 43 ファイル・1062 件 すべて通過。`tsc --noEmit`・eslint・`check:secrets` 問題なし。
