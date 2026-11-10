# Security — Second Root Sales Agent

## 1. Secret の扱い

| Secret | 置き場所 | 渡してよい相手 |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env（server only） | Second Root サーバーのみ |
| DB password | Supabase / 人間のパスワード管理 | 人間のみ |
| `RESEND_API_KEY` | Vercel env | 問い合わせフォーム（`/api/contact`）のみ |
| `SALES_AGENT_INGEST_TOKEN` | Vercel env + Claude Cloud 環境 | Operational Claude（**これだけ**。例外は下の Staging 用 bypass 値のみ） |
| `SALES_AGENT_VERCEL_BYPASS`（Staging のみ・任意） | Staging の Routine environment だけ | Operational Claude（Vercel Preview の保護を通るためだけ。ingest には token が別に必要）。Vercel の Protection Bypass for Automation の値で **project 全体の保護付き deployment に効く**ため、露出が疑われたら人間が Vercel で再生成する。Production には置かない |
| bridge token（DEV-030 / DEV-032） | **local bridge の利用者 `sr-designbridge` の file（`~/.config/second-root/design-bridge.token`、0600）だけ**。server（Vercel）には SHA-256（`SALES_DESIGN_BRIDGE_TOKEN_SHA256`）だけを置く | local design bridge だけ。ingest token とは別の値（同じ hash なら bridge API は 503）。token は表示・log・GitHub・Vercel・Claude の session に出さない。design worker（`sr-designgen`）・Codex・Operational Claude には渡さない |
| bridge 専用の Vercel bypass（DEV-059・Staging のみ・任意。既定で無効） | **`sr-designbridge` の file（`~/.config/second-root/design-bridge.vercel-bypass`、0600）だけ** | local design bridge だけ。Vercel の Protection Bypass for Automation のうち bridge 専用の secret（note「Second Root design bridge (WSL)」。Operational Claude の bypass とは別、env var にしない）。**project 全体の保護付き deployment に効く**ため、bridge は設定した 1 つの `*.vercel.app` origin（API URL と同じ）にだけ header を付け、redirect を辿らない。bridge API には bridge token が別に必要。表示・log・GitHub・Claude の session に出さない。漏れの疑いは Vercel で revoke（`docs/operations/design-bridge-access.md` §8） |
| `SALES_DEMO_VIEW_SIGNING_KEY`（DEV-196、**提案・未作成**。DEV-196d の承認の後） | Vercel env（server only） | Second Root サーバーのみ。版のデモの閲覧 token の HMAC 鍵（32 bytes 以上）。bridge・worker・Operational Claude には渡さない。表示・log・GitHub に出さない。rotate で発行済みの閲覧 token がすべて無効になる（非常停止）。§12 |
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

## 3.2 除外リストのメール（DEV-050）

除外リスト（`sales_exclusions`）はメールのアドレスを保存しない。サーバーで計算した digest（`docs/ARCHITECTURE.md` の sales_exclusions）だけを DB に渡し、管理画面はアドレスを再表示しない。表示名・メモ・店名・住所にアドレスは書けない。開発サーバー（`next dev`）が Server Function の引数を端末に出す既定の記録は `next.config.ts` の `logging.serverFunctions: false` で止めている（管理画面の操作はメール・営業文・返信の下書きを受け取るため）。digest は鍵なしの hash で、推測による確認は防げない（HMAC 化は承認後の別 task）。

## 3.3 探索段階の既知判定（DEV-054）

- ingest API は discovered の stub ごとに「既知かどうか」（`known`）だけを返す。どの一覧（prospect・DNC・除外リスト・却下の記憶）に当たったか、一覧の中身・理由は返さない。照合は Instagram handle と公式サイトのキーだけで、除外リストのメール digest・店名+住所は探索段階では使わない。
- 残るリスク（受け入れ）: ingest token を持つ者は、任意の handle / domain を stub にして「既知か」を確かめられる。token は Operational Claude だけが持つ。
  - 探索段階の照合は persist より安く、痕跡も残らない: 副作用がなく（prospect も記憶も作らない）、1 回の要求で最大 20 キーを確かめられ、discovered の再送で何度でも繰り返せる。ただし一覧を特定しない（prospect・DNC・除外リスト・却下の記憶のどれに当たったかは分からない）。
  - persist の結果（`duplicate` / `excluded`）は一覧を特定するが、当日上限と run ごとの件数で制限され、当たらなかった候補は目に見える prospect として残る。
  - どちらも token の漏洩が前提で、得られるのは「既知か」だけ（一覧の中身は返らない）なので受け入れる。
