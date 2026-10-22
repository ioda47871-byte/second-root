# DEV-083: high-quality design, reproduced safely

> **Design and plan only**, except phase A (verification only), which is built: see §10 for what it added, what it skipped
> and the measured costs. No Codex, no model or API call, no WSL run. No relaxation in this document is in force.
> DEV-083 starts after DEV-082 (PR #96, `docs/operations/comp-to-site.md`, `lib/design-agent/comp-impl/`) is merged.
>
> **Approval rule.** Phase A (§7) only **adds** checks and relaxes nothing: it follows the normal `docs/AI_WORKFLOW.md` §4
> conditions (Fresh Review PASS, required CI on the latest SHA, autonomous feature → develop merge). **Every relaxation phase
> (B–F) and every threshold, tolerance or budget change is a quality-gate change** (`AI_WORKFLOW.md` §7,
> `docs/operations/claude-autonomy.md` §3) and needs the human's approval **before merge**, on top of its own verification,
> adversarial probes and Fresh Review.
>
> Companion: `docs/design/claude-auto-implementation-roadmap.md` (the whole comp → site pipeline).

## 0. Why this exists

Second Root's product value is **design originality, completeness and fidelity to an original comp**. DEV-082 built a strict
safety base for "Claude implements a comp as a page": after its review rounds (a fifth is under way), the page CSS is an
allowlist in which nothing can stack, overlap, fade, transform, write vertically or use an image ground (`comp-to-site.md` §6,
§6a). That closed every bypass the reviewers found. It also means that a high-end wagashi comp — vertical shop name over a
photographic hero, a washi-texture ground, an asymmetric product spread, a mobile layout that is not just the desktop stacked —
**cannot be built** in it. A harness that is safe only because every page looks the same is not the goal.

DEV-083 widens what a page may express **without weakening what the harness proves**. The rule of this document:

> **No ban is lifted without a matching verification.** A capability is allowed only when a check exists that fails every
> known way of using it to hide, change, cover or invent shop text — and that check has been shown to fail the probes.

## 1. What never changes (the invariants)

These are not up for relaxation in DEV-083. A capability that would need one of them weakened is not offered.

| # | invariant | where it is enforced today |
|---|---|---|
| I1 | Every visible word (and alt, aria-label, title) is a fact from the facts source of truth, a verbatim fact excerpt, a fixed UI label or one of the two disclosures. No CSS-generated text (`content` strings, counters, `quotes`, markers with text), and no glyphs painted from an image (`background-clip: text` stays refused). | `checks.ts` `factsCheck`, `page-css.ts` |
| I2 | The disclosure and every required fact are shown, exact, legible, unoccluded and unaltered at every checked width. | `render.ts` `legibilityPass`, `PROTECTED_SCRIPT`, the sweep |
| I3 | No script, no network, no external or `data:` URL; only hash-listed assets. | `page.ts`, `render.ts` routing |
| I4 | Info labels are paired with their own fact, in reading order. | `PAIRS_SCRIPT`, `COMP_INFO_LABEL_FACTS` |
| I5 | No text the checks skip (no `aria-hidden` over text, no hidden fact). | `DOM_AUDIT_SCRIPT`, `MEASURE_SCRIPT` |
| I6 | The comp's own text is never data (no OCR); images are never read as text. | `comp-to-site.md` §4, §5 |
| I7 | Similarity never passes on its own; `faithful_reproduction_claimed` stays `false` without a real comp and a human's side-by-side judgement. | `similarity.ts`, `run.ts` |

## 2. The verification building blocks

DEV-082 has one strong primitive — the Stage 3 **pixel proof** (`shop-css/render-check.ts`: `lowContrastShare` on the ground
actually painted under the text, `inkOf` against a reference render with nothing but the text) — and a set of structural rules
that made the pixel proof unnecessary by forbidding overlap. DEV-083 turns that around: allow overlap, and **prove** that it
does not reach text — exactly by geometry and paint order, and by pixels as the second line. The blocks below are reused by
every capability in §3.

### V1. Semantic roles and layers (`data-comp-role`)

Every element gets a role, declared in HTML and **checked against the DOM**, never trusted:

| role | may contain text | may overlap | paint order |
|---|---|---|---|
| `content` (default) | yes | only under the rules of V2–V4 | must paint after every box that intersects its glyphs |
| `decoration` | **no** — any text node, alt, aria-label or `::before` / `::after` text in its subtree fails (`ROLE_DECORATION_HAS_TEXT`) | yes | anywhere, but V4 forbids intersecting protected text |
| `ground` | no | yes (it is what content sits on) | always before (below) the content it carries |
| `media` | no (an `img` slot) | yes, as ground under content, never above it | before content |

A `content` element can never be declared `decoration` (the role comes from the subtree; the attribute only confirms it).
**Containers that hold text are `content`.** A hero, a card or a section that contains text is a `content` element even when its
main visual is an image; its **own** background (colour, gradient or a `url()` texture) is painted below its own descendants by
definition (CSS 2.1 Appendix E, step 1 of its context) and is treated as the ground under its text (V3b applies to it). A `ground`
element is always a **text-free** box — a scrim, a band, a backdrop — that text overlaps as a sibling or a later box, never by
containing it. So "ground may not contain text" holds without exception: the hero container is `content`, the image inside it is
`media`, a scrim inside it is `ground`.
**Pseudo-elements (`::before`, `::after`, and any later-approved `::first-letter`) are always `decoration`**; they have no DOM
rect, so their geometry is computed from computed style (`getComputedStyle(el, '::before')`: display, position, offsets,
size, margins, transform) and checked against a probe that their computed box equals the box measured by rendering them alone
(a mismatch fails, `PSEUDO_GEOMETRY_UNKNOWN`).

**Deterministic. Cost: one DOM walk, negligible.**

### V2. Exact paint-order model

The pixel proof (V3) has tolerances: its ink lower bound of 0.8 lets a cover of up to ~20 % alpha through. So the paint-order
check must be **exact**, not a heuristic — it is the line that catches a faint cover.

V2 implements the painting order of **CSS 2.1 Appendix E**, with the CSS Display / Flexbox / Grid amendments:

- the stacking-context tree. Triggers: positioned elements with `z-index` ≠ `auto`; **flex and grid items with `z-index` ≠
  `auto` even when `position: static`**; `position: fixed` and `position: sticky` (always); `opacity` < 1; `transform`,
  `translate` / `rotate` / `scale`, `perspective`; `filter`, `backdrop-filter`; `isolation: isolate`; `mix-blend-mode` other than
  `normal`; `clip-path`, `mask` / `mask-image` / `mask-border`; `contain: paint` / `layout` / `strict` / `content`;
  `container-type: size` / `inline-size`; `will-change` naming any property that would create one; anything not in this list is
  refused before rendering if it can create a stacking context. Inside each context, inside each context, the seven layers (backgrounds and
  borders; negative-z contexts; in-flow non-positioned blocks; floats; inline content; `z-index: auto` / 0 positioned and
  pseudo-stacking descendants; positive-z contexts);
- **order-modified document order** for flex and grid items (`order` changes painting order, not just placement);
- **atomic painting** of flex items, grid items and inline-blocks: each paints as if it were a stacking context (its
  background, then its content, all at once), so a **later** flex / grid / inline-block sibling that overflows sideways paints
  completely above an earlier one's text — the class DEV-082's fifth review round found (§6, risk 1). Atomic painting is
  only "as if": **positioned descendants and real stacking contexts inside such an item escape to the parent stacking context**
  and are ordered there (by `z-index`, then tree order), not inside the item — so a `position: relative` child of an earlier
  flex item paints above a later item's in-flow text;
- a grid item in a **later** DOM position stacked on the same cells paints above an earlier one;
- an `opacity < 1` element (e.g. a translucent scrim) forms a stacking context painted in the z-index 0 layer, i.e. **above
  every in-flow non-positioned text** in its parent context, even when it comes earlier in the DOM.

Rule: for every `content` text line box (protected or not) and every other box whose **ink-overflow extent** (V4) intersects it
at the width under test, the other box must paint **before** the text. Any box that paints after the text and intersects it
fails (`PAINT_ORDER_COVER`), whatever its colour or alpha. Hit-testing (`document.elementsFromPoint`) is kept as a second
opinion only: DEV-082 showed it treats an `img` without a painted ground as transparent, and `pointer-events: none` removes an
element from it; `pointer-events` stays off the allowlist.

The model is a re-implementation of the spec's order and can drift from Chromium's. Its own test set compares its predicted
order with Chromium's actual painting on fixtures (render each pair with contrasting colours and read the pixel at the
intersection); a disagreement fails the build.

