# DEV-139 Stage 0 A-2 — 架空3店の方向案（各3方向）と、生成実験に出す6案の prompt pin

更新日：2026-11-17（第3版：DEV-139 で prompt v2.1 を有効化し、6案の v2.1 の pin を CLI で出し直した。第2版：PR #283 のレビュー H1・M1・L1〜L4、CI の2件、PR #284 の facts 経路の制約を反映）。
基準：`develop` の `88597749`。Issue #139 オーナー指示（2026-11-17）の A-2。
**生成はしていない。成功例でもない。**モデル呼び出し・画像生成・ネットワーク・DB・worker/timer・公開・送信には触れていない。
すべて `owner_approval: required`・`sendable: false`・`design_generated: false` のまま。

## ブロッカー（H1）と解消：prompt v2.1 を有効化した（DEV-139、オーナー承認 2026-11-17）

`lib/design-agent/phase2f/prompt.ts` の v2 は、どの店の prompt にも菓子店のための2行を入れる：

- `V2_FACT_RULES`：「for the address show only 名古屋市東区」（テストの値を隠すための規則）
- `V2_IMAGE_RULES.B_html_prototype`：「evoke the sweets」

パン屋（瑞穂区）と喫茶（千種区）の v2 の pin は、facts と食い違う指示をモデルに渡す。**この2店の v2 の pin は実行しない**（v2 自体は変えていない）。

| 版 | 状態 | 店に依存しないか |
| --- | --- | --- |
| v1 / v1.1 | 有効 | 方向案でなく Design DNA の brief から組む。この経路（open direction）では使えない |
| v2 | 有効 | **いいえ**（上の2行） |
| **v2.1** | **有効（DEV-139）** | **はい**：v2 の上の2行だけを facts から組んだ規則（`shopNeutralRules`）に置き換えた |
| tm0 | 有効 | three-methods の brief からだけ組む。この経路では使えない |
| v3（DEV-199f） | **未有効** | **いいえ**：v2 の全文に copy 規則を足したもので、「show only 名古屋市東区」も繰り返す |

v2.1 の規則（値は facts の欄にすでに引用されているので、id だけを書く）：

- 住所：「facts の address の id（例 F4）の値を**省かずにそのまま**」。address が無ければ「出さない」。
- 店の種類：category の id と**その code の意味**（`bakery` = パン、`cafe` = 喫茶、`baked_goods` = 菓子：和菓子または洋菓子）。どちらの菓子かは
  その店の description と品の facts が言う（レビュー L2：菓子店を「焼菓子」へ向けない。店ごとの書き分けはしない）。code 自体は表示しない。
- 品：`service_N`（古い pack では `menu_item_N`）の id を列挙し、その名前のとおりに出す。ほかの品・価格・材料・特徴は作らない。品が無ければ「出さない」。
- 画像の規則（B）：写真を CSS や SVG でまねず、facts が名指すものを色・形・文字・線で。C は v2 と同じ。
- **矛盾する facts は prompt を作らずに拒む**（レビュー L2）：address か品に「テスト」を含む（`FACTS_ADDRESS_PLACEHOLDER` / `FACTS_PRODUCT_PLACEHOLDER`。
  「全部出せ」と「テストは出すな」がぶつかるため）、category が無いか上の3つ以外（`FACTS_CATEGORY_UNSUPPORTED`）。コミット済みの
  `design-library/phase2f/wagashi-facts-pack.json`（所在地がテスト町）は v2.1 では拒まれる。その pack は v2 のまま（変えていない）。

CLI：`phase2f-design`（`--print-pin` と実呼び出し）と `phase2f-steps --package` が `--prompt-version v2.1` を v2 と同じ入力（`--direction`・`--references`、
brief なし）で受ける。`from-generation.mjs` は v2 と v2.1 の設計だけを受ける。**有効でない版（v3、未知の値）は、両 CLI とも何より先に
`PROMPT_VERSION_NOT_ACTIVATED` で拒む**（`USAGE` にしない。レビュー L1。v9 も同じコードになった）。CLI・隔離テストの許可一覧は変えていない。

