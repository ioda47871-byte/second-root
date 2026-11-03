# N1: 装飾の SVG を `<img>` の資産として許す — 研究 (DEV-162、Issue #193 コメント `6601921731` の 2)

2026-11-03。**設計・プローブ・安全の調査だけである。N1 を有効にしていない。**

- 本番の実装レーン (`lib/design-agent/comp-impl/` の `page.ts`・`page-css.ts`・`htmlSourceProblems`・資産の schema) は1行も変えていない。
- 検査器 `lib/design-agent/research/decoration-svg.ts` は、どのレーンからも import されていない。テストがそれを固定している (`tests/unit/design-agent/research/decoration-svg.test.ts` の isolation)。
- **N1 は、段 C (DEV-083 の V2 描く順・V4 守る文字に触れない) が通る前に有効にしてはならない。**

## 1. 何を許したいか

3店の忠実な実装 C の核は、文字を持たない大きな装飾の図だった (`expressive-allowlist-proposal.md` の N1)。

- つぐ手: 器の割れ目を通る金の線 (`path` 1本)
- 輪: 車輪のタイヤ・リム・放射状のスポーク (`circle` と `line`)
- ゆげ湯: 2つの山 (`polygon`)

これを次の形でだけ許す、というのが N1 である。

- 1つの SVG を1つのファイルにする。ページは `<img src="assets/<name>.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer">` でだけ置く。
- 役割は `decoration` だけ。文字を持たない。
- `assets.json` に記録する (ハッシュ・大きさ・寸法・資産 id・種類・役割)。
- **インラインの `<svg>`、外の URL、CSS の `url()` の緩め、JS、通信は、どれも許さない。**

## 2. 仕様 (検査器が実際に検めること)

検査器は**消毒しない。** ファイルを書き換えず、1つでも外れたら拒む。

### 2.1 バイト

| 規則 | 理由 |
|---|---|
| ASCII だけ (0x20〜0x7E と tab・LF・CR) | BOM・UTF-16・全角の `<` などの符号化の手口を、解釈の前に断つ |
| 256 KiB まで | 大きすぎる図と、解析の負荷 |
| 空のファイルは拒む | |

### 2.2 字句

| 規則 | 結果 |
|---|---|
| XML 宣言は `<?xml version="1.0"` (+ `encoding="UTF-8"`、`standalone`) だけ | 他の符号化の宣言は拒む |
| それ以外の `<?` (処理命令、`xml-stylesheet`) | 拒む |
| `<!DOCTYPE` `<!ENTITY` `<!ELEMENT` `<!ATTLIST` | 拒む (DTD・実体。billion laughs の前提を断つ) |
| `&` (実体参照・文字参照) | 拒む (`&#40;` で `url(` を隠すなどの手口) |
| CDATA | 拒む (CDATA に隠した script) |
| コメント | **拒む** (下の 2.6) |
| 要素の間の空白でない文字 (文字の内容) | 拒む (文字を持たない) |
| ルートの後の要素 | 拒む |
| 属性は `名前="値"` か `名前='値'`。引用無し・重複は拒む | |
| タグ名の前の空白 (`< svg`)、`</` の直後の空白 (`</ g>`)、閉じていないタグ・要素 | 拒む (形が崩れたもの)。閉じタグの名前の**後ろ**の空白 (`</g >`) は XML どおり許す |
| `constructor`・`toString`・`__proto__` のような名前の要素・属性 | 知らない名前として拒む (例外を投げない。表の引きは自分の属性だけ、属性は `Map` に持つ) |

### 2.3 要素 (大文字小文字を区別、接頭辞無し)

| 要素 | 置ける場所 |
|---|---|
| `svg` | ルートだけ (入れ子は拒む) |
| `g` | `svg`・`g` |
| `defs` | `svg` |
| `path`・`line`・`polyline`・`polygon`・`rect`・`circle`・`ellipse` | `svg`・`g` |
| `linearGradient`・`radialGradient` | `defs` |
| `stop` | グラデーション |

