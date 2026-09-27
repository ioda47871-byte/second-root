# Progress

> 新しい session はまずここと `.ai/tasks.json`・`.ai/blockers.md` を読む（手順: `docs/AI_WORKFLOW.md` §2）。
> push のたびに「現在地」を更新する。

## 現在地

- 人間が 2026-09-27 に「PR #8 最終修正 → CI/レビュー PASS なら Claude が main へ merge → develop 作成 → DEV-001〜DEV-019 を自律継続（Production release のみ人間承認）」を承認。
- 現在: PR #8 最終仕様整合（decline と DNC の分離 / Admin Auth = email+password 固定 / verified ≤10・新規 actionable ≤5 / デモ expires_at は送信済み時に設定）
- 次の一手: CI + Fresh Review → PR #8 merge → develop 作成 → DEV-001

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
