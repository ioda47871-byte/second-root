# Review record — task DEV-139 ほし窯 photo pipeline

- PR: ioda47871-byte/second-root#288 (feature/dev-139-hoshigama-photo-pipeline → develop)
- Reviewed SHA: 3f61883e69808bcc849d48e80ece1141800e53f0 (base develop 4d1a3abb, merge-base = 4d1a3abb)
- Reviewer: independent Fresh Reviewer (separate context)
- Date: 2026-11-17

## Verdict: FAIL — C 0 / H 0 / M 1 / L 2 / Info 4

The code and page work is sound. Every rights, AI-demo, copy and import gate is unchanged or stricter, and つぐ手 and 輪 output is byte-identical. The PR fails on one Medium: a committed test helper flips the ほし窯 AI-demo gate and can be run directly as a CLI.

## Findings

### M1 — The test helper that flips the owner-approval gate can be run as a CLI
- Files:
  - `tests/support/hoshigama-approved-package-local.ts:4-8`: calls `simulateOwnerApproval()`, then `import("../../scripts/sales/demo-version/package-local")`.
  - `tests/support/hoshigama-approval-stub.ts:36-46`: mutates `SWAP_SHOP_SPECS.bakery` in the running process to `aiDemoAllowed: true` and `aiDemoPromptSha256: <draft sha>`.
  - `lib/demo-version-package/swap-rights.ts:180-181`: the package gate now reads that mutable spec. It used to be hard-coded to `bicycle`.
- Verified: `npx tsx tests/support/hoshigama-approved-package-local.ts --out /tmp/x` enters package-local's `main()` and gets as far as launching Chromium. Nothing refuses a direct invocation.
- Failure scenario: someone runs `npx tsx tests/support/hoshigama-approved-package-local.ts --out <dir> --page <swap>/page --rights … --originals … --depiction-confirmation … [--facts …]`. Often this would be an autonomous agent misled by the file name "approved-package-local". The command writes a v1 or v2 package with `ai_generated_demo` ほし窯 images.
  - At the same time, the repository says `aiDemoAllowed: false`, and run-sheet §1 / the PR body say the package refuses until the spec allows AI (`SUMMARY_NOT_RIN`). That gate is bypassed by one committed command.
  - The PR body's claim "the real CLI never runs this" holds only by convention.
- Mitigations that remain:
  - The intake and the swap have no CLI simulation path. `importHoshigamaAiPhotos` needs an approval record passed in code, and `photo-swap` refuses `AI_DEMO_NOT_ALLOWED`. So a usable swap directory still needs hand-made input.
  - Import refuses `AI_DEMO_NOT_ALLOWED` for any prospect other than 輪's.
  - `sendable` stays false and `public_web` stays false.
  - This is why the severity is Medium, not High.
- Fix (any one of these, plus a test):
  - (a) Preferred: export `main(argv)` from package-local, keeping the auto-run only when the file is the entry point. Call it in-process inside the vitest test after `simulateOwnerApproval()`, and delete the standalone helper.
  - (b) Make the helper refuse unless the test hands it a per-run marker. For example, the test writes a random nonce to a temp file and passes its path through an env var, and the helper also requires `--out` to be under `os.tmpdir()`. Rename the helper to something like `simulated-approval-package-local.test-only.ts`.
  - Add a test that a direct invocation without the marker exits non-zero and writes nothing.

### L1 — Run-sheet §6 names the wrong page
- `docs/operations/hoshigama-one-time-run-sheet.md` §6: "d2-v2 は文を `<wbr>` で割っていたため…" should say **d2-v1**. d2-v2 is the `<wbr>`-free version.

### L2 — The d2-v1 "kept unchanged as a record" banner sits on a page this PR changed
- `poc/bakery/fidelity/d2-v1/README.md:3-4` says it is kept as a record "変えずに残す".
- This same PR changed d2-v1's `index.html` (the `.mix` flour band, commit c8cda89f) and the html SHA in `photo-slots-d2-v1.json` / `photo-slot-edges-d2-v1.json`.
- The README documents the change. Only the wording is misleading: it is "unchanged from now on". Suggest "以後は変えずに残す".

