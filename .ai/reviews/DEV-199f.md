# DEV-199f コピー規則の新版 (prompt v3・文章審査 v2、提案・未有効)

対象: `feature/dev-199f-copy-prompt-v3` (base `origin/develop` c07de8f)。オーナー Issue #258 (新しい版の設計・開発・テストだけ承認)、仕様案 PR #257。

## 状態

- builder の自己確認: 下の「確認したこと」。**独立 Fresh Review は未実施** (coordinator が行う)。
- **何も有効にしていない。生成は実行していない** (Codex・画像生成・LLM の呼び出しなし)。

## 変更

| ファイル | 内容 |
|---|---|
| `lib/design-agent/phase2f/prompt.ts` | `PromptVariant` に `v3` (方向 + 参照、brief なし)。`COPY_V3_RULES` を追加し、v3 = v2 の後に改行 + `COPY_V3_RULES`。`promptVariantOf` は `"v3"` を `PROMPT_VERSION_NOT_ACTIVATED` で拒否。v2 の分岐を `open` (v2 か v3) に置き換えたが、v1・v1.1・v2・tm0 の出力は不変 |
| `tests/unit/design-agent/phase2f/prompt-v3.test.ts` | v3 の SHA と文字数 (B/C × 方向 A/B)、v3 = v2 + 規則のバイト一致、必要な規則と許可の不在、既定 (v1) と v1・v1.1・v2 の pin、CLI の拒否 (`--print-pin` でも、何も書かない)、審査 v2 が SKILL.md / references から読まれないこと |
| `docs/design/design-director-copy-review-v2.md` | 文章審査 v2 の提案。SKILL.md は変えていない |
| `docs/design/copy-prompt-v3-comparison.md` | 現行 v2/v1.1 と v3、現行 SKILL.md と審査 v2 の比較・理由・危険・評価の方法 |
| `.ai/tasks.json` | DEV-199f の項目だけ |

## v3 の固定値

| route | 方向 | SHA-256 | 文字数 |
|---|---|---|---|
| B | wagashi-open-a | `b213764b57eab85dd36e7e448a36dd3ed03abe1d55649cfe7e3b6272c80470eb` | 9296 |
| C | wagashi-open-a | `0e36caf53360ac13451033cc06a151643c141110f6efe228e7a69617b33a5733` | 9742 |
| B | wagashi-open-b | `f565544f86c55e100056cadfc11f49442186de2e18e5478284fb90559f39a986` | 9178 |
| C | wagashi-open-b | `b3739ce4e7b0169cac462541f1e195891f38edd83a7c4ae8b69f27ee94e1954f` | 9624 |

## 確認したこと

- 既存の pin のテストは変更なしで通る: `prompt-v11.test.ts` (v1 `a2fdd003…`/5706、v1.1 `c5973afb…`/6010・`a0dbb48c…`/7741)、`open-direction.test.ts` (v2 4本)、`prompt-tm0.test.ts`、三方式の pin。`tests/unit/design-agent/phase2f/` 10 files / 225 tests pass (`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`)。
- `phase2f-design.ts --print-pin --prompt-version v3`: brief つきで `PROMPT_VERSION_NOT_ACTIVATED`、方向つきで `USAGE` (CLI の brief なしの判定は v2 / tm0 だけ)。どちらも何も書かない。
- 回答の schema (`codex_design_v1`)・`copy-record.ts`・`facts-pack.ts`・SKILL.md と references・CLI・SR-001「輪」・DB・workflow・package/lockfile は無変更。repo のファイルにモデル名を足していない。
- `npm run typecheck` 0 エラー、eslint 0、`check:secrets` 問題なし、unit の全体は下の結果。

## 設計上の判断 (レビューで見てほしい点)

1. **v3 は v2 の上に作った。**B/C の一番新しい版で、事実・技術・画像の規則を既に持つため。v3 と v2 の差は末尾の規則だけ。
2. **v3 は架空の店でも創作の文を書かせない。**`codex_design_v1` の `live_text` は `fact_ref` / `ui_label` だけで、`creative_expression` の欄が無い。創作の文を B/C に入れるには schema の変更が要り、承認の範囲外。オーナーの判断事項として比較の文書 §5 に残した。
3. **CLI から選べないことを「未有効」の境界にした。**有効化 = CLI に v3 を通す変更 (brief なしの判定、記録) + 実行の承認。
4. 審査 v2 は `docs/design/` に置き、スキルの `references/` には置かない (Claude がディレクトリを読んで取り込む余地を無くすため)。

## 残り・注意

- DEV-199a の PR が `.ai/tasks.json` の同じ位置 (末尾) に項目を足すので、後に merge する側で単純な衝突が出る (両方の項目を残せばよい)。
- 審査 v2 が引く `copy_quality_review_v1`・`validateCopyRevision`・`MAX_COPY_REVISION_ROUNDS` は DEV-199a (未マージ) のもの。DEV-199a の名前が変われば審査 v2 を合わせる。
- 評価 (DEV-199c の4業種、v2 と v3 の Codex 比較) はオーナーの承認の後。