テスト：`tests/unit/design-agent/phase2f/prompt-v21.test.ts`（v2 から2行を置き換えただけであること、住所・種類・品が facts の id から来ること、
矛盾する facts を名前付きで拒むこと、CLI の pin、有効でない版のコード）、`prompt-unchanged.test.ts`（develop `5af70616` で取った v1 / v1.1 /
v1.1+research / v2 / v3 / tm0 × route B・C × 5つの facts の 80 通りの SHA と文字数が変わらないこと）。

## 何をしたか

1. 架空のパン屋・喫茶・菓子店の3店それぞれに、**facts 経路で通る版の facts**（下）と、その facts だけから作った
   `art_direction_set_v0`（3方向）を置いた。スキーマ・検査（`directions.length(3)`、C1〜C7）は変えていない。
2. 3つとも C1〜C7 で `READY_FOR_COMPS`（`reference_mode: TEXT_ONLY_PROVISIONAL`）。**品質の判定ではない**。
3. 各店から2方向（計6）を選び、既存の CLI で design input と v2 の prompt pin（`--print-pin`）を作った。v2.1 の有効化の後、同じ入力から v2.1 の pin も CLI で出した。
   選択はスキーマに欄が無いので `design-library/research/quality-pipeline/poc/s0-generation-selection.json` に書いた。

## 店と facts（facts 経路の版）

後で生成物を `--facts-from-store` で取り込み、#280 の同一性の検査（**緩めない**）を通すために、3つとも PR #284 の facts 経路の制約に合わせた：
キーは `service_N` / `statement_N` と単一のキーだけ（`menu_item_N` は `TRUSTED_FACTS_UNMAPPED_KEY`）、住所は名古屋の形
（`isNagoyaAddress`、`名古屋市` を含む。登録の行は facts のバイトから作るので、住所が名古屋の形でないと同一性を通らない）、
category は seed が受ける `bakery` / `baked_goods` / `cafe`。単体テストが3つとも `demoContentFromFactsBytes` と `isNagoyaAddress` に通す。

| 店 | ファイル | shop_id | facts SHA-256 | direction-set SHA-256 |
| --- | --- | --- | --- | --- |
| パン屋「架空パン店 ほし窯」（**新規**） | `poc/bakery/facts-pack.json` | `fictional-bakery-hoshigama` | `d46adc81bee7b7096e47f57091d88df348ac37cf389d7cce071a76f634fcf715` | `ac91a9d2bd3345a7f72888c22213bd0bb52f68d7ba2d5fe51d853138dd57debb` |
| 喫茶「架空喫茶 二階の窓」（新規） | `poc/cafe/facts-pack.json` | `fictional-cafe-nikai` | `52c5d7f34a1172dc3ddbe6711f5621fc8a3b40a3ba9f70e1c1271ee05fb63bf2` | `c82ca402fa5c9f2ff4a4b38a05e88b991bbc69a4d1e937e12847294184f6de64` |
| 菓子店「架空菓庵」（facts 経路の版） | `poc/wagashi/facts-pack.json` | `fictional-wagashi` | `7d101d9f726237734422fd03d91eceba05a048107351e4e7a002beb9311fea86` | `4ed514b96c115b47e8ba19c51aad523afeb95d03a672469126982aeec4db8ec7` |

- **パン屋**：第1版は three-methods の「こむぎ灯」を写したが、あの店はその研究のために**予約された店**（`tests/unit/design-agent/research/three-methods.test.ts`：
  名前と id が研究のディレクトリの外に出てはいけない）なので使わない。新しい架空のパン屋を作った：名古屋市瑞穂区架空町四丁目2-6、
  電話 `000-0000-0631`、薪の石窯（毎朝4時半）、二種類の粉、**石窯で焼くのは田舎パンとバゲット**（どの品が石窯かを事実にした）、品は5つ（`service_1`〜`5`）。
  この file が S0 のパン屋の**唯一の正本**で、PR #284 の seed はこのバイトに切り替える。
- **喫茶**：住所を「名古屋市千種区架空町三丁目7-4 2階」、区を千種区に、品を `service_1`〜`4` にした。ほかの値と id は第1版のまま。
- **菓子店**：`design-library/phase2f/wagashi-facts-pack.json` は**変えていない**。新しい版は同じ id・同じ並びで、`menu_item_N` → `service_N`、
  「テスト」の仮の値（所在地・道順・品名7つ）を「架空」の値に置き換えた（所在地「名古屋市東区架空町一丁目2-3」、道順「架空線架空駅 1番出口から徒歩4分」、
  品名「架空季節の上生菓子」など）。ほかの値はバイト単位で同じ（単体テストが確かめる）。category は `baked_goods`（seed が受ける）、電話は元の `052-000-0731`。
  これで所在地と品名もページに出せるようになった。

