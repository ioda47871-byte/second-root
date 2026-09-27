# Progress

> 新しい session はまずここと `.ai/tasks.json`・`.ai/blockers.md` を読む（手順: `docs/AI_WORKFLOW.md` §2）。
> push のたびに「現在地」を更新する。

## 現在地

- 完了: BOOT-001（PR #8 → main）、DEV-001（PR #9）、DEV-002（PR #10）、DEV-003（PR #11）、DEV-004（PR #12）、DEV-008（PR #13, e1ddf9a）
- 進行中: DEV-005（PR #14）、DEV-006/007（stacked: `feature/dev-006-…`, `feature/dev-007-…`）、DEV-009（`feature/dev-009-today-queue`）
- 次: DEV-005〜007（templates）、DEV-009 以降（`.ai/tasks.json` の依存順）
- 自律実行ルール: feature → develop は CI green + Fresh Review Critical/High 0 で Claude が merge。develop → main（Production release）は人間承認。
- ローカル再開: `npx supabase start` → `npm run test:integration`（Docker 必須。cloud container では `dockerd &` で起動）

## BOOT-001 チェックポイント

- [x] 既存 main 調査（Next.js 16.3 / React 19.2 / Resend 問い合わせ / テスト・CI なし / open PR なし）
- [x] docs/ と .ai/ の作成 → push
- [x] test foundation（Vitest unit + Playwright 既存サイト smoke + secret scan）→ push
- [x] CI（GitHub Actions: static / unit / build / e2e）+ PR template → push
- [x] PR 作成（https://github.com/ioda47871-byte/second-root/pull/8）・CI 確認・Fresh Review PASS（.ai/reviews/BOOT-001.md）

## 調査メモ（BOOT-001, 2026-09-24）

- main HEAD: a926acf（PR #7 merge）。open PR なし。
- 既存に `.github/`・テスト・CI なし。`playwright`（1.62.1）は `scripts/*.mjs` の手動確認用に導入済み（`@playwright/test` は未導入）。
- `tsc --noEmit` 単体では `LayoutProps` 未定義で失敗する。`next typegen` で型生成してから tsc を走らせる必要あり → `npm run typecheck` で対応。
- `npm run lint` / `npm run build` は main で成功。
- `.env.local.example`: RESEND_API_KEY / CONTACT_TO_EMAIL / CONTACT_FROM_EMAIL / NEXT_PUBLIC_INSTAGRAM_URL / NEXT_PUBLIC_BROT_YANAGI_URL。
- `app/layout.tsx` に固定 JSON-LD の `dangerouslySetInnerHTML` あり（既存・対象外）。

## 履歴

- 2026-09-24: BOOT-001 開始。docs / .ai を追加。
- 2026-09-24: test foundation 追加（vitest ~4.0.18 ※4.1 系は npm 10 で `edgesOut` エラー、5 系は @types/node ^20 と peer 衝突のため / @playwright/test 1.62.1 は既存 playwright と同版）。
- 2026-09-24: CI（.github/workflows/ci.yml）と PR template を追加。
- 2026-09-24: CI run #1 で e2e job 内の2回目の build が next/font/google の Google Fonts 取得（外部）で失敗（同コミットの build job は成功）。build を1回にし e2e は `.next` artifact を再利用する構成に修正。
- 2026-09-24: Fresh Review PASS。Medium 3件・Low 3件を反映。BOOT-001 を done に更新。
- 2026-09-27: 耐障害性補強を開始。ARCHITECTURE §5/§7（action 設計・phase/stage・nextAction・多重重複防止・候補単位 transaction）、MVP_SPEC §3.6/§10、AI_WORKFLOW §9、SECURITY §3.1、RELEASE §6 を更新。DEV-001/002/003/015/016 に [checkpoint]/[resume]/[idempotency]/[fail-closed] 受入条件を追加し、tests/unit/ai-tasks.test.ts で存在を検査。
- 2026-09-27: 耐障害性補強の Fresh Review PASS（Critical/High 0）。Medium 3 / Low 3 を反映（checkpoint を同一 transaction で確定、persist の run 単位直列化、3 回で partial_errors 確定、dedupe→DNC→上限の順、期限切れ run の failed 確定、候補 key 定義）。
- 2026-09-27: PR #8 最終仕様整合（上記4点）を反映。
- 2026-09-27: CI build が Google Fonts（next-font-loader）の外部要因で再発。CI の build を「next-font-loader エラー時のみ1回再試行」に変更（他のエラーは即失敗）。Vercel 側でも起こりうるため known issue として記録。
- 2026-09-27: PR #8 merge（32de89a）、develop 作成。DEV-001 開始。
- 2026-09-27: DEV-001 実装（migrations 2本、integration 55件 green、CI に integration job 追加）→ PR 作成・レビューへ。
- 2026-09-27: DEV-001 Fresh Review PASS（Critical/High 0）。Medium 4件・Low を修正（integration 71件 green）。DEV-002 は PR #10 でレビュー中。
- 2026-09-27: DEV-001 merge（PR #9, b190518）。
- 2026-09-27: DEV-002 merge（PR #10, 843699e）。DEV-003 実装中（integration 87件 green）。
- 2026-09-27: DEV-003 Fresh Review PASS。Medium 3件（デモへの email 混入・店名/住所の出典一致・第一者 email の自サイト確認）ほか修正。unit 207 / integration 88 green。
- 2026-09-27: DEV-003 merge（PR #11, 7e62223）。
- 2026-09-27: DEV-004 merge（PR #12, d2acecb）。CI に e2e-sales job。
- 2026-09-27: DEV-008 Fresh Review PASS。Medium（layout のみの認可 → RSC 部分描画で回避可能）を全ページ guard + 実遷移ヘッダ再送 e2e で修正。
- 2026-09-27: DEV-008 merge（PR #13, e1ddf9a）。DEV-009 開始。
