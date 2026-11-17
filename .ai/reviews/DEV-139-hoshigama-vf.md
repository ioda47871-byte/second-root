# Review: DEV-139 ほし窯 visual-first

- PR: ioda47871-byte/second-root#287 "ほし窯 d2 visual-first" (feature/dev-139-hoshigama-visual-first → develop)
- Reviewed SHA: 7fa4c23cf5c778e2948f3a0c8553b7b16c2b4614
- Reviewer: independent Fresh Reviewer (separate context)
- Date: 2026-11-17

## Verdict: FAIL (C0 / H0 / M1 / L5 / Info 2)

It fails on one Medium finding: a visible seam that breaks the direction's protect item and pc_plan. Everything else checks out. The tools pass, the slots reproduce byte-for-byte, the facts and Identity Lock are clean, the scope is clean, and the new test runs in CI. The fix is a one-line CSS change in two files.

## Findings

### M1: PC heat rings cut by a straight horizontal edge at the deep/fire boundary
- Files: `design-library/research/quality-pipeline/poc/bakery/comps/d2-hearth-floor/style.css:148` (`.heat { top: -11.81vw }`), with `:58` (`.deep { z-index: 2; background: … }`). The same problem is at `fidelity/d2-v1/style.css:153` and `:58`.
- What happens: at PC, the `.heat` SVG starts 11.81vw above the fire section. The `.deep` section sits above it (z-index 2) and has an opaque gradient background, so it covers the top of the rings. The outer rings stop in a dead-straight horizontal line at y≈1950 (1440 render), right at the section boundary. This is reproduced at 1920, 1440, 1024 and 768, in both the comp and the fidelity page. SP is not affected.
- Why it matters: it draws the line between sections that the direction forbids. pc_plan says "区画の境を線で切らない", and protect #1 is "窯の奥から扉へ冷めていく1枚の床の面". `review.json` observation 5 describes the rings but misses the clip, so `show_owner` was given on a render that breaks a protect item.
- Fix (any one of these): (a) fade the top of `.heat` with a mask, e.g. `mask-image: linear-gradient(transparent 0, #000 14%)` or a radial fade on `.rings`; (b) set `top: 0` and shrink the rings so they stay inside `.fire`; (c) drop the per-section opaque backgrounds for one page-level gradient. Then re-render and update the `review.json` render hashes and observations, plus `photo-slots-d2-v1.json`, the edges file and the README hashes if the fidelity CSS changes.

### L1: Baguette scoring lines cross the letters of 架空バゲット (PC and SP)
- Files: `comps/d2-hearth-floor/index.html:100` (the `.coupe` lines at x 118–650) and `style.css:67` (opacity .4).
- What happens: diagonal strokes pass through 架, 空, バ, ゲ and ッ at every width. The name is still readable, but it looks struck through. `review.json` already lists this under remaining.
- Fix: put the cuts in the gaps between letters (letter-spacing is .5em at PC and .4em at SP), or move them to the ends of the loaf outline.

### L2: Fidelity PC breaks 架空季節のフルーツデニッシュ onto two lines and runs past the plank (the comp keeps one line)
- File: `fidelity/d2-v1/style.css:170` (absolute inside a `.shelf` held to grid cols 6–13).
- What happens: the containing block is 587px wide but the text needs about 598px, so Chrome breaks at the `<wbr>` despite `white-space: nowrap`. The text bottom ends 3–9px below the bottom of `.plank-b` at 768, 1024, 1440 and 1920 (measured, for example 3522 vs 3515 at 1440). The README says the page was checked for "文字の重なりと切れ", and it is supposed to be faithful to the comp.
- Fix: give `.item-danish` `width: max-content` and pull `left` in, or set `wbr { display: none }` under `@media (min-width: 601px)`, or make the plank taller.

