# 成功例の画像参照レーン (DEV-155、Issue #193 の納品物 2)

成功例の画像を、**説明文ではなく画像そのものに結び付けて**読むための、読み取り専用のレーン。
- オフラインだけで動く。実 Codex・画像生成・ネットワークは使わない。Chromium は WebP を描くときだけ使い、外への要求はすべて断る。
- Playwright は Chromium を OS の sandbox なしで起動する。だから、manifest に SHA が記録された画像だけを描く (SHA を先に照らす)。
- **画像はリポジトリに入れない** (リポジトリは public)。

## 何をするか

```
npx tsx scripts/design-artifact/reference-original.ts --intake --case <CP-NNN> --key <manifest の SHA のキー> --file <画像> --out <新しい record.json>
npx tsx scripts/design-artifact/reference-original.ts --check-observation --record <record.json> --observation <observation.json>
```

### 1. 取り込み (`--intake`)

1. manifest のそのキーに記録された SHA-256 と、渡された画像の SHA-256 を照らす。違えば `SHA_MISMATCH` で、何も書かない。出力先が既にあれば `OUT_EXISTS`、画像が読めなければ `FILE_UNREADABLE`。知らないフラグは `USAGE`。
2. 採用版の画像 (`original`) か、その登録 WebP (`registered_preview`) だけを受け付ける。
   - `comparison`・`superseded`・`rejected` は反例なので、`NOT_A_SUCCESS_PICTURE` で断る。
   - 種類の決め方は `lib/design-agent/reference-originals/inventory.ts`。
3. 画像を読む。PNG はそのまま、WebP は Chromium で原寸に一度描いて読む。
4. 記録 (`reference_original_record_v0`) を書く。中身は次のとおりで、画像は書かない。
   - SHA・種類・view・大きさ
   - 出所 (manifest の status・source_kind、リポジトリ内の道)
   - 測った特徴 (`reference_original_features_v0`、下)

### 2. 観察の検査 (`--check-observation`)

- 先に記録そのものを検める。形 (`reference_original_record_v0`、大きさは正の整数) が違えば `RECORD_INVALID`。画像の SHA が今の manifest のそのキーと違えば `RECORD_NOT_IN_MANIFEST`。
- Claude (または検査者) が画像を見て書いた観察 (`reference_observation_v0`) を、記録と照らす。
- 照らすもの:
  - 観察が名指す画像の SHA・case・view が、記録と同じであること。
  - どの項目の箱 (x, y, w, h) も、画像の中にあること。
  - SP の組み直しの項目は、SP の画像にしか書けないこと。

## 測る特徴 (記録だけ、品質の点ではない)

| 特徴 | 何か | 限界 |
|---|---|---|
| `bands` | 行の左右の端 (幅の 6%) の主な色が続く範囲。区画ごとの地の色の切り替え (区画のリズム) を表す | (1) 写真や巨大な文字が左右の端まで届くと、境がずれる。CP-003 PC の深緑の区画は、実際の y≈676 に対して 768 から始まる。(2) 地がグラデーションだと1つの区画が2つの帯に分かれる (CP-003 SP の区画 02)。(3) 地の色が粗い1段しか違わない区画は1つの帯になる (CP-003 の区画 03 と 04) |
| `photo_share` | 24px の塊のうち、粗い色が 18 色以上あり、かつ多い2色が塊の 60% 以下のものの割合。写真らしさを表す | 密な絵 (イラスト) も数える。平らな地の上の大きな明朝の見出しの縁が少し入る。なめらかな写真や暗い写真の部分 (カップの中など) は数えない |
| `colours` | 既存の `observeColours` (website) | — |

## 観察の形 (`reference_observation_v0`)

- **見えたもの (`observed`):** どの項目も「何が」と「どこに (箱)」を持つ。
  - `motif`: 店の固有の物
  - `motif_to_structure`: それが構造になる場所
  - `hero_reading_order`: 最初の画面の読み順
  - `section_rhythm`: 区画のリズム
  - `typography`・`colour`
  - `image_roles`: 写真の役割
  - `mobile_recomposition`: SP の組み直し
  - `defects`: 採用版にもある欠陥
- **解釈 (`inferred`):** 見えたものと分けて書く。
- **`learn`:** 学ぶ構造の原理 (作り方の手順ではない)。
- **`do_not_copy`:** よその店へ写してはいけないもの。

## 今あるもの

| case | view | 画像 | 記録 | 観察 |
|---|---|---|---|---|
| CP-003 | desktop | 登録 WebP 1080×3308 (`be8f9aae…`) | `references/CP-003/desktop.record.json` (帯 3、写真 0.18) | `desktop.observation.json` (欠陥 1: 区画 02 の小見出しを写真が覆う) |
| CP-003 | mobile | 登録 WebP 390×4502 (`45d54a7e…`) | `references/CP-003/mobile.record.json` (帯 5、写真 0.19) | `mobile.observation.json` (欠陥 2: 文字どうし・写真と小さな文字の重なり) |

- 座標は登録 WebP の画素である (原本 PNG とは大きさが違いうる)。
- **CP-009・CP-016:** オーナーが原本を渡したら (`docs/design/quality-pipeline-audit.md` §5)、次の手順で記録する。
  1. `design-library/research/quality-pipeline/.intake/` (git の外) に置く。
  2. `--intake` で SHA を照らす。
  3. 画像を見て観察を書く。
  4. `--check-observation` を通す。
- 画像は commit しない。
- テスト (`tests/unit/design-agent/reference-originals/`) が、次を確かめる。
  - 追跡されたファイルに、記録された原本と同じ SHA のものが無いこと。
  - research の references の下が JSON だけであること。
