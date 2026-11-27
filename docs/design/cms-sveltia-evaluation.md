# Sveltia CMS で管理画面だけを入れ替えられるか（Issue #380、第二の案の評価）

2026-11-27。状態: **調べと設計の案だけ**。Sveltia CMS を repo に入れていない・動かしていない・アカウントを作っていない。
出典は公式の資料（sveltiacms.app・github.com/sveltia）で、アクセス日はすべて 2026-11-27。**未検証**と書いたものは実際に動かして確かめる必要がある。
前提: hosted の Pages CMS の商用の条件が不明（[`pages-cms-hosted-terms.md`](pages-cms-hosted-terms.md)）。そのときの第二の案（[`cms-live-trial-owner-sheet.md`](cms-live-trial-owner-sheet.md) §3）を詳しく見る。

## 1. 結論

- **入れ替えられる見込みが高い**。content の JSON（`content/works/*.json`・`content/news/*.json`・`content/shop.json`）、写真の場所（`media/` → `/media/…`）、静的な構築（納品用 repo の `build.mjs`）はそのまま使え、
  `.pages.yml` の代わりに `admin/config.yml`（付録）を置く。項目の型（文字・長文・数・真偽・選択・日付・UUID・写真の入った object の list）はすべて対応する型がある。
- 変える必要があるもの: ① 構築の `PAGES_YML_CHANGED` の検査を `admin/config.yml` の検査に変える ② 空の任意の項目の書き方（既定では `""`・`null`・`[]` を書く）を `omit_empty_optional_fields: true` で今の情報の形に合わせるか、読み込みを合わせる ③ `admin/` を公開する頁に含め、Q1 の「外への要求なし」の判定から `/admin/` を外す。
- **写真は Sveltia の方が良い**: アップロードのときにブラウザの中で縮小・WebP への変換・Exif の削除・HEIC の変換ができる。Pages CMS は元のファイル（iPhone の写真なら位置情報を含みうる）をそのまま repo に入れる。
- **重さ**: 認証のための Cloudflare Worker（Sveltia CMS Additions か Authenticator）を置いて保守する手間が増える。Additions を使えば顧客は GitHub のアカウントなしで ID とパスワードで入れる。
- 推奨: hosted の Pages CMS の実環境の試験を先に行い（承認済みの範囲）、**商用の条件が解決しなければ Sveltia CMS + Additions を同じ架空の店で試す**。どちらも無料がずっと続くとは約束しない。

## 2. 情報の形の対応

