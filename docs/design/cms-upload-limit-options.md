# CMS の写真アップロードの上限（413）と選択肢（Issue #380）

2026-11-28。状態: **調べだけ**。何もインストール・契約・送信・公開の変更をしていない。
出典はすべて公式の頁か一次の資料（GitHub の Issue・PR・ソース）で、**アクセス日はすべて 2026-11-28**。引用は原文のまま。
資料に書かれていないものは **未確認**、資料にはあるが実機で確かめていないものは **未検証** と書く。
顧客への約束は書かない。「技術的にできるか」と「商用で提供できるか」は分けて書く。

## 0. 起きたこと

実環境の試験（`cms-live-trial-results.md`、枝 `feature/dev380-live-trial-record` にあり develop には未マージ。架空の店）で、実機の iPhone から hosted の Pages CMS（app.pagescms.org）に約 5 MB の JPEG を上げると
「Failed to upload file: 413」で失敗した。

オーナーの理想: **顧客は iPhone の写真をそのまま選ぶだけ。変換・圧縮は自動**。顧客に手で圧縮してもらうのは恒久の解決にしない。

## 1. 結論（先に）

- **原因はほぼ確定**: hosted の Pages CMS は写真を base64 にして JSON に入れ、自分の API（Vercel の Function）に送ってから GitHub に保存する。
  Vercel の Function は要求の本体を **4.5 MB** までしか受け付けず、超えると **413 `FUNCTION_PAYLOAD_TOO_LARGE`**。
  base64 で約 4/3 倍になるので、**元のファイルで約 3.3 MB（4.5 × 3/4 ≈ 3.37 MB、JSON の分を引くとわずかに下）が実質の上限**。iPhone の写真（2〜5 MB）の多くが超える。
- hosted の Pages CMS には **縮小・圧縮の機能が無く**、作者は Issue #284 を「Vercel の既知の制限」として閉じた。直す PR（#425 縮小、#408 分割）は **未マージ・作者の反応なし**。HEIC の話は Issue に 0 件。
- 理想（そのまま選ぶ → 自動で変換・圧縮）を**設定だけで技術的に満たしうる**のは、調べた中で **Sveltia CMS**（ブラウザの中で縮小・WebP 化・Exif 削除・HEIC 変換をしてから、ブラウザから GitHub に直接保存する。間に Vercel のような Function が無い）。
  Decap CMS も 3.16.0 からブラウザの中の縮小があるが、HEIC は対象外。microCMS は 40 MB まで受け付けるが、今の「GitHub の JSON + 静的構築」を作り直す必要がある。
- **推奨（技術）**: 次の試験の候補を **Sveltia CMS + Sveltia CMS Additions（ID・パスワードでログイン、Cloudflare Workers の無料枠）** とし、同じ架空の店・試験専用の環境で、iPhone の実機で HEIC と 5 MB 超の JPEG を確かめる（実施はオーナーの承認が要る）。
  hosted の Pages CMS は「約 3.3 MB まで」という既知の制限つきの比較対象として残す。
- **商用**: どの案も無料が続くことは約束できない。Sveltia は MIT で自分（顧客）の口座で動かすので運営者の規約の問題は無いが、Cloudflare・GitHub の無料枠の条件に依存する。hosted の Pages CMS の商用の条件は未解決のまま（[`pages-cms-hosted-terms.md`](pages-cms-hosted-terms.md)）。

## 2. Pages CMS（hosted と最新の版）

### 2.1 Issue #284 の内容

https://github.com/hunvreus/pagescms/issues/284 （https://github.com/pages-cms/pages-cms/issues/284 も同じ頁を返す。release 2.0.2 の注記は「migrated to pagescms/pagescms」）

- 題: 「Failed to upload file: 413」。報告（2025-07-11）: 「Upload fails when attempting to use the file field or media uploader for adding small (<4mb) MP4 files.」
- 作者 hunvreus（2025-07-18）: 「I'll do some testing, the only thing I can think of is a limit on the Vercel side as the upload transits through it.」
- 別の利用者（2025-11-16）が Vercel の「The maximum request (body) size for uploads through Vercel serverless functions or API routes is 4.5 MB」を引用。
- 作者（2026-03-16、そのまま **Closed as completed**）:
  > 「This is a known limit of Vercel.」
  > 「Options are:」
  > 「Hosting somewhere you don't have that restriction (e.g. https://devpu.sh, https://render.com, etc).」
  > 「Wait for the 3rd party storage extension to be shipped and host your media on Cloudinary/S3/R2.」
