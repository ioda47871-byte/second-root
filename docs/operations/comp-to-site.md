# Comp to site — implementing a Codex design comp as a shop page (DEV-082, local PoC)

> **Local PoC. Nothing is published.** No Codex run, no model or API call, no network, no database, no Production / Staging,
> no change to the sales demo, the worker, its timer, the asset store rules or any quality gate.
> Code: `lib/design-agent/comp-impl/`, CLI `scripts/sales-design-worker/comp-impl-poc.ts`,
> tests `tests/unit/design-agent/comp-impl/`, synthetic fixture `scripts/sales-design-worker/comp-impl/synthetic-wagashi/`.
>
> **Honesty line.** Everything here was exercised on a **synthetic** comp only (image generation is blocked on HUMAN-022).
> A synthetic run that passes shows that the harness works. It does **not** show that a real Codex comp can be reproduced
> faithfully. Every report says `fidelity_status: synthetic_only` or `real_comp_unverified` and
> `faithful_reproduction_claimed: false`; the similarity metric never passes.

## 1. Goal and where this sits

Second Root's final goal is not tweaking colours or layout in existing templates. Codex reads a shop's industry, mood and
verified facts and produces an **original web design image** (the design-image PoC, `docs/operations/design-image-poc.md`).
**Claude then implements that image faithfully as a real web page.** This document is the step after the image:

```
design-image PoC (Codex, HUMAN-018…022)        this PoC (DEV-082)
  mockup.png + report.json                ┐
  shop-facts.json + design-spec.json      ├─► comp bundle ─► Claude: layout-spec.json ─► Claude: page/ ─► harness ─► report.json
  evaluation (human-confirmed rubric)     ┘                  (from the comp)              (HTML+CSS)       (Chromium)   desktop.png
  approved image assets (DEV-076, later)  ──────────────────────────────────────────────►  assets/                     mobile.png
```

As soon as a real comp passes the rubric, the same harness runs on it unchanged (§9).

## 2. What exists and is reused (investigation)

