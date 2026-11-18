# Review record — task DEV-139 ほし窯 photo run enable

- PR: #289 (ioda47871-byte/second-root) "enable the owner-approved one-time ほし窯 photo run + localhost-only DB allowance"
- Branch: feature/dev-139-hoshigama-photo-run-enable
- Reviewed SHA: 82fb621daf32e93d32c749b95e8ed69c3f4ad1c7 (base develop da3f68cc)
- Reviewer: independent Fresh Reviewer (separate context)
- Date: 2026-11-18

## Verdict: PASS

Counts: Critical 0 / High 0 / Medium 0 / Low 1 / Info 5

Nothing was executed against a real system: no generation, worker, cycle.sh, Supabase or DB write.

## Scope vs owner approval (2026-11-18)

- Prompt file `docs/design/hoshigama-ai-photo-prompt.txt` is unchanged in this PR. Recomputed SHA-256 = 372f7802101f679a519bca9ee2af57a07cbd6faf9df5371b70888e9a7ce3a8f6, 2007 bytes / 1988 chars. Run prompt a7b7d524…62be7f1 / 2668 chars. Both are pinned as literals in photo-swap-hoshigama.test.ts:74,77,146-150,173-177, autorun-shops.test.ts:146 and hoshigama-real-path.test.ts (RUN_SHA).
- `HOSHIGAMA_APPROVAL` (hoshigama-ai-photos.ts:99-116) records bakery, d2-v2, jobs 1, max_image_calls 3, codex_runs 1, timeout_minutes 15, retry false, upscale_allowed [ph-mouth-pc, ph-loaf]. The upscale cap stays HOSHIGAMA_MAX_UPSCALE = 2. No approval id or expiry is in code.
- Enforcement: maxImages 3 (HOSHIGAMA_PHOTOS_MAX_IMAGES), root allowlist `bakery:3`, CODEX_TIMEOUT_MS 15 min (image-autorun.ts:74, asserted ≤15 min in the full-chain test), one generate call per job, max_jobs 1, a one-use ledger, no timer and no retry path added.
- The swap spec takes bakery pages ["d2-v2"] only, with aiDemoPromptSha256 pinned to the core prompt.
- tsugute and bicycle entries are unchanged (only the test lists grew). No other shop changed.
- Not in the diff: workflows, package.json, lockfile, migrations, isolation tests, or model names.

## Gates still required (worker / root)

- These are unchanged and shop-agnostic: the root switch entry for the exact job, root's atomic approval/job use markers, the 20-min boot-bound grant (GRANT_TTL=1200 pinned), the worker one-use ledger, the 24 h window and expiry, and refusal of the consumed つぐ手 id.
- hoshigama-real-path.test.ts proves 0 calls on the injected generator, 0 calls on the mocked real `generateImagesInOneRun` and 0 on the sandbox spy. It also shows no ledger marker and an empty out dir for each of these cases: no entry, entry for another job, switch off, no grant, core SHA instead of the run SHA, other page, wrong or reordered slot ids, 4 images, window over 24 h, consumed id, and checkout bytes changed.
- The full chain runs exactly once. A second job under the same approval returns REFUSED_APPROVAL_REUSED.
- Module-load throw in autorun-shops.ts:69-73: if the approval were null, the import fails closed and no run is possible. It cannot be reached today because tests pin the record.

## cycle.sh

- Changed lines: the allowlist line and one comment line only (`IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6 bakery:3'`).
- Recomputed the pins in the run sheet:
  - file SHA-256: 000a566b49f794b9e358400ddc404ba929a167f09bdf38f9f160ed2b68464a58 (matches)
  - 334f771 file SHA-256: 8beb350dcc7b85a78c0ea060638d4922362d02d25e8eba1d798152fe2d146dab (matches)
  - `git diff --no-color --full-index 334f771f… HEAD -- cycle.sh | sha256sum`: 520fb507180e257a8892c47b8ee243ebf45b67b96e640747be209eae0a511b5a (matches)
- The python matcher test gives: bakery:3 MATCH, bakery:4 MISMATCH, sento MISMATCH, bicycle and tsugute MATCH.

## Local DB patch

- The SQL lives in scripts/sales/demo-version, not supabase/migrations. No migration references it (unit test). CI's deploy and migration paths do not apply it. It is applied only by the apply script, and `supabase db reset` reverts it.
- Apply script:
  - Rejects bad arguments (exit 2).
  - Without the flag it throws HOSHIGAMA_PATCH_FLAG_MISSING before connecting.
  - assertLocalDbUrl (unchanged, reviewed in #255) was probed in this review. It refuses all of these: localhost.evil.com, 127.0.0.1@evil.com, ?host= (both directions), a #fragment, [::1], nip.io, %-encoded host, LOCALHOST, 0x7f000001, 127.1, a multi-host list, a socket ?host=/tmp, and PGHOST/PGHOSTADDR/PGSERVICE/PGSERVICEFILE.
  - `evil.com\@127.0.0.1` is accepted, but it parses as host 127.0.0.1 (the backslash part becomes the password). The explicit config then connects only to 127.0.0.1, so this is not a bypass.
- Markers:
  - id = S0_PROSPECT_ID, plus the exact name, normalized name, address and normalized address. A unit test pins these to s0RegistryRow of the committed facts pack.
  - Instagram must be null.
  - Each contact must be null or the exact example.com value.
  - recommended_channel must be null or email.
  - Every sales_sources row must be the example email, with source_url starting with `https://s0-bakery.example.com/` (trailing slash, host-anchored).
  - The table check is row-local by id. The trigger refuses any other source_kind carrying ai_demo_internal.
- Integration test (CI integration job: success on this SHA):
  - Refused: a real shop, a look-alike, 輪, each marker break, and a non-AI kind carrying ai_demo_internal.
  - The derivation branches and immutability are covered.
  - The versions are unshareable: share_eligible false, image shareable false, versioned sharing off, and no send approvals.
  - It is hermetic: begin/rollback plus savepoints, and the schema is asserted restored.
- `patchedImageWriteFunction(migration, edits = RIN_PATCH_FUNCTION_EDITS)`: the 輪 output is byte-identical (default argument; local-rin-ai-photos.sql is untouched; the 輪 unit tests pass).
- import.ts:
  - S0 is allowed only via AI_DEMO_PROSPECT_IDS.
  - It also requires every image to be ai_generated_demo / ai_demo_internal / public_web false, with by_status containing only ai_demo_internal. This also tightens 輪 safely.
  - The migration's share and send functions exclude AI images (sales_demo_image_shareable, the send guard's `demo_not_shareable`), so nothing becomes sendable or shareable even though S0 has an example.com email.

