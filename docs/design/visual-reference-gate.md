# Claude 自身の閲覧の記録と、視覚参照の門 (DEV-158、Issue #193)

2026-11-03。Issue #193 のコメント `6584276254`・`6591440695` の受け入れ条件を実装する。成功例を参照してデザインするとき、**Claude 自身がその画像を実際に開いて見た**ことを、ほかの根拠 (他の AI の要約・研究記録・ファイル名・SHA) と区別して記録する。

## 3つの区分 (ビューごと)

| 区分 | いつ | 使ってよいこと |
|---|---|---|
| `VISUAL_VERIFIED` | Claude の閲覧の記録が、下の門を通る | 画像のある案件の品質の実証、参照の対応表 |
| `TEXT_ONLY_PROVISIONAL` | 文章だけ (ChatGPT の視覚研究の要約、研究記録、manifest) | 研究の整理、オフラインの道具づくり。「Claude が画像を見て制作した」とは言わない |
| `MISSING_OR_HOLD` | 画像も文章も無い | その工程だけ止める。ほかの作業は続ける |

## 閲覧の記録 (`claude_visual_read_v1`)

置き場所は `design-library/research/quality-pipeline/visual-reads/<case>/<view>.read.json`。**画像そのものは置かない** (リポジトリは public)。

- `asset`:
  - 開いたファイル (リポジトリの登録 WebP か、git に入れない `.intake/` の原本を `intake:` で指す)
  - 原本かプレビューか
  - SHA-256 と画素の大きさ
  - その SHA が manifest に記録されているか
- `reader`:
  - `claude`
  - セッションの URL (**モデル名は書かない**)
  - 開いた時刻
  - 開き方
- `actually_viewed: true` と `viewed_crops`: モデルに見せた範囲 (画像の画素の座標)。縦長のページは切り分けて開くので、その全部を書く。
- `observation`: DEV-155 の `reference_observation_v0`。見えたものを画素の箱で場所つきに書き、解釈 (`inferred`)・学ぶ構造の原理 (`learn`)・写してはいけないもの (`do_not_copy`) を分ける。

## 門 (`checkVisualRead`) が見ること

| 符号 | 止める理由 |
|---|---|
| `READ_SCHEMA` | 形が違う。`actually_viewed` が true でない。範囲が無い。読んだのが Claude でない。観察が箱つきでない (要約の文だけ) |
| `ASSET_NOT_AVAILABLE` | 記録のファイルが、今このセッションに無い。`.intake/` の原本が無い場所 (CI) では `UNVERIFIABLE_HERE` として報告し、`--check` を落とさず、`VISUAL_VERIFIED` にも数えない |
| `ASSET_SHA_MISMATCH`・`ASSET_SIZE_MISMATCH` | 今のファイルのバイトか大きさが、記録と違う |
| `PICTURE_NOT_RECORDED_FOR_CASE`・`PICTURE_KIND_VIEW_OR_PATH_MISMATCH` | 記録の画像が、その件の採用版の画像 (在庫の `original`・`registered_preview`) の**ちょうど1つ**に、ビュー・種類・登録の path まで一致しない。別の件・別のビュー・比較用や不採用の版の画像を付け替えた記録を止める |
| `ORIGINAL_OUTSIDE_INTAKE`・`PREVIEW_IN_INTAKE` | 原本をリポジトリの path で指した (原本は `.intake/` だけ)。プレビューを `intake:` で指した |
| `MANIFEST_CLAIM_WRONG` | 在庫に記録があるという主張が違う |
| `CROPS_DO_NOT_COVER`・`CROP_OUTSIDE` | 見た範囲が、画像の面積の 98% に届かない (4画素の格子で数える)。画像の外を指す |
| `OBSERVATION_*` | 観察が別の画像・別のビューを指す。箱が画像の外 (`checkObservation`) |
| `TOO_FEW_LOCATED_OBSERVATIONS` | 場所つきの観察が8つ未満 |
| `OBSERVATIONS_NOT_SPREAD` | 観察の箱が、画像の上・中・下の3つに散っていない (1画面目だけを見た記録を止める) |

**機械はモデルの中を見られない。** 門ができるのは次の4つだけである。

- 記録を、今ハッシュできるファイルのバイトと大きさに結びつける。
- 見た範囲が画像の全体を覆うことを求める。
- 画像の全体に散った、場所つきの観察を求める。
- 人がその画像を開いて、すべての箱を確かめられるようにする。

要約・ファイル名・SHA だけの記録は通らない。

## 一覧 (`visual-read-matrix.json`)

`npx tsx scripts/design-artifact/visual-read.ts` で書き、`--check` で確かめる (記録が通らないか、一覧が古いと終了 1)。登録された30件について、次をビューごとに持つ。

- ビュー: 在庫の採用版の画像のビュー (コンセプト・PC・SP)。記録が無い件は `unknown`
- `available_for_Claude_visual_read`: リポジトリで開けるファイル (ビュー・種類・path・SHA)
- `read_by_Claude`: 通った記録 (ビュー・**種類 (原本かプレビューか)**・SHA)
- `unverifiable_here`: ここでは確かめられない原本の記録
- `text`: ChatGPT の閲覧、研究記録
- `modes`: 区分

ChatGPT が見た20件は、Claude の記録が無いかぎり `TEXT_ONLY_PROVISIONAL` のまま (テストで固定)。30件と、ChatGPT が見た20件の数もテストで固定した。

## 2026-11-03 の状態

- Claude がこのセッションで開いて記録したのは、リポジトリにある登録 WebP の4枚 (CP-001・002 のコンセプト、CP-003 の PC と SP) で、どれも**原本 PNG ではなくプレビュー**である。
- CP-003 の PC・SP は縦長なので、上から順に切り分けて開いた。最下部の数画素 (PC 8 px・SP 2 px) は見ていない。範囲として正直に記録した。
- CP-009・016 の原本 (オーナーの端末で SHA 一致) は、このセッションに届いていない。届けば `.intake/` で照らし、`intake:` の記録を作る。
- その他の件は `TEXT_ONLY_PROVISIONAL`。
- **画像を見たことと、デザインの品質が上がることは別である。** 品質は、カンプと実装の実画面を見比べる工程と、オーナーの評価で決まる。
