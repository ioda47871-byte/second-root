# 段 B の設計: 書体の固定と、文字に重ならない地 (DEV-161、Issue #193 コメント `6601921731` の決定1)

2026-11-03。**設計と検証の準備だけの文書で、何も有効にしていない。**

次のものは、どれも変えていない。

- 本番の CSS と HTML の許可一覧 (`lib/design-agent/comp-impl/page-css.ts`・`page.ts`・`shop-css/*`)
- 安全の門と閾値
- worker の権限
- 能力の表 (`APPROVED_CAPABILITIES = []`)

段 B を実際に有効にする PR は、オーナーの明示の承認を得てから merge する (DEV-083 §8)。

土台は次の3つの文書である。

- `docs/design/dev-083-expressive-safe-reproduction.md`: 計画。§3 の能力、§7 の段、§8 の審査、§10 の段 A の実装
- `docs/design/comp-impl-loss-analysis.md`: 3店の A/B/C で失われたもの
- `docs/design/expressive-allowlist-proposal.md`: 順番 B → C → N1 → D

## 1. 段 B に入れるもの、入れないもの

段 B は「**文字に重ならない**表現」だけを広げる。重ね (段 C)、縦書きと回転と縁取り (段 D)、装飾の SVG (N1) は入れない。

| 能力の名前 (提案) | 何を許すか | 3店で戻る損失 |
|---|---|---|
| `web_font` | 固定した書体 (ハッシュで照らす) の名前だけを `font-family` で使う。`@font-face` はページに書かせず、信頼できる側が同じバイト列を描画と配信の両方に入れる | 前提。字形を固定しないと、ほかの検査の結果が機械ごとに揺れる (DEV-083 §7「書体の固定は重ねより前」) |
| `display_scale` (DEV-083 の `type_scale`) | 表示語の大きさの幅を広げる。**N3: 256px を超え 640px まで、`content` の表示語の役割の要素だけ** | ゆげ湯の 熱い、3店の巨大な表示語 (`IMPL_RULE_TYPE_MAX_256`) |
| `colour_syntax` | `hsl()`・`oklch()`・名前の色。検査は計算後の sRGB で行う | 釉や漆の微妙な色 |
| `gradient_ground` | 文字の下でない地と帯に `linear-gradient`・`radial-gradient` | ゆげ湯の温度計の帯と火の帯、つぐ手の器の地 (`IMPL_RULE_NO_GRADIENT_PATTERN`) |
| `translucent_decoration` | `decoration`・`ground`・`media` の `opacity` < 1。文字の下でないこと | 湯気、残り火の光 |
| `image_filters` | 決まった一覧 (`grayscale`・`sepia`・`brightness`・`contrast`・`blur`・`saturate`) の範囲つきの値。`media`・`decoration` で、文字の下でないこと | 写真の調子 (実写真が入ってから) |
| `ornament` | 流れの中の `::before`・`::after` で `content: ""` だけ (箱で、文字を持たない)。位置を指定しない | 金の罫、区画のラベルの線 |
| **N2** `display_nowrap` | `white-space: nowrap`・`word-break: keep-all` を表示語の役割の要素にだけ。事実の値の段落には付けない | 語の途中の改行 (まわ/る、ありま/す、つぐ/手) |

### 段 B で許さないもの

- 位置の指定 (`position` の `static` 以外、オフセット、`z-index`、負の margin) → 段 C
- 文字の下のグラデーション・半透明・フィルター → 段 C (V3b・V5 の証明が要る)
- `transform`・`writing-mode` の広げ (vertical_name は既存の別の能力で、未承認)・`-webkit-text-stroke`・`clip-path`・`mix-blend-mode` → 段 D
- SVG (インラインも資産も) → N1 (別の文書と別の PR)
- `url()` (書体の固定も `url()` を使わない。理由は §2.1)
- `content` の文字列・`attr()`・カウンター・`background-clip: text` → 永久に不可 (DEV-083 I1)

## 2. 能力ごとの文法・役割・検証

役割は DEV-083 V1 (`data-comp-role`: content・decoration・ground・media、段 A で作られている) を使う。**宣言された役割は信じず、DOM の中身から検める。**

### 2.1 `web_font`

- **文法:** ページの CSS は `font-family: <固定の一覧の名前>, <総称の書体>` だけを書く。**ページの CSS に `@font-face` は書かせない** (今の `CSS_AT_RULE` の拒否はそのまま)。
  - `src: local()` は使わない。`local()` は、見る人の端末に入っている同じ名前の書体を探すだけである。検査の描画では固定のファイルが使われても、来訪者のブラウザでは別の書体か代わりの書体になり、検査が見た字形と来訪者が見る字形が食い違う (Fresh Review M1)。
  - 書体のバイト列は、**信頼できる側** (検査の描画の道具と、本番の配信の枠。どちらもリポジトリの固定のコード) が、sha256 の一覧にある同じファイルから同じ `@font-face` を差し込む。配信では、自分のサイトの固定の道 (`/fonts/<sha256>.woff2` のような、名前にハッシュを含む道) から読む。ページの CSS は `url()` を持たない。
  - 配信の枠と検査の描画が、同じ一覧・同じバイト列を使うことをテストで固定する (一覧の1か所から両方を作る)。
  - `unicode-range`・`font-feature-settings` の文字の差し替えは、差し込む側でも使わない。
