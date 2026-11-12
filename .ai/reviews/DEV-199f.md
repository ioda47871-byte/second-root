# DEV-199f コピー規則の新版 (prompt v3・文章審査 v2、提案・未有効)

対象: PR #260、`feature/dev-199f-copy-prompt-v3` (base `origin/develop` c07de8f)。オーナー Issue #258 (新しい版の設計・開発・テストだけ承認)、仕様案 PR #257。

## 状態

- builder の自己確認: 下の「確認したこと」。**独立 Fresh Review は未実施** (coordinator が行う)。
- **何も有効にしていない。生成は実行していない** (Codex・画像生成・LLM の呼び出しなし)。

## 変更

| ファイル | 内容 |
|---|---|
| `lib/design-agent/phase2f/prompt.ts` | `PromptVariant` に `v3` (方向 + 参照、brief なし)。`COPY_V3_RULES` を追加し、v3 = v2 の後に改行 + `COPY_V3_RULES`。`promptVariantOf` は `"v3"` を `PROMPT_VERSION_NOT_ACTIVATED` で拒否。v2 の分岐を `open` (v2 か v3) に置き換えたが、v1・v1.1・v2・tm0 の出力は不変 |
| `tests/unit/design-agent/phase2f/prompt-v3.test.ts` | v3 の SHA と文字数 (B/C × 方向 A/B)、v3 = v2 + 規則のバイト一致、必要な規則と許可の不在、既定 (v1) と v1・v1.1・v2 の pin、CLI の拒否 (`--print-pin` でも、何も書かない)、審査 v2 が SKILL.md / references から読まれないこと |
| `scripts/design-artifact/phase2f-design.ts`・`phase2f-steps.ts` | Fresh Review L4: `main` の冒頭で `--prompt-version v3` を `PROMPT_VERSION_NOT_ACTIVATED` で拒否 (それ以外は無変更) |
| `docs/design/design-director-copy-review-v2.md` | 文章審査 v2 の提案。SKILL.md は変えていない |
| `docs/design/copy-prompt-v3-comparison.md` | 現行 v2/v1.1 と v3、現行 SKILL.md と審査 v2 の比較・理由・危険・評価の方法 |
| `.ai/tasks.json` | DEV-199f の項目だけ |

## v3 の固定値

| route | 方向 | SHA-256 | 文字数 |
|---|---|---|---|
| B | wagashi-open-a | `3ca3f33da64c669a90bc8a9e912c4199136d8433e3031c9482d25a20c7b0f487` | 9594 |
| C | wagashi-open-a | `09de0749fabee3ae9705e37cb2aeecf242e28b8a67c3ff0f08a31153c7880fff` | 10040 |
| B | wagashi-open-b | `a90d99c0b2a69ebb367e9d0ad8db06944115407aa81f2045689f874c074ee4a4` | 9476 |
| C | wagashi-open-b | `faf40d24a92dce62d47dc4911c0044b015cbeef5e3fa5d60a76fc31786fc39f2` | 9922 |

## 確認したこと

