# CMS の実環境の試験: オーナーの操作の 1 枚と、方式の比較（Issue #380）

2026-11-27。状態: **文書だけ**。アカウントの作成・サインイン・GitHub App の導入・Cloudflare の接続・課金・外への送信は、どれもしていない。
実案件（自動車の施工店。名前・ロゴ・写真・連絡先はこの repo に書かない）の 11/30 の打ち合わせの前に、
**別の明示の承認の後**に行う実環境の試験（Issue #380 P0 の 5 つ目）の準備として書く。出典はすべて公式の資料で、アクセス日は 2026-11-27（§6 は 2026-11-26 の調べを含む）。

関連: [`pages-cms-hosted-terms.md`](pages-cms-hosted-terms.md)（hosted の規約・問い合わせの文案、未送信）、[`pages-cms-implementation-plan.md`](pages-cms-implementation-plan.md)（Q2〜Q4）。

## 1. オーナーの操作（1 回の作業でまとめて行う）

試験は**架空の自動車施工店のデータだけ**を使い、本番・実案件の口座と分ける。所要は 30〜60 分の見込み（実測ではない）。

### 1.1 事前に決めること（オーナー）

| 項目 | 推奨 | 理由・出典 |
|---|---|---|
| 試験用 repo の名義 | オーナーの個人の GitHub アカウント（新しい組織は作らない）。名前は例 `sr-cms-trial-autocare`（実店名を入れない） | 試験と本番を分ける。後で丸ごと消す。Cloudflare は「A GitHub account should only point to one Cloudflare account」としている（https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/）ので、導入前にその GitHub アカウントが本番・顧客用の Cloudflare アカウントにつながっていない（今後もつなげない）ことを確かめる。つながっている場合は試験専用の GitHub アカウントを使う |
| 公開 / 非公開 | **非公開（private）** | 試験の中身（架空のデータ・設定）を外から見えないようにするため。なお GitHub App は「always have at least read-only access to all public repositories」とされる（https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party）が、これは公開 repo についての話で、この判断の理由ではない。Pages CMS・Cloudflare の文書に非公開の repo の制限は書かれていない（not stated） |
| 顧客役の編集者 | オーナーの 2 つ目のメールアドレス（GitHub アカウントなし）で Pages CMS の協力者として招く | 協力者は「does not have a GitHub account」の人向け（https://pagescms.org/docs/configuration/collaborators/） |
| 非認可の確認用 | 招いていない別のメールアドレス、または repo に権限の無い GitHub アカウント | 書き込みが拒まれることを記録する |
| 本番の枝 | `main`（プレビューは使わない） | §1.3 |

### 1.2 Pages CMS（hosted、app.pagescms.org）

1. Claude が用意した試験用の repo 一式（納品用 repo の雛形: 架空のデータ・合成の画像・`.pages.yml`・`build.mjs` ほか。`experiments/pages-cms/export-delivery.ts` で書き出す。中身と設定の正本はその `README.md`）を、**オーナーが** 作った空の非公開 repo に push する（既定）。
   Claude による push は外部への書き込みにあたるため、repo 名と使う認証情報を明記したオーナーの個別の承認がある場合だけの選択肢とする。token は repo・記録・報告のどこにも残さない。
2. https://app.pagescms.org を開き **GitHub でサインイン**し、repo の持ち主のアカウントに GitHub App を入れる（https://pagescms.org/docs/quick-start/）。
   入れるときに GitHub が**要求する権限を表示する**ので（「During the installation process, GitHub will tell you which permissions the GitHub App requested」、上の GitHub の文書）、**その画面を撮影して記録する**。
   リポジトリの範囲は **Only select repositories** でこの試験用 repo だけを選ぶ。
3. **権限について確かめられていること**: self-host で自分の App を作る公式の手順は、repo の Administration・Actions・Contents を**読み書き**、Checks・Commit statuses・Metadata を読み、アカウントの Email addresses を読み、を指定する（https://pagescms.org/docs/guides/installing/github-app/）。
   **hosted の App（github.com/apps/pages-cms、開発者は pages-cms）の権限は公式に書かれていない**（App の頁にも一覧が無い。https://github.com/apps/pages-cms）。手順 2 の画面が唯一の確かめる方法。
   **2026-11-27 に GitHub の公開の API で実際の権限を確かめた: Pages CMS は Administration を要求せず（Contents・Actions の読み書きと `repository_creation`）、Administration の読み書きを要求するのは Cloudflare の App。** 判断の材料は [`cms-live-trial-confirmation.md`](cms-live-trial-confirmation.md) §3 を正とする。