- **役割:** すべて。
- **検証:**
  - sha256 の一覧と照らす。一覧の変更には人の承認が要る (数字を描き替える記号の書体を足せないように)。
  - 書体ごとに許諾と出所を記録する。
  - V10 の攪乱の pass と一緒に入れる。**読み込みに失敗したとき** (総称の書体に落ちたとき) の描画でも、`TEXT_BOX_OVERFLOW`・横の掃引・語の折れの検査を通すことを求める。来訪者の側で読み込みが遅れても切れないように。
- **落ちるべき例:**
  - 一覧に無い名前
  - ページの CSS の `@font-face` (`src: url(...)` でも `src: local(...)` でも)
  - 差し込む側の一覧と配信の枠の一覧の食い違い
  - 一覧の名前でもハッシュの違うファイル
  - 総称の書体に落ちたときだけはみ出す表示語

### 2.2 `display_scale` (N3 を含む)

- **名前:** DEV-083 §7 は `type_scale` と呼んだ。しかし `type_scale` は、すでに spec の欄の名前である (`spec.ts` の `type_scale: { display_px, … }`、`checks.ts` の大きさの検査)。能力の名前と spec の欄が同じだと、grep の検査も人の読みも混ざる。だから能力の名前は `display_scale` にする。

- **文法:** `font-size` の上限を、表示語の役割で 640px まで上げる。spec の `type_scale.display_px` の範囲 (今は 16〜160) も、旗が立ったときだけ広げる (旗無しの spec の検査は変えない)。ほかの役割は今のまま (256px まで、下限 12px は変えない)。
- **役割:**
  - `content` のうち、spec が表示語 (店名の飾り、固定のラベル) と宣言し、DOM の文字が店名か固定のラベルと一致する要素だけ。
  - 事実の値・免責・情報の組には付けない。
- **検証:**
  - **大きさの上限を、描画した後の計算値 (px) で、すべての文字に掛ける新しい検査を足す** (仮の名前 `TYPE_ABOVE_ROLE_CAP`)。今の `typeCheck` (`checks.ts`) には絶対の上限が無く、PC で spec の大きさとの差を見るだけである。だから「上限を役割ごとにする」のでなく、新しく作る。表示語の役割は 640px、ほかは 256px。SP の幅でも掛ける。
  - **今の静的な上限は、すり抜けられる** (段 B と関係なく、今ある穴)。`html { font-size: 256px }` と `.x { font-size: 16rem }` は、どちらも今の `cssProblems` を通り、合わせて 4096px の文字になる。`em` の入れ子や `vw` も同じである。4096px のような極端な値は `TEXT_BOX_OVERFLOW` や横のはみ出し (`OVERFLOW_HORIZONTAL`) でまず落ちる。しかし 300〜600px ほどの文字は、箱に収まれば事実の段落でも通り得る。大きさそのものを見ているのは、役割のある文字への PC の `TYPE_SIZE` の差の検査だけで、事実の段落や SP には掛からない。上の計算値の検査は、この穴も塞ぐ。段 B の実装より前に、穴だけを塞ぐ小さな PR を出してもよい (緩めではないので、事前承認の内)。
  - `TEXT_BOX_OVERFLOW` と横のはみ出しの掃引は今のまま。
  - 語の途中の改行の検査を足す (`fidelity-measure.ts` の words_broken と同じ考え方を、本番の検査に写す)。
- **落ちるべき例:**
  - 事実の値の段落に 300px
  - 表示語と宣言したが、文字が事実の値
  - 640px を超える値
  - `calc()` で上限をすり抜ける値
  - `html` の `font-size` と `rem` の掛け合わせ、`em` の入れ子、`vw` で上限をすり抜ける値 (計算値の検査で落とす)

### 2.3 `colour_syntax`

- **文法:** `hsl()`・`hsla()`・`oklch()`・`oklab()`、CSS の名前の色。
- **検証:**
  - 色の検査 (コントラストやパレット) は、ブラウザの計算後の sRGB で行う。
  - 範囲外の色 (sRGB の外) は、色の検査が判定できる値に丸めてから判定する。
- **落ちるべき例:**
  - `color-mix()`・`light-dark()`・`currentcolor` の連鎖でコントラストの検査を外す
  - `transparent` を文字の色にする (今の不透明度の検査で落ちることを確かめる)

### 2.4 `gradient_ground`

- **文法:** `background` / `background-image` に `linear-gradient()`・`radial-gradient()`、止めの数は 8 まで、止めの色は `colour_syntax` の範囲。
  - `repeating-*`・`conic-gradient()` は段 B では許さない (模様は文字の判定を難しくする)。
- **役割:** `ground`・`decoration`。**文字を持つ要素とその祖先には付けない。** 付いた要素の箱が、文字の箱と重ならないこと。
- **検証:**
  - 段 A の V3b の止めの規則 (`gradientStopProblems`)。
  - 「文字の下に来ない」ことを、描画した箱で確かめる (V4 の簡易版。重なれば段 C の事柄として拒否する)。箱は、その要素が描く範囲全体とする (§2.9)。
