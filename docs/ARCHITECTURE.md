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
| do_not_contact, dnc_reason, dnc_set_at | DNC 解除は admin のみ |
| status | 営業状態（state machine） |
| first_seen_run_id | |

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
| template | `bakery_v1` / `baked_goods_v1` / `cafe_v1` |
| content | 表示用の確認済みテキスト（jsonb、公開可能項目のみ） |
| expires_at, disabled_at, keep_alive | 表示判定 |

### sales_outreaches（営業行為）
| 列 | 備考 |
|---|---|
| prospect_id, channel | 初回営業は prospect あたり1件（unique partial） |
| kind | `initial` / `follow_up`（follow_up は email のみ・1回のみ） |
| subject, body | 文面 |
| status | `drafted` / `sent` / `replied` / `meeting` / `won` / `lost` |
| sent_at, replied_at, reply_type | reply_type: `interested` / `question` / `meeting_request` / `decline` / `other` |
| won_amount_jpy | status=`won` のとき必須（check） |

### sales_agent_runs（Operational Job の実行状態・checkpoint）
| 列 | 備考 |
|---|---|
| run_id | Operational Claude が生成する UUID。**unique（idempotency key）** |
| status | `started` / `discovered` / `verifying` / `persisted` / `completed` / `failed` |
| checkpoint | jsonb（工程ごとの軽量な進捗） |
| submitted_count, accepted_count, rejected | 受理/拒否の件数と理由 |
| started_at, finished_at, error | |

## 5. Ingest API

`POST /api/internal/sales-agent/runs`

- 認証: `Authorization: Bearer <SALES_AGENT_INGEST_TOKEN>`（定数時間比較）。
- body: `{ runId, stage, candidates[] }`（schema は DEV-003 で確定）。
- 処理順:
  1. token 検証 → schema validation（不正は 400、全体拒否）
  2. `runId` idempotency（同一 runId・同一 stage の再送は前回結果を返す）
  3. batch 上限（5件）と当日新規上限（5件/日, Asia/Tokyo）
  4. URL validation（http/https のみ、Instagram は instagram.com host のみ）
  5. DNC / 重複照合 → 既存 record 再利用
  6. channel eligibility（unknown の Instagram 除外、email provenance 必須）
  7. 保存（prospect / sources / demo / outreach draft）と run checkpoint 更新
- 返り値: 候補ごとの `accepted` / `rejected(reason)` / `duplicate(existingId)`。
- この endpoint は DNC 変更・成約状態変更・送信を**一切できない**。
- `source_url` をサーバーから fetch しない（SSRF 経路を作らない）。

## 6. 認証・認可

- 管理画面: Supabase Auth（email + password または magic link、DEV-008 で決定）。
- 管理者判定: DB 上の allowlist（例: `sales_admins(user_id)` に1行）と RLS policy で行う。**「認証済みユーザー全員 = admin」にしない**。
- service role key は server only（`import "server-only"`）。ブラウザ・Operational Claude に渡さない。
- 公開デモは service role で必要列のみ select し、公開可能な値だけ props に渡す。

## 7. 耐障害性・再開性

| 情報 | 正本 |
|---|---|
| コード・仕様・Task状態・進捗・blocker・review | GitHub（`docs/`, `.ai/`） |
| 営業候補・営業ログ・run 実行状態 | Supabase |
| Secrets | Vercel / GitHub Actions secrets / Claude 環境変数（**GitHub に commit しない**） |
| Claude container | 一時的な作業場所（正本にしない） |

- Operational run は `sales_agent_runs` に checkpoint（開始 → 候補探索完了 → 検証中 → 永続化 → 完了）を残し、同じ `runId` で再送しても重複しない。
- 新規インフラ（Kafka, Redis, 別DB等）は追加しない。

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