4. 顧客役の追加: Pages CMS の協力者としてメールで招く（「Collaborators live in the database, not in `.pages.yml`」）。協力者の書き込みは GitHub App の installation token で行われ、既定では協力者の名前は commit に残らない（`settings.commit.identity: user` で残せる）（上の協力者の文書）。
   **招く・外す画面の手順は公式に書かれていない**（not stated）。外した後に顧客役で開けないことを記録する。
5. 後片付け: GitHub の Settings → Applications → Installed GitHub Apps → Pages CMS → Configure → **Uninstall**。さらに Authorized GitHub Apps で取り消す（https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps）。
   hosted の DB に残る協力者・キャッシュの削除の方法は公式に書かれていない（`pages-cms-hosted-terms.md` §3-6）。

### 1.3 Cloudflare Pages（Git 連携）

| 設定 | 値 | 出典 |
|---|---|---|
| 作り方 | Workers & Pages → Create application → Pages → Connect to Git → GitHub → repo を選び Install & Authorize | https://developers.cloudflare.com/pages/get-started/git-integration/ |
| GitHub App の範囲 | **Only select repositories** で試験用 repo だけ（Cloudflare も推奨）。具体的な権限の一覧は公式に無い（not stated）→ 入れる画面を撮影 | https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/ |
| 本番の枝 | `main`。他の枝はプレビューになるので、Branch control で Preview branch を「None」にする | https://developers.cloudflare.com/pages/configuration/git-integration/ |
| Framework preset | None | 納品用 repo の `README.md`（正本: `experiments/pages-cms/delivery-template/README.md`） |
| Build command | `npm ci && npm run build`（`package-lock.json` の固定の版を入れてから `build.mjs` を動かす） | 同上。Cloudflare の構築の文書 https://developers.cloudflare.com/pages/configuration/build-image/ |
| Build output directory | `dist` | 同上 |
| Root directory | 空（repo の直下） | 同上。https://developers.cloudflare.com/pages/configuration/build-configuration/ |
| 環境変数 | `SKIP_DEPENDENCY_INSTALL` = `1`（自動の依存の導入を止め、Build command の `npm ci` だけで入れる） | 同上 |
| Node | `.node-version`（`22.23.4`、v3 の構築の image の既定と同じ版）から読む | 同上 |
| 秘密 | なし（構築は repo の中だけを読み、ネットワークもモデルも使わない） | 同上。実装計画 §5 |

この表の値は納品用 repo の `README.md` の「Cloudflare Pages settings」と同じでなければならない（違ったら README が正しい）。実際の Pages のプロジェクトではまだ試していない。

**費用と無料の上限（Free プラン）**: 構築は月 500 回、同時 1 つ、1 回 20 分まで、1 サイト 20,000 ファイル、1 ファイル 25 MiB、1 アカウント 100 プロジェクト（https://developers.cloudflare.com/pages/platform/limits/）。Pages CMS は「100% free」と案内（https://pagescms.org/）。試験では課金の設定をしない。

**rollback**: Deployments → All deployments → 対象の「⋯」→ Rollback to this deployment。対象は**成功した本番の deployment だけ**（プレビューは不可）。30 日より古いものは、最新の 100 件と今の本番を除いて消える（https://developers.cloudflare.com/pages/configuration/rollbacks/）。

**全部を消す順**: ① Cloudflare: プロジェクト → Settings → Delete project（独自ドメインは使わないので CNAME の削除は不要）（get-started の文書）② GitHub: Installed GitHub Apps で「Cloudflare Workers and Pages」と Pages CMS を Uninstall（GitHub の接続を外すと新しい構築は止まり、前の deployment は残る、と Cloudflare は書く）③ Authorized GitHub Apps で両方を取り消す ④ 試験用 repo を削除 ⑤ Pages CMS の hosted に残るデータは問い合わせない限り消し方が不明（記録に残す）。

