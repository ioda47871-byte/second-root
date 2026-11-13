# Second Root 営業MVP｜2026-11-13 セッション引き継ぎ

> **記録の復元**: 先行セッションでは GitHub への記録のみ push が権限で拒否された。詳細の正本は [Issue #263 の引き継ぎコメント](https://github.com/ioda47871-byte/second-root/issues/263#issuecomment-6859209435)。本ファイルは公開リポジトリで扱える範囲に限定した再開用の写し。**店舗固有の事実・画像・デモ・連絡先・非公開データをここへ追加しない。**

## 1. 現在地
- develop の引き継ぎ時点の merge commit: `360a04d97c7c1d2d09e1177c2e2f9be50a64324c` (#273)。
- #259–#273 の営業MVP関連PRはマージ済み。引き継ぎ時点で関連する進行中PR・Draft PRは無し。各PRは CI 11/11 と独立レビュー C/H/M=0 を満たしたと記録されている。
- 最優先は **Issue #263：実店舗1件の高品質な完成デモを作り、管理画面で品質・文章承認から手動送信まで通す**。
- 本番/Stagingには新規migration・bucket・env・DNS・共有スイッチ・送信を一切適用していない。ローカルでの実装・E2E合格と、営業開始可能であることを混同しない。

## 2. 主要マージ済みPR
| PR | DEV | 内容 |
| --- | --- | --- |
| #259 | 199a | 文章品質監査スキーマ/判定 |
| #260 | 199f | 新しい文章プロンプト案（未有効化） |
| #261 | 199d | copy.jsonを版パッケージへ同梱 |
| #262 | 199e | 文章審査保存・オーナー承認・送信ガード |
| #264 | 199b | compレーンの文章ゲート・管理画面の文章確認 |
| #265 | 196p/q | 文章の出典分類・構造比較記録 |
| #266 | 263a | trusted factsと架空店舗によるv2デモ |
| #267 | 196g | 公開URLと分離origin、承認済み版の固定表示 |
| #268 | 263e | ローカルの営業E2Eと運用runbook |
| #269 | 263f | facts保存・送信時の再照合 |
| #270 | 263g | DB側テスト宛先ブロック |
| #271 | 263h | 確認済みfactsからデモ内容作成 |
| #272 | 263i | 管理画面のv2版インポート（begin/put/finalize） |
| #273 | 263j | 都道府県が異なる住所を同一店舗と誤認しない修正 |

## 3. 実装済みだが、現時点で本番未有効
- 信頼できるfactsの追記専用保存とオーナー確認、送信前の再検証。
- 写真のないデモ版パッケージのローカル作成・管理画面取り込み・品質7項目/文章の承認。
- 送信承認時の版固定、別originのsandbox iframeで期限付き閲覧（署名検証・hash・revoke・noindex等を守る）。
- メールはメールアプリへ引き渡す。Instagram初回DMは文章コピー＋画面を開き、オーナーが手動送信する。送信済み・返信・商談の履歴。
- 架空店舗でのローカルE2E（メール・Instagram）。これは実送信ではない。

## 4. 未完了・決定待ち
- **最重要**：対象の実店舗をオーナーが選び、営業不可・既存顧客でないことを確認し、掲載する情報を一つずつ検証する。最初の実店舗の全ページPC1440/SP390デザイン・監査・承認は未実施。
- 本番の8 migration、private Storage bucket、Vercel環境変数、別origin/DNS、DB共有スイッチ、develop→mainリリースと初回送信はすべて別途オーナー承認。runbook Part Bに従い1段ずつ。
- 既知の非ブロッカー: #272の掃除/旗off時405、#273の稀な住所文字列・順序テスト、フォローアップ送信のDB guard、管理者プレビューのartifact origin移行 (DEV-196t)、試用後のstagingファイル整理。
- オーナー判断待ち: stagingの `authenticated_can_read`、不合格文章の再開可否、構造所見の自動計算。MVPを止める理由にはしない。
- 4業種研究（DEV-199c）、新しいコピー規則の本番有効化（DEV-199f）は後回し。写真のない版を優先。実画像生成・有料APIは別承認。

## 5. まず次に行うこと
1. 最新developとIssue #263および `docs/operations/sales-mvp-runbook.md`、`docs/operations/real-shop-demo-workflow.md` を照合。
2. 店舗選定後、確認済みのfacts packを**リポジトリ外またはignored `.local-shops/`** に作る。推測の営業時間/商品/サービス/口コミは書かない。PR・Issueの本文にも店舗個別のデータを書かない。
3. 成功例・デザイン方針から写真なしの独創的な全ページHTML/CSSとcopy.jsonを作り、`comp-lane`・`comp-copy`、PC1440/SP390全ページの目視で品質を確認。
4. v2 packageを作り、ローカルのfacts登録→版のimport→管理画面品質/文章承認→送信画面→独立ブラウザで固定版を確認。外部送信はしない。
5. オーナーに全ページ画像と監査結果を提示。承認後、本番反映の個別承認を求める。

## 6. 安全境界
- Code・tests・ローカルDB・PR作成・CI・Fresh Review（C/H/M=0）は承認済みの範囲で進める。
- Staging/Production、migrations、storage、環境変数、DNS/Vercel設定、サービス操作、実送信、Codex/画像生成/有料APIは無断で実行しない。
- 既存のReactデモを壊さない、別版へのfallback禁止、DNC/重複/頻度ガードを緩めない。写真付き版を共有しない。SR-001「輪」の内部資料を実店舗デモに使わない。
- 高品質なデモの**実物**が完成し、相手が共有URLで承認版を見られるまで「営業MVP完成」としない。

## 7. 参照先と再開
- [Issue #263](https://github.com/ioda47871-byte/second-root/issues/263) と [引き継ぎコメント](https://github.com/ioda47871-byte/second-root/issues/263#issuecomment-6859209435)
- `docs/operations/sales-mvp-runbook.md`（A：ローカルE2E、B：本番でのオーナー承認・rollback）
- `docs/operations/real-shop-demo-workflow.md`（facts → 写真なしcomp → copy監査 → package → import → 承認）
- `.ai/tasks.json`・`.ai/reviews/DEV-263*.md`
- 最新developを取得し、`npm ci`、ローカルSupabase、unit/integration/build/必要なE2Eを確認。PRはfeature branch→Draft→CI＋独立Review→条件を満たしてから統合。
