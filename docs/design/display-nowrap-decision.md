# display_nowrap の判断シート (DEV-170、Issue #193 コメント `6628165899` の 1)

2026-11-04。**検証の記録で、何も有効にしていない。**

- `APPROVED_CAPABILITIES` は空のまま (`lib/design-agent/comp-impl/spec.ts`)。
- 本番のコード (`lib/**`) の差は 0 行。テストと文書だけである。
- 旗 `displayNowrap` は、テストの中の呼び出しにだけ渡した。run.ts・worker の道は旗を立てない。
- **能力を ON にするかは、オーナーが決める。** このシートは承認ではない。

土台: `docs/design/phase-b-design.md` §2.8 (N2)・§7・§8、`docs/design/expressive-allowlist-proposal.md`。

## 1. 先に結論

- **対象の制限は効いている。** nowrap と keep-all が通るのは、店名の全体と固定のラベル (`COMP_UI_LABELS`) だけ。事実・免責・`dt`/`dd`・本文・子の要素・継いだ値・aria-label の細工・混ぜた文は、すべて `NOWRAP_NOT_DISPLAY` で落ちる (`white-space`・`text-wrap-mode`・`nobr`・`pre` の道。旗が無くても通る `max-content` の幅の道は別で、§6)。
- **はみ出しは落ちる。** 入りきらない nowrap の表示語は、入りきらない幅だけで落ちる。入る幅では何も出ない。1px の掃引・箱の検査・横のはみ出し・文字の重なりの4つで確かめた。
- **ただし、3店の目に見える損失はほとんど戻らない。** つぐ/手・まわ/る・ありま/す は、どれも対象の外である。
  - つぐ手・輪・ゆげ湯 の大きな文字は**店名の一部** (略称) で、店名の全体ではない。
  - まわる・継ぐ・熱い は**飾りの語**である。
  - ありま/す は**事実の文**である。
  - 対象の店名の全体 (小さな文字の行) が折れるのは、つぐ手の 601〜785px だけだった。nowrap はそこだけを直す。
- **ON にしても、今の3店の描画は 1440 と 390 で1画素も変わらない** (§5 の画像の SHA)。

## 2. 何を検証したか

テスト: `tests/unit/design-agent/comp-impl/display-nowrap.test.ts` (47 件)。
道具: `tests/unit/design-agent/comp-impl/nowrap-harness.ts` (テストだけの研究の道具。本番の options ではない)。

- 旗はテストから `phaseBScan`・`displaySweepPass` に直接渡す (`phase-b.test.ts` と同じ)。
- 幅ごとの検査は run と同じ script を使う。
  - 段 B: `PHASE_B_SCRIPT` (`NOWRAP_NOT_DISPLAY`・`DISPLAY_WORD_BROKEN`)
  - 文字の健全さ: `MEASURE_SCRIPT` + `textCheck` (`TEXT_OVERLAP` = 文字の上の文字、`TEXT_OUT_OF_BOX`・`TEXT_OFFSCREEN`・`TEXT_CLIPPED`)
  - 箱: `PAIRS_SCRIPT` の `TEXT_BOX_OVERFLOW`
  - ページ: 横のはみ出し `OVERFLOW_HORIZONTAL`
  - 1px の掃引: `displaySweepPass` (320〜1920 の整数の幅の全部。`DISPLAY_OUT_OF_BOX`・`DISPLAY_OFFSCREEN`・`DISPLAY_WORD_BROKEN`)
- 確かめる幅: PC 1440・1280、タブレット 1024・768・601、SP 600・480・390・375・360・340・320。390 以下は run と同じく電話の擬装で開く。
- 描画: Chromium 1194、手元の容器の書体 (IPA 明朝・ゴシック)、JS 無効、通信遮断、deviceScaleFactor 1。

## 3. 対象の制限 (証明したこと)

3店 (つぐ手・輪・ゆげ湯) の事実の記録 (`facts-pack.json`) で、店ごとに同じ組を走らせた。

