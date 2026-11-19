# ほし窯の写真枠: AI 生成の写真の指示書 (DEV-139、**2026-11-18 オーナー承認: 3 枚・1 回限りの実生成**)

2026-11-17。輪 (SR-001) の写真の指示書 (`docs/design/bicycle-ai-photo-brief.md`) と同じ形で、架空のパン屋 ほし窯 の研究ページ
`poc/bakery/fidelity/d2-v1` (方向 `d2-hearth-floor`) の写真の組を設計した。
独立レビュー (PR #287) の後、ページをカンプ `comps/d2-hearth-floor-v2` に合わせて直し、石窯の口の板をアーチの奥へ小さく入れたので、枠を測り直してこの指示書の寸法を直した。

> **状態 (2026-11-18 更新):** オーナーが承認した (Issue #139 comment 6970468763 follow-up, owner message 2026-11-18): d2-v2 に写真を
> 入れて続行・3 枚 (§3 の推奨)・`docs/design/hoshigama-ai-photo-prompt.txt` の本文をそのままの内容・SHA で・1 回限りの実生成
> (最大 3 回の画像呼び出し、Codex 1 回、15 分、再試行なし、ほし窯 d2-v2 だけ、WSL で実行)・拡大は ph-mouth-pc と ph-loaf だけ (2 倍以内)・
> ローカル DB は localhost・test shop だけ。記録は `hoshigama-ai-photos.ts` の `HOSHIGAMA_APPROVAL`、実行の手順は
> `docs/operations/hoshigama-one-time-run-sheet.md`。生成した画像はまだ **0枚** (実行はオーナーが WSL で行う)。
> 下の本文は承認の前に書いたもので、「草案」「未承認」の語はその時の記録として残す (§6 のコードブロックは承認されたバイトそのもの)。

- ほし窯は架空の店である (`poc/bakery/facts-pack.json`)。写真は**デモ用のイメージ**で、実在の店・商品・人・窯ではない。
  看板・文字・ロゴ・値札・包装・人の顔を写さない。店の住所・営業・品揃えの事実を写真で足さない。
- 写真で見せてよいのは事実パックにあるものだけ: 薪の石窯 (F9・F10・F12)、田舎パン (F12・F13)。
  価格・量・重さ・原材料・焼き時間・窯の温度・職人の姿は事実に無いので、写真でも示さない。
- 対象のページは `poc/bakery/fidelity/d2-v2` (d2-v1 から `<wbr>` を外し、折り返しを CSS で決めた版。写真の枠の寸法は d2-v1 と同じ)。カンプは `poc/bakery/comps/d2-hearth-floor-v4` (Claude の見比べ `show_owner`、文章の監査 `approve_candidate`)。元の `d2-hearth-floor`・`-v2`・`-v3` と `fidelity/d2-v1` は記録として残し、候補ではない。
  どちらもオーナーはまだ見ていない。**成功例ではない。**
- 枠の一覧と寸法は `poc/bakery/photo-slots-d2-v2.json` と `photo-slot-edges-d2-v2.json` (d2-v2 の HTML・CSS・copy の SHA で測った。d2-v1 の `photo-slots-d2-v1.json` と寸法は同じ)。

## 1. 写真の枠と、写真にしないもの

ページの 写真｜ の札が付いた板は **2つ**。方向の `image_slots` (石窯の口 full、田舎パン large) のとおりで、輪の5枠・6枚に揃えていない。

| 枠 | ページの役 | 区画 | PC 1440 | 1024 | 768 | SP 390 | 600 / 1199 / 1920 (範囲の端) |
|---|---|---|---|---|---|---|---|
| ph-mouth | 石窯の口 (窯の口から覗く窯の中) | mouth | 460×510 | 327×363 | 245×272 | 190×315 | 292×485 / 383×425 / 613×680 |
| ph-loaf | 田舎パン | deep | 588×490 | 418×348 | 314×261 | 300×250 | 462×385 / 490×408 / 784×653 |

(CSS px、d2-v1 と d2-v2 で同じ。範囲は SP ≤600 と PC ≥601 の2つで、PC の板は 601 から 1920 まで幅に比例して大きくなる。`photo-slots.ts` の既定の端 600・1199・1920 で測った。)

- **ph-mouth の板は、窯の口のアーチの奥に小さく入れた板で、上の辺が半円に切られる** (PC は板の高さの上 45.1%、SP は上 30.2% が丸い角で切れる)。
  方向の `image_slots` の `full` を、アーチに縁取られた窯の中の眺めとして読み替えた (意図。カンプ v2 の `review.json` に記録)。
  写真の四隅の上の方は見えない。主役は下の中ほどに置く。アーチの迫石 (せりいし) と店名 ほし窯、板のまわりの窯の中の暗がり・奥へ下がる弧・床の火の光は
  SVG で描いてあり、写真ではない (写真が無くても Hero が窯の口として読めるように)。
- **写真にしないもの (イラスト・SVG・CSS のまま):** 窯の口の迫石と店名、窯の中の暗がりと奥へ下がる弧 (`.inside`)、石の面の煉瓦の目地 (`.masonry`)、バゲットの輪郭とクープの線 (`.baguette`)、薪の木口と熱の輪 (`.heat`)、
  店先の棚板 (`.plank`)、粉の点の円 (`.dust`・`.mix`)、扉のアーチの線 (`.door-line`)。どれも床の面の図の核で、写真に替えると「1枚の床」の構造が壊れる。
- バゲット (F12・F14) は写真の枠を持たない。方向が枠を宣言していないので、写真を足さない。

## 2. 写真の表現

| | 輪 (承認済み、SR-001) | ほし窯 (この草案) |
|---|---|---|
| 種類 | 店先の作業の記録写真 (被写体は枠ごとに違う) | 窯の中の場面1つと、品の真上からの静物1つ |
| 光 | 夕方の低く硬い横の光、約 4300K | 薪の火の光、約 2200〜2700K。火から遠い所は暗く落とす。外の光・蛍光灯の光を入れない |
| 色 | アスファルトの墨・コンクリート・鋼、黄は1枚に1つまで | ページの床の地の色に合わせる: 焦げ茶 (#1b120c〜#2c1b11)・焼き色 (#8a4f26)・火の橙 (#9a4518〜#e57a2e)・皮の金茶 (#e9b872)・粉の白 (#f3eee5)。青・緑の色かぶりを入れない |
| 視点 | 枠ごとに変える | ph-mouth は窯の口の正面 (目の高さ、窯の中を覗く)。ph-loaf は真上 (90°)。**ページの「窯の口の場面 → 真上から見た床」の視点の移りを、2枚の写真がそのまま担う** |
| 光の向き | 枠ごとに統一の横の光 | ph-loaf の光は画面の上の辺から来る (ページで火のある側 = 上)。影は下 (扉の側) へ落ちる |

**2枚を同じ構図のテンプレートにしない。** 1枚は奥行きのある場面 (正面、遠近)、1枚は平らな静物 (真上、影は短い)。

## 3. 枚数と大きさ

**推奨は 3枚** (2枠。石窯の口だけ PC と SP で2枚)。

- ph-mouth は PC (0.90) と SP (縦長、0.60) の形が大きく違う。1枚 (3:4) でも `requestFor` は通るが、
  PC で写真の約 83% しか残らず (SP の板では約 80%)、アーチで上の角も切れる。だから PC 用 1:1 と SP 用 2:3 の2枚にする (輪の作業台と同じ考え方)。
- ph-loaf は PC と SP の形が同じ (1.2) なので1枚。中央の主役の箱は、どの幅の切り抜きにも入る。
- **代案 (2枚):** ph-mouth を 3:4 の1枚にする。枚数は減るが、PC で上下が詰まる。オーナーの判断に残す。

| 写真 | 比 | 目標 (2倍、範囲の端まで。`requestFor` + `photo-slot-edges-d2-v2.json`) | 使う範囲 |
|---|---|---|---|
| ph-mouth (PC) | 1:1 | 1370×1370 | PC (601〜1920) |
| ph-mouth (SP) | 2:3 | 650×975 | SP (≤600) |
| ph-loaf | 4:3 | 1750×1313 | 全部 |

- **2倍を超える補間の道は無い。** 輪の intake は 2倍を超える拡大を `UPSCALE_EXCEEDS_2X` で拒む (上限で、例外は無い)。
  v1 の版で ph-mouth (PC) の目標は 2140px で、1024 の生成からは届かなかった (約 2.09倍)。この道は取らない。
- **代わりに配置で上限を決めた (v2):** 石窯の口の板をアーチの奥へ小さく入れ、PC の板の幅をページの幅の 31.94% (1440 で 460px、範囲の端 1920 で 613px) に抑えた。
  これで ph-mouth (PC) の目標は 1370px になり、正方形 1536 の生成なら補間なし、1024 の生成でも約 1.34倍 (2倍の内) で届く。
  1920 より広い画面は、ほかの店と同じく保証しない (`DESKTOP_CAP_PX`)。ページを直して板が大きくなるなら、測り直して 1520px 以下を保つ。
- ph-mouth (SP) の 650×975 は、よくある生成の寸法で補間なしに届く。
- ph-loaf の 1750px は、4:3 の 1536×1152 の生成なら約 1.14倍、1024×768 なら約 1.71倍 (どちらも 2倍の内) の補間が要る。
- 輪で認められた補間 (1枚だけ、2倍まで、lanczos3) は輪だけの決定で、ほし窯には**まだ何も認められていない**。
  補間を認めるか、1.5倍の下限 (オーナーの例外の記録が要る) にするかは、オーナーが決める。

## 4. 枠ごとの構図 (事実だけに基づく)

座標は写真の幅・高さに対する割合 (0〜1)。主役の箱は、どの幅の切り抜きにも入り、アーチの切り抜きにも掛からない位置にした
(計算の確かめは、写真の寸法が決まった後に `planSlot` で行う。今は未実施)。

### ph-mouth (PC 1:1 と SP 2:3、同じ場面)

- **被写体:** 薪の石窯の口から覗いた、窯の中。朝の火入れの場面 (F10「毎朝4時半に石窯へ薪をくべます」)。
  窯の床の奥で薪が燃え、炎がドームの天井を舐めるように回る。手前の床は石 (または耐火煉瓦) で、何も置かない。
- **パンを入れない。** 薪が燃えている窯の床にパンを並べる場面は、薪の石窯の焼き方として不自然になりうる (火を掻き出してから焼くことが多い)。
  事実にも焼き方の手順は無い。だからこの写真は火入れだけを見せる。
- **構図:** 目の高さの正面。窯の口の石の縁は、写真の外 (ページの SVG の迫石が縁になる) か、四隅のごく端だけ。
  奥の火は下の中ほどからやや奥 (主役の箱: PC x 0.25〜0.75・y 0.48〜0.88、SP x 0.2〜0.8・y 0.42〜0.88)。上の四隅は暗いドームで、切れてよい。
- **PC と SP は同じ場面に見えること:** 同じ窯・同じ薪の組み方・同じ炎の向き。SP は同じ場面を縦に切り直したもの。

### ph-loaf (4:3)

- **被写体:** 焼き上がった田舎パン (F12・F13)。丸い大きな1個を、真上から。表面のクープ (切り込み) と、焼き色の濃淡と、薄くかかった粉。
- **置き場:** 粉を少し散らした、暗い石の面 (ページの「窯の床」の続き)。板・布・紙・包装・値札・道具を入れない。
- **構図:** 真上 90°。パンは中央からやや左 (主役の箱: x 0.18〜0.68・y 0.2〜0.8)。
  ページで品名 架空田舎パン が板の右下に重なるので、右下は石の面の暗く静かな余白にしておく。
- **光:** 画面の上の辺からの低い暖かい光 (窯の側)。影は短く下へ。
- 量・重さ・切った断面・中身 (くるみなどの具) を見せない (事実に無い)。

## 5. 実画像の生成後に人間が目視する表 (輪の V1〜V8 を ほし窯に合わせた)

MOCK・スタブの写真では1つも合格にしない。

| # | 対象 | 確かめること | 判定 | 今の状態 |
|---|---|---|---|---|
| V1 | ph-mouth | 薪の石窯として正しい: 薪が窯の床の上で燃えている (格子・ガスの火口・電気のヒーターが見えない)、炎がドームの内側に沿って回る、窯の口の周りに煤 | 人の目視 | 未生成 |
| V2 | ph-mouth | 窯の中にパン・天板・型・道具・人の手が入っていない (火入れの場面だけ) | 人の目視 | 未生成 |
| V3 | ph-loaf | 田舎パンとして自然: 丸い大きな1個、クープが焼きで開いている、焼き色にむらがある、粉が表面に薄く残る。形が溶けていない・クープが模様になっていない | 人の目視 | 未生成 |
| V4 | ph-loaf | 真上から撮られている (側面が見えない)、光が画面の上の辺から来て影が下へ落ちる | 人の目視 | 未生成 |
| V5 | ph-mouth (PC) / ph-mouth (SP) | PC と SP が**同じ場面**に見える: 同じ窯の形・同じ薪の組み方・同じ炎の向きと色 | 人の目視 | 未生成 |
| V6 | 3枚すべて | 文字・数字・ロゴ・ブランド名・値札・包装・看板・人の顔や手が入っていない (細部の拡大でも) | 人の目視 | 未生成 |
| V7 | ph-mouth (PC) | PC 1440 と 1920 で、アーチの奥の写真がまわりの描いた暗がりと火の光に馴染み、ぼけていない・輪郭が不自然でない (補間した場合はその倍率で)。アーチの切り抜きで主役 (火) が切れていない | 人の目視 (1440・1920 の実描画) | 未生成 |
| V8 | 3枚すべて | 色と光が §2 のとおり (薪の火の暖かい光、ページの焦げ茶〜粉の白の地に馴染む、青・緑のかぶりなし) で、2つの構図 (正面の場面・真上の静物) が互いに違う | 人の目視 | 未生成 |

## 6. プロンプトの草案 — **draft, not approved** (草案、未承認) → 2026-11-18 そのままのバイトで承認

> **2026-11-18:** オーナーが `docs/design/hoshigama-ai-photo-prompt.txt` (下のコードブロックに 3 行の見出しを付けたもの) を、そのままの内容・SHA-256
> `372f7802…a8f6` で承認した。実行プロンプトは `a7b7d524…62be7f1` (2668 文字)。ファイルの見出しの「DRAFT (未承認)」の文字も承認されたバイトの一部なので変えない。

> **DRAFT (未承認)。この節の文は承認に持っていく前の下書きである。この文で画像を生成しない。道具を呼ばない。**
> DEV-139 (写真の流れ): 下のコードブロックを `docs/design/hoshigama-ai-photo-prompt.txt` に、頭に 3 行の「DRAFT (未承認)」を付けて**草案のまま**固定した
> (SHA-256 `372f7802101f679a519bca9ee2af57a07cbd6faf9df5371b70888e9a7ce3a8f6`・2007 バイト・1988 文字。写真ごとの SHA-256 と、
> この本文から組む実行プロンプトの SHA-256 は `lib/design-agent/quality-pipeline/hoshigama-ai-photos.ts`)。これは**承認に持っていく対象の記録**であり、承認ではない。

```
COMMON: Demo images for a FICTIONAL bakery's research web page. Not a real shop, oven, product or person.
No text, numbers, letters, logos, labels, price tags, packaging, signs, faces or hands anywhere in the image.
Light only from a wood fire: warm, about 2200-2700K, deep shadows away from the fire; no daylight, no fluorescent light,
no blue or green cast. Palette: charred brown, baked brown, fire orange, golden crust, flour white. Photographic, natural,
not illustrated.

ph-mouth-pc (1:1): Eye-level view straight into the mouth of a wood-fired masonry bread oven during the morning firing.
Split logs burn directly on the stone oven floor toward the back; flames curl along the inside of the dome. The near floor
is bare stone, empty. No bread, no trays, no tools. The fire sits low and central (inside x 0.25-0.75, y 0.48-0.88);
the upper corners are the dark dome and may be cut off. The oven's outer arch is outside the frame or only at the very corners.

ph-mouth-sp (2:3): The same oven, the same fire, the same log arrangement and flame direction as ph-mouth-pc, framed
vertically. Fire low and central (inside x 0.2-0.8, y 0.42-0.88).

ph-loaf (4:3): Top-down (90 degrees) still life of one large round country loaf, freshly baked, its scoring opened by the
bake, uneven deep crust colour, a light dusting of flour, on a dark stone surface with a little scattered flour. Nothing else:
no board, cloth, paper, knife or label. Loaf slightly left of centre (inside x 0.18-0.68, y 0.2-0.8); keep the
lower right dark and quiet. Low warm light from the top edge of the frame; short shadows falling downward. Not cut open.
```

## 7. 生成の前に残ること

1. オーナーが d2-v2 (またはカンプ v4) を見て、写真を入れる価値があるかを決める (今はどちらも未確認)。
2. 枚数 (§3 の推奨3枚か代案2枚か) と、補間 (2倍の内) を認めるか、1.5倍の下限か。
3. §6 の本文を別のファイルに固定し、プロンプト全文の承認を受ける (輪の DEV-191 と同じ)。
4. 1回限りの実生成の承認 (輪の DEV-192 と同じ: 1ジョブ・呼び出しの回数・やり直しなし・期限・承認 ID の使い切り)。
   ほし窯の差し替えで AI のデモ画像を許すこと (`photo-swap-shops.ts` の `aiDemoAllowed`・`aiDemoPromptSha256`) と、`AUTORUN_SHOPS`・
   `IMAGE_AUTORUN_SHOPS` に入れることは、その承認と一緒に行う (差分は `docs/operations/hoshigama-one-time-run-sheet.md`)。
   **→ 2026-11-18 承認・実行済み。1 回の実生成は使用済み (Issue #139 comment 6990007019)。Issue #290 P0 で `AUTORUN_SHOPS`・
   `IMAGE_AUTORUN_SHOPS` から外した (`CLOSED_SHOPS`)。新しい ID でも再生成しない。`aiDemoAllowed` は生成済み写真のために残す。**
5. 実生成のあと、§5 の表をオーナーが埋める。写真・manifest・権利の記録は私有の成果物のままで、リポジトリに入れない (`docs/design/photo-intake.md` §3)。
