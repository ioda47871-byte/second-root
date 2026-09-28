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