- **落ちるべき例:**
  - 文字の段落の背景
  - 文字を含む区画の背景
  - 止めの急な帯 (`GRADIENT_HARD_STOP`)
  - `url()` を混ぜる
  - `image-set("a.png" 1x)`・`-webkit-image-set(...)`。**文字列の形で外へ読みに行けるので、字句の段の `url` の拒否 (`CSS_SYNTAX_URL`) では止まらない** (今は値の文法で `CSS_VALUE`/`CSS_PROPERTY` として落ちている)。`background-image` を許すときに、関数の許可一覧を2つのグラデーションだけにして落とす
  - `repeating-linear-gradient`

### 2.5 `translucent_decoration`

- **文法:** `opacity` 0.1〜1 を `decoration`・`ground`・`media` に付ける。
- **検証:**
  - 文字の不透明度の積 ≥ 0.85 は変えない。
  - 半透明の要素が描く範囲 (§2.9) が、文字の箱に重ならないことを描画で確かめる。
  - **今の門との関係:** `opacity` < 1 は重ねの文脈を作る。今の `verify.ts` は重ねの文脈を1つでも見つけると `STACKING_CONTEXT` で止める (今の許可一覧は重ねの文脈を作れないので、見つかること自体が異常という作り)。段 B で通すには、この止め方を「文字を子孫に持たず、描く範囲が文字の箱と重ならない要素の作る文脈だけは許す」に狭める必要がある。**これは描画の側の門を緩める変更で、許可一覧の変更と同じく、オーナーの承認が要る。** 狭めた後も、V2 の描く順のモデルでその文脈が文字を覆わないことを確かめる。
- **落ちるべき例:**
  - 文字を含む要素の opacity
  - 半透明の地が文字の下に来る

### 2.6 `image_filters`

- **文法:** `filter` の一覧の関数を、範囲つきで1つずつ使う (`blur` ≤ 8px など、値は段 B の PR で決める)。
- **役割:** `media`・`decoration`。文字の下でないこと。
- **検証:**
  - 静的な範囲の検査。
  - **描く範囲:** `blur(r)` は要素の箱の外へ約 3r 描く (8px なら約 24px)。「文字の下でない」ことは、箱をフィルターの描く範囲だけ広げてから確かめる (§2.9)。箱どうしが離れていても、ぼかしのにじみが文字の下に来ることがある (Fresh Review M2)。
  - `filter` も重ねの文脈を作るので、`STACKING_CONTEXT` について §2.5 と同じ狭め方と承認が要る。
  - 人が、フィルターを掛けて描いた資産を見る (コントラストで隠れていた内容が出ることがある)。
- **落ちるべき例:**
  - `drop-shadow` (一覧外)
  - `url(#…)` のフィルター
  - 文字を含む要素へのフィルター

### 2.7 `ornament`

- **文法:** `::before`・`::after` で `content: ""`、`display: block`/`inline-block`、大きさ・色・罫だけ。
  - `position` の指定は、段 B では不可。
  - ほかの疑似要素は不可。
- **検証:**
  - **今の門との関係:** 段 A には疑似要素の幾何を測る検査が**無い**。今の `verify.ts` は疑似要素が1つでもあれば `PSEUDO_GEOMETRY_UNKNOWN` で止める (「幾何の証明が無いので止める」という意味である)。`ornament` を通すには、疑似要素の描く範囲を測る新しい検査 (`getComputedStyle(el, "::before")` の大きさと、親の箱からの位置) を作り、その測った範囲が文字の箱に重ならないときだけ止めないようにする。**止める門を狭める変更なので、オーナーの承認が要る。**
  - `content` の文字列の検査は今のまま。
- **落ちるべき例:**
  - `content: "x"`・`content: attr()`・`content: counter()`
  - `::first-letter`
  - 位置を指定した疑似要素

### 2.8 N2 `display_nowrap`

- **文法:** `white-space: nowrap`、`word-break: keep-all`。
- **役割:** `display_scale` と同じ表示語の役割だけ。
- **検証:**
  - はみ出しは `TEXT_BOX_OVERFLOW` と横の掃引で落とす。
  - 1px の掃引 (V6) で、間の幅でもはみ出さないことを確かめる。
- **落ちるべき例:**
  - 事実の値の段落の nowrap (狭い幅で文字が切れる)
  - 表示語でも、390 の幅ではみ出す

### 2.9 描く範囲 (段 B の「文字の下でない」の共通の定義)

- 「文字の下でない」は、要素の箱でなく、**その要素が描く範囲**と文字の箱の交わりで確かめる。
- 描く範囲 = 要素の箱 + 外側に描くもの。段 B で増えるのは `blur(r)` の約 3r だけである (外側の `box-shadow`・`outline`・`drop-shadow` は段 B でも許さない)。
- 測れない描き方 (未知の関数など) は、許可一覧で先に落とす。描く範囲が分からないものは通さない。

## 3. 能力の表と旗 (誰が有効にできるか)

**今の事実 (正確に):**