| 例 | 結果 |
|---|---|
| 店名の全体の `h1`・`p` (nowrap / keep-all) | 通る |
| 店名の空白を全角の空白・改行にしたもの | 通る (空白を除いて比べる) |
| 店名だけを持つ外の箱に nowrap (継いで店名だけに届く) | 通る |
| 固定のラベル 11 語のそれぞれ (`a`)、ラベルだけの `ul` | 通る |
| 事実の値 (住所・電話・時間・定休・道順・ほか事実の全部) | `NOWRAP_NOT_DISPLAY` |
| 略称 (つぐ手・輪・ゆげ湯)、飾りの語 (まわる・継ぐ・熱い)、事実の文 (…があります) | `NOWRAP_NOT_DISPLAY` |
| `dd` の中の店名、`dt` のラベル、免責の中の店名、免責の文 | `NOWRAP_NOT_DISPLAY` |
| 店名を含む本文、店名 + 電話、店名 + ラベル、店名 + 句点、略称の繰り返し | `NOWRAP_NOT_DISPLAY` |
| 子の要素を持つもの (`br` で割る、`span` で割る、空の `span`) | `NOWRAP_NOT_DISPLAY` |
| 店名と事実を持つ箱に nowrap、`body`・`html` に nowrap / keep-all | `NOWRAP_NOT_DISPLAY` |
| 事実の段落に `aria-label="店名"`・`aria-label="店舗情報"` | `NOWRAP_NOT_DISPLAY` (文字で決まる) |
| 長いラベル (`店舗情報を見る店舗情報を見る`)、つないだラベル、記号つき | `NOWRAP_NOT_DISPLAY` |
| 全角と半角の数字の違い、ゼロ幅の空白・ソフトハイフン・単語結合子を挟んだ店名 | `NOWRAP_NOT_DISPLAY` (正規化しない。厳しい側) |
| 生の HTML の `nobr`・`pre`、`text-wrap-mode: nowrap`、`white-space: pre`、隠した段落 | `NOWRAP_NOT_DISPLAY` |
| 旗が下りていても (静的な文法が先に拒む) | `NOWRAP_NOT_DISPLAY` |

**静的な文法は役割を知らない。** 旗を立てると、`page-css.ts` はどの選択子の nowrap も通す (`.address-fact { white-space: nowrap }` も)。役割を限るのは描画の `NOWRAP_NOT_DISPLAY` だけである。テストで固定した。

## 4. 幅の検査 (証明したこと)

### 4.1 作った例 (落ちるべきときに落ち、そうでなければ通る)

左右 16px の余白の箱に、表示語の `h1` を1つ置いた。必要な幅 = 1920 で測った文字の幅 + 32px。

| 表示語 (大きさ) | 必要な幅 | 1px の掃引で落ちる幅 | 確かめる幅で落ちるもの | 通る幅 |
|---|---|---|---|---|
| 架空金継ぎと漆の修理工房 つぐ手 本店 (40px) | 752px | 320–750 | 601 以下: `TEXT_BOX_OVERFLOW`・`OVERFLOW_HORIZONTAL`・`TEXT_OUT_OF_BOX` ほか | 768 以上 |
| Café つぐ手 Kintsugi Studio (44px) | 626px | 320–624 | 601 以下 | 768 以上 |
| 架空喫茶 ３丁目２号店 (48px、全角の数字) | 536px | 320–534 | 480 以下 | 600 以上 |
| 架空喫茶 3丁目2号店 (48px、半角の数字) | 488px | 320–486 | 480 以下 | 600 以上 |
| 店舗情報を見る (64px、最も長いラベル) | 480px | 320–478 | 390 以下 | 480 以上 |
| 架空金継ぎ工房 つぐ手 (32px、約 370px に合わせた) | 368px | 320–366 | 360・340・320 | 375・390 以上 |

- どの例も、掃引の落ちる幅は「必要な幅より狭い幅」とちょうど一致した (端は「必要な幅 −2px 以下で落ち、+1px より上では落ちない」。サブピクセルの丸めの分。落ちる幅は 320 から切れ目なく続くこともテストで固定)。テストは測った幅に対して確かめるので、書体が変わっても意味は変わらない。
- 語が右の余白 (16px) の中に収まるあいだは、ページは横に動かない (`OVERFLOW_HORIZONTAL` は出ない)。その幅は `TEXT_BOX_OVERFLOW` と掃引の `DISPLAY_OUT_OF_BOX` が落とす。
- nowrap の語は折れないので、`DISPLAY_WORD_BROKEN` は出ない。対象の中なので `NOWRAP_NOT_DISPLAY` も出ない。
- そのほかに固定したこと:
  - **文字の上の文字:** 2列の格子 (`minmax(0, 1fr)`) で、nowrap の店名が隣の列の住所に重なると、768px で `TEXT_OVERLAP`・`TEXT_BOX_OVERFLOW`・`DISPLAY_OUT_OF_BOX`。1440px では何も出ない。
  - **隠れる切り落とし:** 箱に `overflow: hidden` があると、ページは動かないが `TEXT_CLIPPED` と `DISPLAY_OUT_OF_BOX` で落ちる。
  - **keep-all の違い:** 同じ日英の店名を keep-all にすると、空白で折れる。各語が入るあいだは、どの幅でも何も出ない。1語が箱より広いと (96px) 狭い幅で落ちる。
  - **nowrap が無いとき:** 同じ長い店名は 390px で語の途中で折れ、旗を立てた掃引で `DISPLAY_WORD_BROKEN` になる (nowrap が直そうとする損失)。
  - **電話の擬装と掃引の一致:** viewport の meta があるページでは、390 以下の擬装の結果と、PC の擬装の掃引が同じ幅で落ちる。

