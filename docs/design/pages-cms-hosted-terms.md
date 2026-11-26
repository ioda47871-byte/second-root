# Pages CMS（hosted）の規約と継続の確認（DEV-303 小さな PR の 5）

2026-11-26。状態: **文書だけ**。公式の資料（pagescms.org・GitHub の pages-cms/pages-cms）を読んだだけで、アカウントの作成・サインイン・GitHub App の導入はしていない。
問い合わせは**送っていない**（文案はオーナーの承認待ち）。親の計画: [`pages-cms-implementation-plan.md`](pages-cms-implementation-plan.md) §8 の 5・§9 の問い 1。

## 1. 要約

- **料金**: 公式サイトは「100% free」（hosted も self-host も）と書く。有料プラン・上限の記載は無い。
- **規約**: 利用規約（2024-02-07 版）は「Service」を **pagescms.org の Website** と定義し、**app.pagescms.org（hosted のアプリ）に触れていない**。
  商用利用・代理店の利用・店舗やサイトや利用者の数・上限は**どこにも書かれていない**。
- **継続**: 運営側は「予告なく、理由を問わず」利用を止められる。規約の変更は重大なら 30 日前の通知に「合理的な努力」をする、だけ。
  サービス自体の変更・終了の通知期間は**書かれていない**。保証なし（AS IS）、責任の上限は支払額または 100 米ドル。準拠法はシンガポール。
  （規約の対象は Website。hosted に適用されるかは不明＝§3-1。適用されないなら、hosted の条件は何も書かれていないことになる）
- **データ**: GitHub App は repo の **Administration・Actions・Contents の読み書き**を求める（self-host 用の文書に書かれた権限。hosted の App が同じかは未確認）。
  アプリの DB には認証の情報（GitHub のトークンは暗号化）・協力者・設定・**内容のキャッシュ**が入る。原本は GitHub。
- **逃げ道**: ソースは MIT ライセンスで、self-host（PostgreSQL・GitHub App・HTTPS）と Vercel への deploy の手順が公式にある。
  hosted が止まっても、顧客の GitHub の原本と Cloudflare Pages の公開済みのサイトは残る（構成上の推論）。編集の手段だけを入れ替える。
- **結論**: 「代理店が多数の小さな店のサイトを顧客名義の口座で作り、hosted を使わせる」ことを規約は禁じても認めてもいない。導入の前に運営者へ確かめる（§5 の文案）。

## 2. 公式情報（出典つき）

アクセス日はすべて 2026-11-26。引用は英語の原文。

