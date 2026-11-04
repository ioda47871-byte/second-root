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
- **試作はこれを示した (§6):** 27 の落ちるべき例がすべて落ち、9 の通るべき例がすべて通る。今の run の当たり判定 (`GEOMETRY_SCRIPT` の 15 点) は、そのうち 1px の線・疑似要素・SVG・`pointer-events: none`・輪郭線・影・下に敷いた文字 を見逃す。今の V2 のモデル (`LAYER_SCRIPT`) は疑似要素・SVG・文字の上の文字を見ない。どちらも、今は許可一覧が先に拒むので穴ではないが、**段 C ではそのまま使えない**。
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

- **守る文字 (protected):** 免責 (`[data-comp-disclosure]`、研究のページでは `.fictional`)、`dt`・`dd`、`h1` (店名)、文字の全体が事実の値 (facts pack) を含むか、6 字以上で事実の値の一部である要素。run の `protectedOwner` (layers.ts) より広い (店名の短い形・事実の文の折り返しを含む)。
- **普通の本文 (ordinary):** それ以外のすべての文字の節。`aria-hidden` の文字も描かれるので数える (run は `TEXT_ARIA_HIDDEN` でそもそも拒む)。
- **字形の箱 (glyph box):** 文字ごとの Range の箱を、縦に字の大きさの 1.3 倍に切ったもの。Range の箱は書体の content area (Noto Sans CJK で 1.45em) で、行送り 1 の行どうしは墨が無いのに重なる。CJK の墨は 1em の中、ラテン文字の下がりは約 0.2em。守る文字は V4 でさらに 1px 広げる (V3b と同じ決まり)。

## 3. 規則

### 3.1 V2: 描画の順

**字形の箱 G (文字 T) に 0.5px を超えて届く、T の祖先でない「描くもの」P は、T より先に (下に) 描かれなければならない。**

- 描くもの: 地 (色・画像・内側の影)、見える罫の各辺、`img`、SVG の図形 (線幅を含む)、疑似要素 (§3.4)、ほかの文字。祖先の地と罫は定義で下 (CSS 2.1 付録 E の段 1) なので除く。**祖先の `outline` は除かない** (内容より後に描かれる)。
- 上に描かれれば、色・アルファに依らず `OVERLAP_PAINT_ABOVE_PROTECTED` / `OVERLAP_PAINT_ABOVE_TEXT`。
- **ほかの文字が届けば、順に依らず `OVERLAP_PROTECTED_TEXT_ON_TEXT` / `OVERLAP_TEXT_ON_TEXT`。** 下に敷いた巨大な語も落ちる (字形が混ざって読みが変わる)。
- **順を証明できないものは落とす:** 当たり判定に出ない描き方 (外側の `box-shadow`、`outline`、`filter` のにじみ (`blur` は 3r、`drop-shadow` はずれ + 3r、ほかの移す関数は無限)、`-webkit-box-reflect`) が字形に届く、または当たり判定の束に T が出ない (文字が自分の箱の外にあふれている) と `OVERLAP_PROTECTED_ORDER_UNPROVEN` / `OVERLAP_ORDER_UNPROVEN`。

### 3.2 V4: 守る文字

