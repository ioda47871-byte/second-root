# 品質実証の計画とギャップ監査（Issue #364 PR 1、2026-11-26）

状態: **設計・ギャップ分析だけ**（コードは変えない）。監査の対象は develop `46b501af`（#367 まで）。
この文書は何も承認しない。実 Codex の生成、実店舗の写真の取得や利用、外部への公開、Production、営業の送信、root の操作は、どれも別にオーナーの明示の承認が要る（§4）。
最上位の目標は「オーナーが承認した成功例の水準で、店舗固有のオリジナルのサイトを**安定して**作れる」こと（Issue #263 の最初の外部顧客、50,000 円買い切りの CMS サイト）。コードの完成や CI の green を、この目標の達成とは書かない。

正式なフローは [`image-first-production-flow.md`](image-first-production-flow.md)（8 段）。下の 12 工程は、オーナーの統合指示（2026-11-26）の粒度で、同じ順序を細かく分けたもの。

## 1. 12 工程 × 現状

区分の意味:
- **偽物のみ**: 単体試験・合成データ・架空の記録だけで通している。
- **実機済み**: 実際の生成画像・実際の撮影で通った記録がある。
- **無し**: 仕組みが無い。

| # | 工程 | 今あるもの（パス） | 状態 |
|---|---|---|---|
| 1 | 確認済みの店の事実 | `facts-pack.json`（`docs/operations/real-shop-demo-workflow.md` §2）、Identity Lock、`lib/design-agent/ja-renderings/ja-renderings.ts`（`sr_ja_renderings_v1`）+ `scripts/design-artifact/ja-renderings-check.ts`。架空の店の pack は `design-library/research/quality-pipeline/poc/{bakery,cafe,wagashi,…}/facts-pack.json` | 偽物のみ（実店舗の pack はオーナーの確認待ち） |
| 2 | 成功例の原本を 3 件以上、画像で分析 | `lib/design-agent/case-study/case-study.ts`（`sr_case_study_v1`、`MIN_COUNTED_ORIGINALS = 3` :57、`text_only` は数えない）、`scripts/design-artifact/case-study-check.ts`、`lib/design-agent/case-study/success-originals.ts`（#336 の照合・閲覧ページ）、`design-library/success-cases/originals-catalog.md` | 仕組みはある。数えられる原本は 3 件（CP-001〜003）だけで、どれも閲覧用 WebP か PoC の画面写し（§2.6） |
| 3 | 店固有のデザインの方針 | `second-root-design-director` スキル、依頼の `direction`（`request-prompt.ts` `RequestDirection`） | 偽物のみ（実際の店での記録は無い） |
| 4 | Codex で PC と SP のページ全体のデザイン画像 | `lib/design-agent/image-first/request-prompt.ts`（whole_page、1024×1536 :383・:771、写真枠 :712）、`lib/design-agent/imagefirst-worker/request.ts`・`request-cycle.ts`・`request-run.ts`、`scripts/sales-design-worker/imagefirst-worker.ts --print-plan`（送る内容をオフラインで表示、:82） | **whole_page の実際の試行は 0 回**（`req-vatten-design-01` は古い節分割の依頼で `CODEX_NO_IMAGE`、flow §4.1） |
| 5 | 独立審査と**第 1 承認（構図）** | `lib/design-agent/imagefirst-worker/design-approval.ts`（`sr_design_review_v1` は 5 観点で助言、`sr_design_approval_v1` は bundle・画像・review・page の SHA-256 に結びつく）、`scripts/design-artifact/design-approval-check.ts` | 偽物のみ（`rehearsal.ts` の合成の bundle で通る） |
| 6 | 承認した構図に要る素材 | `request-prompt.ts` `Material`（:116-122）・`ApprovedDesignRef`（:126-133）、`materials-approval.ts`（`sr_materials_review_v1`／`sr_materials_approval_v1`）、確認ページ（#354） | 偽物のみ。承認後の実際の素材の生成は一度も無い |
| 7 | 承認したデザインに忠実な Claude の HTML/CSS | `materials-impl-check.ts`（承認した素材の SHA-256 だけ、「イメージ」の表示）、`impl-compare-approved.ts`（PC1440/SP390 の撮影と承認した画像の比較、`passing` は常に false で助言だけ） | 偽物のみ（合成のデザインと手で書いた頁） |
| 8 | 写真入りの完成サイトを PC/SP で撮影 | `impl-compare-approved.ts` の撮影、`experiments/pages-cms/q1-check.ts`・`q1-render.ts`（実際の Chromium。CI には入っていない） | 偽物のみ（架空の店の単色の PNG） |
| 9 | 独立審査と**第 2 承認（写真入りの完成）** | **無し**（第 2 承認・最終承認の記録はコードのどこにも無い） | 無し |
| 10 | Pages CMS の統合と、更新後も構図が残ること | `experiments/pages-cms/*`（content model、総額表示、写真の上限、`imageKind`、`generated-materials.json`、`.pages.yml`、パン屋・カフェ、`stage-for-gates.ts`）、`tests/unit/experiments/pages-cms*.test.ts`（CI で動く） | 偽物のみ（experiments/ のまま。実際の Pages CMS・Cloudflare では試していない） |
| 11 | 営業デモの品質・事実・権利・共有の検査 | `scripts/design-artifact/comp-copy.ts`、Supabase の `sales_send_guards`・`sales_copy_send_block`・`quality_approval_required`、`sales_demo_images`（画像の権利） | 営業側の検査はある。IMAGE_FIRST の記録とはつながっていない（§2.9） |
| 12 | 営業の管理画面の送信準備へつなぐ | `scripts/sales/demo-version/package-local.ts` → `import-local.ts`、`lib/sales/approval.ts`、`lib/sales/demo-share.ts` | 部分的（ローカルまで。共有 URL の本番の設定 B-1〜B-6 は未実施） |

