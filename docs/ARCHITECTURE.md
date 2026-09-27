# Second Root Sales Agent — Architecture

> 仕様は `docs/MVP_SPEC.md`、セキュリティ要件は `docs/SECURITY.md` を正本とする。
> 本書は「どこに何を置くか」の設計。詳細な列定義は DEV-001 の migration が正本になる。

## 1. 既存構成（BOOT-001 時点の main）

| 項目 | 内容 |
|---|---|
| Framework | Next.js 16.3.0（App Router, `next build --webpack`）/ React 19.2 / TypeScript strict |
| Hosting | Vercel（`vercel.json` なし、既定設定） |
| 既存ルート | `/`, `/privacy`, `/terms`, `/thanks`, `/api/contact`（Resend で問い合わせ送信）, `robots.txt`, `sitemap.xml`, `manifest` |
| 既存外部サービス | Resend（問い合わせフォームのみ）, Google Analytics |
| Lint | ESLint 9 + `eslint-config-next` |
| 既存 scripts | `scripts/*.mjs`（Playwright による手動の見た目確認・画像生成。CI 対象外） |
| 既存テスト / CI | なし（BOOT-001 で追加） |
| DB / Auth | なし（DEV-001 / DEV-008 で Supabase を追加） |

Next.js 16 は学習データと異なる点があるため、実装前に `node_modules/next/dist/docs/` を必ず確認する（`AGENTS.md`）。
型チェックは `next typegen` で `LayoutProps` 等のグローバル型を生成してから `tsc --noEmit` を実行する（`npm run typecheck`）。

## 2. 全体像

```
                ┌──────────────────────────┐
                │ Operational Claude        │  Claude Cloud scheduled job
                │ (Web検索・調査・文面準備) │  持つSecret: SALES_AGENT_INGEST_TOKEN のみ
                └────────────┬─────────────┘
                             │ POST /api/internal/sales-agent/runs (Bearer)
                             ▼
┌───────────────────────────────────────────────────────────────┐
│ Second Root (Next.js on Vercel)                               │
│                                                               │
│  app/api/internal/sales-agent/runs  ← 狭い ingest endpoint    │
│  app/admin/sales/**                 ← 管理画面 (Supabase Auth)│
│  app/demo/[publicToken]             ← 公開デモ (noindex)       │
│  app/api/contact                    ← 既存 (Resend, 変更しない)│
│                                                               │
│  lib/sales/**   ← 純粋なドメインロジック (DB非依存, unit test) │
│  lib/supabase/** ← server/browser client 生成                  │
└────────────────────────────┬──────────────────────────────────┘
                             │ service role (server only) / anon + RLS
                             ▼
                ┌──────────────────────────┐
                │ Supabase (Second Root専用)│  営業データの正本
                │ Postgres + Auth + RLS     │
                └──────────────────────────┘
```

## 3. ディレクトリ方針（後続Taskで作成）

```
lib/sales/            純粋関数（normalize, dedupe, eligibility, limits, state machine,
                      url validation, mailto/DM 文面生成, demo visibility）
lib/sales/schema.ts   ingest payload の schema（zod 等の軽量 validator。DEV-003 で選定）
lib/supabase/         server client（service role, server only）/ SSR auth client
app/api/internal/sales-agent/runs/route.ts
app/demo/[publicToken]/page.tsx  + templates/{bakery_v1,baked_goods_v1,cafe_v1}
app/admin/sales/{page.tsx, replies/, meetings/, history/}
supabase/migrations/  SQL（RLS・constraint を含む）
supabase/seed.sql     テスト用のダミーデータのみ（実店舗データ禁止）
tests/unit/           Vitest（DB不要）
tests/integration/    Vitest + ローカル Supabase（supabase start）
tests/e2e/            Playwright
```

**ドメインロジックは `lib/sales/` の純粋関数に集約**し、route handler / server action は薄く保つ。これにより Hard Rules を unit test で網羅できる。

## 4. データモデル（論理）

全テーブル RLS 有効。`id` は uuid、時刻は `timestamptz`。

