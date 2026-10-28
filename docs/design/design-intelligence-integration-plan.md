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
  - develop に対して 68 ファイル（追加 67、変更 1）。`lib/`・`tests/`・CI・`package.json` の変更はない。
  - **変更の1件は正本の `docs/design/design-first-workflow-decision.md`**（Identity Lock の節を追記）。マージの判断では、この正本の変更も対象になる。
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
  - **成功の層に入るのは、台帳の状態がオーナー選択の成功として既知の4種類のどれかで、かつ選択の記述に「不採用・保留・評価待ち」等を含まない案件だけ。** 未知の状態や保留・不採用は停止する（例: CP-025 が評価待ちのまま登録されても、成功例として読まれない）。条件付きの採用（CP-021）は `conditional: true` として常に表示する。
  - `view` から導いた実装種別と `implementation` の一致を確かめる。
  - 再利用禁止方針を確認する。
  - 候補・キューは、各ファイルが自分で宣言した件数と実際の件数を照合し、ID の重複とキューが候補に含まれることも確かめる。
  - 全体の件数（現在 23 / 80 / 20）は固定しない。研究が増え続けるためで、代わりに各ファイルの SHA-256 と件数を毎回出力し、人が比較する。
  - 不一致はすべて固定コードで停止する。
  - 3層を分けて扱う：
    - `owner_selected_research_success`：案件の分析として示せる唯一の層
    - `unreviewed_reference_candidate`：件数のみ
    - `review_queue_pending`：件数のみ
- `lib/design-agent/intelligence/brief.ts`：店舗1件の研究ブリーフを作る。
  - **入力:** 人が確認した事実だけ。各特徴には出典 ID を付け、キーワードは特徴に紐づける。
  - **関連付け:** 研究カテゴリが一致するか、特徴に紐づくキーワードが案件の分析文に単語として現れる場合だけ。どの欄・どの特徴に基づくかを必ず出力する。
  - **「原理」は出さない。** 研究データにあるのは案件ごとの分析で、抽象化された原理ではない。実データの `structural_translation` には、その案件の具体的なレイアウトやラベルが書かれていることが多い（例: 左右の配置、セクション名、看板・鏡などの主役の装置）。
  - **出すもの:** 関連案件ごとに、
    - `case_analysis_do_not_reproduce`：その案件の構造の翻訳と視覚的な仕組み。**その店の事実がどう構造になったかの記録**として示す。再利用の候補ではない。
    - 失敗の型・`not_to_copy`・再利用禁止・品質ゲート。
  - **使い方の注意（`how_to_use`）:** 研究自身の注記を同梱する（`reuse_policy.allow`「検証済みの店舗事実からオリジナルの構図を発想する。人の選択が必要」、`provenance.basis`「構図の対応は分析であり、測定された因果ではない」、`limitations`）。学ぶのは「事実から構造を発明した考え方」で、結果ではない。
  - 画像・写真・ロゴ・HTML の実物は出さない（研究側も GitHub に持っていない）。
  - **Design DNA:** 8項目はすべて `choice: null`。決めるのはセッションとオーナー。
  - **欠けた入力:** `missing_inputs` に列挙し、`G0_hold` にする。業種からの推測で埋めない。
  - **G0 は一部だけ確認する:** 確認するのは「人が確認した出典付きの特徴」だけで、満たしても `G0_partially_checked`。正本の G0 のうち、使える商品名・店の強み・CTA の真偽・承認済み素材一覧は `g0_not_checked_here` として残し、セッションとオーナーが確認する。
  - 関連が上限（既定5件）を超えたときは、`related_total` で全件数を示す。
- `scripts/design-intelligence/brief.ts`：CLI（`--summary` / `--shop`）。標準出力だけで、ファイルは書かない。
- **テスト:** 架空データだけで 49件。
  - 層の分離、状態の許可リスト（不採用・保留・下書き・差し替え済み等の語も拒否）、件数の不一致、方針変更、マークアップやプロンプト区切りの拒否（平文の指示文までは検出しない。そのため出力は研究専用で、生成器にはつながない）
  - 根拠付きの関連付け、空白を埋めないこと
  - 隔離。Adapter と CLI が名指しできるモジュールを許可リストで固定し（`node:crypto`・`node:fs/promises` の `readFile`・`node:path`・`zod`・自分自身）、CLI 以外から import されないことを確かめる

