# 営業 MVP の運用手順 (Issue #263 の 5)

デモの版 → 品質承認 → 文章の承認 → 送信承認 → 共有 URL → 送信済み → 返信・商談、の流れを
(A) ローカルで試す手順と、(B) Staging / Production に出すときの計画に分けて書く。

**(B) はどれもオーナーの承認が要る。** この文書は計画であって、承認ではない。
`🛑 承認` の印のところで止まり、オーナーの承認を受けてから次へ進む。

E2E で同じ流れを通すテストは `tests/e2e/sales-mvp-flow.spec.ts` (DEV-263e)。
実店舗のデモ (事実 → 頁 → 包み → 登録 → 取り込み) を repo に店のデータを入れずに作る手順は [`real-shop-demo-workflow.md`](real-shop-demo-workflow.md) (DEV-263h)。
頁の制作の正式な流れは [`image-first-production-flow.md`](../design/image-first-production-flow.md) で、写真なしの B 方式・Claude の直接の設計は、オーナーが明示的に指示したときだけの研究・暫定 (IMAGE_FIRST の成功には数えない)。

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

画面で通し終えたら、テスト宛先のスイッチを所有者として off に戻す (A-3 の後で on にしたもの):

```bash
psql "$(npx supabase status -o json | jq -r .DB_URL)" \
  -c "update public.sales_local_test_settings set local_test_recipients_enabled = false;"
```

### A-6. 片付け

```bash
psql ... -c "update public.sales_demo_share_settings set versioned_sharing_enabled = false;"
psql ... -c "update public.sales_local_test_settings set local_test_recipients_enabled = false;"
psql ... -c "update public.sales_facts_registration_settings set operator_cli_enabled = false;"
npx supabase stop
```

E2E (`sales-mvp-flow.spec.ts`) は、前後に 環 (固定の id) を消して作り直す。ローカルで試した 環 の記録も消える。

---

## B. Staging / Production に出す計画 (全部オーナーの承認待ち)

順番に進める。どの段も、前の段が終わってから。**どの段もまだ実施していない。**

Staging で1店舗を通す順番と事前確認 (token・バックアップ・共有 URL の host) は [`staging-first-shop.md`](staging-first-shop.md)。

### B-1. 🛑 承認: migration を当てる

当てる順 (develop にあるもの、この順だけ):

1. `20261111000000_sales_demo_versions.sql` (DEV-196c: 版・品質の審査・送信の guard)
2. `20261113000000_sales_demo_copy_send_guard.sql` (DEV-199e: 文章の監査と送信の門)
3. `20261114000000_sales_demo_structure_findings.sql` (DEV-196q: 構造の所見)
4. `20261114000100_sales_demo_share_switch.sql` (DEV-196g: DB の共有スイッチ、既定 false)
5. `20261115000000_sales_demo_facts_store.sql` (DEV-263f: facts の保存先と送信時の比べ直し。B-2)
6. `20261115000100_sales_test_recipient_guard.sql` (DEV-263g: DB 側のテスト宛先の guard。B-2)
7. `20261116000000_sales_facts_demo_onboarding.sql` (DEV-263h: facts pack からデモの事実を作る + 登録。B-2。戻す SQL は本文の先頭)
8. `20261116000100_sales_test_email_reserved_fallback.sql` (DEV-263h: テスト宛先の guard の予備の判定が実在の非 ASCII のドメインを拒否しないように)
9. `20261117000000_sales_optional_facts_onboarding.sql` (DEV-263k: 未確認の任意事実は省略。必須の4項目は変更なし。本番適用は別承認)

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
  - 実店舗の demo の content を facts pack から作る経路 (DEV-263h、ローカルで実装済み・hosted は未適用): 管理画面の「デモの事実を facts pack から作る」(`sales_create_demo_from_facts`、admin の session) が、DB で事実からデモの内容を作り、デモを作るか内容を置き換え (オーナーの確認)、同じバイトを保存先に登録する (1 つの transaction)。DNC・除外リスト・同じ shop_id の重複・送信の承認後 / 送信後 / 共有中のデモは拒否。ローカルの CLI は `scripts/sales/demo-version/onboard-local.ts`。手順は [`real-shop-demo-workflow.md`](real-shop-demo-workflow.md)。
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

### B-5a. 🛑 承認: hosted で版を取り込む (DEV-263i、管理画面の「版を取り込む」)

`import-local.ts` はローカルの DB にしか入れない。hosted (Staging / Production) の DB と private bucket へは、管理画面の
「版を取り込む」から入れる。CLI から hosted へ入れる経路は無い (service role の鍵を手元に置かない)。

前提 (どれも承認が要る。まだ実施していない):

