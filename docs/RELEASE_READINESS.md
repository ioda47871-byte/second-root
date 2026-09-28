# Release Readiness Report — Second Root Sales Agent MVP（DEV-019）

- 作成: 2026-09-27。**最終更新: 2026-09-28**（Staging 実走・DEV-025・Instagram 実装・Production 準備の完了を反映）
- 対象: `develop` → `main`（Production = secondroot.jp）。Release PR: #29（Draft）
- 結論: **コード・テスト・レビュー・Staging 実走（DEV-016）・Production 準備（人間、§13 の 1〜7）は完了。** 残りは Release PR #29 の merge（人間の明示承認）と、merge 後の確認（§13 の 10 以降）。

## 0. オーナー向けの要約

- **今の状態**:
  - 営業支援（Sales Agent）の MVP は `develop` にまとまっている。Staging（試験環境）で、Operational Claude の実走まで確認済み。
  - 本番（secondroot.jp）には、Next.js の脆弱性修正（PR #27、merge 済み）以外は何も出していない。
- **Staging で確認できたこと（2026-09-28、`.ai/reviews/DEV-016.md`）**:
  - Routine の実走で、途中の中断 → 別 session からの再開 → 完了まで動いた。営業準備 1 件、送信なし。
  - 再送しても重複しない。不正なデータは拒否される（400）。
  - token なしでは 401（オーナーが自分の端末で実測）。
  - 2 本目の run は 409 で拒否される（DEV-025）。
- **Production 準備（2026-09-28、オーナーが完了）**:
  - Supabase `second-root-production`（ref `sagjzgcpqcbrqbokawiz`、Tokyo）に migration 16 本を適用し、`staging:verify` で 14/14 PASS。
  - Auth は sign-up OFF・Confirm email ON・パスワード最小長 12。管理者 1 名。確認用の token は Revoke 済み。
  - Vercel Production に 5 変数を設定した。既存の変数は変更なし、`INSTAGRAM_*` は未設定。Standard Protection。
- **残りのオーナー作業**: PR #29 の merge 後に、本番の動作確認 → 本番の Routine（§13 の 10〜12）。
- **Instagram の返信機能（DEV-020〜024）**:
  - コードは実装・テスト・security review 済みで、この Release に含まれる。
  - 実際の Meta アカウントでの確認（HUMAN-006）だけが残っている。
  - Meta の値を設定しなければ機能は無効のまま（Webhook は 503）で、他の機能には影響しない。

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
| DEV-016 | **Staging 実走**（resume・冪等・fail-closed） | #24（rehearsal fixes）・#34・#35・#36・#37（Staging 用スクリプト・権限修正・Vercel bypass 対応） | **done（2026-09-28）**。`.ai/reviews/DEV-016.md` |
| DEV-017 | Security hardening | #25 | PASS |
| DEV-018 | Full E2E / mobile QA | #26 | PASS |
| DEV-020 | Instagram Webhook 受信（署名検証・重複排除） | #30 | PASS |
| DEV-021 | 返信案の保存（Operational Claude・リンク検査） | #31 | PASS（round 3） |
| DEV-022 / 023 | 受信 inbox UI・人間承認後の公式 Send API 送信 | #32 | PASS（round 3） |
| DEV-024 | 保存期間・連携確認・設定手順 | #33 | PASS（コード）。**実アカウント確認は HUMAN-006 待ち（blocked）** |
| DEV-025 | running の run を常に 1 本に（別 runId の start → 409 `run_in_progress`） | #38 | PASS。Staging で実測済み |

（各 review の詳細は `.ai/reviews/`）

## 2. CI

GitHub Actions（`.github/workflows/ci.yml`）の 6 job: `static`（typecheck・lint・secret 検査）/ `unit` / `integration`（ローカル Supabase、毎回 fresh）/ `build` / `e2e`（既存サイト）/ `e2e-sales`（desktop + mobile）。

- 各 PR は CI green と fresh review（Critical / High = 0）を確認してから develop へ merge した。
- develop 先頭 `ddaa622` の CI（run 161）: **全 6 job success**。https://github.com/ioda47871-byte/second-root/actions/runs/36438873755
- branch protection の required checks は未設定（HUMAN-003、推奨）。

## 3. テスト