予約された店の名前（three-methods の identity lock の店名と別名）が3店の facts と方向案のどこにも無いことも単体テストが確かめる。

## 9方向（各店3つ）

Hero と流れの組み合わせは9方向で全部違う。**ただし4つの Hero × 4つの流れを回して割り当てたので、組み合わせが違うだけでは塗り替えを見抜けない**（L4）。
そこで単体テストに、店をまたいで「区画の型の並びが9つとも違う」「比喩の候補の名前が重ならない」「concept の文字の近さ（bigram Jaccard）が 0.3 未満
（実測最大 0.142）」「最後の区画以外の区画の facet が 0.6 未満（C2 の写しの検査と同じ閾値。実測最大 0.462：時間の区画どうし）」を足した。字面の検査で、
書き直せば通る。決めるのはオーナーの目視である。

各店の中では、どの2方向も8観点のうち同じものは**1つ以下**（点検表 B6）。

| 方向 | Hero / 流れ | SP の1画面目 → 組み替え | 店固有の根拠 | 成功例の原理と翻訳 |
| --- | --- | --- | --- | --- |
| パン屋 **d1-kiln-clock** ★ | diagram_led / single_axis_scroll | 店名と 4:30 の目盛り → 軸を左端 24px に | F10（4時半の薪）, F5（7:00〜16:00、売り切れ次第）, F9 | P2 CP-019 → 事実の時刻だけを目盛りにした縦の軸。P5 CP-008 → その線が区画をまたいで売り切れまで続く |
| パン屋 d2-hearth-floor | scene_led / one_continuous_surface | 窯の口の弧と店名 → 区画を奥から扉へ縦に | F12（石窯で焼くのは田舎パンとバゲット）, F9（店先の棚）, F10 | P1 CP-020 → 窯の床と店先の棚の2つの置き場。P3 CP-012 → 位置ごとに別の面 |
| パン屋 **d3-flour-crust** ★ | type_led / alternating_spreads | 二色に分かれた巨大な店名だけ → 見開きを上下に | F11（二種類の粉を季節で）, F12, F9 | P5 CP-001 → 店名が粉と焼き色の境をまたぐ。P5 CP-018 → 2つの面を見開きごとに入れ替える |
| 喫茶 **c1-window-street** ★ | scene_led / map_of_stations | 窓の桟1本・通り・店名 → 駅を縦一列、道順を最後の駅の前へ | F1・F9・F4（二階の窓）, F10（六席）, F7（階段） | P8 CP-026 → 窓から見下ろす通りを地図に。P3 CP-030 → 通りから階段で窓辺へ着く1本の線 |
| 喫茶 **c2-nel-drop** ★ | object_led / single_axis_scroll | ネルの線画と筋の上端 → 筋を左3分の1へ | F9（ネルで一杯ずつ）, F11（直前に挽く）, F13, F10 | P2 CP-017 → 吊るしたネルを中心の形に。P1 CP-021 → 挽く→注ぐ→落ちる→カップの縦の順 |
| 喫茶 c3-six-seat-plan | diagram_led / alternating_spreads | 縦に回した六席の見取り図 → 見開きを上下に | F10, F9・F4・F7, F11・F12〜F16 | P6 CP-028 → 六席の数だけ見開き。P2 CP-016 → 窓側と内側の向かい合わせ |
| 菓子店 **w1-wrapping-sheet** ★ | object_led / one_continuous_surface | 包みの正面と縦書きの店名 → 折り目を浅く | F9（一つずつお包み）, F10〜F16, F4・F7・F8 | P1 CP-031 → 包みを1段ずつ開く1枚の紙。P5 CP-012 → 折り目の内側の縦書きの注釈 |
| 菓子店 **w2-tsubu-stations** ★ | diagram_led / map_of_stations | 大きな粒と店名 → 縦の蛇行、1画面1駅 | F9（毎朝炊く粒あん）, F11, F10〜F16 | P2 CP-009 → 粒の散らばりを地図に、駅を細い線で。P1 CP-002 → 散らばり方が読む向きを決める |
| 菓子店 w3-narrow-front | scene_led / single_axis_scroll | 柱が画面幅いっぱい、店頭と店名の板 → 通りの地を細い帯に | F9（小さな店頭） | P1 CP-027 → 狭い間口を本文の列の幅に |

