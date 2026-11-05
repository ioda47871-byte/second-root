# 段 C の設計: 安全な重なり・描画順・レイヤー (DEV-173、Issue #193 コメント `6628165899`)

2026-11-04。**設計と、テストの中だけの試作による検証の記録で、何も有効にしていない。**

- `lib/**` の差は 0 行。本番の CSS ゲート (`page-css.ts`)・描画の検査 (`layers.ts`・`render.ts`・`run.ts`)・能力の表 (`spec.ts` の `CAPABILITY_NAMES`・`APPROVED_CAPABILITIES = []`) は変えていない。
- 提案の文法と描画の検査は、`tests/unit/design-agent/comp-impl/overlap-harness.ts` (テストだけの試作) にある。run.ts・worker の道からは見えない。
- **本番の CSS ゲートを変える PR は、オーナーの明示の承認まで merge しない (HOLD)。** §8 の差分の概要は、その PR の下書きであって承認ではない。

土台: `docs/design/dev-083-expressive-safe-reproduction.md` (V1〜V10、§3.1(d)、§7 の段 C)、`docs/design/phase-b-design.md` (段 B の旗と §2.9 の描く範囲)、`docs/design/display-nowrap-decision.md`・`display-scale-decision.md`・`gradient-ground-decision.md` (同じ形の検証)、`docs/design/n1-decoration-svg.md` (装飾の SVG。段 C の後)。

## 0. 先に結論

- **今は何も通らない (証明した)。** 位置・オフセット・`z-index`・負の margin・`transform`・`isolation`・`pointer-events`・`overflow`・`mix-blend-mode`・`clip-path`・`filter`・`outline`・外側の影・`text-shadow`・`-webkit-text-stroke`・`will-change`・`contain`・グリッドの線の番号・疑似要素 (32 の宣言と3つの選択子) は、旗なし・`vertical_name`・段 B の旗すべて の3つの組で文法が拒む。C′ の3ページは HTML (インライン SVG: `HTML_ELEMENT`) と CSS で拒まれ、描画の側でも run の層の検査が `STACKING_CONTEXT` (と疑似要素のある2店で `PSEUDO_GEOMETRY_UNKNOWN`) で止める。
- **提案: 能力 `layered_decoration` (旗 `layeredDecoration`、既定 OFF)。** 文字を持たない箱 (装飾) だけを位置で置き、回し、重ねる。文字を持つ箱は「`position: relative` + `z-index`」で持ち上げる (動かさない) ことだけ。負の margin はどの箱にも許し、届いた先は描画の検査が裁く。疑似要素・SVG・ビューポートの単位・ブレンド・切り抜き・フィルター・外側の影・輪郭線・`pointer-events` は入れない (§5)。
- **描画の検査 (V2 と V4) は、文字の字形の箱に何が届くかを、描画の順で裁く (§3)。** 装飾が字形の上に描かれれば、色や透明度に依らず落ちる。守る文字 (事実・免責・dt/dd・店名) の下には、文字自身か祖先の**不透明で平らな板** (plate) が間に入らない限り、装飾は入れない。順序を証明できない描き方 (外側の影・輪郭線・フィルターのにじみ・測れない疑似要素・文字の外にあふれた文字) は落とす (fail closed)。
- **試作はこれを示した (§6):** 48 の落ちるべき例がすべて落ち、9 の通るべき例がすべて通る (Fresh Review・CI・再レビュー4回と DEV-178 の後。最初の版は 27)。今の run の当たり判定 (`GEOMETRY_SCRIPT` の 15 点) は、そのうち 1px の線・疑似要素・SVG・`pointer-events: none`・輪郭線・影・下に敷いた文字 を見逃す。今の V2 のモデル (`LAYER_SCRIPT`) は疑似要素・SVG・文字の上の文字を見ない。どちらも、今は許可一覧が先に拒むので穴ではないが、**段 C ではそのまま使えない**。
- **3店 (§7):** 提案の文法で strict B に層を足したページ (つぐ手: 板の上の金の割れ目と線の断面を貫く継ぎ目、輪: ハブからのスポークと境界にかかる空気入れの計器、ゆげ湯: 全ページの温度計の管・壁と夜の境にかかるのれん・熱い湯の区画に食い込む湯船の板) は、**320〜1920 の 1px の全幅で strict B と同じコードしか出ない** (strict にもともとあるタブレットのはみ出しだけ)。C′ は確かめる幅のすべてで落ちる。
- **得は小さい。正直に言う。** C′ の見た目の大半 (曲がった継ぎ目、破片の形の板、輪郭の巨大な語、湯気、のれんの「ゆ」、板の影) は、インライン SVG・`clip-path`・フィルター・`aria-hidden` の文字・`-webkit-text-stroke`・vw の位置 に頼っていて、`layered_decoration` だけでは戻らない。戻るのは「区画の境をまたぐ」「板が隣の区画に食い込む」「装飾が画像の上や文字の間を通る」という**構図**である。曲線と形は N1 (装飾の SVG) と段 D が要る。

## 1. 棚卸し: C′ が重ねに使うもの

対象: つぐ手 `fidelity/d1-v5`、輪 `fidelity/d1-v4`、ゆげ湯 `fidelity/d1-v4` (DEV-168 の後の最新。DEV-171・DEV-172 と同じ)。数えたのは `overlap-harness.ts` の `inventory` (CSS の `prop: value` と HTML の要素の素朴な数え上げ。テストで固定)。

| 種類 | つぐ手 | 輪 | ゆげ湯 | 計 | 提案の文法 |
|---|---|---|---|---|---|
| `position: absolute` | 16 | 22 | 11 | 49 | 入れる (文字を持たない箱だけ) |
| `position: relative` | 19 | 10 | 12 | 41 | 入れる (文字の箱は持ち上げだけ) |
| オフセット (`top`・`left`・`inset`…) | 70 | 78 | 70 | 218 | 入れる (px・rem・%、±2400px) |
| `z-index` 正 | 27 | 15 | 20 | 62 | 入れる (−1〜9) |
| `z-index` 負 | 0 | 0 | 0 | 0 | 入れる (−1 だけ) |
| 負の margin | 5 | 1 | 6 | 12 | 入れる (−400px まで) |
| `transform` | 10 | 8 | 3 | 21 | 入れる (`rotate` ±45°・`translate`、文字を持たない箱だけ) |
| 疑似要素の規則 | 1 | 5 | 5 | 11 | 入れない (`ornament` の別の判断) |
| `pointer-events` | 4 | 4 | 6 | 14 | 入れない (検査は無視して当たり判定する) |
| `overflow` の切り抜き | 1 | 1 | 2 | 4 | 入れる (`hidden`・`clip`。V4 が文字の切れを見る) |
| `clip-path`・`mask` | 3 | 2 | 0 | 5 | 入れない (段 D) |
| `filter` | 1 | 1 | 3 | 5 | 入れない (`image_filters` の別の判断) |
| `opacity` < 1 | 7 | 1 | 1 | 9 | `translucent_decoration` (段 B、OFF) |
| 外側の `box-shadow` | 4 | 0 | 5 | 9 | 入れない |
| `outline` | 0 | 0 | 4 | 4 | 入れない |
| `-webkit-text-stroke` | 1 | 0 | 3 | 4 | 入れない (段 D の後) |
| `mix-blend-mode`・`isolation` | 0 | 0 | 0 | 0 | `isolation` だけ入れる |
| 位置に使う vw | 12 | 48 | 1 | 61 | 入れない (`CSS_VIEWPORT_UNIT` のまま) |
| インライン SVG | 16 | 7 | 3 | 26 | 入れない (N1) |
| `aria-hidden` の文字 (巨大な語) | 2 | 3 | 4 | 9 | 入れない (`TEXT_ARIA_HIDDEN` のまま) |

**分かったこと。**

- C′ は **負の `z-index` も `isolation` も使わない**。重ねは「装飾を `z-index: 1`、文字のまとまりを `position: relative; z-index: 2` に持ち上げる」の一つの型でできている (62 の正の `z-index` のほとんど)。提案の「持ち上げ」と「板」は、この型をそのまま検査できる形にしたものである。
- 損失ごとに要るもの:

