# 方向の記録と、カンプの前の検査 (DEV-157、Issue #193 の T1)

2026-11-03。制作工程 (`docs/design/quality-first-process.md`) の段2〜3 を、機械で読める記録にする。

- 記録の形: `art_direction_set_v0` (`lib/design-agent/quality-pipeline/direction-set.ts`)
- 検査: `checkDirectionSet` と CLI

```
npx tsx scripts/design-artifact/direction-set.ts --set <direction-set.json> --facts <facts-pack.json>
```

終了コード: 0 = `READY_FOR_COMPS`、1 = `HOLD`、2 = 使い方・入力の誤り (ファイルが無い、JSON でない、事実パックが `shop_facts_pack_v1` でない、事実の id が重なる)。それ以外の例外は不具合として投げる。

**`READY_FOR_COMPS` は「カンプを作ってよい」という意味だけである。** 品質の判定ではない。「成功例レベル」かどうかは、オーナーが PC/SP の実画像を見て決める。

## 記録に書くもの

- `facts_sha256`: 事実パックのバイトの SHA-256。事実パックが変わったら、記録を見直す。
- `motif`:
  - 候補を3〜6つ。それぞれに、源の分類 (物・素材・製法・時間・空間・行為・物理)、事実パックの id、何が構造になるか。
  - 選んだ1つ (最初に試す中心) と、その理由。
- `directions`: ちょうど3つ。方向ごとに次を書く。
  - 中心にするモチーフの候補 (`motif_focus`)。3方向で同じでも、違ってもよい。選んだモチーフは、少なくとも1方向の中心になる
  - 中心の考え
  - Hero の型と流れの型 (`HERO_MODES` / `PAGE_FLOWS`)
  - 構造記述子の8観点 (source は `declared`)
  - 区画 (3〜12)。区画ごとに、モチーフのどの面か・地・配置・写真の枠 (役割と大きさ)
  - 終点
  - PC の計画と、別に書いた SP の計画 (1画面目・並べ替え・重なりの扱い)
  - 守る核
  - 参照した成功例 (原理 P と件) と、使わなかった件
  - チェック C1〜C7 の答え (はい / いいえ / 未確認) と根拠。**根拠は方向ごとに書く** (2方向で同じ文なら止まる)

## 機械が検めること