- 却下の記憶（`sales_rejected_candidates`）が保存するのは Instagram handle と公式サイトのキー（`site_without_email` の却下だけ）で、店名・住所・メールは平文でも digest でも持たない。RLS で管理者だけが読め、書き込みは service role の関数だけ。期限（90 日）で消える。
- 照合・記憶の関数は service role だけが実行できる（PUBLIC / anon / authenticated は不可。`tests/integration/db-security-audit.test.ts`）。

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
- DEV-196 の版のデモ（§12、未実装）: 外枠（`/admin/sales/demos/…`・`/demo/[publicToken]`）は上のヘッダ（`X-Frame-Options: DENY`・`frame-ancestors 'none'` を含む）を保ち、加えて CSP の `frame-src <artifact-origin>` だけを許す。管理者プレビューの外枠だけは、専用の origin が設定されていない間 `frame-src 'self'` も許す（暫定の `/demo-frame/a/…` がアプリの origin にあるため。設定の後は外す）。共有の外枠には `'self'` を入れない（DEV-196 仕様 §6.8）。iframe に入る成果物の route `/demo-frame/*` だけは、上の規則に当たらない接頭辞に置き、`X-Frame-Options` の代わりに CSP の `frame-ancestors <アプリの origin>` と `sandbox` を付ける（§12）。

## 5.2 依存関係

- `npm audit --omit=dev` で high / critical を 0 に保つ（DEV-017 で Next.js 16.3.0 → 16.3.6: Image Optimization の RCE 等の advisory、sharp の libheif advisory を解消）。
- Release 前に再確認する（`docs/RELEASE.md`）。

## 6. 公開デモ

- `publicToken` は `crypto.randomBytes(32)` 等の暗号学的乱数（128bit 以上）。連番・推測可能 ID を使わない。
- `noindex,nofollow`（meta）＋ `X-Robots-Tag: noindex, nofollow`。
- 絶対に出さない: 営業内部メモ / メールアドレス / Claude 内部評価 / 成約金額 / outcome / internal ID / secret。
- 期限切れ・無効化されたデモは 404 相当（存在有無を区別しない）。
- 事実は確認済み公開情報のみ。Instagram 画像等の無断転載をしない。
- 画像は取得・分析（reference screenshot を色・雰囲気の判断に使い、job の後に消す）と再掲載を区別する。Instagram の画像は店舗の利用許可なしに demo に載せない。写真 asset は `approved_real` だけで、AI 生成・架空の店舗写真は使わない（DEV-070。`docs/MVP_SPEC.md` §7）。
- 公開 demo（相手に見せる頁・共有 URL）には今も写真を出さない（`PUBLIC_DEMO_ASSETS_ENABLED = false`）。実店舗の AI 概念画像を管理者だけのデザイン検討に使う例外（DEV-196、オーナー決定 2026-11-10）は、相手に見せる頁には及ばない（`docs/MVP_SPEC.md` §7.1、§12）。

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
- **jail の DNS は UDP/53 だけ**（明示的な制約、pasta の版によらない。DEV-088）
  - Ubuntu 24.04 標準の passt の `--dns-forward` は UDP/53 だけを、新しい passt（`386b5f5`）は UDP と TCP の 53 と 853 を転送する。
  - jail の namespace の中だけで、jail の resolver の address へは UDP/53 だけを通し、他（TCP/53・TCP/853・UDP/853 を含む）は即座に拒否する（ip rule 3 行）。
  - probe は、rule の組が設計どおりであること（netlink で完全一致）、TCP/53・TCP/853 の拒否（1 秒以内）、UDP/853 と他の port の拒否、`10.255.255.254` の拒否を確かめる。`admin.sh jail-check` は名前解決（`getent`）も確かめる。
  - 他の release の passt は人の例外（`passt-update-plan.md` の A-2）に限る。自前 build・TCP の DNS の proxy / DNAT は入れない。
  - code は DEV-088 で実装。実 WSL への適用は別の承認（`passt-update-plan.md` §4.6）。