### Info
- I1: `fidelity-measure.test.ts` fails with `expected [] to include 'まわる'` (the 輪 B words_broken check). It fails identically on develop 4d1a3abb, so it is not caused by this PR.
- I2: The d2-v2 address shows a space (`名古屋市瑞穂区 架空町四丁目2-6`), while the copy record and F4 have none. The copy gate normalises whitespace and the facts are unchanged, so this is acceptable.
- I3: つぐ手 already writes byte-identical crop files (for example `ph-hand-desktop` and `ph-hand-tablet`). This predates the PR, and `shareIdenticalCrops` correctly leaves つぐ手 alone. It would matter only if つぐ手 were ever packaged.
- I4: `SUMMARY_NOT_RIN` now also covers "a swap shop that is not approved for AI demos" (detail `shop_not_ai_demo_approved`). This is documented in code.

## Checks by area

1. Nothing enables image generation.
   - `bakery` is not in `AUTORUN_SHOPS`. `cycle.sh` is still `IMAGE_AUTORUN_SHOPS='tsugute:6 bicycle:6'`.
   - The bakery spec has `aiDemoAllowed: false` and no prompt pin. `AI_DEMO_SHOPS` does not contain bakery.
   - `HOSHIGAMA_APPROVAL` is null, and `buildHoshigamaRunPrompt()` and `readApprovedHoshigamaPrompt()` both return "".
   - The writer refuses with `PROMPT_NOT_APPROVED`, and `writeHoshigamaPhotosForRun` requires an approvalId. The intake refuses with `RUN_PROMPT_NOT_APPROVED` and accepts no approval ids by default.
   - No environment variable reaches any of these. No lib/ or scripts/ file imports tests/support; I grepped and found none. The exception is the direct CLI route in M1.
2. Rights and AI-demo gates.
   - photo-rights is unchanged.
   - swap-rights now needs a spec with both `aiDemoAllowed` and a prompt pin, looked up with an own-property check. Today that is 輪 only: つぐ手 has no pin, so it is still refused.
   - `checkPhotoRights` receives `spec.aiDemoAllowed`, which for 輪 is the same `true` as before. Import still refuses `AI_DEMO_NOT_ALLOWED` for anything but `RIN_PROSPECT_ID`.
   - `public_web: false` and `sendable: false` hold.
   - `shareIdenticalCrops` only reuses a file within one slot when the source photo and the crop rectangle are identical. It never adds an image, and per-range density checks still run. The package's duplicate-SHA refusal is unchanged.
   - `HOSHIGAMA_MAX_UPSCALE` is pinned equal to `MAX_UPSCALE`, which is 2. The `upscaleFactor` default is `MAX_UPSCALE`.
   - **つぐ手 and 輪 byte-identity was verified directly.** I ran swapPage with the same mock photos on PR head and on develop. For 輪 d1-v9 and つぐ手 d1-v10, every output file is identical: page, photos, CSS, renders, rights and summary.
3. package-local v2 with copy and photos.
   - The CLI combinations are sound: `--copy` with `--page` is refused, and `--facts` without `--copy` or `--page` is refused.
   - `deriveSwapCopy` binds copy.json to the summary's source copy hash. It replaces exactly one `写真｜<alt>` item per slot, refuses any leftover. It then audits round 0, and buildPackage → `verifyPackageCopy` runs again everything below:
     - `checkArtifactHtml`;
     - `checkArtifactCopy`;
     - record ↔ page;
     - the lane check with AI images;
     - the facts path against trusted facts.
   - The alt text is already caption text, so no unverified copy gets through.
   - The photo checks (`prepareSwap`) are unchanged, and the isolation tests are unchanged and pass.
