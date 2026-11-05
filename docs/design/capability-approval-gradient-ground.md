# gradient_ground の承認資料 (DEV-180、Issue #193 コメント `6654178698` B.5)

2026-11-05。**承認の記録ではない。能力は OFF のまま。** オーナーが「ON にするか」を決めるための資料である。

- 研究の branch (`feature/dev-180-capability-readiness`) は `lib/**`・`app/**`・`package.json`・lockfile・workflow を変えていない。`APPROVED_CAPABILITIES` は空のまま。
- 本番の差分は別の branch `feature/dev-180-prod-gradient-ground` に置いた (§3)。**draft のまま、オーナーの明示の承認まで merge しない。**
- 土台: `docs/design/gradient-ground-decision.md` (DEV-172 の判断シート)。このページはその続きで、DEV-172 が「ON の前に必須」とした M1 の穴を塞いだ記録と、ON に要るものの一覧である。

## 1. 安全の未解決点 (DEV-172 の時点)

| # | 未解決点 | 文字の安全か | DEV-172 の扱い |
|---|---|---|---|
| U1 | **測る箱の穴 (Fresh Review M1)。** 止めの規則は枠の箱 (`getBoundingClientRect`) で線の長さを測るが、Chromium はグラデーションを内側の箱 (padding box) の大きさで描き、枠の下には `repeat` で繰り返す。行をまたぐインラインは断片ごとに描く。文法を通り走査が `[]` のまま、1px あたり 96〜252 段の跳びが描ける | いいえ (滑らかさの約束) | 今の振る舞いとしてテストで固定。**HOLD、ON の前に必須** (判断シート §10 の 6) |
| U2 | oklch・oklab の止めは oklab で補間され、規則 (sRGB の端どうし) が見ない急な変化が描ける | いいえ | `colour_syntax` を一緒に ON にするときだけ。直していない |
| U3 | つぐ手の器の地は書体で通る・落ちる (CI の書体では大きな文字の行の箱が器に届き `GROUND_UNDER_TEXT`) | 文字の側に倒れて落ちる (fail closed) | 記録だけ |
| U4 | 地の色をカンプの palette と照らす検査が無い (`paletteCheck` は止めの色を読まない) | いいえ (文字は地に載らない) | 記録だけ |
| U5 | 未検証の環境: 1920 より広い・320 より狭い・小数の幅、拡大率、WebKit・Firefox、実機 | 一部 | 記録だけ |

## 2. 修正 (この branch、テストの道具だけ)

### 2.1 U1 (M1) の直し方: 「内側の箱で測る + 測れない描き方は落とす」

判断シート §3.3 の2案 ((a) 枠を許さない / (b) 内側の箱と断片ごとに測る) を合わせた形にした。(a) をそのまま採るとつぐ手の器 (2px の不透明な実線の枠) が落ちるので、**不透明な実線の枠だけ**を許す。その枠は、枠の下に繰り返されたグラデーションを上から塗りつぶすからである。

候補の検査 (`tests/unit/design-agent/comp-impl/gradient-box-harness.ts`) は、本番の `PAINT_SCANNER` に**1か所の文字列の置き換え**を当てたものである。本番の差分 (§3) はこの置き換えと同じ文字列になる。置き換えは守りを足す。落ちていたページを通すのは**1つの形だけ**である (DEV-180 のレビュー L1): グラデーションの向きに内側の箱の長さが無い地 (例: `height: 0` に不透明な実線の上下の枠)。今の規則は枠の箱で測って `GRADIENT_TOO_STEEP` を出しうるが、置き換えの後は線の長さが 0 で、止めの規則は `[]` を返す。内側の箱が空で枠が不透明なので、グラデーションの画素は1つも描かれない (テストで、箱のすべての画素が枠の黒であることを固定した)。それ以外は、通っていたページを落とすことはあっても、落ちていたページを通さない:

1. 止めの規則を **内側の箱** (枠の箱から枠の幅を引いた箱) で測る。内側の箱は枠の箱より長くならないので、規則は今と同じか厳しい。
2. 幅のある枠の辺がどれか1つでも `solid` でない、または不透明でない (アルファ < 255) → `GRADIENT_PAINT_BOX`。
3. 地の要素の `display` が、地を1つの箱として描く型 (`block`・`flow-root`・`inline-block`・`flex`・`inline-flex`・`grid`・`inline-grid`・`list-item`・`inline`) でない、または `getClientRects()` が1つでない (行をまたいだインライン) → `GRADIENT_PAINT_BOX`。
4. 文字との重なり (`GROUND_HAS_TEXT`・`GROUND_UNDER_TEXT`) は今のまま、枠の箱 (描く範囲の外側) で見る。

