# ほし窯 d2-v2 の AI 写真 3 枚を 1 回だけ本生成する — 承認の前の準備シート（DEV-139）

> **状態: 未承認 (NOT APPROVED)。** このシートは、オーナーが後で決めるための 1 枚。ここに書いた差分はどれも**入れていない**。
> 画像の生成・取得・有料素材・外部 API は行っていない (生成した画像は **0 枚**)。DB は何も変えていない。
> 輪の `docs/operations/bicycle-one-time-run-sheet.md` (DEV-192、オーナーの GO 済み) と同じ形にしてある。承認されたら、輪の (a)〜(i) と
> 同じ手順を、下の値に置き換えて使う (その時に輪と同じ粒度のコマンドシートを作り直す。今のこのシートのコマンドは貼らない)。

ほし窯は架空のパン屋 (`poc/bakery/facts-pack.json`)。写真は**デモ用のイメージ**で、実在の店・商品・人・窯ではない。

## 1. 今あるもの (オフライン、承認なしで入れたもの)

| 段 | ファイル | 今の動き |
|---|---|---|
| 写真の差し替え | `lib/design-agent/quality-pipeline/photo-swap-shops.ts` の `bakery` | d2-v2 の 2 枠を、権利を確かめた写真で差し替えられる。**`aiDemoAllowed: false`・プロンプトの pin なし** → AI のデモ画像は `AI_DEMO_NOT_ALLOWED` で拒否 |
| 写真のデータ | `lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts` | 3 枚の目標・下限・主役の箱・写真ごとのプロンプトの SHA-256。**`HOSHIGAMA_APPROVAL = null`**、`buildHoshigamaRunPrompt()` は `""` |
| プロンプトの草案 | `docs/design/hoshigama-ai-photo-prompt.txt` | 指示書 §6 の草案をそのまま固定 (頭に「DRAFT (未承認)」3 行) |
| run の束を書く | `lib/design-agent/design-image/hoshigama-photos.ts` | 承認の記録が無いので `PROMPT_NOT_APPROVED` で必ず拒否。worker の hook には繋いでいない |
| 取り込み | `scripts/design-artifact/hoshigama-ai-intake.ts` | 承認の記録が無いので `RUN_PROMPT_NOT_APPROVED` で必ず拒否。拡大は承認が名指しした写真だけ、`HOSHIGAMA_MAX_UPSCALE` (= 既存の 2 倍) まで、lanczos3 |
| 包み | `scripts/sales/demo-version/package-local.ts --page … --facts …` | 写真と文章の両方を持つ v2 の包み。ほし窯の写真は差し替えの spec が AI を許すまで `SUMMARY_NOT_RIN` で拒否 |

テスト (モックの写真だけ。承認は**テストの中だけの stub**、`tests/support/hoshigama-approval-stub.ts`):
`tests/unit/design-agent/quality-pipeline/photo-swap-hoshigama.test.ts`、`tests/unit/demo-version-package/hoshigama-photo-pipeline.test.ts`。

## 2. オーナーが決めること (どれも未決)

| # | 項目 | 案 (今の値) | 決定 |
|---|---|---|---|
| A1 | d2-v2 (またはカンプ) に写真を入れる価値があるか | オーナーはまだ d2-v2 もカンプも見ていない。成功例ではない | |
| A2 | 枚数 | **3 枚** (ph-mouth-pc 1:1・ph-mouth-sp 2:3・ph-loaf 4:3)。代案 2 枚 (ph-mouth を 3:4 の 1 枚) は**別の本文と別の写真の一覧が要る** (今のコードは 3 枚だけを知っている) | |
| A3 | プロンプトの本文 | `docs/design/hoshigama-ai-photo-prompt.txt` の全文: SHA-256 `372f7802101f679a519bca9ee2af57a07cbd6faf9df5371b70888e9a7ce3a8f6`・2007 バイト・1988 文字。写真ごと (COMMON の段落 + その写真の段落、改行で連結): ph-mouth-pc `4df1be15…af66`、ph-mouth-sp `b4956f7f…03ad`、ph-loaf `b1261248…0f87` | |
| A4 | 実行プロンプト (本文を包む run の決まり) | `buildHoshigamaRunPromptCandidate` が組むもの: SHA-256 `a7b7d524470a6e271503ca1820db0f0693cecd28e9c51bf4b19b3543f62be7f1`・2668 文字。**本文か実行プロンプトのどちらかのバイトが変われば承認は失効** | |
| A5 | 寸法と拡大 (下の §3) | 拡大を許す写真の一覧 (案: ph-mouth-pc と ph-loaf、どちらも 2 倍の内)。上限は既存の 2 倍のまま (超える道は無い) | |
| A6 | 1 回限りの実生成の範囲 | **1 ジョブ・画像呼び出し最大 3 回・Codex 1 回・15 分・再試行なし・ほし窯 d2-v2 だけ**。承認 ID・job ID・期限はその時にオーナーが決める (コードに書かない) | |
| A7 | コードの差分 (下の §4) | 承認と一緒に、レビュー付きの PR で入れる | |
| A8 | ローカル DB の許可 (下の §5) | S0 の ほし窯 prospect に AI のデモ画像を許すローカル専用の patch と、取り込みの許可の 1 行 | |
| A9 | 文章入りの v2 の包み (下の §6) | d2-v2 (`<wbr>` の無い版) で通る。d2-v2 とカンプ v4 をオーナーが見て決める | |

