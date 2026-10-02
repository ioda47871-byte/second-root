# Meta Business Discovery: 調査記録（DEV-028 取得経路）

- **調べた日:** 2026-09-29
- **制約:** この session のネットワーク方針で `developers.facebook.com` と `www.postman.com` への接続が拒否された
  - Meta の原文は直接読めていない
  - 下の「公式抜粋」は、検索対象を developers.facebook.com に絞った検索結果の抜粋
  - 「前回調査」は `.ai/research/meta-instagram-messaging-2026-09-27.md`（公式の Markdown 版を直接読んだもの）
  - 原文と照合していないものは **未確認** と書く

## 確認できたこと

| 項目 | 内容 | 出どころ |
|---|---|---|
| 利用可否 | Business Discovery は現行の Instagram Platform にある。IG User の `business_discovery` field（例: `GET /{ig-user-id}?fields=business_discovery.username(<name>){followers_count,media_count,biography,website,username}`） | 公式抜粋 |
| API 系統 | **Instagram API with Facebook Login だけ**。Instagram API with Instagram Login では使えない | 公式抜粋 |
| host | `graph.facebook.com` | 公式抜粋 |
| 呼ぶ側 | Instagram のプロアカウント（Business / Creator）で、Facebook ページにリンクしていること。ページで管理者相当の作業ができる人の token | 公式抜粋 |
| 相手側 | Business / Creator のプロアカウントだけ。個人アカウントのデータは返らない | 公式抜粋 |
| media | field expansion で相手の media の公開項目を取れる。`GET /{media-id}` の直接取得はできない | 公式抜粋 |
| media_url の制限 | ダウンロードを無効にしたリールでは、Business Discovery でも `media_url` が返らない | 公式抜粋 |
| rate limit | Business Discovery と Hashtag Search は Platform Rate Limiting の対象（Instagram の BUC rate limit ではない） | 公式抜粋 |
| Access level | 自分が所有・管理するアカウントだけに使うアプリは Standard Access。Advanced Access には App Review と Business Verification が要る | 公式抜粋 + 前回調査 |
| App の分離 | 「Your app can either use Facebook Login or Instagram Login but not both」 | 前回調査（公式原文） |
| 取れない相手のエラー | code 110 / subcode 2207013「Cannot find User」 | 開発者フォーラム（公式リファレンスではない） |

## 未確認

- permissions の正確な組み合わせ
  - 想定: `instagram_basic`、`pages_show_list` / `pages_read_engagement`、場合により `business_management`
  - Business Discovery の reference ページの Requirements 欄で要確認
- **Standard Access のまま、所有していない他社の Business / Creator を Business Discovery で読めるか**
  - Standard Access の制限は「App を使う人」（役割のある人）に対するもので、読む相手ではないと読める
  - 明記は見ていない。meta-check で実際に試して確かめる
- Development mode のまま、App の管理者の token で呼べるか（役割のある人は開発モードでも使える、という一般則からは呼べる見込み）
- 相手側で取れる項目のうち、`name`・`follows_count`・`profile_picture_url`・media の `caption`・`permalink`・`timestamp`・`thumbnail_url` の有無
- token
  - 長期 User token の有効期限（60 日の見込み）
  - Page token を無期限にできる条件
  - System User token が使えるか
- 料金: Graph API に呼び出し課金は無い理解だが、公式の明記は確認できていない
- 現在の Graph API version（repo の Messaging は `v26.0` を使っている。meta-check も既定は `v26.0` で、`--api-version` で変えられる）

## Platform Terms / data use — BLOCKED

- 公式抜粋で確認できたこと
  - Platform Data の処理で禁止されている例: 差別、適格性の判断（住宅・雇用・保険・教育・与信・行政給付・在留資格）、監視や監視のための道具の提供
  - 共有は Terms・法令・関連 policy に従う場合に限る
- **確認できなかったこと**: 取得した他社の公開情報・media を「営業デモのアートディレクションの参考」に一時的に使うことの可否
  - 明示の許可も禁止も見ていない
  - 目的の制限・保持・削除・privacy policy への記載など、該当しうる条項の原文を読めていない
- **判断: BLOCKED**
  - PoC（meta-check）は「取れるか」だけを確かめる。値は表示せず、何も保存しない
  - worker への組み込み（デザイン材料としての利用）は、人間が Platform Terms / Developer Policies の原文を確認して決める
  - 実走の 1 回のテストも、人間の判断で行う

## 出どころ

- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery/
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/
- https://developers.facebook.com/docs/instagram-platform/overview/
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- https://developers.facebook.com/terms/dfc_platform_terms/
- https://developers.facebook.com/community/threads/310930884925810/