検査は1px の掃引 (`DISPLAY_SWEEP_SCRIPT`) の中でも同じ置き換えで動くので、計算値の枠 (`1em` が 256px になる形も) と折れ方を、320〜1920 のすべての幅で見る。

### 2.2 証明したこと (`tests/unit/design-agent/comp-impl/gradient-paint-box.test.ts`、19 件 緑)

「描いた絵」は内側の箱の中を 1px ごとに見た隣り合う画素の差 (段/px)、枠の帯が一色か、断片の数。**10 の再現のうち、内側の箱の差が 3 段/px を超えるのは 5 つ (4・4・9・134・4) だけで、5 つは 3 段/px で、枠の帯に繰り返しが見えること (帯が一色でない) で穴を示す。** DEV-172 の 96〜252 段/px (M1-1〜3) は、枠の帯の中の繰り返しの継ぎ目をまたいだ縦の1列の値で、この表の内側の箱の測り方には入らない。

| 例 (どれも旗ありの文法を通る) | 今の本番 (置き換えの前) | 候補 | 描いた絵 |
|---|---|---|---|
| M1-1 上下 16px の透明な枠、`#202020→#848484` | `[]` | `GRADIENT_PAINT_BOX`・`GRADIENT_TOO_STEEP` | 内側 4 段/px、帯に繰り返し (帯が一色でない) |
| M1-2 黒→白 100px + 透明な枠 | `[]` | `GRADIENT_PAINT_BOX`・`GRADIENT_TOO_STEEP` | 内側 4 段/px、帯に繰り返し (DEV-172 の測り方で継ぎ目 252 段) |
| M1-3 256px の字の中の `1em` の枠 | `[]` | `GRADIENT_PAINT_BOX`・`GRADIENT_TOO_STEEP` | 内側 9 段/px、帯に約 17 回の繰り返し |
| M1-4 3行に折れる空のインライン | `[]` | `GRADIENT_PAINT_BOX` | 断片 3、断片の境で 134 段/px |
| 左だけ 16px の透明な枠 (横向き) | `[]` | `GRADIENT_PAINT_BOX` | 内側 3 段/px、帯に繰り返し |
| 不透明な破線・点線・二重線の枠 | `[]` | `GRADIENT_PAINT_BOX` | 内側 3 段/px、隙間に繰り返し |
| 半透明の実線の枠 | `[]` | `GRADIENT_PAINT_BOX` | 内側 3 段/px、枠の下に繰り返しが透ける |
| 不透明な実線の枠 (上下 16px)、`#202020→#848484`、内側 30px | `[]` | `GRADIENT_TOO_STEEP` | 帯は一色 (繰り返しは隠れる)、内側 30px で 4 段/px (規則は 62px と見ていた) |
| 45% 幅の段落の中のインラインの地 (幅で折れる) | `[]` (全幅) | 折れる幅 (この容器で 320〜533) **だけ** `GRADIENT_PAINT_BOX` | 独立に数えた `getClientRects().length > 1` の幅と完全一致 |
| `td`・`display: contents` の地 (生の HTML) | — | `GRADIENT_PAINT_BOX` (fail closed) | — |

- **通るものは描いたとおり:** 48 の種から作った箱 (枠の型 7・色 4・幅 5・辺 4・向き 2・インライン 20%) で、候補が通した 13 のすべてで、内側の箱の隣り合う画素の差が 3 段以下、枠の帯はどれも一色、断片は1つ。候補が `GRADIENT_PAINT_BOX` で落としたのは 33。
- **枠の無い地は、本番と同じ答え** (DEV-172 の端の例 7 つ: 128/127px、45deg、radial、9.9% の硬い止め、1行のインライン)。
- **3店で何も増えない:** 確かめる幅 12 × 3店 × strict・grad・grad_eased で候補 = 本番。1px の掃引 320〜1920 (本物の大きさの変更) で、ゆげ湯 grad (本番どおり火の管の `GRADIENT_TOO_STEEP`)・grad_eased・つぐ手 grad の全幅で候補 = 本番、`GRADIENT_PAINT_BOX` は 0。つぐ手の器の 2px の実線の枠は不透明なので通る。
- **置き換えは足すだけ:** テストで、置き換えの前の行がすべて置き換えの後に残ること、置き換えを戻すと本番の `PHASE_B_SCRIPT`・`DISPLAY_SWEEP_SCRIPT` とバイト単位で同じになることを固定した。

### 2.3 壊して確かめたこと (変異)

候補の守りを1つずつ外し、`gradient-paint-box.test.ts` (3店の掃引を除く 16 件) を走らせ、元に戻した。走らせ方: `scratchpad/dev180/scripts/mutate.py` (リポジトリの外)。

