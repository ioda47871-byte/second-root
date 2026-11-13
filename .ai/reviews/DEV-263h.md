# DEV-263h — 実店舗のデモの事実を facts pack から作る経路と、実店舗のデモの作業手順 (Issue #263、runbook B-2)

Base: `origin/develop` 404ab4e1 (#269 merge 後)。branch `feature/dev-263h-real-shop-onboarding`。
オーナー承認の範囲: コード・テスト・ローカルの migration・PR。**hosted (Staging / Production) には何も当てていない。** Vercel / env / DNS・実送信・Codex / 画像 / LLM・輪 のデータ・workflow / package.json / lockfile / prompt / skill には触れていない。**実店舗のデータは repo・テスト・PR に入れていない** (テストは架空の店だけ)。ローカルの検証は scratch に複製した別 project id のスタック (`sr-dev263h`、port 5988x) だけ。

## 埋めた穴 (DEV-263f の残り)

DEV-263f の保存先は、demo の content が**すでに**その facts pack から導かれているときだけ登録を受け付ける。その content を作る経路は 環 の seed にしか無く、実店舗の facts は登録できなかった。

## 何をしたか

### 1. migration `20261116000000_sales_facts_demo_onboarding.sql` (ローカルだけ)

| 関数 | 何 |
|---|---|
| `sales_derive_facts_demo_content(text)` (内部、immutable) | facts pack のバイトから demo の content を **DB で**導く。`lib/demo-version-package/facts-content.ts` の `demoContentWithFactsSha` と同じ写し方 (単独の key 10 個・`service_N` / `statement_N` を番号の順・`facts_pack`・`facts_pack_sha256`)。形の誤り・余計な欄・未対応の key・重複・不足は拒否。値はバイトのまま写すので、**前後に空白のある値は拒否** (サーバーの FactsPack は trim するため、2 通りに導かれないように) |
| `sales_onboard_facts_demo(prospect, pack, replace, admin, via)` (内部) | 1 つの transaction: admin の確認 → 除外リストの共有 lock + 候補の行の lock (送信の門と同じ順) → DNC / 除外リスト → 導出 → 輪 → 同じ shop_id が別の候補 (shop ごとの advisory lock) → demo が無ければ作る (template は候補の業種から、token は `sales_new_demo_token`)、あって内容が違えば: 輪・別の shop_id・無効化・共有中 (`expires_at`) / 送信の承認 (approved / send_opened / sent)・デザインの処理中を拒否し、**`replace` が true のときだけ**置き換え → `sales_insert_facts_pack` で同じバイトを登録 (同じバイトは replay)。`operator_cli` は DB の所有者の CLI のスイッチ (`sales_facts_registration_settings`、既定 off) が要る |
| `sales_create_demo_from_facts(prospect, pack, replace)` | 署名済みの sales admin (SECURITY DEFINER、`sales_assert_admin` を最初に、`auth.uid()`、`admin_session`)。authenticated だけに EXECUTE |

- 内部の 2 つはどの API role (anon / authenticated / service_role) も実行できない。**service role の入口は足していない** (CLI は所有者のローカルの接続)。
- 関数名は `sales_demo_` で始めない。DEV-263f の rollback テストの数え方 (`sales_%facts_pack%`) にも掛からない名前にした。
- 候補の表・候補の規則 (名古屋・業種・連絡先の出どころ・重複) は触っていない。候補は作らない。

### 2. サーバー・画面

- `lib/demo-version-package/facts-content.ts` `onboardingDemoContent`: `demoContentWithFactsSha` + 値が trim 済み (`TRUSTED_FACTS_VALUE_UNTRIMMED`) + 輪 (`TRUSTED_FACTS_RIN_DEMO`)。
- `lib/sales/facts-onboarding.ts` (新規): `planFactsOnboarding` (純粋。DB と同じ拒否を、呼び手が見える範囲で: 作る / React のデモの置き換え / 前の facts の置き換え / 変更なし)・`createDemoFromFactsAsAdmin`。
- `lib/admin/demo-onboarding.ts` (新規): `previewDemoFromFacts` (書かない)・`submitDemoFromFacts` (同じバイト = preview の sha256、置き換えは確認が必須、admin の session の `sales_create_demo_from_facts` だけ)、`loadNoDemoProspect`。旗 (`SALES_DEMO_QUALITY_REVIEW_ENABLED`) が最初。メールアドレスを含む値は表示しない。
- `app/admin/sales/_actions/demo-versions.ts`: `previewDemoFromFactsPack`・`createDemoFromFactsPack` (旗 → admin → core)。
- `components/admin/demo/DemoFromFacts.tsx` (新規): 「デモの事実を facts pack から作る」。版の頁に常に出し (旗 on・demo が無効でないとき form)、**demo が無い候補**の頁 (`loadDemoVersionsPage` は not_found のまま) では、この区画だけを出す。React のデモ・既存の登録の区画 (`FactsPackRegistration`) は不変。

### 3. ローカルの CLI

`scripts/sales/demo-version/onboard-local.ts --prospect <uuid> --facts <file> --admin <uuid> [--replace-content]` (`lib/sales/facts-onboarding-local.ts`): `assertLocalDbUrl` (接続の前)、ファイルは **repo の外か `.local-shops/` の下だけ** (`FACTS_FILE_IN_REPO`)、リンク不可、バイトのまま (BOM は JSON として拒否)。計画で拒否 → 所有者の接続で `sales_onboard_facts_demo(..., 'operator_cli')`。出力は id・hash・code だけ。

### 4. 作業手順と guard

- `docs/operations/real-shop-demo-workflow.md` (新規): 作業の置き場 (repo の外 / `.local-shops/`)、オーナーが確認した事実だけで facts-pack.json を書く、design-director スキル + 成功例・写真なし・comp-lane の検査と PC1440 / SP390 の描画・copy.json (`real_shop_proposal`) + comp-copy の監査、package-local `--copy`、管理画面で作る / 登録、`--facts-from-store` で取り込み、管理画面で見て承認。
- `.gitignore` に `/.local-shops/`。`tests/unit/sales/facts-onboarding.test.ts` が、追跡されたファイルが無いこと・ignore されることを確かめる。
- runbook: 冒頭のリンク、B-1 の 6 番目の migration、B-2 の「まだ無いもの」を置き換え、B-7 の rollback。

### 5. `.ai/tasks.json`

DEV-263h を足した (review)。DEV-263f は #269 が merge 済みなので done (依存のテストのため)。DEV-263f の `human_approval_triggers` の「別の Task」を DEV-263h に。

## 既存のテストの変更

- `tests/unit/sales/demo-version/purity.test.ts`: 固定した importer の一覧に `components/admin/demo/DemoFromFacts.tsx` (demo-versions の action を呼ぶ)。

## テスト

- 新規 unit `tests/unit/sales/facts-onboarding.test.ts` (7): 導き方 (番号の順・環 の seed と同じ)・拒否 (未対応・重複・不足・余計な欄・壊れた JSON・前後の空白 3 種・輪)、計画 (作る / 置き換え 2 種 / 変更なし (キーの順によらない)、DNC・重複・別の shop・輪・無効化・共有中・送信の承認・デザインの処理中)、CLI のファイルの規則 (外 / `.local-shops` は可、repo の追跡される場所・リンク・無い・UTF-8 でない・BOM)、`.local-shops/` の guard。
- 新規 unit `tests/unit/admin/demo-onboarding.test.tsx` (7): preview は書かない・置き換えは確認なしで拒否・確認ありで `sales_create_demo_from_facts` だけ、demo なし → 作る / 変更なしは replace=false、旗 off・不正な入力・不正な pack・古い sha256・候補なし・読めない、DNC・重複 (demo / 保存先)・送信の承認・共有中、DB の除外リストの拒否の文言、メールの非表示、action の順 (旗 off は admin を見ずに拒否、admin でなければ拒否)、区画の markup。
- 新規 統合 `tests/integration/demo-facts-onboarding.test.ts` (9、ローカルの Supabase): DB とサーバーの導き方が一致 (3 つの架空の pack)、DB の拒否、権限 (内部の関数は anon / service role / admin のどれも不可、admin の関数は anon / service role 不可、SECURITY DEFINER は 1 つ)、React のデモの置き換え (確認なしは何も変えない → 確認ありで content = サーバーの導出・template と token は不変・保存先の行 → replay・登録の区画も replay → **他の候補の React のデモは不変で描ける**)、demo なし → 作る、新しい facts で置き換え・別の shop は拒否、拒否 (admin でない・候補なし・未対応の key・輪・DNC・除外リスト・重複・共有中・無効化、何も書かない)、CLI の経路 (スイッチ off・admin でない id・未確認・`operator_cli`)、**全体**: 取り込んだ候補 → 環 の facts から作る → 環 の v2 の包みを `factsFromStore` で取り込む → `facts_from_facts_path: true`・送信の門は `demo_copy_owner_confirmation_missing` → facts を変えると止まる。
- 統合の全体 (#270 の merge と Low の対応の後): 38 ファイル 546 件 + 5 skipped。途中、DEV-263f の rollback テスト 1 件が関数名の数え方 (`sales_%facts_pack%`) で落ち、名前を変えて pass。
- CLI を実際に流した (scratch のスタック): 作る → 2 回目は replay・`unchanged`、hosted の URL は `DB_URL_NOT_LOCAL`、repo の追跡される facts は `FACTS_FILE_IN_REPO`。
- unit: sales・admin・demo-version-package・staging・ai-tasks 73 ファイル 1610 件 pass。`swap-photos.test.ts` の 2 件だけ、このコンテナに Chromium が無い (`browserType.launch: Executable doesn't exist`) ため落ちる (この変更と無関係、CI で走る)。
- `tsc --noEmit` (`next typegen` の後)・eslint (変更したファイル)・`check:secrets`: pass。
- e2e は流していない (画面の新しい区画は unit の markup と統合のサーバーの経路で確かめた)。

## 既知の限界・開いている項目

- React のデモの内容を置き換えると、その候補の React のデモの表示も変わる (facts の `category` が bakery / baked_goods / cafe でなければ React のデモは出ない)。共有中・送信の承認後は置き換えを拒否するので、相手が見ている React のデモは変わらない。送るのは版だけ。
- 除外リストの判定は DB だけ (画面の preview では見ない。DB の拒否は文言で返る)。
- hosted の取り込みの経路 (包みを hosted に入れる手段) はこの Task に無い。runbook B の承認と別。
- facts の値の trim: サーバーは JS の `trim()` の空白、DB は `\s` と Unicode の空白 (U+00A0・U+1680・U+2000–200A・U+2028・U+2029・U+202F・U+205F・U+3000・U+FEFF) を前後に持つ値を拒否する。サーバーが先に拒否するので DB の一覧は二重の守り。

## Migration の計画

- ローカル: scratch のスタックに当て、統合テストの全体を流した。
- hosted (別のオーナー承認): `20261115000000` の後。新しい表・列は無く、関数 3 つだけ。当てた直後は誰も呼ばない (画面の区画は旗の後ろ)。サーバーのコードが先だと、作る操作は DB の誤り (関数が無い) で拒否される (fail closed)。当てた後 `notify pgrst, 'reload schema';`。
- rollback: migration の先頭の注記 (3 つの関数を drop、`schema_migrations` の行を消す)。作ったデモの内容と登録した facts は残る (消すかは人が判断する)。

## PR #270 (DEV-263g) の review の Low (この PR に入れた)

origin/develop (558f9cb1、#270 の squash) を merge commit で取り込んでから:

| # | 指摘 | 対応 |
|---|---|---|
| 1 | `sales_test_email_reserved` の予備の判定が [a-z0-9.-] 以外を全部消すので、`日本example.com`・`shop.example.東京` を予約済みと読む | migration `20261116000100_sales_test_email_reserved_fallback.sql` (ローカルだけ) で関数を置き換え: 見えない文字 (U+00AD・U+034F・U+061C・ハングルの埋め字・U+17B4/5・U+180B–180F・U+200B–200F・U+202A–202E・U+2060–206F・U+FE00–FE0F・U+FEFF・U+FFF0–FFF8・U+E0000–E0FFF のタグと異体字セレクター) だけを消し、残りの文字は `x` に置き換えて同じラベルに残す (サーバーの IDNA が xn-- のラベルにするのと同じく、予約名には化けない)。ゼロ幅の文字で予約名を隠すことは今までどおりできない。統合テスト `tests/integration/test-recipient-fallback.test.ts` (非 ASCII 4 件は false・見えない文字 5 件は true・従来の件・サーバーの `isReservedEmailDomain` と一致・rollback と当て直し) |
| 2 | `tests/support/local-test-recipients.ts` の `loopbackDbUrl` が URL の hostname だけを見る | pg-connection-string (pg 自身の解析) の host で判定 (`?host=` の上書きはその値で判定、`?hostaddr=` は拒否)、localhost・127.0.0.0/8・[::1] を受け付ける。unit `tests/unit/sales/local-test-recipients.test.ts` |
| 3 | runbook A-5 にスイッチを off に戻す手順がない | A-5 の最後と A-6 に `update public.sales_local_test_settings set local_test_recipients_enabled = false` (A-6 には facts の CLI のスイッチも) |
| 4 | `sales_local_test_settings` の `grant select … to authenticated` が無用 | **入れていない**: revoke すると staging の照合 `authenticated_can_read` (`scripts/staging/lib.mjs`: 署名済みの role がすべての sales_* 表を SELECT できること、行は RLS が絞る) と統合テスト `staging-checks` が落ちる (実際に 6 件落ちるのを確かめて戻した)。表に policy は無いので、署名済みの role が読める行は無い (`test-recipient-guard.test.ts` が確認済み)。照合の規則を変えるかはオーナーの判断 |

既存の `tests/integration/test-recipient-guard.test.ts` の判定の表 (`info@ex\u200dample.com` は true など) は変わらず pass。

### Rollback SQL (20261116000100)

<!-- rollback-sql-20261116000100:start -->
```sql
begin;
create or replace function public.sales_test_email_reserved(p_email text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_at integer;
  v_domain text;
begin
  if p_email is null then
    return false;
  end if;
  v_at := length(p_email) - strpos(reverse(p_email), '@') + 1;
  if strpos(p_email, '@') = 0 then
    return false;
  end if;
  v_domain := btrim(substr(p_email, v_at + 1));
  if v_domain = '' then
    return false;
  end if;
  v_domain := lower(translate(normalize(v_domain, NFKC), '。．｡', '...'));
  v_domain := regexp_replace(v_domain, '\.+$', '');
  if v_domain = '' then
    return true;
  end if;
  if public.sales_reserved_test_domain(v_domain) then
    return true;
  end if;
  if v_domain ~ '[^a-z0-9.-]' then
    return public.sales_reserved_test_domain(regexp_replace(regexp_replace(v_domain, '[^a-z0-9.-]', '', 'g'), '\.+$', ''));
  end if;
  return false;
end;
$$;
delete from supabase_migrations.schema_migrations where version = '20261116000100';
commit;
```
<!-- rollback-sql-20261116000100:end -->
