# DEV-199e: 文章品質監査の保存・オーナーの文章確認・送信の阻止 (copy send guard)

オーナー Issue #258 の判断①: 送信の阻止を採用。承認された範囲は「必要な DB の変更・送信の門のコード・ローカルのテスト」。Staging / Production の DB 変更と deploy は別の承認が要る (この PR はローカルの Supabase だけに当てた)。

branch `feature/dev-199e-copy-send-guard` (`origin/develop` 55df274c、DEV-199d merge 後から)。

**Staging / Production には何も当てていない。deploy・Vercel の env・実際の送信・画像生成・LLM の呼び出しもしていない。「輪」(SR-001) のデータ・オーナーの WSL / ローカル環境の設定には触れていない** (ローカルの検証は scratch に複製した別 project id のスタックで行った)。

## ファイル

- `supabase/migrations/20261113000000_sales_demo_copy_send_guard.sql` (新規) — 4 表・4 trigger・送信の門・記録の関数・オーナーの関数。
- `lib/sales/copy-review/gate.ts` (新規、純粋) — `planCopyAppend` (保存してよいか)・`evaluateVersionCopyGate` (送ってよいか)。
- `lib/sales/copy-review/store.ts` (新規) — 保存先の読み書き (client は呼び出し側のもの、env は読まない)。`loadShopCopyState`・`recordCopyReview`・`loadVersionCopyGate`・`outreachCopyGate`。
- `lib/sales/copy-review/labels.ts` (新規、import なし) — 拒否の code とオーナー向けの文言。
- `lib/demo-version-package/import.ts` — DB に書く前に保存先を読んで全 round を計画し、版の後に保存して最後の round を版に結び付ける。`ImportResult.storedCopy`。
- `lib/demo-version-package/copy.ts` — `verifyPackageCopy` の `ownerRevisions` (オーナーの保存先の改稿依頼)。`package.ts` は option の型を通すだけ。
- `app/admin/sales/_actions/send.ts` — `approveSend` が DB の前に `outreachCopyGate` を通す。`lib/sales/approval.ts` — DB の code の文言を `SEND_ERROR_LABEL` に追加。
- `scripts/staging/lib.mjs` — `NO_DELETE_TABLES` に新しい 4 表 (どの API role にも DELETE / TRUNCATE なし)。
- テスト: `tests/unit/sales/copy-review/{gate,send-guard}.test.ts`・`tests/unit/demo-version-package/copy-owner-revision.test.ts`・`tests/integration/demo-copy-send-guard.test.ts`・`tests/support/copy-review-fixture.ts` (新規)。
- 変更していない: `copy-quality-review.ts`・`copy-quality-page.ts`・`copy-record.ts`・`facts-pack.ts`・`lib/sales/demo-version/*` (事実・権利・HTML・manifest・画像の確認の検査)・既存の migration・prompt・skill・workflow・package.json / lockfile・「輪」の研究ファイルと seed / patch。

## 設計

### 保存先 (migration)

| 表 | 何 | 誰が書く | 書き換え |
|---|---|---|---|
| `sales_demo_copy_reviews` | 監査した review と、監査したバイト (review・copy record・facts pack・頁の HTML / CSS)。列 (verdict・copy verdict・next step・5 つの hash・round・前の review) は trigger が review の JSON から導出し、テキストを sha256 で照合 | service role (importer、`sales_record_copy_review`) | 不可 (update / delete は trigger が拒否、DELETE の権限なし) |
| `sales_demo_copy_facts_checks` | facts pack を facts の経路と照合した証拠 (review の facts_sha256 と同じであること) | service role | 不可 |
| `sales_demo_version_copy_links` | 版 → review (版の `page/index.html`・`page/style.css` の sha256 = review の hash、1 版に 1 review) | service role | 不可 |
| `sales_demo_copy_owner_decisions` | オーナーの approve / revise / reject。review id・review の sha256・facts / copy / HTML / CSS の hash・版に束縛 | **署名済みの sales admin 本人だけ** (`sales_decide_copy_review`、trigger が `is_sales_admin()` と `decided_by = auth.uid()` を要求) | 不可 (1 review に 1 件) |