これ以外はすべて拒む。例: `script`・`SCRIPT`・`style`・`text`・`tspan`・`textPath`・`title`・`desc`・`metadata`・`foreignObject`・`image`・`use`・`symbol`・`a`・`filter`・`mask`・`pattern`・`clipPath`・`marker`・`switch`・`animate*`・`set`・`iframe`・`svg:script` のような接頭辞付き。

- `title`・`desc` は文字を持つので拒む。図は `aria-hidden` の装飾なので、要らない。

### 2.4 属性

要素ごとに許す属性の表と、属性ごとの値の文法がある (`decoration-svg.ts` の `ELEMENTS`)。

- 形: `d` (パスの命令の文字と数だけ)、`points`、`x`・`y`・`cx`・`r` など (数か `px`・`%`)
- 塗り: `fill`・`stroke` (色、または下の `url(#id)`)、`stroke-*`、`opacity`・`fill-opacity`・`stroke-opacity`、`fill-rule`、`vector-effect`、`shape-rendering`
- `transform` (`matrix`・`translate`・`scale`・`rotate`・`skewX`・`skewY` と数だけ)
- `id` (英字で始まる 41 字まで)
- ルートだけ: `xmlns` (SVG の名前空間だけ)、`width`・`height`・`viewBox`・`preserveAspectRatio`
- グラデーション: 座標、`gradientUnits`・`gradientTransform`・`spreadMethod`。`stop` は `offset`・`stop-color`・`stop-opacity`

必ず拒むもの:

- `on*` (大文字小文字を問わない)
- `href` を含むすべての属性 (`href`・`xlink:href`・別の接頭辞に付け替えた `q:href`、グラデーションの `href` の継承も)
- `:` を含むすべての属性 (`xml:base`・`xml:space`・`xmlns:xlink` など)。**名前空間の宣言そのものを許さない**ので、xlink の別名を作れない
- ルート以外の `xmlns` (名前空間の切り替え)
- `style`
- `class` (ページの CSS に頼る形は、単体のファイルとして描けない)
- `mask`・`filter`・`clip-path`・`marker-*` (参照を作る属性)

### 2.5 `url(` の例外 (決めたこと)

**`fill` か `stroke` の値の全体が `url(#id)` で、その id が同じファイルの `linearGradient` か `radialGradient` であるときだけ許す。**

理由:

- ゆげ湯の山・温度計の帯・器の釉は、グラデーションで描かれている。グラデーションを許さないと、N1 で戻したい形の多くが戻らない。
- 断片の参照 (`#id`) は文書の外へ出られない。引用・別のファイル・`http:`・大文字の `URL(`・代わりの色付き (`url(#g) red`)・`stop-color` の中は、すべて拒む。
- 参照先が無い id、グラデーションでない id (`g` など) も拒む。
- `<img>` で読んだ SVG は、ブラウザがそもそも何も読み込まない (下の 4)。だから、この例外は二重の守りの片方だけを緩める。

### 2.6 コメントの方針 (決めたこと)

**拒む。** 理由:

- 図に要らない。
- コメントの中に、別の解析器が違う読み方をする文字列 (`--`、`-->` の前の `<script>`) を隠せる。
- 作る道具がコメントを残すなら、取り除いてから記録する (検査器は書き換えないので、作る側で除く)。

### 2.7 大きさ

| 上限 | 値 |
|---|---|
| ファイル | 256 KiB |
| 要素の数 | 4000 |
| 入れ子の深さ | 24 |
| 1要素の属性の数 | 24 |
| 1つの値の長さ | 64 KiB |
| `width`・`height` | 必須、px か単位無し、0 より大きく 4096 まで |
| `viewBox` | 必須。幅と高さ (3つ目と4つ目の数) は 0 より大きいこと。0 や負は拒む (`SVG_VIEWBOX`) |

### 2.8 資産のファイル (`checkDecorationAssetFile`)

