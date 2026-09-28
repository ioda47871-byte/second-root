# Blockers

> 人間の判断・操作が必要な事項と、技術的に止まっている事項を記録する。
> 解除されたら「解除済み」に移し、解除日と対応を書く。Secret の値は書かない。

## 未解除

### HUMAN-002 — Second Root 専用 Supabase project
- 状態: **Staging 用は作成済み（2026-09-28、人間）**。project `second-root`、ref `znbqgvawublgyjwfpmei`、Region ap-northeast-1。まず Staging / DEV-016 に使う。
- Production 用を別に作るか、この project を使うかは Release 承認時に人間が判断する（`docs/STAGING.md` §8）。Claude は project 作成・billing 変更を行わない。

### HUMAN-004 — Staging セットアップに必要な人間の操作（DEV-016）
- 対象 Task: DEV-016（DEV-019 の Release 判断にも必要）
- 状態: 人間待ち（2026-09-28 更新）。手順の正本は `docs/STAGING.md`。
- 分かったこと: Claude Code（cloud）の container は HTTPS しか通らず、Postgres に直接つなげない（proxy が `db.<ref>.supabase.co` を拒否）。そのため `supabase db push` の代わりに、Supabase 公式 Management API で migration の適用と確認を行うスクリプト（`scripts/staging/`）を用意した。
- 人間にお願いすること:
  1. **Claude Code の environment に環境変数を追加**（cloud environment メニュー → Edit。値はチャットに貼らない。新しい session から有効）:
     - `SUPABASE_ACCESS_TOKEN`（必須）: Supabase → Account → Access Tokens。**scoped token（project `second-root` のみ、必要な権限だけ）**、有効期限は短く（権限の一覧は `docs/STAGING.md` §2）
     - `STAGING_SALES_AGENT_INGEST_TOKEN`（必須）: `openssl rand -hex 32`。Staging 専用
     - `VERCEL_TOKEN`（任意）: 入れない場合は 4 を人間が画面で行う
  2. **管理者ユーザー作成**: Supabase → Authentication → Add user → Create new user（email + password、Auto Confirm User オン）。パスワードは Claude に渡さず、email だけを伝える。
  3. **Vercel Preview の Deployment Protection の方針**を決める（`docs/STAGING.md` §5）。2026-09-28 に確認したところ、Preview（`https://second-root-git-develop-brot-yanagi.vercel.app`）は Vercel Authentication で保護されていて、ingest API も SSO へ転送される。このままでは Staging の Routine が ingest API に届かない。
     - (a) 推奨: Protection Bypass for Automation を作成する（Preview は非公開のまま）。この場合、Claude が Routine prompt に bypass header の対応を追加する。
     - (b) Preview の Vercel Authentication を OFF にする（管理画面はログイン必須、ingest は token 必須のまま。security 設定の緩和なので人間の判断）。
  4. （`VERCEL_TOKEN` なしの場合）Vercel Preview（branch `develop` のみ）に環境変数を 5 つ設定し、develop を再デプロイする（`docs/STAGING.md` §5）。
  5. **Staging の Routine** を作成する（スケジュールは無効、手動実行のみ。`docs/STAGING.md` §6）。
- 2026-09-28 進捗: Supabase の認証は API credential（api.supabase.com 限定）として登録済み。Staging に 15 migration を適用し、DB の security と必要な権限 12 項目はすべて PASS（`.ai/reviews/DEV-016.md`）。**残り**:
  - ~~(i) sign-up OFF・パスワード 12 文字~~、~~(ii) 管理者ユーザー~~: 2026-09-28 完了。Claude が管理者を登録し、`staging:verify` の 14 項目すべて PASS。
  - (iii) 3（Deployment Protection）・4（Vercel Preview の環境変数）・5（Staging Routine）。この session には Vercel の認証情報がない（api.vercel.com は 403）。Protection Bypass（(a)）を使う場合の prompt 対応は済み（`SALES_AGENT_VERCEL_BYPASS`）。
- 2026-09-28 (2): 人間が Vercel の API credential「Vercel Staging」（api.vercel.com 限定）と、Protection Bypass for Automation「Second Root Staging Claude」を作成した。**この session の proxy は Vercel の credential をまだ付けていない**（api.vercel.com は 403 `missingToken`。Supabase のものは付いている）。API credential は新しい session から有効になるため、次の session で `staging:vercel` から再開する。人間が作る secret（Staging の ingest token と bypass 値）の保存先は `docs/STAGING.md` §2.1。
- 1 の後に Claude がやること:
  - migration の適用と security 確認（`staging:apply --apply --auth` → `staging:verify`）
  - 2 の後: 管理者の登録（`staging:admin`）
  - `VERCEL_TOKEN` がある場合: Preview の環境変数設定
  - 5 の後: DEV-016 の実走（`docs/STAGING.md` §7）とログ（`.ai/reviews/DEV-016.md`）