| チェック | 符号 | 何を見るか |
|---|---|---|
| 形 | `SET_SCHEMA` | 形が違う。方向が3つでない。Hero・流れが語彙の外 (汎用の `split_copy_media`・`centered_headline`・`stacked_bands` は、ここで弾かれる) |
| C1 | `FACTS_SHA_MISMATCH`・`SHOP_ID_MISMATCH` | 事実パックのバイトが、記録した SHA と違う。店の id が事実パックと違う |
| C1 | `MOTIF_CHOSEN_UNKNOWN`・`MOTIF_IDS_DUPLICATED`・`MOTIF_FACT_UNKNOWN` | 選んだモチーフが候補に無い。id が重なる。事実パックに無い id を引いた |
| C1 | `MOTIF_FOCUS_UNKNOWN`・`MOTIF_CHOSEN_UNUSED` | 方向の中心が候補に無い。選んだモチーフがどの方向の中心でもない |
| C2 | `DIRECTION_IDS_DUPLICATED` | 方向の id が重なる |
| C2 | `HERO_OR_FLOW_SHARED` | どこかの2方向で、Hero か流れが同じ (`directionsDiffer`) |
| C2 | `DESCRIPTOR_COMPOSITION_MISMATCH`・`DESCRIPTOR_SECTIONS_MISMATCH` | 構造記述子が、Hero・流れ・区画の配置と合わない。2つの宣言をそろえるだけで、方向が違うことの証明にはならない (どちらも作り手が書く) |
| C2 | `DESCRIPTOR_NOT_DECLARED` | 方向の記録の構造記述子に `measured` がある (ここは宣言だけ) |
| C2 | `SECTIONS_SHARED` | 2方向の中身が同じ: 区画の配置の組 (順は問わない) が同じか、短い方の区画の半分以上でモチーフの面が同じ文。Hero・流れと安い観点のラベルだけを変えた方向を止める |
| C2 | `SIBLINGS_SAME_SKELETON` | 構造記述子の近さが 0.6 以上 (`structureFindings`) |
| C2 | `DESCRIPTOR_ASPECTS_UNKNOWN` | 構造記述子に不明の観点がある (近さの比べ方から外れてしまう) |
| C3 | `MOTIF_FACETS_REPEATED`・`SECTION_IDS_DUPLICATED` | 区画ごとのモチーフの面で、違う文が「区画の数 − 1」未満 (空白・数字・記号を除いて比べる。「金の線1」「金の線2」は同じ文)。区画の id が重なる |
| C4 | `SP_PLAN_NOT_SEPARATE` | SP の計画が PC の計画の写し。SP の3項目のどれかが同じ文 (空白・数字・記号を除いて比べる) |
| C5 | `LOWER_SECTIONS_GENERIC` | 区画の半分以上が汎用の配置 (`split_copy_media`・`grid_cards`) |
| C5 | `GENERIC_SKELETON` | `structureFindings` の汎用の骨格 (Hero・流れが語彙の内に限られるので、今は起きない。語彙が広がったときのために残す) |
| 参照 | `REFERENCE_NOT_VIEWED` | 参照した件か、使わなかった件が、画像を見た20件 (`principles-v1.json` の `cases`) の外 |
| 参照 | `PRINCIPLE_UNKNOWN`・`REFERENCE_PRINCIPLE_NOT_IN_CASE` | 原理の id が無い。引いた件に、その原理が付いていない |
| 参照 | `REFERENCE_BOTH_USED_AND_NOT` | 同じ件を参照と「使わない」の両方に書いた |
| 根拠 | `EVIDENCE_COPIED` | 2方向で、同じチェックの根拠が同じ文 |
| 答え | `DESIGNER_ANSWERED_NO` | 作り手の答えが「いいえ」(1つでもあれば次の段へ進まない) |
| 答え | `ANSWER_CONTRADICTED_BY_CHECK` | 作り手は C1〜C5 に「はい」と答えたが、機械の検査が同じチェックで止めた |

- C6 (写真・図形・文字の関係) と C7 (守る核) は判断である。機械は作り手の答えを記録するだけ。
- 「未確認」は根拠を書けば進める。審査 (段5) で必ず見る。
- C3 の終点は、`ending` の欄が必須というだけである。それが最後の区画を指しているかは、作り手と審査が見る。

## 例: 架空の金継ぎ工房「つぐ手」

`design-library/research/quality-pipeline/poc/tsugute/`。

- **事実パック (`facts-pack.json`):** 比較研究用の**架空の店**。実在の工房ではない。住所・区・電話も架空 (実在の市区や市外局番を使わない)。
- **モチーフの候補:**
  - M1 金の継ぎ目の線 (製法)
  - M2 漆が乾く一か月 (時間)
  - M3 継ぎ目の線を一緒に決める (行為)
  - M4 割れ・欠け・ひび (素材)
- **選んだのは M1** (最初に試す中心)。比べるために、3方向は M1・M2・M3 をそれぞれ中心にした。M4 は3方向とも区画の中で使う。
- **3方向:**

  | 方向 | 中心 | Hero | 流れ | 中身 |
  |---|---|---|---|---|
  | d1 | M1 | `diagram_led` | `one_continuous_surface` | 1本の金の線がページを横断する |
  | d2 | M2 | `type_led` | `single_axis_scroll` | 漆の黒から金へ、層を下る |
  | d3 | M3 | `object_led` | `map_of_stations` | 中心の器のまわりの駅を巡る |

- 参照は見た20件だけ (CP-009・018・019・012・021・030)。引いた原理は、どれもその件に付いているもの。
- 検査は `READY_FOR_COMPS`。**これはカンプを作る準備ができたというだけで、デザインの良し悪しは何も言っていない。** カンプ (T2) とオーナーの盲検の評価が要る。