- 名前は `assets/<小文字・数字・ハイフン>.svg` だけ。`..`・絶対パス・`\`・`%2e`・大文字の拡張子・入れ子は拒む。
- 資産の id は `^[a-z0-9][a-z0-9-]{0,63}$` だけ (`ASSET_ID`)。
- ファイルと、途中のディレクトリ (`assets` 自体も) が symlink なら拒む。実パスがページのディレクトリの中であることも確かめる。
- **ハードリンクを拒む** (`nlink > 1` で `ASSET_HARDLINK`)。同じ中身にページの外から別の名前が付いていると、外から書き換えられる。
- バイト数・sha256・寸法が記録と一致し、検査器を通ること。
- 種類は `decoration_svg`、役割は `decoration` だけ。
- **例外を投げない。** 記録の値の型が違う、ファイルの中身が敵対的、などはすべて符号で返す (想定外は `ASSET_CHECK_ERROR`)。検査器 `checkDecorationSvg` も同じ (`SVG_CHECK_ERROR`)。
- 既知の Low: lstat の検査と読み込みの間にファイルを差し替えられる (TOCTOU)。読んだバイト列の sha256 を記録と照らすので、差し替えは検査を落とすだけで、別の中身を通すことはできない。

### 2.9 ページの側 (`decorationReferenceProblems`)

HTML のタグと属性を、ブラウザと同じ区切りで読む小さな字句解析器を持つ (二重引用・一重引用・引用無しの値、名前は ASCII の大文字小文字を区別しない、`/` は区切り、重複した属性は最初のものが効く。コメント・`<!…>`・`<?…>` は飛ばす。`script`・`style`・`textarea`・`title` などは中身を文字として読む。`noscript` はマークアップとして読む — 描画は JS 無効だから)。そのうえで次の方針を取る。

- **SVG を指してよいのは、`<img src="記録した資産のパスそのもの">` だけ。** その `img` は、解析した属性として `alt=""`・`aria-hidden="true"`・`referrerpolicy="no-referrer"` を持つ (`SVG_IMG_NOT_DECORATIVE`・`SVG_IMG_REFERRER`)。別の属性の値の中に書いた `aria-hidden="true"` は数えない。
- 値は、HTML の文字参照 (数値と小さな名前の表)・CSS のエスケープ (`\67`)・`%XX` を1段ほどき、tab・改行を除き、`\` を `/` にし、小文字にし、`./` `../` を解いた読みでも照らす。表に無い `;` 付きの名前の参照は拒む (`PAGE_ENTITY`)。
- どの要素のどの属性でも、値が記録した資産 (拡張子無しの `assets/seam` も)・`.svg`・SVG の media type を指していたら拒む。`img` の `src` なら `SVG_NOT_RECORDED`、それ以外 (`srcset`・`<picture><source>`・`<a href>`・`<link rel="preload">`・`<input type="image">`・`<image>`・`<table background>`・`<video poster>` など) は `SVG_REFERENCE_NOT_IMG`。`script` などの文字の中身に書いても拒む。
- `<svg` は、どの形でも拒む (`<svg/>`・`<svg/class="x">`・大文字・コメントの中も。`INLINE_SVG`)。`<object>`・`<embed>`・`<iframe>`・frame 類も拒む (`SVG_EMBEDDED_NOT_IMG`)。
- `data:` はどの属性でも拒む (`PAGE_DATA_URL`)。絶対 URL・プロトコル相対 (`//`・`\\`)・URL の属性の先頭のスキーム (`javascript:` など) も拒む (`PAGE_ABSOLUTE_URL`)。
- `style` 属性・`<style>`・ページの CSS の中の `url(`・`image-set(`・`image(`・`@import` などは、指す先を問わず拒む (`CSS_URL`)。CSS の中で SVG を指すと `SVG_FROM_CSS` も付く。コメントで割った `ur/**/l(` も拒む。
- 重複した属性 (`PAGE_ATTRIBUTE_DUPLICATE`)、入力が途中で終わるタグやコメント (`PAGE_MALFORMED`) も拒む。
- 記録の側: 使っていない資産 (`SVG_RECORDED_NOT_USED`)、名前の形 (`SVG_FILE_NAME`)、id の形 (`ASSET_ID`)、同じ id・同じファイルの二重の記録 (`ASSET_ID_DUPLICATE`・`ASSET_FILE_DUPLICATE`)。
- 本番の `htmlSourceProblems` は、このうち多く (`<svg`・`<object>`・`style`・`data:`・`https:` など) をすでに拒んでいる。**この研究の検査器は、それに頼らず自分で拒む。**
- **これはソースの文字列の走査で、研究の形である。** 本番では、今の `htmlSourceProblems` と DOM の検査に組み込む必要がある (5 を見よ)。

