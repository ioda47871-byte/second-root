# Stage 3: 店舗別 CSS の検査器（DEV-072、2026-10-20）

根拠: `.ai/proposals/design-agent-direction-2026-10-20.md` §8.3（人の正式承認 2026-10-20）。
承認の範囲: 隔離された WSL 環境で Claude が店舗別 CSS を生成する方式を、**ローカルのテストデータで**比較検証すること。
実際の WSL worker への投入・Staging 実走・公開 demo への適用は、それぞれ別に承認を求める。
DEV-072 はその 1 つ目で、**検査器（guard と render check）と、不合格なら既存の表示に戻す経路だけ**を作る。生成器（prompt）・
WSL jail への接続・保存 / 配信は作らない。

## 1. 全体の流れ

```
facts（DemoView）+ profile ──► ProfileRenderer ──► 事実だけの固定の意味構造（HTML）
                                                   canvas = scope root（id="shop-css" data-shop-css、isolation: isolate）
生成した店舗別 CSS ──► 静的 guard ──► render check（Chromium 360/390/1440、CSS なしの同じ頁と比較）
                         │ 不合格            │ 不合格
                         └──────► null ◄─────┘  = profile renderer の通常の CSS の頁（今と同じ）
                                   合格 ──► 正規化した CSS ──► <candidate>.shop-css.json（local preview の run の dir）
                                                                 └► /design-preview だけが読む（record の束縛と guard をもう一度）
```

- 文言は今までどおり事実か固定の見出し語だけ（HTML は renderer、CSS は文字を足せない）。
- shop CSS の `<style>` は canvas の外（notice の後、canvas の前）に置く。canvas の中の selector で `<style>` を表示できない。
- selector はすべて `#shop-css` から始まり、子孫・子の結合子だけ。注記帯（notice）と footer は canvas の**兄弟**なので届かない。
  id を root にするのは、module CSS（hash された class の重ね、最大で class 5 個程度）より常に強くするため（`!important` は禁止）。
- canvas は `isolation: isolate`。中の `z-index`（0〜5 に制限）が sticky の notice（z-index 10）の上に出ない。

## 2. 脅威と対策

| 脅威 | 例 | 対策 |
|---|---|---|
| CSS からのコード実行 / 外部読み込み | `url()`・`@import`・`image-set()`・`expression()`・`behavior`・`-moz-binding`・`@font-face` | url token は tokenizer で拒否。関数・at-rule・property は許可リストだけ。font は app が next/font で自前配信している変数（`var(--font-*)`）と generic family だけ |
| 検査のすり抜け | `\75 rl(`・`u\rl(`・大文字小文字・comment の中の `</style>`・`<!--`・全角文字・`1e9px` | `\` と `<` を入力のどこでも拒否（escape を一切読まない）。非 ASCII は comment の中だけ。制御文字・指数表記・閉じない string / comment / 括弧を拒否（error recovery なし）。名前・関数名は ASCII の小文字に正規化して比べる |
| 属性 selector + url による情報の持ち出し | `[value^="a"] { background: url(...) }` | url が無い上に、属性 selector は renderer の安定した属性の**固定値の完全一致**だけ（`^= $= *= ~= |=`・存在だけ・`i` flag を拒否） |
| 注記・事実を隠す（UI redress） | notice への selector・`display:none`・`visibility`・`opacity:0`・`font-size:0`・同じ色・`position:fixed` の覆い・`clip-path`・`text-indent:-9999px`・`overflow:hidden` | 静的: scope の外に届かない・`display` は none / contents なし・`visibility`・`clip`・`mask`・`filter`・`overflow` なし・`position` は static / relative だけ・offset は ±48px・`opacity` ≥ 0.85・`text-indent` は正だけ・大きさの上限。render: 実際の頁で事実ごとに機械検査（§3） |
| 偽の文言 | `content: "公式サイト"`・`list-style-type: "★"`・`quotes`・counter・`attr()` | `content` は `::before / ::after` だけで `none`・`normal`・`""` だけ。string は他では使えない |
| 事実の意味を変える | `text-decoration: line-through`（品切れに見える）・`direction: rtl` + `unicode-bidi` | line-through・direction・unicode-bidi を許可しない |
| 疑似要素で自分の文字の上に重ねる（hit-test で見えない） | `p::before { position:...; }` | 疑似要素の property は in-flow の飾りだけ（大きさ・余白・枠・地・角丸・vertical-align）。offset・配置・stacking・transform なし |
| 巨大化・資源の浪費 | 巨大な CSS・selector の深い入れ子・`calc()` の掛け算 | 24KB・rule 300・宣言 1500（1 rule 60）・selector 12 / rule・複合 8 / selector・@media 24・値の項 40・入れ子 8。calc の `*` `/` は数（≤10）だけ、量の上限を見積もる |

## 3. 各検査が何を見るか

**静的 guard**（`lib/design-agent/shop-css/guard.ts`・`values.ts`・`tokenize.ts`）
- 構文: CSS Syntax Level 3 の tokenization の部分集合を自前で実装（escape なし）。component value に組み、括弧の対応が崩れたら拒否。
- at-rule: `@media` だけ。条件は `(min-width|max-width: <px|em>)` を `and` で 2 つまで。入れ子なし。
- selector: root `#shop-css`（必要なら固定値の属性つき）→ 型（header main section div p span h1 h2 ol ul li dl dt dd、`*`）・
  属性（data-kind / data-variant / data-ground / data-first-view / data-scale / data-headings / data-fv / data-key は Stage 1、
  aria-labelledby / lang / aria-hidden は今の markup）・`:first-child` など・`:nth-child(An+B)`（|A|,|B| ≤ 99）・`:not(単純)`・
  最後に `::before` / `::after`。class は CSS modules の hash で契約でないので使わない。`a`・`img`・`figure` は選べない。
