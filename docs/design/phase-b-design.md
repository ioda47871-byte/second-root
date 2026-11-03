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
| `web_font` | 固定した書体のファイル (ハッシュで照らす) だけを `@font-face` で読む | 前提。字形を固定しないと、ほかの検査の結果が機械ごとに揺れる (DEV-083 §7「書体の固定は重ねより前」) |
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

- **文法:** `@font-face { font-family: <固定の一覧の名前>; src: local(<同じ名前>); font-display: block; }` だけ。
  - `url()` は使わない。書体のファイルは、ページの外の固定の道 (リポジトリ内、sha256 の一覧つき) から描画の側が読み込む。
  - `unicode-range`・`font-feature-settings` の文字の差し替えは拒否する。
- **役割:** すべて。
- **検証:**
  - sha256 の一覧と照らす。一覧の変更には人の承認が要る (数字を描き替える記号の書体を足せないように)。
  - 書体ごとに許諾と出所を記録する。
  - V10 の攪乱の pass と一緒に入れる。
- **落ちるべき例:**
  - 一覧に無い名前
  - `src: url(...)`
  - `unicode-range`
  - 一覧の名前でもハッシュの違うファイル
  - `@font-face` を `@media` の中に入れる

### 2.2 `display_scale` (N3 を含む)

- **名前:** DEV-083 §7 は `type_scale` と呼んだ。しかし `type_scale` は、すでに spec の欄の名前である (`spec.ts` の `type_scale: { display_px, … }`、`checks.ts` の大きさの検査)。能力の名前と spec の欄が同じだと、grep の検査も人の読みも混ざる。だから能力の名前は `display_scale` にする。

- **文法:** `font-size` の上限を、表示語の役割で 640px まで上げる。spec の `type_scale.display_px` の範囲 (今は 16〜160) も、旗が立ったときだけ広げる (旗無しの spec の検査は変えない)。ほかの役割は今のまま (256px まで、下限 12px は変えない)。
- **役割:**
  - `content` のうち、spec が表示語 (店名の飾り、固定のラベル) と宣言し、DOM の文字が店名か固定のラベルと一致する要素だけ。
  - 事実の値・免責・情報の組には付けない。
- **検証:**
  - `typeCheck` の上限を役割ごとにする。
  - `TEXT_BOX_OVERFLOW` と横のはみ出しの掃引は今のまま。
  - 語の途中の改行の検査を足す (`fidelity-measure.ts` の words_broken と同じ考え方を、本番の検査に写す)。
- **落ちるべき例:**
  - 事実の値の段落に 300px
  - 表示語と宣言したが、文字が事実の値
  - 640px を超える値
  - `calc()` で上限をすり抜ける値

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
  - 「文字の下に来ない」ことを、描画した箱で確かめる (V4 の簡易版。重なれば段 C の事柄として拒否する)。
- **落ちるべき例:**
  - 文字の段落の背景
  - 文字を含む区画の背景
  - 止めの急な帯 (`GRADIENT_HARD_STOP`)
  - `url()` を混ぜる
  - `repeating-linear-gradient`

### 2.5 `translucent_decoration`

- **文法:** `opacity` 0.1〜1 を `decoration`・`ground`・`media` に付ける。
- **検証:**
  - 文字の不透明度の積 ≥ 0.85 は変えない。
  - 半透明の要素が文字の箱に重ならないことを描画で確かめる。
  - 重ねの文脈を作るので、V2 の描く順で確かめる。
- **落ちるべき例:**
  - 文字を含む要素の opacity
  - 半透明の地が文字の下に来る

### 2.6 `image_filters`

- **文法:** `filter` の一覧の関数を、範囲つきで1つずつ使う (`blur` ≤ 8px など、値は段 B の PR で決める)。
- **役割:** `media`・`decoration`。文字の下でないこと。
- **検証:**
  - 静的な範囲の検査。
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
  - 段 A の疑似要素の幾何の検査 (`PSEUDO_GEOMETRY_UNKNOWN`)。
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
4. **今の worker の道** (`scripts/sales-design-worker/`) は、段 B の能力の名前を1つも参照しない。これをテストで固定する (§5)。

## 4. 測る費用

DEV-083 §6 と §10 の「measured costs」と同じ方法で、Chromium 1194 の手元の容器で3回測り、最も良い値を取る。

| 能力 | 足す仕事 | 測るもの |
|---|---|---|
| `web_font` | 書体の読み込み、V10 の攪乱 (字幅を変えて再描画) | 1ページあたりの描画の時間の増え |
| `display_scale`・N2 | 語の折れの検査、1px の掃引 | 掃引の幅の数 × 1幅の時間 |
| `gradient_ground`・`translucent_decoration`・`image_filters` | 描画した箱と文字の箱の交わり | 1ページの DOM の歩き |
| `ornament` | 疑似要素の幾何 (段 A にある) | 増えなし (確かめる) |

CI の時間の予算 (unit の shard の増え) は、段 B の実装の PR で表にする。

## 5. 互換性 (旗が下りているあいだは何も変わらない)

`tests/unit/design-agent/comp-impl/phase-b-baseline.test.ts` が、**今の振る舞い**を固定する。段 B の実装の PR は、旗を下ろしたままでこのテストを通し続けなければならない。

- 段 B の落ちるべき例の宣言が、今はすべて拒まれる (旗無しでも、`{ verticalName: true }` でも)。
- 今許されている宣言は、今のまま許される。
- `PageCssOptions` の鍵は `verticalName` だけである (旗は能力ごとに増える。増えたら、このテストを意図して直す)。
- `CAPABILITY_NAMES` は `["vertical_name"]`、`APPROVED_CAPABILITIES` は `[]` である。
- 本番の道 (`scripts/sales-design-worker/` と `lib/design-agent/comp-impl/run.ts`) は、段 B の能力の名前を参照しない。`type_scale` は spec の欄の名前として今も使われているので、この検査では探さない (§2.2)。

## 6. 進め方

1. **この PR (DEV-161):** 設計と、今の振る舞いを固定するテストだけ。
2. **段 B の実装の PR (未着手):**
   - 能力の名前、旗、検査、落ちるべき例、費用の実測を入れる。`APPROVED_CAPABILITIES` は空のまま。
   - CI と独立 Fresh Review を通し、merge の前にオーナーの承認を得る。許可一覧の変更を含むので、事前承認の外である。
3. **有効にする PR:** `APPROVED_CAPABILITIES` に名前を足す1行と、その能力を使う研究用のページの比較画像。オーナーの承認が要る。
4. 段 C、N1、段 D は、それぞれ別の設計と PR とする。

## 7. オーナーに判断してもらうこと (段 B の実装の PR のとき)

- `web_font` に入れる書体の一覧 (許諾つき)。
- `image_filters` の値の範囲。
- 段 B の能力のうち、最初に有効にするもの。