- `comp-impl/run.ts` は、`verticalName` を spec から決める (`verticalNameOf(bundle.spec, …)`)。
- ただし、その前に `bundle.ts` の `loadCompBundle` が `checkCompSpec` を通している。`checkCompSpec` は、spec の `capabilities` のうち、リポジトリの固定の表 `APPROVED_CAPABILITIES` (今は空 `[]`) に無いものを `SPEC_CAPABILITY_NOT_APPROVED` で拒む。
- だから、**今は spec だけでは能力を立てられない**。
- 前の提案 (`expressive-allowlist-proposal.md` §3(3)) の「spec が旗を立てられてしまう」は、表がある今の作りを見落とした書き方だった。正しくは「**表が空のあいだは立たない。表に足すのはオーナーの承認を得た PR だけ**」。

段 B もこの作りに乗せる。

1. `CAPABILITY_NAMES` に段 B の名前を足すのは、段 B の実装の PR とする。この設計 PR では足さない。足しても、`APPROVED_CAPABILITIES` が空のあいだは、spec が宣言すると拒まれる。
2. `APPROVED_CAPABILITIES` に名前を足すのが、有効にする行為である。**オーナーの承認のある別の PR だけ**が行う。表から外せば、その能力は戻せる。
3. `pageCssProblems` の旗は、能力ごとに足す (`PageCssOptions` の鍵)。旗は、承認された能力を spec が宣言したときだけ `run.ts` が立てる。
4. **今の worker の道** (`scripts/sales-design-worker/`) は、段 B の能力の名前を1つも参照しない。これをテストで固定する (§5)。ただし、名前の検索で分かるのは「名前を直接書いていない」ことだけである。能力の一覧をまとめて渡すような書き方は、この検索では見つからない。**本当の門は `APPROVED_CAPABILITIES` が空であることの固定**で、名前の検索はその補助である。

## 4. 測る費用

DEV-083 §6 と §10 の「measured costs」と同じ方法で、Chromium 1194 の手元の容器で3回測り、最も良い値を取る。

| 能力 | 足す仕事 | 測るもの |
|---|---|---|
| `web_font` | 書体の読み込み、V10 の攪乱 (字幅を変えて再描画) | 1ページあたりの描画の時間の増え |
| `display_scale`・N2 | 語の折れの検査、1px の掃引 | 掃引の幅の数 × 1幅の時間 |
| `gradient_ground`・`translucent_decoration`・`image_filters` | 描画した箱と文字の箱の交わり | 1ページの DOM の歩き |
| `ornament` | 疑似要素の描く範囲を測る新しい検査 (§2.7。段 A には無い) | 1ページの疑似要素の数 × 測る時間 |

CI の時間の予算 (unit の shard の増え) は、段 B の実装の PR で表にする。

## 5. 互換性 (旗が下りているあいだは何も変わらない)

`tests/unit/design-agent/comp-impl/phase-b-baseline.test.ts` が、**今の振る舞い**を固定する。段 B の実装の PR は、旗を下ろしたままでこのテストを通し続けなければならない。

- 段 B の落ちるべき例の宣言が、今はすべて拒まれる (旗無しでも、`{ verticalName: true }` でも)。
- 今許されている宣言は、今のまま許される。
- `PageCssOptions` の鍵は `verticalName` だけである (旗は能力ごとに増える。増えたら、このテストを意図して直す)。
- `CAPABILITY_NAMES` は `["vertical_name"]`、`APPROVED_CAPABILITIES` は `[]` である。
- 本番の道 (`scripts/sales-design-worker/` と `lib/design-agent/comp-impl/run.ts`) は、段 B の能力の名前を、snake_case でも旗の鍵の camelCase (`webFont`・`displayScale` など) でも参照しない。`type_scale` は spec の欄の名前として今も使われているので、この検査では探さない (§2.2)。名前の検索の限界は §3 の 4。
- 外へ読みに行く CSS の形 (`url()`、`@import`、`image-set()`・`-webkit-image-set()`、`@font-face` の `src: url()`) が、今はすべて拒まれる。
- 今ある穴 (`html` の `font-size` と `rem` の掛け合わせ、§2.2) は、今は通ることを記録として固定する。穴を塞ぐ PR は、このテストを意図して直す。
- `PageCssOptions` の検査はソースの1行の形を見るので、意味を変えない書き換えでも落ちる (落ちる側に倒れる)。その時はテストを意図して直す。

## 6. 進め方

1. **この PR (DEV-161):** 設計と、今の振る舞いを固定するテストだけ。
2. **段 B の実装の PR (DEV-164、`feature/dev-164-phase-b-impl`、HOLD):**
   - 能力の名前、旗、検査、落ちるべき例、費用の実測を入れる。`APPROVED_CAPABILITIES` は空のまま。
   - CI と独立 Fresh Review を通し、merge の前にオーナーの承認を得る。許可一覧の変更を含むので、事前承認の外である。
   - **状態 (2026-11-04):** 5つの能力を旗の後ろに実装した (§8)。`APPROVED_CAPABILITIES` は空のまま。PR は merge しない。merge にはオーナーの明示の承認が要る (本番の許可一覧のコードの道を変えるため。DEV-083 §8)。