- B-1 の migration が当たっている (新しい migration は要らない)。
- private の Storage bucket `sales-demo-versions` がある: public でない、1 ファイル 4MiB、MIME は `text/html`・`text/css`・`image/webp`・`image/jpeg` だけ (ローカルの `supabase/config.toml` と同じ)。anon / authenticated の storage policy を作らない (`scripts/staging/` の照合が見る)。
- B-4 の `SALES_DEMO_VERSIONS_ENABLED` と `SALES_DEMO_QUALITY_REVIEW_ENABLED` が `true`。server の `SUPABASE_SERVICE_ROLE_KEY` (既存) がある。
- その店の facts pack が「店舗の事実の登録」で登録済み (B-2)。未登録の店には「版を取り込む」の欄が出ない。

手順:

1. オーナーの PC で包みを作る (repo の外へ): `npx tsx scripts/sales/demo-version/package-local.ts --out <置き場>/pkg --copy <頁のフォルダ> --facts <facts-pack.json>`。v2 (文章の監査つき) だけを取り込める。
2. 管理画面の `/admin/sales/demos/<prospect id>` →「版を取り込む」→ 包みのフォルダ (`package.json` のある `pkg`) を選ぶ →「版を取り込む」。
3. ブラウザは 3 段で送る: begin (`package.json` を server が検める。何も書かない) → put (頁のファイルを 1 つずつ、sha256 つき。bucket の `staging/<sha256>` に置く。版ではなく、配られない) → finalize (`package.json` と文章のファイル。server が頁のファイルを staging から読み直し、`import-local.ts --facts-from-store` と同じ検査を同じ順で行い、通れば版にする)。
4. 出来た版は下書き。A-5 と同じく、PC 1440 / SP 390 を見て品質承認・文章の承認をオーナーが行う。取り込みは何も承認しない。

- 途中で止まったら、同じフォルダでもう一度「版を取り込む」。送り済みのファイルは飛ばし、同じ包みは同じ版になる (replay)。
- 送れないもの: zip / tar などの圧縮ファイル (展開しない)、manifest に無いファイル、文章のファイルの合計が約 4MiB を超える包み (`COPY_TOO_LARGE_FOR_UPLOAD`。1 回の要求の上限)。
- `staging/` の一時ファイルは版にならないまま残る (配られない)。片付けは別 Task。消すのは版のファイルと照らしてから。

### B-6. 🛑 承認: 最初の実店舗

- 店の事実は**確認済みのものだけ** (facts pack)。未確認の事実を足さない。
- 版は B-5a の「版を取り込む」で入れる (facts の登録の後)。手順の全体は `docs/operations/real-shop-demo-workflow.md` (DEV-263h)。
- 写真は**共有できる権利が確認できたものだけ**。今の共有は写真なしの版だけ (写真のある版は 404、MVP_SPEC §7)。写真なしの高品質版を先に作る。
- AI 生成画像 (`ai_demo_internal` など共有不可) を公開しない。輪 (SR-001) の版は共有不可。
- 管理画面で PC 1440・SP 390 の全頁を見て、品質 7 項目・文章をオーナーが承認してから送信承認。
- 送信はオーナーが自分のメールアプリ / Instagram から。システムは送らない。送った後に「手動で送信済みにする」。

### B-7. rollback

軽い順。どれか 1 つで共有は止まる (共有 URL は React のデモか 404 に戻る。別の版には切り替わらない):

1. `SALES_DEMO_SHARE_ENABLED` を off にして deploy し直す。版を固定していない (legacy の) token は React のデモに戻る。版を固定して送った token は 404 (React にも別の版にも切り替わらない)。旗 off の間、版を使う新しい送信承認・送信画面を開く操作は止まる。
2. DB の共有スイッチを false: `update public.sales_demo_share_settings set versioned_sharing_enabled = false;`
3. 品質の審査の書き込みを止める: `SALES_DEMO_QUALITY_REVIEW_ENABLED` を off (「版を取り込む」も止まる)。版の画面ごと止める: `SALES_DEMO_VERSIONS_ENABLED` を off。
4. 🛑 承認: migration を戻す (最後の手段、新しい順に):
   - `20261117000000`: **B-7aの監査と明示的承認の後にのみ**、`20261116000000` の関数定義へ戻す。省略形式の登録済みデモがあればロールバックしない。事実・デモは削除しない。
   - `20261116000100`: 本文の先頭の Rollback の注記 (`sales_test_email_reserved` を 20261115000100 の定義に戻す)。`.ai/reviews/DEV-263h.md` にも同じもの。
   - `20261116000000`: 本文の先頭の Rollback の注記 (3 つの関数を drop。作ったデモの内容と登録した facts は残る。消すかは人が判断する)。
   - `20261115000100`: 戻す SQL は `.ai/reviews/DEV-263g.md` (送信の門を 20261111000000 の定義に戻し、判定の関数とスイッチの表を drop)。
   - `20261115000000`: 戻す SQL は `.ai/reviews/DEV-263f.md` (送信の門と照合の証拠の trigger を 20261113000000 の定義に戻し、列・関数・表を drop。登録した facts は消える。消す前に人が判断する)。
   - `20261114000100`: 本文の先頭の Rollback の注記 (DEV-196c の定数に戻す SQL)。`.ai/reviews/DEV-196g.md` にも同じもの。
   - `20261114000000`: 本文の先頭の Rollback の注記 (表と関数を drop)。
   - `20261113000000`: forward-only。戻す SQL は `.ai/reviews/DEV-199e.md`。
   - `20261111000000`: 戻す手順は `.ai/reviews/DEV-196c.md` (1 transaction で関数を前の定義に戻し、表と列を drop)。
   - 送信済みの記録 (`sales_outreach_approvals` など) は消さない。

