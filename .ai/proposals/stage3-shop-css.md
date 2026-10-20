# Stage 3: 店舗別 CSS の検査器（DEV-072、2026-10-20）

根拠: `.ai/proposals/design-agent-direction-2026-10-20.md` §8.3（人の正式承認 2026-10-20）。
承認の範囲: 隔離された WSL 環境で Claude が店舗別 CSS を生成する方式を、**ローカルのテストデータで**比較検証すること。
実際の WSL worker への投入・Staging 実走・公開 demo への適用は、それぞれ別に承認を求める。

DEV-072 はその 1 つ目で、作るのは次の 2 つだけ。
- 検査器（guard と render check）
- 不合格なら既存の表示に戻す経路

生成器（prompt）・WSL jail への接続・保存 / 配信は作らない。
Fresh Review（security、`.ai/reviews/DEV-072.md`）の指摘を受けて §2・§3 を改めた（2026-10-20）。

## 1. 全体の流れ

```
facts（DemoView）+ profile ──► ProfileRenderer ──► 事実だけの固定の意味構造（HTML）
                                                   canvas = scope root（id="shop-css" data-shop-css、isolation: isolate、overflow: clip）
生成した店舗別 CSS ──► 静的 guard ──► render check（Chromium、固定の 7 幅 + CSS の breakpoint の両側、CSS なしの同じ頁と比較）
                         │ 不合格            │ 不合格
                         └──────► null ◄─────┘  = profile renderer の通常の CSS の頁（今と同じ）
                                   合格 ──► 正規化した CSS ──► <candidate>.shop-css.json（local preview の run の dir）
                                                                 └► /design-preview だけが読む（record の束縛と guard をもう一度）
```

- 文言は今までどおり事実か固定の見出し語だけ。HTML は renderer が書き、CSS は文字を足せない（§2 の監査）。
- shop CSS の `<style>` は canvas の外（notice の後、canvas の前）に置く。canvas の中の selector で `<style>` を表示できない。
- selector はすべて `#shop-css` から始まり、結合子は子孫・子だけ。
  - 注記帯（notice）と footer は canvas の**兄弟**なので、selector は届かない。
  - root を id にするのは、module CSS（hash された class の重ね）より常に強くするため（`!important` は禁止）。
- canvas は renderer が付ける inline style で守る。shop CSS は `isolation` も `overflow` も書けない。
  - `isolation: isolate`: 中の `z-index`（0〜5）が sticky の notice（z-index 10）の上に出ない。
  - `overflow: clip`: canvas の中のものは、回転などで canvas の外（footer・notice）に塗れない。

## 2. 脅威と対策

