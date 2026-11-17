# Review: DEV-139 STEP 2 — fictional shop end-to-end

- Task: DEV-139 STEP 2
- PR: #281 (feature/dev-139-step2-fictional-e2e → develop 4d4ff905)
- Reviewed SHA: ebc6be28d3a87fa5ddb5e786d2df287aff529424
- Reviewer: independent Fresh Reviewer (separate context)
- Date: 2026-11-17

## Verdict: PASS

Counts: Critical 0 / High 0 / Medium 0 / Low 2 / Info 4

## Findings

### L1 — The re-pin justification says F9–F16 are identical in both packs. F9 is not.
- Where: `docs/operations/step2-fictional-e2e.md:23`, `tests/unit/sales/b-route-step2-fictional-e2e.test.ts:58-59`.
- What I found: the 輪 direction set refers to F9, F10, F11, F14 and F15. F10–F16 match byte-for-byte between the two packs. F9 does not: 輪 has 「比較研究用の架空の自転車修理店です。…」 and 環 has 「動作確認用の架空の自転車修理店です。…」. The rest of F9 (「…店先の作業台で直します。」) is the same.
- Impact: there is no safety or Identity impact. The direction uses F9 only as evidence for M4 「店先の作業台」, and that wording appears in both packs. The C1–C7 gate also ran against 環's facts and returned READY_FOR_COMPS. The problem is that the written reason for why the re-pin is honest is factually wrong. A later reader could take that sentence as a verified invariant and reuse it.
- Failure scenario: someone re-pins another direction set the same way and relies on the claim that values matching by ID make it safe. They never check the values, and a real difference slips through.
- Fix: change the wording to say F10–F16 match exactly, and F9 differs only in the fictional-use prefix (比較研究用 / 動作確認用) while the part the direction uses (店先の作業台) is the same. Fix the test comment the same way. Optionally, have the test assert that the referenced IDs other than F9 are equal.

### L2 — The critique-checklist answers are not recorded item by item.
- Where: `design-library/research/quality-pipeline/poc/sendable-tamaki/step2-review/review.json`, and the doc section 目視レビューをどう行ったか.
- What I found: `critique-checklist.md` says 「答えは報告書に残す」. The review records observations, one round, a remaining list and references, which is everything `comp_review_v1` requires. But there are no explicit answers to A3 (swap test), A4 (whether every visible text is a fact or a neutral label), B5–B7 (template habits, comparing two directions, copying success cases), C9/C10 (type scale, contrast) or D13 (12px / 44px / overflow). B6 and B7 cannot really be answered for a borrowed design, and the review should say so.
- Failure scenario: the owner, or the next reviewer, cannot tell which checklist items the builder checked and which it skipped.
- Fix: add a short checklist answer block to the doc (not the schema), with 未確認 / 該当なし where applicable. In particular, record that B6/B7 do not apply because the design is 輪's d1-wheel-hub.