- 「3rd party storage extension」の時期・Issue は書かれていない（**未確認**）。ラベル・紐づく PR なし。
- 報告者の回避策: 「committing the files in the media directory and having them show up in Pages CMS that way」（Git で直接 commit する。顧客向けではない）。

### 2.2 関連する Issue・PR（2026-11-28 時点）

| # | 種類 | 題 | 状態 |
|---|---|---|---|
| #425 | PR | 「Prevent 413 errors by optimizing large image uploads」 | Open（2026-08-10）、レビューなし、作者のコメントなし |
| #408 | PR | 「Chunked media uploads to bypass Vercel's 4.5 MB request limit」 | Open（2026-06-24）、レビューなし |
| #393 | Issue | 「Can't upload large files (>= 4.5Mb)」 | Open、最新のコメント 2026-11-14「Same here, i hope this get fixed soon :(」 |
| #346 | Issue | 「Allow for "max size" parameter for images (or files)」 | Open |
| #138 | Issue | 「Convert images to webp when uploading」 | Closed（2025-02-10） |
| #46 | Issue | 「Cloudinary (CDN) support for images」 | Open（enhancement） |

- PR #425: 「The hosted Pages CMS app runs on Vercel, where Function request bodies are limited to 4.5 MB.」「files at or below 3 MiB remain byte-for-byte unchanged」「larger supported images are resized to at most 2560 px on the longest edge and encoded to a target below 2.75 MiB」。対象は JPG・PNG・WebP だけで **HEIC は無い**。
- PR #408: 4 MB 以下に分けて送り、サーバーの Postgres の表に溜めて最後に組み立てる（上限 15 MB）。
- 検索「heic」は 0 件。
- 最新の版: 2.1.8（「released this 08 Jun」、年は表示なし。2026 と推定）。releases の頁に縮小・分割の記載なし。

### 2.3 アップロードの仕組み（main のソース）

- 端末側 `components/media/media-upload.tsx`: `reader.readAsDataURL(file)` で base64 にし、
  `fetch(\`/api/${owner}/${repo}/${branch}/files/${path}\`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "media", name, content }) })`。
  **縮小・圧縮・大きさの検査は無い**（拡張子の絞り込みだけ）。
- サーバー側 `app/api/[owner]/[repo]/[branch]/files/[path]/route.ts`: `request.json()` → `octokit.rest.repos.createOrUpdateFileContents({ ..., content: contentBase64 })`（GitHub の Contents API）。大きさの設定なし。
- したがって **置き場所（ホスティング）の要求本体の上限が、そのまま写真の上限になる**。元のファイル（Exif・GPS を含む）がそのまま repo に入る。

### 2.4 hosted は Vercel か

- 公式の明言は **未確認**（README は「You can use the hosted version directly at app.pagescms.org」だけ。repo に `vercel.json` は無い）。
- 間接の根拠: 作者の「This is a known limit of Vercel.」、release 2.0.1 の「Removed the old Vercel cron cleanup endpoint」、PR #425 の記述。413 の症状も Vercel の文書と一致する。

## 3. 上限の数字

| 置き場所 | 要求本体の上限 | 出典（引用） |
|---|---|---|
| Vercel Functions | **4.5 MB**（全プラン既定）。20 MiB の Public Beta は Performance（4 GB）メモリが要り、それは Pro・Enterprise だけ（Hobby は最大 2 GB なので使えない、と読める。Hobby が 4.5 MB 固定という一文は **未確認**） | https://vercel.com/docs/functions/limitations 「Vercel Functions accept request bodies up to 4.5 MB by default」「Requests exceeding the applicable limit return 413: `FUNCTION_PAYLOAD_TOO_LARGE`.」 |
| Netlify Functions | 6 MB（バッファ）。base64 で実質 4.5 MB | https://docs.netlify.com/build/functions/configuration.md 「Buffered request/response payload \| 6 MB」「effectively reducing the binary request payload size limit to 4.5 MB.」 |
| Cloudflare Workers | ドメインの Cloudflare プラン次第。Free・Pro 100 MB、Business 200 MB。CPU は Free で 10 ms/要求 | https://developers.cloudflare.com/workers/platform/limits/ |
| Next.js Server Actions（参考） | 既定 1 MB（Pages CMS のアップロードは Route Handler なので直接は関係しない。Route Handler の既定は **未確認**） | https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions |
| 自前の Node（VPS・Render など） | プラットフォームの固定の上限は無い（前に置く Nginx などの設定次第。Nginx の既定 1 MB を上げる必要がありうる、**未検証**） | Pages CMS の self-host の文書（https://pagescms.org/docs/guides/installing/self-host/）は `npm run build`・`npm run start` と「Nginx or Caddy as reverse proxy」 |