| 脅威 | 例 | 対策 |
|---|---|---|
| CSS からのコード実行 / 外部読み込み | `url()`・`@import`・`image-set()`・`expression()`・`behavior`・`-moz-binding`・`@font-face` | url token は tokenizer で拒否。関数・at-rule・property は許可リストのものだけ。font は 2 種類だけ: app が next/font で自前配信している変数（`var(--font-*)`）と generic family |
| 検査のすり抜け | `\75 rl(`・`u\rl(`・大文字小文字・comment の中の `</style>`・`<!--`・全角文字・`1e9px` | `\` と `<` は入力のどこにあっても拒否（escape を一切読まない）。非 ASCII は comment の中だけ許す。制御文字・指数表記・閉じない string / comment / 括弧も拒否（error recovery なし）。名前・関数名は ASCII の小文字にしてから比べる |
| 属性 selector + url による情報の持ち出し | `[value^="a"] { background: url(...) }` | url が無い。属性 selector は renderer の安定した属性の**固定値の完全一致**だけ（`^=` `$=` `*=` `~=` `\|=`・存在だけの指定・`i` flag は拒否） |
| 注記・事実・見出しを隠す（UI redress） | notice への selector・`display:none`・`visibility`・`opacity:0`・`font-size:1px`・同じ色・`position:fixed` の覆い・`clip-path`・`text-indent:-9999px`・外側の `box-shadow`・`outline` | 静的: §2.1。render: 実際の頁で、文字ごとに機械検査と画素の証明（§3） |
| 偽の文言・意味を変える | `content: "公式サイト"`・list の marker の数字・`hyphens:auto` の「-」・`line-through`・`direction: rtl`・値を別の label の横へ動かす（`top`・`translate`） | §2.2 の監査。位置をずらす手段（offset・translate・負の margin）は無い |
| 巨大化・資源の浪費 | 巨大な CSS・selector の深い入れ子・`calc()` の掛け算・`%` / `em` の入れ子 | 上限: 24KB・rule 300・宣言 1500（1 rule に 60）・selector 1 rule に 12・複合 1 selector に 8・@media 24・breakpoint 4・値の項 40・入れ子 8。calc の `*` `/` は数（≤10）だけで、量の上限を見積もる。font-size に `%` / `em` は無い |

### 2.1 静的に塞いでいるもの（Fresh Review 後）

- **塗りが隣に出るもの**:
  - `box-shadow` は `inset` だけ。外側の影は兄弟の文字や footer の上に塗られ、hit-test にも出ない（Critical 1・2）。
  - `outline` は無い（stacking context の最後に塗られる。Medium 2）。
  - 文字の装飾線は文字自身の色・既定の位置・既定の太さだけ（`text-decoration-color`・`-thickness`・`text-underline-offset` は無い）。
- **位置をずらすもの**:
  - `top` / `right` / `bottom` / `left` / `inset` は無い。`translate` も無い（dd の値を隣の行の label の横へ動かせた）。
  - `position` は static / relative だけで、`z-index` の層を作ることにしか使えない。
  - `transform` は `rotate`（±8°）を 1 つだけ。`scale` / `scaleX` / `scaleY` は無い（隣の要素を `scaleY(2)` で伸ばし、値の上側を消せた。再レビュー High 1）。`transform-origin` は keyword と % だけ。
  - `text-orientation` は `mixed` / `upright` だけ（`sideways` は和文を横倒しにする。再レビュー Low 1）。
- **字の大きさ**:
  - 下限は 12px で、書けるのは次の 3 つだけ（`%`・`em`・vw 単独・`calc` は不可。High 1・Low 2）。
    - `px` ≥ 12・`rem` ≥ 0.75
    - `clamp(<下限>, <px|rem|vw の式>, <上限>)`
    - 下限を 1 つ含む `max()`
- **selector**:
  - 子孫の複合はどれも許可された型名から始まる（`*` も、型の無い `:not()` / 属性だけの複合も無い。Low 1）。
  - これで `a`・`img`・`svg`・`figure` に届かない。

### 2.2 文字を足す手段の監査（Medium 1）

許可している property を、文字（または文字に見えるもの）を生む手段の有無で見直した結果。

| 手段 | 扱い |
|---|---|
| `content` | `::before` / `::after` だけで、`none` / `normal` / `""` に限る（文字は書けない） |
| list の marker | `display: list-item` は無い。`list-style-type` は `none` だけ（`list-style-position` も無い）。`::marker` は選べない |
| counter・`quotes`・`attr()`・`text-overflow` の文字列・`text-emphasis` | 無い |
| `hyphens: auto`（折り返しに「-」を足す） | 無い（`none` / `manual` だけ） |
| `text-transform` | 大文字・小文字・語頭の大文字だけ（字を足さない。full-width などは無い） |
| `font-variant-*` / `font-family` | 字形の変化だけ（字を足さない） |
| 背景の gradient / 罫線 / `column-rule` | 図形だけ（文字にならない） |

疑似要素について、次の 2 点を書いておく。
- 静的に保証しているのは、shop CSS が疑似要素に offset・配置・stacking・transform を与えられないことまで。
- module CSS がすでに位置指定している装飾の疑似要素に地を付けられる点は、静的には止めない。render check（hit-test で疑似要素の地も見る、画素の証明）で止める（Nit 2）。

## 3. 各検査が何を見るか

### 静的 guard

実装は `lib/design-agent/shop-css/guard.ts`・`values.ts`・`tokenize.ts`。

- **構文**: CSS Syntax Level 3 の tokenization の部分集合を自前で実装した（escape なし）。component value に組み、括弧の対応が崩れたら拒否する。
- **at-rule**: `@media` だけ。
  - 条件は `(min-width|max-width: <px|em>)` で、`and` でつなげるのは 2 つまで。入れ子は不可。
  - breakpoint は render check の幅の範囲（320〜1920px、em は 16px で換算）の中だけ。範囲の外だけで効く帯は検査されないため（再レビュー Medium 1）。
  - 異なる breakpoint は 4 つまで（render check の幅の数を抑える）。
- **selector**: root の `#shop-css`（固定値の属性を付けてもよい）から始め、子孫の複合は型名で始める。使えるものは次のとおり。
  - 型: header main section div p span h1 h2 ol ul li dl dt dd
  - 属性: data-kind / data-variant / data-ground / data-first-view / data-scale / data-headings / data-fv / data-key は Stage 1 のもの。aria-labelledby / lang / aria-hidden は今の markup にもある。
  - 疑似 class: `:first-child` など、`:nth-child(An+B)`（|A|・|B| は 99 以下）、`:not(単純)`。
  - 疑似要素: 最後に `::before` / `::after`。
