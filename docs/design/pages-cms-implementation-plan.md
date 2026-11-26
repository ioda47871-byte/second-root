# Pages CMS の実装計画と最初の実験（DEV-303 §6.1 の 10〜14）

2026-11-26。状態: **計画と、架空の店でのローカルの実験だけ**。外部のアカウント（GitHub・Cloudflare・Pages CMS）は作らず、
GitHub App も導入せず、Cloudflare へ deploy せず、実店舗のデータも使わない。何も公開しない。

## 0. 再開の根拠

2026-11-26、オーナーはこのセッションで「PR #350を完成させ、必要変更9の文書整備へ進めてください。その後、Pages CMSの実装計画と実験を進めてください。」と指示した。
これにより **Pages CMS の実装計画とローカルの実験を、オーナーの指示で再開した**。実際のアカウント（GitHub・Cloudflare・Pages CMS）の作成、GitHub App の導入、
Cloudflare への deploy、本番は、今までどおり**別にオーナーの承認が要る**。Issue #312 の 2026-11-23 の凍結を、実験より先の実装についても解くかは §9 の問い 0。

**オーナー決定（2026-11-26、§9 の問いへの回答。Lead から伝達。要旨）**:

- Issue #312 の凍結は、**架空の店でのローカルの実装と検証についてだけ**解く。外部のアカウント・GitHub App・DNS・deploy・課金はしない。
- 顧客が直せるのは、商品・価格・写真・分類・営業時間・臨時休業・お知らせ。**店名とブランドの表現は固定**（直せない）。**住所と電話は、入力の検査つきで直せる**。
- 各店のデザインを壊さない。共通の情報の形は最小限にする。業種ごとの情報は**任意の拡張**にする。
- 価格は今は自由な文字のまま。**税の自動計算はしない**。その代わり、消費者向けの**総額表示**をオーナーが確かめられる検査を足す（価格の文字を直したり計算したりはしない）。
- 写真: 大きさの上限と構築のときの最適化を検討し、実際の操作性と表示の品質を試す。
- 描画の検査の import の固定: Q1 が既存の描画の道具を使うための、**読むだけ・比べるだけの最小の変更だけ**を認める（どの道具のどの名前かを監査の試験で固定する）。
- まず `experiments/` で作り、安定した共通の部分だけを `lib/` へ移す。
- 公開: CMS で保存したら構築するのが標準。**毎日の定期の構築は今はしない**。日付で自動で消える表示（臨時休業・お知らせ）が要るなら、別に検証する。

正本の仕様: [`image-first-production-flow.md`](image-first-production-flow.md) §3.6（CMS の構成）・§3.7（Q1〜Q4）・§6.1 の 10〜14。
背景: Issue #312 と Draft PR #313 の `docs/operations/customer-owned-cms-handoff-plan.md`（共通の情報の形 §3、小さな検証 §4）。

## 1. 全体の形

```text
店舗の repo（成約後は顧客名義）
  content/menu/<id>.json         商品（1 品 1 ファイル）
  content/categories/<id>.json   分類
  content/news/<id>.json         お知らせ
  content/shop.json              店舗情報（曜日ごとの営業時間・臨時休業を含む）
  media/                         顧客が上げる写真
  .pages.yml                     Pages CMS の設定（content の形から生成）
  site/                          その店だけの頁のコード（承認したデザインから Claude が書く）
  build.mjs                      構築（content を読み、site の頁に差し込み、dist/ を出す）
        |
        | Pages CMS（hosted）で顧客が編集 → GitHub へコミット
        v
Cloudflare Pages（Git 連携。コミットごとに `node build.mjs`、出力 `dist/`。サーバーなし）
```

- **共通にするのは情報の形・読み込み・`.pages.yml` の生成・構築の手順だけ。** 頁の構図・CSS・ラベルの言葉はその店のコードで、
  content から変えられない（テンプレート化しない）。content は決まった枠に escape した文字と写真の場所を入れるだけ。
- 実験の正本: `experiments/pages-cms/`（`content-model.ts`・`pages-config.ts`・`bakery-site.ts`・`build.ts`・`fixtures.ts`・`q1-check.ts`）。
  架空の店「架空のパン屋 こむぎ舎」で、合成の画像だけを使う。

## 2. 情報の形（§6.1 の 10）

| 種類 | 置き場 | 項目 | CMS での扱い |
|---|---|---|---|
| menu_item | `content/menu/<id>.json` | `id`（UUID、自動）、`name`、`category`（分類の ID）、`priceDisplay`（頁にそのまま出す文字）、`description`、`image`（`/media/…`）、`imageAlt`、`soldOut`、`visible`、`displayOrder`。任意の業種の拡張: `sizes`（サイズごとの価格の文字）、`allergens`、`shelfLife` | 編集できる（拡張はその店が使うものだけ） |
| category | `content/categories/<id>.json` | `id`、`name`、`displayOrder`、`visible` | 編集できる |
| announcement | `content/news/<id>.json` | `id`、`title`、`body`、`publishedAt`、`visible` | 編集できる |
| shop_info | `content/shop.json` | `name`（固定）、`address`・`phone`（検査つき）、`hours`（曜日・定休日・開店・閉店）、`hoursNote`、`specialClosures`（日付・理由） | 店名だけ読むだけ。ほかは編集できる |

