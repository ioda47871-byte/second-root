# Stage 1: Design Spec（節の構成・節ごとの組み方・文字組の階層・first view）設計（2026-10-20）

根拠: `.ai/proposals/design-agent-direction-2026-10-20.md` §8（人の正式承認 2026-10-20）の 2 と 5。
Stage 1 は B（Design Spec + Components）の段階。最終目標（Codex が店ごとのデザインを考え、Claude がその店専用の
Web デザインを実装する = Stage 3 の店ごとの CSS）への中間で、「テンプレートの variation を増やして完成」とはしない。

## 1. 目的と、変えないこと

目的: Codex が店ごとに次を設計できるようにする（今は固定）。

| 承認の項目 | Stage 1 で Codex が決めるもの |
|---|---|
| 節の構成と順序 | `layout.sections`: 節の種類の並び（事実のある節だけ） |
| 節ごとの layout | 節ごとの `variant`（3〜4 種）と `ground`（地: 無地・surface の面・反転） |
| タイポの階層 | `layout.type.scale`（見出しと本文の比）・`layout.type.headings`（英 / 和の主従・縦書き） |
| 配色・余白・装飾 | 今の palette・spacing・motifs・direction に、節ごとの地を加える |
| first view の構図 | `layout.firstView`: 店名だけ / 店名 + 説明 / 店名 + 営業時間 / 店名 + メニューの抜粋 / 縦書きの店名 |
| ブランドに応じたデザイン | 上を組み合わせ、参考画像と測った色を根拠に選ぶ（prompt） |

変えないこと:
- 文字はすべて事実（DemoView）か固定の見出し語。Codex は文言・HTML・CSS を書かない（Stage 3 で CSS の試験）
- 根拠の無い節は出さない。店舗情報・商品・口コミ・実績を創作しない。「おすすめ」「人気」「看板」などの主張の語は足さない
  （メニューの最初の品を大きく見せる variant はあるが、語は足さない。順序は店の掲載順のまま）
- お知らせ帯・footer の注記・contrast の規則・overflow の検査・品質ゲート（5 軸・accept・MAX_REVISIONS）
- 写真の扱い（DEV-029、Instagram 写真は使わない）

## 2. 互換性（DB の migration なし）

- `design_profile` の DB 制約は `version = '1'` と 8192 byte 以下。Stage 1 は **version 1 のまま、任意の `layout` を加える**。
  保存済みの profile（`layout` 無し）は今と同じ頁を描く（default layout = 今の固定の構成）
- Codex への output schema では `layout` は必須（`designProfileJsonSchema` は必須版から作る。保存・読込の schema は任意）
- 配布の順: server（Vercel）と worker（WSL）は同じ develop から。`layout` を持つ profile を server が受けるには server が先に
  新しい schema である必要がある（develop の merge で Staging は自動で更新、WSL worker の更新は人の操作）。古い worker は
  `layout` を送らないので問題ない。新しい worker と古い server の組は strict parse で拒否され、既存の表示に戻る（安全側）
- 大きさ: `layout` は最大でも約 400 byte

## 3. Schema（`lib/design-agent/profile.ts`）

```ts
export const SECTION_KINDS = ["about", "menu", "hours", "visit"] as const;
export const SECTION_VARIANTS = {
  about: ["lead", "statement", "side_heading"],
  menu: ["numbered", "chips", "columns", "feature_first"],
  hours: ["strip", "block"],
  visit: ["ledger", "cards", "split", "stacked"],
} as const;
export const GROUNDS = ["plain", "surface", "inverted"] as const;
export const FIRST_VIEWS = ["name_only", "name_lead", "name_hours", "name_menu", "vertical_name"] as const;
export const TYPE_SCALES = ["quiet", "standard", "dramatic"] as const;
export const HEADING_STYLES = ["en_ja", "ja_en", "ja_only", "vertical_ja"] as const;

layout: z.strictObject({
  firstView: z.enum(FIRST_VIEWS),
  sections: z.array(SectionSchema).min(1).max(4),   // kind で discriminated union、kind は重複不可
  type: z.strictObject({ scale: z.enum(TYPE_SCALES), headings: z.enum(HEADING_STYLES) }),
}).optional()
```