合成の通し試験 `lib/design-agent/imagefirst-worker/rehearsal.ts`（+ `scripts/design-artifact/imagefirst-rehearsal.ts`、`bundle.ts` の `synthetic: true`）は、工程 5〜8 を disk 上で通す。`synthetic` の印があるものは、実際の結果としては断られる（`RECEIPT_SYNTHETIC`、`APPROVED_DESIGN_SYNTHETIC`、`SYNTHETIC_NOT_LOGGED`）。
これは配線の確認であって、品質の実証ではない（素材の bundle を含まないので、`materials-impl-check` は通し試験に入っていない。`first-client-pipeline.md` §5）。

実際の run（記録で確かめたもの）は 3 つある。
- `hoshigama-imagefirst-d3`: 古い承認モードで、節に分けた 6 枚。
- `req-vatten-design-01`: 節に分けた古い形。`CODEX_NO_IMAGE` で 0 枚。
- `req-vatten-photo-01`: 古い `photo_brief` の形で 6 枚。今のフローでは数えない。

実店舗の審査・承認の記録（`design-reviews/`）は無く、実店舗で `impl-compare` を実行した記録も無い。vatten の手で書いた `site-v3〜v5` は画像を `images/` に置いているので、`materials-impl-check` を通らない（研究の記録、`image-first-production-flow.md` §7）。

## 2. ギャップと最小の変更

