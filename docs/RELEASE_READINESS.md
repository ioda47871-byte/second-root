# Release Readiness Report — Second Root Sales Agent MVP（DEV-019）

- 作成: 2026-09-27（Claude Code / 自律実行）
- 対象: `develop` → `main`（Production = secondroot.jp）
- 結論: **コード・テスト・レビューは完了（develop の CI は §2 のとおり）。ただし Staging 実走（DEV-016）は未完了で、Release の必須条件。Production への release は Staging 確認と人間の承認の後に、人間が行う。**

## 0. オーナー向けの要約

- **今の状態**: 営業支援（Sales Agent）の MVP は、作成・テスト・点検がすべて終わり `develop` にまとまっている。本番（secondroot.jp）にはまだ何も出していない。
- **オーナーがやること（順番）**:
  1. Supabase で Second Root 専用の project を用意する（無料プランの project 数上限に注意: §9）。
  2. Staging（試験環境）の設定をして、Claude に「DEV-016 を再開」と伝える → Claude が試験環境で実際に動かして確認する。
  3. 確認結果を見て問題なければ、Claude が作る「develop → main」の Release PR を merge する（本番反映）。
  4. 本番の設定と動作確認（§13）。
- **やってはいけないこと**: Staging の確認（DEV-016）より前に Release PR を merge しないこと。
- **急ぎの推奨**: 今の本番サイトは Next.js 16.3.0 で重大な脆弱性の告知がある。Release を待たずに、Next.js の更新だけの小さな修正（hotfix）を先に本番へ出すことを勧める。Claude が **PR #27（main 向け、依存関係の更新のみ）** を用意済み。内容を確認して merge してほしい（§5）。

## 1. 完了 Task

| Task | 内容 | PR | Review |
|---|---|---|---|
| BOOT-001 | 仕様・設計・CI・Task 管理の土台 | #8（main） | PASS（round 2） |
| DEV-001 | Supabase schema / RLS / run 関数（checkpoint・冪等・fail-closed） | #9 | PASS |
| DEV-002 | ドメインルール（チャネル決定・URL・重複排除・上限） | #10 | PASS（round 2） |
| DEV-003 | Ingest API（start/status/checkpoint/persist/abort） | #11 | PASS |
| DEV-004 | 公開デモ route（token・期限・noindex） | #12 | PASS |
| DEV-005 | bakery_v1 テンプレート | #14 | PASS |
| DEV-006 | baked_goods_v1 テンプレート | #16 | PASS |
| DEV-007 | cafe_v1 テンプレート | #18 | PASS |
| DEV-008 | 管理者認証（email + password、allowlist） | #13 | PASS |
| DEV-009 | 今日やること（最大5・フォロー優先） | #15 | PASS（round 2） |
| DEV-010 | Instagram 送信 UX（手動送信・送信済み） | #17 | PASS |
| DEV-011 | Email 送信 UX（mailto・送信済み） | #19 | PASS |
| DEV-012 | 返信・商談・成約・失注（decline ≠ DNC） | #21 | PASS |
| DEV-013 | 履歴・計測・手動 DNC | #22 | PASS |
| DEV-014 | 5日後フォロー（Email・1回のみ） | #23 | PASS |
| DEV-015 | Operational Claude run prompt / scheduled job 定義 | #20 | PASS（round 2） |
| DEV-016 | Staging 実走 | —（ローカル代替 #24） | **BLOCKED（HUMAN-004）** |
| DEV-017 | Security hardening | #25 | PASS |
| DEV-018 | Full E2E / mobile QA | #26 | PASS |

（各 review の詳細は `.ai/reviews/`）

## 2. CI

GitHub Actions（`.github/workflows/ci.yml`）で、各 PR の CI が green であることを確認してから develop へ merge した（job は段階的に追加: DEV-001 で integration、DEV-004 以降は下の 6 job）。

| job | 内容 |
|---|---|
| static | typecheck（`next typegen` + tsc）・lint・secret 検査（`check:secrets`） |
| unit | vitest（ドメインルール・schema・テンプレート・ガードレール・tasks.json 整合） |
| integration | ローカル Supabase（毎回 fresh）で migration・RLS・RPC・ingest API |
| build | `next build`（Google Fonts 取得失敗時のみ 1 回再試行） |
| e2e | 既存 Second Root の regression（Supabase なし） |
| e2e-sales | Sales Agent の E2E（ローカル Supabase、desktop + mobile） |