- **下にも入れない。** 守る字形の箱 (+1px) に届く装飾は、下に描かれていても `OVERLAP_PROTECTED_ON_DECORATION`。金の線が「1」の下を通れば「7」や「4」に読める (V3b と同じ理由)。
- **例外は板 (plate) だけ:** T か T の祖先 Q が不透明で平らな地 (色のアルファ 255、`background-image` なし) を持ち、Q の padding box が届いた字形の箱 (+1px) をすべて含み、Q を含む原子的な箱 A (Q かその祖先で、位置を持つ・重ねの文脈・flex/grid の項目・inline-block のどれか。P を含まない) が P より上に描かれること。このとき P は Q の地に隠れ、字形の下は平らになる (C′ の SP の「文字は地の帯に乗り、線はその下を通る」の型)。
- **切れ・ずれ:** 守る字形が画面の左・右・上の外 (`OVERLAP_PROTECTED_OFFSCREEN`)、`overflow` が見える以外の祖先の padding box の外、または `clip-path`・`mask` の祖先の下 (`OVERLAP_PROTECTED_CLIPPED`)、字形の箱が無い (`OVERLAP_PROTECTED_HIDDEN`)。

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
| **A. 字形の箱 × 描く範囲 (幾何)** — Range の箱と、要素の描く範囲の交わり | 届くかどうか | 1幅 10〜15 ms (層のページ、温まった後)、C′ 300〜400 ms | 順を知らない (上か下かが分からない)。単独では「届けば落とす」しかできず、板も下の層も通せない |
| **B. 当たり判定 (`elementsFromPoint`)** — A の交わりの中で順を読む | 描く順 | 組ごとに1回 (P がある最初の点)。層のページで1幅 0〜5 回、C′ で 30〜1,100 回 | 外側の影・輪郭線・フィルターのにじみ・文字の影は当たり判定に出ない (→ fail closed)。`pointer-events` は強制で外す。自分の箱の外へあふれた文字は束に出ない (→ fail closed) |
| **C. 画素 (飾りを消した差)** — 文字を黒と白で2回描き、ページと「文字だけ」の参照の差の比 (透過率) を見る。合成は線形なので、地に依らず「文字の上に描かれたもの」だけが比を下げる | 墨の上に描かれたものの濃さ | 全ページの画面写し 5 枚 (層のページで 1幅 約 1〜2 s) | 3% 未満の覆い (丸めの余地 0.97)、墨の無い画素 (字の中の空き) の上の覆い、文字の上の文字 (両方が同じ色で変わる)。守る文字の空きは「文字を消した絵の平らさ」(V3b、`groundStructure`) で補う |

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
| `OVERLAP_PSEUDO_UNPROVEN` | 測れない疑似要素 |
| `OVERLAP_LAYER_HAS_TEXT` | 層の要素が文字を持つ、文字の箱が動く |
| `OVERLAP_LINK_COVERED` | リンクの真ん中が覆われる |
| `PIXEL_COVER_PROTECTED` / `PIXEL_COVER_TEXT` | 画素の二重の守り (確かめる幅、止める側) |
| `PIXEL_PROTECTED_GROUND_NOT_FLAT` | 守る字形の下の平らさ (確かめる幅、**advisory**。strict B の輪が出す: §6) |

## 6. 試作が証明したこと

テスト: `tests/unit/design-agent/comp-impl/phase-c-overlap.test.ts`。道具: `overlap-harness.ts`。描画は Chromium 1194、JS 無効、通信遮断、deviceScaleFactor 1。

**落ちるべき例 (27)。** 「試作」は幾何と順の検査、「画素」は §4 の C、「今の V2」は `LAYER_SCRIPT` の覆いの数 / 守る文字への非 content の重なりの数、「今の当たり判定」は `GEOMETRY_SCRIPT` (どれも生の HTML に掛けたもの。本番では許可一覧が先に拒む)。

| 例 | 試作 | 画素 | 今の V2 (覆い / 非 content) | 今の当たり判定 |
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
| ordinary text covered | `PAINT_ABOVE_TEXT` | `PIXEL_COVER_TEXT` | 1/0 | — |
| ordinary text over a decoration with no plate | `TEXT_ON_DECORATION` | — | 0/0 | — |

- **今の当たり判定が見逃すもの:** 1px の線、疑似要素、SVG の線、`pointer-events: none` の覆い、輪郭線・影・`drop-shadow`、下に敷いた文字、下を通る線。**今の V2 のモデルが見ないもの:** 疑似要素 (別に `PSEUDO_GEOMETRY_UNKNOWN` で止める)、SVG の図形 (箱の地が無いので覆いに数えない)、文字の上の文字 (`overprinted` の担当)。段 C ではこの2つを、そのままの形では使えない。
- **画素の見逃し:** 2% の覆い、文字の上の文字、切れ・画面の外 (別の検査の担当)、板の無い普通の本文の下の線。下を通る線と下の文字は「文字を消した絵の平らさ」で見える。画素が覆いを見たすべての例で、試作の幾何も落とした (矛盾 0)。3店でも、C′ の画素の覆い (`PIXEL_COVER_*`、1440・768・390) が出たすべての幅で、幾何が上に描く・順を証明できない・文字の上の文字のどれかを出した。
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

