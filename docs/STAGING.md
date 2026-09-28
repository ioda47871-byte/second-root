# Staging セットアップ手順（DEV-016 / HUMAN-002・004）

> Staging は DEV-016（Operational Claude の実走確認）用。**Production への release はしない。Release PR #29 は merge しない。**
> Staging の Supabase project: `second-root`（ref `znbqgvawublgyjwfpmei`、Region ap-northeast-1）。2026-09-28 に人間が作成。
> Secret の値は GitHub・チャット・ログ・commit に出さない。この文書にも書かない。

## 1. 方式

- Claude Code（cloud）の container からは HTTPS しか外へ出られず、Postgres（5432 / 6543）へ直接つなげない。そのため `supabase db push` は使えない。
- 代わりに **Supabase 公式の Management API**（`POST /v1/projects/{ref}/database/query`、HTTPS）で同じ migration を順番に適用する。
  - 1 migration = 1 request = 1 transaction。失敗した migration は丸ごと戻り、そこで止まる。
  - 適用記録は CLI と同じ `supabase_migrations.schema_migrations`（version / name）に残す。後から人間の端末で `npx supabase migration list` / `db push` を使っても食い違わない。
  - 既存 migration は書き換えない。remote に repo にない version がある、同じ version の名前が違う、古い未適用 migration がある場合は、何も適用せずに止まる（drift）。
- スクリプト: `scripts/staging/`（`apply.mjs` / `verify.mjs` / `admin.mjs` / `vercel-preview.mjs`）。secret は環境変数からだけ読み、表示しない。Claude Code の container（Node 22.21 以上、POSIX shell）で `npm run staging:*` として実行する。
- 人間の端末から CLI で行う場合（同じ結果）: `npx supabase login` → `npx supabase link --project-ref znbqgvawublgyjwfpmei` → `npx supabase db push`（DB password は Claude に渡さない）→ Claude が §2 の verify を実行。

## 1.1 2026-09-28 の実施結果（Staging）

- Supabase の認証は、Claude Code environment の **API credential（`api.supabase.com` 限定の Bearer）** として登録された。session の proxy が header を付けるので、token は Claude の process・shell・ログに入らない。スクリプトは `SUPABASE_ACCESS_TOKEN` がなく proxy がある場合、Authorization header を付けずに送る（`authHeaders`）。
- 14 migration を適用した。security の 8 項目はすべて PASS。
- ただし、この新しい project は既定の権限が古い project と違い、`postgres` が作った table について API role（anon / authenticated / service_role）に SELECT / INSERT / UPDATE を自動で付けない。core の 6 table はこの既定に頼っていたため、Staging では管理画面が読めず、ingest API も書けない状態だった（「多すぎる権限」を見る audit では見つからない）。
  → 既存 migration は変えずに、`20260928000000_sales_explicit_api_grants.sql` で必要な権限を明示した。あわせて「必要な権限」の確認（`REQUIRED_CHECKS`）と、migration が全 table を明示的に grant しているかの静的テストを追加した。
- Auth 設定の変更（`--auth`）には `project_admin_write` 権限が必要（token にない）。範囲の広い権限なので、人間が Dashboard で設定する（§4）。

## 2. Claude Code 環境に入れる secret（人間）

claude.ai の Claude Code → このセッションの cloud environment メニュー → Edit → 環境変数。新しい session から有効になる。**値をチャットに貼らない。**

| 変数名 | 何か / どこで作るか | 必須 | 用途 |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase Dashboard → Account → Access Tokens で **scoped（範囲を限定した）token** を作る。対象は project `second-root` だけ、有効期限は短く（例: 7 日）。権限は下の表 | 必須 | migration 適用・検証・Auth 設定・管理者登録・API キーの受け渡し |
| `STAGING_SALES_AGENT_INGEST_TOKEN` | 手元で `openssl rand -hex 32`（**Staging 専用**。Production とは別の値） | 必須 | Vercel Preview に設定する ingest token。DEV-016 の再送・fail-closed 確認にも使う |
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens → Create（Scope は Second Root のあるチーム、有効期限を短く） | 任意 | Preview の環境変数を Claude が設定する場合だけ。入れない場合は §5 を人間が画面で行う |