| 失われたもの (DEV-160・`comp-impl-loss-analysis.md`) | C′ の作り | `layered_decoration` で戻るか |
|---|---|---|
| つぐ手: 区画をまたいで器から器へ走る継ぎ目 | 区画ごとのインライン SVG の曲線 (`preserveAspectRatio: none`、`vector-effect`)、文字は z 2、線は z 1 | **直線なら戻る** (≤1199 の C′ も `div` の直線)。曲線は N1 が要る |
| つぐ手: 破片の形の板と板の上の割れ目 | `clip-path` の多角形、`rotate`、`drop-shadow`、SVG の割れ目 | 板の上の直線の割れ目は戻る。形・影は戻らない |
| つぐ手: 線の断面を貫く継ぎ目 | 帯の上の SVG と金の盛り上がり (グラデーション) | 直線の継ぎ目は戻る (文字に板を敷く) |
| つぐ手・輪・ゆげ湯: 区画をまたぐ巨大な語 (継ぐ・待つ・まわる・締める・熱い…) | `aria-hidden` の文字、輪郭は `-webkit-text-stroke` | **戻らない。** 文字の装飾は文字として扱う (§3.5)。N1 の SVG の資産なら別 |
| 輪: ハブから伸びて板を吊るスポーク | インライン SVG の線 (vw の座標)、板は vw で絶対位置 | 回した細い箱で近いものは戻る。板を吊る位置 (vw) は戻らない |
| 輪: 区画の境にかかる空気入れの計器 | SVG を絶対位置で上の区画へ | **戻る** (負の margin) |
| ゆげ湯: 温度計の管 | 絶対位置の管、目盛りは疑似要素と繰り返しのグラデーション | 管は戻る (目盛りは戻らない) |
| ゆげ湯: 湯気 | SVG のぼかし (`filter: blur`)、透ける radial | 戻らない (文字に掛かる半透明・フィルター) |
| ゆげ湯: 境にかかるのれん | SVG (布・竿・「ゆ」の文字) と `drop-shadow` | 箱の布の形だけ戻る |
| ゆげ湯: 前の区画に食い込む湯船の板 | 負の margin と `rotate`、白い縁 (`outline`) と影 | 食い込みは戻る (縁と影は戻らない) |

## 2. 守るもの

- **守る文字 (protected):** 免責 (`[data-comp-disclosure]`、研究のページでは `.fictional`)、`dt`・`dd`、`h1` (店名)、文字の全体が事実の値 (facts pack) を含むか、6 字以上で事実の値の一部である要素、**そして要素をまたいで書かれた事実の一部** (DEV-175 の4回目の再レビュー H1: `<p>電話 000-0000-<span>0712</span></p>` の 0712 は、自分の要素の文字が事実を含まず 6 字未満なので普通の本文だった。今は、body の文字の節を DOM の順に1本につなぎ、元の1字ごとに正規化して (NFKD、結合記号・書式文字・空白を落とす)、事実の出現と重なる節を守る文字にする: `FACT_NODES_JS`。flex・grid の項目や2つの段落に分かれた事実、全角の数字、ゼロ幅スペースを挟んだ事実も守る (5回目の再レビュー)。DEV-178 で、紛らわしい字を両側で1つの形に寄せた: U+2010〜2015・U+2212・U+30FC を `-` に、U+FF5E・U+301C を `〜` に、1字を1字へ、NFKD の前と後で (段 D の設計 §4.5)。守る文字を増やすだけで、何も緩めない)。run の `protectedOwner` (layers.ts) より広い (店名の短い形・事実の文の折り返しを含む)。
- **普通の本文 (ordinary):** それ以外のすべての文字の節。`aria-hidden` の文字も描かれるので数える (run は `TEXT_ARIA_HIDDEN` でそもそも拒む)。
- **字形の箱 (glyph box) = 墨の箱:** 文字ごとに、要素の書体で canvas の `measureText` が返す墨の範囲 (`actualBoundingBox*`) を、Range の箱の上端 + 書体の ascent で求めた基線に置き、にじみの 1px 広げたもの。行送りにも書体の content area にも依らない。守る文字は V4 でさらに 1px 広げる (V3b と同じ決まり)。縦書きは Range の箱を字の大きさの 1.3 倍に切ったもの (縦の墨の測り方は作っていない)。
- **なぜ墨の箱か (CI で分かったこと、§2.1)。** 最初の版は「Range の箱を縦に 1.3em に切ったもの」だった。Range の箱は書体の content area で、CI の書体 (IPA の無い ubuntu、Playwright の書体) のように content area が高い書体では、行送り 1 の大きな字 (つぐ手の店名 200px) の箱が自分の要素の箱の外へ出る。そこへ隣の要素 (器の絵) が届くと、当たり判定の束に文字が出ない点になり、**fail closed で `OVERLAP_ORDER_UNPROVEN` を出した**。strict B (重ねの無い、今のページ) が落ちたので、規則でなく測り方の誤りである (誤検知)。

### 2.1 書体への依存 (CI で落ちた4件の原因)

- **何が起きたか:** PR #213 の CI (unit 2/2) で、つぐ手の strict B が 1440 で `OVERLAP_ORDER_UNPROVEN`、層の版の掃引が 320–1920 で `OVERLAP_ORDER_UNPROVEN` と `OFFSCREEN` 601–1007、端の確かめが 600、ゆげ湯の C′ の板の覆いが 1271–1275 になった (この容器では順に 無し・`OFFSCREEN` 601–995 だけ・601・1260–1263)。
- **原因:** 字の高さが書体で変わることに、2つの別のものが重なっていた。(1) **誤検知 (測り方):** 上の 1.3em の箱が書体の content area に引きずられ、要素の箱の外へ出た所を「順を証明できない」とした。(2) **本物の書体差:** はみ出しの範囲・C′ の覆う幅は、書体で実際に変わる (テストに数字を書いたのが誤り)。
- **再現:** `gradient-harness.ts` の `withWideMetrics` (IPA の書体を ascent 116%・descent 29% で宣言し直し、content area を 1.45em にする。この容器で CI の字の高さに**近づける**だけで、IPA の無い所では何も変わらない) で、旧い箱では strict B のつぐ手が 1440・768 で `OVERLAP_ORDER_UNPROVEN` (店名 つぐ手 ← 器の地)・`OVERLAP_PROTECTED_TEXT_ON_TEXT` (店名の全体 ← 大きな店名) など、輪・ゆげ湯も `TEXT_ON_TEXT` を出した。**墨の箱に変えると、3店の strict と層の版は、この容器の書体で 0、広い字の高さでもつぐ手の SP の `aria-hidden` の巨大な語 継ぐ 1つだけ**になった (§2.2)。
- **テストの直し:** 数字を書かない。strict を毎回テストの中で測り、層の版が全幅で strict と同じであることを確かめる (この容器の書体と広い字の高さの両方で、確かめる幅)。C′ の覆いは「確かめる幅のどれにも当たらない狭い帯に、守る文字の覆いがある」という性質を確かめる。この容器の範囲は §7 に記録として残す。

- **CI の書体 (ログから):** `playwright install --with-deps` は `fonts-ipafont-gothic`・`fonts-liberation`・`fonts-freefont-ttf`・`fonts-wqy-zenhei`・`fonts-unifont`・`fonts-tlwg-loma` を入れる。**IPAMincho と Noto Sans CJK は無い**。つぐ手の明朝の語 (縦の店名・巨大な語・見出し) は総称の serif に落ち、ラテン文字の書体 (DejaVu・Liberation など) を主の書体に、かな漢字だけを別の書体で描く。
- **手元での再現:** (1) `FONTCONFIG_FILE` で CI と同じ書体の組だけを見せた fontconfig (`scratchpad/dev173/fonts-ci.conf`、リポジトリの外) で Chromium を起動すると、CI のつぐ手 strict の `ORDER_UNPROVEN` (1280・SP) が同じく出る (巨大な語 継ぐ・待つ の墨が自分の箱の外へ出る)。(2) テストの中では、店のページの書体の名前を IPAGothic (両方の機械にある) に読み替える `withPinnedFonts` を使い、その下で「strict は既知のタブレットのはみ出しだけ」の上限を確かめる (CI でも同じ書体になる)。

### 2.2 残る誤検知の形 (fail closed)

- 広い字の高さで、つぐ手の SP の 継ぐ (120px、行送り 1) の墨は、自分の要素と区画の下へ実際にはみ出し、次の区画の地の上に描かれる。墨のある点は文字の要素の箱の外で、当たり判定の束に文字が出ないので `OVERLAP_ORDER_UNPROVEN`。**描かれ方は本物 (文字が隣の区画の地に載る)** なので、誤検知とまでは言えないが、文字が自分の箱の外に描かれることを「順を証明できない」として落とす決まりである。run の `TEXT_OUT_OF_BOX` (事実と札) と同じ方向の厳しさ。普通の本文 (`aria-hidden` の飾りの語を含む) にまで掛けるかはオーナーの判断 (§12)。
- 書体が変われば、strict のページでも段 C のコードが出うる。**層を足していない strict のページで出るコードは、能力を ON にしたときに今のページを落とす**ので、ON の前にオーナーの書体 (`web_font`、段 B) と合わせて決める。

### 2.3 墨の箱の限り (再レビュー M1・L2、CI)

canvas の `measureText` は、1字を既定の字形で、ひとりで測る。ページがそれと違う字形を描くと、墨の箱は墨を含まない (守る文字の覆いの見逃しになりうる、安全の側の穴)。試作は次を測れないものとして **fail closed** にする (`OVERLAP_GLYPHS_UNMEASURED` / `OVERLAP_PROTECTED_GLYPHS_UNMEASURED`)。

