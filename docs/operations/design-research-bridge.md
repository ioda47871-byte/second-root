# Design research → Design DNA bridge (DEV-099, offline)

## Current truth

**Update (DEV-100, 2026-10-24):** the owner supplied the v0.2 originals. Both files are now in
`design-library/research/v02/` **verbatim** (hashes in its `MANIFEST.json`, checked by a test), and
`lib/design-agent/design-image/research-v02.ts` reads them: 40 references, nine cards (A01–A09).

- **Review status is kept, not upgraded.** The originals are model-made observations of public images
  (`visual_reviewed_from_public_screenshot`, `partial_visual_review_of_public_reference`,
  `visual_reference_partially_inspected`; one `content_reviewed_visual_pending`, two
  `discovered_needs_visual_review`). None names a reviewer or a date, and the cards have no review field.
  `toResearchSnapshot` therefore makes every source and card a bridge `candidate` and keeps the original
  label in `provenance.original_review_status`; the two `discovered_needs_visual_review` entries (nothing observed) stay in the file but are not offered as sources. The bridge cannot report `review_ready` on them.
- **The Design DNA part of each card** (`V02_CARD_PART`) was assigned by a Claude session at import; it is
  marked `claude_session_unreviewed` on every card.
- **Shop-specific choice:** `exploreV02Techniques` picks 2–4 cards from a shop's verified inputs (name,
  number of facts, approved imagery, owner-stated tones, one fact-grounded motif) — never from the industry
  name — and labels the result `exploratory_unreviewed`. Only references whose visuals were observed are
  cited. Example: `docs/design/wagashi-v02-research-direction.md`.
- For a `review_ready` bridge report a person must review the cited sources and cards and record it.
- **URL check (DEV-101, 2026-10-24):** `url-checks-20261024.json` records, for 13 references, whether the URL shows the
  recorded subject (page text only; not a human review). With it, `toResearchSnapshot` and `exploreV02Techniques`
  drop references whose URL shows something else, does not show the observation, cannot be opened or is not web
  design (DR-020, 027, 028, 031, 032, 034), and count only checked, matching references. A04 loses all three of its
  references. The originals are unchanged.

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

1. ~~Locate the real v0.2 originals~~ (done, DEV-100; kept as candidates). Correct the earlier wagashi Design DNA text `small counter` if using that brief: the fixture states `小さな店頭`, not a particular counter.
2. Map only actual, reviewed records into the normalized snapshot; attach approved provenance to the appropriate shop decisions. No automatic industry-template chooser, no product/shop facts from reference websites.
3. Use `selectDesignResearch` to generate a **reviewable new experimental design-direction proposal** with 3–5 supported ideas. Have the human examine its composition, palette, section rhythm and implementability against the old v2 output. Do **not** replace the pinned v2 prompt or increase its input behind the SHA check.
4. Design a separate **new versioned prompt experiment** from the approved proposal. Test limits and guardrails independently; one real Codex image call requires a new explicit approval. Compare new comp against existing v2 on appeal, originality and faithful HTML/CSS reproduction; no invented facts, unapproved photos, fake claims or copying.

### Stop boundaries

No modification to Codex, browser worker, jail, bridge, timers, Supabase, Staging, Production or live sales. No model calls, scraping or billable services. No weakening tests, quality gates or security. The existing v2 pin and its tests remain authoritative.

Tracked in [Issue #118](https://github.com/ioda47871-byte/second-root/issues/118).

The study-text check (markup, links, instruction-like phrases) is a narrow heuristic: it keeps ordinary design prose and can be evaded. A person's review of every source and card is the control; the check only catches obvious cases.