| 種類 | 件数（2026-09-28、develop） | 主な対象 |
|---|---|---|
| unit | 362 | ドメインルール・schema・テンプレート・ガードレール・Instagram の署名/返信案検査・tasks.json |
| integration | 232 | DB 制約・RLS・security audit・run の checkpoint/resume/冪等/期限/partial_errors・**running run は 1 本（同時 start の race を含む）**・ingest API・Instagram 受信/返信案/送信/保存期間 |
| e2e | 78（Playwright、desktop + mobile） | 既存サイト regression・デモ・ログイン/認可・今日やること・送信・返信→商談→成約/失注・DNC・フォロー・Instagram inbox（API は stub）・320/375px |

- テストの skip / 削除はしていない。
- 自動テストから実店舗へメール・Instagram を送らない（`example.com`・架空アカウントのみ。instagram.com への通信は stub）。

## 4. E2E

- desktop（Chrome）と mobile（Pixel 7）の 2 project で実行。`workers: 1`（今日の 5 枠を奪い合わないため）。
- 全管理画面を 320px / 375px で検査した。項目は、横スクロールなし・タップ領域・キーボード操作・console error なし。
- 既存 Second Root: トップ・問い合わせ（API は mock）・`/privacy`・`/terms`・robots.txt・sitemap.xml。

## 5. Security

- DEV-017 の全体 security review と、Instagram 機能全体の最終 security review は、どちらも **Critical 0 / High 0**。指摘はすべて修正済み。
- **Next.js 16.3.6**:
  - 本番（main）は PR #27（2026-09-27 merge）で 16.3.6 になった。
  - develop も 16.3.6 で、`npm audit --omit=dev` は 0 件。
  - PR #29 の `package.json` / lockfile の衝突は、両方 16.3.6 のため develop 側を採用して解消した（§13 の 0）。
- 管理画面:
  - Supabase Auth（email + password）と、`sales_admins` allowlist + RLS。
  - 全ページ・全 server action で管理者を確認する。公開 sign-up は無効。
- DB:
  - 全 `sales_*` table で RLS が有効。anon は権限なし、authenticated は読み取りのみ。
  - 管理者用 RPC は SECURITY DEFINER + `search_path=''` + 先頭で管理者確認。
  - 新しい Supabase project は API role に table 権限を自動で付けないため、必要な権限を migration `20260928000000` で明示した（Staging で発見）。
- Ingest API:
  - 定数時間で token を比較する。未設定なら 503、不一致・なしは 401（Staging で人間が実測）。
  - 256KB 上限、strict schema。サーバーから URL を fetch しない。
  - DNC・成約・送信の権限はない。
- Instagram:
  - Webhook は `X-Hub-Signature-256` を raw body で検証する。自分のアカウント ID 以外のイベントは保存しない。
  - 送信は人間の承認後だけ。結果が不明な送信は自動で再送しない。
  - Meta の値が未設定なら無効（503）。
- 公開デモ: 256bit token。期限切れ・不明は 404。noindex。
- Resend は `/api/contact` のみで、営業には使わない。secret は repo にない（`check:secrets`）。

## 6. Supabase / migrations

`supabase/migrations/` の 16 本（追加のみ・既存の書き換えなし）:

| migration | 内容 |
|---|---|
| 20260927000000 sales_agent_core | テーブル・制約・trigger・RLS |
| 20260927000100 sales_agent_run_functions | run の start/status/checkpoint/persist/abort |
| 20260927000150 sales_followup_due_view | フォロー対象 view |
| 20260927000200 sales_admin_mark_sent | 送信済み RPC |
| 20260927000300 sales_admin_outcomes | 返信・商談・成約・失注・DNC RPC |
| 20260927000400 sales_metrics_view | 計測 view |
| 20260927000500 sales_follow_up | フォロー RPC |
| 20260927000600 sales_run_state_discovered | status が discovered の stub を返す（resume） |
| 20260927000700 sales_revoke_helper_execute | helper 関数の EXECUTE 最小化 |
| 20260927000800 sales_run_status_today | 1 日 1 run（今日の run を返す） |
| 20260927000900 sales_ig_messaging | Instagram 受信（thread・message・event） |
| 20260927001000 sales_ig_inbox | 返信案・inbox |
| 20260927001100 sales_ig_admin_send | 人間承認後の送信 |
| 20260927001200 sales_ig_retention | 保存期間（会話 180 日・受信記録 30 日） |
| 20260928000000 sales_explicit_api_grants | API role の table 権限を明示（新しい project 用） |
| 20260928000100 sales_single_running_run | running の run は 1 本（partial unique index） |

- **Staging（`znbqgvawublgyjwfpmei`）には 16 本すべて適用済み**。
  - Supabase Management API 経由の `staging:apply`。1 migration = 1 transaction。
  - `staging:verify` の 14 項目がすべて PASS: migration 一致・RLS・権限の過不足・sign-up OFF・管理者 1 名。16 本の適用後、2026-09-28 15:19 UTC に再確認した。
