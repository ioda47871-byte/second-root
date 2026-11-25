# Pages CMS の実装計画と最初の実験（DEV-303 §6.1 の 10〜14）

2026-11-26。状態: **計画と、架空の店でのローカルの実験だけ**。外部のアカウント（GitHub・Cloudflare・Pages CMS）は作らず、
GitHub App も導入せず、Cloudflare へ deploy せず、実店舗のデータも使わない。何も公開しない。

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
| menu_item | `content/menu/<id>.json` | `id`（UUID、自動）、`name`、`category`（分類の ID）、`priceDisplay`（頁にそのまま出す文字）、`description`、`image`（`/media/…`）、`imageAlt`、`soldOut`、`visible`、`displayOrder` | 編集できる |
| category | `content/categories/<id>.json` | `id`、`name`、`displayOrder`、`visible` | 編集できる |
| announcement | `content/news/<id>.json` | `id`、`title`、`body`、`publishedAt`、`visible` | 編集できる |
| shop_info | `content/shop.json` | `name`・`address`・`phone`（読むだけ）、`hours`（曜日・定休日・開店・閉店）、`hoursNote`、`specialClosures`（日付・理由） | 営業時間と臨時休業だけ編集できる |

- 価格は**計算しない**。`priceDisplay` を顧客が書いたとおりに出す（「320円（税込）」「時価」「380〜520円」）。税込・税別の扱いは顧客に確かめる（推測で入れない）。
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
- 頁は静的な HTML/CSS だけ（script なし、外部の取得なし）。正式なフローでは、段 5 の実装（承認したデザインに忠実な頁）を、
  この差し込みの形で書く。段 6 の比較（§6.1 の 8）と §6.1 の 7 の素材の検査は、構築した `dist/` に対して行う。

## 4. `.pages.yml`（§6.1 の 11）

- `pagesConfig()` が情報の形から作る（手で書かない）。`media`（`media/` → `/media`、jpg・png・webp、名前は `safe`）と、
  `content` の collection 3 つ（メニュー・分類・お知らせ。`format: json`、`filename: "{id}.json"`、`view` で並び順）と file 1 つ（営業時間・臨時休業。削除できない）。
- 編集できるのは §3.6 の情報だけ。店名・住所・電話は `readonly`。頁のコード・CSS・構築の設定・`.pages.yml` 自身は content に入れない（試験で確かめる）。
- **公式の文書との照合（オフライン）**: https://pagescms.org/docs/configuration/ を 2026-11-26 に読み、文書にあるキーだけを許す
  `PAGES_CONFIG_SCHEMA` で検査する（`media` の `input`/`output`/`extensions`/`rename`、content の `name`/`label`/`type`/`path`/`format`/`filename`/`view`/`operations`/`fields`、
  型ごとの `options`、`pattern` は string・text だけ、`reference` は既存の collection だけ）。YAML は生成した後に読み戻して同じであることを確かめる。
- **確かめていないこと（実際の Pages CMS が要る）**: 実際の画面での表示と保存、`reference` の値の保存の形（`{fields.id}`）、`uuid` の自動の値が
  ファイル名 `{id}.json` に使われるか、日本語の名前の扱い、`list` の object の要約の表示。実際のアカウントと GitHub App の導入が要るので、オーナーの承認の後に試す。

## 5. 静的出力と Cloudflare Pages（§6.1 の 12）

- 構築は `node build.mjs`（納品の repo では依存の少ない Node のスクリプトにする。実験は TypeScript の `build.ts`）、出力は `dist/`（`index.html`・`style.css`・`media/`）。
  Second Root 本体（Next.js）は static export しない。
- 秘密の情報は要らない（構築は repo の中のファイルだけを読む）。トークンを頁・repo・記録に置かない。Deploy Hook は使わない。
- 写真の最適化（縮小・WebP）は構築では行わない（今は元のファイルをそのまま写す）。上げる写真の大きさの上限と案内は未決（§9）。
- 実際の Cloudflare Pages での構築・公開は、試験用アカウントも含めてオーナーの承認の後（Q2）。

## 6. Q1 CMS 更新による崩れ（§6.1 の 13）

- 試験の content（`fixtures.ts`、すべて架空）: 品数 0・3・10・50、長い商品名・長い英単語・長い説明・長い価格の表記、価格の表記の違い（円・税込・¥・時価・範囲・空）、
  写真の形（横 3:2・正方形・縦 2:3・写真なし）、非公開・売り切れ・並べ替え、営業時間の変更・定休日・臨時休業（過ぎた日は出さない）、お知らせ 0・1・12 件（非公開を含む）。
- 撮影と判定（`q1-check.ts`、**手で動かすスクリプト**。unit の試験にしない＝unit の時間を増やさない）:
  `npx tsx experiments/pages-cms/q1-check.ts --out <リポジトリの外の空の場所>`。Chromium で PC 1440・SP 390、JS なし、構築した `dist/` の外への要求はすべて止めて数える。
  判定: 横のはみ出し、欠けた画像、商品どうし・商品の中の文字どうしの重なり、12px 未満の文字、箱で切れた文字、外への要求。撮影は頁の高さで撮る（`fullPage` を使わない、DEV-135）、
  撮る前に描画のフレームを待つ（DEV-098、再試行なし）。始めにわざと壊した頁（対照）で全部の判定が出ることを確かめ、出なければ止まる（`Q1_CONTROL_MISSED`）。
- 既存の描画の道具（`phase2f/render-prototype`・`comp-impl/render`・`mobile-quality`）は、オーナーが承認した import の固定で使える場所が決まっているので、
  この実験では Playwright と、固定の無い `frame-ready` を直接使う。正式な実装で既存の道具を使うには、import の固定の変更（オーナーの承認）が要る（§9）。