| 項目 | 公式の記載 | 出典 |
|---|---|---|
| 料金 | 「Yes, Pages CMS is 100% free, whether you want to use the online version」、Vercel への deploy・self-host も無料 | https://pagescms.org/ |
| 運営者 | 作者は Ronan Berder（「My name is Ronan Berder (@hunvreus). I live in Singapore.」、フッター「© Ronan Berder」）。規約の「Company」は「Pages CMS」、「Country」は Singapore。hosted の運営の主体（個人か法人か）・法人名・住所は **not stated** | https://pagescms.org/ ・ https://pagescms.org/terms |
| 支援 | GitHub Sponsors への「Sponsor me」 | https://pagescms.org/ |
| 規約の版 | 「Last updated: February 07, 2024」 | https://pagescms.org/terms |
| 規約の対象 | 「"Service" refers to the Website」「"Website" refers to Pages CMS, accessible from https://pagescms.org」。app.pagescms.org への言及なし。本文に「the Application」が 2 回出る（個人情報の節と準拠法の節）が、定義の節で定義されていない（汎用のひな形の文言と見られる。推論） | https://pagescms.org/terms |
| 商用利用・数の上限 | 記載なし（**not stated**）。年齢は 18 歳以上と表明する | https://pagescms.org/terms |
| 利用の停止 | 「We may terminate or suspend Your access immediately, without prior notice or liability, for any reason whatsoever」 | https://pagescms.org/terms |
| 規約の変更 | 「If a revision is material We will make reasonable efforts to provide at least 30 days' notice」。重大かは運営の判断。使い続けると同意とみなす | https://pagescms.org/terms |
| 保証・責任 | 「AS IS」「AS AVAILABLE」。責任の上限は Service で支払った額、購入が無ければ 100 USD | https://pagescms.org/terms |
| 準拠法・連絡先 | シンガポール法。contact@pagescms.org | https://pagescms.org/terms |
| 個人情報 | 版は 2024-02-07。メール・氏名・利用の記録（IP・ブラウザなど）・cookie。**アクセストークンや repo の内容の扱いは書かれていない**。保存場所は運営の拠点と関係者の所在地（国外への移転あり） | https://pagescms.org/privacy |
| hosted の使い方 | app.pagescms.org を開き、GitHub でサインインし、repo を持つアカウントか組織に GitHub App を入れる | https://pagescms.org/docs/quick-start/ |
| GitHub App の権限 | アカウント: Email addresses（読み）。repo: **Administration（読み書き）・Actions（読み書き）・Contents（読み書き）**・Checks（読み）・Commit statuses（読み）・Metadata（読み）。Webhook: Installation target・Repository・Push・Delete・Check run・Check suite・Status・Workflow run。**self-host で自分の App を作る手順の記載で、hosted の App の権限は not stated** | https://pagescms.org/docs/guides/installing/github-app/ |
| DB に入るもの | 「stores app state in PostgreSQL: auth data, collaborators, parsed config, and cache metadata」「Content itself stays in GitHub」 | https://pagescms.org/docs/development/database/ |
| 内容のキャッシュ | `cache_file` は「collection/media rows, file metadata, and cached content」。「GitHub as the source of truth and PostgreSQL as a read cache」。self-host の `FILE_TTL_MIN`（ファイルのキャッシュの寿命）の既定は 1440 分（`-1` で無期限）。**hosted の値は not stated** | https://pagescms.org/docs/development/caching/ ・ https://pagescms.org/docs/development/environment-variables/ |
| トークン | `CRYPTO_KEY`:「Key used to encrypt GitHub tokens in the database」 | https://pagescms.org/docs/development/environment-variables/ |
| 協力者 | GitHub のアカウントが無い人をメールで招く。協力者は DB に入る（`.pages.yml` ではない）。書き込みは GitHub App の installation token。人数の上限は **not stated** | https://pagescms.org/docs/configuration/collaborators/ |
| ライセンス | 「Everything in this repo is released under the MIT License」。LICENSE は「Copyright 2025 Ronan Berder」。pagescms.org がリンクする https://github.com/pages-cms/pages-cms は 2026-11-26 に **https://github.com/hunvreus/pagescms へ転送**され、README の clone のコマンドは `https://github.com/pagescms/pagescms.git` を使う（repo の正本の場所が文書の間でそろっていない） | https://github.com/hunvreus/pagescms ・ https://raw.githubusercontent.com/pages-cms/pages-cms/main/LICENSE |
| self-host | PostgreSQL（`DATABASE_URL`）、`BETTER_AUTH_SECRET`・`CRYPTO_KEY`・`BASE_URL`、自分の GitHub App、HTTPS の公開 URL。メールは任意（Resend か SMTP） | https://pagescms.org/docs/guides/installing/self-host/ ・ https://pagescms.org/docs/development/environment-variables/ |
| 版の変更の例 | 2.x への更新は DB・環境変数・GitHub App の権限の追加（Actions・Checks など）を要した。hosted の利用者への告知・日付は **not stated** | https://pagescms.org/docs/guides/upgrading-to-2/ |

## 3. 不明点（公式に書かれていないこと）

1. app.pagescms.org（hosted のアプリ）に利用規約が適用されるか（規約の「Service」は pagescms.org の Website だけ）。
2. 商用利用、特に**代理店が多数の店のために設定し、顧客名義の GitHub・Cloudflare の口座で使わせる**形が認められるか。
3. 利用者・repo・協力者・組織の数、API の呼び出し・保存の量の上限。将来の有料化の予定。
4. サービスの大きな変更・終了・hosted の停止の**通知期間**と、データの持ち出しの手段（協力者の一覧など）。
5. hosted の GitHub App の実際の権限（self-host の文書と同じか。特に Administration と Actions の読み書きを何に使うか）。
6. hosted の DB に入る内容のキャッシュ・トークンの保存期間、アンインストールや退会の後の削除、保存場所（国・事業者）。
7. 運営の主体（個人か法人か）と、障害時の連絡の窓口。

## 4. リスクと対策

規約の条項（予告なしの停止・30 日の通知・AS IS・100 USD）は、規約の対象が Website なので、hosted に適用されるかは不明（§3-1）。下の表は、適用される場合と、hosted の条件が何も無い場合の両方を想定する。