### B-7a. DEV-263k のみの手動 rollback 詳細（実行禁止：別途オーナー承認が必要）

この節は手順の記録であり、**このPRでは実行しない**。特にStaging / Productionに適用する場合、オーナーによる対象環境・実行SQL・監査結果・復旧判断の個別承認が先に必要。ローカルでも他人と共有するDBの初期化・resetは行わない。

1. **対象DBで事前に読み取り専用監査**する。旧関数は10個の単一キーをすべて必須とするので、新形式で少なくとも1個欠けたデモが現存すれば機能を戻せない。以下は現在のデモ行に対する最低限の点検であり、履歴のfacts packやバックアップも別途調査する。**省略形式が1件でもあれば停止し、人が取り扱いを決める**。データを消して帳尻を合わせない。

```sql
select version from supabase_migrations.schema_migrations
where version in ('20261116000000', '20261117000000') order by version;

select d.id, d.prospect_id, d.content->>'facts_pack' as shop_id,
       d.content->>'facts_pack_sha256' as facts_sha256
from public.sales_demos d
where d.content ? 'facts_pack_sha256'
  and not (d.content ?& array[
    'name', 'category', 'ward', 'address', 'hours', 'closed_days',
    'access', 'phone', 'description', 'workshop'
  ]);
```

2. **別途のオーナー承認と移行計画を確定した場合のみ**、以下の一つのトランザクションで元の関数を復元し、migration履歴の当該版だけを戻す。`LOCK TABLE ... IN SHARE MODE` により処理中のデモ・facts書込をブロックしてから、そのトランザクション内で履歴と省略項目の有無を再検査する（事前監査だけに依存しない）。該当データがあれば `raise exception` で全体を取り消す。旧関数本体は `20261116000000_sales_facts_demo_onboarding.sql` から、先頭の `create function` だけを `create or replace function` にしたもの。**DB操作はこのPRでは実行しない**。

