# Instagram 返信後の公式 Messaging API 連携（後続機能 DEV-020〜DEV-024）

> 2026-09-27 に人間が明示的に承認した scope extension。MVP（DEV-001〜DEV-019）を優先し、その後に実装する。
> **Meta の API 仕様（権限名・Graph API version・Webhook の field / event 名・署名方式・送信 endpoint・送信可能期間）は、
> 実装時点の Meta 公式ドキュメントで必ず再確認して決める。** この文書に書く仕様上の具体値は「想定」であり、
> 実装 PR で公式ドキュメントの URL と確認日を `docs/INSTAGRAM_MESSAGING.md` §9 に記録してから確定する。
> 古いブログ記事・非公式ライブラリを仕様の正本にしない。

## 1. 方針

| 段階 | 誰が / 何で |
|---|---|
| 初回 cold DM | **人間が手動送信**（従来どおり。ブラウザ自動操作・非公式 bot・Messaging API での cold 送信はしない） |
| 相手からの返信の受信 | Meta 公式 Webhook で自動取得 |
| prospect / outreach との紐付け | サーバーが自動（一意に判定できない場合は「未照合」として人間が確認） |
| 分類 | 自動（Operational Claude が分類、サーバーのルールが安全側の補助） |
| 返信案 | 自動（Operational Claude が作成） |
| 最終返信 | **人間が1タップで承認した後だけ**、Meta 公式 Send API で送信 |

- API で返信するのは、**相手が先に Second Root の Instagram Professional Account へメッセージした会話だけ**。
  Meta の送信可能期間（想定: 相手の最後のメッセージから一定時間内）を過ぎた会話は API で送らず、人間の手動対応に回す。
- AI の完全自動送信は作らない。

## 2. 全体の流れ

```
相手の DM ──► Meta Webhook ──► POST /api/webhooks/instagram（署名検証・event 保存・idempotent）
                                  │
                                  ├─ sales_ig_messages に保存（message id で一意）
                                  ├─ 紐付け（Instagram の相手 ID ↔ prospect）: 一意なら outreach へ、曖昧なら unmatched
                                  └─ ルールで「明示的な将来連絡拒否」らしき文を検出 → dnc_candidate フラグ（DNC にはしない）

Operational Claude（scheduled job）── ingest API: action=inbox_pending ──► 未処理の受信メッセージ（本文・直近の会話・店舗の公開情報）
                                    └─ action=inbox_draft ──► 分類 + 返信案を保存（送信権限なし）

管理画面「返信」── 店舗名・受信日時・相手のメッセージ・AI 分類・AI 返信案
   [この内容で返信] ─► sales_ig_send（idempotency key 付き）─► Meta Send API ─► 成功時のみ sent + message id + 時刻
   [返信文を編集]   ─► 編集後に同じ送信処理
   [後で対応]       ─► 保留（キューから一時的に外す）
```

## 3. データモデル（想定。DEV-020 で migration 化）

| テーブル | 内容 | 主なキー / 制約 |
|---|---|---|
| `sales_ig_webhook_events` | 受信した Webhook の最小記録（event の種類・受信時刻・処理状態・ハッシュ）。raw body は保存しない、または短期（例: 7 日）で削除 | 一意: event 由来の id（なければ本文ハッシュ） |
| `sales_ig_threads` | 会話単位。Instagram-scoped の相手 ID、相手の username（取得できた場合）、紐付いた prospect / outreach、照合状態（matched / unmatched / ignored）、最後の受信時刻 | 一意: 相手の Instagram-scoped ID |
| `sales_ig_messages` | 受信・送信メッセージ（text のみ、最大長あり）。方向、Meta の message id、時刻 | 一意: Meta の message id |
| `sales_ig_drafts` | 受信メッセージに対する分類・返信案・`dnc_candidate`・作成元（operational / rule）・状態（pending / approved / sending / sent / failed / snoozed / superseded） | 1 受信メッセージにつき有効な案は 1 件 |
| `sales_ig_sends` | 送信要求。idempotency key（draft id + 本文ハッシュ）、状態（sending / sent / failed / unknown）、Meta の message id、試行回数、最終エラーコード | 一意: idempotency key |