- 価格は**計算しない**。`priceDisplay` を顧客が書いたとおりに出す（「320円（税込）」「時価」「380〜520円」）。税込・税別の扱いは顧客に確かめる（推測で入れない）。
- **総額表示の検査**（`price-display.ts`、オーナー決定 2026-11-26）: 構築のたびに、頁に出る商品（公開の分類の公開の商品。サイズごとも）の価格の文字を分ける。
  価格の文字の中の**金額を 1 つずつ**見る（オーナーの指示 2026-11-26: 「S 400円（税込）/ M 500円（税別）」は S があっても M を見逃さない）。文字全体が `tax_included` になるのは、
  どの金額も税込で示されているとき（または「本体1,000円（税込1,080円）」「800円（税抜）／880円（税込）」のように、すぐ後に税込の金額が並ぶとき）だけで、報告には税込で示されていない金額を挙げる。
  `tax_included`（税込の金額を**実際に示している**: 「税込価格 1,080円」「1,080円（税込価格）」「1,080円（税・サ込）」も含む。 「税込1,080円」「総額 550円」のように金額の直前、または「324円（税込）」「500円（込）」のように金額の直後。
  「送料込み」「要申込み」「サービス料込み」の 込み や、金額につかない「総額表示は店頭で」「税込価格は店頭で」は数えない）、`tax_excluded_only`（税別・税抜・外税・+税だけで、税込の総額が無い。総額表示の問題としてオーナーが店と話す）、
  `no_tax_wording`（金額はあるが税の言葉が無い。すでに総額かもしれないので店に確かめる）、`no_amount`（時価など）、`empty`。
  報告（`price_report`）は**助言だけ**で、構築を止めず、価格の文字を直さず、計算もしない。言葉による判定で、法的な判断ではない。
- **店名は固定**: CMS では読むだけで、構築でも店のコードが持つ店名と違えば止める（`CONTENT_FIXED_CHANGED`。CMS の外で直された場合も止める）。
- **住所・電話は検査つきで直せる**: 読み込むときに整える（前後の空白は全角の空白も除く。電話の全角の数字・ハイフン・括弧は半角にする。店に打ち直させない）。
  電話は 0 から始まる 10〜11 桁、または +81（「+81 (0)3-…」の (0) も可）。数字・ハイフン・空白・括弧だけで、+ は先頭の +81 だけ、括弧は対で入れ子なし、
  区切りは続けない・前後に置かない、すべて 0 は不可。住所は 120 字まで、リンク（http・www・://）と `<` `>` を書けない。
  CMS の `pattern` は入力の目安で、最終の検査は構築（`phoneOk`・`addressOk`）。Pages CMS は `pattern` の正規表現の方言を書いていない（例に PCRE 風の `(?s)` がある）ので、
  JavaScript と PCRE に共通の書き方（文字の組・先読みの否定）だけを使う。
- **営業時間**: 開いている日は開店と閉店の両方を書き、開店が閉店より前。同じ曜日は 1 回だけ。深夜をまたぐ営業は `hoursNote` に書く。定休日に開店・閉店の値が残っていてもよい（頁は「定休日」とだけ出す）。
  臨時休業の日付は実在する日だけで、同じ日は 1 回だけ。
- **業種の拡張**: 店のコードが使う拡張（パン屋なら `allergens`・`shelfLife`）だけを CMS に出し、使っていない拡張の項目が content にあれば構築を止める（`CONTENT_EXTENSION_OFF`）。
  数値の `priceAmount` は、並べ替えや構造化データが要るときに後で足す（今は持たない）。
- 非公開（`visible: false`）と削除を分ける。売り切れは顧客の手動の表示だけ（在庫の連動はしない）。
- 構築のときに検査する（`loadContent`）: 知らない項目・ID の重複・無い分類・`/media/` の外の写真・大きすぎるファイルは構築を止める。
  止まった構築は公開されず、Cloudflare Pages では前の正常な公開が残る（Q2 で確かめる）。
- デモの未確認の事実は content に入れない。顧客が確かめた情報だけを成約後に入れる。

## 3. 頁への差し込み（§6.1 の 10・12）

- その店の頁のコード（実験では `bakery-site.ts`）が `viewOf(content)`（公開の分類と商品を並び順で、公開のお知らせを新しい順で）を読み、
  自分の枠に入れる。0 品なら「準備中」、お知らせ 0 件なら節を出さない、臨時休業は今日より後だけ、のような**情報の有無の扱いも店のコード**が決める。
- 写真の枠は単純な長方形で縦横比を固定し（`object-fit: cover`）、縦・横・正方形のどの写真でも構図が変わらない。写真の無い商品も枠を保つ。
  MVP_SPEC §7.1 の「イメージ」の表示と「提案用デモ」の表示は店のコードに入れる（実験では頁の上と下）。
  「イメージ」の表示は**生成した画像素材にだけ**付ける。納品の後に顧客が自分の写真（本物の店の写真）に差し替えた枠には付けない（どの写真が生成した素材かを content に持つかは未決）。
- 頁は静的な HTML/CSS だけ（script なし、外部の取得なし）。正式なフローでは、段 5 の実装（承認したデザインに忠実な頁）を、
  この差し込みの形で書く。段 6 の比較（§6.1 の 8）と §6.1 の 7 の素材の検査は、構築した `dist/` に対して行う。

## 4. `.pages.yml`（§6.1 の 11）

- `pagesConfig()` が情報の形から作る（手で書かない）。`media`（`media/` → `/media`、jpg・png・webp、名前は `safe`）と、
  `content` の collection 3 つ（メニュー・分類・お知らせ。`format: json`、`filename: "{id}.json"`、`view` で並び順）と file 1 つ（営業時間・臨時休業。削除できない）。
- 編集できるのは §3.6 の情報と住所・電話。店名は `readonly`。住所・電話は `pattern` つき。頁のコード・CSS・構築の設定・`.pages.yml` 自身は content に入れない（試験で確かめる）。
  架空のパン屋の生成結果を `experiments/pages-cms/bakery.pages.yml` に置き、生成器と同じであることを試験で確かめる（情報の形を変えたら作り直す）。
