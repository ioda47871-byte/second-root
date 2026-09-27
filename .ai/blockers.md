# Blockers

> 人間の判断・操作が必要な事項と、技術的に止まっている事項を記録する。
> 解除されたら「解除済み」に移し、解除日と対応を書く。Secret の値は書かない。

## 未解除

### HUMAN-002 — Second Root 専用 Supabase project（DEV-001 着手前に確認、DEV-016 までに必要）
- 対象 Task: DEV-001（ローカル開発はローカル Supabase で進められるため必須ではない）, DEV-016, DEV-019
- 状態: 未着手（人間判断）
- 内容: mugi-no-mi 等とは別の Second Root 専用 project を staging / production 用に作成する。無料プランの active project 数上限に注意。
- Claude はプロジェクト作成・billing 変更を行わない（Protected Scope）。

### HUMAN-004 — Staging 実走確認（DEV-016）に必要な人間の操作
- 対象 Task: DEV-016（DEV-019 の Release 判断にも必要）
- 状態: 人間待ち（開発は止めない。ローカルでの代替確認は Claude が実施）
- 必要なもの（Claude は作成・設定しない: Protected Scope / human_approval_triggers）:
  1. **Supabase project（Staging）作成**（HUMAN-002 と同じ判断）: Supabase Dashboard → New project（Free プラン、Region は Tokyo 推奨）。
     作成後、ローカルから `npx supabase link --project-ref <ref>` → `npx supabase db push` で migrations を適用（人間が実行、または Claude に DB 接続情報を渡さずに人間が実行）。
  2. **管理者ユーザー作成**: Dashboard → Authentication → Add user（email + password、Auto Confirm）→ SQL Editor で
     `insert into public.sales_admins (user_id) values ('<作成した user の uuid>');`。Authentication → Providers → Email で「Allow new users to sign up」を OFF。
  3. **Vercel Preview（Staging）環境変数**: Vercel → Project → Settings → Environment Variables（Preview のみ）に
     `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SALES_AGENT_INGEST_TOKEN`（`openssl rand -hex 32`）/ `SALES_DEMO_BASE_URL`（Preview の URL）を設定し再デプロイ。
  4. **Claude Cloud environment + Routine**: `ops/sales-agent/SCHEDULE.md` §2・§3 の手順（環境変数は `SALES_AGENT_INGEST_URL` と `SALES_AGENT_INGEST_TOKEN` だけ）。まず手動で 1 回実行。
- 推奨: 1〜3 を済ませたら Claude に「DEV-016 を再開」と伝える。Claude は Staging の ingest API に対して resume（中断→再開）・再送で重複なし・fail-closed を確認し、実走ログを `.ai/reviews/DEV-016.md` に保存する（token は Claude のこの session には渡さず、Routine の実行結果と管理画面を人間が共有する形でもよい）。
- 解除後に再開すること: DEV-016 の staging 実走 → DEV-019 の Release Readiness を更新。

### HUMAN-005 — Vercel preview の build rate limit（非ブロッキング）
- 状態: 人間判断（開発は止めない）
- 内容: 2026-09-27 に PR の `Vercel` status が "Deployment rate limited — retry in 24 hours" で失敗（無料プランの preview build 回数上限）。GitHub Actions の必須 CI（static / unit / integration / build / e2e / e2e-sales）は独立に判定しており、merge 判断には使っていない。
- 影響: その日の Preview URL が作られない。Staging 実走（DEV-016 / HUMAN-004）を Preview で行う場合、上限にかからない日に行う必要がある。
- 選択肢: (a) 24 時間待つ（推奨。追加費用なし）、(b) Vercel の有料プラン（billing のため人間判断）。Claude は plan を変更しない。

### HUMAN-003 — branch protection の required checks（推奨・非ブロッキング）
- 状態: 人間待ち（開発は止めない）
- 内容: GitHub → Settings → Branches で `main` と `develop` に branch protection を設定し、required status checks に `static` / `unit` / `integration` / `build` / `e2e` / `e2e-sales` を追加する。
- 理由: 現状 Claude は CI green を確認してから merge しているが、GitHub 側でも強制されると安全。
- DEV-004 で Claude が allowed_scope を拡張（GA を /demo・/admin で無効化、noindex / no-referrer ヘッダ、e2e 分割）。既存ページの挙動は不変とレビュー確認済み。異論があれば PR #12 を参照。

## 解除済み

### HUMAN-001 — Bootstrap PR の merge と develop 作成
- 対象 Task: DEV-001, DEV-002（以降すべて）
- 状態: **解除済み（2026-09-27）** — 人間承認に基づき Claude が PR #8 を main へ merge（32de89a）し、`develop` を作成。branch protection の設定は引き続き人間の推奨作業
- 必要な操作（1・2 は人間承認に基づき Claude が実施）:
  1. BOOT-001 の PR #8 を main へ merge
  2. merge 後の main から `develop` branch を作成し push
  3. （推奨）`main` / `develop` に branch protection を設定し、CI の `static` / `unit` / `build` / `e2e` を required check にする
- 解除条件: `origin/develop` が存在し、BOOT-001 の変更を含む


