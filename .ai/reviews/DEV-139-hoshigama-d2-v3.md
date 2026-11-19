# Review: DEV-139 ほし窯 d2-v3 (Issue #290 P1)

- Branch: feature/dev-139-hoshigama-d2-v3 → develop (diff `573e7935..047d7ce`)
- Reviewed SHA: 047d7ce
- Reviewer: independent Fresh Reviewer (separate context)
- Date: 2026-11-19

## Verdict (round 1, 047d7ce): FAIL (C0 / H0 / M1 / L2 / Info 4) — superseded by Round 2 (PASS at 8237764) below

The PR fails on one Medium finding. At every PC width (601 to 1920), the heat rings in the fire section are cut by a straight horizontal edge at the deep/fire boundary. d2-v2 had fixed this exact defect (the M1 of the visual-first review), and d2-v3 brings it back. It breaks the direction's protect item "節の境に線を引かない", and the README and review.json both claim that item is kept.

The rest of the PR checks out:
- All tools pass, and the renders and slot files reproduce byte-for-byte.
- d2-v2, A4, the approval, the prompt and the manifest are untouched.
- No new words were added: copy.json is byte-identical to d2-v2.
- The swap-spec change is limited to the page allowlist.
- The design addresses every point of the owner's critique.

The fix is a one-line CSS change, made in both copies of the file (fidelity/d2-v3 and comps/d2-hearth-floor-v5).

## Findings

### Critical: none
### High: none

### M1: PC heat rings and floor glow are cut by a straight edge at the deep/fire boundary (a regression of the fix in d2-v2)
- Files:
  - `design-library/research/quality-pipeline/poc/bakery/fidelity/d2-v3/style.css:196` (`.heat { top: -5vw; … mask-image: linear-gradient(90deg, transparent 20%, #000 40%) }`)
  - `:94` (`.deep { z-index: 2; background: … }` is opaque and sits above `.fire`, which has z-index 1)
  - the same lines in `comps/d2-hearth-floor-v5/style.css`
- What happens: the `.heat` box starts above the top of `.fire` at every PC width. Measured in Chromium with JS off: 30px at 601, 38 at 768, 51 at 1024, 60 at 1199, 72 at 1440 and 96 at 1920.
  - In viewBox units the box starts 93.75 above the top of `.fire`, and the ring centre sits at y = 600. So anything with r > 506 reaches into `.deep`: the outer ring (r = 514) and the `floor-heat` glow (r = 560).
  - `.deep` covers that part, so the top of the outer ring stops in a flat gap, and the glow ends in a straight horizontal line, exactly at the section boundary. This was seen in a native-contrast crop at 1920, and in the committed-equivalent 1440 render around y ≈ 1874.
  - The row-mean luminance across the ring area steps from 29.3 to 30.1 at the boundary (d2-v3). In d2-v2 it is flat (29.33 to 29.33 at 1440 and 1920).
  - SP is not affected: there the `.heat` box starts well below the top of `.fire`.
- Why it matters: d2-v2 fixed exactly this with a vertical fade (`mask-image: linear-gradient(transparent 0, transparent 14.5%, #000 32%)`, d2-v2 style.css:174). d2-v3 replaced that fade with a horizontal one (90deg, which keeps the rings off the sentence) and dropped the vertical fade.
  - The direction's protect item 1 is "窯の奥から扉へ冷めていく1枚の床の面 (節の境に線を引かない)". The README and review.json say this item is kept, and `show_owner` was given on a render that breaks it.
  - The author's 9-width measurement checked overlaps, not clipping, so it could not catch this.
- Fix (any one of these):
  - (a) Add the vertical fade back alongside the horizontal one, e.g. two mask layers with `mask-composite: intersect` (`-webkit-mask-composite: source-in`). Check first that the server html-safety allows it.
  - (b) Keep every circle inside `.fire`: with `top: -5vw`, set r ≤ 500 for the outer ring and `floor-heat`, or move `.heat` to `top ≥ 0` and shift `.mark-fire` and the leader by the same amount.
  - (c) Give `.deep` no opaque background above `.heat`.
- After the fix, re-render and update the review.json render hashes and the README. If the edited CSS is the fidelity page's, re-measure `photo-slots-d2-v3.json` and the edges file too, since their SHAs pin the CSS.

### L1: The 粉 glyph spills outside its bowl (PC and SP)
- At PC 1440, the left sweep and the bottom of 粉 cross the rim circle of `.kona` (e.g. the lower-left stroke at x ≈ 130 against a rim at ≈ 90–100). At SP 390 the left stroke passes outside the rim.
- It reads as deliberate "flour over the rim", but the README describes the figure as 器を真上から見た円の**中の**巨大な「粉」.
- Either shrink the glyph slightly (`font-size` on `.kona-char`) or record the spill as intentional.