- **公式の文書との照合（オフライン）**: https://pagescms.org/docs/configuration/ と、その下の `media/`・`content/`・`content/fields/`・型ごとの `fields/<型>/`
  （`fields/` の一覧のページは無い）を 2026-11-26 に読み、文書にあるキーだけを許す
  `PAGES_CONFIG_SCHEMA` で検査する（`media` の `input`/`output`/`extensions`/`rename`、content の `name`/`label`/`type`/`path`/`format`/`filename`/`view`/`operations`/`fields`、
  型ごとの `options`、`pattern` は string・text だけ、`reference` は既存の collection だけ）。YAML は生成した後に読み戻して同じであることを確かめる。
- **確かめていないこと（実際の Pages CMS が要る）**: 実際の画面での表示と保存、`reference` の値の保存の形（`{fields.id}`）、`uuid` の自動の値が
  ファイル名 `{id}.json` に使われるか、日本語の名前の扱い、`list` の object の要約の表示、
  そして**空の任意の項目の書き方**（写真・数値・説明を空にしたとき、項目を省くのか、`""` か `null` を書くのか）。今の情報の形は厳しく、
  `null` や型の違う値は `CONTENT_INVALID` で構築を止めるので、Q3 で必ず試し、合わせて形を直す。実際のアカウントと GitHub App の導入が要るので、オーナーの承認の後に試す。

## 5. 静的出力と Cloudflare Pages（§6.1 の 12）

- 構築は `node build.mjs`（納品の repo では依存の少ない Node のスクリプトにする。実験は TypeScript の `build.ts`）、出力は `dist/`（`index.html`・`style.css`・`media/`）。
  Second Root 本体（Next.js）は static export しない。
- 秘密の情報は要らない（構築は repo の中のファイルだけを読む）。トークンを頁・repo・記録に置かない。Deploy Hook は使わない。
- 写真の最適化（縮小・WebP）は構築では行わない（今は元のファイルをそのまま写す）。上限は §5.1（PR (4)）。

### 5.1 写真（PR (4)、オーナー決定 2026-11-26: 大きさの上限と構築のときの最適化を検討し、操作性と表示の品質を試す）

**上限（構築で検査、依存なし）**: `experiments/pages-cms/photos.ts`。頁に出る商品の写真だけを、ファイルの先頭（PNG の IHDR、JPEG の SOF、WebP の VP8 / VP8L / VP8X）から
形式と縦横の画素を読んで調べる（`image-meta.ts`。画像を展開しない・変えない）。

| 検査 | 上限 | 止まる名前 |
|---|---|---|
| ファイルがある | — | `CONTENT_PHOTO_MISSING` |
| 形式（中身で判定し、拡張子と一致） | PNG・JPEG・WebP | `CONTENT_PHOTO_TYPE` |
| 大きさ | 2MB | `CONTENT_PHOTO_TOO_LARGE` |
| 長い辺・画素数 | 4096px・1600 万画素 | `CONTENT_PHOTO_DIMENSIONS` |
| 短い辺 | 320px 以上 | `CONTENT_PHOTO_TOO_SMALL` |
| 縦横の比 | 3:1 まで | `CONTENT_PHOTO_RATIO` |

- CMS では写真の欄の説明に同じ上限（1600 万画素を含む）を出す（`PHOTO_HINT`。Pages CMS には大きさの上限の設定が無いので、決めるのは構築。値は試験で一致を確かめる）。止まった構築は公開されず、前の公開が残る。
- **生成した素材と店の写真**: 商品ごとに `imageKind`（`generated` イメージ素材 / `shop` 店の写真。無ければ `generated`＝安全側）。`generated` の写真は
  `<figure>` の中に `<figcaption>イメージ</figcaption>` を付けて出す（`materials-impl-check.ts` の決まりと同じ。隠さない）。店の写真には付けない。
  頁の下の注記（「「イメージ」の写真は生成した画像素材で、店の写真ではありません。」）は、生成した素材を出すときだけ出す。パン屋とカフェの両方を直した。
