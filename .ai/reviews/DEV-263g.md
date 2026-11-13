# DEV-263g — DB 側のテスト宛先の guard (Issue #263、runbook B-2 の 3) と DEV-263e の review の Low

branch `feature/dev-263g-test-recipient-guard`。Base: `origin/develop` 404ab4e1 (PR #269 DEV-263f の merge)。オーナー承認の範囲: コード・テスト・ローカルの migration・PR。**hosted (Staging / Production) には何も当てていない。** Vercel / env / DNS・実送信・Codex / 画像 / LLM・輪 のデータ・workflow / package.json / lockfile / prompt / skill には触れていない。ローカルの検証は scratch に複製した別 project id のスタック (`sr-dev263f`、port 5976x) だけ。

## 何をしたか

### 1. migration `20261115000100_sales_test_recipient_guard.sql` (ローカルだけ)

| 物 | 何 |
|---|---|
| `sales_test_recipient_block(prospect, channel)` | null = 止めない。demo の `content.facts_pack` が `^fictional-` → `test_recipient_fictional_shop` (どのチャネルでも)。メールの宛先のドメインが予約済み → `test_recipient_reserved_domain`。service role だけ実行可 |
| 予約済みの判定 (`sales_test_email_reserved` / `sales_reserved_test_domain`) | サーバーの `lib/sales/test-recipient.ts` と同じ名前: example.com / .net / .org とその下、`*.example`・`*.test`・`*.invalid`・`*.localhost` (とその名前自体)。正規化: NFKC → 「。」「．」「｡」を `.` に → 小文字 → 末尾の点を除く。`[a-z0-9.-]` 以外の文字が残るドメインは、それらを除いた形でも判定する (ZWJ などで予約済みの名前を隠せない。サーバーの IDNA はそれを拒否して止めるので、DB も止める側)。DB は punycode を作れないので、非 ASCII のラベルの IDNA の写像までは再現しない (予約済みの名前はすべて ASCII なので、写像で予約済みになる非 ASCII のドメインは NFKC と点の折り畳みで足りる) |
| 送信の門 | `sales_send_guards` (置き換え、20261111000000 + この判定) が、送信承認 (`sales_approve_outreach`) と送信画面を開く (`sales_mark_send_opened`) で拒否。開いた承認の「送信済み」(`p_confirm_opened`) では新しく止めない (承認と開く時に止めている) |
| DB の所有者だけのスイッチ | `sales_local_test_settings` (1 行、`local_test_recipients_enabled` 既定 false)。trigger が API role (anon / authenticated / service_role) の書き込みを拒否、行の追加・削除も拒否 (共有スイッチと同じ形)。on の間だけ guard を通す。hosted では off のまま |

関数名は `sales_demo_` で始めない。

### 2. ローカルのテストのスイッチ

- `tests/support/local-test-recipients.ts`: loopback の DB にだけ、所有者として on / off。
- 統合: `vitest.integration.config.mts` の `setupFiles` (`tests/integration/setup-local-test-recipients.ts`) が各ファイルの前に on (既存の統合テストは example.com の宛先を承認するため)。
- e2e: `playwright.config.ts` の `globalSetup` (`tests/e2e/support/global-setup.ts`) が実行の前に on (DB の URL が無い実行では何もしない)。サーバーの門は従来どおり webServer の `SALES_LOCAL_E2E_TEST_RECIPIENTS`。
- サーバーの門 (`approveSend`・`markFollowUpSent`) はそのまま。DB の code の文言を `SEND_ERROR_LABEL` に (`lib/sales/test-recipient-labels.ts`: import なしの文言の module。`approval.ts` は client に届くので `node:url` を持つ `test-recipient.ts` を import しない)。

### 3. DEV-263e の review の Low

- `lib/sales/version-schema.ts`: error の `message` だけを見る (details / hint は見ない)。PGRST200 は 2 つの版の列 (`approved_version_id`・`demo_version_id`) を名指すときだけ。テスト (`send-guard.test.ts`): 列を message で名指す PGRST200 は DB へ進む、details / hint だけの名指し・表名だけの PGRST200 は専用の拒否。
- runbook A-2: 管理者の追加を `psql "$(npx supabase status -o json | jq -r .DB_URL)"` に (コンテナ名に依存しない)。
- `tests/e2e/sales-mvp-flow.spec.ts`: `const clip = await`。
- `proxy.ts` `STATIC_PATH`: 届かない選択肢 (favicon.ico・robots.txt・sitemap.xml は拡張子で一致) を外した。guardrails のテストはそのまま通る。

### 4. PR #269 の delta review の Low (coordinator の指示でこの PR に)

- (a) facts の CLI 登録のスイッチ (`sales_facts_registration_settings`) を、テストが on にした後に off へ戻す: 統合の `setupFiles` の `afterAll` が各ファイルの後に両方のローカルのスイッチ (テスト宛先・facts の CLI 登録) を off に戻す (`helpers.registerFacts`・`demo-sendable-seed` が on にしたものを含む)。`demo-facts-store` は自分の `afterAll` でも off。e2e の `sales-mvp-flow` は従来どおり自分の afterAll で off、テスト宛先のスイッチは `globalTeardown` で off。全体の統合の後、ローカルの DB で両方 false を確認。
- (b) `demo-facts-store` の L4 の統合テストは、共有のローカルの stack で migration を実際に戻さない: 本物の admin の client を包み、保存先の表 (PGRST205) と `facts_pack_id` の列 (42703) だけを migration 前の DB と同じ誤りで答えさせる。「未設定」・証拠は数えない・送信は `demo_copy_facts_not_from_facts_path`、ほかの読み込みの誤りは `demo_copy_review_unverifiable`、本物の DB は変わらない (`ok: true`)、を確かめる。

## 既存のテストの変更

- `tests/unit/sales/copy-review/send-guard.test.ts`: PGRST200 の通る例の名指しを details から message へ (Low の意図した変更) と、拒否の例を 3 つ追加。
- 既存の統合テスト・e2e は、所有者のスイッチを setup で on にする以外は不変。
- `tests/integration/demo-facts-store.test.ts` の L4 (上の (b))。

## 既知の限界

- DB の正規化は IDNA の完全な写像ではない (上)。サーバーの門が前にある。
- 追いの送信 (`sales_mark_follow_up_sent`) は DB では止めない: 最初の送信が承認できない宛先には追いも無い。サーバーの `markFollowUpSent` は従来どおり止める。

## Migration の計画

- ローカル: scratch のスタックで `supabase db reset` (develop の migration + この migration) の上で統合の全体。
- rollback: 下の SQL を 1 transaction で。統合テスト `tests/integration/test-recipient-guard.test.ts` が取り消す transaction の中で流して確かめる。

### hosted に当てるとき (別のオーナー承認が要る)

1. develop → `release/*` → main の後、`20261115000000` の後に当てる。スイッチは off のまま (当てない限り変わらない: 既定 false)。
2. 当てると、example.com などの予約済みの宛先・架空の店への送信承認と送信画面を開く操作は DB でも止まる (実店舗の宛先は影響なし)。サーバーの門は既に止めている。
3. `notify pgrst, 'reload schema';`

## 検証 (ローカル、scratch のスタック、develop の migration + この migration で `supabase db reset`)

- 新規 `tests/integration/test-recipient-guard.test.ts` (6): 予約済みのドメインの承認の拒否とスイッチ on での承認、架空の店はどのチャネルでも拒否・架空でない Instagram は承認、承認後に off にすると送信画面を開く操作も拒否、正規化 (NFKC・全角・「。」・大文字・末尾の点・ZWJ、予約済みでない例)、スイッチは 1 行・既定 off・API role は変えられない・関数は service role だけ、rollback と当て直し。
- 統合の全体: 36 ファイル・539 件 pass。実行の後、ローカルの DB で両方のスイッチが false に戻っていることを確認。
- e2e (production build、globalSetup のスイッチ): desktop の全体 99 passed (`sales-mvp-flow` を含む)。
- unit: sales・demo-frame・admin・staging・ai-tasks・copy-package・sendable-demo 71 ファイル 1563 件 pass。
- `tsc --noEmit`・`eslint` (全体)・`check:secrets`・`next build`: pass。

## Rollback SQL

<!-- rollback-sql:start -->
```sql
begin;
-- sales_send_guards: exactly the 20261111000000 definition (create or replace keeps its grants)
create or replace function public.sales_send_guards(o public.sales_outreaches, p_design_enabled boolean, p_confirm_opened boolean)
returns public.sales_demos
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  v_recipient text;
  v_block text;
  v_code text;
begin
  if o.kind <> 'initial' or o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  -- Serialises with sales_add_exclusion: an exclusion committed before this
  -- point is always seen; one added later waits for this send to finish.
  perform pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'));
  -- A concurrent DNC (sales_set_dnc locks the same row) is seen after the wait.
  perform 1 from public.sales_prospects where id = o.prospect_id for update;
  if coalesce(p_confirm_opened, false) then
    v_block := public.sales_outreach_block_reason(o.prospect_id);
    perform public.sales_assert_channel_eligible(o.prospect_id, o.kind, o.channel);
  else
    -- DNC, channel rules, recommended channel and the exclusion list.
    perform public.sales_assert_outreach_eligible(o.prospect_id, o.kind, o.channel);
  end if;

  v_recipient := public.sales_outreach_recipient(o.prospect_id, o.channel);
  if v_recipient is null then
    raise exception 'recipient_missing' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.sales_outreach_approvals a
    where a.channel = o.channel and a.recipient = v_recipient and a.outreach_id <> o.id
      and a.state in ('approved', 'send_opened', 'sent')
  ) then
    raise exception 'duplicate_recipient' using errcode = 'P0001';
  end if;

  select * into d from public.sales_demos where prospect_id = o.prospect_id for update;
  if not found or (d.disabled_at is not null and v_block is distinct from 'do_not_contact') then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;
  if coalesce(p_design_enabled, false) and d.design_status in ('pending', 'processing') then
    raise exception 'design_pending' using errcode = 'P0001';
  end if;
  -- DEV-196c (§9.2): a quality-approved version must still be approved,
  -- unrevoked, unexpired, match the current facts and be shareable now.
  if not coalesce(p_confirm_opened, false) then
    v_code := public.sales_demo_version_send_block(d);
    if v_code is not null then
      raise exception using message = v_code, errcode = 'P0001';
    end if;
  end if;
  return d;
end;
$$;
drop function public.sales_test_recipient_block(uuid, text);
drop function public.sales_test_email_reserved(text);
drop function public.sales_reserved_test_domain(text);
drop table public.sales_local_test_settings;
drop function public.sales_check_local_test_settings_write();
delete from supabase_migrations.schema_migrations where version = '20261115000100';
commit;
```
<!-- rollback-sql:end -->