3. **有効にする PR:** `APPROVED_CAPABILITIES` に名前を足す1行と、その能力を使う研究用のページの比較画像。オーナーの承認が要る。
4. 段 C、N1、段 D は、それぞれ別の設計と PR とする。

## 7. オーナーに判断してもらうこと (段 B の実装の PR のとき)

- `web_font` に入れる書体の一覧 (許諾つき)。配信の枠に書体のファイルを置くこと (自分のサイトから配る)。
- `STACKING_CONTEXT` と `PSEUDO_GEOMETRY_UNKNOWN` の止め方を狭めること (§2.5・§2.6・§2.7)。
- `image_filters` の値の範囲。
- 段 B の能力のうち、最初に有効にするもの。
- **描画の検査が証明する範囲 (Fresh Review 1回目の M1 の後):** 段 B の旗を立てたとき、地 (`background-image`)・グラデーションの止めの規則・半透明の箱 (と `STACKING_CONTEXT` の狭め)・表示語は、**320〜1920 の整数の CSS px の幅の全部**で確かめる (1px の掃引、§8.4)。**証明しないもの:** 1920 より広い幅、320 より狭い幅、整数でない幅 (小数の CSS px)、ブラウザの拡大率 (zoom) と端末の画素比の違い、**900 以外の窓の高さ** (掃引も確かめる幅も高さは 900 に固定。高さで重なりが変わるのは生の HTML の負の余白などの形で、許可一覧は負の余白を拒むので、許可一覧を通るページでは起きにくいと見るが、証明はしていない)、Chromium 1194 以外の描画系、文字の書体が手元の容器と違う環境。これらを要るとするかは、有効にする前にオーナーが決める。

## 8. 実装メモ (DEV-164)

2026-11-04。Issue #193 コメント `6623100651` と同日のチャットの1。**旗はすべて既定で下りている。能力は1つも承認していない。**

### 8.1 実装したもの、しなかったもの

| 能力 | 状態 | 理由 |
|---|---|---|
| `display_scale` | 実装 (旗 `displayScale`) | |
| `display_nowrap` | 実装 (旗 `displayNowrap`) | |
| `colour_syntax` | 実装 (旗 `colourSyntax`) | |
| `gradient_ground` | 実装 (旗 `gradientGround`) | |
| `translucent_decoration` | 実装 (旗 `translucentDecoration`) | `STACKING_CONTEXT` の狭めを含む。旗の後ろだけ。§7 のオーナーの判断が要る |
| `web_font` | 設計だけ | 書体の一覧と許諾、配信の枠、差し込む側の道具が要る (§7) |
| `image_filters` | 設計だけ | 値の範囲が未決 (§7)。`blur` のにじみの描く範囲の証明が要る |
| `ornament` | 設計だけ | 疑似要素の描く範囲を測る新しい検査が要る (`PSEUDO_GEOMETRY_UNKNOWN` の狭め) |

### 8.2 誰が旗を立てるか

- `CAPABILITY_NAMES` に5つを足した。`APPROVED_CAPABILITIES = []` のまま。
- spec が5つのどれかを宣言すると `SPEC_CAPABILITY_NOT_APPROVED` で拒まれる (前は `SPEC_SHAPE`。どちらも拒否)。
- `spec.ts` の `pageCssOptionsOf(spec)` が、**宣言され かつ 承認された**能力の鍵だけを立てる。今はどの spec でも `{}`。
- `run.ts` は `pageCssOptionsOf(bundle.spec)` の結果だけを使う。能力の名前も鍵の名前も書かない (基準のテストのとおり)。
- worker (`scripts/sales-design-worker/comp-impl-poc.ts`) は `runCompImpl` を呼ぶだけで、旗を渡す口が無い。`RunOptions` にも旗の欄は無い。
- spec の `type_scale.display_px` は、`display_scale` が宣言され承認されたときだけ 640 まで。ほかは今のまま 16〜160 (超えれば `SPEC_SHAPE`)。

### 8.3 静的な文法 (`page-css.ts`)

- `displayScale`: `font-size` を px 12〜640、rem 0.75〜40 まで。`calc()`・`clamp()`・`max()` は今の 256px のまま。`em`・`%`・`vw` は今どおり不可。
- `displayNowrap`: `white-space: normal | nowrap`、`word-break` に `keep-all`。`pre`・`pre-wrap`・負の字間は不可。
- `colourSyntax`: `hsl()`・`hsla()`・`oklch()`・`oklab()`・CSS の名前の色。値は数・%・角度だけ。`calc()`・`none`・相対色 (`from`)・`var()`・`light-dark()`・`lab()`・`color()` は不可。`color-mix()` の中の新しい色も不可。
  - 色が入る場所でだけ通す (hex の色に置き換えて、今の文法で確かめる)。
