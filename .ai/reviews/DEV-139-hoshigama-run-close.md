# Review record — task DEV-139 / Issue #290 P0: close the used one-time ほし窯 run

- Branch: feature/dev-139-close-hoshigama-run (not pushed at review time; no PR number yet)
- Reviewed SHA: 562c8bdf (`git diff 573e7935 562c8bdf`, base origin/develop 573e7935afa7dc7ddf66ac4fbbd81206900f9987)
- Reviewer: independent Fresh Reviewer (separate context, read-only except this record)
- Date: 2026-11-19
- Owner instructions: Issue #290 P0 (items 1-5). Evidence that the run was used: Issue #139 comment 6990007019 (read as data).

## Verdict: PASS

Counts: Critical 0 / High 0 / Medium 0 / Low 2 / Info 3

Nothing was run against a real system. No generation, worker, cycle.sh run, systemd, root clone, Supabase or DB write.

## P0 requirements vs the diff

| # | Requirement | Result |
|---|---|---|
| 1 | The used approval/job is never used again, not under a new id either | Met. ほし窯 is gone from `AUTORUN_SHOPS`. The job schema's `shop_id` / `approval_scope.shop` are `z.enum(AUTORUN_SHOP_IDS)`, so any `bakery` job gets `REFUSED_JOB_INVALID` before the ledger, switch, grant or generator. Root's allowlist no longer has `bakery:3`, so root's matcher gives `IMAGE_GRANT_SCOPE_MISMATCH` before any grant, whatever the id. `CLOSED_SHOPS.bakery` records the used approval record. If the same id is put back into `AUTORUN_SHOPS`, the module throws `AUTORUN_SHOP_CLOSED:bakery` on load. |
| 2 | Remove `AUTORUN_SHOPS.bakery` and root `bakery:3`; update tests | Met. Also removed: the ほし窯 bundle writer from `image-autorun.ts` `BUNDLE_WRITERS`, and the hoshigama imports from the worker. The bundle type is now `Record<AutorunShop["bundle"], …>`. |
| 3 | Keep offline intake/swap/package and their evidence | Met. Still present and unchanged: `HOSHIGAMA_APPROVAL`, both prompt pins (core `372f7802…a8f6`, run `a7b7d524…62be7f1`/2668), `SWAP_SHOP_SPECS.bakery.aiDemoAllowed` + `aiDemoPromptSha256`, `importHoshigamaAiPhotos`, `writeHoshigamaPhotos*` (bundle schema for verifying) and the local patch. Only comments changed in those lib files. The tests pass (below). |
| 3b | Do not loosen output permissions / send prevention | Met. No change to rights, `public_web:false`, demo-only, upscale cap 2, the import/share/send guards or the local DB patch. |
| 4 | Do not remove `bicycle:6`; proposal only | Met in code: `bicycle:6` and `AUTORUN_SHOPS.bicycle` are unchanged. The proposal text is not in the repo diff (L1). |
| 5 | WSL owner steps prepared, not executed; SHAs pinned | Met. See run sheet (k) below. |
| — | Protected Scope | No change to `.github/**`, package.json/lockfile, migrations, RLS, CI checks or isolation tests. No tests were skipped or deleted except the ones that tested the now-closed open path (see Tests). |

## Remaining paths to a real ほし窯 image call (searched)

- Worker (`image-autorun.ts`): the shop enum and `AUTORUN_SHOPS[job.shop_id]` are the only source of page, prompt and bundle. A job under `tsugute`/`bicycle` that carries ほし窯's page, slot ids and run SHA fails the `page` / `brief_sha256` / `slot_ids` equality checks: `REFUSED_JOB_INVALID`, 0 calls (tested). The prompt is built in code per shop, and the job can carry no free text (schema test).
- `worker.ts`, `run.sh`, `cycle.sh`: no hoshigama import, prompt builder, writer or schema name (asserted by test). `cycle.sh` contains no `bakery`/`hoshigama`/`ほし窯`. `IMAGE_AUTORUN_SHOPS` is assigned as a literal, so the environment cannot override it.
- Other generation entries that call `image-once`: `tsugute-photos.ts` (つぐ手 only) and `phase2f-image.ts` (Info 1).
- `buildHoshigamaRunPrompt` / `writeHoshigamaPhotosForRun` are still exported, but no executable path calls them now: grep found only the lib itself and tests. Neither function calls a model.

