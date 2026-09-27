# BOOT-001 最終仕様整合 Fresh Review

対象: `1b00ecf..` の最終仕様整合（decline と DNC の分離 / email+password 固定 / verified ≤10・新規 actionable ≤5 / デモ expires_at は送信時設定）

## Round 1（ccef136）— FAIL（High 1）

| Sev | 指摘 | 対応 |
|---|---|---|
| High | Claude による PR #8 main merge / develop 作成の許可が AI_WORKFLOW・RELEASE の「main は人間のみ」と矛盾し、repo から検証できない | 人間が 2026-09-27 のセッション指示で明示承認済み。AI_WORKFLOW §4 と RELEASE §1 に「BOOT-001 の PR #8 のみの1回限りの例外」として日付付きで明記 |
| Medium | `expires_at = null` の未送信デモが token 保持者に無期限公開 | 未送信デモは公開 URL で 404、ログイン管理者のプレビューのみ。DNC 設定時は `disabled_at` で即時非公開 |
| Medium | batch 超過時「全体拒否」の変更が ARCHITECTURE に未反映 | schema validation による 400 全体拒否として MVP_SPEC / ARCHITECTURE 双方に明記 |
| Low | 「将来の再営業の可能性は残す」が実装要求と誤読されうる | MVP では再営業の仕組みを作らない旨に修正 |
| Low | DEV-012 に decline≠DNC のテストがない | required_tests に追加 |
| Low | 「新規 actionable」の定義・枠の割当順が未定義 | 当日（JST）に初回営業下書きが作られた prospect（全 run 合計）、枠は verified 提出順と定義 |
| Low | 10 件の verified が 64KB に収まるか未検証 | DEV-002 の required_tests に追加 |

## Round 2（59aca29）— PASS（Critical 0 / High 0）

| Sev | 指摘 | 対応 |
|---|---|---|
| Medium | 未送信デモの管理者プレビューを担う Task・テストがない | DEV-008 に管理者限定プレビューの受入条件とテスト、DEV-004 に未送信 404 のテストを追加 |
| Low | tasks.json / blockers.md に「人間が merge」の旧記述 | 承認済み例外に合わせて更新 |
| Low | 明示的拒否の記録方法が未定義 | `dnc_reason = explicit_refusal`、DEV-012 に受入条件追加 |
| Low | DNC 解除時のデモ `disabled_at` の扱い | 戻さないと明記 |
| Low | decline 後に別チャネル不可の直接テストなし | DEV-012 受入条件に明記 |