| 項目 | 今の事実（file:line） | ギャップ | 最小の変更 | PR |
|---|---|---|---|---|
| 2.1 写真枠の契約 | `Material` は `{id, kind: photo/background/decoration, aspect: 3:2/1:1/2:3, placement: 自由記述 120 字, note}` だけ（`request-prompt.ts:116-122`）。whole_page の写真は「単純な長方形か角丸の枠、中は無地か斜線、隅に小さく「イメージ」」（:712）。古い経路には「写真の上に文字を重ねない」がある（:498） | 用途（hero/product/background/decor）、主役の位置、crop・object-position、PC/SP 別の配置、余白・視認性の指定が無い。枠の位置を機械で測る基準が無い | §3.1 の写真枠の指定を、第 1 承認の付属の記録として足す（承認した画像は変えない）。IMAGE_FIRST 以前の `lib/design-agent/photo-review.ts:13`（crop・focal_lost・mobile_crop）の観点を使い回せるか確かめる | 2b |
| 2.2 写真の出自 A/B/C | `imageKind: z.enum(["generated","shop"]).default("generated")`（`experiments/pages-cms/content-model.ts:119`）。CMS の既定値も `generated`（`pages-config.ts:91-96`、`bakery.pages.yml:63-70`）。`generated-materials.json` の SHA と完全に一致する画像を `shop` と表示すると止まる（`photos.ts:64-67`、バイトの一致だけ） | ① 既定の `generated` は「イメージ」が付く安全な側で、CMS は「店の写真」も選べる。ただし顧客が選び忘れると、本物の写真に「イメージ」が付いたままになる（誤表示の余地）。② `shop` の中で B（成約前に店が提供し、権利を確認した写真）と C（成約後の CMS の写真）が混ざっている。③ B の権利・出典の記録が無い。④ `CONTENT_GENERATED_AS_SHOP` はバイトの完全な一致だけを見るので、変換した生成画像は見逃す（`photos.ts:18-19` に記載あり）。⑤ `materials-impl-check.ts:189-190` は承認されていない画像をすべて `MATERIALS_IMPL_IMAGE_NOT_APPROVED` で断り、`shop` を除外しないので、納品後の C を含む頁はこの検査を通れない | 出自を `generated`（A）/ `shop_provided`（B）/ `customer_cms`（C）の 3 つにし、§3.2 の出自の記録を足す。**既定は「イメージ」が付く `generated` のまま**にする。C は顧客が明示して選ぶか、納品の段が設定する（そのとき `generated-materials.json` の照合は効いたまま）。`CONTENT_GENERATED_AS_SHOP` を B と C の両方へ広げる。変換した生成画像を見逃す点は、既知の限界として記録に残す。A の SHA の検査は緩めず、C は別の経路の自動検査（§2.5）にする | 2a（分類と出自の記録）、5（CMS の選択肢と既定、C の自動検査） |
| 2.3 IMAGE_FIRST の第 2 審査と第 2 承認（営業側の `quality_approval_required` とは別のもの） | 第 1 承認は `design-approval.ts:117-127`、素材の承認は `materials-approval.ts`。完成サイトの比較は `impl-compare-approved.ts` が助言として出す（`sr_impl_compare_v1`） | 写真入りの完成ページの審査（写真と背景の色の調和、明るさと文字の読みやすさ、主役と crop、写真・余白・文字・装飾の一体感、PC/SP の完成度、店らしさ、成功例と比べた独自性、写真でデザインの質が落ちていないか）の記録も、承認の記録も無い。未承認のまま共有・送信へ進むのを止める仕組みも無い | `sr_final_review_v1`／`sr_final_approval_v1`（§3.3）を、`design-approval.ts` と同じ形（助言の審査、オーナーが言ったときだけ Claude が書く記録、page_sha256 の再計算、fail は承認で上書きしない）で作る。構図の大きな変更があったら第 1 承認へ戻す（`FINAL_COMPOSITION_CHANGED`）。枠・位置・比率は機械で測り、写真の画素の違いとは分ける | 3a |
| 2.4 拡大の詳細カンプ（検討して、最小限を実装） | 文書は認めている（`image-first-production-flow.md:51` §3.2「承認した全体の画像を参照する追加の画像で補う」）。コードには無い（grep で `detail`／拡大カンプは 0 件） | 1024×1536 では長い頁の文字や細部が読めない。補助の画像を承認した全体の画像に結びつける形も、補助の画像が構図を変えていないかの検査も無い | `detail_comp` の依頼の種類を足す：`approved_design` を必須にし、対象の範囲（hero・品書き・店の情報）を全体の画像の中の矩形で指定し、参照は 5 枚以内。補助として審査し、それだけで正式な成功とは数えない。実装の検査は全体の画像と詳細の画像の両方と比べる | 4 |
| 2.5 CMS の写真の更新でデザインが残るか | 写真の自動検査は 2MB、長い辺 4096、短い辺 320 以上、比 3:1 以内、形式と拡張子の一致（`photos.ts:33-50`、ヘッダーだけ）。枠は `aspect-ratio` + `object-fit: cover` で固定（`bakery-site.ts:9`）。Q1 ははみ出し・重なり・欠けた画像だけを見る | 差し替えの前後で承認した構図と比べていない。主役の位置・crop の確認も、安全性（内容）の確認も無い。パン屋・カフェは手で書いた頁で、承認した全体の画像から作っていない | 写真枠の指定（§3.1）の `object_position` を頁へ出す。Q1 に「写真を差し替える前と後で枠の位置と大きさが同じか」の測定を足す。今の品数 0・3・10・50 と長い文章の試験データを使い回す（新しく作らない）。C の更新は自動検査だけで通し、オーナーの再承認は求めない | 5 |
| 2.6 #336 の原本 | 37 件。A 4 件（数えられるのは CP-001〜003 の 3 件。閲覧用 WebP と PoC の画面写しで、元の PNG は未受領）。B 26 件、C 7 件。疑似復元のバイトは 0（CP-024 v3 は記録だけ）。2026-11-26 の棚卸しで新しい原本は 0 件（`docs/design/success-originals-handover.md:9-23`） | 3 件しか無いので、店の性格に合う原本を選べない。`/mnt/c` は探していない | オーナーに渡してもらう（§4）。優先は SR-002・CP-033〜037（ZIP と SHA）、次に CP-024/009/015（PC と SP の両方がある HTML の PoC）、CP-001〜003 の元の PNG。C は所在の確認から | 続き（#336） |
| 2.7 失敗のカタログ | `.claude/skills/second-root-design-director/references/failure-patterns.md` に 8 つの型（同じ骨格・凡庸・その店ではない・磨きすぎ・仕組みの新しさ・Hero だけ・店の取り違え・似すぎ）と、その根拠の事例 | IMAGE_FIRST の審査（`design-approval.ts` の 5 観点）や第 2 審査から参照していない。店ごとの「なぜ成功し、なぜ失敗したか」の記録が無い | 審査の根拠の欄で、型の名前を**任意の参照**として書けるようにする。禁止語の一覧や固定のテンプレートにはしない。原理は店の事実から導く | 3a（審査の欄）、7（比較） |
| 2.8 架空のパン屋の E2E の準備 | 架空の pack（hoshigama・cafe・wagashi）、合成の通し試験（cafe）、`--print-plan` がある | 通し試験はカフェの合成画像だけ。工程 9 の第 2 審査、CMS 更新の後の比較、成功例と並べる確認ページが無い。実際の生成が要る段は、承認の依頼の形が決まっていない | PR 2〜5 の後に、パン屋で工程 1〜11 をオフラインで通す。実際の承認が無い段は「模擬の記録」と明記する。故意の破損・不一致（古い承認、未承認の素材、構図の変更、B/C に生成画像）が断られることを試験にする。CMS の段は今の 0・3・10・50 品と長い文章の試験データを使い回す | 6 |
| 2.9 複数店の比較 | 無し | 3 店を同じ観点で比べる記録が無い | 比較の記録（構図の違い、情報設計、独自性、写真の調和、Claude の再現性、SP の完成度、CMS への耐性）を作る。実測していない成功率は書かない | 7 |
| 2.10 営業の共有・送信とのつながり | `sales_send_guards` と `sales_copy_send_block` は品質承認・文章の確認・送信の承認だけを見る。lib/sales・app/admin・supabase に IMAGE_FIRST の承認の参照は 0 件 | 第 2 承認の無いデモでも、管理画面の品質承認で共有・送信へ進めてしまう。`package-local.ts` には IMAGE_FIRST の形が無く、写真を WebP に変換する（SHA が変わる） | `package-local.ts` に **IMAGE_FIRST 用の新しい包装の形**を足す。この形だけが第 2 承認（§3.3）を必須にし、変換した写真は元の SHA と保存した SHA の対の記録（§3.2）で扱う。既存の形には検査を足さない。ローカルだけで、DB の migration は無い。DB の gate へ入れるのは別の承認の後 | 3b（包装の形）、本番は別の承認 |