★ = 生成実験に選んだ方向。各方向の詳細は各 `direction-set.json`。

### 事実に無いことを言わない（L3 で直したもの）

- d1：品を時刻に吊るさない。開店の目盛りには説明の文を一文のまま置き、5つの品名は時刻に結び付けない一覧にした。
- d2：5品すべてを石窯の床に置かない。床に置くのは事実（F12）で石窯で焼く田舎パンとバゲットだけ、残りは店先の棚（F9）。温度の凡例は削った（温度は事実に無い）。
- d3：品と文を組にしない（第1版は「火の文」と塩パンを組にしていた）。
- c1・c3：品を席や窓の側に割り当てない。六席は印として描くだけ。
- w3：「台に一つだけ置かれる上生菓子」をやめた（事実に無い）。店頭に何が並ぶかは描かない。
- 菓子店の3方向：説明の文（F9）を区画ごとに切り分けて言い換えず、一文のまま置く。

### prompt に何が入るか（L2）

v2 の prompt に入る方向案は `concept`・`composition`・`research` だけである（`open-direction.ts` の `openDirectionBlock`）。
`sections`・`sp_plan`・`pc_plan`・`protect` はモデルに届かない（prompt は区画の構成と SP の組み方を「任せる」と書く）。したがって
**区画や SP の違いは方向案の上の宣言で、生成物で守られる保証は無い**。今回は SP の1画面目の1文だけを concept の末尾に入れた。
また research の `translate_to_this_shop` は、第1版では2件とも比喩の `becomes_structure` で同じ文だった。`lib/sales/b-route/generation-prompt.ts` に
`TRANSLATION_MARK`（`／翻訳：`）を足し、参照の `use` を「採るもの／翻訳：この店の構造」と書けば、件ごとに自分の翻訳を渡すようにした。
印の無い古い方向案は今までどおり（単体テストあり）。

## 選んだ6案と prompt pin

| 店 | 方向 | v2 prompt SHA-256 | 文字数 | v2 で実行してよいか | **v2.1 prompt SHA-256（有効）** | 文字数 |
| --- | --- | --- | --- | --- | --- | --- |
| パン屋 | d1-kiln-clock | `9b0560e7f86b4911508e2b06f6ce99264700954d4c56335286c181725ae75189` | 4922 | いいえ（H1） | `b90951bc37070381c23e22e65aed11d34bf2deb318218a21e83c2815cbab31fe` | 5332 |
| パン屋 | d3-flour-crust | `bdf727ab562f0e8efdc626cb04094acc390e6e99543acbbd1e8c01b61383816e` | 4899 | いいえ（H1） | `4e735dc6c2193b803f65cf5b2ab5b7d1db2a1b8876b9e41c815f4a5d496f7718` | 5309 |
| 喫茶 | c1-window-street | `7ef511d73b4bad38c0d6270225154321f2312a31dbe053c401fde981f9c97da6` | 4908 | いいえ（H1） | `c9d80ad8bc883017d26ab6423a84b23d9361e2aa10829e61b4fc2f746ec22f77` | 5325 |
| 喫茶 | c2-nel-drop | `e88f8d0cacff74f86024ca20c7385a17666ff67ba9a50bbb374cd67095b6c6ae` | 4869 | いいえ（H1） | `e9b6e39ee942b932662adbc61badfb0e5feb1df7dd0593108f464f6d6ce4bc58` | 5286 |
| 菓子店 | w1-wrapping-sheet | `e47c9478261e3d78635cd45f0f7fe22afaf082732a8befdf1bddbea54c9910f9` | 4806 | はい（住所は「名古屋市東区」までになる） | `cb46674e7e594a33289e56ee9994e5de503316e7c76dcf00f418675c8b1f49cb` | 5271 |
| 菓子店 | w2-tsubu-stations | `0982133cb8dfe5be7be2800c380ac4097cdadb341ff399c460463924404f1f41` | 4785 | はい（同上） | `391c3d969d6140b90f04a7ce82404e2e9859db3d69836b316a023054522af897` | 5250 |