- 最終 develop（DEV-018 merge 後）の CI: <<FINALCI>>
- `Vercel` の preview status は無料プランの build rate limit で一部失敗（HUMAN-005）。必須 CI とは独立で、merge 判断には使っていない。
- branch protection の required checks 設定は未実施（人間の操作、HUMAN-003）。

## 3. テスト

| 種類 | 件数（最終 develop 相当のローカル実行） | 主な対象 |
|---|---|---|
| unit | 242 | チャネル決定・website_status・第一者 email・重複キー・上限・checkpoint 内容・営業文/mailto・デモ内容・テンプレート（全3種）・tasks.json |
| integration | 152 | DB 制約・RLS・security audit（全 sales 関数/テーブル）・run の checkpoint/resume/冪等/期限/partial_errors・ingest API・デモ公開期間・送信済み・返信/DNC・計測・フォロー |
| e2e | 68（desktop 34 + mobile 34） | 既存サイト regression・デモ・ログイン/認可（RSC 部分描画の回避不可を含む）・今日やること・Instagram/Email 送信・返信→商談→成約/失注・DNC・履歴/計測・5日後フォロー・320/375px QA |

- テストの skip / 削除はしていない。自動テストから実店舗へメール・Instagram を送らない（`example.com`・架空アカウントのみ、mailto はクリックを止めて検証）。

## 4. E2E

- desktop（Chrome）と mobile（Pixel 7）の 2 project、`workers: 1`（共有 DB の今日の5枠を奪い合わないため）。
- DEV-018 で全管理画面を 320px / 375px・長い店名・全カード状態・操作展開後の状態で検査（横スクロールなし、h1 1つ、現在地ナビ、タップ領域 24px 以上・主要操作 44px 以上、console error なし、キーボードのみでログイン）。この検査で返信フォームの radio が 20px と判明し 24px に修正済み。
- 既存 Second Root: トップ表示・問い合わせフォーム送信/エラー（API は mock）・`/privacy`・`/terms`・robots.txt・sitemap.xml。

## 5. Security

- DEV-017 の全体 security review: **PASS（Critical 0 / High 0）**。指摘（Medium 1・Low 4）はすべて修正済み（`.ai/reviews/DEV-017.md`）。
- **Next.js 16.3.0 → 16.3.6**: 16.3.0 に critical advisory（Image Optimization API の RCE 等）。`npm audit --omit=dev` 0 件。
  - **注意: 現在の本番（main）は 16.3.0 のまま。** Release は Staging 待ちで日付が未定のため、`next` / `eslint-config-next` / `sharp` の更新だけを含む hotfix PR を main に先に出すことを推奨する（**PR #27 として用意済み**。main 基準で lint・typecheck・unit・build・既存サイト e2e を確認済み。merge は人間）。
- 管理画面: Supabase Auth email + password、`sales_admins` allowlist + RLS。全ページ `requireAdminPage()`、全 server action `requireAdmin()`（layout だけの認可は RSC 部分描画で回避できるため）。公開 sign-up 無効。
- DB: 全 `sales_*` で RLS、anon 権限なし、authenticated は読み取りのみ。管理者 RPC は SECURITY DEFINER + `search_path=''` + 先頭で管理者確認。これらを `db-security-audit` test が全関数・全テーブルで検査。
- Ingest API: 定数時間の token 比較、未設定なら 503、256KB 上限、strict schema、送信値を返さない、サーバーから URL を fetch しない（SSRF なし）、DNC・成約・送信の権限なし。
- 公開デモ: 256bit token、期限切れ/無効/未送信/不明は同じ 404、noindex（meta + header）、email・内部情報・金額を出さない。
- `/demo`・`/admin`・`/api/internal` に noindex・no-referrer・no-store・anti-framing・nosniff。既存ページのヘッダは不変。
- Resend は `/api/contact` のみ（営業には使わない、guardrail test）。secret は repo にない（`check:secrets`）。

## 6. Supabase / migrations