**実データでの確認（研究ブランチの worktree に対して読み取りのみ）:**
- `--summary` の結果：成功 23件（Web試作 10・静止画像 13）、未審査の参考候補 80件、審査キュー 20件。研究側の記載と一致した。
- 架空店舗の入力でブリーフが生成され、関連付けの根拠が出力されることも確かめた。

**このPRに含まないもの:**
- PR #142 のマージ、研究データのコピー
- 営業 demo・worker・timer・bridge・Supabase・Vercel・`components/demo`・品質ゲート・CSS 許可表の変更
- モデル・Codex の呼び出し

## 3. 段階計画（Phase 2 以降はそれぞれオーナーの個別承認が必要）

2026-10-28 にオーナーが承認した順序：**2a → 2d-min → 2f → 2b → 2c → 2d 完成 → 2e → 2g**。最終目標は、Codex が店舗固有のデザインを作り、Claude Code がそれを忠実に実装する自動制作である。

| Phase | 内容 | 必要な承認 |
|---|---|---|
| 2a（DEV-113） | 選定台帳 `selection_ledger_v1` と3モード（下記 3.1） | 承認済み（2026-10-28）。実データの台帳追加は別承認 |
| 2d-min | Design Artifact とゲート記録の最小スキーマ、Intake の検査（SHA の再計算・停止・欠落・生成情報 unknown を成功にしない） | スキーマの承認 |
| 2f | 生成経路 A（画像）/ B（HTML 試作）/ C（併用）の比較。架空店舗で、本番の自動生成経路から隔離した研究 PoC として行う。`CODEX_NO_IMAGE` は「ツールを呼んでいない」「呼んだが失敗」「成功したが取り出せていない」「出力が不正」に分けて記録する | 店舗・入力・回数・費用・環境と、Codex 実行1回ごと |
| 2b | 構造記述子と構造の重複検査（8側面）。実装はブラウザの画面と幾何でも検証する | 語彙の承認 |
| 2c | Identity Lock の TypeScript 化 | 移植の承認 |
| 2d 完成 | Artifact と Intake の完成形 | スキーマの承認 |
| 2e | Claude 側の隔離された表現実装レーン。Codex の試作コードは、読み取り権限と作業領域の分離で Claude の実装から見えなくする | 能力ごと |
| 2g | 決定論的な制御プログラムと、回数・費用に上限のある修正ループ | ループ設計の承認 |
| 3 | 3〜5店舗の縦断テスト | 店舗・素材・生成ごと |
| 4 | 本番ワークフローへの統合案（文書） | develop/main・本番 |

後続 PR に分けるもの：研究セット `research_set_v1`（commit・研究データ SHA・対象案件・利用範囲・選定根拠を固定し、変更時は fail-closed）、人の承認記録の方式（秘密鍵に AI が触れない・検証コードと公開鍵を AI が変更できない・鍵の紛失・更新・失効・HUMAN-xxx との整合・オーナーの操作負担。署名済み JSON があるだけでは承認にしない）。

### 3.1 Phase 2a：選定台帳と3モード（DEV-113）

`lib/design-agent/intelligence/ledger.ts` は zod だけに依存する純粋な検証器である。`corpus.ts` が manifest の案件を渡す（循環依存なし）。

| モード | 台帳 | 一部の案件だけ | 結果 |
|---|---|---|---|
| `phase1_compat`（既定） | 読まない。渡されたら `CORPUS_MODE_INVALID` | — | Phase 1 と**バイト単位で同じ出力** |
| `partial` | 必須（`LEDGER_MISSING`） | 許可し、`unledgered_success_cases` に列挙 | `ledger` 報告を追加 |
| `strict` | 必須 | `LEDGER_INCOMPLETE` | 台帳の検査をすべて通っても必ず `STRICT_APPROVAL_NOT_IMPLEMENTED` で停止 |