- **property**: 明示の許可リスト（§2.1 の制限つき）。値は種類と上限で縛る。
  - 色に使えるもの: hex・`transparent` などの少数の keyword・`var(--p-*)`（palette、fallback なし）・`rgb()`・`color-mix()`。
- **出力**: parse tree から再直列化する（入力をそのまま返さない）。冪等。
- **問題の報告**: 固定の符号で返す。property 名を付けるのは許可リストの名前のときだけで、作者の言葉は残さない。

### render check

実装は `lib/design-agent/shop-css/render-check.ts`・`page-scripts.ts`。

**検査する幅**
- 固定の 320・360・390・768・1024・1440・1920 に、shop CSS の breakpoint ごとに「b−1・b・b+1」（em は 16px で換算）を加える。
- 帯の中は標本で見ている（再レビュー Low 2）。`repeat(auto-fill, minmax())` や vw の値は帯の中で連続に変わり、帯の中ほどだけの崩れを証明するものではない。breakpoint の両側と固定の幅で見る。
- viewport は mobile emulation を使わない（isMobile なし、820px 以下は touch）。shop CSS は幅でしか分岐できず、module CSS に `(hover)` / `(pointer)` の media は無い。入れば、その両側も検査する。
- 4 幅ずつ並行して検査する。不合格が出た組で止める（`exhaustive` なら最後まで）。

**比較のしかた**
- shop CSS あり / なしの同じ頁を測り、**shop CSS が壊したものだけ**を `<幅>:<符号>` で返す。text node は両方で同じ並びになる。
- 頁は文字列から置き、要求はすべて abort する。script 要素があれば `page_script` で不合格。動きは止める。

**検査する文字（4 種）**
- `fact`: DemoView の事実の文字。
- `label`: canvas の中の、事実以外で aria-hidden でない文字。見出し・行の label・folio など（High 2）。
- `notice`: 注記帯の文字。
- `footer`: footer の注記の文字。

**文字（text node）ごとに見ること**（不合格の符号は `<種>_<検査>`）

| 検査 | 不合格の条件 |
|---|---|
| hidden | box が無いか、祖先が非表示 |
| offscreen | 横が viewport の外に出る |
| clipped | overflow / clip-path を持つ祖先で切れる |
| covered | 行を viewport の中央に scroll し、行の高さの 25%・50%・75% × 横 5 点の `elementFromPoint` が自分以外を返す |
| faded | 祖先の opacity の積が 0.85 未満 |
| small | transform を含めた字の大きさが 12px 未満 |
| squeezed | 1 行が 2.5 字分より細い行が 3 行以上ある |
| contrast | 実際に塗られた地の上で 4.5 未満の画素が 10% を超える |
| ink（画素の証明） | §「画素の証明」を参照 |

- covered の補足: 透明で文字の無い飾りは覆いとみなさない。ただし、その飾りの `::before` / `::after` に地があれば覆いとみなす。同じ見出し・段落の別の行（行送りの詰まった大きな字で行の box が重なる）で地の無いものも覆いとみなさない。
- **画素の証明（ink）**: 頁を 4 枚撮る。
  - 頁の画: 文字あり、検査する文字だけを透明にしたもの。
  - 基準の画: 同じ配置のまま、文字以外の塗りをすべて消したもの（地・枠・影・装飾線・疑似要素・画像を消し、文字は白地に黒）。その文字ありと文字なし。
  - 字ごとに、「墨」の画素（文字が 50% 以上覆う画素）の数を頁と基準で比べる。被覆率は「文字あり − 文字なし」を「文字色 − 文字なし」で割る。色に依らないので、明るい地の暗い字も、暗い地の明るい字も同じに測れる。
  - **最も悪い字**が基準の 0.8 未満なら不合格。平均ではない（再レビュー High 1: 上側 40% の覆いは幅の平均では見えなかった）。墨のまったく無い字も不合格。基準で 6 画素未満の小さな字は測らない。
  - 影・outline・疑似要素・伸ばした隣・回転した隣など、何で覆っても、覆ったところの墨が減る。
- 事実の存在は `fact_missing` で見る。text node の並びが変われば `fact_missing` / `label_missing`。