- OpenType の機能: `font-variant-numeric` (例: Inter の `tabular-nums` は数字を広い送りの中央に描く。40px で墨が箱の外に最大 7.9px、456 画素)、`font-feature-settings`、`font-variant-east-asian`・`-alternates`・`-ligatures`・`-caps`・`-position`、`font-variation-settings` が `normal` でない
- 結合文字 (`\p{M}`。`Café` の NFD のアクセントは送り 0 で、Range の箱が捨てられ、元の字の箱はアクセントを含まない)
- 線の飾り (`text-decoration-line` が自分か祖先で `none` でない。下線の墨は字形の外に 5px ほど)
- 縦書きで、字の箱が列の方向に 0.5em より短い (例外は横倒しの ASCII と小さな句読点 、。，．・：；！？ だけ。全角の英数字・半角かな・〇・々は例外にしない) (ラテン文字の主の書体とかな漢字の代わりの書体で描いた縦の店名で、最後の字の Range の箱が 5px になった。CI の書体のつぐ手 C′ で起きる)
- リストの印 (`::marker`。歩く文字に出ない描かれた文字): `OVERLAP_MARKER_UNMEASURED`

**画素の側の確かめ:** 画素の検査は字形の箱の中だけを読むので、箱が小さすぎることを自分では見つけられなかった (再レビューの指摘)。全画面で「参照の絵の文字の墨 (半分以上の濃さ) が、どの字形の箱 (+1px) の外にもある」画素を数える `PIXEL_INK_OUTSIDE_GLYPHS` (4 画素以上で落とす) を足した。3店の strict と層の版は、この容器の書体・CI に近い書体のどちらでも 0。CI の書体のつぐ手 C′ は 1440 で 75,994 画素 (縦の明朝)。

## 3. 規則

### 3.1 V2: 描画の順

**字形の箱 G (文字 T) に 0.5px を超えて届く、T の祖先でない「描くもの」P は、T より先に (下に) 描かれなければならない。**

- 描くもの: 地 (色・画像・内側の影)、見える罫の各辺、`img`、SVG の図形 (線幅を含む)、疑似要素 (§3.4)、ほかの文字。祖先の平らな地 (色) は定義で下 (CSS 2.1 付録 E の段 1) で、文字の地そのものなので除く。**祖先の罫・地の画像・内側の影は除かない** (V4、§3.2)。**祖先の `outline` も除かない** (内容より後に描かれる)。
- 上に描かれれば、色・アルファに依らず `OVERLAP_PAINT_ABOVE_PROTECTED` / `OVERLAP_PAINT_ABOVE_TEXT`。
- **ほかの文字が届けば、順に依らず `OVERLAP_PROTECTED_TEXT_ON_TEXT` / `OVERLAP_TEXT_ON_TEXT`。** 下に敷いた巨大な語も落ちる (字形が混ざって読みが変わる)。**同じ要素の中の別の文字の節も比べる** (Fresh Review M1: `<p>000-0000-0712<span class="k"></span>1111</p>` で `.k { display: inline-block; margin-left: -120px }` とすると、1111 が事実の 0-00 の上に描かれる。最初の版は同じ要素の節を比べず、幾何も画素も何も出さなかった)。
- **順を証明できないものは落とす:** 当たり判定に出ない描き方 (外側の `box-shadow`、`outline`、`filter` のにじみ (`blur` は 3r、`drop-shadow` はずれ + 3r、ほかの移す関数は無限)、`-webkit-box-reflect`) が字形に届く、または当たり判定の束に T が出ない (文字が自分の箱の外にあふれている) と `OVERLAP_PROTECTED_ORDER_UNPROVEN` / `OVERLAP_ORDER_UNPROVEN`。

### 3.2 V4: 守る文字

- **下にも入れない。** 守る字形の箱 (+1px) に届く装飾は、下に描かれていても `OVERLAP_PROTECTED_ON_DECORATION`。金の線が「1」の下を通れば「7」や「4」に読める (V3b と同じ理由)。
- **例外は板 (plate) だけ:** T か T の祖先 Q が不透明で平らな地 (色のアルファ 255、`background-image` なし) を持ち、Q の padding box が届いた字形の箱 (+1px) をすべて含み、Q を含む原子的な箱 A (Q かその祖先で、位置を持つ・重ねの文脈・flex/grid の項目・inline-block のどれか。P を含まない) が P より上に描かれること。このとき P は Q の地に隠れ、字形の下は平らになる (C′ の SP の「文字は地の帯に乗り、線はその下を通る」の型)。
- **祖先の罫・地の画像・内側の影も下の装飾として数える** (Fresh Review M2: 負の margin で事実を自分の箱の罫の上へ引くと、罫が数字の下を通る。最初の版は祖先を一律に除き、advisory の画素の平らさしか出さなかった)。祖先は定義で下に描かれるので、通るのは、その祖先の**内側の**要素の不透明で平らな板 (木の順で祖先の後に描かれる) が字形の箱を含むときだけ。普通の本文も `plate` の決まりなら同じ。
- **祖先のフィルター (`drop-shadow`・`blur`) も数える** (CI と再レビュー): 祖先の中の1つの子の影は、別の子の文字の下に落ちる (つぐ手 C′ の板の `drop-shadow` が、写真の影を自分の札の下へ落とす)。フィルターの描く範囲は「箱 + にじみ」の全体 (最初の版は箱の外の輪だけ)。当たり判定に出ないので `ORDER_UNPROVEN` (fail closed)。提案の文法は `filter` を入れないので、C′ にだけ関わる。
- **文字自身の要素のフィルターも同じ** (3回目の再レビュー M1): `<div class="board"><div class="photo"></div>000-0000-0712</div>` で板に `drop-shadow` があると、写真の影は板自身の文字の下に落ちる。文字自身の要素は地も罫も定義で下なので飛ばしていたが、描く子を持つ要素のフィルターだけは `ORDER_UNPROVEN` にする。
- **文字そのものの画素を変えるフィルター** (`drop-shadow` 以外: `blur`・`opacity()`・`brightness()`・`contrast()` …) が文字自身の要素か祖先 (`body`・`html`・SVG の祖先も含む) にあれば、`OVERLAP_PROTECTED_TEXT_FILTERED` / `OVERLAP_TEXT_FILTERED` (3回目の再レビュー L1。画素の参照はフィルターを外さないので、画素の側からは見えない)。計算値の一番外の関数の名前だけを読む (`drop-shadow(rgba(…) …)` の中の `rgba(` は数えない)。4回目の再レビューの前は、その `rgba(` を関数と読んで `drop-shadow` だけでも `TEXT_FILTERED` を出し、`body`・`html`・SVG の祖先を飛ばしていた (`body { filter: opacity(0.1) }` が通った)。
- **切れ・ずれ:** 守る字形が画面の左・右・上の外 (`OVERLAP_PROTECTED_OFFSCREEN`)、`overflow` が見える以外の祖先の padding box の外、または `clip-path`・`mask` の祖先の下 (`OVERLAP_PROTECTED_CLIPPED`)、字形の箱が無い (`OVERLAP_PROTECTED_HIDDEN`)。**普通の本文の切れも落とす** (`OVERLAP_TEXT_CLIPPED`。Fresh Review L3: 提案の文法はどの要素にも `overflow: hidden | clip` を許すので、普通の本文が黙って切れうる)。

### 3.3 普通の本文

- V2 はそのまま掛かる (上から覆えば落ちる)。
- 下に装飾を敷くことは、試作では2つの決まりを持つ (`ordinary: "plate" | "allow"`)。**提案の既定は `plate` (守る文字と同じく板が要る)**: `OVERLAP_TEXT_ON_DECORATION`。`allow` (板なしで下に敷いてよい) にするには、文字の下の合成のコントラスト (V5) と地の賑やかさの門 (V3b の `GROUND_TOO_BUSY`) が要り、それは今の run に無い (段 B の判断シートの §6 と同じ穴)。オーナーの判断 (§12)。

### 3.4 重ねの文脈・isolation・ブレンド・不透明度・pointer-events・aria-hidden

- **重ねの文脈:** 検査はモデルを持たず、**Chromium の当たり判定の順** (`document.elementsFromPoint`) を描画の順の答えとして読む。当たり判定は付録 E の段 (前景・浮動・ブロックの地) を逆順にたどるので、原子的な描画 (flex・grid の項目、inline-block)、位置を持つ子孫の脱出、`order` で変わる順、`opacity` < 1 や `transform` の作る文脈の z 0 の層、`isolation` で閉じた群の中の `z-index: -1` (群ごと上なら上) を、すべてそのまま反映する。試作の例 (§6) で、それぞれ描いた画素と一致することを確かめた。
- **順は点に依らない:** 2つの要素の描く順は要素の順で、点ごとには変わらない。だから組 (T, P) ごとに、P がある最初の点で一度だけ決める。変わるのは「P がどこに描くか」だけで、SVG の図形は `isPointInFill`・`isPointInStroke`、回した箱は逆行列で先に調べ、ある点でだけ当たり判定を呼ぶ (費用は §4)。
- **`isolation: isolate`:** 色も形も変えず、文脈を閉じるだけ。`z-index: -1` を「群の地より上、群の中の文字より下」に置くために要る。群そのものが文字の上にあれば群ごと上 (罠の例 §6)。
- **`mix-blend-mode`・`backdrop-filter`:** 箱として順を裁く (上なら落ちる)。下なら文字が上に描かれるので影響しない。文法には入れない。
- **不透明度:** `opacity` < 1 の要素は z 0 の層で、普通の文字の上に描かれる (例 §6)。順は当たり判定で同じく裁く。文字の側の不透明度の積 ≥ 0.85 (`MIN_OPACITY`) は今のまま。
- **`pointer-events`:** 当たり判定から要素を消すので、検査はページの全要素に `pointer-events: auto !important` を掛けてから判定する (使い捨てのページ)。今の run の 15 点の当たり判定は `pointer-events: none` の覆いを見逃す (§6)。文法には入れない (装飾がリンクの上に来るなら `OVERLAP_LINK_COVERED`)。
- **`aria-hidden`:** 描かれるものは描かれる。`aria-hidden` の文字は文字として V2 の「文字の上の文字」に数え、装飾の扱いにしない (run の `TEXT_ARIA_HIDDEN` も今のまま)。
- **疑似要素:** 使い捨てのページで、生成された `::before`・`::after` をその計算後のスタイルを持つ本物の `span` に置き換え (`MATERIALIZE_SCRIPT`)、ふつうの要素として裁く。`content` が文字列でない (カウンター・`attr()`・`url()`) ものは `OVERLAP_PSEUDO_UNPROVEN`。置き換えた箱が Chromium の描く場所と 1px 以内で一致することを、絶対位置と流れの中の2例で確かめた。提案の文法は疑似要素を入れないので、本番ではこれは二重の守りである。

