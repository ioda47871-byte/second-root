# 3方式パイロット 1回目 — Claude のページ (D、DEV-152、Issue #180)

**盲検の評価が済むまで、この folder の HTML・CSS を開かない・描画しない** (オーナー)。この文書には見た目の説明を書かない。

## 入っているもの

| folder | 方式 | 条件 | 画像 |
|---|---|---|---|
| `layout-first/` | LAYOUT_FIRST | `claude_layout` | 1枚 (A1、C2-a で生成。`assets/` はまだ無い) |
| `direction-first/` | DIRECTION_FIRST | `direction_text` | 0枚 (理由は下) |

VISUAL_FIRST の実装はこの PR に入れない (lane から作る。計画 §3.2)。

## 入力

- 共通: `../facts-pack.json` (`e63d925a…97c0`)、`../identity-lock.json` (`29c1fd88…cbb4`)、`../brief.json` (`efe91cf2…4b4c`)。ページの文は事実の値そのままか、40字以内の中立なラベルだけ。
- DIRECTION_FIRST だけ: C1-b の `direction.json` (approval `komugi-tm-df-direction-20261102-01`、run `p2f-67b6b59965f041c9`、commit `1617a77`、Codex CLI 0.159.0、model `gpt-6.1-sol`)。受け取った tar の SHA-256 は `74d73c8f…a906`、`SHA256SUMS` は全件一致、リンク無し。
- LAYOUT_FIRST は Codex の出力を見ずに書いた (C1-a・C1-b の結果を受け取る前に commit `e08d7e1`)。

## ファイルの SHA-256 (この PR の head)

| file | SHA-256 |
|---|---|
| `layout-first/index.html` | `529785dff053d42b79be696fce4fd6c352b6cdfeebf7acf3aba1314ee5c091be` |
| `layout-first/style.css` | `293abc8bee3bbd95d6fab81cbe03bd43f94a64698a51b35ee4226b1e7ad7ea79` |
| `direction-first/index.html` | `17bee4e845eb30e4350f2921cde24562f30933168683b15a21f0a219bcfc8728` |
| `direction-first/style.css` | `a4861681a1af6eacff98e08c847cf3b94ce3fbe3fa85106a6bbfa9bd4d769bcd` |

**マージのあとでページを1バイトでも変えると、C2-a の画像はページに結び付かなくなる** (`IMAGE_PAGE_MISMATCH`)。

## 検査 (オフライン、Claude の作業場所、仮の画像)

| | LAYOUT_FIRST | DIRECTION_FIRST |
|---|---|---|
| 実装レーンの CSS 許可一覧 (`pageCssProblems`) | 指摘 0 | 指摘 0 |
| ページの読み取り (`extractAssetMarkers`) | A1 の1枚 | 0枚 |
| `three-methods-steps.ts --check` 横はみ出し (1440 / 390) | 無し / 無し | 無し / 無し |
| Identity (`auditPageText`) | PASS | PASS |
| SP の所見 (`measureMobileQuality`、記録だけ) | 0 | 0 |
| 構造の観測 (記録だけ) | generic_skeleton 無し。PC の hero は `split_copy_media` と測られる (汎用の印は1つ) | generic_skeleton 無し |
| 修正 (横はみ出しのみが修正のきっかけ) | 0回 | 0回 |

- 横はみ出し以外の見た目の調整 (名前の折り返しなど) は、どちらも書いている途中の1巡で行った。修正の上限 (`LIMITS`) は使っていない。
- 描画は Claude の作業場所の Chromium で、和文の明朝の書体が無く、総称の書体で描かれた。実機の書体は違いうる。

## 画像の要求

- **LAYOUT_FIRST (C2-a):** `--page-request` の結果は、A1 が essential、prompt `dd79e4343708ee6a27ed98bb3575ffc75fec1b06549eb53539fc464c4facb580` / 933 文字、ページ `layout-first/index.html` `529785df…91be`。マージのあと C2 の commit で、オーナーが同じ値を `--print-pin` で出して照らす。
- **DIRECTION_FIRST:** 画像を求めない。方向 (C1-b) の `product_visual` が「生成画像も商品写真も使わない」と決めているため。`--no-image-reason` で `no-image.json` を作れることを確かめた。VISUAL_FIRST は必ず1枚なので、生成の予算はそろわない (条件の違いとして記録する。暫定決定 3)。**C2-b は行わない。**

## 方向からのずれ・制約 (DIRECTION_FIRST)

- 方向は分類 (F2 `bakery`) を中立なラベル「パン工房」で示すとした。ページはそれに従い、`bakery` の文字列は出していない。
- 方向は「キーボードの焦点を見えるようにする」としたが、実装レーンの CSS 許可一覧は状態の擬似クラス (`:focus`) を許さない。ブラウザの既定の焦点の表示のままにした。