**6本とも v2.1 で実行できる（この PR が `develop` に merge された後）。**v2.1 の pin は、住所を省かずに出し、店の種類と品をその店の facts から
言うので、パン屋・喫茶も facts と食い違わない。v2.1 の SHA は `prompt.ts`・facts・方向案・参照の manifest のバイトで決まり、commit には依らない。
squash merge で commit が変わっても同じバイトなら同じ SHA になるはずだが、**merge 後の `develop` で走らせ直して確かめてから**承認に出す
（`docs/operations/s0-first-generation.md` の 0.）。

route `B_html_prototype`、参照画像は6本とも0件。**選び方（M1 で直した）**：画像を使わない B方式で比べるので、写真に頼る方向を同じ基準で外した。
d2（場面の Hero、全面の写真の枠、寄せ集めの図像）と w3（店頭の場面と写真の枠）と c3（写真の枠3つ。見開きの型がパン屋 d3 と近く、8観点中**3つ**が同じ：
flow・navigation・reading_path）を外し、d3（文字が主役、写真の枠0）を選んだ。6案で Hero×流れの組は6つとも違い、流れの型は
single_axis_scroll（d1・c2）・alternating_spreads（d3）・map_of_stations（c1・w2）・one_continuous_surface（w1）。

構造の近さ（`structuralSimilarity`、宣言の記述子、オフラインで測った値。構造の語彙は隔離されているので単体テストでは測らない）：
9方向すべての組で最大 0.518（パン屋 d2 と喫茶 c1。d2 は選んでいない）、選んだ6案どうしの最大 0.468（c2 と w1）、閾値 0.6 未満。
兄弟の組は C1〜C7 の C2 の検査が閾値で見ている。

v2 と v2.1 の SHA はどちらも CLI（`phase2f-design --print-pin`）が出したもので、同じ入力を `buildDesignPrompt` で組んでも一致する。
`tests/unit/design-agent/quality-pipeline/three-shop-directions.test.ts` が、一時ディレクトリで CLI を別プロセスで走らせて v2 と v2.1 の
6本ずつを記録どおりに再現し、組み立ての結果とも一致することを確かめる。どの SHA も `prompt.ts`・facts・方向案・参照の manifest のバイトで決まる。

## 実行したコマンド（リポジトリの外、`$RUN` は新しい空のディレクトリ）

```bash
P=design-library/research/quality-pipeline/poc
# 方向案の検査（C1〜C7）。0 = READY_FOR_COMPS
for s in bakery cafe wagashi; do
  npx tsx scripts/design-artifact/direction-set.ts --set "$P/$s/direction-set.json" --facts "$P/$s/facts-pack.json"
done
# 選んだ6案：design input（モデル呼び出し・指示文の生成なし）→ 既存の prompt pin（--print-pin だけ。承認は使わない）
for pair in bakery:d1-kiln-clock bakery:d3-flour-crust cafe:c1-window-street cafe:c2-nel-drop \
            wagashi:w1-wrapping-sheet wagashi:w2-tsubu-stations; do
  shop=${pair%%:*}; dir=${pair#*:}; out="$RUN/$shop-$dir"
  npx tsx scripts/sales/demo-version/prepare-design-input.ts --facts "$P/$shop/facts-pack.json" \
    --directions "$P/$shop/direction-set.json" --direction-id "$dir" --out "$out"
  for v in v2 v2.1; do   # v2.1 は DEV-139 で有効化
    npx tsx scripts/design-artifact/phase2f-design.ts --print-pin --route B --prompt-version "$v" \
      --facts "$P/$shop/facts-pack.json" --direction "$out/direction.json" --references "$out/references.json"
  done
done
```

## 実生成の承認に持っていくもの（未実施）

- 実際の生成には、prompt SHA・文字数・merge 後の commit を pin した**個別の承認**が要る（オーナー指示 B：初回6回＋各案1回の再試行、最大12回、画像生成なし、が候補）。
- 6本とも **v2.1 の pin** で出す（パン屋・喫茶の v2 の pin は使わない）。最初の1回（パン屋 d1-kiln-clock）の手順・止まる条件・元に戻し方は
  `docs/operations/s0-first-generation.md`。
