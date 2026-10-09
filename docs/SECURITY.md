# Security — Second Root Sales Agent

## 1. Secret の扱い

| Secret | 置き場所 | 渡してよい相手 |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env（server only） | Second Root サーバーのみ |
| DB password | Supabase / 人間のパスワード管理 | 人間のみ |
| `RESEND_API_KEY` | Vercel env | 問い合わせフォーム（`/api/contact`）のみ |
| `SALES_AGENT_INGEST_TOKEN` | Vercel env + Claude Cloud 環境 | Operational Claude（**これだけ**。例外は下の Staging 用 bypass 値のみ） |
| `SALES_AGENT_VERCEL_BYPASS`（Staging のみ・任意） | Staging の Routine environment だけ | Operational Claude（Vercel Preview の保護を通るためだけ。ingest には token が別に必要）。Vercel の Protection Bypass for Automation の値で **project 全体の保護付き deployment に効く**ため、露出が疑われたら人間が Vercel で再生成する。Production には置かない |
| `SALES_DESIGN_BRIDGE_TOKEN`（DEV-030） | Vercel env（server only）+ local bridge の利用者 `sr-designbridge` の file（`~/.config/second-root/design-bridge.token`、0600） | local design bridge だけ。ingest token とは別の値（同じなら bridge API は 503）。design worker（`sr-designgen`）・Codex・Operational Claude には渡さない。生成・設定は人間 |
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

- 公開 Instagram の取得（未ログインの経路。ログイン済みの経路は 10.2 の capture helper だけ）
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

### 10.2 Phase 3 の境界（2026-10-01〜02 人間承認・実装・実機検証済み。`.ai/tasks.json` DEV-028）

新しい権限や自動化は足さない。承認済みの境界をここに記録する。

- **Codex の sandbox**
  - Codex の process は、すべて bubblewrap の中でだけ動く。
  - `/` は読み取り専用で、home・`/root`・`/mnt`・`/srv`・`/run` は見えない。privacy 処理済みの画像はコピーだけを渡す。
  - 毎回 probe で確かめ、満たさなければ Codex を起動しない（fail closed）。手順: `docs/operations/design-worker-wsl.md`
- **capture helper（ログイン済み Instagram）と requester の分離**
  - ログイン済みの Instagram profile は、別の Linux 利用者 `sr-igcapture`（home 0700）だけが持つ。
  - requester（`sr-designgen`）にできるのは、`/srv/sr-capture` に id と公開プロフィール URL の request を置くことだけ。返るのは符号と privacy 処理済み PNG（最大 3 枚）だけ。
  - helper は自動ログインしない（`LOGIN_REQUIRED` で止まり、ログインは人が行う）。人が承認した commit だけを動かす。
  - 撮影のたびに、requester の全 process が jail の cgroup にいることを確かめる。手順: `docs/operations/design-capture-helper.md`
- **visual source の順**
  - 確認済みの公式サイト → helper（ログイン済み Instagram）→ 未ログインの公開 Instagram → `PUBLIC_SOURCE_UNAVAILABLE`。
  - 公式サイトの通信は、worker 内の egress proxy を通す。許すのは公開 address の 80 / 443 だけで、確かめた address へ接続する。
  - WebRTC / QUIC は止める。撮影前に確かめ、止まっていなければ撮らない（fail closed）。
- **requester jail**（WSL2 では、別の利用者に分けるだけでは境界にならないため）
  - `sr-designgen` の process は、systemd の `sr-jail-*.service` の中でだけ動く。login shell は nologin。
  - `/run`・`/mnt`・`/usr/lib/wsl` を隠す。vsock・io_uring・ptrace・私設 address・gateway は kernel が拒否する。
  - 専用の network namespace（pasta）で、VM の localhost と abstract socket から切り離す。DNS は jail 専用の address だけ。
  - 起動のたびに probe が確かめ、満たさなければ起動しない。手順: `docs/operations/design-wsl-isolation.md`
- **root だけの install**
  - `admin.sh`・systemd の unit・jail の設定は、root だけの clone（`/root/sr-capture-admin`、承認した commit・clean）からだけ動かし、入れる。
  - requester の repo や helper の checkout からは入れない。読み込まれた unit の設定を確かめ、違えば止まる。
- **jail の DNS は UDP だけ**（明示的な制約）
  - Ubuntu 24.04 標準の passt の `--dns-forward` は UDP/53 だけを転送する。
  - jail の namespace の中だけで、jail の resolver 宛ての TCP を即座に拒否する。
  - probe は、TCP の拒否（1 秒以内）と `10.255.255.254` の拒否を確かめる。
  - 他の release の passt・自前 build・TCP の DNS の proxy / DNAT は入れない。

