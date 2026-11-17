# DEV-139 Stage 0 A-2 — 架空3店の方向案（各3方向）と、生成実験に出す6案の prompt pin

更新日：2026-11-17。基準：`develop` の `88597749`。Issue #139 オーナー指示（2026-11-17）の A-2。
**生成はしていない。成功例でもない。**モデル呼び出し・画像生成・ネットワーク・DB・worker/timer・公開・送信には触れていない。
すべて `owner_approval: required`・`sendable: false`・`design_generated: false` のまま。

## 何をしたか

1. 架空のパン屋・喫茶・菓子店の3店それぞれに、**その店の facts だけ**から `art_direction_set_v0`（3方向）を作った。
2. 3つとも既存の検査（`lib/design-agent/quality-pipeline/direction-set.ts` の C1〜C7、スキーマ `directions.length(3)` は不変）で
   `READY_FOR_COMPS`（`reference_mode: TEXT_ONLY_PROVISIONAL`）。**品質の判定ではない**。
3. 各店から2方向（計6）を生成実験用に選び、既存の CLI で design input と prompt pin（`--print-pin`、モデル呼び出しなし）を作って、
   prompt の SHA-256 と文字数を記録した。選択はスキーマに欄が無いので、別ファイル
   `design-library/research/quality-pipeline/poc/s0-generation-selection.json` に書いた。

## 店と facts

| 店 | ディレクトリ | shop_id | facts | facts SHA-256 | direction-set SHA-256 |
| --- | --- | --- | --- | --- | --- |
| パン屋「架空パン工房 こむぎ灯」 | `poc/bakery/` | `fictional-bakery-komugi` | `design-library/research/three-methods/facts-pack.json` のバイトそのままの写し | `e63d925a1e1cdae46502d9e2a1fc2745eb69a47e65df7ba51fdd9036d04597c0` | `341ebf67a8d81e8d83adeaada195758bb9d194f174dfcdecfe264e80ef138632` |
| 喫茶「架空喫茶 二階の窓」 | `poc/cafe/` | `fictional-cafe-nikai` | **新規**（`shop_facts_pack_v1`、16件） | `36e090319c6ef400f9a0981ec2614bb2dde2dcab77ed73a1bd978912dd5e9c70` | `3be9eb1541c5f8fbe4100b03c3a8e57742cd464d977613f0ed370029ae8fdce1` |
| 菓子店「架空菓庵」 | `poc/wagashi/` | `fictional-wagashi` | `design-library/phase2f/wagashi-facts-pack.json` のバイトそのままの写し | `8abbddb5bae816123d99b4642697aea94bdd42ae1d2372b4ac86719daec2b10e` | `8b32bf8b94177b82709bac1ea32a7d9a93fe7085183dbc16f51265ff6430a0c7` |

`poc/` の各店ディレクトリに `facts-pack.json` と `direction-set.json` を置くのは既存の並び（`bicycle`・`tsugute`・`sento`）に合わせた。
写しはバイト単位で同じで、単体テストが元との一致を確かめる（スキーマは分岐させていない）。

喫茶の facts は全部架空である：店名と品名はすべて「架空」で始まり、所在地は「架空市架空区架空町三丁目7-4 2階」、電話は `000-0000-0925`、
説明に「比較研究用の架空の喫茶店です。実在の店舗ではありません。」。実在の人・場所・ブランドは無い。注文・予約・カートの語も値に無い。

**菓子店の facts の制約**：所在地（F4）・道順（F7）・品名（F10〜F16）の値は「テスト」を含むので、B方式の規則で**ページに出せない**。
出せるのは店名・区・営業時間・定休・電話・説明（F9）だけである。3方向とも、F9 の記述（季節の上生菓子、毎朝炊く粒あん、小さな店頭、
一つずつお包み）と表示できる事実だけで構造が立つように組み、品名は使わない（「テスト」を含む値を方向案のどこにも書いていないことを単体テストが確かめる）。

## 9方向（各店3つ）