- 2026-09-28 時点で Claude が確認済みのこと: 全 14 migration を空の DB に順に適用でき、integration 全件（security audit を含む）が pass する（ローカル、`supabase db reset`）。

### HUMAN-006 — Instagram 公式 Messaging API の Meta 側設定（DEV-024）
- 対象 Task: DEV-024（DEV-020〜023 のコード・DB・管理画面・テストは完成済み。実アカウントでの確認だけが残る）
- 状態: 人間待ち（MVP の Release とは独立。HUMAN-004 の Staging があると先に安全に確認できる）
- 必要な操作と値（手順・画面の場所は `docs/INSTAGRAM_SETUP.md`）:
  1. Meta App を作成（ユースケース: Instagram のメッセージとコンテンツを管理）
  2. Second Root の Instagram プロアカウントを接続し、Instagram アプリで「メッセージへのアクセスを許可」をオン。権限は `instagram_business_basic` と `instagram_business_manage_messages`
  3. Vercel（Staging は Preview、本番は Production）に設定して再デプロイ:
     - `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`（`openssl rand -hex 32`）
     - `INSTAGRAM_APP_SECRET`
     - `INSTAGRAM_ACCOUNT_ID`
     - `INSTAGRAM_ACCESS_TOKEN`（60 日で失効。更新手順は §7）
  4. Webhook を登録: callback `https://<ドメイン>/api/webhooks/instagram`、verify token は 3 と同じ値、field は `messages`。アカウントの subscription もオンにする
  5. アプリを Live にする。自社アカウント用なので Standard Access（App Review 不要）の想定。一般ユーザーとのやりとりで失敗した場合だけ、Advanced Access（ビジネス認証 + App Review）を人間が判断する
  6. inbox Routine `second-root-sales-inbox` を作成（`ops/sales-agent/SCHEDULE.md` §5）
- 推奨: Staging で 1〜6 → `docs/INSTAGRAM_SETUP.md` §8 の確認表 → Release 承認後に Production で 3〜5。
- 解除後に確認すること（§8）:
  - Meta の Verify が成功する
  - 管理画面の「Instagram 連携を確認」が OK
  - 個人アカウントからの DM が「未照合」として表示される
  - Routine が返信案を作る
  - 「この内容で返信」で 1 回だけ届き、2 回目は「送信済み」になる
- Claude は Meta の画面操作・App Review 申請・token の扱いを行わない。

### HUMAN-003 — branch protection の required checks（推奨・非ブロッキング）
- 状態: 人間待ち（開発は止めない）
- 内容: GitHub → Settings → Branches で `main` と `develop` に branch protection を設定し、required status checks に `static` / `unit` / `integration` / `build` / `e2e` / `e2e-sales` を追加する。
- 理由: 現状 Claude は CI green を確認してから merge しているが、GitHub 側でも強制されると安全。
- DEV-004 で Claude が allowed_scope を拡張（GA を /demo・/admin で無効化、noindex / no-referrer ヘッダ、e2e 分割）。既存ページの挙動は不変とレビュー確認済み。異論があれば PR #12 を参照。

## 解除済み

### HUMAN-005 — Vercel preview の build rate limit
- 状態: **解除（2026-09-28）**: PR #34 の Preview が Ready になった（rate limit 解除）。再発した場合も GitHub Actions の必須 CI で merge 判断を続ける。

### HUMAN-001 — Bootstrap PR の merge と develop 作成
- 対象 Task: DEV-001, DEV-002（以降すべて）
- 状態: **解除済み（2026-09-27）** — 人間承認に基づき Claude が PR #8 を main へ merge（32de89a）し、`develop` を作成。branch protection の設定は引き続き人間の推奨作業
- 必要な操作（1・2 は人間承認に基づき Claude が実施）:
  1. BOOT-001 の PR #8 を main へ merge
  2. merge 後の main から `develop` branch を作成し push
  3. （推奨）`main` / `develop` に branch protection を設定し、CI の `static` / `unit` / `build` / `e2e` を required check にする
- 解除条件: `origin/develop` が存在し、BOOT-001 の変更を含む