| 店 | layer: 文法 (提案の旗) | layer: 1px の掃引 320〜1920 | strict: 1px の掃引 | C′: 確かめる幅 12 | C′: 1px の掃引 (道具の外、本物の大きさの変更) |
|---|---|---|---|---|---|
| つぐ手 | 問題 0 (旗なしは `CSS_PROPERTY`・`CSS_VALUE`) | `OVERLAP_PROTECTED_OFFSCREEN` 601–995 だけ | 同じ | すべての幅で落ちる | `PAINT_ABOVE_TEXT` 320–363・559・562–600・1200–1920、`PROTECTED_ON_DECORATION` 320–600、`ORDER_UNPROVEN`・`PROTECTED_ORDER_UNPROVEN`・`TEXT_ON_DECORATION` 全幅 (約 12 分) |
| 輪 | 問題 0 | `OVERLAP_PROTECTED_OFFSCREEN` 320–369・601–1129 だけ | 同じ | すべての幅で落ちる | `PAINT_ABOVE_TEXT` 594–600・1111–1118・1124–1147・1217–1292、`TEXT_ON_TEXT` 1000–1920、`ORDER_UNPROVEN`・`PROTECTED_ORDER_UNPROVEN`・`TEXT_ON_DECORATION` 全幅 (約 13 分) |
| ゆげ湯 | 問題 0 | `OVERLAP_PROTECTED_OFFSCREEN` 601–969 だけ | 同じ | すべての幅で落ちる | **`PAINT_ABOVE_PROTECTED` 1260–1263**、**`PROTECTED_TEXT_ON_TEXT` 861–885・1136–1159**、`TEXT_ON_TEXT` 601–681・1101–1150、`PAINT_ABOVE_TEXT`・`PROTECTED_ON_DECORATION`・`ORDER_UNPROVEN`・`TEXT_ON_DECORATION` 全幅 (約 5 分) |

- **strict にもともとある `OFFSCREEN`** は、strict B のタブレットの横のはみ出し (DEV-160 で知られた誤り) と輪の 320–369 である。層を足しても1幅も増えも減りもしない (テストで、層の版の 1,601 幅の全部が strict の範囲と一致することを固定。端は本物の大きさの変更で確かめた)。
- **層の版は、確かめる幅 12 のすべてで strict と同じコード**で、画素の二重の守り (1440・768・390) でも覆いは 0。
- 層の版の調整で検査が実際に止めたもの (作る途中で見つかった): 輪のスポークが巨大な語 まわる の下を通る (1200–1302、`OVERLAP_TEXT_ON_DECORATION`。長いスポークを 1360px 以上に)、ゆげ湯ののれんが 1024 で 手ぬぐいと石けんを貸し出しています (事実) の上に来る、390 で 湯上がりの、帰り道。の上に来る (`OVERLAP_PAINT_ABOVE_*`。のれんを短く)、つぐ手の割れ目が狭い幅で板の札に届く (`OVERLAP_PAINT_ABOVE_TEXT`。割れ目を短く)、線の断面の継ぎ目が 768 で帯の文字の下を通る (`OVERLAP_TEXT_ON_DECORATION`。文字に板を敷いた)。**層を足す作り手は、検査の答えを見て形を直すことになる**。

### 7.3 C′ で見つかったこと