### 1.4 Claude ができること / オーナーだけができること

| Claude（承認の範囲で） | オーナーだけ |
|---|---|
| 納品用 repo の雛形（架空のデータ・合成の画像・`.pages.yml`・`build.mjs`）を書き出し、ローカルで `npm ci`・`npm run build`・`npm test` で試験する | GitHub の repo の作成、Pages CMS・Cloudflare へのサインイン、GitHub App の導入と範囲の選択 |
| 試験用 repo へ push するファイル一式を渡す（Claude 自身の push は repo と認証情報を明記した個別の承認がある場合だけ） | Cloudflare のプロジェクトの作成・設定・削除、rollback の操作 |
| 公開された URL を読み、PC 1440 / SP 390 で撮影し、Q1 の判定をする | 協力者（顧客役）の招待・削除、顧客役でのログインと編集（スマートフォンの実機かどうかを記録） |
| commit SHA・deployment ID・時刻を集め、報告を書く | 問い合わせの送信、課金、実案件の口座・写真・名前の使用（どれも別の承認） |

### 1.5 残す証拠

- GitHub App の導入の画面（Pages CMS・Cloudflare それぞれの要求する権限と、選んだ repo）。
- 顧客役の操作ごとに: CMS で保存した時刻 → commit SHA → Cloudflare の deployment ID と構築の開始・終了の時刻 → 公開 URL で変化を確かめた時刻（キャッシュを避けて再読み込み）。
- 公開 URL の PC 1440 / SP 390 の撮影（変更の前と後）。実機を使わなければ「エミュレーション」と書く。
- 招いていない人・外した人で開いたときの拒否の画面。
- わざと壊した content で構築が止まり、前の公開が残ったこと（deployment の一覧の撮影）と、rollback した場合はその時刻。
- 後片付けの各段の完了の撮影。

## 2. hosted の Pages CMS の商用利用の状態と、顧客への約束

- 公式は「100% free」と案内するが、利用規約（2024-02-07 版）の対象は pagescms.org の Website で、**app.pagescms.org・商用利用・代理店の利用・数の上限は書かれていない**。
  規約の条項（予告なしの停止・保証なし・責任 100 USD）が hosted に適用されるかも不明。詳しくは [`pages-cms-hosted-terms.md`](pages-cms-hosted-terms.md)。
- 運営者への問い合わせの文案は**未送信**のまま（送るか・名義はオーナーが決める）。
- **顧客に言えること**: 「GitHub を使う無料の CMS で更新できる仕組みを試験中で、提供の条件を確かめている」まで。
  **言えないこと**: hosted の Pages CMS をずっと無料で使える、規約上問題ない、サービスが続く、の約束。CMS 込みの価格・機能も、オーナーと顧客が合意するまで約束しない（Issue #380）。
- 実環境の試験が通っても、商用の条件が解決するまでは Issue #380 の判定は「技術的実現性」まで。

## 3. 代わりの方式（同じ基準で）

