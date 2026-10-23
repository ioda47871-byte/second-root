# Design DNA — research-to-comp foundation (offline, not integrated)

**Status: isolated development contract.** No model call, image generation, browser automation, data collection, WSL changes, worker queue, database, sales demo, staging, production, asset intake or release. This document and `lib/design-agent/design-image/design-dna.ts` are a **preparation step**, not a finished store-to-comp pipeline.

## Why

The human-approved A-8 image test (2026-10-23) succeeded with `SR_DESIGN_IMAGE_POC_DIRECTION=v1`: image saved at 1024×1536, SHA256 `849775e98cc074a016700ce62bb112d5f1ad2a290d93327abdadefce35d6dc47`, first image call about 54.8 s. **This verified the repaired Codex image path, not the visual quality of a modern website.** The returned v1 composition is primarily a large typographic poster with an information block. The code already has a different **v2 (default)** art direction with header, food visuals, CTA, product cards, shop info and a strict rubric. **v2 has not been visually evaluated on the repaired connection yet. Do not edit or run it merely to make a claim about its output.** One actual v2 call needs its own human approval.

The user's goal is: inspect verified store facts and mood, study inspiring website *principles*, create an original **webpage screenshot-style comp**, then have Claude implement the comp with the real facts as source of truth. **Not** pick an industry template, clone a reference site or let Claude re-design it.

## Provenance and original composition

1. **Store facts:** only from an approved facts source or owner-confirmed directions. Record `evidence` with its origin and source label; unsupported claims stay unknown. Do not treat a reference business's facts as the client's.
2. **Website study:** SANKOU! / gallery or official websites may reveal content hierarchy, nav, spacing, composition, visual rhythm. An observed feature is *evidence*, an application is *an original hypothesis*. Label limited sources as `public_visual_only` or `site_structure_only`, NOT `desktop_reviewed`. Never claim full responsive/interaction inspection from a gallery screenshot.
3. **Design DNA:** decide eight independent attributes (hero, type, palette, product visual, section rhythm, navigation, mobile, implementation) with a store-evidence link for each. Optional references explain *what to learn*, not layouts, assets, text or logos to copy. `sameDesignDna` only catches identical creative choices across briefs; it does not judge aesthetics or originality.
4. **Comp:** a real one-page website image, not a poster. A legible top bar/navigation, Hero with one grounded focal point, content sections with distinct visual rhythm, a true actionable anchor/CTA supported by facts, structured location/hours/contact where verified, and a footer. No invented claims, fake prices, reviews, available bookings, people or shop photos. Asset policy must be checked before any visual goes beyond the local concept.
5. **Implementation:** Claude gets image plus factual JSON plus structured layout observations. Text from image pixels is **never** a factual source. Compare desktop 1440 and mobile 390 screenshots; respect `docs/operations/comp-to-site.md` and the existing human-reviewed fidelity / no-template checks.

## References inspected as research candidates (not templates)

- [八芳園洋菓子店 — official](https://happo-en-patisserie.com/): actual page sections for **NEWS / SELECTIONS / CAFE / SHOP**, illustrating why a food brand site has a navigable hierarchy beyond a hero image. **Do not transfer brand text, photos or its actual layout.**
- [A Bite Coffee — owner announcement](https://bake-jp.com/info/abitecoffee_202609launch/): a minimal cream/dark-brown brand graphic (not proof of the website's layout). Shows why abstract motifs must be *explained by the brand*; do not reuse its dots or logo. **Not re-verified:** on 2026-10-23 the page returned HTTP 503 to this review; third-party coverage confirms only that BAKE Inc. launched A Bite Coffee in September 2026. Treat the visual note as unconfirmed until a human looks at the page.
- [SONICJAM case study — お茶のはまだ](https://xd.5star.co.jp/work/1649/) (used by the wagashi brief): the page describes a **white-based** brand site for a Kagoshima tea retailer. It does not discuss white-space layout or Japanese typography, so the brief records only the white-ground observation.
- [SANKOU! typography gallery](https://sankoudesign.com/category/typography/), [whitespace gallery](https://sankoudesign.com/category/whitespace/), and [food & restaurant gallery](https://sankoudesign.com/category/cafe-restaurant-tavern/): candidate discovery only; a gallery label is not a screenshot-level inspection.
- Existing 2026-10-21 design-research v0.2 records 40 sources and nine study cards; preserve its `review_status` distinctions. That library is **not in this repository**, so it could not be cross-checked here. The `DR-0xx` reference ids in the briefs are brief-local labels; the HTTPS URL is the identifier that matters. **This PR does not import the raw 40-item library or wire it into image prompts**; doing so without narrowing, provenance checks and an anti-copy review would create noise.

## How to use the new offline contract

`parseDesignDna(input)` validates a manually composed JSON document. Every decision must cite one or more store evidence IDs. References are HTTPS links tagged `analysis_only`; no image payload fields are accepted. All eight areas must have choices, not fixed preset identifiers; any unrecognised field is rejected. Each decision needs its own rationale: a brief that pastes one sentence under several decisions is rejected (`decisions:boilerplate_rationale`).

`sharedDesignDnaParts(a,b)` lists the areas whose choice is the same text in both briefs, compared area by area (decision order, case, width, spacing and punctuation are ignored). `sameDesignDna(a,b)` is true when all eight are shared. Both are **copy/paste signals only**: a reworded or translated choice is not detected, and an empty list says nothing about originality, quality or how different two pages will look. Never report it as an originality score.

Three illustrative, **research-only** briefs in `design-library/poc/design-dna/` now use the DEV-073 fictional wagashi, coffee, and patisserie evidence. The shops are fictional (DEV-073 fixtures; the brand evidence says so) and a unit test checks that every evidence item names a DEV-073 field that exists. No area shares a choice text across the three briefs (checked by `sharedDesignDnaParts`). They are not industry templates, do not contain image assets, and must not become live output without review.

There is deliberately **no automatic preset picker** and **no function connecting this brief to the current PoC**. The next implementation must create a bounded, evidence-preserving selector and have its choice reviewed before using it to create imagery. The eight decision names are a checklist, not eight allowed layouts.

## Next gated experiments and acceptance

1. **Next: untouched v2 on the fictional wagashi fixture** using the existing `design-image-poc.sh`, one human-approved Codex image call. Score with `docs/operations/design-image-eval-template.md`: no hard fails, total >=22/25, each dimension >=4, human-confirmed. Record SHA and image without committing pixels. Reject poster composition even if imagegen succeeds.
2. If v2 does not pass, revise **only** v2 art direction/prompt in a separate PR using visible failure evidence; preserve v1 as the connectivity control. Respect current prompt length limit and source-of-truth restrictions. No unapproved rerun.
3. Three research-only Design DNA fixtures now exist for fictional wagashi, coffee and patisserie. **Review them manually against the fixture facts** (and correct creative choices if necessary); only then consider separate, human-approved image calls. Do not mistake deterministic distinctness for aesthetic originality. Reference principles are sampled differently based on unique shop evidence, never chosen by a hard-coded industry preset.
4. Only after a real comp passes human review, use the existing `comp-impl-poc.ts` harness with Claude and compare real screenshots at 1440/390; synthetic fixture results are not fidelity proof. Any automatic Claude execution, worker integration or concept-asset ingestion needs separate review/approval.

**Stop conditions:** Unverified facts, unapproved photo/assets, duplicated directions, poster-like page, illegible shop name / invented price, missing disclosure where concept images are used, weak mobile handoff or inability to reproduce the comp with permitted HTML/CSS. Do not relax the existing security / quality gates.