- `gradientGround`: `background` と `background-image` に `linear-gradient()`・`radial-gradient()` を1つだけ。
  - 止めは 2〜8。止めの色に `var()` は不可。位置は % を1つまで (px・`calc()`・2つの位置は不可)。
  - **止めの色は不透明だけ** (Fresh Review 2回目の M1): 3桁・6桁の hex、末尾が `f`・`ff` の 4桁・8桁の hex、`white`・`black`、アルファ無しか 1・100% の `rgb()`・`rgba()`、`colourSyntax` のときは名前の色とアルファ無しか 1・100% の `hsl()`・`hsla()`・`oklch()`・`oklab()`。`transparent`・`currentcolor`・`color-mix()`・アルファが 1 未満のものは `CSS_VALUE`。グラデーションの止めの外 (`color` など) の色の文法は変えていない。
  - 向きは `to <辺> [<辺>]` か角度。円形は `circle`・`ellipse` だけ (`at`・大きさは不可)。
  - `repeating-*`・`conic-gradient()`・`image-set()`・`-webkit-image-set()`・重ね (カンマ) は不可。`url()` は字句の段で止まる。
- `translucentDecoration`: `opacity` 0.1〜1。

### 8.4 描画の側 (`phase-b.ts`、`layers.ts`、`render.ts`)

- 調べる幅: 確かめる幅 (PC と SP の擬装) と 32px の掃引の全部。測れなかった幅は `PHASE_B_UNMEASURED`。
- 旗を立てたときは、それに加えて 1px の掃引 (下) で 320〜1920 の整数の幅の全部。
- 結果は `run.ts` の `checks.phase_b` (止める側)。
- **`TYPE_ABOVE_ROLE_CAP` (旗が無くても掛かる):**
  - すべての文字の、計算後の `font-size` (px) を見る。上限は 256px。
  - `displayScale` のときだけ、表示語は 640px まで。
  - 表示語 = 店名か固定のラベル (`COMP_UI_LABELS`) と文字が完全に一致し、子の要素を持たず、`dt`・`dd`・免責の中でない要素。**一覧はコードが決める。spec では広げられない** (設計の「spec が宣言する」より狭い)。
  - これで `html { font-size }` × `rem` の穴 (§2.2) が描画で塞がる。静的な検査は今も通す (基準のテストは `[]` のまま)。
- `NOWRAP_NOT_DISPLAY`: 表示語でない文字に、計算後の nowrap・pre・keep-all が掛かっている (継いだ値も)。
- `DISPLAY_WORD_BROKEN`: 表示語の語 (空白の間) が2行にまたがる。`displayScale` か `displayNowrap` のときだけ見る。
- 1px の掃引 (`displaySweepPass`。`displayScale`・`displayNowrap`・`gradientGround`・`translucentDecoration` のどれかのときだけ。旗が無ければ動かない): 320〜1920 の整数の幅の全部。段の分け方は `protectedGeometryPass` と同じ (段の両端で根に自分の箱が無ければ根の幅を動かし、そうでなければ実際に画面の幅を変える)。
  - `displayScale` か `displayNowrap`: 表示語の行が箱と画面の中にあること、語が折れないこと (`DISPLAY_OUT_OF_BOX`・`DISPLAY_OFFSCREEN`・`DISPLAY_WORD_BROKEN`)。
  - `gradientGround` か `translucentDecoration` (Fresh Review の M1): 下の地・グラデーション・半透明の箱の検査 (`PAINT_SCANNER`。確かめる幅と同じコード) を毎幅に掛ける。確かめる幅の間の 15px の帯で地が文字に重なる例 (レビューの再現) がこれで落ちる。`STACKING_CONTEXT` の狭めは「文字に重ならない」が条件なので、これで全幅で裏付けられる (重なる幅があれば `TRANSLUCENT_UNDER_TEXT`)。
  - **測れなかった幅は落とす:** 掃引は測った幅の数を返し、範囲の整数の幅で測っていないものを `PHASE_B_UNMEASURED` にする。
- `GROUND_HAS_TEXT`・`GROUND_UNDER_TEXT`: `background-image` のある要素は文字を持たず、枠の箱が文字の行の箱に重ならないこと。
  - 「文字を持つ」は、文字の節・`aria-label`・`alt` (自分の `alt` も) のどれか (Fresh Review の L1。段 A の `layers.ts` の `altInside` と同じく `alt` を数える。段 A は媒体の `img` の自分の `alt` を数えないが、段 B では数える: 厳しい側)。半透明の箱も同じ。
- `GRADIENT_HARD_STOP`・`GRADIENT_TOO_STEEP`・`GRADIENT_UNMEASURED`: 描いたグラデーションに V3b の止めの規則を掛ける。
  - 色はキャンバスで sRGB に直す (`oklch` も)。
  - 線の長さは下の限り (角は min(w, h)、円形は min(w, h)/2) で、短く見るほど厳しくなる。
  - 読めない形は落とす。
  - **描いたグラデーションの全部に掛ける** (Fresh Review の M2。前は返す一覧が 40 までで、41 個目からは見ていなかった)。規則はページの中で走らせ (`GRADIENT_CODES_JS`)、返すのはコード (3種) と数だけ。TS の `gradientProblems` と同じ答えを出すことを、テストで多くの形について照らし合わせる。
  - 1px の掃引でも毎幅に掛ける (箱の幅で線の長さが変わるため)。
  - **止めの色のアルファ (L3 の訂正。Fresh Review 2回目の M1):** 1回目の後にここへ「厳しい側で、落ちるべきものが通ることは無い」と書いたのは**誤りだった**。規則は RGB だけを比べるので、アルファだけが変わる止め (`#000` から `transparent`、`#0000`、`rgba(0,0,0,.05)`、300px の `#000 50%, transparent 50%` の硬い境目) は `change === 0` として飛ばされ、通っていた。直し:
    - 静的: `gradientGround` の止めの色を不透明に限る (上の §8.3)。これが主の守り。
    - 描画 (二重の守り): ページの中で、アルファが 255 でない止めは測れない (`GRADIENT_UNMEASURED`) として落とす。
    - 段 A の `verify.ts` の `gradientStopProblems` (RGB だけを比べる) は変えていない。段 A ではグラデーションは許可一覧が拒むので、そこへ届くのは生の HTML のテストだけである。段 B の描画の側はアルファの無い止めしか渡さない。