- **写真の出自 A/B/C（DEV-364 PR 2a、`quality-proof-plan.md` §3.2）**: `imageKind` を 3 つにした。`generated`（A、AI の提案用素材。「イメージ」付き。既定）、
  `shop_provided`（B、店が提供した本物の写真。権利の記録が要る）、`customer_cms`（C、成約後に顧客が CMS で上げた・選んだ写真。明示して選ぶときだけ）。B と C は「イメージ」を付けない。
  以前の `shop`（納品後に顧客が CMS で選ぶ「店の写真」）は C として読む（後方互換）。Second Root が置く写真は A か B で、C にはしない。
  - A の記録: 引き渡しの記録 `generated-materials.json` の項目に、素材の id と素材の承認の SHA-256 を任意で書ける（書いてあれば構築の出自の報告に A の記録として出る。無ければ null と報告）。
  - B の記録: 全文（`sr_photo_provenance_v1`、提供した人の役割・出典・許可の範囲と確認日と確認した役割・事実の確認・SHA-256）は**リポジトリの外**の非公開の場所に、写真ごとに `<sha256>.json`。
    店のリポジトリには索引 `content/photo-provenance.json`（写真の SHA-256 と非公開の記録の SHA-256）だけを置く（`.pages.yml` には入れない）。顧客の構築は索引だけで B と分かり、
    Second Root の構築（非公開の場所を渡す）は記録の全文と索引の一致まで確かめる。索引に無い B、記録が無い・書き換えられた B は `CONTENT_PHOTO_RIGHTS_MISSING`。
  - C の記録: 構築が自動の検査（形式・大きさ・寸法・比）の結果から書く（オーナーの承認は求めない）。
  - `CONTENT_GENERATED_AS_SHOP` は B と C の両方に効く（バイトの完全な一致だけ。変換した写しは見つからない＝既知の限界）。`materials-impl-check` など他の検査は変えていない。
  - **区分は写真のバイトに属する**（PR #371 のレビュー M1、オーナーの「A/B/C を混ぜない」）: B の索引にある写真はどこでも B（A や C、以前の `shop` にすると `CONTENT_PHOTO_CLASS_MIXED`）。
    同じ写真を頁の中で 2 つの区分で出す、生成素材の記録と B の索引の両方に同じ SHA-256 がある、も `CONTENT_PHOTO_CLASS_MIXED`。
  - **Second Root の納品の構築**（明示の `delivery: true` を渡す構築）は C の写真を断る（`CONTENT_DELIVERY_CUSTOMER_PHOTO`。「C は置かない」を手順でなく構築で守る）。
    非公開の場所（`provenanceDir`）を渡すだけでは納品にならない：その場所を使う監査の構築は、顧客の正当な C の写真をそのまま通す（PR #371 の Low）。
    非公開の場所がリポジトリの中なら `CONTENT_PROVENANCE_IN_REPO`。記録が読めない（存在しない以外の失敗）は `CONTENT_INVALID`。
  - B の `provided_by`・`confirmed_by` は役割の一覧（店主・店長・スタッフ・撮影者・Second Root 担当）だけ。出典・範囲の文は NFKC で正規化してから、電話番号・LINE ID・@ や SNS 名のあとのハンドル・下線を含む英字の語・
    メール・リンク・敬称つきの名前（後ろの文字を問わない）を断る。**これは推測の検査で、名前や連絡先を確実に止めるものではない**：
    厳しめの側に倒れる（「模様」「仕様」「皆さん」も断る）一方、敬称の無い名前や印の無いハンドルは通ってしまう。守りの本体は役割の一覧。A の素材の承認の SHA-256 と C の commit は任意（`quality-proof-plan.md` §3.2 も合わせた）。
  - CMS の選択肢は変えていない（PR 5）。CMS の「店の写真」は C になる。B は納品のときに Second Root が content に書く値で、CMS の選択肢には無い（PR 5 で表示を決める）。変換の記録 `sr_photo_transform_v1` は後の PR。
- **顧客が「店の写真」に変えても外れない**（PR #365 のレビュー M1、決定: 顧客に任せず構築で守る）: 納品のときに、渡した生成素材を
  `content/generated-materials.json`（`generated_materials_v1`: ファイル名と SHA-256）に書く。この記録は `.pages.yml` に入れないので CMS からは直せない。
  構築は、`imageKind: "shop"` の商品の写真の SHA-256 がこの記録にあれば止まる（`CONTENT_GENERATED_AS_SHOP`）。店が自分の写真に差し替えれば SHA-256 が違うので
  「店の写真」にできる。記録が壊れていれば `CONTENT_INVALID`。記録が無い店（生成素材を渡していない店）では、この検査は何もしない。
  生成素材を渡した店は、店の profile に `generatedDelivered: true` を立て、記録が無ければ構築を止める（`CONTENT_GENERATED_RECORD_MISSING`）。
  「記録が無い」とみなすのはファイルが存在しないとき（ENOENT）だけで、ディレクトリ・権限の誤り・その他の読み込みの失敗は `CONTENT_INVALID`。
  **限界**: 照合は完全に同じバイトだけ（再圧縮・編集した生成素材は見つけない）。CMS での付け替えの誤りを防ぐもので、repo を直接書き換えることは防がない。
- **大文字の拡張子**（`IMG_0001.JPG` など）: そのまま受け付ける（形式は中身で判定）。Pages CMS の `rename: "safe"` が小文字にするかは文書に書いていない（「slugify」とだけある）ので、
  どちらでも構築が通るようにした（実際の Pages CMS で確かめるのは Q3）。
- 頁の枠は縦横比を固定して `object-fit: cover` で切り取るので、上限の中のどの比の写真でも構図は崩れない（Q1 の `photos-large-odd`: 3600×2400、3:1、1:3、320×320、2000×2000 を両方の店で PC・SP とも所見なし）。

**構築のときの最適化の評価（依存は足していない）**

参考の数値（2026-11-26、Chromium の画像の書き出し `canvas.toBlob` で、合成した写真風の画像を測った。実際の写真は細部が多く、縮小した後の大きさはこの 2〜4 倍になることが多い）:

| 画像 | JPEG q80 | WebP q80 |
|---|---|---|
| 元（4032×3024、スマートフォンの写真に近い JPEG q92） | 3.3MB | — |
| 2400×1800 | 317KB | 147KB |
| 1600×1200 | 110KB | 38KB |
| 1200×900 | 60KB | 25KB |
| 800×600 | 29KB | 14KB |

頁で写真が出る大きさは、パン屋のカードで約 280〜380px 幅（PC）、カフェの小さい写真で 80px 角。画面の密度 2 倍でも 800px あれば足りるので、1200〜1600px に縮めれば
1 枚あたり数十〜数百 KB になり、元のまま（数 MB）より頁がずっと軽くなる。