- Supabase の token は **scoped PAT** にする（公式: "A scoped PAT can only reach the organizations, projects, and permissions you choose"）。Legacy の token はアカウントのすべての project に効くので使わない。
  必要な権限（Management API の各 endpoint に書かれている名前）:

  | 権限 | 使う場面 |
  |---|---|
  | `database_write`（と `database_read`） | migration 適用・確認・管理者登録（`/database/query`） |
  | `auth_config_read`・`auth_config_write` | sign-up OFF・パスワード最小長（`/config/auth`） |
  | `api_gateway_keys_read`・`api_gateway_keys_secret_read` | `VERCEL_TOKEN` を使って Claude が Preview に key を設定する場合だけ（`/api-keys?reveal=true`） |

  画面で名前が違う、または `auth_config_write` に `project_admin_write` も必要と出る場合は、それに従う。**Staging の作業が終わったら token を削除（Revoke）する。**
- Operational Claude（Routine）の environment には `SALES_AGENT_INGEST_URL` だけを環境変数で入れ、ingest token と bypass は host 限定の API credential にする（§2.1・§6）。上の 3 つは入れない。

### 2.1 人間が作る secret の置き場所（2026-09-28 決定）

Supabase と Vercel の token は、Claude Code environment の **API credential**（host 限定の Bearer）として登録済み。session の proxy が header を付けるので、token は Claude の process・shell・ログに入らない。API credential は**新しい session から有効**になる。
人間にしか作れない secret が 2 つあり、それぞれ次の場所にだけ保存する（チャット・GitHub には貼らない）。

| secret | 作り方 | 保存先 |
|---|---|---|
| Staging の ingest token | 手元で `openssl rand -hex 32`（Production とは別の値） | ① Vercel → second-root → Settings → Environment Variables: `SALES_AGENT_INGEST_TOKEN`、Environment は **Preview だけ**、Branch `develop`、**Sensitive**<br>② Claude Cloud environment の **API credential「Second Root Staging API」**（host `second-root-git-develop-brot-yanagi.vercel.app` 限定）の header `Authorization: Bearer <token>` |
| Protection Bypass for Automation（「Second Root Staging Claude」） | Vercel → Settings → Deployment Protection で作成済み | 同じ API credential「Second Root Staging API」の header `x-vercel-protection-bypass: <値>` |

- 2026-09-28 の最終形: Staging Routine と開発 session は同じ Claude Cloud environment を使い、環境変数は `SALES_AGENT_INGEST_URL` だけ。`SALES_AGENT_INGEST_TOKEN` / `SALES_AGENT_VERCEL_BYPASS` の環境変数は置かない。proxy が上の 2 header を ingest の host にだけ付けるので、値は Claude の process・shell・ログに入らない（RUN_PROMPT §0・§2 は両方式に対応）。
- 注意: credential は host 単位なので、Claude がこの host（develop の固定 URL）に送る request にはすべて 2 header が付く。token なしの fail-closed 確認は、credential の付かない deployment 固有 URL で行う（§7 #1）。

`SALES_AGENT_INGEST_TOKEN` 以外の Preview 変数 4 つ（Supabase URL / anon key / service_role key / demo base URL）は、Claude が `staging:vercel` で設定する。

## 3. migration と security 確認（Claude）

```bash
npm run staging:apply  -- --project-ref znbqgvawublgyjwfpmei            # 計画だけ表示
npm run staging:apply  -- --project-ref znbqgvawublgyjwfpmei --confirm-ref znbqgvawublgyjwfpmei --apply --auth
npm run staging:verify -- --project-ref znbqgvawublgyjwfpmei            # 読み取りのみ。管理者登録後にも実行
```

- `--apply`: 未適用の migration を順に適用し、続けて security 確認を行う。`--confirm-ref` に同じ ref を書かないと実行しない。
  - 最初の変更の前に、実際の project で次を確かめ、違えば何も変えずに止まる:
    - SQL が CLI と同じ `postgres` として実行されること
    - 途中で失敗した複数文の request が何も残さない（1 transaction）こと（公式ドキュメントに明記がないため、毎回その場で確認する）