**計算**: Vercel の 4.5 MB の中で base64（×4/3）+ JSON → 元のファイルで **約 3.3 MB まで**。5 MB の JPEG は base64 で約 6.7 MB になり、元の大きさでもすでに 4.5 MB を超える。

**GitHub 側**:
- Contents API の取得: 「1 MB or smaller: All features…」「Between 1-100 MB: Only the raw or object custom media types are supported.」「Greater than 100 MB: This endpoint is not supported.」（https://docs.github.com/en/rest/repos/contents）。**作成・更新（PUT）の上限は記載なし（未確認）**。
- 一般: 「GitHub blocks files larger than 100 MiB.」「If you add a file to a repository via a browser, the file can be no larger than 25 MiB.」（https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github）。
- Cloudflare Pages の公開ファイル 1 つは 25 MiB まで（https://developers.cloudflare.com/pages/platform/limits/）。今の構築は公開用の写真を縮めるのでここには当たらない。

**Pages CMS の self-host の対応先**: 文書は「Deploy on Vercel」と「Self-host」（Node + PostgreSQL）だけ。Docker の公式イメージ・Cloudflare・Netlify の手順は無い（Cloudflare は **未確認**、README に netlify.app の注意書きがあるので Netlify で動かす人はいるらしい）。
作者は Render・devpu.sh を例に挙げた。どれも Second Root か顧客がサーバーと DB を持つ形になる。

## 4. ブラウザの中で自動で変換・圧縮する案

### 4.1 Sveltia CMS（組み込み）

出典 https://sveltiacms.app/docs/media （「Image Optimization」「HEIC Photos」「File Size Limits」）。

```yaml
media_libraries:
  all:
    transformations:
      raster_image: # original format
        format: webp # new format, only `webp` is supported
        quality: 85 # integer between 0 and 100, default: 85
        width: 2048 # default: original size
        height: 2048 # default: original size
      svg:
        optimize: true # default: false
```

- **アップロードの前にブラウザの中で**: 「those images are automatically optimized, all within the browser.」。width・height は上限で、拡大はしない。
- 対象: 「`raster_image` applies to any supported raster image format: `avif`, `gif`, `heic`, `jpeg`, `png` and `webp`.」
- **HEIC**: `raster_image` か `heic` を設定すると、画像の欄と Asset Library が HEIC を受け付け「converted on upload like any other raster image」。変換は libheif（WebAssembly、初回に UNPKG から約 300 KB）で、「Safari decodes HEIC natively, so nothing is downloaded there.」。拡張子が `.jpg` の HEIC も中身で判定。変換できない HEIC は「rejected rather than uploaded as is」。
- **Exif・GPS**: 「Exif metadata is stripped from raster images to reduce file size.」 GPS は名指しされていない（GPS は Exif の一部なので消えるはず、と読めるが **未検証**）。
- **iOS Safari**: 「File processing is a bit slow on Safari because native WebP encoding is not supported」（jSquash で代わりに作る）。「If the browser can't encode WebP, the image may be saved in PNG format instead」。iOS 専用の記載は無い（**未確認**）。動く GIF・WebP・PNG は変換せずそのまま。
- `max_file_size`: 既定「`Infinity`」。
- **保存の道**: 「Sveltia CMS uses the GitHub GraphQL API where possible.」、Additions の頁「the CMS uses that token to talk to GitHub directly. Content never passes through the service」（https://sveltiacms.app/docs/additions）。**間に Function が無いので Vercel の 4.5 MB は当たらない**。GitHub の GraphQL の 1 回の要求の大きさの上限は **未確認**（縮小した後の WebP は 2560px・q85 で多くは 1 MB 前後と見込むが **未検証**）。Git LFS は非対応。

