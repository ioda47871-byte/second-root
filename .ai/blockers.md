# Blockers

> 人間の判断・操作が必要な事項と、技術的に止まっている事項を記録する。
> 解除されたら「解除済み」に移し、解除日と対応を書く。Secret の値は書かない。

## 未解除

### HUMAN-001 — Bootstrap PR の merge と develop 作成
- 対象 Task: DEV-001, DEV-002（以降すべて）
- 状態: 人間待ち
- 必要な操作:
  1. BOOT-001 の PR をレビューし main へ merge
  2. merge 後の main から `develop` branch を作成し push
  3. （推奨）`main` / `develop` に branch protection を設定し、CI の `static` / `unit` / `build` / `e2e` を required check にする
- 解除条件: `origin/develop` が存在し、BOOT-001 の変更を含む

### HUMAN-002 — Second Root 専用 Supabase project（DEV-001 着手前に確認、DEV-016 までに必要）
- 対象 Task: DEV-001（ローカル開発はローカル Supabase で進められるため必須ではない）, DEV-016, DEV-019
- 状態: 未着手（人間判断）
- 内容: mugi-no-mi 等とは別の Second Root 専用 project を staging / production 用に作成する。無料プランの active project 数上限に注意。
- Claude はプロジェクト作成・billing 変更を行わない（Protected Scope）。

## 解除済み

（なし）