| 外した守り | 落ちたテスト |
|---|---|
| G1 どの枠も許す | 9 / 16 |
| G2 断片の数を見ない | 3 / 16 |
| G3 `display` の型を見ない | 1 / 16 |
| G4 枠の箱で測る (今の本番) | 5 / 16 |

### 2.4 U2〜U5

- U2 (oklab) は **`colour_syntax` を ON にしない限り起きない。** gradient_ground だけを ON にすると、文法は `oklch()`・`oklab()`・名前の色を拒む (DEV-172 §3.1 の表)。この PR では直さない。`colour_syntax` を ON にする前に、止めに oklch・oklab を許さないか、補間の色空間で測る直しが要る (BLOCKED、別件)。
- U3 (書体) は fail closed の側に倒れる (CI の書体では器の地が拒まれる)。安全の穴ではないが、**つぐ手の器は CI と同じ書体の来訪者向けには ON でも描けない**。`web_font` (書体の固定) が入るまでは、器は書体しだいの得である。
- U4・U5 は直していない (§6)。

## 3. 本番の差分 (別の branch、draft、merge しない)

branch `feature/dev-180-prod-gradient-ground` (この研究の branch から切った)。2つの commit:

1. **門の強化 (能力は OFF のまま):** `lib/design-agent/comp-impl/phase-b.ts` の `PAINT_SCANNER` に §2.1 の置き換えを当て、`GRADIENT_CODES` に `GRADIENT_PAINT_BOX` を足す。`gradient-ground.test.ts` の「known gap before ON (Fresh Review M1)」を、4つの再現が候補どおり落ちることを求める形に強める。この commit だけでも本番の振る舞いは変わらない (旗は立たない)。
2. **能力の ON (オーナーの承認が要る):** `spec.ts` の `APPROVED_CAPABILITIES` を `["gradient_ground"]` に。`colour_syntax` は足さない。承認の一覧を固定しているテスト (「承認は空」) を、承認された一覧を求める形に、その commit の中で書き換える (消さない・skip しない)。

差分の大きさ・テストの結果は、その branch の `.ai/reviews/DEV-180-prod.md` と下の §5 に書いた。

## 4. 実際の店の画面での改善 (前後の画像)

旗 OFF = strict B (今の本番の文法で通るページ)。旗 ON = DEV-172 の `grad_eased` (ゆげ湯) / `grad` (つぐ手) を、テストの中だけで旗を立てて描いたもの。どちらも JS 無効・通信遮断・deviceScaleFactor 1・Chromium 1194・この容器の書体。旗 ON の各ページは、本番の検査も候補の検査も 1440・768・390 でコード 0 (`index.tsv`)。

画像はリポジトリの外 (セッションの一時の場所、後から開けない): `/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/dev180/shots/`

| 店・場所 | PC 1440 | タブレット 768 | SP 390 |
|---|---|---|---|
| ゆげ湯 全体 | `ba-gg-sento-1440-full.png` | `ba-gg-sento-768-full.png` | `ba-gg-sento-390-full.png` |
| ゆげ湯 火の区画 (目盛りの帯) | `ba-gg-sento-1440-fire.png` | `ba-gg-sento-768-fire.png` | `ba-gg-sento-390-fire.png` |
| ゆげ湯 熱い湯の区画 (温度計の管) | `ba-gg-sento-1440-hot.png` | `ba-gg-sento-768-hot.png` | `ba-gg-sento-390-hot.png` |
| つぐ手 hero (器) | `ba-gg-tsugute-1440-hero.png` | `ba-gg-tsugute-768-hero.png` | `ba-gg-tsugute-390-hero.png` |

SHA-256 の先頭 8 桁 (ページ全体、1440 / 768 / 390): ゆげ湯 strict `4f14e5ba` / `edf64a65` / `9b14b356`、grad_eased `6c0a098d` / `163cdd2a` / `93416509`。つぐ手 strict `5b4b8a6c` / `c8c02bcd` / `cfb9a2ce`、grad `83515152` / `dcdc0003` / `30c73484`。DEV-172 の記録と同じ。

**見て分かったこと (Claude が見た。オーナーの目視の記録ではない):**

