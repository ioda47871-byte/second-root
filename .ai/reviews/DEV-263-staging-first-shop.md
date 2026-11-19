# DEV-263 Fresh Review — PR #297 (Staging で営業 MVP を1店舗ぶん確かめる最短手順)

独立 Fresh Reviewer (別コンテキスト)、読み取りのみ。最終判定: Round 4 PASS at 3e2738053d5be3df4674ed19f49630d7d57917e8 (C0/H0/M0/L1)。L8 (option (a) で runbook B-3 の成果物 host の /admin 404 確認と B-4 の SALES_LOCAL_E2E_TEST_RECIPIENTS を置かないことを再掲) は runbook が正本として既に持つため、この PR では足さない。

# Fresh Review: PR #297 (feature/dev-263-staging-first-shop @ f2ec2b25, base develop 31f09ce9)

Scope: `docs/operations/staging-first-shop.md` (new, 72 lines) + one link line in `docs/operations/sales-mvp-runbook.md:148`.
Read-only review. Nothing pushed, no GitHub comment, no Supabase/Vercel call.

## Verdict: FAIL (Critical 0 / High 0 / Medium 3 / Low 6)

## Verified OK

- Migration list / order (9 files, `20261111000000` .. `20261117000000`), previous head `20261110000000`: matches `supabase/migrations/` and runbook B-1.
- `staging:apply` plan-only vs `--confirm-ref <ref> --apply`; stops on drift (incl. "pending older than newest applied"); 1 migration = 1 transaction; security checks after apply: matches `scripts/staging/apply.mjs`, `lib.mjs` `planMigrations` / `runChecks`, `docs/STAGING.md` §1・§3.
- `demo_version_sharing_disabled` check exists and requires off (`lib.mjs:285-306`); `storage_no_client_policies` (no storage policy) matches "storage policy は作らない".
- Bucket spec (private, 4MiB, 4 MIME) matches `supabase/config.toml:125-128` and runbook B-5a.
- `notify pgrst, 'reload schema';` matches runbook B-1. Env var names / values / redeploy (`frame-src` at build time) match runbook B-4 and `lib/sales/demo-version/flags.ts:105`.
- Share URL is public only after `sent`: `sales_resolve_demo_share` (`20261111000000_sales_demo_versions.sql`) requires `expires_at` and `state = 'sent'`; E2E asserts 404 before 送信済み (`tests/e2e/sales-mvp-flow.spec.ts:246-251, 376-395`). E2E has exactly 2 tests (email, Instagram).
- Fictional shop is refused at send approval with the switch off: `20261115000100_sales_test_recipient_guard.sql:146-150` (`^fictional-` -> `test_recipient_fictional_shop`). The doc keeps the switch off on hosted (does not weaken the gate). Good.
- `npx supabase db dump` flags `--db-url`, `-f`, `--data-only` exist (CLI help).
- PAT scoping / Revoke / "network secret for api.supabase.com, value never in chat" match `docs/STAGING.md` §2・§2.1. §0 is framed as read-only observations; no secret values, no project ref, only public domain names.
- Every 🛑 step is marked as owner approval first; nothing claims to have been executed.

## Medium

### M1. §5 (a) rests on an unverified, probably wrong Vercel claim — `docs/operations/staging-first-shop.md:50` (also :13)
"`all_except_custom_domains` なので、独自ドメインはログイン不要になる" for custom domains assigned to the **`develop` branch (Preview)**.
The repository only establishes that the **Production** custom domain `secondroot.jp` is unprotected under this mode (`docs/operations/design-bridge-access.md:21`, `docs/RELEASE_READINESS.md:279`, `docs/RELEASE.md:104`). Vercel's Standard Protection is documented as protecting everything except production custom domains; a branch-assigned (preview) custom domain is generally still behind Vercel Authentication. If so, the recommended option makes the owner create DNS + domains (an approval-gated, external change) and the cookie-less recipient and the artifact iframe still hit the Vercel login — and the natural "fix" at that point is to loosen Deployment Protection project-wide.
Fix: state this as unconfirmed; add a pre-check (after assigning the domain, a cookie-less `curl -I https://staging.<domain>/` must not redirect to `vercel.com/sso-api`) and say what to do if it does (stop and decide; do not turn off protection as a side effect). Alternatively cite a Vercel source for preview custom domains.