`DEFAULT_LAYOUT` = `{ firstView: "name_only", sections: [about/lead/plain, menu/numbered/plain, visit/ledger/plain], type: { scale: "standard", headings: "en_ja" } }`
（今の頁と同じ。`layout` 無しの profile はこれで描く）。

## 4. 根拠（事実）と節

| 節 | 使う事実 | 根拠が無いとき |
|---|---|---|
| about | description | 出さない |
| menu | menuItems（1 品以上） | 出さない |
| hours | hours または closedDays | 出さない |
| visit | address・access・phone・hours・closedDays（hours 節があるときは hours・closedDays を除く） | 出さない |

first view:

| firstView | 使う事実 | 根拠が無いとき |
|---|---|---|
| name_only | name | — |
| name_lead | description（hero に置き、about 節は出さない: 同じ文の重複を避ける） | name_only |
| name_hours | hours（hero に抜粋。visit / hours 節にも出る） | name_only |
| name_menu | menuItems の最初の 3 品（hero に抜粋。menu 節にも全品） | name_only |
| vertical_name | 和文を含み、空白なしで 12 字以下の店名（縦書き。phone は横書きの今の組に戻る） | name_only |

`normalizeLayout(layout, demo) → { layout, adjustments }`（`lib/design-agent/layout.ts`、純関数）:
1. 根拠の無い節を外す（adjustment `dropped:<kind>`）
2. 根拠があるのに並びに無い節を、既定の variant・地で末尾に足す（`added:<kind>`）。**全事実が頁に出る**ことを保つ
3. 根拠の無い firstView を name_only に（`first_view:<value>`）。name_lead のときは about 節を外す（`about_in_first_view`）
4. 重複した kind は最初のものだけ（schema でも拒否）

renderer は描く前に必ず `normalizeLayout` を通す（保存済みの profile にも）。pipeline は Codex の答えを normalize し、
adjustments を report に記録（Codex の言葉は残さない規則のまま、記録は固定の符号だけ）。brief の prompt には
「この店で使える節と first view」（事実の有無から作る固定の一覧）を渡し、根拠の無い指定を最初から避けさせる。

## 5. Renderer（`components/demo/profile/`）

- `ProfileRenderer` は `normalizeLayout(profile.layout ?? DEFAULT_LAYOUT, demo)` の順に節を描く。節は部品に分ける
  （`sections/About.tsx`・`Menu.tsx`・`Hours.tsx`・`Visit.tsx`、`FirstView` は hero の中）。DOM の data 属性:
  `data-kind`・`data-variant`・`data-ground`、canvas に `data-first-view`・`data-scale`・`data-headings`
- CSS は新しい `sections.module.css`（`profile.module.css` は direction の preset が大きいので分ける）。direction の preset と
  節の variant は重ねて効く（direction = 見出し・罫・地の質感、variant = 節の組み方）
- 地 `surface` / `inverted`: DEV-067 の対応と同じく、面の中の文字は contrast が保証された組だけ
  （surface: text on surface ≥ 4.5、inverted: background on primary ≥ 4.5。面の中では primary / secondary / accent の文字色を
  text または background に置き換える）。新しい contrast の規則は足さない
- 縦書き（`vertical_ja` の見出し・`vertical_name`）: desktop だけ `writing-mode: vertical-rl`、phone は横書き。
  英字・数字の混じる見出しは縦書きにしない（`ja` の見出し語だけ）
- 見出し語は固定（About / Menu / Hours / Visit と 店について / メニュー / 営業時間 / 店舗のご案内）。`ja_only` は和文だけ、
  `ja_en` は和文を主に英字を小さく
- 写真（DEV-029）の about / visit の slot は、その節があるときだけ描く（無ければ render check が落ちて既存の表示へ）
- motion・photo・DemoFrame は変えない

## 6. 見える変更（DEV-066）と prompt

- `visibleChanges` に `layout.firstView`・`layout.sections`（kind の順・variant・ground）・`layout.type.scale`・
  `layout.type.headings` を足す。normalize した後で比べる（根拠が無くて描かれない変更は見えない扱い）