## Run sheet

- (a) is read-only.
- (b) does these things before checkout: backs up the HEAD, checks ancestry and develop, refuses if develop moved the worker code, and pins the diff SHA plus a typed `yes`. After checkout it re-checks the file, unit, allowlist and prompt SHAs.
- (d) checks: ID formats, expiry within 24 h, requested_at, consumed and used markers on root and worker. EXP/REQ are placeholders; a literal placeholder STOPs on the format check. The approval and job ids are pre-filled proposals that the owner is told to fill or change.
- (e) starts the one-shot. (f) verifies results and that worker_commit matches the PIN.
- (g) does the OFF step: it removes only `/etc/sr-design-worker/image-autorun.json` and keeps the use markers. The removal PR is planned.
- (i) says no retry and gives a rollback to 334f771.
- j-* is local only. The destructive commands are `npx supabase db reset` (on the owner's local stack, gated on the owner's decision) and `rm -rf -- "$T"` (a mktemp path; empty if unset).

## Findings

### L1 (Low) — bakery real-path test lacks some missing-link cases
tests/unit/design-agent/hoshigama-real-path.test.ts:150-163.

The refusal table has no bakery-specific case for:
- an approval whose expires_at is in the past (REFUSED_APPROVAL_EXPIRED)
- a stale or expired grant
- a grant with another boot_id
- a grant for other job bytes or another job id

Scenario: a future shop-specific branch could skip one of these checks for bakery only, and this file would not notice. Mitigation: the worker code path is shop-agnostic, and image-autorun.test.ts:218,380-410 covers all of these for つぐ手.

Fix: add 3–4 rows to the bakery table (expired entry/scope, grant expires_at in the past, grant boot_id mismatch, grant job_sha256 of other bytes), each asserting 0 generate calls and no marker.

### Info
- I1: `patchedImageWriteFunction` still throws `RIN_PATCH_EDIT_NOT_UNIQUE` for the ほし窯 edits (local-rin-patch.ts:83). This is cosmetic.
- I2: The module-load throw in autorun-shops.ts makes the whole worker manifest fail to import if HOSHIGAMA_APPROVAL ever becomes null. That is fail closed, but it would also block つぐ手 and 輪. The (g) PR should remove the bakery entry and the throw together, or keep the record, as the sheet says.
- I3: The trigger checks the markers only at INSERT. AI rows stay if S0's row later changes. This is the same as the 輪 precedent, and the rows stay unshareable through the migration's share functions.
- I4: `bicycle:6` is still listed from DEV-192. The precedent run had no removal PR. This is out of scope here, but the owner may want the same (g)-style removal for 輪.
- I5: `assertLocalDbUrl` accepts `user:pw@evil.com\@127.0.0.1`. It resolves to host 127.0.0.1 and connects locally, so it is not exploitable.

## Commands / results
- `npm ci`: OK
- `vitest run autorun-shops, hoshigama-real-path, quality-pipeline, tests/unit/sales, tests/unit/demo-version-package` (PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium): 89 files, 1801 passed, 1 failed. The failure is fidelity-measure.test.ts "輪: B keeps about half…" (words_broken). It fails identically on develop da3f68cc, so it is environmental and not caused by this PR.
- `vitest run tests/unit/design-worker-cycle.test.ts image-autorun bicycle-real-path-off tsugute-ai-photos w0-window-check phase2f/isolation three-methods/isolation photo-worker design-image-approved-one-shot`: 9 files, 316 passed.
- All changed unit tests plus demo-version-package: 13 files, 240 passed.
- eslint on the changed files: 0 problems. `npx next typegen && npx tsc --noEmit`: 0 errors.
- CI on 82fb621 at review time: static, build, integration and e2e succeeded; unit, shop-css and e2e-sales were still in progress.
- Integration was not run locally (Supabase was not started, per the instructions); CI integration passed.

## Disposition (merge decision)
- PASS at 82fb621d (C/H/M 0, Low 1, Info 5). Scope matches the owner's 2026-11-18 approval; all existing run gates remain required.
- Carried to the (g) removal PR after the run: L1 add bakery rows for expired approval / expired grant / other-boot grant / other-job-bytes grant (0 generate calls, no marker); I2 remove the bakery manifest entry together with its load-time approval check; I4 note for the owner: bicycle:6 is still in IMAGE_AUTORUN_SHOPS from DEV-192 (no removal PR was made) — propose the same removal.
- Nothing has been executed: no generation, worker run, root switch or DB write. The owner runs the sheet on WSL.
- This commit adds only this record; the reviewed code is 82fb621d.