## 11. Sales Design Bridge（DEV-030）

Sales Agent の demo と AI design worker をつなぐ。**既定は無効**（`SALES_AI_DESIGN_ENABLED="true"` のときだけ）。設計: `docs/ARCHITECTURE.md` §10。

- **token を持つのは 1 か所だけ**
  - token そのものは bridge の利用者 `sr-designbridge` の 0600 の file にだけある（環境変数にしない）。bridge は子 process を起動しない。
  - server は token を持たず、SHA-256（`SALES_DESIGN_BRIDGE_TOKEN_SHA256`、64 桁の hex）だけを持つ。Bearer の token（32〜512 文字の可視 ASCII）を SHA-256 して定数時間で比べる（DEV-032）。
  - worker（`sr-designgen`）・Codex・capture helper には token も Supabase の鍵も Sales Agent の token も渡らない。worker の環境は allowlist（`lib/design-agent/worker/env.ts`、`run.sh`）で、bridge 関係は spool の path（`SR_DESIGN_BRIDGE_SPOOL`）だけ。
  - bridge の `run.sh` は root・`sr-designgen`・`sr-igcapture` では動かない。
- **Vercel の保護は外さない（DEV-059）**: Staging の Preview は Vercel Authentication のまま。bridge は任意で bridge 専用の Protection Bypass（`sr-designbridge` の 0600 file、既定で無効）を、設定した 1 つの `*.vercel.app` origin への request にだけ付ける（redirect は辿らない、値は出力しない）。bypass は Vercel の保護を通るだけで、bridge API の認証（bridge token）は変わらない。比較と手順: `docs/operations/design-bridge-access.md`
- **API は狭い**
  - `claim` と `submit` だけ。prospect・outreach・DNC・run・送信には触れない。
  - 503: flag 無効・hash 未設定・hash が 64 桁の hex でない・token そのもの（`SALES_DESIGN_BRIDGE_TOKEN`）が server に設定されている・ingest token の hash と同じ。401: 不一致。
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
  - 写真（DEV-029。DEV-070 から `approved_real` だけ）、Instagram・公式サイトの screenshot、capture helper の PNG、reference 画像は公開 demo に出さない。public demo の `ProfileRenderer` には写真を渡さない。
  - 写真の公開は後続の DEV で、同意（approved_real の `public_demo` scope）とともに設計する。
- **spool**
  - `/srv/sr-design-bridge/to-worker`（bridge が書き、worker は読むだけ）と `from-worker`（worker が書き、bridge は読むだけ）。
  - どちらの側も link を辿らない・通常ファイル・link 数 1・サイズ上限・strict schema で読む。worker は自分の job id と一致しない job を取り込まない。
  - **worker（と jail の中の process）は結果を偽れる**（残るリスク）。できるのは、bridge が渡した自分の job について `ready`（`checkProfile` を通る enum だけの profile）・`blocked`・`failed` を選ぶことだけ。別の demo には届かない（bridge の ledger が worker の job id と server の job id を対応させ、server が job id で demo を特定する）。文字・画像・URL は送れない。符号は既知のものだけ（他は `WORKER_FAILED`）。
- **送信の抑止**
  - flag 有効で `pending` / `processing` の demo は、管理画面に送信ボタンを出さず、「送信済み」の server action でも拒否する。DEV-195 から DB も拒否する: 送信の承認・送信画面を開く・送信済みの関数は `p_design_enabled`（server が flag を渡す）が true のとき `design_pending` で断る（flag は DB から見えないため、管理者本人が false を渡して RPC を直接呼ぶ場合だけ通る）。
