# 顧客所有CMS＋店舗デモ採用プラン — 技術方針案（Issue #312）

作成日: 2026-11-21 / 方針更新: 2026-11-23 / 状態: **Pages CMSを第一候補にした検証方針。未実装・未商用公開**。

## 0. オーナーが決めた販売方針
- 店舗ごとに専用デモサイトを営業前に生成し、デザインをそのまま採用する場合は **制作費50,000円** とする。
- **メニュー掲載＋顧客自身によるメニュー更新が標準必須。** 営業時間、定休日、臨時休業、お知らせも顧客が変更可能にする。
- Second Rootは日々の更新業務・常時CMSサーバーの運営をなるべく持たない。
- ドメイン・CMS・ホスティングは原則顧客アカウント。外部サービスの継続費は顧客が直接負担。
- デモの独創的なレイアウトは維持し、共通化するのは**商品データモデル、データ取得契約、リリース/納品手順**。業種共通の画面テンプレートを強制しない。
- 追加ページ、独自予約・EC・デザイン全面改変は基本価格の対象外。
- **注意**: 現在の公開向け `Pricing.tsx` / `Faq.tsx` は50,000円**税別（55,000円税込）・CMSなし・別プラン198,000円CMS・初年度Second Root公開環境込み**。この仕様と新方針は矛盾する。税・実績掲載条件・契約条件の整合が取れるまで本番表記は変更しない。

## 1. 比較（2026-11-23 方針更新、実機未検証）
| 基盤 | 顧客の使いやすさ | Second Rootの保守 | 利用条件・コスト | 初期評価 |
| --- | --- | --- | --- | --- |
| **Pages CMS hosted + 顧客所有GitHub + Cloudflare Pages** | GitHubに保存したメニュー/写真をWeb UI編集。店主のGitHubログインで操作可能 | CMS SaaSは外部、データは顧客repo。編集のサポート/障害・サービス終了の移行は残る | 現在Hosted無料・MITライセンス。本番では提供規約・可用性・導入規模の再確認が必要 | **第一候補（今回の選択）** |
| microCMS Hobby + 静的サイト | 日本語UIで商品更新を想定 | CMS本体は外部管理。サイト連携・障害対応は残る | Hobby月0円、3名・5 API、20GB/月転送超過でAPI停止。商用利用可。無料枠は変更・制限あり | 代替候補 |
| Sanity Free + 静的サイト | Studio設計に開発工数、UIを作り込める | Studioスキーマとバージョンの保守が増える恐れ | Free枠あり。API・データ上限あり | 第二候補 |
| Brot Yanagi由来のSupabase CMS | 既存機能を再利用可能かも | Auth/RLS/DB/Storageと障害対応を当方が持ちやすい | 顧客ごと分離すれば費用・設定の検証が必要 | 比較対象。現物未検証 |
| GitHubファイル直編集 | 外部CMS契約不要 | 更新ごとの操作サポートが必要になりやすい | データを編集できても店舗が簡単に使えるとは限らない | 非推奨 |

- **Pages CMS 公式: https://pagescms.org/ / https://pagescms.org/docs/quick-start/ / https://pagescms.org/docs/configuration/ / https://pagescms.org/docs/configuration/collaborators/ / https://pagescms.org/terms/**
- microCMS公式料金: https://microcms.io/pricing
- 商用利用可の公式FAQ: https://help.microcms.io/ja/knowledge/free-plan-for-corporation
- Webhook連携: https://document.microcms.io/manual/webhook-setting
- Sanity: https://www.sanity.io/pricing
- Cloudflare Pages Free枠（500 builds/月）: https://developers.cloudflare.com/pages/platform/limits/
- Cloudflare Pages Deploy Hook: https://developers.cloudflare.com/pages/configuration/deploy-hooks/

**未確認**: 小規模店におけるCMSの学習負担、無料枠の実使用量、納品時のアカウント移管フロー、無料プランのCSV出力制限、Next.js 16を含む実サイトの静的export適合。これらはPoCで確かめる。

