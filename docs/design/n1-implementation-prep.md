# N1 の実装準備: 装飾の SVG を `<img>` に限り、段 C の文字の守りと結ぶ (DEV-174、Issue #193 コメント `6628165899`)

2026-11-04。**準備と、テストの中だけの試作による検証の記録である。N1 は有効にしていない。有効にする承認でもない。**

- `lib/design-agent/comp-impl/**` (本番の実装レーンと CSS ゲート) の差は 0 行。`APPROVED_CAPABILITIES` は `[]` のまま。`CAPABILITY_NAMES` に N1 の名前を足していない。
- 足したのは研究のモジュール `lib/design-agent/research/decoration-review.ts` (どのレーンからも import されない。テストで固定) と、テスト2本 (`tests/unit/design-agent/research/n1-owner-review.test.ts`・`n1-phase-c-join.test.ts`) である。`decoration-svg.ts` は関数を2つ export しただけで、挙動は変えていない。
- **オーナーの目視の記録は、リポジトリに1つも無い。** 承認 (`approved`) の記録は、テストのメモリの中の印付きの fixture だけである。Claude はどの資産も承認済みにしていないし、できない (§3)。
- **DEV-174 は DEV-173 (段 C の研究、PR #213、develop に merge 済み `7f5e2ac`) に依る。** merge されたのは研究 (テストの中の試作と設計) であり、段 C の lib の変更 (`phase-c-design.md` §8) は HOLD のまま。段 C が本番の道で通り、オーナーが承認するまで、N1 を ON にしてはならない。

土台: `docs/design/n1-decoration-svg.md` (DEV-162・DEV-165: 構文の検査・ページの許可一覧・sha256・`owner_visual_review`・他のブラウザのプローブ・§7 の C-1〜C-8)、`docs/design/phase-c-design.md` (DEV-173: V2 描く順・V4 守る文字・板・1px の掃引)、`tests/unit/design-agent/comp-impl/overlap-harness.ts` (段 C の試作。develop `7f5e2ac` の最終版: 字形の箱は墨の箱、測れない字形・フィルターは fail closed、落ちるべき 43 例・通るべき 9 例)。

## 0. 先に結論

- **用意できたもの:** (1) 装飾は `<img>` に限る検査 (DEV-162・165 のまま)。(2) N1 の `<img>` を段 C の描画の検査に通す「結合」の試作 (テストの中)。(3) 資産ごとのオーナーの目視の記録 (schema 2: 資産の sha256・描いた絵の sha256・描いた描画系・`pending`/`approved`/`rejected`・証明の口) と、記録の無い・`pending` の・証明できない資産を拒む検査。(4) WebKit・Firefox は **BLOCKED** (この container に無い)。プローブと絵の描き方はどの描画系でも動く形のまま。
- **試作が示したこと (Chromium 1194 だけ):** 落ちるべき `<img>` の置き方 10 (事実の上・負の margin で事実の上・板なしで事実の下 2・不透明でない板・普通の本文の上・板なしで普通の本文の下・事実を画面の外へ押し出す・**透明な部分で事実を覆う**・**幅で伸びて 899px で終わる1つの帯 (この container の書体で 849–899px) でだけ事実に届く**) がすべて落ちる。後の2つは、画素だけ・確かめる幅 12 だけでは見逃す。通るべき 4 (流れの中・溝の上・板の上の普通の本文・2つの資産) は、結合のすべての部分でコード 0、画素でもコード 0。幅で伸びても届かない版は、段 C の 1px の掃引 320〜1920 でコード 0。
- **見つけたこと (本番の不具合ではない):** 段 C の V4 は「守る文字の下の装飾は、不透明な板があれば通す」。今の run の幾何 (`FACT_IMAGE_OVERLAP`) は「どの `<img>` も守る文字の行に触れない」で、板があっても止める。`n1-decoration-svg.md` §7 C-2 は「段 C でこれを緩めない」と書いた。**結合はこの C-2 を残した** (板の上の事実の下の装飾は、段 C は通すが結合は止める)。どちらにするかはオーナーの判断 (§4 の 2)。
- **何も ON にしていない。** 記録の検査は、今どの資産も通さない (`N1_REVIEW_MISSING`・`N1_REVIEW_PENDING`・`N1_REVIEW_UNATTESTED` のどれか)。

## 1. 用意したもの

### 1.1 装飾は `<img>` に限る (DEV-162・DEV-165 の検査をそのまま使う)

変えていない。結合はこれらを部品として呼ぶ。

| 部分 | 何を拒むか | 場所 |
|---|---|---|
| SVG のファイル | 文字 (`text`・`title`・`desc`・文字の内容)、`script`・`style`・`foreignObject`・`image`・`use`・`a`・`filter`・`mask`・`pattern`・動き (`animate`・`set` …)、イベント属性、`href`・`xlink:href`、外への `url(`、DTD・実体・CDATA・コメント、ASCII 以外、`skewX`・`skewY` と名前の無い傾き | `checkDecorationSvg` (`decoration-svg.ts`) |
| 資産のファイル | 名前の形、symlink・hardlink・ディレクトリの外、記録と違うバイト数・sha256・寸法 | `decorationAssetFileProblems` (DEV-174 で export。中身は前からの `checkAssetFile`) |
| ページ | インラインの `<svg>` (`INLINE_SVG`)、記録に無い `<img>`、`alt=""`・`aria-hidden="true"`・`referrerpolicy="no-referrer"` の無い `<img>`、CSS からの読み込み (`CSS_URL`・`SVG_FROM_CSS`)、許可一覧の外の要素・属性 | `checkDecorationPage` |
| ブラウザ | 記録した資産の外への要求、DOM の食い違い (JS 有効と無効の2回) | `verifyDecorationPageInBrowser` (`decoration-page-browser.ts`) |

### 1.2 段 C との結合 (テストの中の試作)

`tests/unit/design-agent/research/n1-phase-c-join.test.ts`。ページを `http://n1-join.invalid/page/index.html` としてメモリから出し、記録した SVG だけをその隣に出す。ほかの要求はすべて中断して数える (どの例でも 0)。JS 無効、deviceScaleFactor 1、IPAGothic、800×600 (掃引は高さ 900)。

**結合 = 次のすべてが空のとき、そのときだけ通る:**

1. ページの許可一覧 `checkDecorationPage` (HTML とページの CSS)
2. 使う資産のすべてが `checkDecorationSvg` を通る
3. 段 C の提案の文法 `layeredCssProblems(css, { layeredDecoration: true })` (旗は試作の中だけ)
4. **今の run の幾何 `GEOMETRY_SCRIPT` (変えずに使う)**: どの `<img>` も守る文字の行に触れない (`FACT_IMAGE_OVERLAP`・`FACT_COVERED` …)。C-2 を残すため
5. 段 C の描画の検査 `overlapScan` (V2・V4、`grammar: true`、普通の本文は `plate`)。幅で変わるものは 1px の掃引 (`overlapSweep`)
6. 資産ごとのオーナーの記録 `checkN1Asset` (§1.3)

**`<img>` は箱で裁く。** ブラウザは画像のどこが透明かを教えない。だから透明な部分が字形に届いても「描くもの」と数える (fail closed)。インラインの SVG なら図形の線だけを見られる (`isPointInStroke`) が、N1 はインラインを許さないので、この粗さは N1 の代わりに払う費用である。

**落ちるべき例 (すべて、静的な部分 1〜3 は空。止めるのは描画の側。表の2つの列のコードは、どちらもテストが固定する):**

| 例 | 段 C (`overlapScan`) | 今の run の幾何 |
|---|---|---|
| 事実の上 (`position: absolute`、`z-index: 1`) | `OVERLAP_PAINT_ABOVE_PROTECTED` | `FACT_COVERED`・`FACT_IMAGE_OVERLAP` |
| 事実の上 (流れの中、負の margin で引き上げ) | `OVERLAP_PAINT_ABOVE_PROTECTED` | `FACT_COVERED`・`FACT_IMAGE_OVERLAP` |
| 事実の下、板なし (文字を `z-index: 2` に持ち上げ) | `OVERLAP_PROTECTED_ON_DECORATION` | `FACT_IMAGE_OVERLAP` |
| 事実の下、板なし (`isolation` の群の中の `z-index: -1`) | `OVERLAP_PROTECTED_ON_DECORATION` | `FACT_IMAGE_OVERLAP` |
| 事実の下、90% の白の板 (不透明でない) | `OVERLAP_PROTECTED_ON_DECORATION` | `FACT_IMAGE_OVERLAP` |
| 普通の本文の上 | `OVERLAP_PAINT_ABOVE_TEXT` | — (今の幾何は普通の本文を見ない) |
| 普通の本文の下、板なし | `OVERLAP_TEXT_ON_DECORATION` | — |
| `<img>` の後で事実を負の margin で画面の外へ | `OVERLAP_PROTECTED_OFFSCREEN` | `FACT_OFFSCREEN` |
| **透明な部分で事実を覆う** (つぐ手の継ぎ目。箱の 98% が透明で、線は事実の字から右に外れている) | `OVERLAP_PAINT_ABOVE_PROTECTED` のみ | `FACT_COVERED`・`FACT_IMAGE_OVERLAP` (同じく箱で止まる) |
| **幅で伸びる** (`width: 40%`、800px から事実が決まった溝の隣、900px から溝も割合) | 1px の掃引で **899px で終わる1つの帯** だけ `OVERLAP_PAINT_ABOVE_PROTECTED` (この container の書体で 849–899px。下の端は書体に依る) | 845〜905 の各幅で **852–899px** だけ |

- **透明な例は、画素の二重の守り (`pixelPass`) を通る** (`PIXEL_COVER_PROTECTED` なし、最悪の透過率 ≥ 0.97)。字の墨はそのまま画面に届くからである。止めているのは箱の規則であり、画素だけの検査に替えると通ってしまう。同じ置き方でも、事実が自分の不透明な板に乗れば段 C は通す (§0 の「見つけたこと」の例)。
- **幅で伸びる例は、確かめる幅 12 (1440・1280・1024・768・601・600・480・390・375・360・340・320) のどれでも落ちない。** 1px の掃引 (320〜1920 の 1,601 幅、約 20〜30 秒) だけが見つける。端は、ページを開き直した本物の大きさの変更でも同じ (テストは掃引の帯を、下の端の前後の各幅を開き直した結果と照らす)。今の run の幾何は行の箱を広げないので 852 から、段 C は守る字形の墨の箱を 1px 広げる (V4) ので、この container の書体では 849 から止める。**下の端 (849) は字形の墨 (サイドベアリング) に依るので、テストは固定しない。** 書体に依らない 899 (900px の media query の手前) と 852 (行の箱の左の端 340px に `<img>` の箱が届く幅、配置だけで決まる) を固定し、帯が1つで、852 を含み、800 以上で始まることを確かめる (CI の CJK の書体は違う)。
- 静的な部分は、描画の側が通すものを独立に止める: インラインの `<svg>` (`INLINE_SVG`)、`alt` のある `<img>` (`SVG_IMG_NOT_DECORATIVE`)、記録に無いファイル (`SVG_NOT_RECORDED`)、CSS の `background-image` での読み込み (`CSS_URL`・`SVG_FROM_CSS`)、`<text>` を持つ SVG。そのとき描画の側は同じページを通す (2つの半分は独立で、結合は両方を要る)。

**通るべき例 (結合のすべてでコード 0、画素でもコード 0):** 流れの中で文字から離れた `<img>` / 溝の上、上に描くが字形に届かない / 普通の本文が自分の不透明な持ち上げた板に乗り、その下の `<img>` / 2つの資産 (継ぎ目と車輪)。ほかに、幅で伸びる例の溝を 360px にした版は、段 C の 1px の掃引 (320〜1920) でコード 0 (掃引したのは段 C の検査だけ)。

**変異 (壊して確かめた。戻した):** 段 C の試作で `<img>` を「描くもの」から外すと、`<img>` に依る落ちるべき例 9 件がすべて落ちる (画面の外の例は `<img>` に依らないので残る)。`overlap-harness.ts` は変えていない (確かめた後に元へ戻し、`git status` で差 0)。develop `7f5e2ac` の最終版の試作でも同じ変異をやり直し、同じ 9 件が落ちた。

### 1.3 資産ごとのオーナーの目視の記録 (schema 2、`decoration-review.ts`)

DEV-165 の `owner_visual_review` (5つのキー、ファイルの sha256 に結ぶ) を広げる。足りなかったのは「オーナーが**何を**見たか」と「まだ見ていない」を書く場所と、「オーナーが書いた」ことの証明の口である。

```json
{
  "schema": "second-root/n1-owner-visual-review@2",
  "asset_id": "seam",
  "asset_file": "assets/seam.svg",
  "asset_sha256": "<読んだバイト列の sha256>",
  "preview": { "sha256": "<描いた PNG の sha256>", "renderer": "chromium/141.0.7390.37", "width": 100, "height": 100, "scale": 2, "background": "#ffffff" },
  "reviewer": "owner",
  "decision": "pending",
  "reviewed_at": null,
  "note": ""
}
```

(上は形の説明である。記録ではない。リポジトリの JSON のファイルには、この schema の名前は1つも無い。テストで固定。)

- **`preview`:** `renderN1Preview` が描く絵。そのバイト列だけを `<img>` で、記録の寸法ちょうど、倍率 2、白の上に描く。JS 無効、Service Worker 無効、ページと資産の外への要求は中断 (`N1_PREVIEW_UNEXPECTED_REQUEST`)。構文の検査を通らないファイルは描かない。寸法が違えば描かない (`N1_PREVIEW_SIZE`)。同じバイト列は新しい文脈で同じ sha256 になり、色を1つ変えれば変わる (テスト)。
- **`reviewer: "owner"`** は「見るべき人」であって、「見た」という主張ではない。
- **`decision`:** Claude (と worker・スクリプト) が書いてよいのは `pending` だけ (`pendingN1Review`)。`pending` は無いのと同じく拒む。

| 規則 | 拒む符号 |
|---|---|
| オブジェクトが無い | `N1_REVIEW_MISSING` |
| キーがちょうど9つでない | `N1_REVIEW_SHAPE` |
| `schema` が違う (DEV-165 の形も) | `N1_REVIEW_SCHEMA` |
| 別の資産の id・ファイル | `N1_REVIEW_ASSET` |
| `asset_sha256` が読んだバイト列のものでない、読めなかった | `N1_REVIEW_ASSET_SHA256` |
| `preview` のキー・倍率・背景が違う | `N1_REVIEW_PREVIEW_SHAPE` |
| 今描いた絵の sha256 と違う、描けなかった | `N1_REVIEW_PREVIEW_SHA256` |
| 別の描画系で描いた (Chromium の版が変われば、見直す) | `N1_REVIEW_PREVIEW_RENDERER` |
| 別の寸法で描いた | `N1_REVIEW_PREVIEW_SIZE` |
| `reviewer` が `owner` でない | `N1_REVIEW_REVIEWER` |
| `pending` | `N1_REVIEW_PENDING` |
| `rejected` | `N1_REVIEW_REJECTED` |
| 3つのどれでもない | `N1_REVIEW_DECISION` |
| `pending` なのに日付がある、決めたのに実在する過去の日付が無い | `N1_REVIEW_DATE` |
| `note` が文字列でない、500 字を超える | `N1_REVIEW_NOTE` |
| **`approved` だが、オーナーが書いたことを証明する検証器が無い・否と言う・例外を投げる** | `N1_REVIEW_UNATTESTED` |

- **証明の口 (`attest`):** 検証器は記録を受け取り、真偽を返す。記録の中身はすべて主張なので、検証器は記録の外 (GitHub の API・署名など) で確かめる。**どう確かめるかは、オーナーの判断で、まだ無い** (§4 の 1)。既定の `NO_ATTESTATION` は常に否で、今はどの `approved` の記録も通らない。テストの中で「常に真」の検証器を使うのは、道の形を示すためだけである (印付きの fixture)。
- `checkN1Asset(browser, dir, asset, record)` = 資産のファイルの側 + 記録。**絵は `checkN1Asset` 自身が、読んだその同じバイト列から `renderN1Preview` で資産の記録の寸法に描く。** 呼ぶ側は絵も sha256 も渡さない (Fresh Review M1: 前は呼ぶ側が「今描いた絵」を渡し、記録の `preview` をそのまま渡せば照合が必ず通った)。記録の絵の sha256・描画系・寸法が今描いた絵と違えば拒む。ファイルの寸法が資産の記録と違えば描かず (`N1_PREVIEW_SIZE`・`ASSET_DIMENSIONS`)、記録は結べない。両方が空のときだけ通る。`n1ReviewProblems` は下の段の関数で、結び先 (binding) を呼ぶ側から受け取る。run は使わない。
- 検証器に渡すのは、検めた9つの欄の**凍結した素の写し**である (呼ぶ側の生きた記録ではない。getter は1度だけ読み、検査と写しは同じ値を見る。Fresh Review L5)。
- テストが固定する守り: モジュールは `decision` に `approved`・`rejected` を書くコードを持たない / 検証器は `NO_ATTESTATION` (常に否) の1つだけ / schema の名前はモジュール・研究のテスト・この文書・`.ai/reviews/DEV-174.md` にしか出ない / JSON のファイルのどれにも無い / lib・tests・scripts のうち N1 の記録に触れるすべてのファイルで、`approved`・`rejected` の記録はテストの中だけにあり、すべて `TEST FIXTURE - not an owner review` の印 (または印を持つ fixture の関数) の近くにある / モジュールは `as N1Attestation`・`satisfies`・`<N1Attestation>` で検証器を作らず、ほかの lib のファイルは `N1Attestation` を名指さない (Fresh Review L4)。

### 1.4 他のブラウザ

| 描画系 | 結果 |
|---|---|
| Chromium 141.0.7390.37 (`/opt/pw-browsers/chromium-1194`) | プローブ (`n1-browser-probe.ts`) 終了 0、`pass`。結合とプレビューのテストも緑 |
| WebKit | **BLOCKED** (プローブ 終了 2: `Executable doesn't exist at /opt/pw-browsers/webkit-2336/pw_run.sh`)。入れることは許されていない |
| Firefox | **BLOCKED** (プローブ 終了 2: `Executable doesn't exist at /opt/pw-browsers/firefox-1538/firefox/firefox`)。同じ |

- プローブはそのまま走る形 (`n1-decoration-svg.md` §4.1 のオーナーの WSL の手順)。`renderN1Preview` は `Browser` を受け取るだけなので、WebKit・Firefox でも描ける (`renderer` に描画系の名前が入り、別の描画系の絵は別の記録になる)。**段 C の検査は Chromium の当たり判定に頼る** (`phase-c-design.md` §3.4) ので、他の描画系での描画の順の一致は別に確かめる必要がある (§6)。

## 2. 確かめたこと (数)

| テスト | 件数 | 時間 (この container) |
|---|---|---|
| `n1-owner-review.test.ts` (新) | 51 | 約 10 秒 |
| `n1-phase-c-join.test.ts` (新) | 19 | 約 70 秒 (1px の掃引 2 本) |
| `decoration-svg.test.ts` (隔離の一覧に新しいモジュールを足した) | 322 | |
| `decoration-n1-verification.test.ts` (記録の名前を書いてよいファイルに、新しいモジュール・この文書・DEV-174 のレビューを足した) | 88 | |
| research のほかの4本 | 13・9・9・7 | |
| `comp-impl/phase-c-overlap.test.ts` (変えていない。develop `7f5e2ac` の最終版) | 74 | 約 15 分 |

変異 (記録の検査、`n1-owner-review.test.ts` で): 既定の検証器を「真」にする・絵の sha256 を見ない・`pending` を通す・資産の sha256 を見ない・描画系を見ない・例外を投げる検証器を真と数える の 6 つのすべてで 1〜4 件落ちる。Fresh Review M1 の後: `checkN1Asset` が自分で描かずに記録の `preview` を結び先に使う変異で、4 件落ちる (戻した)。

## 3. してはならないこと (この PR も、後の PR も)

- Claude・worker・スクリプトは、記録の `decision` を `approved`・`rejected` にしない。`reviewed_at` を埋めない。チャットのオーナーの言葉を記録に写さない。オーナーの代わりに検証器を「真」にしない。
- 承認の記録を、この公開リポジトリに Claude が commit しない。
- N1 を ON にしない (`APPROVED_CAPABILITIES` に足さない)。段 C が通り、オーナーが承認するまで。

## 4. オーナーの判断が要ること

> **オーナーの判断が要る (未承認)**
>
> 1. **記録をオーナーが書いたことの証明。** 候補: (a) オーナーのアカウントが、記録を足す PR を GitHub で approve し、hosted の job が API でその approve の主と記録の sha256 を照らす / (b) オーナーのアカウントの Issue のコメントに、資産と絵の sha256 を書き、hosted の job が API でコメントの主を確かめる / (c) オーナーの鍵の署名 (公開鍵はリポジトリ、秘密鍵はオーナーの機械だけ) / (d) オーナーだけが書ける置き場 (CODEOWNERS と branch の保護。今の develop には保護が無い)。どれも検証器 (`N1Attestation`) の中身になる。今は無いので、何も通らない。**あわせて、検証器を今のように引数で受けるか、モジュールの中に固定するか** (引数なら、呼ぶ側が「常に真」を渡せる。固定なら、呼ぶ側は変えられない。Fresh Review L5 の残り。Claude は固定を勧める)。
> 2. **守る文字の下の装飾:** 段 C の V4 の板の例外を N1 の `<img>` にも認めるか、C-2 (`FACT_IMAGE_OVERLAP`: どの `<img>` も守る文字に触れない) を残すか。**Claude は C-2 を残すことを勧める** (緩めない向き)。認めるなら、本番の幾何の門を狭める変更で、明示の承認が要る。
> 3. **箱で裁くこと:** `<img>` の透明な部分も「描くもの」と数え続けるか (勧める。安全側)。墨で裁くなら、`<img>` の墨の場所を測る別の証明 (装飾を隠した絵との比較) が要る。
> 4. **絵を描画系の版に結ぶこと:** Chromium の版が変わるたびに、オーナーが見直す (費用)。代わりに資産の sha256 だけに結べば、オーナーが見た絵と run が描く絵の一致は保証しない。
> 5. **ページでの大きさ:** 絵は記録の寸法で描く。ページで `<img>` の縦横比を変えると (`preserveAspectRatio="none"` の継ぎ目・山)、オーナーが見た絵と違う形になる。ページの箱の縦横比を記録の比に限るか、比ごとに絵を描いて見せるか。
> 6. **普通の本文の下の装飾:** 段 C の既定 `plate` (`phase-c-design.md` §12 の 4) を N1 にもそのまま掛けるか。
> 7. **WebKit・Firefox:** オーナーの WSL でプローブを走らせるか (ダウンロードを伴う。`n1-decoration-svg.md` §4.1)。段 C の当たり判定の一致も、そこで確かめるか。
> 8. **記録の置き場:** `pending` の記録をリポジトリに置くか (今は置いていない。JSON は 0)、承認の記録を公開リポジトリに置いてよいか。
>
> この文書は承認ではない。

## 5. オーナーが記録を渡す道 (案。§4 の 1 が決まるまで動かない)

1. Claude は、資産のファイル (リポジトリの外、または研究の枝) から `renderN1Preview` で絵を描き、`pendingN1Review` で `pending` の記録を作る。絵の PNG はリポジトリに入れず、オーナーに見せる (チャットに貼る、またはオーナーの機械で同じ手順で描く)。そのとき資産と絵の sha256 を並べて示す。
2. オーナーが絵を見て、`approved` か `rejected` を決める。**記録を書き換えるのはオーナー自身である** (`decision`・`reviewed_at`・`note`)。Claude は書き換えない。
3. §4 の 1 で決めた道で、それをオーナーが書いたことを証明する (例: オーナーのアカウントの approve)。
4. run は、取り込むたびに `checkN1Asset` を呼ぶ。`checkN1Asset` は資産のファイルを読み、**読んだそのバイト列から自分で絵を描き直し** (呼ぶ側から絵や sha256 を受け取らない)、記録の `asset_sha256`・`preview.sha256`・`preview.renderer`・`preview.width`/`height` (資産の記録の寸法) と照らし、検めた欄の凍結した写しを検証器に問う。1つでも違えば、その資産は使わない。

## 6. 証明していないこと

- **Chromium 1194 以外の描画系。** WebKit・Firefox は BLOCKED。段 C の順の答えは Chromium の当たり判定である。
- **結合の本番の道。** 結合はテストの中の組み合わせで、run の中ではない。段 C の検査 (`OVERLAP_SCRIPT`) は試作で、lib に無い。
- **合成の例と 2 本の幅の掃引だけ。** 3店のページに N1 の `<img>` を置いた版は作っていない (段 C の §7 は CSS の箱の層だけ)。
- **1920px より広い、320px より狭い、小数の幅、窓の高さ 900 以外、拡大率。**
- **ページで伸ばした `<img>` の見た目** と、オーナーが見た絵の一致 (§4 の 5)。
- **パスで描いた文字の形** を機械で見つけること (OCR は無い)。オーナーの目視に頼る。
- **記録の主の証明** (§4 の 1)。
- **プレビューの sha256 の安定** は、同じ container・同じ Chromium の中で2回描いて同じであることだけ。別の機械 (フォントの設定・GPU) での一致は見ていない。装飾は文字を持たないのでフォントには依らないはずだが、確かめていない。

## 7. 後で有効にする手順 (どれも、前の段とオーナーの承認が要る)

1. DEV-173 (段 C の研究) は PR #213 で develop に merge 済み (`7f5e2ac`)。残りは、`phase-c-design.md` §8 の lib の変更 (HOLD) をオーナーが承認し、別の PR で実装し、最新の head の CI と独立の Fresh Review の後に merge する。
2. §4 の 1〜8 をオーナーが決める。
3. comp-impl の変更の PR (この PR では HOLD。`lib/design-agent/comp-impl/**` を変えるので、別の承認が要る):
   1. `spec.ts`: `CAPABILITY_NAMES` に `decoration_svg` (仮)。`APPROVED_CAPABILITIES` は空のまま。旗は宣言と承認の両方で立つ (`pageCssOptionsOf` と同じ形)。
   2. 資産の schema (`PageAsset`): 種類 `decoration_svg`、役割 `decoration`、schema 2 の記録。旗なしの結果が今の全プローブで変わらないことを固定する。
   3. `htmlSourceProblems`: インラインの `<svg>` は拒んだまま。`<img src>` を記録した `decoration_svg` の資産にだけ広げ、`alt=""`・`aria-hidden="true"`・`referrerpolicy="no-referrer"` を要る。CSS の `url()` の拒否は変えない。
   4. `layers.ts`: 装飾の `<img>` の役割 (C-1)。`decoration` にし、描く順を問わず守る文字に触れない形 (C-2 を残す)。
   5. 段 C の `OVERLAP_SCRIPT` (lib に移したもの) が `<img>` を箱の「描くもの」として数えることを、この PR の must-fail の 10 例で固定する。1px の掃引を旗のときに掛け、測れない幅は落とす。
   6. 取り込み: 資産ごとに `checkDecorationSvg`・資産のファイルの検査・`renderN1Preview`・`checkN1Asset` (§4 の 1 で決めた検証器)。1つでも外れれば止める。
4. その PR のテスト: この PR の2本を、試作でなく本番の道を呼ぶ形に移す。変異で守りを1つずつ外して落ちることを確かめる。
5. WebKit・Firefox のプローブ (§4 の 7)。
6. 各資産のオーナーの記録 (§5)。**Claude は作らない。**
7. 能力を ON にする別の PR (`APPROVED_CAPABILITIES` に足す)。**オーナーの明示の承認の後だけ。**

## 8. ON の禁止

**段 C が通り、オーナーが承認するまで、N1 を ON にしない。** この文書・DEV-174 の PR・テストの緑は、どれも ON の承認ではない。
