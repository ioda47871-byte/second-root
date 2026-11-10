# DEV-196: 店舗ごとの高品質デモを営業の管理画面につなぐ — 仕様と安全設計

2026-11-10。Issue #235 (North Star) の計画の第3段。branch `feature/dev-196-demo-admin-spec` (`origin/develop` 6443d99 から)。

**この文書は仕様と安全設計だけである。コード・migration・DB・Storage・workflow・package の変更は無い。**
ここに書いた表・列・関数・route・bucket・環境変数はすべて**提案**で、どれも作られておらず、どの環境にも適用されていない。
各段の実装には、§12 に書いたオーナーの承認が別に要る。この PR の merge はそれらの承認ではない。

**オーナー決定 2026-11-10**: オーナーがこの仕様の方向を承認し、§14 の問いの多くに答えた (AI 画像・別 origin・版の無い店舗・取り消し・保持と token・デザイン品質・次の段)。決定の一覧は §15、反映した節は各所に「(オーナー決定 2026-11-10)」と書いた。承認された次の段は **DEV-196a (仕様の文書だけ) と DEV-196b (offline の純粋なライブラリだけ)** で、DEV-196c 以降 (DB・Storage・Staging の環境・画像生成・公開・Production) は**未承認のまま**である。

---

## 0. 目的と North Star への寄与