### L3: The hero depends on a placeholder (design risk set by the direction)
- At PC 1440×900, the `ph-mouth` board (760×800) takes up about 47% of the first screen. At SP 390×844, the 300×488 board takes up about 44%. With the placeholder, the centre of the hero is a striped brown void. The arch, the name and the plaque are the only real content. 輪's hero (wheel and hub) works without photos; this one does not. The owner should be told clearly that they are judging an empty oven mouth, or be shown a clearly labelled mock.

### L4: Brief §3 lists the 1024 path (~2.09×) without saying it is over the hard 2× cap
- File: `docs/design/hoshigama-ai-photo-brief.md:63-66`.
- The only precedent is 輪's intake, which refuses anything over 2× (`UPSCALE_EXCEEDS_2X`). The brief says nothing is approved, which is correct, but it presents 2.09× as one arithmetic option among others.
- Fix: say outright that a 1024 source cannot reach 2140 within 2× and is out. Also offer a layout option: cap `.fig-mouth`/`.arch-pc` at a max width (for example the size at 1440) so the 1920-edge target drops from 2140 to about 1520.

### L5: Small departures from the declared layouts
- `visit` is declared `single_column_text`, but at PC it is two columns (the doorway with hours and closed days, and a side column). See `comps/.../style.css:171-183`.
- The `mouth` image slot is declared `size: full` with layout `full_bleed_media`, but the photo board is 53% of the width and framed by the arch.
- Both are defensible readings of the concept ("窯の口から覗く"), but the comp's notes and review.json should record them as deliberate choices.

### Info
- I1: `door-fact` (F9: 薪の石窯で田舎パンを焼き、焼き上がった順に店先の棚へ…) sits next to the shelf holding the *other* three breads, while F9 itself names 田舎パン as the bread put on the shelf. The direction asked for this layout and no text is invented, so this is only a note.
- I2: SP: the faintest outer heat rings (opacity .12–.2) pass behind 毎朝4時半に石窯へ／薪をくべます. Round 1 says "文と重ねない". The effect on legibility is negligible.

## 1. Independent checks (each matches the PR's claims)
- `comp-lane` comp: OK, 0 findings. Render sha: desktop `d12c5312…` 1440×5200, mobile `ab63cee7…` 390×3853. Both are identical to review.json and the README.
- `comp-lane` fidelity d2-v1: OK, 0 findings. Render sha: desktop `607640a8…` 1440×5105, mobile `ab63cee7…` (identical).
- `comp-copy --audit`: `approve_candidate`, round 0, codes [], mayShowOwner true. The send blockers are the expected FICTIONAL/OWNER_APPROVAL.
- `comp-lane --check-review --facts`: `{"ok":true,"codes":[]}`.
- `photo-slots.ts --shop bakery` and `--edges`: the output JSON is identical to the committed `photo-slots-d2-v1.json` and `photo-slot-edges-d2-v1.json`.
- Scroll width at 1920, 1440, 1024, 768 and 390 equals the viewport (no horizontal overflow).

## 2. Identity Lock / facts
- All 25 copy items are verbatim facts (F1–F17, or exact substrings such as ほし窯, 7:00〜16:00…, and the F9 tail) or neutral labels of 6 characters or fewer: 窯の奥, 薪の火, 店先の棚, 粉, 扉の外, 写真｜石窯の口, 写真｜田舎パン. The dt labels 時間, 定休, 所在地, 道順 and 電話 pass the lane. Nothing is invented: no prices, reservations, awards, ingredients or temperatures.
- Drawn elements: the 4 log ends are F10 (薪), the 2 planks are F9 (店先の棚), the 2 flour piles are F11 (二種類), and the baguette outline is F12/F14. None of them implies a fact the pack lacks.
- Photo brief: `ph-mouth` shows only the firing (F10). It deliberately leaves out bread, trays and hands, which avoids implying a baking process the facts don't state. `ph-loaf` is one round country loaf, top-down, uncut, with no fillings, weight or props (F12/F13). No text, faces or brands. Nothing misleading. The one process remark in the brief ("火を掻き出してから焼くことが多い") explains why bread is left out; it is not a claim about the shop and does not appear on the page.