| need | existing code (reused, not changed) | how it is used here |
|---|---|---|
| comp PNG validation | `lib/design-agent/design-image/png.ts` (`readPngNoFollow`, `checkPng`, `MOCKUP_PNG_LIMITS`) | the comp is read with O_NOFOLLOW and the full chunk / CRC walk; assets the same with a smaller minimum side |
| PoC output layout | `lib/design-agent/design-image/run.ts` (`mockup.png`, `shop-facts.json`, `design-spec.json`, `report.json`, 0700 / 0600) | the bundle **is** that directory plus `evaluation.json` and `layout-spec.json`; outputs use the same private, O_EXCL writing |
| art direction | `design-library/poc/wagashi-art-direction-v2.json`, `design-image/prompt.ts` (`loadPocInputs`, `POC_DISCLOSURE*`, `SALES_UI`) | the bundle's `design-spec.json` must equal the repository's direction; the two disclosure strings and the sales-word rule come from here |
| shop facts | `lib/design-agent/compare/shops.ts` (`parseShop`, `factStrings`) → `worker/queue.ts` `pickFacts` (the worker's fact filter) → `preview.ts` `factsToDemoView` → `lib/sales/demo-content.ts` `toDemoView` (DemoView) | facts are read **only** from the facts source of truth (default: the DEV-073 fixture `scripts/sales-design-worker/compare/shops/wagashi.json`) through the same filter; the bundle's copy must be identical |
| fact-only text rule | `tests/unit/sales/demo-templates.test.tsx` (strip facts, then the allowed copy; nothing may be left) | `checks.ts` `factsCheck` applies the same allowlist method to every text node of the rendered page (hidden ones too), plus alt / aria-label / title |
| CSS safety | `lib/design-agent/shop-css/tokenize.ts` (strict tokenizer), `guard.ts` (Stage 3 guard) | `guardShopCss` cannot take a whole page (selectors must start at `#shop-css` and use the renderer's data attributes and element list), so `page-css.ts` reuses the **guard's tokenizer and value grammar** (`values.ts` `ELEMENT_PROPS`, `valueMatches`) with its own selector and `@media` allowlist — the same allowlist model. See §6 |
| render checks | `shop-css/page-scripts.ts` `MEASURE_SCRIPT` + `MeasureSchema`, `HIDE_TEXT_CSS`, `CLEAN_CSS`, `REFERENCE_SCRIPT`; `shop-css/render-check.ts` `overprinted`, `lowContrastShare`, `inkOf`, `groundColour`, `MIN_FONT_PX`, `MIN_OPACITY`, `CONTRAST_TOLERANCE`, `INK_RATIO`, `SHOP_CSS_BASE_WIDTHS` | the text soundness check runs the shop-CSS measurement with the whole body as its scope (clipped, offscreen, covered, out of its own box, too small, faded, squeezed) and its text-on-text test; the disclosure and required facts get the Stage 3 contrast and ink proof; the overflow sweep uses the same 320…1920 widths |
| screenshot sizes | `lib/design-agent/shot-viewports.ts` (`SHOT_VIEWPORTS`: 1440 × 900 @1, 390 × 844 @2) | the PC and mobile screenshots and measurements |
| Chromium in tests | `tests/unit/design-agent/shop-css/support.tsx` `launch()` (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`), un-gated in CI like the other renderer tests | same launch pattern; runs in CI |
| PNG decoding | `lib/design-agent/worker/png-paint.ts` `decodePng` | similarity metric |
| evaluation | `docs/operations/design-image-eval-template.md` (hard fails, 5 × 1–5, pass = no hard fail and ≥ 22/25, human-confirmed) | `evaluation.json` records that sheet; a real comp is implemented only when it passed and the human confirmed it |
| demo templates / renderer | `components/demo/*` (3 templates), `components/demo/profile/ProfileRenderer.tsx`, `lib/design-agent/defaults.ts`, `profile.ts` `DIRECTIONS`, `compare/hand-written/*.json` | **never imported by an implementation**; rendered only in a test to build the anti-template reference fingerprints (§7) |
| asset store | `lib/design-agent/assets/manifest.ts` (`approved_real` only, DEV-070), `intake.ts`, `store-root.ts` | **not changed, not written.** AI concept images are not in the store (§5); the output root may not lie inside the store |
| Codex hooks | `lib/design-agent/codex.ts` (`runCodexJson`, jail, ChatGPT sign-in only), `pipeline.ts` | **not used.** The implementation step is Claude's, in a Claude Code session (§8) |

## 3. Inputs: the comp bundle

One directory (the design-image PoC's output dir, plus two files):

| file | from | checked |
|---|---|---|
| `mockup.png` | the PoC (Codex) | `png.ts`, O_NOFOLLOW, regular file, size limits |
| `report.json` | the PoC | `status`, `shop`, `direction_version`, size and `png_sha256` match the PNG; `synthetic: true` only for the synthetic fixture |
| `shop-facts.json` | the PoC | **must equal** the facts source of truth after the worker's fact filter, or `BUNDLE_FACTS_MISMATCH` |
| `design-spec.json` | the PoC | must equal the repository's art direction of that version |
| `evaluation.json` | the human + Claude (rubric) | same comp sha; no hard fail; total = sum; a `real` comp needs `human_confirmed` and ≥ 22, else `COMP_NOT_APPROVED`; `synthetic` must match the report |
| `layout-spec.json` | **Claude, from the comp** (§4) | schema + consistency (`spec.ts`), same comp sha and artboard size, phrases verbatim inside a fact |

And beside the page: `assets.json` (§5). Anything else in a bundle is ignored; anything inconsistent stops the run with a fixed code.

**Process gates, not technical ones.** `evaluation.json` (`human_confirmed`, `confirmed_by`, the scores) and the synthetic / real
label (`report.json` `synthetic`, `evaluation.json` `comp_kind`) are written by people and Claude; the loader checks that they are
consistent (same comp sha, total = sum, kind matches the report), but nothing can prove that a human really confirmed the sheet or
that a comp labelled `real` came from Codex. They keep an honest run honest and make a careless one fail loudly; they do not stop a
dishonest author. The same holds for an asset's `kind` (§5).

## 4. Claude's implementation step

**What Claude receives:** the comp PNG (to look at), the facts (`shop-facts.json`, the only source of words), the art direction,
the evaluation sheet, the approved asset list, and this contract.

**Step A — the implementation spec (`layout-spec.json`, `spec.ts`).** Before writing any HTML, Claude writes down what the comp
shows, as numbers: sections in order with boxes as fractions of the artboard, the palette (hex, role), the type scale (desktop px),
spacing (unit, section padding, content max width), nav items and targets, the CTA, image slots (section, kind, aspect, box),
where the disclosure sits, the required facts and any verbatim fact excerpts used as captions, and the mobile order.
The spec carries **no free text**: labels come from `COMP_UI_LABELS`, captions must be excerpts of a fact, the disclosure is one
of the two fixed strings. The comp's own text is **never** read as data (no OCR): if the comp shows a price, a slogan or a
wrong phone number, it is simply not implemented.

**Step B — the page (`page.ts`).** A standalone directory:

- `index.html` — one page; allowed elements and attributes only (`page-scripts.ts` `PAGE_ELEMENTS`); no `<script>`, no event
  handler, no `style` attribute or element, no form / iframe / svg / video, no external or `data:` URL; exactly one
  `<link rel="stylesheet" href="style.css">`; links are in-page anchors only;
- `style.css` — the whole stylesheet, within the **page CSS allowlist** (§6, `page-css.ts`): anything not listed is refused;
- `assets.json` + `assets/*.png` — only listed, hash-checked images; a `placeholder` must be exactly one colour;
- no `aria-hidden` on any element that holds text (such text is skipped by every text measurement); no bidi control
  characters (U+200E/F, U+202A–202E, U+2066–2069, U+061C, as characters or entities), no `dir` attribute, no `<bdo>` / `<bdi>`;
- harness hooks: `data-comp-section` on each section, `data-comp-type` (display / heading / caption / body / label),
  `data-comp-slot` (+ `data-comp-placeholder` for a flat placeholder), `data-comp-nav`, `data-comp-cta`,
  `data-comp-disclosure`, `data-comp-container`;
- text sits in its own block / inline element (loose text directly in a flex / grid container counts as out of its box,
  as in the Stage 3 render check).

A component (Next.js) version is out of scope for the PoC: a standalone page needs no app route, no build and no change to
the web app (AGENTS.md: this Next.js differs from training data; nothing here touches it).

## 5. Facts, images and the disclosure

- **Facts** come only from the facts source of truth. The page's visible text (and alt, aria-label, the title) must be made of
  facts, declared verbatim fact excerpts, `COMP_UI_LABELS` and the disclosure; anything else is `FACTS_UNKNOWN_TEXT`
  (an invented price, award, history, rating or a changed phone number fails). Sales words (`予約`, `購入`, `人気`, `おすすめ` …) fail.
  Required facts must be shown verbatim in one text node that passes the legibility check (§6) at every checked width.
- **AI-generated images.** AI concept images are **not** in the asset store (DEV-070 removed `generated_concept`; DEV-076 is
  backlog and its store intake needs a separate human decision). The PoC may reference a **local, unpublished** concept image
  only as `kind: "ai_concept_local"` in `assets.json`, with a person's review record (`approved_by`, `approved_at`,
  `record_id`) and `published: false` (the literal). Such an image may only sit in an `ai_concept` slot with an allowed alt
  (「…のイメージ（AI生成）」), and then the page must show exactly
  **「架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです」**, legible (§6 legibility), where the spec says.
  Without an AI image the page shows 「架空店舗のデザイン提案」. Unapproved AI images are never published; nothing is.
- The synthetic fixture uses **no AI image and no photo**: CSS placeholders only. The AI-disclosure rule is tested with a flat
  PNG flagged as an AI concept asset.
- **Images are not read.** No check reads text inside an image (no OCR, by design). An asset's `kind` is the author's declaration:
  the only technical check is that a `placeholder` PNG is exactly one colour (every pixel equal to the first, so it cannot carry
  text or a photo, not even in near-identical pixels; `PAGE_ASSET_PLACEHOLDER_NOT_FLAT`). An `ai_concept_local` image could contain invented text and nothing
  here would see it — that is what the person's per-image review record is for.

## 6. The validation harness and the fidelity checks

`run.ts` renders the page in Chromium (`render.ts`): JavaScript off, every request routed — only `index.html`, `style.css` and the
listed assets are served under an unresolvable origin, everything else is aborted and counted (`NETWORK_REQUEST_BLOCKED`).

| check | how it is measured | tolerance / rule |
|---|---|---|
| PC and mobile | 1440 × 900 @1 and 390 × 844 @2 (mobile emulation), full-page screenshots | — |
| DOM allowlist | live DOM: every element / attribute in the allowlist, one stylesheet link, metas | exact |
| section order and placement | `data-comp-section` boxes; x / w as a share of the page width, y / h of the page height, vs the spec's fractions | ±0.05 x, ±0.06 w / y / h; order exact; mobile order exact |
| colours | every painted text colour, ground, border, outline of displayed elements | each channel within 10 of a spec palette colour |
| spacing | inner sections' padding top / bottom; `data-comp-container` widths | ±max(8 px, 30 %); ≤ content max width |
| type size and hierarchy | max size per `data-comp-type` role | display > heading > body; desktop sizes ±20 % of the spec; ≥ 12 px everywhere |
| product image placement | `data-comp-slot`: present once, in its section, aspect vs spec; img loaded; `object-fit: fill` keeps its own aspect | ±10 % aspect, ±2 % distortion; slot kind ↔ asset kind |
| nav and buttons | nav labels and anchors in order; one CTA `<a>` with the label and target; every link an in-page anchor with a target | exact |
| responsiveness | `scrollWidth − clientWidth` at the **checked widths**: 320, 360, 390, 768, 1024, 1440, 1920 and 1 px each side of every `@media` breakpoint (`render-check.ts` `checkWidths`, fed the page's own breakpoints) | 0 |
| missing / clipped / overlapping text | the shop-CSS `MEASURE_SCRIPT` on the whole body + `overprinted`, at **every checked width** (scale 1) | no displayed text clipped, offscreen, covered, out of its box, < 12 px, faded or overprinted; no hidden fact |
| legibility of the disclosure and every required fact | at every checked width: `MEASURE_SCRIPT` + `PROTECTED_SCRIPT` + the **Stage 3 pixel proof** (`lowContrastShare` on the ground actually painted under the text, `inkOf` against the same boxes with nothing but the text, and the per-character ink upper bound with `inkMass`) | every node of a protected element shown with no TEXT_* problem; size × transform × zoom ≥ 12 px; opacity product ≥ 0.85; colour alpha 1 and no different `-webkit-text-fill-color`; no clip-path / mask / filter / blend / clip on its chain; ≤ 10 % of its ground below 4.5:1; ink ratio ≥ 0.8 **and ≤ 1.15** (extra ink — a bar, a shadow, overprint, an underline — fails; a clean page measures 1.000, an underline 1.78); no `aria-hidden` over any text |
| fact accuracy | §5 | exact |
| AI disclosure | §5 | exact text, one element, placement, legibility |
| anti-template | §7 | distance > 0.35, CSS reuse ≤ 20 %, no renderer markers |
| comp similarity | §7 | reported, never passes |

### The page CSS allowlist (`page-css.ts`)

The same model as the Stage 3 shop-css guard: **everything not listed is refused**, and the value grammar is the guard's own
(`shop-css/values.ts`: `ELEMENT_PROPS`, `valueMatches`; the tokenizer `shop-css/tokenize.ts`). The guard itself cannot take a
whole page (its selectors start at the renderer's `#shop-css` scope), so this module adds its own selector and `@media` rules.

- **Selectors:** type selectors of the page's allowed elements, `*`, `.class`, `#id`; `:first-child`, `:last-child`,
  `:only-child`, `:first-of-type`, `:last-of-type`, `:nth-child(An+B)`, `:nth-of-type(An+B)`; descendant and `>` combinators.
  No attribute selector, no sibling combinator, no state pseudo-class (`:hover`, `:focus` …), no `:not` / `:has` / `:root`,
  and **no pseudo-element at all** (`::first-letter`, `::first-line`, `::marker`, `::selection`, `::before`, `::after` …, and
  their one-colon spellings).
- **`@media`:** only `(min-width: Npx)` / `(max-width: Npx)`, joined by `and`, N in 320 … 1920; no media type (`print`,
  `screen`), no other feature (`scripting`, `prefers-*`, `orientation`, `hover`, resolution …), no range syntax, not nested.
  No other at-rule (`@import`, `@font-face`, `@counter-style`, `@supports`, `@layer` …).
- **Properties:** layout (`display` without `none` / `list-item` / `contents`, **`position: static` only, no `z-index`**, sizes, `aspect-ratio`, `box-sizing`, `float: none` only), spacing (`margin` / `padding` / `gap`, no negatives),
  flex (no reversed directions, no `order`, no `column` + `wrap` in one rule), grid (column tracks; **rows sized by content
  only** — `auto`, `min-content`, `max-content`, `fr`, `minmax(…, auto)`; **placement by `span` only**, no line numbers,
  `grid-auto-flow: row` only: the visual order is the source order), alignment, columns, colours (`color`, `background` / `background-color` as a plain
  colour: hex, `rgb()`, `transparent`, `currentcolor`, `white`, `black`), borders and radius, inset `box-shadow` only,
  **`opacity: 1` only, no `transform` at all**, `object-fit` / `object-position`, typography basics (`font-family` from a
  fixed list of text faces, `font-size` ≥ 12 px, weight, style, `line-height`, `letter-spacing` ≥ 0, `word-spacing`,
  `text-align`, `text-transform: none`, `font-variant-caps: normal`, `text-indent` ≤ 2em / 32 px, **`writing-mode: horizontal-tb` only**, wrapping; **no multi-column layout**), `list-style` / `list-style-type`
  **`none` only**, `text-decoration` / `text-decoration-line` **`none` / `underline` only** (no style, colour, thickness or
  offset property).
- **Not listed, so refused** (the reviewers' probes among them): `content`, counters, `quotes`, `hyphenate-character`,
  `text-overflow`, `unicode-bidi`, `direction`, `filter`, `backdrop-filter`, `mix-blend-mode`, `text-shadow`,
  `-webkit-text-stroke`, `-webkit-text-fill-color`, `-webkit-text-security`, `text-emphasis`, `zoom`, `clip-path`, `mask`,
  `visibility`, `overflow`, offsets (`top` / `left` …), backgrounds with images or gradients, `!important`, custom properties.
- **No viewport or container units** (`vw`, `vh`, `vmin`, `vmax`, `svw` / `lvw` / `dvw` …, `cq*`) anywhere, also inside
  `calc()` / `clamp()` (`CSS_VIEWPORT_UNIT`): text then wraps only where an `@media` breakpoint says, which the checked widths
  sample. Percentages and `fr` still make wrapping width-dependent; that is what the coarse sweep and the fixed-height rule are for.

**No stacking or painting-order change exists (fourth review).** With `position: static` only, no `z-index`, `opacity: 1`
and no `transform`, no element creates a stacking context, so nothing can be lifted above other content. **Correction (fifth
review):** that alone does not stop covering. Text that overflows an earlier *block* paints above later blocks' grounds, but
**flex items, grid items and inline-blocks paint atomically in tree order**: a later item's ground covers an earlier item's
text when that text overflows sideways (probe A: a phone `dd` with `min-width: 0` in a wrapping flex row, digits hidden at
450–476 px; probe B: an inline-block `dd` at 80 % beside a 20 % inline-block tab, the last digit hidden). Images (replaced
elements) can cover too. These covers are measured, not excluded by the stylesheet: the 1 px pass below. **This drops the small
rotation the earlier rounds allowed** (`rotate()` ≤ 8°); a comp that needs a tilted element cannot be implemented in this PoC.

### Render-time rules the stylesheet alone cannot see (third and fourth reviews)

The allowlist judges each declaration; some defects come from combining allowed ones with the page's HTML. These are
measured in the browser:

- **No box shorter than its text.** On any element whose subtree holds text, under any media: a fixed height (`height`,
  `max-height`, `block-size`, `max-block-size` other than `auto` / `none`: `FIXED_HEIGHT_TEXT`), an `aspect-ratio` other than
  `auto` (`ASPECT_RATIO_TEXT`; image slots and placeholders keep it), `min-height` / `min-block-size: 0`
  (`MIN_HEIGHT_ZERO_TEXT`), and — from the computed style — a length `flex-basis` on an item of a column flex
  (`COLUMN_FLEX_BASIS_TEXT`). Vertical writing is refused, so `width` never becomes a block size. And the generic catch-all,
  at every checked width and in the sweep: **any text-holding box (not inline) whose content is taller or wider than the box**
  (`scrollHeight > clientHeight + 1` or `scrollWidth > clientWidth + 1`: `TEXT_BOX_OVERFLOW`; the inline axis since the fifth
  review). The fourth review's F1 (aspect-ratio + `min-height: 0` in a wrapping
  flex row, overflowing only at 641–670 px, covered by a later `position: relative` sibling) is refused at the stylesheet and
  fails every one of these rules when the positioning is left out.
- **No image over protected text** (`DISCLOSURE_IMAGE_OVERLAP` / `FACT_IMAGE_OVERLAP`): at every checked width and in the
  sweep, no line box of the disclosure or a required fact may intersect any `img`. Verified with a probe: the shop-CSS
  hit-test does **not** report an image cover (it treats an img without a painted ground as a transparent decoration); the
  Stage 3 ink proof (`NO_INK`) and this rectangle check do.
- **Coarse sweep of protected text** (`legibility_sweep`): on top of the checked widths, every **32 px from 320 to 1920**
  (51 widths) in one page context, the viewport resized (no reload), re-measuring the disclosure, the required facts and
  the label pairs with `MEASURE_SCRIPT`, `PROTECTED_SCRIPT` and `PAIRS_SCRIPT` (shown, not clipped / covered / out of its box /
  overprinted / too small / faded / decorated / under an image, no effects, no text box overflow). The pixel proofs (contrast,
  ink) run at the checked widths only; the sweep uses desktop emulation at every width.
- **1 px geometric pass over protected text** (`protected_1px`, fifth review): **every width from 320 to 1920** (1,601), for
  the disclosure (and the AI disclosure) and every element whose own text holds a required fact, the `dd` values included.
  At each width: no line box outside its own box and no content wider or taller than the box (`*_OUT_OF_BOX`), none off the
  page (`*_OFFSCREEN`), none intersecting an `img` (`*_IMAGE_OVERLAP`), and `elementFromPoint` at fifteen points across the
  middle of every line (scrolled into view; no cap on the number of lines) hits only the text's own element or what lies under it — anything else that paints a
  ground, a border, text or an image is a cover (`*_COVERED`). Failing widths are reported as ranges per code
  (`"FACT_COVERED": "450-477"`). No pixel proof in this pass (contrast and ink stay at the checked widths).
  *How it stays cheap:* 1,601 real viewport resizes take about 11.7 s per page. The widths are split into **media segments**
  (ranges where every `@media` rule is constant: a breakpoint N starts a segment at N and at N + 1). For each segment, **both
  ends are first measured with a real resize and no override**: only if the root element has **no box of its own** there —
  zero margin, border and padding on every side, and its margin box exactly the viewport's width (within 0.5 px) — does
  `GEOMETRY_SCRIPT` step the **root element's width** 1 px at a time inside the page (`stepped`). The root's styles are constant
  inside a segment and a width clamped by `min-` / `max-width` moves monotonically, so the two ends decide — this relies on the
  value grammar (`shop-css/values.ts`) refusing subtraction and negative terms (`calc(100% - 10px)` on `html` is refused), which
  makes every `html` box value a non-decreasing function of the viewport width with slope ≤ 1. While stepping, `html`'s side
  margins are set to 0 (they were proved 0 at both ends), so `html { max-width: …; margin: 0 auto }` does not centre the narrower
  stepped root and invent off-page text. Otherwise the
  segment is measured with a **real `setViewportSize` at every 1 px**, nothing overridden (`real`). The check reports
  `segments_stepped`, `segments_real` and the real ranges. With no viewport or container units and no fixed positioning in the
  stylesheet, and no box on the root, layout depends on the viewport only through `@media`, so the stepped root width stands in
  for the viewport exactly; a test compares it with true resizes (no override) width by width. **Sixth review:** before this
  check, `html { margin-right: 100px }` under 760 px (allowed CSS) made the stand-in measure a different content width, and a
  phone number read 052-/000-/073 at 362–381 px unmeasured; that segment now falls back to real resizes and fails there.
  Cost: **about 2 s per page when every segment is stepped** (the synthetic page: 3 segments, ends checked, 15 points per
  line); **about 5–6.5 s** when a 440-width segment falls back to real resizes (the probe). A full run takes about 14–19 s.
  **No 16 px pass** is needed on top: the 1 px pass covers every width.
- **Labels mapped to their facts** (`pairs_<width>`, and in the sweep; fourth review F2 / F3): each info label names one fact
  (`spec.ts` `COMP_INFO_LABEL_FACTS`: 営業時間 → hours, 定休日 → closed days, 住所 → address, 電話 → phone, アクセス → access).
  Every `dt` must be one of these labels (`DT_NOT_A_LABEL`) and be followed by a `dd` (`DT_WITHOUT_DD`) whose text **is that
  label's fact** (`PAIR_WRONG_FACT`: swapped `dd` values fail); any text node outside a `dt` that, with the facts and the
  separators taken out, still contains an info label fails (`LABEL_OUTSIDE_DL`: 「電話：9:00〜18:00」 in a paragraph fails).
  On screen, the `dt` / `dd` keep DOM order in reading order (`PAIR_ORDER`), and each `dd`'s first line starts on its
  `dt`'s line or below it, above the next `dt` (`PAIR_LINE`). No multi-column layout, `grid-auto-flow: row` only.
- **Rotation** (`TEXT_ROTATED`): every transform of a text's ancestor chain composed; more than 8° off axis fails. Since the
  fourth review no transform is allowed at all; the check stays as defence in depth.
- **List markers** (`LIST_MARKER`): `ol` is no longer an allowed element, and any shown element displayed as a list item with
  a `list-style-type` other than `none` fails (the default `ul` disc, the `ol` numbers).
- **Decoration on protected text** (`DISCLOSURE_DECORATED` / `FACT_DECORATED`): a decoration line declared on the element or
  any ancestor (they propagate) is refused up front, with its own code, before the ink bound would fail it.

**Adversarial sweep, fourth round (local, after the review of 0301171).** 39 probes: both reviewer probes (F1 as written and
without its positioning, F2 / F3), every box-shorter-than-text route (aspect-ratio, `min-height: 0`, column flex basis in px and
%, vertical writing, a fixed height), stacking (`z-index`, `opacity: .99`, a 2° rotation, `position: relative`), an image after
the disclosure, a label in a paragraph and in the description, a `dt` that is not a label, columns, `grid-auto-flow: column`,
and a regression set of every earlier category. 22 refused before rendering, 15 rendered and failed, 2 passed — the harmless
controls (wrapping at a % width; `span` with other column widths).

**Adversarial sweep, third round (local, after the review of 7b612c1).** 62 probes: the earlier categories again plus the
six combinations of this review (vw-driven wrapping into a fixed-height footer, fixed / max / block heights under media,
rotated neighbours and sections, nested rotation, `grid-auto-flow: column`, `float`, column + wrap flex in one and two
rules, labels outside a `dl`, a `dt` without its `dd`, `ol`, the default `ul` disc, underline on the disclosure, on an
ancestor and on a fact, `text-transform`, `font-variant-caps`, fixed grid rows, an opacity chain). 42 refused before
rendering, 16 rendered and failed, 4 passed — and those 4 are harmless controls whose screenshot is right (text wrapping at a
% width with no fixed height; a column flex that never wraps without a height; a span with other column widths; the nested
spans without the rotation CSS).

**Adversarial sweep (local, after the re-review of b94c61b).** 101 probes over every pseudo-element (both spellings), bidi (CSS, the
`dir` attribute, control characters and entities), `text-decoration` / `text-shadow` / stroke / emphasis, `letter-spacing`,
16 media features and types, tablet-only rules between breakpoints, filters / blends / clip / mask on the hero visual,
`list-style` values, grid stacking, nested opacity, `aria-hidden`, fonts and `!important`: 91 refused before rendering,
10 rendered and failed (legibility at the widths around their breakpoints, text checks); **none passed**. The categories are
unit and Chromium tests in `tests/unit/design-agent/comp-impl/`.

### Remaining limits (honest list)

- **Only the five info labels are mapped to facts.** A `dl` of other content cannot be built (every `dt` must be one of them);
  a label word not in the list is ordinary text, checked only by the facts allowlist.
- **The pixel proofs (contrast, ink) run at the checked widths only.** Colours change only at `@media` breakpoints, whose edges
  are checked widths; between them, what can change is geometry, which the 1 px pass measures at every width. Its cover test is
  geometric (`elementFromPoint`), not a pixel proof, and it covers protected text only — other labels and captions can still be
  covered between the checked widths (all text is measured at the checked widths only). The root-width stand-in is used
  **only where `html` has no box of its own** (checked with real resizes at both ends of each segment); elsewhere real resizes
  are used. It is exact only because viewport units and fixed positioning are refused; allowing either (DEV-083) would need
  real resizes everywhere (about 12 s per page).
- **Contrast and ink are proven only for the disclosure and the required facts.** Labels, captions, the CTA and other text
  can be faint or invisible without failing (the warm-grey labels of the synthetic page are below 4.5:1). Underlined
  protected text fails the ink upper bound by design.
- **Images are not read** (§5): an `ai_concept_local` image could carry text; only the person's review would see it.
- **Fonts:** names are limited to known text faces, but which one is installed varies by machine; the fallback is not
  checked against the comp.
- **The allowlist is narrower than CSS.** A real comp may need something it lacks (gradients, overlapping layers, offsets,
  hover states); adding a property is a review decision, not a quick fix.
- **Process gates** (§3) remain process gates.

**Section placement, colours, spacing and type are compared against Claude's own spec**, which Claude wrote from the comp.
They show that the page keeps to the spec, not that the spec (or the page) matches the comp: they are **not fidelity evidence**.

**Not checked (honest gaps):** contrast and ink of text other than the disclosure and the required facts (labels, captions,
CTA: the warm-grey labels of the synthetic page are below 4.5:1, which the pixel proof would flag), text inside images (§5),
font identity (local stacks differ by machine), image quality, and anything aesthetic. A page that passes every check can still
look nothing like the comp; that is why a person compares them (§9).

**Correction (review of PR #96 at 9daac92).** The first version of this document claimed that the facts check, the disclosure
check and the stylesheet rules made invented text and a hidden disclosure impossible. A Fresh Review disproved that: CSS strings
(`list-style`, `hyphenate-character`) drew invented text; the disclosure passed with `color: transparent`, a transparent text fill,
the ground's colour, `zoom: 0.1`, `clip-path`, `scale` + `opacity`, or `aria-hidden` with off-screen placement; and a required fact
under `aria-hidden` off screen passed. Each of these probes is now a test that must fail (`tests/unit/design-agent/comp-impl/`).
The re-review at b94c61b showed the deny-list approach itself was the problem: 38 further probes (bidi override,
`::first-letter`, `scaleX(-1)`, line-through and shadows that only add ink, print / scripting media, tablet-only rules,
filters on images, list markers …) passed. The stylesheet is now an allowlist, the ink proof has an upper bound, and the
checks run at every width around every breakpoint. The third review (7b612c1) passed three combinations of allowed
properties: text wrapping between sampled widths into a fixed-height box, labels moved beside other values (column flow,
float, column + wrap flex), and nested rotations adding up to 96°; and noted list markers, underline on protected text and
`text-transform`. The render-time rules above close them. The fourth review (0301171) found two more — the disclosure covered
between sweep widths (aspect-ratio + `min-height: 0`, a later `position: relative` sibling) and labels written beside the wrong
values in HTML — and asked to close the causes: no stacking context can exist, no box can be shorter than its text, and labels
are mapped to their facts.

## 6a. Expressive capabilities the allowlist forbids today (input for DEV-083)

> **The human's decision (2026-10-22):** DEV-082 is finished as a **strict safety base**; no safety rule is relaxed to pass a
> review. These restrictions also block things a high-quality design needs. Making them possible is a later task (DEV-083),
> which must pair each allowed expression with its own verification. This section only **lists** what is forbidden now and
> why; it does not design DEV-083.

| capability a comp may show | forbidden by | why (the risk it was closing) |
|---|---|---|
| text over a hero image (overlay title, caption on a photo) | no offsets / `position` other than static / negative margins; `IMAGE_OVERLAP` for protected text | covering is not measurable once boxes can overlap; contrast of text on an image is not proven by the Stage 3 ground model |
| decorative overlap, layered cards, offset frames | `position` static only, no `z-index`, no negative margins, no offsets | any stacking context lets a later box paint over earlier text (fourth review F1) |
| tilted, scaled or mirrored elements; parallax-like shifts | no `transform` at all (the ≤ 8° rotation was dropped in the fourth review) | mirroring redrew facts; nested rotations reached 96°; a transform creates a stacking context |
| fades, translucency, blend modes, frosted glass, duotone images | `opacity: 1` only; no `filter`, `backdrop-filter`, `mix-blend-mode`, `mask`, `clip-path` | faded / blended / clipped text, and images whose hidden content a filter can reveal |
| gradients and background images (textures, washi paper grounds, photo bands) | `background` is a plain colour only; no `url()` (tokenizer) | an image or gradient ground defeats the contrast proof; a background image is an unreviewed asset outside the asset list |
| ornaments from pseudo-elements, drop caps, quote marks | no pseudo-elements (`::before`, `::after`, `::first-letter` …) | `::first-letter` shrank / hid the first character of facts; pseudo-element text is outside the facts check |
| outlined or shadowed display type, decorative underlines | no `text-shadow`, `-webkit-text-stroke`; `text-decoration` none / underline only, never on protected text | shadows and strokes add ink in the text colour (an invisible line-through, duplicated text) |
| tight display tracking, Latin capitals, small caps | `letter-spacing` ≥ 0; `text-transform: none`; `font-variant-caps: normal` | negative tracking overprints; case transforms change how Latin facts are drawn |
| 縦書き (vertical Japanese headings or copy) | `writing-mode: horizontal-tb` only | in vertical writing `width` becomes the block size, so a box can be shorter than its text |
| multi-column text, magazine flows | no `column-*` | columns split a `dl` and pair labels with other values |
| asymmetric magazine grids (named areas, explicit lines, items spanning into each other, dense packing, column flow) | grid placement by `span` only; `grid-auto-flow: row`; content-sized rows | explicit placement and column flow set labels beside other values; fixed rows let text leave its box |
| mobile re-layout (moving the image below the copy, reordering sections, hiding the nav behind a menu) | no `order`, no reversed flex directions, no `float`, no `display: none`, no column + wrap flex | reordering moves labels beside other values; hidden text is skipped by the facts and legibility checks |
| full-bleed heroes and equal-height cards with fixed heights, line clamping, ellipsis | no fixed height, `aspect-ratio` or `min-height: 0` on text-holding elements; no `overflow`, no `text-overflow` | a box shorter than its text lets wrapped text leave it (and be covered) at widths no check samples |
| fluid type and spacing (`clamp(…vw)`), container queries | no viewport or container units; `@media` width only | text wrapped at widths no breakpoint names (third review) |
| hover / focus states, motion, transitions | no state pseudo-classes; no animation properties | never visible in a screenshot, so never checked |
| brand web fonts (a specific Mincho), icon fonts | no `@font-face`; `font-family` from a fixed list of installed text faces | a font fetch is network; a symbol font redraws a fact's digits |
| custom list markers, numbered steps | no `ol`; `list-style: none` only | markers are drawn text outside the facts check (numbers from counters) |
| inline SVG icons, video, canvas | not allowed elements | content outside the DOM text the checks read |
| richer colour (hsl, oklch, named colours) | the guard's colour grammar (hex, `rgb()`, `transparent`, `currentcolor`, `white`, `black`) | inherited from the Stage 3 guard; not a safety finding of this PoC |
| any `dl` other than the shop information (a menu with prices as a `dl`) | every `dt` must be one of the five info labels with its fact | labels are mapped to facts; other pairs have no source of truth |
| captions or copy beyond verbatim fact excerpts and fixed labels | the facts allowlist | invented text (prices, claims) — not an expressiveness limit to relax |

**Remaining conflicts between safety and needed function** (written down, not resolved here): text over a hero image,
vertical Japanese type, mobile re-layout and textured / photographic grounds are each common in a high-end wagashi comp and
each is forbidden above. A real comp that relies on one of them cannot be implemented faithfully in DEV-082; the
implementation would have to approximate it, and the person comparing the screenshots would see the difference.

## 7. Comp similarity and the anti-template guard

**Similarity (`similarity.ts`).** The comp and the desktop full-page screenshot are box-filtered onto the same 96 × n grid
(n from the comp's aspect; the screenshot is stretched to it, and the aspect difference is reported) and compared three ways:
mean SSIM of 8 × 8 windows on luminance, colour-block similarity (8 × 8-cell mean colours), and IoU of binarized Sobel edge maps.
The result carries `passing: false` (a literal) and a status: `synthetic_only` (synthetic comp), `no_real_comp`
(a real comp that was not approved), or `real_comp_human_review_required`. **It never yields a pass:** a coarse metric cannot
judge typography, image quality or feel, and on the synthetic fixture the comp and the page were drawn by the same hand
(synthetic run: SSIM 0.90, colour blocks 0.996, edges IoU 0.71 — meaningless as a fidelity claim).

**Anti-template guard (`anti-template.ts`).** Prevents "a slightly modified existing template":

1. no renderer markers in the page (`#shop-css`, `data-shop-css`, `data-kind`, `data-variant`, … in HTML or CSS) and no demo
   template CSS-module class name (≥ 6 characters);
2. CSS reuse: the share of the page's rule bodies (≥ 3 declarations, normalized) found in `components/demo/**.module.css` ≤ 20 %;
3. structure: the page's fingerprint (DOMParser, text ignored: tag-path trigrams and child-count buckets as a multiset, plus the
   top-level block trees two levels deep) must be at distance > **0.35** from every reference in
   `lib/design-agent/comp-impl/template-fingerprints.json` — the three demo templates and the profile renderer (category defaults,
   every direction, the hand-written Stage 1 specs). A test regenerates that file from the current components and fails if it
   differs. Calibration: the renderer's own variants sit at 0.00–0.22 from each other, two different templates at 0.54, the
   synthetic page at 0.88 from the nearest. The renderer's markup offered as a page fails (test).
4. The spec is derived from the comp (Step A) and the page may not import or reuse `components/demo/*` or direction presets
   (it is plain HTML / CSS; there is nothing to import).

**Limits, honestly:** a determined copier can rename classes, rewrite declarations and wrap elements until every number moves,
so passing the guard is evidence, not proof; failing it is a strong signal. The real guard is the process — the page is written
from the comp and its spec in a reviewed session, and a person looks at it next to the comp.

## 8. Claude's step, now and later

- **Now:** a Claude Code session (a human-approved developer step). The human uploads the bundle (or points at it); Claude
  writes `layout-spec.json` from the comp, writes `page/`, runs
  `npx tsx scripts/sales-design-worker/comp-impl-poc.ts --bundle <dir> --page <dir>`, fixes failures, and shows the
  screenshots next to the comp. The human judges likeness.
- **Later (automated):** an unattended "Claude implements the comp" step would need its own human approval. This repository's
  automation uses subscription CLIs signed in by a person (Codex with ChatGPT sign-in, never an API key —
  `tests/unit/guardrails.test.ts`); no repository code calls a model API, and none calls the Anthropic API. An automated
  Claude step would have to be a Claude Code run on the human's machine (like the Codex worker) or a decision to use an API
  with its own key handling, billing and policy — both are human decisions (HUMAN-023), not part of this PoC.

## 9. What only a real comp can verify

- that Claude can read a real Codex comp into a correct spec (sections, boxes, palette, type sizes) — the synthetic comp was
  drawn to a plan;
- whether the tolerances are right (real comps are ~1024 × 1536 images of a 1440 page: the page's height rarely matches the
  comp's aspect; `geometry_desktop` reports both aspects);
- whether the similarity numbers mean anything (what a "good" SSIM / edge IoU looks like on a real pair);
- image slots with real, reviewed AI concept assets (DEV-076) and their crops;
- fonts: a Mincho face in the comp vs the local stacks (no web fonts are allowed in this PoC);
- anything aesthetic — the human's side-by-side review.

## 10. Outputs and running it

`$SR_COMP_IMPL_POC_ROOT` (absolute) or `~/sr-comp-impl-poc/`, a new `<shop>-XXXXXX/` (0700) with `report.json`, `desktop.png`,
`mobile.png` (0600, never overwritten). The root may not be inside the repository, the asset store, the bundle or the page; this
is checked on its resolved path **before** anything is created. An existing root is used only when it is a real directory (not a
link) owned by the user with mode 0700, and its mode is never changed; a missing root is created 0700.
`report.json`: `fidelity_status`, `faithful_reproduction_claimed: false`, `mechanical_ok`, `failed`, bundle and page digests,
every check's codes and numbers, `anti_template`, `similarity`, notes.

```bash
# synthetic fixture (renders the synthetic comp into a private scratch bundle, removed afterwards)
npx tsx scripts/sales-design-worker/comp-impl-poc.ts --synthetic
# a real bundle (after the rubric passed and the human confirmed it)
npx tsx scripts/sales-design-worker/comp-impl-poc.ts --bundle ~/sr-design-image-poc/wagashi-XXXXXX --page <page dir>
```

Exit 0 all mechanical checks passed, 1 a check failed, 2 refused / usage. Printed: codes, numbers, the output path.
On the human's WSL machine, run the resource preflight first (`docs/operations/wsl-resource-preflight.md`); it starts Chromium.

## 11. Not changed

The sales demo generation, the design worker and its timer, the bridge, the asset store and its rules (`approved_real` only),
the quality gates and thresholds, `components/demo/*`, `.github/workflows`, `package.json` (no new dependency), Production,
Staging, the database and Vercel settings.
