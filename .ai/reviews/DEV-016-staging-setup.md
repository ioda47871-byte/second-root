# DEV-016 Staging setup scripts — fresh-context review

Scope: `scripts/staging/`, `docs/STAGING.md`, `.ai/blockers.md` HUMAN-004, and the tests. These scripts apply the migrations to the Staging Supabase project (`znbqgvawublgyjwfpmei`) through the Management API, because Claude Code cloud has HTTPS egress only.

## Round 1: PASS (Critical 0 / High 0 / Medium 3 / Low 6)

Verified:
- Secrets appear only in the `Authorization` header, never in URLs, logs or errors. Redaction covers every token and key, and `redirect: "error"` is set.
- The default is plan only. Drift exits with code 2. Vercel is written for Preview + branch only.
- Admin registration requires exactly one confirmed Auth user and refuses a second admin.
- Interpolated SQL is safe: every value is pattern-checked, and quotes are doubled.
- The 8 security queries are identical to the CI audit (`db-security-audit.test.ts`), plus: migration match, table existence, sign-up off, one admin.
- The Supabase and Vercel API usage matches the official references. No existing migration changed, and none contains explicit transaction control or `concurrently`.

| Sev | Finding | Resolution |
|---|---|---|
| Medium | Atomicity of a multi-statement Management API request was assumed, not verified | Fixed: `assertQuerySemantics` probes the real project before the first change. A failing two-statement request must leave nothing behind, otherwise the script cleans up and stops. Tests cover both a transactional DB and a simulated splitting API. |
| Medium | Vercel `upsert` could overwrite or re-target a variable that also serves Production | Fixed: existing env vars are listed first. If any of the 5 keys exists for Production/Development or another branch, the script stops; only an exact Preview + branch match is updated. |
| Medium | The role that runs the SQL (object owner and default grants) was unverified | Fixed: the probe requires `current_user = postgres`, the same as the CLI. |
| Low | Plan mode fetched the revealed keys | Fixed: keys are fetched only with `--apply` |
| Low | Any project ref accepted for writes | Fixed: `--confirm-ref` must repeat the ref for `apply --apply`, `admin` and `vercel` |
| Low | `JSON.parse` error could quote part of a key | Fixed: `parseJson` throws `non-JSON response (<status>)` without the body. Test added. |
| Low | Admin could be a deleted, banned or anonymous user | Fixed: those users are excluded |
| Low | `--apply no` was read as true | Fixed: `--apply` / `--auth` take no value. Test added. |
| Low | `NODE_USE_ENV_PROXY` inline / older Node | Fixed: `assertProxySupport` refuses to run behind the proxy without it (Node ≥ 22.21). The doc says to run these in the container via `npm run staging:*`. |

Still to verify live on the first run (the scripts check these themselves): the SQL role, request atomicity, and the scoped-PAT permission names (`docs/STAGING.md` §2).

## Round 2 (PR #35: explicit API grants + proxy-injected credential): PASS (Critical 0 / High 0 / Medium 0 / Low 4)

The reviewer simulated a project with no default privileges on the local DB, inside a transaction that was rolled back. Everything not granted explicitly by a migration was revoked from the API roles, then only the migrations' own grants and `20260928000000` were re-applied. Results:
- The full ingest run as service_role worked: start → status → discovered → verified → begin_persist → persist_candidate (`outreach_ready`) → finalize.
- The Instagram service functions worked.
- The admin screens' reads and admin RPCs worked for the signed-in admin.
- anon had no access at all.
- Without the new migration, the same run fails with `permission denied for table sales_agent_runs`. This negative control matches what was seen on Staging.

Nothing the app needs is still missing on a project without default privileges. Function EXECUTE, the views (`security_invoker`) and the absence of sequences were all confirmed.

| Sev | Finding | Resolution |
|---|---|---|
| Low | service_role gets DELETE on the 6 core tables, and INSERT/UPDATE on `sales_admins`, which the app does not use | Accepted. This matches the local stack the app has always been tested on. service_role is the server-only role and bypasses RLS anyway. Narrowing it is a separate hardening task. |
| Low | `REQUIRED_CHECKS` covers table privileges, not function EXECUTE | Accepted for now. Every function the app calls has an explicit grant (verified in the simulation). DEV-016 exercises the functions end to end on Staging. |
| Low | `explicitGrantGaps` can miss a gap (later revoke, column grants, block comments, views) | Accepted as a best-effort lint. The database check (`REQUIRED_CHECKS`, `has_table_privilege`) is the real guard and has a fail-closed test. |
| Low | The error message does not mention the proxy path | Accepted (it fails closed). |

## Round 3 (PR #36: optional Vercel protection bypass for the Staging Routine): PASS (Critical 0 / High 0 / Medium 0 / Low 4)

Verified:
- `x-vercel-protection-bypass` is Vercel's documented header. No bypass cookie is set.
- The header is sent only to `$SALES_AGENT_INGEST_URL`.
- The value is never printed, and the existing prompt-injection rule covers it.
- The curl example passes the value through a variable.
- A leaked value opens only Vercel's gate; the ingest API still needs its token.

All 4 Lows are fixed:
- The secret list now says that on Staging the bypass value is allowed in addition to the token.
- The count of environment variables in STAGING.md is corrected.
- SECURITY.md, AI_WORKFLOW.md and STAGING.md now record the bypass value as a Staging-only exception, including that it covers the whole Vercel project and must be rotated if exposed.
- The prompts never send the header when the ingest URL is the Production host.