### L2: PC deep section leaves a large dead quadrant
- At 1440 the area under the photo board and left of the baguette (about 600×350px) is empty. In d2-v2 the shelf and text fill that rhythm.
- This is subjective and not a gate. Mention it to the owner, or tighten the baguette's `margin-top`.

### Info
- I1: Real-photo verification is still pending, which the README states correctly. The owner comparison must be the real-photo swap output (d2-v2 and d2-v3 side by side at PC1440/SP390), not these placeholder renders.
- I2: `HOSHIGAMA_APPROVAL.page` is still the literal `"d2-v2"` (`hoshigama-ai-photos.ts:81,105,262`). The swap does not bind to it, so P1 is fine. A later P2 package of d2-v3 should confirm that no package or summary step requires `page === approval.page`. Do not widen the approval to make it pass.
- I3: The browser re-measure of the d2-v3 inventory and edges is asserted twice: in `photo-slots-bakery-d2-v3.test.ts` and in the last test of `photo-swap-hoshigama.test.ts`. This is harmless redundancy.
- I4: The hero plaque is hidden at 601–767 (`display: none`), as it is at SP in d2-v2. The same information stays visible in the visit section at every width. The swap-spec comment "move text only" is still accurate, because no board changes.

## What was checked, commands and results

### 1. Scope and protected files
- `git diff 573e7935 047d7ce --stat`: 15 files, all additions except `photo-swap-shops.ts` (+7/−3).
- New files: comps/d2-hearth-floor-v5 (6 files), fidelity/d2-v3 (4), photo-slots-d2-v3.json, photo-slot-edges-d2-v3.json, and one new test. One existing test file was extended.
- Unchanged: nothing under fidelity/d2-v2, comps/d2-hearth-floor-v4 or the older comps; `hoshigama-ai-photos.ts`; `docs/design/hoshigama-ai-photo-prompt.txt`; any manifest or hash file.
- No binary file, no absolute or private path, no `.intake/` path.
- The fidelity/d2-v3 index.html, style.css and copy.json are byte-identical to comps/d2-hearth-floor-v5. Its copy.json is byte-identical to d2-v2 (`ec9c1d6b…40f8`).
- The hero HTML is unchanged from d2-v2: the first HTML difference is the baguette's coupe SVG.

### 2. Copy and facts
- No new copy items or claims: the copy record is the d2-v2 record.
- The fictional-shop note `比較研究用の架空のパン屋です。実在の店舗ではありません。` is present. It moved up under the shop name.
- `comp-copy.ts --audit comps/d2-hearth-floor-v5 --facts …/facts-pack.json`: `approve_candidate`, round 0, codes [], mayShowOwner true. The send blockers are the expected FICTIONAL_RESEARCH_NOT_SENDABLE and OWNER_APPROVAL_MISSING. The audit runs the server `checkArtifactHtml` and `checkArtifactCopy`. The committed copy-review.json was left unchanged (git status clean).
- The new figures imply nothing beyond F11 (二種類 / 季節で割合を変えて), F10 (薪) and F9 (店先の棚): no counts, no ratios, no temperatures.

### 3. Lane and slots
- `comp-lane.ts --dir` on comps/d2-hearth-floor-v5 and on fidelity/d2-v3 (JS off, network blocked, dsf 1): status OK, 0 findings for both.
  - Desktop 1440×4760 `b81f6e40…3b54`, mobile 390×4064 `041d595e…68c4`. Both match review.json, the README and the author's p1-renders/v3-final PNGs exactly.
- `comp-lane.ts --check-review comps/d2-hearth-floor-v5 --facts …`: `{"ok":true,"codes":[]}`. direction_id `d2-hearth-floor-v5` matches the directory, and the verdict is `show_owner`.
- `photo-slots.ts --shop bakery --page fidelity/d2-v3` and the same with `--edges`: the output is byte-identical (`cmp`) to the committed `photo-slots-d2-v3.json` and `photo-slot-edges-d2-v3.json`.
- My own 9-width check (360/390/600/601/768/1024/1199/1440/1920, JS off, non-file requests aborted):
  - horizontal overflow: none at any width
  - smallest text: 12px (the photo captions)
  - text clipped inside its box: none
  - hidden text: only the alternate-arch ほし窯 and the hero plaque (see I4)