- **確かめる幅の間にだけある守る文字の覆い (本物):** ゆげ湯の C′ は、湯の表面の板 (`board-surface`) が 1260–1263px でだけ 熱い湯と、ぬるい湯の二つの湯船があります (事実) の上に描かれる。C′ の CSS の注 (「1280–1300 で最後の す を覆っていた」) の直しが、覆う幅を 1260–1263 にずらしただけだった。確かめる幅 (1280・1024) では見えない。同じく巨大な語 沸く が 861–885px で 湯が沸くのは、開店の一時間前です (事実) に、熱い が 1136–1159px で説明文に重なる。テストで、1px の掃引がこの範囲を正確に見つけ、確かめる幅 12 のどれもが見逃すことを固定した。
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

試作の守りを1つずつ外して、`phase-c-overlap.test.ts` の合成の例・文法・今の門の組を走らせ、元に戻した (`overlap-harness.ts` の外は触らない)。数は「落ちたテスト / 走ったテスト」。

| 外した守り | 落ちたテスト |
|---|---|
| M1 上に描くものを下と数える | 18 / 47 |
| M2 `pointer-events` を auto にしない | 1 / 47 |
| M3 板を問わない (下の装飾をすべて通す) | 3 / 47 |
| M4 守る字形の箱を 1px 広げない | 1 / 47 |
| M5 当たり判定に出ない描き方も当たり判定で裁く (fail closed をやめる) | 4 / 47 |
| M6 疑似要素を置き換えない | 3 / 47 |
| M7 文字の上の文字を見ない | 2 / 47 |
| M8 SVG の図形を「無い」と答える | 1 / 47 |
| M9 切れの検査を外す | 2 / 47 |
| M10 画面の外の検査を外す | 1 / 47 |
| M11 束に文字が無いとき「下」と数える | 1 / 47 |
| M12 重なりの余地 0.5px を 3px に | 4 / 47 |
| M13 どの祖先も原子的な箱と数える (板の持ち上げを問わない) | 1 / 47 |
| M14 画素の透過率の下限 0.97 を 0.9 に | 4 / 47 |
| M15 外側の影を数えない | 1 / 47 |
| M16 測れない疑似要素の `content` を落とさない | 1 / 47 |

- 16 のうち 16 が 1 件以上落ちる。M13 は最初 0 件で生き残った (板の祖先が原子的でない例が無かった)。「原子的でない箱の不透明な地は板にならない」例 (後の流れのブロックを負の margin で引き上げ、事実の地と文字の間に描く) を足し、落ちるようにした。
- 走らせ方: `scratchpad/dev173/scripts/mutate.py` (リポジトリの外)。`overlap-harness.ts` の1か所を書き換え、`phase-c-overlap.test.ts` の合成の例・文法・今の門の組 (47 件) を走らせ、元に戻す。終わりに `git status` で道具に差が無いことを確かめた。3店の組 (掃引) は時間のため変異では走らせていない。

## 10. 証明していないこと

- **1920px より広い幅、320px より狭い幅、整数でない幅、900 以外の窓の高さ、拡大率・端末の画素比。** 位置の指定は高さで変わりうる (`%` の `top`、`bottom` 基準)。提案の文法は vh を拒むが、窓の高さで重なりが変わらないことは証明していない。
- **Chromium 1194 以外の描画系。** 順の答えは Chromium の当たり判定に頼る。WebKit・Firefox の当たり判定が描画の順と一致するかは見ていない。
- **当たり判定と描画の一致の網羅。** 例ごとに画素と照らしたが、付録 E の全段の組み合わせを機械的に網羅したわけではない (DEV-083 の V2 の 23 の例に相当する一覧は、本番の PR で要る)。
- **字形の箱の外の墨。** 1.3em に切った箱の外に出る墨 (大きな字の飛び出し、斜体) は見ない。
- **板の上の色。** 板は平らで不透明であることだけを見る。板と文字のコントラストは今の検査 (守る文字は `lowContrastShare`) に任せる。
- **普通の本文の下の装飾 (`allow`)。** 合成のコントラストと賑やかさの門が無い。
- **3店以外のページ、ほかの書体。**
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
>
> このシートは承認ではない。能力の ON・`APPROVED_CAPABILITIES` の変更・安全の門の変更は、別の承認まで HOLD のまま。
