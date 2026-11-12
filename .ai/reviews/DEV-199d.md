# DEV-199d: デモ版パッケージの copy.json と文章品質監査の取り込み検査

オーナー Issue #258 の判断②: コピーを構造化 (copy.json) してデモ版パッケージに入れ、facts pack と照合する。サーバー側で出典・整合・監査結果・改ざん・古い承認の再利用を検める。既存の事実・権利の検査は緩めない。

branch `feature/dev-199d-copy-json-package` (`origin/develop` b9305e17、DEV-199a merge 後から)。

**送信経路・DB には接続していない。** 結果は `importPackage` の戻り値 (`ImportResult.copy`) にだけ返す。保存は DEV-199e (DB)。

## ファイル

- `lib/demo-version-package/copy.ts` (新規) — copy manifest の schema、ファイル名と役割、`makeCopyFiles` (作る側)、`verifyPackageCopy` (検める側)、`PackageCopyResult`。
- `lib/demo-version-package/package.ts` — 形式 `sales_demo_version_package_v2` (`PACKAGE_FORMAT_COPY`)、`checkPackageCopy`、`buildPackage({ copy })`、`writePackage` / `readPackage` の copy ファイルの読み書きと検査。
- `lib/demo-version-package/import.ts` — DB に触る前に `checkPackageCopy`、`trustedFactsPack` の option、`ImportResult.copy`。
- `tests/unit/demo-version-package/copy-package.test.ts` (新規、24 件)。
- `tests/unit/design-agent/quality-pipeline/copy-quality-review.test.ts` — isolation の1件だけ変更 (下記)。
- 変更していない: `copy-record.ts`・`facts-pack.ts`・`copy-quality-review.ts`・`copy-quality-page.ts`・`lib/sales/demo-version/*` (`copy-check.ts`・`html-safety.ts`・`manifest.ts`・`rights.ts` を含む)・`swap-*.ts`・`seed-rin.ts`・`scripts/`・DB・migration・prompt・skill・workflow・package.json / lockfile・「輪」の研究ファイル。

## 設計上の判断

### 形式の版 (manifest の版ではなくパッケージの版を上げる)

- **頁の manifest (`ArtifactManifest`, `MANIFEST_VERSION = 1`) は変えない。** これは DB の manifest で、`sales_demo_version_files` は role を `html / css / photo / render` に限る (migration `20261111000000_sales_demo_versions.sql`)。copy のファイルをそこへ入れると migration が要るうえ、`bundle_sha256` (版の同一性) と bucket の中身が変わる。
- 代わりに**パッケージの形式を `sales_demo_version_package_v1` → `_v2` に上げ**、`package.json` に別の **copy manifest** (`copy`: `version: 1`・`bundle_sha256`・`files[]` = 名前・役割・sha256・サイズ) を足す。copy manifest は頁の bundle を名指すので、別の頁に付け替えられない。ファイルは固定の名前だけ:
  - `copy/facts-pack.json` (facts_pack)・`copy/copy.json` (copy_record)・`copy/review.json` (review)
  - `copy/rounds/<i>/{copy.json,index.html,style.css,review.json}` (i < review.round ≤ 2、前の round の鎖)
- copy manifest は strict で、verdict・点数・承認の欄を持てない (足すと `COPY_MANIFEST_INVALID`)。判定は常に検める側が計算する。
- copy のファイルは upload も配信もしない (`importPackage` は頁の manifest のファイルだけを上げる。テストで確認)。

### 古いパッケージ (v1) の扱い: 「copy 未審査」に固定 (fail closed)

