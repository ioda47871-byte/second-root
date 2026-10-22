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
| CSS safety | `lib/design-agent/shop-css/tokenize.ts` (strict tokenizer), `guard.ts` (Stage 3 guard) | the tokenizer and the guard's "never" list are applied to `style.css`. **Gap:** `guardShopCss` cannot take a whole page: selectors must start at `#shop-css`, use the renderer's data attributes and a fixed element list (no `a`, `img`, `nav`, `footer`, `figure`), and its property allowlist is the renderer's subset. See §6 |
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
- `style.css` — the whole stylesheet: the shop-CSS tokenizer (no escapes, no `<`, no non-ASCII outside comments, no url
  tokens), only `@media` at-rules (so no `@counter-style`), no `attr()` / `env()` / `image-set()` / `counter()` / `counters()` /
  `symbols()`, no `content` other than `""` / `none` / `normal`, **no string anywhere** except font family and grid area names
  (`font-family`, `font`, `grid-template-areas`, `grid-template`, `grid`) — so no `list-style: "…"`, `list-style-type: "…"`,
  `quotes`, `hyphenate-character`, `text-overflow: "…"` or string in a selector — and no `counter-reset` / `counter-set` /
  `counter-increment` / `-webkit-text-security` (CSS can draw text outside the DOM; the review of PR #96 drew
  「SALE 50% OFF」 with `list-style` and 「$9.80」 with `hyphenate-character` before this rule); local font stacks only (no `@font-face`);
- `assets.json` + `assets/*.png` — only listed, hash-checked images; a `placeholder` must be one flat colour;
- no `aria-hidden` on any element that holds text (such text is skipped by every text measurement);
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
  Required facts must be shown verbatim in one text node that passes the legibility check (§6) at 320, 390, 1440 and 1920.
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
  the only technical check is that a `placeholder` PNG is one flat colour (every pixel within 6 levels of the first, so it cannot
  carry text or a photo; `PAGE_ASSET_PLACEHOLDER_NOT_FLAT`). An `ai_concept_local` image could contain invented text and nothing
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
| responsiveness | `scrollWidth − clientWidth` at 320, 360, 390, 768, 1024, 1440, 1920 | 0 |
| missing / clipped / overlapping text | the shop-CSS `MEASURE_SCRIPT` on the whole body + `overprinted`, at **320, 390, 1440 and 1920** (scale 1) | no displayed text clipped, offscreen, covered, out of its box, < 12 px, faded or overprinted; no hidden fact |
| legibility of the disclosure and every required fact | at the same four widths: `MEASURE_SCRIPT` + `PROTECTED_SCRIPT` + the **Stage 3 pixel proof** (`lowContrastShare` on the ground actually painted under the text, `inkOf` against the same boxes with nothing but the text) | every node of a protected element shown with no TEXT_* problem; size × transform × zoom ≥ 12 px; opacity product ≥ 0.85; colour alpha 1 and no different `-webkit-text-fill-color`; no clip-path / mask / filter / blend / clip on its chain; ≤ 10 % of its ground below 4.5:1; ink ratio ≥ 0.8; no `aria-hidden` over any text |
| fact accuracy | §5 | exact |
| AI disclosure | §5 | exact text, one element, placement, legibility |
| anti-template | §7 | distance > 0.35, CSS reuse ≤ 20 %, no renderer markers |
| comp similarity | §7 | reported, never passes |

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