### M2. The fictional-shop run on Staging has no way to obtain a fictional prospect — `docs/operations/staging-first-shop.md:62`
"まず架空の店で: 管理画面で facts の登録 → …". On hosted, candidates are created only by the existing ingest (`docs/operations/real-shop-demo-workflow.md:97`: "この手順で候補は作らない"); `sales_create_demo_from_facts` / `sales_onboard_facts_demo` need an existing prospect (`20261116000000_sales_facts_demo_onboarding.sql:139-189`). The Staging DB's prospects come from DEV-016's real discovery (`docs/STAGING.md` §7), i.e. real Nagoya shops. As written, the operator must either attach a `fictional-…` facts pack to a real shop's prospect, or insert a prospect by ad-hoc SQL — neither is described or approved.
Fix: say exactly how the fictional prospect gets into Staging (e.g. an owner-approved ingest of one fictional candidate with a reserved-domain address through the existing ingest API, with its id recorded for cleanup), forbid attaching a fictional pack to an ingested real prospect, and add its cleanup to §8. Or drop the fictional run and say Staging checks only the real-shop path.

### M3. Option (b) is not carried through §6 / §7, and leads to a real send with a link the recipient cannot open — `docs/operations/staging-first-shop.md:51, 56, 61, 67`
§6 sets `SALES_DEMO_ARTIFACT_ORIGIN` / `SALES_DEMO_APP_ORIGIN` / `SALES_DEMO_BASE_URL` to "§5 の host", which does not exist under (b); §7.1 still turns the DB share switch on; §7.3 still proceeds to the first real shop on Staging. Under (b) the share URL stays behind Vercel login (§5 line 48), so a real shop would receive a proposal whose URL asks for a Vercel login. §5 line 52 even says the only externally viewable case on Staging is the real shop, which (b) excludes.
Fix: give the (b) branch explicitly: leave `SALES_DEMO_SHARE_ENABLED` / `SALES_DEMO_ARTIFACT_ORIGIN` / `SALES_DEMO_APP_ORIGIN` unset (admin preview then uses the app origin, `flags.ts:13`), keep the DB switch off and skip §7.1, and do **not** send to a real shop from Staging under (b) (§7.3 only after a working public host, or in Production).

## Low