**Probes (each must fail):** a later grid item stacked on the same cell over a fact; a later flex item overflowing sideways
over an earlier item's text (`flex-shrink: 0`, a wide child); a later inline-block overflowing over the previous line's text;
an earlier-in-DOM `opacity: .9` scrim sitting over non-positioned text; `opacity: .2` cover (passes V3's ink bound, must fail
V2); a flex / grid cover that is earlier in the DOM but later in **order-modified** document order (`order: 1` on the cover)
and so paints above the text (and the reverse case, which must pass); a positioned
`z-index: auto` box after the text; a `z-index: -1` child escaping a parent's background; a float over inline text; `isolation:
isolate` plus `mix-blend-mode`; a transformed earlier sibling (transform → stacking context → paints above in-flow text); a
negative-margin card pulled over the previous section's text; a **static** grid / flex item with `z-index: 1` laid over an
earlier item's text (a stacking context without `position`); a `position: relative` (z-index auto) child of an **earlier** flex
item overflowing onto a later item's text (escapes atomic painting, paints above); a `position: sticky` header scrolled over a
fact in a full-page screenshot; `contain: paint` and `will-change: transform` on a cover (stacking contexts without the usual
properties).

**Deterministic. Cost: small (one script per width) plus the fixture comparison test.**

### V3. Layered per-glyph ink proof (extends `inkOf`)

Today: page picture vs a **reference** picture in which everything except the text is removed and the text is drawn on the
median colour of its ground (`CLEAN_CSS`, `REFERENCE_SCRIPT`, `groundColour`). That reference is why an image ground is not
proven today: on a photo, the flat median ground is the wrong comparison, and pixels where the text colour is close to the
photo count as "not covered".

DEV-083 reference: **keep the `ground` and `media` layers, remove every `decoration` element and every other text**, draw only
the node under test. Ink is compared on the same composited ground, glyph by glyph (the existing colour-free least-squares
coverage fit). Rule unchanged: every character's ink ratio in [0.8, 1.15], no character missing.

**Scope.** Today the proof runs on the disclosure and the required facts only. When a page declares an overlap capability (§3),
it runs on **every `content` text node whose box intersects a non-content box** — not on all text of every page, to bound cost.

**What V3 cannot see — and V3b closes.** Because the ground stays in the reference, anything the **ground** draws is invisible
to the ink comparison: a hard gradient stop, a texture or an image can paint a text-coloured stroke under a glyph and turn a
「1」 into a 「7」 or a 「4」, and both pictures contain the stroke. V3 alone is therefore not a proof over non-flat grounds.

**Deterministic. Cost: two extra screenshots per checked width — the dominant pixel cost.**

### V3b. Ground structure under glyphs

Over any ground that is not one flat colour:

- **Protected text** (the disclosure never sits on a non-flat ground at all — §3.1(a)): inside each glyph box (expanded by
  1 px), the ground picture with the text hidden must be **flat within a tolerance** — every channel within *t* of the glyph
  box's median, where channels are on the 0–255 scale and the provisional *t* = 6 (`GROUND_NOT_FLAT`) — **or** the text sits on a declared **scrim** (a `ground` element
  of one colour *S* with alpha *a*) whose worst case is proven **analytically**: for any pixel *g* under the scrim, the composite
  is *a·S + (1 − a)·g*. (1) Contrast: the composite is monotonic in each channel of *g* and relative luminance is monotonic per
  channel, so over every *g* in [0, 255]³ the composite's luminance fills the interval [*L*min, *L*max] between the two corner
  composites (*g* = black and *g* = white). Contrast against the text luminance *L*t is not monotonic over an interval that
  contains *L*t, so the rule is: **both** *L*min and *L*max lie on the **same side** of *L*t (both lighter or both darker), and the
  **nearer** of the two gives ≥ 4.5:1 against the text colour. (2) Structure: the scrim attenuates any
  stroke under it to at most *(1 − a)·255* per channel (0–255 scale); that must be ≤ *t*, i.e. *a* ≥ 1 − *t*/255 (≈ 0.976 at *t* = 6). In
  other words, over a busy image a protected fact needs a near-opaque scrim or a flat area of the image; a semi-transparent
  scrim is enough for non-protected text (next point) but not for facts.
- **Gradients**: no hard stops. Adjacent colour stops must be at least a minimum distance apart (provisional ≥ 24 px **and**
  ≥ 10 % of the gradient line), and the colour change per px along the line is bounded (provisional ≤ 2 per channel per px, 0–255 scale);
  `repeating-*-gradient`, `conic-gradient`, `border-image` and stacked gradient layers stay refused.
- **Other `content` text** over a non-flat ground: **ground busyness** — luminance standard deviation and Sobel edge energy
  inside each glyph box of the text-hidden picture — is a **gate** (`GROUND_TOO_BUSY` above the cap), not a report. Caps are
  provisional gate values, calibrated on real comps and approved by the human.
- **`background-clip: text`** (and `-webkit-background-clip: text`) **stays refused**: it paints a ground image *as* the
  glyphs, so the visible letters would come from an image.

**Probes (each must fail):** a hard-stop `linear-gradient` drawing a vertical bar in the text colour under 「1」 of the phone
number; the same with a 1 px soft edge (stop distance); `repeating-linear-gradient` stripes under hours; a texture asset with a
stroke placed under one digit; a cropped photo whose crop puts an edge under a digit at one width only (§3.1(a)); a scrim
at *a* = 0.9 over a text-coloured stroke (passes contrast, fails structure); a near-text-colour stroke (Δ just above *t*); a scrim whose two corner composites straddle the text luminance (each corner
passes 4.5:1, a mid-grey ground under it does not);
`background-clip: text` with a photo; `border-image` with a gradient; a `::before` decoration with a gradient under a fact
(V4 must already refuse it).

**Deterministic (pixel maths and analytic bounds). Thresholds need the human's approval.**

### V4. Nothing intersects protected text except proven-below media

At every width of the sweep, the **ink-overflow extent** of every non-content box — its border box plus `box-shadow`, `outline`,
`outline-offset`, `border-image` outset and filter spread, transformed to its bounding quad, pseudo-elements included (V1) —
must not intersect any line box of the disclosure or a required fact.

The one exception is **text over media or ground** (§3.1(a), capability `hero_overlay`), and only for required facts. It is
named after the hero, its main case, but it is **not limited to the hero**: it covers any `media` or `ground` element in any
section that meets all of the conditions below. The container holding the fact is `content` (V1):

- `FACT_IMAGE_OVERLAP` is relaxed **only** for a `media` (or `ground`) element that V2 proves paints **below** the fact **at
  every 1 px width** (V6), whose pixels under the fact pass V3b and the analytic contrast of §3.1(a);
- `DISCLOSURE_IMAGE_OVERLAP` is **unchanged**: nothing intersects the disclosure, ever;
- `decoration` never intersects protected text, whatever its paint order.

**Deterministic. Cost: small; runs inside the sweep script.**

### V5. Composited contrast

Contrast is measured per sampled pixel against the **picture with the text hidden** (`HIDE_TEXT_CSS`) — the ground actually
composited under each glyph, including photos, gradients, textures, translucent layers and `backdrop-filter`. Rule unchanged:
≤ 10 % of the samples under a node below 4.5:1. Together with V3b (structure) this replaces "contrast against a flat median".
For an `img` ground, the analytic form of §3.1(a) is used instead of screenshots wherever possible, because it covers every
width.

Lowering 4.5:1 for large display type (WCAG allows 3:1 for ≥ 24 px / ≥ 18.66 px bold) is a possible later proposal, not part
of this plan: it is a threshold change.

**Deterministic.**

### V6. The 1 px pass

DEV-082 sweeps every 32 px (51 widths) and argued a 1 px pass was unnecessary because no box can be shorter than its text and
nothing can stack. Once positioned elements, stacking and percentage offsets exist, an intersection can open and close between
two 32 px samples. For pages that declare a positioning, stacking or overlay capability, the **structural** checks — V2, V4,
`TEXT_BOX_OVERFLOW`, visibility, **and `PAIRS_SCRIPT`** (label ↔ fact pairs) — run at **every width 320–1920** for protected
text and the info pairs (no screenshots: rectangles and computed style). Pixel proofs stay at the checked widths (320, 360,
390, 768, 1024, 1440, 1920 and ±1 px of every breakpoint), except for the analytic image contrast of §3.1(a), which is cheap
enough to run at every width.

**Cost: measured in phase A (§10)** — the naive real-resize pass is 12.4 s, the layout hash alone ~0.9 s stepped. The estimate was: a realistic per-width cost for a resize plus the structural scripts is **50–200 ms**, which gives
**80–320 s** for 1601 widths — not affordable in CI per test, and possibly not per run. Phase A must measure it. Proposal:
**layout-change detection** — at every 1 px width run only a cheap script that hashes the layout state the checks depend on
(line-break positions per text node, rounded rects of text lines and of every positioned / stacked / overlapping box, the
stacking order of intersecting pairs); run the full structural checks only at widths where the hash changes, and at both
neighbours. The hashing itself still runs at every width (its cost is also to be measured), and a hash that leaves out an input
of a check would make the pass unsound — so the hash's input list is derived from the checks' inputs and tested against them.

**Deterministic.**

### V7. Capability flags and budget

`layout-spec.json` gains `capabilities: [...]`, a closed enum (§3). The page CSS allowlist becomes **the DEV-082 base plus the
property set of each declared capability**; using a property of an undeclared capability is refused before rendering
(`CAPABILITY_NOT_DECLARED`). Each capability brings its own checks, which run only when declared. A **budget** caps
complexity per page (provisional: ≤ 5 capabilities; ≤ 12 decoration elements; ≤ 3 text blocks over media; ≤ 6 transformed
elements). The report lists the declared capabilities, so the human reviewer sees exactly which relaxations a page uses.

Two reasons: (1) the attack surface of a page is the base plus what it declared, not every relaxation ever approved;
(2) CI time and run time scale with what a page uses.

**Deterministic.**

### V8. Text-transform identity

For any transformed `content` text, the composed matrix of its ancestor chain (`TEXT_ROTATED` already composes it): determinant
> 0 (no mirroring), rotation ≤ a cap, no skew beyond a cap, effective size (font size × scale × zoom) ≥ 12 px. Protected text:
no transform at all (unchanged).

**Deterministic.**

### V9. Reading order, visibility and writing mode under re-layout

When the visual order may differ from DOM order (grid placement, `order`, mobile re-layout, vertical writing, columns):

- **visibility matrix**: every fact that is shown at one checked width is shown at every checked width (a mobile layout may move
  a fact, never drop it). Hiding is allowed for `decoration` and for a **duplicate** of non-fact UI (a second nav), nothing else;
- **reading order**: within a section, the visual order of `content` blocks (sorted in the writing mode's reading direction with
  a tolerance) equals the order the spec declares for that width; `PAIR_ORDER` / `PAIR_LINE` stay as they are;
- **info pairs are never placed**: grid placement, `grid-area` / areas, `order`, positioning and reversed directions are refused
  on `dl`, `dt`, `dd` and every element between them (the `dl` moves as a whole); `PAIRS_SCRIPT` also runs in V6;
- **computed writing mode**: `dt`, `dd` and the disclosure must have a **computed** `writing-mode: horizontal-tb` — checked from
  computed style, so a vertical ancestor whose writing mode they inherit fails (`PROTECTED_VERTICAL`);
- **mobile order**: the existing `mobileOrderCheck` against the spec.

**Deterministic.**

### V10. Engine and font robustness

Every proof above holds **for the harness's Chromium and the fonts installed on the machine that ran it**. The page's main
audience opens it from an Instagram DM — i.e. **iOS WebKit with Hiragino** — where glyph advances, line breaks and therefore every
overlap differ. A layout that leaves 2 px between a decoration and a fact in Chromium can cover it on an iPhone.

- **Pinned web fonts are a prerequisite** for every capability that lets something overlap or sit near text (`hero_overlay`,
  `layered_decoration`, `magazine_grid` with stacking, `vertical_type`, `transformed_decoration`, `fluid_type`): the page must
  load its text faces as **local, hash-pinned `@font-face` assets** (§3.1(c)) with `font-display: block`, so every engine lays
  the text out with the same font file. Hence font pinning moves to **phase B**, ahead of phase C (§7).
- **Metric-perturbation pass** for declared overlap capabilities: re-run the structural checks (V2, V4, V6 at the checked widths
  and around every change point) with (1) the pinned face replaced by a **wider fallback face** (the widest installed CJK face,
  standing in for a font that failed to load), and (2) `letter-spacing` ± 0.05 em added to all text. A page whose proofs only
  hold at the exact metrics fails (`METRICS_FRAGILE`).
- **WebKit runs** (Playwright's WebKit build) for declared capabilities, if the human approves adding a browser (it is a new
  CI dependency and download). Honest limit: Playwright WebKit on Linux is not iOS Safari, and Hiragino is not licensed for
  Linux, so this narrows the gap but does not close it. A **real-device screenshot** (an iPhone, by a person) stays on the
  human review sheet for any page with an overlap capability.

**Deterministic (perturbation, WebKit) + human (real device).**

### V11. Human visual review

What no check here can judge: whether an overlay is beautiful, whether a filter reveals latent content in an AI image, whether
the real-device rendering is right, whether the result looks like the comp. These go on the review sheet (roadmap §4) next to
the comp, with the declared capabilities listed. **A page that uses a capability marked "H" in §3 cannot be marked ready
without that sheet.**

## 3. Capabilities: allowed expression ⇄ how it is verified

Columns: **allowed** (what a page may do once approved), **verification** (V-blocks + new rules), **D/H** (D = decided by a
deterministic check, H = needs a human or visual review in addition), **phase** (§7). "Protected" = the disclosure and required
facts. Every row also keeps I1–I7, and every overlap-capable row needs pinned fonts and the perturbation pass (V10).

### 3.1 The capabilities the human named

**(a) Text over photos or images in a hero — readable overlays.**

- Allowed: the hero (a `content` container, V1) holds a `media` image; its text sits on it. Overlap built **preferably with grid stacking**
  (one named area shared by the media and the text block, media **first** in DOM so it paints first — V2), or with
  `position: relative` on the hero and `position: absolute` on the media (media first in DOM, never a `z-index` above content).
  A scrim (`ground` of one colour with alpha, or a gradient obeying V3b) between them is allowed.
- Protected text over an image: **allowed for required facts** such as the shop name (a vertical shop name over the hero is the
  most common high-end wagashi motif), **never for the disclosure**, which stays on a flat ground. Allowing the disclosure over an
  image would be a separate human decision (roadmap A-list).
- **Contrast and structure on a cropped image.** The visible part of the image changes with every width (`object-fit:
  cover` crops differently), so screenshots at the checked widths are not enough. Either:
  1. **analytic**: decode the asset (the harness already has the bytes and `decodePng`), and at **every 1 px width** compute the
     image's rendered rect and the `object-fit` / `object-position` mapping (only `cover`, `contain`, `fill` and `object-position`
     in % or px are allowed under text; no filter, transform or blend on that media), map each glyph box of the text to source
     pixels, and apply V3b and V5 to those pixels — no screenshot needed, so every width is affordable; or
  2. **scrim**: the text sits on a scrim whose bound is proven analytically (V3b), which makes the image's content irrelevant.
  Protected facts need (1) with the flat-ground rule, or (2) with the near-opaque scrim; other text may use either with the
  busyness gate.
- **The same for `url()` grounds** (textures and background images, §3.1(g)): under protected text, the analytic mapping at
  every 1 px width must also model `background-size` (`cover`, `contain`, lengths, %), `background-position` (lengths, %) and
  `background-repeat` (`repeat`, `no-repeat`, `round`, `space` — tiling and rounding computed exactly, `background-origin` /
  `background-attachment` fixed at their defaults), mapping each glyph box to the asset's source pixels. Until that mapping exists
  and is proven against Chromium on fixtures, **protected text over a texture or background image is allowed only on the
  near-opaque scrim** of V3b.
- Further verification: V1 roles; V2 media below content at every 1 px width (V6); V3 layered ink proof at the checked widths;
  V4 (only proven-below media may meet a fact); `TEXT_BOX_OVERFLOW`; V10. The image is never read as text (I6): an AI image
  could carry text under the overlay — that stays with the person's per-image review (`assets.json` approval record).
- D, + **H** for the image and the real-device check. Phase C.

**(b) Asymmetric magazine layouts.**

- Allowed: `grid-template-areas`, explicit line placement (`grid-column: 2 / 8`), spanning items, unequal tracks, items sharing
  rows at different heights, `align-self` offsets; negative margins on `decoration`. Not allowed: `grid-auto-flow: dense`
  (it reorders silently); placement of `dl` / `dt` / `dd` (V9).
- Verification: V9 reading order against the spec's declared order per width; `PAIR_*` unchanged; V2 + V4 if anything overlaps
  (a later grid item on shared cells paints above — V2); `TEXT_BOX_OVERFLOW`; content-sized rows stay (fixed rows still fail
  `FIXED_HEIGHT_TEXT`).
- D. Phase C (one placement per page; a placement that differs per width is phase E).

**(c) Creative typography.**

| expression | allowed | verification | D/H | phase |
|---|---|---|---|---|
| brand web fonts | `@font-face` with a **local asset** from a pinned list of vetted fonts (sha256 in the repository, e.g. the OFL Mincho / Gothic faces the site already serves via `next/font`), `font-display: block` | sha256 allowlist (a symbol font that redraws digits cannot be added without a reviewed list change); no `unicode-range`; fonts served by the page router like assets; each font's licence and provenance recorded and approved by the human | D (+ human approval per font) | **B** |
| tracking | `letter-spacing` down to −0.05 em (display / heading roles), any positive value | `overprinted` per glyph pair (existing), V3 on the node, V10 perturbation | D | D |
| scale contrast | display sizes beyond today's ±20 % of the spec's scale (the spec carries the scale) | `typeCheck` vs spec; ≥ 12 px floor unchanged | D | B |
| Latin capitals / small caps | `text-transform: uppercase`, `font-variant-caps: small-caps` **only on elements whose text is a fixed UI label**, never on a fact | static: the element's text must be a `COMP_UI_LABELS` entry; DOM check | D | D |
| 縦書き, decorative | a `decoration` element holds no text (V1), so decorative vertical type is a **`content`** element whose text is a fixed label or the shop name used as an ornament (e.g. a large vertical 架空菓庵 beside the hero); it gets exactly the real-text verification of the next row | as the next row | D | D |
| 縦書き, real text | `writing-mode: vertical-rl`, `text-orientation: mixed` for the shop name, headings, the description and verbatim excerpts; **not** for the info pairs or the disclosure (V9 checks their **computed** writing mode, so inheriting a vertical ancestor fails). Tate-chū-yoko for digits: `text-combine-upright: digits 2` is **not relied on** — to our knowledge Chromium implements only `none` / `all`, and WebKit's support is unverified; phase D must test both engines before using any form of it, and the fallback is `all` on an element wrapping the digits | the "box shorter than its text" family on **logical** axes: `TEXT_BOX_OVERFLOW` checks `scrollWidth > clientWidth` in vertical writing, `FIXED_HEIGHT_TEXT` applies to the inline-size properties in vertical writing (`width` / `max-width` become block size); V3 per-glyph ink with the reference drawn in the same writing mode; V9 reading order right-to-left between columns; V10 | D (+H for whether rotated Latin / digits read well) | D |
| outlined / shadowed display type | `text-shadow` with offset ≤ 0.08 em and blur ≥ 0 on display / heading roles, never on protected text; `-webkit-text-stroke` ≤ 2 px later | the reference render includes the declared shadow (so ink compares like with like); the offset cap keeps a shadow from forming a second readable copy; contrast measured on the fill **and** the stroke | D (+H) | D (stroke: F) |
| drop caps | `::first-letter` on body / description text that is not a required fact: `font-size` ≥ the parent's, colour and weight only | V3 on that node (the reference includes the same rule); the `font-size` floor is static; the pseudo-element's geometry per V1 | D | D |

**(d) Safe overlap of decoration and content.**

- Allowed: `position: relative / absolute` and `z-index` on `decoration` elements and on `content` cards; negative margins;
  offset frames, layered cards. Ornaments from `::before` / `::after` with **`content: ""` only** (a box, no text; anything else
  stays refused, I1) are **phase B when they do not overlap text** (in-flow, no positioning) and phase C when positioned.
- Verification: V1 (a decoration with text fails; pseudo-elements are decoration), V2 exact paint order, V3 on every content node a
  positioned box reaches, V4 (never touches protected text, ink-overflow extents), V6, V10. The fourth review's F1 (a later
  `position: relative` sibling covering text between sweep widths) and the fifth round's class (§6, risk 1) are regression probes
  that must keep failing.
- D. Phase C.

**(e) Responsive free placement, and mobile re-layout that differs from desktop.**

- Allowed: under `@media`, different `grid-template-areas`, `order`, reversed flex directions, a different hero composition on
  mobile; `display: none` on `decoration` and on a **duplicate** nav; a collapsible nav with `<details>` / `<summary>` (no
  script) if it holds only nav labels. Never on `dl` / `dt` / `dd` (V9).
- Verification: V9 (visibility matrix — no fact disappears at any width; reading order per width; mobile order vs spec);
  `PAIR_*` at every checked width and in V6; V2 for order-modified painting; the overflow sweep unchanged.
- Fluid type and spacing (`clamp(… vw)`) and container queries: allowed only together with V6 on **all** text, because wrapping
  then changes at widths no breakpoint names (the third review's finding). The most expensive capability.
- D. Phase E.

**(f) Grids and asymmetric compositions.** Same as (b); plus `grid-template-rows` with fixed sizes **only on rows that hold no
text** (image rows, spacer rows), checked by mapping row tracks to the elements placed in them (`FIXED_ROW_TEXT`). D. Phase C.

**(g) Gradients, textures, background images.**

- Allowed: `linear-gradient` / `radial-gradient` with stops from the spec palette (± the palette tolerance) and the V3b stop
  rule; `background-image: url(…)` only to an asset in `assets.json` of kind `texture` or `ai_concept_local`, hash-checked,
  served by the same router; `background-size / position / repeat`; on `ground` and `decoration` elements and as a `content` container's own background
  (V1).
  `background-clip: text` stays refused.
- New asset kind `texture` (a washi or paper scan, a pattern): a human-approved local asset like `ai_concept_local`, with licence
  and provenance recorded; never in the asset store without the separate DEV-070 / DEV-076 decision.
- Verification: V3b ground structure (flat or scrim for protected text; busyness gate for other text; stop distance), V5
  composited contrast, V3 with the ground layer kept; the tokenizer accepts `url()` only for listed asset paths
  (`CSS_URL_NOT_ASSET`); palette check extended to gradient stops.
- D (+H for textures). **Phase B under no text** (a ground with no text over it, e.g. a band or a frame); **phase C under
  text**.

**(h) Complex first views.** Not one capability but a **combination**: a full-bleed hero with a photo, a vertical shop name
over it, a decorative frame, a scrim, an asymmetric copy block. Verification is the union of (a), (c), (d), (g), and the
budget (V7) caps how many layers a first view may stack.
Full-bleed height: `min-height` (never `height`) on a `ground` element. **Viewport-height units (`vh`, `svh`, `lvh`, `dvh`) stay
refused** unless the page also runs a **viewport-height sweep**: the checks of V2, V4, V6 and the analytic image contrast over a
matrix of real viewport shapes — short laptops (1280 × 600, 1366 × 650), 1440 × 900, 1920 × 1080, phones in portrait
(360 × 640, 390 × 844) and **landscape** (740 × 360, 844 × 390) — because a `vh`-sized hero crops its image and moves its text
with the height, which width sweeps never vary. D + **H** (the first view is where fidelity is judged). Phase C (without
`vh`), with `vh` only once the height sweep exists.

**(i) A different structure per shop.** The spec already chooses sections, order, boxes and slots per comp; what limits structure
today is the vocabulary: section roles (`header / hero / products / info / footer / other`) and `COMP_UI_LABELS` (11 fixed
labels). Proposal: per-industry **label sets** reviewed by the human (e.g. 季節の菓子 / 店主の言葉 are not facts, so they need
approval as labels), more section roles (`story`, `seasonal`, `gallery`), and the capabilities above. **Every label-vocabulary
and section-role addition needs the human's approval.** Structure must come **from the comp**, never from injected variation
(§4). D for the vocabulary; **H** for whether the structure serves the shop. Phase B (vocabulary proposal) and ongoing.

### 3.2 Every other §6a row

| §6a capability | allowed expression | verification | D/H | phase |
|---|---|---|---|---|
| tilted, scaled or mirrored elements | `decoration`: any 2D transform within its own box budget; `content` (not protected): rotation ≤ 8°, uniform scale with effective size ≥ 12 px, no mirroring, no skew > 5°; protected: none | V8 composed matrix; V2 (a transform makes a stacking context); V3 on rotated content; V10 | D | D |
| parallax-like shifts, motion, transitions | not offered: never visible in a screenshot, so never verified | — | — | not planned |
| fades, translucency | `opacity` < 1 on `decoration` / `ground` / `media` only; text keeps opacity product ≥ 0.85 (unchanged) | V2 (opacity makes a stacking context painted above in-flow text); `MIN_OPACITY` on every text chain | D | B (not over text); C (over text) |
| filters on images and decoration | a fixed list (`grayscale`, `sepia`, `brightness`, `contrast`, `blur`, `saturate`) with bounded parameters, on `media` / `decoration` **not under text** | static bounds; V2 (a filter makes a stacking context); **H**: the person reviews the asset **rendered with the same filter** (a contrast filter can reveal latent content an unfiltered review missed) | D + H | B |
| blend modes, duotone | `mix-blend-mode` on `decoration` and `media` only, never on an element whose subtree or ancestors hold text, never under protected text | static role check + computed chain; V3b / V5 on the composited result | D (+H for media) | D |
| frosted glass | `backdrop-filter: blur()` on a `ground` behind non-protected text | V3b busyness gate and V5 on the blurred composite | D | D |
| `clip-path` / `mask` | on `media` and `decoration` only (shaped photos, torn-paper edges) with basic shapes; never on a text chain | static role check; V2; `NO_INK` / V3 still catches a clipped text | D | D |
| multi-column text | `column-count` ≤ 3 on description / body text; never on an element containing a `dl`, the disclosure or a required fact | static containment; V9 reading order (columns top-to-bottom, then across); `TEXT_BOX_OVERFLOW` | D | E |
| fixed heights, equal-height cards | equal heights through grid / flex stretch (grows with content); `min-height` in px on `ground`; fixed heights on text still refused; `vh` units per §3.1(h) | existing `FIXED_HEIGHT_TEXT` family | D | B |
| line clamping, ellipsis | **not offered**: truncation shows part of a fact (I2) | — | — | never |
| hover / focus states | `:hover`, `:focus-visible` on links: colour, underline, background only | rendered in each forced state (Playwright hover / keyboard focus) and the contrast proof run in that state | D | F |
| custom list markers, numbered steps | `ol` with `decimal` / `decimal-leading-zero`, `::marker` colour only, on non-fact lists | facts check counts marker text (digits) as a fixed ornament set; V3 | D | F |
| inline SVG icons | SVG as `img` assets only (no inline SVG): a strict SVG allowlist parser (no `<text>`, `<foreignObject>`, `<script>`, external `href`, `<image>`) | static parse; asset hash; **H** review of the icon | D + H | F |
| video, canvas | not offered | — | — | never |
| richer colour (`hsl`, `oklch`, named colours) | allowed; checks use the computed sRGB value | palette check on computed colour | D | B |
| any `dl` other than shop information | only when the facts source has the pairs (e.g. `menuItems` with prices once a price is a verified fact); otherwise invented content (I1) | the existing pair mapping, extended per fact key | D | not planned (facts source change) |
| captions beyond fact excerpts | **not an expressiveness limit**: invented text (I1) | — | — | never |
| `aria-hidden` over text, bidi controls, `content` strings, `background-clip: text` | **not offered** (I1, I5) | — | — | never |

## 4. Anti-template: difference is not quality

DEV-082's guard (`anti-template.ts`: renderer markers, CSS reuse ≤ 20 %, structural fingerprint distance > 0.35 from the demo
templates and the profile renderer) answers one question: *is this page a renamed copy of an existing template?* It does not,
and cannot, answer *is this page good* or *is this page the comp*.

- **The structural difference score is a supporting metric.** A random page scores far from every template. A page that
  differs structurally from the templates can still be generic, ugly or unlike its comp. Passing the guard is evidence of
  non-copying, nothing more; failing it remains a strong signal and a hard fail.
- **Never optimise toward distance.** The fix loop (roadmap §5) must not use the distance as a reward or a target. Structure
  comes from the comp; injected variation to "look different" is itself a template behaviour.
- **Three independent evaluations**, never merged into one number:
  1. *comp fidelity* — does the page look like the comp (human side-by-side, similarity metrics as aids only, I7);
  2. *design quality* — is the page itself good on PC and mobile, fit for the shop, original (human review sheet, roadmap §4);
  3. *non-copying* — the anti-template guard (mechanical).
  A page needs all three; a high score on one never compensates another.
- **Across shops**: the real failure mode the human named — "everything looks the same" — is a portfolio property. Proposal:
  record each implemented page's fingerprint and report its nearest **other shop's page** (not only the templates). Report only,
  not a gate: two shops of the same industry may legitimately share a structure if their comps do.
- **The capabilities of §3 raise legitimate distance**: most of today's pages converge because the allowlist leaves only
  stacked blocks. Widening expression is the actual anti-template measure; the guard only catches copying.

## 5. Which checks are deterministic, which need a person

| question | deterministic check | human / visual review |
|---|---|---|
| is every word a fact / label / disclosure | `factsCheck` (I1) | — |
| is protected text shown, exact, legible, unoccluded | V2 (exact), V3, V3b, V4, V5, V6, existing legibility | — |
| is non-protected text unoccluded where something overlaps it | V2, V3 (scoped) | — |
| can the ground draw a stroke under a glyph | V3b (flat / analytic scrim / stop distance / busyness gate) | — |
| does decoration stay off text | V1, V2, V4 | — |
| is the reading order right after re-layout | V9 | whether the order *reads well* |
| is vertical type correct | V3 (same writing mode), logical-axis overflow, computed writing mode on pairs | whether rotated digits / Latin read well |
| does it hold on iOS WebKit / other fonts | V10 pinned fonts, perturbation pass, WebKit runs (if approved) | **real-device screenshot** |
| is an image or texture acceptable | V3b / V5 numbers | yes, always for photos and textures |
| does a filter reveal hidden content in an image | — | yes (asset reviewed with the filter) |
| does the page look like the comp | similarity metrics (report only) | **yes — the only judge** |
| is the design good, original, on-brand | — | **yes** |
| is it a template copy | anti-template guard | — |

## 6. Costs, CI time, risks

**Run time (estimates; phase A measured the rows that exist — §10 has the numbers).** A DEV-082 full run takes
about 13 s.

| added work | per run, estimate | when |
|---|---|---|
| V1, V2, V4, V8, V9 (DOM / computed style / rectangles, inside existing scripts) | +0.5–2 s | always once phase A lands |
| V3 scoped to overlapped content text (2 screenshots × 7–10 checked widths) | +2–5 s | when an overlap capability is declared |
| V3b, V5 on screenshots | < 0.5 s (same pictures) | with non-flat grounds |
| analytic image contrast at every 1 px width (decoded asset, no screenshots) | +1–5 s | text over media |
| V6 1 px structural pass, naive (50–200 ms per width × 1601) | **+80–320 s — unmeasured, likely unaffordable** | positioning declared |
| V6 with layout-change detection (hash every width, full checks at change points) | unknown until measured; expected a fraction of the naive cost | positioning declared |
| V10 perturbation pass (2 extra variants of the structural checks) | roughly ×2–3 of the structural cost | overlap capabilities |
| V10 WebKit run (if approved) | roughly the Chromium cost again | overlap capabilities |
| viewport-height sweep (8 shapes) | +2–6 s | `vh` units |
| forced hover / focus states | +1–3 s | phase F |

**CI time is the binding constraint.** The unit job ran **672 s** of its 15-minute limit at 0301171 and **678 s** at 2d27cb3
(PR #96), with comp-impl's Chromium tests inside it. DEV-083 adds per-capability probe sets (DEV-082's rounds used 39–101 probes
each) and new e2e runs. It **does not fit the unit job.** Proposal (needs the human's approval — it changes
`.github/workflows/ci.yml`): move `tests/unit/design-agent/comp-impl/**` into its own job, sharded like the existing `shop-css`
job (DEV-072 precedent: "every test still runs on every PR"), and run the 1 px pass on one shared fixture per capability rather
than in every test. **The new job must also be added to the required-CI list** (`docs/RELEASE.md` §2 — static / unit /
integration / build / e2e / e2e-sales — and the branch protection's required checks, HUMAN-003), or moving tests out of `unit`
would quietly make them non-required. Until the split is approved, phase A must keep the unit job inside its limit by sharing
runs between tests (as DEV-082's last round did) and must not skip tests.

**Risks.**

1. **Combinatorial bypasses.** Every DEV-082 review round found a *combination* of allowed properties that hid text. Each
   capability multiplies combinations. Mitigations: verification first, then relaxation; per-capability **and cross-capability**
   probe sets; the budget (V7); a Fresh Review per phase whose brief is bypass hunting; an exact paint-order model (V2) rather
   than tolerances.
   **Regression set.** Every bypass class of DEV-082's rounds stays in the probe set, including the **fifth round's**: a
   required fact covered between sweep widths by a **later flex, grid or inline-block item through sideways overflow** (atomic
   painting puts the later item's background above the earlier item's text). V2's atomic-painting rule and V6 must both fail it.
2. **Ground-drawn glyph strokes.** Closed by V3b; its tolerances need real-comp calibration.
3. **Engine and font divergence.** Proofs are Chromium-on-Linux facts. Pinned fonts, the perturbation pass and (if approved)
   WebKit narrow the gap; a real-device check by a person remains.
4. **Paint-model drift.** V2 re-implements the spec; its fixture comparison with Chromium's painting is what keeps it honest.
5. **Pixel-proof noise on photos.** Antialiasing over photographic grounds may give ink ratios outside [0.8, 1.15] for honest
   pages. Mitigation: V3 compares on the same ground layer; calibrate on real comps; a tolerance change is a gate change.
6. **Scope creep into a CSS engine.** Each capability is a narrow property set with a closed value grammar, not "allow
   `position`". If a capability needs an open grammar, it is not offered.
7. **CI time** (above): without the split and the required-check update, phases C and E cannot run their probe sets in CI and
   must wait.
8. **Rubric pressure.** The comp rubric's implementability criterion (`design-image-eval-template.md` §5) scores "complex
   overlaps, text on busy images" as 3, and the rubric now requires every criterion ≥ 4 (the human's policy of 2026-10-22). Once
   DEV-083 phases land, that anchor should be revisited (a human decision), or Codex will keep being steered away from the designs
   DEV-083 makes possible.

## 7. Incremental order

Each phase is its own PR to `develop`, with its probes as tests that must fail, a Fresh Review and CI on the latest SHA. A later
phase never starts before the earlier one is merged. **Approval:** phase A follows the normal `AI_WORKFLOW.md` §4 conditions
(it relaxes nothing); **phases B–F need the human's approval of the gate change before merge** (§8).

| phase | content | relaxes anything? | approval | depends on |
|---|---|---|---|---|
| **A — verification only** | V1 roles (incl. pseudo-element geometry), V2 exact paint-order model with its Chromium fixture comparison, V3 layered reference and V3b ground structure (on raw test HTML, not through the page allowlist), V4 with ink-overflow extents, V9 incl. computed writing mode, V7 capability schema with an **empty** enum, layout-change hashing for V6, the perturbation harness of V10; **measured** timings for every row of §6 | **no** | AI_WORKFLOW §4 | DEV-082 merged; ideally the CI split |
| **B — fonts and low-risk grounds** | **pinned web fonts** (`web_font`; prerequisite for C–E) and the V10 perturbation pass; gradients and textures **under no text**; **scale contrast** (`type_scale`: display sizes beyond ±20 %); **richer colour syntax** (`colour_syntax`: `hsl`, `oklch`, named
colours); `opacity` and the **fixed filter list** (`image_filters`) on decoration and media **not under text**; in-flow `::before` / `::after` ornaments with `content: ""` (not overlapping text); equal heights via stretch, `min-height` in px on ground; label-vocabulary / section-role proposal | yes (`web_font`, `type_scale`, `colour_syntax`, `gradient_ground`, `translucent_decoration`, `image_filters`, `ornament`) | human, before merge | A |
| **C — overlap and composition** | positioning and `z-index` for decoration and cards (incl. positioned ornaments); grid areas / explicit lines (one placement for all widths); text over media in the hero (required facts included, never the disclosure) with the analytic image contrast; gradients / textures / translucency under text; V6 1 px pass; viewport-height sweep if `vh` is wanted | yes (`hero_overlay`, `layered_decoration`, `magazine_grid`) | human, before merge | B, CI split |
| **D — typography and effects** | vertical writing (name, headings, description), tracking, label-only caps, drop caps, shadows, small rotations of non-protected text, blend / backdrop / clip on non-text | yes (`vertical_type`, `display_type`, `transformed_decoration`, `blend_effects`) | human, before merge | C |
| **E — responsive freedom** | per-width re-layout and **reordering** (`order`, reversed directions, per-width areas, details nav), fluid type with V6 on all text, multi-column body text | yes (`mobile_relayout`, `fluid_type`, `columns`) | human, before merge | C (D optional) |
| **F — states and icons** | hover / focus states, `ol` markers, SVG icons, text stroke | yes | human, before merge | E |

**How phase A is wired.** Phase A's checks are added to `run.ts` as gates that **only add refusals**: no existing check,
tolerance or threshold is relaxed, and with the capability enum empty no page gains an expression. The existing synthetic fixture
(`scripts/sales-design-worker/comp-impl/synthetic-wagashi/`) and every page that passes today **must still pass**: a stricter gate
that changes the outcome for existing pages is itself a quality-gate change needing the human's approval
(`claude-autonomy.md` §3). So if a phase A check would fail the existing synthetic fixture (or any existing passing test page),
the work **stops and asks the human** — it does not change the fixture or loosen the new check to make it pass, and it does not
merge under AI_WORKFLOW §4.

Reordering is therefore only in phase E; phase C allows a fixed grid placement whose reading order V9 checks, and nothing ever
places the info pairs. The first real comp (roadmap stages 1–5) should be implemented **after phase A**: it tells which
capabilities real comps actually need and calibrates V3 / V3b / V5 on real images. Phases B–F may be reordered by that
evidence (a human decision), except that **font pinning stays before any overlap capability**.

## 8. How each relaxation is reviewed

A relaxation is any change that lets a page do something the allowlist refused. It is a **quality-gate change** and follows
this process, stricter than the autonomous feature → develop merge (`claude-autonomy.md` §1). (Phase A is not a relaxation; it
follows AI_WORKFLOW §4 — as long as it changes no outcome for existing pages, §7.)

1. **Proposal row** (in this document or its successor): capability name, exact property / value grammar, roles it applies to,
   the V-blocks and new rules that verify it, D/H, cost, probes.
2. **Verification before relaxation.** The checks land and are shown to fail the probes **with the property enabled behind a
   test-only switch**, before the allowlist changes. A capability whose probes do not all fail is not enabled.
3. **Probe set.** Every known bypass category of DEV-082's rounds (including the fifth round's sideways-overflow class) re-run
   with the new capability, plus capability-specific and cross-capability probes and the probes listed under V2 and V3b. Counts
   (refused / rendered and failed / passed) and every passing probe's screenshot recorded, as in `comp-to-site.md` §6.
4. **Fresh Review** of the latest SHA with an explicit bypass-hunting brief (`.ai/reviews/DEV-083*.md`).
5. **Human approval** of the gate change **before merge**, recorded in the PR and `.ai/blockers.md` (a HUMAN-xxx entry per
   phase). CI green and a Fresh Review PASS are necessary, not sufficient: no relaxation is merged autonomously.
6. **Rollback** is one line: remove the capability from the enum. Pages that declared it are then refused (fail closed); no
   page silently loses its proof.
7. **Thresholds** (ink [0.8, 1.15], 4.5:1, 10 %, 12 px, 0.85 opacity, the flat-ground tolerance, the scrim alpha, stop distance,
   busyness caps, budgets, tolerances) are gate values: a change to any of them is a separate human approval before merge, never
   bundled with a capability.

## 9. Not changed by this document

Nothing in the harness. This is a plan. `lib/design-agent/comp-impl/**`, `docs/operations/comp-to-site.md`,
`lib/design-agent/shop-css/**`, the sales demo, the worker and its timer, the asset store rules, the quality gates and thresholds,
`.github/workflows`, `package.json`, Production, Staging and the database are untouched. (The same PR records the human's
rubric policy of 2026-10-22 — every criterion ≥ 4 — in the rubric documents; see the roadmap §2, stage 1.)

## 10. Phase A as built (2026-10-22)

The human approved starting phase A on 2026-10-22 with these conditions:
- strengthen checks only;
- do not relax the CSS allowlist;
- connect nothing to operations (worker, real Codex, Next.js app routes, sales);
- later phases may be designed here, but any implemented relaxation needs its own approval.

Phase A leaves these unchanged:
- `page-css.ts`, the DOM allowlist, the spec schema, every existing check in `checks.ts` / `render.ts`, every tolerance and
  threshold.
- Every existing comp-impl test passes without modification.

**The guarantee, precisely.** A new code may enter `failed` only when the DEV-082 allowlist and the existing checks
already refuse every page it refuses (the argument per code is in the table below). Every other new finding goes to
`report.advisory`, which never enters `failed` and never changes `mechanical_ok`. So **`mechanical_ok` and pass / fail are
the same as before phase A for every page**, not only for the synthetic fixture. A page that already fails because a fact is
hidden at some checked widths may additionally list `visibility_matrix` in `failed` (a re-report of `text_<w>`). This is shown, not assumed, for:
- the synthetic fixture;
- the review's three allowlisted pages that a flat-ground gate would have refused: a highlight span, a `border-left` with 0
  padding, a dark badge `dd` (`phase-a.test.ts`, one whole run: `failed` is empty, `GROUND_NOT_FLAT` is in `advisory`).

**No widening.**
- `data-comp-role` is **not** accepted on a page. The DOM allowlist still refuses it (`DOM_ATTRIBUTE_NOT_ALLOWED`).
- In the run every role is derived from the DOM. Declared roles are read only on a test path (`layerScan({ declared: true })`).
- Accepting the attribute is deferred to phase B and needs the human's approval.
- A `capabilities` key in `layout-spec.json` is still refused (`SPEC_SHAPE`), present or absent, empty or not.
- The report's `capabilities: []` is derived internally.

### Each new code: blocking or advisory

| code | where | blocking? | why |
|---|---|---|---|
| `PSEUDO_GEOMETRY_UNKNOWN` | `layers_<w>`, `layers_sweep` | **blocking** | a generated `::before` / `::after` needs a pseudo-element selector (refused, `CSS_PSEUDO_ELEMENT`) and `content` (not in the property table); none of the allowed elements has UA-generated content; any other element fails `DOM_ELEMENT_NOT_ALLOWED`. Every page it refuses is refused before rendering |
| `STACKING_CONTEXT` | same | **blocking** | of the allowlisted properties only `position` (static only) and `opacity` (1 only) can create a context; no UA style of an allowed element creates one. The trigger list fails closed (any non-initial `will-change`, `contain`, `content-visibility`, `container-type`, `offset-path`, reflection, mask border, plus the §2 list), and none of those properties is allowlisted. Every page it refuses is refused before rendering |
| `PROTECTED_VERTICAL` | same | **blocking** | `writing-mode` is `horizontal-tb` only, and no allowed element has a vertical UA style |
| `ROLE_UNKNOWN`, `ROLE_MISMATCH`, `ROLE_*_HAS_TEXT` | same | **blocking**, but **never produced by the run** | the run never reads `data-comp-role` (derived roles only); a page carrying the attribute already fails `dom` |
| `FACT_VISIBILITY_CHANGES` | `visibility_matrix` | **blocking** | `MEASURE_SCRIPT` measures every text node at every checked width (only `aria-hidden` text is skipped, which fails `TEXT_ARIA_HIDDEN`); a fact node hidden at one checked width fails `TEXT_FACT_HIDDEN` in `text_<width>` there. It only re-reports a refusal that exists. It uses the **checked widths only** (not the sweep, not the 1 px pass) |
| `CAPABILITY_NOT_APPROVED` | `capabilities` | **blocking**, never produced | the declared list is always empty (the schema refuses the key) |
| `PAINT_ORDER_COVER` | `advisory` | advisory | its geometry (a box meeting a text's range rect by > 0.5 px) is stricter than the existing hit-test (15 points across the middle of each protected line) and covers all text, so an allowlisted page that passes today can trip it |
| `DISCLOSURE_NONCONTENT_OVERLAP`, `FACT_NONCONTENT_OVERLAP` | `advisory` | advisory | a text-free box meeting a protected line box by > 0.5 px is not refused today unless it hides glyphs; and the split is **evadable by one character**: give the covering box one character of text and it is `content`, outside V4. Coverage of protected text rests on V2 (any later painting box, content or not) plus the existing checks (1 px hit-test pass, `IMAGE_OVERLAP`, ink proof), not on V4 |
| `GROUND_NOT_FLAT` | `advisory` | advisory | refuses allowlisted pages that pass today (the review's highlight span: deviation 11; `border-left` with 0 padding: 203; a dark badge `dd` with 0 padding: 203). Both the threshold (*t* = 6) and the semantics (glyph box + 1 px on all four sides) need the human's approval as a gate |
| `GROUND_UNMEASURED` | `advisory` | advisory | V3b measured fewer protected nodes than exist (e.g. a page over the screenshot height cap) |

### What was built

**V1 roles** (`layers.ts` `LAYER_SCRIPT`)
- Every element gets a derived role:
  - content: the subtree holds text or an aria-label;
  - media: an img or a placeholder slot;
  - decoration: any other text-free box.
- On the test path only, a declared role must confirm the derived one.
- Any generated pseudo-element fails closed.

**V2 paint order** (`LAYER_SCRIPT`)
- CSS 2.1 Appendix E, with:
  - order-modified document order;
  - atomic painting of inline-blocks, flex and grid items, inline replaced elements and floats;
  - escape of positioned descendants and real contexts to the parent context;
  - outlines last.
- Painting is **fail-closed**. A box paints when any of these is off its inert initial value: ground colour or image, a
  visible border, **any** box-shadow (an inset shadow paints over the border box: the review's probe is a fixture),
  border image, column rule, scrollbars.
- Filters, backdrop filters and reflections are treated as painting over everything after them.
- A box event after a text event whose extent meets one of its line boxes is `PAINT_ORDER_COVER`, whatever the colour or
  alpha.
- Not modelled: text-on-text, which `overprinted` owns.

**V2 Chromium comparison** (`render.ts` `paintCrossCheck`; `phase-a.test.ts`)
- 23 fixtures: 5 inside today's allowlist, including the inset-shadow probe, and 18 raw HTML.
- For each text / box pair, the text is drawn pure red and everything else transparent; the box is then painted or not.
- Only the glyph's interior pixels are read: opaque red pixels whose four neighbours are red too.
- Each fixture's key pair must be conclusive (≥ 20 interior pixels; 69+ at the time of writing), and every conclusive pair
  must agree with the model.
- Locally the changed share is 0 for "text on top" and ≥ 0.88 for "box on top"; CI runs the same assertions.
- History: the first version read edge pixels too. On CI's rasterizer, 4 "text on top" fixtures read as unclear (5–50 %
  changed) while they passed locally.
- The fixture face (IPAGothic, CI's `fonts-ipafont-gothic`) is checked at start: missing, the file fails with that message.

**V3 layered reference** (`render.ts` `layeredInkPass`)
- The reference keeps ground and media, hides decoration and every non-protected text.
- Tested on raw HTML (a smooth gradient ground passes; a translucent decoration fails).
- Not used by `run.ts`.

**V3b ground structure** (`verify.ts` `groundStructure`)
- Per protected glyph box grown by 1 px on all four sides (pixels the grown box touches): max channel deviation from the
  median, luminance deviation, Sobel energy.
- `scrimBound` and `gradientStopProblems` are pure functions with the §2 probes.
- Advisory (above).

**V4 extents** (`LAYER_SCRIPT`)
- Border box + outset shadows + outline, the bounding box of any transform, unbounded for filters.
- Checked for non-content elements against protected line boxes.
- Advisory, and evadable by one character (above).

**V6** (`LAYOUT_HASH_SCRIPT`, `layoutHashPass`, `gatedGeometryPass`)
- The layout signature around every protected line.
- The gated 1 px pass is equivalence-tested width by width against the full pass on the synthetic page, the fifth-review
  probes A and B (320–1920), the sixth review's real-resize probe and the seventh review's centred root.
- Not wired into `run.ts`.

**V7** (`spec.ts` `APPROVED_CAPABILITIES = []`, `verify.ts` `capabilitiesCheck`, `report.capabilities`)
- The schema is unchanged (above).

**V9** (`LAYER_SCRIPT`, `verify.ts`)
- Computed writing mode of dt, dd, the disclosure and protected text.
- Visibility matrix over the checked widths.

**V10** (`perturbedGeometryPass`, `PERTURB_SCRIPT`, `WIDEST_FACE_SCRIPT`, `metricsCheck`)
- The widest installed allowlisted face (here DejaVu Serif; no wider CJK face is installed) or ±0.05 em tracking.
- `METRICS_FRAGILE`. A harness only.

### Skipped or deferred, and why (no rule weakened)

- **Accepting `data-comp-role` on a page, and the pseudo-element geometry proof** (V1): phase B, with approval.
- **The `capabilities` field in the spec**: comes with the first approved capability.
- **V9 reading order against a spec-declared order per section and width**: needs a spec field (phase C / E).
  `PAIR_ORDER`, `PAIR_LINE` and `mobileOrderCheck` are unchanged.
- **`position: sticky` probe**: sticky is refused, and its cover depends on scrolling, which the harness never does.
- **Budget (V7)**: provisional values for the human; nothing to count.
- **WebKit runs, viewport-height sweep, analytic image contrast, hover / focus states**: not built (a new browser needs
  approval; the rest belong to phases C and F), so their §6 rows stay estimates.

### Measured costs (local container, Chromium 1194, best of 3 unless noted; before the review fixes, which add no work to the run)

| §6 row | measured |
|---|---|
| V1 + V2 + V4 + V9 (`LAYER_SCRIPT`, one call per width, synthetic page) | **6.8 ms per width** (51 sweep widths); 6–23 ms at the checked widths |
| V3b on the existing pictures | **33 ms per checked width** (165 protected glyphs) |
| one checked width (`legibilityPass` with the layer scan and V3b) | 949 ms |
| coarse sweep, 51 widths, with the layer scan | 2.3 s |
| **whole run, synthetic page** | **10.8 s → 11.7 s (+0.94 s)** |
| V3 layered reference, one width (4 screenshots) | 0.94 s |
| 1 px pass, current (root width stepped) | 1.58 s synthetic, 1.49 s probe A |
| 1 px pass, naive (real resize at all 1,601 widths) | **12.4 s** synthetic, 12.6 s probe A (≈ 7.8 ms a width) |
| layout hash alone, stepped / with real resizes | 0.97 s / 13.0 s |
| gated 1 px pass (hash + `GEOMETRY_SCRIPT` at change points) | 1.13 s synthetic (65 widths measured fully, 30 signature changes); 1.29 s probe A (105 widths, 67 changes); same findings as the full pass |
| V10 perturbation, one variant over 320–1920 | 1.7–2.2 s |
| V2 Chromium comparison | ~85–130 ms per fixture |

**What the numbers say for V6.** The doc's 50–200 ms per width was pessimistic. A real resize plus the structural script
costs about 8 ms, so a naive 1 px pass over 1,601 widths costs **~12.5 s** per page, not 80–320 s.

The cost is the **resize itself**:
- Where the viewport has to be resized for real, hashing every width costs as much as measuring, so layout-change
  detection saves nothing.
- Where the root's width can be stepped, the full pass is already ~1.5 s and the hash saves ~0.3 s.

So phase A keeps the full 1 px pass in `run.ts`, and the gated pass stays an equivalence-tested tool. Capabilities that need
real resizes (viewport units, `vh` heroes, fixed positioning) should budget **~12.5 s per page per variant**. V10 multiplies
that by 3.

**CI.** The new test file (`tests/unit/design-agent/comp-impl/phase-a.test.ts`) takes ~37 s of test time, including one
whole run. It runs in the sharded unit jobs (DEV-085).