## 3. 最小のデータ契約（提案。コードではない）

### 3.1 写真枠の指定 `sr_photo_slots_v1`（第 1 承認の付属。承認の画像 SHA に結びつく）

| 欄 | 内容 |
|---|---|
| `approved_design` | 既存の `ApprovedDesignRef` と同じ欄（`bundle_id`・`bundle_sha256`・`review_file`・`approval_file`、`request-prompt.ts:126-133`）と、承認の記録の `approval_sha256` |
| `slots[]` | `id`、`role`（hero / product / background / decor）、`material_ids`（どの素材を入れるか） |
| `pc` / `sp` | 視点ごとに `box`（承認画像の中の位置と大きさ、0〜1 の矩形）、`aspect`、`shape`（rect / rounded）、`object_position`（例「50% 35%」）、`subject`（主役の位置: center / left-third / right-third / top / bottom）、`text_gap`（写真と文字の間合い: adjacent / separated） |
| `notes` | 余白・明るさ・視認性の注意（自由記述、事実を書かない） |

写真枠の指定は承認した画像を変えない。`box` が承認画像と合わない指定は断る。**文字を写真に重ねる指定は、この形では書けない**（`text_gap` に重ねる値は無い）。重ねる表現が要るときは、§4 の別の承認の項目にする。