## 3. 寸法と拡大 (既存の 2 倍の規則は緩めていない)

目標は差し替えの 2 倍の規則を範囲の端 (600・1199・1920) まで満たす最小の大きさ (`photo-slot-edges-d2-v2.json`、10 単位に切り上げ)。

| 写真 | 比 | 2 倍の目標 | 1.5 倍の下限 (例外の記録が要る) | よくある生成の大きさから |
|---|---|---|---|---|
| ph-mouth-pc | 1:1 | 1370×1370 | 1020×1020 | 1536² → 拡大なしで届く。1024² → 1.338 倍 (許可の一覧にあれば通る)。640² → 2.14 倍 → `UPSCALE_EXCEEDS_MAX` で拒否 |
| ph-mouth-sp | 2:3 | 650×975 | 490×735 | 1024×1536 → 拡大なしで届く |
| ph-loaf | 4:3 | 1750×1313 | 1310×983 | 1536×1024 (3:2) → 4:3 に切って 1.283 倍。1024×768 → 1.709 倍 |

- 2140px の目標 (PR #287 の初めの d2-v1) は 1024² からは 2.09 倍が要り届かなかった。PR #287 の直しで石窯の口の板を小さくし (PC 1440 で 460×510、
  1920 の端で 613×680)、目標は 1370px になった。2 倍を超える拡大の道は取らない (指示書 §3)。
- 2 倍に届かない写真 (例 1280²、1920 の端で 1.88 倍) は差し替えが `SCALE_EXCEPTION_REQUIRED`。オーナーの例外の記録 (`scale_exception`、1.5 以上)
  があれば通る (テストで確かめた)。
- `HOSHIGAMA_MAX_UPSCALE` は店ごとの明示の値で、既存の `MAX_UPSCALE` (= 2) と同じにしてある (テストで一致を固定)。2 倍を超える拡大は
  この値を変える**オーナーの決定**で、既定にはしない。`upscaleFactor` は上限を引数で受け、既定は `MAX_UPSCALE` (つぐ手・輪は不変)。
- SP の写真 (ph-mouth-sp) は差し替えの規則が求めるものではない (正方形 1 枚でも SP の板で主役の箱を保ち、61.5% を残す)。
  指示書 §3 のとおり、アーチで上が大きく切れる SP の構図のための選択。
- ph-loaf はどの幅でも板の形が 1.2 で、PC 1440 と SP 390 の切り抜きが同じ矩形になる。差し替えは同じ切り抜きを 1 つのファイルで共有する
  (`shareIdenticalCrops`、ほし窯だけ。DB の `sales_demo_images.sha256` は unique なので、同じバイトの写真 2 枚は包みに入らない)。

## 4. 承認の時に入れる差分 (今は入れていない)

**(1) `lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts`** — 承認の記録 (値はオーナーの決定。下は草案を変えずに承認した場合):

```diff
-export const HOSHIGAMA_APPROVAL: HoshigamaApproval | null = null;
+export const HOSHIGAMA_APPROVAL: HoshigamaApproval | null = {
+  approval_record: "hoshigama-one-time-run-<YYYYMMDD>",
+  decided_by: "owner", decided_on: "<YYYY-MM-DD>", evidence: "<Issue のコメント>",
+  shop: "bakery", page: "d2-v2", jobs: 1, max_image_calls: 3, codex_runs: 1, timeout_minutes: 15, retry: false,
+  core_prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256, core_prompt_bytes: HOSHIGAMA_PROMPT_DRAFT_BYTES,
+  run_prompt_sha256: HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256, run_prompt_chars: HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS,
+  upscale_allowed: ["ph-mouth-pc", "ph-loaf"],
+};
```

