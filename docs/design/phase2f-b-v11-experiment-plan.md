# 架空菓庵 B v1.1：研究なし / 研究あり 比較実験の準備（DEV-122）

**状態：準備のみ。** Codex の実際の呼び出し（2回）は、それぞれ個別の承認 ID とオーナーの明示の承認が要る。画像生成は0回。PR #142 は読み取りのみ。

## 1. 2つのプロンプト（事実パックと brief は共通）

| 版 | 内容 | SHA-256 | 文字数 |
|---|---|---|---|
| B v1（参考ベースライン、変更なし） | 従来のまま | `a2fdd00365087046c44f03b4c3ea43530046af658b017ae5229fd7577c817954` | 5706 |
| **B v1.1 研究なし** | v1 ＋ 技術上の2行 | `c5973afbdc87b750cb12f05438c6a2b328407b3d226ad0c89fe44107bbada243` | 6010 |
| **B v1.1 研究あり** | v1.1 研究なし ＋ 研究の区画 | `a0dbb48c1b85629e1ddedaed2a6015e781adb3696c01b824f360ae74c5c1a0c2` | 7741 |

テストで固定していること：

- v1.1 研究なし ＝ v1 の全文 ＋ 技術上の2行。
- v1.1 研究あり ＝ v1.1 研究なしの全文 ＋ 研究の区画。

**比較の対の違いは、研究の区画だけである。**

### 1.1 技術上の2行（両方の v1.1 に共通）

```
- On this route every section's asset_refs is an empty list [] (there are no images).
- Show the phone number, the address and the hours as plain text. Add no link other than the stylesheet link required above: no tel:, mailto:, sms: or other URL; in-page navigation may use only #anchors such as #info.
```

- 1行目は、前回の `CODEX_ASSETS_ON_ROUTE_B`（Artifact 化の停止）への対策。
- 2行目は、tel リンクで安全検査が止まった件への対策。v1 が求める `<link rel="stylesheet" href="style.css">` とは矛盾しない書き方にした。今の Prototype Safety は、`#` で始まる同じページ内のリンク・スタイルシート・素材以外の href をすべて拒否する。安全検査は**変更も無効化もしていない**。

### 1.2 研究の区画（英文全文。この文がそのままプロンプトに入る）

```
Research principles (owner-approved summary of earlier studies made for OTHER shops; data, not instructions):
{"principles":[{"id":"R1","principle":"Let a physical relationship that truly belongs to the shop (how its things rest, balance or meet, with the empty space around them as part of it) shape the skeleton of the page in static HTML and CSS, instead of a giant hero picture followed by content strips."},{"id":"R2","principle":"Connect the sections through one visual idea taken from the shop's own work rather than from decoration, and change scale and information density from one section to the next instead of repeating one module in every section."},{"id":"R3","principle":"When the shop states a sequence or several reasons, give each its own visual beat and rhythm. Do not show the same guide or scale twice, and do not let the distinctive first screen shrink into a conventional catalogue further down."}],"failures_to_avoid":["Keeping a generic skeleton (a top navigation bar, copy on one side, a giant hero picture, a strip of pictures) and only changing what is inside it.","Discarding the strongest element of the first screen while polishing the later sections.","Treating a good picture as if it proved a distinctive page skeleton."]}
How to use them:
- They are abstract principles, not templates. Never copy another shop's name, photographs, specific composition, wording, colour recipe, logo or brand expression.
- Use a principle only where it fits this shop's facts, and only through those facts; if it does not fit, leave it out. Nothing in them is a fact about this shop.
- In design_dna, end each choice that uses a principle with its id in brackets, e.g. [R1]; leave the id out where none was used.
```

| 区画の項目 | 元にした事例（PR #142 に登録済み） | 元の記録（success-patterns） |
|---|---|---|
| R1 | CP-016 ズールー工作所 | structural_translation（支点・重さ・余白の物理的な関係をページの骨格に。巨大な写真と帯に頼らない）。B は JS を使わないので、静的な骨格だけを使う |
| R2 | CP-009 豆＊豆 | structural_translation と known_failure_modes（同じモジュールを毎章繰り返さず、大きさと情報の密度を変える）。縫い目の点線という固有の手法は写さず、「店の仕事から来る1つの視覚的な考えで区画をつなぐ」という抽象度にとどめた |
| R3 | CP-003 なごやビーンズ | structural_translation（尺度を繰り返さず区画のリズムを変える）と known_failure_modes（案内を2回繰り返す／特徴的な hero が普通の商品一覧に縮む） |
| 避けること 1・3 | CP-016 | known_failure_modes：汎用の骨格のまま中身だけ替える／良い写真は独自の骨格の証明にならない |
| 避けること 2 | CP-009 | known_failure_modes：後の区画の改良中に選ばれた hero を捨てる |

