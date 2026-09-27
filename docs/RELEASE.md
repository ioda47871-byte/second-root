# Release — Second Root Sales Agent

## 1. ブランチと環境

| Branch | デプロイ先 | merge 権限 |
|---|---|---|
| `main` | Vercel Production（secondroot.jp） | 人間のみ（例外: BOOT-001 の PR #8 のみ、2026-09-27 の人間承認に基づき Claude が merge 可。AI_WORKFLOW §4） |
| `develop` | Vercel Preview（staging 用 env） | Claude（条件付き自律 merge） |
| `feature/*` | Vercel Preview | — |

## 2. feature → develop（Claude 自律 merge 条件）

- [ ] 必須 CI（static / unit / integration / build / e2e / e2e-sales）成功
- [ ] Fresh Reviewer PASS（`.ai/reviews/<task-id>.md`）
- [ ] Critical / High = 0
- [ ] Protected Scope 変更なし
- [ ] `.ai/tasks.json` / `.ai/progress.md` 更新済み

## 3. develop → main（人間承認）

Release Readiness（DEV-019）でチェック:

- [ ] 全 MVP Task が done
- [ ] CI 全 green
- [ ] 既存 Second Root regression（トップ・法務ページ・問い合わせフォーム）確認
- [ ] Supabase migration が staging で適用・検証済み
- [ ] RLS: 管理者以外が営業データを読めないことを確認
- [ ] Production env（Supabase URL/keys, ingest token）が Vercel に設定済み（人間）
- [ ] Claude Cloud scheduled job の staging 実走確認済み（DEV-016）
- [ ] Secret 混入なし
- [ ] rollback 手順確認

## 4. DB migration

- migration は `supabase/migrations/` に追加のみ（既存 migration の書き換え禁止）。
- Production への適用は人間承認後（Protected Scope）。
- 破壊的変更（列削除等）は2段階（追加 → 移行 → 削除）で行う。

## 5. Rollback

| 対象 | 手順 |
|---|---|
| アプリ | Vercel の直前 Production deployment を Promote（Instant Rollback） |
| コード | `main` で revert PR を作成し人間が merge |
| DB | 前方修正（逆 migration）を原則。データ削除を伴う rollback は人間承認 |
| Operational job | Claude Cloud の scheduled job を無効化。ingest token を rotate すれば即座に遮断可能 |
| 依存関係 | Next.js 16.3.6 への更新（DEV-017、security advisory 対応）を戻す場合は、advisory が再び有効になるため revert ではなく前方修正を優先 |

## 6. 途中で止まった Operational run

- 状態は `sales_agent_runs` を見れば分かる（status / phase / checkpoint_at / error_code）。
- `running` のまま最終 checkpoint から 24 時間を超えた run は、次に参照された時点でサーバーが `failed`（error_code `run_expired`）に確定し、次の run は新しい run_id で始める。手作業のデータ修正は不要。
- `persist` を 3 回試しても解消しない候補エラーは、run を `completed`（error_code `partial_errors`）として確定し、その候補は営業準備しない。
- 途中 run が作った prospect / demo / outreach は候補単位の transaction で作られているため、中途半端な行は残らない。
- 同じ原因で連続して失敗する場合は scheduled job を一時停止し、`.ai/blockers.md` に記録して人間が判断する。

## 7. 緊急停止

- ingest を止める: Vercel の `SALES_AGENT_INGEST_TOKEN` を削除 / 変更（API は fail closed）。
- 管理画面・デモを止める: 該当ルートを無効化する revert、またはデモを `disabled_at` で一括無効化。
- 既存 Second Root（トップ・問い合わせ）は Sales Agent と独立しているため影響を受けない設計とする。

## 8. Production リリース手順（人間が実行。Claude は PR 作成まで）

前提（必須）: §3 のチェックがすべて済み、DEV-016（Staging 実走）が完了していること。満たすまで develop → main を merge しない。

1. **Supabase（Production 用 project）**
   - Second Root 専用 project を作成（HUMAN-002）。Region は Tokyo 推奨、Free プラン。
   - migrations を適用（人間の端末から）: `npx supabase login`（access token）→ `npx supabase link --project-ref <prod-ref>` → `npx supabase db push`（DB password を聞かれる。Claude には渡さない）。
   - 適用後の確認（SQL Editor）:
     - `select version from supabase_migrations.schema_migrations order by 1;` が `supabase/migrations/` のファイルと一致
     - `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' and relname like 'sales\_%' and not relrowsecurity;` が 0 行
   - Authentication → Providers → Email: 「Allow new users to sign up」OFF、「Confirm email」ON、パスワード最小長 12 以上を推奨。
   - 管理者作成: Authentication → Add user（email + password、Auto Confirm）→ SQL Editor で
     `insert into public.sales_admins (user_id) values ('<uuid>');`
2. **Vercel（Production 環境変数）**: Supabase Dashboard の API キー表示が新しい名称の場合、公開用（anon / Publishable）を `NEXT_PUBLIC_SUPABASE_ANON_KEY`、サーバー用（service_role / Secret）を `SUPABASE_SERVICE_ROLE_KEY` に入れる。**サーバー用のキーを `NEXT_PUBLIC_*` に入れない**（ブラウザに露出する）。
   設定する値: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SALES_AGENT_INGEST_TOKEN`（Staging と別の値、`openssl rand -hex 32`）/ `SALES_DEMO_BASE_URL=https://secondroot.jp`。既存の `RESEND_API_KEY` 等はそのまま。
3. **develop → main**: Claude が作成した Release PR（DEV-019）を人間がレビューし merge。Vercel が Production にデプロイ。
4. **Smoke test（Production）**:
   - 既存: `/`（トップ表示・問い合わせフォーム送信は実際に送ると通知が届くので必要な場合のみ）、`/privacy`・`/terms`（法務ページ）、`/thanks`、`/robots.txt`、`/sitemap.xml`
   - `/admin/login` → 管理者でログイン → `/admin/sales` が空の一覧で表示される
   - Authentication → Add user で一時的な非管理者を作成 → `/admin/sales` で「権限がありません」を確認 → そのユーザーを削除
   - `curl -sS -X POST https://secondroot.jp/api/internal/sales-agent/runs -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"action":"status"}'` が `{"run":null,...}`
   - token なしで 401、未知のデモ URL で 404
5. **Operational job（Production）**: `ops/sales-agent/SCHEDULE.md` §3 の手順で Production 用 environment と Routine を作成し、まず手動で 1 回実行 → 管理画面で候補を目視確認 → スケジュール有効化。
6. 最初の 1 週間は毎日、営業準備された候補の事実・出典・営業文を人間が確認してから送信する。

## 9. リリース前の追加確認

- [ ] `npm audit --omit=dev` で high / critical が 0
- [ ] GitHub branch protection（`main` / `develop`）に required checks: `static` / `unit` / `integration` / `build` / `e2e` / `e2e-sales`（HUMAN-003）
- [ ] Supabase Auth の sign-up 無効・管理者 1 名のみ
- [ ] Vercel の Production / Preview で `SALES_AGENT_INGEST_TOKEN` が別の値