**(2) `lib/design-agent/quality-pipeline/photo-swap-shops.ts`** — 差し替えで AI のデモ画像を許す (承認された本文の SHA に限る):

```diff
+import { HOSHIGAMA_PROMPT_DRAFT_SHA256 } from "./hoshigama-ai-photos";
 …
   bakery: {
 …
-    aiDemoAllowed: false,
+    aiDemoAllowed: true,
+    aiDemoPromptSha256: HOSHIGAMA_PROMPT_DRAFT_SHA256,
   },
```

**(3) `scripts/sales-design-worker/autorun-shops.ts`** — worker の固定 manifest に足す:

```diff
+import { importHoshigamaAiPhotos } from "../design-artifact/hoshigama-ai-intake";
+import { buildHoshigamaRunPrompt, HOSHIGAMA_APPROVAL, HOSHIGAMA_MAX_UPSCALE, HOSHIGAMA_PHOTOS, HOSHIGAMA_PHOTOS_MAX_IMAGES } from "../../lib/design-agent/quality-pipeline/hoshigama-ai-photos";
 …
-  promptApproval?: typeof BICYCLE_RUN_PROMPT_APPROVAL;
+  promptApproval?: typeof BICYCLE_RUN_PROMPT_APPROVAL | NonNullable<typeof HOSHIGAMA_APPROVAL>;
 …
-  bundle: "tsugute_ai_photos_v0" | "bicycle_ai_photos_v0";
+  bundle: "tsugute_ai_photos_v0" | "bicycle_ai_photos_v0" | "hoshigama_ai_photos_v0";
 …
+const BAKERY_DIR = "design-library/research/quality-pipeline/poc/bakery";
 …
+  bakery: {
+    shop_id: "bakery",
+    page: "d2-v2",
+    pageDir: `${BAKERY_DIR}/fidelity/d2-v2`,
+    slotInventory: `${BAKERY_DIR}/photo-slots-d2-v2.json`,
+    slotEdges: `${BAKERY_DIR}/photo-slot-edges-d2-v2.json`,
+    slotIds: HOSHIGAMA_PHOTOS.map((p) => p.photo_id),
+    photoToSlot: Object.fromEntries(HOSHIGAMA_PHOTOS.map((p) => [p.photo_id, p.slot_id])),
+    maxImages: HOSHIGAMA_PHOTOS_MAX_IMAGES,
+    prompt: { source: "lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts", brief: "docs/design/hoshigama-ai-photo-brief.md", sha256: HOSHIGAMA_APPROVAL!.run_prompt_sha256, chars: HOSHIGAMA_APPROVAL!.run_prompt_chars, build: () => buildHoshigamaRunPrompt() },
+    promptApproval: HOSHIGAMA_APPROVAL!,
+    bundle: "hoshigama_ai_photos_v0",
+    intake: importHoshigamaAiPhotos,
+    out: { subdir: "image-autorun" },
+    rights: { sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: HOSHIGAMA_MAX_UPSCALE, upscaleMethod: "sharp-lanczos3" },
+  },
```

**(4) `scripts/sales-design-worker/image-autorun.ts`** — run の束を書く関数を繋ぐ:

```diff
+import { writeHoshigamaPhotosForRun } from "../../lib/design-agent/design-image/hoshigama-photos";
 …
-const BUNDLE_WRITERS: Record<"tsugute_ai_photos_v0" | "bicycle_ai_photos_v0", (o: BundleInput) => Promise<BundleOutcome>> = {
+const BUNDLE_WRITERS: Record<"tsugute_ai_photos_v0" | "bicycle_ai_photos_v0" | "hoshigama_ai_photos_v0", (o: BundleInput) => Promise<BundleOutcome>> = {
 …
+  hoshigama_ai_photos_v0: async (o) => {
+    const { dir, manifest } = await writeHoshigamaPhotosForRun(o);
+    return { dir, status: manifest.status, stop_code: manifest.stop_code, images: manifest.photos.length, image_tool_calls: manifest.image_tool_calls };
+  },
```

**(5) `scripts/sales-design-worker/cycle.sh`** — root の allowlist (root の clone の更新はオーナーが行い、差分の SHA-256 を輪の (b) と同じく固定する):

```diff
-IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'
+IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6 bakery:3'
```

**(6) テスト:** `tests/unit/design-agent/autorun-shops.test.ts` (manifest と allowlist の一致・pin)、`photo-swap-hoshigama.test.ts` の
「AI を許していない」「AUTORUN に無い」「cycle.sh に無い」の 3 つの確かめを、承認後の値に書き換える。