4. Page d2-v2 and comp v4.
   - comp-lane: 0 findings for both. Render SHAs match the README (v4 `5e179f54…`/`0762a590…`, d2-v2 `aff4e629…`/`0762a590…`).
   - `comp-copy --gate` and `--audit`: `approve_candidate`, codes []. The audit left the tree clean.
   - `--check-review`: ok.
   - photo-slots and edges, re-measured: byte-identical to the committed JSONs.
   - Renders at 1440, 1024, 768, 601, 600, 390 and 360: scrollWidth equals clientWidth at every width.
   - Line breaks fall at phrase ends: 粉は二種類を、/季節で割合を変えて合わせます; 薪の石窯で田舎パンを焼き、/焼き上がった順に店先の棚へ/並べています。
   - The flour band is one continuous dotted pill with no steps.
   - Nothing appears beyond the facts.
   - `show_owner` is defensible. One visual nit predates this PR: 架空塩パン overlaps the edge of the くるみパン plank at PC widths.
5. Prompt draft.
   - It uses only F9, F10 and F12–F13 (wood-fired stone oven, morning firing, country loaf). It names no real place, brand or person, and it excludes text, people and products.
   - It matches the brief §6, with the pins checked by the tests.
   - The targets are the 2× edge sizes, and upscaling is capped at 2×.
6. Tests and scope.
   - The tests use the real CLIs, stub PNGs only, and no network. They fall under `tests/unit/**`, so CI runs them (the unit shards install Chromium).
   - Protected Scope is untouched: no workflows, package.json, lockfile, migrations or .claude changes.
   - No real-shop data, and no model names (only the fixture string "fixture-image-model").

## Commands and results
- `npx vitest run tests/unit/design-agent/quality-pipeline tests/unit/sales tests/unit/demo-version-package` plus the autorun-shops, image-autorun, tsugute-ai-photos, bicycle-real-path-off and all 8 isolation tests (PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium): 97/98 files, 1940/1941 tests. The one failure is fidelity-measure (I1), which fails the same way on develop.
- `npx eslint <changed .ts>`: 0. `npx next typegen && npx tsc --noEmit`: 0.
- comp-lane on v4 and d2-v2, comp-copy `--gate`/`--audit`, `--check-review`, photo-slots and `--edges`: as listed in section 4.
- Direct swap byte comparison against develop (scratchpad `cmp/swapcmp.mts`): bicycle IDENTICAL, tsugute IDENTICAL.
- CI on the head SHA at review time: e2e, build, static, integration and shop-css 1/2 and 2/2 passed. unit 1/2, unit 2/2 and e2e-sales were still running.
- Renders: `/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/rv288-renders/`.

---

## Round 2 — reviewed SHA 63e33eac9724b314d8d7e5ec641fdd6104ef6cd4 (one commit on 3f61883e), 2026-11-17, independent Fresh Reviewer (separate context)

### Verdict: PASS — delta C 0 / H 0 / M 0 / L 0 / Info 2. Round 1 M1, L1, L2 and the 塩パン nit are resolved.

### M1: resolved. I tried to re-open it and could not.
- **The standalone helper and `simulateOwnerApproval` are deleted.** No CLI entry is left in tests/support. `approvedBakerySpec` and `approvedSpecFor` return new objects and live only in tests/support. Nothing in lib/, scripts/ or app/ imports them: I grepped repo-wide, and the only users are the test and the stub.
- **The deep freeze holds.**
  - A probe walked every nested object and array of `SWAP_SHOP_SPECS` and found 0 unfrozen.
  - Adding a key (`evil`), assigning `bakery.aiDemoPromptSha256`, and `Object.defineProperty(bakery, "aiDemoAllowed")` all fail: TypeError or a silent no-op. The values stay false and absent.
  - Strings and the shared constant `EDGE_VIEWPORTS` (a string tuple) are frozen too. No code in lib/ or scripts/ mutates them.
