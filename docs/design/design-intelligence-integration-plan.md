# Design Intelligence 統合計画（DEV-112、2026-10-28）

**状態:** Phase 1（調査・統合設計・読み取り専用 Adapter・テスト）だけを実施する。

**行わないこと:**
- Phase 2 以降の実行
- 本番経路への接続
- PR #142 のマージ
- 研究データの承認済みプロンプトへの昇格

いずれもオーナーの個別承認が必要。

**目的:** テンプレートを増やすことではない。店舗ごとに異なる高品質なオリジナルWebサイトを、安定して作れる仕組みにすること。

**正本:** この文書は次の正本の範囲内で動く。正本のゲートを緩めない。
- [デザイン先行方針](design-first-workflow-decision.md)（G0–G6）
- [comp→site](../operations/comp-to-site.md)
- [画像評価](../operations/design-image-eval-template.md)
- [画像アセット](../operations/design-image-assets.md)
- [1店舗スクショPoC](../operations/store-screenshot-led-demo-poc.md)

## 1. 現状の調査結果（develop 1de951e、研究ブランチ efe269f）

### 研究データ（PR #142、`research/approved-editorial-cases-20261027`、develop へは未マージ）

- **ブランチの内容:**
  - develop に対して追加だけ（68ファイル）。`lib/`・`tests/`・CI・`package.json` の変更はない。
  - PR #142 の head `efe269f` で、必須CI 10件は成功。
- **機械可読の正本:**
  - `design-library/success-cases/manifest.json`：23件の登録台帳。
    - 状態は `owner_*` のみ。
    - Web試作か静止画像かは `view` から導く。
    - SHA は案件ごとに別名のキーで持つ。
  - `design-library/intelligence/v01/success-patterns.json`：23件の分析。
    - `implementation` は `local_html_css_js_poc`（10件）か `concept_image_only`（13件）。
    - 各件が持つ項目：`shop_motifs`・`structural_translation`・`visual_mechanisms`・`known_failure_modes`・`not_to_copy`。
    - `reuse_policy.deny` があり、その中に「生成器へ別審査なしに流さない」を含む。
  - `design-library/intelligence/v01/review-queue.json`：審査キュー20件。全件 `approval_for_generation:false`。
- **参考候補80件（develop 側の既存データ）:** すべて未審査。
  - v0.2：40件
  - v0.3：15件と25件（`research_candidates_not_approved`）
- **機械可読でないもの（Markdown にしかない）:**
  - 不採用・保留の記録（CP-014 未承認、CP-025 の v1/v2 不採用・v3 評価待ち、各案件の不採用版）
  - 実店舗の出典 URL・権利の状況
- **研究ブランチ内の自前検証:**
  - `validate.mjs`、`identity-audit.test.mjs`、`structure-audit.test.mjs`
  - CI では実行されていない（vitest の対象外）。

### 再利用できる既存資産（develop）

| 用途 | 既存資産 | 備考 |
|---|---|---|
| 8項目の Design DNA | `lib/design-agent/design-image/design-dna.ts` | `design-image` 配下は隔離テストで import 先が固定されている。Adapter は名前だけを揃え、import しない |
| 事実だけによる技法判定 T1–T8・2案の差 | `design-image/shop-proposals.ts` | 現在は技法の組だけを比較し、構図は比較しない |
| comp→site 実装の検査 | `lib/design-agent/comp-impl/*`（1440/390 の描画、事実・幾何・凡庸化防止 `antiTemplateCheck`・類似度・可読性） | 入力は WSL Codex の和菓子 PoC に固定。ChatGPT 画像の取り込み経路はない |
| 評価基準 | `comp-impl/bundle.ts` `evaluationVerdict`（hard fail なし・22/25・各4以上・人の確認） | そのまま再利用できる |
| 構造距離・画素差 | `compare/metrics.ts`、`comp-impl/similarity.ts` | 報告用。合格判定には使わない |
| Identity Lock | 研究ブランチ `identity-audit.mjs` | 研究用 `.mjs`。CI 外 |

### 足りないもの

1. 研究データを型付きで読み、承認済み・未審査・保留を分けて扱う層（→ Phase 1 で作る）
2. 不採用・保留の機械可読な台帳（今は Markdown だけ）
3. 構図の構造的な重複判定。研究の 3案比較（`structure-audit.mjs`）は研究側にあるが、本体にない（→ Phase 2）
4. ChatGPT 画像・PC/スマホの全ページ構成・設計仕様の取り込み経路（出所・SHA・事実との照合・評価記録）。comp-impl の `report.json`・spec はモバイルの comp を持たない（→ Phase 2、正本どおり設計と承認が先）
5. 実在店舗用の評価基準。既存の hard fail は、店舗写真・ロゴ・架空店舗の開示文を前提にしている（→ 別途承認）

## 2. Phase 1 の実装（このPR）

