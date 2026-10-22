# DEV-083: high-quality design, reproduced safely

> **Design and plan only.** No code, no Codex, no model or API call, no WSL run. Nothing in this document is in force.
> DEV-083 starts after DEV-082 (PR #96, `docs/operations/comp-to-site.md`, `lib/design-agent/comp-impl/`) is merged.
> **Every relaxation described here is a quality-gate change** (`docs/AI_WORKFLOW.md` §7, `docs/operations/claude-autonomy.md` §3):
> each one lands only with its own verification, its own adversarial probes, a Fresh Review, and the human's approval.
>
> Companion: `docs/design/claude-auto-implementation-roadmap.md` (the whole comp → site pipeline).

## 0. Why this exists

Second Root's product value is **design originality, completeness and fidelity to an original comp**. DEV-082 built a strict
safety base for "Claude implements a comp as a page": after four review rounds, the page CSS is an allowlist in which nothing
can stack, overlap, fade, transform, write vertically or use an image ground (`comp-to-site.md` §6, §6a). That closed every
bypass the reviewers found. It also means that a high-end wagashi comp — vertical shop name over a photographic hero, a
washi-texture ground, an asymmetric product spread, a mobile layout that is not just the desktop stacked — **cannot be built**
in it. A harness that is safe only because every page looks the same is not the goal.

DEV-083 widens what a page may express **without weakening what the harness proves**. The rule of this document:

> **No ban is lifted without a matching verification.** A capability is allowed only when a check exists that fails every
> known way of using it to hide, change, cover or invent shop text — and that check has been shown to fail the probes.

## 1. What never changes (the invariants)

These are not up for relaxation in DEV-083. A capability that would need one of them weakened is not offered.

| # | invariant | where it is enforced today |
|---|---|---|
| I1 | Every visible word (and alt, aria-label, title) is a fact from the facts source of truth, a verbatim fact excerpt, a fixed UI label or one of the two disclosures. No CSS-generated text (`content` strings, counters, `quotes`, markers with text). | `checks.ts` `factsCheck`, `page-css.ts` (no `content`) |
| I2 | The disclosure and every required fact are shown, exact, legible, unoccluded and unaltered at every checked width. | `render.ts` `legibilityPass`, `PROTECTED_SCRIPT`, the sweep |
| I3 | No script, no network, no external or `data:` URL; only hash-listed assets. | `page.ts`, `render.ts` routing |
| I4 | Info labels are paired with their own fact, in reading order. | `PAIRS_SCRIPT`, `COMP_INFO_LABEL_FACTS` |
| I5 | No text the checks skip (no `aria-hidden` over text, no hidden fact). | `DOM_AUDIT_SCRIPT`, `MEASURE_SCRIPT` |
| I6 | The comp's own text is never data (no OCR); images are never read. | `comp-to-site.md` §4, §5 |
| I7 | Similarity never passes on its own; `faithful_reproduction_claimed` stays `false` without a real comp and a human's side-by-side judgement. | `similarity.ts`, `run.ts` |

## 2. The verification building blocks

DEV-082 has one strong primitive — the Stage 3 **pixel proof** (`shop-css/render-check.ts`: `lowContrastShare` on the ground
actually painted under the text, `inkOf` against a reference render with nothing but the text) — and a set of structural rules
that made the pixel proof unnecessary by forbidding overlap. DEV-083 turns that around: allow overlap, and **prove** per glyph
that it does not reach text. The blocks below are reused by every capability in §3.

### V1. Semantic roles and layers (`data-comp-role`)

Every element gets a role, declared in HTML and **checked against the DOM**, never trusted:

| role | may contain text | may overlap | paint order |
|---|---|---|---|
| `content` (default) | yes | only under the rules of V2/V3 | must be topmost over its own glyphs |
| `decoration` | **no** — any text node, alt, aria-label or `::before` / `::after` text in its subtree fails (`ROLE_DECORATION_HAS_TEXT`) | yes | anywhere, but V4 forbids intersecting protected text |
| `ground` | no | yes (it is what content sits on) | always below the content it carries |
| `media` | no (an `img` slot) | yes, as ground under content, never above it | below content |

A `content` element can never be declared `decoration` (the role comes from the subtree, the attribute only confirms it).
Roles feed every later check: "decoration cannot cover text" is only checkable if the harness knows which boxes are decoration.

**Deterministic. Cost: one DOM walk, negligible.**

### V2. Paint-order audit (stacking)

For each width checked: list every stacking context (`position` ≠ static with `z-index`, `opacity` < 1, `transform`, `filter`,
`isolation`, `mix-blend-mode` …) and its z-order, from computed style. Rule: **no `decoration`, `ground` or `media` box may paint
above a `content` box whose line boxes it intersects.** Computed from the stacking tree, not from hit-testing alone.

Why not just `document.elementsFromPoint`: DEV-082 showed the shop-CSS hit-test treats an `img` without a painted ground as
transparent, and `pointer-events: none` removes an element from hit-testing entirely. Hit-tests are kept as a second opinion,
never as the proof; `pointer-events` stays off the allowlist.

**Deterministic. Cost: small (one script per width).**

### V3. Layered per-glyph ink proof (extends `inkOf`)

Today: page picture vs a **reference** picture in which everything except the text is removed and the text is drawn on the
median colour of its ground (`CLEAN_CSS`, `REFERENCE_SCRIPT`, `groundColour`). That reference is why an image ground is not
proven today: on a photo, the flat median ground is the wrong comparison, and pixels where the text colour is close to the
photo count as "not covered".

DEV-083 reference: **keep the `ground` and `media` layers, remove every `decoration` element and every other text**, draw only
the node under test. Ink is then compared on the same composited ground, glyph by glyph (the existing colour-free least-squares
coverage fit). Rule unchanged: every character's ink ratio in [0.8, 1.15], no character missing. Anything painted above the text
(a decoration, a translucent card, a neighbour's shadow) takes ink away or adds it, and fails.

Extension of scope: today the proof runs on the disclosure and the required facts only. When a page declares an overlap
capability (§3), the proof runs on **every `content` text node that intersects a non-content box** — not on all text of every
page, to keep the cost bounded.

**Deterministic. Cost: two extra screenshots per checked width (with and without the node set) — the dominant new cost.**

### V4. Decoration ∩ protected text = ∅ (geometry)

At every width of the sweep: the border boxes (transformed to their bounding quads) of all `decoration`, `ground`-above-flow and
positioned boxes must not intersect any line box of the disclosure or a required fact. This is the existing
`DISCLOSURE_IMAGE_OVERLAP` / `FACT_IMAGE_OVERLAP` rectangle check, generalised from `img` to every non-content box.
Protected text is therefore **never** overlapped by decoration; only non-protected text may be (and then V3 proves it).

**Deterministic. Cost: small; runs inside the existing sweep script.**

### V5. Composited contrast

Contrast is measured per sampled pixel against the **picture with the text hidden** (`HIDE_TEXT_CSS`) — the ground actually
composited under each glyph, including photos, gradients, textures, translucent layers and `backdrop-filter`. Rule unchanged:
≤ 10 % of the samples under a node below 4.5:1. New: a **ground busyness** measure (luminance standard deviation and edge density
under the glyph boxes) reported for every text over a non-flat ground, with a provisional cap (to be calibrated on real comps;
the cap itself is a gate value and needs the human's approval). A busy photo can pass 90 % of samples at 4.5:1 and still be
hard to read; busyness above the cap fails, between a lower bound and the cap goes to human review.

A **scrim** (a gradient or translucent `ground` under the text) is the intended fix and is measured like any other ground.

Lowering 4.5:1 for large display type (WCAG allows 3:1 for ≥ 24 px / ≥ 18.66 px bold) is a possible later proposal, not part
of this plan: it is a threshold change.

**Deterministic (pixel maths); the busyness cap needs human calibration.**

### V6. The 1 px geometric pass for protected text

DEV-082 sweeps every 32 px (51 widths) and argued a 1 px pass was unnecessary because no box can be shorter than its text and
nothing can stack. Once positioned elements and percentage offsets exist, an intersection can open and close between two
32 px samples. For pages that declare a positioning capability, the structural checks (V2, V4, `TEXT_BOX_OVERFLOW`, visibility)
run at **every width 320–1920** for protected text only (no pixels: rectangles and computed style). Pixel proofs stay at the
checked widths (320, 360, 390, 768, 1024, 1440, 1920 and ±1 px of every breakpoint).

Where it is affordable, the same pass extends to all `content` text that a positioned box can reach (V3 scope).

**Deterministic. Cost: see §6 — estimated 25–50 s per run; this is the main CI-time item.**

### V7. Capability flags and budget

`layout-spec.json` gains `capabilities: [...]`, a closed enum (§3). The page CSS allowlist becomes **the DEV-082 base plus the
property set of each declared capability**; using a property of an undeclared capability is refused before rendering
(`CAPABILITY_NOT_DECLARED`). Each capability brings its own checks, which run only when declared. A **budget** caps
complexity per page (provisional: ≤ 5 capabilities; per-capability counts such as ≤ 12 decoration elements, ≤ 3 text blocks
over media, ≤ 6 transformed elements). The report lists the declared capabilities, so the human reviewer sees exactly which
relaxations a page uses.

Two reasons: (1) the attack surface of a page is the base plus what it declared, not every relaxation ever approved;
(2) CI time and run time scale with what a page uses.

**Deterministic.**

### V8. Text-transform identity

For any transformed `content` text, the composed matrix of its ancestor chain (`TEXT_ROTATED` already composes it): determinant
> 0 (no mirroring), rotation ≤ a cap, no skew beyond a cap, effective size (font size × scale × zoom) ≥ 12 px. Protected text:
no transform at all (unchanged).

**Deterministic.**

### V9. Reading order and visibility under re-layout

When the visual order may differ from DOM order (grid areas, `order`, mobile re-layout, vertical writing, columns):

- **visibility matrix**: every fact that is shown at one checked width is shown at every checked width (a mobile layout may move
  a fact, never drop it). Hiding is allowed for `decoration` and for a **duplicate** of non-fact UI (a second nav), nothing else;
- **reading order**: within a section, the visual order of `content` blocks (sorted in the writing mode's reading direction with
  a tolerance) equals the order the spec declares for that width; `PAIR_ORDER` / `PAIR_LINE` stay as they are;
- **mobile order**: the existing `mobileOrderCheck` against the spec.

**Deterministic.**

### V10. Human visual review

What no check here can judge: whether an overlay is beautiful, whether a busy photo under text is acceptable in the middle band
of V5, whether a filter reveals latent content in an AI image, whether the result looks like the comp. These go on the review
sheet (roadmap §4) next to the comp, with the declared capabilities listed. **A page that uses a capability marked "human" in §3
cannot be marked ready without that sheet.**

## 3. Capabilities: allowed expression ⇄ how it is verified

Columns: **allowed** (what a page may do once approved), **verification** (V-blocks + new rules), **D/H** (D = decided by a
deterministic check, H = needs a human or visual review in addition), **phase** (§7). "Protected" = the disclosure and required
facts. Every row also keeps I1–I7.

### 3.1 The capabilities the human named

**(a) Text over photos or images in a hero — readable overlays.**

- Allowed: the hero `ground` holds a `media` image; `content` text sits on it. Overlap built **preferably with grid stacking**
  (`grid-template-areas` with one named area shared by the media and the text block — the visual order still follows the DOM, no
  offsets), or with `position: relative` on the hero and `position: absolute` on the media (media first in DOM, never a
  `z-index` above content). A scrim (gradient / translucent ground) between them is allowed.
- Protected text over an image: **allowed for the shop name and other required facts** (a vertical shop name over the hero is the
  most common high-end wagashi motif), **never for the disclosure** (it stays on a flat ground — a deliberate choice; changing it
  is a separate human decision).
- Verification: V1 roles; V2 media/ground below content; V3 layered ink proof on the image ground; V5 composited contrast +
  busyness; V6 1 px structural pass; existing `TEXT_BOX_OVERFLOW`. The image itself is not read (I6): an AI image could carry
  text under the overlay — that stays with the person's per-image review (`assets.json` approval record).
- D/H: D for coverage and contrast; **H** for busyness in the middle band and for the image. Phase C.

**(b) Asymmetric magazine layouts.**

- Allowed: `grid-template-areas`, explicit line placement (`grid-column: 2 / 8`), spanning items, unequal tracks, items sharing
  rows at different heights, `align-self` offsets; negative margins on `decoration`. Not allowed: `grid-auto-flow: dense`
  (it reorders silently; revisit only with V9 in place and a probe set).
- Verification: V9 reading order against the spec's declared order per width; `PAIR_*` unchanged; V4 if anything overlaps;
  `TEXT_BOX_OVERFLOW`; content-sized rows stay (fixed rows still fail `FIXED_HEIGHT_TEXT`).
- D. Phase C (grid placement) — the layout half of most real comps.

**(c) Creative typography.**

| expression | allowed | verification | D/H | phase |
|---|---|---|---|---|
| tracking | `letter-spacing` down to −0.05 em (display / heading roles), any positive value | `overprinted` per glyph pair (existing), V3 on the node | D | D |
| scale contrast | display sizes beyond today's ±20 % of the spec's scale (the spec carries the scale) | `typeCheck` vs spec; ≥ 12 px floor unchanged | D | B |
| Latin capitals / small caps | `text-transform: uppercase`, `font-variant-caps: small-caps` **only on elements whose text is a fixed UI label**, never on a fact | static: the element's text must be a `COMP_UI_LABELS` entry; DOM check | D | D |
| 縦書き, decorative | a `decoration` element holds no text (V1), so decorative vertical type is a **`content`** element whose text is a fixed label or the shop name used as an ornament (e.g. a large vertical 架空菓庵 beside the hero); it gets exactly the real-text verification of the next row | as the next row | D | D |
| 縦書き, real text | `writing-mode: vertical-rl`, `text-orientation: mixed`, `text-combine-upright: digits 2` for the shop name, headings, the description and verbatim excerpts; **not** for the info pairs (hours, closed days, address, phone, access) or the disclosure in the first step | the "box shorter than its text" family on **logical** axes: `TEXT_BOX_OVERFLOW` checks `scrollWidth > clientWidth` in vertical writing, `FIXED_HEIGHT_TEXT` applies to the inline-size properties in vertical writing (`width` / `max-width` become block size); V3 per-glyph ink with the reference drawn in the same writing mode; V9 reading order right-to-left between columns; `PAIR_*` untouched because pairs stay horizontal | D (+H for whether rotated Latin / digits read well) | D |
| outlined / shadowed display type | `text-shadow` with offset ≤ 0.08 em and blur ≥ 0 on display / heading roles, never on protected text; `-webkit-text-stroke` ≤ 2 px later | the reference render includes the declared shadow (so ink compares like with like); the offset cap keeps a shadow from forming a second readable copy; contrast measured on the fill **and** the stroke | D (+H) | D (stroke: F) |
| drop caps | `::first-letter` on body / description text that is not a required fact: `font-size` ≥ the parent's, colour and weight only | V3 on that node (the reference includes the same `::first-letter` rule); the rule's `font-size` floor is static | D | D |
| brand web fonts | `@font-face` with a **local asset** from a pinned list of vetted fonts (sha256 in the repository, e.g. the OFL Mincho / Gothic faces the site already serves via `next/font`) | sha256 allowlist (a symbol font that redraws digits cannot be added without a reviewed list change); no `unicode-range`; fonts served by the page router like assets | D | D |

**(d) Safe overlap of decoration and content.**

- Allowed: `position: relative / absolute` and `z-index` on `decoration` elements and on `content` cards; negative margins;
  offset frames, layered cards, ornaments from `::before` / `::after` with **`content: ""` only** (the empty string — a box, no
  text; anything else stays refused, I1).
- Verification: V1 (a decoration with text fails), V2 (no decoration above content it touches), V3 on every content node a
  positioned box reaches, V4 (never touches protected text), V6. The fourth review's F1 (a later `position: relative` sibling
  covering text between sweep widths) is the regression probe that must keep failing.
- D. Phase C.

**(e) Responsive free placement, and mobile re-layout that differs from desktop.**

- Allowed: under `@media`, different `grid-template-areas`, `order`, reversed flex directions, a different hero composition on
  mobile; `display: none` on `decoration` and on a **duplicate** nav; a collapsible nav with `<details>` / `<summary>` (no
  script) if it holds only nav labels.
- Verification: V9 (visibility matrix — no fact disappears at any width; reading order per width; mobile order vs spec);
  `PAIR_*` at every checked width; V6 when positioning is used; the overflow sweep unchanged.
- Fluid type and spacing (`clamp(… vw)`) and container queries: allowed only together with the 1 px pass (V6) on all text,
  because wrapping then changes at widths no breakpoint names (the third review's finding). D, but the most expensive
  capability; phase E.
- D. Phase E.

**(f) Grids and asymmetric compositions.** Same as (b); plus `grid-template-rows` with fixed sizes **only on rows that hold no
text** (image rows, spacer rows), checked by mapping row tracks to the elements placed in them (`FIXED_ROW_TEXT`). D. Phase C.

**(g) Gradients, textures, background images.**

- Allowed: `linear-gradient` / `radial-gradient` with stops from the spec palette (± the palette tolerance); `background-image:
  url(…)` only to an asset in `assets.json` of kind `texture` or `ai_concept_local`, hash-checked, served by the same router;
  `background-size / position / repeat`; on `ground` and `decoration` elements.
- New asset kind `texture` (a washi or paper scan, a pattern): a human-approved local asset like `ai_concept_local`, never in
  the asset store without the separate DEV-070 / DEV-076 decision.
- Verification: V5 composited contrast + busyness for every text over a non-flat ground; V3 with the ground layer kept; the
  tokenizer accepts `url()` only for listed asset paths (`CSS_URL_NOT_ASSET`); palette check extended to gradient stops.
- D (+H for textures under body text). Phase B (gradients, textures under no text), Phase C (under text).

**(h) Complex first views.** Not one capability but a **combination**: a full-bleed hero with a photo, a vertical shop name
over it, a decorative frame, a scrim, an asymmetric copy block. Verification is the union of (a), (c), (d), (g), and the
budget (V7) caps how many layers a first view may stack. Full-bleed height: `min-height` (never `height`) with `svh` /
`vh` units **only on a `ground` element** (it can only grow, so text cannot leave it; `TEXT_BOX_OVERFLOW` still runs).
D + **H** (the first view is where fidelity is judged). Phase C/D.

**(i) A different structure per shop.** The spec already chooses sections, order, boxes and slots per comp; what limits structure
today is the vocabulary: section roles (`header / hero / products / info / footer / other`) and `COMP_UI_LABELS` (11 fixed
labels). Proposal: per-industry **label sets** reviewed by the human (e.g. 季節の菓子 / 店主の言葉 are not facts, so they need
approval as labels), more section roles (`story`, `seasonal`, `gallery`, `access-map-placeholder`), and the capabilities above.
Structure must come **from the comp**, never from injected variation (see §4). D for the vocabulary; **H** for whether the
structure serves the shop. Phase B (vocabulary) and ongoing.

### 3.2 Every other §6a row

| §6a capability | allowed expression | verification | D/H | phase |
|---|---|---|---|---|
| tilted, scaled or mirrored elements | `decoration`: any 2D transform within its own box budget; `content` (not protected): rotation ≤ 8°, uniform scale with effective size ≥ 12 px, no mirroring, no skew > 5°; protected: none | V8 composed matrix; V2 (a transform makes a stacking context); V3 on rotated content | D | D |
| parallax-like shifts, motion, transitions | not offered: never visible in a screenshot, so never verified | — | — | not planned |
| fades, translucency | `opacity` < 1 on `decoration` / `ground` / `media` only; text keeps opacity product ≥ 0.85 (unchanged) | V2 (opacity makes a stacking context); `MIN_OPACITY` on every text chain | D | B |
| blend modes, duotone | `mix-blend-mode` on `decoration` and `media` only, never on an element whose subtree or ancestors hold text | static role check + computed chain; V5 on the composited result | D (+H for media) | D |
| frosted glass | `backdrop-filter: blur()` on a `ground` behind text | V5 measures the blurred composite | D | D |
| filters on images | a fixed list (`grayscale`, `sepia`, `brightness`, `contrast`, `blur`, `saturate`) with bounded parameters, on `media` / `decoration` | static bounds; **H**: the person reviews the asset **rendered with the same filter** (a contrast filter can reveal latent content an unfiltered review missed) | H | D |
| `clip-path` / `mask` | on `media` and `decoration` only (shaped photos, torn-paper edges) with basic shapes; never on a text chain | static role check; `NO_INK` / V3 still catches a clipped text | D | D |
| multi-column text | `column-count` ≤ 3 on description / body text; never on an element containing a `dl`, the disclosure or a required fact | static containment; V9 reading order (columns top-to-bottom, then across); `TEXT_BOX_OVERFLOW` | D | E |
| fixed heights, equal-height cards | equal heights through grid / flex stretch (grows with content); `min-height` on `ground`; fixed heights on text still refused | existing `FIXED_HEIGHT_TEXT` family | D | B |
| line clamping, ellipsis | **not offered**: truncation shows part of a fact (I2) | — | — | never |
| hover / focus states | `:hover`, `:focus-visible` on links: colour, underline, background only | rendered in each forced state (Playwright hover / keyboard focus) and the contrast proof run in that state | D | F |
| custom list markers, numbered steps | `ol` with `decimal` / `decimal-leading-zero`, `::marker` colour only, on non-fact lists | facts check counts marker text (digits) as a fixed ornament set; V3 | D | F |
| inline SVG icons | SVG as `img` assets only (no inline SVG): a strict SVG allowlist parser (no `<text>`, `<foreignObject>`, `<script>`, external `href`, `<image>`) | static parse; asset hash; **H** review of the icon | D + H | F |
| video, canvas | not offered | — | — | never |
| richer colour (`hsl`, `oklch`, named colours) | allowed; checks use the computed sRGB value | palette check on computed colour | D | B |
| any `dl` other than shop information | only when the facts source has the pairs (e.g. `menuItems` with prices once a price is a verified fact); otherwise invented content (I1) | the existing pair mapping, extended per fact key | D | not planned (facts source change) |
| captions beyond fact excerpts | **not an expressiveness limit**: invented text (I1) | — | — | never |
| `aria-hidden` over text, bidi controls, `content` strings | **not offered** (I1, I5) | — | — | never |

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
| is protected text shown, exact, legible, unoccluded | V2, V3, V4, V5, V6, existing legibility | middle-band busyness (V5) |
| is non-protected text unoccluded where something overlaps it | V3 (scoped) | — |
| does decoration stay off text | V1, V2, V4 | — |
| is the reading order right after re-layout | V9 | whether the order *reads well* |
| is vertical type correct | V3 (same writing mode), logical-axis overflow | whether rotated digits / Latin read well |
| is an image or texture acceptable under text | V5 numbers | yes, always for photos and textures |
| does a filter reveal hidden content in an image | — | yes (asset reviewed with the filter) |
| does the page look like the comp | similarity metrics (report only) | **yes — the only judge** |
| is the design good, original, on-brand | — | **yes** |
| is it a template copy | anti-template guard | — |

## 6. Costs, CI time, risks

**Run time (estimates, to be measured in phase A before any phase is approved).** A DEV-082 full run takes about 13 s.

| added work | per run, estimate | when |
|---|---|---|
| V1, V2, V4, V8, V9 (DOM / computed style / rectangles, inside existing scripts) | +0.5–1.5 s | always once phase A lands |
| V3 scoped to overlapped content text (2 screenshots × 7–10 checked widths) | +2–5 s | when an overlap capability is declared |
| V5 busyness | < 0.5 s (same pictures) | with non-flat grounds |
| V6 1 px structural pass, protected text, 1601 widths in one resized context (~15–30 ms each) | +25–50 s | when positioning is declared |
| V6 extended to all text (fluid type) | +40–90 s | phase E only |
| forced hover / focus states | +1–3 s | phase F |

**CI time is the binding constraint.** The unit job ran 672 s of its 15-minute limit at 0301171 (PR #96), with comp-impl's
Chromium tests inside it. DEV-083 adds per-capability probe sets (DEV-082's rounds used 39–101 probes each) and new e2e runs.
It **does not fit the unit job.** Proposal (needs the human's approval — it changes `.github/workflows/ci.yml`): move
`tests/unit/design-agent/comp-impl/**` into its own job, sharded like the existing `shop-css` job (DEV-072 precedent: "every
test still runs on every PR"), and run the 1 px pass on one shared fixture per capability rather than in every test. Until that
is approved, phase A must keep the unit job inside its limit by sharing runs between tests (as DEV-082's last round did) and
must not skip tests.

**Risks.**

1. **Combinatorial bypasses.** Every DEV-082 review round found a *combination* of allowed properties that hid text. Each
   capability multiplies combinations. Mitigations: verification first, then relaxation; per-capability **and cross-capability**
   probe sets (each new capability is probed together with every earlier one); the budget (V7); a Fresh Review per phase whose
   brief is bypass hunting.
2. **Pixel-proof noise on photos.** Antialiasing over photographic grounds may give ink ratios outside [0.8, 1.15] for honest
   pages. Mitigation: V3 compares on the same ground layer (that is its point); calibrate on real comps; a tolerance change is a
   gate change.
3. **False confidence from hit-testing.** Addressed by making V2 stacking-tree based and keeping `pointer-events` off.
4. **Machine-dependent fonts.** References are rendered on the same machine in the same run, so the proof is internally
   consistent; fidelity to the comp's typeface is a human judgement until web fonts (phase D) land.
5. **Scope creep into a CSS engine.** Each capability is a narrow property set with a closed value grammar, not "allow
   `position`". If a capability needs an open grammar, it is not offered.
6. **CI time** (above): if the split is not approved, the later phases (C/E) cannot run their probe sets in CI and must wait.
7. **Rubric pressure.** The comp rubric's implementability criterion (`design-image-eval-template.md` §5) scores "complex
   overlaps, text on busy images" as 3. Once DEV-083 phases land, that anchor should be revisited (a human decision), or Codex
   will keep being steered away from the designs DEV-083 makes possible.

## 7. Incremental order

Each phase is its own PR to `develop`, with its probes as tests that must fail, a Fresh Review, CI on the latest SHA, and **the
human's approval of the gate change before merge** (§8). A later phase never starts before the earlier one is merged.

| phase | content | relaxes anything? | depends on |
|---|---|---|---|
| **A — verification only** | V1 roles, V2 stacking audit, V4 generalised intersection, V3 layered reference (on raw test HTML, not through the page allowlist), V5 busyness (report only), V7 capability schema with an **empty** enum, V9 visibility matrix; measured timings | **no** | DEV-082 merged; ideally the CI split |
| **B — low-risk grounds** | gradients from the palette, richer colour syntax, `opacity` / filters on decoration and media, equal-height via stretch, `min-height` on ground, label vocabulary proposal, `texture` asset kind under no text, `::before` / `::after` with `content: ""` | yes (capabilities `gradient_ground`, `translucent_decoration`, `ornament`) | A |
| **C — overlap and composition** | positioning and `z-index` for decoration and cards, grid areas / explicit lines, text over media in the hero (protected text included except the disclosure), textures under text, V6 1 px pass | yes (`hero_overlay`, `layered_decoration`, `magazine_grid`) | B, CI split |
| **D — typography** | vertical writing (name, headings, description), tracking, label-only caps, drop caps, shadows, pinned web fonts, small rotations, blend / backdrop / clip on non-text | yes (`vertical_type`, `display_type`, `web_font`, `transformed_decoration`) | C |
| **E — responsive freedom** | mobile re-layout (`order`, areas, details nav), fluid type with V6 on all text, multi-column body text | yes (`mobile_relayout`, `fluid_type`, `columns`) | C (D optional) |
| **F — states and icons** | hover / focus states, `ol` markers, SVG icons, text stroke | yes | E |

The first real comp (roadmap stage 1–5) should be implemented **after phase A** and before B: it tells which capabilities real
comps actually need, in which order, and calibrates V3 / V5 on real images. Phases B–F may be reordered by that evidence (a
human decision).

## 8. How each relaxation is reviewed

A relaxation is any change that lets a page do something the allowlist refused. It is a **quality-gate change** and follows
this process, stricter than the autonomous feature → develop merge (`claude-autonomy.md` §1):

1. **Proposal row** (in this document or its successor): capability name, exact property / value grammar, roles it applies to,
   the V-blocks and new rules that verify it, D/H, cost, probes.
2. **Verification before relaxation.** The checks land and are shown to fail the probes **with the property enabled behind a
   test-only switch**, before the allowlist changes. A capability whose probes do not all fail is not enabled.
3. **Probe set.** Every known bypass category of DEV-082's four rounds re-run with the new capability, plus capability-specific
   and cross-capability probes. Counts (refused / rendered and failed / passed) and every passing probe's screenshot recorded,
   as in `comp-to-site.md` §6.
4. **Fresh Review** of the latest SHA with an explicit bypass-hunting brief (`.ai/reviews/DEV-083*.md`).
5. **Human approval** of the gate change, recorded in the PR and `.ai/blockers.md` (a HUMAN-xxx entry per phase). **CI green
   and a Fresh Review PASS are necessary, not sufficient**: no relaxation is merged autonomously.
6. **Rollback** is one line: remove the capability from the enum. Pages that declared it are then refused (fail closed); no
   page silently loses its proof.
7. **Thresholds** (ink [0.8, 1.15], 4.5:1, 10 %, 12 px, 0.85 opacity, busyness cap, budgets, tolerances) are gate values: a
   change to any of them is a separate approval, never bundled with a capability.

## 9. Not changed by this document

Nothing. This is a plan. `lib/design-agent/comp-impl/**`, `docs/operations/comp-to-site.md`, `lib/design-agent/shop-css/**`, the
sales demo, the worker and its timer, the asset store rules, the quality gates and thresholds, `.github/workflows`, `package.json`,
Production, Staging and the database are untouched.
