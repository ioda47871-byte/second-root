# Blockers

> 人間の判断・操作が必要な事項と、技術的に止まっている事項を記録する。
> 解除されたら「解除済み」に移し、解除日と対応を書く。Secret の値は書かない。

## 未解除

### HUMAN-007 — Production 準備と Release PR #29 の merge（DEV-019）
- 状態: **Production 準備は人間が完了（2026-09-28）**。残りは PR #29 の merge（人間の明示承認のもと Claude が実行）と、merge 後の確認。Release の技術的な条件（CI・review・Staging 実走・DEV-025）はすべて満たした。
- PR #29（develop → main）は、人間の明示承認（2026-09-28）があるまで Draft のままにしていた。merge は、その承認に基づき Claude が行う。Claude は Production の DB・環境変数を変更しない。
- main（PR #27）との衝突は PR #39 で解消した（両方 Next.js 16.3.6、develop 側を採用）。
- 人間にお願いすること（この順番。詳細は `docs/RELEASE_READINESS.md` §13）:
  1. Production 用の Supabase project（HUMAN-002）
  2. migration 16 本の適用（`supabase db push`）
  3. `staging:verify --project-ref <prod-ref>` で確認
     - 人間が自分の端末で、Production に絞った短期の token を使って実行する。
     - Claude には Production 用の token を渡さない（Management API の token は任意の SQL を実行できる）。
     - 結果の PASS / FAIL 一覧を Claude に貼れば確認する。
  4. Auth の設定（sign-up OFF・パスワード 12 文字以上）
  5. 管理者の作成と `sales_admins` への登録（人間）
     - この後 verify の 14 項目すべて PASS を確認し、token を Revoke する。
  6. Vercel の **Production だけ**に 5 つの変数を設定する
     - Supabase の 3 つ・新しい ingest token・`SALES_DEMO_BASE_URL=https://secondroot.jp`
     - `INSTAGRAM_*` はまだ入れない。
  7. Deployment Protection を確認する（`secondroot.jp` が公開のままであること）
  8. PR #29 の CI が green で、衝突がないことを確認する
  9. Draft を外して人間が merge する
- merge 後: smoke test、Production の Routine（host `secondroot.jp` 限定の API credential）、最初の 1 週間は送信前に人間が確認する。
- 解除条件: PR #29 が merge され、Production の smoke test が通ること。
- 2026-09-28 人間が完了・確認したこと（secret の値は書かない）:
  - Production project `second-root-production`（ref `sagjzgcpqcbrqbokawiz`、Tokyo）に migration 16 本を適用し、`staging:verify` で **14/14 PASS** を確認した。
  - Auth: public sign-up OFF・Confirm email ON・パスワード最小長 12。
  - 管理者 1 名を作成し、`sales_admins` に登録した。
  - 確認に使った token は Revoke した。
  - Vercel Production に 5 変数を設定した（Supabase の 3 つ・`SALES_AGENT_INGEST_TOKEN`・`SALES_DEMO_BASE_URL=https://secondroot.jp`）。既存の Production の変数は変更していない。`INSTAGRAM_*` は未設定。
  - Vercel Authentication は Standard Protection のまま。`secondroot.jp` は Production の custom domain として公開する構成。
  - 古い main の再デプロイはしていない。

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

### HUMAN-002 — Second Root 専用 Supabase project
- 状態: **Staging 用は作成済み（2026-09-28、人間）**。project `second-root`、ref `znbqgvawublgyjwfpmei`、Region ap-northeast-1。まず Staging / DEV-016 に使う。
- Production 用を別に作るか、この project を使うかは Release 承認時に人間が判断する（`docs/STAGING.md` §8）。Claude は project 作成・billing 変更を行わない。
- 2026-09-28: **残りは Production 用**。**新しい project を作る**（Staging の project は Preview・Staging の ingest token・Routine・Claude 用の token がつながっているため流用しない）。migration 16 本を人間が適用する。手順は `docs/RELEASE_READINESS.md` §13 の 1〜5、`docs/RELEASE.md` §8。
- 2026-09-28: **解除**。人間が Production 用の新しい project `second-root-production`（ref `sagjzgcpqcbrqbokawiz`、Tokyo）を作成した。

