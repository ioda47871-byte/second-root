# 営業 MVP の運用手順 (Issue #263 の 5)

デモの版 → 品質承認 → 文章の承認 → 送信承認 → 共有 URL → 送信済み → 返信・商談、の流れを
(A) ローカルで試す手順と、(B) Staging / Production に出すときの計画に分けて書く。

**(B) はどれもオーナーの承認が要る。** この文書は計画であって、承認ではない。
`🛑 承認` の印のところで止まり、オーナーの承認を受けてから次へ進む。

E2E で同じ流れを通すテストは `tests/e2e/sales-mvp-flow.spec.ts` (DEV-263e)。

---

## A. ローカルで試す (架空の店 環、写真なし)

ローカルの Supabase だけを使う。実在の店・実送信・hosted の DB は使わない。

### A-1. 起動

```bash
df -h /                                   # 空きを確認 (stack とビルドで数 GB)
npx supabase start                        # ローカルの stack (Storage を含む。-x storage-api は付けない)
npx supabase status -o env                # URL と鍵を表示 (repo には書かない)
```

`.env.local` (git に入れない) に、`supabase status` の値と、次の旗を書く。
**旗はローカルの `.env.local` だけ**。デプロイ先には書かない。

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<status の ANON_KEY>
SUPABASE_SERVICE_ROLE_KEY=<status の SERVICE_ROLE_KEY>
SALES_DEMO_VERSIONS_ENABLED=true
SALES_DEMO_QUALITY_REVIEW_ENABLED=true
SALES_DEMO_SHARE_ENABLED=true
SALES_DEMO_VIEW_SIGNING_KEY=<openssl rand -base64 32 で作った値。ローカル専用>
SALES_DEMO_APP_ORIGIN=http://127.0.0.1:3000
SALES_DEMO_ARTIFACT_ORIGIN=http://localhost:3000
SALES_DEMO_BASE_URL=http://127.0.0.1:3000
SALES_LOCAL_E2E_TEST_RECIPIENTS=true      # 架空の店・example.com 宛を承認できるようにする。ローカルの Supabase のときだけ効く
```

- アプリの origin (`127.0.0.1`) と成果物の origin (`localhost`) は、同じサーバーを別の host 名で開くことで分けている (ブラウザーには別の origin)。
- `SALES_LOCAL_E2E_TEST_RECIPIENTS` は Supabase の URL が loopback (localhost / 127.x / ::1) のときだけ効く。hosted の URL では、値があっても架空の店・予約済みのドメインへの送信承認は止まる。

### A-2. 環 を登録して、版を取り込む

1 の管理者 (ローカルだけ。既にあれば不要。`API_URL`・`SERVICE_ROLE_KEY` は `npx supabase status -o env` の値):

```bash
ADMIN_EMAIL=owner-local@test.example.com; ADMIN_PW="$(openssl rand -base64 18)"
ADMIN_ID=$(curl -sS -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\",\"email_confirm\":true}" \
  | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["id"])')
psql "$(npx supabase status -o json | jq -r .DB_URL)" -c "insert into public.sales_admins (user_id) values ('$ADMIN_ID')"
echo "$ADMIN_PW"                                  # この端末に出るだけ。どこにも書かない
```

```bash
# 1. 管理者を作る (上)
# 2. 候補: 環 (架空の店、固定の id 5e2d0a63-7c1b-4f0e-9a6d-263a00000001)
npx tsx scripts/sales/demo-version/import-local.ts --seed-sendable --seed-only
# 3. v2 の包み (頁 + 文章 + 監査)。出力先は repo の外
npx tsx scripts/sales/demo-version/package-local.ts --out /tmp/tamaki-pkg \
  --copy design-library/research/quality-pipeline/poc/sendable-tamaki/page \
  --facts design-library/research/quality-pipeline/poc/sendable-tamaki/facts-pack.json
# 4. 取り込み。facts は facts の保存先 (sales_demo_facts_packs) から (DEV-263f)。どちらか 1 つ:
#  (a) 管理画面で facts を登録してから (A-5 の 2 の「店舗の事実の登録」)、保存先で取り込む
npx tsx scripts/sales/demo-version/import-local.ts --package /tmp/tamaki-pkg --seed-sendable --facts-from-store
#  (b) 開発用: コミット済みの facts pack (origin/develop と同じ blob) を管理者として登録してから取り込む。
#      CLI の登録は DB の所有者のローカルのスイッチが要る (既定 off。hosted では off のまま):
psql "$(npx supabase status -o json | jq -r .DB_URL)" -c "update public.sales_facts_registration_settings set operator_cli_enabled = true"
npx tsx scripts/sales/demo-version/import-local.ts --package /tmp/tamaki-pkg --seed-sendable \
  --trusted-facts design-library/research/quality-pipeline/poc/sendable-tamaki/facts-pack.json --admin "$ADMIN_ID"
