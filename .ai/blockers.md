# Blockers

> 人間の判断・操作が必要な事項と、技術的に止まっている事項を記録する。
> 解除されたら「解除済み」に移し、解除日と対応を書く。Secret の値は書かない。

## 未解除

### HUMAN-015 — Claude の Supabase（Staging）読み取りが 401

- 何: 2026-10-20、この session の proxy が入れる Supabase の token が `Invalid access token`（401）になった。Vercel の読み取りは動く。controlled run の前後の読み取り（`.ai/runbooks/controlled-run/snapshot.sql`・`after.sql`）が Claude からできない。
- 人の操作: Supabase で read-only に使える新しい access token を発行し、Claude の cloud environment の設定（session の title bar の environment メニュー → Edit → Network secrets）で `api.supabase.com` の値を差し替える。新しい session から有効。値は会話・GitHub に出さない。古い token は revoke。
- 代わり: 人が Supabase SQL editor で `snapshot.sql`・`after.sql` を実行し、結果（profile の中身は含まない）を貼ってもよい。
- 解除条件: Claude の read-only query が通る。
- 2026-10-20 人の判断: 新しい token は今は発行しない。読み取りは人の側の Supabase 接続（ChatGPT 経由、read-only）で行う。Claude からの読み取りは 401 のまま（未解除のまま残す。必要になったら上の手順で）。
- 2026-10-20 人が `snapshot.sql` を read-only で実行（事前の写し）: demo `efb4bdb2-5fb8-4575-b2e1-76217a832485`・`ready`・attempts 1・job `0fdbda79-794a-410b-931f-9677628742a3`・worker commit `f562166fda314af32d7c0b60a2c6f0f4262fa697`・updated_at 2026-10-16 10:10:44.754171+00・profile_md5 `89911ff811874960e23ae80d449e4542`・profile_bytes 722・outreach initial / instagram / drafted / 未送信・do_not_contact false・disabled_at null・queue_open 0。手順 A の前提はすべて満たす。

### HUMAN-010 — design worker の cycle（DEV-052）の WSL への install と timer の有効化

- 何: `scripts/sales-design-worker/cycle.sh` と `scripts/sales-design-worker/systemd/sr-design-cycle.{service,timer}` を、root の admin clone（`/root/sr-capture-admin`）から install し、dry-run の後に timer を有効化する。手順は `docs/operations/design-worker-cycle.md`。
- 前提: Staging の `SALES_AI_DESIGN_ENABLED=true` と Vercel Preview の bridge 経路が常時使えること（今は controlled rerun のたびに一時開放）。これは Authentication の常時の扱いに関わるため、別途人の判断。
- 状態（2026-10-19、人）: **保留**。timer は有効化しない。Vercel Authentication は維持し、認証された bridge だけが通る方式を Claude が検討する。
- 人の判断が要る点（PR #66）: bridge を `sudo -u` でなく `runuser` で動かす・`/etc/second-root/design-cycle.conf` に承認した bridge の SHA を置く・preflight SERIAL を OK とする・最初の deliver-only は全件 0 を求める・回復 SQL（job id と processing を条件）。
- 解除条件: 人が install と dry-run（`CYCLE_DRY_RUN_OK`）を行い、timer の有効化を承認する。
- 残りの前提（2026-10-20 整理、どれも人の判断・操作）:
  1. HUMAN-013（bypass の接続、`BYPASS_OK`）。これで「Authentication を外す」「復旧タスク 2 つ」は不要になる。
  2. controlled run 用の design job: Staging の demo は 3 件とも `ready`（2026-10-20 の読み取り）で、claim できる job が 0。用意の仕方を人が選ぶ: (a) flag ON の間に Operational Claude の Staging run で新しい店を準備（`AIデザイン待ち` の demo ができる。外部の公開ページの読み取りあり、1 日 5 件まで、送信はしない）、(b) 既存の `ready` の demo 1 件を `pending` に戻す SQL（DB の書き込み、人の承認、今の profile は次の結果で置き換わる）。
  3. flag の扱い: controlled run の window の間だけ Staging の `SALES_AI_DESIGN_ENABLED=true`（Vercel の env の変更 + develop の redeploy、人の承認）。常時 ON にするかは timer の前に別途判断（`design-worker-cycle.md` §7）。
  4. cycle の install（`design-worker-cycle.md` §4）: `/etc/second-root/design-cycle.conf` を作る（`SR_DESIGN_CYCLE_BRIDGE_SHA=` bridge の checkout の commit 40 文字、`SR_DESIGN_CYCLE_VERCEL_BYPASS=on`）→ setup script を `--replace` なしでもう一度（段 6 で dry-run、`CYCLE_DRY_RUN_OK`）→ window の中で `cycle.sh` を手で 1 回（`CYCLE_OK` か `CYCLE_IDLE`、bridge の段に `vercel protection bypass in use`）→ unit を置いて unit の中で 1 回（hardening の下での動作は実機で未確認）。
  5. PR #66 の判断: bridge を `runuser` で動かす・conf に承認した bridge の SHA を置く・preflight の SERIAL を OK とする・最初の deliver-only は全件 0・claim 後に止まったときの回復 SQL（job id と processing を条件）。
  6. Instagram のログインが有効であること（`LOGIN_REQUIRED` なら `admin.sh login`。cycle は回避せず止まる）。
  7. 上がすべて済んでから timer の enable を承認（`design-worker-cycle.md` §5）。
