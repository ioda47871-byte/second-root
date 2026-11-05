# layered_decoration の承認資料 (DEV-180、Issue #193 コメント `6654178698` B.5)

2026-11-05。**承認の記録ではない。能力は OFF のまま。** 段 C の能力 `layered_decoration` (区画の境をまたぐ板・計器・線) について、ON の前に何が要るかの資料である。

- `layered_decoration` は今は能力の名前の一覧 (`CAPABILITY_NAMES`) にも無い。本番の検査は試作 (`tests/unit/design-agent/comp-impl/overlap-harness.ts`) にしかない。
- この branch は `lib/**` を変えていない。**本番の差分は作っていない** (§3 の理由)。
- 土台: `docs/design/phase-c-design.md` (DEV-173 の設計と試作)。

## 1. 安全の未解決点

| # | 未解決点 | 状態 |
|---|---|---|
| U1 | **見逃しの点検 (オーナーの指示): 1px の線・疑似要素・SVG、守る事実以外の普通の本文への重なり。** DEV-173 の試作の例は、これらの形を主に守る事実 (電話番号) に対して確かめていた。普通の本文には「箱で覆う」と「板の無い下の線」の2つしか無かった | **この branch で格子を作って確かめた (§2)。試作の見逃しを3つ見つけて塞いだ** |
| U2 | 今の本番の当たり判定 (`GEOMETRY_SCRIPT` の 15 点) と V2 のモデル (`LAYER_SCRIPT`) は、1px の線・疑似要素・SVG・`pointer-events: none`・影・下に敷いた文字を見ない (DEV-173 §6) | 今は許可一覧が先に拒むので穴ではない。**ON には試作 (`OVERLAP_SCRIPT`) を本番へ移すことが要る** (§3) |
| U3 | 今の本番の穴: `height: 0` の箱の中の普通の本文に次の段落が重なって描かれても、層の検査と 15 点の当たり判定は何も出さない (`textCheck` の `TEXT_OVERLAP` だけが確かめる幅と 32px の掃引で拾う。1px の掃引には無い) | 試作は1px の掃引でその幅だけを `OVERLAP_TEXT_ON_TEXT` で名指す (§2.3)。本番は未修正 (段 C と別の判断、phase-c §12 の 10) |
| U4 | 描画の順を Chromium の当たり判定 (`elementsFromPoint`) に頼る設計 | 例ごとに画素と照らしただけ。付録 E の全段の網羅は無い |
| U5 | `STACKING_CONTEXT` の止め方を狭める (位置・`z-index`・`transform`・`isolation` で作る文脈は数えない) | **描画の門を狭める変更で、承認が要る** |
| U6 | 墨の箱の限り (OpenType の機能・結合文字・下線・リストの印は fail closed で落ちる)、書体への依存 | 記録だけ |
| U7 | 1px の掃引の費用 (層の多いページで 1 ページ 分単位) と層の数の予算 (V7) | 設計だけ |

## 2. 修正 (この branch、テストの道具だけ。守りを足すだけ)

### 2.1 格子: 細い・生成された・SVG の描き方 × 守る事実と普通の本文 × 上と下

`tests/unit/design-agent/comp-impl/phase-c-reach.test.ts` (108 件 緑)。26 の描き方を、守る事実 (`000-0000-0712`) と普通の段落 (`線の引き方を相談します`) のそれぞれに、上 (`z-index: 1`) と下 (`isolation` の中の `z-index: -1`) から当てた 104 の例が、すべて期待のコードで落ちる。どの例も、画素の検査が覆いを見た文字は幾何も同じ文字を名指す (`pixelPass` の食い違い 0)。