Hero・流れの組み合わせは9方向で全部違う（パン屋の型を喫茶や菓子店に塗り替えたものは無い）。各店の中では、どの2方向も
8観点（hero, flow, navigation, reading_path, section_layouts, transitions, text_direction, imagery）のうち同じものは**1つ以下**（点検表 B6）。

| 方向 | Hero / 流れ | SP の組み方（1画面目 → 組み替え） | 店固有の根拠 | 成功例の原理と、どう翻訳したか |
| --- | --- | --- | --- | --- |
| パン屋 **d1-kiln-clock** ★ | diagram_led / single_axis_scroll | 店名と 5:00 の目盛り → 軸を左端 24px に寄せ、区画を右に吊るす | F10（毎朝5時に火）, F5（7:30〜17:00、売り切れ次第）, F13 | P2 CP-019：時間の地点を1本の読み順に置く → 蝋のアーチでなく、パンの一日の実時刻の目盛り（間隔は実時間に比例）。P5 CP-008：細い線が区画をまたぐ → 線を時刻の軸にする |
| パン屋 **d2-hearth-floor** ★ | scene_led / one_continuous_surface | 窯の口の弧と店名 → 品を奥から扉へ縦に、左右に半分ずつずらす | F9（石窯）, F12〜F16（5品） | P1 CP-020：店の台を情報の置き場に → 格子の棚でなく、火の側から扉へ冷める窯の床に品を格子にせず置く。P3 CP-012：章ごとに素材の別の面 → 床の奥・中ほど・扉の側 |
| パン屋 d3-flour-crust | type_led / alternating_spreads | 二色に分かれた巨大な店名だけ → 見開きの左右を上下に積む | F11（粉は季節で配合を変える）, F9 | P5 CP-001：巨大な文字が面の区切りをまたぐ → 店名を粉の白と焼き色の境にまたがせる。P5 CP-018：2つの版の重ね → 粉と焼き色の面の入れ替え |
| 喫茶 **c1-window-street** ★ | scene_led / map_of_stations | 窓の桟1本と通りの一部、店名 → 六席の駅を縦一列、道順を最後の駅の前へ | F1・F9・F4（二階の窓、通りを見下ろす）, F10（六席）, F7（階段で二階へ） | P8 CP-026：店の実際の空間から始める → 二階の窓と六席から始める（案内帳の意匠は使わない）。P3 CP-030：街から店へ入る順 → 通りから階段を上がって窓辺の席へ着く順 |
| 喫茶 **c2-nel-drop** ★ | object_led / single_axis_scroll | ネルの線画と筋の上端 → 筋を左3分の1へ、縦書きの品名を横書きに | F9（ネルで一杯ずつ）, F11（淹れる直前に挽く）, F13, F10 | P2 CP-017：中心の大きな形の周りで読ませる → 吊るしたネルを中心の形にして下へ伸ばす。P1 CP-021：作る手順を読み順に → 挽く→注ぐ→落ちる→カップの縦の順 |
| 喫茶 c3-six-seat-plan | diagram_led / alternating_spreads | 縦に回した六席の見取り図 → 見開きを上下に、目次を各見開きの頭の小図に | F10（六席）, F11, F12 | P6 CP-028：決まった数の面を進み SP で順序を組み直す → 六席の見開き。P2 CP-016：物の関係を情報構造に → 窓側と内側の向かい合わせ |
| 菓子店 **w1-wrapping-sheet** ★ | object_led / one_continuous_surface | 包みの正面と縦書きの店名 → 折り目を浅くし、営業時間を1つ繰り上げる | F9（一つずつお包み、上生菓子、粒あん）, F5, F6, F8 | P1 CP-031：広げ・裁ち・組み直す工程を台の構造に → 包みを1段ずつ開く1枚の紙と斜めの折り目。P5 CP-012：物の近くの標本の札 → 折り目の内側の縦書きの注釈 |
| 菓子店 **w2-tsubu-stations** ★ | diagram_led / map_of_stations | 大きな粒と店名 → 駅を縦の蛇行に、1画面1駅、目次を外す | F9（毎朝炊く粒あん）, F11（参照のみ、表示しない）, F5, F6, F8 | P2 CP-009：丸い要素の不揃いの星座と細い線 → 粒あんの粒の散らばりと駅の間の線。P1 CP-002：分かれ方が読む向きを決める → 粒の散らばりが読む向きを決める |
| 菓子店 w3-narrow-front | scene_led / single_axis_scroll | 画面幅いっぱいの柱に店頭と店名の板 → 通りの地を細い帯に、板を柱の中へ | F9（小さな店頭）, F5, F6, F8 | P1 CP-027：店の実際の空間を読み順に → 狭い間口の幅に絞った1本の柱（段差・階段の線は使わない） |