- controlled run の手順（2026-10-20 更新。HUMAN-014 は済み。DB の書き込み・flag・run・timer はすべて未承認）。SQL は `.ai/runbooks/controlled-run/`（ローカルの Postgres で確かめた）
  - 対象: demo `efb4bdb2-5fb8-4575-b2e1-76217a832485`（baked_goods、Instagram のみ、outreach は drafted、attempts 1/3）。予備 `b2048c61-…`。`d5656932-…`（attempts 2）は使わない
  - A. 読むだけ（承認不要）: `snapshot.sql` で ready・attempts 1・outreach が drafted で未送信・do_not_contact false・disabled でない・`queue_open` 0 を確かめる（HUMAN-015 で Claude から読めない間は人が実行）
  - B. 人が `restore-gen.sql`（読むだけ）を実行し、出力の update 文を自分の PC に保存（git・会話に貼らない）。保存したら確かめる: 文が `update public.sales_demos set design_status = 'ready'` で始まり `returning … profile_md5;` で終わる 1 行、`89911ff811874960e23ae80d449e4542` は文の中には出ない（戻した後に returning が返す値）。0 行なら demo が ready でない → 止まる。戻すときは returning の profile_md5 が `89911ff8…` であることを確かめる
  - 承認の単位（2026-10-20 整理）: 承認 1 = C（reset.sql を 1 回、1 行）、承認 2 = D と F（flag を true → 必ず false、window の長さを決める）、承認 3 = E（cycle.sh を 1 回、timer・unit なし）。B の update を使う復旧は別の書き込みなので、使うときに改めて承認
  - C. **[承認 1: DB 書き込み]** 人が `reset.sql` → 1 行・`pending`・attempts 1。0 行なら止まって Claude に知らせる
  - D. **[承認 2: Staging の flag]** Vercel の Preview（develop）で `SALES_AI_DESIGN_ENABLED=true` → develop を redeploy → Claude が `npm run staging:bypass-status` で "true"・READY を確認。window の間は Sales Agent の run を始めない（flag が on だと新しい demo が pending で作られる）
  - E. **[承認 3: cycle を 1 回]** WSL で `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh --dry-run` → `CYCLE_DRY_RUN_OK` の後に `sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh`（timer・unit は使わない）。最後の `CYCLE_RESULT` 行を Claude に
  - F. **[承認 2 の続き]** 結果に関係なく flag を `false` に戻し redeploy → Claude が "false" を確認
  - G. 読むだけ: `after.sql`（Claude、または人）
  - 復旧: `CYCLE_OK` で `ready` → 終わり。`blocked` → demo はテンプレートで表示（未送信・未公開で外への影響なし）。worker の失敗で `pending`（attempts 2）に戻った → そのまま置く（timer なしで動かない）か、B の update で元に戻す。`CYCLE_STOP_*` で `phase=before_claim` → 何も変わっていない（demo は pending のまま、B で戻せる）。`phase=after_claim` / `claim_unknown` → `design-worker-cycle.md` §6（job id を条件にした SQL・`--deliver-only`・lease の満了）。前のデザインに戻したいときはどの場合も B の update（processing の間は 0 行で何もしない）。どの場合も F（flag を false）は必ず行う