## cycle.sh restoration and run-sheet pins (recomputed)

- `git show 334f771:scripts/sales-design-worker/cycle.sh | sha256sum` = `8beb350dcc7b85a78c0ea060638d4922362d02d25e8eba1d798152fe2d146dab`. At 562c8bdf, both the committed blob and the working file give the same hash. `git diff --quiet 334f771 562c8bdf -- cycle.sh` reports no difference. The file is byte-identical.
- 573e7935 file: `000a566b…4a58` (matches the sheet).
- `git diff --no-color --full-index 573e7935afa7… 562c8bdf -- scripts/sales-design-worker/cycle.sh | sha256sum` = `c2dc2d2058bb3db2cef0c6bd39b545b7b9cb56130d2a11c8e7c53f02c29f83e7`. This matches (k). The value is deterministic for any merge SHA whose cycle.sh equals 334f771, because both endpoint blobs are fixed.
- Root-run file set (`scripts/sales-design-capture`, `cycle.sh`, `systemd`, `scripts/ops`, `scripts/sales-design-bridge`):
  - 573e7935→562c8bdf: only `cycle.sh | 3 +--`, as the sheet expects.
  - 334f771→562c8bdf: no difference. So the stated rollback target 334f771 is equivalent for root.

## Run sheet (k) — safety

- k-1 is read-only. It STOPs on any of these: service active, timer present, switch file present, grant present (`/var/cache/sr-design-image-grant/grant.json`, which matches `GRANT_PATH` in cycle.sh), clone not at 573e793, or dirty clone. It lists the use markers and does not delete them.
- k-2 does these steps in order:
  1. Validates PIN as 40 hex.
  2. Backs up the old HEAD to a 0700 root dir.
  3. Checks ancestry: 573e793 ⊂ PIN ⊂ origin/develop.
  4. Requires the root-file diff to be exactly cycle.sh, the diff SHA to match, and the file to be the same bytes as 334f771.
  5. Asks for a typed `yes`.
  6. Does a detached checkout, then re-checks HEAD, cleanliness, the file SHA, `cmp` of the installed unit, the allowlist line, and that `bakery` is absent.
- No `daemon-reload`, unit install, timer, service start or switch creation. Use markers are kept.
- Rollback goes to 334f771, not 573e793 (which would bring back `bakery:3`). That is correct.
- The worker side follows `origin/develop` via `run.sh` (`WORKER_REF=develop` in cycle.sh), so the worker is closed at merge. Root stays at `bakery:3` until (k) is done. During that window the worker still refuses, and root also needs the owner's switch entry (Info 2).

## Tests (converted, not weakened)

- Removed:
  - The ほし窯 full-chain mock run (DONE → bundle → intake → swap → renders).
  - The "checkout bytes changed" case and the missing-link cases.
  - These all tested the open route that no longer exists. The generic chain stays covered by `bicycle-real-path-off.test.ts` (unchanged full-chain test).
- Added or converted (`hoshigama-real-path.test.ts`):
  - A FULL chain is refused with `REFUSED_JOB_INVALID`, 0 calls to the injected generator (one that would succeed), 0 real `generateImagesInOneRun`, 0 sandbox, no ledger marker and an empty out dir. That chain is the owner switch entry for the exact job, root's grant for the exact bytes, and three different approval ids (new, the run sheet's id, another).
  - ほし窯 assets under the `tsugute`/`bicycle` ids: refused.
  - Root matcher: `bakery` with 1–6 images and a new id gives SCOPE_MISMATCH; bicycle/tsugute still MATCH.
- `autorun-shops.test.ts` asserts:
  - `CLOSED_SHOPS` contents.
  - A closed shop is in none of the lists.
  - The source holds the load-time throw.
  - No worker file references hoshigama.
  - cycle.sh SHA = 8beb350d and contains no bakery.
- `design-worker-cycle.test.ts` runs the real cycle.sh. A ほし窯 job with a matching owner entry under a new id gets `IMAGE_GRANT_SCOPE_MISMATCH` and uses nothing up.
- `photo-swap-hoshigama.test.ts`: still asserts the swap spec, `aiDemoAllowed` and the prompt pin, and now asserts ほし窯 is absent from `AUTORUN_SHOPS`.