### HUMAN-004 — Staging セットアップに必要な人間の操作（DEV-016）
- 対象 Task: DEV-016（DEV-019 の Release 判断にも必要）
- 状態: **解除（2026-09-28）**。DEV-016 の Staging 実走が完了した（`.ai/reviews/DEV-016.md`）。DEV-025 も Staging で実測済み。以下は経緯の記録。手順の正本は `docs/STAGING.md`。
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
- 2026-09-28 (3): 新しい session で確認。proxy は Vercel の credential を**付けるようになった**（エラーが `missingToken` → `invalidToken` に変化）が、Vercel が token 自体を拒否する（`/v2/user`・`/v9/projects`・`/v6/deployments` すべて 403 `invalidToken: true`）。Supabase の credential は有効（`staging:verify` 14 項目 PASS）。**人間にお願いすること**: Vercel → Account Settings → Tokens で token を作り直し（Scope は team `brot-yanagi`、有効期限は短く）、Claude Code の cloud environment → Edit → API credentials の「Vercel Staging」（host `api.vercel.com`）の値を差し替える。値は token 文字列だけ（`Bearer ` を付けない・前後の空白や改行を入れない）。新しい session から有効。
- 2026-09-28 (4): 人間が「Vercel Staging」の token を差し替えた。新しい session で read-only 確認: `/v9/projects`・`/v6/deployments` は 200（project `second-root` を取得）。`/v2/user`・`/v2/teams` は 404/403 だが、project 単位に絞った token なので想定どおり。Claude が `staging:vercel --apply` で Preview（branch `develop` のみ）に 4 変数（Supabase URL / anon key / service_role key / demo base URL）を設定。Production・他 branch の変数は変更なし（既存 3 変数は触れていない）。**残り（人間）**:
  - (A) Staging の ingest token（`openssl rand -hex 32`）を作り、`docs/STAGING.md` §2.1 の 3 か所に保存する: ① Vercel → second-root → Settings → Environment Variables に `SALES_AGENT_INGEST_TOKEN`（**Preview だけ・Branch `develop`・Sensitive**）② Staging Routine の environment ③ この開発 session の environment の API credential（host `second-root-git-develop-brot-yanagi.vercel.app`）。①の後、develop の Preview を再デプロイ（Claude が develop へ push しても再ビルドされる）。
  - (B) Staging Routine `second-root-sales-agent-daily-staging` を作成（スケジュール無効、手動実行のみ、環境変数は §6 の 3 つ）し、名前を Claude に伝える。
  - (A)(B) の後、Claude が DEV-016 の実走（§7）を行う。
- 2026-09-28 (5): **人間の作業はすべて完了**。Vercel Preview（develop）に `SALES_AGENT_INGEST_TOKEN` を設定。ingest token と bypass を 1 つの API credential「Second Root Staging API」にまとめた。Routine `second-root-sales-agent-daily-staging` を作成（遠い日付の schedule、Run now のみ）。Claude が再デプロイ後に認証を確認し、DEV-016 の実走（§7）を完了（`.ai/reviews/DEV-016.md`）。→ HUMAN-004 は解除扱い。残りは任意の確認 2 つ（人間の端末から bypass だけを付けた curl で ingest が 401 になること、管理画面で今日の 1 件を確認すること）と、Staging 終了後の token の revoke（§8）。
- 1 の後に Claude がやること:
  - migration の適用と security 確認（`staging:apply --apply --auth` → `staging:verify`）
  - 2 の後: 管理者の登録（`staging:admin`）
  - `VERCEL_TOKEN` がある場合: Preview の環境変数設定
  - 5 の後: DEV-016 の実走（`docs/STAGING.md` §7）とログ（`.ai/reviews/DEV-016.md`）
- 2026-09-28 時点で Claude が確認済みのこと: 全 14 migration を空の DB に順に適用でき、integration 全件（security audit を含む）が pass する（ローカル、`supabase db reset`）。

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


