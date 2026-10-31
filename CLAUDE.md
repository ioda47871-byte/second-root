@AGENTS.md

## Second Root Sales Agent

Sales Agent（営業支援 MVP）の開発では、session 開始時に `docs/AI_WORKFLOW.md` §2 の手順で
`docs/MVP_SPEC.md` → `docs/ARCHITECTURE.md` → `.ai/tasks.json` → `.ai/progress.md` → `.ai/blockers.md` を確認してから作業する。
重要な成果は小さな単位で commit + push し、Claude の container を正本にしない。

実機（WSL）で full unit suite・Chromium・design worker・Codex などの重い処理を始める前は、
`docs/operations/wsl-resource-preflight.md` の実機 resource preflight（`scripts/ops/wsl-resource-preflight.sh`）を行う。
突然 `Killed` されたら修正ループに入る前に OOM-kill を確認し、OOM なら resource failure として止まる。
`%USERPROFILE%\.wslconfig` は人の承認なしに変えない。

## 自律進行と待機ルール（必読）

Development Claude は `docs/operations/claude-autonomy.md` に従う。
CI・レビューの通知待ちだけで無期限停止せず、実行可能な間は最新PR head SHAを自ら照会する。
条件を満たす feature → develop は自律マージするが、`docs/AI_WORKFLOW.md` のレビュー・CI・Protected Scope条件を守る。
HUMAN-017 / HUMAN-018、Production・Staging・DB・worker・timer・実営業・削除等の個別承認は、**本ルールでは付与しない**。

## デザインのスキル (DEV-132)

- `.claude/skills/frontend-design/` は Anthropic 公式 `frontend-design` v1.1.1 の無改変の写し (Apache 2.0、出典は同じ場所の `PROVENANCE.md`)。
- 店舗サイトのデザインでは、Second Root の規則が公式スキルより優先する。事実パックと Identity Lock (店舗の事実を作らない)、B方式 (`B_html_prototype`) の JS・通信・書体・アセットの制約、実装レーンの CSS と書体の許可一覧を、公式スキルの提案 (動き、Web フォント、画像) で緩めない。店舗デザインの手順は `second-root-design-director` スキルに従う。
