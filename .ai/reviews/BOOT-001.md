# BOOT-001 Fresh Review

- Reviewer: 独立 context の Claude subagent（実装 context を共有しない）
- 対象: `origin/main...37d63ce`（docs / .ai / test foundation / CI）
- 実行: `npm test` 36 passed / lint・typecheck・check:secrets clean / Playwright 14 passed（desktop 7・mobile 7）
- 判定: **PASS**（Critical 0 / High 0）

## 指摘と対応

| Sev | 指摘 | 対応 |
|---|---|---|
| Medium | MVP_SPEC の `followed_up` 状態と ARCHITECTURE の `kind=follow_up` 行が不一致 | `kind=follow_up` の別行に統一（MVP_SPEC §5, ARCHITECTURE §4） |
| Medium | デモの30日期限の起点（未送信時）が未定義 | 作成時 `created_at+30日` → 初回 sent 時 `sent_at+30日` に更新と明記。DEV-004/010/011 の受入条件へ追加 |
| Medium | DEV-002/003 の受入条件に一部 Hard Rules が明記されていない | 名古屋のみ・3業種・1チャネル・サイトあり+IGのみ対象外・not_found 再確認・email 第一者出典を追加 |
| Low | Resend guardrail が dynamic `import("resend")` を検出しない | 正規表現に `import(...)` を追加 |
| Low | CI の `cancel-in-progress` が main/develop の push も取り消す | pull_request のときのみ取り消すよう変更 |
| Low | `blocked` を人間待ちにも使うことが AI_WORKFLOW に未記載 | §3 に追記 |
| Low | check-secrets の placeholder 判定が `test`/`example` を含む値を通す | 現状維持（誤検知回避を優先。補助的な安全網という位置づけを script に明記済み） |
| Low | push と pull_request の二重実行 | 現状維持（CI 分数のみのコスト） |

## CI

- run #1: e2e job 内の2回目の build が next/font/google の Google Fonts 取得で失敗（同コミットの build job は成功）。build を1回にし e2e が `.next` artifact を再利用する構成に修正（9c3c0bb）。