### 3.5 文法の役割 (描画で検める)

- 位置を流れの外にする (`absolute`・`fixed`・`sticky`)、`transform`、`z-index` < 0 の要素は、文字・`aria-label`・`alt` を持たない: `OVERLAP_LAYER_HAS_TEXT`。
- 文字を持つ要素の `position: relative` は、オフセットが 0 のとき (持ち上げ) だけ。
- 負の margin はどの要素にも許す (流れの中で箱を動かし、文字も一緒に動く)。届いた先は V2・V4 が裁き、画面の外は `OVERLAP_PROTECTED_OFFSCREEN` と run の `TEXT_OFFSCREEN` が落とす。

### 3.6 fail closed のまとめ

| 状況 | コード |
|---|---|
| 当たり判定に出ない描き方が字形に届く | `…ORDER_UNPROVEN` |
| 当たり判定の束に文字が出ない | `…ORDER_UNPROVEN` |
| 点が画面の外で当たり判定できない | `…ORDER_UNPROVEN` |
| 疑似要素の `content` が文字列でない | `OVERLAP_PSEUDO_UNPROVEN` |
| 画素の三つの絵の大きさが違う | `PIXEL_UNMEASURED` |
| 測れなかった幅 (本番の掃引) | `PHASE_B_UNMEASURED` と同じ数え方 (`unmeasuredWidths`) を使う (§8) |

## 4. 測り方の比較

| 方法 | 見るもの | 費用 (手元、Chromium 1194) | 見逃し |
|---|---|---|---|
| **A. 字形の箱 × 描く範囲 (幾何)** — 墨の箱 (§2) と、要素の描く範囲の交わり | 届くかどうか | 1幅 10〜15 ms (層のページ、温まった後)、C′ 300〜400 ms | 順を知らない (上か下かが分からない)。単独では「届けば落とす」しかできず、板も下の層も通せない |
| **B. 当たり判定 (`elementsFromPoint`)** — A の交わりの中で順を読む | 描く順 | 組ごとに1回 (P がある最初の点)。層のページで1幅 0〜5 回、C′ で 30〜1,100 回 | 外側の影・輪郭線・フィルターのにじみ・文字の影は当たり判定に出ない (→ fail closed)。`pointer-events` は強制で外す。自分の箱の外へあふれた文字は束に出ない (→ fail closed) |
| **C. 画素 (飾りを消した差)** — 文字を黒と白で2回描き、ページと「文字だけ」の参照の差の比 (透過率) を見る。合成は線形なので、地に依らず「文字の上に描かれたもの」だけが比を下げる | 墨の上に描かれたものの濃さ | 全ページの画面写し 5 枚 (層のページで 1幅 約 1〜2 s) | 3% 未満の覆い (丸めの余地 0.97)、墨の無い画素 (字の中の空き) の上の覆い、文字の上の文字 (両方が同じ色で変わる)。守る文字の空きは「文字を消した絵の平らさ」(V3b、`groundStructure`) で補う。**字形の箱の中しか読まない** (箱が墨より小さいと見えない → 全画面の `PIXEL_INK_OUTSIDE_GLYPHS` で補う、§2.3)。全部の文字を一度に色を変えるので、ある文字の箱に別の文字の墨が入ると、その覆いがこの文字のものに見える → 覆いの候補はその文字だけ色を変えた4枚 (箱の周りの切り抜き) で確かめ直す。参照の絵でもフィルターは外さない (外すとフィルターの層の中の文字の描かれ方が変わり、覆いに見える)。そのぶん文字の画素を変えるフィルターは画素からは見えず、幾何の `TEXT_FILTERED` (文字自身から `html` までのすべての祖先) が受け持つ。単独で確かめて自分の覆いでなかった候補は、確かめられた別の文字の箱と重ならなければ `PIXEL_COVER_UNATTRIBUTED` (誰のものでもない覆い、fail closed) |

**提案: A で候補を絞り、B で順を決める (幾何の検査、1px の全幅)。C は確かめる幅だけの二重の守り。**

- B は今の run の 15 点の当たり判定 (`GEOMETRY_SCRIPT` の `_COVERED`) とは違う: 字形と描くものの交わりの全体から点を取り (箱は 2px、細い・回した・SVG は 1px の間隔)、最上位の1つでなく束全体で T と P の順を比べ、`pointer-events` を外し、描くもの (地・罫・SVG の図形) でない当たり (空の箱の中) は数えない。
- C だけでは、V2 の言う「色やアルファに依らず落とす」は守れない (2% の覆いが通る)。B だけでは、測ったモデルが Chromium とずれたときに気づけない。C は B の答えを Chromium の画素で照らす役でもある (§6 の表で、C が見えるものはすべて B と一致)。
- 全幅の費用: 層のページの 1px の掃引 (1,601 幅) は 1 ページ 約 30〜70 秒 (根の幅を動かす方式と本物の大きさの変更で同じ答え)。C′ は 1 ページ 約 5〜13 分 (図形と組が多い。本物の大きさの変更)。本番は層の数に予算 (V7) を置く前提である。

## 5. 提案の文法: `layered_decoration` (旗 `layeredDecoration`、既定 OFF)

旗が立ったときだけ、今の許可一覧に次を足す (試作: `layeredDecl`・`layeredCssProblems`)。旗が無ければ今の文法そのまま (テストで、店の 9 つの CSS と 70 を超える宣言で一致)。

| 性質 | 値 |
|---|---|
| `position` | `static`・`relative`・`absolute` (`fixed`・`sticky` は不可) |
| `top`・`right`・`bottom`・`left` | `auto`・px・rem・% (±2400px・±100%)。`calc()`・vw・vh は不可 |
| `inset` | 上の値を 1〜4 個 |
| `z-index` | `auto`、整数 −1〜9 |
| `isolation` | `auto`・`isolate` |
| `transform` | `none`、`rotate(<±45deg>)`・`translate()`・`translateX()`・`translateY()` を 3 つまで。`scale`・`skew`・`matrix`・`perspective`・3D は不可。`translate`/`rotate`/`scale` の個別の性質も不可 |
| `transform-origin` | 方向の語・px・rem・% を 2 つまで |
| `margin`・`margin-*` | 負の値を −400px まで (今の文法は 0 以上) |
| `overflow`・`overflow-x`・`overflow-y` | `visible`・`hidden`・`clip` |

**入れないもの:** 疑似要素 (`CSS_PSEUDO_ELEMENT` のまま)、`pointer-events`、`mix-blend-mode`、`clip-path`・`mask`、`filter`・`backdrop-filter`、`outline`、外側の `box-shadow`、`text-shadow`、`-webkit-text-stroke`、`will-change`、`contain`、ビューポートの単位、グリッドの線の番号と重ねの区域 (`magazine_grid` として別の能力: 読みの順 V9 が要る)、SVG と `aria-hidden` の文字。

**描画のコード (段 C の検査。旗が立ったときに止める):**

