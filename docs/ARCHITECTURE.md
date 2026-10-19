# Second Root Sales Agent — Architecture

> 仕様は `docs/MVP_SPEC.md`、セキュリティ要件は `docs/SECURITY.md` を正本とする。
> 本書は「どこに何を置くか」の設計。詳細な列定義・制約・関数は `supabase/migrations/` が正本。

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
app/api/webhooks/instagram/route.ts  Meta 公式 webhook（署名検証・冪等保存）
lib/instagram/        署名検証・webhook 解析・返信案検証・Graph API（server only）・承認済み返信の送信
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
| do_not_contact, dnc_reason, dnc_set_at | 明示的な将来連絡拒否のときだけ admin が設定（返信記録の「今後の連絡を拒否された」で `dnc_reason = explicit_refusal`。通常の decline では設定しない）。解除も admin のみ。解除してもデモの `disabled_at` は戻さない |
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

### sales_exclusions（除外リスト、DEV-049 / DEV-050）
| 列 | 備考 |
|---|---|
| label / reason / note | 表示名・`existing_customer` / `partner` / `other`・任意のメモ |
| instagram_handle / website_domain | ingest と同じ正規化。それぞれ partial unique |
| email_digest | DEV-050: メールの**アドレスは持たない**。正規化メールの digest（64 桁 hex、partial unique）。候補の `email_digest`（候補が出したメール、第一者でなくても）と照合し、それが無い旧い checkpoint は第一者の `public_email` から同じ方式で作って照合する |
| normalized_name + normalized_address | 2 つで 1 キー（片方だけは不可）。partial unique |
| created_by | 登録した管理者 |

照合キーが 1 つ以上必要。読み取りは管理者だけ（RLS）。追加・削除は `sales_add_exclusion` / `sales_remove_exclusion`（SECURITY DEFINER、最初に管理者を確認）だけで、API role の直接書き込みは無い。`sales_persist_candidate` が §7.4 の順で照合する。

メールの digest（DEV-050、`lib/sales/email-digest.ts`）:

- 方式: `sha256("second-root/exclusion-email/v1\n" + normalizeEmail(address))` の hex。server action と `prepareCandidate` が同じ関数で計算し、SQL の旧 checkpoint 向けの照合も同じ接頭辞で作る。平文のアドレスは DB・関数の引数・DB のログに届かない（`sales_add_exclusion` は digest の形を insert の前に検査し、制約違反で行の中身がログに出ないようにする）。表示名・メモにアドレスの形の文字列は入れられない（画面と DB の check）。
- 限界: 鍵のない hash なので、admin だけが読める行を読める人は、推測したアドレスが登録済みかを確かめられる（辞書攻撃）。接頭辞は、一般的な `sha256(email)` の対応表をそのまま使えなくするだけ。
- より安全な方式（承認が要る次の段階）: サーバーだけが持つ secret を鍵にした HMAC-SHA256。候補側（ingest）と管理画面の両方が同じ鍵を持つ必要があり、新しい secret の追加・鍵の交換時の再計算（除外リストと進行中の checkpoint）が要るため、人の承認の後に別 task で行う。接頭辞の版（`v1`）を上げて移行できる。

### sales_rejected_candidates（却下した候補の記憶、DEV-054）
| 列 | 備考 |
|---|---|
| key_type / key_value | `instagram_handle` / `website_domain` の 2 種だけ（check）。探索段階の照合（`sales_discovery_known_keys`）が使うキーと同じで、ingest と同じ正規化（`parseInstagramProfile` / `websiteKey`）。店名・住所・メールは保存しない（照合に使わないため）。unique(key_type, key_value)。key_value に空白・メールの形は入らない（check） |
| reason | `site_without_email` だけ（check）。公式サイトがあり第一者メールがない、という店舗そのものが理由で出典確認の後に決まる却下（`lib/sales/discovery.ts` の `DURABLE_REJECTIONS`）。候補がメールを**一つも提出していない**ときだけ記録する（提出したメールが不採用だった場合は提出の誤りの可能性があるため記録しない） |
| run_id | 最後に却下した run（追跡用） |
| first_rejected_at / last_rejected_at / expires_at | 期限は最後の却下から 90 日。期限切れの行は照合に使わず、次の書き込みで削除する |