- property: 明示の許可リスト（layout・flex・grid・配置・字組・色・地・枠・影・transform）。値は種類と上限つき。
  色は hex・`transparent` など少数・`var(--p-*)`（palette、fallback なし）・`rgb()`・`color-mix()`。gradient の色も同じ。
- 出力: parse tree から再直列化（入力をそのまま返さない）。出力を guard に通すと同じ出力（冪等）。問題は固定の符号
  （property 名を付けるのは許可リストの名前のときだけ。作者の言葉は残さない）。

**render check**（`lib/design-agent/shop-css/render-check.ts`・`page-scripts.ts`）
- 360・390・1440px で、shop CSS あり / なしの同じ頁を測り、**shop CSS が壊したものだけ**を `<viewport>:<code>` で返す
  （module CSS の元々の性質で落ちないように。事実の text node は両方で同じ並び）。
- 頁は文字列から置き、要求はすべて abort（font・画像・CSS を取りに行かない）。動きは止める（reduced motion と終状態）。
- 事実（DemoView の店名・地域・紹介文・menu・営業時間・定休日・住所・アクセス・電話）の text node ごとに:
  存在（`fact_missing`）・box がある / 祖先が非表示でない（`fact_hidden`）・横が viewport の中（`fact_offscreen`）・
  overflow / clip-path の祖先で切れない（`fact_clipped`）・行を viewport の中央に scroll して `elementFromPoint` の 3 点が自分
  （透明で文字の無い飾りは可。`pointer-events` は検査中すべて auto: 透過の飾りも覆いとして数える）（`fact_covered`）・
  祖先の opacity の積 ≥ 0.85（`fact_faded`）・transform の縮小も含めた字の大きさ ≥ 12px（`fact_small`）・
  1 行の幅が 2.5 字未満で 3 行以上にならない（縦書きは高さ）（`fact_squeezed`）・
  **実際に塗られた地の上の contrast** ≥ 4.5（事実の文字だけを `-webkit-text-fill-color: transparent` にして full-page の
  screenshot を撮り、各行の box の画素と文字色（alpha と opacity を合成）を比べる。gradient・疑似要素の地・下の兄弟の地も
  画素として入る。下線などのため 10% までの画素は許す）（`fact_contrast`）。
- 注記帯: 計算された style と box（位置も）が同じ（`notice_changed`）、scroll の 3 位置で覆われない（`notice_covered`）。
  footer: style と大きさが同じ（`footer_changed`、位置は頁の高さで動くので見ない）、覆われない（`footer_covered`）。
- 横 overflow（`overflow_x`）・頁の高さが CSS なしの 3 倍（最低 2000px）または 16000px を超えない（`page_too_tall`）。
- scope root が無い（`scope_missing`）・検査自体の失敗（`check_error`）も不合格（fallback）。

**採否**（`apply.ts`）: `shopCssOrFallback` は guard → render check の両方を通ったときだけ正規化した CSS、そうでなければ
null と固定の符号の report。**record**（`record.ts`）: `<candidate>.shop-css.json` は run・candidate・profile の hash・CSS の hash に
束縛。preview の loader はどれかが違うか、guard を通した結果が保存された CSS と一致しなければ読まない（profile の頁に戻る）。
renderer も渡された CSS をもう一度 guard する（型だけに頼らない）。render check は Chromium が要るので preview の表示時には
繰り返さない（record は検査に通ったという記録。安全の境界は guard と scope）。

## 4. parser の選択

postcss は next の推移的依存として node_modules にあるが、**使わない**。理由:
1. postcss は寛容（閉じない block を補うなど、壊れた入力を読めてしまう）で、値は文字列のまま。値の検査には別の tokenizer が要る
2. 許可する部分集合は小さい（escape なし・at-rule 1 つ・selector の小さな文法）。自前の tokenizer は約 200 行で、
   読めないものはすべて拒否（fail closed）にできる
3. 依存を増やさない（package.json と lock の変更・供給網の面が増えない）

## 5. 残り（後の段階、それぞれ別の承認）

- 生成器: 仕様（Design Spec）から店舗別 CSS を書く prompt（Codex か WSL jail の Claude Code）。guard の符号を修正の手がかりに返す
- WSL jail への接続: jail の中で生成し、検査は jail の外（worker）で行う。jail から秘密情報・権限には触れない
- 保存と配信: 公開 demo に使うなら DB に検査済みの CSS だけ（大きさ・hash）、配信前に server で guard をもう一度。render check を
  どこで繰り返すかを決める
- Stage 1（DEV-071、PR #83）の data 属性が develop に入ると、節ごとの selector（`[data-kind]` など）が効く。今の develop の
  markup では `section[aria-labelledby="pr-menu"]` などで節を選ぶ（例の 3 つはこちら）
- 3 店の比較（§8.7）と、生成時間・費用の記録