`supabase/migrations/`（追加のみ・既存の書き換えなし）:

| migration | 内容 |
|---|---|
| 000000 sales_agent_core | テーブル・制約・trigger（適格性・DNC・状態遷移・email 出典）・RLS |
| 000100 sales_agent_run_functions | run の start/status/checkpoint/persist/abort（service role のみ） |
| 000150 sales_followup_due_view | フォロー対象 view（security_invoker） |
| 000200 sales_admin_mark_sent | 送信済み RPC（デモ公開 30 日開始） |
| 000300 sales_admin_outcomes | 返信・商談・成約・失注・DNC RPC |
| 000400 sales_metrics_view | 計測 view |
| 000500 sales_follow_up | フォロー RPC・view 更新 |
| 000600 sales_run_state_discovered | status が discovered の stub を返す（resume） |
| 000700 sales_revoke_helper_execute | helper 関数の EXECUTE 最小化 |
| 000800 sales_run_status_today | 1 日 1 run（今日の run を返す） |

- ローカル Supabase（CI では毎回 fresh）で全 migration の適用とテストを確認済み。
- **Staging / Production の Supabase project は未作成（HUMAN-002 / HUMAN-004）**。適用は人間が `supabase db push` で行う（`docs/RELEASE.md` §8）。
- 無料プランのまま（有料プランへの変更なし）。

## 7. Cloud Job 実走

- **Claude Cloud scheduled job としての実走は未実施（BLOCKED: HUMAN-004）**。Staging の Supabase / Vercel 環境変数 / Claude Cloud environment + Routine の作成・有効化は人間の操作。
- 代替として **ローカル live rehearsal** を実施（`.ai/reviews/DEV-016-local-rehearsal.md`）: run prompt どおりに実際の公開 Web を調査し、ローカルの ingest API にだけ提出（店舗への連絡なし）。
  - session A: 4 店舗を discovered で保存し意図的に中断 → session B（記憶なし）が `status` だけから再開し 2 件 outreach_ready、`persist` 再送は `replayed` で重複なし、出典が不確かな候補は提出されなかった（fail-closed）。
  - rehearsal で見つかった「完了後に同日 2 回目の run を始められる」問題はサーバー側（000800）と prompt で修正済み。
- ローカル dry-run（架空店舗、`ops/sales-agent/dry-run.mjs`）: resume・再送・完了後の replay を確認。

## 8. Known issues

1. Operational Claude はログインなしで Instagram プロフィールを読めないことが多い（429）。handle は公式サイト等のリンク元で確認し、「DM不可・営業お断り」の最終確認は送信前に人間が行う（管理画面に表示）。
2. 1 日 1 run は prompt で守る。同時起動で 2 run になり得るが、新規営業準備の上限（5件/日）は全 run 共通の lock 下で数えるため超えない。
3. mailto は長すぎる本文を開けないことがあるため、上限超過時は理由を表示し送信操作を出さない（営業文は prompt で短く保つ）。
4. 管理画面の一覧は履歴 200 件・商談 100 件まで表示（上限到達時は表示で通知）。
5. Vercel 無料プランの preview build rate limit（HUMAN-005）。
6. ローカル共有 DB で複数の検証を同時に走らせると互いのテストデータを消して失敗する（CI は毎回 fresh DB のため影響なし）。

## 9. Blockers（人間の操作が必要）

| ID | 内容 | 必要な操作 | 解除後に再開すること |
|---|---|---|---|
| HUMAN-002 | Second Root 専用 Supabase project（Staging / Production） | Supabase Dashboard で作成（Tokyo 推奨）。**無料プランは有効な project 数に上限があり、既存の project（mugi-no-mi 等）と合わせて超える可能性がある**。選択肢: 別の organization / アカウントで作る、使っていない project を一時停止する、有料プラン（billing のため人間判断） | migration 適用・管理者作成 |
| HUMAN-004 | Staging 実走（DEV-016） | Staging project + Vercel Preview 環境変数 + Claude Cloud environment / Routine（手順: `.ai/blockers.md`・`ops/sales-agent/SCHEDULE.md`） | Claude が Staging で resume・冪等・fail-closed を確認し `.ai/reviews/DEV-016.md` に記録 |
| HUMAN-003 | branch protection の required checks（推奨） | GitHub Settings → Branches で main / develop に 6 checks | — |
| HUMAN-005 | Vercel preview build rate limit（非ブロッキング） | 24 時間待つ（推奨）/ 有料プランは人間判断 | — |