## 3. Faithfulness to d2-hearth-floor
- The sections and their order match: mouth, deep, fire, door, flour, visit. Layouts: deep and door are overlap collages, fire is a diagram, flour is single-column. The two image slots are exactly the declared ones (the test pins this).
- Concept: the ground cools 焦げ茶 → 焼き色 → 小麦色 → 粉の白 → 生成り with no section lines (except the M1 clip). The name sits on the arch stones, the stone-oven pair is in the deep section, and the other three breads are off-grid on the shelf.
- pc_plan: met except for M1. sp_plan: the first screen is the arch, the name and a peek of the deep section. The SP order is redone, the item names don't overlap, and the planks alternate left and right.
- protect: #2 (off-grid names) holds, including in the 12-column fidelity page, because the shelf items are positioned by percentage. #1 is broken by M1. Small layout deviations are in L5.

## 4. Design assessment (renders: my own; files listed below)
Critique checklist:
- A1: Yes. The PC first screen shows ほし窯 at 78px on the arch, the small 架空パン店 ほし窯 and bakery, and an oven arch. SP is the same. "What kind of shop" leans on the arch and the small "bakery"; a photo would make it obvious.
- A2: Mostly. The cooling colour runs to the end, and the closing doorway arch echoes the oven mouth. The "floor seen from above" reading depends on the labels (self-noted).
- A3: Yes. A shop without a wood-fired oven loses the cooling hearth entirely.
- A4: Yes.
- B5: There is a repeated tic: the 5 small marks are all spaced 12px labels with a left border. It is acceptable as one floor-label system. The PC visit section is a familiar two-column info block.
- B6: The sibling directions are not built, so the 8 points could only be compared on paper. The direction-set says the types differ.
- B7: The pattern is not copied from CP-020/CP-012; it is translated (two places to put things, a different face per position).
- C8: The most memorable spot is the hero arch. The heat-ring diagram competes at a similar weight. Neither the left of the PC hero (~330px tall, empty between the sign and the plaque) nor any other area is a whole dead screen. The flour section (one sentence and two halftone discs) and the start of the door section (~200px of empty gradient) are weak and low-density.
- C9: The hierarchy is clear (item names 4–7vw, facts 2.8–4.2vw, labels 12px). The serif setting falls back to gothic in this container, as stated.
- C10: There are 5 working colours. Contrast is fine; the smallest text is 12px #b98e5e on #1b120c.
- C11: The transitions run continuously, which suits the metaphor. M1 is the one place where they don't.
- D12: Yes, SP is recomposed: stacked, offset, and the overlaps removed.
- D13: No overflow. The smallest text is 12px. There are no tap targets (the phone number is not a link, which is fine for a comp). No decoration crosses the shop name. The coupe lines cross the baguette name (L1).
- D14: SP is 3853px tall, which is fine.

Compared with 輪: below 輪. My judgement is that it is roughly two-thirds of the way there. 輪 has a strong, photo-independent hero and loud typographic beats (まわる / 締める) that tie its sections together. ほし窯 is atmospheric and coherent, but its hero is hostage to a missing photo, and its lower half (door, flour, visit) loses density.

Is `show_owner` defensible? It is defensible as "show for a direction decision", since the lane permits it and the remaining list is honest. But M1 breaks a protect item that the review missed, so fix M1 first. When it is shown, tell the owner plainly that the hero's centre is a placeholder.

## 5. Photo plan
- The measured slots support 3 photos. `ph-mouth` is 0.95 at PC and 0.615 at SP. A single 3:4 photo keeps only 79% of the height at PC (verified). The SP 2:3 photo covers the 600-edge 462×751 at 2× (924×1502 ≤ 1010×1515). `ph-loaf` is 1.2 at every width, and 4:3 at 1750×1313 covers the 1920 edge of 784×653 at 2× (1568×1306). The focus boxes fit inside every crop and clear the arch. `planSlot` was not run, as the brief states. The 2-photo alternative is presented fairly.
- Upscaling: the 2140 target comes from the 1920 edge (1067×2). The brief does not ask for or assume an upscale, and says correctly that nothing is approved for ほし窯. That matches photo-intake §10-3 (2× target, 1.5× only with an owner record) and the 輪 precedent (≤2×, lanczos3, one photo only). See L4: the brief should rule out the >2× path explicitly and offer the layout cap.