- **No production caller passes a seam.**
  - The `photo-swap.ts` CLI calls `swapPage({ pageDir, manifest, out, browser })`. `image-autorun.ts` calls `swapPage` without `spec`.
  - The `package-local` CLI entry is `if (require.main === module) main(process.argv.slice(2))`, with no seams. No argv flag or env var reaches `aiDemoSpecFor` or `spec`.
- **The entry-point check works under tsx and node.**
  - Run directly with `npx tsx` or with `node --import tsx`, main runs (usage, exit 2).
  - Loaded with `require` from another script, main does not auto-run.
  - The same pattern is already used by `photo-swap.ts`, `comp-lane.ts` and others, and by the existing `sendable-demo` and `swap-photos` CLI tests.
- **The seams change nothing when unused.**
  - `buildSwapImages` resolves with `(aiDemoSpecFor ?? committed)`. `committed` is the previous own-property lookup, and the full gate line `!spec || spec.shop !== shop || !aiDemoAllowed || !aiDemoPromptSha256` is unchanged. A resolver that returns another shop's spec is still refused.
  - `swapPage` uses `opts.spec ?? swapShopSpec(shop)`, plus a new `SPEC_OF_ANOTHER_SHOP` refusal. That refusal is stricter.
  - `prepareSwap` and `package-local` only forward the seam when it is given.
- **New tests:** specs are frozen; a direct CLI run (separate process, v1 and v2) refuses `SUMMARY_NOT_RIN` and writes nothing; in-process main without a resolver refuses and writes nothing.

### Docs and page
- L1 and L2 are fixed.
- 塩パン: `.item-shio` top moved from 5.2% to -3% on the d2-v2 PC CSS only. I looked at 1440, 768 and 601: the label now sits fully above the tilted plank and clear of the band above. SP 390 is unchanged.

### Re-run
- comp-lane on d2-v2: OK, 0 findings. CSS `a0c93627…`, PC 1440×5162 `5c4b0cb3…` and SP `0762a590…`, both matching the README.
- photo-slots and `--edges` re-measured: byte-identical to the committed JSONs, where only the CSS SHA changed.
- Renders at 1440, 1024, 768, 601, 600, 390 and 360: scrollWidth equals clientWidth at every width. Files are in `rv288-renders/r2/`.
- `swapcmp.mts` against develop 4d1a3abb: 輪 d1-v9 IDENTICAL (23 files), つぐ手 d1-v10 IDENTICAL (25 files).
- vitest on the same suites as round 1: 97/98 files, 1942/1943 tests. The one failure is still fidelity-measure (I1), which predates this PR and fails the same way on develop.
- eslint: 0. `next typegen` plus `tsc --noEmit`: 0. Protected Scope untouched.
- CI on 63e33eac at review time: e2e, build, static and integration passed. The unit, shop-css and e2e-sales jobs were still running.

### Info (delta)
- I5: Polluting `Object.prototype.aiDemoPromptSha256` in-process would let the gate read through to つぐ手's spec, which has `aiDemoAllowed: true` and no own pin. The bakery spec is immune because it has an own `aiDemoAllowed: false`. This needs code running in the process, which is outside the threat model. An optional hardening is to read `aiDemoPromptSha256` with an own-property check.
- I6: The seams are exported options, so a future script could pass them. Optional: an isolation-style test that no file outside tests/ references `aiDemoSpecFor`, swapPage's `spec`, or `main(…, seams)`.

## Disposition (merge decision)
- Round 2 PASS at 63e33eac (C/H/M/L 0, Info 2).
- Carried: I5 read the AI-demo prompt pin with an own-property check; I6 add an isolation-style test that no file outside tests/ references the in-process approval seams (aiDemoSpecFor / swapPage spec / package-local main seams).
- Image generation remains NOT enabled: ほし窯 absent from AUTORUN_SHOPS and cycle.sh, aiDemoAllowed false, HOSHIGAMA_APPROVAL null. Enabling needs the owner's approvals listed in docs/operations/hoshigama-one-time-run-sheet.md.
- This commit adds only this record; the reviewed code is 63e33eac.