### 4.2 Decap CMS（組み込み、3.16.0 から）

出典 https://decapcms.org/docs/configuration-options/ （「Media Processing」）、release 3.16.0「Support browser image transformations」。

- 「The `media_processing` setting controls image transformations that run in the browser before Decap CMS saves uploads」。
- 「Image transformations apply to JPEG, PNG, and WebP files uploaded directly through Decap CMS.」 → **HEIC は対象外**（記載なし）。`strip_metadata` は「removes image metadata by re-encoding the uploaded image」。
- 例: `media_processing: { enabled: true, format: { enabled: true, default: webp }, quality: 80, strip_metadata: true, width: 1600 }`。width と height を両方書くとその大きさに切る（上限ではない）。
- 最新は 3.18.0（2026-11-18）、MIT。

### 4.3 Pages CMS を直す（fork・自前のアップロード部品）

- **技術的には可能**: PR #425 と同じく、`media-upload.tsx` で送る前に canvas などで縮小すればよい（HEIC は Sveltia と同じく libheif の WebAssembly を足せば可能、Safari は自前で読める）。
- ただし hosted（app.pagescms.org）には入れられない。fork を使うには **Second Root か顧客が Pages CMS 自体（Next.js + PostgreSQL + GitHub App）を運用する**ことになり、上流の更新の追従も負う。
- 上流に #425 が入れば hosted でも 3 MiB 超の JPG・PNG・WebP は縮められる見込み（HEIC は対象外のまま）。時期は **未確認**、作者の反応なし。

## 5. Sveltia CMS に入れ替える場合

既存の評価は [`cms-sveltia-evaluation.md`](cms-sveltia-evaluation.md)（情報の形の対応・`admin/config.yml` の案）。今回の更新点だけ書く。

- **成熟度（更新）**: v5.0.0（2026-11-26）の注記「Sveltia CMS is now out of beta!」「We skipped versions 1.x through 4.x…」。最新 v5.0.3（2026-11-27）。前の評価の「out of beta は未確認」はこれで確認できた。ただし **安定版になって 2 日** で、v5.0.0 では一部の設定名が変わった（例 `automatic_deployments` → `skip_ci`）。
- **ログイン**: GitHub の backend は「A GitHub account.」と書き込み権限が要る（https://sveltiacms.app/docs/backends/github）。
  **Sveltia CMS Additions**: 「sign-in with a username and password, so people don't need a GitHub account」、「designed to run on the Workers Free plan」「MIT-licensed, with no subscription and no usage fees of its own.」。必要なもの: 「Sveltia CMS v0.271.0 or later」、GitHub の backend、Cloudflare のアカウント、GitHub App を作って入れられる GitHub のアカウント（持ち主だけ。編集者は不要）。役割 admin・editor・viewer。ログインは「people can only sign in with a username and password, or with GitHub.」（パスキー・2FA は予定）。
  設定の手順（https://sveltiacms.app/docs/additions/setup）: Deploy ボタンが小さな repo を自分の GitHub に写し、Durable Object を作る。ウィザードが GitHub App を作り「Only select repositories」で入れる。更新は「Dependabot opens a pull request in your copy of the repository when a new version is released. Merge it, and Workers Builds deploys the update.」。Additions の版番号は **未確認**。
  Sveltia CMS Authenticator（GitHub の OAuth だけ）は「We now recommend Sveltia CMS Additions instead.」（https://github.com/sveltia/sveltia-cms-auth）。
- **スマートフォン**: 「Works on phones and tablets, with quick QR code sign-in」（https://sveltiacms.app/）。iPhone の実機での写真のアップロードは **未検証**。
- **ライセンス・費用**: MIT、「Free and open source forever, with no per-seat or per-site pricing」。
- **今の構築との関係**: content の JSON・`media/`・`build.mjs` はそのまま使える見込み。変換後は `.webp` になるので、今の写真の検査（JPEG・PNG・WebP、2 MiB、長辺 4096px など）を通るはず（**未検証**）。`photo-prep.mjs` は公開用の写しをさらに処理するが、Sveltia の後では repo の元の写真にも GPS が残らない点が今と違う（**未検証**）。
- 前の評価の変更点（`PAGES_YML_CHANGED` の検査、空の項目の書き方、`/admin/` の扱い）は残る。

## 6. microCMS に入れ替える場合

