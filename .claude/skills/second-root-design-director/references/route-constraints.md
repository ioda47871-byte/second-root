# 経路ごとの制約と指示文の形

道案内である。正本はコードで、食い違ったらコードが正しい。

## B方式 (`B_html_prototype`) の試作

正本: `lib/design-agent/phase2f/prompt.ts` (指示文)、`lib/design-agent/phase2f/prototype-safety.ts`
(`checkPrototype`、違反は `PROTOTYPE_UNSAFE`)、`docs/design/phase2f-runner.md`、`docs/design/phase2f-live.md`。

- 出すのは `index.html` と `style.css` だけ。`<link rel="stylesheet" href="style.css">` で読む
- 使えない要素: script、iframe、frame、object、embed、applet、form、base、portal、foreignObject、
  SVG の animate / set / animateMotion / animateTransform、noscript。`on*` 属性も不可
- URL は `style.css`、`#id` だけ (B方式は画像を使わないので `assets/` も使わない)
- CSS で使えないもの: `@import`、Web フォント (`@font-face` で外から読むもの)、`data:` URL、
  `url()` で外を指すもの、`expression()`、`behavior:`、`-moz-binding`、`image-set(` / `image(`
- 画像を使わない。文字・色・レイアウト・CSS の形・インライン SVG で作る。写真を CSS や SVG で真似ない
- CSS の性質は自由: grid、絶対配置の重ね、`writing-mode`、`clip-path`、transform、blend mode、
  インライン SVG を使ってよい (B方式の試作だけの自由。実装レーンは違う)
- 各節の根に `data-section="<id>"`。SP の 390px は「縮めた PC ではなく、スマホのために設計」する
- 描画は JS を切り、通信を止めて行う。外へ出ようとすると `PROTOTYPE_NETWORK_ATTEMPT`
- 止まる条件: 横はみ出し (`PROTOTYPE_HORIZONTAL_OVERFLOW`)、白紙 (`RENDER_BLANK`)、
  高さ 16000px 超 (`RENDER_PAGE_TOO_TALL`)、どの幅でも見えない節
- 大きさ: HTML 384 KiB、CSS 256 KiB まで
- 事実の規則 (`B_V11_RULES` / `V2_FACT_RULES`): `asset_refs` は常に空、電話・住所・時間は
  プレーンテキスト (リンクにしない。`#anchor` だけ可)、`テスト` を含む値を出さない、注文・予約・カートの言葉を使わない

書体: B方式の試作は Web フォントを読めない。描画する機械にある書体か、総称 (serif、sans-serif など)
で組む。実装レーンへ渡すなら、最初から下の許可一覧の中で選んでおくと、試作と実装で書体がずれない。

## 実装レーン (Claude が実装する側)

正本: `lib/design-agent/comp-impl/page-css.ts` の冒頭と `PAGE_FONT_FAMILIES`、
`lib/design-agent/shop-css/render-check.ts`。

- B方式よりずっと厳しい許可一覧である。transform・擬似要素・clip-path・blend mode・vw/vh は使えず、
  文字は横組みだけ (店名の縦組み `vertical_name` も DEV-102 で未承認。`docs/design/reference-technique-shortlist.md`)
- 文字は 12px 以上、コントラスト 4.5 以上
- 書体は許可一覧の中から: Noto Sans/Serif JP、Noto Sans/Serif CJK JP、IPA 系、ヒラギノ系、游系、
  メイリオ、BIZ UD 系、Zen Kaku Gothic New、Zen Old Mincho、Shippori Mincho、Inter、DejaVu、
  Liberation、Helvetica、Arial、Georgia、Times New Roman、総称 (serif、sans-serif、system-ui、ui-serif、ui-sans-serif)
- だから、B方式の試作で使った表現 (縦組み、斜めの切り抜き、重ね) は、実装レーンで同じに作れるとは限らない。
  方向案に「実装レーンで代わりにどう作るか」を1行書いておく

## 構造記述子の語彙

正本: `lib/design-agent/structure` の `VOCABULARY`・`GENERIC`・`THRESHOLDS`。**語彙も閾値も仮である** (Issue #159)。
方向案の構造の宣言と、オフラインの自己点検 (助言) にだけ使う。Codex への指示文に入れてよいのは、
Hero の型と流れの型 (`HERO_MODES` / `PAGE_FLOWS`) だけである。生成器への組み込みは別の承認が要る。

| 観点 | 値 |
| --- | --- |
| hero | object_led, type_led, diagram_led, scene_led, split_copy_media, centered_headline |
| flow | single_axis_scroll, map_of_stations, alternating_spreads, one_continuous_surface, stacked_bands |
| navigation | top_bar, side_index, inline, none |
| reading_path | vertical_axis, z_pattern, f_pattern, radial, free |
| section_layouts | full_bleed_media, split_copy_media, single_column_text, grid_cards, overlap_collage, diagram, vertical_text |
| transitions | hard_cut, overlap, continuous |
| text_direction | horizontal, vertical, mixed |
| imagery | none, single_lead, sequence, collage, drawn |

- 汎用 LP の印 (`GENERIC`) は3つ: hero が split_copy_media か centered_headline / flow が stacked_bands /
  節の半分以上が split_copy_media か grid_cards。このうち2つで `GENERIC_SKELETON`
- 仮の閾値: 参照に近すぎる 0.75 (`TOO_CLOSE_TO_REFERENCE`)、兄弟案が同じ骨格 0.6 (`SIBLINGS_SAME_SKELETON`)
- 方向案どうしは、Hero の型と流れの型の**両方**が違うこと (`lib/design-agent/phase2f` の `directionsDiffer`)
- 計測できる観点 (navigation、節の型、transitions、text_direction、imagery、Hero と流れの汎用の印) は
  描画から測られ、宣言より計測が勝つ。宣言しただけでは通らない

## 指示文の形

### B方式の試作を Codex に頼む指示文

指示文は手書きの文章にしない。方向案を **`phase2f_open_direction_v1` の JSON** にし
(`lib/design-agent/phase2f/open-direction.ts` の `OpenDirection`。例: `design-library/phase2f/directions/wagashi-open-a.json`)、
`buildDesignPrompt` に組ませる。承認に持っていく SHA-256 と文字数は、組まれた prompt のものである。
JSON の欄は `concept` (900字まで。配色と節の順は書かない)、`composition` (`hero` と `flow`)、`research`
(1〜3件: 採ったもの・捨てたもの・この店への翻訳)、`reference_ids` (承認済み参照だけ)。分け方は次のとおり。

- **固定**: 事実 (そのまま)、店名、Hero の型、流れの型、中心の比喩、PC と SP の組み方の要点
- **任せる**: 構図の細部、配色の細部、書体の細部、節の内部の構成
- **参照**: 承認済み参照 (CP-003-pc / sp) だけ。`learn` と `do_not_copy` を添える。研究の文章は、
  所有者が承認し SHA で固定したファイルからしか入れない
- **禁止**: B方式の制約と事実の規則をそのまま

### 実装レーンへの引き継ぎ

- 選ばれたデザインの PC1440 / SP390 の原本、節の id と順序、守る部分、許可一覧で作れない表現の代わり方

## 実行の承認

Codex の実行、画像生成、有料 API は、このスキルでは行わない。実行には人間の承認 ID が1回ごとに要り、
prompt の SHA-256 と文字数を記録する (`docs/design/phase2f-live.md`、`docs/operations/claude-autonomy.md`)。
