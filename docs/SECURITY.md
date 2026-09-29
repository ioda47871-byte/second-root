# Security — Second Root Sales Agent

## 1. Secret の扱い

| Secret | 置き場所 | 渡してよい相手 |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env（server only） | Second Root サーバーのみ |
| DB password | Supabase / 人間のパスワード管理 | 人間のみ |
| `RESEND_API_KEY` | Vercel env | 問い合わせフォーム（`/api/contact`）のみ |
| `SALES_AGENT_INGEST_TOKEN` | Vercel env + Claude Cloud 環境 | Operational Claude（**これだけ**。例外は下の Staging 用 bypass 値のみ） |
| `SALES_AGENT_VERCEL_BYPASS`（Staging のみ・任意） | Staging の Routine environment だけ | Operational Claude（Vercel Preview の保護を通るためだけ。ingest には token が別に必要）。Vercel の Protection Bypass for Automation の値で **project 全体の保護付き deployment に効く**ため、露出が疑われたら人間が Vercel で再生成する。Production には置かない |
| Vercel token / GitHub write token / admin password | 人間 | 人間のみ |

- Secret を GitHub に commit しない。`.env*` は `.gitignore` 済み（`.env.local.example` のみ例外、値はダミー）。
- CI は `npm run check:secrets` で追跡ファイルを検査する。
- CI に Production の Supabase / secret を入れない。CI はローカル Supabase とテスト用ダミー値のみ使う。
- server only のモジュールは `import "server-only"` で browser bundle への混入を防ぐ。

## 2. 認証・認可

- 管理画面は Supabase Auth。**明示された管理者1名だけ**を RLS / allowlist で許可する。認証済みユーザー全員を admin にしない。
- ingest API は専用 Bearer token。比較は定数時間（`crypto.timingSafeEqual`）。token 未設定時は 503 で全拒否（fail closed）。
- ingest API は DNC 変更・成約状態変更・送信の権限を持たない。
- DNC 解除は管理者 UI からのみ。
- DB: `sales_*` の全テーブルで RLS 有効、anon の権限なし、authenticated の直接書き込み権限なし。
  `sales_*` / `is_sales_admin` の関数はすべて `search_path` 固定。authenticated が呼べる `sales_*` 関数は SECURITY DEFINER の管理者 RPC だけで、最初の文で管理者を確認する。
  helper / trigger 関数の EXECUTE は service_role のみ。PUBLIC の EXECUTE はスキーマ単位の既定では外せないため、関数を作る migration は必ず `revoke all on function … from public, anon, authenticated` してから必要な role にだけ grant する。
  これらは `tests/integration/db-security-audit.test.ts` が全関数・全テーブルに対して検査する。

## 3. 入力検証

- ingest payload は schema validation を必須とし、未知フィールドは拒否または除去。
- URL は `http:` / `https:` のみ許可。`javascript:` / `data:` / `file:` / `vbscript:` 等は拒否。
- Instagram URL は `instagram.com` / `www.instagram.com` host のみ許可。
- メールアドレスは第一者出典（`source_url` + `source_type`）必須。推測メール禁止。
  `official_site` / `official_contact` は検証済み公式サイトと同じサイト上、`official_profile` は候補自身の検証済み Instagram プロフィールだけを認める。
- 文字列長の上限を設ける（DoS / 表示崩れ対策）。
- `action` ごとの discriminated union で検証し、phase の飛び越し・後退はサーバーが拒否する（Operational Claude の申告を信用しない）。

## 3.1 run checkpoint の内容

- `sales_agent_runs.checkpoint` / `result` / `error_summary` に保存しない: raw HTML、画像、ページ本文、secret、token、Cookie、Claude の内部推論全文。
- checkpoint は 1 run 64KB 以下（DB の check constraint とAPI で二重に制限）。`error_summary` は 500 文字以内。
- `sales_agent_runs` は RLS で管理者のみ read、書き込みは ingest API（service role, server only）のみ。

## 4. SSRF

- Second Root サーバーは Claude が提出した `source_url` 等を **fetch しない**。
- 公式サイト確認は Operational Claude 側で行い、サーバーは記録のみ。

## 5. XSS / 表示

- Claude 取得テキストを `dangerouslySetInnerHTML` で表示しない。React の標準 escape を使う。
  - 既存の `app/layout.tsx` の JSON-LD（固定値）は対象外。Sales Agent 関連ディレクトリでの使用は `tests/unit/guardrails.test.ts` で禁止を検査する。