出典 https://microcms.io/pricing （2025/6/10 改定の料金）ほか。

- **料金**: Hobby「0円 / 月」（カード登録不要）、Team「4,900円 〜 / 月」、Business「75,000円 〜 / 月」（税抜）。Team は年 58,800 円〜（税抜、計算）。
- **アップロード**: 「1メディアのサイズ上限」Hobby **40MB**（Team 100MB）。Hobby は「画像のみ」（https://help.microcms.io/ja/knowledge/media-types-for-upload）。マネジメント API からは「アップロード可能なファイルサイズ上限は**5MB**まで」（https://document.microcms.io/management-api/post-media、管理画面からは関係なし）。
- **HEIC**: 画像 API の主な形式に「JPEG / PNG / GIF / WebP / HEIC/HEIF」（https://document.microcms.io/image-api/introduction）。管理画面が iPhone の HEIC を画像として受け付けるか、アップロード時に変換するかは **未確認**。
- **縮小**: 配信の URL の引数で行う（imgix）。「アップロード時に編集を行わなくても、アップロード後の画像URLに対してパラメータを付与することで、様々な編集を行うことが可能です。」 `fm=webp`「画像をWebP形式に変換します。」、`q`（既定 75）、`w`・`h`。「パラメータを一切付与しない場合については、オリジナルの画像が表示されます。」 → **元の写真がそのまま保存・公開される**と読める（「メディアはアップロードされた時点で「公開状態」となります。」、https://document.microcms.io/manual/media-management）。元の写真の URL から GPS が見えうる（**未検証**）。
- **iPhone の管理画面**: 推奨環境に「iOS/iPadOS: Safari」。「スマートフォンでの表示については、画面幅の関係で一部行えない操作や、PC版と比べて操作しづらいUIがございます。」（https://document.microcms.io/manual/recommended-environment）
- **Webhook → Cloudflare Pages**: Webhook の種類に「Cloudflare Pages」（「Deploy Hooks URL」）がある。「リトライ処理は行われません」（https://document.microcms.io/manual/webhook-setting）。**Hobby で使えるかは未確認**（料金表に Webhook の行が無く、×の一覧にも無い）。
- **規約**: 「法人様のウェブサイトであってもHobbyプランをご利用いただくことは可能です。」（https://help.microcms.io/ja/knowledge/free-plan-for-corporation）。制作会社の導入可・代理店契約不要（https://help.microcms.io/ja/knowledge/microcms-production-contract）、「クライアントごとに新たなサービスのご契約が必要となります。」
- **超過**: 転送量 20GB/月を超えると「即時にAPIが停止します」、翌月 1 日に解除、Team 以上にすると再開（https://help.microcms.io/ja/knowledge/hobby-20gb）。
- **書き出し・引き渡し**: GET API で JSON 取得可（全プラン）。CSV の書き出しは Team 以上（https://help.microcms.io/ja/knowledge/data-backup）。サービスの譲渡は「事前に弊社の承認があった場合に限り可能」（https://help.microcms.io/ja/knowledge/service-transfer）。Hobby の譲渡の手順は **未確認**。
- **今の構築との関係**: content が GitHub の JSON から microCMS に移る。構築が API から読み、写真を取り込んで縮める作り直しが要る（imgix の URL を店の頁から直接使うと、Q1 の「外への要求なし」に反する）。

## 7. 比較

凡例: ◎ 満たす（資料で確認）、○ 満たす見込み（**未検証**）、△ 条件つき、× 満たさない。