## 6. Tests, CI and scope
- New test `tests/unit/design-agent/quality-pipeline/photo-slots-bakery-d2-v1.test.ts`: 3/3 pass. CI picks it up through `tests/unit/**` in the sharded unit job, which runs `npx playwright install --with-deps chromium`. It uses the same browser pattern as `photo-intake.test.ts`.
- `npx vitest run tests/unit/design-agent/quality-pipeline tests/unit/sales`: 1594 passed and 1 failed. The failure is `fidelity-measure.test.ts` "輪: B keeps about half…" (`expected [] to include 'まわる'`). It fails identically on origin/develop because of fonts, so it is not caused by this PR.
- Isolation tests (phase2f, three-methods), the identity-lock test and the design-director skill test: 65/65 pass. None of these files changed.
- eslint on the new test: clean. `npx next typegen && npx tsc --noEmit`: exit 0.
- Scope: all 13 changed files are under `poc/bakery/**`, `docs/design/hoshigama-ai-photo-brief.md` and the new test. No workflow, package, config or Protected Scope file changed. No real-shop data (phone 000-0000-0631 and 架空 names only). No model names in the diff.

## Renders (scratchpad, not committed)
/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/rv287-renders/
- d2-hearth-floor/{desktop.png, mobile.png, pc_0..5.png, sp_0..4.png, pc_overview.png, sp_overview.png, sp_sheet.png, z_baguette_seam.png, z_sp_firedoor.png}
- d2-v1/{desktop.png, mobile.png, pc_*.png, sp_*.png, z_baguette_seam.png, z_door.png, fid_1024.png, fid_768.png, fid_1024_768.png}
- wa-d1-v9/{desktop.png, mobile.png, pc_overview.png, pc_0.png, sp_overview.png} (輪, for comparison)
- slots.json, edges.json (fresh `photo-slots.ts` output, identical to the committed files)

---

# Round 2

- Reviewed SHA: 61ff8ec80ca47337b88eb578ac8e163782709a39 (one commit on 7fa4c23c)
- Reviewer: independent Fresh Reviewer (separate context). Date: 2026-11-17. Fresh clone `rv287b`, `npm ci`.

## Verdict on the delta: PASS (C0 / H0 / M0 / L1 / Info 4)

All six round-1 findings are fixed or recorded as deliberate. The new commit introduces no Critical, High or Medium issue.

## Round-1 findings
| # | Status | Evidence |
|---|---|---|
| M1 | **Fixed** | `.heat` now has a mask (`linear-gradient(transparent 0, transparent 14.5%, #000 32%)`) in comp-v2 and the fidelity page. Full-size crops at the deep/fire boundary show the rings fading smoothly with no straight edge, even at 4× contrast. Checked at 1440 (`z_boundary_1440.png`, `z_boundary_1440_contrast.png`, both pages) and 1920 (`v2_1920_boundary.png`). 1024 and 768 match in the width sheets. |
| L1 | **Fixed** | Five cuts sit in the gaps between letters, plus two at the ends. Nothing crosses a letter at any width. Design note: the line now reads a little like "/架/空/バ/ゲ/ッ/ト/" (Info). |
| L2 | **Fixed** | Fidelity PC: `.item-danish { width: max-content }` keeps it on one line. Its bottom is 29–74px above the plank bottom at 768–1920 (measured; `d2-v1/z_door.png`). |
| L3 | **Addressed** | The ph-mouth board is inset deep in the arch (PC 460×510, SP 190×315) inside a drawn oven interior: a dark cavity, three receding courses and an orange floor glow. The hero now reads as an oven mouth without a photo. Faint brick joints fill the left face, and the name block is 2 lines in serif at clamp(18–36px). The door section's head is tightened. The five labels are now different per place. |
| L4 | **Fixed** | The brief drops the >2× path and cites `UPSCALE_EXCEEDS_2X`. The layout cap gives a PC target of 1370: the 1920 edge is 613×680, 2× is 1226×1360 → 1:1 at 1370. That is no upscale from 1536, or 1.34× from 1024. SP is 650×975 (600 edge 292×485 → 584×970), with no upscale. The loaf is 1750×1313: 1.14× from 1536×1152, 1.71× from 1024×768. **Every target is ≤2×.** The focus boxes clear the crops: the PC fire box is now y ≥ 0.48 vs the arch's top 45.1%. |
| L5 | **Recorded** | v2 `review.json` remaining, v2 README, fidelity README and the brief all record the two-column visit section and the inset "full" slot as deliberate readings. |

