# BOOT-001 耐障害性補強 Fresh Review

- Reviewer: 独立 context の Claude subagent（実装 context を共有しない）
- 対象: `9e15620..f6f1862`（docs / .ai/tasks.json / .ai/progress.md / tests/unit/ai-tasks.test.ts）
- 実行: `npm test` 41 passed / `npm run lint` clean
- 判定: **PASS**（Critical 0 / High 0）
- 確認された点: endpoint は1つのまま（action の discriminated union）、新規インフラなし、security は同等以上、営業フロー不変、DEV-001/002/003/015/016 の受入条件に checkpoint / resume / idempotency / fail-closed が揃い、MVP_SPEC §3.6・ARCHITECTURE §7.4・SECURITY・AI_WORKFLOW §9 の fail-closed 規則が一致

## 指摘と対応

| Sev | 指摘 | 対応 |
|---|---|---|
| Medium | commit 後・checkpoint 更新前に落ちると、再処理で自 run の prospect が `duplicate` と誤判定される | 候補結果を業務データと**同じ transaction** で checkpoint に書く。加えて `first_seen_run_id` と候補 key が一致する場合は自 run の既存結果を返す（ARCHITECTURE §7.3 3・5、DEV-001/003） |
| Medium | 同一 run の `persist` 同時実行で checkpoint jsonb 更新が失われうる | run_id ごとの advisory lock（取れなければ 409 `run_busy`）＋ run 行 `SELECT … FOR UPDATE`（§7.3 6、DEV-001/003） |
| Medium | 解消しない `error` 候補で run が `persisting` に留まり続ける | 3 回目の `persist` 後に残る error はサーバーが `completed`（`partial_errors`）で確定、候補は営業準備しない（§7.4、AI_WORKFLOW §9.1、RELEASE §6、DEV-002/003） |
| Low | 当日上限が dedupe より先で、重複が `daily_cap` と報告されうる。lock 範囲の記述不一致 | 順序を dedupe → DNC → 当日上限 に変更、全体を共通 advisory lock 下と明記 |
| Low | 期限切れ run が `running` のまま残る | 参照時に `failed`（`run_expired`）へ確定、runId なし `status` は返さない |
| Low | 中間 stage が記録されない点・候補 key が未定義 | `[ ]` 内は transaction 内の論理工程と明記、候補 key の定義と未知 key 拒否を追記 |
| Low | guard test はタグの存在のみ検査 | 現状維持（受入条件の欠落防止が目的。内容は review で担保） |