| | |
|---|---|
| North Star (#235) | オーナーが毎日管理画面を開くと、AI が用意した店舗ごとの高品質なデモと営業文面が並んでいて、数件を確かめて「送信」を押す |
| DEV-196 の役割 | 高品質な店舗デモ (B方式の HTML/CSS ページ + 写真) を、営業の管理画面 (`/admin/sales`) と DEV-195 の送信承認へつなぐ |
| 今のボトルネック | 高品質のデモ (例: SR-001「輪」d1-v9 の AI 写真入り版) はオーナーの WSL の中のファイル (`~sr-designgen/.local/share/second-root-design/image-autorun/<job>/…`) にしか無く、スマホや管理画面からは見られない。管理画面と公開デモが描けるのは DB の `template` / `content` / `design_profile` から作る React のデモだけ |
| 減る手作業 | WSL でファイルを開いてスクショを撮り比べる作業。デモと送信文面の対応を目で照らし合わせる作業 |
| 品質・費用・法令・安全 | 公開 bucket を作らない、スクリプトを動かさない、権利不明の画像は共有 URL に出さない (fail closed)。デモの品質承認と送信承認を分ける |

## 1. 範囲と範囲外

### 範囲 (この仕様が決めること)

1. 店舗 (prospect) ごとのデモの**版 (version) と系譜 (lineage)**、どの版が承認されたか、DEV-195 の承認の記録との結び付け
2. 店らしさ (デザイン・画像・PC/SP の描画) を保つ品質の確かめ方と、テンプレート化の防止
3. **管理者だけのプレビュー**と**相手に送る共有 URL**の分離 (route・token・見えるもの)
4. 安全: 非公開の Storage、閲覧の期限、取り消し、スクリプト無効、CSP と sandbox、第三者への通信なし、noindex。脅威モデル
5. 将来の自動生成 worker との接続 (状態・冪等性・未承認の下書きとして入る経路)
6. AI 生成写真の利用権・出所 (DB に記録)・実店舗のデモに使ってよいか。権利状態の enum と fail closed
7. デモの品質承認と送信承認を**別々に**管理する (無効になる条件を含む)

### 範囲外 (この PR でも、この仕様の最初の段でもしないこと)

- コード・migration・Storage bucket・環境変数・workflow・package / lockfile の変更 (§12 の各段で、承認の後に)
- Staging / Production の DB・Storage・Vercel・WSL への適用、画像生成、Codex の実行
- 自動送信 (DM・メールとも)。DEV-195 の「手動で送信済み」の流れは変えない
- 営業ルール (5 件/日・DNC・重複排除・チャネル決定・30 日・初回は人間送信) の変更
- `APPROVED_CAPABILITIES` (今は空) や実装レーンの CSS 許可一覧・書体許可一覧の緩和
- 店舗の事実の補完 (不明は「未確認」のまま)。実店舗の AI 写真の共有 (§8。オーナーの仕様判断が先)
- 既存の React のデモ (`bakery_v1` / `baked_goods_v1` / `cafe_v1` / `ProfileRenderer`) の変更。新しい経路は**並べて足す**

---

## 2. 今の状態 (develop 6443d99 のコードで確かめた事実)

| 事実 | 場所 | この仕様への影響 |
|---|---|---|
| `sales_demos` は prospect ごとに 1 行 (unique(prospect_id))。列は `public_token`・`template`・`content`・`expires_at`・`disabled_at`・`keep_alive`・`design_status`・`design_profile`・`design_job_id` など。**版の概念は無い** | `supabase/migrations/20260927000000_sales_agent_core.sql`、`20261009000000_sales_design_bridge.sql`、`docs/ARCHITECTURE.md` §4 | 版は別表にする (§4)。`sales_demos` の 1 行 = 1 店舗は変えない |
| 管理者プレビュー `/admin/preview/[prospectId]` と公開デモ `/demo/[publicToken]` は、どちらも `renderDesignedDemo(DemoView, DesignProfile)` で React を描く。任意の HTML も写真も出せない | `app/admin/preview/[prospectId]/page.tsx`、`app/demo/[publicToken]/page.tsx`、`components/demo/renderDemo.tsx`、`lib/sales/demo-data.ts` | ファイルのデモには**新しい配信経路**が要る。React の経路はそのまま残す |
| 公開デモの表示条件は `isDemoPublic` (送信済みで `expires_at` 設定済み・30 日内か `keep_alive`・`disabled_at` が null)。それ以外は同じ 404 | `lib/sales/demo.ts`、MVP_SPEC §7 | 共有 URL の期限・無効化はこの規則を土台にする |
| 営業文面のデモ URL は `${SALES_DEMO_BASE_URL}/demo/${public_token}` | `lib/admin/today.ts` `demoUrl` | 相手に渡る URL は今の形のまま変えない (送信済みの文面と DEV-195 の承認の本文に入っている) |
| `next.config.ts` が `/demo/*`・`/design-preview/*`・`/admin/*`・`/api/internal/*`・`/api/webhooks/*` に `X-Frame-Options: DENY` と `CSP: frame-ancestors 'none'` を付ける。同じ key を 2 つの規則が付けると後の規則が勝つ | `next.config.ts`、`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md` | iframe に入る成果物は、これらと重ならない**別の接頭辞**に置く (§6) |
| `proxy.ts` は `/admin/*` だけで Supabase の cookie を更新する | `proxy.ts` | 成果物の route は cookie を読まない (§6.3) |
| Next 16 では `route.ts` と `page.tsx` を同じ segment に置けない。`params` は Promise | `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` | 成果物の route は `/demo/[publicToken]` に同居できない |
| ローカル Supabase は `[storage] enabled = false`。Storage を使うコードは無い | `supabase/config.toml` | 統合テストには Storage を有効にする変更が要る (§12 の段で) |
| `PUBLIC_DEMO_ASSETS_ENABLED = false`。写真 asset は `approved_real` だけ、AI 生成・架空の店舗写真は使わない (DEV-070) | `lib/design-agent/assets/manifest.ts:27`、MVP_SPEC §7、SECURITY §6 | 実店舗の共有 URL に AI 写真は出さない (§8)。変えるには MVP_SPEC の変更 (Protected Scope) が先 |
| 写真の権利の記録 `photo_rights_v0`: `source_kind` は `owner_provided` / `shop_provided` / `licensed_stock_with_terms` / `ai_generated_demo`。`ai_generated_demo` は `ai_provenance` (`demo_only: true` 固定) が必須で、`checkPhotoRights(…, {purpose: "public_site"})` は必ず `AI_DEMO_NOT_FOR_PUBLIC_SITE` で拒否。公開側の記録は `toPublicPhotoRecord` (所有者・同意の記録・path を落とす) | `lib/design-agent/quality-pipeline/photo-rights.ts` | 権利の enum (§8) はこの記録から**導く**。新しい信頼の仕組みは作らない |
| 写真の差し替えの出力は「公開してよいもの」(`swap-summary.json`) と「リポジトリに入れないもの」(`rights.private.json`) に分かれている。`<out>/page/` (index.html・style.css・copy.json・photos/) と `<out>/renders/` (desktop_1440.png・mobile_390.png) | `scripts/design-artifact/photo-swap.ts` 冒頭 | アップロードの包みはこの分け方を使う。`rights.private.json` は包まない |
| 輪 d1-v9 は `index.html` + `style.css` + `copy.json`。`<script>` も `style=` 属性も無い (0 件) | `design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9/` | `'unsafe-inline'` の無い厳しい CSP で配れる |
| B方式の安全検査 `checkPrototype`: 禁止要素 (`script`・`iframe`・`object`・`form`・`base`・`foreignObject`・SVG の animate 系など)、`on*` 属性、`style.css`・宣言した asset・`#id` 以外の URL、CSS の `@import`・外への `url()`・`expression()` などを拒否。HTML の解析は Playwright の Chromium | `lib/design-agent/phase2f/prototype-safety.ts`、`.claude/skills/second-root-design-director/references/route-constraints.md` | Vercel では Chromium を動かせない。server の正本の検査は**同じ規則の純粋 TS 版**にする (§7.3) |
| 書体の許可一覧 `PAGE_FONT_FAMILIES` (Noto / IPA / ヒラギノ / 游 / メイリオ / BIZ UD / Zen / Shippori / Inter / DejaVu / Liberation など + 総称) | `lib/design-agent/comp-impl/page-css.ts:70` | 成果物の CSS の `font-family` はこの一覧だけ。Web フォントは読まない (`font-src 'none'`) |
| 実装レーンの能力 `APPROVED_CAPABILITIES` は空 | `lib/design-agent/comp-impl/spec.ts:72` | この仕様はこれを変えない。B方式の成果物は B方式の規則で検める |
| 画像の無人実行は既定 OFF・root の境界で 1 回限りの承認 (DEV-186/187)。承認の窓は最大 24 時間 (`MAX_APPROVAL_WINDOW_MS`)。対象の店は `AUTORUN_SHOPS` (つぐ手・輪 の架空 2 店だけ) | `scripts/sales-design-worker/image-autorun.ts:82`、`scripts/sales-design-worker/autorun-shops.ts`、`docs/operations/design-worker-cycle.md` | worker の生成物は同じ「1 回限りの承認」の考え方で受け入れる (§10) |
| bridge は Linux 利用者 `sr-designbridge` だけが token (0600) を持ち、server は SHA-256 だけを持つ。worker (`sr-designgen`) は jail の中で spool の 2 つの directory しか見えない | SECURITY §11、`lib/sales/design-bridge-auth.ts`、`lib/design-agent/bridge/spool.ts` | アップロードは bridge 経由。WSL に Supabase の鍵を置かない (§10.3) |
| DEV-195 の `sales_outreach_approvals` は `demo_token`・`demo_design_status`・`demo_design_updated_at`・`demo_version` を持つ。`demo_version = sales_demo_version(d)` = sha256(`public_token`, `template`, `content`, `design_status`, `design_profile`)。送信済みにするとき `sales_approval_is_current` が今の `demo_version` と照合する | `supabase/migrations/20261107000000_sales_send_approval.sql`、ARCHITECTURE §4 | 版を足すと、**今の `demo_version` は成果物の版の変化を拾わない**。§9 で関数の拡張を提案する |
| 研究成功例: 外部 30 件 (CP-001〜032 の manifest。登録の門で 30 に固定) と、自社の研究台帳 SR-001「輪」(架空の店、`not_templates: true`・`not_fed_to_generators_automatically: true`・`release_or_deployment_approval: false`) | `docs/design/success-cases-index.md`、`design-library/success-cases/second-root-research-successes.json` | 参照としてだけ使う (§7.6) |
| 事実の規則: Identity Lock (店名・業種を固定し、別の店名を混ぜない)・事実パック `shop_facts_pack_v1`・管理画面の「未確認」(`UNCONFIRMED`) | `docs/design/identity-lock-research-policy.md`、`lib/design-agent/identity/identity-lock.ts`、`lib/design-agent/quality-pipeline/facts-pack.ts`、`lib/sales/evidence.ts:37` | 成果物の文は事実パックの値と固定の見出しだけ (§7.4) |

---

## 3. 全体像

```
             (将来) 自動生成 worker ── jail の中 ── from-worker/artifacts/<ref>/   (包み: page + renders + public 権利の要約)
                                                       │
             sr-designbridge (token を持つ唯一の local process、子 process なし)
                                                       │  POST /api/internal/sales-design/demo-versions  (begin / put / finalize)
                                                       ▼
Second Root server (Vercel) ── service role ──► private bucket `sales-demo-versions`  (公開 bucket は作らない)
     │  finalize: 再ハッシュ・HTML/CSS の規則・書体・画像の頭・権利 → status = draft (未承認) / rejected
     │
     ├─ /admin/sales/demos/[prospectId]  (管理者セッション)   版の一覧・系譜・PC1440 / SP390・品質承認・取り消し
     │      └─ <iframe sandbox> → /demo-frame/a/<管理者用 view token>/index.html   (15 分、版 1 つ。URL の index.html = manifest の page/index.html、§5.2)
     │
     ├─ /admin/sales (今日)  DEV-195 の送信承認: 「品質承認済みの版」を snapshot に固定
     │
     └─ /demo/[publicToken]  (相手が開く URL。今の形のまま)
            └─ 信頼できる外枠 (注記・footer) + <iframe sandbox> → /demo-frame/p/<共有用 view token>/index.html
               (送信済みの承認が固定した版だけ、共有してよい画像の版だけ、30 日・無効化・取り消しを毎回確認)
```

原則:

- **成果物の HTML は React の木に入れない** (`dangerouslySetInnerHTML` は `tests/unit/guardrails.test.ts` で禁止のまま、`srcdoc` も使わない)。別の route から `src=` で iframe に入れる。
- **Storage の URL をブラウザに渡さない**。読むのは server の route だけで、毎回 DB で権限と取り消しを確かめる (署名付き URL は期限前に取り消せないため。§6.5)。
- **server の検査だけが正本**。worker の申告は助言として記録するだけ (SECURITY §11「worker は結果を偽れる」)。

---

## 4. データモデル (提案。migration ではない)

既存の `sales_demos` (1 店舗 1 行) の下に、版の表を足す。名前・型・制約は実装の段 (DEV-196c) で詰める。
RLS・権限は既存の型 (SECURITY §2) に従う: RLS 有効、anon の権限なし、authenticated の直接書き込みなし、
書き込みはすべて SECURITY DEFINER の関数 (`search_path` 固定・最初に管理者か service role を確認・`revoke all … from public, anon, authenticated` してから必要な role にだけ grant)、`tests/integration/db-security-audit.test.ts` で全関数・全表を検査。

### 4.1 `sales_demo_versions` (版。1 行 = アップロードされた成果物 1 つ)

| 列 | 型 / 制約 (案) | 意味 |
|---|---|---|
| `id` | uuid pk | 版の id |
| `demo_id` | uuid not null → `sales_demos(id)` on delete restrict | どの店舗のデモか |
| `version_no` | int not null、unique(`demo_id`, `version_no`)、1〜1000 | 店舗の中の通し番号 (表示用) |
| `parent_version_id` | uuid null → `sales_demo_versions(id)`、同じ `demo_id` であること (trigger) | **系譜**: どの版を元に作り直したか (null = 最初の版) |
| `origin` | text check in (`worker_autogen`, `design_bridge`, `manual_import`) | 生成の経路 |
| `generation_job_id` | text null、unique (null 以外)、`^[a-z0-9][a-z0-9-]{2,62}$` | **冪等性の鍵**: 同じ job の再送は同じ版になる (§10.2) |
| `worker_commit` | text null、`^[0-9a-f]{7,40}$` | 作った worker の commit |
| `facts_sha256` | text not null、64 hex | 生成の入力にした事実パック (fact-only の DemoView) の sha256。事実が変われば品質承認が無効になる (§9.3) |
| `direction_sha256` | text null、64 hex | 方向案 (open direction JSON など) の sha256。自由文は入れない |
| `bundle_sha256` | text not null、64 hex | **版の同一性**: 正規化した manifest (ファイル名・役割・sha256・bytes・content type の整列) の sha256 |
| `manifest` | jsonb not null、`pg_column_size` ≤ 16KB、strict | ファイルの一覧 (§5) |
| `storage_prefix` | text not null | `v1/<demo_id>/<id>/` (server が決める。worker からは受けない) |
| `total_bytes` | int not null、1〜15MiB | 合計 |
| `status` | text check (§4.6 の状態) | 版の状態 |
| `validator_result` | jsonb null、strict・≤ 2KB | `{version, ok, codes[], validator_commit, checked_at}`。**固定の符号だけ**、自由文なし |
| `worker_checks` | jsonb null、strict・≤ 2KB | worker の申告 (助言。`checkPrototype`・描画の検査・構造記述子) |
| `structure_descriptor` | jsonb null、strict・≤ 2KB | 計測した構造記述子 (`lib/design-agent/structure`。hero・flow・節の型など。§7.5) |
| `rights_summary` | jsonb null、strict・≤ 1KB | §8.4 |
| `share_eligible` | boolean not null default false | 共有 URL に出してよい版か (server が §8.3 から導く表示用の cache。check: 写真の共有を認める後の別の承認 (MVP_SPEC §7 の変更、Protected Scope。DEV-196a には含まない) までは写真 0 枚のときだけ true。送信の照合はこの値を使わず導き直す、§9.2) |
| `renders` | jsonb null | `desktop_1440` / `mobile_390` (と店の spec が描くなら `tablet_768`) の描画画像 (WebP) の manifest 上の名前と sha256 (§5.2・§7.2) |
| `expires_at` | timestamptz not null | 管理画面で見られる期限 (未送信のまま放置された版の掃除。未送信は作成から約 60 日。送信済みは共有の期間の終わりから約 30 日に延ばす (オーナー決定 2026-11-10、§6.6)。期限の後の削除は別の承認) |
| `revoked_at`, `revoked_by`, `revoke_code` | null 可、`revoke_code ~ '^[A-Z][A-Z0-9_]{2,47}$'` | 取り消し (§6.6)。取り消した版は管理者プレビューでも共有でも出ない |
| `created_at`, `validated_at` | timestamptz | |

- 版の内容 (`manifest`・`bundle_sha256`・`storage_prefix`・`facts_sha256`・`rights_summary` の元) は `draft` になった後は**変えられない** (trigger)。直したいときは新しい版を作り、`parent_version_id` で系譜をつなぐ。
- 版を消す row 削除は無い (取り消し + Storage の掃除だけ。§6.6)。

### 4.2 `sales_demo_version_files` (版のファイル。manifest の正規化した写し)

| 列 | 意味 |
|---|---|
| `version_id`, `path` | pk。`path` は §5.2 の固定の形だけ (check) |
| `role` | `html` / `css` / `photo` / `render` |
| `sha256`, `bytes`, `content_type`, `width`, `height` | 計測した値 (server が bytes から測る) |
| `image_id` | `photo` のとき `sales_demo_images(id)` (権利の記録) |

manifest (jsonb) を正本にして、この表を作らない案もある。問い合わせ (この画像を使っている版はどれか、権利を取り消したら影響する版はどれか) を SQL で書けるよう、表にするのを推す。

### 4.3 `sales_demo_images` (画像と権利・出所。**DB にだけ置く**)

| 列 | 意味 |
|---|---|
| `id` | uuid pk |
| `sha256`, `bytes`, `width`, `height`, `format` | 計測した値。unique(`sha256`) |
| `rights_status` | §8.1 の enum。既定 `unknown` |
| `source_kind` | `owner_provided` / `shop_provided` / `licensed_stock_with_terms` / `ai_generated_demo` (`photo_rights_v0` と同じ語) |
| `depicts_real_shop`, `depicts_identifiable_person`, `depicts_real_product`, `depicts_real_interior`, `depicts_real_equipment` | boolean not null。実店舗の AI 概念画像はどれも false でなければ受けない (§8.3)。`no_factual_impersonation_confirmed_at/by` (オーナーの確認) |
| `allowed_uses` | jsonb strict `{edit, crop, commercial, public_web}` |
| `client_confirmed_at`, `client_confirmation_ref` | 店舗の書面の確認 (参照は管理者だけが読む) |
| `rights_expiry` | date null |
| `provenance` | jsonb、strict・≤ 2KB。**AI 生成なら生成の手段・ツールが報告したモデル名・生成時刻・prompt の sha256・承認 ID・upscale の記録**。人の写真なら受け取り日・同意の記録の参照。**リポジトリのファイルには書かない** (§8.2) |
| `prospect_id` | uuid null。どの店舗のために用意した画像か (別の店舗の版で使うと拒否) |
| `owner_ai_share_decision_at/by` | null 固定 (check)。AI 画像を共有する仕様変更をオーナーが決めた後にだけ緩める (§8.3) |
| `revoked_at`, `revoke_code` | 権利の取り消し (苦情・期限・誤り) |

- RLS: 管理者だけが select。書き込みは関数だけ (worker の包みから server が作る / 管理者が権利を更新する)。
- 成功例の画像と reference の原本は、`loadForbiddenSha256` (originals inventory) と同じ集合を server でも持ち、`sha256` が当たれば `FORBIDDEN_SOURCE_HASH` で版ごと拒否する。

### 4.4 `sales_demo_quality_reviews` (デモの品質承認。送信承認とは別の表)

| 列 | 意味 |
|---|---|
| `id` | uuid pk |
| `version_id` | → `sales_demo_versions(id)` |
| `decision` | `approved` / `rejected` / `changes_requested` |
| `state` | `active` / `withdrawn` / `invalidated` (後戻りしない。trigger) |
| `checklist` | jsonb strict。§7.2 の観点ごとの ok / ng (enum だけ) |
| `viewed_renders_sha256` | 承認したときに画面に出した PC1440 / SP390 の描画の sha256 (見たものを固定) |
| `bundle_sha256`, `facts_sha256`, `rights_summary_sha256` | 承認したときの版の内容 (snapshot。変えられない) |
| `reviewed_by`, `reviewed_at` | 管理者と時刻 |
| `invalidated_at`, `invalidated_reason` | `rights_changed` / `facts_changed` / `version_revoked` / `withdrawn` / `superseded_by_newer_approval` |

- 1 つの demo で `active` な `approved` は**最大 1 件** (partial unique index)。新しい版を承認すると、前の版の承認は `superseded_by_newer_approval` になる (送信済みの承認が固定した版は §9.4 のとおり残る)。
- `sales_demos` に `approved_version_id` (null 可) を足し、`active` な `approved` の版を指させる (関数だけが書く)。DEV-195 の照合はこの列を見る (§9)。

### 4.5 `sales_demo_generation_jobs` (将来の自動生成。§10)

| 列 | 意味 |
|---|---|
| `id` (= `generation_job_id`) | job の id |
| `demo_id`, `parent_version_id` | どの店舗の、どの版の作り直しか |
| `state` | §4.6 の worker の状態 |
| `attempts`, `claimed_at`, `lease_expires_at` | 試行と lease (既存の design bridge と同じ考え方: 最大 3 回・lease 2 時間) |
| `grant_id` | 生成・画像生成の 1 回限りの承認 (§10.4) |
| `error_code` | 固定の符号だけ |
| `version_id` | できた版 (1 対 1) |

### 4.6 状態機械

**版 (`sales_demo_versions.status`)**

```
uploading ──finalize OK──► draft ──品質承認──► approved ──(別の版を承認)──► superseded
    │                        │                    │
    │ finalize NG            │ 取り消し            │ 取り消し / 権利の取り消し
    ▼                        ▼                    ▼
 rejected (オブジェクト削除)  revoked             revoked
                                                   (送信済みの承認が固定していても revoked は効く: 共有は 404)
draft / approved / superseded ──期限 (expires_at、未送信のときだけ)──► expired (掃除の対象)
```

| 状態 | 管理者プレビュー | 送信承認に使える | 共有 URL |
|---|---|---|---|
| `uploading` | × | × | × |
| `rejected` | × (符号だけ表示) | × | × |
| `draft` (未承認、または品質承認の取り下げ・無効化で戻った版) | ○ | × | × (ただし `sent` の承認が固定していれば、その相手には出し続ける。§6.4) |
| `approved` | ○ | ○ (`share_eligible` が false ならデモ URL を含む送信は不可。§8.3) | 送信済みの承認が固定したときだけ |
| `superseded` | ○ (履歴) | × (新しい承認には使えない) | 送信済みの承認が固定していれば、その相手にはこの版を出し続ける (§9.4) |
| `revoked` / `expired` | × | × | × (404) |

**品質承認 (`sales_demo_quality_reviews.state`)**: `active` → `withdrawn` (オーナーが取り下げ) / `invalidated` (§9.3 の理由)。後戻りなし。

**品質承認を取り下げた・無効になった版の状態**: 版は `approved` から **`draft` に戻る** (`approved_version_id` は null。§9.3)。`draft` は今後の送信承認には使えない (もう一度品質承認すれば `approved` に戻る)。ただし、その版を固定した `sent` の承認があれば、共有 URL は状態にかかわらずその版を出し続ける (§6.4 の手順 3・4)。共有を止めるのは取り消し (`revoked`) と共有の期限 (`isDemoPublic`) だけである。

**送信承認**: DEV-195 のまま (`approved` → `send_opened` → `sent`、`superseded`)。§9 で「品質承認済みの版」の条件を足す。

**生成 job (`sales_demo_generation_jobs.state`)** は §10.1。

---

## 5. Storage の配置 (提案)

### 5.1 bucket

- **非公開の bucket を 1 つ**: `sales-demo-versions` (`public = false`、`file_size_limit` 4MiB、`allowed_mime_types` = `text/html`, `text/css`, `image/webp`, `image/jpeg`)。
- `storage.objects` に anon・authenticated の policy を**作らない**。読み書きは service role (server) だけ。管理者もバイト列は server の route を通してだけ見る。
- 公開 bucket・公開 URL・CDN は作らない。

### 5.2 key の形

```
v1/<demo_id>/<version_id>/page/index.html
v1/<demo_id>/<version_id>/page/style.css
v1/<demo_id>/<version_id>/page/photos/<slot>-<range>.<webp|jpg>      range = desktop | tablet | mobile
v1/<demo_id>/<version_id>/renders/desktop_1440.webp
v1/<demo_id>/<version_id>/renders/tablet_768.webp          (店の spec が tablet を描くときだけ。輪は描く)
v1/<demo_id>/<version_id>/renders/mobile_390.webp
```

- key は manifest と server が決める。URL の path は key にならない (route は manifest の名前と完全一致したものだけを、manifest の sha256 から引く)。
- **URL の path と manifest の名前の対応 (これが唯一の正本。§3・§6.4・§6.7 はこれに従う)**:

  | URL (`/demo-frame/<scope>/<token>/` の後) | manifest の名前 | scope |
  |---|---|---|
  | `index.html` | `page/index.html` | `a`・`p` |
  | `style.css` | `page/style.css` | `a`・`p` |
  | `photos/<name>` | `page/photos/<name>` | `a`・`p` |
  | `renders/<name>` | `renders/<name>` | `a` だけ |

  つまり頁のファイルは URL から `page/` を**外した**名前で出す (server が URL の X を manifest の `page/X` に写す)。HTML の相対 URL (`style.css`・`photos/…`) は書き換えずにそのまま解決する。`page/` の下に許すのは `index.html`・`style.css`・`photos/*` だけなので、`renders/` と名前がぶつからない。
- **描画画像の形式**: photo-swap が出す全頁の PNG (`desktop_1440.png`・`mobile_390.png`、輪は `tablet_768` も) を、worker の包みの段で**WebP (固定の品質・metadata なし) に変換**して `renders/<viewport>.webp` にする。元の PNG の sha256 は `worker_checks` に残す (追跡用)。PNG は受けない (全頁の PNG は 1 枚で数 MB〜十数 MB になり、1 ファイル 4MiB の上限と Vercel の要求の上限を超えるため)。bucket の `allowed_mime_types` にも PNG を入れない。
- **入れないもの**: `rights.private.json`、`.intake/`、`swap-manifest.json`、pipeline の記録、所有者名、同意の記録の参照、private path、prompt の本文、モデル名。出所は DB の `sales_demo_images.provenance` にだけ書く (§8.2)。Storage の object metadata にも書かない。
- SVG ファイルは受けない (単独で開かれた `image/svg+xml` はスクリプトを動かせる)。HTML の中の inline SVG は B方式の規則の範囲で可。
- 画像は配信用に正規化してから包む: 各 range の枠の最大の辺の 2 倍まで縮め、WebP / JPEG、EXIF・GPS なし。1 枚 ≤ 2MB・各辺 ≤ 4096px。HTML ≤ 384KiB・CSS ≤ 256KiB (B方式の上限と同じ)・ファイル ≤ 40・合計 ≤ 15MiB。正規化しないと 1 枚が数 MB になり、Vercel の応答の上限と転送量を超える (§11.3)。

---

## 6. route と認証 — 管理者プレビューと共有 URL の分離

### 6.1 二つの見え方

| | 管理者プレビュー | 相手に送る共有 URL |
|---|---|---|
| 入口の URL | `/admin/sales/demos/[prospectId]` (新しい頁) と、既存の `/admin/preview/[prospectId]` からのリンク | `/demo/[publicToken]` (**今の URL のまま**。送信済みの文面に入っている) |
| 入口の認証 | 管理者セッション (`requireAdminPage`、RLS) | `public_token` (32 bytes の乱数) + `isDemoPublic` (送信済み・30 日・無効化なし) |
| 成果物の route | `/demo-frame/a/<view token>/<path>` | `/demo-frame/p/<view token>/<path>` |
| view token の発行 | 管理者の頁を描くたびに server が発行 (15 分) | 外枠の頁を描くたびに server が発行 (30 分) |
| token が指せるもの | 1 つの版 (`draft` / `approved` / `superseded`)。取り消し・期限切れは不可 | **送信済みの承認が固定した 1 つの版だけ** (§9.4)。`share_eligible` かつ取り消しなし |
| 見えるもの | 版の全ファイル (AI 画像を含む)、PC1440 / SP390 (と tablet 768) の描画、検査の符号、権利の要約、系譜、品質承認の操作 | 版の頁のファイル (`index.html`・`style.css`・`photos/*`) だけ (`renders/` は出さない)。注記と footer は**信頼できる外枠**が出す (MVP_SPEC §7「Second Root による提案用デモであり、店舗公式サイトではない」) |
| 見えないもの | 権利の参照・出所の生の値 (画面には enum と要約だけ) | 営業メモ・メール・内部評価・成約・内部 ID・secret (MVP_SPEC §7)、版の番号・系譜・検査結果・権利の記録、ほかの版 |
| 版がないとき | 「デモの版はまだありません」(既存の React プレビューはそのまま) | 既存の React のデモ (template / DesignProfile) のまま。**未承認の版へは決して落ちない** |

### 6.2 view token (提案)

- 形: `base64url(payload) "." base64url(HMAC-SHA256(key, payload))`。payload = `{v:1, scope:"a"|"p", version_id, demo_id, exp}`。
- 鍵: 新しい server 専用の環境変数 `SALES_DEMO_VIEW_SIGNING_KEY` (32 bytes 以上、server only、Vercel の env。値は commit・表示しない)。**鍵の rotate で、発行済みの view token がすべて無効になる** (非常停止)。
- 利点: 共有の外枠を開くたびに DB へ書かない (匿名の要求で書き込みが増えない)。
- 取り消しは token ではなく **DB の状態で毎回**確かめる (§6.4)。token が漏れても、効くのは 1 つの版の閲覧を最大 15 / 30 分だけ。
- scope が違えば別物: `a` の token を `/demo-frame/p/` に出すと 404、その逆も 404。`p` の token は発行の時点と配信のたびに「送信済みの承認が固定した版」であることを確かめる。
- **採用 (オーナー決定 2026-11-10)**: 管理者用・共有用とも HMAC の token + **要求ごとの DB の取り消しの照合** (§6.4)。期限は管理者用 15 分、共有用 30 分。共有 URL (`/demo/[publicToken]`) を開き直す (外枠を描き直す) たびに、新しい 30 分の token を発行する。DB の view session 行の案は採らない。

### 6.3 なぜ cookie ではなく path の token か

`sandbox` の iframe (`allow-same-origin` なし) の文書は opaque origin になる。そこからの CSS・画像の要求は cross-site 扱いで、`SameSite=Lax` の Supabase の cookie は送られない。cookie で認証すると画像が出ない。
しかも `@supabase/ssr` のブラウザ用 cookie は HttpOnly ではない (browser client が読む) ので、成果物の文書が**同じ origin でスクリプトを動かせたら管理者のセッションが漏れる**。だから:

- 成果物の route は cookie を**読まない** (`proxy.ts` の matcher は `/admin/*` のままで、`/demo-frame/*` を含めない)。
- 認可は path の短命な token だけ。発行できるのは管理者の頁 (scope `a`) と、表示条件を満たした共有の外枠 (scope `p`) だけ。

### 6.4 成果物の route `/demo-frame/{a|p}/[token]/[...path]` (route handler)

要求ごとに、この順で確かめ、どれか 1 つでも外れたら**同じ 404** (理由を区別しない、`Cache-Control: no-store`):

1. 機能の旗 `SALES_DEMO_VERSIONS_ENABLED` が `"true"` (それ以外は 404)。共有は別の旗 `SALES_DEMO_SHARE_ENABLED` も要る (§12)。
2. token の形・HMAC (定数時間)・`exp`・scope が path と一致。
3. DB (service role): 版が存在し、`revoked_at` が null。scope `a` は `status` が `draft` / `approved` / `superseded` で版の `expires_at` 内。**scope `p` は `status` を見ない** (下の 4 で、送信済みの固定だけで決める)。
4. scope `p`: demo が `isDemoPublic` (送信から 30 日・`keep_alive`・無効化なし) を満たし、`sales_outreach_approvals` の `sent` の行がこの版を固定していること (§9.4)。**今の承認の状態 (`approved` / `superseded` / 品質承認の取り下げで `draft` に戻ったもの) にかかわらず、送信済みの固定があり取り消し・期限切れでなければ出す**。送信済みの版は版の `expires_at` による掃除の対象にしない (§9.4) ので、期限は共有の期限 (`isDemoPublic`) で決まる。さらに`share_eligible` が true で、版の全画像の `rights_status` が共有可 (§8.3、配信のたびに再評価)。
5. URL の path を §5.2 の対応表で manifest の名前に写し、その名前が manifest に完全一致で在ること (scope `p` は `index.html`・`style.css`・`photos/*` だけ、`renders/*` は 404)。`..`・query・符号化の抜け道は対応表と manifest の照合で落ちる。
6. `Sec-Fetch-Dest` を役割と照合する。CSS は `style`、画像は `image`。HTML は **scope `p` では `iframe` だけ** (無い・`document` などは 404。外枠の注記 (MVP_SPEC §7) なしに頁だけを直接開けないようにするため。`Sec-Fetch-Dest` を送らない古いブラウザでは枠の中が空になるが、fail closed を選ぶ)。scope `a` は `iframe` (無ければ許す。管理者だけの道で、CSP の `sandbox` が後ろ盾)。
7. Storage から読み、sha256 を manifest と照合してから返す。

### 6.5 署名付き URL を使わない理由

Supabase の署名付き URL は path と期限を持つ自己完結の署名で、Storage は denylist を持たない。期限前に止めるには、object を消す・動かすか、project の署名鍵を rotate する (全 session と全署名付き URL が無効になる) しかない。
相対 URL (`style.css`・`photos/…`) も object ごとに別の token が要り、HTML を見るたびに書き換えることになる。
server の route なら、取り消しは次の要求から効き、ヘッダも hash の再確認も自分で持てる。転送は Supabase → Vercel → ブラウザで約 2 倍になるが、正規化した後なら小さい (§11.3)。

### 6.6 期限と取り消し

| もの | 期限 | 取り消し |
|---|---|---|
| 管理者用 view token | 15 分 | 版の `revoked_at`、鍵の rotate |
| 共有用 view token | 30 分 (外枠を開くたびに新しく発行) | 同上 + demo の `disabled_at`・期限切れ・権利の取り消し |
| 共有 URL `/demo/[publicToken]` | 原則 30 日: 送信済みから 30 日 (`expires_at`)、`keep_alive`、`disabled_at` (DNC で即時)。開き直すたびに共有用 token を新しく発行 | 今の手段 + 版の取り消し。**送信済みの版を取り消したら共有 URL は 404。ほかの版や既存の React のデモへ自動で切り替えない** (オーナー決定 2026-11-10) |
| 未送信の版 (管理画面で見られる期間) | 作成から約 60 日 (オーナー決定 2026-11-10) | `revoked_at` (管理者の関数、即時) |
| 送信済みの版 (管理画面で見返す期間) | 共有の期間が終わってから約 30 日 (オーナー決定 2026-11-10)。その間は管理者プレビューだけ | `revoked_at` |
| 期限の後の削除 | 自動では消さない。Storage の object の削除は**別の承認** (DEV-196j、復元できないデータの削除) | — |
| アップロードの token (bridge → server) | 15 分、1 回限り | 使用済み・期限切れ |
| 生成・受け入れの承認 (grant) | 最大 24 時間、1 回限り | オーナーが使用前に消せる |

- 取り消しの手段: (1) 版の `revoked_at` (通常の手段)、(2) 画像の `revoked_at` (その画像を使う全版の `share_eligible` が false に。配信時に再評価)、(3) Storage の object の掃除 (戻せない。保持期限・権利の苦情のとき。オーナーの承認つき)。
- 限界: すでに相手の画面に開かれている頁は呼び戻せない。ブラウザに `no-store` 以外の cache は持たせない。

### 6.7 応答ヘッダ (成果物の route)

| ヘッダ | HTML | CSS | 画像 |
|---|---|---|---|
| `Content-Type` | `text/html; charset=utf-8` | `text/css; charset=utf-8` | manifest の値 (`image/webp` / `image/jpeg`。描画画像は WebP で scope `a` だけ)。magic bytes で確かめた後 |
| `X-Content-Type-Options` | `nosniff` | `nosniff` | `nosniff` |
| `Content-Security-Policy` | 下記 | `default-src 'none'` | `default-src 'none'` |
| `Cache-Control` | `private, no-store` | `private, no-store` | `private, no-store` |
| `Referrer-Policy` | `no-referrer` | 同 | 同 |
| `X-Robots-Tag` | `noindex, nofollow, noarchive` | 同 | 同 |
| `Permissions-Policy` | すべて無効 (camera・microphone・geolocation・payment・usb など) | | |
| `Cross-Origin-Opener-Policy` | `same-origin` | | |

- `X-Frame-Options` は付けない (iframe に入れるため)。代わりに CSP の `frame-ancestors <アプリの origin>` (別 origin で配るときはアプリの origin を名指し、同じ origin の暫定 (管理者だけ) では `'self'`。§6.8)。
- `Cross-Origin-Resource-Policy: same-origin` は付けない (opaque origin の文書からの画像の要求が止まる)。
- HTML の CSP (要求ごとに組む。`'self'` の意味は opaque origin の中でブラウザごとに揺れたため、host と path で書く)。path は §5.2 の対応表の **URL 側** (`page/` を外した名前) で、server が manifest の `page/style.css`・`page/photos/*` に写す:

```
default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none';
connect-src 'none'; media-src 'none'; manifest-src 'none'; font-src 'none'; prefetch-src 'none';
style-src https://<host>/demo-frame/<scope>/<token>/style.css;
img-src https://<host>/demo-frame/<scope>/<token>/photos/;
form-action 'none'; base-uri 'none'; frame-ancestors https://<アプリの host>;
sandbox
```

`<host>` は成果物を配る origin (`<artifact-origin>`、暫定の管理者プレビューではアプリの host)。

- `sandbox` 指令 (`allow-*` なし) は、URL を直接開かれても文書を opaque origin・スクリプトなしにする。iframe の `sandbox=""` 属性の後ろ盾。
- `font-src 'none'` でも端末にある書体は使える (読み込みはしない)。B方式の「許可した書体だけ」と合う。端末に無い書体は代わりの書体で出る (§7.2 で描画画像を並べる理由)。
- 外枠の頁 (`/admin/sales/demos/…`・`/demo/[publicToken]`) は今のヘッダ (`X-Frame-Options: DENY`・`frame-ancestors 'none'`) のまま。iframe は `sandbox=""`・`referrerpolicy="no-referrer"`・`loading="lazy"`・`allow` 属性なし。

### 6.8 専用の別 origin と、権限・cookie・CSP の境界 (オーナー決定 2026-11-10)

**共有する成果物は、専用の別 origin から配ることを採用する** (以下 `<artifact-origin>`。例: アプリと別の sub domain。名前は DEV-196a で決める)。
ただし **DNS と Vercel の設定は今は変えない**。設定は後の段 (DEV-196g の前) の別の承認である。非公開の Storage・sandbox・スクリプト無効・要求ごとの認可は、別 origin を入れても**そのまま保つ** (別 origin は置き換えではなく、もう 1 枚の層)。

| | アプリの origin (今の Second Root) | `<artifact-origin>` (新設、後の承認) |
|---|---|---|
| 置くもの | 管理画面 (`/admin/*`)、管理者プレビューの外枠 (`/admin/sales/demos/[prospectId]`)、共有 URL の外枠 (`/demo/[publicToken]`)、アップロードの API (`/api/internal/…`) | 成果物の route `/demo-frame/{a\|p}/[token]/[...path]` **だけ**。ほかの頁・API は置かない (他の path は 404) |
| cookie | Supabase の管理者セッション (今のまま、host-only)。外枠は cookie を読む | **cookie を一切発行せず、読まない**。アプリの cookie は host-only なので送られない (アプリの cookie に `Domain=` を付けて親 domain に広げることはしない) |
| 認可 | 管理者セッション (RLS) / `public_token` + `isDemoPublic` | path の HMAC の view token + 要求ごとの DB の照合 (§6.2・§6.4) |
| CSP (外枠) | 今の `X-Frame-Options: DENY`・`frame-ancestors 'none'` に加え、`frame-src <artifact-origin>` だけを許す。**専用の origin が設定されていない間だけ**、管理者プレビューの外枠 (`/admin/sales/demos/…`) は `frame-src 'self'` にする (暫定の `/demo-frame/a/…` がアプリの origin にあるため)。設定された後は `'self'` を外す。共有の外枠 (`/demo/[publicToken]`) は常に `<artifact-origin>` だけ (`'self'` は入れない) | — |
| CSP (成果物) | — | §6.7 の CSP。`frame-ancestors <アプリの origin>` (`'self'` ではなく、アプリの origin を名指し)、`style-src` / `img-src` は `<artifact-origin>` の token の path |
| iframe | `sandbox=""` (`allow-*` なし)・`referrerpolicy="no-referrer"`・`allow` なし | 応答の CSP の `sandbox` 指令で、直接開かれても opaque origin・スクリプトなし |
| Storage | server (アプリの route と成果物の route の両方の server 側) だけが service role で読む。ブラウザには Storage の URL を出さない | 同左 |

- **共有 (scope `p`)** は `<artifact-origin>` からだけ配る。設定が無ければ (DNS と Vercel の承認の前) 共有の成果物 route は 404 (fail closed)。つまり共有の開始 (DEV-196g) は別 origin の設定の後になる。
- **管理者プレビュー (scope `a`)** も `<artifact-origin>` が使えるようになったらそちらに移す。それまで (ローカル・CI と、Staging で承認されたとき) は、アプリの origin の `/demo-frame/a/…` で、cookie を読まない route + CSP `sandbox` + iframe `sandbox=""` で配る。opaque origin なのでアプリの cookie・DOM・storage には届かない。これを管理者だけの暫定として受け入れる (T1・T19)。
- 両方の origin で、`/demo-frame/*` は `next.config.ts` の `/demo/:path*` などの規則に当たらない接頭辞にする (§2)。

---

## 7. 品質の確かめ方 — 店らしさを保ち、テンプレートに崩れない

### 7.1 三段の検査

| どこで | 何を | 正本か |
|---|---|---|
| worker (jail の中) | `checkPrototype` (Chromium)、描画の検査 (横はみ出し `PROTOTYPE_HORIZONTAL_OVERFLOW`・白紙 `RENDER_BLANK`・高さ 16000px 超・見えない節)、PC1440 / SP390 の全頁の描画、構造記述子の計測、Identity Lock (店名・業種)、事実の照合 (copy record と事実パック) | 助言 (`worker_checks` に記録) |
| bridge (`sr-designbridge`、ブラウザなし・子 process なし) | 包みの形だけ: strict schema・ファイル名・大きさ・sha256・link / device / hard link なし・全ファイルの宣言 (`spool.ts` の読み方) | 形の門 |
| **server の finalize** | 全 object の再ハッシュ、magic bytes と画素数、HTML/CSS の規則 (§7.3)、書体の許可一覧、画像の権利 (§8)、事実の照合 (§7.4)、成功例の画像の hash の禁止 | **正本** (`validator_result`) |

どれかが通らなければ版は `rejected` になり、object は消え、符号だけが残る (自由文は残さない)。

### 7.2 PC 1440 と SP 390 の確かめ方

- worker が描いた全頁の画像 (`renders/desktop_1440.webp`・`renders/mobile_390.webp`、店の spec が描くなら `renders/tablet_768.webp`。§5.2) を版に含める。desktop と mobile は必須 (無い版は品質承認できない)、tablet は任意 (あれば並べる)。端末に IPA などの書体が無い (Windows・iOS) と、ブラウザの生の頁は書体が変わるため、**オーナーが判断する基準は描画画像**にする。
- 管理画面は 1 画面に 3 つを並べる: (1) PC1440 の描画画像、(2) SP390 の描画画像、(3) 生の頁の iframe (幅 1440 を縮小した枠と、幅 390 の枠を切り替え)。スマホで開いたときは SP を先に出す。
- オーナーの確認項目 (品質承認の `checklist`、enum の ok / ng):
  1. 店名・業種が正しい (Identity Lock。別の店名・別業種の混入なし)
  2. 表示された事実がすべて確認済み (§7.4。未確認は出ていないか「未確認」のまま)
  3. **その店舗でなければ成立しない構成**である (この店にしか無い比喩・構図、Hero の型と流れの型。店名を入れ替えても成り立つ頁は ng)
  4. **凡庸な LP への回帰がない** (汎用 LP の骨格・積み重ねた帯・カードの並びに戻っていない。§7.5 の警告を見たうえで判断)
  5. **全ページで情報が伝わる** (PC1440 と SP390 の全頁を上から下まで見て、店の事実と連絡の道が読める。SP はスマホのために組まれ、PC を縮めただけではない・横はみ出しなし・文字が読める。PC は間延び・空白の崩れがない)
  6. 写真が店の事実を偽らない (§8。AI 画像は管理者プレビューだけ)
  7. 成功例の写しではない (§7.6)
- 承認は「その描画画像を見た」ことを `viewed_renders_sha256` で固定する。描画画像が無い版は品質承認できない。
- **採用 (オーナー決定 2026-11-10)**: PC1440 / SP390 の全頁の描画と、上の 7 項目の品質確認を採用する。特に 3「その店舗でなければ成立しない構成」、4「凡庸な LP への回帰がないこと」、5「全ページで情報が伝わること」を重く見る。7 項目のうち 1 つでも ng なら品質承認できない (`changes_requested` か `rejected`)。

### 7.3 server の HTML/CSS の規則 (B方式の規則をそのまま)

- `prototype-safety.ts` の規則 (`FORBIDDEN_ELEMENTS`・`URL_ATTRIBUTES`・`cssProblems`・`cssUrls`) を、解析器から切り離した純粋な規則の核にし、Chromium の解析器 (WSL・CI) と server の解析器 (HTML 仕様どおりの tokenizer、例: parse5) の 2 つで使う。**規則は緩めない**。
- server の解析器は依存の追加になる (`package.json` / lockfile。CLAUDE.md のレビュー記録の対象で、オーナーの承認が要る。§12 DEV-196b)。
- 成果物に固有の追加の規則:
  - `<script>`・`on*`・`<form>`・`<iframe>`・`<object>`・`<base>`・`<meta http-equiv="refresh">`・`javascript:` / `data:` / 外部の URL・`@import`・`@font-face`・外への `url()`・`image-set(`・`expression()` を拒否 (B方式と同じ)
  - `style` 属性と `<style>` 要素を拒否 (CSP に `'unsafe-inline'` を入れないため。今の研究頁は 0 件)
  - `<link rel="stylesheet" href="style.css">` がちょうど 1 つ
  - `href` は `#fragment` だけ (電話・住所・時間はプレーンテキスト。B方式の事実の規則)
  - `<img>` / `<source srcset>` は manifest の写真の名前だけ
  - `font-family` は `PAGE_FONT_FAMILIES` と総称だけ
  - 注文・予約・カートの言葉、`テスト` を含む値を拒否 (B方式の事実の規則)
- 二つの解析器の差分を突くリスクには、(1) 研究の fidelity 頁が全部通り XSS の corpus が全部落ちる差分テスト、(2) CSP の `script-src 'none'` + `sandbox` の後ろ盾、で備える。さらに固くするなら、server が再直列化した HTML を配る (「検めたものを配る」)。描画画像とのバイト一致は失われる (§14 Q8)。

### 7.4 事実と Identity Lock

- 実店舗の版の文は、**生成の入力にした事実パック (fact-only の DemoView) の値と、固定の見出しだけ**。`facts_sha256` で入力を固定する。
- 包みに `copy.json` (copy record) を含め、server が HTML の見える文字を copy record の行と照合し、事実の行は事実パックの値と一致することを確かめる (`lib/design-agent/quality-pipeline/copy-record.ts` の考え方)。一致しない文は `UNVERIFIED_COPY` で拒否。
- 事実パックに無いこと (営業時間・価格・沿革・店主の話・人気商品など) は**作らない**。足りなければ省くか、管理画面で「未確認」と出す (公開頁には「未確認」の語も出さない。省く)。
- 研究頁のような創作の見出し (例: 輪の「どこを直すか、先に決める。」) は事実ではないので、実店舗の版では「創作の見出し」としてオーナーに印を付けて見せ、品質承認の確認項目 2 で判断を求める。

### 7.5 テンプレート化の防止

- 版ごとに構造記述子 (`lib/design-agent/structure`: hero・flow・navigation・reading_path・節の型・transitions・text_direction・imagery) を計測して `structure_descriptor` に残す。宣言より計測が勝つ。
- finalize で次を計算し、管理画面に**助言の印**として出す:
  - `GENERIC_SKELETON` (汎用 LP の印 3 つのうち 2 つ)
  - 直近に承認した**ほかの店舗**の版 N 件 (案: 20) との骨格の近さ。仮の閾値 0.6 (`SIBLINGS_SAME_SKELETON` と同じ値) を超えたら「ほかの店と同じ骨格」
  - 成功例 30 件・SR-001 との近さ。仮の閾値 0.75 (`TOO_CLOSE_TO_REFERENCE`) を超えたら「参照に近すぎる」
- 語彙と閾値は**仮** (Issue #159) なので、**今は警告だけで、自動では拒否しない** (オーナー決定 2026-11-10)。版は `rejected` にならず、品質承認も止めない。警告は管理画面に出し、オーナーが確認項目 3・4 で判断する。自動の拒否 (門) にするのは、警告とオーナーの判断の実績が十分に貯まり、オーナーが閾値を決めた後 (別の承認)。
- 方向案は 1 店舗につき 2 案以上で、Hero の型と流れの型の**両方**が違うこと (`directionsDiffer`、`second-root-design-director` スキル) は生成側の規則として保つ。

### 7.6 成功例 30 件と SR-001「輪」の使い方

- **参照としてだけ使う。相手のデモに写さない**。
  - 外部 30 件 (CP-001〜032): オーナーの判断の基準 (`docs/design/success-principles-v1.md` の原理) と、`TOO_CLOSE_TO_REFERENCE` の比較相手。画像・文・頁を版に入れない。成功例の画像の sha256 は server でも禁止の集合にする (`loadForbiddenSha256` と同じ originals inventory)。
  - SR-001「輪」: 架空の店。台帳の方針 (`not_templates`・`not_fed_to_generators_automatically`・`release_or_deployment_approval: false`) を守る。この仕様では (1) 品質の基準線 (この水準に届かない版は承認しない目安)、(2) **Staging の架空の prospect** (example.com) に載せて経路全体を通す試験の材料 (§12 DEV-196h)、にだけ使う。実在の店舗の版の元にしない。輪の AI 写真 6 枚 (`ai_generated_demo`・デモ専用・`public_web=false`) は共有 URL に出ない (§8 の規則でそうなる)。
- 生成の指示文に成功例を入れるときは、既存の承認済み参照の経路 (`reference_ids`、`learn` / `do_not_copy`) だけを使う。この仕様は新しい参照を足さない。

---

## 8. 画像の権利と出所

### 8.1 権利の状態 (`rights_status` の enum、案)

| 値 | 意味 | 管理者プレビュー | 共有 URL |
|---|---|---|---|
| `unknown` | 記録が無い・読めない・形が違う (**既定**) | × (版ごと `rejected`) | × |
| `ai_demo_internal` | `ai_generated_demo`。`ai_provenance` があり `demo_only: true`。架空の店の研究 (SR-001「輪」・つぐ手) | ○ (「AI 生成のデモ画像を含む (デモ専用・共有不可)」の固定の帯) | **×** |
| `ai_concept_internal` | **実店舗**の管理者だけのデザイン検討用の AI 概念画像 (オーナー決定 2026-11-10)。条件 (§8.3) をすべて満たすときだけ | ○ (画像ごとに「AI 生成の概念画像 (実在の商品・店内・人・設備ではありません。共有不可)」の固定のラベル) | **×** (仕様変更と承認が別に要る) |
| `owner_provided_internal` / `shop_provided_internal` | 人の写真。編集・切り抜き・商用は可だが `public_web` が false か店舗の書面の確認が無い | ○ | × |
| `licensed_terms_pinned_internal` | 利用規約の sha256 を固定した素材。`public_web` が false | ○ | × |
| `share_cleared` | 人の写真か規約固定の素材で、`public_web=true`・店舗の書面の確認あり (`client_confirmed_at`)・期限内・実在の人物を写さない | ○ | **写真の共有を認める後の別の承認 (MVP_SPEC §7 の変更、Protected Scope。DEV-196a には含まない) の後だけ** ○ (それまでは ×、§8.3) |
| `ai_share_approved` | (予約) AI 画像を共有する仕様変更と、画像ごとのオーナーの決定の後だけ。**今は DB の check で書けない** | ○ | 今は × |
| `expired` | `rights_expiry` を過ぎた (配信のたびに日付で判定) | × | × |
| `revoked` | 苦情・誤り・取り下げ | × | × |

- 状態は server が記録から**導く** (人が enum を直接選ばない)。導き方は画像の種類で 2 つに分かれる:
  - **人の写真・規約固定の素材・架空の店の AI デモ画像**: `photo_rights_v0` を `checkPhotoRights` に通した結果から導く。共有の判定は `purpose: "public_site"` の結果 (AI 画像は必ず `AI_DEMO_NOT_FOR_PUBLIC_SITE`) と同じ。`ai_generated_demo` は今までどおり `AI_DEMO_SHOPS` (架空の店) のときだけ `aiDemoAllowed` を渡し、それ以外は `AI_DEMO_NOT_ALLOWED` で `unknown`。**`checkPhotoRights`・`AiProvenance`・`AI_DEMO_PUBLIC_LABEL`・`AI_DEMO_SHOPS` は変えない** (架空の店の研究の規則を緩めない)。実店舗の画像に `aiDemoAllowed: true` を渡すことはしない。
  - **実店舗の AI 概念画像 (`ai_concept_internal`)**: `checkPhotoRights` には通さず、**別の記録と別の検査**で導く (§8.3.1)。
- **fail closed**: 1 枚でも共有可でない画像があれば、版の `share_eligible` は false。画像を抜いて穴のあいた頁を出すことはしない。共有したいなら、共有可の画像だけで作り直した**別の版**にする (系譜でつなぐ)。

### 8.2 出所 (provenance) の置き場所

- AI 画像の出所 (生成の手段、ツールが報告したモデル名、生成時刻、prompt の sha256、承認 ID、upscale の記録) と、人の写真の出所 (受け取り日、同意の記録の参照、規約の sha256) は **DB の `sales_demo_images.provenance` (管理者だけが読める) にだけ**記録する。
- **リポジトリのファイル (docs・json・テストの fixture) には書かない**。モデル名・所有者名・同意の参照・private path をリポジトリに入れない。今の WSL の `rights.private.json` の役割を DB が引き継ぐ。
- 包みが運ぶのは `toPublicPhotoRecord` の形 (hash・大きさ・`source_kind`・`allowed_uses`・demo のラベル・prompt の sha256) と、server へ別に渡す権利の記録だけ。server は strict schema で受け、未知の key は 400。
- 管理画面に出すのは enum・要約・日付だけ (生の参照は出さない)。

### 8.3 実店舗のデモに AI 画像を使ってよいか

**オーナー決定 2026-11-10:**

- **実店舗の管理者だけのデザイン検討では、AI 生成の概念画像を条件つきで使ってよい** (`ai_concept_internal`)。条件はすべて満たすこと:
  1. **事実の偽装をしない**: 実在の商品・店内・人・設備を事実として見せない。描いてよいのは質感・光・抽象的な形・一般的な道具の形などの雰囲気だけ。画像の記録に `depicts_real_product` / `depicts_real_interior` / `depicts_identifiable_person` / `depicts_real_equipment` (案) を持ち、どれかが true なら `unknown` と同じ扱い (版ごと `rejected`)。オーナーが画像ごとに「事実の偽装なし」を確かめて記録する。
  2. **管理画面で AI 生成と明示する**: 画像ごとに固定のラベル (上の表)。ラベルは管理画面の外枠が出し、成果物の HTML には任せない。
  3. **出所と利用の許可を記録する**: `sales_demo_images.provenance` (§8.2) に生成の手段・ツールが報告したモデル名・生成時刻・prompt の sha256・承認 ID を、`allowed_uses` と承認の参照に利用の許可を残す。記録が欠ければ `unknown` (fail closed)。
- **実店舗の prospect への AI 画像の共有は、今は認めない**。共有 URL には出さない (`share_eligible` は false、DB の check でも強制)。将来使うには、仕様の変更 (MVP_SPEC §7、Protected Scope) と承認が別に要る。根拠: MVP_SPEC §7「AI 生成・架空の店舗写真は使わない」(DEV-070)、SECURITY §6、`checkPhotoRights` の `AI_DEMO_NOT_FOR_PUBLIC_SITE`。実店舗の商品・店内・職人を AI で描いて見せれば、**店舗の事実を作る**ことになる (Identity Lock・事実パック)。
- **架空の店の研究 (SR-001「輪」・つぐ手など) は今までどおり** (`ai_demo_internal`、`AI_DEMO_SHOPS`、DEV-185〜193 の承認の範囲)。
- 画像の生成そのもの (Codex・画像生成) は、今までどおり 1 回ごとのオーナーの承認が要る (§10.4、DEV-196i)。この決定は生成を承認しない。
- `ai_concept_internal` の画像を含む版は、管理者プレビューで見て品質承認まではできるが、共有できないので、その版でデモ URL を含む送信承認はできない (`demo_not_shareable`、§9.2)。送るには AI 画像を含まない別の版 (系譜でつなぐ) か、版の無い既存の React のデモ (§9.2) を使う。
- **AI 画像だけでなく、どの写真も今は共有 URL に出せない**。MVP_SPEC §7 は「公開 demo には今も写真を出さない」とし、コードも `PUBLIC_DEMO_ASSETS_ENABLED = false` である。したがって `share_cleared` の写真を共有 URL に出すことも、**写真の共有を認める後の別の承認 (MVP_SPEC §7 の変更、Protected Scope。DEV-196a には含まない)** が先に要る (DEV-196a は写真の共有を変えない、§12)。それまでは、共有できる版は**写真 0 枚の版だけ** (`share_eligible` は「写真が 0 枚」のときだけ true、DB の check でも強制) とし、`share_cleared` は承認の後に有効にする予約の値として扱う。
- 仕様を変える場合 (Protected Scope) の最小の条件: MVP_SPEC §7 の改訂、店の事実を描かない画像 (質感・抽象・道具の一般形など) に限る規則、実店舗向けの新しいラベルの文 (今の `AI_DEMO_PUBLIC_LABEL` は「架空の店」と書いてある)、画像ごとの `owner_ai_share_decision_at/by`、外枠が出すラベル (成果物の HTML には任せない)。

### 8.3.1 `ai_concept_internal` の導き方 (DEV-196b で実装)

- 記録は `photo_rights_v0` とは別の schema `ai_concept_rights_v0` (案、strict)。`source_kind` は `ai_concept_internal` の 1 値だけで、`ai_generated_demo` と混ぜない。中身:
  - `provenance`: 生成の手段・ツールが報告したモデル名・生成時刻・prompt の sha256・承認 ID (`AiProvenance` と同じ形の欄。ただし `demo_only` ではなく `admin_preview_only: true` 固定)。値は DB だけに置く (§8.2)。
  - `depicts_real_product` / `depicts_real_interior` / `depicts_identifiable_person` / `depicts_real_equipment` / `depicts_real_shop`: すべて boolean。
  - `no_factual_impersonation_confirmed_at` / `_by`: オーナーの「事実の偽装なし」の確認。
  - `admin_label`: 固定の文 `AI_CONCEPT_ADMIN_LABEL` (「AI 生成の概念画像。実在の商品・店内・人・設備ではありません。共有不可」、案) と一致すること。
  - `prospect_id`: どの実店舗の検討用か。
  - sha256・bytes・width・height・format (計測した値と照合)。
- 検査 `checkAiConceptRights(record, bytesInfo, opts)` (案) は、次を**すべて**満たすときだけ `ai_concept_internal` を返し、1 つでも欠ければ `unknown`:
  1. schema に通り、出所が記録されている (モデル名・承認 ID・prompt の sha256 が空でない)
  2. `depicts_real_*` がすべて false
  3. オーナーの確認がある
  4. 管理画面のラベルが固定の文と一致
  5. bytes の hash・大きさ・形式が記録と一致し、成功例の禁止の hash に当たらない (`forbiddenSha256`、`checkPhotoRights` と同じ集合)
  6. 版の `demo_id` の prospect と記録の `prospect_id` が同じ
- 結果は**管理者プレビューで見えるだけ**。`purpose` を受け取らず、共有の可否を返す経路そのものが無い (返り値の型に `share` が無い)。`share_eligible` の導出は `ai_concept_internal` の画像が 1 枚でもあれば常に false。
- 実装の場所 (DEV-196b、offline の純粋な module): `lib/sales/demo-version/ai-concept-rights.ts` (案。schema・`AI_CONCEPT_ADMIN_LABEL`・`checkAiConceptRights`) と、両方の検査の結果を enum に写す `lib/sales/demo-version/rights.ts` (案。`deriveRightsStatus`・`shareEligible`)。`lib/design-agent/quality-pipeline/photo-rights.ts` は import して使うだけで変えない。unit で「`ai_concept_internal` の記録は `checkPhotoRights` では `unknown`」「`depicts_real_*` が 1 つ true・確認なし・ラベル違い・出所の欠け → `unknown`」「`shareEligible` は常に false」を固定する。

### 8.4 `rights_summary` (版ごと、server が導く)

`{version:1, photos:n, by_status:{share_cleared:n, ai_demo_internal:n, …}, earliest_expiry, label_required:bool}`。固定の key・≤ 1KB (check)。`share_eligible` はここから導き、配信のたびに画像の `rights_status`・期限・取り消しを再評価する (保存値だけを信用しない)。

---

## 9. DEV-195 の承認との結び付け — 二つの独立した承認

### 9.1 二つの承認

| | デモの品質承認 | 送信承認 (DEV-195) |
|---|---|---|
| 何を | 「この版は店らしく、事実が正しく、PC/SP で崩れていない」 | 「この文面を、この宛先に、このデモで送る」 |
| 記録 | `sales_demo_quality_reviews` (§4.4) | `sales_outreach_approvals` |
| 単位 | 版 | 初回営業 1 件 |
| 前提 | 版が `draft` で検査を通っている・描画画像がある | **品質承認済みの版がある** (版の機能が有効な demo のとき) |
| 誰が | 管理者 (MVP は 1 名) | 管理者 |

同じ人が押しても、別の画面の別の操作で、別の行に残る。片方がもう片方を兼ねない。

### 9.2 送信承認に足す条件 (提案)

`sales_outreach_approvals` に列を足す (提案):

| 列 | 意味 |
|---|---|
| `demo_version_id` | 送るデモの版 (null = 版の機能を使わない legacy のデモ) |
| `demo_bundle_sha256` | その版の `bundle_sha256` |
| `demo_quality_review_id` | その版の `active` な `approved` の品質承認 |
| `demo_share_eligible` | 承認した時点の `share_eligible` (記録用。照合には使わない、§9.2) |
| `demo_unavailable_after_open` | `send_opened` からの送信済みのときだけ、その時デモが出せなかった理由 (`rights_expired` / `version_expired` / `revoked_urgent` など、案。§9.5) |

`sales_send_guards` (承認・送信画面を開く・送信済みのたび) に足す照合。**保存された旗 (`share_eligible`・`rights_summary`・品質承認の `state = active`・`status`) を信用せず、照合のその時点で元の行から導き直す** (保存値は画面の表示用の cache にすぎない):

- 版: `sales_demos.approved_version_id` があるなら、その版の `status = approved`・`revoked_at` が null・`expires_at > now()`。
- 品質承認: その版の品質承認の行が `decision = approved`・`withdrawn` でも `invalidated` でもない・snapshot (`bundle_sha256`・`facts_sha256`) が今の版と今の事実に一致。
- 事実: 今の `sales_demos.content` から server と同じ式で計算した hash (`facts_sha256` = sha256 of `content` の正規化した text。worker の申告ではなく server が `begin` の時点で DB から計算して保存する) が版の `facts_sha256` と一致。
- 権利: 版が使う全画像 (`sales_demo_version_files` → `sales_demo_images`) について、`revoked_at` が null・`rights_expiry` が null か今日 (JST の暦日) 以降・`rights_status` が共有可 (§8.1)。**期限は日付が過ぎるだけで変わるので、保存した `share_eligible` は見ない**。1 枚でも外れれば `demo_not_shareable`。
- 本文にデモ URL を含む送信は、上の権利の照合を通る版のときだけ (今の DEV-195 の本文は常にデモ URL を含むので、実際には「共有可の版が要る」)。
- 照合の符号: `demo_version_unavailable` (版・期限・取り消し)・`demo_quality_not_approved` (品質承認)・`demo_facts_changed` (事実)・`demo_not_shareable` (権利)。どれも承認と「送信画面を開く」では拒否。「送信済み」での扱いは §9.5。
- **承認済みの版が無い店舗 (オーナー決定 2026-11-10)**: `approved_version_id` が null の demo は、**一時的に既存の React のデモ (template / DesignProfile) で送ってよい**。ただし人による内容の確認と送信承認 (DEV-195 の `sales_approve_outreach`、表示した文面とデモの確認) は必須で、省略しない。
  - 未承認の新しい版へ**自動で切り替えない**。`draft` の版があっても、共有 URL も送信承認も React のデモのまま (共有 URL が版を出すのは `sent` の承認が版を固定したときだけ、§6.4)。
  - 品質確認を**飛ばさない**。版を使って送るには、§7.2 の品質承認が必ず先。React のデモから版への切り替えは、品質承認 → `approved_version_id` の設定 → (`demo_version` が変わるので) 送信承認のやり直し、の順でだけ起きる。

### 9.3 `sales_demo_version(d)` の拡張 (既存の照合に版の変化を拾わせる)

- 今の `demo_version` は `public_token`・`template`・`content`・`design_status`・`design_profile` の sha256 で、**版の差し替えに気づかない**。
- 提案: `approved_version_id` が null でないときだけ、配列の末尾に `approved_version_id` とその `bundle_sha256` を足す。null のときは今と**同じ hash** になるので、既存の承認 (版を使わない demo) は無効にならない。
- これで `sales_approval_is_current` が、承認の後に版が変わった (新しい版を承認した・取り消した) ことを今の仕組みのまま拒否する。
- **取り消しと hash**: 版の取り消し (`revoked_at` を立てる) と品質承認の取り下げは、同じ transaction で `sales_demos.approved_version_id` を **null に戻す**。hash は legacy の形 (5 要素) に戻り、取り消した版を含む hash を持つ承認とは一致しなくなる。新しい版の承認は `approved_version_id` を新しい版に置き換えるので、やはり hash が変わる。権利の期限切れ・画像の取り消しは `approved_version_id` を変えない (時間で起きることは書き込みを伴わないため) ので、§9.2 の導き直しの照合で拒否する。
- hash を変える操作 (新しい版の承認・版の取り消し・品質承認の取り下げ) は、§9.5 のとおり `send_opened` の承認があるあいだ拒否する。

### 9.4 何が何を無効にするか

| できごと | 品質承認 | 送信承認 (未送信: `approved` / `send_opened`) | 送信済み (`sent`) の相手に見えるもの |
|---|---|---|---|
| 新しい版を承認した | 前の版の承認は `superseded_by_newer_approval` | `demo_version` が変わるので、送信済みにできない (再承認が要る) | 送ったときの版のまま (差し替えない) |
| 版を取り消した | `invalidated(version_revoked)` | 同上で拒否 | **404**。ほかの版や既存の React のデモへの自動の切り替えは禁止 (オーナー決定 2026-11-10。送った頁と違う頁を見せない) |
| 画像の権利を取り消した・期限が切れた | その画像を使う版の承認は `invalidated(rights_changed)` | 拒否 | その版は配信のたびの再評価で 404 |
| 事実パックが変わった (prospect の事実の訂正) | `facts_sha256` が今の事実と違えば `invalidated(facts_changed)` | 拒否 | 送ったときの版のまま (ただし事実の誤りなら版を取り消す) |
| 文面を編集した | 変わらない | DEV-195 のとおり `superseded(draft_edited)` | — |
| 品質承認を取り下げた | `withdrawn` (版は `draft` に戻る) | 拒否 | 送ったときの版のまま (`draft` でも `sent` の固定で出す、§6.4) |
| DNC・除外 | 変わらない | DEV-195 のとおり (承認・開くは拒否、`send_opened` からの送信済みだけ記録) | `disabled_at` で即時 404 (今と同じ) |
| 30 日の期限 | 変わらない | — | 404 (今と同じ) |

- **送った後は頁を変えない** (ARCHITECTURE §10.1 の `ALREADY_SENT` と同じ考え)。共有 URL は `sales_outreach_approvals` の `sent` の行の `demo_version_id` が指す版**だけ**を出し、「最新の版」は決して出さない。
- 送信済みの版は、共有の期間の終わりから約 30 日は管理者が見返せるよう残す (オーナー決定 2026-11-10)。その後の削除は別の承認 (DEV-196j)。
- 上の表の「送信承認」の列のうち、`send_opened` の行は §9.5 が優先する (`send_opened` のあいだは hash を変える操作そのものを拒否する)。

### 9.5 `send_opened` のあいだの扱い (DEV-195 の不変条件を壊さない)

`send_opened` は「オーナーが自分のアプリで送ったかもしれない」状態である (DEV-195 PR #239 M2)。ここでデモの版が変わると `sales_mark_sent` が `demo_version` の不一致で拒否され、**実際の送信の事実が記録できず**、相手のリンクも 404 になる。原則 (DEV-195・DEV-197): **実際の送信の事実を失わない。画面の表示と記録を食い違わせない。**

1. **hash を変える管理者の操作は `approval_open` で断る**: 新しい版の品質承認 (`approved_version_id` の差し替え)・版の取り消し・品質承認の取り下げ・その版を使う画像の権利の取り消し。その prospect / demo の承認に `send_opened` が 1 件でもあれば、関数は何も書かずに `approval_open` を返す。画面は「送信画面を開いた送信があります。先に『手動で送信済み』か『取り下げ』を選んでください」と出す。
2. **時間で起きる変化 (権利の期限切れ・版の `expires_at`)** は断れない。`send_opened` からの「送信済み」に限り、§9.2 の版・権利・品質・事実の照合は**拒否せず記録する**: 承認の行に `demo_unavailable_after_open` (`rights_expired` / `version_expired` など、案) を残して `sent` にする (DNC の `blocked_after_open` と同じ型)。共有 URL は配信のたびの再評価で 404 になり、管理画面は「送信済み (デモは非公開: 権利の期限切れ)」と出す。記録と表示は一致する。承認と「送信画面を開く」は従来どおり拒否する (何も緩めない)。
3. **急ぎの取り消し (権利の苦情・安全)** は別の関数 `sales_urgent_revoke_demo_version(version, reason)` (案、管理者だけ) にする:
   - `send_opened` の承認があれば、まずその 1 件ごとにオーナーが決着させる: 実際に送ったなら「手動で送信済み」(上の 2 と同じく `demo_unavailable_after_open = revoked_urgent` を残して `sent`)、送っていないなら DEV-195 の `sales_withdraw_approval` で取り下げ。決着していない `send_opened` が残る間、この関数も `approval_open` で断る (勝手に sent にも withdrawn にもしない)。
   - 決着の後に、同じ transaction で版の `revoked_at` を立て、`approved_version_id` を null にし、品質承認を `invalidated(version_revoked)` にする。送信済みの相手のリンクは 404 になり、管理画面は「送信済み (デモは取り消し済み)」と出す。
   - 画像の権利の急ぎの取り消しも同じ手順 (その画像を使う全版について決着 → 取り消し)。

---

## 10. 自動生成 worker との接続

### 10.1 生成 job の状態

```
queued ─claim─► claimed ─► generating ─► packaged ─upload begin─► uploading ─finalize─► done (版 = draft)
   │              │            │             │                       │           └─► rejected (版 = rejected、符号)
   │              └─ lease 切れ (2 時間) ─► queued (試行が残れば) / failed (3 回目)
   └─ オーナーの取り消し / DNC / 送信済み ─► cancelled
```

- worker は `done` までしか進めない。**品質承認・送信承認は worker からは書けない** (関数の権限で分ける。worker・bridge の経路に管理者の関数は無い)。
- 生成物は必ず `draft` (未承認) の新しい版として入る。今の `approved` の版も、送信済みの承認が固定した版も置き換えない。
- 送信済み・DNC・無効化の demo には job を作らない (既存の `ALREADY_SENT` / `DO_NOT_CONTACT` / `DEMO_DISABLED` と同じ)。

### 10.2 冪等性

- `generation_job_id` は claim ごとの新しい id (unique)。版の `generation_job_id` も unique。
- 同じ job の `begin` の再送は同じ版 (`uploading` のまま) を返し、`put` の同じファイルの再送は sha256 が同じなら `replayed`、違えば拒否。`finalize` の再送は結果を変えない。
- 古い job (lease 切れで回収された) の結果は `job_superseded` で捨てる (既存の design bridge と同じ)。
- 1 つの demo で `uploading` の版は最大 1 つ (partial unique index)。

### 10.3 経路と権限 (WSL に Supabase の鍵を置かない)

```
sr-designgen (jail)  ── 包みを書く ─► /srv/sr-design-bridge/from-worker/artifacts/<ref>/   (今の bind の中。jail の変更なし)
sr-designbridge      ── 読む (link なし・link 数 1・上限・strict schema) ─► POST /api/internal/sales-design/demo-versions
                        Authorization: Bearer <bridge token>  (今の 0600 の file。server は SHA-256 だけ)
   begin    {jobId, manifest}       → 1 回限りの受け入れの承認を消費し、版の行 (uploading) と 15 分のアップロード token を返す
   put      {versionId, path} + body → manifest に無い名前・二度目・hash や大きさの不一致は拒否。server が service role で Storage に書く
   finalize {versionId}             → §7.1 の server の検査 → draft / rejected
```

| 誰が | 持つもの |
|---|---|
| jail の worker | 新しいものは無い。ファイルを書くだけ。偽れるのは自分の包みだけで、server が検め直す |
| bridge | 今の bridge token と、版ごとの 15 分のアップロード token (メモリだけ) |
| server | bridge token の SHA-256、service role key (server only)、アップロード token の SHA-256、view token の署名鍵 |
| root | 新しいものは無い。cycle がアップロードの段を動かすかどうかだけ (root の conf) |

- API は狭い: 版の受け入れだけ。prospect・outreach・DNC・送信・品質承認には触れない。別の旗 (`SALES_DEMO_VERSIONS_ENABLED`、無効なら 503) で、既存の `jobs` の API とは別の route にする。
- 本文は 1 ファイル ≤ 4MiB (正規化の後)。

### 10.4 承認 (grant)

- 生成 (Codex・画像生成) の承認は、既存の画像の無人実行の考え方 (root の境界で 1 回限り・最大 24 時間・店と job を固定) を使う。**画像生成は 1 回ごとにオーナーの承認が要る**。この仕様は承認を付与しない。
- 受け入れの承認 (この job の成果物を、この店舗の版として受け取る) も 1 回限り・最大 24 時間。管理画面のボタンか、bridge の claim の時点で job に結び付けて作る。

---

## 11. 安全 — 脅威モデル

### 11.1 脅威 → 対策 → テスト

| # | 脅威 | 対策 | テスト (実装の段で) |
|---|---|---|---|
| T1 | 成果物の HTML に入ったスクリプトが管理者のセッション (HttpOnly でない cookie) を盗む | server の finalize で `<script>`・`on*`・`javascript:` を拒否 / CSP `script-src 'none'` + `sandbox` / iframe `sandbox=""` / route は cookie を読まない / 共有の成果物は cookie の無い専用の別 origin から配る (§6.8、オーナー決定 2026-11-10) | e2e: `<script>` 入りの fixture は finalize で `rejected`。検査をわざと飛ばした fixture でも実行されない (CSP)。iframe の中で `document.cookie` が読めない (opaque origin) |
| T2 | 二つの HTML 解析器の差 (parse5 と Chromium) を突いた要素の密輸 | 同じ規則の核・差分テスト・CSP の後ろ盾・(任意) 再直列化 | unit: 研究の fidelity 頁は両方で通り、XSS の corpus は両方で落ちる |
| T3 | 成果物から第三者・外部への通信 (追跡・情報の持ち出し) | 外部 URL・`@import`・`@font-face`・外への `url()` を拒否 / CSP `default-src 'none'`・`connect-src 'none'`・`img-src` と `style-src` を token の path に固定 / `Referrer-Policy: no-referrer` | e2e: Playwright で全要求を記録し、自分の route 以外が 0 件。CSP ヘッダの golden |
| T4 | 公開 bucket・署名付き URL の漏れで、取り消せない閲覧が残る | 非公開 bucket・policy なし・署名付き URL を出さない・server の route だけが読む | 統合: bucket が `public=false`、anon / authenticated で object を読めない。応答に Storage の URL が無い |
| T5 | 共有 URL で未承認の版・ほかの版・最新の版が見える | scope `p` は送信済みの承認が固定した版だけ / 毎回 DB で確認 | e2e: 新しい版を承認しても、送信済みの相手には古い版。未送信の demo は 404 |
| T6 | 権利の無い画像 (AI 画像・未確認の写真) が相手に出る | `rights_status` の enum・fail closed・配信のたびの再評価・AI 画像は共有不可 (DB の check と `checkPhotoRights`) | unit: 権利の導出の表。e2e: AI 画像入りの版は送信承認で `demo_not_shareable`、共有 route は 404 |
| T7 | view token の推測・使い回し・scope の取り違え | HMAC (32 bytes 以上の鍵)・短い期限・scope を payload と path の両方で照合・定数時間の比較 | unit: 改ざん・期限切れ・scope 違いは 404。鍵の rotate で全 token が無効 |
| T8 | 取り消し・DNC・期限切れの後も見える | 要求ごとに DB で確認・`no-store` | e2e: 取り消し・`disabled_at`・期限切れの直後の要求は 404 |
| T9 | worker / jail が偽の包み (別の店の版・権利の偽装・巨大なファイル) を出す | job id で demo を特定・1 回限りの承認・server の再ハッシュと再検査・権利は server が `checkPhotoRights` で導く・大きさの上限 | unit / 統合: 別の demo の job、manifest に無いファイル、hash の不一致、上限超え、未知の key は拒否 |
| T10 | 型の取り違え (画像のふりをした HTML、SVG のスクリプト) | magic bytes の確認・manifest の `Content-Type`・`nosniff`・SVG ファイルを受けない | unit: 拡張子と中身の不一致は拒否。e2e: `nosniff` |
| T11 | path traversal・Storage の key の注入 | URL の path は key にしない。manifest の名前と完全一致だけ | unit: `..`・符号化・query・未登録の名前は 404 |
| T12 | 検索エンジンへの露出・Referer からの token 漏れ | `X-Robots-Tag: noindex, nofollow, noarchive`・外枠の meta noindex・`Referrer-Policy: no-referrer`・iframe `referrerpolicy` | e2e: ヘッダの golden |
| T13 | clickjacking (管理画面が他のサイトに埋め込まれる) | 外枠は今の `X-Frame-Options: DENY`・`frame-ancestors 'none'`。成果物は `frame-ancestors <アプリの origin>` (§6.8) | e2e: `/admin/*` は DENY のまま、`/demo-frame/*` に `X-Frame-Options` が無く、`frame-ancestors` がアプリの origin だけ |
| T14 | 店舗の事実の捏造 (AI の文・画像) | 事実パックとの照合・copy record・Identity Lock・実店舗に AI 画像を出さない | unit: 事実パックに無い文は `UNVERIFIED_COPY`。オーナーの確認項目 1・2・6 |
| T15 | 成功例の写し (画像・構造) | 禁止の hash の集合・`TOO_CLOSE_TO_REFERENCE` の印 | unit: 成功例の画像は `FORBIDDEN_SOURCE_HASH` |
| T16 | 匿名の要求で DB への書き込みや費用が増える (DoS) | 共有の view token は HMAC で DB に書かない・応答は小さく (正規化)・Vercel の既存の保護 | 負荷は手動確認。統合: 共有の外枠を開いても DB の行が増えない |
| T17 | 出所・モデル名・同意の参照がリポジトリや公開側に漏れる | DB の管理者だけの列・strict schema・`toPublicPhotoRecord`・secret の検査 | unit: 包みの schema が private の key を表現できない。`npm run check:secrets` |
| T18 | 品質承認を飛ばした送信・期限の切れた権利での送信 | 送信承認の DB の照合で版・品質・事実・権利 (期限を含む) を毎回導き直す (§9.2)・`sales_demo_version` の拡張・取り消しで `approved_version_id` を null に | 統合: 未承認の版・取り消した版・権利の取り消し・**日付を進めて権利の期限が切れた**版・事実の変わった版で `sales_approve_outreach` / `sales_mark_send_opened` が拒否 |
| T19 | 管理者用 view token (scope `a`) は cookie の無い **bearer URL** で、漏れると未承認の下書き (AI 画像を含む) が 15 分見える | **受け入れるリスク**として記録。対策: 15 分の短い期限、1 つの版 (1 店舗) だけ、管理者の頁でだけ発行、URL を log に出さない (route は token を記録せず、エラーにも出さない)、`Referrer-Policy: no-referrer`、`no-store`、版の取り消しと鍵の rotate で止められる、共有用 (`p`) とは scope で分離 | unit: 期限切れ・別の版・scope `p` の route では 404。log の検査: token が出力されない |
| T20 | `send_opened` のあいだに版が変わり、実際の送信が記録できない | hash を変える操作は `approval_open` で拒否、時間による変化は記録して送信済みに、急ぎの取り消しは先に決着 (§9.5) | 統合: `send_opened` の間の新しい版の承認・取り消し・取り下げは `approval_open`。権利の期限切れ後も `sales_mark_sent` は `demo_unavailable_after_open` を残して成功し、共有 URL は 404 |
| T21 | 実店舗の AI 概念画像が、実在の商品・店内・人・設備の事実として受け取られる (オーナー・将来の相手) | `ai_concept_internal` は管理者だけ・共有不可 (DB の check)・画像ごとの AI ラベルを外枠が出す・`depicts_real_*` が 1 つでも true なら拒否・オーナーの「事実の偽装なし」の確認・出所と許可の記録が無ければ `unknown` (§8.3) | unit: 権利の導出 (`depicts_real_*`・記録の欠け → 不可)。e2e: 管理者プレビューにラベルが出る、AI 概念画像を含む版は送信承認で `demo_not_shareable`、共有 route は 404 |
| T22 | 送信済みの版を取り消した後に、別の版や React のデモが相手に出る (送った頁と違う頁) | 共有 URL は `sent` の承認が固定した版だけを出し、取り消されたら 404。自動の切り替えをしない (§9.4、オーナー決定 2026-11-10) | e2e: 送信済みの版を取り消すと `/demo/[publicToken]` の枠も成果物も 404 (React のデモに落ちない)。別の版を承認しても相手には出ない |
| T23 | 共有の成果物が別 origin の設定の前にアプリの origin から配られる | scope `p` は `<artifact-origin>` が設定されていなければ 404 (fail closed、§6.8) | unit / e2e: 別 origin の設定が無いとき `/demo-frame/p/…` は 404 |

### 11.2 noindex の方針

- 外枠: 今のまま (`robots` の meta noindex,nofollow,nocache + `X-Robots-Tag`)。
- 成果物: `X-Robots-Tag: noindex, nofollow, noarchive`。成果物の HTML に `<meta name="robots">` が無くてもヘッダで効く。
- `robots.txt` で `/demo-frame/` を拒否することは**しない** (拒否するとヘッダの noindex をクローラーが読めなくなる)。

### 11.3 費用の目安 (現在の料金表で確かめること)

- 正規化した後の 1 版 ≈ 3〜5MB (描画画像を含む)、1 回の閲覧 ≈ PC 0.8〜1.5MB・SP 0.5〜0.9MB (`<picture>` が 1 つの range だけ読む)。正規化しなければ ≈ 20 倍で、1 応答が Vercel の上限を超える。**正規化は必須**。
- 5 版/日・60 日の保持で ≈ 1〜1.5GB (Supabase Free の Storage の上限付近)。転送 ≈ 1GB/月。Storage の plan の確認はオーナーの判断 (§12)。
- Vercel: 1 閲覧 ≈ 8 回の関数の呼び出し。月に数千回で、含まれる量に比べて小さい。商用利用できる plan かの確認も要る。

---

## 12. 段階の実装計画 (小さな PR に分ける)

**オーナー決定 2026-11-10 で承認されたのは DEV-196a (仕様の文書だけ) と DEV-196b (offline の純粋なライブラリだけ) である。DEV-196c 以降は、まだ承認されていない。** 各段は前の段の merge の後に、記した承認を得てから始める。
既存の承認 (DEV-030 の forward schema、DEV-186〜193 の画像の 1 回限りの実行、DEV-195 の開発) は、この計画の段を承認しない。

| 段 | 内容 | 実行時の影響 | 必要なオーナーの承認 | 状態 |
|---|---|---|---|---|
| **DEV-196** (この PR) | 仕様と安全設計 (docs だけ) | なし | PR のレビューと merge | review |
| DEV-196a | 仕様の文書の更新だけ: MVP_SPEC §7 / §11.1・ARCHITECTURE・SECURITY に版のデモの規則と §15 の決定を書く (実店舗の AI 概念画像は管理者だけ・共有不可、別 origin の採用、保持と token、取り消しで 404)。共有 URL に写真を出す (`PUBLIC_DEMO_ASSETS_ENABLED`) かどうかは、AI 画像の共有と同じく今は変えない | なし | 承認済み (オーナー決定 2026-11-10、仕様の文書だけ)。PR のレビューと merge は別 | **承認済み (文書だけ)** |
| DEV-196b | 純粋なライブラリ (offline だけ): manifest の schema と正規化 hash、規則の核の切り出しと server の HTML 解析器、CSP の組み立て、HMAC の view token、権利の導出 (`ai_concept_internal` は §8.3.1 の別の検査、`checkPhotoRights` は変えない)、事実の照合、構造記述子の警告 | なし (呼ぶ側が無い) | 承認済み (オーナー決定 2026-11-10)。依存は**最小限**で、追加の前に候補の安全性 (保守の状況・推移的な依存・既知の advisory・`npm audit`) と版 (2 週間以上前の固定の版) を確かめ、レビュー記録に残す | **承認済み (offline だけ)** |
| DEV-196c | migration (ローカルだけ): §4 の表・関数・RLS・trigger・bucket、`supabase/config.toml` の Storage を有効 | 適用するまで無し | **DB 変更の作成**。Storage の有効化 (ローカル・CI の Supabase) | 未承認 |
| DEV-196d | server (旗は既定で無効): アップロードの API、`/demo-frame/a/…` の route (別 origin の設定が無い間は管理者の暫定、§6.8)、`/admin/sales/demos/[prospectId]` (版の一覧・系譜・PC1440 / SP390・品質承認・取り消し) | 旗が無効の間は 404 / 503 | **新しい環境変数** (`SALES_DEMO_VERSIONS_ENABLED`・`SALES_DEMO_VIEW_SIGNING_KEY`・`SALES_DEMO_ARTIFACT_ORIGIN`。値の設定は人) | 未承認 |
| DEV-196e | WSL: photo-swap の配信用の書き出し・包み・bridge のアップロードの mode・cycle の任意の段 | conf の旗を立てるまで無し | **WSL の commit の承認と導入** (`admin.sh approve`、root の conf)。jail・`.wslconfig`・timer は変えない | 未承認 |
| DEV-196f | DEV-195 との結合: 送信承認の列の追加・`sales_send_guards` の照合・`sales_demo_version` の拡張 | 適用するまで無し | **DB 変更** (DEV-195 の表と関数の変更) | 未承認 |
| DEV-196g | 共有 URL: `/demo/[publicToken]` の外枠と `/demo-frame/p/…` (`share_eligible` の版だけ) | 旗 `SALES_DEMO_SHARE_ENABLED` が無効の間は今のまま | **公開 (publishing)**。その前に**専用の別 origin の DNS と Vercel の設定** (採用はオーナー決定 2026-11-10、設定の変更は別の承認) | 未承認 |
| DEV-196h | Staging: DEV-196c / f の migration と bucket の適用、旗を Staging だけ有効、**架空の** prospect (example.com) に SR-001「輪」d1-v9 を 1 回アップロードし、オーナーが PC とスマホで確かめる。AI 写真の扱い: `checkPhotoRights` は `aiDemoAllowed` が無いと `ai_generated_demo` を `AI_DEMO_NOT_ALLOWED` で拒否し、許すのは `photo-swap.ts` の `AI_DEMO_SHOPS` (つぐ手・輪の研究頁) だけ。server の finalize に同じ許可を持ち込むなら、**その 1 つの架空の Staging prospect の id だけ**を server 側の許可一覧に入れ (scope `a` だけ、共有不可は不変)、その追加を別の承認にする。承認が無ければ写真なしの d1-v9 (placeholder の板のまま) を上げる | Staging だけ・管理者だけ | **Staging DB への適用**、**Storage bucket の作成**、Staging の環境変数、WSL のアップロード 1 回、(AI 写真を載せるなら) 架空の prospect 1 件への AI 画像の許可 | 未承認 |
| DEV-196i | 自動生成 worker の接続 (§10): job の表・claim・lease・受け入れの承認。実店舗の AI 概念画像 (管理者だけ、§8.3) の生成もここから | 旗が無効の間は無し | **画像生成 (1 回ごと)**、Codex の実行、worker の常時運転 (timer) | 未承認 |
| DEV-196j | 保持期限 (未送信は約 60 日、送信済みは共有の期間の後 約 30 日) を過ぎた版の掃除 (管理者の操作。timer にしない)・使用量の表示 | — | **復元できないデータの削除** (Storage の object)。期限の後の削除は別の承認 (オーナー決定 2026-11-10) | 未承認 |
| (後) | Production への適用・共有の開始 | 本番 | **Production の DB・Storage・環境変数・公開** (それぞれ別の承認) | 未承認 |

## 13. テストの方針

| 層 | 何を | どこで |
|---|---|---|
| unit (vitest) | manifest の schema と正規化 hash、規則の核 (fidelity 頁は通る・XSS の corpus は落ちる・二つの解析器の差分)、CSP の golden、view token (改ざん・期限・scope)、権利の導出の表 (`unknown` → 不可、AI → 共有不可)、事実の照合、構造記述子の近さの計算、包みの schema が private の key を表現できないこと | CI (Chromium の差分テストは既存の browser の job) |
| 統合 (ローカル Supabase、Storage 有効) | RLS と権限 (`db-security-audit.test.ts` を拡張)、関数の権限 (worker の経路から品質承認・送信承認を書けない)、1 回限りの承認と token、版の不変性、bucket が非公開、送信承認の照合 (未承認・取り消し・権利の変化・事実の変化で拒否)、`sales_demo_version` が版の無い demo で今と同じ hash | CI |
| e2e (Playwright、build の後) | 管理者プレビューの iframe が opaque origin で `document.cookie` を読めない、スクリプトが動かない、画像が sandbox の中で出る、外部への要求 0 件、取り消し・期限切れ・DNC で 404、共有 URL は送信済みの版だけ、`/admin/*` の DENY は不変、PC1440 / SP390 の表示 | CI |
| 手動 | Staging での 1 回 (DEV-196h)、オーナーのスマホと PC での目視 | オーナー |

テストを削除・skip・`only` にしない。CI の必須の検査を外さない。テストのデータは `example.com` と架空の店だけ (SECURITY §8)。

## 14. オーナーへの問い

### オーナー決定 2026-11-10 で答えが出たもの

| 問い | 決定 | 反映した節 |
|---|---|---|
| Q1 実店舗の AI 画像 | 管理者だけのデザイン検討では条件つきで可 (事実の偽装なし・管理画面で AI と明示・出所と許可の記録)。実店舗の prospect への共有は今は不可 (将来は別の仕様変更と承認)。架空の店の研究は今までどおり | §4.3・§8.1・§8.3・T21 |
| Q2 別 origin | 共有の成果物に専用の別 origin を採用。権限・cookie・CSP の境界を管理者プレビューも含めて定義。DNS と Vercel の設定は今は変えない (後の承認) | §6.7・§6.8・§12 DEV-196g・T1・T13・T23 |
| Q3 版の無い店舗の送信 | 既存の React のデモで一時的に送ってよい。人による内容の確認と送信承認は必須。未承認の版への自動の切り替えと、品質確認の省略は禁止 | §9.2 |
| Q4 保持期限 | 未送信の版は約 60 日、送信済みの版は共有の期間の後 約 30 日 (管理者が見返す)。期限の後の削除は別の承認 | §4.1・§6.6・§9.4・§12 DEV-196j |
| Q5 送信後の取り消し | 共有 URL は 404。ほかの版や React のデモへの自動の切り替えは禁止 | §6.6・§9.4・T22 |
| Q6 view token | HMAC + 要求ごとの DB の取り消しの照合。管理者用 15 分、共有用 30 分、共有 URL は原則 30 日、開き直すたびに短い token を新しく発行 | §6.2・§6.6 |
| Q9 テンプレート化の閾値 | 今は警告だけ。実績が十分に貯まるまで自動では拒否しない | §7.5 |
| Q10 品質承認の確認項目 | PC1440 / SP390 の全頁の描画と 7 項目を採用。「その店舗でなければ成立しない構成」「凡庸な LP への回帰がないこと」「全ページで情報が伝わること」を重視 | §7.2 |

### まだ残る問い

7. **Storage と Vercel の plan**: 版の数と保持 (未送信 60 日 + 送信済み 共有の後 30 日) で Free の上限付近になる。plan の確認・変更 (DEV-196h の前)。
8. **再直列化**: server が検めた HTML を作り直して配るか (安全は上がるが、描画画像とバイト一致しない)。DEV-196b で差分テストの結果を見て決める。
11. **別 origin の名前**: どの sub domain にするか (DEV-196a で案を出し、DNS と Vercel の設定は後の承認)。
12. **実店舗の AI 概念画像の確認の手順**: 「事実の偽装なし」の確認を、画像ごとにオーナーが押す形でよいか (DEV-196a で画面の文言と合わせて決める)。

---

## 15. オーナー決定 (2026-11-10)

オーナーが PR #241 の方向を承認し、次を決めた。この仕様は各節にこれを反映した。

1. **AI 画像**: 実店舗の管理者だけのデザイン検討では、AI 生成の概念画像を条件つきで使ってよい — (a) 実在の商品・店内・人・設備を事実として見せない (事実の偽装なし)、(b) 管理画面で AI 生成と明示する、(c) 出所と利用の許可を記録する。実店舗の prospect への AI 画像の共有は今は認めない (将来は別の仕様変更と承認)。架空の店の研究 (SR-001「輪」など) は今までどおり。→ §4.3・§8.1・§8.3
2. **安全**: 共有の成果物に専用の別 origin を採用する。権限・cookie・CSP の境界を、管理者プレビューも含めて明確にする。DNS と Vercel の設定は今は変えない (後の承認)。非公開の Storage・sandbox・スクリプト無効・要求ごとの認可は保つ。→ §6.7・§6.8
3. **承認済みの版が無い店舗**: 既存の React のデモを一時的に使ってよいが、人による内容の確認と送信承認は必須。未承認の新しい版へ自動で切り替えない。品質確認を飛ばさない。→ §9.2
4. **取り消し**: 送信済みの版を取り消したら共有 URL は 404。ほかの版や React のデモへの自動の切り替えは禁止。→ §6.6・§9.4
5. **保持と token**: 未送信の版は約 60 日、送信済みの版は共有の期間の後 約 30 日、管理者が見返せるよう残す。期限の後の削除は別の承認。管理者用 token 15 分、共有の成果物の token 30 分、共有 URL は原則 30 日。共有 URL を開き直すと短い token を新しくする。HMAC の token + 要求ごとの DB の取り消しの照合を採用。→ §4.1・§6.2・§6.6
6. **デザイン品質**: PC1440 / SP390 の全頁の描画と 7 項目の品質確認を採用。「その店舗でなければ成立しない構成」「凡庸な LP への回帰がないこと」「全ページで情報が伝わること」を重視。類似の閾値は今は警告だけで、実績が十分に貯まるまで自動では拒否しない。→ §7.2・§7.5
7. **次の段**: DEV-196a は仕様の更新だけ (MVP_SPEC など)。DEV-196b は offline の純粋なライブラリだけで、依存は候補の安全性と版を確かめたうえで最小限。DEV-196c 以降 (DB migration・Storage の作成・Staging の環境の変更・画像生成・公開・Production) は**未承認のまま**。→ §12

---

## 付録: 要求 7 項目との対応

| 要求 | 節 |
|---|---|
| 1. 版と系譜、DEV-195 の snapshot との結び付け | §4.1・§4.6・§9.2・§9.3 |
| 2. 店らしさ、テンプレート化の防止、PC1440 / SP390 | §7.2・§7.5・§7.6 |
| 3. 管理者プレビューと共有 URL の分離 | §6.1〜§6.4 |
| 4. 非公開 Storage・期限・取り消し・スクリプト無効・CSP・sandbox・別 origin・第三者通信なし・noindex・脅威モデル | §5・§6.5〜§6.8・§11 |
| 5. 自動生成 worker (状態・冪等性・未承認の下書き) | §10 |
| 6. AI 画像の権利・出所 (DB)・実店舗での可否、enum と fail closed | §8 |
| 7. 品質承認と送信承認の分離、無効になる条件 | §4.4・§9 |