| 方法 | 得るもの | 引き換え |
|---|---|---|
| (a) 縮めない（今）＋上限と案内 | 依存なし・構築が速い・元の画質 | 店が 2MB 以下で上げる手間。上限の中でも頁は重め（50 品で数十 MB になりうる） |
| (b) `sharp`（libvips）を構築で使う | 速い・高品質の縮小と WebP・複数の大きさ（srcset） | 依存が増える（ネイティブのバイナリ。Cloudflare Pages の構築の環境での動作は要確認）、構築の時間と回数（月 500 回）への影響 |
| (c) `@squoosh/lib` など WASM | ネイティブのバイナリなし | 保守が止まっている。遅い。勧めない |
| (d) ブラウザ（Chromium）で縮める | この repo にはもう Playwright がある | 納品の店舗の repo の構築に Chromium は重すぎる。研究の測定にだけ使える |
| (e) GitHub Actions で縮めて commit し直す | 店の repo の中で完結、Pages CMS の上げ方は変わらない | Actions の分数・権限・二重の commit（構築が 2 回）。顧客名義の repo の設定が増える |
| (f) Pages CMS の上げるときに縮める | 店の手間が最小 | hosted の Pages CMS には変換の機能が無い（`media` の設定は置き場と名前だけ） |

**勧め**: 今は (a)。実際の店で上限に当たる回数と頁の重さを Q3 で測り、重すぎれば (b) を、依存を足す前に Lead とオーナーの了承を得てから試す。今の数値では、依存が**はっきり必要**とまでは言えない。
- 実際の Cloudflare Pages での構築・公開は、試験用アカウントも含めてオーナーの承認の後（Q2）。
- **納品の構築は非公開の場所を必ず要る**（#371 の再レビュー）: `delivery: true` で `provenanceDir` が無ければ、何も読む前に `CONTENT_DELIVERY_RIGHTS_DIR_MISSING` で止まる
  （納品では B の権利の記録の全文を確かめる。索引だけでは足りない）。

### 5.2 写真枠の指定（DEV-364 PR 2b、`quality-proof-plan.md` §3.1・§6 の 2b。架空・オフラインだけ）

- `experiments/pages-cms/photo-slots.ts` の `sr_photo_slots_v1`: 承認の記録（`approved_design`: `ApprovedDesignRef` の 4 つの欄と `approval_sha256`）に結びつく、第 1 承認の付属の記録。
  枠ごとに `id`・`role`（hero / product / background / decor）・`material_ids`（承認した構図の素材の id。`request-prompt.ts` の Material）、PC と SP それぞれに
  `box`（承認画像の中の 0〜1 の矩形）・`aspect`（16:9・3:2・4:3・1:1・3:4・2:3）・`shape`（rect / rounded）・`object_position`（「50% 35%」の形だけ）・`subject`（center / left-third / right-third / top / bottom）・
  `text_gap`（adjacent / separated）。**文字を写真に重ねる指定は書けない**（`text_gap` に重ねる値が無く、どの階層も余分な欄を断る）。重ねる表現は §4 の別の承認の項目。
- 承認した画像と全体の依頼文（whole_page の prompt）は変えない。別の記録として、承認に欄と SHA-256 で結びつくだけ。
- `experiments/` は `request-prompt.ts` を import できない（オーナー承認の隔離の試験）。id の形・素材の種類と比・依頼 ID・記録の名前はこの file に写し、単体試験で `request-prompt.ts` と一致することを確かめる。
- **納品のときの検査**（`checkPhotoSlots`、承認の文脈を渡す）: 渡した承認と違う → `CONTENT_SLOTS_NOT_APPROVED`。承認した素材に無い id → `CONTENT_SLOTS_MATERIAL_UNKNOWN`。
  役割と素材の種類が合わない（hero・product は photo、background は background、decor は decoration）→ `CONTENT_SLOTS_ROLE_MISMATCH`。
  `box` の承認画像の中での形が `aspect` と 8% を超えて違う → `CONTENT_SLOTS_BOX_MISMATCH`。素材の比で切り取ると主役が枠の外 → `CONTENT_SLOTS_SUBJECT_CROPPED`。形の誤り → `CONTENT_SLOTS_INVALID`。
- **構築**: `content/photo-slots.json`（`.pages.yml` に入れない。CMS からは直せない）を読み、生成素材の記録で素材の id が付いた写真に、その枠を当てる。
  写真の**実際の比**で PC・SP とも主役が切り取りの中に残るかを確かめる（残らなければ `CONTENT_SLOTS_SUBJECT_CROPPED`）。頁は `<img data-slot="…">` と、
  後ろに足す CSS（`object-position`、SP は店ごとの区切り幅の下）で枠を当てる。指定が無ければ頁は前と同じバイト。
- **Q1**（`q1-check.ts` の直接の経路。`q1-render.ts` は同じ関数を通す。import は変えていない）: 当てた枠ごとに PC・SP で、描いた枠の比（`Q1_SLOT_ASPECT`、3% まで）、
  `object-position` と `object-fit: cover`（`Q1_SLOT_POSITION`）、主役の点が見える範囲に残るか（`Q1_SUBJECT_CROPPED`）、枠が頁にあるか（`Q1_SLOT_MISSING`）を測る。
  わざと崩した枠の対照の頁（`SLOT_CONTROL`）で 4 つとも出ることを毎回確かめる。架空の `photo-slots` の試験データ（3:2・3:1・1:1・2.8:1 の写真、パン屋の 4:3 のカードとカフェの 1:1 の小さい写真）は PC・SP とも所見なし。
- **限界**: 主役の位置は指定に書いた位置で、画素から見つけたものではない（測れるのは幾何だけ）。枠は生成素材の記録の素材の id を通して写真に届くので、B・C の写真と差し替えた写真には
  頁の既定の枠が当たる。差し替えても承認した構図に収まるかは PR 5。枠の比は店の CSS が決め、指定の比と合うかを Q1 が測る（頁の CSS は変えない）。