- 2つの選択肢のうち、**v1 を読めるまま `copy_unreviewed` に固定する**方を選んだ。結果は `{ status: "copy_unreviewed", sendable: false, send_blockers: ["COPY_UNREVIEWED_LEGACY_PACKAGE"] }` で、`sendable` は型として `false` だけ。
- 理由: (1) 送信の可否はこの結果からしか作れず、未審査は送信可能にならない型なので、拒否と同じだけ閉じている。(2) 既存の「輪」(SR-001) のローカルの包み (v1、架空・AI 画像・管理者表示だけ) と、その import / rights / swap のテストを変えずに保てる (仕様の「現行の研究v1・ローカル写真パッケージ…の安全境界は維持」)。(3) v2 から copy を抜いて v1 に書き換えても、落ちるのは `copy_unreviewed` だけ (テスト)。
- 逆向きは拒否: copy を持つ v1 (`COPY_IN_V1_PACKAGE`)、copy の無い v2 (`COPY_MANIFEST_INVALID`)、未知の形式 (`PACKAGE_FORMAT`)。
- 送信経路が v1 を拒否するか `copy_unreviewed` で止めるかは、接続するとき (DEV-199e 以降) に `copy.status === "checked"` を必須にし、そのうえで `copy_verdict` と `send_blockers` で決めること (Fresh Review L3)。

### 検査 (`verifyPackageCopy`) — 宣言を信用せず、バイトから計算し直す

`buildPackage` (作るとき)・`readPackage` (読むたび)・`importPackage` (DB の前) の3か所で同じ関数を通す。`importPackage` は渡された包みのオブジェクトを `readPackage` を経たかによらず検め直す。

1. copy manifest の schema、名前と役割、サイズ (JSON は 1 MiB、前の round の HTML / CSS は頁の上限、合計 6 MiB)、重複・未知の名前・manifest に無いファイル、必須の3つ。各ファイルを sha256 とサイズで照合、UTF-8 (fatal)。copy manifest の `bundle_sha256` = 包みの bundle = 頁の manifest から計算した bundle。頁の HTML / CSS のバイトが頁の manifest の hash と一致すること。
2. facts pack を schema で読む。`trustedFactsPack` (facts の経路から読んだもの) が渡されればバイト一致 (`COPY_FACTS_NOT_FROM_FACTS_PATH` で拒否)。渡されなければ阻害要因 `FACTS_NOT_FROM_FACTS_PATH` を残す (DEV-199a の引き継ぎ「facts pack は facts の経路からだけ」: 生成側の包みにある pack だけでは送信に足りない)。
3. **既存の検査を変えずに再実行**: `checkArtifactHtml(html, css, 頁の写真 URL)` (落ちれば `COPY_PAGE_CHECK_FAILED`) の文言で `checkArtifactCopy` (= `checkCopyRecord` + 頁の文言がすべて record にある + 並んだ文言が事実に見えない)。落ちれば `COPY_CHECK_FAILED` + codes。**record ↔ 頁の逆向き**: record の各 item の**文言そのもの**が頁の文言 (ラベルだけでは足りない、Fresh Review L4) (監査と同じ `pageText` の読み) にあること (`COPY_RECORD_ITEM_NOT_ON_PAGE`)。AI 画像 (架空の「輪」だけ) を持つ包みに実店舗レーンの copy は拒否 (`COPY_REAL_SHOP_LANE_WITH_AI_IMAGES`)。
4. **鎖の順序**: round ごとに `copyReviewAppendBlockers(前の review, その review)` (round 0 の二重・round の飛び・前の copy に繋がらない・前の round が改稿を許さない → `COPY_REVIEW_CHAIN_INVALID` + codes)。前の round のファイルは review.round と同じ数だけ揃っていること (`COPY_ROUNDS_INCOMPLETE`)。
5. **review の照合**: `checkCopyQualityReview(review, 実ファイル, { previous: 前の round (review・copy・HTML・CSS), photoUrls })`。hash を実ファイルから計算し直し、監査を再実行して記録全体を比べ、前の各 round も再監査し、各段を `validateCopyRevision` に通す。stale (`REVIEW_STALE_*`)・偽の verdict (`REVIEW_DOES_NOT_MATCH_AUDIT`)・別の auditor_version (`REVIEW_SCHEMA`、schema が `copy_quality_rules_v1` に固定)・偽の前の round (`PREVIOUS_REVIEW_DOES_NOT_MATCH_AUDIT`) は `COPY_REVIEW_INVALID` + codes で拒否。
6. 監査を同じ入力で再実行した記録 (`reviewCopyQuality`) から結果を作る。`fail` は拒否 (`COPY_REVIEW_FAIL`)。それ以外は `verdict`・`copy_verdict`・`next_step`・`unresolved`・5つの hash・`facts_content_sha256`・review のバイトの sha256 と、**オーナー承認なしの** `copyGateSendBlockers` (+ `FACTS_NOT_FROM_FACTS_PATH`) を返す。`sendable` は常に `false`。