- 書き込みは service role の `sales_remember_rejections(run_id, entries)` だけ。verified の checkpoint を保存した後に ingest API が呼び、その run の checkpoint に同じ key が同じ理由で `rejected` として残っているものだけを記録する（それ以外は無視）。同じ key の再記録は理由・run・期限を更新するだけ（冪等）。送る前にサーバーが各キーを表の check と同じ規則（形・長さ・空白・メールの形）で検証し（`validMemoryEntries`）、関数側も表が拒むキー（check / not null 違反）はそのキーだけ飛ばして残りを記録する。失敗しても run には影響しない（次回また verify されるだけ）。
- 記憶しない: 当日上限・エラー（一時的）、出典不足・再確認不足・unknown・URL 不正・提出したメールの不採用など提出内容の問題、市外・対象外業種（出典確認の前に決まる）、`no_eligible_channel`（公式サイトも Instagram もなく、照合に使えるキーがない）、除外・DNC・重複（除外リストと prospect が答える。除外の削除がすぐ効くように）。
- 90 日の理由: 店舗の Web の状況（サイトの閉鎖・メールの掲載・Instagram の開始）は数か月で変わりうる。1 日 1 run・20 件の探索で同じ店舗が繰り返し見つかるのを止めるには十分長く、四半期ごとに見直される程度に短い。保存する情報も期限で消える。
- メールは平文も digest も持たない（stub にメールが無く、探索段階の照合に使えないため）。読み取りは管理者だけ（RLS）、API role の直接書き込みは無い。

### sales_demos
| 列 | 備考 |
|---|---|
| prospect_id | |
| public_token | 128bit 以上の乱数、unique |
| run_id | 生成した run（追跡用）。**unique(prospect_id)**: MVP はデモ1店舗1件。再送・resume で重複しない |
| template | `bakery_v1` / `baked_goods_v1` / `cafe_v1` |
| content | 表示用の確認済みテキスト（jsonb、公開可能項目のみ） |
| expires_at, disabled_at, keep_alive | 表示判定。作成時は `expires_at = null`（未送信: 公開 URL では 404、管理者プレビューのみ）、初回営業を送信済みにした時点で `sent_at + 30日` を設定。DNC 設定時は `disabled_at` を設定 |
| design_status | AI デザインの状態（DEV-030）。`null` = legacy（AI デザインなし。flag 無効のとき・migration 前のすべての demo）/ `pending` / `processing` / `ready` / `blocked` / `failed`（check）。§10 |
| design_profile | `ready` のときだけ（check で同値）。検証済みの DesignProfile（rationale は空）。8KB 以下・`version = 1`。読むたびに server が DesignProfileSchema で再検証する |
| design_job_id, design_attempts, design_claimed_at | job の lineage（claim ごとに新しい uuid、unique）・試行回数（≤ 3）・lease の開始。`processing` には job id と lease が必須（check） |
| design_worker_commit, design_error_code, design_updated_at | worker の commit（sha）・固定の符号（`^[A-Z][A-Z0-9_]{2,47}$`。自由文は入らない）・最終更新 |

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
| `start` | `runId` | run を `running / started` で作成 | 既存 run があれば作成せず現在の状態を返す（`replayed: true`）。**別の run が running の間は作成せず 409 `run_in_progress`**（24 時間 checkpoint がない run は先に `failed / run_expired` にするので妨げない。DEV-025） |
| `status` | `runId?` | run の状態・checkpoint・`nextAction` を返す。`runId` 省略時は実行中の run → なければ今日（Asia/Tokyo）開始の run（completed は 200、failed は 409 と `start_new_run`）→ なければ `null`（§7.3） | 読み取りのみ |
| `checkpoint` | `runId, phase: "discovered", candidates: stub[] (≤20)` | 候補の要約を checkpoint に保存し phase を進める。DEV-054: 保存の前に stub の Instagram handle / 公式サイトのキーを既知の店舗（prospect・DNC・除外リスト・却下の記憶）と照合し、当たった stub に `known: true` を付けて保存する（`sales_discovery_known_keys`。照合失敗は印なしで保存） | 同じ phase の再送は上書き保存（`persisting` 以降は拒否）。再送のたびに照合し直す |
| `checkpoint` | `runId, phase: "verified", candidates: verified[] (≤10。超過は 400 で全体拒否)` | 候補ごとに schema と入力 Hard Rules（URL scheme・Instagram host・email 出典形式等）を検証し、合格分を checkpoint に保存。DEV-054: 保存できたら、店舗そのものが理由の却下を `sales_rejected_candidates` に記録する（best effort） | 同上 |
| `persist` | `runId` | `verified` checkpoint の候補を §7.4 の手順で処理し、候補ごとの stage を checkpoint に記録。全候補が終端に達したら（または試行上限で）`completed` にし `result` を保存 | 何度呼んでも同じ結果に収束（§7.3）。同じ run の `persist` 同時実行は 409 `run_busy` |
| `inbox_pending` | `limit?`（≤20） | Instagram の未処理の返信（最新の受信に返信案がない会話）を古い順に返す。未照合の会話は公式 API の username で安全に照合を試みる（DEV-021、`docs/INSTAGRAM_MESSAGING.md`） | 読み取りのみ（照合は一意な場合だけ） |
| `inbox_draft` | `threadId, messageId, replyType, body, futureContactRefused` | 返信案を検証して保存（連絡先・他の URL は拒否、価格・納期・契約の表現は人間確認の印、明示的な拒否は dnc_candidate）。**送信はしない** | 同じ messageId の再送は同じ案を更新、古い messageId は 409 |
| `abort` | `runId, errorCode, errorSummary` | `failed` にする（Operational Claude が続行不能と判断した場合） | `failed` / `completed` への再送は no-op |