## 6. Q1 CMS 更新による崩れ（§6.1 の 13）

- 試験の content（`fixtures.ts`、すべて架空）: 品数 0・3・10・50、長い商品名・長い英単語・長い説明・長い価格の表記、価格の表記の違い（円・税込・¥・時価・範囲・空）、
  写真の形（横 3:2・正方形・縦 2:3・写真なし）、非公開・売り切れ・並べ替え、営業時間の変更・定休日・臨時休業（過ぎた日は出さない）、お知らせ 0・1・12 件（非公開を含む）、業種の拡張（アレルゲン・日持ち）と総額表示の各分類の価格。
- 撮影と判定（`q1-check.ts`、**手で動かすスクリプト**。unit の試験にしない＝unit の時間を増やさない）:
  `npx tsx experiments/pages-cms/q1-check.ts --out <リポジトリの外の空の場所>`。Chromium で PC 1440・SP 390、JS なし、構築した `dist/` の外への要求はすべて止めて数える。
  判定: 横のはみ出し、欠けた画像、商品どうし・商品の中の文字どうしの重なり、12px 未満の文字、箱で切れた文字、外への要求。撮影は頁の高さで撮る（`fullPage` を使わない、DEV-135）、
  撮る前に描画のフレームを待つ（DEV-098、再試行なし）。始めにわざと壊した頁（対照）を PC と SP で開き、6 つの判定（はみ出し・欠けた画像・重なり・小さい字・切れた文字・外への要求）がすべて出ることを確かめ、出なければ止まる（`Q1_CONTROL_MISSED`）。
  **限界**: 「切れた文字」は横に切れたものだけを見る（縦に切れたものは見つけない）。重なりはメニューの商品だけを見る（他の節は見ない）。作業用のコピーは終わったら消し、`--out` には報告と撮影だけを残す。
- **既存の描画の道具での Q1**（オーナー決定 2026-11-26: 読むだけ・比べるだけの最小の import の固定の変更）: `experiments/pages-cms/q1-render.ts` だけが
  `phase2f/render-prototype` の `renderPrototype` だけを使う（`tests/unit/design-agent/phase2f/isolation.test.ts` の監査の試験で、この 1 つのファイル・1 つのモジュール・1 つの名前に固定。
  `experiments/` から comp-impl・shop-css などへ直接届くことも禁じる）。renderPrototype は comp-impl の安全な開き方（JS なし、頁のファイルだけを出し、ほかの要求は止めて数える）で
  PC 1440・SP 390 を撮り、SP 390 では DEV-134 の電話の検査（shop-CSS の文字の測り方: 切れ・覆い・箱の外・12px 未満・薄い・詰まり・重なり、押せる大きさ、最初の画面の店名）を行う。
  `npx tsx experiments/pages-cms/q1-render.ts --out <リポジトリの外の空の場所>` は、すべての試験の content と対照の頁で、この道と Playwright を直接使う道（`q1-check.ts`）の両方を走らせ、
  `q1-compare.json` に幅ごとの所見を並べる。対照は 1 つの頁ではなく、壊し方ごとの小さな頁の組（`CONTROLS`）で、それぞれ決めた判定が出なければ止まる（`Q1_RENDER_CONTROL_MISSED`）。
  **対照で確かめた判定**: 既存の道具の道は `R_OVERFLOW_X`、`R_BLOCKED`（欠けた画像だけの頁と、外の stylesheet だけの頁で別々に）、`SP_TEXT_TOO_SMALL`・`SP_TEXT_CLIPPED`・`SP_TEXT_OVERLAP`・
  `SP_TEXT_OUT_OF_BOX`・`SP_TEXT_COVERED`・`SP_TEXT_OFFSCREEN`・`SP_TEXT_FADED`・`SP_TEXT_SQUEEZED`・`SP_FACT_HIDDEN`・`SP_TAP_TARGET_TOO_SMALL`・`SP_TAP_TARGET_BELOW_44`・
  `SP_SHOP_NAME_NOT_IN_FIRST_SCREEN`。直接の道（PC と SP の両方）は `Q1_OVERFLOW_X`・`Q1_OVERLAP`・`Q1_SMALL_TEXT`・`Q1_TEXT_CLIPPED`、`Q1_BROKEN_IMAGE`（`Q1_EXTERNAL_REQUEST` なしで）、
  `Q1_EXTERNAL_REQUEST`（`Q1_BROKEN_IMAGE` なしで）。**対照で確かめていないもの**: 電話の検査そのものが失敗したときの `SP_CHECK_FAILED`・`SP_CHECK_SCOPE_CONFLICT`。
- **比べた結果（2026-11-26）**: 直接の道は 10 件 × PC/SP で所見なし。既存の道具の道は、SP で全件に `SP_TAP_TARGET_BELOW_44`（見出しの中の案内のリンクが 44px より小さい）を見つけた
  （直接の道は押せる大きさを測らない）。架空のパン屋の頁のコードで案内のリンクを 44px にして、両方の道とも所見なしになった。既存の道具のほうが電話の検査が広いので、正式な Q1 は既存の道具の道を主にし、
  直接の道は PC の重なりの検査（既存の道具は PC では文字を測らない）として残すのがよい。
- 2026-11-26 の実行: 9 件の試験の content × PC/SP で所見なし（情報の形の PR の後は業種の拡張を足した 10 件で所見なし。既存の道具の道は上のとおり）（対照は上に挙げた判定がすべて出た）。**これは架空の 1 店の頁での結果で、正式な店舗の頁の Q1 の合格ではない。**
  「店舗固有の構図が保たれる」の判定（段 6 の比較の観点）は、承認したデザインと実装がそろってから行う。
