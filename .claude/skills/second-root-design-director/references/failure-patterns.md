# 不採用例から学ぶ失敗パターン

出典はすべて `design-library/intelligence/v02/` (以下 `v02/`) と `design-library/intelligence/v01/success-patterns.json`
の `known_failure_modes` である。方向案を立てる前に通読し、点検の段で1つずつ当てる。

## 1. 同じ骨格の繰り返し (テンプレート化)

- **CP-016 の初稿** — 「同じような構成になってきた」で却下。上のナビ、左に文字、大きな写真の Hero、
  波の区切り、写真の帯 (`v02/README.md`、`v02/experiments/CP016-zulu-structural-reset.json`)
- **PT-02 の初稿** — 左文字・右写真の繰り返し (`v02/case-comparison.md`)
- 見分け方: 構造記述子の `split_copy_media`・`centered_headline`・`stacked_bands`・`grid_cards` が2つ以上

## 2. 壊れていないだけの凡庸な全頁

- **CP-025 v1** (`OWNER_REJECTED_FULLPAGE_V1`) — 2カラムの Hero、どの店にもある切替タブ、
  交互の帯、同じ AI 画像の使い回し。記録の言葉:「横はみ出し0・JSエラー0は技術的に壊れていないだけ」
  (`v02/experiments/CP025-HOTEL-AUTHENTIC-EDIBLE-ATLAS-v1.md`)
- 教訓: 検査の数値が良いことを、デザインが良いことと取り違えない

## 3. その店ではない (業種の一般論)

- **CP-025 v2** (`OWNER_REJECTED_V2_NOT_SHOP_SPECIFIC`) — 実際の店内や月替わりの品ではなく、
  業種から連想した雰囲気で作った (`v02/experiments/CP025-HOTEL-AUTHENTIC-SPICE-CABINET-v2.md`)。
  v3 は実際の店に戻った (`…-ACTUAL-SHOP-v3.md`)
- **CP-030 の失敗例** — どこにでもある時計のアイコン
- 見分け方: 入れ替えテスト (店名と事実を同業の別の店に替えても成立するか)

## 4. 磨きすぎて核を壊す

- **CP-014 v2** — 密度を足して奥行きを失い「前の方がよかった」。直す前に守る部分を名指しする
  (`v02/experiments/CP014-CAN-BUY-RECORDS-v1-restoration-review.md`)
- **CP-011 v1** — 「ありきたり」の写真の帯。v2 は Hero を守って骨格を直した
  (`v02/experiments/CP011-BARN-structure-recovery-v2.md`)
- **CP-017** — 作り直しで糸の輪 (核) が消えた
- **CP-021 v2** — 色と反射だけを変えた (変えたつもりで、何も変わっていない)

## 5. 仕組みの新しさが見た目を下げる

- **PT-02 の動く本棚** — 「悪くなったな」(`v02/experiments/PT02-interactive-bookshelf-review.md`、
  `PT02-visual-fidelity-v2-review.md`)
- 教訓: 仕掛けは見た目の質の上に足す。見た目と引き換えにしない

## 6. Hero だけで全頁が無い

- CP-025 以降、納品は PC と SP の全頁・比較・動く HTML・QA を揃える
  (`docs/design/research-full-page-review-gate.md`)
- 教訓: 1画面目の絵だけで方向案を決めない。最後の節まで同じ比喩が続くかを書く

## 7. 店の取り違え (Identity)

- CP-014 の KOALA / cobaco、CP-015 の cobaco 書店 (`v02/experiments/CP015-cobaco-identity-rejected.json`
  → REJECT)、CP-028 の KOALA / カリーぴろ
- 教訓: 前の店の名前・prompt・画像を入力に混ぜない。Identity Lock の他店名一覧に入れて検める

## 8. 似すぎ

- **CP-029 v1** — CP-028 に似すぎた
- **CP-023 v5** — 下の3枚カードと多すぎる文字
- 教訓: 直前に作った案・学んだ参照と並べて距離を見る (構造記述子の `TOO_CLOSE_TO_REFERENCE`)