- 2026-11-26 の実行: 9 件の試験の content × PC/SP で所見なし（対照は 6 つの判定がすべて出た）。**これは架空の 1 店の頁での結果で、正式な店舗の頁の Q1 の合格ではない。**
  「店舗固有の構図が保たれる」の判定（段 6 の比較の観点）は、承認したデザインと実装がそろってから行う。
- unit の試験（`tests/unit/experiments/pages-cms.test.ts`、ブラウザなし・約 1 秒）: 情報の形の検査、構築（非公開・並び順・売り切れ・臨時休業・0 品・escape）、
  `.pages.yml` の文書との照合と読み戻し。

## 7. Q2〜Q4（§6.1 の 14）

| 区分 | 成約前にローカルでできること（stub/mock） | 実際のアカウントが要ること（オーナーの承認の後） |
|---|---|---|
| Q2 GitHub からの自動公開 | ローカルの git repo に content の変更をコミットし、そのつど `build` を走らせ、成功なら `dist/` を差し替え、失敗なら前の `dist/` を残す、を再現する。連続のコミット・壊れた content（構築が止まる）・写真の欠けを試す | Cloudflare Pages の Git 連携での構築と公開、失敗時に前の版が残ること、反映の時間、無料枠（月 500 回の構築）の消費 |
| Q3 顧客自身による更新 | Pages CMS が書くのと同じ形の JSON の変更（商品の追加・価格・写真の差し替え・非公開・並べ替え・営業時間・臨時休業・お知らせ）を手順書どおりに当て、Q1 の判定を通す。触る画面と手順の数を手順書で見積もる | 店主役が Pages CMS（hosted）だけで更新し、Second Root の操作なしで公開に反映されること、画面の数と所要時間の記録 |
| Q4 権限を外した独立運用 | 引き渡しの資料のひな形（移行、Pages CMS が止まったときの案内、費用、責任の範囲）と、外す権限の一覧（GitHub の協力者、Cloudflare のメンバー、Pages CMS の協力者）の点検表 | 実際に権限を外した後で Q2・Q3 をもう一度行う。顧客の GitHub App は顧客のものとして残す |

架空の店のためでも、実際の試験用アカウントの作成・GitHub App の導入・Cloudflare への deploy は別にオーナーの承認が要る（§3.7）。

## 8. §6.1 の順との対応

| §6.1 | この計画 | 実験の状態 |
|---|---|---|
| 10 content への分離 | §2・§3 | 情報の形・読み込み・検査・架空の店の差し込みを実装（`experiments/pages-cms/`） |
| 11 `.pages.yml` | §4 | 生成と文書との照合を実装。実際の Pages CMS では未確認 |
| 12 静的出力と Cloudflare Pages | §5 | ローカルの構築だけ。`build.mjs`（依存の少ない形）と Cloudflare での構築は未着手 |
| 13 Q1 | §6 | 試験の content と PC/SP の判定のスクリプトを実装。正式な店舗の頁では未実施 |
| 14 Q2〜Q4 | §7 | 手順の案だけ。stub/mock の実装は次の段 |

次の段の候補（小さな PR に分ける）: (1) 実験を正式なモジュール（`lib/` の下）へ移すかの判断と、import の固定の扱い、(2) 依存の少ない `build.mjs` の形、
(3) Q2 のローカルの再現（git のコミットと構築の失敗の扱い）、(4) Q3 の手順書と JSON の変更の再現、(5) 引き渡しの資料のひな形。

## 9. 危険とオーナーへの問い

**危険**
- Pages CMS（hosted）の規約・継続・料金は保証されない。止まっても公開済みのサイトと GitHub の原本は残るが、編集には別の手段が要る。
- Cloudflare Pages の無料枠（月 500 回の構築）。保存のたびに構築されるので、こまめな編集が多い店では数を見る。
- 写真の大きさ: 携帯の写真（数 MB）をそのまま上げると repo と頁が重くなる。Pages CMS の `media` は変換をしない。
- 反映の遅れ: 臨時休業・売り切れは構築の後に出る（数分）。即時の表示は約束しない。
- 顧客の操作: GitHub のアカウント・二要素・GitHub App の導入は、店主にとって最初の壁になりうる（Q3 で時間を測る）。

**オーナーへの問い**
1. Pages CMS hosted の利用規約（商用・多数の店舗）を、導入の前に提供元へ確かめるか。確かめるならいつ、誰が。
2. 実際の試験（Q2〜Q4）のための試験用アカウント（GitHub・Cloudflare・Pages CMS）を作ってよいか、どの名義で。
3. 店名・住所・電話を顧客が CMS で直せるようにするか（今は読むだけ。§3.6 の更新できる情報に入っていない）。
4. 写真の大きさの扱い: 上げる前に縮めてもらう案内だけにするか、構築で縮める（依存が増え、構築が遅くなる）か、GitHub Actions で縮めるか。
5. 価格の表示: 文字のまま（今の案）でよいか、数値と税の区分を持たせるか。
6. 業種ごとの項目（カフェのサイズ・菓子の日持ちなど）をどこまで共通の形に入れるか（今は入れない）。
7. 正式な実装で既存の描画の道具（`phase2f/render-prototype`・`mobile-quality`）を Q1 に使うための import の固定の変更を認めるか、それとも実験のように Playwright を直接使うか。
8. 実験のコードを `experiments/` に置いたままにするか、正式な場所（`lib/` の下と試験）へ移すか。