- `persist` は Operational Claude から候補を**受け取らない**。処理するのは直前に検証・保存した `verified` checkpoint だけなので、resume しても対象がぶれない。
- `completed` の run に `start` / `checkpoint` / `persist` を送った場合は処理せず、保存済みの `result` を返す（HTTP 200、`replayed: true`）。
- phase を飛ばす要求（例: `discovered` 前の `verified`、`verified` 前の `persist`）は 409 `phase_order_violation`。
- 返り値は常に `{ runId, status, phase, checkpointAt, nextAction, candidates: [{ key, stage, prospectId?, reason? }], replayed }`。
  DEV-054 で追加（後方互換、既存の項目は不変）: `knownKeys`（discovered のうちサーバーが既知と判定した key）と `discovered[].known`（boolean）。どの一覧に当たったか・理由は返さない（`docs/MVP_SPEC.md` §3.5.2）。`known` は Operational Claude からは送れない（strict schema で 400）。
- この endpoint は DNC 変更・成約状態変更・送信を**一切できない**。
- `source_url` 等をサーバーから fetch しない（SSRF 経路を作らない）。
- 処理順の詳細・fail-closed 条件は §7。
- 実装: `app/api/internal/sales-agent/runs/route.ts`（認証・サイズ・schema）、`lib/sales/ingest-schema.ts`（request schema の正本）、`lib/sales/prepare.ts`（verified 候補の検証・正規化・チャネル決定・デモ内容）、`lib/sales/discovery.ts`（DEV-054: 探索段階の照合キーと記憶する却下）、`lib/sales/ingest.ts`（action 実行）。
- HTTP: 200 正常 / 400 schema・内容不正（値は返さない）/ 401 token 不一致 / 404 run なし / 409 phase 違反・run_busy・run_in_progress・failed run（`nextAction: start_new_run`）/ 413 本文 256KB 超・checkpoint 64KB 超 / 503 token 未設定・DB 不達。

## 6. 認証・認可

