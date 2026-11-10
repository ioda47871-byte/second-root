# DEV-196c: 店舗デモの版の DB (ローカルだけ・版の共有は DB で無効)

2026-11-10。branch `feature/dev-196c-demo-versions-db` (`origin/develop` 93ee591 から)。仕様は `docs/design/DEV-196-demo-admin-spec.md` (§4・§4.6・§5・§6.4・§8・§8.3.1・§9.2〜§9.5・§10.2・§12・§15)。

**範囲 (オーナー承認 2026-11-10)**: migration の作成、ローカル Supabase への適用と確認、ローカル Storage の設定と試験、統合・セキュリティのテスト、PR。**Staging・Production への適用、hosted の bucket の作成、Vercel の環境変数・DNS、画像生成、WSL の worker、実店舗のデモの公開・送信、期限切れの成果物の削除はしていない。** `.github/workflows`・`package.json`・lockfile の変更なし。

## 何を足したか (`supabase/migrations/20261111000000_sales_demo_versions.sql`)

| もの | 中身 | 仕様 |
|---|---|---|
| `sales_demo_versions` | 版 1 つ = 成果物 1 つ。`version_no` (demo ごとに unique)、`parent_version_id` (系譜、同じ demo だけ: trigger)、`origin`、`generation_job_id` (unique = 冪等性の鍵)、`worker_commit`、`facts_sha256` (DB が `content` から計算)、`direction_sha256`、`bundle_sha256` (DB が再計算)、`manifest`、`storage_prefix` (= `v1/<demo>/<id>/`、check)、`total_bytes`、`status`、`validator_result` など (≤ 2KB / 1KB)、`share_eligible` (check で **false だけ**)、`expires_at` (作成から 60 日)、取り消しの 3 列 | §4.1・§4.6・§10.2 |
| `sales_demo_version_files` | manifest のファイル (path は §5.2 の形だけ、役割・content type・大きさ・寸法の check、photo は `image_id` 必須)。pk (`version_id`, `path`) | §4.2・§5.2 |
| `sales_demo_images` | 画像ごとの権利と出所 (DB だけ)。`sha256` unique、`prospect_id` (別の店で使うと拒否)、`rights_status` (§8.1 の enum、既定 `unknown`)、`depicts_*`、オーナーの確認、`allowed_uses` (strict)、`provenance` (≤ 2KB)、`owner_ai_share_decision_*` (check で null だけ)、取り消し | §4.3・§8 |
| `sales_demo_quality_reviews` | **品質承認** (送信承認とは別の表)。`decision`・`state` (active → withdrawn / invalidated だけ)・`checklist` (7 項目、check)・`viewed_renders_sha256`・snapshot (bundle / facts / rights_summary の hash)・`note` (≤ 500 字、URL・メールなし)・`reviewed_by` | §4.4・§7.2 |
| `sales_demos.approved_version_id` | 品質承認済みの版 (関数だけが書く。trigger が管理者と承認済みの版を要求) | §4.4・§9.3 |
| `sales_outreach_approvals` の列 | `demo_version_id`・`demo_bundle_sha256`・`demo_quality_review_id`・`demo_share_eligible` (4 つとも null = legacy、check)、`demo_unavailable_after_open` (sent で版を固定したときだけ) | §9.2・§9.5 |

**index**: `sales_demo_versions_one_uploading` (demo ごとにアップロード中は 1)、`sales_demo_versions_bundle_key` (同じ bundle は demo ごとに 1、rejected を除く)、`sales_demo_versions_one_approved`、`sales_demo_quality_reviews_one_active_approval` (demo ごとに active な approved は 1)、`sales_demo_versions_no`、`generation_job_id` unique、`sales_demo_images.sha256` unique、files の pk。参照用の index (parent・image・version・承認の版)。

**関数**