## Commands and results (worktree at 562c8bdf)

- `npm run typecheck` (`next typegen && tsc --noEmit`): exit 0.
- `npm run lint`: exit 0, 0 errors. There is 1 warning, in `tests/unit/sales/visual-first-brief.test.ts`. That file is not in the diff.
- `npm run check:secrets`: no secrets found.
- `npx vitest run tests/unit/design-agent/autorun-shops.test.ts tests/unit/design-agent/hoshigama-real-path.test.ts tests/unit/design-agent/bicycle-real-path-off.test.ts tests/unit/design-agent/quality-pipeline/photo-swap-hoshigama.test.ts` (Chromium `/opt/pw-browsers/chromium`): 4 files, 71/71 passed.
- `npx vitest run tests/unit/design-worker-cycle.test.ts`: 116/116 passed.
- `npx vitest run tests/unit/demo-version-package/hoshigama-photo-pipeline.test.ts tests/unit/demo-version-package/local-hoshigama-patch.test.ts`: 17/17 passed. This shows the offline package and the local patch are kept.
- `npx vitest run tests/unit/design-agent tests/unit/design-worker-cycle.test.ts --maxWorkers=4`: stopped at the 30-minute background limit before the summary.
  - Every file that reported finished passed except 5 Chromium render files: `browser.test.ts` (1), `comp-impl/phase-b.test.ts` (3), `phase-c-overlap.test.ts` (1), `phase-d.test.ts` (1), `shop-css/render-check.test.tsx` (1).
  - Some failed on 240–600 s timeouts under load.
  - phase-b's 3 also fail alone (`expected … to not include 'GROUND_UNDER_TEXT'`). That is a rendering/font difference in this container.
  - None of these files import the changed modules. `git diff 573e7935 562c8bdf` is empty for `lib/design-agent/comp-impl`, `shop-css`, `browser*` and their tests, so the failures are unrelated to this PR. The PR's CI must confirm.

## Findings

### L1 (Low) — the `bicycle:6` removal proposal is not in the PR content yet
Issue #290 P0-4 asks for a proposal for removing 輪's old `bicycle:6` entry, presented for the owner's decision. The repo diff correctly leaves `bicycle:6` alone but contains no proposal text. Put it in the PR body or an Issue #290 comment: scope, impact on `bicycle-real-path-off.test.ts`, and a root (k)-style step. No code change is needed.

### L2 (Low) — the closure guard for root's allowlist is test-enforced only
`CLOSED_SHOPS` throws at module load if `AUTORUN_SHOPS` lists a closed shop. Nothing executable stops `bakery:N` being put back into `cycle.sh`. Only the unit tests stop it: the cycle.sh SHA pin, the no-`bakery` regex and allowlist = manifest. This is acceptable, because both layers are required for a grant and CI blocks such a diff. Noted for the record. Optional hardening for a later PR: have the allowlist/manifest agreement test also iterate `CLOSED_SHOPS` against `rootAllowlist()`. The test "a closed shop is in neither …" already does this.

### Info 1 — `scripts/design-artifact/phase2f-image.ts` is a separate image entry
Pre-existing (DEV-117/DEV-150) and human-invoked. It needs `--human-approval-confirmed`, a per-call approval id, its own used-approval record, and a pinned prompt SHA/commit. Its routes are A (wagashi concept), C (a phase2f design run) and P (a three-methods study page under `--page-root`). It does not take the ほし窯 photo prompt. This PR does not change it.

### Info 2 — window between merge and the owner's (k)
Until (k) is done, root's clone still lists `bakery:3`. In that window the worker (`origin/develop`) refuses every ほし窯 job, and root still needs the owner's switch entry plus its use records, so nothing can run. `run.sh` honours `SR_DESIGN_WORKER_REF`. The root cycle sets `WORKER_REF=develop` (unchanged).

### Info 3 — "the run sheet's proposed id of the used run" in tests
The test assumes `s0-hoshigama-photos-20261118-01` was the id actually used. Comment 6990007019 does not name the id. The refusal depends on the shop, not on the id, so the assertion holds either way.

## Completion gate

Fresh Review: PASS (C0/H0/M0) on 562c8bdf. CI on the pushed head still has to be checked separately. develop integration follows the existing rules. Root clone update (k) is the owner's own step on WSL and must not be run from Claude or the cloud.