- 管理者の追加は人間が行う: Supabase Dashboard の Authentication でユーザーを作成し、SQL Editor で `insert into public.sales_admins (user_id) values ('<uuid>');`。公開 sign-up は無効（`supabase/config.toml` と本番 Auth 設定の両方）。

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
| 候補探索完了 (`discovered`) | 候補 stub（key・店名・区・業種・公式サイト/Instagram URL）≤20 件。既知の店舗の stub にはサーバーが `known: true` を付ける（DEV-054） | `checkpoint` |
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
| 実行中の run なし | runId なしの `status` | 今日（Asia/Tokyo）開始の run があればその状態を返す（completed → `none`、failed → `start_new_run`）。Operational Claude はどちらでもその日は新しい run を始めない（1 日 1 run）。今日の run がなければ `null`。1 日 1 run は prompt で守り、サーバーは新しい runId の `start` を拒否しない（同時起動で 2 run になっても、当日の新規 actionable 上限 5 件は全 run 共通の lock 下で数えるため超えない） |
| `completed` | 任意 | 処理せず保存済み `result` を返す（`replayed: true`） |
| `failed` | 任意 | 処理しない。`nextAction: "start_new_run"` |

`nextAction` の導出（純粋関数）:

| status / phase | nextAction |
|---|---|
| running / started | `discover` |
| running / discovered | `verify`（checkpoint の stub を使い探索を再実行しない。この間は応答の `discovered` に stub が入るので、新しい session でも記憶なしで再開できる） |
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
7. **running の run は常に 1 本**: `sales_agent_runs` の partial unique index（`where status = 'running'`）で、同時に 2 本の run が running になれない。`start` が重なっても後から commit する方は unique violation になり、409 `run_in_progress`（同じ runId なら `replayed`）を返す（migration `20260928000100`、DEV-025）。

### 7.4 persist の処理と fail-closed

候補ごとに**1 つの DB transaction**（Postgres 関数を service role から RPC で呼ぶ）で次を表の順に行う。dedupe・DNC・当日上限の確認から書き込みまでを、全 run 共通の advisory lock（`pg_advisory_xact_lock`）の下で行い、同時に走る別 run と上限・重複判定が競合しないようにする。途中のどこかが失敗・未確認なら transaction ごと rollback し、その候補は `error(code)` か `rejected(reason)` になる。`outreach_ready` に**確認が取れたものだけ**が到達する。

| 工程 | 確認できない / 失敗したとき | 結果 |
|---|---|---|
| dedupe（name+住所 / domain / Instagram / email） | 照合クエリ失敗 | `error(dedupe_unavailable)`。営業準備しない |
| 除外リスト（DEV-049。既存顧客など、管理者が登録。自 run の再処理は除く） | 照合クエリ失敗 | `error(exclusion_unavailable)`。営業準備しない。該当は `rejected(excluded)`（当日上限の枠を使わない） |
| DNC | 照合クエリ失敗 | `error(dnc_unavailable)`。営業準備しない |
| DNC 該当 | — | `rejected(do_not_contact)` |
| 当日上限（5件/日, JST） | 当日すでに新規 actionable になった prospect 数が上限 | `rejected(daily_cap)`。「新規 actionable」= 当日（JST）に初回営業の下書き（outreach_ready）が作られた prospect（全 run 合計）。verified 候補が最大10件でも当日の残り枠（最大5件）までで、枠は verified の提出順に割り当てる |
| website 確認 | 確認失敗は `unknown` として届く | `unknown` は Instagram 不可。第一者 email がなければ `rejected(no_eligible_channel)` |
| `not_found` の再確認記録 | 記録なし | `rejected(website_not_rechecked)` |
| 第一者 email 出典 | 出典なし / 第一者でない | Email 不可（Instagram 条件も満たさなければ `rejected(no_eligible_channel)`） |
| 永続化（prospect / sources） | 失敗 | `error(persist_failed)`。demo / outreach を作らない |
| demo 準備 | 失敗 | `error(demo_failed)`。outreach を作らない |
| outreach 下書き | 失敗 | `error(outreach_failed)` |