## Re-run checks (all match the commit)
- comp-lane v2: OK, 0 findings. css `acaac8ab9d91…`; renders `4f0a66f96ec7…` 1440×5090 and `fddd7c163cfb…` 390×3943, identical to v2 `review.json`.
- comp-lane fidelity d2-v1: OK, 0 findings. css `7017a35e4480…`; renders `e4805418b2c7…` and `fddd7c163cfb…`, identical to its README.
- comp-lane v1 (unchanged): OK, 0 findings, same hashes as round 1.
- `comp-copy --audit` v2: `approve_candidate`, round 0, codes []. v2 copy.json is byte-identical to v1 (and to the fidelity copy). v2 index.html is byte-identical to the fidelity index.html.
- `--check-review --facts`: v2 `{"ok":true,"codes":[]}` (v1 also still ok).
- `photo-slots.ts` and `--edges` on the fidelity page: output identical to the committed `photo-slots-d2-v1.json` and `photo-slot-edges-d2-v1.json`. ph-mouth: 1440 460×510, 1024 327×363, 768 245×272, 390 190×315; edges 292×485 / 383×425 / 613×680. ph-loaf unchanged.
- Scroll width equals the viewport at 1920, 1440, 1024, 768, 600 and 390 for v2 and the fidelity page. Bounding-box text overlaps found by DOM were only rotation artefacts, confirmed visually: the SP planks (`z_sp_shelf.png`) and the intended PC shelf overlap of くるみ and 塩.

## New findings
### L1 (new): the flour "mix" row's four discrete pairs suggest four seasonal blends
- Files: `comps/d2-hearth-floor-v2/index.html:156-161`; the same HTML is in the fidelity page.
- What it shows: four groups of the two dot patterns at radii 44/20, 36/30, 28/40 and 40/26, placed right under 粉は二種類を、季節で割合を変えて合わせます.
- Why it matters: no season names or numbers are written, and that was deliberate. But four discrete steps under "季節で" reads as four seasons, each with its own blend in an A → B → A pattern. F11 says only that the proportion changes with the season; it gives no count, no scheme and no direction.
- Owner scenario: the owner (or a real shop later) reads it as "a blend for each of the four seasons".
- Fix: make the proportion change continuously, or irregularly without a count (for example one strip where the two patterns trade area smoothly), or list the row in `remaining` as needing owner confirmation.

### Info
- I1: brief §3 still says a single 3:4 photo keeps "80%" at PC. With the new 0.902 slot it keeps 0.75/0.902 ≈ 83%. The text needs a small correction; the recommendation stands.
- I2: v1's own `review.json` still says `show_owner`. The note that v1 is not a candidate lives only in the v2 README and the fidelity README, not in the v1 directory. That is acceptable under append-only, but anyone reading v1 alone will not see it.
- I3: the hero's faint brick joints (`.masonry`, opacity .07) and the cavity courses suggest brick masonry. F12 says 石窯. Brick-built stone ovens are ordinary, and the brief already allows refractory brick, so this implies nothing material.
- I4: as round 1 I2, the faintest SP heat rings still sit near the 4時半 sentence. Negligible.