## 11. Sales Design Bridge（DEV-030）

Sales Agent の demo と AI design worker をつなぐ。**既定は無効**（`SALES_AI_DESIGN_ENABLED="true"` のときだけ）。設計: `docs/ARCHITECTURE.md` §10。

- **token を持つのは 1 か所だけ**
  - local では bridge の利用者 `sr-designbridge` だけが `SALES_DESIGN_BRIDGE_TOKEN` を持つ（0600 の file。環境変数にしない）。bridge は子 process を起動しない。
  - worker（`sr-designgen`）・Codex・capture helper には token も Supabase の鍵も Sales Agent の token も渡らない。worker の環境は allowlist（`lib/design-agent/worker/env.ts`、`run.sh`）で、bridge 関係は spool の path（`SR_DESIGN_BRIDGE_SPOOL`）だけ。
  - bridge の `run.sh` は root・`sr-designgen`・`sr-igcapture` では動かない。
- **API は狭い**
  - `claim` と `submit` だけ。prospect・outreach・DNC・run・送信には触れない。
  - 503: flag 無効・token 未設定・32 文字未満・ingest token と同じ値。401: 不一致。定数時間比較。
  - ingest token では通らず、bridge token で ingest API も通らない。
- **出すもの・受け取るもの**
  - server が出すのは、fact-only の DemoView に通る確認済み facts と、検証済みの source URL（公式サイト・Instagram profile）だけ。
  - server が受け取るのは、job id・outcome・DesignProfile（enum だけの schema、rationale は空）・固定の符号・worker commit・lineage だけ。strict schema なので、screenshot・raw HTML・Cookie・Instagram session・prompt・Codex の出力・stderr・secret・推論は表現できない（400、何も書かない）。
  - 保存する profile は 8KB 以下（DB の check）。server は読むたびに `DesignProfileSchema` と contrast で再検証し、通らなければ既存 template にする。
- **lineage と冪等性**
  - job id は claim ごとの新しい uuid（unique）。結果は job id で demo を特定するので、別の prospect / demo に入らない。
  - 古い job の結果は `job_superseded`。同じ job の再送は `replayed` で何も変えない。`ready` は再生成しない。
  - 試行は最大 3 回、lease は 2 時間。
- **公開しないもの**
  - 写真（DEV-029）、Instagram・公式サイトの screenshot、capture helper の PNG、reference 画像は公開 demo に出さない。public demo の `ProfileRenderer` には写真を渡さない。
  - 写真の公開は後続の DEV で、同意（approved_real の `public_demo` scope）とともに設計する。
- **spool**
  - `/srv/sr-design-bridge/to-worker`（bridge が書き、worker は読むだけ）と `from-worker`（worker が書き、bridge は読むだけ）。
  - どちらの側も link を辿らない・通常ファイル・link 数 1・サイズ上限・strict schema で読む。worker は自分の job id と一致しない job を取り込まない。
  - **worker（と jail の中の process）は結果を偽れる**（残るリスク）。できるのは、bridge が渡した自分の job について `ready`（`checkProfile` を通る enum だけの profile）・`blocked`・`failed` を選ぶことだけ。別の demo には届かない（bridge の ledger が worker の job id と server の job id を対応させ、server が job id で demo を特定する）。文字・画像・URL は送れない。符号は既知のものだけ（他は `WORKER_FAILED`）。
- **送信の抑止**
  - flag 有効で `pending` / `processing` の demo は、管理画面に送信ボタンを出さず、「送信済み」の server action でも拒否する。DB の `sales_mark_sent` は変えていない（flag が DB から見えないため。管理者本人が RPC を直接呼ぶ場合だけ通る）。
- **jail に見せるのは spool の 2 つの directory だけ**（DEV-031、2026-10-09 人間承認の boundary 拡張）
  - `jail.properties` に `BindReadOnlyPaths=-/srv/sr-design-bridge/to-worker` と `BindPaths=-/srv/sr-design-bridge/from-worker` の 2 行だけを足した。
  - それ以外の `/srv`・bridge の利用者の home（token・state）・Supabase・host の filesystem・network の境界は変えていない。`jail.test.ts` が `/srv` の設定の全体と bind の全体を固定し、probe は `/home/sr-designbridge` が見えれば止まる。
  - 入れ直しは root だけの clone を承認した commit・clean にして `admin.sh jail-install` から（`docs/operations/design-bridge.md` §4）。
- **自動化しないもの**
  - 初回の DM / Email は人が送る。flag 有効で `pending` / `processing` の demo は「送信済み」にできない（server action で拒否）。
  - systemd の unit は repo に置くだけで、install・enable は人が行う。