### sales_prospects（店舗）
| 列 | 備考 |
|---|---|
| name, normalized_name | |
| address, normalized_address | 名古屋市内のみ（check constraint / 検証） |
| category | `bakery` / `baked_goods` / `cafe`（check） |
| website_status | `present` / `not_found` / `unknown`（check） |
| website_url, website_domain | domain は unique（partial, not null） |
| instagram_url, instagram_handle | handle は unique（partial） |
| public_email | 小文字化、unique（partial）。出典必須 |
| recommended_channel | `instagram` / `email` / null |
| do_not_contact, dnc_reason, dnc_set_at | 明示的な将来連絡拒否のときだけ admin が設定（通常の decline では設定しない）。解除も admin のみ |
| status | 営業状態（state machine） |
| first_seen_run_id | 最初にこの店舗を登録した run（追跡用） |

unique(normalized_name, normalized_address) による重複防止。

### sales_sources（事実の出典）
| 列 | 備考 |
|---|---|
| prospect_id | |
| field | 例: `name`, `address`, `hours`, `email`, `instagram_url`, `website_url` |
| value | |
| source_url | http(s) のみ。**サーバーは fetch しない** |
| source_type | `official_site` / `official_contact` / `official_profile` / `instagram_profile` / `map_listing` / `other` |
| verified_at | |

デモに出す事実は sales_sources で出典が確認できるものだけ。

### sales_demos
| 列 | 備考 |
|---|---|
| prospect_id | |
| public_token | 128bit 以上の乱数、unique |
| run_id | 生成した run（追跡用）。**unique(prospect_id)**: MVP はデモ1店舗1件。再送・resume で重複しない |
| template | `bakery_v1` / `baked_goods_v1` / `cafe_v1` |
| content | 表示用の確認済みテキスト（jsonb、公開可能項目のみ） |
| expires_at, disabled_at, keep_alive | 表示判定。作成時は `expires_at = null`（未送信: 公開 URL では 404、管理者プレビューのみ）、初回営業を送信済みにした時点で `sent_at + 30日` を設定。DNC 設定時は `disabled_at` を設定 |

### sales_outreaches（営業行為）
| 列 | 備考 |
|---|---|
| prospect_id, channel | 初回営業は prospect あたり1件（**unique(prospect_id) where kind='initial'**）。再送・resume・別 run でも重複しない |
| run_id | 下書きを作った run（追跡用） |
| kind | `initial` / `follow_up`（follow_up は email のみ・1回のみ） |
| subject, body | 文面 |
| status | `drafted` / `sent` / `replied` / `meeting` / `won` / `lost`（`followed_up` という状態は持たず、フォローは `kind=follow_up` の別行） |
| sent_at, replied_at, reply_type | reply_type: `interested` / `question` / `meeting_request` / `decline` / `other` |
| won_amount_jpy | status=`won` のとき必須（check） |

### sales_agent_runs（Operational run の実行状態・checkpoint）

run の現在地を**このテーブルだけから**判断できるようにする（詳細は §5, §7）。

| 列 | 備考 |
|---|---|
| run_id | Operational Claude が生成する UUID。**primary key / idempotency key** |
| status | `running` / `completed` / `failed`（check） |
| phase | `started` → `discovered` → `verified` → `persisting` → `completed`（check。後退しない） |
| checkpoint | jsonb。最後の安全な checkpoint の内容（§7.2）。**上限 64KB**（check constraint） |
| checkpoint_at | 最後に checkpoint を確定した時刻 |
| result | jsonb。completed 時の最終結果（再送時にそのまま返す） |
| error_code, error_summary | 直近のエラー（`error_summary` は 500 文字以内、secret・raw HTML を含めない） |
| started_at, finished_at, updated_at | |

`next_action`（次にどこから再開するか）は列に持たず、`status` と `phase` から純粋関数で導出する（§7.3）。

## 5. Ingest API

`POST /api/internal/sales-agent/runs` の**1 endpoint のみ**。body の `action` で操作を区別する（endpoint を増やさない）。

- 認証: `Authorization: Bearer <SALES_AGENT_INGEST_TOKEN>`（定数時間比較。未設定なら 503 で全拒否）。
- body は `action` による discriminated union として schema validation（不正は 400、何も書き込まない）。