- 輪と同じく、**一覧に載ること自体は許可ではない**。毎回の実行には root のスイッチのエントリ (1 ジョブ)・root の使用の印・20 分の grant・worker の使用の台帳が要る。timer は入れない。
- 実行の後は、輪の (g) と同じく、ほし窯を `AUTORUN_SHOPS` と `IMAGE_AUTORUN_SHOPS` から外す PR を出す (新しい ID で 2 回目が走れてしまうため)。

ジョブ (輪の (d) と同じ形、値だけ違う):
`{"version":1,"shop_id":"bakery","page":"d2-v2","slot_ids":["ph-mouth-pc","ph-mouth-sp","ph-loaf"],"brief_sha256":"<承認された実行プロンプトの SHA-256>","approval_id":"<APPROVAL>","approval_scope":{"shop":"bakery","max_images":3,"max_jobs":1,"expires_at":"<EXP>"},"requested_at":"<REQ>"}`

## 5. ローカル DB の許可 (オーナーの承認が要る。今は何も無い)

今の取り込み (`lib/demo-version-package/import.ts`) は、写真のある包みを**輪の prospect (`RIN_PROSPECT_ID`) のデモにだけ**入れる。
ほし窯の S0 の prospect (`S0_PROSPECT_ID` = `13900000-5e00-4d00-8a00-000000000001`、`seed-s0.ts`) は `AI_DEMO_NOT_ALLOWED` で拒否される
(テストで確かめた)。DB も、共有の schema では架空の店でも実在扱いの prospect に AI のデモ画像を入れない (`sales_demo_images_real_shop_no_ai_demo`)。
ほし窯の写真入りの版をローカルで見るには、輪の `scripts/sales/demo-version/local-rin-ai-photos.sql` と同じ種類の、**ローカル専用**の許可が要る:

1. **SQL の patch (ローカルの stack だけ、migration にしない):** check `sales_demo_images_real_shop_no_ai_demo` と `sales_check_demo_image_write()` に、
   `S0_PROSPECT_ID` を、その行が S0 の架空の印を持つ間だけ (名前・住所は `s0RegistryRow` が facts から作るもの、連絡先は `s0-bakery.example.com` の
   example ドメインだけ) 足す。**輪の印 (連絡先が一つも無い) とは違い、S0 は送信の試験のために example の連絡先を持つ**ので、印の条件を別に決める必要がある。
   戻し方は輪と同じ `npx supabase db reset`。
2. **取り込みの許可:** `import.ts` の `RIN_PROSPECT_ID` の 1 件だけの確かめに `S0_PROSPECT_ID` を足す (コードの変更、レビューが要る)。
3. 写真入りの版は `ai_demo_internal` (管理画面の確認だけ) で、**送信・共有には出ない**。S0 の写真なしの送信用の版とは別の版になる。

## 6. 文章入りの v2 の包み: d2-v2 で通る

`package-local.ts --page … --facts …` は、写真の確かめ (権利・元の写真・描写の確認) をそのまま行い、文章を足して v2 にする。文章の記録は差し替えの
copy.json で、差し替えが外した 写真｜ の札 2 つだけが写真の alt (石窯の口・田舎パン) になる。審査は既存の監査をその page に round 0 で掛ける。

d2-v1 (前の版) は文を `<wbr>` で割っていたため、サーバーの文章の検査 (`checkArtifactCopy`、`checkArtifactHtml` の文字の断片を読む) が
`UNVERIFIED_COPY`・`JOINED_TEXT_LOOKS_LIKE_FACT` で止めた (写真なしのカンプも同じ)。検査は緩めず、`<wbr>` の無い版を作った:
カンプ `comps/d2-hearth-floor-v4` と C ページ `fidelity/d2-v2` (折り返しは CSS の箱の幅で句の切れ目に合わせる。写真の枠は d2-v2 と同じ寸法)。
差し替えの spec は d2-v2 を指す。テストは**コミットされた d2-v2** で、v2 (文章 + 写真、facts の SHA・権利・送信不可) が通ることを確かめる。

## 7. 実生成の後 (承認された場合)

- 写真・manifest・権利の記録は私有の成果物のまま、リポジトリに入れない (`docs/design/photo-intake.md` §3)。
- 指示書 §5 の V1〜V8 をオーナーが目で埋める。MOCK・stub の写真では 1 つも合格にしない。
- 包みの前に、オーナーが写真ごとに描写の確認 (`rin_depiction_confirmation_v0` の形、輪の `docs/operations/rin-ai-photos-local.md` §5) を書く。
