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
- 店舗サイトのデザインでは、Second Root の規則が公式スキルより優先する。事実パックと Identity Lock (店舗の事実を作らない)、B方式 (`B_html_prototype`) の JS・通信・書体・アセットの制約、実装レーンの CSS と書体の許可一覧を、公式スキルの提案 (動き、Web フォント、画像) で緩めない。店舗デザインの手順は `second-root-design-director` スキル (DEV-133、PR #170) に従う。

## デザイン研究ループ (Issue #302 P5)

- オーナーとのデザイン研究（「改善して」「成功例として保存」「不採用」「次の店へ」「続きから」）は `second-root-research-loop` スキルに従う。
- デザイン研究を続ける session では、最初に `node --import tsx scripts/design-research/research.ts status` で前回の続き（店・段階・次の作業・オーナー待ち）を読む。履歴の正本は `design-library/research-log/`（メタデータのみ。画像は `~/sr-runs` の非公開の場所に残す）。
- 研究ログへの記録は承認ではない。画像生成・承認 ID の発行と消費は既存の承認ルールのまま。

## コマンドの書き方（オーナーの承認画面を増やさない。Issue #302）

- ソースや JSON の編集は専用の Edit / Write ツールで行う。`sed -i`・`node -e`・ヒアドキュメントでファイルを書き換えない。
- 計算・編集・検証を1つの長い Bash にまとめない。1コマンド1目的で、`$(…)` の入れ子や `&&` の長い連鎖を避ける。
- ハッシュやピンは用意された読み取り専用の CLI で出す（例: `scripts/design-artifact/image-first-prompt.ts --direction <d> --print-direction-sha` / `--print-pin`）。その場限りのスクリプトを書かない。
- 新しい作業ツリーは、許可設定に入っている場所（`~/work/sr-research-dev` など、`.claude/settings.local.json` の `additionalDirectories`）に置く。入っていない場所への書き込みは Auto でも承認を求められる。
- 許可設定（`~/.claude/settings.json`・`.claude/settings.local.json`）を Claude が自分で変えない。変える必要があればオーナーに一度だけの手順を出す。