```sql
begin;
-- Do not allow concurrent onboarding/demo mutations between the guards and restoration.
-- SHARE conflicts with INSERT/UPDATE/DELETE ROW EXCLUSIVE locks, until COMMIT.
lock table public.sales_demos, public.sales_demo_facts_packs,
           supabase_migrations.schema_migrations in share mode;

do $rollback_guard$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261116000000')
     or not exists (select 1 from supabase_migrations.schema_migrations where version = '20261117000000') then
    raise exception 'optional_facts_rollback_missing_applied_migration';
  end if;

  if exists (
    select 1 from public.sales_demos d
    where d.content ? 'facts_pack_sha256'
      and not (d.content ?& array[
        'name', 'category', 'ward', 'address', 'hours', 'closed_days',
        'access', 'phone', 'description', 'workshop'
      ])
  ) then
    raise exception 'optional_facts_rollback_sparse_demo_exists';
  end if;

  -- Append-only history matters too: a demo can be overwritten while its old
  -- facts bytes remain registered. Never strand those packs behind the old gate.
  if exists (
    select 1 from public.sales_demo_facts_packs f
    where exists (
      select 1 from unnest(array[
        'name', 'category', 'ward', 'address', 'hours', 'closed_days',
        'access', 'phone', 'description', 'workshop'
      ]::text[]) k(key)
      where not ((f.facts_pack_text::jsonb->'facts') @> jsonb_build_array(jsonb_build_object('key', k.key)))
    )
  ) then
    raise exception 'optional_facts_rollback_sparse_stored_pack_exists';
  end if;
end
$rollback_guard$;

create or replace function public.sales_derive_facts_demo_content(p_facts_pack text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_pack jsonb;
  f jsonb;
  v_key text;
  v_seen text[] := '{}';
  v_single jsonb := '{}'::jsonb;
  k text;
  c_single constant text[] := array['name', 'category', 'ward', 'address', 'hours', 'closed_days', 'access', 'phone', 'description', 'workshop'];
begin
  if p_facts_pack is null or octet_length(p_facts_pack) not between 2 and 1048576 then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  begin
    v_pack := p_facts_pack::jsonb;
  exception when others then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end;
  if jsonb_typeof(v_pack) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(v_pack) x where x not in ('schema', 'shop_id', 'facts'))
     or v_pack->>'schema' is distinct from 'shop_facts_pack_v1'
     or jsonb_typeof(v_pack->'shop_id') is distinct from 'string' or (v_pack->>'shop_id') !~ '^[a-z0-9][a-z0-9_-]{1,40}$'
     or jsonb_typeof(v_pack->'facts') is distinct from 'array' or coalesce(jsonb_array_length(v_pack->'facts'), 0) not between 1 and 200 then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  for f in select e.value from jsonb_array_elements(v_pack->'facts') e loop
    if jsonb_typeof(f) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(f) x where x not in ('id', 'key', 'value', 'source_id'))
       or jsonb_typeof(f->'id') is distinct from 'string' or jsonb_typeof(f->'key') is distinct from 'string'
       or jsonb_typeof(f->'value') is distinct from 'string' or jsonb_typeof(f->'source_id') is distinct from 'string'
       or (f->>'id') !~ '^F[0-9]{1,3}$' or (f->>'source_id') !~ '^S[0-9]{1,3}$'
       or (f->>'key') !~ '^[a-z][a-z0-9_]{1,40}$'
       -- FactsPack's max(400) counts characters (code points), as char_length does
       or char_length(f->>'value') not between 1 and 400 then
      raise exception 'invalid_facts_pack' using errcode = '22023';
    end if;
    -- FactsPack's unsafeText (lib/design-agent/quality-pipeline/facts-pack.ts): control characters, <<< / >>>, a tag
    -- opening (JavaScript's \s, case-insensitive [a-z]; NUL cannot be in a text value)
    if (f->>'value') ~ '[\x01-\x09\x0b-\x1f\x7f]|<<<|>>>|<[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*/?[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[a-zA-Z!]' then
      raise exception 'facts_pack_unsafe_text' using errcode = '22023';
    end if;
    if (f->>'value') ~ '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
       or (f->>'value') ~ '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$' then
      raise exception 'facts_pack_value_untrimmed' using errcode = '22023';
    end if;
    v_key := f->>'key';
    if v_key = any (v_seen) then
      raise exception 'facts_pack_duplicate_key' using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;
    if v_key = any (c_single) then
      v_single := v_single || jsonb_build_object(v_key, f->>'value');
    elsif v_key !~ '^(service|statement)_[1-9][0-9]{0,2}$' then
      raise exception 'facts_pack_unmapped_key' using errcode = '22023';
    end if;
  end loop;
  foreach k in array c_single loop
    if not v_single ? k then
      raise exception 'facts_pack_incomplete' using errcode = '22023';
    end if;
  end loop;
  return v_single || jsonb_build_object(
    'menu_items', coalesce((select jsonb_agg(e.value->'value' order by substring(e.value->>'key' from 9)::integer)
                              from jsonb_array_elements(v_pack->'facts') e where e.value->>'key' ~ '^service_[1-9][0-9]{0,2}$'), '[]'::jsonb),
    'statements', coalesce((select jsonb_agg(e.value->'value' order by substring(e.value->>'key' from 11)::integer)
                              from jsonb_array_elements(v_pack->'facts') e where e.value->>'key' ~ '^statement_[1-9][0-9]{0,2}$'), '[]'::jsonb),
    'facts_pack', v_pack->>'shop_id',
    'facts_pack_sha256', encode(sha256(convert_to(p_facts_pack, 'UTF8')), 'hex'));
end;
$$;

delete from supabase_migrations.schema_migrations
where version = '20261117000000';
commit;
```

**再適用注意**: リポジトリ内の `20261117000000_sales_optional_facts_onboarding.sql` を残したまま migration履歴だけ消すと、次の `db push` 等で再適用されうる。実行前に別途承認されたリポジトリ側のrevert / forward migration方針と運用停止範囲を確定する。履歴の手動変更が許されない環境では、履歴を消さず承認済みのforward復旧migrationを設計する。

3. **事後確認**: `pg_get_functiondef('public.sales_derive_facts_demo_content(text)'::regprocedure)` で `c_single` の必須検査に戻ったこと、関数のEXECUTE権限が公開されていないこと、`20261117000000` の履歴が消え `20261116000000` が残ることを確認する。既存の登録済みfactsやデモ、送信済み記録は一切削除しない。migration履歴の手動更新が許されない環境ではSQLをそのまま実行せず、別の承認済みforward修復migrationを設計する。
