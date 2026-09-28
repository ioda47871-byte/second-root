# Progress

> 新しい session はまずここと `.ai/tasks.json`・`.ai/blockers.md` を読む（手順: `docs/AI_WORKFLOW.md` §2）。
> push のたびに「現在地」を更新する。

## 現在地

- 完了（develop merge 済み）: BOOT-001（main）、DEV-001, 002, 003, 004, 005, 008, 009
- レビュー / CI 中: DEV-006（PR #16）
- 実装済み・PR 前（stacked）: DEV-007（`feature/dev-007-cafe-template`, DEV-006 上）、DEV-010 → DEV-011 → DEV-012（`feature/dev-010-instagram-send` → `…-011-email-mailto` → `…-012-reply-outcomes`）
- 次: DEV-013（履歴・集計）、DEV-014（フォロー）、DEV-015（Operational Claude prompt）、DEV-016（staging 実走・人間の Supabase 必要）、DEV-017〜019
- 自律実行ルール: feature → develop は CI green + Fresh Review Critical/High 0 で Claude が merge。develop → main（Production release）は人間承認。
- ローカル再開: `dockerd &`（cloud container）→ `npx supabase start` → `npm run test:integration` / `npm run build && npm run test:e2e`
- 注意: ローカル Supabase は全 worktree 共有。レビュー中は `supabase db reset` しない。feature ブランチでは progress.md を編集しない（develop の記録コミットのみ）。

## BOOT-001 チェックポイント

- [x] 既存 main 調査（Next.js 16.3 / React 19.2 / Resend 問い合わせ / テスト・CI なし / open PR なし）
- [x] docs/ と .ai/ の作成 → push
- [x] test foundation（Vitest unit + Playwright 既存サイト smoke + secret scan）→ push
- [x] CI（GitHub Actions: static / unit / build / e2e）+ PR template → push
- [x] PR 作成（https://github.com/ioda47871-byte/second-root/pull/8）・CI 確認・Fresh Review PASS（.ai/reviews/BOOT-001.md）

## 調査メモ（BOOT-001, 2026-09-24）

- main HEAD: a926acf（PR #7 merge）。open PR なし。
- 既存に `.github/`・テスト・CI なし。`playwright`（1.62.1）は `scripts/*.mjs` の手動確認用に導入済み（`@playwright/test` は未導入）。
- `tsc --noEmit` 単体では `LayoutProps` 未定義で失敗する。`next typegen` で型生成してから tsc を走らせる必要あり → `npm run typecheck` で対応。
- `npm run lint` / `npm run build` は main で成功。
- `.env.local.example`: RESEND_API_KEY / CONTACT_TO_EMAIL / CONTACT_FROM_EMAIL / NEXT_PUBLIC_INSTAGRAM_URL / NEXT_PUBLIC_BROT_YANAGI_URL。
- `app/layout.tsx` に固定 JSON-LD の `dangerouslySetInnerHTML` あり（既存・対象外）。

## 履歴