### 4. Swap spec and tests
- `photo-swap-shops.ts`: the only change is `pages: ["d2-v2", "d2-v3"]` plus comments.
  - These are unchanged: ranges, spViewports, the structure triples, HOSHIGAMA_SWAP_CSS, `aiDemoAllowed`, `aiDemoPromptSha256` (`372f7802…a8f6`) and HOSHIGAMA_APPROVAL. The new test asserts that the approval page is still `d2-v2`.
- The new tests are meaningful:
  - SHA pins of the inventory against the page, and the A5 bytes
  - the media-query set, with no board rules in the extra queries
  - exact triple markup and the arch clip
  - planSlot at the intake's real sizes: ≥2× everywhere with no exception
  - a negative case: the brief's 650×975 SP target gets `SCALE_EXCEPTION_REQUIRED`, i.e. refused rather than loosened
  - transformHtml leaves the page unchanged except for the photos
  - an E2E swap with mock photos of the intake sizes, with distinct photo files
  - a browser re-measure within 2px
- `npx vitest run photo-swap-hoshigama photo-slots-bakery-d2-v3 photo-slots-bakery-d2-v1` (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers): 3 files, 38 passed.
- The wider check (every test that references the spec or hoshigama, photo-intake, and the 8 isolation tests): 18 files, 300 passed.
- `tests/unit/design-agent/quality-pipeline` plus the isolation tests: 24 files, 587 passed.
- `npm run typecheck`: 0 errors. `npm run lint`: 0 errors and 1 warning, in the untouched `tests/unit/sales/visual-first-brief.test.ts`. `npm run check:secrets`: no secrets.

### 5. B方式 constraints
- The page has no `<script>`, event attributes, `<style>`, style attributes, `@import` or `@font-face`, and no external `url()`. The only `url(#…)` references are internal SVG fills and masks.
- No `<img>`, no `tel:` or `mailto:`, no CSS `content:` text, no `font:` shorthand, no `textPath`.
- The only link is `style.css`.
- Font families are only `--mincho` (Shippori Mincho, Zen Old Mincho, Noto Serif CJK JP, IPAMincho, serif), `--gothic` (Zen Kaku Gothic New, Noto Sans CJK JP, IPAGothic, sans-serif) and Georgia, serif. All are on the allowlist, and they are unchanged from d2-v2.
- The new SVG (mask, pattern, linearGradient, text) passed the server html-safety check inside the audit.

### 6. Design against the owner's critique (placeholder renders; real photos not yet seen)
- Kept:
  - the voussoir arch hero with ほし窯 in the stones and the peek into the oven (same HTML, same PC board)
  - separate PC and SP compositions
  - no split hero, card rows or generic LP
  - no imitation of 輪's まわる
- 粉: the bowl seen from above, with a giant 粉 drawn in two dot textures that blend along a diagonal, beside the F11 sentence. This is a real visual lead built only from the fact, and it is much stronger than d2-v2's faint dots and band. It is clear at both PC and SP.
- 薪の火: the label 薪の火 now sits on a leader from the logs, and the rings fade from the centre outward. The figure now reads as a labelled diagram rather than decoration. This point is weakened by M1 at PC.
- Bread names:
  - 架空田舎パン is set vertically beside the board, with no overlap.
  - The three shelf names stand on their own planks.
  - The coupe strokes sit between the characters of 架空バゲット. This fixes the overlaps in d2-v2.
- Store information:
  - The hours, closed days and phone number are large and readable at PC and SP (SP: hours about 24px, phone 30px).
  - The labels have good contrast.
  - The fictional-shop note is boxed under the name.
  - The PC doorway runs to the bottom of the page.
- Typography: the section labels vary by section (vertical column, hanging tag, door tag, diagram plate). There is a clear size hierarchy.

## Disposition
- FAIL at 047d7ce because of M1 only. After M1 is fixed and the renders, hashes and slot files are refreshed as needed, a re-review should only need to confirm:
  - there is no edge at the deep/fire boundary at 601–1920
  - comp-lane, the slot files and the tests are still byte-identical or passing
- L1 and L2 are optional.
- This commit adds only this record. No photo was generated, fetched or committed, and nothing was pushed.

---

# Round 2: re-review at 8237764

- Range: `573e7935..8237764`. The fix commit 8237764 sits on top of the round-1 record 9bdf61f.
- Reviewed SHA: 8237764
- Reviewer: the same independent Fresh Reviewer (separate context)
- Date: 2026-11-19

## Verdict: PASS (C0 / H0 / M0 / L0 / Info 3)