- **Production の Supabase project は未作成**（HUMAN-002）。
- 無料プランのまま。

## 7. Cloud Job 実走（DEV-016、Staging）

- Staging の Routine `second-root-sales-agent-daily-staging` を人間が Run now し、Claude が ingest API と DB を読み取りで確認した。
  - ingest の token と Vercel bypass は、host 限定の API credential で proxy が付ける。
- 結果（`.ai/reviews/DEV-016.md`）:
  - **resume**:
    - session A が `discovered`（2 件）まで進んだところで Claude が中断した。
    - 記憶のない session B が `status` から同じ runId を取り、discover をやり直さずに `verify` → `persist` → `completed` まで進めた。
  - **結果**: `outreach_ready` 1 件（Instagram、下書きのまま・送信なし）。確認できなかった 1 件は提出されなかった。
  - **idempotency**: 同じ runId の `persist`・`start`・`checkpoint` を再送すると `replayed: true` になり、DB に重複はない。
  - **fail-closed**:
    - 不正な payload（未知の項目・`javascript:` URL・対象外の業種・runId の形式違い）は 400 で、何も保存されない。
    - token なしは 401（人間が実測）。
  - **1 日 1 run**: 完了後にもう一度 Run now すると、新しい run を作らずに止まる。
  - **二重 run**: 実行中に別 runId で `start` すると 409 `run_in_progress`、同じ runId は 200 `replayed`（DEV-025 適用後に実測）。確認用の run は abort 済みで、running は 0。

## 8. Known issues

1. Operational Claude は、ログインなしで Instagram プロフィールを読めないことが多い。handle は公式サイト等のリンク元で確認する。「DM不可・営業お断り」の最終確認は、送信前に人間が行う。
2. 中断されて再開されない run は、最大 24 時間、新しい run の `start` を止める（409 `run_in_progress`）。24 時間で自動的に `failed` になる。すぐ止めたい場合は、その runId で `abort` する（RUN_PROMPT §2）。
3. mailto は長すぎる本文を開けないことがある。上限を超えたら理由を表示し、送信操作を出さない。
4. 管理画面の一覧は、履歴 200 件・商談 100 件まで表示する。
5. Instagram の実アカウントでの確認は未実施（HUMAN-006）。
   - Standard Access で一般ユーザーとやり取りできるかは、Meta の公式ドキュメント間で記述が矛盾している。
   - Live app で確認する。

## 9. Blockers（人間の操作が必要）

| ID | 内容 | 状態 |
|---|---|---|
| HUMAN-002 | Production 用の Supabase project | **解除**（2026-09-28。`second-root-production`、16 本適用・verify 14/14 PASS） |
| HUMAN-006 | Instagram の Meta 側設定と実アカウント確認 | 未。**Release の必須条件ではない**（未設定なら機能は無効） |
| HUMAN-003 | branch protection の required checks | 未（推奨） |
| HUMAN-004 | Staging セットアップ | **解除**（2026-09-28。DEV-016 完了） |

## 10. Critical / High

- **未解決の Critical / High は 0 件**。
- round 1 で High と判定され、修正後の再 review で PASS したもの:
  - BOOT-001
  - DEV-002
  - DEV-009
  - DEV-015
  - DEV-021: round 1・2（返信案のリンク検査）
  - DEV-022/023: round 2（前の文面への再試行で draft が送信中のまま残る）
- 詳細は `.ai/reviews/`。

## 11. 仕様との差分（仕様変更・解釈）

実装中に仕様を明確化・安全側に狭めた点（MVP の意図は変えていない）:

1. `official_profile` のメール出典は、候補自身の検証済み Instagram プロフィールだけ。
2. link-in-bio とモール内店舗ページは公式サイトとして扱わない。店舗専用 URL のネットショップは公式サイト扱い。
3. 5 日後フォローは、デモが公開中であることも条件。件名は初回から自動。
4. 返信の分類をやり直す操作は拒否する。後から来た「今後の連絡を拒否」は常に DNC に反映する。
5. Instagram 送信前に、人間が「DM不可・営業お断り」を確認する。
6. Operational run は 1 日 1 run（今日の run が完了 / 失敗なら新しい run を始めない）。**加えて running の run は同時に 1 本だけ（DEV-025、DB で保証）。**
7. 計測に「デモ有無」の軸を追加した。
8. 「断り」を記録すると、その営業は自動で失注（declined）になる。DNC にはならない。
9. 成約金額は 1 円〜1 億円。
10. 一覧の表示上限と、mailto で開けない長さの文面の扱い。
11. **スコープ拡張**: Instagram 公式 Messaging API 連携（DEV-020〜024）。2026-09-27 に人間が承認し、この Release に含めた。
12. **手順上の逸脱の記録**（develop へ PR を通さず直接 commit したもの）:
    - `3fba06d`: scope extension の記録（`docs/MVP_SPEC.md` §11.1 と注記、`docs/INSTAGRAM_MESSAGING.md` の新規作成を含む）。
    - `e2d2b79`: `docs/AI_WORKFLOW.md` に「`.ai/` の更新は develop へ直接 commit してよい」を追加。
    - 内容の確認を人間にお願いしたい。

## 12. Rollback

- **アプリ**: Vercel の直前の Production deployment を Promote（Instant Rollback）する。直前は PR #27 の deployment（Next.js 16.3.6）なので、脆弱性は戻らない。
- **コード**: `main` で revert PR を作り、人間が merge する。
- **DB**:
  - migration は追加のみ。既存サイトは DB に依存しない。
  - 問題があれば前方修正（逆 migration）で直す。データ削除を伴う rollback は人間の承認が必要。
- **Operational job**: 次のどれかで止める。
  - Routine を無効化する。
  - Vercel の `SALES_AGENT_INGEST_TOKEN` を削除して再デプロイする（ingest API は 503 で全拒否）。
  - Claude Cloud の API credential を削除する。
- **Instagram**: Vercel の `INSTAGRAM_*` を削除して再デプロイする（Webhook は 503、送信は不可）。
- 既存 Second Root（トップ・法務・問い合わせ）は Sales Agent と独立している。
- 詳細: `docs/RELEASE.md` §5・§7。

## 12.1 Release チェックリスト（`docs/RELEASE.md` §3）の状況

| 項目 | 状況 |
|---|---|
| 全 MVP Task が done | **済**（DEV-001〜018 と DEV-025。DEV-019 はこの Release 自体。DEV-024 の実アカウント確認は MVP 外） |
| CI 全 green | 済（§2） |
| 既存 Second Root regression | 済（e2e） |
| Supabase migration が staging で適用・検証済み | **済**（16 本、`staging:verify` 14 項目 PASS） |
| RLS: 管理者以外が営業データを読めない | **済**（ローカル integration・security audit と、Staging の実 role で確認） |
| Claude Cloud scheduled job の staging 実走 | **済**（§7） |
| Secret 混入なし | 済（`check:secrets`） |
| rollback 手順確認 | 済（§12） |
| Production の Supabase・Auth・管理者 | **済**（人間、2026-09-28。`sagjzgcpqcbrqbokawiz`、verify 14/14 PASS） |
| Production env が Vercel に設定済み | **済**（人間、2026-09-28。5 変数、Production のみ） |

## 13. Production 準備（人間。**PR #29 を merge する前に**、この順番で）

手順の詳細は `docs/RELEASE.md` §8。

**状況（2026-09-28）: 1〜7 はオーナーが完了した**（§0）。0 は PR #39 で完了した。8〜9 は、オーナーの明示承認に基づき Claude が行う。

**Production の DB・Auth・環境変数への操作は、読み取りの確認も含めてすべて人間が行う。** Claude は Production 用の token を持たない。Supabase の Management API の token は任意の SQL を実行できるため、読み取りだけの確認でも書き込みの権限を渡すことになる。Claude は人間が貼った結果（PASS / FAIL の一覧。secret は含まない）を確認できる。

0. **（Claude）PR #29 の衝突解消**。main（PR #27）を develop に取り込む merge を、PR #39 で行った。両方 Next.js 16.3.6 のため、develop の lockfile を採用した。PR #39 が develop に merge されると、PR #29 の衝突が消える。
1. **Production 用に新しい Supabase project を作る**（HUMAN-002）。Tokyo、Free。
   - Staging の project（`znbqgvawublgyjwfpmei`）は Production に**流用しない**。Staging には次のものが今もつながっているため:
     - develop の Preview の service_role key
     - Staging の ingest token と bypass、Staging の Routine
     - Claude 用の Supabase token
   - 無料プランの有効な project 数の上限に当たる場合は、使っていない project を一時停止する。有料化は人間が判断する。