★ = 生成実験に選んだ方向。各方向の `concept`・区画・`pc_plan`・`sp_plan`・`protect`・`not_used`・C1〜C7 の答えは各 `direction-set.json` にある。
成功例は `principles-v1.json` の閲覧済みの件だけを引き、各件の `not_to_copy`（形・色・文言・店名）を写さない旨を `use` に書いた。
同じ業種の例（CP-005 パン、CP-022 ドーナツ、CP-001・CP-020 喫茶）は写す危険が高いので、パン屋では CP-022 を、喫茶では CP-001・CP-020 を `not_used` に置いた
（CP-001 はパン屋 d3 の文字の使い方としてだけ引いた）。

### 店をまたいだ構造の近さ

9方向すべての組で `structuralSimilarity` を測った（宣言の記述子どうし、オフライン）。最大は 0.536（パン屋 d2 と喫茶 c1：どちらも scene_led・自由な読み順）、
兄弟の閾値 0.6 未満。最初の案では喫茶 c2 の区画の型がパン屋 d1 と同じ多重集合で 0.625 になったので、c2 の区画（挽く＝重ね、注ぐ・落ちる＝縦書き、カップ＝全面）と
遷移を作り直した。選んだ6案どうしが 0.6 未満であることは単体テストが確かめる。

## 選んだ6案と prompt pin

| 店 | 方向 | Hero / 流れ | prompt SHA-256 | 文字数 | 参照画像 |
| --- | --- | --- | --- | --- | --- |
| パン屋 | d1-kiln-clock | diagram_led / single_axis_scroll | `5bc7fdd1df57ad334c985212dddac36cd2cf8c56bb299719729e376ea0337bad` | 4871 | 0 |
| パン屋 | d2-hearth-floor | scene_led / one_continuous_surface | `099b73e2033e48875a39ac5f3dfc69568c76d56fd84667008b6a95d90e3fddda` | 4833 | 0 |
| 喫茶 | c1-window-street | scene_led / map_of_stations | `89e23f6ba3e58fc4bee4bbf96b27edf773f11953f1d56b7f6b27686cc4d31d48` | 4888 | 0 |
| 喫茶 | c2-nel-drop | object_led / single_axis_scroll | `c25ac4d59707553acde3f9aac5fe6443261198047dd81295f489ddf6ac45cda5` | 4877 | 0 |
| 菓子店 | w1-wrapping-sheet | object_led / one_continuous_surface | `9930b72798625d2c095401dea338b538e0da36e6f382faafa1dc29a579afe3cd` | 4867 | 0 |
| 菓子店 | w2-tsubu-stations | diagram_led / map_of_stations | `387b6ce4333f001a463e4d26c317e5e2f3999d15b86b84f45be526460c88b2d6` | 4864 | 0 |

route `B_html_prototype`、prompt version `v2`。選んだ理由と外した理由は selection ファイルの `why`。要点：6案で流れの型は
single_axis_scroll・one_continuous_surface・map_of_stations が2回ずつ、どれも違う Hero と組み、Hero×流れの組は6つとも違う。
外した3案（d3・c3・w3）は、根拠が薄い・型が他店の案と近い・画像なしの B方式で比喩が弱まりやすい、のいずれか。