- 再送・replay 対策は `sales_ig_webhook_events.body_sha256` と `sales_ig_messages.mid` の一意制約に依存する。DEV-024 で保存期間を決めて古い行を削除する場合は、削除する範囲より古い `timestamp` の event を拒否する（署名済みの古い body の再送で再登録されないように）。既読・リアクション等も webhook event 行を作るため削除対象に含める。
- 保存期間: メッセージ本文は営業判断に必要な期間（例: 最終メッセージから 180 日）で削除・要約可能にする（DEV-024 で運用値を決める）。
- **access token・secret・署名・Cookie は会話データに保存しない。**
- RLS: 全テーブル管理者のみ read。書き込みは Webhook（service role）・ingest API（service role）・管理者 RPC（SECURITY DEFINER）だけ。

## 4. 紐付け（DEV-021）

- Webhook で得られるのは Instagram-scoped の相手 ID。prospect が持つのは Instagram handle（URL）。
- 一意に判定できる場合だけ紐付ける:
  1. 既に紐付け済みの thread（同じ相手 ID）
  2. 公式 API で取得できる相手の username が、**送信済み（sent 以降）の Instagram outreach を持つ prospect の handle と完全一致し、候補が 1 件だけ**
- それ以外（username が取れない・一致なし・複数一致）は `unmatched` として保存し、管理画面の「未照合」で人間が prospect を選ぶ（または無関係として ignore）。自動で推測しない。

## 5. 分類と返信案（DEV-021）

- 分類: `interested` / `question` / `meeting_request` / `decline` / `other`（既存の reply_type と同じ）。
- `decline` と DNC は分離する。通常のお断りは DNC にしない。
  「今後連絡しないで」等の**明示的な将来連絡拒否**は `dnc_candidate = true` として管理画面で強調し、人間が「DNC にする」を押したときだけ DNC（既存 `sales_record_reply(..., future_contact_refused)` / `sales_set_dnc`）。
  AI が DNC を設定・解除することはない。
- 分類・返信案は Operational Claude が ingest API 経由で提出する（**有料 API をサーバーから呼ばない**という既存方針のため）。
  サーバーは提出内容を検証する: 本文長、URL は Second Root のデモ URL のみ、メールアドレス・電話番号の新規追加なし、
  価格・納期・値引きの表現を含む案は `needs_human_review` として強調（自動では送らないが、人間の確認点として示す）。
- 返信案のルール（prompt と検証の両方）: 短く丁寧、確認済みの事実と Second Root の公開情報だけ、価格・納期・契約条件を約束しない、架空情報を足さない。
- Operational Claude の権限拡張: ingest token で未処理の受信メッセージ（本文・直近の会話・店舗の公開情報）を読めるようになる。送信・DNC 変更・成約変更は引き続き不可。

## 6. 送信（DEV-023）

- 管理者の「この内容で返信」→ server action（`requireAdmin()`）→ `sales_ig_send` を idempotency key で作成（既にあれば既存の結果を返す）→ Meta Send API → 結果を記録。
- **API 失敗時に sent にしない。** タイムアウト等で結果不明の場合は `unknown` とし、自動再送しない（Meta 側に message id が記録されたかを確認できる手段が公式にあれば DEV-023 で使う。なければ人間に「送信されたか Instagram で確認」を促す）。
- 明確な失敗（4xx 等で未送信が確実）の再試行は同じ idempotency key で行い、二重送信しない。
- 送信可能期間外・thread 未照合・DNC の相手には送らない（サーバー側で拒否）。

## 7. Security

- Meta の App Secret / Access Token / Webhook verify token は server only の環境変数（Vercel）。GitHub・ブラウザ・ログ・DB に出さない。
- Webhook は Meta 公式仕様の検証（想定: 購読確認の verify token と challenge、payload の HMAC-SHA256 署名ヘッダを App Secret で定数時間比較）を行い、失敗は 401/403 で何も保存しない。本文サイズ上限あり。
- 受信メッセージ・AI 返信案は常に plain text として表示（`dangerouslySetInnerHTML` 禁止。既存 guardrail test の対象ディレクトリに含める）。
- 受信本文を checkpoint や ingest の応答に載せる範囲は必要最小限（直近 N 件、最大長あり）。

## 8. 耐障害性

