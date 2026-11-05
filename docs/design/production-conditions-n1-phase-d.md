# 本番へ取り込む条件: N1 の装飾 SVG と段 D の3つの能力 (DEV-181、Issue #193 コメント `6654178698` の B.6)

2026-11-05。**機能ごとの条件の整理であって、承認ではない。何も ON にしていない。**

- `APPROVED_CAPABILITIES` は `[]` のまま。`CAPABILITY_NAMES` に名前を足していない。`lib/**`・`app/**`・`tests/**`・`.github/**`・`package.json`・lockfile の差は 0 行 (この PR は `docs/design/` と `.ai/` だけ)。
- **オーナーの目視の記録は、リポジトリに1つも無い。この文書も作らない。** N1 の資産ごとの記録は「要るもの」として挙げるだけである。Claude・worker・スクリプトは記録の `decision` を決めない (`n1-implementation-prep.md` §3)。
- **縦の事実の文は、今も、これからも禁じる。保護が先である。** この文書は段 D の規則 (守る文字は縦にも回転にも縁取りにもならない、`PHASE_D_PROTECTED_VERTICAL`・`_ROTATED`・`_STROKED`) を緩める案を1つも出さない。カンプの縦の事実の文 (つぐ手 `.month-fact`、輪 `.check-fact`) は、まず横書きに組み直す (オーナーの方針 C。研究は DEV-179)。縦の演出が要るなら、事実でない短い語 (見出し・巨大な語) で作る。
- オーナーの優先順位 (同じコメントの B.5) では、`gradient_ground` と `layered_decoration` (段 C) の判断資料が先である。下の §6 のとおり、N1 と `small_rotation` は段 C に依るので、その順は変えない。

出典: `.ai/reviews/DEV-174.md` (N1 の実装準備)、`.ai/reviews/DEV-175.md` (段 D)、`.ai/reviews/DEV-178.md` (研究の道具の強化と CI に近い書体での再実行)、`docs/design/n1-implementation-prep.md`、`docs/design/n1-decoration-svg.md` (DEV-162・DEV-165)、`docs/design/phase-d-design.md`、`docs/design/phase-c-design.md` §8・§12、`lib/design-agent/research/decoration-review.ts` (読んだだけ、変えていない)、`lib/design-agent/comp-impl/spec.ts`・`page-css.ts`・`layers.ts`・`verify.ts` (読んだだけ)。

## 0. 先に結論

判定は2段に分ける。**(a) 実装の PR** = 能力の名前・旗・検査を lib に足し、旗は OFF (`APPROVED_CAPABILITIES` は空) のまま merge する PR。**(b) ON** = `APPROVED_CAPABILITIES` に名前を足す PR。どちらも `lib/design-agent/comp-impl/**` を変えるので、それぞれオーナーの明示の承認が要る。「Ready-for-approval」は「承認を求める材料がそろっている」という意味で、承認されたという意味ではない。

| 能力 (仮の名前) | (a) 実装の PR | (b) ON | いちばん重い理由 |
|---|---|---|---|
| N1 装飾の SVG (`decoration_svg`) | **Blocked** | **Blocked** | 段 C の lib の変更 (`phase-c-design.md` §8) が HOLD。記録をオーナーが書いたことの証明の道が未定。資産ごとのオーナーの記録が 0。WebKit・Firefox は BLOCKED |
| `vertical_text` (縦書きの語) | **Ready-for-approval** | **Blocked** | (b): 実装が無い。縦の字は書体に強く依り、書体を固定する能力 (`web_font`) は設計だけ。WebKit・Firefox・実機は未検証 |
| `small_rotation` (小さな回転) | **Blocked** | **Blocked** | 文字を持たない回した箱が文字に届くかは段 C の検査が裁く (段 D 設計 §3.3・判断 5)。段 C の lib が先 |
| `outlined_type` (縁取りの語) | **Ready-for-approval** | **Blocked** | (a) は本番の「ベンダー接頭辞は決して通さない」の例外 (`-webkit-text-stroke*`) を含むので、その方針の判断と一緒に承認が要る。(b): 実装が無い |

**ON (b) はどれも Blocked である。** 試作はテストの中 (`tests/unit/design-agent/comp-impl/phase-d-harness.ts`、`tests/unit/design-agent/research/n1-phase-c-join.test.ts`) にあり、run・worker の道には無い。(a) の PR が merge され、最新の head の CI と独立の Fresh Review を通った後でなければ、(b) を求める材料にならない。

## 1. 4つの能力に共通すること

### 1.1 未検証の環境 (共通)