**注記帯と footer**
- `notice_changed` / `footer_changed`: 次のどちらかで不合格。
  - 計算された style と box が CSS なしと違う（notice は位置も比べる）。
  - **地**（文字と装飾線を透明にした画、上下の端 2px を除く）が CSS なしと 1% を超えて違う。
  - 文字そのものは比べない。footer は頁の高さで動き、sub-pixel の位置が違うと同じ文字でも antialias が違うため（CI 118754174929 で 320px の footer が 5% を超えた）。文字は位置に依らない画素の証明（`notice_ink` / `footer_ink`）で見る。
- `notice_covered` / `footer_covered`: 覆われている。
- 各文字は上の文字ごとの検査（ink を含む）にもかかる。

**頁全体**
- `overflow_x`: 横 overflow。
- `page_too_tall`: 頁の高さが CSS なしの 3 倍（最低 2000px）を超える、または 16000px を超える。
- `scope_missing`: scope root が無い。`check_error`: 検査そのものが失敗した。どちらも不合格（fallback）。

### 採否と record

- **採否**（`apply.ts`）: `shopCssOrFallback` は guard → render check の両方を通ったときだけ、正規化した CSS を返す。それ以外は null と、固定の符号の report。
- **record**（`record.ts`）: `<candidate>.shop-css.json` は run・candidate・profile の hash・**事実（DemoView）の hash**・CSS の hash に束縛する（Low 3）。
  - preview の loader は、どれかが違うか、guard を通した結果が保存された CSS と一致しなければ読まない（profile の頁に戻る）。
  - renderer も渡された CSS をもう一度 guard に通す。
  - render check は Chromium が要るので、preview の表示時には繰り返さない。record は「検査に通った」という記録で、事実が変われば record は使えない。安全の境界は guard と scope。

## 4. parser の選択

postcss は next の推移的依存として node_modules にあるが、**使わない**。理由は 3 つ。
1. postcss は寛容で、壊れた入力も読めてしまう（閉じない block を補うなど）。値は文字列のままなので、値の検査には別の tokenizer が要る。
2. 許可する部分集合は小さい（escape なし・at-rule 1 つ・selector の小さな文法）。自前の tokenizer は約 200 行で済み、読めないものはすべて拒否できる（fail closed）。
3. 依存を増やさない。package.json と lock の変更も、供給網の面も増えない。

## 5. 残り（後の段階、それぞれ別の承認）

- **生成器**: 仕様（Design Spec）から店舗別 CSS を書く prompt。書くのは Codex か、WSL jail の Claude Code。guard と render の符号を修正の手がかりとして返す。
- **WSL jail への接続**: 生成は jail の中、検査は jail の外（worker）で行う。jail から秘密情報や権限には触れない。
- **保存と配信**:
  - 公開 demo に使うなら、DB には検査済みの CSS だけを置く（大きさ・hash）。配信前に server で guard をもう一度通す。
  - render check をどこで繰り返すかを決める（事実が変われば必ず繰り返す）。
- **Stage 1（DEV-071a、PR #83）との関係**: merge 済み。許可した属性の値は profile の schema の定数と一致し、どの値も実際の markup に現れる（test）。`lang` は `en` だけ（`ja` は markup に無い）。
  - 例の 4 つ（kissa-retro・atelier-mono・sakura-wagashi・stage1-hooks）は、Stage 1 の 3 店の layout（vertical_name + vertical_ja・name_menu・name_lead）の全幅で通る。
  - 例を 3 店で検査して、render check が実際の崩れを捕まえた（例を直した）。
    - 2 段組の main と全幅の帯が重なり、帯が Visit 節を覆った。
    - 縦書きの見出しの字が重なった。
    - split の visit で電話番号が画面からはみ出した。
  - 店ごとの CSS は layout に合わせて書く必要がある。帯（surface / inverted）と first view の抜粋には、その店の地と文字色を与える。
  - render check の viewport は isMobile を使わない。mobile の viewport は画面より広い頁を縮小表示するので、CSS あり / なしで画の倍率がずれる。
  - 見つけた renderer の問題（別 task）: DEV-071a の split の visit が 720〜760px で横にはみ出す（電話番号の keep span）。
- **test の書体**: test の頁は IPA Gothic を和文の代わりに使う。WenQuanYi は縦書きの metrics を持たず、縦書きの字が重なり、画素の証明が正しく不合格にする。
  - 実際の頁は next/font の和文書体。実画面での確認は後の段階で行う。
- **比較**: 3 店の比較（§8.7）と、生成時間・費用の記録。
