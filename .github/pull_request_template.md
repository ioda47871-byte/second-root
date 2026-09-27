## Task

<!-- .ai/tasks.json の Task ID とタイトル -->

## 変更内容

## テスト

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e`
- [ ] integration（DB を触る場合）

## チェック

- [ ] 既存 Second Root（トップ・法務ページ・問い合わせフォーム）に影響なし
- [ ] Secret を含まない（`npm run check:secrets`）
- [ ] Protected Scope（docs/AI_WORKFLOW.md §7）の変更なし / ある場合は人間承認を明記
- [ ] 自動テストから実店舗へ Email / Instagram を送らない
- [ ] `.ai/tasks.json` / `.ai/progress.md` を更新
- [ ] Fresh Reviewer 結果（`.ai/reviews/<task-id>.md`）

## 既知の問題 / BLOCKED