監査 (`reviewCopyQuality`) と検査 (`checkCopyQualityReview` / `copyGateSendBlockers`) には同じ `photoUrls` (頁の manifest の写真、`checkPackageFiles` と同じ集合) を渡す (DEV-199a の引き継ぎ)。

**オーナーの記録は包みから読まない** (DEV-199a round 5 の引き継ぎ)。`PriorRound.ownerRevision` は常に `null`。このため、実店舗レーンで approve_candidate の後にオーナーが改稿を求めた鎖は、この検査では `LAST_ROUND_DOES_NOT_ALLOW_REVISION` で拒否される (閉じる側)。オーナーの保存先ができる DEV-199e でその記録を渡す。

### 結果の記録

DB の変更はしないので、計算した結果は `ImportResult.copy` に返すだけ (`scripts/sales/demo-version/import-local.ts` はこれまでどおり ImportResult を JSON で出すので、copy の結果も出力に入る。スクリプトは変えていない)。`p_worker_checks` に入れることも考えたが、送信経路の判断材料を DB に置く変更になるので DEV-199e に回した。

## 既存のテストの変更 (1件)

`tests/unit/design-agent/quality-pipeline/copy-quality-review.test.ts` の isolation「nothing in the app, lib or scripts calls the audit yet」は、DEV-199a の時点で「どこからも呼ばれない」ことを固定していた。DEV-199d は意図して `lib/demo-version-package/copy.ts` から監査を呼ぶ (オーナー判断②)。期待値を `[]` から `["lib/demo-version-package/copy.ts"]` に変え、名前を「package copy check 以外は呼ばない (送信のゲートは有効ではない)」にした。他の呼び出し元が増えれば引き続き落ちる。新しいテストで、app・components・lib/sales がパッケージとその結果を import しないこと (送信経路に未接続) と、`copy.ts` の import が zod・sha256・既存の検査だけであることを固定した。

それ以外の既存のテスト (`package.test.tsx`・`swap-photos.test.ts`・`local-rin-patch.test.ts`・`tests/unit/sales/demo-version/**`・phase2f の isolation) は変更なしで通る。

## `.ai/tasks.json` の DEV-199a

DEV-199a は PR #259 で develop に merge 済み (b9305e17) だが `status` が `review` のままだった。DEV-199d (`review`) がそれに依存するので、`ai-tasks.test.ts`「依存が done でない Task を in progress 以降にしない」が落ちる。merge 済みの事実に合わせて DEV-199a を `done` にした (他の欄は変えていない)。

## 既知の限界 (DEV-199e 以降)

- **包みをまたぐ再提出**: 前の包みで既に round 0 を出した店の、同じ facts 内容の新しい round 0 (改稿を初回の監査として出し直す) は、1つの包みの中からは見えない。`copyReviewAppendBlockers` を店ごとの保存済み review 全部に対して通すのは、DB の保存先 (DEV-199e) の仕事。
- オーナーの承認・改稿依頼の記録は包みに入れず、ここでは使わない (上記)。
- facts の経路の pack が無い取り込みは送信の阻害要因 `FACTS_NOT_FROM_FACTS_PATH` を残すだけで、拒否はしない (管理者表示のための取り込みは止めない)。
- 「輪」の v1 の包みは `copy_unreviewed` のまま。「輪」の研究コピーを v2 に入れ直すことはしていない (研究原本は変更しない)。

## 検証

- `tests/unit/demo-version-package/copy-package.test.ts`: 24 件 (Fresh Review の対応後)。
- 対象の unit (`tests/unit/demo-version-package`・`tests/unit/sales/demo-version`・`tests/unit/design-agent/quality-pipeline`・`tests/unit/ai-tasks.test.ts`): 34 ファイル・1203 件 pass (isolation の2件を足す前の数。PR 本文に最終の数)。
- unit の全体・`npm run typecheck`・`npm run lint`・`npm run check:secrets`: PR 本文に結果。