- **ゆげ湯の火の目盛りの帯がいちばんはっきり良くなる。** 4段の色の箱が、炭から薄い黄への滑らかな帯になる。PC・タブレット・SP のどれでも同じ。帯の上に文字は無い。
- **ゆげ湯の温度計の管** は、区画ごとの単色の罫から、区画をまたいで色が下る1本の管になる。PC の全体の画像では細く (6px、SP は 4px)、得は火の帯より小さい。
- **つぐ手の器** は平たい板から下へ暗くなる釉の調子になり、丸みが出る。**ただし左右の2つの箱にそれぞれ 160deg のグラデーションを掛けるので、真ん中の金の線の左右で明るさが食い違う** (左の箱の右下が暗く、右の箱の左が明るい)。見た目の判断が要る。CI の書体では器は拒まれる (§2.4)。
- 輪は何も変わらない (C′ のグラデーションは文字を持つ写真の板の上だけ)。
- 768 のページ幅のはみ出し (strict の既知のタブレットの誤り、DEV-160) は旗に依らず残る。gradient_ground はそれを直さない。
- 仮写真のページなので `placeholder_limited`。成功例の水準は認定しない。

## 5. CI とレビュー

| 項目 | 状態 |
|---|---|
| 研究の branch の CI | **未実行** (push 済み、PR は親のセッションが開く) |
| 研究の branch の Fresh Review | **未実施** |
| 研究の branch の手元のテスト | `gradient-paint-box.test.ts` 19 件 緑、`gradient-ground.test.ts` 緑 (§記録は `.ai/reviews/DEV-180.md`) |
| 本番の branch の手元のテスト | `.ai/reviews/DEV-180-prod.md` (その branch) と `.ai/reviews/DEV-180.md` |
| 本番の branch の CI・Fresh Review | **未実行・未実施** (draft PR は親が開く。merge しない) |

## 6. 未検証の環境

- **WebKit・Firefox:** 未検証。「グラデーションの画像を内側の箱の大きさで描き、枠の下で繰り返す」は CSS の決まり (`background-origin: padding-box`、`background-repeat: repeat`) で、どの描画系でも同じはずだが、確かめていない。行の断片ごとの描き方 (`box-decoration-break: slice`) も同じ。補間・ディザは描画系で違いうる。検査は Chromium の中で走るので、**来訪者が別の描画系で見る絵は検査していない。**
- **実機:** 未検証 (iOS Safari・Android Chrome、端末の画素比 2・3、拡大率、文字の大きさの設定)。
- 1920 より広い・320 より狭い・小数の幅、900 以外の窓の高さ。
- CI の書体: この容器で CI の書体の組だけを見せる fontconfig (`scratchpad/dev173/fonts-ci.conf`) で `gradient-paint-box.test.ts` (3店の掃引を含む) を走らせ 18 / 18 緑。CI そのものではない。
- **限り (DEV-180 のレビュー L3): 内側の影 (`box-shadow: inset 0 16px 0 #000`) は文法も描画の検査も通り、グラデーションの地の上に硬い帯を描く。** 文字は載らないので文字の安全ではないが、「地は滑らか」の約束はこの形を見ていない (内側の影は今の文法が地の無い箱にも許すもので、gradient_ground の前からある)。ON の前に、地に内側の影を許さないかを決める (§7 の B8)。

## 7. 残る BLOCKED

| # | 項目 | ON を止めるか |
|---|---|---|
| B1 | **オーナーの明示の承認** (能力の ON、`APPROVED_CAPABILITIES` の変更、本番の描画の門の変更) | 止める |
| B2 | 研究の branch・本番の branch の CI 緑と独立の Fresh Review (C/H/M = 0) | 止める |
| B3 | WebKit・Firefox・実機で、地の描き方と規則の答えが合うこと (§6) | オーナーの判断 (判断シート §10 の 5) |
| B4 | `colour_syntax` と一緒に ON にしないこと (U2 が残る) | `colour_syntax` だけを止める |
| B5 | つぐ手の器は書体しだい (U3)、器の左右の明るさの食い違い | 器を使うかの見た目の判断 |
| B6 | 地の色とカンプの palette を照らす検査が無い (U4) | オーナーの判断 (判断シート §10 の 4) |
| B7 | 火の管の止めを 18% → 40% にずらすこと (C′ の色のままでは `GRADIENT_TOO_STEEP`) は見た目の判断 | 値の判断 |
| B8 | グラデーションの地の上の内側の影 (硬い帯が描ける。§6) | オーナーの判断 (文字の安全ではない) |

## 8. 推奨

**最初に ON を求める単一の能力は gradient_ground** (推奨であって承認ではない)。理由は `capability-approval-layered-decoration.md` §8: 必須の穴が小さな本番の差分で塞がる、文字の安全の作りが単純 (文字の載る地は全幅で落とす)、得が画面ではっきりしている (ゆげ湯の火の目盛りの帯)、巻き戻しが名前を1つ外すだけ。

**M1 の穴 (U1) は、候補の検査で塞げることを示した。本番に入るのは §3 の draft の branch が承認されたときである。それまで gradient_ground は OFF のまま。**
