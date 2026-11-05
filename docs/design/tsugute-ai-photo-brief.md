# つぐ手の6枠: AI 生成の写真の一括の指示書 (DEV-184)

2026-11-05。Issue #193 コメント `6662793266` (オーナー) の3と4による。

> **まだ実行しない。** この指示書を走らせるには、オーナーが生成の手段を1つ承認する必要がある (例: WSL の実機で real Codex を1回だけ、6枚を1バッチ)。その承認はまだ無い。この容器には画像を生成する道具が無く、有料の API・real Codex は別の承認が要る。だから、この版では**1枚も生成していない**。

- つぐ手は架空の店である。6枚は**デモ用のイメージ**で、実在の商品・工房・職人・修理の実績を写したものではない。ページと記録の両方でそう扱う。
- 枠と大きさは `docs/design/tsugute-photo-owner-checklist.md` §1 の表 (d1-v3 と d1-v10 の大きいほう) と同じ。枠の一覧は `poc/tsugute/photo-slots-d1-v10.json`。差し替えは `scripts/design-artifact/photo-swap.ts --page …/fidelity/d1-v10` (DEV-184)。
- 生成した元の画像は**リポジトリに入れない** (公開のリポジトリ)。置き場は `design-library/research/quality-pipeline/.intake/photos/` (git が無視する) かリポジトリの外。

## 1. 6枚に共通の指示 (1つの組に見せるため)

1バッチの全部のプロンプトの頭に、次の共通の段落を付ける。

```
Documentary still-life photograph for a fictional kintsugi (urushi lacquer repair) workshop. Demo image, not a real product.
Light: soft north-window daylight from the upper left, about 5000K, one large diffused source, gentle falloff, no flash,
no hard specular hotspots. Colour: warm washi off-white (#efe8dc) and pale cedar backgrounds, deep urushi brown-black
(#2a1d14), muted cream glaze; low saturation, slightly lifted shadows, fine natural grain, no HDR, no vignette.
Vessel: the SAME hand-thrown stoneware tea bowl in every frame — wide shallow chawan, about 12 cm across, off-white
crackle glaze over a light grey-buff clay body, a thin iron-brown rim, a low unglazed foot ring.
Lens: 85–100 mm macro-equivalent, f/5.6–f/8, eye-level or 30° above, straight verticals, shallow but readable depth of
field. Clean, quiet, plenty of empty space around the subject. No text, letters, logos, labels, signatures, maker's
marks, brand stamps, watermarks, price tags, faces, jewellery, tattoos, painted nails, or identifiable places.
```

- **器の形をそろえる。** どの枠も同じ茶碗 (割れ・欠け・ひびの違いだけ)。ph-desk の器も同じ形。
- **金は描かない (ph-ware・ph-kake・ph-hibi)。** この3枠の板には、ページが金の継ぎ目を**写真の上に**描く (`<svg class="dmg">`、DEV-184 で写真の上に残すと決めた)。写真は**修理の前**の割れ・欠け・ひびだけを写し、金を足さない (金が二重になる)。
- **主役は真ん中、周りに余白。** 切り抜きは主役の箱 (`focal_box`) の中心に合わせる。PC と SP で形が違う。
- 書き出し: PNG か JPEG (品質 90 以上)、sRGB、目標の大きさ**以上**で、その比のまま。拡大して大きさを満たさない (2倍の画素の規則は実の画素で数える)。

## 2. 枠ごとの指示

大きさは「目標 (2倍)」。下限 (1.5倍) はオーナーの例外の記録が要るので、生成では目標を使う。

| 枠 | ページの役 | 比 | 目標の大きさ | 主役の箱 (目安) |
|---|---|---|---|---|
| ph-ware | ふたつに割れた器の接写 | 4:3 | 1610×1208 px | 中央 x 0.30–0.70・y 0.25–0.75 |
| ph-kake | 縁の欠けた器 | 4:3 | 1370×1028 px | 中央 x 0.30–0.70・y 0.25–0.75 |
| ph-hibi | ひびの入った器 | 16:9 | 1600×900 px | 中央 x 0.25–0.75・y 0.20–0.80 |
| ph-dry | 乾くのを待つ器 | 1:1 | 1300×1300 px | 幅の 6 割・高さの 7 割の中 (x 0.20–0.80・y 0.15–0.85) |
| ph-hand | 筆で金を蒔く手元 | 1:1 | 1660×1660 px | 中央 x 0.25–0.75・y 0.25–0.75 |
| ph-desk | 線を相談する机と器 | 4:3 | 1030×773 px | 中央 x 0.25–0.75・y 0.25–0.75 |

