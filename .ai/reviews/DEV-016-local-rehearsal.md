# DEV-016 代替: ローカル live rehearsal（2026-09-27）

Staging（HUMAN-004）が未準備のため、Operational Claude の run prompt（`ops/sales-agent/RUN_PROMPT.md`）を
**ローカルの ingest API** に対して実行した。Web 調査は実際の公開 Web で行い、提出先はローカル Supabase のみ。
店舗への連絡・送信は一切なし。token はローカル専用の使い捨て値。店舗名はこの記録では key に置き換える。

## 手順と結果

| 段階 | 内容 | 結果 |
|---|---|---|
| session A | `status`（run なし）→ `start` → 実 Web 調査 → `checkpoint(discovered)` 4 件 → **意図的に終了** | 200。最後の `status` は `nextAction: verify`、`run.discovered` に 4 stub |
| session B（記憶なし・別 session） | `status`（runId なし）→ 中断した run と stub を取得 → 4 件を verify → `checkpoint(verified)` 2 件 → `persist` | `completed`、c01・c04 が `outreach_ready` |
| 冪等性 | 完了後に同じ `persist` を再送 | 200、`replayed: true`、同じ prospectId、重複なし |
| fail-closed | c02: 「問い合わせは電話・来店のみ」の記載（又聞き）→ 提出せず。c03: 公式サイト判定が曖昧（自社ネットショップ）→ 提出せず。c04: 営業時間が出典間で食い違い → その事実を入れず | 出典の不確かな候補・事実は `outreach_ready` にならなかった |
| discover 時の除外 | 公式サイト + Instagram + 公開メールなし（2 件）、名古屋市外（2 件、検索要約が誤り） | 提出せず |

- 除外理由・事実の出典は session のレポートに記録（営業文に URL・メール・電話なし、件名 null（Instagram））。
- 不審な指示を含むページはなかった。

## rehearsal で見つかった問題と対応（PR: feature/dev-016-rehearsal-fixes）

| 問題 | 対応 |
|---|---|
| 完了後の `status`（runId なし）が `null` を返し、同じ日に 2 回目の run を始められた | サーバー: 実行中の run がなければ今日（JST）の run を返す（migration 000800、integration test）。prompt: `none` / `start_new_run` なら新しい run を始めない |
| Instagram がログインなしで読めない（429）場合の確認方法が不明 | prompt: リンク元ページで handle を確認、読めないプロフィールを出典にしない、読めないことだけでは除外しない |
| 自社ネットショップ（BASE 等）が公式サイトか不明 | prompt: 店舗専用 URL のサイト / ネットショップは公式サイト。大型モール内のページ・SNS・地図サイトは非公式（サーバーの判定と一致） |
| 又聞きの「DM 不可」等 | prompt: 除外（fail-closed） |
| stub と出典で店名表記が違う / 出典の食い違い | prompt: verified は出典の表記、食い違う事実は入れない |
| 検索の AI 要約の誤り（県名） | prompt: 住所は実際のページで確認、要約を出典にしない |
| 業種の境界・UUID の作り方・中断時のレポート・応答の `candidates` / `replayed` | prompt に明記 |

## 未確認（Staging で確認が必要）

- Claude Cloud の scheduled job（Routine）としての起動・環境変数・ネットワーク制限下での動作
- Vercel 上の ingest API（本番相当の設定）への到達と 24 時間期限・lease の実時間での挙動
