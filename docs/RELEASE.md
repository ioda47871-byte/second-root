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

## 8. Production リリース手順（人間が実行。Claude は PR 作成と、人間が貼った確認結果の確認まで）

前提: §3 のチェックが済んでいること。DEV-016（Staging 実走）は 2026-09-28 に完了している（`.ai/reviews/DEV-016.md`）。手順 1〜3 は **Release PR を merge する前に**行う（4 が merge、5 以降は merge 後）。**Production の DB・Auth・環境変数への操作は、確認も含めて人間が行う**（Claude に Production 用の token を渡さない。Supabase の Management API の token は任意の SQL を実行できるため）。状況の一覧は `docs/RELEASE_READINESS.md` §13。

1. **Supabase（Production 用 project）**
   - Second Root 専用の**新しい** project を作成する（HUMAN-002）。Region は Tokyo 推奨、Free プラン。
   - Staging の project（`znbqgvawublgyjwfpmei`）は流用しない。develop の Preview・Staging の ingest token と Routine・Claude 用の token が、今もつながっているため。
   - migrations を適用する（人間の端末から）:
     - `npx supabase login` → `npx supabase link --project-ref <prod-ref>` → `npx supabase db push`
     - DB password を聞かれるが、Claude には渡さない。
     - `supabase/migrations/` の 16 本すべてを適用する。
     - 新しい project は API role に table 権限を自動で付けないので、`20260928000000_sales_explicit_api_grants.sql` が必須。
   - 適用後の確認: 人間の端末で `SUPABASE_ACCESS_TOKEN=<token> npm run staging:verify -- --project-ref <prod-ref>`。名前は staging だが、どの project でも使える。
     - token は Production だけに範囲を絞り、有効期限を短くする（`database_read`・`database_write`・`auth_config_read`）。
     - 結果の一覧（secret は含まない）は Claude に貼って確認してもらえる。
     - 確認内容: migration の一致・RLS・権限の過不足（多すぎ・足りない）・sign-up OFF・管理者 1 名。
     - 次の SQL だけでは、権限の不足は分からない:
       - `select version from supabase_migrations.schema_migrations order by 1;` が `supabase/migrations/` と一致する
       - `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' and relname like 'sales\_%' and not relrowsecurity;` が 0 行
   - Authentication → Sign In / Providers:
     - 「Allow new users to sign up」を OFF。
     - Email の「Minimum password length」を 12 以上。
     - 「Confirm email」は ON のまま。
   - 管理者作成:
     - Authentication → Add user（email + password、Auto Confirm）。
     - SQL Editor で `insert into public.sales_admins (user_id) values ('<uuid>');`
     - または人間の端末で `npm run staging:admin -- --project-ref <prod-ref> --confirm-ref <prod-ref> --email <email>`（パスワードは扱わない）。
     - その後 `staging:verify` の **14 項目すべて PASS** を確認し、token を削除（Revoke）する。
2. **Vercel（Production 環境変数）**。Environment は **Production だけ**に設定する。Preview（develop）の Staging 用の値はそのまま。
   - Supabase Dashboard の API キー表示が新しい名称の場合: 公開用（anon / Publishable）を `NEXT_PUBLIC_SUPABASE_ANON_KEY`、サーバー用（service_role / Secret）を `SUPABASE_SERVICE_ROLE_KEY` に入れる。**サーバー用のキーを `NEXT_PUBLIC_*` に入れない**（ブラウザに露出する）。
   - 設定する値:
     - `NEXT_PUBLIC_SUPABASE_URL`
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`（Sensitive）
     - `SALES_AGENT_INGEST_TOKEN`（Staging と別の値、`openssl rand -hex 32`、Sensitive）
     - `SALES_DEMO_BASE_URL=https://secondroot.jp`
   - 既存の `RESEND_API_KEY` / `CONTACT_TO_EMAIL` / `NEXT_PUBLIC_GA_MEASUREMENT_ID` はそのまま。
   - `INSTAGRAM_*` は HUMAN-006 まで設定しない。未設定なら Instagram 機能は無効（Webhook は 503）。
   - 今の本番のコードはこれらを読まないので、merge 前に設定してよい。
3. **Deployment Protection**:
   - Vercel Authentication が `all_except_custom_domains` なら、`secondroot.jp` は公開のままで、Production の ingest に bypass は要らない。
   - `*.vercel.app` の Production URL は保護されるので、Routine は `https://secondroot.jp` を使う。
4. **develop → main**:
   - Release PR（#29、DEV-019）の CI が green で、衝突がないことを確認する。
   - 人間がレビューし、Draft を外して merge する。
   - Vercel が Production にデプロイする。
5. **Smoke test（Production）**:
   - 既存ページ:
     - `/`（トップ表示。問い合わせフォームは実際に送ると通知が届くので、必要な場合のみ送信する）
     - `/privacy`・`/terms`（法務ページ）
     - `/thanks`、`/robots.txt`、`/sitemap.xml`
   - `/admin/login` → 管理者でログイン → `/admin/sales` が空の一覧で表示される。
   - 非管理者の拒否: Authentication → Add user で一時的な非管理者を作成 → `/admin/sales` で「権限がありません」を確認 → そのユーザーを削除する。
   - ingest: `curl -sS -X POST https://secondroot.jp/api/internal/sales-agent/runs -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"action":"status"}'` が `{"run":null,...}` を返す。
   - token なしで 401、未知のデモ URL で 404。
6. **Operational job（Production）**: `ops/sales-agent/SCHEDULE.md` §3 の手順で進める。
   - Staging とは別の Claude Cloud environment を作る。
     - 環境変数: `SALES_AGENT_INGEST_URL=https://secondroot.jp/api/internal/sales-agent/runs` だけ。
     - API credential: host `secondroot.jp` 限定で、`Authorization: Bearer <Production の ingest token>` だけ。bypass は付けない。
   - Routine を作り、まず手動で 1 回実行する → 管理画面で候補を目視確認する → スケジュールを有効化する。
7. 最初の 1 週間は毎日、営業準備された候補の事実・出典・営業文を人間が確認してから送信する。
8. （任意・後日）Instagram 返信機能: HUMAN-006、`docs/INSTAGRAM_SETUP.md`。

## 9. リリース前の追加確認

- [x] `npm audit --omit=dev` で high / critical が 0（2026-09-28、develop）
- [ ] GitHub branch protection（`main` / `develop`）に required checks: `static` / `unit` / `integration` / `build` / `e2e` / `e2e-sales`（HUMAN-003、推奨）
- [ ] Production の Supabase Auth: sign-up 無効・管理者 1 名のみ（`staging:verify` 14 項目 PASS）
- [ ] Vercel の Production と Preview で `SALES_AGENT_INGEST_TOKEN` が別の値
- [ ] Staging 用の Supabase / Vercel token を片付けた（`docs/STAGING.md` §8。merge 後でもよい）