| 今（`.pages.yml`、`experiments/pages-cms/auto.pages.yml`） | Sveltia CMS | 出典・注意 |
|---|---|---|
| `works`・`news`: `type: collection`、`path`、`format: json`、`filename: "{id}.json"` | entry collection: `folder`、`format: json`、`slug` に `{{uuid}}` か `{{fields.id}}` | 「Each entry is stored as a separate file in a specified folder」。slug に項目の値と `{{uuid}}` が使える（https://sveltiacms.app/en/docs/collections ・ https://sveltiacms.app/en/docs/collections/entries/slugs）。読み込みはファイル名と `id` の一致を求めていない（`content-model.ts` は `.json` を全部読み、`id` の重複だけを止める）。`{{fields.id}}` で uuid の欄の値が作成時に使えるかは**未検証** |
| `shop`: `type: file`、`content/shop.json`、`operations.delete: false` | file collection: `files` に `file: content/shop.json`（拡張子で JSON と判定） | https://sveltiacms.app/en/docs/collections/files 。file collection を消せるかの記載は無い（`readonly` で全体を固定はできる）。**未検証** |
| `uuid`（`readonly`・`hidden`） | `widget: uuid`（既定で読むだけ、36 文字の形） | https://sveltiacms.app/en/docs/fields/uuid 。隠す設定は無く、読むだけで見える（**未検証**） |
| `string`・`text`（`maxlength`） | `string`・`text`。長さの上限は `pattern` で書く | `pattern: ['正規表現', 'メッセージ']`（https://sveltiacms.app/en/docs/fields）。今の住所・電話・時刻の正規表現は JavaScript で使える書き方 |
| `readonly: true`（店名） | 共通の `readonly: true` | 同上 |
| `required` | 共通の `required`。**既定は `true`**（Pages CMS と逆）→ 任意の項目に `required: false` を書く | 同上 |
| `boolean`（`default`） | `widget: boolean` | 同上 |
| `number`（`min`・`max`） | `widget: number`（既定で数として保存、`value_type: int`） | https://sveltiacms.app/en/docs/fields/number |
| `select`（`values` の `name`/`label`） | `widget: select`、`options: [{label, value}]`、`default` | https://sveltiacms.app/en/docs/fields/select |
| `date`（`yyyy-MM-dd`） | `widget: datetime`、`type: date`、`format: YYYY-MM-DD`、`picker_utc: true` | https://sveltiacms.app/en/docs/fields/datetime 。UTC にしないと時差で日付がずれうる、と公式 |
| `object` の `list`（`min`・`max`・`summary`） | `widget: list` + `fields`（`min`・`max`・`summary`・`collapsed`） | https://sveltiacms.app/en/docs/fields/list |
| `image`（`extensions`） | `widget: image`（`accept`、`media_folder`・`public_folder`）。値は公開の道（例 `/media/x.jpg`） | https://sveltiacms.app/en/docs/fields/file 。空なら `''` |
| `media`（`media` → `/media`、`rename: safe`） | 全体の `media_folder: /media`、`public_folder: /media`、`slugify_filename: true` | https://sveltiacms.app/en/docs/media |
| 空の任意の項目（Pages CMS の書き方は Q3 で確かめる予定） | 既定は「empty string, an empty array or `null`」を書く。`output.omit_empty_optional_fields: true` で省く。list の中の全部空の項目は `{}` | https://sveltiacms.app/en/docs/data-output 。今の読み込みは `null` や型の違いで止まるので、どちらかに合わせ、試験で固定する |
| JSON の字下げ | `output.json.indent_style`・`indent_size`（既定 2 つの空白） | 同上 |

構築: 納品用 repo の `build.mjs` は content と写真だけを読むのでそのまま使える。ただし `.pages.yml` が生成したものと同じかを検査する（`PAGES_YML_CHANGED`）ので、Sveltia にするなら `admin/config.yml` を同じように生成して検査し、`admin/` を `dist/` に写す変更が要る（未実装）。

## 3. Pages CMS との比較