| コード | 意味 |
|---|---|
| `OVERLAP_PAINT_ABOVE_PROTECTED` / `OVERLAP_PAINT_ABOVE_TEXT` | 字形の上に描くものがある |
| `OVERLAP_PROTECTED_TEXT_ON_TEXT` / `OVERLAP_TEXT_ON_TEXT` | 字形に別の文字が届く (順を問わない) |
| `OVERLAP_PROTECTED_ON_DECORATION` / `OVERLAP_TEXT_ON_DECORATION` | 字形の下に装飾があり、板が無い |
| `OVERLAP_PROTECTED_ORDER_UNPROVEN` / `OVERLAP_ORDER_UNPROVEN` | 順を証明できない (fail closed) |
| `OVERLAP_PROTECTED_CLIPPED`・`_OFFSCREEN`・`_HIDDEN` | 守る文字が切れる・画面の外・描かれない |
| `OVERLAP_TEXT_CLIPPED` | 普通の本文が `overflow`・`clip-path` の祖先で切れる |
| `OVERLAP_PSEUDO_UNPROVEN` | 測れない疑似要素 |
| `OVERLAP_PROTECTED_GLYPHS_UNMEASURED` / `OVERLAP_GLYPHS_UNMEASURED`、`OVERLAP_MARKER_UNMEASURED` | 墨の箱を測れない字形・印 (§2.3) |
| `PIXEL_INK_OUTSIDE_GLYPHS` | 字形の箱の外に文字の墨がある (確かめる幅、止める側) |
| `OVERLAP_PROTECTED_TEXT_FILTERED` / `OVERLAP_TEXT_FILTERED` | 文字自身か祖先のフィルターが文字の画素を変える |
| `PIXEL_COVER_UNATTRIBUTED` | 画素の覆いが、単独で確かめたどの文字のものでもない |
| `OVERLAP_LAYER_HAS_TEXT` | 層の要素が文字を持つ、文字の箱が動く |
| `OVERLAP_LINK_COVERED` | リンクの真ん中が覆われる |
| `PIXEL_COVER_PROTECTED` / `PIXEL_COVER_TEXT` | 画素の二重の守り (確かめる幅、止める側) |
| `PIXEL_PROTECTED_GROUND_NOT_FLAT` | 守る字形の下の平らさ (確かめる幅、**advisory**。strict B の輪が出す: §6) |

## 6. 試作が証明したこと

テスト: `tests/unit/design-agent/comp-impl/phase-c-overlap.test.ts`。道具: `overlap-harness.ts`。描画は Chromium 1194、JS 無効、通信遮断、deviceScaleFactor 1。

**落ちるべき例 (48。最初の 27 に、Fresh Review で 5、CI と2回目の再レビューで 5、3回目の再レビューで 4、4回目の再レビューで 2、DEV-175 の4回目と5回目の再レビューで 3、DEV-178 で 2 を足した。画素の列はこの容器の書体での結果で、`tabular-nums` の例は書体に依る: Inter と数字の機能の無い CI では画素は覆いを見ない。テストは、書体が本当に数字を広げるとき (`tabular-nums` の有無で "1111" の幅を測って広くなるとき) は `PIXEL_COVER_PROTECTED` も求め、そうでなければ幾何の fail closed だけを求める)。** 「試作」は幾何と順の検査、「画素」は §4 の C、「今の V2」は `LAYER_SCRIPT` の覆いの数 / 守る文字への非 content の重なりの数、「今の当たり判定」は `GEOMETRY_SCRIPT` (どれも生の HTML に掛けたもの。本番では許可一覧が先に拒む)。

| 例 | 試作 | 画素 (この容器の書体) | 今の V2 (覆い / 非 content) | 今の当たり判定 |
|---|---|---|---|---|
| z-index: a 5% cover | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED |
| z-index: a 2% cover (under the pixel bound) | `PAINT_ABOVE_PROTECTED` | — | 1/1 | FACT_COVERED |
| negative margin: a positioned card pulled up over the fact | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/0 | FACT_COVERED |
| transform: a translated empty block (a stacking context over in-flow text) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED |
| absolute sibling, z-index auto | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED |
| pseudo-element: a 3% veil (::after, inset 0) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED` | 0/0 | — |
| pseudo-element: a solid bar (::before) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 0/0 | — |
| outline spreading from a far box | `PROTECTED_ORDER_UNPROVEN` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | — |
| box-shadow spreading from a far box | `PROTECTED_ORDER_UNPROVEN` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | — |
| drop-shadow filter reaching the fact | `PROTECTED_ORDER_UNPROVEN` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | — |
| text over text: ordinary text lifted over the fact | `PROTECTED_TEXT_ON_TEXT` | `GROUND_NOT_FLAT` | 0/0 | FACT_COVERED |
| text under text: an aria-hidden ghost word below the fact | `PROTECTED_TEXT_ON_TEXT` | `GROUND_NOT_FLAT` | 0/0 | — |
| a 1px line across the digits, above | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | — |
| a 1px line across the digits, below (z-index -1, isolated) | `PROTECTED_ON_DECORATION` | `GROUND_NOT_FLAT` | 0/1 | — |
| an SVG stroke across the fact | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 0/2 | — |
| clipped: an overflow box cuts the fact | `PROTECTED_CLIPPED` | — | 0/0 | FACT_OUT_OF_BOX |
| clipped: clip-path on an ancestor | `PROTECTED_CLIPPED` | — | 0/0 | — |
| off screen: pulled left by a negative margin | `PROTECTED_OFFSCREEN` | — | 0/0 | FACT_OFFSCREEN |
| mix-blend-mode: difference over the fact | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED |
| pointer-events: none on the cover (hit-testing would skip it) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | — |
| isolation trap: z-index -1 inside an isolated group that is itself above | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/2 | FACT_COVERED |
| opacity: an earlier translucent sibling pulled under the text paints above it | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED |
| atomic painting: a later flex item over an earlier item's overflowing text | `PROTECTED_ORDER_UNPROVEN` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED,FACT_OUT_OF_BOX |
| atomic painting: a later flex item pulled back over an earlier item's text | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED |
| grid stacking: a later item on the same cell | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 1/1 | FACT_COVERED |
| text over text inside one element: a later run pulled back over the fact | `PROTECTED_TEXT_ON_TEXT` | — | 0/0 | — |
| an ancestor's top border under the fact (negative margin) | `PROTECTED_ON_DECORATION` | `GROUND_NOT_FLAT` | 0/0 | — |
| an ancestor's left border under the fact (negative margin) | `PROTECTED_ON_DECORATION` | `GROUND_NOT_FLAT` | 0/0 | — |
| an ancestor's gradient ground under the fact | `PROTECTED_ON_DECORATION` | — | 0/0 | — |
| ordinary text clipped by an overflow box | `TEXT_CLIPPED` | — | 0/0 | — |
| an ancestor's drop-shadow under the fact (a photo's shadow on its own caption) | `PROTECTED_ORDER_UNPROVEN` | `GROUND_NOT_FLAT` | 0/0 | — |
| tabular figures (font-variant-numeric) drawn wider than measured | `PAINT_ABOVE_PROTECTED`, `PROTECTED_GLYPHS_UNMEASURED` | `PIXEL_COVER_PROTECTED`, `PIXEL_INK_OUTSIDE_GLYPHS`, `GROUND_NOT_FLAT` | 1/1 | — |
| a combining mark (NFD) above its base | `PROTECTED_GLYPHS_UNMEASURED` | — | 0/0 | — |
| an underline (text-decoration) drawn outside the glyphs | `PROTECTED_GLYPHS_UNMEASURED` | `PIXEL_INK_OUTSIDE_GLYPHS` | 0/0 | — |
| a list marker (text the walker does not see) | `MARKER_UNMEASURED` | `PIXEL_INK_OUTSIDE_GLYPHS` | 0/0 | — |
| the text's own element's drop-shadow (a child's shadow under the element's own text) | `PROTECTED_ORDER_UNPROVEN` | `GROUND_NOT_FLAT` | 0/0 | — |
| an ancestor's filter: opacity(0.15) fades the fact | `PROTECTED_TEXT_FILTERED` | — | 0/0 | — |
| an ancestor's filter: brightness(0) blackens the fact | `PROTECTED_TEXT_FILTERED` | — | 0/0 | — |
| body's filter: opacity(0.1) fades the fact | `PROTECTED_TEXT_FILTERED` | — | 0/0 | — |
| html's filter: brightness(0) blackens the fact | `PROTECTED_TEXT_FILTERED` | — | 0/0 | — |
| small caps (font-variant-caps) drawn otherwise than measured | `PROTECTED_GLYPHS_UNMEASURED` | — | 0/0 | — |
| a fact split over elements: its last digits (a span) covered (DEV-175 で足した) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED` | — | — |
| a fact split over flex items: its last digits covered (DEV-175) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED` | — | — |
| a fact split over two blocks: the second block covered (DEV-175) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED` | — | — |
| a fact written with hyphens U+2010: its last digits (a span) covered (DEV-178) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 2/0 | — |
| a fact in full-width digits: the line covered (DEV-178) | `PAINT_ABOVE_PROTECTED` | `PIXEL_COVER_PROTECTED`, `GROUND_NOT_FLAT` | 2/0 | — |
| ordinary text covered | `PAINT_ABOVE_TEXT` | `PIXEL_COVER_TEXT` | 1/0 | — |
| ordinary text over a decoration with no plate | `TEXT_ON_DECORATION` | — | 0/0 | — |