ph-dry は1枚 (正方形) とする。SP で主役が切れたら、`SP_PHOTO_REQUIRED` で道具が止まるので、その時だけ SP 用 4:3 (1300×975 px) を1枚足す (§4 の調整の1回に数える)。

各枠のプロンプト (共通の段落のあとに付ける):

1. **ph-ware** (4:3, 1610×1208)
   `The tea bowl broken cleanly into two halves, the two pieces set side by side and almost touching, the jagged break running roughly vertically through the centre of the frame. Close-up from 30° above on pale cedar. Unrepaired: raw clay visible along the break, no gold, no glue.`
   (板の継ぎ目は、PC で幅の 0.45〜0.52 を縦に走る。割れ目が中央を縦に走ると、描いた金がその上に重なる。)
2. **ph-kake** (4:3, 1370×1028)
   `The same tea bowl, whole, with one small chip missing from the rim, the chip facing the camera at the centre. Eye level, washi-paper backdrop. Unrepaired: no gold, no filler.`
3. **ph-hibi** (16:9, 1600×900)
   `The same tea bowl, whole, with a fine hairline crack running sideways across the glaze from the rim, lit low from the left so the line catches the light. Wide close-up on pale cedar, empty space either side. No gold.`
4. **ph-dry** (1:1, 1300×1300)
   `The same tea bowl after lacquer repair, resting inside a plain wooden drying cupboard (muro) with a damp cloth on the shelf, the joins coated in dark urushi (not yet gilded). Calm, dim, warm interior; the bowl centred with wide margins. No people, no labels.`
5. **ph-hand** (1:1, 1660×1660)
   `Two anonymous hands, sleeves of plain indigo work cloth, dusting gold powder with a soft brush onto a lacquered join of the same bowl. Only hands and forearms, no face, no jewellery, no nail polish, short plain nails. Close-up, the brush tip at the centre.`
6. **ph-desk** (4:3, 1030×773)
   `A worktable seen from above at 45°: the same broken bowl, a few fine brushes, a small lacquer palette and a blank sheet of washi paper with a faint pencil line sketch of a seam (no writing). Two chairs implied at the table edge, no people.`

## 3. 来歴の記録 (1枚ごと、非公開)

生成のたびに、次をリポジトリの外 (または `.intake/`) の記録に残す。公開してよいのは SHA と測った値だけ。

| 項目 | 例 / 意味 |
|---|---|
| `generator` | 生成の手段 (例: WSL 実機の real Codex の画像生成) |
| `model` | 生成に使ったモデルの名前と版 (手段が返す文字列のまま) |
| `generated_at` | 生成した日時 (UTC) |
| `prompt_sha256` | 共通の段落 + 枠のプロンプトを UTF-8 で連ねた文字列の SHA-256 (プロンプトの本文も非公開の記録に残す) |
| `seed` / `settings` | 手段が返すなら |
| `file_sha256`・`width`・`height`・`format` | 書き出したファイルの値 (道具の `checkPhotoRights` が照らす) |
| `demo_image` | `true`。「デモ用のイメージ。実在の商品・工房・職人・修理の実績ではない」 |
| `depicts_identifiable_person`・`depicts_real_shop` | どちらも `false` (顔・特徴・実在の場所を写さない) |
| `adjusted` | 調整の回数 (0 か 1) と理由 |

**今の差し替えの道具の権利の記録には、AI 生成の種類が無い。** `photo_rights_v0` の `source_kind` は `owner_provided`・`shop_provided`・`licensed_stock_with_terms` だけである。AI の画像をそのどれかと書くのは偽りになる。差し替えの前に、`source_kind` に生成物の種類 (上の来歴を必須にする) を足すかどうかを決める (別の変更。`lib/design-agent/quality-pipeline/photo-rights.ts`)。それまでは、AI の画像は道具を通さない。

## 4. 回し方 (承認の後)

1. オーナーが生成の手段を1つ承認する (例: WSL 実機で real Codex を1回、この6枚を1バッチ)。実機の resource preflight (`docs/operations/wsl-resource-preflight.md`) を先に行う。
2. 6枚を1バッチで作る。画像が返らない (`CODEX_NO_IMAGE` など) ときは、何度も試さず止めて報告する。
3. Claude が6枚を見て、主役の切れ・文字や印の写り込み・器の形の不ぞろいを確かめる。直すのは問題のある枠だけ、**1回まで**。
4. 来歴を記録し、§3 の種類が足されたら、`photo-swap.ts --page …/fidelity/d1-v10` で差し替え、PC 1440・タブレット 768・SP 390 を描いてオーナーに見せる。成功例の水準とは言わない。