### 3.2 出自の記録 `sr_photo_provenance_v1`（ファイルごと）

| 区分 | 必須の欄 | 表示 | 検査の経路 |
|---|---|---|---|
| A AI の提案用素材 | `materials_approval` の SHA、`sha256`（承認した PNG。頁にはこのバイトのまま置く） | 「イメージ」必須。店のものとして見せない | 既存の `materials-impl-check.ts`。**完全な一致のまま**で、変換した写しは決して受け付けない |
| B 店が提供した本物の写真 | `provided_by`（役割だけ。個人名は書かない）、`permission`（範囲・確認日・確認した人の役割）、`source`、`facts_check`（写っている商品・店内を事実として確認したか）、`sha256` | 「イメージ」を付けない。デザインに使える | 新しい B の検査（権利の記録が無ければ断る）。保存はリポジトリの外 |
| C 成約後の CMS の写真 | `uploaded_via: pages_cms`、`commit`、`sha256` | 「イメージ」を付けない | 自動検査だけ（寸法・形式・比・大きさ・頁の崩れ）。Second Root の手動の承認は求めない |

3 つは混ぜない。A の SHA が B/C の欄に出たら断る（今の `CONTENT_GENERATED_AS_SHOP` を B と C へ広げる。変換した写しはバイトの一致では見つからないことを、既知の限界として書く）。

**変換（縮小・再圧縮）の記録は別にする。** 包装や配信で写真を変換するときは、`materials-impl-check.ts` を広げずに、別の記録 `sr_photo_transform_v1`（`source_sha256` → `delivered_sha256`、`transform`、品質の値）と、別の検査を作る。前例は `scripts/sales/demo-version/package-local.ts:209` の写真の WebP 変換（`original_sha256` → `stored`）。元の `source_sha256` は、承認の段で照合を通ったものに限る。

### 3.3 第 2 承認 `sr_final_review_v1` / `sr_final_approval_v1`