- `TRANSLUCENT_HAS_TEXT`・`TRANSLUCENT_UNDER_TEXT`: `opacity` < 1 の要素は文字を持たず、自分と子孫の箱が文字の行の箱に重ならないこと。
- **`STACKING_CONTEXT` の狭め (`translucentDecoration` のときだけ):** `opacity` だけで重ねの文脈を作り、文字を持たず、自分と子孫の箱が文字に重ならない要素 (`html`・`body` 以外) は数えない。ほかの引き金・文字・重なりがあれば今どおり数える。**描画の門を狭める変更なので、§7 のオーナーの承認が要る。**
- 描く範囲 (§2.9) は箱そのもの。段 B の実装した能力は外側に描くものを足さない (`blur` は未実装)。

### 8.5 旗が下りているときに変わること

- 変わるのは `TYPE_ABOVE_ROLE_CAP` の 256px だけ。今 256px を超える文字を描くページは落ちる (今ある穴を塞ぐ。緩めではない)。
- 既存の通るページ 9 枚 (合成の和菓子、pilot-1 の2枚、3店の C の6枚) は、確かめる幅の全部 (PC と SP の擬装) と 32px の掃引の 51 幅の全部 (`legibilitySweep` と同じく PC の擬装の1つの頁で幅を変える) で、コードが出ない (テストで固定。Fresh Review の L2 で掃引の幅を足した)。1px の掃引は旗が無ければ動かないので、旗を下ろしたときの検査の幅はこの2つだけである。
- ほかのコードは、旗無しでは許可一覧が元の宣言を拒むので出ない。
- 報告の `checks` に `phase_b` が1つ増える。

### 8.6 費用 (手元の容器、Chromium 1194、合成のページ、3回の最良)

`phase-b.test.ts` の最後のテストが測って、ログに出す (`DEV-164 cost`)。

| 測ったもの | 値 |
|---|---|
| `PHASE_B_SCRIPT` 1回 (1幅、旗をすべて立てて) | 3〜8 ms |
| 旗無しでも足される仕事 (確かめる幅 10 + 32px の掃引 51 = 61 回) | 約 0.2〜0.5 s / ページ |
| 32px の掃引 (`legibilitySweep`) 旗無し / 旗すべて | 3,416 / 3,394 ms、3,901 / 3,973 ms (差は誤差の内) |
| 1幅の `legibilityPass` (1440) 旗無し / 旗すべて | 1,207 / 1,123 ms、1,239 / 1,521 ms (同上) |
| 1px の表示語の掃引 (`displaySweepPass`、旗を立てたときだけ、320〜1920 の 1,601 幅) | 923 ms、1,017 ms |
| (Fresh Review 1回目の後) 1px の掃引: 表示語の旗だけ / 地と半透明の旗だけ / 旗すべて | 1,034 / 975 / 1,577 ms |
| (同) 32px の掃引 旗無し / 旗すべて、1幅の `legibilityPass` (1440) 旗無し / 旗すべて | 3,867 / 3,806 ms、1,298 / 1,249 ms |

- 2回の実行の値を並べた (各値は3回の最良)。
- 旗を下ろしたときの増え: 1ページ約 0.2〜0.5 s (計算後の大きさの上限の分)。
- 旗を立てたときの増え: それに約 1 s (1px の掃引)。合成のページの1回の実行 (数十秒) に比べて小さい。
- M1 の直しの増え (地と半透明を 1px の掃引に足した分): `gradientGround` か `translucentDecoration` だけなら掃引1回 約 1.0 s、表示語の旗と合わせると約 1.6 s (表示語だけの約 1.0 s から約 +0.6 s)。旗を下ろしたときは掃引が動かないので増えない (32px の掃引と確かめる幅の値は誤差の内)。
- CI の unit の組の増え: `phase-b.test.ts` 1本 (Fresh Review の後 164 件、手元で約 139 秒。うち `runCompImpl` 2回、既存の 9 枚を 32px の掃引の幅でも見る分 約 30 秒)。

### 8.7 設計で見つけたこと

