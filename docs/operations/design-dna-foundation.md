# Design DNA — research-to-comp foundation (offline, not integrated)

**Status: isolated development contract.** No model call, image generation, browser automation, data collection, WSL changes, worker queue, database, sales demo, staging, production, asset intake or release. This document and `lib/design-agent/design-image/design-dna.ts` are a **preparation step**, not a finished store-to-comp pipeline.

## Why

HUMAN-025 (2026-10-23) succeeded with `SR_DESIGN_IMAGE_POC_DIRECTION=v1`: image saved at 1024×1536, SHA256 `849775e98cc074a016700ce62bb112d5f1ad2a290d93327abdadefce35d6dc47`, first image call about 54.8 s. **This verified the repaired Codex image path, not the visual quality of a modern website.** The returned v1 composition is primarily a large typographic poster with an information block. The code already has a different **v2 (default)** art direction with header, food visuals, CTA, product cards, shop info and a strict rubric. **v2 has not been visually evaluated on the repaired connection yet. Do not edit or run it merely to make a claim about its output.** One actual v2 call needs its own human approval.

The user's goal is: inspect verified store facts and mood, study inspiring website *principles*, create an original **webpage screenshot-style comp**, then have Claude implement the comp with the real facts as source of truth. **Not** pick an industry template, clone a reference site or let Claude re-design it.

## Provenance and original composition

1. **Store facts:** only from an approved facts source or owner-confirmed directions. Record `evidence` with its origin and source label; unsupported claims stay unknown. Do not treat a reference business's facts as the client's.
2. **Website study:** SANKOU! / gallery or official websites may reveal content hierarchy, nav, spacing, composition, visual rhythm. An observed feature is *evidence*, an application is *an original hypothesis*. Label limited sources as `public_visual_only` or `site_structure_only`, NOT `desktop_reviewed`. Never claim full responsive/interaction inspection from a gallery screenshot.
3. **Design DNA:** decide eight independent attributes (hero, type, palette, product visual, section rhythm, navigation, mobile, implementation) with a store-evidence link for each. Optional references explain *what to learn*, not layouts, assets, text or logos to copy. `sameDesignDna` only catches identical creative choices across briefs; it does not judge aesthetics or originality.
4. **Comp:** a real one-page website image, not a poster. A legible top bar/navigation, Hero with one grounded focal point, content sections with distinct visual rhythm, a true actionable anchor/CTA supported by facts, structured location/hours/contact where verified, and a footer. No invented claims, fake prices, reviews, available bookings, people or shop photos. Asset policy must be checked before any visual goes beyond the local concept.
5. **Implementation:** Claude gets image plus factual JSON plus structured layout observations. Text from image pixels is **never** a factual source. Compare desktop 1440 and mobile 390 screenshots; respect `docs/operations/comp-to-site.md` and the existing human-reviewed fidelity / no-template checks.

## References inspected as research candidates (not templates)

- [八芳園洋菓子店 — official](https://happo-en-patisserie.com/): actual page sections for **NEWS / SELECTIONS / CAFE / SHOP**, illustrating why a food brand site has a navigable hierarchy beyond a hero image. **Do not transfer brand text, photos or its actual layout.**
- [A Bite Coffee — owner announcement](https://bake-jp.com/info/abitecoffee_202609launch/): a minimal cream/dark-brown brand graphic (not proof of the website's layout). Shows why abstract motifs must be *explained by the brand*; do not reuse its dots or logo.
- [SANKOU! typography gallery](https://sankoudesign.com/category/typography/), [whitespace gallery](https://sankoudesign.com/category/whitespace/), and [food & restaurant gallery](https://sankoudesign.com/category/cafe-restaurant-tavern/): candidate discovery only; a gallery label is not a screenshot-level inspection.
- Existing 2026-10-21 design-research v0.2 records 40 sources and nine study cards; preserve its `review_status` distinctions. **This PR does not import the raw 40-item library or wire it into image prompts**; doing so without narrowing, provenance checks and an anti-copy review would create noise.

## How to use the new offline contract

`parseDesignDna(input)` validates a manually composed JSON document. Every decision must cite one or more store evidence IDs. References are HTTPS links tagged `analysis_only`; no image payload fields are accepted. All eight areas must have choices, not fixed preset identifiers; any unrecognised field is rejected. `sameDesignDna(a,b)` flags identical per-area choices across shops even if shop keys differ, but **does not** certify originality.

There is deliberately **no automatic preset picker** and **no function connecting this brief to the current PoC**. The next implementation must create a bounded, evidence-preserving selector and have its choice reviewed before using it to create imagery. The eight decision names are a checklist, not eight allowed layouts.

## Next gated experiments and acceptance

1. **Next: untouched v2 on the fictional wagashi fixture** using the existing `design-image-poc.sh`, one human-approved Codex image call. Score with `docs/operations/design-image-eval-template.md`: no hard fails, total >=22/25, each dimension >=4, human-confirmed. Record SHA and image without committing pixels. Reject poster composition even if imagegen succeeds.
2. If v2 does not pass, revise **only** v2 art direction/prompt in a separate PR using visible failure evidence; preserve v1 as the connectivity control. Respect current prompt length limit and source-of-truth restrictions. No unapproved rerun.
3. Produce three genuinely different Design DNA briefs from verified fictional wagashi, coffee and patisserie facts, then manually review composition/fingerprints before **separately approved** image calls. Reference principles are sampled differently based on unique shop evidence, never chosen by a hard-coded industry preset.
4. Only after a real comp passes human review, use the existing `comp-impl-poc.ts` harness with Claude and compare real screenshots at 1440/390; synthetic fixture results are not fidelity proof. Any automatic Claude execution, worker integration or concept-asset ingestion needs separate review/approval.

**Stop conditions:** Unverified facts, unapproved photo/assets, duplicated directions, poster-like page, illegible shop name / invented price, missing disclosure where concept images are used, weak mobile handoff or inability to reproduce the comp with permitted HTML/CSS. Do not relax the existing security / quality gates.