- DEV-054 の探索段階の `known` の印と却下の記憶は、この表の判定を変えない。印の付いた店舗が提出されても、この表の順で判定される。
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
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` / `INSTAGRAM_APP_SECRET` / `INSTAGRAM_ACCOUNT_ID` / `INSTAGRAM_ACCESS_TOKEN` | **server only**（Operational Claude にも渡さない。設定は人間: `docs/INSTAGRAM_SETUP.md`） | DEV-020〜024 |
| `SALES_AI_DESIGN_ENABLED` | server。`"true"` のときだけ AI デザイン step が有効（unset・他の値は無効）。migration `20261009000000` の適用後にだけ有効にする | DEV-030 |
| `SALES_DESIGN_BRIDGE_TOKEN_SHA256` | server only。bridge token の SHA-256（64 桁の hex）。token そのものは local bridge（Linux 利用者 `sr-designbridge` の 0600 file）にだけあり、server には置かない（置くと 503）。ingest token とは別の token。design worker（`sr-designgen`）・Operational Claude には渡さない | DEV-030 / DEV-032 |

## 10. Sales Design Bridge（DEV-030）

既存の Sales Agent（§5・§7。5 件/日・DNC・重複排除・初回は人間送信）は変えずに、`sales_demos` と人間の送信の間に AI デザインの step を足す。
**既定は無効**（`SALES_AI_DESIGN_ENABLED` が `"true"` のときだけ有効）。無効のときは、ingest の RPC 呼び出し・公開 demo・管理画面の query と表示・送信済み操作がすべて既存と同じで、DB の新しい列にも触れない（migration 前に deploy しても安全）。

```
Operational Claude ─► ingest API ─► persist（同じ transaction で demo を design_status=pending）
                                            │
Second Root server                          ▼
  POST /api/internal/sales-design/jobs   sales_demos（pending → processing → ready / blocked / failed）
      ▲  Bearer <bridge token>（server は SHA-256 だけを持つ。claim / submit だけ）
      │  https
local bridge（Linux 利用者 sr-designbridge。token を持つ唯一の local process）
      │  /srv/sr-design-bridge/to-worker   （job: 確認済みの facts と source URL だけ）
      ▼  /srv/sr-design-bridge/from-worker （result: outcome・DesignProfile・符号・commit だけ）
design worker（sr-designgen、jail の中。token・DB・server を知らない）
      → 公式サイト / Instagram の reference 撮影 → Codex art direction → DesignProfile