| 欄 | 内容 |
|---|---|
| `approved_design` | §3.1 と同じ（`bundle_id`・`bundle_sha256`・`review_file`・`approval_file`・`approval_sha256`） |
| `detail_comps[]` | 使ったときだけ：詳細カンプの bundle の SHA-256 と、その承認の SHA |
| `photo_slots_sha256` | §3.1 の記録の SHA |
| `materials[]` | ファイルごとに `class`（A/B。デモの段では C は無い）、`sha256`、出自の記録の SHA、変換したときは `sr_photo_transform_v1` の SHA |
| `build` | サイトの成果物の SHA-256（index.html・CSS・各 asset、または tree の hash）と、構築した commit |
| `captures` | PC1440・SP390 の全ページの画像の SHA-256 |
| `impl_compare_sha256` | `sr_impl_compare_v1` の record の SHA（助言） |
| `review`（審査） | 観点ごとの判定（pass / revise / fail）と根拠：色の調和、明るさと可読性、主役と crop、一体感、PC/SP の完成度、店らしさ、成功例と比べた独自性、写真による質の低下の有無、構図の維持、事実・権利・表示 |
| `review_sha256`・`page_sha256` | 審査の記録と、オーナーが見た確認ページ（再計算する） |
| `decision`・`decided_at` | approve / revise / reject。審査の後の時刻 |

どれか 1 つの SHA が変われば、古い承認は使わない。
**第 2 承認の対象は、デモとして見せる成果物、または納品する時点の成果物だけ。** 納品の後に顧客が CMS で行う C の更新は、自動検査（§2.5）だけで扱い、新しい第 2 承認は求めない（SHA が変わっても、納品後の更新では第 2 承認を作り直さない）。
この記録は、Claude がオーナーの指示を書いたもので、**本人の電子署名ではない**。オーナーが実際に承認していないものを承認済みとは扱わない。

## 4. オーナーの承認が要るもの

| いつ | 何を | 依頼に書く内容 |
|---|---|---|
| §6 の 5.5（PR 6 の前。実際の画像が要るとき） | Codex の実際の生成（デザイン、素材、詳細カンプ） | `--print-plan` の結果、固定する commit、対象（架空の店か実店舗か、依頼 ID）、回数、利用枠（1 日・1 週の上限の残り）、参照画像（5 枚以内、原本の id と SHA）、成果物の扱い（置き場、git に入れない、消さない） |
| B の写真を使う前 | 実店舗の写真の取得と利用 | 店の許可の範囲、出典、保存場所、事実として確かめる範囲 |
| 工程 5 と工程 9 | 第 1 承認・第 2 承認 | オーナーが確認ページを実際に見て言ったこと（記録は署名ではない） |
| #336 | 原本の受け渡し | SR-002・CP-033〜037 の ZIP、CP-024/009/015、CP-001〜003 の元の PNG、C 7 件の所在 |
| 必要になったとき | 写真枠の制約の変更（大胆な配置、背景と溶け合わせる、文字を重ねる、マスク） | 別の承認の項目として、案と、誤認の危険・差し替えのしやすさへの影響を示す（今の安全規定の中での研究を先にする） |
| 本番 | DB の送信の gate へ第 2 承認を入れる、共有 URL、Production、送信 | それぞれ個別に |

写真枠の研究で答える問い（PR 2b・4 で、今の安全規定の中で）:
- 単純な矩形・角丸の枠のままで、配置の大胆さ（大きさ、裁ち落とし、非対称）でどこまで質を出せるか。
- 枠の周りの色・余白・地の模様で、写真と背景をどうなじませるか。
- 文字を写真に重ねずに、近くに置いて一体に見せられるか。
- `object-position` と crop を写真ごとに決め、PC と SP で別にすると、差し替えの耐性は落ちるか。

## 5. 完成度の区分（2026-11-26、正直な状態）