- **jail に見せるのは spool の 2 つの directory だけ**（DEV-031、2026-10-09 人間承認の boundary 拡張）
  - `jail.properties` に `BindReadOnlyPaths=-/srv/sr-design-bridge/to-worker` と `BindPaths=-/srv/sr-design-bridge/from-worker` の 2 行だけを足した。
  - それ以外の `/srv`・bridge の利用者の home（token・state）・Supabase・host の filesystem・network の境界は変えていない。`jail.test.ts` が `/srv` の設定の全体と bind の全体を固定し、probe は `/home/sr-designbridge` が見えれば止まる。
  - 入れ直しは root だけの clone を承認した commit・clean にして `admin.sh jail-install` から（`docs/operations/design-bridge.md` §4）。
- **自動化しないもの**
  - 初回の DM / Email は人が送る。flag 有効で `pending` / `processing` の demo は「送信済み」にできない（server action で拒否）。
  - systemd の unit は repo に置くだけで、install・enable は人が行う。

## 12. 店舗ごとの版のデモ（DEV-196。設計だけで未実装・既定は無効）

設計と脅威モデルの正本は `docs/design/DEV-196-demo-admin-spec.md`（以下「DEV-196 仕様」、脅威 T1〜T23 は §11）、規則は `docs/MVP_SPEC.md` §7.1、配置は `docs/ARCHITECTURE.md` §11。
ここに書く bucket・route・環境変数はどれも作られていない。実装と適用の各段は別の承認が要る（DEV-196 仕様 §12）。この節は、実装の段で**緩めてはいけない境界**を先に決めておくもの。

- **Storage**
  - 非公開の bucket だけ（`public = false`）。`storage.objects` に anon・authenticated の policy を作らない。読み書きは server（service role）だけ。
  - 公開 bucket・公開 URL・CDN・**署名付き URL を作らない・ブラウザに渡さない**（署名付き URL は期限前に取り消せないため）。
  - HTML・CSS・WebP / JPEG だけ。SVG ファイル・PNG は受けない。正規化した画像（EXIF・GPS なし）と大きさの上限。
  - object・object の metadata に、出所・モデル名・所有者名・同意の参照・private path・prompt の本文を書かない。
- **成果物の route `/demo-frame/{a|p}/[token]/[...path]`**
  - cookie を**読まない**（`proxy.ts` の matcher に入れない）。認可は path の HMAC の短い token だけ。
  - token は管理者用（scope `a`）15 分、共有用（scope `p`）30 分。共有 URL を開き直すたびに共有用の token を新しく発行する。scope が違えば 404。HMAC は定数時間で比べる。
  - **要求ごとに DB で確かめる**: 版の存在・取り消し・期限、scope `p` は加えて `isDemoPublic`（送信済み・30 日・無効化なし）・送信済みの承認がその版を固定していること・画像の権利の再評価。どれか 1 つでも外れたら、理由を区別しない 404（`no-store`）。
  - URL の path は Storage の key にしない。manifest の名前と完全一致したものだけを返し、返す前に sha256 を照合する。
  - 応答: `nosniff`・`Cache-Control: private, no-store`・`Referrer-Policy: no-referrer`・`X-Robots-Tag: noindex, nofollow, noarchive`・`Permissions-Policy` はすべて無効。HTML の CSP は `default-src 'none'`・`script-src 'none'`・`connect-src 'none'`・`font-src 'none'`・`form-action 'none'`・`base-uri 'none'`・`style-src` と `img-src` は token の path だけ・`frame-ancestors <アプリの origin>`・`sandbox`（`allow-*` なし）。`'unsafe-inline'` は入れない。
  - token を log・エラーに出さない。
- **専用の別 origin**（オーナー決定 2026-11-10）
  - 共有する成果物は、アプリと別の専用の origin（`<artifact-origin>`）から配る。そこには成果物の route だけを置き、cookie を発行も読みもしない。アプリの cookie は host-only のまま（`Domain=` で親の domain に広げない）。
  - **DNS と Vercel の設定は今は変えない**（後の段の別の承認。Domain / DNS は Protected Scope）。設定されるまで、共有の成果物の route は 404（fail closed）。
  - 別 origin は置き換えではなく、もう 1 枚の層。非公開の Storage・sandbox・スクリプト無効・要求ごとの認可は、別 origin を入れても保つ。
  - 管理者プレビューは、別 origin の設定までアプリの origin の `/demo-frame/a/…` で配る（cookie を読まない route・CSP の `sandbox`・iframe の `sandbox=""` で opaque origin になり、アプリの cookie・DOM・storage に届かない）。管理者だけの暫定として受け入れる。