```

### 10.1 状態（`sales_demos.design_status`）

| 状態 | 意味 | 次 |
|---|---|---|
| `null` | legacy demo（flag 無効で作られた・migration 前の demo） | 変わらない |
| `pending` | デザイン待ち | `sales_design_claim` で `processing` |
| `processing` | job を bridge に渡した（`design_job_id`・`design_claimed_at`） | submit で `ready` / `blocked` / `failed`（試行が残れば `pending`）。lease（2 時間）を過ぎたら次の claim が回収して `pending`（job id は消すので、その job の遅れた結果は `job_superseded`。3 回目なら `failed` / `DESIGN_STALE`） |
| `ready` | 検証済みの profile がある | 終端。**再生成しない** |
| `blocked` | AI デザインを使えない（`PUBLIC_SOURCE_UNAVAILABLE`・`FALLBACK_TEMPLATE`・`DESIGN_BLOCKED`・`RENDERER_CHANGE_NEEDED`・`QUALITY_NOT_ACCEPTED`（DEV-053、§10.4）・`DO_NOT_CONTACT`・`DEMO_DISABLED`・`ALREADY_SENT`・`OUTREACH_CLOSED`（送らずに失注にした）・`NO_VISUAL_SOURCE`・`DEMO_CONTENT_INVALID`） | 終端。既存 template で表示 |
| `failed` | 3 回試しても結果が出ない | 終端。既存 template で表示 |

- claim は全体の advisory lock の下で `for update skip locked` で 1 件ずつ取る。同じ demo を二重に渡さない。
- submit は job id で demo を特定する（lineage）。今の job でない id（lease 切れで回収された古い job）は `job_superseded`（409）で捨てる。同じ job の再送は何も変えず `replayed`。
- 初回営業がもう送信済みなら、demo を後から変えない（claim でも submit でも `blocked` / `ALREADY_SENT`）。DNC・無効化済みの demo もデザインしない。
- 関数は service role だけが実行できる（`sales_design_claim` / `sales_design_submit`、migration `20261009000000`）。

### 10.2 bridge API（`POST /api/internal/sales-design/jobs`）

| action | body | 返すもの |
|---|---|---|
| `claim` | なし | `{ job: { jobId, workerJobId: "b-<jobId>", attempt, facts, source } \| null }`。facts は fact-only の DemoView に通るものだけ（email・未知の key は落ちる）、source は検証済みの公式サイト（`website_status = present`、SNS・portal は除く）と canonical な Instagram profile URL だけ |
| `submit` | `jobId, outcome (ready / blocked / failed), profile (ready のときだけ、rationale は空), errorCode (ready 以外、固定の符号), workerCommit, lineage.workerJobId` | `{ result: { jobId, status, errorCode, attempts, replayed } }` |

- 認証: `Authorization: Bearer <bridge token>`。server は `SALES_DESIGN_BRIDGE_TOKEN_SHA256`（64 桁の hex）だけを持ち、受け取った token を SHA-256 して定数時間で比べる（DEV-032）。flag 無効・hash 未設定 / 不正・token そのものが server に設定されている・ingest token の hash と同じ、なら **503**、不一致は 401。ingest token では通らず、bridge token で ingest API も通らない。
- strict schema: 未知の key（screenshot・HTML・Cookie・prompt・Codex の出力・stderr・推論など）があれば 400 で何も書かない。値は返さない。本文は 32KB まで。
- profile は server でも `checkProfile`（schema・contrast・motif の重複）を通らなければ 400。
- server は source URL を fetch しない。
- 実装: `app/api/internal/sales-design/jobs/route.ts`、`lib/sales/design-bridge-schema.ts`（両側共通の schema）、`lib/sales/design-bridge.ts`、`lib/sales/design-bridge-auth.ts`、`lib/sales/design.ts`（flag と規則）。

### 10.3 公開 demo と管理画面

- `/demo/[publicToken]`: flag 有効・`ready`・profile が再検証を通る → `ProfileRenderer`（写真なし）。それ以外 → 既存の bakery / baked_goods / cafe template。表示の可否（送信済み・30 日・無効化・DNC）と notice・footer・noindex は既存のまま。表示文は fact-only の DemoView と固定の見出しだけ。
- 公開しないもの: DEV-029 の写真、Instagram・公式サイトの screenshot、capture helper の PNG、reference 画像。保存するのは validated DesignProfile と最小の metadata（状態・job id・試行回数・commit・符号）だけ。
- `/admin/sales`（今日）: 初回の項目に「AIデザイン待ち / AIデザイン生成中 / デモ確認可能 / デザインBLOCKED / AIデザイン失敗」を出す。flag 有効で `pending` / `processing` の項目は送信ボタンを出さず、「送信済み」もサーバー（server action）で拒否する。`ready` はプレビューへのリンクを出す。`blocked` / `failed` は既存 template のデモで送れる。
  - `design_error_code` の管理画面向けの文言は `lib/sales/design.ts` の `DESIGN_ERROR_LABEL` / `designErrorLabel`（DEV-053。`QUALITY_NOT_ACCEPTED` を含む）。今日の一覧（`lib/admin/today.ts`）は flag 有効時だけ `design_error_code` を読み、`blocked` / `failed` の初回の項目に「理由: …」として表示する（flag 無効時の query は従来と同じ）。
  - この拒否は server action で行い、DB の `sales_mark_sent`（管理者だけが呼べる RPC）は変えていない。flag は env にあり DB からは見えないため、flag 無効時の legacy の挙動を DB で崩さないための選択。管理者が RPC を直接呼べば送信済みにできるが、それは管理者本人の操作に限られる。
  - flag を一度無効にして、その間に待ち・生成中の demo を送った後で再び有効にすると、その demo は `ALREADY_SENT` で閉じる（送った後でページを変えない）。
- `/admin/preview/[prospectId]`: 公開ページと同じ描き方と、デザインの状態。

### 10.4 local bridge と worker

- `scripts/sales-design-bridge/run.sh --once`（`bridge.ts`）: 利用者 `sr-designbridge` だけで動く（root・`sr-designgen`・`sr-igcapture` では止まる）。token は 0600 の file から読み、環境変数にしない。子 process を起動しない。1 回で「結果の提出 → 期限切れの job の破棄 → 1 件の claim」。`--deliver-only` は「結果の提出 → 期限切れの job の破棄」だけで、claim を頼まず worker 用の job file も書かない（DEV-037）。
- worker は `SR_DESIGN_BRIDGE_SPOOL` があるときだけ、run の前に `to-worker/` の job を自分の inbox に取り込み、run の後に終わった bridge job の結果を `from-worker/` に書く（`lib/design-agent/bridge/worker-side.ts`）。書くのは outcome・final profile（rationale を落として `checkProfile` を通したもの）・固定の符号（既知の符号だけ。他は `WORKER_FAILED`）・commit だけ。
  - run の初めに heartbeat（`from-worker/worker-heartbeat.json`）を書く。bridge は heartbeat が 90 分以内のときだけ claim する。worker が止まっている間に job が lease を待ち切って試行を使い切ることはない。**bridge を動かす間は、worker を少なくとも 1 時間に 1 回動かす。**
  - bridge が手放した job（spool の job file が消えた）は、inbox で待っていれば取り下げ、結果も書かない。閉じた job の結果 file は worker が消す。
  - **品質ゲート（DEV-053）**: final は従来どおり点の最も高い candidate（同点は後）だが、`ready` で出すのはその candidate の最後の review（best の再 review を含む）が `accept` のときだけ。accept でなければ（改訂の上限・改訂 profile なし・時間切れ・後の review の失敗）pipeline は `blocked`、notes と `report.json` の `codex.quality_not_accepted` に記録し、bridge には `blocked` / `QUALITY_NOT_ACCEPTED`（profile なし）を出す。demo は既存 template で、送信は止めない（他の `blocked` と同じ）。final.json・after の画像・`rounds`（verdict と点数）・`final_candidate` は worker の記録に残る（Codex の文章は残さない）。renderer の変更が要る stop（`RENDERER_CHANGE_NEEDED`）・写真の描画不一致・template への fallback・環境の失敗は変わらない。
    - 基準は verdict だけ。review の schema・enum・点の計算・`MAX_REVISIONS`（2）・confidence の閾値 0.5 は変えていない。点数の下限（例: `mobile_quality` が一定未満なら止める）は足していない。足すなら既存の 1〜5 の点から名前つきの定数で決め、根拠をここに書く（人の判断）。
    - 実装: `lib/design-agent/pipeline.ts`（`QUALITY_NOT_ACCEPTED`・`finalAccepted`）、`lib/design-agent/bridge/worker-side.ts`（`resultFromRecords`）、`lib/design-agent/bridge/spool.ts`（既知の符号）。DB の `sales_design_submit` は `blocked` と固定の符号（`^[A-Z][A-Z0-9_]{2,47}$`）をそのまま受けるので migration は要らない。
  - worker の profile は写真つきで選ばれることがある（DEV-029 の写真 job）が、公開 demo は写真なしで描く。bridge の job には写真を付けない運用にする（写真の公開は後続 DEV）。
- spool の file は link を辿らず、通常ファイル・link 数 1・サイズ上限・strict schema で読む（`lib/design-agent/bridge/spool.ts`）。
- systemd の unit（`scripts/sales-design-bridge/systemd/`）は repo に置くだけで、install・enable は人が行う。手順: `docs/operations/design-bridge.md`。