- 2026-09-24: BOOT-001 開始。docs / .ai を追加。
- 2026-09-24: test foundation 追加（vitest ~4.0.18 ※4.1 系は npm 10 で `edgesOut` エラー、5 系は @types/node ^20 と peer 衝突のため / @playwright/test 1.62.1 は既存 playwright と同版）。
- 2026-09-24: CI（.github/workflows/ci.yml）と PR template を追加。
- 2026-09-24: CI run #1 で e2e job 内の2回目の build が next/font/google の Google Fonts 取得（外部）で失敗（同コミットの build job は成功）。build を1回にし e2e は `.next` artifact を再利用する構成に修正。
- 2026-09-24: Fresh Review PASS。Medium 3件・Low 3件を反映。BOOT-001 を done に更新。
- 2026-09-27: 耐障害性補強を開始。ARCHITECTURE §5/§7（action 設計・phase/stage・nextAction・多重重複防止・候補単位 transaction）、MVP_SPEC §3.6/§10、AI_WORKFLOW §9、SECURITY §3.1、RELEASE §6 を更新。DEV-001/002/003/015/016 に [checkpoint]/[resume]/[idempotency]/[fail-closed] 受入条件を追加し、tests/unit/ai-tasks.test.ts で存在を検査。
- 2026-09-27: 耐障害性補強の Fresh Review PASS（Critical/High 0）。Medium 3 / Low 3 を反映（checkpoint を同一 transaction で確定、persist の run 単位直列化、3 回で partial_errors 確定、dedupe→DNC→上限の順、期限切れ run の failed 確定、候補 key 定義）。
- 2026-09-27: PR #8 最終仕様整合（上記4点）を反映。
- 2026-09-27: CI build が Google Fonts（next-font-loader）の外部要因で再発。CI の build を「next-font-loader エラー時のみ1回再試行」に変更（他のエラーは即失敗）。Vercel 側でも起こりうるため known issue として記録。
- 2026-09-27: PR #8 merge（32de89a）、develop 作成。DEV-001 開始。
- 2026-09-27: DEV-001 実装（migrations 2本、integration 55件 green、CI に integration job 追加）→ PR 作成・レビューへ。
- 2026-09-27: DEV-001 Fresh Review PASS（Critical/High 0）。Medium 4件・Low を修正（integration 71件 green）。DEV-002 は PR #10 でレビュー中。
- 2026-09-27: DEV-001 merge（PR #9, b190518）。
- 2026-09-27: DEV-002 merge（PR #10, 843699e）。DEV-003 実装中（integration 87件 green）。
- 2026-09-27: DEV-003 Fresh Review PASS。Medium 3件（デモへの email 混入・店名/住所の出典一致・第一者 email の自サイト確認）ほか修正。unit 207 / integration 88 green。
- 2026-09-27: DEV-003 merge（PR #11, 7e62223）。
- 2026-09-27: DEV-004 merge（PR #12, d2acecb）。CI に e2e-sales job。
- 2026-09-27: DEV-008 Fresh Review PASS。Medium（layout のみの認可 → RSC 部分描画で回避可能）を全ページ guard + 実遷移ヘッダ再送 e2e で修正。
- 2026-09-27: DEV-008 merge（PR #13, e1ddf9a）。DEV-009 開始。
- 2026-09-27: DEV-005 merge（PR #14, b78bb14）。
- 2026-09-27: DEV-009 review round 1 FAIL（フォロー取りこぼし）→ view sales_followup_due で修正。運用ルール: レビュー実行中は共有ローカル DB を reset しない。
- 2026-09-27: DEV-009 merge（PR #15, 8d4f633）。
- 2026-09-27: DEV-006 merge（PR #16, c9c4a70）。
- 2026-09-27: DEV-010 review PASS（Medium: iOS で await 後の window.open がブロックされうる → タップ内で同期実行 + フォールバックリンク）。merge（PR #17, a04c440）。
- 2026-09-27: DEV-007 PR #18 review PASS（Medium 3: 長い説明文の横はみ出し・重複 key・全テンプレ e2e）→ 修正 push、CI 待ち。
- 2026-09-27: DEV-007 merge（PR #18, 5b9c14c）。
- 2026-09-27: DEV-011 review PASS（Medium: 長文で送信ボタンが黙って消える・メールアプリが開かない時の手段なし → 理由表示・コピー可能な宛先/件名/本文）。merge（PR #19, 70ba4a8）。
- 2026-09-27: DEV-015 PR #20: review round 1 FAIL（High: 無人で Web を閲覧する agent に prompt injection 対策の指示がない）→ 修正、round 2 PASS。status が discovered の stub を返すよう変更（新しい session が記憶なしで verify を再開できる。ARCHITECTURE §7.3 との不整合を解消）。ローカル dry-run OK。
- 2026-09-27: DEV-014 実装（feature/dev-014-followup、DEV-013 の上に stack）。integration 130 / e2e 60 green。
- 運用メモ: e2e・dry-run で起動した next-server が残ることがある。作業後に確認して停止する。
- 2026-09-27: DEV-015 merge（PR #20, a106570）。
- 2026-09-27: DEV-016 は HUMAN-004（Staging Supabase / Vercel Preview env / Claude Cloud Routine は人間の操作）で blocked。ローカルでの代替確認（dry-run・実 Web 調査をローカル ingest に提出する rehearsal）は Claude が実施する。
- 2026-09-27: DEV-012 review PASS（Medium 3: stale tab の再分類が黙って成功・後から来た拒否の記録手段・失注の誤タップ）→ 修正、PR #21 CI 待ち。
- 2026-09-27: DEV-017 着手（feature/dev-017-security）: Next 16.3.0 に critical advisory（Image Optimization の RCE 等）→ 16.3.6 へ更新、sharp 修正、official_profile は店舗自身の Instagram のみ、private route に anti-framing header、helper 関数の EXECUTE を最小化、DB security audit test。
- 2026-09-27: DEV-012 merge（PR #21, 90d8500）。
- 2026-09-27: DEV-013 review PASS（Medium: §9 のデモ有無の軸・各段階の件数と率）→ 修正。merge（PR #22, deccd72）。
- 2026-09-27: DEV-014 review PASS（Medium: RPC が任意の件名・本文を記録できた・長い件名で失敗）→ 件名は SQL で導出、本文はデモ URL と opt-out を必須に。PR #23。
- 2026-09-27: DEV-018 着手（feature/dev-018-e2e-qa、DEV-014 の上）: 320/375px で全管理画面・長い店名・全カード状態、キーボードでのログイン。管理画面の本文を main landmark に。
- 2026-09-27: **scope extension（人間承認）**: Instagram 返信後の公式 Messaging API 連携を後続 Task DEV-020〜DEV-024 として追加（docs/INSTAGRAM_MESSAGING.md）。MVP（DEV-001〜019）を優先し、その後に着手。分類・返信案は有料 API を使わず Operational Claude（scheduled job）が ingest API 経由で作成する設計。
- 2026-09-27: DEV-016 代替のローカル rehearsal: session A（実 Web 調査、4 店舗を discovered）→ 中断 → session B が status から再開中。
- 2026-09-27: DEV-014 merge（PR #23, cb41080）。
- 2026-09-27: DEV-016 代替 rehearsal 完了: session A（実 Web 調査・discovered 後に中断）→ session B（記憶なし）が status から再開し 2 件 outreach_ready、persist 再送は replayed で重複なし。発見: 完了後の status が null で同日 2 run 目を開始できた → PR #24（今日の run を返す migration 000800 + prompt 修正）、review PASS・指摘修正済み。
- 2026-09-27: PR #25（DEV-017 security）・PR #26（DEV-018 mobile QA）作成、review 中。
- 運用メモ: 共有ローカル DB で reviewer と同時に integration を走らせると users / rows が消えて失敗する（interference）。CI（毎回 fresh DB）を正とし、ローカルは reviewer 終了後に再実行する。
- 2026-09-27: DEV-020〜024 事前調査（Meta 公式ドキュメントのみ、`.ai/research/meta-instagram-messaging-2026-09-27.md`）: Instagram API with Instagram Login（`instagram_business_basic` / `instagram_business_manage_messages`）、Webhook は `X-Hub-Signature-256`（raw body の HMAC-SHA256）、再送あり（mid で重複排除）、返信は相手の最後のメッセージから 24 時間以内、Send API に公式の idempotency key はない（結果不明の送信は自動再送しない設計が必要）。Standard Access で一般ユーザーとやり取りできるかは公式ドキュメント間で矛盾 → Live app での確認が必要（HUMAN BLOCKER 候補）。
- 2026-09-27: PR #25（DEV-017）・#26（DEV-018）review PASS、指摘修正済み。DEV-018 の強化テストで返信フォームの radio が 20px（< 24px）と判明 → 24px に修正。
- 2026-09-27: PR #24（rehearsal fixes）merge（424a089）。PR #25（DEV-017）review PASS（Medium: スキーマ単位の default privileges では PUBLIC EXECUTE を外せない → migration ごとの明示 revoke + audit で PUBLIC grant を検出）→ 修正、merge（78976b6）。Vercel preview は build rate limit（HUMAN-005）で失敗するが必須 CI とは独立。
- 2026-09-27: DEV-018 merge（PR #26, 3973770）。MVP の実装 Task（DEV-001〜015, 017, 018）はすべて develop に merge 済み。DEV-016 は HUMAN-004 待ち、DEV-019 は Release Readiness Report を作成し人間の承認待ち。
- 2026-09-27: DEV-019 Release Readiness Report（docs/RELEASE_READINESS.md）review round 1 FAIL（High 2）→ 修正、round 2 PASS。merge（PR #28, ea8a726）。develop → main の Release PR を作成（**merge は人間。DEV-016 Staging 完了まで merge しない**）。本番の Next.js 脆弱性対応 hotfix PR #27（main 向け）も人間の merge 待ち。
- **状態: READY_FOR_HUMAN_RELEASE_APPROVAL**。人間待ち: HUMAN-002（Supabase project）、HUMAN-004（Staging → DEV-016）、PR #27 merge、Release PR merge、HUMAN-003（branch protection 推奨）、HUMAN-005（Vercel rate limit、非ブロッキング）。後続 DEV-020〜024（Instagram 公式 Messaging API）は MVP release 後に着手。
- 2026-09-27: DEV-020 着手。依存を DEV-019 → DEV-018 に変更（DEV-019 は人間の Release 承認待ちで blocked のため。後続機能のローカル実装・テストは MVP のコード完成（DEV-018）だけに依存し、本番 release とは独立。Meta 実アカウント操作は DEV-024 の HUMAN BLOCKER）。
- 2026-09-27: DEV-020 review PASS（Medium 3: 取り消されたメッセージの本文が残る順序・保存できない文字で batch が永久失敗・account id 任意）→ 修正、merge（PR #30）。DEV-021 は review round 1 FAIL（High: 返信案のリンク検査が裸のドメイン等を見逃す）→ 修正、round 2 review 中。DEV-022/023（受信 inbox UI + 人間承認後の公式 API 送信）を同じ branch で実装中。
- 2026-09-27: DEV-021 review round 2 FAIL（High: IDN・IPv4・不可視文字を含むリンク）→ 修正、round 3 PASS（Medium: デモ URL 境界の deny-list → allow-list に修正）。merge（PR #31, a2055b9）。DEV-022/023 は実装・テスト完了（send integration 13、e2e 8）、fresh review 中。
- 2026-09-27: DEV-022/023（Instagram 返信 inbox + 人間承認後の公式 Send API 送信）review round 1 PASS（Medium 4）→ 修正、round 2 FAIL（High: 前の文面への再試行で draft が送信中のまま）→ 修正、round 3 PASS（Medium 2 も修正）。merge（PR #32, 620297b）。DEV-024（保存期間・連携確認・人間の設定手順）を実装、最終 security review 中。
- 2026-09-27: DEV-024: 保存期間（会話 180 日・受信記録 30 日・7 日より古い event は無視）、管理画面の「Instagram 連携を確認」（読み取りのみ）、人間の設定手順 docs/INSTAGRAM_SETUP.md を実装。Instagram 機能全体の最終 security review PASS（Critical/High/Medium 0、Low 4 は修正）。merge（PR #33, ae5bab4）。CI の integration が port 衝突（テスト開始前）で 1 回失敗 → re-run で green。**DEV-024 は HUMAN-006（Meta 側の設定）待ちで blocked。** 残りは実アカウントでの確認だけ。
- 2026-09-28: Staging Supabase project（`second-root`、ref znbqgvawublgyjwfpmei、Tokyo）を人間が作成（HUMAN-002 の Staging 分は解除）。この session の container には Supabase / Vercel の認証情報がなく、Postgres（5432）にも直接つなげない（HTTPS のみ）。そのため公式 Management API で migration 適用・security 確認・管理者登録・Vercel Preview 設定を行う `scripts/staging/` と手順書 `docs/STAGING.md` を作成。ローカルで全 14 migration を空 DB に適用し、integration 全件 pass を確認。**HUMAN-004 で環境変数（SUPABASE_ACCESS_TOKEN ほか）と管理者作成を待つ。**
- 2026-09-28: DEV-016 Staging セットアップ用スクリプト（scripts/staging/）と docs/STAGING.md を merge（PR #34, 2e01c97。fresh review PASS、Medium 3 / Low 6 は修正済み）。develop の Preview（second-root-git-develop-brot-yanagi.vercel.app）に Vercel Authentication が掛かっていることを確認（ingest API も SSO へ転送される）→ HUMAN-004 に方針決定を追加。HUMAN-005（Vercel rate limit）は解除。**Staging への migration 適用は SUPABASE_ACCESS_TOKEN 待ち（HUMAN-004）。**
- 2026-09-28: Supabase の認証を API credential（api.supabase.com 限定、proxy が header を付与）で受け取り、Staging（znbqgvawublgyjwfpmei）に 14 migration を適用。security 8 項目 PASS。ただし新しい project は API role に table 権限を既定で付けないため、core 6 table で管理画面の読み取りと ingest の書き込みができない状態を発見（local と権限を diff）。修正 migration 20260928000000（権限を明示）と、必要な権限の確認・静的テストを追加。Auth 設定（sign-up OFF・パスワード 12 文字）は token に project_admin_write がないため人間が設定する。
- 2026-09-28: PR #35 merge（8a86540）→ Staging に `20260928000000` を適用。`staging:verify` は DB の 12 項目すべて PASS。残る FAIL は sign-up ON と管理者 0 人（どちらも HUMAN-004）。実際の role で確認: anon 42501、非管理者 0 行（RLS）、service_role は書き込み可。記録は `.ai/reviews/DEV-016.md`。
- 2026-09-28: 人間が Staging の sign-up を OFF にし、パスワード最小長を 12 にし、管理者を作成。Claude が `staging:admin` で登録し、`staging:verify` の 14 項目すべて PASS（DB の Staging セットアップ完了）。Vercel の認証情報がないため Preview の設定は人間待ち。Deployment Protection の (a) Protection Bypass 用に、Routine prompt に任意の `SALES_AGENT_VERCEL_BYPASS` header 対応を追加。
- 2026-09-28: Vercel の API credential（api.vercel.com 限定）と Protection Bypass を人間が作成。この session では Vercel の credential がまだ付かない（403 missingToken）ため、`staging:vercel` を proxy の credential に対応させ、ingest token は人間が Vercel で設定する形にした（PR #37）。人間が作る secret の保存先を STAGING.md §2.1 に明記。次の session で Preview の環境変数 4 つを設定し、DEV-016 へ進む。
- 2026-09-28: 新しい session で Vercel credential を確認。proxy は header を付けるようになったが、Vercel が token を無効と判定（403 `invalidToken`）。Supabase は有効（`staging:verify` 14 項目 PASS）。token の作り直しと credential の差し替えを人間に依頼（HUMAN-004）。Preview の環境変数・再デプロイ・Routine・DEV-016 実走は未着手。
- 2026-09-28: Vercel token の差し替え後、新しい session で read-only 確認（`/v9/projects`・`/v6/deployments` 200）。`staging:vercel --apply` で develop の Preview に 4 変数を設定（Production・他 branch は無変更）。Staging の ingest token（Vercel Preview・Routine・開発 session の 3 か所）と Staging Routine の作成は人間待ち（HUMAN-004 (A)(B)）。
- 2026-09-28: HUMAN-004 完了 → DEV-016 Staging 実走 done（`.ai/reviews/DEV-016.md`）。ingest token と bypass は host 限定の API credential「Second Root Staging API」で proxy が付与し、RUN_PROMPT / INBOX_PROMPT / STAGING / SCHEDULE を両方式に対応させた（58d550d）。再デプロイ後に status 200。Routine 実走: discovered（2 stub）で session A を中断 → session B が同じ runId を status から verify → persist → completed（outreach_ready 1、Instagram、drafted・未送信）。同じ runId の persist / start / checkpoint 再送は replayed で重複なし、不正 payload は 400。**発見**: 別 runId の 2 本目 `start` を拒否する server 側 guard がない（STAGING §7 #7 の想定と不一致）→ follow-up 提案。Release PR #29 は未 merge（人間の承認待ち）。
- 2026-09-28: DEV-016 の「token なし → 401」を人間が自分の端末で実測（PASS）。
- 2026-09-28: DEV-025（running run は常に 1 本）merge（PR #38, 1e53ef0）。partial unique index と `sales_run_start` の `run_in_progress`（409）を追加。同時 start の race test も追加。fresh review PASS、CI 6 check green。Staging に migration 20260928000100 を適用（12 項目 PASS）。実測: start 200 / 別 runId 409 run_in_progress / 同一 runId 200 replayed。確認用 run は abort 済みで、running は 0。Release PR #29 は未 merge（人間の承認待ち）。
- 2026-09-28: DEV-019 Release 準備を更新（PR #39）。
  - RELEASE_READINESS / RELEASE §8 に、Staging 実走完了・DEV-025・Instagram 実装済み（HUMAN-006 のみ残り）を反映し、Production 準備の順番を書いた。
  - main（PR #27）との衝突を解消した。
  - HUMAN-004 は解除済みに移し、HUMAN-007（Production 準備と PR #29 の merge）を追加した。
  - PR #29 は Draft のまま。Production は未変更。