| action | body | サーバーの処理 | 冪等性 |
|---|---|---|---|
| `start` | `runId` | run を `running / started` で作成 | 既存 run があれば作成せず現在の状態を返す |
| `status` | `runId?` | run の状態・checkpoint・`nextAction` を返す。`runId` 省略時は再開可能な最新 run（なければ `null`） | 読み取りのみ |
| `checkpoint` | `runId, phase: "discovered", candidates: stub[] (≤20)` | 候補の要約を checkpoint に保存し phase を進める | 同じ phase の再送は上書き保存（`persisting` 以降は拒否） |
| `checkpoint` | `runId, phase: "verified", candidates: verified[] (≤10。超過は 400 で全体拒否)` | 候補ごとに schema と入力 Hard Rules（URL scheme・Instagram host・email 出典形式等）を検証し、合格分を checkpoint に保存 | 同上 |
| `persist` | `runId` | `verified` checkpoint の候補を §7.4 の手順で処理し、候補ごとの stage を checkpoint に記録。全候補が終端に達したら（または試行上限で）`completed` にし `result` を保存 | 何度呼んでも同じ結果に収束（§7.3）。同じ run の `persist` 同時実行は 409 `run_busy` |
| `abort` | `runId, errorCode, errorSummary` | `failed` にする（Operational Claude が続行不能と判断した場合） | `failed` / `completed` への再送は no-op |

- `persist` は Operational Claude から候補を**受け取らない**。処理するのは直前に検証・保存した `verified` checkpoint だけなので、resume しても対象がぶれない。
- `completed` の run に `start` / `checkpoint` / `persist` を送った場合は処理せず、保存済みの `result` を返す（HTTP 200、`replayed: true`）。
- phase を飛ばす要求（例: `discovered` 前の `verified`、`verified` 前の `persist`）は 409 `phase_order_violation`。
- 返り値は常に `{ runId, status, phase, checkpointAt, nextAction, candidates: [{ key, stage, prospectId?, reason? }], replayed }`。
- この endpoint は DNC 変更・成約状態変更・送信を**一切できない**。
- `source_url` 等をサーバーから fetch しない（SSRF 経路を作らない）。
- 処理順の詳細・fail-closed 条件は §7。

## 6. 認証・認可

- 管理画面: Supabase Auth の **email + password**（MVP で固定。magic link は使わない）。
- 管理者判定: DB 上の allowlist（例: `sales_admins(user_id)` に1行）と RLS policy で行う。**「認証済みユーザー全員 = admin」にしない**。
- service role key は server only（`import "server-only"`）。ブラウザ・Operational Claude に渡さない。
- 公開デモは service role で必要列のみ select し、公開可能な値だけ props に渡す。

## 7. 耐障害性・再開性

設計基準: **「今この Claude セッションが消えても、別セッションが GitHub + Supabase だけを見て続きを再開できるか？」**

| 情報 | 正本 |
|---|---|
| コード・仕様・Task状態・進捗・blocker・review | GitHub（`docs/`, `.ai/`） |
| 営業候補・営業ログ・run 実行状態と checkpoint | Supabase（`sales_*` テーブル） |
| Secrets | Vercel / GitHub Actions secrets / Claude 環境変数（**GitHub に commit しない**） |
| Claude session / container | 一時的な作業場所（正本にしない） |

新規インフラ（Kafka, Redis, 新しい queue, 別DB等）は追加しない。GitHub + Supabase + Next.js + Claude Cloud だけで実現する。

### 7.1 run の phase と候補の stage

```
run phase:   started ──► discovered ──► verified ──► persisting ──► completed
                 (Operational Claude が調査)          (サーバーが処理)

候補 stage:  pending ──► [deduped ──► persisted ──► demo_ready] ──► outreach_ready   (成功)
                  └─► rejected(reason) / duplicate(prospectId)                    (終端・営業準備しない)
                  └─► error(code)                                                  (再試行可能・営業準備しない)
```