- この文書は承認を与えない。

## facts の版の取り違え（レビュー L4）

菓子店の facts 経路の版（`poc/wagashi/facts-pack.json`）は、コミット済みの `design-library/phase2f/wagashi-facts-pack.json` と同じ
`shop_id: fictional-wagashi` で、バイト（facts SHA）は違う。生成の経路で **shop_id だけを鍵にしているところは無い**ことを確かめた：

- 方向案は facts SHA に結びつく（C1 `FACTS_SHA_MISMATCH`）。菓子店の版の方向案にコミット済みの pack を渡すと、`prepare-design-input` は
  `DIRECTION_SET_HOLD` で止まる（単体テストあり）。
- design input の `pin.json`、Design Artifact（`facts_pack_sha256`、intake が照合）、接着（`from-generation.mjs`）はどれも facts SHA を照合する。
- prompt は facts の値を引用するので、承認が結びつく prompt SHA が facts のバイトに結びつく。台帳は承認 ID と plan ID が鍵で、店の ID を持たない。
- v2.1 はコミット済みの pack（テスト町）を `FACTS_ADDRESS_PLACEHOLDER` で拒む。
- 選択の記録（`s0-generation-selection.json`）は店ごとに facts SHA を持ち、単体テストがファイルのバイトと照合する。

DB の seed（PR #284）はパン屋だけで、facts のパスと SHA を持つ。将来、菓子店の版を登録や seed に入れるときは、facts SHA で結ぶか別の id にする。

## 未解決・注意

- **H1**（上）は v2.1 の有効化で解消（merge 後）。v3 は未有効のまま。
- **参照画像が0件**：方向案が引ける成功例は `principles-v1.json` の閲覧済みの20件だけで、承認済みの参照（CP-003-pc / sp）は `not_viewed` にある。
  6本とも文字の指示だけになる。CP-003 を渡すには検査か参照の扱いを変える判断が要る（緩めていない）。
- 区画・SP・守る部分は prompt に入らない（L2）。生成物で守られたかは目視で確かめる。
- 喫茶・パン屋の facts と菓子店の新しい版は、オーナーの確認を受けていない。
- C6・C7 は設計者（Claude）の答えで、機械の検査ではない。C7 は全方向「unknown」（新しい方向のため）。
- カンプは描いていない。PC1440 / SP390 の見た目、誤主張、独自性はまだ測っていない。

## 追加・変更したファイル

- `design-library/research/quality-pipeline/poc/{bakery,cafe,wagashi}/facts-pack.json`、`…/direction-set.json`、`…/poc/s0-generation-selection.json`
- `lib/design-agent/phase2f/prompt.ts`：v2.1（`shopNeutralRules`。DEV-139 で有効化、`shopNeutralFactsStop`・`ACTIVATED_PROMPT_VERSIONS` を追加。v1 / v1.1 / v2 / tm0 / v3 の出力は1バイトも変わらない）
- `lib/sales/b-route/generation-prompt.ts`：`TRANSLATION_MARK` / `splitUse`（印の無い方向案は今までどおり）
- `tests/unit/design-agent/quality-pipeline/three-shop-directions.test.ts`、`tests/unit/design-agent/phase2f/prompt-v21.test.ts`、
  `tests/unit/sales/b-route-generation-prompt.test.ts`（1件追加）
- この文書
- DEV-139（v2.1 の有効化）：`scripts/design-artifact/phase2f-design.ts`・`phase2f-steps.ts`（v2.1 を受け、有効でない版を
  `PROMPT_VERSION_NOT_ACTIVATED` で先に拒む）、`scripts/sales/demo-version/from-generation.mjs`（v2.1 の設計も受ける）、
  `tests/unit/design-agent/phase2f/prompt-unchanged.test.ts`（新規）・`prompt-v21.test.ts`、`tests/unit/design-agent/phase2f-live/steps.test.ts`、
  `tests/unit/sales/s0-generation-glue.test.ts`、`three-shop-directions.test.ts`（v2.1 の pin を CLI で再現、L4）、
  `docs/operations/s0-first-generation.md`（新規）、`docs/operations/s0-generation-glue.md`（1行）