2. **migration を適用する**（人間の端末）。
   - `npx supabase login` → `npx supabase link --project-ref <prod-ref>` → `npx supabase db push`
   - 16 本すべてを適用する。DB password は誰にも渡さない。
   - 新しい project では `20260928000000`（権限の明示）が必須。途中の migration だけを適用しない。
3. **確認する**（人間の端末）。
   - Production だけに範囲を絞った短期の Supabase access token（`database_read`・`database_write`・`auth_config_read`）を作る。
   - `SUPABASE_ACCESS_TOKEN=<token> npm run staging:verify -- --project-ref <prod-ref>` を実行する。名前は staging だが、どの project でも使える。
   - この時点では「public sign-up is off」「exactly one admin」の 2 項目は FAIL になる（4・5 の後に PASS）。ほかの 12 項目はすべて PASS であること。
   - `RELEASE.md` §8 の SQL だけでは、権限の不足（Staging で見つかった問題）は分からない。
   - 結果の一覧を Claude に貼れば、Claude が確認する。
4. **Auth を設定する**（Dashboard）。
   - Sign In / Providers →「Allow new users to sign up」を OFF。
   - Email の「Minimum password length」を 12 以上。
   - 「Confirm email」は ON のまま。
5. **管理者を作る**（人間）。
   - Authentication → Add user（email + password、Auto Confirm）。
   - SQL Editor で `insert into public.sales_admins (user_id) values ('<uuid>');`。または人間の端末で `staging:admin -- --project-ref <prod-ref> --confirm-ref <prod-ref> --email <email>`。
   - 3 をもう一度実行して、**14 項目すべて PASS** を確認する。
   - 終わったら 3 の token を削除（Revoke）する。
6. **Vercel の Production 環境変数を設定する**。Environment は **Production だけ**。Preview の Staging 用の値とは別。
   - `NEXT_PUBLIC_SUPABASE_URL`: `https://<prod-ref>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: 公開用（anon / Publishable）
   - `SUPABASE_SERVICE_ROLE_KEY`: サーバー用（service_role / Secret）。**Sensitive**。`NEXT_PUBLIC_` を付けない。
   - `SALES_AGENT_INGEST_TOKEN`: 新しく `openssl rand -hex 32`。**Staging と別の値**。Sensitive。
   - `SALES_DEMO_BASE_URL`: `https://secondroot.jp`
   - 既存の `RESEND_API_KEY` / `CONTACT_TO_EMAIL` / `NEXT_PUBLIC_GA_MEASUREMENT_ID` は変えない。
   - `INSTAGRAM_*` はまだ設定しない（HUMAN-006 の後）。
   - 今の本番のコードはこれらの変数を読まないので、merge 前に設定しても既存サイトに影響はない。反映は merge 後のデプロイから。
7. **Deployment Protection を確認する**。
   - 今の設定（`all_except_custom_domains`）では、`secondroot.jp` は保護されない。そのため Production の ingest は bypass なしで届く。
   - `*.vercel.app` の Production URL は保護されたままなので、Routine は必ず `https://secondroot.jp/...` を使う。
8. **merge 前の最終確認**。
   - PR #29 の CI が全 6 job green で、衝突がないこと。
   - （推奨）HUMAN-003 の branch protection。
   - Staging の token の後片付け（`docs/STAGING.md` §8。merge 後でもよい）。
9. **PR #29 を Ready for review にして、人間が merge する**。Vercel が Production にデプロイする。

merge 後（人間）:

10. **Smoke test**（`docs/RELEASE.md` §8 の 4）。
    - 既存ページを確認する。
    - 管理者でログインできることを確認する。
    - 一時的な非管理者で拒否されることを確認し、確認後にそのユーザーを削除する。
    - ingest `status` が `{"run":null,...}` を返すことを確認する。
    - token なしで 401、不明なデモで 404 になることを確認する。
11. **Production の Routine**。
    - Staging とは別の Claude Cloud environment を作る。
      - 環境変数は `SALES_AGENT_INGEST_URL=https://secondroot.jp/api/internal/sales-agent/runs` だけ。
      - API credential は host `secondroot.jp` に限定し、`Authorization: Bearer <Production の ingest token>` だけを登録する（bypass は付けない）。
    - Routine を作り、手動で 1 回実行する → 管理画面で候補を目視確認する → スケジュールを有効化する。
12. 最初の 1 週間は、送信前に候補の事実・出典・営業文を人間が確認する。
13. （任意・後日）Instagram（HUMAN-006）: `docs/INSTAGRAM_SETUP.md`。推奨は Staging で確認してから Production。

READY_FOR_HUMAN_RELEASE_APPROVAL