既存 Sales Agent と同じ原則（`docs/ARCHITECTURE.md` §7）: Claude session / container は正本にしない。
受信 DM・Webhook event・会話状態・返信案・送信結果はすべて Supabase に保存し、Webhook 再送・session 消失・再起動でも二重返信・消失が起きないこと。

テストで確認する: webhook event idempotency / send idempotency / failed send の再試行安全性 / unmatched の保存 / 再起動後の継続。

## 9. 公式仕様の確認記録

出典と引用: `.ai/research/meta-instagram-messaging-2026-09-27.md`（Meta 公式ドキュメントのみ、確認日 2026-09-27）。「要 live 確認」は Live の Meta App で DEV-024 に確認する。

| 項目 | 採用した値 | 状態 |
|---|---|---|
| API | Instagram API with Instagram Login（host `graph.instagram.com`、Instagram User token、Facebook Page 不要） | 採用 |
| permission | `instagram_business_basic`・`instagram_business_manage_messages` | 採用。自社アカウントのみなら Standard Access / App Review 不要と読めるが、一般ユーザーとのやり取りが Standard Access で可能かはドキュメント間で矛盾 → **要 live 確認** |
| Graph API version | v26.0（2026-07-29 公開）。v25.0 は 2028-07-29 まで | DEV-023 で固定値として設定 |
| Webhook 購読確認 | GET `hub.mode=subscribe`・`hub.verify_token`・`hub.challenge` → challenge を返す | **実装済み（DEV-020）** |
| 購読 field / payload | `messages`。`{object:"instagram", entry:[{id, time, messaging:[{sender:{id}, recipient:{id}, timestamp, message:{mid, text, attachments, is_echo, is_deleted}}]}]}` | **実装済み**。echo が `messages` で届くか `message_echoes` かは **要 live 確認**（両方の形に対応できる実装） |
| 再送 | 失敗時に最大 36 時間再送、重複排除はサーバー側の責任、batch・順不同あり | **実装済み**（body hash と `mid` で冪等、`timestamp` で並べる） |
| 署名 | `X-Hub-Signature-256: sha256=<hex>`、raw body の HMAC-SHA256（App Secret） | **実装済み**。Meta App Secret と Instagram App Secret のどちらで署名されるかは **要 live 確認**（`INSTAGRAM_APP_SECRET` に設定する値を DEV-024 で確定） |
| Send API | `POST https://graph.instagram.com/v26.0/<IG_ID>/messages`、`{recipient:{id:IGSID}, message:{text}}`、text は 1000 UTF-8 bytes まで、応答 `{recipient_id, message_id}` | DEV-023 |
| 送信可能期間 | 相手の最後のメッセージから 24 時間。`human_agent` tag（7 日）は App Review 等が必要 → MVP では使わない | DEV-023 で 24 時間外は送らない |
| 相手の username | `GET /<IGSID>?fields=username,name`（相手がメッセージした後のみ） | DEV-021 |
| 送信の冪等性 | 公式の idempotency key なし。送信成功なのにエラーが返る場合あり（subcode 1357046） → 結果不明は自動再送しない、echo webhook で確認 | DEV-023 |

## 9.1 環境変数（server only、値は人間が Vercel に設定。GitHub に commit しない）

| 名前 | 用途 |
|---|---|
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | 購読確認用（16 文字以上のランダム値、Meta App の Webhook 設定と同じ値） |
| `INSTAGRAM_APP_SECRET` | Webhook 署名の検証（未設定なら webhook は 503 で全拒否） |
| `INSTAGRAM_ACCOUNT_ID` | Second Root の Instagram professional account ID（数字、**必須**。未設定・不正なら webhook は 503。同じ Meta App の他アカウント宛ての event を保存しない） |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram User access token（server only）。DEV-021 で相手の username 取得（照合）、DEV-023 で返信送信に使う。未設定なら照合は行わず全件「未照合」（fail-closed）。60 日で失効、更新手順を DEV-024 で定める |

## 10. 人間の作業（HUMAN BLOCKER 候補、DEV-024 で具体化）

Meta App 作成 / Instagram Professional Account 接続 / permission 申請と App Review / Webhook callback URL と verify token の登録 /
Production Access Token と App Secret の Vercel 設定。これらはコード・ローカルテスト・UI・DB 設計を止める理由にしない。