### 4.2 3店の strict B のページ

- ページ: つぐ手 `impl/d1-v2-b`、輪 `impl/d1-b`、ゆげ湯 `impl/d1-b` (develop の最新)。
- 研究のページには viewport の meta が無い。電話の擬装のまま開くと 980px で組まれるので、道具で meta を足した (合成のページと同じ meta。PC の描画は SHA が変わらない)。
- 版: strict (そのまま)、nowrap (店名の全体の行だけ nowrap)、nowrap_wide (略称と飾りの語にも nowrap: 対象の外)。

| 店 | strict で落ちる幅 (旗なしでも出るもの) | nowrap で変わったこと | nowrap_wide |
|---|---|---|---|
| つぐ手 | 1024・768・601 (`OVERFLOW_HORIZONTAL`・`TEXT_BOX_OVERFLOW`・`TEXT_SQUEEZED` ほか) | 旗を立てた掃引の `DISPLAY_WORD_BROKEN` 601–785 が消えた。ほかのコードと横のはみ出しの量 (105・361・528px) は同じ | 全 12 幅で `NOWRAP_NOT_DISPLAY`。360・340・320 で新しく `TEXT_BOX_OVERFLOW`・`OVERFLOW_HORIZONTAL` |
| 輪 | 1280〜601、375〜320 | 何も変わらない (店名の行は元から折れない) | 全 12 幅で `NOWRAP_NOT_DISPLAY`。390 で新しく `TEXT_BOX_OVERFLOW` |
| ゆげ湯 | 1280〜601 | 何も変わらない | 全 12 幅で `NOWRAP_NOT_DISPLAY`。340・320 で新しく `TEXT_BOX_OVERFLOW`・`TEXT_OUT_OF_BOX` ほか |

- strict の 601〜1280 の落ちは、DEV-160 で記録した実装の誤り (タブレットの格子) で、nowrap とは関係が無い。
- nowrap (対象の中) は、どの店のどの幅でも**新しいコードを出さず**、横のはみ出しの量も増やさなかった (テストで固定)。
- 対象の外の nowrap は、**通らない** (どの幅でも `NOWRAP_NOT_DISPLAY`)。しかも SP で実際にはみ出す。

## 5. 比較画像 (Claude が見た)

リポジトリの外に置いた (35 枚の画像の固定に足さない)。

- 場所: 作業したセッションの一時の場所 (`scratchpad/dev170/shots/`、一覧は `index.tsv`)。**リポジトリには無く、後からは開けない。**同じ絵は、strict の描画の SHA (`impl/README.md` に記録) を手がかりに、同じ組のページを描けば作り直せる
- 並べた画像: `cmp-<店>-<390|768>-hero.png` (左から strict・nowrap・nowrap_wide・auto_phrase・C′)
- C′ はつぐ手 `fidelity/d1-v4`、輪・ゆげ湯 `fidelity/d1-v3`。

全体の画像の SHA-256 の先頭 8 桁 (PC 1440 / SP 390、JS 無効、deviceScaleFactor 1):

| 店 | strict B | B + nowrap (研究) | B + nowrap_wide (対象の外) | B + auto-phrase | C′ |
|---|---|---|---|---|---|
| つぐ手 | `5b4b8a6c` / `cfb9a2ce` | `5b4b8a6c` / `cfb9a2ce` (同じ) | `b8e9c325` / `cfb9a2ce` | `b8e9c325` / `312153ce` | `9894f151` / `1aeb994d` |
| 輪 | `917d1561` / `da0e08a9` | `917d1561` / `da0e08a9` (同じ) | `917d1561` / `87aa7130` | `3a497ef2` / `8232b35b` | `fb709812` / `7aa0a6d1` |
| ゆげ湯 | `68c8da1e` / `1303cc95` | `68c8da1e` / `1303cc95` (同じ) | `68c8da1e` / `1303cc95` | `68c8da1e` / `29523aa3` | `338b8e1c` / `a7e92c7f` |