```

4 の出力の `copy.facts_from_facts_path` が `true` であること ((b) は `facts_registered` も出る)。facts が未登録のまま (a) を流すと `FACTS_STORE_EMPTY` で止まる (何も書かない)。

### A-3. DB の共有スイッチ (ローカル)

```bash
psql "$(npx supabase status -o json | jq -r .DB_URL)" \
  -c "update public.sales_demo_share_settings set versioned_sharing_enabled = true;"
```

環 は架空の店・example.com の宛先なので、DB 側のテスト宛先の guard (DEV-263g) のローカルのスイッチも所有者として on にする (hosted では off のまま):

```bash
psql "$(npx supabase status -o json | jq -r .DB_URL)" \
  -c "update public.sales_local_test_settings set local_test_recipients_enabled = true;"
```

### A-4. 下書きを置く

下書きは本来 worker が作る。ローカルで試すときは、1 件だけ手で入れる:

```sql
insert into public.sales_outreaches (prospect_id, kind, channel, subject, body)
values ('5e2d0a63-7c1b-4f0e-9a6d-263a00000001', 'initial', 'email', 'ホームページのご提案',
        'はじめまして。ホームページのご提案用に、貴店のデモページを作りました。');
```

### A-5. 画面で通す

```bash
npm run build && npm run start            # http://127.0.0.1:3000
```

1. `http://127.0.0.1:3000/admin/login` でログイン。
2. `http://127.0.0.1:3000/admin/sales/demos/5e2d0a63-7c1b-4f0e-9a6d-263a00000001` を開く。
   - (A-2 の 4 (a) のとき、取り込みの前に) 「店舗の事実の登録」に `facts-pack.json` の中身を貼り、**内容を確認** → 事実の一覧を見て **この事実を登録する**。デモの事実がその pack から作られていなければ登録できない。登録は追記のみ。
   - PC 1440 と SP 390 の描画を**最後までスクロール**して見る (タブで切り替え)。
   - 「文章の監査」で facts の経路から (`はい`)・監査は承認候補、であることを確かめる。
3. 品質の 7 項目に「問題なし」を付け、確認のチェックを入れて **品質承認**。
4. 文章の確認で **文章を承認** を選び、「「文章を承認」を記録する」。
5. `http://127.0.0.1:3000/admin/sales` (今日) の 環 のカードで、宛先・文面・共有 URL (`/demo/<token>`) を確かめ、**この内容で送信を承認**。
6. **メールを作成** → メールアプリが開く (宛先は `info@tamaki-demo.example.com`。誰にも届かない予約済みドメイン。**送信ボタンは押さない**)。
7. **手動で送信済みにする**。
8. 別のブラウザー (プライベートウィンドウ) で共有 URL を開く: 承認した版が枠の中に出る。React のデモや新しい版には切り替わらない。
9. 「返信」で 返信あり → 興味あり → 記録する。「商談」で 商談へ。

Instagram の流れは、Instagram のハンドルを持つ候補で 5 の後に **DMを送る** (文面をコピーし、Instagram のプロフィールを開くだけ。人が自分で貼り付けて送る。初回 DM を API で送る機能は無い)。

### A-6. 片付け

```bash
psql ... -c "update public.sales_demo_share_settings set versioned_sharing_enabled = false;"
npx supabase stop
```

E2E (`sales-mvp-flow.spec.ts`) は、前後に 環 (固定の id) を消して作り直す。ローカルで試した 環 の記録も消える。

---

## B. Staging / Production に出す計画 (全部オーナーの承認待ち)

順番に進める。どの段も、前の段が終わってから。**どの段もまだ実施していない。**

### B-1. 🛑 承認: migration を当てる

当てる順 (develop にあるもの、この順だけ):

1. `20261111000000_sales_demo_versions.sql` (DEV-196c: 版・品質の審査・送信の guard)
2. `20261113000000_sales_demo_copy_send_guard.sql` (DEV-199e: 文章の監査と送信の門)
3. `20261114000000_sales_demo_structure_findings.sql` (DEV-196q: 構造の所見)
4. `20261114000100_sales_demo_share_switch.sql` (DEV-196g: DB の共有スイッチ、既定 false)
5. `20261115000000_sales_demo_facts_store.sql` (DEV-263f: facts の保存先と送信時の比べ直し。B-2)
6. `20261115000100_sales_test_recipient_guard.sql` (DEV-263g: DB 側のテスト宛先の guard。B-2)