### HUMAN-007 — Production 準備と Release PR #29 の merge（DEV-019）
- 状態: **PR #29 を main へ merge 済み（2026-09-28、b14aab7。人間の明示承認に基づき Claude が実行）**。残りは merge 後の人間の作業。
  - **smoke test**（`docs/RELEASE.md` §8 の 5）: 管理者ログイン・非管理者の拒否・token ありの ingest `status`。
    - Claude が credential なしで確認済み: `/`・`/privacy`・`/terms`・`/robots.txt` は 200、`/admin/login` は 200、ingest の token なしは 401、不明なデモは 404、private route の header あり。
  - **Production Routine**（§8 の 6）: 別の environment を作る。API credential は `secondroot.jp` 限定で、bypass なし。まず手動で 1 回実行し、その後スケジュールを有効化する。
  - 最初の 1 週間は、送信前に人間が候補を確認する。Release の技術的な条件（CI・review・Staging 実走・DEV-025）はすべて満たした。
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

### HUMAN-014 — cycle の install と dry-run（timer なし、HUMAN-010 の一部）（解除: 2026-10-20）

- 何: `/etc/second-root/design-cycle.conf` を作り（bridge の commit と bypass のスイッチ）、setup script を `--replace` なしで動かして段 6 の `cycle.sh --dry-run` まで通す。unit は置かない・timer は enable しない・flag は変えない・DB は変えない。
- 前提: root の clone `/root/sr-capture-admin` は c066618（HUMAN-013 で合わせた）、bridge の checkout は 90c4c38caef5dafc539121195a6fd4d48753f477。
- 人の操作（WSL、1 行。bridge の checkout が 90c4c38 で clean であること・conf がまだ無いことを確かめてから作る。どれかが違えば何も書かずに止まる）:
  `B=$(sudo -u sr-designbridge -H git -C /home/sr-designbridge/second-root rev-parse HEAD) && [ "$B" = 90c4c38caef5dafc539121195a6fd4d48753f477 ] && test -z "$(sudo -u sr-designbridge -H git -C /home/sr-designbridge/second-root status --porcelain --untracked-files=normal)" && sudo test ! -e /etc/second-root/design-cycle.conf && sudo install -d -o root -g root -m 0755 /etc/second-root && printf 'SR_DESIGN_CYCLE_BRIDGE_SHA=%s\nSR_DESIGN_CYCLE_VERCEL_BYPASS=on\n' "$B" | sudo tee /etc/second-root/design-cycle.conf >/dev/null && sudo chmod 0644 /etc/second-root/design-cycle.conf && sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh`
  - 値は聞かれない（file があるので `BYPASS_FILE_PRESENT`）。`BYPASS_OK` の後、段 6 で `cycle: vercel bypass: on` と `CYCLE_RESULT CYCLE_DRY_RUN_OK …`、最後の行 `BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。
  - dry-run が止まったら（`CYCLE_DRY_RUN_NOT_OK`）、表示された `CHECK_*` / `CYCLE_STOP_PREFLIGHT` の符号だけを Claude に渡す。conf は残してよい（cycle は timer なしでは動かない）。やめるときは `sudo rm /etc/second-root/design-cycle.conf`。
- 解除条件: 人の出力に `CYCLE_DRY_RUN_OK` と `cycle: vercel bypass: on`。
- 2026-10-20 人が WSL で実行: `CYCLE_CONFIG_CREATED`・`BYPASS_FILE_PRESENT`・`PROTECTION_ON`・`BYPASS_OK`・`CYCLE_SWITCH_ON`・`cycle: vercel bypass: on`・`cycle: checks: OK`・`CYCLE_RESULT CYCLE_DRY_RUN_OK phase=before_claim job=none exit=0`・`BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。unit・timer・flag・DB は変わっていない。

### HUMAN-013 — bridge 専用 Vercel bypass secret の作成と WSL への設定（DEV-059 / DEV-063）（解除: 2026-10-20）

