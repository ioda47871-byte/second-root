# カンプの道: 文の記録・B方式の描画・Claude 自身の見比べ (DEV-159、Issue #193)

2026-11-03。制作工程の段4 (PC/SP の完成カンプ) と段5の前半 (Claude の自己批評) を、記録の残る道にする。

**ここで「通る」は、品質の判定ではない。** カンプを見て採るかを決めるのはオーナーである。

## 1. 文の記録 (`comp_copy_v1`、`copy.json`)

カンプに出る言葉は、すべて記録のどれかである。

| claim_type | 何か | 条件 |
|---|---|---|
| `fact` | 事実パックの言葉 | `source_fact_ids` が必要。文は値そのもの、値の**文の区切り (。) で切った1文か続く数文**、または空白で区切った1語 (店名だけ) のどれか。足すことも、文の途中で切ることもできない。`label` は決まった一覧 (所在地・時間・定休・道順・電話など) から |
| `creative_expression` | オリジナルのキャッチ・見出し・比喩 | 品質優先の研究の道の、**架空の店だけ** (`lane: quality_research_fictional`)。`owner_review_needed: true` |
| `proposal_pending_review` | 実店舗への文の提案 | `owner_review_needed: true`。確認まで店の言葉として出さない |

**創作の文は、事実を作ってはいけない** (オーナー、Issue #193 コメント `6591440695`)。

- 次の印を含むと `CREATIVE_LOOKS_LIKE_FACT` で止める (オーナーの分類ごと): 数字、金額・メニュー・料金、営業時間・日付、歴史・代々・創業、職人・店主などの人、原材料・素材、受賞・表彰・認定、唯一・最高・人気・評判、お客様の声・レビュー、効果・安全・安心、予約・在庫・限定。
- これは仕掛け線で、事実の検査ではない。最後はオーナーが文を見る。
- 隣り合う創作の文で語を作られないように、同じ印を検める (`COMP_JOINED_TEXT_LOOKS_LIKE_FACT`)。
  - 単位は、文の記録と同じである (1つの文字の節、または `<br>` で折った1行)。見える文字だけを使う。
  - 画面で隣に描かれた単位を、読む向きに2つ・3つつないで検める。
    - 隣とは、同じ行か同じ列で間が 1em 以内、または行や列の折り返しで次の行・列の頭に続くことである。
    - 折り返して次の行・列へ続くのは、同じ塊の中だけである (間は行間まで)。別の塊 (段落、見出しと本文、写真の説明と次の文) は、間がほぼ無いときだけつなぐ。縦書きは、vertical-rl なら左の列、vertical-lr なら右の列へ続く。
    - PC 1440 と SP 390 の両方の幅で測る。
  - **知っている誤検知:** 余白なしで縦に積んだ項目 (`li` など) は、境をまたいでつながる。例えば「割れと人」の次の行が「気長に待つ」だと、人気 になる。止まったら文を言い換える。安全側に倒れる。
  - 事実とラベルの単位は区切りにして、つながない。
- 文に bidi の制御文字があれば止める (`COPY_BIDI_CONTROL`)。CSS の `unicode-bidi: *override`・`direction: rtl`、`dir` 属性と `<bdo>` も止める。
- `quality_research_fictional` は、shop_id が `fictional-` で始まり、店名の事実が「架空」で始まる店だけに使える (`COPY_LANE_NOT_FICTIONAL`)。

## 2. 描画と検査 (`scripts/design-artifact/comp-lane.ts`)

```
npx tsx scripts/design-artifact/comp-lane.ts --dir <カンプ> --facts <事実パック> --out <画像の置き場 (git の外)>
```

1. 文の記録の検査
2. B方式の安全の検査 (`checkPrototype`: script・外の URL・Web フォントを使わない)
3. ページが見せうる文 (文字の節、直接の子の `<br>`・`<wbr>` で折った行は1行として、SVG の文字、`alt`・`title`・`placeholder`・`aria-label`・`value`・`label`・`start`) が、すべて文の記録の文かラベルであること (`COMP_TEXT_NOT_IN_COPY`)。CSS で文字を足すことはできない (`COMP_CSS_CONTENT_TEXT`)。Chromium が解いた CSS (style.css は単独で解く。`<style>`・style 属性・入れ子の @media など) で、`content` (none・normal・空以外)・`attr()`・`counter()`・`quotes`・`list-style` の文字列・`@counter-style` を止める。書かれた値 (`var()`・`env()` を含むものも) に加え、**計算後の値** (var を解いた後) を全要素と `::before`・`::after`・`::marker` で検める (`list-style-type`・`text-emphasis-style`・`content`。空の `content: ""` の飾りは許す)。`hyphenate-character` (と見えない改行の印 U+00AD)・`counter-set`/`counter-reset`/`counter-increment`・`text-emphasis` の文字列も止める。影の DOM と `<template>` (開いても閉じても)、CSS で見せた `<style>` (HTML・MathML。SVG の `<style>` は文字を描かないので除く)、`style.css` を1回だけ読む `<link>` 以外、ブラウザが自分で文字を書く要素 (送信ボタン・ファイル選択・日付と時刻の入力欄・summary の無い details) も止める。**これは禁止の一覧で、文字を書く CSS の全部を証明するものではない。** 最後はオーナーが描いた画像を見る。安全の検査 (2) に落ちたカンプは、ここから先を開かない。文の抜き出しは JS を切り、通信を止めて行う
4. JS を切り、通信を止めて PC 1440 と SP 390 を描き、PNG・SHA・区画の箱を出す。画像の置き場はリポジトリの外だけ
5. `review.json` があれば、描いた画像と照らす。形と参照が崩れていれば落とす。バイトの一致 (`renders_match_here`) は書体で機械ごとに変わるので、報告だけする

写真は、役割と大きさだけを決める仮の板である。実際の写真や生成の画像は、別の承認が要る。

**機械の検査には限界がある。** ページが `overflow: hidden` で切った文字や、区画の外にはみ出した説明は、ここでは見つからない。つぐ手の例では、Claude が描いた画像を見て見つけた。だから次の 3 の見比べが要る。

## 3. Claude 自身の見比べ (`comp_review_v1`、`review.json`)

```
npx tsx scripts/design-artifact/comp-lane.ts --check-review <カンプ>
```

Claude は描いた PC と SP の全体を、自分で開いて見る。記録に書くものは次のとおり。

- 見た範囲 (`viewed_crops`)。描いた画像の 98% 以上を覆う。
- 場所つきの観察 (上・中・下に散らす)。
- 記録の店と方向は、カンプの文の記録の shop_id とカンプのディレクトリ名に一致する (`REVIEW_OF_ANOTHER_SHOP`・`REVIEW_OF_ANOTHER_DIRECTION`)。
- 参照: Claude 自身の `VISUAL_VERIFIED` の閲覧の記録 (DEV-158) の `learn` を**そのまま引き**、カンプのどこで使ったかを箱で示す。ChatGPT の要約や `TEXT_ONLY_PROVISIONAL` の原理は、ここでは引けない。
- 自己批評の巡: `second-root-design-director` の規則どおり**最大2巡、1巡に1つの原因**。守る核を先に書く。その巡が自分で起こした退行は、同じ巡の中で直して書く。
- 残る問題、失敗の符号 (`principles-v1.json`)。
- 判定: `show_owner` / `revise` / `drop`。**成功の判定は書けない。**

描いた画像のバイトは書体で機械ごとに変わる。だから、バイトの照合は描いた場所でだけ意味があり、ほかでは報告だけにする。CI では記録の形・参照・範囲を確かめる。描いた画像の幅は 1440 と 390 に固定し、高さは1画面以上とする。判定が `show_owner` なら、失敗の符号を残せない。

## 例: つぐ手 d1「金の継ぎ目が横断する」

`design-library/research/quality-pipeline/poc/tsugute/comps/d1-seam-across/`

- **参照:** Claude が見た CP-002 と CP-003 (PC/SP)。使ったのは次の4つ。
  - 区画の地の色を工程に合わせて変える。
  - 素材の形を写真の枠の形に使う。
  - 最後の区画に行動の案内を置く。
  - SP では横並びの要素を縦に重ねる。
- **2巡の結果:**
  - 1巡目: 器の割れ目を継ぎ目の線そのものにした。文字の重なりを直した。
  - 2巡目: 余白を詰めた。SP で線が文字の下を通るようにした。この巡で起きた3つの退行も、同じ巡の中で直した。
- **判定は `revise`。** 残る問題は次のとおり。
  - SP で、割れ・欠け・ひびの説明と名札が次の写真の下に隠れるか、はみ出す。2巡目が自分で入れた退行で、最初は記録から漏れていた。独立レビューが描いた画像で見つけた。
  - PC で、金の線が相談の区画の事実の文を横切る。
  - 写真が仮の板のままである。
  - 器が平らな線画である。
- 次の版で直す。オーナーに見せる候補ではあるが、成功例の水準とは言わない。
