# 顧客所有CMS＋店舗デモ採用プラン — 技術方針案（Issue #312）

作成日: 2026-11-21 / 状態: **調査・設計案。未実装・未商用公開**。

## 0. オーナーが決めた販売方針
- 店舗ごとに専用デモサイトを営業前に生成し、デザインをそのまま採用する場合は **制作費50,000円** とする。
- **メニュー掲載＋顧客自身によるメニュー更新が標準必須。** 営業時間、定休日、臨時休業、お知らせも顧客が変更可能にする。
- Second Rootは日々の更新業務・常時CMSサーバーの運営をなるべく持たない。
- ドメイン・CMS・ホスティングは原則顧客アカウント。外部サービスの継続費は顧客が直接負担。
- デモの独創的なレイアウトは維持し、共通化するのは**商品データモデル、データ取得契約、リリース/納品手順**。業種共通の画面テンプレートを強制しない。
- 追加ページ、独自予約・EC・デザイン全面改変は基本価格の対象外。
- **注意**: 現在の公開向け `Pricing.tsx` / `Faq.tsx` は50,000円**税別（55,000円税込）・CMSなし・別プラン198,000円CMS・初年度Second Root公開環境込み**。この仕様と新方針は矛盾する。税・実績掲載条件・契約条件の整合が取れるまで本番表記は変更しない。

## 1. 比較（2026-11-21時点の暫定）
| 基盤 | 顧客の使いやすさ | Second Rootの保守 | 利用条件・コスト | 初期評価 |
| --- | --- | --- | --- | --- |
| microCMS Hobby + 静的サイト | 日本語UIで商品更新を想定 | CMS本体は外部管理。サイト連携・障害対応は残る | Hobby月0円、3名・5 API、20GB/月転送超過でAPI停止。商用利用可。無料枠は変更・制限あり | **第一候補** |
| Sanity Free + 静的サイト | Studio設計に開発工数、UIを作り込める | Studioスキーマとバージョンの保守が増える恐れ | Free枠あり。API・データ上限あり | 第二候補 |
| Brot Yanagi由来のSupabase CMS | 既存機能を再利用可能かも | Auth/RLS/DB/Storageと障害対応を当方が持ちやすい | 顧客ごと分離すれば費用・設定の検証が必要 | 比較対象。現物未検証 |
| GitHubファイル直編集 | 外部CMS契約不要 | 更新ごとの操作サポートが必要になりやすい | データを編集できても店舗が簡単に使えるとは限らない | 非推奨 |

- microCMS公式料金: https://microcms.io/pricing
- 商用利用可の公式FAQ: https://help.microcms.io/ja/knowledge/free-plan-for-corporation
- Webhook連携: https://document.microcms.io/manual/webhook-setting
- Sanity: https://www.sanity.io/pricing
- Cloudflare Pages Free枠（500 builds/月）: https://developers.cloudflare.com/pages/platform/limits/
- Cloudflare Pages Deploy Hook: https://developers.cloudflare.com/pages/configuration/deploy-hooks/

**未確認**: 小規模店におけるCMSの学習負担、無料枠の実使用量、納品時のアカウント移管フロー、無料プランのCSV出力制限、Next.js 16を含む実サイトの静的export適合。これらはPoCで確かめる。

## 2. 第一候補の構成（正式採用前）
```text
営業前: Second Rootの自動デザイン制作（店舗固有のデモ）
                   |
成約後: 商品・営業時間・お知らせの正式情報を顧客確認
                   |
           顧客名義 microCMS
              商品・営業時間・お知らせ
                   |
           CMS 公開 Webhook
                   |
       顧客名義 Cloudflare Pages Deploy Hook
                   |
    顧客名義のソースrepoから静的サイト再ビルド
                   |
       顧客の独自ドメインに公開
```
- デザインをCMSへ入れず、サイト実装へ残す。CMSが変わっても表示コンポーネントを保てるadapterを挟む。
- 「保存」ではなく「公開/非公開」の操作がWebサイト反映の起点。Webhookが届いてもビルドが失敗した場合は、最後の正常公開サイトを維持する。
- 無制限の即時反映を約束しない。デプロイ待ち時間と失敗時の確認手順を顧客用マニュアルに明記する。
- CMSの読み取り用APIキーをブラウザへ埋め込まない。ビルド環境だけでデータを取得して静的HTML/JSONを生成する。Webhookの秘密URLはCMS設定に限定しGitHub・公開JS・顧客向けマニュアルへ記録しない。
- ドメイン/Cloudflare/CMS/リポジトリを顧客が管理。初期設定時は顧客自身が規約に同意し、Second Rootの作業権限は納品後に削除または縮小できる状態にする。
- 画像の直接配信でCMS転送枠を消耗する可能性があるため、静的ビルド時の画像取得と実際の配信元を別途試験する。
- Vercel Hobbyは商用利用を禁止しているため、顧客の商用サイトをHobbyプランで公開しない。Next.js固有機能が静的化不可能なら商用可能な別構成を再評価する。

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
3. **操作テスト**: 非技術者の店舗担当役が商品追加/価格変更/画像差替/非公開/順序変更/時間変更/休業通知を行い、Second Rootの操作なしで公開内容が変わる。
4. **配信テスト**: CMSの公開Webhook→静的再ビルド→正常公開。連続更新と再ビルド失敗時にデータ損失・誤公開がない。Freeビルド上限を超えた時の影響も記録。
5. **品質検証**: PC 1440 / SP 390で表示、レイアウト固有性、メニュー使いやすさ、価格表示、リンク、SEO、アクセシビリティを確認。
6. **所有権・移管テスト**: Second Rootの権限を外した状態で顧客操作と公開継続が可能。コード利用権・外部アカウント・CMSデータ・DNSの引継ぎ資料を作る。
7. **採算**: 契約後セットアップ/顧客支援時間、外部費用、無料枠超過時、保守・障害シナリオを集計。5万円販売の粗利条件を評価。

## 5. 進行上の保護条件
- ISSUE #312の範囲は提案・PoC。営業MVP、IMAGE_FIRST研究、コンテンツ成功例DB、fact/rights/quality gateを変更しない。
- 顧客アカウント作成、外部サービス利用規約への同意、課金、実データ移行、Production・DNS、実送信は別途人間承認。
- 既存の main と develop への無条件マージは禁止。Docs/設計のみ先行し、PoCは別ブランチ/別PR、CI・独立Fresh Reviewを適用する。
- 初期採用可否を未検証のまま「標準CMS搭載」と公式サイトに記載しない。