- unit の試験（`tests/unit/experiments/pages-cms.test.ts`、ブラウザなし・約 1 秒）: 情報の形の検査、構築（非公開・並び順・売り切れ・臨時休業・0 品・escape）、
  `.pages.yml` の文書との照合と読み戻し。

## 7. Q2〜Q4（§6.1 の 14）

| 区分 | 成約前にローカルでできること（stub/mock） | 実際のアカウントが要ること（オーナーの承認の後） |
|---|---|---|
| Q2 GitHub からの自動公開 | ローカルの git repo に content の変更をコミットし、そのつど `build` を走らせ、成功なら `dist/` を差し替え、失敗なら前の `dist/` を残す、を再現する。連続のコミット・壊れた content（構築が止まる）・写真の欠けを試す | Cloudflare Pages の Git 連携での構築と公開、失敗時に前の版が残ること、反映の時間、無料枠（月 500 回の構築）の消費 |
| Q3 顧客自身による更新 | Pages CMS が書くのと同じ形の JSON の変更（商品の追加・価格・写真の差し替え・非公開・並べ替え・営業時間・臨時休業・お知らせ）を手順書どおりに当て、Q1 の判定を通す。触る画面と手順の数を手順書で見積もる | 店主役が Pages CMS（hosted）だけで更新し、Second Root の操作なしで公開に反映されること、画面の数と所要時間の記録。**確かめること**: hosted の Pages CMS の画面から `.pages.yml` そのもの（と `content/generated-materials.json`）を書き換えられるか（できるなら、編集できる項目の制限と生成素材の記録は CMS の操作で外せてしまうので、守り方を見直す）。空の任意の項目の書き方、`rename: "safe"` が拡張子を小文字にするか |
| Q4 権限を外した独立運用 | 引き渡しの資料のひな形（移行、Pages CMS が止まったときの案内、費用、責任の範囲）と、外す権限の一覧（GitHub の協力者、Cloudflare のメンバー、Pages CMS の協力者）の点検表 | 実際に権限を外した後で Q2・Q3 をもう一度行う。顧客の GitHub App は顧客のものとして残す |

架空の店のためでも、実際の試験用アカウントの作成・GitHub App の導入・Cloudflare への deploy は別にオーナーの承認が要る（§3.7）。

## 7a. CMS の構築を既存の検査にかける橋渡し（PR (5)）

構築の出力（`dist/`: `index.html`・`style.css`・`media/*`）を、段 5・段 6 の既存の検査が読む形（`index.html`・`style.css`・`assets/*`）に写す
`experiments/pages-cms/stage-for-gates.ts`（`stageForGates`）を足した。リポジトリの外の空の非公開の場所（0700）に、`src="/media/<名前>"` を `src="assets/<名前>"` に
書き換えた頁と、`media/` の写真を**バイトを変えずに** `assets/` へ写す。`dist/` は読むだけ。検査のモジュール（`impl-compare-approved`・`materials-impl-check`）は
写した場所を普段どおりに読むだけで、experiments から検査のモジュールを import しない（import の固定は変えない。試験は tests/ から両方を呼ぶ）。

- **materials-impl-check**: カフェの構築（承認した素材 2 枚を生成素材として使う）を写すと、承認した素材だけが使われ、どちらも `<figure>` の `<figcaption>イメージ</figcaption>` つきで
  通った（`status: ok`）。別のバイトの写真に変えると `MATERIALS_IMPL_IMAGE_NOT_APPROVED`。カフェの頁は店舗の版のデモの HTML/CSS の検査（`checkArtifactHtml`）も通った。
- **impl-compare-approved**: リハーサルの合成の承認済みデザイン（#362、店 `cafe`、架空）と比べ、記録（助言だけ、`synthetic: true`、`passing: false`）ができた。
  合成のデザインなので数値に意味は無く、道が最後まで通ることを確かめただけ。
- **止まるもの**: JPEG・WebP の写真（`STAGE_ASSET_NOT_PNG`。impl-compare-approved は PNG の assets しか出さないので、今は比べられない＝既知の穴）、
  書き換えの後も `/media/` が残る（CSS の `url()` など。`STAGE_MEDIA_REFERENCE`）、頁のファイルが無い（`STAGE_DIST_INVALID`）、出力先がリポジトリの中・空でない。
- 試験: `tests/unit/experiments/pages-cms-gates.test.ts`（架空のデータ、段 6 は本物の Chromium）。

## 8. §6.1 の順との対応

| §6.1 | この計画 | 実験の状態 |
|---|---|---|
| 10 content への分離 | §2・§3 | 情報の形・読み込み・検査・架空の店の差し込みを実装（`experiments/pages-cms/`） |
| 11 `.pages.yml` | §4 | 生成と文書との照合を実装。実際の Pages CMS では未確認 |
| 12 静的出力と Cloudflare Pages | §5 | ローカルの構築だけ。`build.mjs`（依存の少ない形）と Cloudflare での構築は未着手 |
| 13 Q1 | §6 | 試験の content と PC/SP の判定のスクリプトを実装。正式な店舗の頁では未実施 |
| 14 Q2〜Q4 | §7 | 手順の案だけ。stub/mock の実装は次の段 |

**小さな PR の順（オーナー決定 2026-11-26 の後）**。どれも最新の develop から作り、試験をつける。