- **今の当たり判定が見逃すもの:** 1px の線、疑似要素、SVG の線、`pointer-events: none` の覆い、輪郭線・影・`drop-shadow`、下に敷いた文字、下を通る線。**今の V2 のモデルが見ないもの:** 疑似要素 (別に `PSEUDO_GEOMETRY_UNKNOWN` で止める)、SVG の図形 (箱の地が無いので覆いに数えない)、文字の上の文字 (`overprinted` の担当)。段 C ではこの2つを、そのままの形では使えない。
- **画素の見逃し:** 2% の覆い、文字の上の文字、切れ・画面の外 (別の検査の担当)、板の無い普通の本文の下の線。下を通る線と下の文字は「文字を消した絵の平らさ」で見える。**照らし合わせは文字ごと:** 画素が覆いを見た文字のそれぞれについて、幾何がその**同じ文字**に覆いを意味するコード (上に描く・順を証明できない・文字の上の文字) を出したことを確かめる (`pixelPass` の `disagreements` が空)。合成の例と、3店の strict・層の版・C′ (1440・768・390) のすべてで食い違い 0。
- **(訂正) 最初の版の「3店で矛盾 0」は空の証明だった** (Fresh Review M3): C′ のどこかに `ORDER_UNPROVEN` があれば通る作りで、C′ はどの幅にもそれがあった (例: 輪の 768 は画素が `PIXEL_COVER_PROTECTED` で、幾何は `*_ORDER_UNPROVEN` と `TEXT_ON_DECORATION` だけ)。オーナーの判断 3 (§12) の証拠としては、文字ごとの照らし合わせ (上) だけを使う。
- **CI で文字ごとの照らし合わせが落ちた (head 2d43cc3):** つぐ手 C′ の 1440 で、写真の札3つを画素が覆いと見て、幾何は何も出さなかった。札は板の `drop-shadow` の層の中の唯一の文字で、(1) 幾何は祖先のフィルターを数えていなかった (写真の影は札の下に本当に落ちる。本物の見逃し)、(2) 画素の参照はフィルターを外していて、層の中と外で文字の描かれ方が変わりうる (誤検知の見立て)。両方を直した (§3.2・§4)。CI の失敗そのものは手元で再現できなかった (CI の書体の組を見せた fontconfig でも)。直した後、札はどの書体でも幾何が `ORDER_UNPROVEN` で名指すので、この食い違いは起きえない。
- **平らさの画素 (`PIXEL_PROTECTED_GROUND_NOT_FLAT`) は止める側に使えない:** 輪の strict B 自体が 1440・768・390 で出す (丸いハブの上の店名 輪、太い罫に近い文字)。run の V3b (`GROUND_NOT_FLAT`) が advisory のままである理由と同じ。段 C でも advisory とし、止めるのは幾何の V4 (`OVERLAP_PROTECTED_ON_DECORATION`) とする。

**通るべき例 (9):** 二つの段の間の溝を通る下の層の継ぎ目 / 文字から離れた上の装飾 / 守る文字の下の線を文字自身の不透明な板が隠す / 普通の本文の下の線を板が隠す / 画像の上だけの割れ目 / 箱は事実に届くが描く棒は届かない回した棒 / 箱は事実を覆うが線は避ける SVG の曲線 / 空いた所にだけ重なる負の margin の札 / `allow` のときの普通の本文の下の線。すべて幾何でも画素でもコード 0。

**板の正確さ (8 例):** 不透明な板は通り、90% の白・`linear-gradient` の板・持ち上げない板 (z 0 で線が上に来る)・字形 +1px を含まない板 (最初と最後の字に接する)・原子的でない箱の地 (後の流れのブロックを負の margin で引き上げると、事実の地と文字の間に描かれる)・持ち上げの無い事実自身の地 は落ちる。祖先の札が板になる例は通る。

**幅:** 1100〜1108px にだけ現れる覆いを、1px の掃引は 1100–1108 と正確に見つけ (根の幅を動かす方式と本物の大きさの変更の両方で)、確かめる幅 (1024・1280・1440) は見逃す。

## 7. 3店

ページ: strict B (つぐ手 `impl/d1-v2-b`、輪 `impl/d1-b`、ゆげ湯 `impl/d1-b`。viewport の meta と資産の配りは DEV-170〜172 の道具と同じ)、**layer** (strict B に、提案の文法だけで層を足した版。`overlap-harness.ts` の `LAYER_CSS`。足した要素は `aria-hidden` の空の `div` で、HTML の許可一覧をそのまま通る)、C′ (§1 の3ページ)。

### 7.1 layer の版の中身

- **つぐ手:** 3つの板の画像の上に金の割れ目を2本ずつ (回した細い箱、`z-index: 1`)。線の断面の3つの帯を縦に貫く継ぎ目 (上の区画から 40px はみ出す)。帯の文字は自分の帯の色の板 (`display: inline-block; position: relative; z-index: 2`) に乗り、継ぎ目はその下を通る。
- **輪:** ハブの下から暗い区画へ伸びる4本のスポーク (回した細い箱、区画は `isolation: isolate`・`overflow-x: clip`、見出しと札は `z-index: 2` に持ち上げ)。1360px 以上では長く。SP は札の左を下る1本。空気入れの計器は負の margin で上の区画の境にかかる。
- **ゆげ湯:** 全ページの左の溝を下る温度計の管 (`z-index: 1`、本文は `z-index: 2` に持ち上げ)。壁と夜の境にかかるのれん (切れ目3本)。熱い湯の区画の足に食い込む湯船の板 (負の margin と持ち上げ。札を持つ板そのものを動かす)。

### 7.2 結果

この容器の書体 (IPA) での値。**書体で変わるので、テストはこれらの数字を書かない** (§2.1)。layer と strict の列は墨の箱の版、C′ の 1px の列は最初の版 (1.3em の箱) で測った記録である (C′ の全幅の掃引は1ページ 5〜13 分で、直した後に全部は測り直していない。直した後にゆげ湯の 600–1000・1100–1300 を測り直した結果は下の注)。

| 店 | layer: 文法 (提案の旗) | layer: 1px の掃引 320〜1920 | strict: 1px の掃引 | C′: 確かめる幅 12 | C′: 1px の掃引 (最初の箱、道具の外、本物の大きさの変更) |
|---|---|---|---|---|---|
| つぐ手 | 問題 0 (旗なしは `CSS_PROPERTY`・`CSS_VALUE`) | `OVERLAP_PROTECTED_OFFSCREEN` 601–992 だけ (最初の箱では 601–995) | 同じ | すべての幅で落ちる | `PAINT_ABOVE_TEXT` 320–363・559・562–600・1200–1920、`PROTECTED_ON_DECORATION` 320–600、`ORDER_UNPROVEN`・`PROTECTED_ORDER_UNPROVEN`・`TEXT_ON_DECORATION` 全幅 (約 12 分) |
| 輪 | 問題 0 | `OVERLAP_PROTECTED_OFFSCREEN` 320–369・601–1125 だけ (最初の箱では 601–1129) | 同じ | すべての幅で落ちる | `PAINT_ABOVE_TEXT` 594–600・1111–1118・1124–1147・1217–1292、`TEXT_ON_TEXT` 1000–1920、`ORDER_UNPROVEN`・`PROTECTED_ORDER_UNPROVEN`・`TEXT_ON_DECORATION` 全幅 (約 13 分) |
| ゆげ湯 | 問題 0 | `OVERLAP_PROTECTED_OFFSCREEN` 601–969 だけ | 同じ | すべての幅で落ちる | **`PAINT_ABOVE_PROTECTED` 1260–1263**、~~`PROTECTED_TEXT_ON_TEXT` 861–885・1136–1159~~ (箱の誤り、下)、`TEXT_ON_TEXT` 601–681・1101–1150、`PAINT_ABOVE_TEXT`・`PROTECTED_ON_DECORATION`・`ORDER_UNPROVEN`・`TEXT_ON_DECORATION` 全幅 (約 5 分) |

- **墨の箱で測り直したゆげ湯の C′:** `PAINT_ABOVE_PROTECTED` は 1260–1262 (最初の箱で 1260–1263。CI では最初の箱で 1271–1275)。`PROTECTED_TEXT_ON_TEXT` は 600–1000・1100–1300 のどこにも出ない。`TEXT_ON_TEXT` 601–681 は残る。
- **strict にもともとある `OFFSCREEN`** は、strict B のタブレットの横のはみ出し (DEV-160 で知られた誤り) と輪の 320–369 である。層を足しても1幅も増えも減りもしない (テストで、層の版の 1,601 幅の全部が strict の範囲と一致することを固定。端は本物の大きさの変更で確かめた)。
- **層の版は、確かめる幅 12 のすべてで strict と同じコード**で、画素の二重の守り (1440・768・390) でも覆いは 0。
- 層の版の調整で検査が実際に止めたもの (作る途中で見つかった): 輪のスポークが巨大な語 まわる の下を通る (1200–1302、`OVERLAP_TEXT_ON_DECORATION`。長いスポークを 1360px 以上に)、ゆげ湯ののれんが 1024 で 手ぬぐいと石けんを貸し出しています (事実) の上に来る、390 で 湯上がりの、帰り道。の上に来る (`OVERLAP_PAINT_ABOVE_*`。のれんを短く)、つぐ手の割れ目が狭い幅で板の札に届く (`OVERLAP_PAINT_ABOVE_TEXT`。割れ目を短く)、線の断面の継ぎ目が 768 で帯の文字の下を通る (`OVERLAP_TEXT_ON_DECORATION`。文字に板を敷いた)。**層を足す作り手は、検査の答えを見て形を直すことになる**。