- §5 は「本番の道は段 B の名前を参照しない」と言い、§3 の 3 は「旗は `run.ts` が立てる」と言う。両方を満たすため、名前と鍵の対応は `spec.ts` に置き、`run.ts` は `pageCssOptionsOf` だけを呼ぶ。
- §2.2 の「spec が表示語と宣言する」は、spec に欄が無い。欄を足すと作者が表示語を広げられるので、一覧をコードに固定した。
- §2.4 の止めの規則は、文字の下でない地に掛けても強い (黒から白へは 128px 以上要る)。オーナーが有効にする前に、帯の幅と合わせて見る値である。
- 不安全なところは見つからなかった。`translucent_decoration` の `STACKING_CONTEXT` の狭めだけは、設計どおり描画の門を狭めるので、承認の対象として明記した。

### 8.8 Fresh Review 1回目 (C0 / H0 / M2 / L3) の直し

| 指摘 | 直したこと | テスト |
|---|---|---|
| M1 地・半透明と文字の重なりを確かめる幅でしか見ない (間の 15px の帯が抜ける) | `gradientGround` か `translucentDecoration` のとき、1px の掃引 (`displaySweepPass`、320〜1920 の整数の幅の全部) で地・グラデーションの止めの規則・半透明の箱の検査を毎幅に掛ける。測っていない幅は `PHASE_B_UNMEASURED` | レビューの再現 (`GROUND_UNDER_TEXT` が 462〜476 だけで出る。確かめる幅と 32px の幅では出ない)、止めの規則に掛からない 30px の帯 (標本の幅では全部通り、掃引だけで落ちる)、同じ形の半透明 (`TRANSLUCENT_UNDER_TEXT`)、根の幅を動かす測り方と実際の幅の変更の一致、旗無しで掃引が動かないこと |
| M2 41 個目からのグラデーションに止めの規則が掛からない | 規則をページの中で全部のグラデーションに掛け、コードと数だけ返す (`GRADIENT_CODES_JS`。返す形は `{ count, codes }`) | 40 個の滑らかなもの + 硬い止め1つ、200 個 + 1つ。ページの中の規則と TS の `gradientProblems` が 539 の形 (向き・大きさ・止めの組み合わせ) で同じ答え |
| L1 段 B の「文字を持つ」が `alt` を数えない | `alt` (自分のものも) と `aria-label` を数える | `img alt` を持つ地、`alt` を持つ `img` 自身、`aria-label`、空の `alt` は数えない |
| L2 既存の 9 枚のテストが確かめる幅だけ | 32px の掃引の 51 幅も見る (`legibilitySweep` と同じ開き方) | 9 枚すべて緑 |
| L3 止めの色のアルファを捨てる | 1回目は既知の振る舞いとして書いただけだった。2回目の M1 で、その記述が誤りと分かり直した (§8.9) | — |

**証明する範囲と、しない範囲**は §7 の最後の項に書いた (旗を立てたとき 320〜1920 の整数の CSS px の全部。1920 より広い幅と拡大率は証明しない)。

### 8.9 Fresh Review 2回目 (C0 / H0 / M1 / L3) の直し

| 指摘 | 直したこと | テスト |
|---|---|---|
| M1 アルファだけが変わる止めが止めの規則を素通りする | `gradientGround` の静的な文法で止めの色を不透明に限る (§8.3)。描画の側でもアルファが 255 でない止めを `GRADIENT_UNMEASURED` に。§8.4 の誤った記述を直した | `#000`→`transparent` (30px)、`#000 50%, transparent 50%` (300px)、`#0000`、`#00000000`、`#000e`、`rgba(0,0,0,.05)`、`rgb(0 0 0 / 0.5)`、`currentcolor`、`color-mix()`、`hsl`/`hsla`/`oklch`/`oklab` のアルファが静的に `CSS_VALUE`。生の HTML では描画が `GRADIENT_UNMEASURED`。`#000f`・`#ffffffff`・`rgb(0 0 0 / 1)` などの不透明は通る |
| L2 窓の高さが 900 に固定 | §7 の証明しないものに足した | — |
| L1 1920 より広い幅・小数の幅 | §7 の書き方を確かめた (そのまま) | — |
| L3 `PHASE_B_UNMEASURED` の道にテストが無い | 数え方を純粋な関数 `unmeasuredWidths` (`render.ts`) に出し、`displaySweepPass` がそれを使う。本番の options に口は足していない | 短い数・0・負の数・長すぎる数・どの実行も頼まなかった幅・空、それが `phaseBCheck` を落とすこと |

旗を下ろしたときの静的な一致: develop の `page-css.ts` と、旗無しと `{ verticalName: true }` で 1,200,034 回比べて差 0 (リポジトリの CSS 36 本の全体と規則ごと、宣言 2,864、性質 305 × 値 1,946 の組み合わせ。値には新しいアルファの形も入れた)。


**merge 後の L1 (DEV-169) は閉じた:** `displaySweepPass` から `unmeasuredWidths` を呼ぶ行にテストが無かった (行を消しても全部緑だった)。`phase-b.test.ts` に、1920 を越える `range` (`[1916, 1923]`、段の区切りは 1920 で止まるので 1921〜1923 はどの実行も測らない) で掃引を呼び、その3幅だけが `PHASE_B_UNMEASURED` になることを、根の幅を動かす測り方と実際の幅の変更の両方で確かめるテストを足した。その行を消すとこのテストが落ちる。本番のコードと options は変えていない (テストだけ)。