| 観点 | Pages CMS（hosted） | Sveltia CMS |
|---|---|---|
| 写真の縮小・圧縮 | 文書に記載なし（https://pagescms.org/docs/configuration/media/）。納品用 repo の構築が公開する頁の写真だけを長辺 2560px に収める | `media_libraries` の `transformations.raster_image`（`format: webp`・`quality`・`width`・`height`）でアップロードのときに「all within the browser」で縮小・WebP 化。大きくはしない。ブラウザが WebP を作れないと PNG になりうる（https://sveltiacms.app/en/docs/media）。設定の正確な入れ子は**未検証** |
| HEIC | 記載なし。今の設定は jpg・png・webp だけで選べない。構築は `CONTENT_PHOTO_HEIC` で止まる | `raster_image` か `heic` の変換を設定すれば、アップロードで他の写真と同じく変換（初回に約 300 KB の変換器を読み込む。Safari は自前で読める）。設定しないと画像の欄で HEIC を選べない（同上） |
| Exif・位置情報 | 文書に加工の記載が無いので、**上げた元のファイルがそのまま repo に入る**と見る（推論、実環境の試験で確かめる）（iPhone の JPEG は店や自宅の位置を含みうる）。構築は公開する頁の写真からメタデータを除くが、repo の元は残る（`pages-cms-phone-photos.md` §4） | 「Exif metadata is stripped from raster images」。位置情報（GPS）は Exif の一部だが、公式は GPS を名指ししていない → **未検証**（試験で位置情報つきの合成の写真を上げて確かめる）。動く GIF・WebP・PNG は変換せずそのまま上げる、とある |
| 顧客のログイン | 協力者としてメールで招く。GitHub のアカウント不要（https://pagescms.org/docs/configuration/collaborators/） | 標準は GitHub のアカウントで、repo の書き込み権限が要る（読むだけの人は入れない）。**Sveltia CMS Additions** を使えば ID とパスワードで入り、短い期限の GitHub の token を受け取る（repo とその人の役割に限る）。役割は admin・editor・viewer（https://sveltiacms.app/en/docs/backends/github ・ https://sveltiacms.app/en/docs/additions） |
| 認証の置き場所 | 運営者の hosted のアプリと DB | 自分の Cloudflare の Worker（Additions は Worker + Durable Object、「The Free plan is enough」。Authenticator は Worker だけ）。Additions は内容を通さず、CMS が GitHub と直接話す。パスワードは二重にハッシュ、GitHub App の秘密鍵は暗号化して保存（同上） |
| 顧客の名義での運用 | content は顧客の GitHub。hosted の App と DB は運営者のもの。引き渡しは App の導入と協力者の付け替え | repo・Cloudflare（頁と Worker）・GitHub App をすべて顧客の名義に置ける。Additions の GitHub App は設定のウィザードが作り、作るには repo に App を作って入れられる GitHub のアカウントが要る。Additions は「several sites on one deployment」も可能（代理店向け）だが、それは Second Root が認証を持ち続ける形になり、顧客の名義の方針と合わない |
| Second Root の保守 | 小（hosted を使うだけ。止まれば self-host か別の CMS） | 中: ① 管理画面は店のサイトの `/admin/` に置く（`index.html` と `config.yml`）② 認証の Worker を店ごとに置き、`ALLOWED_DOMAINS` などを設定 ③ 更新: 公式は版を固定しない（unpkg の版なしの URL）ことを勧め、固定は「increases maintenance burden and security risks」とする。固定しなければ CDN の変更がそのまま顧客の管理画面に入る（https://sveltiacms.app/en/docs/start）。どちらにするかは Second Root の方針で決める |
| ライセンス | MIT（self-host の場合） | 本体 MIT（https://github.com/sveltia/sveltia-cms）、Authenticator MIT（https://github.com/sveltia/sveltia-cms-auth）、Additions MIT |
| 商用・規約 | hosted の商用の条件は not stated | 自分の口座で動かすので運営者の規約の問題は無い（Cloudflare・GitHub の規約は別にある） |
| 成熟度 | 公式の版 2.x | 「now out of beta」を掲げる。Additions は v0.271.0 以上が要り、一部のログインの方法は予定（成熟度は**未検証**） |

管理画面の JavaScript について: 店の頁は JavaScript なし・外への要求なしだが、`/admin/` は CDN から Sveltia を読み込む別の頁になる。店の頁の検査（Q1 の外への要求の数）と分けて扱う。

## 4. microCMS（第三の案、短い更新）

[`cms-live-trial-owner-sheet.md`](cms-live-trial-owner-sheet.md) §3・§4 から変わりなし（2026-11-27）。規約はいちばんはっきりしている（法人のサイトも Hobby 可、制作会社の導入可、原則クライアントごとの契約、名義の変更は事前の承認）。
ただし content が GitHub の JSON ではなく microCMS に入るので、今の構築・情報の形・写真の検査の作り直しが要り、「管理画面だけの入れ替え」にはならない。Hobby の転送量 20GB/月を超えると API が止まる、ロールは Business 以上。

## 5. Brot Yanagi の CMS（記録の調べ）

調べた範囲（2026-11-27）: この repo の `docs/`・`.ai/progress.md`・`.ai/tasks.json`・`.ai/blockers.md`・`docs/operations/`、`git log --all --grep=brot`、GitHub の Issue・PR の検索（`gh api search/issues`、`brot`）、Draft PR #313 の枝、アクセスできる GitHub の repo の一覧（`brot` で 0 件）、`/home/sr-designgen/work` の下の作業場所。

