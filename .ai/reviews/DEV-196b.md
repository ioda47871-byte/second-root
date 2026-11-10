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