| 基準 | Pages CMS（hosted） | microCMS（Hobby） | Sveltia CMS（Decap の後継） | Decap CMS | Brot Yanagi の既存の CMS |
|---|---|---|---|---|---|
| 顧客がスマホで実績と写真を更新 | 協力者はメールで招かれ GitHub 不要。スマホでの使い勝手は未確認 | 管理画面で編集。モバイルは「デバイスによってはアップロードできるファイルの種類が限られる可能性」 | 「mobile support」を掲げる。編集者は GitHub の書き込み権限が要る。GitHub なしは別の Sveltia CMS Additions（自分の Cloudflare に置く、無料）で ID とパスワード | 編集者全員が GitHub の push 権限が要る | repo に記載なし |
| 費用 | 無料と案内（上限・将来は not stated） | 0 円。API 5・メンバー 3・転送量 20GB/月（**超えると API が即停止**）・1 ファイル 40MB・10,000 件 | 本体は MIT で無料。認証は Cloudflare Workers に自分で置く | MIT で無料。認証のサーバー（Netlify など）が要る | 不明 |
| 商用・代理店 | **not stated**（§2） | 法人のサイトも Hobby 可。制作会社が契約して顧客の環境に導入してよい。原則クライアントごとに別の契約 | MIT（自分で置く） | MIT（自分で置く） | 不明 |
| 所有・引き渡し | content は顧客の GitHub。hosted の App と DB は運営者のもの | content は microCMS の中。名義の変更は**事前の承認がある場合だけ** | content は顧客の GitHub。認証の Worker も顧客の Cloudflare に置ける | content は顧客の GitHub | 不明 |
| ロックイン | 低い（JSON と画像が repo に残る。self-host は MIT） | 中（API で取り出す。画像は microCMS の配信） | 低い | 低い | 不明 |
| 権限の分け方 | 協力者は content の編集だけ（`.pages.yml` の設定どおり） | 権限管理（ロール）は Business 以上。Hobby のメンバーの権限の違いは not stated | Additions に admin・editor・viewer | GitHub の権限 | 不明 |
| 構築の起動 | GitHub への commit → Cloudflare の Git 連携 | Webhook に「Cloudflare Pages」がある（Deploy Hook の URL を登録）。**失敗しても再試行しない** | commit → Git 連携 | commit → Git 連携 | 不明 |
| 今の実験との相性 | 既存の `experiments/pages-cms/` をそのまま使える | 読み込みを API に変える作り直しが要る。画像は microCMS の URL | `.pages.yml` の代わりに Decap 形式の設定を作る。content の JSON はそのまま使える見込み | Sveltia と同じ | — |
| 手間 | 小（App の導入だけ） | 中（API・Webhook・API キーの管理。キーは秘密） | 中（Worker の認証を置く。Additions を使うなら更に） | 中〜大（認証サーバー） | — |

出典: microCMS https://help.microcms.io/ja/knowledge/free-plan-for-corporation ・ https://microcms.io/pricing ・ https://help.microcms.io/ja/knowledge/microcms-production-contract ・ https://help.microcms.io/ja/knowledge/agency-service-contract-requirement ・ https://document.microcms.io/manual/roles ・ https://document.microcms.io/manual/webhook-setting ・ https://help.microcms.io/ja/knowledge/media-types-for-upload。
Sveltia https://github.com/sveltia/sveltia-cms ・ https://sveltiacms.app/en/docs/backends/github ・ https://sveltiacms.app/en/docs/additions ・ https://sveltiacms.app/en/docs/media。
Decap https://decapcms.org/docs/github-backend/ ・ https://github.com/decaporg/decap-cms。

**Brot Yanagi の既存の CMS**: この repo には、トップページの実績の紹介に「CMS導入」とあるだけで（`components/home/RealProject.tsx`、`components/home/Pricing.tsx` の「原則1種類の情報を更新できるCMS」）、
**どの CMS か・構成・費用・引き渡しの方法は書かれていない**。再利用できるかは、オーナーがその CMS の正体を教えるまで判断できない（オーナーへの問い）。

**推奨（危険つき）**:
1. **第一の案は今のまま Pages CMS（hosted）で実環境の試験**を行う（content が顧客の GitHub に残り、今の実験をそのまま使え、手間が最小）。ただし商用の条件が不明なので、顧客には「試験中」とだけ言う。
2. **商用の条件が解決しなければ、Sveltia CMS（+ 必要なら Additions）を第二の案**にする。content の形（GitHub の JSON と画像）を変えずに CMS の画面だけ入れ替えられ、MIT で自分の口座に置ける。危険: 認証の Worker を置く手間と保守、Additions は新しく実績が少ない（成熟度は未確認）、実際の試験はまだ。
3. **microCMS は、規約がいちばんはっきりしている案**（法人可・制作会社の導入可）。危険: content が microCMS に入り GitHub に残らない、20GB を超えると API が止まる（静的に構築すれば閲覧では API を呼ばないので通常は小さい見込み、未計測）、Hobby に権限管理が無い、名義の変更に承認が要る、作り直しの量が大きい。
4. どの案でも**無料がずっと続くとは約束しない**。各サービスの料金・規約は変わりうる。

## 4. スマートフォンの写真

