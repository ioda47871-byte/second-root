# Security — Second Root Sales Agent

## 1. Secret の扱い

| Secret | 置き場所 | 渡してよい相手 |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env（server only） | Second Root サーバーのみ |
| DB password | Supabase / 人間のパスワード管理 | 人間のみ |
| `RESEND_API_KEY` | Vercel env | 問い合わせフォーム（`/api/contact`）のみ |
| `SALES_AGENT_INGEST_TOKEN` | Vercel env + Claude Cloud 環境 | Operational Claude（**これだけ**） |
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

## 3. 入力検証

- ingest payload は schema validation を必須とし、未知フィールドは拒否または除去。
- URL は `http:` / `https:` のみ許可。`javascript:` / `data:` / `file:` / `vbscript:` 等は拒否。
- Instagram URL は `instagram.com` / `www.instagram.com` host のみ許可。
- メールアドレスは第一者出典（`source_url` + `source_type`）必須。推測メール禁止。
- 文字列長の上限を設ける（DoS / 表示崩れ対策）。

## 4. SSRF

- Second Root サーバーは Claude が提出した `source_url` 等を **fetch しない**。
- 公式サイト確認は Operational Claude 側で行い、サーバーは記録のみ。

## 5. XSS / 表示

- Claude 取得テキストを `dangerouslySetInnerHTML` で表示しない。React の標準 escape を使う。
  - 既存の `app/layout.tsx` の JSON-LD（固定値）は対象外。Sales Agent 関連ディレクトリでの使用は `tests/unit/guardrails.test.ts` で禁止を検査する。
- `href` に入れる URL は必ず URL validation を通す。
- `mailto:` は `encodeURIComponent` で各パラメータをエンコードする。

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