strict B の SHA は、`impl/README.md` に記録した b の描画と同じだった (同じページを描いている)。

### 見て分かったこと

- **nowrap (対象の中) が直すもの:**
  - つぐ手の 768px: 小さな店名の行が「架空金継ぎ工房 つぐ / 手」と折れていた。nowrap で1行になった。
  - 1440 と 390 では、3店とも1画素も変わらない。
- **nowrap では直せないもの (対象の外):**
  - つぐ手の 1440: 大きな つぐ/手 が2行に折れる。nowrap_wide なら1行になるが、`NOWRAP_NOT_DISPLAY` で落ちる。
    - しかも、列が文字に押されて広がり、**金の線が器の割れ目からずれる** (線は 720px から 787px へ。器の割れ目は 720px のまま)。店の核の「1本の線」が切れる。
  - 輪の 390: 飾りの まわ/る。nowrap_wide なら1行。対象の外。
  - ゆげ湯の 768: ゆげ/湯。nowrap_wide なら1行だが、列が広がり、熱い の大きな文字が画面の外へ押し出される。
  - ゆげ湯の SP の ありま/す: 事実の文で、nowrap を掛けてはならないもの。
- **C′ との差:** C′ は縦書き・重なり・SVG・グラデーションで組んでいる。nowrap はその差をほとんど埋めない。C′ は つぐ手 を縦に置くので、折れの問題がそもそも無い。
- **auto-phrase (比べるため):** `word-break: auto-phrase` は、旗が無くても今の許可一覧で通る。
  - つぐ手の 1440 は nowrap_wide と同じ画素になった (つぐ手が1行。線のずれも同じ)。
  - 輪の まわ/る は直らない (語が箱より広いと、語の中で折れる)。
  - strict に無かったコードが新しく出る幅がある: つぐ手の 1280 (`OVERFLOW_HORIZONTAL`・`TEXT_BOX_OVERFLOW`)、ゆげ湯の 340・320 (`TEXT_BOX_OVERFLOW` ほか)。記録はセッションの一時の場所 (`scratchpad/dev170/table.txt`) だけで、リポジトリには無い (テストでも固定していない)。
  - auto-phrase も「無害な直し」ではない。今の検査がそれを落とす。

## 6. 証明していないこと

- **1920px より広い幅、320px より狭い幅、整数でない幅。** 掃引は 320〜1920 の整数の幅だけ。
- **ブラウザの拡大率 (zoom)・文字の大きさの設定・端末の画素比。** 拡大すると実際の幅が狭くなるのと同じで、nowrap の語ははみ出しうる。検査は 100% の拡大でだけ走る。
- **Chromium 1194 以外の描画系** (WebKit・Firefox)。
- **ほかの書体。** 文字の幅が広い書体 (代わりの書体、利用者の書体の設定) では、必要な幅が増える。テストは測った幅に対して確かめるので、その書体で走らせれば正しく落ちるが、手元の容器の書体でしか走らせていない (`web_font` は未実装)。
- **900 以外の窓の高さ** (段 B の全体と同じ)。
- **3店以外のページ。** 実際の店で、店名の全体を大きく組むページは、まだ無い。
- **文字の色や地との関係** (nowrap は色を変えないので、段 A の検査のまま)。
- **すでに落ちている幅での「同じコードの2件目」。** 3店の strict のページがすでに落ちている幅 (つぐ手 1024・768・601、輪とゆげ湯 1280〜601、輪 375〜320) では、テストはコードの組と横のはみ出しの量を比べる。nowrap が同じコードの問題をもう1件増やしても (例: 2つ目の `TEXT_BOX_OVERFLOW`)、組は変わらないので見えない。
- **nowrap に似た別の道。** `width: max-content`・`min-width: max-content`・`inline-size: max-content`・`grid-template-columns: max-content` は、旗が全部 OFF でも今の文法を通る。事実の段落を折れなくでき、`NOWRAP_NOT_DISPLAY` は出ない。これは DEV-170 で増えたものではなく、max-content の幅は画面の幅によらないので、320 の幅の検査 (はみ出し) で落ちる。ただ「対象の外の nowrap はすべて `NOWRAP_NOT_DISPLAY` で落ちる」は `white-space`・`text-wrap-mode`・`nobr`・`pre` の道についての話で、この道は含まない。

## 7. 危険