鎖の規則 (trigger `sales_check_copy_review_write`、書く人によらず): 鎖は prospect + lane + `facts_content_sha256`。店ごとに advisory lock。別の shop_id の review は拒否。鎖が無ければ round 0 だけ。鎖があれば round 0 は `copy_review_round_0_replay`、round は鎖の長さ、`previous_copy_sha256` は最後の copy、facts のバイトは同じ、最後の round が改稿を許すこと (next step = revise、または実店舗で owner_review かつ round < 2 で、その review にオーナーの revise がある)。unique (prospect, lane, facts_content, round) でも二重を止める。表の check: gate_blockers は必ず `OWNER_APPROVAL_MISSING` を含み、架空レーンは `FICTIONAL_RESEARCH_NOT_SENDABLE`、copy verdict が approve_candidate でなければ `REVIEW_NOT_PASSED` を含む。

DB は監査を再実行できない。監査の再実行はサーバー (取り込みと送信の承認の前) の仕事で、DB はハッシュ・導出・鎖の順序・権限・送信の門を自分で検める。

### 既存の承認の流れとの関係 (なぜ別の表か)

オーナーの文章の確認は、既存の品質承認 (`sales_demo_quality_reviews`、7 項目・描画の確認・取り下げ) の**後ろにつながる送信の門**として足した。品質承認の表に入れなかった理由: (1) 7 項目の checklist は `sales_demo_checklist_valid` と管理画面・そのテストが固定しており、項目を足すと既存の承認の形が変わる。(2) 文章の確認は revise が鎖の次の round を開くという別の寿命を持ち、5 つの copy の hash に束縛される。(3) 品質承認は取り下げられる (active → withdrawn) が、オーナーの文章の記録は変えられない。流れとしては同じ: 品質承認と同じく admin の RPC (admin を最初に検める)・`sales_demo_note_valid` の note・`auth.uid()` への束縛・service role は書けない、で、使われる場所は既存の `sales_demo_version_send_block` (→ `sales_send_guards` → 承認・送信画面・送信済み) の中。

### facts の経路

facts の経路 (生成・改稿の側が書けない店舗の facts pack の保存先) は**まだ無い**。取り込みは `trustedFactsPack` が渡されたときだけ照合の証拠 (`sales_demo_copy_facts_checks`) を残す。`import-local.ts` は渡さないので、今の取り込みの結果はすべて `facts_from_facts_path = false` で送信不可 (オーナーも確認できない: `copy_facts_not_from_facts_path`)。証拠を review の列ではなく別の追記のみの表にしたのは、facts の経路ができた後に同じ包みを取り込み直せば (replay) 証拠だけを足せるようにするため (round 0 の再提出の規則で鎖が永久に送れなくなる罠を避ける)。統合テストで確認。

### 送信の門の順序と、版の共有が無効の間

`sales_demo_version_send_block` は、承認された版が無いデモ (React のデモ) では今までどおり最初に null を返す。版があれば既存の 4 つ (版が使える・品質承認・facts・共有できる) の**後**に `sales_copy_send_block` を見る。版の共有は DEV-196g まで定数 false なので、版の送信は今も `demo_not_shareable` で止まる (既存のテスト・管理画面の表示と同じ)。共有が有効になる日には文章の門がそのまま残る。統合テストは、共有の関数を**取り消す transaction の中で** true に置き換えて、門が版の経路で効くことを確かめた。サーバーの `approveSend` は DB の前に文章の門を通すので、オーナーには文章の理由が先に出る。

拒否の code (DB と `labels.ts`):

