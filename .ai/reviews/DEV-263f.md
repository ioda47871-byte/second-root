# DEV-263f — hosted の facts の保存先と送信時の facts の比べ直し (Issue #263、runbook B-2 の 1・2)

Base: `origin/develop` d3e31891 (#264–#268 merge 後)。branch `feature/dev-263f-facts-store`。
オーナー承認の範囲: コード・テスト・ローカルの migration・PR。**hosted (Staging / Production) には何も当てていない。** Vercel / env / DNS・実送信・Codex / 画像 / LLM・輪 のデータ・workflow / package.json / lockfile / prompt / skill には触れていない。ローカルの検証は scratch に複製した別 project id のスタック (`sr-dev263f`、port 5976x) だけ。

## 何をしたか

### 1. 保存先 (migration `20261115000000_sales_demo_facts_store.sql`)

| 物 | 何 |
|---|---|
| `sales_demo_facts_packs` (新しい表) | 店の信頼できる facts pack のバイト (`facts_pack_text`)・その sha256 (`facts_sha256`、文章の監査が名指す hash)・正規の内容の hash (`facts_jsonb_sha256`: jsonb の正規形。キーの順序・空白によらない)・`shop_id`。prospect と demo に結び付く。trigger が全部の列を本文から導き直す。**追記のみ** (update / delete は trigger が拒否、どの API role にも DELETE / TRUNCATE なし)。prospect の最新の行 (seq) が「今の facts」 |
| 結び付き | 書く時に、demo の `sales_demos.content.facts_pack_sha256` がこのバイトの sha256、`content.facts_pack` がこの shop_id であること (`facts_pack_not_demo_content`)。demo の行と facts の出どころが 1 つ |
| 書く人 | **オーナーだけ**。`sales_register_facts_pack(demo, pack)` (署名済みの sales admin 本人、SECURITY DEFINER、admin を最初に検める、`recorded_by = auth.uid()`、`recorded_via = admin_session`)。`sales_register_facts_pack_as(demo, pack, admin_id)` (service role だけ、SECURITY DEFINER、`admin_id` が `sales_admins` にあること、`recorded_via = operator_cli`: 登録 / 取り込みの CLI 用)。どの API role も表に直接は書けない (trigger `facts_pack_owner_path_only`: current_user が anon / authenticated / service_role なら拒否)。同じバイトが今の行 (同じ demo) なら replay |
| RLS | admin の読み出しだけ (`sales_demo_facts_packs_admin_read`)。service role は他の sales_* 表と同じく SELECT / INSERT / UPDATE の権限 (`scripts/staging/lib.mjs` の REQUIRED_CHECKS) を持つが、trigger が書き込みを拒否する |
| 照合の証拠 | `sales_demo_copy_facts_checks.facts_pack_id` (新しい列) が保存先の行を名指す。trigger `sales_check_copy_facts_check_write` (置き換え) は、prospect の今の facts pack が review の facts pack と同じバイト・その review の demo の行・demo の content がそれを名指すときだけ書かせ、`facts_pack_id` を入れる。違えば `copy_facts_not_in_store`。**この migration より前の証拠 (`facts_pack_id` なし) は数えない** |
| 送信時の比べ直し | `sales_copy_send_block` (置き換え、`sales_demo_version_send_block` → `sales_send_guards` → 送信承認・送信画面を開く で毎回): 保存先から作った証拠だけを数え (なければ `demo_copy_facts_not_from_facts_path`)、`demo_copy_facts_stale` の後に、review の facts pack が prospect の今の facts pack と同じバイト・その行がこの demo のもの・demo の content がそれを名指す、を要求。新しい facts の行 (別のバイト) や不一致は **`demo_copy_facts_changed`** |

関数名は `sales_demo_` で始めない (DEV-196c の監査テストの数え方)。

### 2. サーバー

- `lib/sales/facts-store.ts` (新規): `loadCurrentFactsPack`・`registerFactsPackAsAdmin` (admin の session)・`registerFactsPackAsOperator` (service role + admin id)・`checkFactsPackForDemo` (FactsPack の schema、demo の content がこのバイトから導いたものか: `assertDemoContentFromFacts`)。
- `lib/demo-version-package/facts-content.ts` (新規、純粋): `local-inputs.ts` から導き方と内容の照合を移した (`local-inputs.ts` は re-export、CLI の挙動は不変)。`local-input-error.ts` に `LocalInputError`。
- `lib/sales/copy-review/gate.ts`: `ShopCopyState.factsStore` (今の facts pack と demo の content が名指す sha)、`factsChecks[].facts_pack_id`。`storeFactsChecks` (数える証拠)・`factsStoreMatches` (DB と同じ規則)。`evaluateVersionCopyGate` に `demo_copy_facts_changed` (DB と同じ順序)、`copyDecisionRefusals` の承認に `COPY_FACTS_CHANGED`。
- `lib/sales/copy-review/store.ts` `loadShopCopyState`: demo の `content->>facts_pack_sha256` と保存先の今の行を読む (読めなければ fail closed)。
- `lib/sales/copy-review/labels.ts`: `demo_copy_facts_changed` と `COPY_FACTS_CHANGED` の文言。`view.ts`: 「facts の経路から」は保存先から作った証拠だけ。
- `lib/demo-version-package/import.ts`: `factsFromStore` — 信頼できる facts pack を保存先 (prospect の今の行、この demo のもの) から読む。無ければ書く前に `FACTS_STORE_EMPTY`、別の demo の行なら `FACTS_STORE_OTHER_DEMO`、`trustedFactsPack` と同時なら `TRUSTED_FACTS_TWICE`。取り込みは保存先に書かない。
- `scripts/sales/demo-version/import-local.ts`: `--facts-from-store` (保存先から。今の行が demo の content と一致することを先に確かめる)。`--trusted-facts <コミット済み> --admin <admin の user id>` は**開発用の出どころ**: 従来の検査の後に保存先へ登録 (`sales_register_facts_pack_as`) してから保存先で取り込む。`--trusted-facts` は `--admin` が必須、`--facts-from-store` とは併用不可、`--seed-sendable` は どちらかが必須。
- 送信の門 (`approveSend` → `outreachCopyGate`) は gate.ts を通るので、サーバーも `demo_copy_facts_changed` で DB の前に止める。

### 3. 管理画面 (最小)

デモの版の頁 (`/admin/sales/demos/[prospectId]`、`SALES_DEMO_VERSIONS_ENABLED`、書き込みは `SALES_DEMO_QUALITY_REVIEW_ENABLED`) に「店舗の事実の登録」: 今の登録 (sha256 の先頭・日時・経路) を表示し、JSON を貼る → 「内容を確認」(サーバーで FactsPack の schema と demo の content との一致を検め、事実の一覧を表示) → 「この事実を登録する」(確認した sha256 と同じバイトであることをサーバーが再確認し、admin の session で `sales_register_facts_pack`)。`lib/admin/demo-facts-pack.ts`・`app/admin/sales/_actions/demo-versions.ts` の 2 つの action・`components/admin/demo/FactsPackRegistration.tsx`。旗 off なら何も読まず書かない (既存の action と同じ順序: 旗 → admin → 再確認 → DB)。

### 4. `.ai/tasks.json`

DEV-199b の `hard prerequisite` (送信の時点で facts pack を facts の経路と比べ直す) を外し、DEV-263f を足した。

## 既存のテストの変更

- `tests/unit/sales/copy-review/gate.test.ts`・`tests/unit/admin/demo-copy-review.test.tsx`: 状態の fixture に `factsStore` と `facts_pack_id` (保存先から作った証拠) を足した (型の追加)。期待値は不変。gate.test に DEV-263f の describe (4 件)。
- `tests/unit/sales/copy-review/gate.test.ts`「the database's sales_copy_send_block uses exactly these codes」・`tests/unit/sales/demo-version/admin-messages.test.ts` L4: 読む定義を最新の migration (`20261115000000` の `create or replace`) にした (code が 1 つ増えたため)。
- `tests/unit/demo-version-package/copy-package.test.ts`・`sendable-demo.test.ts`: importPackage の stub が保存先の読み出し (`order` + `limit`) に空で答える。`sendable-demo` の CLI の件は `--trusted-facts` に `--admin` を足し (無いと使い方の誤り)、`--admin` なし・`--facts-from-store` との併用が exit 2 になることを足した。
- `tests/unit/sales/demo-version/purity.test.ts`: 固定した importer の一覧に `components/admin/demo/FactsPackRegistration.tsx` (demo-versions の action を呼ぶ)。
- `tests/integration/demo-copy-send-guard.test.ts`・`demo-copy-decision.test.ts`・`demo-sendable-seed.test.ts`: facts の経路の代役 (`trustedFactsPack`) を、保存先への登録 (`registerFacts`: demo の content に名指させてから `sales_register_facts_pack_as`) + `factsFromStore` に置き換えた。DB が保存先なしの証拠を拒否するようになったため (意図した変更)。期待する拒否の code は不変。
- `tests/integration/helpers.ts`: `resetSalesData` の表に `sales_demo_facts_packs`、`nameFactsInContent`・`registerFacts`。
- `tests/e2e/sales-mvp-flow.spec.ts`: メールの経路は管理画面で facts を登録してから `--facts-from-store` で取り込む。Instagram の経路は `--trusted-facts … --admin <管理者>`。片付けに `sales_demo_facts_packs`。
- `scripts/staging/lib.mjs`・`tests/unit/staging/lib.test.ts`: `NO_DELETE_TABLES` に `sales_demo_facts_packs`。

## 既知の限界・開いている項目

- 実店舗の demo の content を facts pack から作る経路は、今は 環 の seed だけ (`demoContentFromFacts` は 輪 の鍵の写し方を一般化したもの)。管理画面の登録は、demo の content が**すでに**その pack から導かれているときだけ受け付ける (登録で content を書き換えない: 既存の版の facts が変わるため)。最初の実店舗の前に、登録と同時に content を作る経路 (候補の登録 / 取り込みの CLI) が別に要る (runbook B-2)。
- 正規の内容の hash は jsonb の正規形。copy-quality-review の `factsContentSha256` (正規化した key / value の組) とは別物 (DB で同じ正規化はできない)。送信の門はバイトの sha256 で比べる。
- 古い facts pack (A) → 新しい (B) → A を登録し直すと、最新の行は A のバイトになり、A で作った証拠がまた数える (同じバイトなので安全側)。
- service role は `sales_register_facts_pack_as` で任意の admin の id を名乗れる (service role の鍵は管理者と同じ信頼。生成側・包みの取り込みはこの関数を呼ばない)。

## Migration の計画

- ローカル: scratch のスタックに当て、統合テストの全体を流した (下の検証)。
- rollback: 下の SQL を 1 transaction で。統合テスト `tests/integration/demo-facts-store.test.ts` が、この block を取り消す transaction の中で流し、表・関数・列が消え、`sales_copy_send_block` が 20261113000000 の定義に戻ること、当て直すと古い証拠が数えないことを確かめる。

### hosted に当てるとき (別のオーナー承認が要る)

1. この PR が develop → `release/*` → main に入っていること。`20261111000000`〜`20261114000100` の後に当てる。
2. Staging: `scripts/staging/verify.mjs` の手順。新しい表は空で始まる。**既存の文章の照合の証拠は数えなくなる** (`facts_pack_id` なし) ので、版の送信は `demo_copy_facts_not_from_facts_path` で止まる (共有が無効なら今も `demo_not_shareable`)。店ごとに facts を登録し、同じ包みを取り込み直す (replay で証拠だけ足す) と戻る。
3. サーバーのコードと同時に出す。コードだけ先だと `loadShopCopyState` が表を読めず、版の送信は `demo_copy_review_unverifiable` (fail closed。React のデモは影響なし)。migration だけ先だと、古いサーバーは保存先の証拠を要求しないが DB が止める (fail closed)。
4. `notify pgrst, 'reload schema';`

## 検証 (ローカル、scratch のスタック `sr-dev263f`)

- 新規: `tests/integration/demo-facts-store.test.ts` (8): 登録 (admin の session・CLI の明示の admin・replay・最新が今の行・jsonb の hash)、拒否 (content が名指さない・形の誤り・admin でない・CLI が admin でない id)、表への直接の書き込み・update・delete の拒否と RLS・関数の権限 (SECURITY DEFINER は登録の 2 つだけ、内部の関数はどの API role も実行不可)、証拠が保存先の行を名指す (保存先なし・別の pack が今のときは記録しない、`FACTS_STORE_EMPTY`・`TRUSTED_FACTS_TWICE`)、保存先以前の証拠は数えない、送信時の比べ直し (新しい pack → DB とサーバーで `demo_copy_facts_changed`、送信の門全体は `demo_facts_changed`、古い pack を登録し直すと戻る、content が名指さなくなると止まる)、rollback と当て直し。
- 新規: `tests/unit/admin/demo-facts-pack.test.tsx` (7)、`gate.test.ts` の DEV-263f (4)。
- 統合の全体: 35 ファイル・528 件 pass (新しいファイルを含む)。
- e2e (production build、`PLAYWRIGHT_CHROMIUM_EXECUTABLE`、Storage あり): desktop の全体 99 passed (`sales-mvp-flow` 2 件を含む: メールは管理画面で facts を登録 → `--facts-from-store`、Instagram は `--trusted-facts --admin`)。
- unit: sales・admin・demo-version-package・staging・ai-tasks・demo-frame・quality-pipeline・isolation 89 ファイル pass (全体は PR に記す)。
- `tsc --noEmit`・`eslint` (全体)・`check:secrets`・`next build`: pass。

## Rollback SQL

<!-- rollback-sql:start -->
```sql
begin;
drop function public.sales_register_facts_pack_as(uuid, text, uuid);
drop function public.sales_register_facts_pack(uuid, text);
drop function public.sales_insert_facts_pack(uuid, text, uuid, text);
-- sales_copy_send_block: exactly the 20261113000000 definition (create or replace keeps its grants)
create or replace function public.sales_copy_send_block(p_version_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  q public.sales_demo_copy_reviews;
  o public.sales_demo_copy_owner_decisions;
begin
  select r.* into q from public.sales_demo_version_copy_links l
    join public.sales_demo_copy_reviews r on r.id = l.review_id
    where l.version_id = p_version_id;
  if q.id is null then
    return 'demo_copy_review_missing';
  end if;
  if not exists (select 1 from public.sales_demo_copy_facts_checks c where c.review_id = q.id and c.facts_sha256 = q.facts_sha256) then
    return 'demo_copy_facts_not_from_facts_path';
  end if;
  -- PR #262 M2: the facts-path check must have been made on the facts the version was generated from (the version's
  -- facts_sha256; the demo's current facts are compared with it by demo_facts_changed before this)
  if not exists (select 1 from public.sales_demo_copy_facts_checks c join public.sales_demo_versions v on v.id = p_version_id
                 where c.review_id = q.id and c.facts_sha256 = q.facts_sha256 and c.demo_facts_sha256 = v.facts_sha256) then
    return 'demo_copy_facts_stale';
  end if;
  -- the review's page must still be the version's page, and nothing may have followed it in its chain
  if (select f.sha256 from public.sales_demo_version_files f where f.version_id = p_version_id and f.path = 'page/index.html') is distinct from q.page_html_sha256
     or (select f.sha256 from public.sales_demo_version_files f where f.version_id = p_version_id and f.path = 'page/style.css') is distinct from q.page_css_sha256
     or exists (select 1 from public.sales_demo_copy_reviews n
                where n.prospect_id = q.prospect_id and n.lane = q.lane and n.facts_content_sha256 = q.facts_content_sha256 and n.round > q.round) then
    return 'demo_copy_review_stale';
  end if;
  if q.lane <> 'real_shop_proposal' or q.copy_verdict <> 'approve_candidate' then
    return 'demo_copy_review_not_passed';
  end if;
  if exists (select 1 from unnest(q.gate_blockers) b where b <> 'OWNER_APPROVAL_MISSING') then
    return 'demo_copy_send_blocked';
  end if;
  select * into o from public.sales_demo_copy_owner_decisions where review_id = q.id;
  if o.id is null or o.decision <> 'approve' or o.version_id <> p_version_id then
    return 'demo_copy_owner_confirmation_missing';
  end if;
  if row(o.review_sha256, o.facts_sha256, o.copy_sha256, o.page_html_sha256, o.page_css_sha256)
     is distinct from row(q.review_sha256, q.facts_sha256, q.copy_sha256, q.page_html_sha256, q.page_css_sha256) then
    return 'demo_copy_owner_confirmation_mismatch';
  end if;
  return null;
end;
$$;
-- sales_check_copy_facts_check_write: exactly the 20261113000000 definition
create or replace function public.sales_check_copy_facts_check_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'copy_facts_check_immutable' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.sales_demo_copy_reviews q where q.id = new.review_id and q.facts_sha256 = new.facts_sha256) then
    raise exception 'copy_facts_check_mismatch' using errcode = 'check_violation';
  end if;
  select public.sales_demo_facts_sha256(d) into new.demo_facts_sha256
    from public.sales_demo_copy_reviews q join public.sales_demos d on d.id = q.demo_id where q.id = new.review_id;
  new.checked_at := now();
  return new;
end;
$$;
alter table public.sales_demo_copy_facts_checks drop column facts_pack_id;
drop table public.sales_demo_facts_packs;
drop function public.sales_check_facts_pack_write();
delete from supabase_migrations.schema_migrations where version = '20261115000000';
commit;
```
<!-- rollback-sql:end -->