- 2026-09-28: PR #39 merge（82f2236）。fresh review PASS（Medium 3・Low 5 は修正済み）。
  - Production は新しい project だけを使う。Production の DB・Auth・環境変数の操作は、確認も含めて人間が行う。
  - Staging の verify を 16 本の migration で再確認し、14/14 PASS。
  - PR #29 は main との衝突が解消した（mergeable、Draft のまま）。
  - **状態: READY_FOR_HUMAN_RELEASE_APPROVAL**。人間待ちは HUMAN-007（Production 準備 → PR #29 の merge）。任意の残りは HUMAN-006・HUMAN-003・Staging token の Revoke。
- 2026-09-28: **人間が Production 準備を完了**（HUMAN-002 解除）。
  - Supabase `second-root-production`（sagjzgcpqcbrqbokawiz、Tokyo）に migration 16 本を適用し、verify 14/14 PASS。
  - Auth は sign-up OFF・Confirm email ON・パスワード最小長 12。管理者 1 名。確認用の token は Revoke 済み。
  - Vercel Production に 5 変数を設定した。既存の変数は変更なし、INSTAGRAM_* は未設定。Standard Protection。
  - 人間の明示承認に基づき、PR #29 の最終確認と merge に進む。
- 2026-09-28: **Release: PR #29 を main へ merge**（b14aab7。人間の明示承認に基づく）。
  - 直前の確認: head 32b5440 = develop、main と衝突なし、PR と push の CI それぞれで 6 job すべて success。前回の確認以降の差分は docs/.ai だけ。
  - main の CI（run 178）: success。
  - Production（secondroot.jp）で新しいコードが応答していることを確認した: `/admin/login` 200、ingest の token なし 401、不明なデモ 404、private route の header。既存ページは 200。
  - Vercel の deployment API はこの session の credential がなく（403 missingToken）、deployment ID は見ていない。
  - 残り（人間）: smoke test（ログイン・非管理者・token ありの status）、Production Routine、HUMAN-006・HUMAN-003・Staging token の Revoke。