M1 is fixed and confirmed at every PC width. L1 and L2 are fixed. Nothing regressed.

## Round-1 findings

### M1: fixed
- What changed: `.heat` now carries two mask layers, intersected with `mask-composite: intersect` (`-webkit-mask-composite: source-in`):
  - the round-1 horizontal fade, `linear-gradient(90deg, transparent 20%, #000 40%)`, which keeps the rings off the sentence
  - a new vertical fade, `linear-gradient(transparent 8%, #000 24%)`
- Why this removes the edge: 8% of the 64vw box is 5.12vw. The box starts 5vw above `.fire`, so the drawing is already fully transparent where it passes under `.deep`. No circle can reach the boundary.
- Visual check: crops at 601, 768, 1024, 1199, 1440 and 1920 (JS off, external requests aborted), viewed brightened 3×. The outer ring and the glow fade out before the boundary at every width, with no flat top and no straight line.
- Measurement script (`p1-measure.mjs`, scratchpad) on d2-v3: `section_edge_cut = 0` at all 9 widths (360 to 1920). Every other check is also 0, the smallest text is 12px, and the lowest contrast is 5.09.
- My row-mean luminance check: the small step across the boundary at 601–1440 is the same size as d2-v2's own background step (29.33 → 29.67 at 768 in d2-v2). It is not drawing.
- The server html-safety check accepts `mask-composite`: the audit below passes.

### L1: fixed
- `.kona-char` went from 840 to 740 viewBox units, in the base rule, so it applies at both PC and SP.
- In the 1440 and 390 renders the whole 粉 glyph sits inside the bowl's rim, with margin on every side.

### L2: fixed
- The PC baguette is now centred under the photo row, at 4.86vw instead of 4.17vw, with a top margin of 4.17vw instead of 6vw.
- The 1440 render no longer has the empty lower-left area: the photo, the vertical name and the sentence form the top row, and the baguette fills the width below.
- The photo board is unchanged.

## No regressions
- Changed between rounds: the two style.css files (byte-identical to each other), README.md for d2-v3 and for A5, review.json (new render hashes and observations), copy-review.json (only `page_css_sha256`), and the css_sha256 in the two slot files.
- A5 and the C page are byte-identical (`cmp` on index.html, style.css and copy.json). copy.json is still byte-identical to d2-v2.
- Nothing under d2-v2/, d2-hearth-floor-v4/, `hoshigama-ai-photos.ts` or the prompt changed across `573e7935..8237764`. No PNG files.
- `comp-copy --audit` (A5): `approve_candidate`, round 0, codes [], mayShowOwner true. The send blockers are the expected two. The committed copy-review.json was reproduced: git status is clean afterwards.
- `comp-lane --dir` on A5 and on d2-v3: OK, 0 findings. Desktop 1440×4757 `478525c1…6eec`, mobile 390×4064 `d27dcce5…b210`. Both are identical to review.json.
- `comp-lane --check-review --facts`: `{"ok":true,"codes":[]}`.
- `photo-slots.ts`, with and without `--edges`: byte-identical (`cmp`) to the committed `photo-slots-d2-v3.json` and `photo-slot-edges-d2-v3.json`. The board sizes are unchanged, so the 2× analysis from round 1 still holds.
- Tests (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers):
  - the 3 named files: 38 passed
  - quality-pipeline, plus every test that references the spec or hoshigama, plus the 8 isolation tests: 29 files, 653 passed
- `npm run typecheck`: 0 errors. `npm run lint`: 0 errors and 1 warning (the untouched visual-first-brief test). `npm run check:secrets`: clean.

## Info
- I5: The new edge-cut check in `p1-measure.mjs` is not sensitive enough at small PC widths. Run on the 047d7ce CSS, it flags the cut only at 1440 and 1920, not at 601 or 768, although the box crossed the boundary there too. Its threshold (0.012) misses faint strokes. That is why the visual check above covers all six widths. If this check is ever moved into the repo, tighten it or add a box-crossing test.
- I6: The same script flags `section_edge_cut` at the *bottom* of the fire section in d2-v2 (heat, spread 0.02–0.045). d2-v2 is frozen and not part of this PR. This only means the d2-v2 side of the owner comparison carries that artefact.
- I1–I4 from round 1 still apply, unchanged. Most importantly, the owner comparison must use the real-photo swap output.

## Disposition
- PASS at 8237764: Critical, High, Medium and Low are all 0.
- Still to do outside this review: the real-photo swap and the side-by-side comparison for the owner, CI, and owner adoption.
- This commit adds only this round to the record. Nothing was pushed.