| code | いつ |
|---|---|
| `demo_copy_review_missing` | 版に結び付いた review が無い (既存の版・v1 の包み・copy の無い取り込み) |
| `demo_copy_facts_not_from_facts_path` | facts の経路との照合の証拠が無い |
| `demo_copy_review_stale` | review の HTML / CSS の hash が版のファイルと違う、または同じ鎖に後の round がある |
| `demo_copy_review_not_passed` | 実店舗レーンでない、または copy verdict が approve_candidate でない |
| `demo_copy_send_blocked` | 保存した gate (`copyGateSendBlockers`、オーナーなし) に `OWNER_APPROVAL_MISSING` 以外が残る。サーバーは保存したバイトで監査を再実行し、残れば同じ code |
| `demo_copy_owner_confirmation_missing` | オーナーの approve が無い (revise / reject / 別の版での approve を含む) |
| `demo_copy_owner_confirmation_mismatch` | オーナーの記録の hash が review と違う (trigger が書かせないので通常は起きない。サーバーの再監査で `OWNER_APPROVAL_FOR_OTHER_INPUTS` も同じ) |
| `demo_copy_review_unverifiable` | サーバーだけ: 保存先を読めない (fail closed) |

### 取り込み (DEV-199a / DEV-199d の引き継ぎ)

1. v2 の包みなら、DB に書く前に店の保存済み review・オーナーの記録・照合の証拠を読む。
2. `checkPackageCopy` にオーナーの保存先の改稿依頼だけを `ownerRevisions` として渡す (包みからは読まない)。
3. 各 round (前の round から) を `planCopyAppend` で計画: `copyReviewAppendBlockers(店の保存済み review 全部 (保存順), 提出, { ownerRevision: 鎖の最後へのオーナーの revise })` と `checkCopyQualityReview(提出, ファイル, { previous: 保存済みの鎖 (ownerRevision 付き), photoUrls: 頁の写真 })` の**両方**。gate は同じ `previous`・`photoUrls` で `copyGateSendBlockers(…, null, …)`。どれかが落ちれば `COPY_NOT_APPENDABLE` で、**版を取り込む前に**拒否 (round 0 の再提出もここ)。
4. 版を ingest・upload・検証した後に、round を順に `sales_record_copy_review` で保存 (同じ review は replay)、最後を版に結び付ける。DB の trigger が鎖を検め直す。

`buildPackage` / `readPackage` はオーナーの保存先を読まない。実店舗の owner_review の round に続く鎖は、そこでは「依頼があったものとして」形だけ検め、取り込み (保存先の記録だけ) と DB (revise の記録が要る) が決める (`copy.ts` の `ownerRevisionFor`)。架空レーンには適用しない (DEV-199d の「broken chains」のテストのとおり拒否のまま)。

### 関数名

新しい関数は `sales_demo_` で始めない (`sales_copy_*`・`sales_check_copy_*`・`sales_record_copy_review`・`sales_decide_copy_review`)。DEV-196c の監査テストが `sales_demo_*` の関数を数えて固定しているため。新しい関数の権限は新しい統合テストが固定 (`sales_decide_copy_review` だけ SECURITY DEFINER・authenticated、他は service role だけ)。

## 既存のデータと React のデモ (legacy)

- 埋め戻しはしない。既存の版には review が無いので、版の経路では `demo_copy_review_missing` で送れない (共有が無効なので今も `demo_not_shareable` で止まっている)。
- 承認された版の無いデモ (template + facts text の React のデモ) は `sales_demo_version_send_block` が最初に null を返し、サーバーの門も `legacy` で何もしない。既存の送信承認の hash (`sales_demo_version`) も変えていない。
- 既存の事実・権利・画像の確認の検査は変更していない。版の共有は無効のまま。
- 統合テスト: 既存のデータ (送信承認のある React のデモ・品質承認済みの版) の上で、取り消す transaction の中で rollback → migration を当て直し、版・承認の行が完全に同じ・新しい表は空・React のデモは null・版は review が無いので送れないことを確認。

## Migration の計画