- `href` に入れる URL は必ず URL validation を通す。
- `mailto:` は `encodeURIComponent` で各パラメータをエンコードする。

## 5.1 HTTP ヘッダ（`/demo`・`/admin`・`/api/internal`）

- `X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`、`Cache-Control: private, no-store`
- `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`（管理画面の clickjacking 防止）
- `X-Content-Type-Options: nosniff`、`Permissions-Policy`（camera / microphone / geolocation 無効）
- 既存 Second Root のページのヘッダは変更しない。

## 5.2 依存関係

- `npm audit --omit=dev` で high / critical を 0 に保つ（DEV-017 で Next.js 16.3.0 → 16.3.6: Image Optimization の RCE 等の advisory、sharp の libheif advisory を解消）。
- Release 前に再確認する（`docs/RELEASE.md`）。

## 6. 公開デモ

- `publicToken` は `crypto.randomBytes(32)` 等の暗号学的乱数（128bit 以上）。連番・推測可能 ID を使わない。
- `noindex,nofollow`（meta）＋ `X-Robots-Tag: noindex, nofollow`。
- 絶対に出さない: 営業内部メモ / メールアドレス / Claude 内部評価 / 成約金額 / outcome / internal ID / secret。
- 期限切れ・無効化されたデモは 404 相当（存在有無を区別しない）。
- 事実は確認済み公開情報のみ。Instagram 画像等の無断転載をしない。

## 7. Resend

- `resend` の import は `app/api/contact/route.ts` のみ許可（`tests/unit/guardrails.test.ts` で検査）。
- コールド営業メールに Resend を使わない。

## 8. テストの安全性

- 自動テストから実店舗へ Email / Instagram を送らない。
- テストデータは `example.com` ドメイン、架空の店舗・Instagram handle のみ。
- seed に実店舗データを入れない。

## 9. 報告

脆弱性や secret 混入を見つけたら、`.ai/blockers.md` に記録し（secret の値は書かない）、人間に報告する。漏洩した secret の rotate は人間が行う。

## 10. デモの AI アートディレクション PoC（DEV-028）

- Codex CLI は ChatGPT のサインインだけで使う。`OPENAI_API_KEY` / `CODEX_API_KEY` / `OPENAI_BASE_URL` は子プロセスへ渡さない（`lib/design-agent/codex.ts`、guardrails テストで検査）。
- Codex は `--sandbox read-only` で、空の一時ディレクトリで動く。出力と stderr はログに写さず、符号だけを返す。
- Codex の答えは JSON Schema と zod の列挙値で縛る。ページの文字は fact-only の DemoView と固定の見出しからしか出ない。
- 店舗の facts・スクリーンショット・profile はリポジトリ（public）の外、WSL の専用利用者 `sr-designgen` のホームにだけ置く。
- `/design-preview` は `SR_DESIGN_PREVIEW_ROOT` を設定したローカルの `next start` でしか開かない（Vercel では常に 404、noindex）。
- 手順: `docs/operations/design-agent-wsl.md`

### 10.1 design worker（DEV-028 worker）

WSL の専用利用者で動く無人の local worker（`scripts/sales-design-worker/run.sh`）。Claude Cloud から PC には触らない。

- 公開 Instagram の取得
  - 開いてよいのは `https://(www.)instagram.com/<profile>/` だけ（`lib/design-agent/worker/source-url.ts`）
  - redirect は 1 段ずつ検査し、script による遷移も含めて Instagram の外なら取得をやめる（`PUBLIC_SOURCE_UNAVAILABLE`）
  - 未ログインの使い捨て context で動く。ログイン・cookie の再利用・CAPTCHA の回避・クリックはしない
  - ページ内の画像と動画は blur して撮る
  - 撮った画像は Codex の判断にだけ使い、job の後に消す。デモや公開 asset には使わない
- run.sh は許可した環境変数だけで動く。worker の子 process（git・npm・next・Playwright・Codex）にも許可した変数だけを渡す（`lib/design-agent/worker/env.ts`）。API キー・token・DB の鍵は渡らない
- worker は commit・push・PR 作成・DB 接続をしない。checkout に `.env` があれば止まる
- ログ・ledger・job の記録・report には符号と定型文だけを書く。Codex の文章・stderr・source URL は書かない
- job・facts・結果はリポジトリの外（`~/sr-design-jobs`、`~/.local/share/second-root-design`、0700）に置く
- 一時ディレクトリは worker の prefix・所有者・古さを確かめて片付ける。それ以外の `/tmp` には触らない
- 手順: `docs/operations/design-worker-wsl.md`