- **はみ出し:** nowrap の語は折れないので、狭い幅で箱やページからはみ出す。検査が落とす (§4)。落ちた案は実装の作り直しになる。
- **列が押し広げられる:** 格子や flex の `auto`・`1fr` の列は、nowrap の語の幅まで広がる。ほかの列が狭くなり、隣の文字が折れたり、線や帯の位置がずれる (つぐ手の金の線)。
  - 文字の重なりやページのはみ出しになれば検査が落とす。
  - **位置がずれるだけ (線と器の割れ目のずれ) は、検査では落ちない。** 見た目の判断になる。
- **静的な文法は役割を知らない:** 旗を立てると、どの選択子の nowrap も文法を通る。描画の検査が唯一の守りである。描画の検査が走らない道は無い (run.ts は全ての幅で `phaseBScan` を呼ぶ) が、守りは1枚である。
- **正規化しない:** 店名の表記が事実の記録と1文字でも違うと、表示語にならない。厳しい側の失敗 (直せない) で、危ない側ではない。

## 8. ON にしたら変わること

- spec が `display_nowrap` を宣言でき、そのページだけ `white-space: normal | nowrap` と `word-break: keep-all` が文法を通る。
- そのページだけ、1px の掃引 (320〜1920) が表示語に掛かる (1ページ約 1 秒増える。`phase-b-design.md` §8.6)。
- `DISPLAY_WORD_BROKEN` を見るようになる。**宣言したページでは、店名の全体やラベルが語の途中で折れると落ちる** (今は落ちない)。つぐ手の strict B は、宣言すると 601〜785px で `DISPLAY_WORD_BROKEN` も出る (その幅は今も別のコードで落ちている。nowrap を付ければこのコードは消える)。
- 宣言しないページは何も変わらない (旗は宣言 かつ 承認のときだけ立つ)。
- 3店の今の見た目は、ほぼ変わらない (§5)。

## 9. 有効にする PR の手順 (将来、承認の後)

1. `lib/design-agent/comp-impl/spec.ts` の `APPROVED_CAPABILITIES` に `"display_nowrap"` だけを足す。ほかの名前は足さない。
2. `tests/unit/design-agent/comp-impl/phase-b.test.ts` の「承認は空」のテスト (`approves nothing`) と、`display-nowrap.test.ts` の `stays OFF` のテストを、**その PR の中で**承認された一覧に合わせて書き換える。書き換えたことを PR の本文に書く (テストを消さない、skip しない)。
3. 次が緑であること。
   - `npx vitest run tests/unit/design-agent/comp-impl/display-nowrap.test.ts`
   - `npx vitest run tests/unit/design-agent/comp-impl/phase-b.test.ts`
   - `npx vitest run tests/unit/design-agent/comp-impl/phase-b-baseline.test.ts`
   - `npx vitest run tests/unit/design-agent/comp-impl/isolation.test.ts`
   - `npx vitest run tests/unit/design-agent/comp-impl` (全体)
   - `npx vitest run tests/unit/ai-tasks.test.ts`
   - 必須の CI の全部
4. 旗を下ろしたページの静的な一致: develop の `page-css.ts` と、旗無しで大きな組み合わせを比べて差 0 (`phase-b-design.md` §8.9 と同じやり方)。
5. 独立の Fresh Review で C/H/M = 0。
6. **merge はオーナーの明示の承認の後** (DEV-083 §8)。

## 10. オーナーの判断が要ること

> **オーナーの判断が要る (未承認)**
>
> 1. `display_nowrap` を今の対象 (店名の全体と固定のラベル) のまま ON にするか。
>    - ON にしても、3店の見た目はほぼ戻らない (§1・§5)。戻るのは、つぐ手の 601〜785px の小さな店名の行だけ。
> 2. 略称 (つぐ手・輪・ゆげ湯) を表示語に入れるかどうか (別の判断、別の PR)。
>    - 入れれば つぐ/手・ゆげ/湯 を直せる。ただし事実の一部を「語」として扱う変更で、`displayWordsOf` の一覧を広げる。この PR はしていない。
>    - 入れても、列が押し広げられて線がずれる問題 (§7) は残る。
> 3. 飾りの語 (まわる・継ぐ・熱い) は、nowrap の対象に入れない (このシートの推奨)。飾りの語は段 D (縦書き・縁取り) と段 C (重なり) の話で、nowrap では C′ に近づかない。
> 4. §6 の証明していないこと (1920 より広い幅、拡大率、ほかの描画系、ほかの書体) を ON の前に要るとするか。
> 5. `word-break: auto-phrase` が今の許可一覧にあることを、そのまま残すか (§5。今の検査が落とすので危なくはないが、nowrap と同じく列を押し広げる)。
>
> このシートは承認ではない。能力の ON・`APPROVED_CAPABILITIES` の変更は、別の承認まで HOLD のまま。
