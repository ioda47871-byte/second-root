# CMS 実環境試験 記録（Issue #380）

架空の店「架空のカーケア工房 そらいろ（SORAIRO）」・合成写真と AI 生成のデザイン画像だけで行う実環境の試験の記録。
実顧客の情報・写真・名前は使っていない。手順は [`cms-live-trial-owner-sheet.md`](cms-live-trial-owner-sheet.md) 付録 A、
対象と権限は [`cms-live-trial-confirmation.md`](cms-live-trial-confirmation.md)。スクリーンショットなどの証跡はオーナーの手元（公開の repo には置かない）。

## 環境

| 項目 | 内容 |
|---|---|
| GitHub | オーナーの個人アカウントが持ち主の試験専用 Organization `sr-cms-trial`、非公開 repo `sr-cms-trial/sr-cms-trial-autocare`（既存の開発環境・実顧客の環境とは分けた。GitHub の規約が無料の個人アカウントを 1 人 1 つに限るため、試験専用の個人アカウントではなく Organization にした） |
| Cloudflare | オーナーの既存アカウントに試験専用の Pages プロジェクト `sr-cms-trial-autocare` を新規作成。既存の 4 プロジェクト・DNS・ドメイン・個人アカウントの GitHub App の範囲と認可は変えていない |
| 公開 URL | https://sr-cms-trial-autocare.pages.dev （無料枠、独自ドメインなし） |
| 構築 | `npm ci && npm run build`、出力 `dist`、`SKIP_DEPENDENCY_INSTALL=1`、Node 22.23.4。本番の自動デプロイ有効、プレビュー無効 |
| GitHub App | Pages CMS と Cloudflare Workers and Pages を `sr-cms-trial` に、試験用 repo だけを選んで導入（事前に提示した権限をオーナーが試験専用の環境に限って承認） |

## 2026-11-28 の結果

| 項目 | 結果 | 記録 |
|---|---|---|
| 初回の公開 | **成功** | commit 46c7b94、deployment 2a339e14 |
| 公開前の確認（実データでの構築） | **合格** | 公開されるのは表示中の施工実績の写真とデザイン画像だけ。非公開の施工実績とその画像、どこからも参照されない画像は公開されない |
| 公開サイトの画像の実測 | **合格** | 25 枚すべて取得・判定でき、EXIF・GPS は 0 件。AI 生成のデザイン画像には「AI生成・架空の施工イメージ」の表示 |
| 既存の施工実績の編集（初回） | **不合格 → 修正** | 「Please fix the errors before saving.」。原因: 非表示の id 欄（uuid 型）を Pages CMS が保存時に検証するのに、納品時の id が `job-1` 形式だった。PR #391 で UUID に置き換え、移行の道具を追加 |
| UUID 修正の反映 | **成功** | commit 7090883、deployment f4db4a4f（自動デプロイ） |
| **CMS から施工実績の説明を編集 → GitHub に保存 → Cloudflare が自動で公開 → サイトに反映** | **成功** | 「架空車 タイプ1」の説明を「CMS自動更新テスト001：ガラスコーティング施工が完了しました。」に変更。保存先 `content/works/job-1.json`（ファイル名は保たれ、重複ファイルなし、施工実績のファイルは計 11 件）。commit 274c2fb、deployment 8e60bafb。GitHub・Cloudflare での手作業のデプロイなし。公開サイトでの反映をオーナーが目視で確認し、Claude も公開頁の本文で確認 |
| 反映までの時間 | 未計測 | 次の試験で `live-trial-measure.ts wait` で測る |
| **iPhone 実機から約 5MB の JPEG をアップロード（STEP 9）** | **不合格** | iPhone からのログインと施工実績の新規登録画面までは成功。合成の試験画像（約 5MB、4032×3024）のアップロードで「Failed to upload file: 413」。Pages CMS の公式 Issue #284（https://github.com/hunvreus/pagescms/issues/284 ）で開発者が hosted の置き場（Vercel）の要求の大きさの上限を原因と認めている（オーナー確認、2026-11-28）。構築時の圧縮はアップロードの後なので解決にならない。保存・公開は起きていない（公開サイトへの影響なし。待ち受けの計測は 1 時間で打ち切り、文言は現れず） |

技術的な実現性: 上の範囲（既存の施工実績の文章の編集から公開まで）は**実環境で確認済み**。スマートフォンからの大きな写真の登録は**hosted の Pages CMS では不可**（413）。
商用提供の可否: **未判定**（Pages CMS の hosted の商用利用の条件は問い合わせ前。文案は [`pages-cms-hosted-terms.md`](pages-cms-hosted-terms.md) §6、未送信）。

## 判明した制約（2026-11-28）

hosted の Pages CMS では、iPhone で撮ったままの大きな写真をそのまま選んで登録できない（上限の正確な値は調査中）。
顧客に毎回手で縮めてもらう方式は恒久的な解決にしない（オーナー）。アップロードの前にブラウザで自動変換・圧縮する方式（Sveltia CMS など）、self-host、microCMS を比較する（[`cms-upload-limit-options.md`](cms-upload-limit-options.md)、作成中）。

## 残りの確認（未検証）

施工実績の追加・削除、複数写真、施工前・施工後の写真、スマートフォンからの更新、4〜6MB の JPEG、写真の自動最適化と GPS（公開用と GitHub 上の原本を分ける）、反映までの時間、顧客役の権限管理（招待・削除・非認可の拒否）、構築の失敗で旧サイトが残ること、正常状態への復旧。

## パン屋・カフェの既知の問題と修正計画（未着手）

PR #391 の検証（Pages CMS の保存時の検証の再現）で見つかった。どちらも試験の対象外で、出力は固定の試験で守られているため変えていない。

| 問題 | 影響 | 修正の案 |
|---|---|---|
| 試験データ全体で、メニュー（106 / 104 件）・カテゴリ（36 / 36）・お知らせ（13 / 13）の非表示の id が UUID でない | 納品時に登録済みの項目を CMS で保存できない（自動車施工店と同じ） | 固定の名前空間の UUIDv5 に置き換える。カテゴリはメニューの項目から参照されているので、参照も同じ対応で書き換える移行にする（`migrate-ids` を拡張し、参照の書き換えと一致の確認を加える） |
| 試験データ全体で、メニューの `imageKind` の値 `customer_cms` / `shop_provided`（20 / 19 件）が `.pages.yml` の選択肢（generated / shop）に無い | CMS で「Invalid option」になり保存できない | 選択肢と内容の型を合わせる（写真の区分を CMS に見せるかどうかを含めて決める。自動車施工店は写真の区分を CMS に出さず、店の写真はファイルの中身で判定している） |
| 出力の固定（ハッシュ）の更新 | 上を直すと固定の値が変わる | 意図した変更として固定の値を更新し、変わった理由を記録する |

着手の条件: オーナーの判断（今の試験・11/30 の打ち合わせを妨げない時期）。