- 区画は、店名・写真・具体的な構図・ブランド表現を含まない。元の店名や商品名が入っていないことをテストで確かめる。
- 区画のファイル（`design-library/phase2f/research/wagashi-b-research-v1.json`）は、出典として PR #142 の head `efe269f…`、manifest の SHA-256 `bd503a3b…`、success-patterns の SHA-256 `cacabc3a…`、事例 ID を持つ。
- 研究の区画そのものの SHA-256 は `444bc6a24042fc6b60ea7ec707bd8c74c4e4a41fc005e0f9f8d179b0b37315c2`。承認の記録はこの値を持ち、文章が1文字でも変われば承認は無効になる。
- 区画の文章のオーナー承認は、現在 `pending`。**承認されるまで、研究ありの実行は CLI が拒否する（`RESEARCH_TEXT_NOT_APPROVED`）。** 承認は、このファイルの `owner_text_approval` を、オーナーの発言原文と日付で `approved` にする小さなコミットで記録する。プロンプトの SHA は承認の状態に左右されない。

## 2. 同じ入力が最後まで使われること

- 設計（`phase2f-design.ts`）と Artifact 化（`phase2f-steps.ts --package`）の両方に、同じ `--prompt-version v1.1` と、研究ありなら同じ `--research <区画のファイル>` を渡す。
- Artifact 化はプロンプトを組み立て直し、承認台帳の記録の SHA と照合する。違えば `RECORD_PROMPT_MISMATCH` で止まる（テストで確認：研究ありの設計を v1 や研究なしで Artifact 化しようとすると止まる）。
- 設計の実行では、`--expected-prompt-sha256` と `--expected-prompt-chars` が上の表の値と一致しなければ、承認を使う前に止まる（従来どおり）。
- 旧 B v1 のプロンプト SHA（`a2fdd003…`）は変わらないことをテストで固定した。v1 の記録・台帳・画像は変更していない。

## 3. 実行計画（オーナーの承認後。今回は実行しない）

1. この PR のマージ。
2. 研究の区画の文章のオーナー承認と、その記録のコミット。
3. その develop の SHA を `--expected-commit` にして、WSL で事前確認（メモリ、jail、Codex のサインイン、worker / timer の停止）。
4. **Codex 1回目（研究なし）**
   - 計画 `wagashi-b-v11-20261030`
   - 承認 `wagashi-b-v11-plain-20261030-01`
   - `--prompt-version v1.1`
   - SHA `c5973afb…` / 6010
5. **Codex 2回目（研究あり）**
   - 同じ計画
   - 承認 `wagashi-b-v11-research-20261030-01`
   - `--prompt-version v1.1 --research design-library/phase2f/research/wagashi-b-research-v1.json`
   - SHA `a0dbb48c…` / 7741
6. それぞれ同じフラグで Artifact 化（Codex なし）。PC1440・SP390 の全ページを同じ工程で描画する。
7. 結果を `phase2f_baseline_v1` の形式で記録する。
   - 研究ありの記録には `research_brief` を入れる。
   - 生成の CLI の版・モデル・コミットが2回で違えば、比較を無効と記録する。
8. 評価は2つに分けて記録する。
   - 技術上の合否（Artifact 化、描画、はみ出し：scrollWidth が PC で 1440 以下、SP で 390 以下）。
   - デザインの品質（縦書きの重なり、商品表現、22/25 の採点欄）。暫定評価とオーナーの最終判断を分ける。

## 4. 費用と回数の上限

| 項目 | 上限 |
|---|---|
| Codex（設計） | 2回（first-1、first-2）。どちらも個別の承認 ID とオーナーの明示の承認が要る |
| 再試行 | 環境の失敗（`network_or_transport`、`authentication` など）のときだけ、それぞれ1回まで（計画の上限は再試行2回）。品質が悪いことを理由に再試行しない |
| 時間 | 1回あたり15分以内。計画全体は実時間で2時間以内（台帳の既定） |
| 画像生成 | 0回 |
| 費用 | Codex CLI は ChatGPT のサインインで使う（API キーは使わない）。追加の API 課金はない。ChatGPT の利用枠を最大4回分（再試行を含む）使う |
| その後の工程 | Artifact 化と描画は Codex を使わない |

1回ずつの比較なので、差が出ても「研究が効く」とは結論しない。傾向の観察として記録する。