- 状態（2026-10-20）: Claude 側の準備は完了（PR #76 merge c066618）。人の操作待ち。Vercel Authentication は ON のまま、secret は 2 つ（bridge 用は未作成）、Staging の `SALES_AI_DESIGN_ENABLED`（Preview・develop）は `false`。
- 人の操作 1（Vercel の画面）: second-root → Settings → Deployment Protection → Protection Bypass for Automation → Create。note は `Second Root design bridge (WSL)`。**env var にはしない**。既存の 2 つは変えない。表示された値をコピー（チャット・GitHub・Claude には貼らない）。
- 人の操作 2（WSL、1 行。root の clone を c066618 に合わせてから setup script を動かす。prompt に値を貼って Enter、画面には出ない）:
  `sudo git -C /root/sr-capture-admin fetch -q origin && sudo git -C /root/sr-capture-admin checkout -q --detach c066618cd6a40fe1cef57f75a71b755eea4157e8 && test -z "$(sudo git -C /root/sr-capture-admin status --porcelain --untracked-files=normal)" && sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh`
  - 成功: `PROTECTION_ON`・`BYPASS_OK`（`REACHED_APP design_bridge_disabled`。flag が OFF なので正しい）・`CYCLE_CONF_ABSENT`（cycle の conf は HUMAN-010 の前なので無い。失敗ではない）・最後の行 `BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。
  - 止まったら出力の符号を Claude に渡す（値は貼らない）。`BYPASS_REJECTED` は値の貼り間違い → 同じ 1 行の末尾に ` --replace` を付けて正しい値でやり直す。`PROTECTION_NOT_ON` は Authentication が外れている可能性 → すぐ Vercel を確かめる。
  - bridge の checkout（`~sr-designbridge/second-root`、90c4c38）は bypass の対応（DEV-059）を含むので更新不要。
- 解除条件: Claude が `npm run staging:bypass-status` で `bridge_secret=present`・`isEnvVar: false`・`auth=on` を値なしで確認し、人の出力の `BYPASS_SETUP_OK` を確かめる。
- 戻し方・失効: `docs/operations/design-bridge-access.md` §8（Vercel で note の secret を revoke、WSL の file を消す。redeploy 不要）。
- 2026-10-20 人の実機結果: `BYPASS_FILE_WRITTEN`・`BYPASS_ENV_APPENDED`・`PROTECTION_ON`・`REACHED_APP design_bridge_disabled`・`BYPASS_OK`・`CYCLE_CONF_ABSENT`・`BYPASS_SETUP_RESULT BYPASS_SETUP_OK step=6`。
- 2026-10-20 Claude の読み取り（`npm run staging:bypass-status`、値は出さない）: Authentication on（all_except_custom_domains）、Password / Trusted IPs / OPTIONS off、secret 3 つ。**ただし note が入れ違い**: #1（2026-08-22 作成・`isEnvVar: true`、全 deployment の env に入っている古いもの）の note が `Second Root design bridge (WSL)`、#3（2026-10-20 作成・`isEnvVar: false`）の note が `Second Root design bridge`（"(WSL)" なし）。結果 `bridge_secret=env_var`。WSL の file にどちらの値が入っているかは Claude からは分からない（どちらでも Vercel は通すので BYPASS_OK になる）。
- **未解除**。直し方（人、値は出さない）: (1) Vercel の Protection Bypass for Automation で #1 の note を元に戻す（空か `legacy env var (do not use)`）、#3 の note を `Second Root design bridge (WSL)` にする（note を変えられなければ #3 はそのまま、#1 の note だけ外す）。(2) #3（2026-10-20、env var でないもの）の値をコピーし、WSL で `sudo bash /root/sr-capture-admin/scripts/sales-design-bridge/setup-vercel-bypass.sh --replace` に貼る（`BYPASS_SETUP_OK` まで）。これで WSL の file が env var の secret でないことが確定する。(3) Claude が `staging:bypass-status` で `bridge_secret=present` を確認して解除。
- 2026-10-20 人が note を修正（#1 `Legacy automation env var`・#2 `Second Root Staging Claude`・#3 `Second Root design bridge (WSL)`）し、#3 の値で `--replace`: `BYPASS_FILE_REPLACED`・`BYPASS_ENV_PRESENT`・`PROTECTION_ON`・`REACHED_APP design_bridge_disabled`・`BYPASS_OK`・`CYCLE_CONF_ABSENT`・`BYPASS_SETUP_OK step=6`。
- Claude の読み取り（2026-10-20）: `VERCEL_BYPASS_STATUS OK auth=on bridge_secret=present`。Authentication on（all_except_custom_domains）、secret 3 つ、#3 は isEnvVar false、Staging の flag は "false"、develop の alias は a64cc4b で READY。値は表示・記録していない。

### HUMAN-012 — WSL の design bridge を DEV-058 / DEV-059 以降の commit に更新（任意、HUMAN-010 とは別）（解除: 2026-10-19）

- 何: `sr-designbridge` の checkout（`~sr-designbridge/second-root`）を承認した commit（f7e7712 以降）に `git checkout --detach <commit> && npm ci`。手順は `docs/operations/design-bridge.md` §5・§10。
- 推奨の順番: HUMAN-011（migration）→ Staging の server（develop の自動 deploy で済み）→ bridge → worker（worker は `SR_DESIGN_WORKER_REF=develop` で run ごとに develop に揃う）。順番が違っても結果は失われない（§10）。
- bridge の Vercel bypass（DEV-059）は既定で無効のまま。有効にするのは `design-bridge-access.md` の人の承認後。timer（HUMAN-010）は保留のまま。
- 解除条件: 人が更新し、次の controlled run で `result <id>: delivered` と管理画面の「AI レビュー: …」の表示を確かめる。

- 人が更新（2026-10-19）: bridge を b04e135 に、npm ci 成功、TypeScript の動作確認 PASS。`/mnt/c/...` から run.sh を起動すると tsx の esbuild 起動が EACCES になる問題を発見（checkout に cd すれば成功）→ DEV-062（PR #75）で修正中。merge 後に bridge をその commit に更新すると、どこから起動してもよくなる。

### HUMAN-011 — Staging に DEV-057 と DEV-058 の migration を適用（この順で 1 回に）（解除: 2026-10-19）

- 何: `20261020110000_sales_funnel_views.sql`（DEV-057、view 2 つだけ）と `20261020120000_sales_design_review.sql`（DEV-058、`sales_demos.design_review` 列・check 2 つ・`sales_design_submit` の置き換え）。Staging は `20261019120000` まで（19 本）。未適用はこの 2 本だけ。
- 前提: develop が f7e7712（PR #72 の merge）以降。checkout が LF（STAGING.md §3）。
- 手順: `git ls-files --eol supabase/migrations | grep -v w/lf` が空 → plan（`npm run staging:apply -- --project-ref znbqgvawublgyjwfpmei`）で pending がこの 2 本だけ → `--confirm-ref znbqgvawublgyjwfpmei --apply` で全 PASS。FAIL は再実行せず出力を Claude に渡す。
- 適用しないとき: 履歴タブのファネルの部分だけ「読み込めませんでした」。AI デザインは flag が off なので影響なし（on にしても要約付きの submit は 503 で止まり、bridge が次の回に再送するだけ）。
- 解除条件: 適用後、Claude が読み取りで view・grant・security_invoker、`design_review` の check、`sales_design_submit` の引数（7 つ）・権限（service_role だけ）・本文（LF、repo と一致）を確認する。

- 人が適用（2026-10-19）: 19 → 21 本、セキュリティ検査 13 項目 PASS、Supabase の独立検証も正常。再適用しない。
- Claude の読み取り確認: migration 21 本（最新 20261020120000）・`sales_funnel_daily` / `sales_design_daily` は security_invoker、authenticated / service_role は SELECT だけ・anon は不可・`sales_demos_design_review_shape` / `_final` の check あり・`sales_design_submit` は 7 引数・service_role だけ実行可・本文は LF で md5 がローカルと一致・`design_review` は 0 行。

### HUMAN-009 — Staging に DEV-054 の migration を適用（探索段階の既知判定・却下の記憶）（解除: 2026-10-19）

- 人が適用: `20261019120000_sales_discovery_screening.sql`、18 → 19 applied、`HUMAN009_APPLY_OK`、セキュリティ検査すべて PASS。ChatGPT による独立の読み取り検証も完了。再適用しない。
- Claude の読み取り確認（2026-10-19）: migration 19 本（最新 20261019120000）・`sales_rejected_candidates` は RLS 有効・0 行・`sales_discovery_known_keys(p_stubs jsonb)` / `sales_remember_rejections(p_run_id uuid, p_entries jsonb)` / `sales_run_state(r sales_agent_runs, p_replayed boolean)` は anon・authenticated に実行権限なし、本文は LF で、md5 がローカル（同じ migration を適用した DB）と一致。

### HUMAN-008 — Staging に除外リストの migration を適用（DEV-049 / DEV-050）（解除: 2026-10-19）

- 人が適用（`npm run staging:apply … --apply`）: `20261018000000_sales_exclusions.sql`、17 → 18 applied、検査 13 項目すべて PASS（`exclusions_no_plain_email` を含む）、APPLY_SUCCEEDED。再適用しない。
- 適用後の `staging:verify` は、限定トークンに `auth_config_read` の権限がないため Auth 設定の読み取りで 403 になり止まった（DB の検証の失敗ではない）。Auth 設定の確認は人が別途行う。
- Claude の読み取り確認（2026-10-19）: migration 18 本（最新 20261018000000）・`sales_exclusions` の列にメールは `email_digest` だけ・RLS 有効・policy `sales_exclusions_admin_read`・0 行・`sales_add_exclusion(… p_email_digest …)` / `sales_remove_exclusion` は SECURITY DEFINER・`sales_persist_candidate` は SECURITY INVOKER のまま。3 つの関数の本文は repo と一致（改行が CRLF である点だけが違う。適用した checkout の改行設定による。PL/pgSQL の動作には影響しない。今後は `.gitattributes` で migration を LF に固定する）。

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