| リスク | 影響 | 対策 |
|---|---|---|
| 規約が hosted と商用・多数の店に触れていない | 後で利用を断られる、条件が変わる | 導入の前に §5 で問い合わせ、回答を記録する。回答が無ければ hosted を前提にしない案（self-host）を並べて持つ |
| 予告なしの停止・サービスの終了 | 顧客が編集できない（公開中のサイトと GitHub の原本は残る） | 引き渡しの資料（Q4）に「Pages CMS が止まったとき」の案内を入れる: GitHub の画面での JSON の直接の編集、self-host、別の Git ベースの CMS への移行。content は Pages CMS に依存しない JSON の形にしてある |
| 版の更新で設定や権限が変わる（2.x の例） | `.pages.yml` の互換性、顧客への GitHub App の権限の再承認 | `.pages.yml` は生成器から作り直せる（実装計画 §4）。版の変更を定期に確かめる |
| GitHub App の広い権限（Administration・Actions の読み書き） | 顧客の repo の設定を App が変えられる | App は**その店の repo だけ**に入れる（全 repo にしない）。hosted の権限を問い合わせで確かめ、引き渡しの資料に書く |
| hosted の DB に内容のキャッシュとトークンが入る | 第三者（運営）に店の内容と認証が置かれる | 公開の情報（メニュー・営業時間）だけを content に置く。秘密を repo に置かない（実装計画 §5）。個人情報の扱いを問い合わせる |
| 責任の上限が小さい（100 USD）・保証なし | 障害の補償は無い | 顧客との契約で、Pages CMS は第三者の無料のサービスで保証しないと明記する（責任の範囲） |
| self-host に切り替える費用 | DB・HTTPS・GitHub App・保守の手間 | MIT なので法的には可能。費用と担い手は別に決める（オーナーへの問い） |

## 5. 問い合わせ文案（未送信・要オーナー承認）

宛先の候補: contact@pagescms.org（規約・個人情報の文書にある連絡先）。**送るかどうか、誰の名義で送るかはオーナーが決める。** 名義・会社名は空欄のまま。

### 日本語

> 件名: Pages CMS（app.pagescms.org）の商用利用と利用条件についての質問
>
> Pages CMS ご担当者さま
>
> 日本で小さな店舗（パン屋・カフェなど）のウェブサイトを制作している〔名義〕と申します。
> 制作したサイトを、店舗さま名義の GitHub の repo と Cloudflare Pages で公開し、店舗さまご自身が app.pagescms.org でメニューや営業時間を更新する形を検討しています。
> 公開されている利用規約（2024-02-07 版）と文書を拝見しましたが、次の点が分からなかったため、ご教示ください。
>
> 1. 利用規約は app.pagescms.org（hosted のアプリ）にも適用されますか。別の条件はありますか。
> 2. 制作会社が多数の店舗のために設定し、各店舗さま名義の GitHub アカウントで hosted のアプリを使っていただく形は、商用利用として認められますか。
> 3. 利用者・repo・協力者の数や利用量に上限はありますか。将来の有料化の予定はありますか。
> 4. サービスの大きな変更や終了のとき、どのくらい前に、どの方法で通知されますか。そのとき、協力者の一覧などのデータを持ち出す方法はありますか。
> 5. hosted の GitHub App が求める権限（Administration・Actions の読み書きなど）の用途と、hosted のデータベースに保存される内容（キャッシュ・トークン）の保存期間を教えてください。
> 6. hosted のデータはどの国の、どの事業者の設備に保存されますか。GitHub App のアンインストールや退会の後、データは削除されますか。
> 7. hosted のサービスを運営しているのは個人と法人のどちらですか（法人なら名称）。障害のときの連絡先はどちらですか。
>
> ご多忙のところ恐れ入りますが、よろしくお願いいたします。
> 〔名義・連絡先〕

### English

> Subject: Question about commercial use and limits of Pages CMS (app.pagescms.org)
>
> Hello,
>
> I am [name], and I build websites for small shops (bakeries, cafés, etc.) in Japan.
> We are considering publishing each site from a GitHub repository and a Cloudflare Pages project owned by the shop itself, and having the shop owner update menus and opening hours with app.pagescms.org.
> We read your Terms and Conditions (last updated February 7, 2024) and the documentation, but could not find answers to the following:
>
> 1. Do the Terms apply to the hosted app at app.pagescms.org? Are there separate terms for it?
> 2. Is it acceptable, as commercial use, for an agency to set up Pages CMS for many small shops, with each shop using the hosted app under its own GitHub account?
> 3. Are there any limits on the number of users, repositories, or collaborators, or on usage? Are there plans for paid plans?
> 4. How much notice, and through which channel, do you give before major changes to, or discontinuation of, the hosted service? In that case, is there a way to export data such as the collaborator list?
> 5. What are the hosted GitHub App's permissions (e.g. Administration and Actions read/write) used for, and how long is data in the hosted database (cache, tokens) kept?
> 6. In which country, and with which provider, is hosted data stored? Is the data deleted after the GitHub App is uninstalled or a user leaves?
> 7. Is the hosted service operated by an individual or a company (if a company, under what name)? Where should we report outages?
>
> Thank you for building Pages CMS.
> [name / contact]