- 既存の pin のテストは変更なしで通る: `prompt-v11.test.ts` (v1 `a2fdd003…`/5706、v1.1 `c5973afb…`/6010・`a0dbb48c…`/7741)、`open-direction.test.ts` (v2 4本)、`prompt-tm0.test.ts`、三方式の pin。`tests/unit/design-agent/phase2f/` 10 files / 225 tests pass (`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`)。
- `phase2f-design.ts --print-pin --prompt-version v3`: 当初は brief つきで `PROMPT_VERSION_NOT_ACTIVATED`、方向つきで `USAGE` だった。Fresh Review L4 で、どの形でも `PROMPT_VERSION_NOT_ACTIVATED` に揃えた (下の「Fresh Review への対応」)。
- 回答の schema (`codex_design_v1`)・`copy-record.ts`・`facts-pack.ts`・SKILL.md と references・SR-001「輪」・DB・workflow・package/lockfile は無変更。CLI は Fresh Review L4 で v3 を冒頭で拒否する行だけを足した (v3 を選べるようにはしていない)。repo のファイルにモデル名を足していない。
- `npm run typecheck` 0 エラー、eslint 0、`check:secrets` 問題なし。
- unit の全体 (この container): 218 files pass / 18 files fail。失敗はすべて Chromium の crash (`Target crashed`・`Page crashed`・`Unable to capture screenshot`) による comp-impl / shop-css / renderer の描画テストで、`phase2f/prompt.ts` を import しない。一部は `--maxWorkers=2` の再実行で通り、残りも同じ crash。CI (PR #260) で確かめる。

## 設計上の判断 (レビューで見てほしい点)

1. **v3 は v2 の上に作った。**B/C の一番新しい版で、事実・技術・画像の規則を既に持つため。v3 と v2 の差は末尾の規則だけ。
2. **v3 は架空の店でも創作の文を書かせない。**`codex_design_v1` の `live_text` は `fact_ref` / `ui_label` だけで、`creative_expression` の欄が無い。創作の文を B/C に入れるには schema の変更が要り、承認の範囲外。オーナーの判断事項として比較の文書 §5 に残した。
3. **CLI から選べないことを「未有効」の境界にした。**有効化 = CLI に v3 を通す変更 (brief なしの判定、記録) + 実行の承認。
4. 審査 v2 は `docs/design/` に置き、スキルの `references/` には置かない (Claude がディレクトリを読んで取り込む余地を無くすため)。

## 残り・注意

- DEV-199a の PR が `.ai/tasks.json` の同じ位置 (末尾) に項目を足すので、後に merge する側で単純な衝突が出る (両方の項目を残せばよい)。
- 審査 v2 が引く `copy_quality_review_v1`・`validateCopyRevision`・`MAX_COPY_REVISION_ROUNDS` は DEV-199a (未マージ) のもの。DEV-199a の名前が変われば審査 v2 を合わせる。
- 評価 (DEV-199c の4業種、v2 と v3 の Codex 比較) はオーナーの承認の後。

## Fresh Review への対応 (C0 H0 M2 L3、5件すべて修正)

| # | 指摘 | 修正 |
|---|---|---|
| M1 | v2 の「住所は 名古屋市東区 だけ」と v3 の「事実を言い換え・短くしない」が衝突する | `COPY_V3_RULES` に例外の行を追加 (上の住所の規則が、事実の一部だけを見せてよい唯一の値)。比較の文書 §2 に、v3 は v2 の架空菓庵 fixture 専用の事実の規則 (`テスト`・`名古屋市東区`) を継ぐので、まだ店に依らない版ではないと明記 |
| M2 | 審査 v2 §7 が `MAX_COPY_REVISION_ROUNDS`・`validateCopyRevision` を今ある強制として書いている | 両方に「DEV-199a、PR #259、develop に未マージ」を付記。比較の文書の危険の表の `COPY_INFORMATION_MISSING` にも同じ注記 |
| L3 | 「事実の無い区画は落とす」が、中立なラベルだけの header・CTA・footer まで落としうる | 「a content section」に限定し、中立な `ui_label` だけのナビゲーションは内容の区画に数えないと明記 |
| L4 | `--prompt-version v3 --direction … --references …` が `USAGE` になり、v3 の拒否が出ない | `phase2f-design.ts` と `phase2f-steps.ts` の `main` の冒頭 (引数の解釈・ファイルの読み込み・ledger を開く前) で、`--prompt-version v3` を `PROMPT_VERSION_NOT_ACTIVATED` で拒否。どの組み合わせ (方向つき・brief つき・他の引数なし・未知の引数) でも同じ拒否で、何も書かない。テストを更新し、steps CLI の拒否のテストを追加。比較の文書 §5 に有効化の作業 (`noBrief`・`referenceImages`・`--print-pin` と manifest の欄・冒頭の拒否・fixture 専用の行) を列挙 |
| L5 | 「labels read the way the shop's own sign or menu would」が曖昧 | 「labels are plain words a shop sign would use (メニュー, 営業時間), naming only what the facts contain」に変更 |

- v3 の固定値は上の表のとおり更新した (規則 2597 字、旧 2299 字)。v1・v1.1・v2・tm0・三方式の pin とそのテストは無変更。
- 修正後の確認: `tests/unit/design-agent/phase2f/` + `tests/unit/ai-tasks.test.ts` 11 files / 449 tests pass (`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`)、`npm run typecheck` 0 エラー、`npm run lint` 0、`check:secrets` 問題なし。生成・モデルの呼び出しはしていない。
