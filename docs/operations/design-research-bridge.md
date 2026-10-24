# Design research → Design DNA bridge (DEV-099, offline)

## Current truth

The 2026-10-21 v0.2 study was described as **40 website references and nine technique cards**, with originals named `secondroot_design_research_v02_20261021.md` and `secondroot_design_library_v02_20261021.json`. **Their complete content is NOT in this GitHub repository and was not available to this development session.** We did **not** invent rows or call random pages "reviewed." Recover the originals from the previous Claude session/downloads if available. The original JSON's schema is currently unknown, so the schema below is an **intermediate normalized review format**, not a claim to parse the old files as-is.

The existing `design-library/poc/design-dna/*.json` briefs are research-only and are not a live input to `buildMockupPrompt`. The earlier wagashi v2 real image (SHA256 `101c1c04eaef8ff957eae910c6ab1b72b6444645a4a3952aed0156ce60da91ac`) and the local faithful implementation are the baseline. The **pinned v2 prompt** remains unchanged: SHA256 `7334ea1906052f558cc43c8ce1582ddada1432e14899bd5d57d354914a5012aa` (6801 characters).

## What this PR actually adds

`lib/design-agent/design-image/research-bridge.ts` is a pure offline selection function. It accepts a normalized, manually reviewed snapshot and a validated, store-specific Design DNA brief, and outputs a **candidate report only**: no files, HTTP fetches, model calls, Git, worker, website screenshots, prompt mutation or assets.

A normalized input has these fields:

- `schema_version: 1`, `status: "research_only"`, `sources[]`, `technique_cards[]`.
- Source: `id`, **HTTPS** `url`, `scope` (public visual / site structure / desktop reviewed), `rights: "analysis_only"`, `observed_principle`, `review`.
- Technique card: `id`, `part` (one of the eight Design DNA sections), `source_ids[]`, `transferable_principle`, `use`, `avoid`, `review`.
- Review: `status: "candidate" | "human_reviewed"`, `reviewer`, `reviewed_at` (ISO offset timestamp). Attribution is required for reviewed items. **This metadata cannot authenticate the reviewer; a human must inspect and confirm the original source.**

The selection does not fill blanks. Cards are considered only when source and card are declared reviewed, HTTPS source matches one of the store brief's registered references, scope matches, and that **specific decision cites that reference**. At most five cards are picked, with at most one technique per Design DNA part. Three parts and two distinct cited sources are necessary for a `review_ready` report. Otherwise status `insufficient_reviewed_sources`; nothing is authorized. The result keeps the original store decision, verified shop evidence IDs, and relevant source URLs separate. **Neither `review_ready` nor the source's declared review status grants permission to run imagegen, validates the original research, or demonstrates aesthetic originality.**

No image, photograph, website, brand text, HTML, CSS or asset is ever copied from the sources.

## Explicit next steps (one small slice at a time)

1. Locate the **real v0.2 originals**. Without them, do not claim the 40/9 library is restored. Inspect duplicates, broken URLs, `review_status`, licensed use limits and cited visual observations; keep candidates candidates. Correct the earlier wagashi Design DNA text `small counter` if using that brief: the fixture states `小さな店頭`, not a particular counter.
2. Map only actual, reviewed records into the normalized snapshot; attach approved provenance to the appropriate shop decisions. No automatic industry-template chooser, no product/shop facts from reference websites.
3. Use `selectDesignResearch` to generate a **reviewable new experimental design-direction proposal** with 3–5 supported ideas. Have the human examine its composition, palette, section rhythm and implementability against the old v2 output. Do **not** replace the pinned v2 prompt or increase its input behind the SHA check.
4. Design a separate **new versioned prompt experiment** from the approved proposal. Test limits and guardrails independently; one real Codex image call requires a new explicit approval. Compare new comp against existing v2 on appeal, originality and faithful HTML/CSS reproduction; no invented facts, unapproved photos, fake claims or copying.

### Stop boundaries

No modification to Codex, browser worker, jail, bridge, timers, Supabase, Staging, Production or live sales. No model calls, scraping or billable services. No weakening tests, quality gates or security. The existing v2 pin and its tests remain authoritative.

Tracked in [Issue #118](https://github.com/ioda47871-byte/second-root/issues/118).

The study-text check (markup, links, instruction-like phrases) is a narrow heuristic: it keeps ordinary design prose and can be evaded. A person's review of every source and card is the control; the check only catches obvious cases.