| | HEIC | 大きさの上限 | 縮小・変換 |
|---|---|---|---|
| Pages CMS | 文書に記載なし。`extensions` で許す拡張子を決める（今の設定は jpg・jpeg・png・webp と大文字だけ＝HEIC は選べない） | 文書に記載なし | 文書に記載なし（例に「Optimize images」の action があるが、中身は GitHub の workflow で説明なし） |
| microCMS | アップロードの文書に記載なし（拡張子の制限はしていない、ただし Hobby は画像だけ）。画像 API の主な形式に「HEIC/HEIF」がある（配信のときの変換の話） | 1 ファイル 40MB（Hobby）。マネジメント API からは 5MB | 画像 API の URL の引数で縮小（例 `?w=600`）。`?auto=format` は非対応 |
| Sveltia CMS | 変換（`raster_image` か `heic`）を設定すれば、アップロードのときに変換。設定しないと画像の欄で HEIC を選べない | `max_file_size`（既定は無制限） | WebP への変換と最大の幅・高さへの縮小、Exif を消す |
| 今の実験（`experiments/pages-cms/photos.ts`） | 受け付けない（JPEG・PNG・WebP だけ。HEIC は CONTENT_PHOTO_HEIC で止まり、案内を出す） | 公開する写真は 2 MiB・長辺 4096px・16MP・短辺 320px・縦横比 3:1 まで（構築で検査して止める） | 納品用 repo の構築（`photo-prep.mjs`）が顧客の写真を縮める: 向きを直し、2560px に収め、Exif（GPS を含む）を消した写しを公開する。repo の元の写真は変えない |

出典: https://pagescms.org/docs/configuration/media/ ・ https://pagescms.org/docs/configuration/fields/image/ ・ https://help.microcms.io/ja/knowledge/media-types-for-upload ・ https://document.microcms.io/image-api/introduction ・ https://microcms.io/pricing ・ https://sveltiacms.app/en/docs/media。microCMS のマネジメント API の 5MB は https://document.microcms.io/management-api/post-media の記載（検索の結果での確認、頁の本文は未読）。

**顧客の負担（今の Pages CMS の案）**: iPhone の既定の写真（HEIC）は使えない。案内は「カメラの設定で互換性優先（JPEG）にする」か「Safari から上げる」（Safari は JPEG にして送る見込み。未検証。`pages-cms-phone-photos.md`）。
大きな JPEG（数 MB）は納品用 repo の構築が縮めて公開するので、顧客が縮める必要は無い（Issue #380 PR 3）。
納品の前に、写真の Exif の位置情報・ナンバープレートの扱いを確かめる（Issue #380）。

## 5. オーナーへの問い

1. §1 の実環境の試験を行うか（行うなら日時。11/30 より前か）。repo の名義と、Claude に試験用 repo への push を許すか。
2. Cloudflare の App の Administration 読み書き、Pages CMS の App の `repository_creation` 書き込み（どちらも確認書 §3）を、試験用 repo に限る前提で認めるか。
3. Pages CMS の運営者への問い合わせ（`pages-cms-hosted-terms.md` §6 の更新版、未送信）を送るか。名義は誰か。最終確認の依頼は [`cms-live-trial-confirmation.md`](cms-live-trial-confirmation.md)、第二の案の評価は [`cms-sveltia-evaluation.md`](cms-sveltia-evaluation.md)。
4. Brot Yanagi のサイトで使っている CMS は何か（再利用の可否を判断するため）。
5. 第二の案を Sveltia CMS と microCMS のどちらで用意するか（またはその両方を比べる試験をするか）。

## 6. 出典のアクセス日

2026-11-27: pagescms.org/docs/configuration/media/・fields/image/・github.com/apps/pages-cms、developers.cloudflare.com の 6 頁、docs.github.com の 2 頁、microCMS の 7 頁、sveltiacms.app の 3 頁と github.com/sveltia/sveltia-cms、decapcms.org と github.com/decaporg/decap-cms。
2026-11-26（`pages-cms-hosted-terms.md` の調べ）: pagescms.org の規約・個人情報・quick-start・collaborators・installing/github-app・database・caching・environment-variables。

## 付録 A. 実環境の試験の手順（12 項目、架空の車の店だけ）

オーナーの承認（2026-11-27）: 実環境の試験に進む。使うのは架空の車の店のデータだけ。
**App の導入・repo の作成・公開は、その場でオーナーが最後に確かめてから行う。** Claude はどの外部の操作もしない。
1 回の作業で終わるように、必要な物は先にローカルに用意してある。