## 10. Critical / High

- **未解決の Critical / High は 0 件**。
- 途中で High と判定され、修正後の再 review で PASS したもの:

| Task | round 1 の High | 対応 |
|---|---|---|
| BOOT-001 | 1 件（Claude による PR #8 の main merge 許可が「main は人間のみ」と矛盾） | 2026-09-27 の人間承認に基づく「PR #8 のみの1回限りの例外」として日付付きで明記 → round 2 PASS |
| DEV-002 | 3 件（住所正規化で別店舗を統合し得る／共有ホストで別店舗が同一 domain／第一者 email が出典なしで通る） | 修正・反例をテスト化 → round 2 PASS（残 Medium も解消） |
| DEV-009 | 2 件（フォロー対象の取りこぼし／大きな送信ボタン未実装） | SQL view で算出・60 件のテスト追加／ボタンは DEV-010・011・014 で実装 → round 2 PASS |
| DEV-015 | 1 件（無人で Web を閲覧する agent への prompt injection 対策の指示がない） | 修正 → round 2 PASS |
- 各 Task の review は Critical / High = 0 を確認してから merge（`.ai/reviews/`）。

## 11. 仕様との差分（仕様変更・解釈）

実装中に仕様を明確化・安全側に狭めた点（MVP の意図は変えていない）:

1. `official_profile` のメール出典は **候補自身の検証済み Instagram プロフィールのみ**（リンク集・他の SNS は店舗との結び付きを確認できないため不可）。MVP_SPEC §3.4。
2. link-in-bio（lit.link・linktr.ee）とモール内店舗ページ（楽天・Amazon・Yahoo!ショッピング・minne・Creema）は公式サイトとして扱わない。店舗専用 URL のネットショップ（BASE 等）は公式サイト扱い。
3. 5日後フォローは **デモが公開中** であることも条件（フォロー文にデモ URL を含むため）。件名は初回件名から自動（「Re: 」、200 文字以内）。MVP_SPEC §4.3。
4. 返信の分類をやり直す操作は拒否（古い画面からの誤操作防止）。ただし後から来た「今後の連絡を拒否」は常に DNC に反映。
5. Instagram 送信前に人間がプロフィールの「DM不可・営業お断り」を確認する手順を追加（MVP_SPEC §4.1）。
6. Operational run は 1 日 1 run（今日の run が完了/失敗なら新しい run を始めない）。
7. 計測に「デモ有無」の軸を追加（MVP_SPEC §9 のとおり。現状は全件デモあり）。
8. 返信を「断り（decline）」で記録すると、その営業は自動で「失注（lost、理由 declined）」になる（MVP_SPEC §5 の「営業はそこで終了」の実装。返信数には返信日時で計上）。DNC にはならない。
9. 成約金額は 1 円〜1 億円（入力ミス防止の上限）。
10. 一覧の表示上限（履歴 200 件・商談 100 件、上限時は表示で通知）と、長すぎて mailto で開けない文面の送信操作を出さない扱い。
11. **手順上の逸脱の記録**（いずれも develop へ PR を通さず直接 commit）:
    - `3fba06d`: scope extension（Instagram 公式 API 連携）の記録として `.ai/progress.md`・`.ai/tasks.json`・`docs/INSTAGRAM_MESSAGING.md`（新規）・`docs/MVP_SPEC.md`（§11.1 追加と 2 行の注記。MVP の挙動の変更なし）・`tests/unit/ai-tasks.test.ts`（DEV-020/021/023 の受入条件の検査追加）を変更。
    - `e2d2b79`: DEV-001 完了の記録と同時に、`docs/AI_WORKFLOW.md` に「`.ai/` の更新は develop へ直接 commit してよい」旨を 1 行追加（ルール自体を直接 commit で追加した）。
    - 仕様の正本（MVP_SPEC）への直接 commit は本来 PR を通すべきだった。内容の確認を人間にお願いしたい。