| 区分 | 意味 | 状態 |
|---|---|---|
| A コードの完成 | 必要な仕組みがマージ済みで試験がある | **一部**。工程 1〜8 と 10〜12 の部品はある（偽物と合成のデータだけで検証）。工程 9 の第 2 承認、写真枠の指定、A/B/C の出自、詳細カンプ、CMS の差し替え前後の比較、営業の gate とのつながりは無い |
| B 実際の制作で検証 | 実際の画像・写真・Claude のサイト・PC/SP の審査に合格 | **未達成**。whole_page の実際の試行は 0 回（`req-vatten-design-01` は古い節分割の依頼で失敗）。承認後の実際の素材も、写真入りの完成サイトも無い |
| C 3 店での安定 | 性格の違う 3 店で同じ観点で合格 | **未達成**（1 店も B に達していない）。オフラインの PR 7 では C を示せない。実際の生成（その承認）と実際の審査が要る |
| D 販売・納品できる | CMS の更新、公開、所有権の移転、共有のデモ | **未達成**（実際の Pages CMS・Cloudflare での確認、Q2〜Q4、共有 URL の本番の設定は未実施） |

成功率は、実際に実験していないので書かない。

## 6. PR 2〜7 の分け方（オーナーの順序）

| PR | 内容 | 完了の条件（オフライン、架空のデータ） |
|---|---|---|
| 2a | 写真の出自（§3.2）：3 つの区分、B の権利の記録、`CONTENT_GENERATED_AS_SHOP` を B と C へ、変換の記録 `sr_photo_transform_v1` と専用の検査 | A/B/C が混ざると断られる。既定は「イメージ」が付く側のまま。`materials-impl-check` は完全な一致のまま |
| 2b | 写真枠の指定（§3.1）：第 1 承認への結びつけ、PC/SP 別の `box`・`object_position`・主役の位置 | `box` が承認画像と合わない、承認と結びつかない指定が断られる。文字を重ねる指定は書けない |
| 3a | IMAGE_FIRST の第 2 審査と第 2 承認（§3.3）、確認ページ | 古い承認、SHA の不一致、構図の変更、未承認の素材が断られる |
| 3b | `package-local.ts` の IMAGE_FIRST 用の新しい包装の形（第 2 承認が必須、変換の記録を使う）。既存の形は変えない | 第 2 承認が無い、または成果物の SHA が違うと包装できない |
| 4 | 詳細カンプ（検討して最小限を実装）：依頼の種類と、全体と詳細の両方での忠実さの検査 | 詳細カンプが承認した全体の画像に結びつかなければ断られる。参照は 5 枚以内 |
| 5 | CMS の写真の更新とデザインが残るかの検査（Q1 の差し替えの前後の比較、object-position、CMS の選択肢、C の自動検査）。0・3・10・50 品と長い文章の試験データを使い回す | 3:2・1:1・2:3、写真なし、主役の位置の違いでも枠が同じ |
| 5.5 | **実際の生成の事前検査と承認の依頼**（コードではなく手順）：`--print-plan` の結果を添えて、固定する commit、対象（店・依頼 ID）、回数、利用枠、参照画像（5 枚以内、id と SHA）、成果物の扱いを書き、オーナーに出す | オーナーが承認するまで実行しない。承認が無ければ PR 6 は模擬の記録のまま |
| 6 | 架空のパン屋で工程 1〜11 を通す（実際の生成は、5.5 の承認が出たときだけ） | 故意の破損が断られる。成功例と並べる非公開の確認ページ |
| 7 | パン屋・カフェ・和菓子の 3 店の比較 | §2.9 の観点の記録。実測の無い数字は書かない。オフラインだけでは完成度 C を示せない |

オーナーの最新の指示（§10）の順序（1 ギャップ監査、2 写真の出自と配置、3 第 2 審査、4 詳細カンプと忠実な実装の確認、5 CMS の写真の更新、6 架空の店の E2E、7 複数店）を保ち、2 と 3 をそれぞれ 2 つの小さな PR に分け、5.5 の手順を足した。