## 2. Pages CMS第一候補の構成（2026-11-23、PoC合格前の暫定選定）
```text
営業前: Second Rootが店舗固有デザインの非公式デモを生成（CMSの本番接続なし）
                         |
成約後: 店舗が事実・価格・画像の利用を確認
                         |
       顧客名義GitHub repo（コードと商品情報・写真）
               ^                        |
               | Pages CMSが直接変更     | push（コミット）
       顧客がPages CMS hostedで編集      v
       （GitHubでログイン）       顧客名義Cloudflare Pages
                                       |
                            構築成功後に独自ドメインへ公開
```
- **最初の検証は店主1人で編集**。店主はGitHubとCloudflareの所有者となり、Pages CMS hosted（https://app.pagescms.org/）にはGitHubでログインする。**Decap/Turbo契約は不要**。Pages CMSは別サイトであり、店舗ドメインの `/admin` にネイティブなCMS画面を提供するとは言わない（必要なら外部管理画面への導線のみ）。
- 顧客はGitHub/Cloudflareの初回登録・規約同意・本人認証・Pages CMS GitHub Appの**対象repoを限定した導入承認**等を自ら実施。Second Rootは本人のパスワードや二要素コードを預からず、最小権限の招待で技術設定を代行する。納品後は招待権限を撤去する。
- Pages CMSの設定は各顧客repoのルートの `.pages.yml`（`media`, `content` / `collection` / `file`）で管理。商品45件・分類・価格・売切表示（手動）・営業時間・臨時休業・お知らせを編集可能にし、**サイトの構図・デザインは店舗固有のまま**。商品データのみ共通契約/adapterで扱う。
- Pages CMSは既存のGitファイルを編集する層であり、専用のメニューDB/APIを納品後にSecond Rootが持つ必要はない。コンテンツと写真の原本は顧客repo。ただしHostedの認証・協力者招待・キャッシュなどにはPages CMS側のサービス/DBが必要なので、**サイトデータが残ることと管理画面の無停止稼働を混同しない**。
- Pages CMSのHosted利用は公式サイトで現時点無料・MITの本体は商用利用可能。ただしHostedの利用規約・継続・料金変更・大規模な商用顧客への導入の許容は**未保証**。多数店舗への標準導入前に現行規約を記録し、必要に応じて提供元へ確認する。
- Pages CMSの `collaborators` は編集者がGitHubアカウントを持たない場合の**メール招待機能**だが、招待管理と設定編集はGitHub identityを持つユーザーに限られる。今回は1人（owner）のGitHubログインを基本とし、メール招待は将来拡張扱い。移行時は協力者リストはrepo内の`.pages.yml`だけでは復元しない。
- GitHubにコミットが発生するとCloudflare PagesのGit連携でビルドされる。**microCMS案のWebhook → Deploy Hookではない**。更新反映の遅延と失敗時の確認手順を検証し、最後の成功デプロイを維持する。緊急休業・売切れは手動更新＋ビルド反映遅延があるため、即時性を保証しない。
- 画像はrepo内で管理。アップロード容量、最適化・向き・ファイル名・著作権、Git履歴増加、GitHubの上限、無料のビルド回数をPoCで確認する。APIキー/管理秘密情報は公開JSやGitHubファイルに置かない。アクセス許可するGitHub Appの権限範囲を顧客に説明する。
- Pages CMSが将来停止しても、**公開済みの静的WebサイトとGitHub原本が残る可能性が高い**が、編集には別CMS接続または別手段が必要。納品時に移行手順・GitHubデータ保全・CMSが止まった場合の案内を渡す。
- 顧客はサービス・ドメインの更新料金を直接負担。Second Rootの追加保守契約を必須にしない。一方でサイトの不具合・脆弱性・無料枠改定等に対する恒久的無償対応は約束しない。契約・保証範囲を別途確定する。
- Second Root本体（Next.js 16 + サーバー機能）を無理にstatic exportしない。**納品用の独立した顧客サイト**について静的配信が可能か検証し、難しければ実装方法を再評価。Vercel Hobbyでの商用公開は避ける。
- 外部アカウント作成・実サービスのGitHub App許可・課金・DNS・顧客データ投入・Productionは**別途人間承認**。最初は架空店舗とローカルmockで検証する。

## 3. メニューの共通データ契約
最低限のエンティティ（各店舗は独立サービス/スキーマ。実店舗情報を設計資料・テストへ持ち込まない）:

| エンティティ | フィールド（概念） |
| --- | --- |
| menu_item | id, name, categoryId, description, priceAmount, priceDisplay, image, imageAlt, visible, displayOrder, soldOut, updatedAt |
| category | id, name, displayOrder, visible |
| shop_info | name, address, phone, instagramUrl, reservationUrl, timezone, hours, specialClosures |
| announcement | id, title, body, publishedAt, visible |

- 価格は税込/税別・「〜」などの表示条件を顧客に確認。推測で入れない。
- メニューの非公開/削除を混同しない。編集できる範囲は商品・店舗情報・お知らせであり、CSS/レイアウトは含めない。
- デモ時の未確認事実は実データへ自動移行しない。顧客承認済みの情報だけ本番のCMSに登録する。
- ネット注文・決済・POS連携・リアルタイム在庫同期は対象外。soldOutは顧客の**手動**表示としてのみ扱う。
- カフェのサイズ・美容の施術時間など業種別フィールドは拡張可能にするが、基本スキーマに全店共通の重い要件を強制しない。

## 4. 実装に進むための小さな検証
1. **静的配信適合**: Next.jsで複数レイアウトに対して静的出力を再現できるか。生成画像・フォント・route handler・next/image・動きのあるUIを確認。
2. **架空店舗デモ**: 45商品、3分類、商品画像、営業時間、臨時休業、お知らせ1件を用意。実店舗の連絡先・写真・個人情報は使わない。
3. **操作テスト（Pages CMS想定）**: 非技術者の店舗担当役が商品追加/価格変更/画像差替/非公開/順序変更/時間変更/休業通知を行い、Second Rootの操作なしで公開内容が変わる。
4. **配信テスト**: Pages CMSのGitコミット→Cloudflare Pages自動ビルド→正常公開。連続更新と再ビルド失敗時にデータ損失・誤公開がない。Freeビルド上限を超えた時の影響も記録。
5. **品質検証**: PC 1440 / SP 390で表示、レイアウト固有性、メニュー使いやすさ、価格表示、リンク、SEO、アクセシビリティを確認。
6. **所有権・移管テスト**: Second Rootの権限を外した状態で顧客操作と公開継続が可能。コード利用権・外部アカウント・CMSデータ・DNSの引継ぎ資料を作る。
7. **採算**: 契約後セットアップ/顧客支援時間、外部費用、無料枠超過時、保守・障害シナリオを集計。5万円販売の粗利条件を評価。

## 5. 進行上の保護条件
- ISSUE #312の範囲は提案・PoC。営業MVP、IMAGE_FIRST研究、コンテンツ成功例DB、fact/rights/quality gateを変更しない。
- 顧客アカウント作成、外部サービス利用規約への同意、課金、実データ移行、Production・DNS、実送信は別途人間承認。
- 既存の main と develop への無条件マージは禁止。Docs/設計のみ先行し、PoCは別ブランチ/別PR、CI・独立Fresh Reviewを適用する。
- 初期採用可否を未検証のまま「標準CMS搭載」と公式サイトに記載しない。