- ローカル: `supabase/migrations/20261113000000_sales_demo_copy_send_guard.sql`。scratch に複製した別 project id のスタックに当て、統合テストの全体を流した。
- rollback: 下の SQL。確認 (ローカル): migration なしで reset した DB の `pg_dump --schema-only --schema=public` (6930 行) と、migration を当ててから rollback を流した後の dump が完全に一致 (`\restrict` の行を除いて差分 0 行)。当て直した後の dump も当てた直後と一致。
- 前方のみ。既存の表には列も行も足さない (`sales_demo_version_send_block` を置き換えるだけ)。

### Staging / Production に当てるとき (別のオーナー承認が要る)

1. 承認された PR が develop → `release/*` → main に入っていること (`docs/operations/release-branch.md`)。
2. Staging: `scripts/staging/verify.mjs` の手順で migration を当て、`SECURITY_CHECKS`・`REQUIRED_CHECKS` (新しい 4 表は `NO_DELETE_TABLES`) が通ること。新しい表は空で始まる。既存の版はすべて版の経路で送信不可になる (共有が無効なので実際の挙動は変わらない)。
3. サーバーのコード (`approveSend` の文章の門・取り込みの保存) は migration と同時に出すこと。コードだけ先に出すと、承認された版のあるデモの送信承認は保存先を読めず `demo_copy_review_unverifiable` で止まる (fail closed。React のデモは影響なし)。migration だけ先に当てると、取り込みは保存しないが DB が版の送信を止める (fail closed)。
4. Production も同じ。オーナーの文章の確認の画面はまだ無い (RPC だけ)。版の送信を実際に通すには、facts の経路・確認の画面・版の共有 (DEV-196g) がそれぞれ別の承認で要る。
5. 戻すときは下の rollback SQL を 1 transaction で (保存された review・オーナーの記録は消える。消す前に人が判断する)。

## 既存のテストの変更

- `tests/unit/demo-version-package/copy-package.test.ts`: importPackage の stub が保存先の読み出し (`order`・`in`・`sales_demos` の prospect_id) に答えるようにし、v2 の取り込みの RPC の期待を `["sales_ingest_demo_version"]` → `["sales_ingest_demo_version", "sales_record_copy_review"]` に (DEV-199e が保存する意図した変更)。拒否の 2 つのテストは変更なしで通る (保存先の読み出しは書き込みではなく、ingest の前に拒否される)。
- `tests/unit/design-agent/quality-pipeline/copy-quality-review.test.ts`: isolation の呼び出し元の一覧に `lib/sales/copy-review/gate.ts` を追加 (DEV-199d と同じ扱い)。
- `tests/unit/staging/lib.test.ts`: 固定した `NO_DELETE_TABLES` の一覧に新しい 4 表を追加。
- `tests/integration/helpers.ts`: `resetSalesData` の表に新しい 4 表を追加。

## 既知の限界

- **fail の review は保存されない**: DEV-199d の検査は fail の包みを DB の前に拒否するので、fail の round 0 は記録に残らず、直したコピーを新しい round 0 として出し直せる。fail は終端なので送信の安全には影響しない (直したものも監査・オーナーの確認を通る) が、「fail の後に改稿させない」ことは店をまたいで強制していない。fail も保存するなら DEV-199d の拒否の扱いを変える必要がある (判断待ち)。
- **facts の経路が無い**: 上記。照合の時点の facts pack と、送信の時点の facts の経路の中身の比較 (経路の facts が後で変わった場合) は、経路ができたときに送信の門へ足す必要がある。版の facts (`sales_demos.content`) が変わった場合は既存の `demo_facts_changed` が止める。
- オーナーの記録は 1 review に 1 件。同じ頁で描画だけが違う 2 つ目の版は同じ review に結び付くが、オーナーの approve は最初の版のものなので 2 つ目は送れない (閉じる側)。
- オーナーの文章の確認の画面は作っていない (RPC だけ。画面は別の Task)。
- サーバーの文章の門は `approveSend` だけ。送信画面を開く・送信済みは DB の門 (`sales_send_guards`) が毎回検める (文章の記録は変えられないので、承認の後に状態が変わるのは後の round が足された場合だけで、それも DB が止める)。
- DB は監査を再実行できない。service role が保存する review の中身はサーバーの検査に依存する (DB はハッシュ・導出・順序・権限を検める)。