| 環境 | 状態 | 証拠 |
|---|---|---|
| Chromium 1194 (141.0.7390.37) | 試作のすべて (段 D 22 件・N1 の結合 19 件・記録 51 件) が緑 | DEV-174・175・178 の記録。今日 (2026-11-05) も N1 の2本を走らせ直した (§7) |
| CI (GitHub hosted、ubuntu-latest、`npx playwright install chromium`) | develop `63e1891` (PR #218 の merge) で `unit (1/2)`・`unit (2/2)` が success。`phase-d.test.ts`・`phase-c-overlap.test.ts`・`n1-*.test.ts` はこの組に入る (`--exclude` は `shop-css` だけ) | GitHub の check runs (`63e1891`) |
| CI に近い書体 (`fonts-ci.conf`: IPAMincho・Noto Sans CJK の無い組) | 段 D 22/22 (DEV-178)、段 C 79/79 (DEV-178)、N1 の2本は今日 51/51・19/19 (§7) | 同上 |
| **WebKit** | **BLOCKED**。今日のプローブ `n1-browser-probe.ts --browser webkit` は終了 2 (`Executable doesn't exist at /opt/pw-browsers/webkit-2336/pw_run.sh`)。この container に入れることは許されていない | §7 |
| **Firefox** | **BLOCKED**。同じく終了 2 (`/opt/pw-browsers/firefox-1538/firefox/firefox` が無い) | §7 |
| **実機 (iPhone の Safari、Android の Chrome、iPad)** | **未検証**。SP は Chromium の電話の擬装 (viewport・deviceScaleFactor) だけ。実機の書体・字の描き方・拡大率は見ていない | — |
| **CI の書体そのものでの見た目** | **未検証**。CI はテストの答え (コード) を通しただけで、絵を誰も見ていない。CI に近い書体の組での絵は Claude が見た (DEV-175・178) が、CI の機械の書体と同じとは言えない | DEV-178 の既知の限界 |
| 1920px より広い・320px より狭い・小数の幅、窓の高さ 900 以外、拡大率 | **未検証** | 段 D 設計 §9、`n1-implementation-prep.md` §6 |
| スクリーンリーダー | **未検証** (読む順は DOM と箱の位置で測るだけ) | 段 D 設計 §9 |

- WebKit・Firefox は、オーナーの WSL で走らせる道が書いてある (`n1-decoration-svg.md` §4.1 の手順。ダウンロードを伴う)。段 C・段 D の試作は Chromium の当たり判定と Range の箱に頼るので、他の描画系では N1 のプローブとは別に、段 C・段 D のテストそのものを走らせる必要がある。**どちらも、ON の前に要るとするかはオーナーの判断** (段 D 判断 9、N1 判断 7)。
- WSL で重い処理を走らせる前は `docs/operations/wsl-resource-preflight.md` の確認をする。

### 1.2 守ることを先にする (共通、緩めない)

- 守る文字 (事実・免責・dt/dd、要素をまたいだ事実の一部、紛らわしい字を寄せた形を含む: 段 D 設計 §4.5) は、縦にも回転にも縁取りにもならない。N1 の `<img>` はどの描く順でも守る文字に触れない (C-2)。
- 測れないときは落とす (fail closed): `PHASE_D_INK_UNPROVEN`・`_ROTATION_UNMEASURED`・`_OUTLINE_GROUND_UNMEASURED`、N1 の `<img>` は箱で裁く (透明な部分も「描くもの」)。
- **この文書が勧める判断は、どれも緩めない向きである。** 守りを狭める (検査を外す・閾値を上げる) 案は出さない。

### 1.3 実装の PR に共通する差分 (形は段 B と同じ)

既存の6つの能力 (`vertical_name`・段 B の5つ) と同じ形にする。

1. `lib/design-agent/comp-impl/spec.ts`: `CAPABILITY_NAMES` に名前、`CAPABILITY_OPTION_KEYS` に旗の鍵。`APPROVED_CAPABILITIES` は `[]` のまま。旗は spec の宣言と承認の両方で立つ (`pageCssOptionsOf` は今のまま)。
2. `lib/design-agent/comp-impl/page-css.ts`: `PageCssOptions` に鍵。`propertySpecFor` で旗のときだけ表を足す。**旗なしの答えが今と同じであること**を大きな組み合わせで固定する (`phase-b-design.md` §8.9 のやり方)。
3. 描画の検査を lib に移し、zod の形を足す。`run.ts` で止める側 (`checks.*`)、`verify.ts` の止めるコードの一覧へ。
4. テスト: 試作のテストを、本番の道を呼ぶ形に移す (落ちるべき例・通るべき例の数を減らさない)。`phase-b-baseline.test.ts` の `PageCssOptions` の鍵の固定を、意図して直す。変異で守りを1つずつ外して落ちることを確かめる。worker の道 (`scripts/sales-design-worker/`) が旗を渡さないことを固定する。
5. その PR の最新の head の CI と、独立の Fresh Review。

### 1.4 ON の PR に共通する差分

- `spec.ts` の1行: `export const APPROVED_CAPABILITIES: readonly CapabilityName[] = ["<名前>"];` (能力ごとに別の PR。2つ以上を1つの PR で足さない)。
- それ以外の lib の変更を含めない (含むなら、それは (a) の PR に戻す)。
- 最新の head の CI・独立の Fresh Review・**オーナーの明示の承認**。

## 2. N1: 装飾の SVG (`decoration_svg`、仮の名前) — DEV-162・165・174

### 2.1 証明した安全の条件 (Chromium 1194 だけ)

| 条件 | テスト | 数 |
|---|---|---|
| SVG のファイルの構文 (文字・script・style・foreignObject・外への `url(`・`use`・`filter`・動き・イベント属性・DTD・コメント・傾き …を拒む) | `tests/unit/design-agent/research/decoration-svg.test.ts` | 322 件 緑 |
| 装飾は `<img>` に限る (インラインの `<svg>`・`alt` のある `<img>`・記録に無いファイル・CSS の `background-image`・`<text>` を持つ SVG を静的に拒む) | 同上、`n1-phase-c-join.test.ts` | — |
| 今の段 A の検査が装飾の `<img>` に何を言うか (守る文字への重なりは今すべて止まる。守っていない普通の文への流れの中の重なりは今どこでも止まらない: C-3) | `decoration-n1-verification.test.ts` | 88 件 緑 |
| 段 C との結合: 落ちるべき置き方 10 がすべて落ちる、通るべき 4 がすべてコード 0 (画素も)。幅で伸びる例は 1px の掃引 (320〜1920 の 1,601 幅) だけが見つけ (この container の書体で 849–899px)、確かめる幅 12 はすべて見逃す | `n1-phase-c-join.test.ts` | 19 件 緑 (今日も、2つの書体の組で: §7) |
| 透明な部分で事実を覆う形を箱で止める (画素だけなら通る: 透過率 ≥ 0.97) | 同上 | — |
| 資産ごとの記録の検査: 記録無し・`pending`・証明の無い `approved`・資産と絵の sha256・描画系・寸法・日付・形の 29 の誤りを、常に真の検証器でも拒む。絵は `checkN1Asset` が読んだバイト列から自分で描く | `n1-owner-review.test.ts` | 51 件 緑 (今日も: §7) |
| 証明の口の既定 `NO_ATTESTATION` は常に否 → **今どの `approved` も通らない** | 同上 (`decoration-review.ts` 56 行) | — |
| リポジトリに記録が無いこと (記録の名前を書けるファイルの一覧、JSON に0、`approved`・`rejected` の値は印付きのテストの fixture だけ) | `n1-owner-review.test.ts`・`decoration-n1-verification.test.ts` | — |
| 変異: 記録の検査の 6 変異 + `checkN1Asset` が記録の絵を結び先に使う変異 → すべて 1〜4 件落ちる。段 C の試作で `<img>` を描くものから外す → `<img>` に依る落ちるべき 9 件がすべて落ちる | DEV-174 の記録 | 7 + 1 |
| 3店の形のプローブ (JS 有効・無効、外への要求 0、箱の外のインク 0、敵対的な 13 件を拒む) | `n1-browser-probe.ts --browser chromium` | 終了 0 (今日も) |
| 段 C の試作 (結合が使う) | `comp-impl/phase-c-overlap.test.ts` | 79 件 緑 (2つの書体の組、DEV-178) |

### 2.2 まだ証明していないこと

- **WebKit・Firefox: BLOCKED** (§1.1)。段 C の描く順の答えは Chromium の当たり判定に頼る。
- **実機・CI の書体での見た目:** 未検証。
- **資産ごとのオーナーの目視の記録: 0 件。** 有効にする各資産に、オーナーの `approved` の記録 (資産の sha256・絵の sha256・描画系・寸法に結ぶ) が要る。**Claude は作らない。** `pending` の記録もリポジトリに置いていない (JSON に 0。置くかはオーナーの判断 8)。
- **記録をオーナーが書いたことの証明** (検証器の中身): 道が無い。今は `NO_ATTESTATION` で何も通らない。
- **プレビューの sha256 の別の機械での一致:** 同じ container・同じ Chromium で2回描いて同じであることだけ。オーナーの機械や CI の機械で描いた絵と同じかは見ていない。
- **結合の本番の道:** 結合はテストの中の組み合わせで、run の中に無い。段 C の `OVERLAP_SCRIPT` は lib に無い。
- 3店のページに N1 の `<img>` を置いた版、ページで縦横比を変えた `<img>`、パスで描いた文字を機械で見つけること (OCR なし、オーナーの目視に頼る)。

### 2.3 ON に要る本番の差分 (正確な一覧)

**前提 (別の PR):** 段 C の lib の変更 (`phase-c-design.md` §8 の 1〜8: `layered_decoration` の名前と旗、`overlap.ts` に `OVERLAP_SCRIPT`、`layers.ts` の `STACKING_CONTEXT` の数え方、`render.ts` の 1px の掃引、`run.ts` の `checks.phase_c`、`verify.ts`)。それが merge され、gate として効いていること (`n1-decoration-svg.md` §5 の 1)。

**(a) N1 の実装の PR** (`n1-implementation-prep.md` §7.3):

1. `spec.ts`: `CAPABILITY_NAMES` に `"decoration_svg"`、`CAPABILITY_OPTION_KEYS` に鍵 (例 `decorationSvg`)。`APPROVED_CAPABILITIES` は空。
2. 資産の schema (`PageAsset`): 種類 `decoration_svg`、役割 `decoration`、資産ごとの記録 (`decoration-review.ts` の schema 2 の形)。旗なしの結果が今の全プローブで変わらないことを固定する。
3. `htmlSourceProblems`: インラインの `<svg>` は拒んだまま。`<img src>` を、記録した `decoration_svg` の資産にだけ広げ、`alt=""`・`aria-hidden="true"`・`referrerpolicy="no-referrer"` を要る。CSS の `url()` の拒否 (`CSS_SYNTAX_URL`) は変えない。
4. `layers.ts`: 装飾の `<img>` の役割を `decoration` に (C-1)。描く順を問わず守る文字に触れない (C-2 を残す)。
5. lib に移した段 C の検査が `<img>` を箱の「描くもの」として数えることを、落ちるべき 10 例で固定。旗のとき 1px の掃引を掛け、測れない幅は落とす。
6. 取り込み: 資産ごとに `checkDecorationSvg`・資産のファイルの検査・`renderN1Preview`・`checkN1Asset` (オーナーが決めた検証器)。1つでも外れれば止める。検証器はモジュールに固定する (引数で受けない。Claude の勧め、判断 1)。
7. 描画は JS 無効・通信の拒否のまま。拒否した数を報告に残す。

**(b) ON の PR:** `APPROVED_CAPABILITIES = ["decoration_svg"]` の1行 (§1.4)。**その時点で、使う資産のすべてにオーナーの記録があり、検証器が通すこと。** 記録が無い資産は、ON の後も使えない (それが正しい)。

### 2.4 オーナーの判断 (未承認。`n1-implementation-prep.md` §4、`n1-decoration-svg.md` §6)

1. 記録をオーナーが書いたことの証明: (a) オーナーのアカウントの PR の approve を hosted の job が API で照らす / (b) オーナーの Issue のコメント / (c) オーナーの鍵の署名 / (d) オーナーだけが書ける置き場。あわせて、検証器を引数で受けるかモジュールに固定するか (**Claude は固定を勧める**)。
2. 守る文字の下の装飾: 段 C の V4 の板の例外を N1 の `<img>` に認めるか、C-2 を残すか (**Claude は C-2 を残すことを勧める**。緩めない向き)。
3. 箱で裁くことを続けるか (勧める。安全側)。
4. 絵を描画系の版に結ぶか (Chromium を上げるたびにオーナーが見直す費用)。
5. ページでの大きさ: 縦横比を記録の比に限るか。
6. 普通の本文の下の装飾 (段 C の既定 `plate`)。
7. WebKit・Firefox をオーナーの WSL で確かめるか。
8. 記録の置き場 (`pending` をリポジトリに置くか、承認の記録を公開リポジトリに置いてよいか)。
9. 装飾の `<img>` の役割 `decoration` か `media` か (C-1)。守っていない普通の文への流れの中の重なりを段 C で拒むか (C-3)。

### 2.5 BLOCKED

- 段 C の lib の変更 (HOLD、オーナーの承認待ち)。
- 証明の道 (判断 1) が無い。
- 資産ごとのオーナーの記録 0 件 (オーナーが見て書くまで。Claude は作らない)。
- WebKit・Firefox (この container に無い。入れることは許されていない)。
- 実機。

### 2.6 判定

- (a) 実装の PR: **Blocked** (段 C の lib が先。証明の道 (判断 1) が決まるまで、取り込みの検査の形が決まらない)。
- (b) ON: **Blocked**。

## 3. `vertical_text` (縦書きの語、旗 `verticalText`) — DEV-175・178

対象は「語」(守る文字でない・16 字以下・20px 以上の見出しや巨大な語) と、店名の役割の要素 (全体の文字が店名と等しい要素。`h1` であるだけでは店名にならない。事実を含めば事実が勝つ)。**事実の文は対象にならない。縦の事実の文は `PHASE_D_PROTECTED_VERTICAL` で止まり、この文書はそれを緩めない。**

### 3.1 証明した安全の条件 (Chromium 1194、テストの中の試作)

| 条件 | テスト | 数 |
|---|---|---|
| 今の門は縦を `vertical_name` の `writing-mode: vertical-rl` (店名だけ) のほかは拒む | `phase-d.test.ts` | 15 の宣言 × 旗の組 |
| 提案の文法: 旗なしは本番と同じ答え (3店 × 4 つの CSS × 3 つの旗の組)。`vertical_text` の旗は自分の表 (6 の形) だけを通し、回転・縁取りの表を1つも通さない。`vertical-lr`・`sideways`・`digits 2` を拒む | 同上 | 33 の拒む形 (3つの旗の共通) |
| 落ちるべき縦の例 (守る文字を縦に: 事実・事実の後半・flex の項目の事実・dd・店名でない h1・店名と事実の h1・店名の dd / 縦の入れ物 4 / 長い文・小さな字 / `vertical-lr`・横倒し・`sideways`・縦中横でない数字・長い縦中横 / あふれ / 字の順・重なり / 読む順 2 / 旗なし) | 同上 | 段 D 全体で落ちるべき 78 例のうち縦の分 (表は段 D 設計 §6) |
| 通るべき縦の例 (段落の右の縦の見出し・縦の店名・縦中横の 12・`upright` の ABC・横の行の中の縦の語・3つすべての語・ジグザグ・事実のすぐ後の飾りの語) は 320〜1920 の 1px の全幅でコード 0 | 同上 | 通るべき 16 例のうち 13 例が全幅 |
| 3店 (つぐ手・輪・ゆげ湯) の縦の版: 確かめる幅 12 と 1px の全幅で、段 D と段 C のコードが strict と同じ | 同上 | 3 版 |
| 変異: 縦に関わる守り (M1・M2〜M9・M28〜M32・M36・M41・M42・M44・M46・M57〜M60) を1つずつ外すと、すべて 1 件以上落ちる | 段 D 設計 §13 | 60 変異のうち縦の分 |
| 書体: この容器の書体と CI に近い書体の両方で 22/22 | DEV-178 | 411 秒・399 秒 |
| CI (hosted) で `unit` が success | develop `63e1891` | — |

### 3.2 まだ証明していないこと

- **WebKit・Firefox: BLOCKED。** 縦の字の並びは Range の箱で測る。描画系ごとに縦の組み方 (縦中横・約物の位置) が違いうる。
- **実機:** 未検証。とくに iOS の Safari の縦の和文の書体。
- **書体:** 縦の字は書体に強く依る。CI に近い書体で 明朝 の指定のまま縦にすると、`serif` がラテン文字の書体になり、縦の かな漢字 が積み重なって描かれた (検査は止めた。DEV-175)。今の試作は縦の語の書体の並びに IPAGothic を入れて避けているだけで、書体を固定する能力 (`web_font`) は設計だけ (段 D 判断 10)。DEV-178 の既知の限界: CI に近い書体ではつぐ手の C の縦の事実の文が「急がない…」の行と重なる — **これは縦の事実の文がカンプに残っていることの問題でもあり、`vertical_text` を ON にしても通らない (規則で拒まれる)。横書きへ組み直すのが先である。**
- 縦の墨 (字形の墨の外へのはみ出し)、回した縦の字の並び、読む順の網羅、スクリーンリーダー (段 D 設計 §9)。
- 窓の高さ (縦の要素の利用できる高さは窓の高さに依る) を変えて確かめていない。

### 3.3 ON に要る本番の差分 (正確な一覧)

**(a) 実装の PR** (段 D 設計 §8 のうち縦の分):

1. `spec.ts`: `CAPABILITY_NAMES` に `"vertical_text"`、`CAPABILITY_OPTION_KEYS` に `vertical_text: "verticalText"`。`APPROVED_CAPABILITIES` は空。
2. `page-css.ts`: `PageCssOptions` に `verticalText?: boolean`。`propertySpecFor` で旗のときだけ `writing-mode` (`horizontal-tb`・`vertical-rl`)・`text-orientation` (`mixed`・`upright`)・`text-combine-upright` (`none`・`all`) を足す。`vertical_name` の `VERTICAL_WRITING_MODE` を含む (店名の縦は `vertical_name` のまま)。冒頭の注記 (「horizontal writing only」) を直す。
3. 新しい `lib/design-agent/comp-impl/phase-d.ts`: `PHASE_D_SCRIPT` の縦の部分 (字の順・重なり・あふれ・読む順・横倒し・数字・縦中横・`vertical-lr`・縦の入れ物・守る文字)、`FACT_NODES_JS` (段 C と共通、紛らわしい字の写像を含む)。zod の形。1px の掃引は `unmeasuredWidths` と同じ数え方。
4. `layers.ts`: 旗のときだけ、V9 の縦の検査 (`VERTICAL_NOT_NAME`) を「語」の役割へ広げる (守る文字の縦の禁止 `PROTECTED_VERTICAL` はそのまま)。
5. `run.ts`・`verify.ts`: 段 D の縦のコードを止める側へ (`BLOCKING_LAYER_CODES` に足すか、`checks.phase_d`)。
6. テスト: §1.3 の 4。縦の落ちるべき例のすべてを本番の道で。

**(b) ON の PR:** `APPROVED_CAPABILITIES = ["vertical_text"]` (§1.4)。

### 3.4 オーナーの判断 (段 D 設計 §12 のうち)

- 1 (進むか・順序)、2 (語の範囲: 16 字・20px、見出しを縦にしてよいか)、3 (店名の縦を短い名まで広げるか)、7 (読む順の規則)、9 (§3.2 を ON の前に要るとするか)、10 (縦の語の書体の並びに、どの機械にもある縦の CJK の書体を必ず含めるか。`web_font` との関係)。
- **出さない判断:** 縦の事実の文を許すこと。これは判断の候補にしない (保護が先)。

### 3.5 BLOCKED

- (b) について: 実装が無い。WebKit・Firefox (この container に無い)。実機。書体を固定する手段 (判断 10 が決まるまで、書体の差は検査で止めるだけ)。

### 3.6 判定

- (a) 実装の PR: **Ready-for-approval** (試作・文法・変異・2つの書体の組・CI がそろう。段 C に依らない)。**ただし得は限られる** (段 D 設計 §0: 戻るのは「語を縦に立てる」こと。C′ の主役の縦の事実の文は規則で拒まれる)。オーナーの優先順位 (B.5) の後に置くことを勧める。
- (b) ON: **Blocked**。

## 4. `small_rotation` (小さな回転、旗 `smallRotation`) — DEV-175・178

対象は文字を持たない箱 (画像・装飾) と語 (守る文字でない・12 字以下・24px 以上)。角度は `rotate(<deg>)` を1つ、|8°| 以下、入れ子の和も 8° 以下、振れは 24px 以下。

### 4.1 証明した安全の条件 (Chromium 1194、テストの中の試作)

| 条件 | テスト | 数 |
|---|---|---|
| 今の門は `transform`・`transform-origin`・`rotate` を拒む | `phase-d.test.ts` | — |
| 提案の文法: `rotate()` 1つ・`deg`・|8| 以下。`turn`・`rad`・`calc()`・2つの関数・`skew`・`scale`・`matrix`・`rotateZ`・`rotate` の性質を拒む。自分の表 (8 の形) だけを通す | 同上 | — |
| 落ちるべき回転の例 (守る文字・事実を持つ札・店名・要素をまたいだ事実の後半 / 段落 / 12°・6° の中の 6° / `skewX`・`rotate` の性質 / 振れ 3 / 画面の外 3・切れ / 墨 2 / 旗なし / 横のはみ出し) | 同上 | 落ちるべき 78 例のうち回転の分 |
| 3店の回転の版: 確かめる幅 12 と 1px の全幅で strict と同じ。作る途中で 1px の掃引だけが狭い帯 (つぐ手 686〜691px、ゆげ湯 870〜878px・1290〜1294px) で画面の外へ出るのを見つけた | 同上 | 3 版 |
| 回した文字の墨は画素で測る (段 C の字形の箱は回した墨を含まない: 段 C は fail closed) | 同上 | — |
| 変異: 回転に関わる守り (M9〜M17・M40・M45・M50・M33・M35・M37 ほか) を外すとすべて落ちる | 段 D 設計 §13 | — |
| 2つの書体の組で 22/22、CI で success | DEV-178、`63e1891` | — |

### 4.2 まだ証明していないこと

- **回した文字を持たない箱が文字に届くこと** は、段 D ではなく段 C の検査が裁く (例: 事実の上を通る 4° の棒は段 D で 0、段 C で `OVERLAP_PAINT_ABOVE_PROTECTED`)。**段 C の検査は lib に無い。** 段 C と段 D を同時に ON にした検査の組み立ては作っていない (段 D 設計 §9)。
- 回転は重ねの文脈を作る。今の `layers.ts` は `STACKING_CONTEXT` で止める。数えないようにするのは描画の門を狭める変更で、その安全は段 C の検査が全幅で裁くことに依る (段 D 判断 5、段 C 判断 2)。
- WebKit・Firefox: BLOCKED。実機: 未検証。回転の描き方 (アンチエイリアス・回した後の字の墨) は描画系に依る。
- 画素は確かめる幅だけで、1px の掃引の間は外接矩形の fail closed (`INK_UNPROVEN`)。

### 4.3 ON に要る本番の差分 (正確な一覧)

**前提 (別の PR):** 段 C の lib の変更 (`phase-c-design.md` §8)。

**(a) 実装の PR:**

1. `spec.ts`: `"small_rotation"`、`small_rotation: "smallRotation"`。
2. `page-css.ts`: `smallRotation?: boolean`。旗のときだけ `transform` (`none` か `rotate(<deg>)` 1つ、|8| 以下) と `transform-origin` (方向の語と 0〜100% を 1〜2 個)。個別の `rotate`・`translate`・`scale` は拒んだまま。冒頭の注記 (「no transform at all」) を直す。段 C の `layered_decoration` も `transform` を足すので、2つの旗の表が互いに広げないことを固定する。
3. `phase-d.ts`: 回転の部分 (純粋な回転の行列、角度の和、振れ = 罫の箱 ∪ 子孫の箱 ∪ 字の箱、画面の外、切れ、墨の対象と `phaseDPixels`)。
4. `layers.ts`: 旗のときだけ、回転の作る重ねの文脈を `STACKING_CONTEXT` で数えない (**描画の門を狭める。承認が要る**。段 C の §8 の 4 と同じ形)。
5. `render.ts`: 確かめる幅で画素 (`phaseDPixels`)、1px の掃引で幾何 (`INK_UNPROVEN` の fail closed)。
6. `run.ts`・`verify.ts`。テスト §1.3 の 4。

**(b) ON の PR:** `APPROVED_CAPABILITIES = ["small_rotation"]`。**段 C (`layered_decoration`) の検査が run で効いていること** (`layered_decoration` を ON にすることではない。検査が回した箱に掛かること)。

### 4.4 オーナーの判断 (段 D 設計 §12 のうち)

- 1、2、4 (角度 8° と振れ 24px)、5 (`STACKING_CONTEXT`、段 C が先)、8 (画素と幾何の分担: 墨の対象の外接矩形が全幅で別の文字に届く作りを禁じることになる)、9。段 C の判断 1・2・3 (Chromium の当たり判定に頼ること)。

### 4.5 BLOCKED

- 段 C の lib の変更 (HOLD)。WebKit・Firefox。実機。

### 4.6 判定

- (a) 実装の PR: **Blocked** (段 C の lib が先)。
- (b) ON: **Blocked**。

## 5. `outlined_type` (縁取りの語、旗 `outlinedType`) — DEV-175・178

対象は語 (守る文字でない・12 字以下・24px 以上)。`-webkit-text-stroke-width` 0.5〜3px (かつ 0.06em 以下)、色は不透明、中抜きは 1.5px 以上、画素のコントラスト (墨の上位 4 分の 1) ≥ 3。

### 5.1 証明した安全の条件 (Chromium 1194、テストの中の試作)

| 条件 | テスト | 数 |
|---|---|---|
| 今の門は `-webkit-text-stroke*`・`-webkit-text-fill-color`・`paint-order`・`text-shadow` を拒む (ベンダー接頭辞は決して通さない)。`color: transparent` は今も通る (縁が無ければ文字が消えるだけ。run のコントラストの領分) | `phase-d.test.ts` | — |
| 提案の文法: 幅・不透明な色・`paint-order` だけ。`transparent`・`currentcolor`・アルファ・`var()`・`em` の幅・4px・`-webkit-text-fill-color`・`text-shadow` を拒む。自分の表 (8 の形) だけを通す | 同上 | — |
| 落ちるべき縁取りの例 (守る文字: 事実・継承・電話番号の末尾 (span・flex・grid・2つ目の段落・全角の数字・ゼロ幅スペース・U+2010)・時間の後半 (U+FF5E・ASCII `~`) / 段落・16px / 太すぎ・細い中抜き・地と同じ塗り・半透明・影 / 低いコントラスト 3 / 見えない 7 / グラデーションの地 / 撮る範囲が空 / 旗なし) | 同上 | 落ちるべき 78 例のうち縁取りの分 |
| 縁が隣の行の墨に届く形は段 D だけが落とす (段 C は縁を消して描くので見ない) | 同上 | — |
| 3店の縁取りの版: strict と同じ。作る途中で、ゆげ湯の ぬるい の中間色の縁 (#b4561e、地 #dd8a3e、色どうしのコントラスト約 1.8) を `OUTLINE_LOW_CONTRAST` で止めた | 同上 | 3 版 |
| 変異: 縁取りに関わる守り (M18〜M24・M39・M43・M47〜M49・M51・M52・M54〜M56・M34・M38 ほか) を外すとすべて落ちる | 段 D 設計 §13 | — |
| 2つの書体の組で 22/22、CI で success | DEV-178、`63e1891` | — |

### 5.2 まだ証明していないこと

- **WebKit・Firefox: BLOCKED。** `-webkit-text-stroke` の描き方 (縁が字形の内か外か、`paint-order` の扱い) は描画系で違いうる。画素のコントラストの答えも描画系に依る。
- **実機:** 未検証。細い縁 (0.5〜1px) は高い倍率の画面と低い倍率の画面で見え方が大きく違う。試作は deviceScaleFactor 1 だけ。
- 画素のコントラストの尺度は字の太さ・縁の細さ (読めるか) を測らない (段 D 設計 §9)。
- 画素の測り方は文字の色を差し替えるので、`currentcolor` の罫などが3枚の間で変わる (段 D 設計 §11)。本番では段 C の `TEXT_INK` と同じ方法と照らす必要がある。

### 5.3 ON に要る本番の差分 (正確な一覧)

**(a) 実装の PR:**

1. `spec.ts`: `"outlined_type"`、`outlined_type: "outlinedType"`。
2. `page-css.ts`: `outlinedType?: boolean`。旗のときだけ `-webkit-text-stroke-width`・`-webkit-text-stroke-color`・`-webkit-text-stroke`・`paint-order` の表。**本番の「ベンダー接頭辞は決して通さない」の例外になる** (冒頭の注記の `never` の行を直す)。例外は旗の下の `-webkit-text-stroke*` の3つだけで、`-webkit-text-fill-color` ほかの接頭辞は拒んだまま、を固定する。
3. `phase-d.ts`: 縁取りの部分 (守る文字・読む文字・太さ・半透明・中抜き・地の画像・影・縁取りの対象ごとの画素 (自分の文字の節だけ、語の範囲、色を先に読む))。
4. `render.ts`: 確かめる幅で画素、1px の掃引で `INK_UNPROVEN` の fail closed。
5. `run.ts`・`verify.ts`。テスト §1.3 の 4。

**(b) ON の PR:** `APPROVED_CAPABILITIES = ["outlined_type"]`。

### 5.4 オーナーの判断 (段 D 設計 §12 のうち)

- 1、2、6 (ベンダー接頭辞を許可一覧に入れるか。中抜きを許すか、不透明な塗りだけにするか。尺度 ≥ 3、中抜き 1.5px、0.06em)、8、9。
- **Claude の勧め (緩めない向き):** 最初は不透明な塗りの縁取りだけにし、中抜きは別の判断にする。中抜きは `color: transparent` と組んで「見えない文字」の入口になるからである (段 D 設計 §4.4)。

### 5.5 BLOCKED

- (b) について: 実装が無い。WebKit・Firefox。実機 (倍率の違う画面での細い縁)。

### 5.6 判定

- (a) 実装の PR: **Ready-for-approval** (ベンダー接頭辞の方針の判断 6 と同時に。段 C に依らない)。得は限られる (巨大な語を縁取りで軽くすること。C′ の透けた・地に近い縁は規則で拒まれる)。B.5 の後に置くことを勧める。
- (b) ON: **Blocked**。

## 6. 依存と勧める順序 (承認ではない)

```
段 C の lib (layered_decoration、phase-c-design §8)  ← B.5 の判断資料が先 (DEV-180)
  ├─ N1 の実装の PR  ← 判断 1 (証明の道) も要る
  │    └─ 資産ごとのオーナーの記録 (オーナーが書く)
  └─ small_rotation の実装の PR
vertical_text の実装の PR   (段 C に依らない)
outlined_type の実装の PR   (段 C に依らない。判断 6 と同時)
ON の PR は、どれも上の実装の PR の後に、1つずつ
```

- 段 D の3つは別々の能力である。1つを ON にしても、ほかの2つは開かない (文法と描画の両方で確かめた: 段 D 設計 §6)。
- Claude は、`vertical_text` と `outlined_type` を先にする理由を持たない (得は限られる)。先に承認を求めるなら、オーナーの B.5 (`gradient_ground`・`layered_decoration`) の判断資料の後である。

## 7. この文書のために今日走らせたもの (2026-11-05、この container)

`set -o pipefail`、終了の値を見た。`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`。リポジトリの外に書いた (`scratchpad/dev181/`)。

| 走らせたもの | 結果 |
|---|---|
| `npx tsx scripts/design-artifact/n1-browser-probe.ts --browser chromium --executable …` | 終了 0、`pass` |
| 同 `--browser webkit` | 終了 2、BLOCKED (`/opt/pw-browsers/webkit-2336/pw_run.sh` が無い) |
| 同 `--browser firefox` | 終了 2、BLOCKED (`/opt/pw-browsers/firefox-1538/firefox/firefox` が無い) |
| `npx vitest run tests/unit/design-agent/research/n1-owner-review.test.ts` (この容器の書体 / `fonts-ci.conf`) | 51 passed / 51 passed、どちらも終了 0 |
| `npx vitest run tests/unit/design-agent/research/n1-phase-c-join.test.ts` (この容器の書体 / `fonts-ci.conf`) | 19 passed / 19 passed、どちらも終了 0 |

段 D (`phase-d.test.ts`) と段 C (`phase-c-overlap.test.ts`) は、DEV-178 の数 (22/22・79/79、2つの書体の組) を引いた。今日は走らせ直していない (lib・tests の差が 0 なので答えは変わらない)。

## 8. この文書がしないこと

- 能力を ON にしない。`APPROVED_CAPABILITIES`・`CAPABILITY_NAMES`・本番の CSS ゲート・許可一覧・描画の門を変えない。
- オーナーの目視の記録を作らない。`pending` の記録も作らない。チャットの言葉を記録に写さない。
- 縦の事実の文を許す案、守る文字の範囲を狭める案、閾値を緩める案を出さない。
- この文書は承認ではない。上の判定の「Ready-for-approval」は、オーナーに承認を求める材料がそろっているという意味だけである。