- Staging で先に当て、`scripts/staging/` の照合を通してから Production。
- 当てた直後の挙動は前と同じ (旗が off、スイッチが false なので、版は出ず React のデモのまま)。
- 当てた後、PostgREST の schema cache を読み直させる (`notify pgrst, 'reload schema';`、DB の所有者)。読み直す前は新しい関数・列が API から見えず、共有の頁は「resolver が無い」(PGRST202) と区別できない。
- **migration を当てる前のアプリ** (旗 off) も動く: 版の列・関係が無いことを示す読み込みの誤り (42703・PGRST200・PGRST204 で `approved_version_id` / `demo_version_id` / `sales_demo_versions` を名指すもの) は「版は存在し得ない」= React のデモとして扱い、送信承認・送信画面を開く操作は DB へ進む (PR #268 H1)。それ以外の読み込みの誤りは、旗 off の間は専用の文言で止まる (fail closed)。
- private の Storage bucket `sales-demo-versions` (public でない) が要る。無ければ migration の承認と一緒に作る (🛑 承認)。

### B-2. 🛑 承認: 未完了の安全装置 (実店舗に送る前に必須)

実在の店に送る前に、次の 3 つを入れる。どれも migration が要る:

- **hosted の facts の保存先** (DEV-263f、ローカルで実装済み・hosted は未適用): `sales_demo_facts_packs` (追記のみ)。書けるのはオーナーだけ (管理画面の「店舗の事実の登録」= `sales_register_facts_pack`、または CLI の `--trusted-facts … --admin <管理者>` = `sales_register_facts_pack_as`)。デモの `content.facts_pack_sha256` / `content.facts_pack` がその pack を名指すときだけ登録できる。取り込みは保存先から (`--facts-from-store`)。
- **送信時の facts の比べ直し** (DEV-263f、同上): `sales_copy_send_block` と `lib/sales/copy-review/gate.ts` の両方で、文章の監査の facts pack が prospect の今の facts pack (最新の行、この demo のもの、demo の content が名指す) と同じでなければ `demo_copy_facts_changed` で止める。保存先より前の照合の証拠は数えない。
  - hosted に当てるとき: 上の B-1 の 5。当てると**既存の照合の証拠は数えなくなる**ので、版の送信は `demo_copy_facts_not_from_facts_path` で止まる。店ごとに facts を管理画面で登録し、同じ包みを取り込み直す (replay で既存の証拠に保存先の行が入る)。CLI の登録のスイッチ (`sales_facts_registration_settings`) は hosted では off のまま。サーバーのコードと同時に出す (片方だけなら fail closed)。rollback は `.ai/reviews/DEV-263f.md`。
  - まだ無いもの: 実店舗の demo の content を facts pack から作る経路 (今は 環 の seed だけ)。最初の実店舗の前に別 Task。
- **DB 側のテスト宛先の guard** (DEV-263g、ローカルで実装済み・hosted は未適用): 送信承認 (`sales_approve_outreach`) と送信画面を開く操作 (`sales_send_guards`) が、架空の店 (`content.facts_pack` が `fictional-…`) と予約済みのドメイン (example.com/.net/.org、`*.example`・`*.test`・`*.invalid`・`*.localhost`) を拒否する (`test_recipient_fictional_shop` / `test_recipient_reserved_domain`)。サーバーの門 `lib/sales/test-recipient.ts` はその前にそのまま。
  - DB の所有者だけのスイッチ `sales_local_test_settings.local_test_recipients_enabled` (既定 false) が on の間だけ通す。**hosted では off のまま** (on にしない)。ローカルの統合テストと e2e は setup で所有者として on にし、終わると off に戻す。
  - ローカルで 環 を画面で通すとき (A-5) は、所有者として on にする: `psql "$(npx supabase status -o json | jq -r .DB_URL)" -c "update public.sales_local_test_settings set local_test_recipients_enabled = true"`。
  - rollback は `.ai/reviews/DEV-263g.md`。

### B-3. 🛑 承認: 成果物の origin (DNS / Vercel)

- 成果物用の sub domain (例 `https://demo-art.<domain>`) の DNS を作り、同じ Vercel project に domain を足す。
- アプリの origin と別であること。cookie は host-only のまま (Domain 属性を付けない)。
- 成果物の route (`/demo-frame/p/...`) は、要求の host が `SALES_DEMO_ARTIFACT_ORIGIN` のときだけ配る (アプリの host では 404。実装済み)。
- 逆向きの host の制限 (DEV-196g、`proxy.ts` + `lib/sales/artifact-host.ts`): 成果物の host では `/demo-frame/p/*` 以外 (`/admin`・`/demo/*`・API) は 404。`favicon.ico`・`robots.txt`・`sitemap.xml` や拡張子付きの静的ファイルの path も、成果物の host では 404 (proxy の matcher は広いまま。アプリの host で静的ファイルの session の処理を飛ばすだけ)。domain を足した後、成果物の host で `/admin` が 404 になることを確かめる。

### B-4. 🛑 承認: 環境変数 (Vercel、server だけ)

| 変数 | 値 |
| --- | --- |
| `SALES_DEMO_VERSIONS_ENABLED` | `true` |
| `SALES_DEMO_QUALITY_REVIEW_ENABLED` | `true` |
| `SALES_DEMO_SHARE_ENABLED` | `true` |
| `SALES_DEMO_VIEW_SIGNING_KEY` | 新しく作る 32 bytes 以上 (Staging と Production で別。ローカルの値を使わない) |
| `SALES_DEMO_ARTIFACT_ORIGIN` | `https://<成果物の sub domain>` |
| `SALES_DEMO_APP_ORIGIN` | `https://<アプリの origin>` |
| `SALES_DEMO_BASE_URL` | 共有 URL の origin (アプリの origin) |

- `SALES_LOCAL_E2E_TEST_RECIPIENTS` は**設定しない** (hosted では効かないが、置かない)。
- `next.config.ts` の `/demo/*` の `frame-src` は build 時に読む。設定した後に deploy し直す。

### B-5. 🛑 承認: DB の共有スイッチ

```sql
update public.sales_demo_share_settings set versioned_sharing_enabled = true;   -- DB の所有者だけ (SQL editor)
```

同時に `scripts/staging/lib.mjs` の照合 `demo_version_sharing_disabled` を変える (今は off を要求する)。

### B-6. 🛑 承認: 最初の実店舗

- 店の事実は**確認済みのものだけ** (facts pack)。未確認の事実を足さない。
- 写真は**共有できる権利が確認できたものだけ**。今の共有は写真なしの版だけ (写真のある版は 404、MVP_SPEC §7)。写真なしの高品質版を先に作る。
- AI 生成画像 (`ai_demo_internal` など共有不可) を公開しない。輪 (SR-001) の版は共有不可。
- 管理画面で PC 1440・SP 390 の全頁を見て、品質 7 項目・文章をオーナーが承認してから送信承認。
- 送信はオーナーが自分のメールアプリ / Instagram から。システムは送らない。送った後に「手動で送信済みにする」。

### B-7. rollback

軽い順。どれか 1 つで共有は止まる (共有 URL は React のデモか 404 に戻る。別の版には切り替わらない):

1. `SALES_DEMO_SHARE_ENABLED` を off にして deploy し直す。版を固定していない (legacy の) token は React のデモに戻る。版を固定して送った token は 404 (React にも別の版にも切り替わらない)。旗 off の間、版を使う新しい送信承認・送信画面を開く操作は止まる。
2. DB の共有スイッチを false: `update public.sales_demo_share_settings set versioned_sharing_enabled = false;`
3. 品質の審査の書き込みを止める: `SALES_DEMO_QUALITY_REVIEW_ENABLED` を off。版の画面ごと止める: `SALES_DEMO_VERSIONS_ENABLED` を off。
4. 🛑 承認: migration を戻す (最後の手段、新しい順に):
   - `20261115000100`: 戻す SQL は `.ai/reviews/DEV-263g.md` (送信の門を 20261111000000 の定義に戻し、判定の関数とスイッチの表を drop)。
   - `20261115000000`: 戻す SQL は `.ai/reviews/DEV-263f.md` (送信の門と照合の証拠の trigger を 20261113000000 の定義に戻し、列・関数・表を drop。登録した facts は消える。消す前に人が判断する)。
   - `20261114000100`: 本文の先頭の Rollback の注記 (DEV-196c の定数に戻す SQL)。`.ai/reviews/DEV-196g.md` にも同じもの。
   - `20261114000000`: 本文の先頭の Rollback の注記 (表と関数を drop)。
   - `20261113000000`: forward-only。戻す SQL は `.ai/reviews/DEV-199e.md`。
   - `20261111000000`: 戻す手順は `.ai/reviews/DEV-196c.md` (1 transaction で関数を前の定義に戻し、表と列を drop)。
   - 送信済みの記録 (`sales_outreach_approvals` など) は消さない。