**どの CMS か・どう作ったかは、アクセスできる記録に見つからなかった。** 分かっていること:
- トップページの実績の紹介に「CMS導入」（`components/home/RealProject.tsx`）、料金に「原則1種類の情報を更新できるCMS」（`components/home/Pricing.tsx`）とあるだけ。
- Issue #312（2026-11-21）は比較の対象に「Brot Yanagi由来CMS/Supabase」を挙げ、Phase A に「Brot Yanagi CMSの実装とライセンス・再利用可能範囲を確認。別repoが閲覧不可なら未検証と明記する」とある。
- Draft PR #313 の `docs/operations/customer-owned-cms-handoff-plan.md` の表は「Brot Yanagi由来のSupabase CMS … 比較対象。現物未検証」。つまり **Supabase を使った CMS らしい、という記載はあるが、現物は誰も確かめていない**。
- Vercel の team 名が `brot-yanagi`（`docs/STAGING.md`）だが、これは Second Root 本体の Vercel の team で、Brot Yanagi のサイトの CMS の記録ではない。
- `.ai/tasks.json` には「店舗候補はBrot Yanagiとしても素材/写真の使用権限を既成事実化しない」とだけある。

再利用の判断には、Brot Yanagi のサイトの repo（別にあるなら）か、オーナーの説明が要る。Supabase の CMS なら、Auth・DB・Storage の運用と障害の対応を Second Root が持つ形になりやすく、顧客の名義で手放す方針とは合いにくい（Draft PR #313 の評価と同じ）。

## 付録: `admin/config.yml` の案（つないでいない・未検証）

架空の自動車施工店（`auto.pages.yml` と同じ項目）。`base_url` は Additions か Authenticator の Worker の URL。media の入れ子は公式の頁の要約から書いたもので、正確な形は**未検証**。