## 検証

- `tests/unit/sales/copy-review/gate.test.ts` (19 件)・`send-guard.test.ts` (11 件)・`tests/unit/demo-version-package/copy-owner-revision.test.ts` (2 件)。
- `tests/integration/demo-copy-send-guard.test.ts` (14 件): 正常系、各拒否理由 (DB とサーバー)、facts の照合を後から足せること、round 0 の再提出 (取り込みは版の前に拒否・DB も拒否)、オーナーの改稿依頼を明示の段として、追記のみ・変更不可・削除不可、RLS と権限、React のデモ、既存データの上での rollback と migration。
- 統合の全体 (ローカル): 30 ファイル・493 件 pass。
- unit の全体: このサンドボックスでは Chromium (playwright の版) が無く、243 ファイル中 69 ファイル (design-agent の描画・worker・CLI の 68 と、`swap-photos.test.ts` の描画の 2 件) が環境 (ブラウザの起動・描画) で落ちる。落ちたのはどれもブラウザ・描画・worker の件で (`swap-photos.test.ts` の importPackage の件は pass)、diff の挙動を見る件ではない。それ以外 (sales・admin・demo-version-package・staging・ai-tasks・copy-quality-review など) はすべて pass。
- `npm run typecheck`・`npm run lint`・`npm run check:secrets`: pass。

## Rollback SQL

ローカル (または後に別承認で当てた環境) で戻すときに、人の判断で 1 transaction として流す。統合テスト `tests/integration/demo-copy-send-guard.test.ts` が、この block を **取り消す transaction の中で** 流し、既存データの上で migration を当て直して確かめる。

<!-- rollback-sql:start -->
```sql
begin;
drop function public.sales_decide_copy_review(uuid, uuid, text, text, text, text, text, text, text);
drop function public.sales_record_copy_review(uuid, uuid, text, text, text, text, text, text[], boolean);
-- sales_demo_version_send_block: exactly the 20261111000000 definition (create or replace keeps its grants)
create or replace function public.sales_demo_version_send_block(d public.sales_demos)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
begin
  if d.approved_version_id is null then
    return null;
  end if;
  select * into v from public.sales_demo_versions where id = d.approved_version_id;
  if not found or v.demo_id <> d.id or v.status <> 'approved' or v.revoked_at is not null or v.expires_at <= now() then
    return 'demo_version_unavailable';
  end if;
  if not exists (
    select 1 from public.sales_demo_quality_reviews r
    where r.version_id = v.id and r.decision = 'approved' and r.state = 'active'
      and r.bundle_sha256 = v.bundle_sha256 and r.facts_sha256 = v.facts_sha256) then
    return 'demo_quality_not_approved';
  end if;
  if v.facts_sha256 <> public.sales_demo_facts_sha256(d) then
    return 'demo_facts_changed';
  end if;
  if not public.sales_demo_version_shareable(v.id) then
    return 'demo_not_shareable';
  end if;
  return null;
end;
$$;
drop function public.sales_copy_send_block(uuid);
drop table public.sales_demo_copy_owner_decisions;
drop table public.sales_demo_version_copy_links;
drop table public.sales_demo_copy_facts_checks;
drop table public.sales_demo_copy_reviews;
drop function public.sales_check_copy_decision_write();
drop function public.sales_check_version_copy_link_write();
drop function public.sales_check_copy_facts_check_write();
drop function public.sales_check_copy_review_write();
drop function public.sales_copy_codes_valid(text[]);
delete from supabase_migrations.schema_migrations where version = '20261113000000';
commit;
```
<!-- rollback-sql:end -->