**strict は安全な未実装状態であり、稼働する strict モードではない。** 承認済み研究セットと承認記録の検証は後続の PR で扱う。

**台帳ができないこと:**
- 成功を作ること。成功は manifest の状態だけで決まる。manifest が成功として持たない案件・版を「選定」とする台帳は停止する。
- `ledger_assigned` のラベルを承認の根拠にすること。manifest に承認版ラベルがない案件の内部識別子にすぎない。manifest にラベルがあるときは、選定版はそれと完全一致する必要がある。
- オーナー発言の引用を新しい承認の証拠にすること。引用は「発言の記録」として種類（`quote_kind`）と状態の整合だけを検査し、報告にも本文を出さない。
- SHA 欄を名前から推測すること。`anchor` は根拠となる記録（`evidence_ref`）を必須とし、manifest の値と一致するかだけを見る。`first_` などの名前で採否を決めない。
- 画像を検証済み素材にすること。`verification` は `recorded_unverified` / `original_unavailable` だけで、検証済みを表す値がない。

**分析者の分類**（`analyst_classification`、`classified_by: analyst_not_owner`）はオーナーの発言とは別の欄で、混ぜるとスキーマ違反になる。

**停止コード:** `LEDGER_MISSING`・`LEDGER_SCHEMA_INVALID`・`LEDGER_UNKNOWN_STATUS`・`LEDGER_DUPLICATE_CASE`・`LEDGER_DUPLICATE_VERSION`・`LEDGER_CONTRADICTS_MANIFEST`・`LEDGER_QUOTE_MISSING`・`LEDGER_QUOTE_KIND_MISMATCH`・`LEDGER_ASSIGNED_LABEL_AS_APPROVAL`・`LEDGER_ANCHOR_UNSUPPORTED`・`VERSION_LABEL_MISMATCH`・`LEDGER_INCOMPLETE`・`STRICT_APPROVAL_NOT_IMPLEMENTED`、および `CORPUS_MODE_INVALID`。

**CLI:** `--mode phase1_compat|partial|strict`（省略時は phase1_compat）と `--ledger <file>`。研究ブランチには台帳がまだないため、実データで partial を実行すると `LEDGER_MISSING` で停止する（正しい動作）。

## 4. リスクと対策

- **研究データの意味の取り違え:** 成功（研究）≠ 店舗の許諾 ≠ 公開可。Adapter は層と状態を出力に必ず含め、`status: research_only_not_prompt_input_not_approved` を固定する。
- **テンプレート化:** 過去案件の構造は「再現しない分析」としてだけ示し、`not_to_copy`・再利用禁止・研究自身の注記を同梱する。ただし文字で示す以上、真似される余地は残る。Phase 2b で、新しい案と過去例との構造の重複を機械的に検出する。
- **台帳の自己申告:** 台帳は Claude やセッションが書ける JSON である。だから台帳は成功を作れず、承認を表す値も持たない（3.1）。strict が承認を要求する段階は、改ざんできない承認記録の方式が決まるまで実装しない。
- **未マージのデータへの依存:** Adapter はパスを実行時に受け取る。研究ブランチが変わると、SHA と件数の変化で検知できる。PR #142 がマージされるまで、develop だけでは実データを読めない。
- **実在店舗の情報が repo に入っている:** PR #142 は実店舗名・住所・SNS URL を `design-library/`・`docs/design/` に含む。既存の guardrails の対象外。マージ前にオーナーの判断が必要。
- **研究ブランチの検証が CI 外:** `validate.mjs` などは CI で実行されない。Adapter の検査が代わりの一部になるが、完全ではない。
- **キーワード照合の限界:** 研究データは英語、店舗の事実は日本語。そのためキーワードは、人かセッションが特徴に紐づけて与える。照合は単語一致だけで、意味までは理解しない。
- **自動スコアの過信:** 最終的な美的判断はオーナーが行う。CI の合格を美的な合格と呼ばない。