| 描き方 | 上 (事実 / 普通の本文) | 下 (事実 / 普通の本文) |
|---|---|---|
| 1px の横線・縦線、0.6px の線 (小数の位置)、30deg に回した 1px の線、高さ 0 の箱の 1px の上の罫、1px の破線の罫 | `PAINT_ABOVE_PROTECTED` / `PAINT_ABOVE_TEXT` | `PROTECTED_ON_DECORATION` / `TEXT_ON_DECORATION` |
| `::before` の 1px の線、`::after` の 1px の枠だけの箱 | 同上 | 同上 |
| `::before` の生成された字 (`※`) | `PROTECTED_TEXT_ON_TEXT` / `TEXT_ON_TEXT` | 同じ (順を問わない) |
| SVG: 1px の線、0.5px の髪の毛の線、破線の 1px の線、塗った `rect`、`pattern` の塗り、`use`、viewBox の外の線 (`overflow: visible`)、四角い線端、viewBox で 4 倍に拡大した線 | `PAINT_ABOVE_*` | `*_ON_DECORATION` |
| **SVG の留め (miter) の角が、線幅の半分だけ広げた箱の外へ出る** (DEV-180 で塞いだ) | `PAINT_ABOVE_*` | `*_ON_DECORATION` |
| **SVG のマーカー (`marker-end`) が線の端の先に描かれる**、**線も塗りも無い道のマーカー**、**1点だけの道 (大きさ 0) の `marker-start`** (DEV-180 で fail closed。後の2つはレビュー M1) | `*_ORDER_UNPROVEN` | `*_ORDER_UNPROVEN` |
| SVG のフィルター (`feOffset`) で図形をずらす | `*_ORDER_UNPROVEN` | `*_ORDER_UNPROVEN` |
| SVG の `text`、`foreignObject` の中の文字 | `*_TEXT_ON_TEXT` | `*_TEXT_ON_TEXT` |
| 画像 (`img`) | `PAINT_ABOVE_*` | `*_ON_DECORATION` |

**届かないものは通る (4 例):** 2行の間の行間を通る 1px の線、両方の下を通る SVG の髪の毛の線、左を通る `::before` の線、角が文字の手前で止まる留めの線 (広げた箱は文字に届くが、`isPointInStroke` で線が無いと分かる)。幾何でも画素でもコード 0。

### 2.2 試作の見逃し3つ (見つけて塞いだ)

`overlap-harness.ts` に守りを足した (外した守りは無い)。

| 見逃し | 何が起きたか | 直し |
|---|---|---|
| SVG の留めの角 | 描く範囲を「図形の箱 + 線幅の半分 + 1px」とした。鋭い角では留めの先が `miterlimit × 半分` まで伸びる。6px の線の角が 9.5px 伸びて事実の最初の 0 に触れ、画素は覆いを見て幾何は何も出さなかった (食い違い 1) | 箱を `半分 × max(miterlimit, √2) + 1` 広げる (丸・面取りの角は √2)。届くかは今どおり `isPointInStroke` が確かめるので、届かない線は通る (§2.1 の最後の例) |
| SVG のマーカー | マーカーは図形の箱の外に描かれ、`isPointInStroke`・`isPointInFill` にも出ない。14px のマーカーが事実を覆っても幾何は何も出さなかった | `marker-start`・`-mid`・`-end` のどれかが計算値にある SVG の要素は fail closed (描く範囲を測れない: `ORDER_UNPROVEN`)。**最初の直しは、この確かめを「線も塗りも無い図形」と「大きさ 0 の箱」を飛ばす2つの `continue` の後に置いていたので、`stroke="none" fill="none"` の道のマーカーと、1点の道 (`M44 33 L44 33`) の `marker-start` が事実を覆っても幾何は `[]` だった (画素は `PIXEL_COVER_PROTECTED`。独立のレビューの M1)。** 確かめをそれらの前に移し、2つの形を格子に足した |
| `::first-letter`・`::first-line` | 墨の箱は要素の書体で `measureText` するので、80px の頭文字が次の行に重なっても幾何は何も出さなかった (確かめる幅の画素だけが `PIXEL_INK_OUTSIDE_GLYPHS` を出す。1px の掃引には画素が無い) | `::before`・`::after` (置き換えて測る) と `::marker` (`MARKER_UNMEASURED`) のほかの疑似要素を名指す規則が、どのシートのどの深さ (`@media`・入れ子) にあっても `OVERLAP_PSEUDO_UNPROVEN` |