### A.0 用意してある物と事前の作業

| 物 | 場所 | 中身 |
|---|---|---|
| 試験用 repo（push の前の状態） | `~/second-root-trial/sr-cms-trial-autocare/` | `export-delivery.ts` で書き出した納品用 repo。`main` に commit が 1 つ（作者は中立の仮名 `Trial Kit <trial-kit@example.invalid>`）。remote は無い。きれいな clone で `npm ci && npm run build && npm test` が通ることを確認済み |
| 試験データ | `~/second-root-trial/test-data/`（repo の外） | 合成の画像と壊れた entry。`manifest.json` に一覧。作り方は `experiments/pages-cms/live-trial-data.mjs` |
| 測る道具 | Second Root の `experiments/pages-cms/live-trial-measure.ts` | 読むだけ。公開 URL を GET するか、ローカルの checkout を読む。サインインも書き込みもしない |

試験データの中身:
- `phone/IMG_4001〜4003.JPG`: 4032×3024、約 5 MB。EXIF の向き 6（横に保存し、縦に表示）、架空の位置情報（北緯 0°・東経 0°。実在の場所の位置情報は入れない）。
- `phone/IMG_4800.JPG`: 8064×6048（4800 万画素）、約 11.6 MB、同じ架空の位置情報。
- `before-after/pair-1|2-before|after.jpg`: 施工前と施工後の組。
- `multi/*.jpg`: 4:3・3:4・16:9・1:1。
- `heic/IMG_4002-fake-heic.jpg`: HEIC の頭だけを持つ偽のファイル。**本物の HEIC は作れなかった**（sharp の既製のバイナリは HEVC を書けない）。本物は iPhone で撮って試す。
- `broken/*.json`: 途中で切れた JSON、写真が 0 枚、存在しない写真。

以下では測る道具を `TOOL` と書く。Second Root の checkout で次のように動かす: `npx tsx experiments/pages-cms/live-trial-measure.ts`。
公開 URL は `URL` と書く。例: `https://sr-cms-trial-autocare.pages.dev/`。

事前の作業（オーナー。順に）:
1. GitHub のオーナーの個人のアカウントに**空の非公開（private）repo** `sr-cms-trial-autocare` を作る（README などは作らない。名前と非公開は `cms-live-trial-confirmation.md` §1 で決めたとおり）。
2. `~/second-root-trial/sr-cms-trial-autocare/` で `git remote add origin <その repo の URL>` を実行し、`git push -u origin main` で push する。commit の作者を自分にしたい場合は、push の前に `git commit --amend --reset-author --no-edit` を実行する。
3. §1.2 の手順で Pages CMS の GitHub App を**この repo だけ**に入れ、要求された権限の画面を撮影する。
4. §1.3 の表のとおり Cloudflare Pages を設定する（値の正本は repo の `README.md`）。Cloudflare の GitHub App も **Only select repositories** でこの repo だけにする。最初の構築が成功し、`URL` に「架空のカーケア工房 そらいろ」が出ることを確かめる。

### A.1〜A.12 各項目の手順

どの項目でも記録すること: 操作した時刻、CMS で保存した時刻、commit SHA（GitHub の commit の一覧）、Cloudflare の deployment ID と構築の開始・終了の時刻、`TOOL` の出力（JSON をそのまま保存する）、PC 1440 / SP 390 の撮影。実機ではないときは「エミュレーション」と書く。