```yaml
# DRAFT — not wired in, not tested (Issue #380, 2026-11-27)
backend:
  name: github
  repo: <owner>/<trial-repo>        # e.g. the trial repo in cms-live-trial-confirmation.md
  branch: main
  base_url: https://<auth-worker>.workers.dev   # Sveltia CMS Additions or Authenticator
media_folder: /media
public_folder: /media
media_libraries:
  all:                               # nesting to verify against https://sveltiacms.app/en/docs/media
    max_file_size: 15000000          # intake ceiling, decided separately
    transformations:
      raster_image:
        format: webp
        quality: 85
        width: 2560
        height: 2560
output:
  omit_empty_optional_fields: true   # match the strict content model (no "" / null for absent optional fields)
  json:
    indent_style: space
    indent_size: 2
collections:
  - name: works
    label: 施工実績
    folder: content/works
    format: json
    slug: "{{uuid}}"                 # or "{{fields.id}}" if the uuid field is available at creation (to verify)
    identifier_field: vehicle
    sortable_fields: [displayOrder, vehicle]
    fields:
      - { name: id, label: ID（自動）, widget: uuid }
      - name: vehicle
        label: 車種
        widget: string
        hint: "例: 架空車 ワゴン 2019年式"
        pattern: ['^[\s\S]{1,60}$', '60 字まで']
      - name: service
        label: 施工の種類
        widget: string
        hint: "例: ガラスコーティング、車内清掃"
        pattern: ['^[\s\S]{1,40}$', '40 字まで']
      - name: description
        label: ひとこと説明
        widget: text
        required: false
        pattern: ['^[\s\S]{0,300}$', '300 字まで']
      - name: photos
        label: 写真（1枚以上・4枚まで。試行中の上限です）
        widget: list
        min: 1
        max: 4
        summary: "{{role}} {{imageAlt}}"
        fields:
          - { name: image, label: 写真, widget: image, accept: "image/jpeg,image/png,image/webp,image/heic" }
          - { name: imageAlt, label: 写真の説明（読み上げ用）, widget: string, required: false, pattern: ['^[\s\S]{0,120}$', '120 字まで'] }
          - name: role
            label: 施工前・施工後
            widget: select
            default: other
            options:
              - { label: 指定なし, value: other }
              - { label: 施工前, value: before }
              - { label: 施工後, value: after }
      - { name: visible, label: 公開する, widget: boolean, default: true }
      - { name: displayOrder, label: 並び順（小さいほど上）, widget: number, value_type: int, min: 0, max: 9999, default: 0 }
  - name: news
    label: お知らせ
    folder: content/news
    format: json
    slug: "{{uuid}}"
    identifier_field: title
    sortable_fields: [publishedAt]
    fields:
      - { name: id, label: ID（自動）, widget: uuid }
      - { name: title, label: 見出し, widget: string, pattern: ['^[\s\S]{1,80}$', '80 字まで'] }
      - { name: body, label: 本文, widget: text, required: false, pattern: ['^[\s\S]{0,1000}$', '1000 字まで'] }
      - { name: publishedAt, label: 日付, widget: datetime, type: date, format: YYYY-MM-DD, picker_utc: true }
      - { name: visible, label: 公開する, widget: boolean, default: true }
  - name: shop
    label: 営業時間・臨時休業
    files:
      - name: shop
        label: 営業時間・臨時休業
        file: content/shop.json
        fields:
          - { name: name, label: 店名（変更できません）, widget: string, readonly: true }
          - name: address
            label: 住所
            widget: string
            required: false
            pattern: ['^(?![\s\S]*([Hh][Tt][Tt][Pp][Ss]?:|[Ww][Ww][Ww]\.|:\/\/))[^<>]{0,120}$', '住所は 120 字まで。記号 < > とリンク（http・www）は書けません']
          - name: phone
            label: 電話
            widget: string
            required: false
            pattern: ['^([+＋]?[0-9０-９()（）\-－ 　]{10,24})?$', '例: 03-1234-5678（空なら表示しません）']
          - name: hours
            label: 営業時間（曜日ごと）
            widget: list
            required: false
            max: 7
            collapsed: true
            summary: "{{day}} {{open}}–{{close}}"
            fields:
              - name: day
                label: 曜日
                widget: select
                options:
                  - { label: 月, value: mon }
                  - { label: 火, value: tue }
                  - { label: 水, value: wed }
                  - { label: 木, value: thu }
                  - { label: 金, value: fri }
                  - { label: 土, value: sat }
                  - { label: 日, value: sun }
              - { name: closed, label: 定休日, widget: boolean, default: false }
              - { name: open, label: 開店, widget: string, required: false, pattern: ['^(([01][0-9]|2[0-3]):[0-5][0-9])?$', '08:30 のように 24 時間で'] }
              - { name: close, label: 閉店, widget: string, required: false, pattern: ['^(([01][0-9]|2[0-3]):[0-5][0-9])?$', '08:30 のように 24 時間で'] }
          - { name: hoursNote, label: 営業時間の補足, widget: string, required: false, pattern: ['^[\s\S]{0,120}$', '120 字まで'] }
          - name: specialClosures
            label: 臨時休業
            widget: list
            required: false
            max: 60
            collapsed: true
            summary: "{{date}} {{note}}"
            fields:
              - { name: date, label: 日付, widget: datetime, type: date, format: YYYY-MM-DD, picker_utc: true }
              - { name: note, label: 理由など, widget: string, required: false, pattern: ['^[\s\S]{0,80}$', '80 字まで'] }
```

注意: HEIC を `accept` に入れるのは、Sveltia の変換が JPEG/WebP にしてから保存する前提（変換を設定しないと HEIC は選べない、と公式）。保存される拡張子が `.webp` になるかと、今の写真の検査（JPEG・PNG・WebP、2 MiB など）を通るかは**未検証**。
`identifier_field`・`sortable_fields` は Decap 互換の名前で、Sveltia の Entry Views・Listings の頁では確かめていない（**未検証**）。
