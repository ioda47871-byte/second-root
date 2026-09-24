# AI Workflow — Development Claude / Operational Claude

> 新しい Claude session は前 session の会話記憶を前提にしない。
> **このリポジトリ内の永続資料だけから現在地を復元する。**

## 1. 役割

| 役割 | やること | やらないこと |
|---|---|---|
| Development Claude | コード / テスト / CI / PR / `.ai/` 更新 | Production data・secret 操作、main 直接 push、Protected Scope の単独変更 |
| Operational Claude | 日々の店舗探索と ingest API への提出のみ | DM・メール送信、Supabase 直接書き込み、コード変更、DNC 変更、成約状態変更 |
| 人間（管理者） | 送信、返信記録、DNC 解除、承認、main merge、secret 設定 | — |

## 2. Session 開始時の確認手順（必須）

1. `CLAUDE.md` / `AGENTS.md`
2. `docs/MVP_SPEC.md`
3. `docs/ARCHITECTURE.md`（必要に応じ `docs/SECURITY.md`）
4. `.ai/tasks.json`
5. `git status` / `git log` / `git fetch` でリモートとの差分
6. `.ai/progress.md`
7. `.ai/blockers.md`
8. CI（対象 PR の GitHub Actions 結果）

判断:
- `in_progress` の Task があれば、その branch を fetch して**再開**する。
- なければ `depends_on` がすべて `done` の `ready` Task を priority 順に選ぶ。
- 進められる Task が残る限り「次は何をしますか？」と人間に聞かない。
- `blocked` の Task は `.ai/blockers.md` の解除条件を確認し、解除されていなければ飛ばす。

## 3. Task 管理（`.ai/tasks.json` が正本）

必須フィールド: `id, title, status, priority, depends_on, purpose, acceptance_criteria, required_tests, allowed_scope, forbidden_scope, human_approval_triggers, attempts, last_failure`

status: `backlog` / `ready` / `in_progress` / `review` / `done` / `blocked`

- 着手時: `in_progress` にして commit + push（他 session が同じ Task を拾わないように）。
- 失敗時: `attempts` を増やし `last_failure` に要約を書く。3回失敗したら `blocked` にし `.ai/blockers.md` に記録。
- 人間の操作待ち（merge・secret 設定等）でも `blocked` を使う。その場合は `blocked_reason` に `.ai/blockers.md` の ID と解除条件を書く。
- PR 作成後: `review`。merge 後: `done`。
- `tasks.json` の構造は `tests/unit/ai-tasks.test.ts` が CI で検証する。

### 自分で追加 Task 化してよいもの
明確な bug / test failure / CI failure / 実運用 incident / MVP 仕様との明確な乖離 / 完成を妨げる技術負債 / 再開性・永続化上の明確な欠陥。

### 勝手に追加してはいけないもの
新機能 / MVP 範囲拡大 / 有料サービス / 大規模 refactor / product 方向転換 / major infrastructure 追加。

## 4. Git 戦略

```
main      ← 人間承認でのみ merge（直接 push 禁止）
  ↑
develop   ← Claude が条件付きで自律統合
  ↑
feature/<task-id>-<slug>   1 Task = 1 branch = 1 PR
```

feature → develop の自律 merge 条件（すべて満たすこと）:
- 必須 CI 成功
- Fresh Reviewer PASS（別 context の reviewer による review。結果を `.ai/reviews/<task-id>.md` に保存）
- Critical / High = 0
- Protected Scope の変更なし
- 必要な integration 条件の達成

develop → main は人間承認必須。

> BOOT-001 は例外として main 向け PR（人間が merge）。merge 後に人間が `develop` を作成する。

## 5. 耐障害性ルール（Claude container は作業場所であり正本ではない）

1. 重要なコード・仕様・Task 状態・進捗を container だけに長時間置かない。
2. 意味のある小さな完成単位で commit → push。「最後に1回 push」は禁止。
3. feature branch は作成直後に remote へ push する。
4. push のたびに `.ai/progress.md` の現在地を更新する。
5. 設計/実装判断のたびに「**このセッションが今消えても、別環境から続きができるか？**」を確認する。
6. Secrets を commit しない（`npm run check:secrets` が CI で検査）。
7. 営業候補・営業ログ・run 状態の正本は Supabase。
8. 不要なインフラを増やさない（GitHub + Supabase で完結させる）。

## 6. Claude 障害時の復旧（Windows ローカル等）

通常運用の主役にはしないが、逃げ道として以下で再開できる。

```bash
git clone https://github.com/ioda47871-byte/second-root.git
cd second-root
git fetch --all
git checkout <作業中 branch>      # .ai/progress.md に記載
npm ci
npm run lint && npm run typecheck && npm test && npm run build
# DB を触る Task の場合（DEV-001 以降）
npx supabase start               # Docker が必要
```

その後 `.ai/progress.md` と `.ai/blockers.md` を読み、続きから作業して push する。

## 7. Protected Scope（Claude 単独で適用しない）

Production data / Production secrets / main 直接 push / Production release / Domain・DNS / billing / 契約・API 規約同意 / RLS・security 弱体化 / CI required check 削除・弱体化 / Branch protection 弱体化 / test 無効化 / 品質基準引き下げ / MVP 重大変更 / major framework 変更 / 大規模基盤変更 / 復元不能なデータ削除。

必要な場合は **変更案・理由・影響・rollback** を `.ai/blockers.md` と PR に書き、人間承認を待つ。

## 8. テスト方針

| 層 | 内容 | 実行 |
|---|---|---|
| static | ESLint / TypeScript / secret scan | `npm run lint` / `npm run typecheck` / `npm run check:secrets` |
| unit | dedupe, channel eligibility, DNC, limits, state machine, demo expiry, mailto, DM, URL validation | `npm test`（Vitest, `tests/unit/`） |
| integration | ingest API, token auth, runId idempotency, batch cap, DNC, duplicate, unknown website, schema, DB/RLS | `npm run test:integration`（ローカル Supabase。DEV-001/003 で追加） |
| e2e | 既存サイト regression, admin, 今日の一覧, DM/Email UX, 送信済み, reply→meeting→won/lost, mobile | `npm run test:e2e`（Playwright, `tests/e2e/`） |

- 自動テストから実店舗へ Email / Instagram を**絶対に送らない**（テストデータは `example.com` / 架空アカウントのみ）。
- テスト失敗時に skip / 削除 / required check 解除 / 基準引き下げで green にしない。

## 9. Operational Claude run の原則（DEV-015 で詳細化）

- 実行基盤: Claude Cloud scheduled job を第一候補。
- 持つ secret は `SALES_AGENT_INGEST_TOKEN` のみ。
- 各 run は UUID の `runId` を生成し、同じ `runId` で工程ごとに checkpoint を送る。
- 失敗時は有料 API へ切り替えず、`failed` として理由を記録し人間に報告する。
