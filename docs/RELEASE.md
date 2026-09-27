# Release — Second Root Sales Agent

## 1. ブランチと環境

| Branch | デプロイ先 | merge 権限 |
|---|---|---|
| `main` | Vercel Production（secondroot.jp） | 人間のみ |
| `develop` | Vercel Preview（staging 用 env） | Claude（条件付き自律 merge） |
| `feature/*` | Vercel Preview | — |

## 2. feature → develop（Claude 自律 merge 条件）

- [ ] 必須 CI（static / unit / build / e2e、導入後は integration）成功
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

## 6. 途中で止まった Operational run

- 状態は `sales_agent_runs` を見れば分かる（status / phase / checkpoint_at / error_code）。
- `running` のまま最終 checkpoint から 24 時間を超えた run は再開されず、次の run が新しい run_id で始める（`nextAction: start_new_run`）。手作業のデータ修正は不要。
- 途中 run が作った prospect / demo / outreach は候補単位の transaction で作られているため、中途半端な行は残らない。
- 同じ原因で連続して失敗する場合は scheduled job を一時停止し、`.ai/blockers.md` に記録して人間が判断する。

## 7. 緊急停止

- ingest を止める: Vercel の `SALES_AGENT_INGEST_TOKEN` を削除 / 変更（API は fail closed）。
- 管理画面・デモを止める: 該当ルートを無効化する revert、またはデモを `disabled_at` で一括無効化。
- 既存 Second Root（トップ・問い合わせ）は Sales Agent と独立しているため影響を受けない設計とする。