### Info
- I1: The `DIRECTION_ID` regex in `from-prototype.ts:26,77` cannot trigger in practice. `READY_FOR_COMPS` already parses ids with the same regex, and `directionId` must equal one of them. It is a harmless second guard, but no test covers it.
- I2: Locally, without `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, the browser test is reported as skipped. Playwright expects `chromium-1234` and only `chromium-1243` is installed here. The test does not pass silently. In CI the browser test ran: the unit (1/2) log shows `b-route-step2-fictional-e2e.test.ts (2 tests)` with no skip, and `npx playwright install --with-deps chromium` is in `.github/workflows/ci.yml:60`.
- I3: `tests/unit/design-agent/quality-pipeline/fidelity-measure.test.ts` fails in this environment on both the branch and base 4d4ff905, with the same assertion (`expected [] to include 'まわる'`, the 輪 B/C case). The failure was there before this PR and depends on the environment (likely fonts). This PR did not cause it.
- I4: The e2e test does not assert `renders_match_here`. That is correct: render bytes depend on fonts, and the existing adapter only requires `structural_ok`. In this environment I reproduced `renders_match_here: true` exactly.

## Concern-by-concern judgement

1. **Self-approval / show_owner.** In the existing schema (`lib/design-agent/quality-pipeline/comp-review.ts`), the visual review is by design the builder's own critique: `reader.who` is the literal `claude`, and `show_owner` requires at least one round (`SHOW_WITHOUT_A_ROUND`). So the builder writing the review and changing CSS in round 1 is the intended path, not a loophole. A verdict is not a quality claim, and the owner decides.
   I re-ran the whole chain in a scratch directory, following the doc. My renders reproduce the review's hashes byte for byte: desktop `5090b4ef…e3a6` 1440×5260, mobile `5930857…2453` 390×5599. The comp html/css/copy SHAs in review.json match the derived and committed bytes.
   I rendered both CSS versions. The PC difference is confined to bbox (81,1079)–(319,1860), exactly as the review states. SP is byte-identical. The CSS diff is one rule (`.spokes-h` inside the ≥1000px block). There is no text or HTML change.
   I looked at every crop. The observations match what is on the PNGs: the info bar label/value pairs, the hub 環, the four yellow spokes with boards, まわる/締める crossing sections, the dead area of about 160px under ブレーキ調整 on SP, and the SP 1-column info block. The round-1 cause is real: before the change, 修理のご案内 sat below the stations as a small stray caption. The fix reads correctly: the heading is vertical at the top left, before the first station.
   `show_owner` is defensible. See L2 for the missing checklist answers.
2. **Re-pinned direction.** Only `shop_id` and `facts_sha256` are swapped, and only in a tmp copy. No 環 direction set is committed. It is labelled as borrowed in the doc, in review.json `remaining`, in the PR body and in a test comment, and it is never marked as a success case. C1–C7 run unchanged against 環's facts. The ID-to-value claim is slightly wrong (L1).
3. **Gates.** There are no changes under `lib/design-agent`, `lib/sales/demo-version`, `scripts/design-artifact`, copy-check, the comp-review schema, direction-set or the isolation tests. `sendable:false` is added to the adapter's status.json, and the package contains no `"sendable": true`. Both isolation tests pass (33 tests).
4. **from-prototype `comp/<direction-id>/`, VISUAL_REVIEW_MISSING, label_bound_fact_lines.** All three are correct and tested:
   - The only other caller of from-prototype is the doc, which is updated.
   - A missing review stops before `runStep('visual')`, after the renders exist. There is a unit test for it, and the real-browser node test was updated.
   - The stat counts fact lines that have a label. I got 5, which matches the doc. The guard test asserts 0 on its fixture.
5. **e2e test.** It uses the real CLIs as subprocesses (tsx/node) and mocks nothing. All writes go to `mkdtemp`, and the data is the committed fictional 環/輪 data only. CI runs the browser part (I2).
6. **Protected Scope.** The diff does not touch workflows, `package.json`, the lockfile or migrations. There is no real-shop data: all names, addresses and phone numbers are 架空 or 000-0000-xxxx. No model names appear in the diff.

## Commands and results

- clone, checkout ebc6be28, `npm ci` → OK
- Chain per the doc in `$SCRATCH/run281` with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`:
  - prepare-design-input → OK, facts `dc4ce586…2595`
  - `--print-pin` → prompt SHA `57e38cc1…6422b`, 4648 chars
  - from-prototype → 21 fact lines (5 label-bound), 13 proposed lines, 44 visible texts
  - prepare-offline → `package_prepared_owner_review_required`, copy_step owner_review, `structural_ok` and `renders_match_here` both true, bundle `ed0123fc…bf40`, `sendable:false`
  - with the original page CSS and no review → `VISUAL_REVIEW_MISSING`; the renders exist
- `vitest run tests/unit/sales/b-route-step2-fictional-e2e.test.ts`: with the env set → 2 passed. Without it → 1 passed, 1 skipped (I2).
- `vitest run tests/unit/sales` → 61 files, 1104 passed
- `node --test tests/node/sales-demo-prep.test.mjs` → 48 passed
- isolation tests (artifact + phase2f) → 33 passed
- eslint on the 6 changed code/test files → clean
- `next typegen && tsc --noEmit` → clean
- fidelity-measure.test.ts → 1 failure on the branch and the same failure on base (I3)
- GitHub checks on ebc6be28: static, build, integration, unit (1/2), shop-css 1/2 and 2/2, e2e and e2e-sales all succeeded. unit (2/2) was still running when this was written.
- My attempt at the whole `tests/unit/design-agent` suite locally hit the 9-minute limit (resources). CI covers it.

## My assessment of the renders

- **PC1440:** the first screen clearly shows a bicycle repair shop named 環. The huge wheel with the yellow hub is a strong single focal point. The wheel continues as structure, not only in the Hero: spokes carry the stations, the 振れ取り section has its own wheel, the info section ends on a wheel, and the gauge sits in the 講座 section. The section transitions (まわる and 締める crossing colour boundaries) fit the metaphor. Weaknesses:
  - The placeholder photo boards dominate, especially the very large grey board in 修理の流れ.
  - The serif type falls back to gothic.
  - The 講座 section is thin.
  - There is no screen-sized dead area.
- **SP390:** it is genuinely re-composed, not shrunk. The spine with pins holds the stations, and the phone number is large at the top and bottom. The first 844px show the name, the wheel and the tagline. There is no horizontal overflow, and the minimum font size in the CSS is 12px. Weaknesses: the dead area of about 160px under ブレーキ調整, as the review states, and placeholder boards again.
- Overall: "show to owner" is reasonable. It is not a success case, and the PR does not claim it is.

## Renders saved

- PC1440 reviewed CSS: `/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/rv281-renders/pc1440-reviewed.png`
- PC1440 original page CSS: `/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/rv281-renders/pc1440-original-css.png`
- SP390: `/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/rv281-renders/sp390-reviewed.png`
- Crops: `pc_0..3.png`, `sp_0..4.png`, `pc_after_full_detail.png`, `pc_before_detail.png`, all in the same directory

## Disposition (merge decision)
- L1 fixed in docs/operations/step2-fictional-e2e.md and the test comment (wording only: F10–F16 match, F9 differs in its leading phrase; warning not to assume same id = same value).
- L2 fixed: per-item checklist answers added to the doc (未確認 / 該当なし where they apply).
- Info I1–I4: no action. This commit changes docs, one test comment and this record only; the reviewed code is ebc6be28.