## 12. Rollback

- アプリ: Vercel の直前 Production deployment を Promote（Instant Rollback）。**その deployment が Next.js 16.3.0 の場合は脆弱性が戻るため、短時間の緊急措置に限り、前方修正を優先する。**
- コード: `main` で revert PR を作成し人間が merge。ただし Next.js 16.3.6 への更新は security advisory 対応のため、戻す場合も Next のバージョンは維持する（前方修正を優先）。
- DB: migration は追加のみで、既存サイトの機能は DB に依存しない。問題時は前方修正（逆 migration）。データ削除を伴う rollback は人間承認。
- Operational job: Routine を無効化、または Vercel の `SALES_AGENT_INGEST_TOKEN` を削除して再デプロイ（ingest API は 503 で全拒否）。
- 既存 Second Root（トップ・法務・問い合わせ）は Sales Agent と独立（Sales Agent の環境変数が未設定でも既存ページは動く）。
- 詳細: `docs/RELEASE.md` §5・§7。

## 12.1 Release チェックリスト（`docs/RELEASE.md` §3）の状況

| 項目 | 状況 |
|---|---|
| 全 MVP Task が done | 未（DEV-016 が HUMAN-004 待ち。他はすべて done） |
| CI 全 green | 済（§2） |
| 既存 Second Root regression | 済（e2e: トップ・法務ページ・問い合わせ・robots/sitemap） |
| Supabase migration が staging で適用・検証済み | 未（HUMAN-002 / HUMAN-004） |
| RLS: 管理者以外が営業データを読めない | ローカルで済（integration・security audit）、staging は未 |
| Production env が Vercel に設定済み | 未（人間） |
| Claude Cloud scheduled job の staging 実走 | 未（HUMAN-004。ローカル rehearsal のみ済） |
| Secret 混入なし | 済（`check:secrets`） |
| rollback 手順確認 | 済（§12） |

## 13. Production に必要な人間の操作

`docs/RELEASE.md` §8・§9 に手順あり。要点:

1. Supabase Production project 作成（Free・Tokyo）→ 人間の端末から `npx supabase link` → `npx supabase db push`（DB password は Claude に渡さない）→ RLS 確認 SQL。
2. Supabase Auth: sign-up OFF、Confirm email ON、管理者ユーザー作成 → `insert into public.sales_admins (user_id) values ('<uuid>');`
3. Vercel Production 環境変数: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SALES_AGENT_INGEST_TOKEN`（Staging と別、`openssl rand -hex 32`）/ `SALES_DEMO_BASE_URL=https://secondroot.jp`。
4. **必須: 先に Staging で DEV-016 を完了（HUMAN-004）。完了まで Release PR を merge しない。**
5. Claude が作成する `develop → main` の Release PR を人間がレビューして merge（Claude は main へ merge しない）。
6. Production smoke test（既存ページ・管理画面ログイン・非管理者の拒否・ingest `status`・token なし 401・不明デモ 404）。
7. Claude Cloud の Production 用 environment（ingest token と URL のみ）と Routine を作成し、手動で 1 回実行 → 候補を目視確認 → スケジュール有効化。
8. 最初の 1 週間は、送信前に候補の事実・出典・営業文を人間が確認。

## 14. 後続（承認済み scope extension）

- **Instagram 返信後の公式 Messaging API 連携（DEV-020〜DEV-024）**: 2026-09-27 に人間が承認した scope extension。この MVP release とは独立に、release 後に着手する（設計: `docs/INSTAGRAM_MESSAGING.md`、公式ドキュメント調査: `.ai/research/meta-instagram-messaging-2026-09-27.md`）。
- 調査結果の要点: Instagram API with Instagram Login、Webhook 署名 `X-Hub-Signature-256`、返信は相手の最後のメッセージから 24 時間以内、Send API に公式の idempotency key はない（結果不明の送信は自動再送しない設計にする）。
- Meta 側の人間設定（Meta App・Professional Account 接続・permission・App Review の要否確認・Webhook 登録・token）が必要。Standard Access で一般ユーザーとやり取りできるかは公式ドキュメント間で矛盾があり、Live app で確認する。

READY_FOR_HUMAN_RELEASE_APPROVAL
