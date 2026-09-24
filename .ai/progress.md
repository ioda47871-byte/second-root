# Progress

> 新しい session はまずここと `.ai/tasks.json`・`.ai/blockers.md` を読む（手順: `docs/AI_WORKFLOW.md` §2）。
> push のたびに「現在地」を更新する。

## 現在地

- 現在の Task: **BOOT-001**（in_progress）
- 作業 branch: `claude/sales-agent-bootstrap-6e2zge`（base: `main` @ a926acf）
- 次の一手: GitHub Actions CI（.github/workflows/ci.yml）を追加して push

## BOOT-001 チェックポイント

- [x] 既存 main 調査（Next.js 16.3 / React 19.2 / Resend 問い合わせ / テスト・CI なし / open PR なし）
- [x] docs/ と .ai/ の作成 → push
- [x] test foundation（Vitest unit + Playwright 既存サイト smoke + secret scan）→ push
- [ ] CI（GitHub Actions）→ push
- [ ] PR 作成・CI 結果確認

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