| 観点 | A. hosted Pages CMS（今） | B. Pages CMS を self-host | C. Pages CMS の fork（縮小を追加） | D. Sveltia CMS + Additions | E. Decap CMS | F. microCMS Hobby |
|---|---|---|---|---|---|---|
| 写真の上限 | × 元で約 3.3 MB（Vercel 4.5 MB） | △ 置き場所次第（Node なら実質なし、Netlify なら同じ問題） | ○ 縮めてから送る | ◎ Function を通らない（GitHub 側の上限は未確認） | ◎ 同左（GitHub backend の場合） | ◎ 40 MB |
| iPhone の写真をそのまま（JPEG 5 MB 超） | × | △ 元のまま repo へ | ○ | ○（資料上は満たす、実機は未検証） | ○（JPEG は縮小） | ○（管理画面の iPhone での使いやすさは注意書きあり） |
| HEIC | × 受け付けない設定 | × | △ 追加すれば可 | ◎ 変換して保存（設定時） | × 対象外 | 未確認 |
| 自動の縮小・WebP | × | × | ○ 作る | ◎ ブラウザで | ◎ ブラウザで | △ 配信時（元は保存） |
| repo・保存先の元の写真の GPS | × 残る（公開用は構築で削除） | × 同左 | ○ 削れる | ○ Exif 削除（GPS は未検証） | ○ `strip_metadata` | × 元が公開状態で残る見込み |
| 顧客のログイン | メール招待、GitHub 不要 | 同左 | 同左 | ID・パスワード（Additions）、GitHub 不要 | GitHub のアカウント必須（または Turbo のアカウント、Git Gateway） | microCMS のアカウント |
| 顧客が持つアカウント | GitHub（repo）、Cloudflare。CMS のアプリと DB は運営者 | GitHub、Cloudflare、＋サーバーと DB | 同左 | GitHub（repo と App）、Cloudflare（Pages と Worker） | GitHub、Cloudflare（＋Turbo なら Decap のアカウント） | microCMS、Cloudflare（構築を GitHub に置くなら GitHub も） |
| 年の費用（調べた範囲） | 0 円（hosted、条件は未解決） | サーバー・DB の費用（Render などの料金は未調査） | 同左 | 0 円（Workers Free・GitHub Free・Pages Free の範囲） | 0 円（Turbo Free の上限は未確認） | 0 円（Hobby）／超えれば Team 58,800 円〜（税抜） |
| Second Root の保守 | 小 | 大（サーバー・DB・更新） | 大（＋fork の追従） | 中（Worker と CMS の更新、店ごとの設定） | 中 | 小〜中（構築の作り直しは一度） |
| 囲い込み | 小（content は GitHub の JSON） | 小 | 小 | 小（同じ JSON・MIT） | 小 | 中（content が microCMS、譲渡は承認制、Hobby は CSV 不可） |
| 今からの切り替えの手間 | なし | 中 | 大 | 中（`admin/config.yml`・構築の検査の変更、評価文書に案あり） | 中 | 大（構築・情報の形・写真の検査の作り直し） |
| 商用の可否 | 未判定（条件の問い合わせ前） | MIT の範囲で可（運用の責任は自分） | 同左 | MIT・自分の口座。Cloudflare・GitHub の規約に従う | MIT。Turbo は Decap の規約（未確認） | 法人・制作会社の利用は明記で可 |

## 8. 推奨と次の一歩

**技術の推奨**: D（Sveltia CMS + Additions）を次に試す候補とする。理由: 調べた中で唯一、設定だけで ① iPhone の写真をそのまま選べる（HEIC を含む） ② アップロードの前に自動で縮小・WebP 化・Exif 削除 ③ 間の Function の 4.5 MB の制限が無い ④ 顧客は GitHub のアカウント無しで入れる ⑤ 全部を顧客の名義・無料枠に置ける、を資料上満たす。
弱点: 安定版になったばかり（v5.0.0 が 2026-11-26）、Additions の版と成熟度は未確認、認証の Worker の保守が Second Root に増える、GPS の削除と iPhone の実機の動きは未検証。

**次の試験（実施はオーナーの承認後）**: 架空の店・試験専用の Organization と repo で、Sveltia CMS + Additions を入れ、iPhone の実機から ① HEIC ② 5 MB 超の JPEG（架空の位置情報つきの合成の写真）を上げ、repo に入ったファイルの形式・大きさ・GPS の有無、構築の合否、公開までの時間を記録する。

**hosted の Pages CMS について**: 「元のファイルで約 3.3 MB まで、HEIC 不可」という既知の制限を記録して比較対象に残す。PR #425 がマージされれば JPEG は改善する見込みだが、時期は分からない。顧客に手で圧縮してもらう運用は、試験の間のつなぎ以外では採らない。

**microCMS**: 上限の問題は無いが、構築の作り直しと「元の写真が公開状態で残る」点、Hobby の Webhook の可否が未確認なので、第三の案のまま。

**約束しないこと**: どの案についても、顧客に無料の継続・機能・時期を約束しない。商用の提供の可否は、各サービスの条件と試験の結果を見てオーナーが判断する。
