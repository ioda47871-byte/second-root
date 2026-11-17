# Fresh Review — DEV-139 visual-first

- task: DEV-139 visual-first (offline visual-first brief / photo-slot handoff)
- PR: #286 `feature/dev-139-visual-first-brief` → `develop`
- reviewed SHA: 9ee2ab6b7020b30d092de464ada6831836a11ed9
- reviewer: independent Fresh Reviewer (separate context)
- date: 2026-11-17

## Verdict: PASS

Critical 0 / High 0 / Medium 0 / Low 5 / Info 4

Changed files (3, all new): `scripts/sales/demo-version/prepare-visual-first.ts`,
`tests/unit/sales/visual-first-brief.test.ts`, `docs/operations/dev139-visual-first-photo-route.md`.

## Checks

(a) Guards — verified by CLI probes. New dir only (`OUTPUT_EXISTS`, incl. dangling symlink), output under repo
refused also via a symlinked parent (`OUTPUT_IN_REPO`), missing parent refused, symlinked/oversized input refused
(`INPUT_FILE_INVALID`), bad schema refused (`INPUT_SCHEMA_INVALID`), facts byte-SHA and shop_id must match the set
(`FACTS_IDENTITY_MISMATCH`), re-hash before write (`INPUT_MUTATED`), dir 0700 / files 0600 with `wx`. Logic is
equivalent to `checkPrivateOutputDir` / `file()` in `prepare-design-input.ts:27-45`.

(b) C1–C7 — the existing `runDirectionSetCheck` is called and anything other than `READY_FOR_COMPS` throws
(`prepare-visual-first.ts:139-140`). Probes: designer C6 "no" → `DIRECTION_SET_HOLD`; SP plan copied from PC
plan (C4) → `DIRECTION_SET_HOLD`. There is no flag or input that skips it.

(c) No new capability — no model/image call, network, DB, env or worker code. Imports only are facts-pack,
direction-set schema and the existing check. Phase 2f / artifact / phase2f-live isolation tests pass (50/50).
Rights, copy thresholds, B-route and workflows are unchanged. `sendable:false` is hardcoded.

(d) Test realism — the tests use the committed fictional bakery fixtures and the real schema and C1–C7 check,
with no mocks. They live under `tests/unit/**` (vitest include) and ran in CI unit (green). Gaps: see L4.

(e) Fidelity — the brief carries concept, motif, composition, 8-aspect descriptor, all sections (facet, ground,
layout, image_slots), ending, pc_plan, the separate sp_plan (first_screen / reorder / overlaps), protect,
references and not_used. Each slot keeps role and size. Per-slot PC/SP crop, ratio and focal point are explicitly
deferred (`needs_measured_pc_sp_slot`). Facts text is pinned only by SHA and not embedded. **Nothing consumes
`sales_visual_first_brief_v1` yet**; the doc and PR say so honestly.

(f) Duplication — the output differs from `prepare-design-input` (whose `phase2f_open_direction_v1` keeps only
concept, composition, research and reference_ids: `lib/sales/b-route/generation-prompt.ts:133-140`, so the doc's
claim is accurate). A separate entry point is defensible. The guard code, however, is copied (L2).

(g) 輪 claim — `docs/design/bicycle-ai-photo-brief.md:55,169` says 6 photos in 5 slots, with the workbench split
into PC and SP (`ph-bench-pc` / `ph-bench-sp`). The PC1440 / tablet 768 / SP390 renders and the owner adoption
(comment 6703047826) are at :146,162. The doc's statement matches. All referenced files exist, including
`lib/sales/b-route/verified-generation-facts.ts`.

(h) Protected Scope is untouched: no workflow, package, config, migration or main change. Only fictional shop
data is used, and no model IDs appear (product names "Claude/Codex" match existing repo usage).

## Findings

- **L1** `scripts/sales/demo-version/prepare-visual-first.ts:154-199,205`: on `PHOTO_SLOTS_REQUIRED` the script
  still writes `visual-first-brief.json`, and that file has no `stage` / hold marker. It differs from a ready brief
  only by `photo_slots: []`. Failure scenario: the P2 consumer the doc plans reads only the brief and treats d1 as
  ready for design. Fix: put `stage` (and `photo_slot_count`) into the brief, or do not write the brief on HOLD.
  Then add a test for it.