- `--auth`: public sign-up を OFF にし、パスワードの最小長を 12 以上にする。
- 確認項目（`scripts/staging/lib.mjs` の `runChecks`。CI の `tests/integration/db-security-audit.test.ts` と同じ規則）:
  - `schema_migrations` が `supabase/migrations/` と完全一致（Instagram 連携の 000900〜001200 を含む）
  - すべての `sales_*` table が存在し、RLS が有効
  - anon: `sales_*` の table・view に権限なし、sales 関数を実行できない
  - authenticated（一般ユーザー）: `sales_*` table へ直接 INSERT / UPDATE / DELETE / TRUNCATE できない。実行できるのは admin を最初に確認する SECURITY DEFINER 関数だけ
  - すべての sales 関数で `search_path` が固定され、PUBLIC に実行権限がない
  - `verify` はさらに、public sign-up が OFF で、管理者がちょうど 1 人であることを確認する
- この確認は CI でもローカル DB に対して毎回実行している（`tests/integration/staging-checks.test.ts`）。

## 4. 管理者（人間 → Claude）

MVP は email + password の管理者 1 人。**パスワードは Claude に渡さない。**

1. 人間: Supabase Dashboard → Authentication → Users → **Add user** → **Create new user**。email とパスワードを入れ、**Auto Confirm User** をオンにする。
2. 人間: 管理者の email アドレス（secret ではない）を Claude に伝える。
3. Claude: `npm run staging:admin -- --project-ref znbqgvawublgyjwfpmei --confirm-ref znbqgvawublgyjwfpmei --email <email>` を実行する。削除済み・停止中・匿名の user は対象外。確認済みの Auth user を `sales_admins` に登録するだけで、パスワードは扱わない。2 人目の管理者は登録しない。
4. public sign-up の OFF とパスワード最小長は、token に `project_admin_write` がなければ人間が設定する: Authentication → Sign In / Providers →「Allow new users to sign up」を OFF、Email の「Minimum password length」を 12 以上。その後 Claude が `staging:verify` で確認する。

## 5. Vercel Preview（Staging）

Preview のうち **`develop` branch の deployment だけ**に設定する。Production には設定しない。

| 変数 | 値 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://znbqgvawublgyjwfpmei.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase の anon（公開用）key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase の service_role key（Sensitive。`NEXT_PUBLIC_` を付けない） |
| `SALES_AGENT_INGEST_TOKEN` | `STAGING_SALES_AGENT_INGEST_TOKEN` と同じ値（Sensitive） |
| `SALES_DEMO_BASE_URL` | `https://second-root-git-develop-brot-yanagi.vercel.app`（develop の Preview の固定 URL） |

- `VERCEL_TOKEN` がある場合は Claude が実行する（値は Supabase / 環境変数から Vercel へ直接渡し、表示しない）:
  `npm run staging:vercel -- --project-ref znbqgvawublgyjwfpmei --confirm-ref znbqgvawublgyjwfpmei --vercel-project <name> [--team <teamId>] --git-branch develop --demo-base-url https://<develop の Preview URL> --apply`
  - このスクリプトは Preview の Deployment Protection の状態も表示する。
  - 同じ名前の変数が Production・Development・別 branch 向けにすでにある場合は、何も変えずに止まる。更新するのは「Preview かつ develop だけ」の変数に限る。
  - key の値は `--apply` のときだけ取得する。