| # | 項目 | 手順 | 期待する結果 | 記録・道具 |
|---|---|---|---|---|
| 1 | 施工実績の追加・編集・削除 | CMS の「施工実績」で ① 追加: 車種「架空車 試験 新規」・施工の種類・写真 1 枚で保存する ② 編集: 車種を「架空車 試験 編集」に変える ③ 削除: その entry を消す | 保存のたびに commit が 1 つでき、構築が成功し、頁に出る・変わる・消える。entry の file 名は自動の ID（uuid）になる見込み（**未検証**。Pages CMS の source を読んだだけ。実際の file 名を記録する） | 操作ごとに `TOOL wait --url URL --marker "架空車 試験 新規" --timeout 900`（編集は「架空車 試験 編集」）。削除は頁から消えたことを撮影する。GitHub で新しい file の名前を記録する |
| 2 | 1 件に複数枚の写真 | 1 つの entry に `multi/` の 4 枚を付ける。5 枚目を足そうとする | 4 枚まで保存でき、頁の 1 つの札に大 1 枚と小 3 枚が出る。5 枚目は、CMS が保存を止めるか、保存できても構築が `CONTENT_INVALID` で止まって前の公開が残るか、のどちらでも合格（試行の上限 4 枚）。どちらだったかを記録する | `TOOL images --url URL --min-images <公開されているはずの枚数>` が exit 0 で、4 枚が公開されていること |
| 3 | 施工前・施工後 | `before-after/pair-1-before.jpg` を「施工前」、`pair-1-after.jpg` を「施工後」にして保存する | 頁で 2 枚が並び、「施工前」「施工後」の札が付く | PC と SP の撮影 |
| 4 | スマートフォンからの更新 | 顧客役が iPhone の Safari で招待のメールから入り、1 と同じ追加をする。写真は「写真ライブラリ」から選ぶ | 保存でき、頁に出る。iPhone の HEIC の写真も Safari が JPEG にして送る見込み（**未検証**。`pages-cms-phone-photos.md` §2） | 機種・iOS の版・ブラウザ。repo に入った写真の拡張子と大きさ（GitHub の画面）。`TOOL originals --repo <手元の clone>` |
| 5 | 4〜6 MB の JPEG | `phone/IMG_4001.JPG`（約 5 MB）を PC のブラウザの CMS から上げて保存する。続けて `IMG_4800.JPG`（約 11.6 MB） | CMS が受け付け、repo に元のまま入り、構築が成功する。11.6 MB は hosted の Pages CMS がリクエストの大きさで断る可能性がある（**未検証**）。断られたらその表示を記録する | 上げた時刻と結果。GitHub での file の大きさ |
| 6 | 自動の最適化 | 5 の後の公開の頁を測る | 合格の条件（すべて）: ① `TOOL images` が exit 0（`status` が `measured`、`failures` が空。どの写真も HTTP 200 で、JPEG・PNG・WebP のどれか） ② `count.measured` が、上げた写真の枚数以上 ③ `IMG_4001.JPG` が 1920×2560 で、`exif` と `gps` が false ④ `with_gps` と `with_metadata` が空 | `TOOL images --url URL --min-images <上げた写真の枚数>`。exit 1 なら `failures` を記録する（測れなかった写真は「GPS 無し」ではない） |
| 7 | GitHub への保存 | 1〜5 の保存の後、GitHub の commit の一覧と `content/works/`・`media/` を見る | 保存ごとに commit があり、content は JSON、写真は `media/` に入っている。`.pages.yml` と `site/` は変わっていない | commit SHA と作者（既定は App の名前。§1.2 の 4） |
| 8 | Cloudflare の自動公開 | 7 の各 commit について Cloudflare の Deployments を見る | commit ごとに本番の deployment が自動ででき、成功する | deployment ID、開始・終了の時刻、構築の記録の最後の行（`build ok: …`） |
| 9 | 反映までの時間 | CMS で保存する直前に `TOOL wait --url URL --marker "<新しい車種>" --interval 10 --timeout 900` を始めて、保存する | 数分以内に `"status": "found"` が出る（目安。保証ではない） | 出力の `elapsed_ms`（保存の操作から見つかるまで）。3 回測って中央値を記録する |
| 10 | 編集者の権限の管理 | ① 顧客役をメールで招く ② 顧客役で入り、施工実績を編集できること、`.pages.yml`・`site/`・`build.mjs` が CMS に出ないことを確かめる ③ 招いていない人で開く ④ 顧客役を外し、もう一度開く | ② 編集できるのは content と写真だけ ③ と ④ は入れない・保存できない | それぞれの画面の撮影と時刻 |
| 11 | 構築の失敗で前の公開が残る | GitHub の画面で `test-data/broken/no-photo.json` の中身の file を `content/works/` に作る（または CMS で写真の無い保存を試す。CMS は写真 0 枚を止めるので、GitHub の画面で入れる）。もう 1 つ、写真の欄を `heic/IMG_4002-fake-heic.jpg` にした entry でも試す | 構築が失敗し（構築の記録に `CONTENT_INVALID`、HEIC なら `CONTENT_PHOTO_HEIC` と案内）、`URL` は前の公開のまま | Cloudflare の失敗の deployment の撮影。失敗の後に `TOOL images --url URL` を動かし、前と同じであること |
| 12 | 復旧 | ① 11 の壊れた file を GitHub で消す（または直す）→ 構築が成功する ② Deployments で前の成功した deployment に Rollback し、それから最新に戻す（§1.3 の rollback） | ① 次の構築が成功し、頁が戻る ② rollback の直後に前の頁、戻した後に最新の頁 | 時刻、deployment ID、`TOOL wait` の出力 |

