# Second Root | Design Intelligence Pilot v0.1

**Research-only / 2026-10-27 / proposal pending review.**

This folder organizes **nine owner-selected design study cases** and **a queue of 20 detailed reference reviews** as *structured evidence*, not templates or approved model prompts. It complements, but does not mutate, the existing reference collections.

## Files

| Path | Role | Current status |
| --- | --- | --- |
| [success-patterns.json](success-patterns.json) | CP-001–009: shop characteristics → composition principles → what was selected/rejected → implementation gaps | Nine documented study cases; analysis interpretation, not scientific proof |
| [review-queue.json](review-queue.json) | Source-traceable priority list of 10 existing AI-reviewed screenshots and 10 new audits | **Not** 20 completed human reviews |
| [validate.mjs](validate.mjs) | Offline, read-only cross-check against case registry, original v03 candidate source URLs and pending owner review status | May be run with `node design-library/intelligence/v01/validate.mjs` |

## Exact current inventory

- v02 reference library: **40** historical entries with mixed review labels, **none attributable to a human review**.
- v03 additive candidate set: **40** entries, page text or gallery metadata checked; text alone does not establish how a page looks.
- v03 AI viewport evidence: **10** specific references, 1440px + 390px notes, recorded as AI observations; **owner decision pending**.
- Second Root study successes: **9** case IDs, **5 with local HTML/CSS/JS PoCs** (CP-003/004/005/007/009), **4 concept/image only** (CP-001/002/006/008); **no production deployment is implied**.
- This v0.1 pilot prioritizes **20 depth reviews**, but it does **not** automatically accept or score any design reference.

## How to use this in a new design experiment

1. Confirm the *new* shop's official facts and imagery rights independently; mark any unavailable details as unknown.
2. Form at least **two truly different conceptual compositions** from the verified shop-specific characteristic. The principle is to translate its inherent geometry, motion, material, or experience, **not** to fetch a fixed pattern based on shop industry.
3. Use the case records to identify **possible pitfalls** and conceptual transformations; do not copy any existing case's wording, photography, visual hierarchy or exact geometry.
4. Show the original compositions to the owner for qualitative selection. Record what the owner actually chose separately from designer interpretation.
5. Once a concept is selected, split photographic assets from type, build responsive PC/mobile layouts, compare real browser screenshots, document issues and design fidelity, and retain the rejected experiments.
6. Obtain a separate **human review** before new source analysis can be labeled reviewed/usable for an automated prompt. Nothing in this folder is auto-injected into Codex/Claude or a sales workflow.

## Example (reasoning only, NOT a template)

If a shop has a verified signature material with linear grain, try generating a composition from the grain direction. Another plausible original direction may come from the purchasing experience, such as repeated small decisions along a path. The reference case of a loaf or a spinning cookie cannot be transplanted to the new shop just because both are food businesses.

## Review process / next work

**Phase A (first 10):** human acceptance or rejection of existing AI viewport evidence in `design-library/research/v03/viewport-evidence-20261025.json`. Screenshots are *not* in GitHub; re-obtain when necessary. Record uncertainty where inaccessible.

**Phase B (next 10):** perform source-specific 1440/390 visual captures and explicit strengths, weaknesses, mobile differences and rights notes for new candidates. Concentrates on salons, wellness, beauty and restaurant material to address the current overemphasis on food.

Two **non-food shop studies** now have owner-selected HTML PoCs: ORGN. (CP-007, salon/fashion) and 豆＊豆 (CP-009, handmade crafts). The wellness study Seitai Go (CP-008) has a selected static design but no functioning site. More businesses and live, owner-approved implementations are needed before generalizing this design workflow. Only after comparing with owner feedback should any generalized design process be proposed for production.

## Immutable safety boundaries

- Never claim an unreviewed candidate is reviewed, or an AI observation constitutes human review.
- Never use third-party imagery, logos, copy, trademarks or a copied layout as deployable assets.
- Do not promote the selected cases to templates. Stored descriptions are **design research data**, not instructions or evidence of a client contract.
- No changes to `main`, Supabase, Vercel, sales automations, or `lib/design-agent` in this work.
- This is version 0.1 **in a review branch**, not a connected Supabase or production generation database.
