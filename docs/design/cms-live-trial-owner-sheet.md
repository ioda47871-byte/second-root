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

1. Claude が用意した試験用の中身（架空のデータ・合成の画像・`.pages.yml`・`build.mjs`）を、**オーナーが** 作った空の非公開 repo に push する（既定）。
   Claude による push は外部への書き込みにあたるため、repo 名と使う認証情報を明記したオーナーの個別の承認がある場合だけの選択肢とする。token は repo・記録・報告のどこにも残さない。
2. https://app.pagescms.org を開き **GitHub でサインイン**し、repo の持ち主のアカウントに GitHub App を入れる（https://pagescms.org/docs/quick-start/）。
   入れるときに GitHub が**要求する権限を表示する**ので（「During the installation process, GitHub will tell you which permissions the GitHub App requested」、上の GitHub の文書）、**その画面を撮影して記録する**。
   リポジトリの範囲は **Only select repositories** でこの試験用 repo だけを選ぶ。
3. **権限について確かめられていること**: self-host で自分の App を作る公式の手順は、repo の Administration・Actions・Contents を**読み書き**、Checks・Commit statuses・Metadata を読み、アカウントの Email addresses を読み、を指定する（https://pagescms.org/docs/guides/installing/github-app/）。
   **hosted の App（github.com/apps/pages-cms、開発者は pages-cms）の権限は公式に書かれていない**（App の頁にも一覧が無い。https://github.com/apps/pages-cms）。手順 2 の画面が唯一の確かめる方法。
   Administration の読み書きが含まれていたら、その試験用 repo だけに限る前提で続けるかをオーナーが判断する。
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
| Build command | `node build.mjs`（依存の無い納品用の入口。まだ作っていない＝実装計画 §8 の後の候補） | 同上 get-started |
| Build output directory | `dist` | 同上 |
| Root directory | 空（repo の直下） | https://developers.cloudflare.com/pages/configuration/build-configuration/ |
| Node | v3 の構築の image の既定は 22.23.4。固定するなら `NODE_VERSION` か `.node-version` / `.nvmrc` | https://developers.cloudflare.com/pages/configuration/build-image/ |
| 環境変数・秘密 | なし（構築は repo の中だけを読む） | 実装計画 §5 |

**費用と無料の上限（Free プラン）**: 構築は月 500 回、同時 1 つ、1 回 20 分まで、1 サイト 20,000 ファイル、1 ファイル 25 MiB、1 アカウント 100 プロジェクト（https://developers.cloudflare.com/pages/platform/limits/）。Pages CMS は「100% free」と案内（https://pagescms.org/）。試験では課金の設定をしない。

**rollback**: Deployments → All deployments → 対象の「⋯」→ Rollback to this deployment。対象は**成功した本番の deployment だけ**（プレビューは不可）。30 日より古いものは、最新の 100 件と今の本番を除いて消える（https://developers.cloudflare.com/pages/configuration/rollbacks/）。

**全部を消す順**: ① Cloudflare: プロジェクト → Settings → Delete project（独自ドメインは使わないので CNAME の削除は不要）（get-started の文書）② GitHub: Installed GitHub Apps で「Cloudflare Workers and Pages」と Pages CMS を Uninstall（GitHub の接続を外すと新しい構築は止まり、前の deployment は残る、と Cloudflare は書く）③ Authorized GitHub Apps で両方を取り消す ④ 試験用 repo を削除 ⑤ Pages CMS の hosted に残るデータは問い合わせない限り消し方が不明（記録に残す）。

### 1.4 Claude ができること / オーナーだけができること

| Claude（承認の範囲で） | オーナーだけ |
|---|---|
| 架空のデータ・合成の画像・`.pages.yml`・`build.mjs` を作り、ローカルで試験する | GitHub の repo の作成、Pages CMS・Cloudflare へのサインイン、GitHub App の導入と範囲の選択 |
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
| 今の実験（`experiments/pages-cms/photos.ts`） | 受け付けない（JPEG・PNG・WebP だけ） | 2 MiB・長辺 4096px・16MP・短辺 320px・縦横比 3:1 まで（構築で検査して止める） | しない |

出典: https://pagescms.org/docs/configuration/media/ ・ https://pagescms.org/docs/configuration/fields/image/ ・ https://help.microcms.io/ja/knowledge/media-types-for-upload ・ https://document.microcms.io/image-api/introduction ・ https://microcms.io/pricing ・ https://sveltiacms.app/en/docs/media。microCMS のマネジメント API の 5MB は https://document.microcms.io/management-api/post-media の記載（検索の結果での確認、頁の本文は未読）。

**顧客の負担（今の Pages CMS の案）**: iPhone の既定の写真（HEIC、数 MB）はそのまま上げられない。案内は「カメラの設定で互換性優先（JPEG）にする」か「上げる前に縮小・JPEG で書き出す」。
Pages CMS には縮小が無いので、2 MiB を超える写真は構築で止まる（前の公開は残る）。自動の縮小（構築で縮める・GitHub Actions で縮める）は別に決める（実装計画 §9 の問い 4）。
納品の前に、写真の Exif の位置情報・ナンバープレートの扱いを確かめる（Issue #380）。

## 5. オーナーへの問い

1. §1 の実環境の試験を行うか（行うなら日時。11/30 より前か）。repo の名義と、Claude に試験用 repo への push を許すか。
2. GitHub App の導入の画面で Administration の読み書きが要求された場合も続けるか。
3. Pages CMS の運営者への問い合わせ（`pages-cms-hosted-terms.md` §6 の更新版、未送信）を送るか。名義は誰か。最終確認の依頼は [`cms-live-trial-confirmation.md`](cms-live-trial-confirmation.md)、第二の案の評価は [`cms-sveltia-evaluation.md`](cms-sveltia-evaluation.md)。
4. Brot Yanagi のサイトで使っている CMS は何か（再利用の可否を判断するため）。
5. 第二の案を Sveltia CMS と microCMS のどちらで用意するか（またはその両方を比べる試験をするか）。

## 6. 出典のアクセス日

2026-11-27: pagescms.org/docs/configuration/media/・fields/image/・github.com/apps/pages-cms、developers.cloudflare.com の 6 頁、docs.github.com の 2 頁、microCMS の 7 頁、sveltiacms.app の 3 頁と github.com/sveltia/sveltia-cms、decapcms.org と github.com/decaporg/decap-cms。
2026-11-26（`pages-cms-hosted-terms.md` の調べ）: pagescms.org の規約・個人情報・quick-start・collaborators・installing/github-app・database・caching・environment-variables。
