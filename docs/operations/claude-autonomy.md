# Second Root — Development Claude 自律進行ルール

> 目的: 「CI/レビューの通知待ちで何時間も止まる」を防ぎ、許可済みの開発を人間承認の境界まで確実に進める。
> 本書は `docs/AI_WORKFLOW.md`、`.ai/tasks.json`、`.ai/blockers.md` に**追加する運用ルール**。既存のセキュリティ・権限・レビュー・CI・品質基準を緩めない。

## 1. 原則

- **承認済みの現在の Task / スコープ内**では、調査 → 最小実装 → テスト → 修正 → Fresh Review → 最新HEADのCI確認 → 条件付き feature→develop マージ → develop反映確認 → `.ai/` の状態更新まで、原則として都度質問せず進める。
- 必要のない「次は何をしますか？」を挟まない。レビューで見つかった問題を直し、必要な再確認を済ませたら次へ進む。無関係な機能追加や無制限のリファクタリングはしない。
- GitHubの **feature→develop** 自律マージは `docs/AI_WORKFLOW.md` §4 の全条件を満たす場合のみ。**develop→main は必ず人間承認**。
- このルールは、個別の承認ゲート（例: HUMAN-017・HUMAN-018）の承認を**意味しない**。

## 2. CI / 外部確認の待ち方（再発防止）

1. push 後、対象PR番号・**最新head SHA**・開始時刻・必要なcheck・Fresh Reviewの対象SHAを記録。
2. 通知イベントだけに依存しない。セッションが実行可能であれば、約5分後にGitHub Actions/check-runを**直接照会**し、未完了なら約10分ごとに再照会する。可能な範囲で待機時間に独立して進められる安全な作業を進める。
3. 途中でpushが増えたら、**最新head SHAの必須CIと必要なFresh Reviewを再評価**。旧SHAの成功を新SHAの成功とみなさない。
4. 最新SHAの必須CIがすべて成功し、必要なFresh ReviewがPASS、Critical/Highが0、競合なし、Protected Scope変更なし、必要なintegration条件達成を確認できたら、追加の問題がない限り自律マージしてdevelopを確認する。
5. checkが失敗したらログを調べて修正する。timeout/infra障害とコード不具合は区別する。テストのskip・閾値引き下げ・チェック解除による「green化」は禁止。
6. **セッション自体が停止したら自力で再開できるとは限らない**。有効な待機実行環境や承認済みのscheduled checkがない場合、「自動的に後で確認する」と約束しない。進捗と次の確認条件をGitHubに残し、利用者に**現時点では自動再開できない**と報告する。
7. 目安として、同じ外部待ちが30分以上続いて解決不能、または確認可能な時間枠を使い切った場合は、沈黙して待ち続けず、未完了の理由と最新状態を明示する。実際に存在しないタイマーやリマインダーを作成済みと主張しない。

## 3. 人間承認まで進める／必ず止める境界

**自律でよい:** 既存Task範囲内のソース・docs変更、テスト、Fresh Review依頼・修正、PR作成、CI確認、条件を満たすfeature→developマージ、進捗の記録、**読み取り専用**の診断、実行コマンド・rollbackの準備。

**実行前に個別の明示承認が必要:**

- `HUMAN-018`: Second RootのWSL上で実Codexにデザイン画像を生成させる操作（ChatGPT利用枠を消費）。`HUMAN-017`: 3店舗比較のWSL実Codex実行。
- Production / Staging / Supabase・DBの書き込み・reset、設計worker / queue / bridge / flag / timerの実行・切り替え、実営業のDM・メール送信。
- develop→mainのマージ・Production公開、secret/credentialの設定や移動、課金や契約、権限・セキュリティ境界の変更。
- `docs/AI_WORKFLOW.md` §7 のProtected Scope、実機設定変更（`.wslconfig`等）、破壊的なファイル掃除・データ削除、不要ブランチ削除、許可範囲外の外部副作用。
- CIやFresh Reviewが不足するマージ、品質ゲートの変更・弱体化。

承認待ちは**勝手に実行しない**。既存の承認済み範囲だけを使い、非破壊な準備を完了してから、**承認対象・コスト/時間上限・副作用・実行コマンド・停止条件・rollback**を提示する。「この運用ルールに同意した」ことを個別承認に読み替えない。

## 4. 作業の現在地と復旧

- 初回と再開時は `docs/AI_WORKFLOW.md` §2 に従って `CLAUDE.md` / `AGENTS.md` / `.ai/tasks.json` / `.ai/progress.md` / `.ai/blockers.md`、PRとCIを確認。
- 作業の意味ある区切りでcommit+pushし、`progress.md`に**Task / branch / PR / 最新SHA / CI / review / 次のアクション**を記録する。featureでは `.ai/progress.md` を直接編集しない既存ルールを守り、規定の方法で更新する。
- 人間の操作待ちは `.ai/blockers.md` のID・解除条件を明示する。権限がない・ツールが使えない・ローカルWSLにアクセスできない場合は、処理したふりをせず具体的な次操作を提示する。
- 既存Task以外に進む場合は `docs/AI_WORKFLOW.md` §3 の新規Task追加ルールを守る。新機能・MVP拡大・有料サービスを自分で決めない。

## 5. 報告フォーマット

- **現在地:** Task、PR、branch、最新SHA、CI（どのSHA）、Fresh Review、マージ状態。
- **完了事項:** 実際に確認した事実のみ。
- **ブロッカー:** `なし / HUMAN-xxx / CI / 実機アクセス / その他` と具体的理由。
- **次の一手:** 自律で続行する操作、または**人が承認する正確な範囲**。
- **影響範囲:** Production / Staging / DB / worker / timer / 送信に触れたか（なければ未変更）。

「作業中」「待っています」だけで終えない。実行できない作業と実行済みの作業を混同しない。

## 6. 本件の具体例

- PR #88 (DEV-074)のコードreview/CIが最新SHAで成功したら、merge条件を確認してfeature→developマージまで進める。
- **HUMAN-018は別途承認が出るまで実行しない**。デザイン画像1枚が生成されるまでは「画像生成済み」と言わない。
- 出力PNGの手動受け渡しが必要なら、`docs/operations/design-image-poc.md`の手順を案内する。デザイン画像→Claude実装→画像比較は**別工程**であり、先回りして自動本番公開しない。
- すでにPRがマージ済みなら、同じレビュー/mergeを繰り返さず次の承認待ちタスクの準備へ進む。

---
本ルールは「継続して勝手に動ける能力」を新たに与えるものではない。**動作可能なセッション内の自律進行**と、停止後にも再開できる永続的な作業記録を定めるものである。
