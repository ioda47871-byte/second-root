# Staging で営業 MVP を1店舗ぶん確かめる最短手順 (Issue #263)

2026-11-19。`sales-mvp-runbook.md` の B (Staging / Production) を、**Staging で1店舗を通すため**の順に並べ直した確認表。
新しい仕組みは足さない。各段の中身・rollback は runbook と `docs/STAGING.md` が正本で、ここはその順番と事前確認だけ。
**どの段もまだ実施していない。🛑 の段はすべてオーナーの承認が先。** Production は Staging が通った後に別に判断する。

## 0. 2026-11-19 の読み取り結果 (何も変えていない)

| 項目 | 状態 | 根拠 |
|---|---|---|
| Staging のアプリ | Vercel の Preview、`develop` branch。develop の最新 (`31f09ce9`) が READY | Vercel API (読み取り) |
| Staging の Preview の環境変数 | 既存の 7 つ (Supabase URL / anon / service role、ingest token、demo base URL、設計の旗2つ) だけ。runbook B-4 の `SALES_DEMO_*` 6 つは**どの環境にも無い** | Vercel API (名前だけ。値は読んでいない) |
| Deployment Protection | `all_except_custom_domains`: Preview の `*.vercel.app` は **Vercel のログインが要る**。automation bypass はある。ログインが要らないと repo で確かめてあるのは Production の `secondroot.jp` だけ (develop に割り当てた独自ドメインがどうなるかは未確認) | Vercel API、`docs/operations/design-bridge-access.md` |
| 独自ドメイン | `secondroot.jp` / `www.secondroot.jp` / `second-root.vercel.app` (Production) だけ。成果物 origin の domain は無い | Vercel API |
| Staging の DB の migration・Storage | **読めなかった**: Supabase 管理 API が 401 (`Invalid access token`) | 下の §1 |

## 1. 🛑 Supabase の token を作り直す (人)

401 の原因: environment に入っている `api.supabase.com` の credential が、もう有効でない token
(`docs/STAGING.md` §2 は「scoped PAT・有効期限は短く (例 7 日)・作業後に Revoke」と決めている。2026-09-28 に作った token は期限切れか取り消し済みと考えられる)。

- Supabase Dashboard → Account → Access Tokens で、**project `second-root` だけ**の scoped PAT を短い期限で作る (権限は `docs/STAGING.md` §2 の表)。
- Claude Code の environment の network secret `api.supabase.com` (header `Authorization: Bearer …`) を新しい値で置き換える。**値をチャット・GitHub に貼らない。**
- 確認 (Claude、読み取りだけ): `npm run staging:apply -- --project-ref <ref>` (plan だけ。適用しない)。未適用の migration・drift が出る。

## 2. migration 9本の事前確認 (Claude、読み取り)

- 依存: 9本は `20261111000000` → `20261117000000` の順で、それぞれ前の段の表・関数を前提にする (runbook B-1 の順以外で当てない)。
  ローカルでは空の DB に全 migration を順に当てて通り、営業 MVP の E2E (メール・Instagram) が 2/2 通る (2026-11-19、develop `31f09ce9`)。
- `staging:apply` の plan で、Staging が `20261110000000` まで当たっていて drift が無いことを見る。drift があれば止める (スクリプトも止まる)。
- 当てる前のアプリ (旗 off) は、版の列が無くても React のデモとして動く (runbook B-1)。順番は「migration → 旗」。

## 3. 🛑 バックアップ (人、適用の直前)

- Supabase Dashboard → Database → Backups で、直近のバックアップの日時を確かめる (plan によって PITR の有無が違う)。
- 加えて手元に schema とデータの dump を取る (repo の外、Git に入れない): `npx supabase db dump --db-url "<Staging の接続文字列>" -f <置き場>/staging-before-b1.sql` と、同じく `--data-only` を付けたもの。
  - CLI は Docker を使う。`--db-url` は percent-encode した接続文字列。**接続文字列には DB のパスワードが入るので、Claude にもチャットにも渡さず、人の端末だけで実行する。**
  - 既定の dump には `auth`・`storage` の schema が入らない (このB-1は `public` と bucket だけを変える)。
- rollback は migration ごとに runbook B-7 (forward-only のものがある)。dump は最後の手段。

## 4. 🛑 適用 (Claude が実行。オーナーの承認の後)