この SHA は**この commit の** `lib/design-agent/phase2f/prompt.ts` と facts・方向案のバイトで決まる。どれかが変われば変わる。
`tests/unit/design-agent/quality-pipeline/three-shop-directions.test.ts` が、下と同じ CLI を別プロセスで一時ディレクトリに走らせ、
6本の SHA と文字数が記録どおりに再現されることを確かめる（Phase 2f の隔離モジュールは import しない）。

## 実行したコマンド（リポジトリの外、`$RUN` は新しい空のディレクトリ）

```bash
P=design-library/research/quality-pipeline/poc
# 方向案の検査（C1〜C7）。0 = READY_FOR_COMPS
for s in bakery cafe wagashi; do
  npx tsx scripts/design-artifact/direction-set.ts --set "$P/$s/direction-set.json" --facts "$P/$s/facts-pack.json"
done
# 選んだ6案：design input（モデル呼び出し・指示文の生成なし）→ 既存の prompt pin（--print-pin だけ。承認は使わない）
for pair in bakery:d1-kiln-clock bakery:d2-hearth-floor cafe:c1-window-street cafe:c2-nel-drop \
            wagashi:w1-wrapping-sheet wagashi:w2-tsubu-stations; do
  shop=${pair%%:*}; dir=${pair#*:}; out="$RUN/$shop-$dir"
  npx tsx scripts/sales/demo-version/prepare-design-input.ts --facts "$P/$shop/facts-pack.json" \
    --directions "$P/$shop/direction-set.json" --direction-id "$dir" --out "$out"
  npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route B --prompt-version v2 \
    --facts "$P/$shop/facts-pack.json" --direction "$out/direction.json" --references "$out/references.json"
done
```

`prepare-design-input` は `$out` に `direction.json`・`references.json`・`pin.json`（`design_generated: false`、`owner_approval: required`、
`sendable: false`）を書く。`--print-pin` は `{"mode":"print_pin", …, "prompt_sha256", "prompt_chars"}` を出すだけで、何も呼ばない。

## 実生成の承認に持っていくもの（未実施）

実際の生成は、上の6本の prompt SHA・文字数・この commit を pin した**個別の承認**が要る（オーナー指示 B：初回6回＋各案1回の再試行、最大12回、画像生成なし、が候補）。
呼び出し回数・使用量の上限・入出力の場所・止め方・戻し方は、承認の依頼でまとめて示す。この文書は承認を与えない。

## 未解決・注意

- **参照画像が0件**：方向案が引ける成功例は `principles-v1.json` の閲覧済みの20件だけで、承認済みの参照（`success-references-v1.json` の CP-003-pc / sp）は
  閲覧済みの一覧に無い（`not_viewed`）。そのため `prepare-design-input` は参照を1枚も渡さず、6本とも文字の指示だけになる。CP-003 を渡すには、
  方向案の検査か参照の扱いを変える判断が要る（検査は緩めていない）。
- **菓子店は表示できる事実が少ない**：所在地・道順・品名が「テスト」を含むため、来店の区画に所在地を出せない。facts を直すのは別の判断（既存の pack を変えていない）。
  また category の値が `baked_goods` のまま。
- **喫茶の facts は新規**で、オーナーの確認を受けていない。
- C6・C7 は設計者（Claude）の答えで、機械の検査ではない。C7 は全方向「unknown」（改良でなく新しい方向のため）。
- カンプは描いていない。PC1440 / SP390 の見た目、事実の誤主張、独自性はまだ測っていない（Stage 0 の後段と C の工程）。
- パン屋 d2 と喫茶 c1 は Hero がどちらも scene_led（近さ 0.536）。生成物で似ていないかは目視で確かめる。

## 追加したファイル

- `design-library/research/quality-pipeline/poc/{bakery,cafe,wagashi}/facts-pack.json`（パン屋・菓子店は写し、喫茶は新規）
- `design-library/research/quality-pipeline/poc/{bakery,cafe,wagashi}/direction-set.json`
- `design-library/research/quality-pipeline/poc/s0-generation-selection.json`
- `tests/unit/design-agent/quality-pipeline/three-shop-directions.test.ts`
- この文書