## PR #261 Fresh Review (C0 H0 M0 L7、head 2e28537) と対応

| ID | 指摘 | 対応 |
|---|---|---|
| L1 | 包みをまたぐ round 0 の再提出は1つの包みの中から見えない | DEV-199e へ引き継ぎ (下記) |
| L2 | `trustedFactsPack` を渡す呼び出し元が無く、結果は包みの facts pack に対して計算される | DEV-199e へ引き継ぎ (下記) |
| L3 | `status: "reviewed"` が hold / revise も含み、合格と読める | `"checked"` に改名。型の注釈に「checked は無傷・既存の検査が通る・review が有効という意味だけで、合格ではない。決めるのは `copy_verdict` と `send_blockers` だけ」と明記。テストを更新 (CLI はこの値を解釈せず ImportResult をそのまま出すだけなので変更なし) |
| L4 | record → 頁の検査がラベルだけ頁にあれば通る | item の文言そのものが頁にあることを要求 (ラベルは数えない)。テスト: 営業時間のラベル (dt) を残して値 (dd) を消すと `COPY_RECORD_ITEM_NOT_ON_PAGE hours` |
| L5 | `readPackage` が schema の上限より前に `meta.copy.files` のファイルを読む | 先に `CopyManifest` (件数・各サイズの上限) を通し、名前・役割・合計サイズを検め、各ファイルを `statSync` で通常のファイルかつ `bytes` と同じサイズか確かめてから読む。テスト: 50件の一覧・50 MiB の申告 → `COPY_MANIFEST_INVALID`、範囲外の名前 → `COPY_NAME_NOT_ALLOWED`、役割違い → `COPY_ROLE_MISMATCH`、ディスクのファイルが申告より大きい・ディレクトリ → `COPY_FILE_HASH_MISMATCH` |
| L6 | `writePackage` が `copyFiles` の key を検めずに書く | `copyRoleOfName` が受けない key があれば、何も書く前に `COPY_NAME_NOT_ALLOWED` で拒否。テスト: `../outside.json`・`copy/notes.json`・`page/extra.html`・`copy/rounds/2/copy.json` は拒否され、出力先ディレクトリも作られない |
| L7 | importer の isolation が app・components・lib/sales だけ | app・components・lib 全体・scripts を走査し、相対 (`./copy`) と alias (`@/lib/...`) を解決して `lib/demo-version-package/{copy,import,package}` を import するファイルを列挙。許すのは `package.ts`・`import.ts`・`scripts/sales/demo-version/import-local.ts`、**および既存の作成 CLI `scripts/sales/demo-version/package-local.ts`** (DEV-196r からある包みの作成スクリプトで、`package.ts` を import する。copy の結果は読まない。指示の一覧に無かったが、既存のファイルなので許可に加え、ここに記録する) |

### DEV-199e への引き継ぎ (Fresh Review L1・L2)

- **L1 包みをまたぐ再提出**: 保存先は、新しい review を受け入れる前に `copyReviewAppendBlockers(その店の保存済み review 全部 (全レーン・全 facts、保存順), 提出された review, { ownerRevision })` を必ず通す。1つの包みの中の鎖の検査 (この PR) だけでは、前の包みで round 0 を出した店が、改稿を新しい round 0 として別の包みで出し直すのを止められない。続けて `checkCopyQualityReview` を保存済みの鎖を `previous` に、同じ `photoUrls` で通す (DEV-199a の引き継ぎどおり)。
- **L2 facts の経路**: 取り込みは facts pack を **facts の経路 (DB の店舗の事実など、生成・改稿の側が書けない保存先) から読み**、`trustedFactsPack` として渡す。`facts_from_facts_path: false` の結果 (阻害要因 `FACTS_NOT_FROM_FACTS_PATH`) は、送信の判断・オーナー承認の対象として**数えない**。今の呼び出し元 (`import-local.ts`) は渡していないので、現状の取り込み結果はすべてこの扱い。

### 検証 (Fresh Review の対応後)

- 対象の unit・`npm run typecheck`・`npm run lint`・`npm run check:secrets`: PR のコメントに結果。