- `VOCABULARY` に節・variant・地・first view・型の階層を事実どおりに書く。「The page always has, in this order」の文は
  「事実のある節だけを、あなたの決めた順で」に改める
- review の prompt・点・式・verdict・ゲートは変えない

## 7. Test

- schema: 正常・不正（重複 kind・未知 variant・5 節）・`layout` 無しの互換・JSON Schema（必須版）
- `normalizeLayout`: 事実の組み合わせ（全部・説明なし・menu なし・hours なし・名前だけ）× firstView の全値で、
  根拠の無い節が残らない・全事実が節か first view に出る・about の重複なし
- renderer（Chromium）: 全 kind × variant × ground × スマホ / デスクトップ × 事実の多い店 / 少ない店 で
  overflow なし・全事実が出る・注記とお知らせ帯が見える・面の中の文字の contrast・縦書きの desktop / phone
- 互換: `layout` 無しの profile と `DEFAULT_LAYOUT` の profile の HTML が同じ
- 違い: 3 店（業種・ブランドの違う架空の店）の手書きの spec で、節の順・組み方・first view が違うとき、画素と DOM の構造が違う
- pipeline: normalize の adjustments が report に、`visibleChanges` の新しい項目

## 8. 段階（各段で Fresh Review → CI → develop）

1. **DEV-071a**: schema・`normalizeLayout`・renderer の節の部品と CSS・test（Codex の prompt は変えない: `layout` 無しの今の頁）
2. **DEV-071b**: prompt（語彙・使える節の一覧）・Codex の output schema の必須化・pipeline の normalize と report・`visibleChanges`
3. **比較**: 3 店の比較（構造・見た目の違い、実画面、§8-5 の比較項目）。Codex の実際の生成は WSL の worker でしか動かない
   （この container には Codex も ChatGPT のサインインも無い）。local の test data での実行は人の操作が要るので、
   手順と script を用意して人に頼む。それまでは手書きの spec で renderer の表現の幅を示し、そう明記する

## 9. 比較の項目（各段で記録）

店舗間の構造・見た目の違い（DOM の節の順・variant の違い、画素の差）/ 実画面（next build + start の screenshot）/
品質審査（実走は人の承認ごと。local の比較は審査の prompt を使わず目視と機械検査）/ 生成時間とモデルの費用（prompt の長さ、
Codex の呼び出し回数は変わらない）/ 安全性と運用の安定（DB migration なし、保存済み profile の互換、注記の検査）

## 10. DEV-071a の実装メモ（設計からの調整と理由、2026-10-20）

- **Section の schema は `z.union`**（discriminated union にしない）: zod の discriminated union は JSON Schema の `oneOf` を出し、
  Codex の structured output は `anyOf` だけを受ける。kind は literal なので一致する枝は 1 つ（test で `oneOf` が無いことを確認）
- **Codex への schema は 071b まで layout なし**: `DesignProfileCoreSchema`（layout なし）から `designProfileJsonSchema()` と
  review の `revised_profile` を作る（snapshot 不変）。保存・読込（`DesignProfileSchema`・`checkProfile`・bridge の schema）は任意の
  layout を受ける。`visibleChanges` の網羅 test は Core に限定（071b で layout を足す）
- **hours と visit**: hours 節が無いときは visit が営業時間・定休日を出す（今の頁と同じ）。だから DEFAULT_LAYOUT に hours 節を
  `added` しない。「事実を出す節が無いときだけ足す」。hours 節があり visit に他の事実が無ければ visit は `dropped:visit`
- **adjustment の符号**: `dropped:<kind>`・`added:<kind>`・`first_view:<value>`・`about_in_first_view` に加え、重複は
  `duplicate:<kind>`。名前しかない店では normalize 後の sections は空（今と同じく節なし）
- **vertical_name は和文だけの店名**（「和文を含む」より厳しく）: 英字・数字・空白の混じる店名は縦書きにしない（横倒しになるため）。
  12 字以下。phone は横書き