**Design Intelligence Adapter（読み取り専用）**
- `lib/design-agent/intelligence/corpus.ts`
  - 研究 checkout のパスを実行時に受け取り、JSON を読む。
  - 型を検査し、台帳と分析の ID を照合する。
  - `view` から導いた実装種別と `implementation` の一致を確かめる。
  - 再利用禁止方針を確認する。
  - 候補・キューの件数と ID を照合する。
  - 不一致はすべて固定コードで停止する。
  - 3層を分けて扱う：
    - `owner_selected_research_success`：原理の根拠に使える唯一の層
    - `unreviewed_reference_candidate`：件数のみ
    - `review_queue_pending`：件数のみ
- `lib/design-agent/intelligence/brief.ts`：店舗1件の研究ブリーフを作る。
  - **入力:** 人が確認した事実だけ。各特徴には出典 ID を付け、キーワードは特徴に紐づける。
  - **関連付け:** 研究カテゴリが一致するか、特徴に紐づくキーワードが案件の分析文に単語として現れる場合だけ。どの欄・どの特徴に基づくかを必ず出力する。
  - **出すもの:** 構造的な原理（`structural_translation`・`visual_mechanisms`）、失敗の型、`not_to_copy`、再利用禁止、品質ゲート。具体的な構図・ロゴ・写真・文言・配色は出さない。
  - **Design DNA:** 8項目はすべて `choice: null`。決めるのはセッションとオーナー。
  - **欠けた入力:** `missing_inputs` に列挙し、`G0_hold` にする。業種からの推測で埋めない。
- `scripts/design-intelligence/brief.ts`：CLI（`--summary` / `--shop`）。標準出力だけで、ファイルは書かない。
- **テスト:** 架空データだけで 34件。
  - 層の分離、不一致・方針変更・注入らしき文字列の拒否
  - 根拠付きの関連付け、空白を埋めないこと
  - 隔離（CLI 以外から import されない。営業・worker・pipeline・Codex・PoC・ネットワーク・書き込みに触れない）

**実データでの確認（研究ブランチの worktree に対して読み取りのみ）:**
- `--summary` の結果：成功 23件（Web試作 10・静止画像 13）、未審査の参考候補 80件、審査キュー 20件。研究側の記載と一致した。
- 架空店舗の入力でブリーフが生成され、関連付けの根拠が出力されることも確かめた。

**このPRに含まないもの:**
- PR #142 のマージ、研究データのコピー
- 営業 demo・worker・timer・bridge・Supabase・Vercel・`components/demo`・品質ゲート・CSS 許可表の変更
- モデル・Codex の呼び出し

## 3. 段階計画（Phase 2 以降はそれぞれオーナーの個別承認が必要）

| Phase | 内容 | 主な成果物 | 必要な承認 |
|---|---|---|---|
| 2a | 不採用・保留の機械可読台帳 | 研究ブランチ側に `rejections.json`（CP-014・CP-025 v1/v2・各案件の不採用版、理由・SHA）。Adapter が読む | 研究データの追加方法（研究ブランチで行うか） |
| 2b | 構図の重複チェック（3案） | Hero構造・閲覧順・情報配置・インタラクション・スマホ構成の構造記述スキーマ。案同士、および過去の成功・不採用例との構造距離。配色・写真だけの差は「同一構造」と判定する | スキーマの承認 |
| 2c | Identity Lock の本体化 | 研究の `identity-audit` を TypeScript 化し、vitest/CI で検証。生成前の店名・業種の固定と、生成後の照合記録 | 研究ルールの移植の承認 |
| 2d | ChatGPT デザインの取り込み（intake） | `chatgpt_owner_upload` 型の出所記録（SHA・日時・会話アーカイブ SHA）、PC/スマホの全ページ構成、設計仕様。存在しない素材は `missing` として報告する。comp-impl の spec にモバイル版を足す | 正本の G2 経路の追加（design-first の改訂） |
| 3 | 3〜5店舗の縦断テスト | 研究データあり・なしの比較。デザインと実装の 1440/390、評価記録 | 店舗・素材・生成ごとの承認 |
| 4 | 本番制作ワークフローへの統合案 | 文書による提案だけ | develop/main・本番の承認 |

## 4. リスクと対策

- **研究データの意味の取り違え:** 成功（研究）≠ 店舗の許諾 ≠ 公開可。Adapter は層と状態を出力に必ず含め、`status: research_only_not_prompt_input_not_approved` を固定する。
- **テンプレート化:** 原理だけを出し、`not_to_copy` と再利用禁止を同梱する。Phase 2b で、過去例との構造の重複を検出する。
- **未マージのデータへの依存:** Adapter はパスを実行時に受け取る。研究ブランチが変わると、SHA と件数の変化で検知できる。PR #142 がマージされるまで、develop だけでは実データを読めない。
- **実在店舗の情報が repo に入っている:** PR #142 は実店舗名・住所・SNS URL を `design-library/`・`docs/design/` に含む。既存の guardrails の対象外。マージ前にオーナーの判断が必要。
- **研究ブランチの検証が CI 外:** `validate.mjs` などは CI で実行されない。Adapter の検査が代わりの一部になるが、完全ではない。
- **キーワード照合の限界:** 研究データは英語、店舗の事実は日本語。そのためキーワードは、人かセッションが特徴に紐づけて与える。照合は単語一致だけで、意味までは理解しない。
- **自動スコアの過信:** 最終的な美的判断はオーナーが行う。CI の合格を美的な合格と呼ばない。