## 3. 脅威のモデル

| 脅威 | 守り |
|---|---|
| SVG の中の script・イベント属性が動く | 要素と属性の許可一覧。`<img>` の画像モードはそもそも script を動かさない。描画は JS 無効 |
| SVG から外へ通信する (`<image>`・`<use>`・`style` の `@import`・`url()`・`xml-stylesheet`・`foreignObject`) | 要素・属性・`url(`・処理命令の拒否。`<img>` の画像モードは外を読まない。描画の routing も外を拒む |
| 解析器の食い違い (大文字、接頭辞、実体、CDATA、BOM、UTF-16、コメント) | ASCII だけ、`&`・CDATA・コメント・DTD の拒否、大文字小文字の区別 |
| 実体の膨張 (billion laughs) | DTD と `&` を拒む |
| `xml:base`・xlink の名前空間の別名 | `:` を含む属性と `xmlns:*` を拒む |
| 文字を図に描いて、事実の検査を逃れる (`text`・`title`) | 文字の要素と文字の内容を拒む。**パスで文字の形を描くことは止められない** (5 を見よ) |
| 図が箱の外に描かれ、文字に重なる | `<img>` の箱で切り取られる (プローブで確かめた)。箱そのものの重なりは段 C の V2/V4 で検める |
| symlink・ハードリンク・パスの横断で、ページの外のファイルを資産にする | 名前の形、symlink とハードリンク (`nlink > 1`) の拒否、実パスの確認 |
| 検査器を例外で止める (`constructor`・`__proto__` のような名前、型の違う記録) | 自分の属性だけを引く表と `Map`。例外は捕まえて符号にする |
| ページで SVG を `<img>` 以外から読む (`srcset`・`poster`・`background`・`<link>`・CSS・エスケープや実体で隠した `.svg`) | 字句解析した全属性・`style`・`<style>`・CSS を、ほどいた読みで照らす (2.9) |
| SVG の要求に Referer を付けて送る | 装飾の `img` に `referrerpolicy="no-referrer"` を必須にする (資産はページと同じ場所なので、主に将来の取り違えへの備え) |
| 記録と違うファイルにすり替える | sha256・バイト数・寸法の照合 |
| 巨大なファイル・深い入れ子で検査や描画を重くする | 大きさ・要素の数・深さの上限 |

## 4. 確かめたことと、確かめていないこと

**確かめたこと (テスト):**

- 3店の C の図の形 (割れ目の線・スポークの車輪・グラデーションの山) を単体のファイルにしたものが通る。
- 落ちるべきプローブ 90 件以上が、それぞれ決まった符号で落ちる (DTD・billion laughs・実体・CDATA の script・コメント・処理命令・`SCRIPT`・`text`・`title`・`foreignObject`・`image`・`use`・`a`・`filter`・`animate`・`set`・接頭辞・入れ子の `svg`・`on*`・`href`・`xlink:href`・xlink の別名・`xml:base`・子の `xmlns`・`style`・`class`・別のファイルや http への `url()`・グラデーションでない参照・`data:`・BOM・UTF-16・全角・NUL・深さ・要素の数・属性の数・大きすぎるファイル など)。
- 資産のファイル: symlink (ファイルと `assets` ディレクトリ)・ハードリンク・パスの横断・id の形・ハッシュ・大きさ・寸法。敵対的な記録や中身で例外を投げないこと。
- ページの側: Fresh Review が挙げた入力すべて (一重引用・引用無しの `src`、`<picture><source srcset>`、`<svg/>`・`<svg/class>`、記録した資産の `<a href>`・`<link rel=preload>`・`<input type=image>`、`style` と `<style>` の `url()`、`<table background>`、`<video poster>`、CSS のエスケープ `\67`、`data:image/svg+xml`、拡張子無しの `assets/seam`、別の属性の値に書いた装飾の印、`title=">"`)。
- **Chromium のプローブ** (JS 無効・Service Worker 無効・ページのディレクトリ以外への通信を拒否・`<img>` で読む):
  - 3つの図は、`<img>` の箱の中にだけ描かれ、箱の外のインクは 0 だった。山の多角形は viewBox の外 (x = -60 と 780) まで伸びているが、箱で切られた。
  - 読み込まれたのは、ページと SVG の2つだけだった。
  - 検査器が拒む敵対的な SVG (`onload`・`<style>@import`・`<image href="http:">`・`xlink:href`・`<use href="http:">`・`<script>fetch`・`foreignObject` の `<img>`) を `<img>` で読ませても、**外への要求は 0 件**で、拒否する必要すら無かった。