- **name_hours は営業時間だけ**を hero に（定休日は節に）。name_menu は最初の 3 品（語は足さない）
- **互換**: `layout` 無しの profile は layout の data 属性も class も出さず、今の markup と byte 単位で同じ（8 店 × 4 profile ×
  写真 3 種の hash を 3b1c2fb の renderer から固定）。`layout: DEFAULT_LAYOUT` は同じ markup に layout の属性と
  sections.module.css の class が加わるだけ（test で除いて一致を確認）。en_ja の About は今と同じく英字だけ
- **写真**: about / visit の slot は節が描かれるときだけ。`sectionsPresent`（photo の direction の選択）は事実から決めたまま →
  071b で normalize した layout から決める（name_lead で about の写真を選ばないように）
- **CSS**: profile.module.css は変えない。sections.module.css の selector は class の重ねで specificity を上げ、読み込み順に依存しない。
  direction は線の種類・太さ・角の丸み（変数）で新しい variant に効き、見出しの処理は既存の `.heading` に乗る。
  DEV-067（PR #80）を一時的に merge した tree で、10 の direction すべてについて Chromium の検査（overflow・文字の切れ・
  事実・注記・band の contrast・縦書き）が通ることを確認（merge は commit していない）。boutique_minimal は節の
  `--p-primary` を text にするので、inverted の band の地は text の色になる（text on background の保証された組のまま）
- **未対応（後続）**: alignment=center（DEV-067）の中央揃えは既存の class だけが対象で、新しい variant（chips・cards など）は左揃えのまま
- **Test の書体**: この container の既定の和文書体（WenQuanYi）は縦書きの metrics を持たず字が重なる。Chromium の test は IPA の書体を
  `--font-body` / `--font-display` に入れる（実際の頁は next/font の和文書体で、`next build` + `start` の実画面で縦書きを確認）

### Fresh Review（FAIL）への対応で変えた規則（2026-10-20）

- vertical_name: 和文だけ・**6 字以下**。desktop は「掛け軸」の構図: folio が上に全幅、その下で縦の店名と、そのすぐ左に上端を揃えた縦の添え書き（地域と業種、和文だけのとき）を hero の中央に置き、左右の余白をほぼ等しくする。hero の高さは店名に合わせる。motif・枠の写真がある profile では、それを右の余白に置き店名の塊を左へ寄せて釣り合わせる。店名は見出しの 2 倍以上
- name_menu: メニューが 4 品以上、かつ menu 節が最初の節でないときだけ（それ以外は `first_view:name_menu` で name_only）
- 縦書きの見出し（vertical_ja）: 頁のどの節も短くない（`data-short` なし）ときだけ縦。混ぜない
- side_heading は見出しを縮めない。band の地は main で取った palette から（direction の token の付け替えに影響されない）。
  最後の band は footer に接する。boutique_minimal の band は panel の列の中
- normalize の結果は `NormalizedLayout`（節 0 個を許す描画の計画、再 parse しない）
- renderer の baseline は develop の renderer（Stage 1 を含まない tree）から取り直し、fixture に commit を記録

### DEV-071b への申し送り（再レビューの Low 1〜3、2026-10-20）

- **短い節（`data-short`）の判断を normalize へ**: 今は CSS の `:has(.sec[data-short])` で頁の見出しを横書きに戻す。短さは事実（字数・品数・行数）と
  variant だけで決まるので、`normalizeLayout` で判定し、固定の符号（例 `headings:vertical_ja`）の adjustment にして headings を ja_only に落とす。
  prompt の「使える設定」・report・`visibleChanges` を描かれる頁と一致させる（DEV-066 の「見えない変更で round を使わない」）。CSS は結果を描くだけにする
- **boutique_minimal の plain と surface は同じ見た目**（plain の節も surface の panel）: `visibleChanges` でこの組の変更を見えない変更と扱う、または語彙で説明する
- **name_menu の利用可否**: `availableFirstViews` は品数（> 3）だけを見るが、normalize は「menu 節が最初の節」でも外す。brief の「使える first view」の一覧にも
  「menu 節を最初にしない場合に限る」を書く（Codex が組み合わせを外し続けないように）
