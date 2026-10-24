# Design reference expansion v0.3 — first candidate batch (DEV-105)

**Purpose:** Broaden Second Root's research beyond the original 40 entries and nine technique cards, especially across pastries/bakeries, cafés, salons and wellness clinics. The historical `v02` JSON/Markdown remain **byte-for-byte fixed** and their SHA-pinned loader retains `references.length===40`. This is a separate **additive candidate pool**, not a fake v0.2 update, and not Supabase.

## Counts

| Research set | Records | Source verification | Usable automatically by image PoC? |
|---|---:|---|---|
| Original `v02` | 40 | historical mixed partial/visual review labels, **no attributable human signoff**; several misattributed URLs corrected via overlay | No |
| New `v03/candidates-20261025-01.json` | 15 | **only specific page text / gallery tags retrieved and checked**; not full visual screenshot audits | **No** |
| Total saved reference leads | **55** | not the same as 55 fully reviewed/approved designs | No |

The new categories: **3 pastry + 3 cafe + 2 bakery + 4 wellness + 2 salon + 1 editorial**.

## Actual candidate sources

| ID | Source | Kind | What was confirmed (not a visual audit) |
|---|---|---|---|
| DX-001 | [パレード伏見洋菓子店](https://muuuuu.org/industry/restaurant/22704.html) | award gallery | listed Jan 15 2026, tagged Japanese vertical typography, line work and food photography |
| DX-002 | [harebare](https://harebare.org/) | live brand site | cookies, regional origin story, product range, shop/online-store links |
| DX-003 | [パティスリーポルカ 結びサンド](https://design-kom.com/design/w160polka_musubisand/) | agency case | product LP uses a fact-grounded triangle/water-knot inspiration |
| DX-004 | [Lit GELATO](https://design-kom.com/design/w1281litgelato/) | agency case | a gelato web site as part of shop/brand packaging work |
| DX-005 | [パン屋SUNtoF](https://design-kom.com/design/w139panyasun/) | agency case | freshly baked bread photography used as the brand story |
| DX-006 | [ON THE WAY ケーキ特設](https://design-kom.com/design/w048ontheway_cake/) | agency case | separate focused cake landing page from the café's main site |
| DX-007 | [カフェ・ド・せんじゅ](https://design-kom.com/design/w051senju/) | agency case | coffee, cake and bread each described in the site's structure |
| DX-008 | [TAKE整体院](https://usagi-design.jp/works/takeseitaiin) | agency case | white/light-blue base, service photography, gently curved sections |
| DX-009 | [Leash Hair Design](https://usagi-design.jp/works/leashhairdesign) | agency case | salon personality expressed through staff and interior photos |
| DX-010 | [GOKAN Conditioning Labo.](https://design-kom.com/design/w113gokan/) | agency case | clear presentation of the hybrid acupuncture/training offer |
| DX-011 | [aoはり治療院](https://design-kom.com/design/w068ao/) | agency case | first-visitor reassurance through service explanations/photography and appointment detail |
| DX-012 | [クリニック杜の里](https://muuuuu.org/industry/hospital/22868.html) | award gallery | gallery tags include soft colors, rounding and trustworthy feel |
| DX-013 | [DAN BRISE](https://www.danbrise-barber.com/) | live barber site | concept, services, staff, gallery, prices, appointments and location pages |
| DX-014 | [俵屋旅館](https://muuuuu.org/industry/trip/22954.html) | award gallery | gallery tags include traditional Japanese vertical text, photography, motion |
| DX-015 | [四季ノ香](https://www.foriio.com/works/225868) | creator's portfolio | creator explicitly reports the published Nagoya bakery-café site and STUDIO implementation |

The `text_confirmed` field in the JSON contains a **brief, source-grounded paraphrase**, and `technique_hypothesis_unreviewed` is **our proposal to test**, not an observed website layout. Portfolio/gallery listings are NOT equivalent to reviewing the original live site's 1440px/390px appearance. No extracted text, images, HTML, assets, full-page screenshots, owner claims, or third-party marks are copied to this repository.

## How this batch is protected

`lib/design-agent/design-image/research-candidates.ts` is **offline only** and validates:
- exact required fields, sources as specific public HTTPS pages without credentials, tracking, localhost or private IP literals;
- count and distinct IDs;
- URL deduplication within the new batch **and against every historical v0.2 reference URL**;
- every item permanently marked `candidate_text_checked_visual_pending` with no authority to present itself as human-reviewed;
- a mandatory 1440px + 390px visual, interaction and license/purpose check before any candidate is upgraded;
- no screenshot/media/assets stored and an explicit **analysis-only, do-not-copy** rights boundary.

This validation prevents accidental status changes but is NOT proof that page text is trustworthy, that every third-party URL will remain available, or that sources were actually seen by a person. Results are **not connected to** Codex, the image pipeline, demo templates, CRM, design worker or Supabase. No new image generation permission is implied. Existing `v02` importer/test/prompt SHA pins are unchanged.

## How to scale toward ~120 *usable* references

1. **Seed in batches of 10–20** from verified specific URLs, not scraped search-result blurbs. Avoid treating gallery pages, site plans, concept portfolios and working live sites as equivalent evidence.
2. **Human visual audit (separate):** examine at least desktop ~1440px and mobile ~390px and record actual hero structure, text-photo treatment, product presentation, section rhythm, CTA, responsive behavior, reference source type, screenshot observation date, and *what not to imitate*. Only verified observations may become reviewed technique cards.
3. **Balance learning goals, not just industries:** check the candidate pool for under-covered photo-text blending, typographic hierarchy, premium service trust, mobile navigation, product hierarchy, and careful image-ground effects. Limit influence from any one design studio.
4. **Use a shop-specific blend:** infer the shop's distinctive evidence and image permissions first; choose 3–5 complementary **reviewed transferable techniques**, not a genre template. Record why other visually tempting references are rejected. Original designs must not reuse logos, product imagery, copy or site composition.
5. **Evaluate before generating again:** use the independent v2-v3 critique (Issue #124) to require a written tradeoff note on what gets worse, not just what looks striking. The existing formal 22/25 and each ≥4 gate remain unchanged.

No automatic scraping/recurring bot, no API charges, no production user data, no `main` merge. The reviewed visual database is a **future human-assisted phase**, not falsely completed by this seed. See Issue #126 for the scope.