- **取り消しと保持**
  - 版の取り消しは次の要求から効く。送信済みの版を取り消したら共有 URL は 404 で、ほかの版や React のデモへ**自動で切り替えない**。鍵の rotate で発行済みの token はすべて無効になる。すでに相手の画面に開かれた頁は呼び戻せない（限界）。
  - 未送信の版は約 60 日、送信済みの版は共有の期間の後 約 30 日残す。期限の後も自動では消さない。Storage の object の削除は復元できないので、別の承認。
- **HTML/CSS の検査**: server の finalize が正本（worker の申告は助言、§11「worker は結果を偽れる」）。B方式の規則（`script`・`on*`・`form`・`iframe`・外部 URL・`@import`・`@font-face`・外への `url()` など）を緩めず、加えて `style` 属性と `<style>` 要素を拒否する。書体は許可一覧だけ。React の木に成果物の HTML を入れない（`dangerouslySetInnerHTML`・`srcdoc` を使わない）。
- **画像の権利と出所**
  - 権利の状態は server が記録から導く（人が enum を選ばない）。既定は `unknown` で、1 枚でも共有可でない画像があれば版ごと共有不可（fail closed。画像を抜いた頁は出さない）。
  - 出所（AI 画像の生成の手段・ツールが報告したモデル名・生成時刻・prompt の sha256・承認 ID、人の写真の同意の参照など）は **DB の管理者だけが読む列にだけ**置く。リポジトリのファイル（docs・json・fixture）、Storage、log に書かない。
  - 実店舗の AI 概念画像は、管理者だけのデザイン検討に限る。条件: 実在の商品・店内・人・設備を事実として描かない（`depicts_real_*` が 1 つでも true なら不可）・画像ごとにオーナーが「事実の偽装なし」を確認して記録する・管理画面が画像ごとに AI 生成のラベルを出す・出所と利用の許可が記録されている。1 つでも欠ければ `unknown`。共有の可否を返す経路そのものを持たせず、共有 URL には出さない（DB の check でも強制）。
  - 「事実の偽装なし」の確認（案、DEV-196 仕様 §14 Q12）: 管理者プレビューの画像ごとに、オーナーが固定の文「この画像は実在の商品・店内・人・設備を事実として描いていません」を読んで押す。押した人と時刻を画像の記録に残し、画像の bytes が変われば確認は無効。文言と手順は DEV-196i の前にオーナーが決める。
  - 架空の店の研究の規則（`checkPhotoRights`・`AI_DEMO_SHOPS`・`AI_DEMO_NOT_FOR_PUBLIC_SITE`）は変えない。
  - 写真の共有は今も無効（`PUBLIC_DEMO_ASSETS_ENABLED = false`）。共有できる版は写真 0 枚の版だけ。写真や AI 画像の共有を始めるには、`docs/MVP_SPEC.md` §7 の変更（Protected Scope）と別の承認が要る。
- **受け入れるリスク**: 管理者用の token は cookie の無い bearer URL で、漏れると未承認の下書き（AI 画像を含む）が最大 15 分見える（DEV-196 仕様 T19）。対策は短い期限・1 つの版だけ・管理者の頁でだけ発行・log に出さない・`no-referrer`・`no-store`・取り消しと鍵の rotate。
- **worker と bridge**: WSL に Supabase の鍵を置かない。アップロードは今の bridge の token で、版の受け入れだけの狭い API（prospect・outreach・DNC・送信・品質承認には触れない）。worker・bridge の経路から品質承認・送信承認は書けない。生成物は必ず未承認の `draft`。画像の生成は今までどおり 1 回ごとのオーナーの承認。