1. **情報の形と検査**（#356、マージ済み）: 店名の固定、住所・電話の検査、営業時間・臨時休業の検査、業種の任意の拡張、価格の自由な文字と総額表示の検査、`.pages.yml` の作り直し。
2. **Q1 を既存の描画の道具で**（#360）: 読むだけ・比べるだけの最小の import の固定の変更と、どの道具のどの名前かを固定する監査の試験。今の Playwright の直接の判定と結果を比べる。
2a. **店のサイトの形と 2 つ目の店**（この PR）: 店のサイトを「profile（固定の店名・使う拡張）＋描画の関数＋試験の content」の形（`experiments/pages-cms/shop-site.ts` の `ShopSite`）にし、
   構築（`build.ts`）と Q1 の 2 つの道（`q1-check.ts`・`q1-render.ts`）はこの形だけを使う。パン屋の出力は形を変える前とバイト単位で同じ（試験で SHA-256 を照合）。
   2 つ目の架空の店として、パン屋と違う構図のカフェ（「架空のカフェ 木洩れ日珈琲」。細い見出しの帯、写真の小さい価格の一覧、PC では横にお知らせと営業時間の列、`sizes` の拡張）を足し、
   その試験の content（0・3・10・50 品、長い文字、非公開・売り切れ・並べ替え、営業時間・臨時休業、お知らせ、サイズごとの価格）で両方の道とも所見なし。
   見つけたこと: 電話の検査は事実の一覧を 200 件までしか受け付けない（shop-CSS の測り方の上限）ので、事実は頁に出る商品だけを頁の順に、重複を除いて 200 件までにし、それでも切った数は `q1-compare.json` の `facts_truncated` に記録する（カフェの 50 品で `SP_CHECK_FAILED` が出た）。試験の content の名前は「<店>-<試験>」（例 `bakery-items-50`・`cafe-sizes-prices`）になった（報告・撮影のファイル名・`runQ1` の `only`）。
   総額表示の検査も直した: 括弧の中の 税込 と他の言葉（「（10%税込）」「（2名分・税込）」）、円のない数の一覧（「S400/M500/L600円（税込）」「1,000〜1,500円+税」）、「本体価格1,000円 税込1,100円」。
3. **写真**: 大きさの上限（構築で検査）と、構築のときの最適化の評価（縮小・WebP。依存を足す前に得失を報告し、`package.json` の変更は Lead の了承の後）。実際の操作性と表示の品質を試す。
4. **`lib/` への移動**: 安定した共通の部分（情報の形・読み込み・`.pages.yml` の生成・総額表示の検査）だけを移す。店の頁のコードは移さない。
5. **文書だけ（送信しない）**: Pages CMS hosted の規約・商用利用・店舗の数・サービスの変更の危険を公式の資料で確かめ、運営者への問い合わせの文案（日本語・英語）を作ってオーナーの承認を待つ。
   結果: [`pages-cms-hosted-terms.md`](pages-cms-hosted-terms.md)（2026-11-26、問い合わせは未送信）。

その後の候補: 依存の少ない `build.mjs` の形、Q2 のローカルの再現（git のコミットと構築の失敗の扱い）、Q3 の手順書と JSON の変更の再現、引き渡しの資料のひな形、日付で消える表示の別の検証。

## 9. 危険とオーナーへの問い

**危険**
- Pages CMS（hosted）の規約・継続・料金は保証されない。止まっても公開済みのサイトと GitHub の原本は残るが、編集には別の手段が要る。
- Cloudflare Pages の無料枠（月 500 回の構築）。保存のたびに構築されるので、こまめな編集が多い店では数を見る。
- 写真の大きさ: 携帯の写真（数 MB）をそのまま上げると repo と頁が重くなる。Pages CMS の `media` は変換をしない。
- 反映の遅れ: 臨時休業・売り切れは構築の後に出る（数分）。即時の表示は約束しない。
- 日付で選ぶ表示は構築のときに決まる: 過ぎた臨時休業（とお知らせの並び）は、次の構築まで頁に残る。オーナー決定（2026-11-26）: 毎日の定期の構築は今はしない。自動で消す表示が要るなら別に検証する。
- 顧客の操作: GitHub のアカウント・二要素・GitHub App の導入は、店主にとって最初の壁になりうる（Q3 で時間を測る）。

**オーナーへの問い**（2026-11-26 に 0・3〜9 は回答済み。§0 の決定を参照。1・2 は残る）
0. Issue #312 の 2026-11-23 の凍結を、ローカルの実験より先の実装（正式なモジュール・納品用の構築のスクリプトなど）についても解くか（2026-11-26 の指示は計画と実験の再開。§0）。
1. Pages CMS hosted の利用規約（商用・多数の店舗）を、導入の前に提供元へ確かめるか。確かめるならいつ、誰が。
2. 実際の試験（Q2〜Q4）のための試験用アカウント（GitHub・Cloudflare・Pages CMS）を作ってよいか、どの名義で。
3. 店名・住所・電話を顧客が CMS で直せるようにするか（今は読むだけ。§3.6 の更新できる情報に入っていない）。
4. 写真の大きさの扱い: 上げる前に縮めてもらう案内だけにするか、構築で縮める（依存が増え、構築が遅くなる）か、GitHub Actions で縮めるか。
5. 価格の表示: 文字のまま（今の案）でよいか、数値と税の区分を持たせるか。
6. 業種ごとの項目（カフェのサイズ・菓子の日持ちなど）をどこまで共通の形に入れるか（今は入れない）。
7. 正式な実装で既存の描画の道具（`phase2f/render-prototype`・`mobile-quality`）を Q1 に使うための import の固定の変更を認めるか、それとも実験のように Playwright を直接使うか。
8. 実験のコードを `experiments/` に置いたままにするか、正式な場所（`lib/` の下と試験）へ移すか。
9. 過ぎた臨時休業が次の構築まで残る件: 毎日の定期の構築（Cloudflare Pages の構築の回数を月 30 回ほど使う）にするか、残ることを受け入れて顧客に案内するか。