**確かめていないこと:**

- **パスで描いた文字の形。** `path` で「本日半額」の形を描けば、検査器は通す。文字の要素は拒むが、形が文字に見えるかは構文では分からない。本番で有効にするなら、資産を人が見る承認か、描画した資産の OCR の検査が要る。
- 他のブラウザ (WebKit・Firefox) の画像モードの振る舞い。プローブは Chromium だけである。
- ページの中での重なりと描く順。`<img>` の箱が守る文字に重なるかは、段 C の V2/V4 の仕事で、ここでは検めていない。
- 本番の HTML の検査への組み込み。`decorationReferenceProblems` は文字列の走査で、DOM での検査ではない。字句解析器は HTML の仕様の全部ではない (名前の文字参照は小さな表だけを解き、表に無いものは拒む。拡張子も記録も指さない、ページの中の別の名前のファイルを SVG として配る経路は、資産の検査の側の仕事)。
- 生成の道 (worker や Codex を経た道) で SVG が作られる流れ。どこにも繋いでいない。

## 5. 有効にする前の確認 (すべて必要、オーナーの承認が要る)

1. [ ] 段 C (DEV-083 の V2 描く順・V4 守る文字に触れない) が merge され、gate として効いている。**C が通る前に N1 を有効にしない。**
2. [ ] `decoration_svg` を資産の schema に足す別 PR。旗無しの結果が今の全プローブで不変であることをテストで固定する。
3. [ ] 能力の旗は、spec の宣言だけで立たない。オーナーが承認した能力の表と照らす (`expressive-allowlist-proposal.md` 3(3))。今の worker の道 (`scripts/sales-design-worker/`) が旗を渡さないことをテストで固定する。
4. [ ] `htmlSourceProblems` は、インラインの `<svg>` を拒むままにする。`<img>` の `src` は、記録した `decoration_svg` の資産だけに広げる。DOM でも検める (`<img>` の役割が `decoration` であること、`alt=""`・`aria-hidden="true"`・`referrerpolicy="no-referrer"`)。
5. [ ] CSS の `url()` の拒否 (`CSS_SYNTAX_URL`) は変えない。
6. [ ] 描画は JS 無効・通信の拒否のまま。拒否した数を報告に残す。
7. [ ] パスで描いた文字への対策を決める (資産を人が見る承認か、OCR)。
8. [ ] 独立の Fresh Review と、最新の head の CI。
9. [ ] **merge の前に、オーナーの承認。** この文書と DEV-162 は、有効にする承認ではない。

## 6. 決めたこと・聞きたいこと

- 決めたこと: `url(` は同じファイルのグラデーションへの `fill`・`stroke` だけ。コメントは拒む。`title`・`desc` は拒む。`class` は拒む。
- オーナーに聞きたいこと:
  1. パスで描いた文字の形を、どう止めるか (人が見る承認か、OCR か)。
  2. `transform` の `skewX`・`skewY` は要るか (今は許しているが、3店では使っていない)。