| 種類 | 関数 | 実行できる role |
|---|---|---|
| 管理者 RPC (SECURITY DEFINER、最初に `sales_assert_admin()`) | `sales_review_demo_version` (品質承認 / 差し戻し / 不採用)、`sales_withdraw_demo_quality_review`、`sales_revoke_demo_version`、`sales_revoke_demo_image` | authenticated (中で管理者を確認) |
| worker の経路 | `sales_ingest_demo_version` (invoker、未承認の `draft` を作るだけ) | service_role だけ |
| 共有の判定 | `sales_resolve_demo_share` (none / legacy / version。version は今は返らない) | service_role だけ |
| 照合・補助 | `sales_demo_version_send_block` (§9.2)、`sales_demo_version_after_open_code` (§9.5)、`sales_demo_assert_no_open_send`、`sales_demo_version_shareable` / `_rights_shareable`、`sales_demo_image_shareable` / `_previewable`、`sales_demo_facts_sha256`、`sales_demo_bundle_sha256`、check 用の 4 つ、旗の 2 つ | service_role だけ |
| trigger | 画像・版・ファイル・品質承認・`approved_version_id` の書き込みの規則 | (なし) |
| 置き換え (create or replace、同じ引数・grant) | `sales_demo_version` (§9.3)、`sales_approval_is_current`、`sales_send_guards` (§9.2)、`sales_check_approval_write`、`sales_approve_outreach` (版の固定)、`sales_mark_sent` (§9.5 の記録) | 従来どおり |

## オーナーの要求 1〜8 との対応