- `[ ]` 内の stage は1つの transaction 内の論理的な工程で、checkpoint に記録されるのは `pending` と結果（`outreach_ready` / `rejected` / `duplicate` / `error`）だけ。
- 候補の `key` は Operational Claude が `discovered` で付ける run 内で一意の短い文字列（例: `c01`）。`verified` の候補は `discovered` にある `key` だけを使える（未知の key は拒否）。
- `discover` / `verify`（Web 調査）は Operational Claude 側で行い、結果を checkpoint として保存する。
- `dedupe` / `persist` / `demo_ready` / `outreach_ready` はサーバー側で行う。
- phase は前進のみ。後退・飛び越しはサーバーが拒否する（run phase の遷移は `lib/sales/` の純粋関数 + DB の check / 条件付き update で強制）。

### 7.2 checkpoint（意味のある工程境界だけ）

| checkpoint | 保存するもの | 誰が確定するか |
|---|---|---|
| run 開始 | run_id, started_at | `start` |
| 候補探索完了 (`discovered`) | 候補 stub（key・店名・区・業種・公式サイト/Instagram URL）≤20 件 | `checkpoint` |
| 検証完了 (`verified`) | 検証済み候補 ≤10 件（website_status と再確認記録、第一者 email と出典、出典付き事実、推奨チャネル、営業文案） | `checkpoint` |
| dedupe/DNC 確認 → 永続化 → demo 準備 → outreach 準備 | 候補ごとの stage・prospectId・reason / error_code | `persist`（候補ごとに更新） |
| run 完了 | 最終 result（件数と候補ごとの結果） | `persist` |

- 1 検索ごと・1 ページごとの checkpoint は作らない。
- checkpoint に保存しない: raw HTML、画像、ページ本文、巨大データ、secret、token、Claude の内部推論全文。
- 1 run の checkpoint は 64KB 以下（超過は 413 で拒否し、状態は変えない）。

### 7.3 idempotency と resume

`run_id` を idempotency key とし、「同じ run_id は常に拒否」ではなく状態に応じて振る舞う。

| run の状態 | 同じ run_id の要求 | サーバーの振る舞い |
|---|---|---|
| 存在しない | `start` | 作成 |
| `running` | 同じ/次の phase | 続きから処理（resume） |
| `running` | 前の phase | 何もせず現在の状態を返す（遅延した再送とみなす） |
| `running`（最終 checkpoint から 24 時間超） | 任意 | その場で `failed` / error_code `run_expired` に確定し 409。新しい run_id で始める。runId なしの `status` は期限切れ run を返さない |
| `completed` | 任意 | 処理せず保存済み `result` を返す（`replayed: true`） |
| `failed` | 任意 | 処理しない。`nextAction: "start_new_run"` |

`nextAction` の導出（純粋関数）:

| status / phase | nextAction |
|---|---|
| running / started | `discover` |
| running / discovered | `verify`（checkpoint の stub を使い探索を再実行しない） |
| running / verified, persisting | `persist` |
| completed | `none` |
| failed, または期限切れ | `start_new_run` |

重複を防ぐ仕組み（多重防御）:

1. **run 単位**: `completed` の再送は保存済み結果を返すだけ。
2. **候補単位**: `persist` は checkpoint 上で終端 stage（`outreach_ready` / `rejected` / `duplicate`）の候補を再処理しない。
3. **checkpoint と業務データを同じ transaction で確定**: 候補の結果 stage は、prospect / demo / outreach の書き込みと同じ transaction で `sales_agent_runs.checkpoint` に書く。「行は作ったが checkpoint 未更新」の状態が起きない。
4. **DB 制約（最後の砦）**: prospect の dedupe キー unique、`sales_demos` unique(prospect_id)、`sales_outreaches` unique(prospect_id) where kind='initial'。万一再処理されても insert は失敗し、重複行はできない。
5. **自 run の再処理と別 run の重複の区別**: dedupe で一致した prospect の `first_seen_run_id` が同じ run かつ同じ候補 key なら、自分の既存結果（`outreach_ready` 等）を返す。別 run の prospect に一致した場合は `duplicate` とし、新しい demo / outreach を作らない。
6. **同時実行の直列化**: `persist` は run_id ごとの advisory lock（取れなければ 409 `run_busy`）で直列化し、各 transaction は run 行を `SELECT … FOR UPDATE` してから checkpoint を更新する。`checkpoint` action も run 行をロックして更新する。

