# DEV-139 P0-2c — 営業候補の確認済みfacts → デザイン生成の読取入口

## 目的

既存の候補探索・ingest、重複排除、DNC、`sales_demo_facts_packs`保存を再実装しない。営業候補の`prospect_id`から**オーナー登録済みの事実原本だけ**を、既存のデザイン生成・文章審査へ渡せる読取契約を追加する。

実装: `lib/sales/b-route/verified-generation-facts.ts::loadVerifiedGenerationFacts(client, prospectId)`。

- 入力は既存のサインイン済み管理者Supabase clientとUUID。**service role・環境変数・登録の代理操作を作らない**。DB RLSと既存認証を維持。
- `sales_prospects`で候補の存在と`do_not_contact=false`を確認。未知・DNCは停止。
- `sales_demos`の存在・本人prospect・非無効化状態を確認。
- 既存`loadCurrentFactsPack`から最新の登録済みfactsを読む。空・DB不達なら停止。
- packのSHA256・shop ID・demo IDを登録記録と照合し、既存`assertDemoContentFromFacts`を使って同じbytesから導出されたデモ内容であることを再検証。
- 候補登録の店名・住所がpackと一致しない場合は無人生成せず`PROSPECT_FACTS_IDENTITY_HOLD`。管理画面で例外承認していた場合も再確認が必要（誤店舗への大量制作を防ぐ側の条件）。
- 成功時だけ`factsBytes`、`factsSha256`、prospect ID、demo ID、facts pack ID、shop IDを返す。**事実が本当に正しいことをコードが独立検証したとは主張しない**。その根拠は既存のオーナー登録・出典確認手順に依存。

既存のデザイン生成入力は`factsBytes`のまま使う。packの解析→作り直しをしてバイトを変えないため、PR #279のプロンプト、`copy.json`、PR #278のv2 packageまで**同じSHAを通す設計**にする。DB操作、公開、送信、モデル呼び出しは一切含まない。

## テスト

`tests/unit/sales/verified-generation-facts.test.ts`：既存clientを模擬して、正常なfacts読込、DNCで早期停止、未登録、SHA不一致、別demoとの混線、デモの事実変更、候補名/住所の不一致、無効化/DB障害を検証する。

この単体テストだけではローカルSupabase/RLSの統合は未検証。実行時は必ず管理者権限・行ポリシーが正しく働くことも確認する。

## 次の小PR

1. 管理者の**明示的起動または承認済みのローカル処理**から読取入口を呼び、確認済みfacts SHAの`art_direction_set_v0`を入力として準備する。現時点で候補が存在するだけで実Codexを自動起動してはならない。
2. PR #279の生成指示文出力 → 既存承認付きPhase2f生成器 → 生成HTML/CSS → 自動copy台帳 → PR #278の品質審査・v2 package。
3. 同一facts SHAで`import-local.ts --facts-from-store`と既存管理画面の承認待ちに到達することを、架空店のローカルE2Eで証明。次にパン屋・カフェ・焼菓子店の**実際の完成カンプ**を個別評価する。構造の異なるprompt SHAだけでは完成や品質合格ではない。

Harissyの個別修正・実店舗の非公開情報のGitHub掲載・Production/Staging/WSL/実Codex/画像生成・送信は引き続き停止。
