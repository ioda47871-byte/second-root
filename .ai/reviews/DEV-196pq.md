# DEV-196p / DEV-196q: 共有の前に必須の 2 つ (copy record の事実・創作の照合の表示、構造の比較の結果の保存)

オーナー Issue #263 (営業 MVP 最優先) の一部。承認済みの範囲は「コード・テスト・ローカル DB の検証・PR 作成・CI」。
Staging / Production の DB 変更・deploy・DNS / Vercel・実送信・画像生成・LLM の呼び出しは**していない**。
branch `feature/dev-196pq-share-prereqs` (`origin/develop` da46c83b から)。ローカルの検証は scratch に複製した別 project id
(`sr-dev196g`、port 5967x) のスタックで行い、終わったら止めた。「輪」(SR-001) のデータには触れていない。

## DEV-196p: copy.json の事実の行と創作の見出しの照合

### 既にあったもの (DEV-199d / DEV-199e)

受け入れ条件の大半は DEV-199d (#261) / DEV-199e (#262) で入っている:

- copy record の保存: `sales_demo_copy_reviews.copy_record_text`・`facts_pack_text` (監査したバイトそのもの、trigger が sha256 で照合)、版との結び付け `sales_demo_version_copy_links` (版の HTML / CSS の sha256 = review の hash)。
- 頁の見える文と copy record の照合、事実の行と事実パックの一致: 取り込みで `checkArtifactCopy` (`lib/demo-version-package/copy.ts`)、送信の前に `evaluateVersionCopyGate`。

### この PR で足したもの

DEV-196d-4 の比較の頁は「copy record が保存されていないので創作の見出しを区別しない」としていた。その解消:

- `lib/sales/demo-version/copy-lines.ts` (新、純粋): 保存された copy record・事実パック・facts hash と頁の文から、
  - server の照合 `checkArtifactCopy` (変えていない) を**保存されたバイトで再実行**し、符号だけを返す (文は返さない)。
  - 行の印: 「事実」= copy record の `fact` の行で、その項目に finding が無い (= 事実パックの値と一致) もの。「創作」= `creative_expression` / `proposal_pending_review` の行 (品質の判定の項目 2 で判断)。それ以外 (ラベル・記録に無い行・finding のある事実の行) は印なし。記録全体の finding (店・facts hash・schema の不一致) があれば、どの行も事実にしない。メールアドレスを含む行は隠し、事実にしない。
- `lib/admin/demo-compare.ts`: 両方の版に記録があるときだけ記録で印を付け (`basis: "copy_record"`)、版ごとの照合の結果 (`records.a/b`) を出す。片方に無い・読めない (RLS で見えない、壊れている) ときは今までどおり事実だけの印 (`basis: "facts"`、創作とは言わない)。記録は**管理者のセッション** (RLS) で読む。照合に使う文は取り込みと同じ `checkArtifactHtml(...).texts`。
- `components/admin/demo/CompareTables.tsx`: 「創作」の印、版ごとの照合の 1 行 (`記録に無い文はなく、事実の行は事実パックと一致` / 符号の一覧 / 記録なし / 読めない)、記録を使ったかどうかの説明。
- `lib/design-agent/quality-pipeline/copy-record.ts`: 正規化の `norm` を export しただけ (規則は不変)。

DB の変更なし。

## DEV-196q: 構造の比較の結果 (structure findings) の保存

### migration `supabase/migrations/20261114000000_sales_demo_structure_findings.sql` (ローカルだけ)

- `sales_demo_structure_findings`: 版ごとに 1 行 (`version_id` 主キー)、`demo_id`、`source` (`observation_report` だけ)、`findings` (jsonb)、`siblings_compared` (0〜20)、`recorded_at`。
- `sales_structure_findings_valid(jsonb)`: `quality.ts` の `StructureFindingInput` と同じ形だけ (4 つの code、それぞれちょうどその key、similarity 0〜1、reference は参照 id の形、sibling は uuid、reasons は `aspect:value` の語、aspects は 8 観点の名前、64 件まで)。check 制約と関数の両方で使う。
- trigger: insert のみ (update / delete は `structure_findings_immutable`)、版がその demo のもので `draft` / `approved` / `superseded`、sibling は**他の店**の版だけ。
- `sales_record_structure_findings(version, findings, siblings_compared, source)`: service role だけ。同じ内容は replay、違う内容は `structure_findings_exist` (最初の記録を黙って書き換えない)。
- RLS: 管理者だけ読む。anon は権限なし。service role は select / insert / update (trigger が update を拒否)、DELETE なし (`scripts/staging/lib.mjs` の `NO_DELETE_TABLES` と `tests/unit/staging/lib.test.ts` の固定リストに追加)。
- **どの guard もこの表を読まない** (品質承認・送信・共有を止めない。spec §7.5・オーナー決定 2026-11-10)。

rollback (ローカル、guard から読まれないので順に落とせる):

```sql
drop function public.sales_record_structure_findings(uuid, jsonb, integer, text);
drop table public.sales_demo_structure_findings;
drop function public.sales_check_structure_findings_write();
drop function public.sales_structure_findings_valid(jsonb);
```

### server と画面

- `lib/sales/demo-version/structure-findings.ts` (新、純粋): zod の厳格な形、`parseStructureFindingsInput`、`structureAdviceOf` (保存なし / 読めない / 保存あり → `templateWarnings`、`blocking: false`)。
- `lib/sales/structure-findings/store.ts` (新): `recordStructureFindings` (service role)・`loadStructureAdvice` (管理者のセッション。失敗は `unreadable`、決して「警告なし」にしない)。
- `lib/demo-version-package/import.ts`: 任意の入力 `structureFindings`。DB に書く前に形を検め (`STRUCTURE_FINDINGS_INVALID`、何も書かない)、版の後に保存 (再実行は replay)。
- `QualityReviewForm`: 項目 3 (`shop_specific_structure`) と 4 (`no_generic_lp_regression`) の下に、保存された警告 (`templateWarningText`、もともと未使用だった) を参考として出す。保存なし・読めないときはそう書く。どの選択肢も無効にしない。

### この PR で**していない**こと (承認が要る)

findings の**計算**。構造記述子の module (`lib/design-agent/structure/*`) は隔離されていて (`tests/unit/design-agent/structure/structure.test.ts` が importer を固定、例外はそれぞれオーナー承認)、server から成功例・他店の承認版との類似を計算するのは新しい importer になる。隔離を緩める差分は出していない。今は import の任意の入力として渡された findings を検めて保存できるだけで、それを作る側 (承認済みの観察 CLI `scripts/design-artifact/phase2f-structure-observe.ts` の報告からの変換、または worker) の配線は未。オーナーへの問い: (a) server に importer を 1 つ足して計算する、(b) 観察 CLI / worker の報告を取り込む、のどちらにするか。

## テスト

- unit: `tests/unit/sales/demo-version/copy-lines.test.ts` (7)・`structure-findings.test.ts` (13)・`tests/unit/admin/demo-compare.test.tsx` (+3: 記録で印、照合の符号、片方なしは事実だけ)・`tests/unit/admin/demo-review.test.tsx` (+1: 項目 3・4 の横だけ、選択肢は無効にならない)・`purity.test.ts` (純粋な module の一覧に 2 つ)・`tests/unit/staging/lib.test.ts`。
- 対象の unit 一式 (`tests/unit/admin`・`sales`・`staging`・`design-agent/structure`・`demo-version-package`・`demo-frame`): 失敗はこの環境に Chromium (playwright 1.62 用の build) が無いことによるものだけ (`observe.test`・`structure.test` の描画・`swap-photos.test`。変更前から同じ)。構造 module の隔離のテストは通る。
- 統合 (ローカル Supabase): `tests/integration/demo-structure-findings.test.ts` (新、3)・`demo-version-package.test.ts` (+1: 形の拒否は何も書かない、保存、replay)・`demo-copy-decision.test.ts` (+1: 管理者のセッションで記録を読み、印と照合、他の利用者は読めない)・`demo-versions-page`・`db-security-audit`・`staging-checks`。
- `tsc --noEmit`・eslint (変更したファイル)・`check:secrets`・`next build`。

## hosted に当てるとき (オーナーの後の承認)

- Staging / Production: migration `20261114000000_sales_demo_structure_findings.sql` を 1 つ当てる (`npm run staging:apply` の手順、DEV-199e までの migration が先)。新しい環境変数・DNS・Vercel の設定はない。
- 当てても画面は「保存されていません」と出るだけ (findings を作る側が無い間)。

## PR #265 の修正 (coordinator / Fresh Review C0 H0 M0 L4)

- CI unit (1/2) `tests/unit/ai-tasks.test.ts` (「review の task の依存は done」): DEV-196p / DEV-196q の `depends_on` を、まだできていない DEV-196e-1 (アップロード API) から DEV-196d (比較・品質の判定の画面) と DEV-199e (copy record の保存と import の経路) に直した (どちらも done)。copy record も findings も既存の import の経路 (`lib/demo-version-package/import.ts`) で保存し、アップロード API は使わない。テストは変えていない。
- Vercel の preview の build が `type_error` で失敗: ローカルでは `.next` を消した clean な `npm run build` が通る (1 回目は Google Fonts の取得の一時的な失敗、2 回目は成功)。CI の `build` job も decea5d で success。Vercel の log はこの session から見えないので、push で再 build させて結果を確かめる (下の「未解決」)。
- L1: 構造の findings の DB の拒否が、版と copy review の保存の**後**に起きうる問題。`precheckStructureFindings` (新、`lib/sales/structure-findings/store.ts`) が、書き込みの前に DB が拒否する条件を確かめる: 形と大きさ (JSON 8 KiB まで、DB の列の上限は 16 KiB)、sibling が他の店の approved / superseded の版であること、同じ bundle の版が既にあり違う findings を持っていないこと。それでも後で拒否された場合 (競合だけ) は、エラーの文に「版と copy review は findings なしで保存された」と書く (黙って半端な状態にしない)。テスト: unit (大きさの上限)、統合 (既存と違う findings・自店の sibling・大きすぎ、どれも版も object も書かない)。
- L2: trigger は sibling の版の status が `approved` / `superseded` であることも確かめる (統合: 他の店の draft の版は拒否)。
- L3: 保存されていないときの文から「（参考の警告はありません）」を削った。
- L4: 比較の頁の説明を「片方または両方の版に文章の記録が無い（または読めない）ため」に直した。

再実行: 統合 4 ファイル (27)・unit (`tests/unit/sales/demo-version`・`admin`・`ai-tasks`・`staging`、874)・`tsc`・eslint・clean な `npm run build`。