どれも、提案の文法は SVG・疑似要素を入れない (`CSS_PSEUDO_ELEMENT`・`HTML_ELEMENT`) ので、本番に移したときは二重の守りである。それでも、描画の検査が単独で正しいことを ON の前提にしているので塞いだ。

### 2.3 普通の本文に普通の本文が重なる (U3)

1100〜1108px だけ `height: 0` になる箱の中の段落に次の段落が重なるページで、試作の1px の掃引 (1090〜1120、本物の大きさの変更) は **1100〜1108 の9幅だけ** を `OVERLAP_TEXT_ON_TEXT` で名指す。

### 2.4 既存の試作のテスト

`phase-c-overlap.test.ts` (DEV-173 の 74 件) を、守りを足した後の道具で走らせ直した (結果は `.ai/reviews/DEV-180.md`)。3店の strict・層の版・C′ の答えが変わらないことを確かめた。

### 2.5 壊して確かめたこと (変異)

`phase-c-reach.test.ts` に対し、試作の守りを1つずつ外して走らせ、元に戻した (`scratchpad/dev180/scripts/mutate.py`)。結果の表は `.ai/reviews/DEV-180.md`。

## 3. 必要な本番の差分 (作っていない)

`phase-c-design.md` §8 の下書きのとおりで、**大きい**:

1. `spec.ts`: `CAPABILITY_NAMES` に `layered_decoration`、`pageCssOptionsOf` で `layeredDecoration`。
2. `page-css.ts`: 旗のときだけ §5 の性質 (`position`・オフセット・`inset`・`z-index`・`isolation`・`transform`・`transform-origin`・負の margin・`overflow`)。
3. 新しい `overlap.ts`: `OVERLAP_SCRIPT`・`MATERIALIZE_SCRIPT` (試作 約 600 行の page script) と zod の形、`overlapCodes`。画素の二重の守り (`pixelPass`) を `render.ts` の確かめる幅へ。
4. `layers.ts`: 旗のときだけ `STACKING_CONTEXT` を狭める (**描画の門を狭める。承認が要る**)。
5. `render.ts`・`run.ts`・`verify.ts`: 1px の掃引で毎幅 `OVERLAP_SCRIPT`、止める側のコード。
6. テストを試作から本番の道へ移す。

gradient_ground の差分 (§ `capability-approval-gradient-ground.md` §3、数十行の置き換え) と比べて、新しい page script・描画の門の変更・run の道の変更を含む。この branch では作らなかった。

## 4. 実際の店の画面での改善 (前後の画像)

旗 OFF = strict B。旗 ON = DEV-173 の層の版 (提案の文法の中、テストの中だけで描いた)。層の版の CSS は旗なしで `CSS_PROPERTY`・`CSS_VALUE`、旗ありで問題 0。試作の検査は 1440・390 でコード 0、768 では strict と同じ既知のタブレットのはみ出し (`OVERLAP_PROTECTED_OFFSCREEN`、DEV-160) だけ (`index.tsv`)。

場所: `/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/dev180/shots/`

| 店 | 全体 (1440 / 768 / 390) | 部分 |
|---|---|---|
| つぐ手 | `ba-ld-tsugute-{1440,768,390}-full.png` | `ba-ld-tsugute-*-cut.png` (線の断面を貫く継ぎ目)、`-board.png` (板の上の金の割れ目) |
| 輪 | `ba-ld-bicycle-{1440,768,390}-full.png` | `ba-ld-bicycle-*-spokes.png` (ハブから下の区画へ伸びるスポーク)、`-lesson.png` (区画の上の縁にかかる空気入れの計器) |
| ゆげ湯 | `ba-ld-sento-{1440,768,390}-full.png` | `ba-ld-sento-*-night.png` (壁と夜の境にかかるのれん)、`-warm.png` (熱い湯の区画に食い込む湯船の板) |

**見て分かったこと (Claude が見た):**