Identity check of the new drawn elements: the interior and floor glow come from F10/F12 (firing a wood oven); the rings and logs are unchanged. The brick and mix row are covered in I3 and L1. No new text was added. The labels are the same copy items, only restyled (the large 粉 is the copy item `mk-flour`).

## Design, re-assessed (my renders at 1440, 390, 1920, 1024 and 768)
- A1: Yes, and stronger. PC shows a big two-line serif name, bakery, and an arch with ほし窯. SP shows the arch name and an oven interior that reads as an oven without a photo.
- A2: Yes. The cooling floor carries through to the door arch, which is now topped by its label. "Seen from above" still leans on the labels (self-noted).
- A3: Yes. A4: Yes, with the mix-row caveat (L1).
- B5: The repeated left-border label tic is gone; each label has its own form. B6/B7: as round 1.
- C8: The hero arch and tunnel are clearly the focal point; the rings are secondary. The empty left of the PC hero is now filled by the name block and brick joints. There is no dead screen. The door head is tighter. Flour has more going on but is still the quietest area with visit. C9: the hierarchy is clearer, with the serif name and large 粉. C10: the palette is unchanged and fine. C11: transitions are continuous everywhere now that M1 is fixed.
- D12: SP is recomposed, with the inset board in the drawn interior. D13: no overflow, text ≥12px, the cuts are clear of letters, nothing crosses the name. D14: SP is 3943px.

Compared with 輪: improved from about two-thirds to about **three-quarters**. The hero no longer depends on the photo. 輪 still has the louder type beats and the stronger, denser lower half.

Is `show_owner` defensible for v2? **Yes.** The protect items hold, there are no C/H/M issues, and the remaining list is honest. Ideally L1 (mix row) is fixed or flagged for the owner before showing.

## Tests and scope
- New test: 3/3 pass.
- `quality-pipeline` + `sales`: 1594 pass, 1 fails. The failure is `fidelity-measure` 輪 "まわる", the same font-dependent failure as on develop.
- Isolation, identity-lock and skill tests: 65/65 pass.
- eslint on the test: clean. `next typegen` and `tsc --noEmit`: exit 0.
- The changes stay within `poc/bakery/**`, the brief and the test. No Protected Scope, no real-shop data, no model names.

## Round 2 renders
`/tmp/claude-0/-home-user/0fe1c26c-c40d-5220-911a-3f28258de597/scratchpad/rv287-renders/round2/`
- d2-hearth-floor-v2/ (desktop.png, mobile.png, pc_0..5, pc_overview, sp_overview, sp_sheet, z_boundary_1440*.png, z_sp_shelf.png)
- d2-v1/ (desktop.png, mobile.png, pc_*, sp_*, z_boundary_1440*.png, z_door.png)
- d2-hearth-floor/ (v1 re-render, unchanged hashes)
- v2_{1920,1024,768}.png, fid_{1920,1024,768}.png, v2_widths.png, fid_widths.png, v2_1920_hero.png, v2_1920_boundary.png
- slots.json, edges.json (fresh output, identical to the committed files)

## Disposition (merge decision)
- Round 2 PASS at 61ff8ec8 (C/H/M 0, Low 1, Info 4). Design estimate ~3/4 of 輪; v2 `show_owner` defensible as a direction check, NOT a success case.
- Carried (must be fixed in the next ほし窯 PR, before anything is shown as a candidate): the flour "mix" row (comps/d2-hearth-floor-v2/index.html:156-161 and fidelity/d2-v1) shows four countable proportion steps that imply four seasonal blends not in F11 → make the change continuous/uncountable or remove; and mark v1's review.json as superseded (not a candidate). Also correct brief §3 (single 3:4 photo keeps ~83%).
- This commit adds only this record; the reviewed code is 61ff8ec8.