### 7.3 C′ で見つかったこと

- **確かめる幅の間にだけある守る文字の覆い (本物):** ゆげ湯の C′ は、湯の表面の板 (`board-surface`) が 1260–1263px でだけ 熱い湯と、ぬるい湯の二つの湯船があります (事実) の上に描かれる。C′ の CSS の注 (「1280–1300 で最後の す を覆っていた」) の直しが、覆う幅をずらしただけだった。幅は書体で動く (この容器 1260–1262、CI 1271–1275)。1261px の画面で、板の白い縁が す を切っているのを Claude が見た。確かめる幅 (1280・1024) では見えない。テストは数字を書かず、「1230〜1310 の窓の 1px の掃引で、40 幅以下の狭い帯に守る文字の覆いがあり、帯に確かめる幅が無く、確かめる幅 12 のどれもそれを出さない」ことを確かめる。
- **(訂正) 沸く・熱い の重なりは誤りだった。** 最初の報告の「沸く が 861–885px で 湯が沸くのは、開店の一時間前です に、熱い が 1136–1159px で説明文に重なる」は、墨より大きな最初の箱 (1.3em) のせいだった。墨の箱では出ず、870px の画面で 沸く の輪郭が事実の字から離れていることを Claude が見た。
- 全幅で出るものの大半は、(a) 板の `drop-shadow`・`box-shadow` が札や本文に届く (順を証明できない)、(b) 写真の仮の板の上の札・巨大な語・区画をまたぐ文字が、自分の祖先でない地 (別の区画・写真の板・残り火・湯気) の上にある、(c) SVG の線・湯気が巨大な語 (普通の本文として数える) の上に描かれる、である。(b) の「写真の上の札」は段 C の別の能力 `hero_overlay` (DEV-083 §3.1(a)、画像の解析のコントラスト) の範囲で、`layered_decoration` は扱わない。

### 7.4 比較画像 (Claude が見た)

リポジトリの外に置いた。**セッションの一時の場所なので、後から開けない。** SHA だけを残す。

- 場所: `/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/dev173/shots/` (一覧は `index.tsv`、並べた画像は `cmp-<店>-<1440|768|390>-full.png`: 左から strict B・layer・C′)
- ページ全体の画像の SHA-256 の先頭 8 桁 (PC 1440 / タブレット 768 / SP 390、JS 無効、deviceScaleFactor 1、外への要求 0):

| 店 | strict B | B + layered_decoration | C′ |
|---|---|---|---|
| つぐ手 | `5b4b8a6c` / `c8c02bcd` / `cfb9a2ce` | `1729b48d` / `f91ca102` / `1d4cd21c` | `df00b8c4` / `56eccf30` / `1aeb994d` |
| 輪 | `917d1561` / `a9fa55d3` / `da0e08a9` | `d32d56ff` / `84d12123` / `dbb1fe96` | `077843c1` / `fe330aae` / `950852a9` |
| ゆげ湯 | `4f14e5ba` / `edf64a65` / `9b14b356` | `7c5765a3` / `6110edf5` / `8d804f07` | `53308a0f` / `e92830da` / `8d33403a` |

strict B と C′ の SHA は DEV-171・DEV-172 の記録と同じだった。

**見て分かったこと (正直な判断):**

- **つぐ手:** strict はもともと1本の直線の継ぎ目が全ページを貫いている。layer で足したのは板の上の細い金の割れ目と、線の断面の帯を貫く継ぎ目で、**差は小さい**。C′ の主役 (器から破片を縫って走る曲がった継ぎ目、破片の形に切った板とその影、輪郭の 継ぐ・待つ) は、どれも曲線・`clip-path`・影・`-webkit-text-stroke` で、戻らない。
- **輪:** ハブから暗い区画へ伸びる黄色のスポークは、strict の「車輪の絵と暗い区画が別々」を少しつなぐ。計器が上の区画にかかるのは C′ にかなり近い。それでも C′ の「スポークの先に板が吊られる」構図 (vw の位置・SVG の線・回した板) にはならない。
- **ゆげ湯:** 熱い湯の区画に食い込む湯船の板は C′ と同じ構図になり、区画の境が硬い strict より読める。のれんは平たい箱で、C′ ののれん (布のひだ・竿・「ゆ」・影) には遠い。温度計の管は細い線として見えるが、strict の罫との差は小さい。
- **768・390:** 得と限界は PC と同じ。390 ではスポークを1本にしたので、輪の差はさらに小さい。
- **結論:** `layered_decoration` は「重ねてよい構図」を安全に開くが、**それ自体で C′ の質には近づかない**。曲線・形・影の装飾 (N1、段 D) と組み合わせて初めて見た目の得が出る。逆に、C′ の見た目のいくつか (湯気が 熱い を覆う、影が札を覆う、巨大な語が事実に重なる) は、提案の規則では**正しく拒まれる**。

## 8. lib の変更の概要 (HOLD: オーナーの承認まで merge しない)

この PR には入れない。段 C の実装の PR の下書きである。

1. `spec.ts`: `CAPABILITY_NAMES` に `"layered_decoration"`。`APPROVED_CAPABILITIES` は空のまま。`pageCssOptionsOf` が宣言と承認の両方で `layeredDecoration` を立てる。
2. `page-css.ts`: `PageCssOptions` に `layeredDecoration?: boolean`。旗のときだけ、§5 の表の項目を `PAGE_PROPS` の写しに足す (`position`・オフセット・`inset`・`z-index`・`isolation`・`transform`・`transform-origin`・負の margin・`overflow*`)。試作 `layeredDecl` と同じ範囲。旗なしの一致は、段 B と同じく大きな組み合わせで差 0 を確かめる (`phase-b-design.md` §8.9 のやり方)。
3. 新しい `lib/design-agent/comp-impl/overlap.ts`: `OVERLAP_SCRIPT`・`MATERIALIZE_SCRIPT` (試作をそのまま移し、zod の形を足す)、`overlapCodes`。画素の二重の守り (`pixelPass`) は `render.ts` の確かめる幅の道へ。
4. `layers.ts`: 旗のときだけ `STACKING_CONTEXT` の数え方を狭める: `position`・`z-index`・`transform`・`isolation` だけで作られた文脈は数えない (`translucentDecoration` の `benignTranslucent` と同じ形)。**その安全は §3 の検査が全幅で裁くことに依る。描画の門を狭める変更で、承認が要る。**
5. `render.ts`: 旗のとき、1px の掃引 (`displaySweepPass` と同じ段の分け方と `unmeasuredWidths`) で `OVERLAP_SCRIPT` を毎幅に掛ける。測れない幅は落とす。
6. `run.ts`: 結果を `checks.phase_c` として止める側へ。名前は書かない (`pageCssOptionsOf` だけ)。
7. `verify.ts`: 段 C のコードを止める側の一覧に。
8. テスト: この PR の `phase-c-overlap.test.ts` を、試作でなく本番の道を呼ぶ形に移す。`phase-b-baseline.test.ts` の「`PageCssOptions` の鍵」の固定を意図して直す。

## 9. 壊して確かめたこと (試作の変異)

試作の守りを1つずつ外して、`phase-c-overlap.test.ts` の合成の例・文法・今の門・墨の箱の組 (CI の2回目と再レビューの直しの後で 60 件) を走らせ、元に戻した (`overlap-harness.ts` の外は触らない)。数は「落ちたテスト / 走ったテスト」。**直しの後に全部を走らせ直した。**

| 外した守り | 落ちたテスト |
|---|---|
| M1 上に描くものを下と数える | 19 / 60 |
| M2 `pointer-events` を auto にしない | 1 / 60 |
| M3 板を問わない (下の装飾をすべて通す) | 3 / 60 |
| M4 守る字形の箱を 1px 広げない | 1 / 60 |
| M5 当たり判定に出ない描き方も当たり判定で裁く (fail closed をやめる) | 5 / 60 |
| M6 疑似要素を置き換えない | 3 / 60 |
| M7 文字の上の文字を見ない | 4 / 60 |
| M8 SVG の図形を「無い」と答える | 1 / 60 |
| M9 切れの検査を外す | 3 / 60 |
| M10 画面の外の検査を外す | 1 / 60 |
| M11 束に文字が無いとき「下」と数える | 1 / 60 |
| M12 重なりの余地 0.5px を 3px に | 7 / 60 |
| M13 どの祖先も原子的な箱と数える (板の持ち上げを問わない) | 1 / 60 |
| M14 画素の透過率の下限 0.97 を 0.9 に | 4 / 60 |
| M15 外側の影を数えない | 1 / 60 |
| M16 測れない疑似要素の `content` を落とさない | 1 / 60 |
| M17 同じ要素の文字の節どうしを比べない (Fresh Review M1 の戻し) | 1 / 60 |
| M18 祖先を下の描くものに数えない (M2 の戻し) | 4 / 60 |
| M19 普通の本文の切れを出さない (L3 の戻し) | 1 / 60 |
| M20 墨の箱を Range の箱に戻す | 1 / 60 |
| M21 祖先の下の描くものに、祖先の内側の板を求めない | 3 / 60 |
| M22 祖先のフィルターを数えない (CI の戻し) | 1 / 60 |
| M23 OpenType の機能・結合文字・線の飾りを fail closed にしない (再レビュー M1・L2 の戻し) | 3 / 60 |
| M24 全画面の墨のはみ出しの検査を外す | 1 / 60 |
| M25 縦の短い字の箱を測れないとしない | 1 / 60 |
| M26 リストの印を fail closed にしない | 1 / 60 |
| M27 文字自身の要素のフィルターを飛ばす (3回目の再レビュー M1 の戻し) | 31 / 64 |
| M28 文字の画素を変えるフィルターを fail closed にしない (L1 の戻し) | 2 / 64 |
| M29 単独で確かめられない画素の覆いを捨てる (L2 の戻し) | **0 / 64 (生き残る)** |
| M30 `font-variant-caps` を字形を変える性質に数えない (L6 の戻し) | 1 / 64 |