### 7.4 persist の処理と fail-closed

候補ごとに**1 つの DB transaction**（Postgres 関数を service role から RPC で呼ぶ）で次を表の順に行う。dedupe・DNC・当日上限の確認から書き込みまでを、全 run 共通の advisory lock（`pg_advisory_xact_lock`）の下で行い、同時に走る別 run と上限・重複判定が競合しないようにする。途中のどこかが失敗・未確認なら transaction ごと rollback し、その候補は `error(code)` か `rejected(reason)` になる。`outreach_ready` に**確認が取れたものだけ**が到達する。

| 工程 | 確認できない / 失敗したとき | 結果 |
|---|---|---|
| dedupe（name+住所 / domain / Instagram / email） | 照合クエリ失敗 | `error(dedupe_unavailable)`。営業準備しない |
| DNC | 照合クエリ失敗 | `error(dnc_unavailable)`。営業準備しない |
| DNC 該当 | — | `rejected(do_not_contact)` |
| 当日上限（5件/日, JST） | 当日すでに新規 actionable になった prospect 数が上限 | `rejected(daily_cap)`。「新規 actionable」= 当日（JST）に初回営業の下書き（outreach_ready）が作られた prospect（全 run 合計）。verified 候補が最大10件でも当日の残り枠（最大5件）までで、枠は verified の提出順に割り当てる |
| website 確認 | 確認失敗は `unknown` として届く | `unknown` は Instagram 不可。第一者 email がなければ `rejected(no_eligible_channel)` |
| `not_found` の再確認記録 | 記録なし | `rejected(website_not_rechecked)` |
| 第一者 email 出典 | 出典なし / 第一者でない | Email 不可（Instagram 条件も満たさなければ `rejected(no_eligible_channel)`） |
| 永続化（prospect / sources） | 失敗 | `error(persist_failed)`。demo / outreach を作らない |
| demo 準備 | 失敗 | `error(demo_failed)`。outreach を作らない |
| outreach 下書き | 失敗 | `error(outreach_failed)` |

- 候補ごとの transaction なので「prospect はあるが demo だけない」等の中途半端な行は残らない。
- `error` の候補は再度 `persist` を呼べば再試行される（stage は checkpoint にあり、DB 制約で重複しない）。
- `persist` の試行回数は checkpoint に記録する。**3 回目の `persist` 後も `error` が残る場合、サーバーが run を `completed`（error_code `partial_errors`）で確定**し、残りの候補は `error` のまま営業準備しない。run が `persisting` に留まり続けて新しい探索を妨げることはない（該当店舗は後日の run で再発見されれば改めて処理される）。
- 管理画面の「今日」に出るのは `sales_outreaches`（kind=initial, status=drafted）が存在し、DNC でない店舗だけ。送信済みにする操作でも DNC をサーバー側で再確認する。
- これらは LLM の prompt ではなく、`lib/sales/` の純粋関数・API validation・DB 制約で強制する。

## 8. 環境

| 環境 | DB | 用途 |
|---|---|---|
| local / CI | ローカル Supabase（`supabase start`, Docker） | unit / integration / e2e |
| staging | Second Root 専用 Supabase（無料枠, 別 project） | Claude Cloud 実走確認（DEV-016） |
| production | Second Root 専用 Supabase | 本番（人間承認でのみ設定） |

mugi-no-mi 等の別 project と混ぜない。CI に Production の Supabase / secret を入れない。

## 9. 予定する環境変数（値は commit しない）

| 変数 | 公開範囲 | 導入 Task |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser 可 | DEV-001 / DEV-008 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser 可（RLS 前提） | DEV-008 |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | DEV-001 |
| `SALES_AGENT_INGEST_TOKEN` | server + Operational Claude のみ | DEV-003 |
| `SALES_ADMIN_EMAIL` 等 | server only | DEV-008 |
| `SALES_DEMO_BASE_URL` | server | DEV-004 |