1. `npm run staging:apply -- --project-ref <ref> --confirm-ref <ref> --apply` — 9本を順に当てる。1本でも失敗すればその1本は transaction ごと戻り、そこで止まる。その後 security の照合が走る。
2. `notify pgrst, 'reload schema';` (DB の所有者)。
3. private bucket `sales-demo-versions` を作る (public でない、4MiB、MIME 4 種。runbook B-5a)。storage policy は作らない。
4. `npm run staging:verify -- --project-ref <ref>` — 照合 (`demo_version_sharing_disabled` を含む) が通ること。
5. 読み取りで、hosted で off のままにするスイッチ2つを確かめる (今の照合は見ていない):
   `select local_test_recipients_enabled from public.sales_local_test_settings;` と
   `select operator_cli_enabled from public.sales_facts_registration_settings;` — どちらも `false`。`true` なら止める。

## 5. 🛑 Staging で共有 URL まで確かめるかを決める (オーナーの選択)

Staging の Preview は Vercel のログインの内側なので、**受信者役のブラウザ (cookie なし) は今のままでは共有 URL を開けない**。成果物 origin もアプリ origin と別の host が要る (runbook B-3)。

- (a) Staging 用の独自のサブドメインを2つ (例 `staging.<domain>` をアプリ、`staging-art.<domain>` を成果物) DNS に作り、Vercel で `develop` branch に割り当てる。
  **develop に割り当てた独自ドメインにログインが要るかは未確認。** 割り当てた後、cookie なしの要求が `vercel.com/sso-api` へ転送されないことを確かめる。転送されるなら**そこで止めてオーナーに報告する** (Deployment Protection を緩めて通す近道は取らない)。
- (b) DNS を作らない。Staging では版の取り込み・プレビュー・承認の画面までを確かめ、共有 URL の外部表示はローカルの E2E に任せる。**(b) では Staging から実店舗に送らない**。外部表示と最初の送信は Production の段で、別の承認のもとで行う。

## 6. 🛑 Preview (develop) の環境変数 (runbook B-4)

Environment は Preview・Branch は `develop` だけ。設定後に develop を再デプロイ (`/demo/*` の `frame-src` は build 時に読む)。

- (a)・(b) 共通: `SALES_DEMO_VERSIONS_ENABLED=true`、`SALES_DEMO_QUALITY_REVIEW_ENABLED=true`。
- (a) だけ: `SALES_DEMO_SHARE_ENABLED=true`、`SALES_DEMO_VIEW_SIGNING_KEY` (Staging 専用の新しい値)、`SALES_DEMO_ARTIFACT_ORIGIN` / `SALES_DEMO_APP_ORIGIN` / `SALES_DEMO_BASE_URL` を §5 の host に。
- (b) では `SALES_DEMO_SHARE_ENABLED`・`SALES_DEMO_ARTIFACT_ORIGIN`・`SALES_DEMO_APP_ORIGIN` を**置かない** (共有は off のまま)。

## 7. 🛑 Staging での通し

1. **prospect**: hosted の prospect は ingest からしか入らず、Staging にあるのは実店舗の prospect。**実店舗の prospect に架空の facts pack を付けない。**
   架空店で通すなら、オーナーの承認のうえで、架空店 環 の固定の id (`lib/demo-version-package/seed-sendable.ts`) の prospect 1行を DB の所有者が SQL で入れる (入れる SQL と消す SQL を承認の時に示す)。承認が無ければ架空店の通しは省き、ローカルの E2E に任せる。
2. **架空店**: 管理画面で facts の登録 → 「版を取り込む」→ PC 1440 / SP 390 のプレビュー → 品質・文章の承認 → 送信承認が `test_recipient_fictional_shop` で**拒否される**ことを確かめる。
   テスト宛先の guard は hosted では off のまま (on にしない)。共有 URL は送信承認 → 送信済みの後にしか外へ開かない (ローカルの E2E が固定) ので、**架空店では共有 URL の外部表示まで進まない**。それが正しい動き。
3. **共有スイッチ (runbook B-5)**: (a) を選び、最初の実店舗の版を共有する直前にだけ on にする (`update public.sales_demo_share_settings set versioned_sharing_enabled = true;` と、`scripts/staging/lib.mjs` の照合を on 用に変える小 PR を同時に)。(b) では on にしない。
4. **実店舗**: facts の確認・DNC/重複の確認・デモと文章の承認が揃ってから (runbook B-6)。**Staging で実店舗へ送るかは、(a) を選んだうえでのオーナーの判断** (既定は Production の段で送る)。送信は人が手で行い、そのたびにオーナーの承認。

## 8. 片付け

- Supabase の token は作業後に Revoke (`docs/STAGING.md` §2)。
- §7.1 で架空店の prospect を入れたなら、承認時に示した SQL で、その prospect と、そこから作られたデモ・版・facts の行を消す (Storage の版のファイルも)。実店舗の行には触れない。
- 版にならなかった `staging/` の一時ファイルは残る (配られない。runbook B-5a)。