1. **追跡**: 版 (`version_no`)・系譜 (`parent_version_id`、同じ demo だけ)・生成 job (`generation_job_id` unique、同じ job の再送は同じ版、別の bundle は `job_conflict`)・hash (`bundle_sha256` は DB が `canonicalManifest` と同じ形で再計算して DEV-196b の `bundleSha256` と一致、`facts_sha256` は DB が計算、ファイルごとの sha256 は `sales_demo_version_files`)。
2. **二つの承認の分離**: 品質承認は `sales_demo_quality_reviews` と `sales_review_demo_version`、送信承認は DEV-195 の `sales_outreach_approvals` のまま。品質承認は送信承認を作らない (テストで固定)。§9.3: `approved_version_id` が null のとき `sales_demo_version` は**今と同じ 5 要素の hash** (テストで旧式と一致を確認) なので、live な DEV-195 の承認は有効のまま。版があれば id と bundle の hash を足す。送信承認は版の id・hash・品質承認を固定する (挿入時に整合を trigger で確認)。
3. **DB での防御**: `sales_send_guards` が承認と「送信画面を開く」のたびに、版 (approved・取り消しなし・期限内)・品質承認 (active・snapshot 一致)・事実 (`facts_sha256` = 今の `content`)・権利を**元の行から導き直す** (`demo_version_unavailable` / `demo_quality_not_approved` / `demo_facts_changed` / `demo_not_shareable`)。保存した `share_eligible` などは見ない。`ai_concept_internal`・`ai_demo_internal` は table の check で `share_cleared` になれず、`sales_demo_image_shareable` も false。**版の共有の無効**: `sales_demo_versioned_sharing_enabled()` と `sales_demo_share_photos_enabled()` は定数 false (変えるのは後の承認の migration)、`share_eligible` は check で false、`sales_resolve_demo_share` は版を返さない。結果として、承認済みの版がある店の送信承認は今は `demo_not_shareable` で断られる。**React のデモの共有は変えていない**: `/demo/[publicToken]`・`isDemoPublic` はこの関数を呼ばず、版を固定していない送信済みは `legacy`、版を固定した送信済みは `none` (取り消し後も React に落ちない)。
4. **厳しい安全**: 新しい 4 表すべて RLS・管理者だけ select・anon の権限なし・authenticated の直接の書き込みなし。管理者の関数は SECURITY DEFINER・最初に管理者の確認・`search_path = ''`・PUBLIC / anon の実行なし。FK (`on delete restrict`、版は店舗の削除を止める)・unique・partial unique。版の内容・hash・ファイルは作成後に不変、版・ファイル・画像・品質承認の行は消せない、品質承認は append-only。`send_opened` (§9.5): 新しい版の品質承認・取り下げ・版の取り消し・画像の取り消しは `approval_open` で何も書かない。
5. **worker の権限**: worker の経路は `sales_ingest_demo_version` だけ (service_role、SECURITY DEFINER でない)。挿入は常に `draft`。trigger が「版を approved にする」「品質承認を書く」「`approved_version_id` を設定する」「品質承認を取り下げる」を**サインイン中の管理者 (`auth.uid()` が `sales_admins`)** に結び付けるので、service role の鍵で表に直接書いても承認できない (テストで固定)。管理者の RPC は service role から呼ぶと `forbidden`。
6. **互換**: 既存の統合テスト 23 ファイルすべて通る (DEV-195 の send-approval 48 件・mark-sent・design-bridge・demo-public など)。版の無い店 (draft の版があっても) は従来どおり React のデモで承認・送信できる (テストで固定)。
7. **参照を写さない**: 成功例 30 件・SR-001 を読む表・関数・既定値は無い。版のファイルはその版の manifest からだけ。
8. **台帳**: DEV-196a を done (PR #244 を 93ee591 で merge、docs だけ、レビュー 2 回、最終 C0/H0/M0/L0、CI 11/11)。DEV-196c を review (depends_on DEV-196b) で追加。

DEV-196d の計画からの追加 (coordinator 経由): 品質承認の `note` (500 字まで、trim・空は null・URL / メールは関数で拒否し、table の check でも同じ規則)、見た描画画像 (PC1440・SP390、版に tablet があれば tablet も) の sha256 を版の render ファイルと照合 (見ていない・別の hash・版に無い render は `render_not_viewed`、render が無い版は `render_missing`)。

## Storage (ローカルだけ)

- `supabase/config.toml`: `[storage] enabled = true`、`file_size_limit = "4MiB"`、bucket `sales-demo-versions` (`public = false`、4MiB、`text/html`・`text/css`・`image/webp`・`image/jpeg`。PNG・SVG なし)。ローカルの `supabase start` / `db reset` が bucket を作る。hosted には何も作らない (config.toml は push していない)。
- storage の policy は作らない (読み書きは service role だけ)。
- テスト: DB の層 (どの storage の policy も anon / authenticated / PUBLIC に与えず bucket を名指さない、bucket があれば非公開、公開 bucket なし) は CI でも走る。Storage の API の 1 件 (bucket の設定、anon / 非管理者 / 管理者のセッションで読めない・書けない・一覧できない、公開 URL で出ない、PNG / SVG を受けない、service role は読み書きできる) は storage の service が無いとき (CI の `-x storage-api`) だけ `skipIf` で skip する。CI と同じ除外で起動して確認: 433 passed / 1 skipped。

## ローカルの適用の記録

- 隔離したローカルの stack (project_id `sr-dev196c`、port 553xx。他の作業の stack と分けるため。scratch の config で、repo の config.toml の port は変えていない) で `supabase start` → 全 migration を適用、`Creating Storage bucket: sales-demo-versions`。`supabase db reset` も成功。
- 確認: `storage.buckets` = `sales-demo-versions | public f | 4194304 | {text/html,text/css,image/webp,image/jpeg}`、`storage` の policy 0 件。

## 巻き戻し (コミットしない)

DEV-195 と同じ扱い: scratch の `dev196c-rollback.sql` (repo には置かない) を、人の判断で 1 transaction として流す。内容: (1) 新しい管理者関数・worker の関数・共有の判定を drop、(2) 置き換えた 6 関数を以前の migration (20261107000000・20261110000000) の定義そのものに戻す、(3) trigger・列・4 表・補助関数を drop、(4) `schema_migrations` から `20261111000000` を消す。確認 (ローカル): migration ありの DB に流した後の public schema の `pg_dump --schema-only` が、migration なしで reset した schema と完全に一致 (`\restrict` の行を除いて差分 0 行、4955 行)。

## セキュリティの点検

- [x] 新しい表すべて RLS、管理者だけ select の policy 1 つ、anon の権限なし、authenticated の書き込みなし (`db-security-audit` と staging の検査)
- [x] 管理者の関数は SECURITY DEFINER・最初に `sales_assert_admin()`・`search_path = ''`・PUBLIC / anon の実行なし
- [x] worker の関数・補助関数・trigger の関数は service_role だけ (authenticated / anon は実行できない)
- [x] 承認の書き込みは管理者の identity が要る (service role の直接の書き込みも trigger が拒否)
- [x] 版の内容と hash・ファイル・品質承認の snapshot は不変、行の削除なし、取り消しは最終
- [x] AI 画像は共有不可 (table の check と導き直し)、`ai_share_approved`・オーナーの AI 共有の決定は書けない
- [x] 版の共有は DB で無効 (旗 2 つ・`share_eligible` の check・共有の判定)。staging の検査 `demo_version_sharing_disabled` が監視
- [x] storage の policy なし。staging の検査 `storage_no_client_policies` が監視
- [x] `send_opened` のあいだ hash を変える操作は `approval_open`、時間による変化は送信済みに記録
- [x] 文字列の検査は挿入の前 (note・code)。失敗した行の本文がログに残らない
- [x] secret・モデル名・実在の店舗をリポジトリに入れていない (テストは架空の店と example.com だけ、`check:secrets` 通過)

`scripts/staging/lib.mjs` の `SECURITY_CHECKS` に 2 つ足した (`storage_no_client_policies`・`demo_version_sharing_disabled`)。既存の規則は変えていない。`staging-checks.test.ts` に fail-closed の 1 件。

## テスト

- 統合 (ローカル Supabase、storage あり): **23 ファイル・434 件すべて通過** (新規 `tests/integration/demo-versions.test.ts` 30 件、`db-security-audit` 11 件 (DEV-196c 1 件追加)、`staging-checks` 8 件 (1 件追加))。CI と同じ `-x storage-api` で起動: 433 passed / 1 skipped (Storage の API の 1 件だけ)。
- unit: `tests/unit/sales`・`tests/unit/ai-tasks.test.ts`・`tests/unit/staging` 1154 件通過。全 unit の実行では `tests/unit/design-agent` の 68 ファイルが、この container に Playwright の Chromium が無い (`browserType.launch: Executable doesn't exist`) ため落ちる。この PR は design-agent に触れていない。
- `npm run typecheck`・`npx eslint`・`npm run check:secrets`・`npm run build` 通過。

## 残る問い

- 生成 job の表 (`sales_demo_generation_jobs`、§4.5) と upload の `uploading` → `draft` / `rejected` の流れ (begin / put / finalize) は作っていない。worker の関数は server の検査を通った版を `draft` で記録するだけ (DEV-196d / DEV-196i で決める)。`rejected` の行はまだ書かない。
- `ai_concept_internal` の「事実の偽装なし」のオーナーの確認は、今は包みの記録で受け取り、確認者が `sales_admins` であることだけを DB で確かめる。管理画面で押す形にするかは仕様 §14 Q12 のまま。
- 画像の権利の更新 (例: `unknown` → `share_cleared`) の関数は無い (trigger は権利の格上げを拒否)。写真の共有を認める承認のときに設計する。
- 成功例の画像の禁止の hash は server (DEV-196b の `forbiddenSha256`) が持ち、DB には持っていない。
- 急ぎの取り消し `sales_urgent_revoke_demo_version` (§9.5 の 3) は作っていない。通常の取り消しも `send_opened` があれば `approval_open` で、決着を先にする規則は同じ。

## Review round 1 (独立レビュー、dd6606e: C0 / H0 / M1 / L5)

置き換えた 6 関数と legacy の hash は問題なしとの評価。指摘への対応 (同じ migration を修正。どの hosted DB にも未適用):

| # | 指摘 | 対応 | 回帰テスト |
|---|---|---|---|
| M1 | 実店舗の AI 画像を `ai_generated_demo` / `ai_demo_internal` として入れると、AI 概念画像の規則を迂回できた | `sales_prospects` の行はすべて実店舗なので、table の check `sales_demo_images_real_shop_no_ai_demo` と挿入の trigger (`ai_demo_real_shop`) で両方を拒否。権利の状態は **DB が導く** (挿入の trigger): `ai_concept_internal` は `depicts_real_*` がすべて false・オーナーの確認 (確認者が `sales_admins`)・出所が strict な `AiConceptProvenance` の形 (`sales_demo_ai_provenance_valid`)・`public_web=false` のときだけ、それ以外は `unknown`。人の写真は条件から `share_cleared` / 種類ごとの internal を導く。呼ぶ側の値で残すのは `unknown` だけ (下げる方向)。`rights_expiry` を過ぎていれば `expired` | ingest と service role の直接の挿入で `ai_demo_real_shop` / `invalid_image`、呼ぶ側が `share_cleared` と言った AI 概念画像は `ai_concept_internal` (共有不可) で保存、書面の確認の無い人の写真は internal、期限切れは `rights_unknown`、条件の欠け (`depicts_real_shop`・model `unknown`・`public_web`) は `rights_unknown` |
| L3 | note の検査が裸のドメインと全角を見逃した | NFKC で正規化して小文字にした上で、scheme (`xxx://`・`https:`)・`www.`・ドメインの形 (`名前.英字2文字以上` の後が `/`・`:`・語の終わり)・メール (全角の `＠` も) を拒否 | `example.com/x`・`参考 example.com`・`ｈｔｔｐｓ：／／…`・`ｅｘａｍｐｌｅ．ｃｏｍ`・`info＠example．com`・`ftp://x`・`shop.example.jp:8080` は `invalid_note`。`版 1.2 の SP390 …` は通る |
| L4 | service role の直接の書き込みが ingest の検査を迂回できた | 検査を trigger に移した (どの書き手にも効く): 挿入時に manifest の形 (`sales_demo_manifest_valid`、ingest と共用)・bundle の hash = manifest から計算した値・`total_bytes` = 合計・`facts_sha256` = 今の demo の content・`expires_at` は今から 60 日以内、ファイルは manifest の 1 項目と完全一致 (`file_not_in_manifest`)、commit の時点でファイルの数 = manifest (遅延の constraint trigger `version_files_incomplete`)。`expires_at` は短くはできるが、延ばせるのは送信済みの承認が固定した版だけ。approved から出る・approved に入る・revoked への遷移、active な品質承認の終了、`approved_version_id` の変更、画像の取り消しは、`send_opened` があれば trigger が `approval_open`。4 表の DELETE・TRUNCATE を service_role・authenticated・anon から外した (`NO_DELETE_TABLES`、staging の `service_role_can_write` はこの 4 表の DELETE だけを除外し、新しい検査 `demo_version_tables_never_deleted` が逆を監視) | service role の直接の挿入で `bundle_mismatch` / `facts_mismatch` / `invalid_manifest` / `invalid_expiry` / `version_files_incomplete`、`file_not_in_manifest`、DELETE は 42501、TRUNCATE は `permission denied` (service_role・authenticated)、期限の延長は拒否、`send_opened` の間の直接の approved→draft・revoked・品質承認の無効化・`approved_version_id = null` は `approval_open` |
| L5 | 同じ bundle を別の店で記録できた | 挿入の trigger が bundle ごとの advisory lock の下で、別の demo に同じ `bundle_sha256` の版があれば (状態を問わず) `bundle_reused_across_shops` | ingest と直接の挿入の両方で `bundle_reused_across_shops` |

**DEV-196d に持ち越す (今は直さない、オーナー指示)**

- **L2**: オーナーの「事実の偽装なし」の確認を、包みで中継された user id ではなく管理者の操作 (管理画面のボタン) に結び付ける。今は確認者が `sales_admins` であることだけを DB で確かめる。
- **L6**: 版を品質承認すると、版の共有が有効になるか承認を取り下げるまで、その店の送信承認は `demo_not_shareable` で止まることを、管理画面で警告する。

**再実行 (round 1 の修正の後)**

- `npx supabase db reset` (ローカルの隔離した stack): 成功、bucket 作成。
- 統合: 23 ファイル **439 / 439 通過** (storage あり。`demo-versions` 35 件、`send-approval` 48 件、`db-security-audit` 11 件、`staging-checks` 8 件を含む)。CI と同じ `-x storage-api` では 438 passed / 1 skipped (Storage の API の 1 件)。
- unit (`tests/unit/sales`・`ai-tasks`・`staging`): 1155 件通過 (`staging/lib.test.ts` の明示 grant の検査は、DELETE だけ `NO_DELETE_TABLES` を期待値にした)。
- `npm run typecheck`・`npx eslint`・`npm run check:secrets`・`npm run build` 通過。
- 巻き戻しの scratch SQL を新しい関数に合わせて更新し、もう一度確認: migration なしの schema と差分 0 行。