### A.13 位置情報（GPS）について（はっきり分けて記録する）

- **公開される写真**: 納品用 repo の構築（`photo-prep.mjs`）が、顧客の写真の EXIF（GPS を含む）を消した写しを公開する。項目 6 で `TOOL images` の `with_gps` が空であることを確かめる。ローカルの試し（2026-11-27）で、偽の GPS 付きの 5.0 MB の写真は 1920×2560・416 KB の EXIF の無い写しとして公開された。
- **repo の中の元の写真**: Pages CMS は写真をそのまま GitHub に保存する（縮小・変換・メタデータの除去は無い。`pages-cms-phone-photos.md` §3）。そのため、**顧客の電話や Safari が上げる前に位置情報を消さない限り、repo の元の写真には GPS が残る**。iOS の Safari が写真を JPEG にするときに位置情報を消すかは**未検証**（消すという報告はあるが、公式の文書は無い）。項目 4 と 5 の後に `TOOL originals --repo <手元の clone>` を動かし、`with_gps` に出た file を記録する（ローカルの試しでは、偽の GPS 付きの元の写真は repo の中で GPS を持ったままだった）。
- repo は非公開だが、repo に入れる人（オーナー、Pages CMS の App、Cloudflare の App）は元の写真の位置情報を読める。
- **公開の写真の合格の条件**は A.6 のとおり（`TOOL images` が exit 0 で、測れなかった写真が無いこと）。測れなかった写真（HTTP 200 でない、形式が分からない、メタデータが読めない）は `failures` に出る。それを「GPS 無し」と読まない。
- **道具が読めるもの・読めないもの**（`exif-scan.ts`）: JPEG の Exif と XMP（Extended XMP をつないだもの）、PNG の eXIf・XMP（圧縮も含む）・ImageMagick の「Raw profile type exif / APP1 / xmp」、WebP の EXIF・XMP。
  読めないもの（`unknown` として出し、`TOOL originals` では `unscannable` に並ぶ）: HEIC・HEIF・AVIF、JPEG・PNG・WebP 以外の形式、展開できない圧縮のかたまり、壊れた・途中で切れたファイル（読めない Exif を含む）。これらに位置情報が無いとは言えないので、手で確かめる（例: Mac のプレビューの「情報を見る」）。既知の限界: TIFF の頭は読めるのに GPS の位置（タグ 0x8825）がファイルの外や不自然な数を指す、意図的に壊したファイルは「GPS 無し」と出ることがある（実機の写真では起きにくい）。
  そのほか、知られていない置き場所（独自のメーカーの領域など）は調べていない。
- **案（どれも今は作らない。決めるのはオーナー）**:
  1. 顧客に、店の写真を撮るカメラの位置情報を切ってもらう（iPhone は「設定」→「プライバシーとセキュリティ」→「位置情報サービス」→「カメラ」→「なし」。Apple の文書での確認は未）。
  2. 後で CMS の側で手当てする: GitHub Actions で `media/` の元の写真から位置情報を消す commit を自動で作る、または位置情報を消せる CMS（Sveltia CMS は Exif の除去を持つ。§4）に替える。
  3. 納品の前に、`TOOL originals` で位置情報の残る元の写真を確かめて報告する（今回の確認の手順）。

### A.14 試験の後

- §1.3 の「全部を消す順」で片付ける。試験データは `~/second-root-trial/` に残る（Second Root の git には入れない）。
- 結果は項目ごとに「通った・通らない・試せない（理由）」で報告する。未検証と書いた点（4・5・A.13）は、実際の結果で書き換える。