- L1 `staging-first-shop.md:44` — `npm run staging:verify` lacks `-- --project-ref <ref>`; `verify.mjs:18` `assertRef` throws without it. Use `npm run staging:verify -- --project-ref <ref>` (as in `docs/STAGING.md` §3).
- L2 `staging-first-shop.md:36` — the dump: CLI needs Docker (pg_dump runs in a container), `--db-url` must be percent-encoded (CLI help), and the connection string carries the DB password: add "人の端末だけで、Claude・チャットに渡さない" (STAGING.md §1 keeps the DB password from Claude). Also note the default schema dump skips Supabase-managed schemas (auth/storage), so Storage objects are not in it.
- L3 `staging-first-shop.md:62-65` — the step list ends with "共有 URL を cookie なしのブラウザで開く" and the next lines say the fictional run cannot get there. Remove that step from the list to avoid confusion.
- L4 `staging-first-shop.md:41-44` — the doc relies on `sales_local_test_settings.local_test_recipients_enabled = false` (and runbook B-2's `sales_facts_registration_settings.operator_cli_enabled = false`) on hosted, but `runChecks` checks neither. Add a read-only `select` of both after apply (expect false) before §7.
- L5 `staging-first-shop.md:61` — the DB share switch is turned on before the fictional run, which by the doc's own account never reaches sharing. Turning it on just before the first real-shop share keeps the exposure window minimal (runbook B-5 order allows it, since B-6 follows).
- L6 `staging-first-shop.md:67` — the first real outreach would be recorded in the Staging DB with a Staging-host URL. Runbook B-6 does not say where the first real shop happens; state explicitly that this is the owner's intended place (or defer to Production) so the decision is visible at approval time.

# Round 2 (head be3a81087d89030be12a4bbc1e10db4e37ecfdd4)

## Verdict: FAIL (Critical 0 / High 0 / Medium 2 / Low 0)

## Round 1 findings

| # | Status | Where |
|---|---|---|
| M1 | Resolved. The custom-domain login is marked unconfirmed (:13, :56); there is a cookie-less check against `vercel.com/sso-api`, and the doc says to stop and report rather than loosen protection. | :13, :56 |
| M2 | Resolved as written: "no fictional pack on a real prospect"; one 環 prospect (`5e2d0a63-…263a00000001`, `fictional-bicycle-repair-tamaki`, matches `lib/demo-version-package/seed-sendable.ts:20,26`) inserted by the DB owner only with approval, or skip. However, its cleanup introduces N2. | :69-70 |
| M3 | Mostly resolved: (b) leaves share/origins unset, keeps the DB switch off, and sends no real shop from Staging (:57, :65, :73-74). However, the env split introduces N1. | :57-74 |
| L1 | Resolved (`--project-ref <ref>`). | :46 |
| L2 | Resolved (Docker, percent-encode, password stays on the human's machine, auth/storage not in the default dump). | :37-38 |
| L3 | Resolved. | :71-72 |
| L4 | Resolved. Both columns exist (`sales_local_test_settings.local_test_recipients_enabled`, `sales_facts_registration_settings.operator_cli_enabled`, as in runbook A-6). | :47-49 |
| L5 | Resolved (switch on only just before the first real-shop share). | :73 |
| L6 | Resolved (real send on Staging only under (a), and only as an explicit owner decision; the default is Production). | :74 |

## New findings

### N1 (Medium). Under (b) the admin preview cannot render: `SALES_DEMO_VIEW_SIGNING_KEY` is listed only for (a) — `docs/operations/staging-first-shop.md:63-65`
The admin preview frames and render images are served with signed view tokens: `lib/admin/demo-versions.ts:20` `signViewToken`, and `app/admin/sales/demos/[prospectId]/page.tsx:36-37` shows `signing_key_missing` ("…描画画像と頁を表示できません"). `lib/sales/demo-version/flags.ts:10-12` says that with the key missing, no token is issued and the screen shows no frame and no render. So under (b), the very thing (b) is meant to check on Staging cannot happen: PC 1440 / SP 390 preview, and therefore the owner's quality approval after viewing. Runbook B-4 lists the key without condition.
Fix: move `SALES_DEMO_VIEW_SIGNING_KEY` (new, Staging-only, ≥32 bytes) to "(a)・(b) 共通". `SALES_DEMO_ARTIFACT_ORIGIN` unset under (b) is fine: the admin preview then comes from the app origin (`flags.ts:13`).

### N2 (Medium). The §8 cleanup cannot be done without bypassing the append-only guards, and it bundles an irreversible Storage delete — `docs/operations/staging-first-shop.md:79` (with :70)
"その prospect と、そこから作られたデモ・版・facts の行を消す (Storage の版のファイルも)". These tables refuse DELETE in triggers that also fire for `postgres`:
- `sales_demo_facts_packs` (`20261115000000_sales_demo_facts_store.sql:77-78, 113-114`: any non-INSERT raises `facts_pack_immutable`).
- `sales_demo_copy_reviews` (`20261113000000…:188-189` `copy_review_delete_forbidden`).
- The other append-only / immutable stores: versions, files, quality reviews, copy checks, links, decisions, structure findings (`scripts/staging/lib.mjs:176-182` NO_DELETE_TABLES; `on delete restrict` FKs).

Locally, the E2E deletes only with `set local session_replication_role = replica` (`tests/e2e/sales-mvp-flow.spec.ts:94-103`), i.e. by switching the guards off. Doing that on hosted Staging is a safety-guard bypass. Deleting Storage objects is its own irreversible approval (DEV-196j, `.ai/tasks.json` DEV-196 triggers). Read as written, the doc implies a routine deletion, and the "SQL shown at approval" would have to disable triggers.
Fix: do not promise deletion. Say the fictional rows stay (inert: sending is refused by the DB guard, sharing never opens). If they must be removed, that is a separate owner approval that names the trigger bypass (`session_replication_role` or `disable trigger`), whether it is allowed at all on hosted, and the Storage deletion under DEV-196j. Alternatively, retire the demo with `disabled_at` instead of deleting it.

# Round 3 (head e4f019b00973956a95f5695af18af1feac7b5bfd)

## Verdict: FAIL (Critical 0 / High 0 / Medium 1 / Low 1)

## Round 2 findings

- **N1: resolved.** `SALES_DEMO_VIEW_SIGNING_KEY` is now in "(a)・(b) 共通" with the right reason (`staging-first-shop.md:63`).
- **N2: resolved, and the new §8 text is accurate:**
  - "行は消さない / DB の所有者の DELETE も trigger が拒む": correct. `sales_check_facts_pack_write` raises on any non-INSERT before any role check (`20261115000000…:77-78`, trigger `before insert or update or delete`, :113-114). `sales_demo_copy_reviews` raises `copy_review_delete_forbidden` (`20261113000000…:188-189`). The other stores are append-only or `on delete restrict`. Bypassing needs `session_replication_role` / disabling triggers, as the local E2E does (`tests/e2e/sales-mvp-flow.spec.ts:94`).
  - DNC disables the demo: `components/admin/DncControl.tsx` → `app/admin/sales/_actions/dnc.ts:17,24` `rpc("sales_set_dnc")` → `sales_set_dnc` → `sales_set_dnc_internal` (`20260927000300_sales_admin_outcomes.sql`). That sets `do_not_contact` and `update public.sales_demos set disabled_at = now()`. No later migration redefines it, and no trigger blocks it (only `sales_demos_touch` and the `approved_version_id` trigger). The UI confirm text says "デモも非公開になります".
  - A real deletion goes through a separate owner approval that names the trigger bypass and DEV-196j. Good.

## New / remaining findings

### N3 (Medium). §7.1 inserts only a prospect row, but §7.2's send approval needs an initial outreach draft — `docs/operations/staging-first-shop.md:70-71`
I should have caught this in Round 2. `sales_approve_outreach(p_outreach_id, p_draft_version, …)` (`20261111000000_sales_demo_versions.sql`) works on a `sales_outreaches` row with `status = 'drafted'`. The admin action `approveSend(outreachId, draftVersion, …)` (`app/admin/sales/_actions/send.ts:41,73`) runs from the Today card of that draft. On hosted, drafts are written by the worker. The E2E inserts one itself (`tests/e2e/sales-mvp-flow.spec.ts:127-135` `draftFor`).

With only "prospect 1行":
- no Today card exists;
- send approval, and so the `test_recipient_fictional_shop` refusal §7.2 sets out to confirm, is unreachable;
- the §8 "営業お断り" control, which lives only on the Today card and the history page (both driven by outreaches), is unreachable too.

The likely result is improvised extra SQL on hosted at run time. Channel eligibility (`sales_assert_channel_eligible`: the recorded contact source of the email) may need more rows as well.

Fix: in §7.1, list every row the owner-approved SQL inserts: the prospect with its reserved-domain email and the contact fields the send guards need, plus one `sales_outreaches` initial draft (`kind='initial'`, `channel='email'`, subject/body as in `draftFor`). Show them at approval time. Alternatively, limit the fictional run to facts → import → preview → quality/copy approval, and drop the send-approval refusal check (it is covered locally by the integration tests and E2E).

## Low

- L7 `staging-first-shop.md:80`: the control is labelled "営業不要（DNC）にする" (`components/admin/DncControl.tsx`), not "営業お断り". Use the on-screen label, and say where it is (the Today card / 履歴).

# Round 4 (head 3e2738053d5be3df4674ed19f49630d7d57917e8)

## Verdict: PASS (Critical 0 / High 0 / Medium 0 / Low 1)

## Round 3 findings

- **N3: resolved** (`staging-first-shop.md:69-73`).
  - The fictional run is off by default.
  - If the owner approves it, the approved SQL lists every row up front and no SQL is added mid-run: one prospect (the 環 fixed id, reserved-domain address) plus one initial email draft.
  - The doc states why the draft is needed: Today card → send approval / DNC. This matches `sales_approve_outreach` (needs a `drafted` outreach), `approveSend(outreachId, draftVersion…)` and the E2E `draftFor`.
  - §7.2 is limited to "1 を承認したときだけ".
- **L7: resolved** (:82). The label is "営業不要（DNC）にする" (`components/admin/DncControl.tsx`), on the Today card or the 履歴 page. 履歴 reads `sales_outreaches` (`lib/admin/history.ts:36-37`), so a prospect with a draft appears there.

## Full re-read (end to end), re-checked against the repo

- §0: framed as observations. Names only, no values or project ref. The custom-domain login is marked unconfirmed.
- §1: matches `docs/STAGING.md` §2 / §2.1 (scoped PAT, network secret, Revoke). The plan-only command is correct.
- §2: migration list, order and previous head `20261110000000` match. The drift stop matches `planMigrations`.
- §3: `db dump` flags exist. The Docker, percent-encoding and password-handling notes are right. "B-1 changes only `public` and the bucket" is consistent: the 9 migrations create policies only on `public.*`, and their `auth.` mentions are `auth.uid()` calls.
- §4: apply → reload → bucket (spec = `supabase/config.toml:125-128`) → verify with `--project-ref` → read-only check that both switches are false. Order and commands are correct.
- §5: (a) has the cookie-less check and stops rather than loosening protection. (b) sends no real shop from Staging.
- §6: the signing key is common to (a) and (b). Share/origins are set only under (a). Redeploy is noted (build-time `frame-src`).
- §7: the guard stays off on hosted. The share URL opens only after `sent` (`sales_resolve_demo_share`). The DB switch goes on only just before the first real-shop share, together with the `lib.mjs` check PR. A real send from Staging is an explicit owner decision.
- §8: no deletion. The append-only triggers are described correctly. DNC → `disabled_at` is verified (`sales_set_dnc_internal`). Real removal needs a separate approval naming the trigger bypass and DEV-196j.
- No secrets anywhere. No step weakens a gate. Every executing step is behind 🛑 owner approval. The runbook link line (`sales-mvp-runbook.md:148`) is accurate.

## Low

- L8 `staging-first-shop.md:55-56, 64`: under (a), the doc does not repeat two runbook checks:
  - B-3: after adding the artifact domain, confirm `/admin` returns 404 on the artifact host.
  - B-4: do not set `SALES_LOCAL_E2E_TEST_RECIPIENTS`.

  Both are in the runbook, which this doc names as canonical, so this is not blocking. One line in §5(a) / §6 would help.
