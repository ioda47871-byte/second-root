# Roadmap: from a comp image to an auto-implemented shop site

> **Design and plan only.** No code, no Codex, no model or API call, no WSL run. Status as of 2026-10-22 (develop `6a000f7`,
> DEV-082 in review as PR #96 on `feature/dev-082-comp-to-site`).
> Companion: `docs/design/dev-083-expressive-safe-reproduction.md` (DEV-083: widening expression with matching verification).

## 0. The goal, and the honesty line

For each shop, the system should: (1) analyse it — industry, mood, verified facts, references used for study only (never copied,
no fabricated facts); (2) have ChatGPT / Codex create an **original** web design comp image; (3) have Claude implement that comp
**faithfully** as a real site, ultimately in Next.js; (4) render PC and mobile screenshots, compare them with the comp, and fix
the differences in a **bounded** loop; (5) review quality and accuracy, and only then let the site become a **sales-demo
candidate**. Human approval for sending and publishing stays exactly as it is.

**Honesty line.** No real comp has been produced yet (image generation is blocked: DEV-084 merged, HUMAN-024 pending). Every
implementation run so far used a **synthetic** comp. Faithful reproduction **cannot be claimed or passed without a real comp
and a human's side-by-side judgement** — that holds at every stage below.

## 1. The seven stages at a glance

Status key: **Implemented** (merged to develop and used), **PoC** (exists as a local proof of concept, possibly still in
review), **Designed-only** (written down, no code), **Not started**.

| # | stage | status | where | what remains |
|---|---|---|---|---|
| 1 | comp validation | **PoC** (in review, PR #96); PNG checks Implemented | `lib/design-agent/comp-impl/bundle.ts` (bundle loader, evaluation sheet, facts equality), `lib/design-agent/design-image/png.ts` (`readPngNoFollow`, `checkPng`), `docs/operations/design-image-eval-template.md` (rubric) | a real comp (HUMAN-024 → image generation); the per-criterion "each ≥ 4" check in `bundle.ts` (the human adopted it on 2026-10-22; follow-up after #96 merges); provenance link from the comp to its design-image run |
| 2 | comp → implementation spec (`layout-spec.json`) | **PoC** (in review) | `lib/design-agent/comp-impl/spec.ts` (`CompSpecSchema`, `checkCompSpec`, `specFactProblems`, `COMP_UI_LABELS`) | tried on a synthetic comp only; spec lacks capabilities, layers / roles, per-width layouts and vertical type (DEV-083 V1, V7, V9); written by Claude in a session, no automated extraction |
| 3 | Claude generates HTML/CSS or Next.js | HTML/CSS: **PoC** (manual Claude Code session, synthetic fixture); Next.js: **Not started**; automation: **Not started** | `lib/design-agent/comp-impl/page.ts` (page contract), `page-css.ts` (allowlist), `scripts/sales-design-worker/comp-impl/synthetic-wagashi/` | first real implementation (HUMAN-023 判断 1); expressive capabilities (DEV-083); Next.js serving (§7); an unattended Claude step (HUMAN-023 判断 2) |
| 4 | browser verification | **PoC** (in review), built on **Implemented** Stage 3 checks | `comp-impl/render.ts`, `checks.ts`, `page-scripts.ts`, `run.ts`; reused `lib/design-agent/shop-css/render-check.ts`, `shop-css/page-scripts.ts` (DEV-072), `lib/design-agent/shot-viewports.ts` | the DEV-083 verification blocks; CI time (§8) |
| 5 | comparison with the comp | **PoC**: metrics reported, **never pass**; per-section report **PoC (report only, DEV-097)**; human side-by-side **Designed-only** | `comp-impl/similarity.ts` (SSIM, colour blocks, edge IoU; `sectionComparison` → `report.similarity.sections`; `passing: false`), `anti-template.ts` | calibration on real pairs; a type-size estimate per section; the human review sheet (§4); any threshold (A5) |
| 6 | iterative fix loop | **Not started** for comp implementation (manual "fix failures" in a session); precedent **Implemented** for the profile designer | precedent: `lib/design-agent/pipeline.ts` (`MAX_REVISIONS = 2`, `qualityGate`, `QUALITY_NOT_ACCEPTED`), DEV-066 (no rounds spent on invisible changes) | everything in §5 |
| 7 | quality review and connection to sales demos | **Not started** for comp pages; precedent **Implemented** for profile designs | precedent: DEV-053 quality gate, DEV-058 review summary (`lib/design-agent/review-summary.ts`), `app/demo/[publicToken]/page.tsx` (ProfileRenderer or template), local `app/design-preview/[runId]/page.tsx` | the implementation review sheet (§4), the serving design (§7), every approval in §6 |

Upstream of stage 1 (shop analysis, art direction, comp generation) is **PoC / blocked**: `lib/design-agent/design-image/`
(`run.ts`, `prompt.ts`, `capability.ts`, `diagnostics.ts`), `docs/operations/design-image-poc.md`, waiting on HUMAN-024.
Shop analysis for the existing profile designer (facts, reference screenshots, measured colours) is **Implemented**
(`lib/design-agent/pipeline.ts`, `reference-colours.ts`, DEV-028 / DEV-069).

## 2. Stage details

### Stage 1 — comp validation
What exists: the bundle loader reads the comp with O_NOFOLLOW and the full PNG chunk / CRC walk; checks `report.json`
(sha, size, `synthetic`), that `shop-facts.json` equals the facts source of truth after the worker's fact filter, that
`design-spec.json` equals the repository's art direction, and the evaluation sheet (no hard fail, total = sum, a `real` comp
needs `human_confirmed` and ≥ 22/25, else `COMP_NOT_APPROVED`).
**Rubric policy (the human, 2026-10-22): 「22/25点以上、各項目4点以上を基本方針とする」** — pass = no hard fail, total ≥ 22/25 and
every criterion ≥ 4. This PR records it in `docs/operations/design-image-eval-template.md`, `design-image-poc.md`, the DEV-075
criterion and `.ai/blockers.md` (HUMAN-019's evaluation note).
Remains: (a) a real comp; (b) **follow-up after #96 merges**: `comp-impl/bundle.ts` checks only the total (`EVAL_PASS_TOTAL`);
it must also refuse a `real` comp with any criterion below 4 (not edited here — the file belongs to PR #96); (c) the human-confirmed sheet and the `real` label are **process gates**
(`comp-to-site.md` §3) — a hash link from the comp to the design-image run's `report.json` would make "this came from Codex"
checkable, not just declared; (d) the implementability anchor of the rubric discourages overlays and text on images
(DEV-083 doc §6 risk 8).

### Stage 2 — comp → `layout-spec.json`
What exists: a strict schema (sections with boxes as artboard fractions, palette, type scale, spacing, nav, CTA, image slots,
disclosure position, required facts, verbatim excerpts, mobile order), no free text, the comp's text never read.
Remains: the spec must grow with DEV-083 (declared capabilities, element roles, per-width layout and reading order, writing
mode, label vocabulary). Whether Claude's spec reading of a real comp is accurate is unknown until a real comp exists.

### Stage 3 — Claude implements
What exists: a contract for a standalone page (`index.html`, `style.css`, `assets.json`, `assets/`), an allowlist stylesheet,
the synthetic fixture page. The implementer is a person-approved Claude Code session (`comp-to-site.md` §8).
Remains: the first real implementation; DEV-083 capabilities; a Next.js form (§7); automation of the step (HUMAN-023 判断 2:
Claude Code on the human's WSL like the Codex worker, or an API with its own key handling and billing — both human decisions;
no repository code calls a model API today).

### Stage 4 — browser verification
What exists: Chromium with JavaScript off and every request routed; DOM allowlist; facts allowlist; disclosure; geometry,
palette, spacing, type vs the spec; links; image slots; overflow sweep at 320…1920 and around breakpoints; the Stage 3 text
measurement and pixel proof for protected text; a 32 px legibility sweep; label ↔ fact pairs; anti-template.
Remains: DEV-083 phase A blocks; moving the comp-impl Chromium tests out of the unit job (§8).

### Stage 5 — comparison with the comp
What exists: three coarse metrics on a 96-column grid, reported with a status and `passing: false`. On the synthetic pair
(drawn by the same hand) SSIM 0.90 / colour 0.996 / edge IoU 0.71 — meaningless as fidelity evidence.
Remains: (a) calibration on real comps (what "close" looks like); (b) a **per-section** comparison (crop each `data-comp-section`
of the screenshot and the matching spec box of the comp; report palette distance, edge-density difference, type-size estimate per
section) so the fix loop gets "the hero is 18 % darker and its headline is smaller" instead of one number; (c) the human
side-by-side sheet (§4) as the only fidelity judge.

(b) is **partially done, report only (DEV-097)**: `report.similarity.sections` gives, per spec section on the 1440 desktop page,
mean and dominant colour (CIE76 ΔE, L* difference), edge density, the share of page height and the aspect against the comp
(`comp-to-site.md` §7). `passing` stays false; no threshold, no gate, no fidelity status changed (A5). Not done: the type-size
estimate; mobile (there is no mobile comp: order check and the human only).

### Stage 6 — the fix loop
Not started. Design in §5.

### Stage 7 — quality review and sales demos
Not started for comp pages. Design in §4 (review) and §7 (serving). The existing profile-designer path (DEV-053 gate, DEV-058
review summary, `design_status` in `sales_demos`) is the model, and stays untouched.

## 3. What "implemented faithfully" will mean

A comp page is a **sales-demo candidate** only when all of these hold:

1. the comp passed its rubric (≥ 22/25, no hard fail) and the human confirmed it — the comp's own evaluation;
2. every mechanical check of stage 4 passed (and every DEV-083 check of the declared capabilities);
3. the implementation review (§4) passed on every axis, with the human's confirmation;
4. the human compared comp and screenshots side by side and recorded it.

No synthetic run, no metric and no AI review substitutes for 1 and 4.

## 4. Implementation evaluation axes (separate from the comp's rubric)

The comp rubric (`design-image-eval-template.md`: beauty, fit, originality, structure, implementability; pass ≥ 22/25, "each ≥ 4"
proposed) judges the **image**. The implementation is judged on its own sheet, never folded into the comp's score.
Scores 1–5 with anchors to be written in the sheet; **all thresholds below are provisional** — they become gate values only with
the human's approval (and changing them later is a gate change).

| axis | how it is measured | mechanical | human | provisional threshold |
|---|---|---|---|---|
| **visual fidelity to the comp** | side-by-side of comp and desktop / mobile screenshots, per section (layout, hierarchy, colour, type, imagery, first view); similarity metrics and per-section diffs as aids | spec conformance (geometry ±0.05–0.06, palette ±10 / channel, type ±20 %); similarity reported, **never passes** | **decides** | ≥ 4/5; first view ≥ 4; **cannot pass without a real comp** (synthetic → `not_applicable`, never a pass) |
| **PC and mobile quality** | the page at 1440 and 390 (and the sweep) as a design in its own right, including the mobile re-layout | overflow 0 at every checked width, text checks, ≥ 12 px, tap targets ≥ 44 × 44 px on mobile (new, proposed); for overlap capabilities the font-perturbation pass (and WebKit if approved) | decides quality; **real-device (iPhone) screenshot** for pages with overlap capabilities — the DM audience opens iOS WebKit | all mechanical pass; ≥ 4/5 each for PC and mobile |
| **brand fit** | does it read as this shop's industry and mood (the art direction), not a generic site | palette inside the spec palette | **decides** | ≥ 4/5 |
| **originality** | not a template, not a copy of a reference site, not the same as other shops' pages | anti-template guard (markers, CSS reuse ≤ 20 %, distance > 0.35); nearest other-shop page reported (DEV-083 §4) | decides "original", not "different" | guard passes; ≥ 4/5 |
| **usability and readability** | nav works, CTA findable, reading order, contrast of all text (not only protected) | links / anchors, pairs, contrast and ink proof on protected text; DEV-083 extends to overlapped text; contrast of other text reported | decides comfort | mechanical pass; ≥ 4/5 |
| **fact accuracy** | every word from the facts source; required facts present and exact | `factsCheck`, required facts, pairs, disclosure — **fully mechanical** | confirms the facts source itself was verified | 0 violations (hard fail) |
| **safety** | no script / network / external URL, approved assets only, disclosure for AI images, no store / people imagery, nothing hidden | page contract, routing, asset hashes, disclosure check | per-image review of AI concept assets; filtered renders (DEV-083) | 0 violations (hard fail) |

Pass (proposed): fact accuracy and safety have **no** violation; every scored axis ≥ 4; human-confirmed. No total score: a high
total must not hide one weak axis, and a 5 on originality never buys back a 3 on fidelity. An AI (Claude) review may **draft**
the sheet with citations to what is visible, as the comp rubric does; the human confirms or corrects it. An AI review alone never
marks a page as a demo candidate.

## 5. The fix loop (stage 6)

The loop turns stage 4 / 5 findings into page changes, boundedly.

```
spec + page ─► harness (stage 4) ─► comparison (stage 5) ─► findings (fixed codes + per-section numbers)
     ▲                                                              │
     └───────────── Claude edits page / spec (one round) ◄──────────┘   stop? → report to human
```

- **Iteration cap.** Provisional: **3 rounds per comp** (hard maximum 5, a gate value). Precedent: the profile designer's
  `MAX_REVISIONS = 2`.
- **Stop conditions** (any one stops the loop and reports):
  1. all mechanical checks pass and the per-section diffs are below the (calibrated) report thresholds → **stop, ask the human
     for the side-by-side review** (the loop never declares fidelity itself);
  2. the cap is reached;
  3. **no improvement**: a round that does not reduce the failing check count or any section's diff (DEV-066 precedent: no round
     spent on an invisible change);
  4. **regression**: a round that fails a check that passed before (fact, safety, protected text) → revert that round and stop;
  5. a finding that requires a capability the page has not been approved for, **any spec change** (the spec hash differs from
     the frozen one), or any change to facts, labels, thresholds or the harness → stop; these are human decisions;
  6. a **refusal code** from the harness (`CAPABILITY_NOT_DECLARED`, network, DOM allowlist) twice in a row → stop (it means the
     implementation is fighting the contract).
- **Frozen spec.** When the loop starts, the spec (`layout-spec.json`) is frozen: its sha256 is recorded in the run report,
  and every round re-checks it. **Any spec edit stops the loop** and goes to the human (the spec is Claude's reading of the comp;
  editing it to match the page would make every spec-based check pass by definition).
- **Never touched by the loop**: the facts source, the comp, **the spec**, the evaluation sheet, thresholds and tolerances,
  the harness, the anti-template references. The loop may not optimise toward the anti-template distance or the similarity numbers as goals.
- **Model calls.** Today each round is Claude in a person-approved Claude Code session — there is no unattended model call.
  If the step is ever automated (HUMAN-023 判断 2): **no automatic retry of a model call** without an explicit budget (rounds,
  wall-clock time and, for an API, cost), a failed or timed-out call ends the run with a fixed code (the Codex worker's
  precedent: one call, fail closed, `docs/operations/imagegen-timeout-investigation.md`), and the budget is written into the
  run's report.
- **Human stop.** The person can stop a run at any time: in a session by interrupting; for an automated run, a stop file / lock
  in the run root checked before every round, and the existing worker conventions (the timer stays disabled unless the human
  enables it). A stopped run leaves its last good page and report; nothing is published.
- **Records.** Every round's findings, the diff of the page, and the stop reason go into the run's `report.json` (fixed codes and
  numbers, no model text), so a person can audit why it stopped.

## 6. Human approvals required (explicit list)

None of these is granted by this document, by `claude-autonomy.md`, or by an earlier approval.

| # | approval | why | related |
|---|---|---|---|
| A1 | Running Codex to generate a comp (each run) | ChatGPT usage, WSL | HUMAN-024 → later runs |
| A2 | Confirming each comp's rubric sheet (pass = no hard fail, ≥ 22/25, **each criterion ≥ 4** — the policy itself was adopted by the human on 2026-10-22; any change to it is a new approval) | the comp gate | `design-image-eval-template.md` |
| A3 | The first implementation of a real comp and the side-by-side judgement | fidelity has no mechanical judge | HUMAN-023 判断 1 |
| A4 | Each DEV-083 relaxation phase (B–F) and every threshold / tolerance / budget value, **before merge**. Phase A (checks only, nothing relaxed) is not in this list: it follows AI_WORKFLOW §4 | quality-gate changes | DEV-083 doc §7, §8 |
| A5 | The implementation review sheet's axes and thresholds (§4) becoming a gate | quality gate | §4 |
| A6 | Using AI concept images (DEV-076) or `texture` assets in a page, per image | asset rights and review | DEV-076, DEV-070 |
| A6b | **Asset-store or source-kind changes** for AI or texture images (adding `ai_generated_concept` / `texture` kinds partly reverses DEV-070) | asset store rules | DEV-070, DEV-076, `design-image-assets.md` |
| A6c | **Licences and provenance** of each texture and each pinned web font (and the font allowlist itself) | rights | DEV-083 doc §3.1(c), (g) |
| A7 | **Model / API usage** for the implementation step: (a) Claude Code run unattended on the human's WSL, or (b) an API key with billing and terms | billing, credentials, terms; repository code calls no model API today | HUMAN-023 判断 2, `tests/unit/guardrails.test.ts` |
| A8 | **Connecting the implementation step to the real design worker** (queue, bridge, timer) | worker and timer changes need approval | `docs/operations/design-worker-wsl.md` |
| A9 | **Next.js integration** — serving a comp page inside the app (§7), even behind a flag | app and route changes, public surface | §7 |
| A10 | Showing a comp page as a public demo (`/demo/[publicToken]`) or sending it in sales | sales and publishing stay human-approved | MVP_SPEC, ARCHITECTURE §10 |
| A11 | Any DB schema change, or **object storage**, to store comp pages / review results | DB, storage, cost | ARCHITECTURE §10 |
| A12 | **CI split** of the comp-impl tests into their own job (`.github/workflows/ci.yml`) **and adding that job to the required-CI list** (`docs/RELEASE.md` §2, branch protection — HUMAN-003), so moving tests out of `unit` does not make them non-required | workflow and required checks | §8 |
| A12b | **A WebKit browser** in CI / the harness (Playwright WebKit) for the engine-robustness runs | new dependency and download | DEV-083 doc V10 |
| A13 | Revising the comp rubric's implementability anchor once DEV-083 makes overlays verifiable | the comp gate | DEV-083 doc §6 risk 8 |
| A14 | **Label-vocabulary and section-role additions** (`COMP_UI_LABELS`, section roles, per-industry label sets) | words shown to shops | DEV-083 doc §3.1(i) |
| A15 | **Allowing the disclosure over an image** (today: never; DEV-083 keeps it on a flat ground) | the disclosure rule | DEV-083 doc §3.1(a), V4 |

## 7. Next.js integration (design sketch; needs A9)

Constraints: the existing demo generation (templates, `ProfileRenderer`, `sales_demos`, the bridge) is **not touched**; the
public `/demo` route keeps working exactly as now; nothing is served on Vercel until A9 / A10. AGENTS.md: this Next.js differs
from training data — the implementing task must read `node_modules/next/dist/docs/` first; nothing here assumes an API.

Two stages, each a separate approval:

1. **Local preview first.** Extend the existing local-only pattern of `app/design-preview/[runId]/page.tsx` (exists only when
   `SR_DESIGN_PREVIEW_ROOT` is set; always 404 on Vercel): a sibling local route serves a **verified** comp run's `index.html`,
   `style.css` and listed assets from outside the repository, re-checked on load (hash of the files equals the report's digests,
   report `mechanical_ok`, review sheet confirmed). Served as static content with a strict Content-Security-Policy
   (`default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'`; no script — `font-src` for the pinned web
   fonts of DEV-083) — the same guarantees the harness assumed when it
   rendered with JavaScript off and requests routed. No React conversion is needed for this step.
2. **Demo integration later.** A comp page becomes another *render mode* of a demo, selected only when a stored, verified record
   says so, with the same fall-back rule as today (anything invalid → the existing template). Storage of the page (DB or object
   store), its re-verification at serve time, the flag, and how it coexists with `design_status` are a separate design and need
   A9–A11. Converting the HTML/CSS into React components is optional; serving the verified static page avoids re-introducing
   anything the harness did not see.

## 8. Recommended next tasks (proposals)

`docs/AI_WORKFLOW.md` §3 lets Claude add tasks only for bugs, CI failures, incidents, spec gaps, blocking debt and resilience
defects; **new features need the human's approval**. Only DEV-083 (already reserved by the human) is added to `.ai/tasks.json`.
Everything below is a **proposal** for the human to accept, reorder or drop.

| order | proposal | depends on | approval | why now |
|---|---|---|---|---|
| 1 | **CI split**: move `tests/unit/design-agent/comp-impl/**` into its own sharded job like `shop-css` (every test still runs on every PR; no skip) | DEV-082 merged | A12 (workflow change + required-check list) | the unit job ran 672 s of 900 at 0301171 and 678 s at 2d27cb3; DEV-083 cannot add probes inside it; the new job must join the required checks |
| 2 | **DEV-083 phase A** — verification blocks only (roles incl. pseudo-element geometry, the exact CSS 2.1 Appendix E paint-order model, ink-overflow intersection, layered ink reference, ground structure under glyphs, computed writing mode and visibility matrix, layout-change hashing, the font-perturbation harness, capability schema with an empty enum), with measured timings | DEV-082, ideally 1 | none: it relaxes nothing, so it follows AI_WORKFLOW §4 (Fresh Review, CI, autonomous merge) | lets every later capability arrive with its proof (exact paint order, ground structure, engine robustness); no risk to the current gate |
| 3 | **First real comp → implementation** (stages 1–5 by hand in a session) | HUMAN-024 resolved and a comp generated (A1), rubric confirmed (A2) | A3 | the only way to learn which capabilities real comps need and whether tolerances and metrics mean anything; decides the order of DEV-083 B–F |
| 4 | **Implementation review sheet + per-section comparison report** (docs template like `design-image-eval-template.md`, and a report-only per-section diff in `similarity.ts` — **the report is in, DEV-097**; the sheet remains) | DEV-082 | A5 for the thresholds to become a gate | gives stage 5 something the fix loop and the human can act on |
| 5 | **Fix-loop harness, local and manual** (frozen spec hash, round records, stop conditions, cap, regression revert; Claude edits in a session; no model call by code) | 4 | its cap and stop values (A4/A5); automation stays A7 | makes stage 6 reproducible before anyone automates it |

Also, after #96 merges: the per-criterion "each ≥ 4" check in `comp-impl/bundle.ts` (follow-up of the human's rubric policy, §2 stage 1; a small fix aligning code with an adopted policy).

After these: DEV-083 phases B–F (fonts first) in the order the first real comp suggests; the local Next.js preview (A9); automation (A7, A8).

## 9. Not changed by this document

Nothing. No code, workflow, threshold, gate, asset rule, worker, timer, demo, Production, Staging or database change.