- ない場合は人間が Vercel → Project → Settings → Environment Variables で、Environment を **Preview** だけ、Branch を `develop` にして上の 5 つを追加する。その後 develop を再デプロイする。
- Vercel project: `second-root`（team `brot-yanagi`）。develop の Preview の固定 URL: `https://second-root-git-develop-brot-yanagi.vercel.app`。
- **2026-09-28 確認: Preview には Vercel Authentication が掛かっている**。ingest API（`/api/internal/sales-agent/runs`）も含め、未ログインのアクセスは `vercel.com/sso-api` へ 302 で転送される。
- **Deployment Protection**: Preview に「Vercel Authentication」が掛かっていると、Operational Claude（Routine）の ingest 呼び出しが Vercel に 401 で止められる（Meta の Webhook も同じ）。どちらかを人間が選ぶ:
  - (a) 推奨: Settings → Deployment Protection → **Protection Bypass for Automation** を作成する。prompt は対応済みで、Staging の Routine environment に `SALES_AGENT_VERCEL_BYPASS` として入れると header `x-vercel-protection-bypass` を付けて呼ぶ（RUN_PROMPT / INBOX_PROMPT §0）。この値で通れるのは Vercel の保護だけで、ingest API には token が別に必要。ただし値は **project 全体**（他 branch の Preview も含む）の保護付き deployment に効くので、露出が疑われたら Vercel で再生成する。
  - (b) Preview の Vercel Authentication を OFF にする（管理画面はログイン必須、ingest は token 必須、デモは推測できない URL なので、データは守られる）。
- Vercel の Preview build が rate limit 中（HUMAN-005）なら、解除後に再デプロイする。

## 6. Operational Claude（Staging の Routine、人間）

`ops/sales-agent/SCHEDULE.md` §2・§3 のとおり。

- environment の環境変数は `SALES_AGENT_INGEST_URL=https://second-root-git-develop-brot-yanagi.vercel.app/api/internal/sales-agent/runs` だけ。
- ingest token と bypass は API credential「Second Root Staging API」（host 限定、§2.1）。proxy が `Authorization` と `x-vercel-protection-bypass` を付ける。
  （環境変数 `SALES_AGENT_INGEST_TOKEN` / `SALES_AGENT_VERCEL_BYPASS` で渡す方式にも prompt は対応しているが、Staging では使わない。）
- Routine 名は `second-root-sales-agent-daily-staging`。Routine の UI では trigger なしで保存できなかったため、**十分先の日付の schedule** を設定してあり、DEV-016 では手動実行（Run now）だけを使う。
- 作成したら Routine の名前を Claude に伝える。Claude は Routine を起動・中断できる（DEV-016）。

## 7. DEV-016 実走確認（Claude。§3〜§6 の後）

実店舗へメール・Instagram DM は送らない。送信は常に人間の操作で、今回は誰も押さない。

| # | 確認 | 方法 |
|---|---|---|
| 1 | ingest API が Staging で動く | token なしで 401、`status` が `{"run":null}` |
| 2 | Operational Claude が `status` から開始し、Web 検索で候補を探して `discovered` checkpoint を保存する | Routine を手動実行し、`status` で phase を確認 |
| 3 | 意図的に中断 → 新しい session が `status` から resume する | `discovered` を確認したら Routine の session を中断し、Routine をもう一度実行する（別 session） |
| 4 | `verified` → `persist` → `completed` | `status` と管理画面の「今日やること」 |
| 5 | 重複なし・同じ runId の再送は `replayed` | Staging の ingest token で、同じ checkpoint と persist を再送する |
| 6 | unknown / DNC / 不正な email が `outreach_ready` にならない | 管理画面と DB（Management API の読み取り）で確認。不正な payload を送ると 400 で何も保存されない |
| 7 | 最大 5 件の actionable、二重 run が起きない | 1 日の上限と、完了後の `status` が今日の run（`none`）を返すこと。実行中に**別の runId** で `start` すると 409 `run_in_progress`、同じ runId は 200 `replayed`（DEV-025 の migration `20260928000100` 以降）。再開できない running run が残った場合は、24 時間で自動的に `failed` になるのを待つか、その runId で `abort` する |

実走ログは `.ai/reviews/DEV-016.md` に残す。

## 8. 片付け

- Staging 確認が終わったら、Supabase Access Token と Vercel Token を削除（Revoke）し、Claude Code 環境変数からも削除する。
- この project を Staging のまま残すか、Production 用に別 project を作るかは Release 承認時に人間が判断する（`docs/RELEASE.md` §8。Free プランの active project 数の上限に注意）。Production に流用する場合も、Staging の試験データを消してから使う。
