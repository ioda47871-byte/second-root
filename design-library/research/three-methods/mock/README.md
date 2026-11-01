# MOCK — 3制作方式の模擬の通し実行の fixture (DEV-142)

**ここにあるものは、すべて MOCK (模擬) である。** 方式の優劣の証拠にしない。オーナーの盲検評価 (`../review-sheet.md`) にも使わない。

- Codex の出力の代わりに、手で書いた fixture を置いている。Codex・画像生成・ネットワーク・有料 API は、どれも呼んでいない。
- 素材 (A1) は、テストのコードが作る単色の PNG である (生成した画像ではない)。PNG の tEXt に MOCK と書いてある。
- ページに出す文は、事実パック (`../facts-pack.json`) の値と、40字以内の中立なラベルだけである。各ページの最上部に「MOCK」の帯を置いた。
- 目的は、3方式の手順・引き渡し・共通の検査・記録 (`three_method_run_v0`、`run_kind: "mock"`) が通しで動くことを確かめることだけである (研究の設計 `docs/design/three-methods-study.md` §8)。

## 中身

| パス | 何の代わりか |
|---|---|
| `runner-brief.json` | Phase 2f の runner の v1 prompt が要るブリーフ。研究の共通ブリーフは DNA を持たない (§4) が、今の runner は DNA を必須とするので、模擬の通し実行のためだけに置いた。実行の入口は DEV-143 |
| `visual-first/codex-answer.json` + `visual-first/codex-prototype/` | VISUAL_FIRST (V-B) の Codex のデザインの答え (`codex_design_v1`) と試作の HTML/CSS。偽の DesignPort が返す |
| `visual-first/claude-impl/` | VISUAL_FIRST の Claude の実装。lane の PC/SP の原本だけを見て書いた想定で、試作とは別に書いた (共通のクラス名は無い) |
| `layout-first/claude-impl/` | LAYOUT_FIRST の Claude の構図と実装 (2回目)。`attempt-1/style.css` は、SP で横にはみ出す1回目 (修正のきっかけの模擬) |
| `direction-first/direction.md` | DIRECTION_FIRST の Codex の方向の答え (DNA の8観点の文章) |
| `direction-first/claude-impl/` | DIRECTION_FIRST の Claude の構図と実装 |

テストは `tests/unit/design-agent/research/three-methods-mock.test.ts`。PC1440/SP390 の画像と記録は一時ディレクトリに書き、終わったら消す。残したいときは、空のディレクトリを `THREE_METHODS_MOCK_OUT` に渡す。