- **L2** `prepare-visual-first.ts:91-118` duplicates `inside` / `file` / `checkPrivateOutputDir` from
  `prepare-design-input.ts:22-45`. This is a third copy, after `from-prototype.ts:45`, and the error codes already
  differ (`OUTPUT_PARENT_INVALID` vs `OUTPUT_PARENT_MISSING`). Risk: a guard fix lands in one copy only. Fix: import
  the existing exports, or move them to one shared module.
- **L3** `prepare-visual-first.ts:147`: `slot_id = ph-${section.id}-${i+1}`. DirectionSet section ids allow `_` and
  41 chars (`direction-set.ts:46`), but `PhotoSlot.slot_id` / `section` allow `^ph-[a-z0-9-]{1,40}$` /
  `[a-z0-9-]{1,40}` (`photo-slots.ts:41,45`). A section such as `fire_door` yields an id that the existing photo
  inventory schema rejects. Fix: normalise the id or HOLD on it, and test that case.
- **L4** `tests/unit/sales/visual-first-brief.test.ts`:
  - The test named "refuses an unknown direction without creating an output" (:298-302) never asserts that the
    output is absent.
  - Nothing tests the CLI exit codes (0 / 1 for PHOTO_SLOTS_REQUIRED / 2), symlinked input, dangling or symlinked
    output parent, shop_id mismatch, or a HOLD set. The probes in this review covered these by hand.
  - `VisualFirstStop` is imported but unused, which raises an eslint warning (:5).
- **L5** Process: the PR does not update `.ai/progress.md` / `.ai/tasks.json` (AI_WORKFLOW §5, "update progress on
  every push"). The review record must be saved to `.ai/reviews/` before merge (§6 line 61).

## Info

- I1: `runDirectionSetCheck` re-reads both files with plain `readFileSync`, while the brief is built from the first
  read. The final re-hash catches a change that persists, but not a swap that is reverted between reads. This is
  the same local-only pattern as `prepare-design-input`.
- I2: `reference_mode` is passed through (`TEXT_ONLY_PROVISIONAL` still counts as READY under the existing rules,
  so this is unchanged).
- I3: Locally, `tests/unit/design-agent/quality-pipeline/fidelity-measure.test.ts` has 1 failure (輪 "まわる"). It
  fails the same way on `origin/develop`, so it is environment-dependent and not caused by this PR; it passes in CI.
- I4: The brief does not embed facts text. A future comp generator must load the facts pack and pin it by
  `facts_sha256`.

## Commands / results

- `npx vitest run tests/unit/sales/visual-first-brief.test.ts`: 5/5 pass
- `npx vitest run tests/unit/sales tests/unit/design-agent/quality-pipeline`: 1595 pass / 1 fail (I3, same on develop)
- isolation tests (artifact, phase2f, phase2f-live): 50/50 pass
- `npx eslint <changed ts>`: 0 errors, 1 warning (L4)
- `npx next typegen && npx tsc --noEmit`: exit 0
- CLI probes:
  - d2: exit 0
  - d1: exit 1 `PHOTO_SLOTS_REQUIRED`
  - existing output, dangling symlink, symlinked repo parent, symlinked facts, usage variants, C6 "no", C4 copy,
    bad facts schema: each refused with exit 2
  - permissions: dir 700, files 600
- CI on head (check-runs): unit, unit 1/2, unit 2/2, static, build, integration, e2e, e2e-sales, shop-css 1/2,
  shop-css 2/2 all success

## Disposition (merge decision)
- PASS at 9ee2ab6b (C/H/M 0, Low 5, Info 4); CI green on that head.
- Carried to the next PR that consumes the brief (ほし窯 visual-first build): L1 stage/photo_slot_count marker or no brief on hold; L2 reuse the existing output/input guards instead of a third copy; L3 normalise or stop on section ids that make invalid ph- slot ids; L4 test gaps (no-output assertion, CLI exit codes, symlink cases, shop_id mismatch, held set, unused import).
- This commit adds only this record; the reviewed code is 9ee2ab6b.