- **構図は変わる。** 輪のスポークがハブから暗い区画へ降り、空気入れの計器が区画の境に掛かる。ゆげ湯ののれんが夜の区画の上の縁に掛かり、湯船の板が上の区画へ食い込む。つぐ手の継ぎ目が3つの帯を縦に貫く。区画が積み重なっただけの strict より、区画どうしがつながって見える。
- **ただし得は小さい** (DEV-173 §0 と同じ見立て)。線は直線、板は四角で、C′ の曲がった継ぎ目・破片の形・湯気・輪郭の巨大な語は戻らない。それらは SVG (N1) と段 D が要る。
- 層を足しても、事実や本文に何も重ならない (試作の検査も、Claude の目でも)。
- 768 のはみ出しは strict と同じで、層のせいではない。
- 仮写真のページなので `placeholder_limited`。

## 5. CI とレビュー

| 項目 | 状態 |
|---|---|
| 研究の branch の CI | **未実行** (push 済み、PR は親が開く) |
| Fresh Review | **未実施** |
| 手元のテスト | `phase-c-reach.test.ts` 108 件 緑、`phase-c-overlap.test.ts` (道具の変更の後) は `.ai/reviews/DEV-180.md` |
| 本番の差分 | **無い** (§3) |

## 6. 未検証の環境

- **WebKit・Firefox:** 未検証。順の答えは Chromium の当たり判定に頼る。ほかの描画系の当たり判定と描画の一致は見ていない。**来訪者の描画系では検査していない。**
- **実機:** 未検証 (端末の画素比、拡大率、文字の大きさの設定、タッチの当たり)。
- 1920 より広い・320 より狭い・小数の幅、窓の高さ (位置は高さで変わりうる)。
- 3店以外のページ、ほかの書体 (CI の書体の組での `phase-c-reach.test.ts` は `DEV-180.md` を見る)。

## 7. 残る BLOCKED

| # | 項目 |
|---|---|
| B1 | オーナーの明示の承認 (能力の新設と ON、`STACKING_CONTEXT` を狭めること) |
| B2 | 本番の差分そのもの (§3): 試作の page script を本番へ移す PR、その CI と Fresh Review |
| B3 | 当たり判定と描画の一致の網羅 (付録 E の段の組み合わせの一覧と画素の照らし合わせ、phase-c §10) |
| B4 | WebKit・Firefox・実機 |
| B5 | 普通の本文の下の装飾の既定 (`plate`) と、`allow` にするなら合成のコントラストと賑やかさの門 |
| B6 | 層の数の予算 (V7) と掃引の費用 |
| B7 | 得の評価を N1 (装飾の SVG) と一緒にするか (phase-c §12 の 8) |

## 8. 最初に ON を求める能力: gradient_ground (推奨、承認ではない)

**gradient_ground を先にする。** 理由:

1. **ON の前に必須とされた穴が、小さな本番の差分で塞がる。** M1 は `PAINT_SCANNER` の1か所の置き換え (守りを足すだけ) と承認の一覧の1行で、候補と本番の差分が同じ文字列であることをテストで固定した。layered_decoration は新しい page script (約 600 行)・描画の門を狭める変更・run の道の変更が要り、その本番の差分はまだ無い。
2. **文字の安全の作りが単純。** gradient_ground は「文字を持つ箱・文字に重なる箱には地を置かない」を全幅で落とすだけで、コントラストも描画の順も問わない。layered_decoration は描画の順を Chromium の当たり判定に頼り、その網羅 (B3) が無い。
3. **画面での得がはっきりしている。** ゆげ湯の火の目盛りの帯は、PC・タブレット・SP のどれでも、4段の箱から滑らかな帯になる (§ gradient-ground の §4)。layered_decoration の得は構図の小さな変化で、C′ の形の多くは SVG と段 D が無いと戻らない。
4. **巻き戻しが簡単。** `APPROVED_CAPABILITIES` から名前を外せば元に戻る。宣言しないページは何も変わらない。

残るもの: gradient_ground の §7 の B1〜B7 (特にオーナーの承認、CI と Fresh Review、WebKit・Firefox・実機、`colour_syntax` を一緒に ON にしないこと)。layered_decoration は B1〜B7 のすべてが残り、本番の差分の PR から始まる。