- M1〜M26 は2回目の再レビューの直しの後 (60 件の組)、M27〜M30 は3回目の直しの後 (64 件の組) に走らせた。30 のうち 29 が 1 件以上落ちる。
- **M29 は生き残る。** 「別の文字の墨が自分の箱の外にあり、それが覆われ、その墨がこの文字の箱に入る」例を、fail closed の決まり (§2.3) をすり抜ける形で作れなかった (作れる形は、先に `GLYPHS_UNMEASURED` か `PIXEL_INK_OUTSIDE_GLYPHS` で落ちる)。決まりは二重の守りとして残し、テストで証明していないことを記録する。
- 墨の箱に変えた後、M4 (守る文字の 1px) と M20 (墨の箱を Range の箱に戻す) が 0 件で生き残った。前者は「事実の墨の 1.3px 下の線は落ち、同じ線が普通の本文の下なら通る」、後者は「content area が 1.45em の書体で行送り 1 の2段落は重ならない」のテストを足して落ちるようにした。M13 は最初の版で生き残り、「原子的でない箱の地は板にならない」例を足した (前の報告)。
- 走らせ方: `scratchpad/dev173/scripts/mutate.py` (リポジトリの外)。1つごとに道具を元に戻し、終わりに `git status` で道具に差が無いことを確かめた。3店の組 (掃引) は時間のため変異では走らせていない。
- **DEV-178: 段 D の変異 M58・M59・M60 をこのテストでも走らせた。** 3つとも `FACT_NODES_JS` (このテストと段 D が共有する守る文字の照らし合わせ) を壊す。合成の例の組 (`-t "on synthetic probes"`、65 件) で、M58 (事実をブロックごとにしか照らさない) は 2 / 65、M59 (NFKD と書式文字の正規化をしない) は 1 / 65、M60 (紛らわしい字を寄せない) は 1 / 65 が落ちる。M59 と M60 を落とすために、全角の数字の例と U+2010 の例をこの組に足した (§6 の表の最後の2つの前)。走らせ方: `scratchpad/dev178/mutate.py` (`TARGET=c`)。

## 10. 証明していないこと

- **1920px より広い幅、320px より狭い幅、整数でない幅、900 以外の窓の高さ、拡大率・端末の画素比。** 位置の指定は高さで変わりうる (`%` の `top`、`bottom` 基準)。提案の文法は vh を拒むが、窓の高さで重なりが変わらないことは証明していない。
- **Chromium 1194 以外の描画系。** 順の答えは Chromium の当たり判定に頼る。WebKit・Firefox の当たり判定が描画の順と一致するかは見ていない。
- **当たり判定と描画の一致の網羅。** 例ごとに画素と照らしたが、付録 E の全段の組み合わせを機械的に網羅したわけではない (DEV-083 の V2 の 23 の例に相当する一覧は、本番の PR で要る)。
- **字形の箱の外の墨。** 1.3em に切った箱の外に出る墨 (大きな字の飛び出し、斜体) は見ない。
- **板の上の色。** 板は平らで不透明であることだけを見る。板と文字のコントラストは今の検査 (守る文字は `lowContrastShare`) に任せる。
- **普通の本文の下の装飾 (`allow`)。** 合成のコントラストと賑やかさの門が無い。
- **3店以外のページ、ほかの書体。** 書体で strict のページにもコードが出うる (§2.1・§2.2)。CI の書体では、この容器とはみ出しの範囲・C′ の覆う幅が違う (C′ のゆげ湯の板: この容器 1260–1263、CI 1271–1275)。
- **縦書きの墨。** 縦書きは Range の箱を 1.3em に切った箱のまま (書体の content area に引きずられる)。字の箱が短すぎる形だけを fail closed にする (§2.3)。
- **墨の箱の限り (§2.3) の網羅。** fail closed にした形のほかにも、canvas と DOM で字形が食い違う形 (書体の代わりの選び方の違い、`font-synthesis` の太字・斜体など) がありうる。全画面の `PIXEL_INK_OUTSIDE_GLYPHS` は確かめる幅だけ (1px の掃引には無い)。
- **今の本番の穴 (この PR の外、Fresh Review L2):** 今の許可一覧は `height`・`max-height` を `overflow: visible` のまま許す。`.box { height: 0 }` の中の普通の本文に、次の段落が重なって描かれる。run の層の検査 (`layerScan`) と 15 点の当たり判定 (`GEOMETRY_SCRIPT`) は何も出さない。この容器では文字の検査 (`textCheck` の重なり、`TEXT_OVERLAP`) が拾う (確かめる幅と 32px の掃引で。1px の掃引には無い)。事実なら `FACT_COVERED` も出る。テストで今の振る舞いを固定した (`a pre-existing gap …`)。普通の本文の重なりを 1px の全幅で見るかはオーナーの判断 (§12)。lib は変えていない。
- **C′ の 1px の掃引は道具の外の実行。** テストは確かめる幅と、ゆげ湯の 2 つの狭い範囲 (1250–1275・850–895) だけを固定する (全幅は1ページ 5〜13 分)。

## 11. 危険

- **順を Chromium に問う:** 検査がブラウザの当たり判定を信じる。当たり判定と描画が食い違う版が来れば、検査も食い違う。画素の二重の守り (確かめる幅) と、例の表の画素の照らし合わせを本番の CI に残すことで気づく。
- **組ごとに一度だけ順を決める:** 「順は点に依らない」を前提にしている。同じ要素の地と文字が別の段で描かれる (T 自身の地) のは、T 自身は描くものに数えないので影響しない。
- **板は描画の門を緩める方向の決まりである。** 板の判定 (不透明・平ら・+1px を含む・原子的な箱が上) を外すと、下の層が守る文字に届く (変異 M3)。
- **負の margin は文字の箱も動かす。** 届いた先は裁くが、読みの順 (V9) の意味の変化 (札が前の区画の中に見える) は裁かない。
- **費用:** C′ のように層の多いページは 1px の掃引が分単位になる。層の数の予算 (V7) が要る。

## 12. オーナーの判断が要ること

> **オーナーの判断が要る (未承認)**
>
> 1. `layered_decoration` を §5 の範囲で実装する PR (lib の変更、§8) に進むか。merge は改めて明示の承認の後。
> 2. `STACKING_CONTEXT` の止め方を、`position`・`z-index`・`transform`・`isolation` の文脈について狭めること (§8 の 4)。
> 3. 描画の順の答えを Chromium の当たり判定に頼る設計 (§3.4・§4) でよいか。代わりは `LAYER_SCRIPT` の付録 E のモデルを疑似要素・SVG・文字の上の文字へ広げること (費用は大きい)。
> 4. 普通の本文の下の装飾: 既定を `plate` (板が要る) にするか、合成のコントラストと賑やかさの門を作ってから `allow` にするか。
> 5. 守る文字の範囲 (§2): 店名の短い形・事実の文の一部まで広げてよいか。
> 6. 板の決まり (不透明・平ら・字形 +1px)。
> 7. §10 の証明していないもの (広い幅・高さ・拡大率・ほかの描画系) を ON の前に要るとするか。
> 8. 得が小さいこと (§0・§7): `layered_decoration` 単独でなく、N1 (装飾の SVG) と一緒に評価するか。
> 9. 字形の箱を墨の箱 (canvas の `measureText`) で測ること (§2)、文字が自分の要素の箱の外に描かれる所を `ORDER_UNPROVEN` で落とすこと (§2.2)。書体 (`web_font`) を固定しないまま ON にすると、strict のページでも書体次第でコードが出うる。
> 11. 墨の箱の限り (§2.3) を fail closed で扱うこと: OpenType の機能・結合文字・線の飾り・リストの印を使う文字は、段 C の旗のページで落ちる。下線のリンクなどを使うなら、墨を画素から測る方式 (費用が大きい) が要る。
> 10. 今の本番の穴 (§10、`height: 0` の箱の普通の本文の重ねが 1px の全幅で見られていない) を、段 C と別に塞ぐか。
>
> このシートは承認ではない。能力の ON・`APPROVED_CAPABILITIES` の変更・安全の門の変更は、別の承認まで HOLD のまま。
