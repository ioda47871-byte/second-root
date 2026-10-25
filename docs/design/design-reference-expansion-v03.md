# Design reference expansion v0.3 — two candidate batches (DEV-105)

**Purpose:** Broaden Second Root's research beyond the original 40 entries and nine technique cards, especially across pastries/bakeries, cafés, salons and wellness clinics. The historical `v02` JSON/Markdown remain **byte-for-byte fixed** and their SHA-pinned loader retains `references.length===40`. This is a separate **additive candidate pool**, not a fake v0.2 update, and not Supabase.

## Counts

| Research set | Records | Source verification | Usable automatically by image PoC? |
|---|---:|---|---|
| Original `v02` | 40 | historical mixed partial/visual review labels, **no attributable human signoff**; several misattributed URLs corrected via overlay | No |
| New `v03/candidates-20261025-01.json` | 15 | **specific page text / gallery tags checked**, no screenshot audit | **No** |
| New `v03/candidates-20261025-02.json` | 25 | **live pages or specific gallery detail pages text-checked**, no screenshot audit | **No** |
| Total saved reference leads | **80** | not the same as 80 fully reviewed/approved designs | No |

The first batch includes **3 pastry + 3 cafe + 2 bakery + 4 wellness + 2 salon + 1 editorial**. The second adds **11 restaurant + 4 pastry + 2 cafe + 4 salon + 3 wellness + 1 beauty**. Across both new batches there are 40 candidates, none human-reviewed.

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

## Second candidate batch: live shops + source-traceable gallery entries (DX-016–040)

The entries below were checked as **public page content / gallery metadata**, not photographed desktop/mobile pages. Local Nagoya examples are included for realistic information hierarchy; award-gallery examples are included for *potential* higher-end typographic composition. Gallery labels are not treated as observed responsive layouts.

| ID | Source page | Source type | Proposed learning target (unreviewed) |
|---|---|---|---|
| DX-016 | [PHASE ONE 名古屋新栄](https://phaseone.jp/) | official_brand_site | navigation |
| DX-017 | [cafe MELS 名古屋](https://cafe-mels.com/) | official_brand_site | product |
| DX-018 | [味処 風雅 名古屋](https://huga-hongo.jp/) | official_brand_site | section |
| DX-019 | [DINING BAR Torta due 名古屋](https://tortadue.jp/) | official_brand_site | information |
| DX-020 | [お食事の店 おぐら 長久手](https://ogura-nagakute.city/) | official_brand_site | photography |
| DX-021 | [period 名古屋プライベートサロン](https://period-nagoya.jp/) | official_brand_site | cta |
| DX-022 | [日之出整骨院 福井](https://baboibu.com/) | official_brand_site | trust |
| DX-023 | [NELU 高麗橋](https://muuuuu.org/industry/restaurant/19240.html) | design_gallery | typography |
| DX-024 | [peace put](https://muuuuu.org/industry/restaurant/23611.html) | design_gallery | hero |
| DX-025 | [Cartapani](https://muuuuu.org/industry/restaurant/18797.html) | design_gallery | palette |
| DX-026 | [日本料理店 宝善亭](https://muuuuu.org/industry/restaurant/18828.html) | design_gallery | section |
| DX-027 | [SOLES GAUFRETTE](https://muuuuu.org/industry/restaurant/13585.html) | design_gallery | brand |
| DX-028 | [HAIR ICI](https://muuuuu.org/industry/beauty/16581.html) | design_gallery | photography |
| DX-029 | [SPA NOIR](https://muuuuu.org/industry/beauty/18999.html) | design_gallery | typography |
| DX-030 | [SEE/SAW](https://muuuuu.org/industry/beauty/19057.html) | design_gallery | product |
| DX-031 | [NANEA HAIR](https://muuuuu.org/industry/beauty/17007.html) | design_gallery | palette |
| DX-032 | [Cellato](https://muuuuu.org/industry/restaurant/16681.html) | design_gallery | typography |
| DX-033 | [MAISON CACAO](https://muuuuu.org/industry/restaurant/13421.html) | design_gallery | product |
| DX-034 | [BLUE YARD](https://muuuuu.org/industry/restaurant/18232.html) | design_gallery | section |
| DX-035 | [SWISS洋菓子店](https://muuuuu.org/industry/restaurant/16832.html) | design_gallery | palette |
| DX-036 | [Kariomons Coffee Roaster](https://muuuuu.org/industry/restaurant/13499.html) | design_gallery | hero |
| DX-037 | [hōsa](https://muuuuu.org/industry/restaurant/18282.html) | design_gallery | typography |
| DX-038 | [Karaoke Bar BLOOD 藤が丘](https://bloodfujigaoka.jp/) | official_brand_site | trust |
| DX-039 | [美・れい 藤が丘](https://birei-fujigaoka.jp/) | official_brand_site | navigation |
| DX-040 | [重原整骨院・整体院 旭川](https://tukina.net/) | official_brand_site | information |

**One important difference:** `official_brand_site` denotes the actual current source page; `design_gallery` denotes someone else's listing/tag classification. Neither means a human reviewed the original layout visually. Even in the official sites, the `technique_hypothesis_unreviewed` remains an idea for an art-director to verify, not a machine-proven design trait.

## DEV-105 follow-up: first visual-audit shortlist (2026-10-25, not approvals)

The following 10 cases are a **balanced inspection queue**, not a top-ten design ranking or ten reviewed references. Selection is based on distinct research questions and source traceability. The page-text evidence and occasional third-party preview images do **not** constitute a desktop 1440px/mobile 390px verification.

| Order | Candidate | Specific reason to inspect at 1440px and 390px | Preliminary evidence limit |
|---|---|---|---|
| 1 | DX-005 パン屋SUNtoF | Test whether the in-store bread scene actually helps product discovery and practical hours/access | Agency shows a desktop/mobile *device mockup*, not verified live viewport captures |
| 2 | DX-002 harebare | Assess how origin story, signature cookie, other sweets and purchase links share the first two screens | Live page text checked; no viewport audit |
| 3 | DX-006 ON THE WAY ケーキ特設 | Test focused single-product landing-page hierarchy against full-shop information | Agency description only |
| 4 | DX-033 MAISON CACAO | Examine premium product grouping, editorial rhythm and retail CTA without losing product legibility | Gallery classification only |
| 5 | DX-027 SOLES GAUFRETTE | Test the balance of typographic impact, product scale and sale information across breakpoints | Public gallery *partial preview* visually inspected; no full live viewport audit |
| 6 | DX-036 Kariomons Coffee Roaster | Examine atmospheric café introduction versus location/menu visibility | Gallery classification only |
| 7 | DX-008 TAKE整体院 | Test clean-space/organic-divider claims, staff trust and appointment clarity | Agency's own explanation, not independent page-layout verification |
| 8 | DX-011 aoはり治療院 | Examine how first-visit explanations, facility images and booking affordances work on mobile | Agency description only |
| 9 | DX-013 DAN BRISE | Test service/menu/staff/pricing navigation and booking CTA placement | Live link structure/page text; no breakpoint audit |
| 10 | DX-023 NELU 高麗橋 | Examine premium typography legibility and food prominence on small screens | Gallery classification only |

### Live source rechecks: first factual inspection notes (2026-10-25)

These entries are **page-content / navigation evidence only**. They were inspected by reading public source and gallery/agency pages, **not** by capturing either target viewport. Treat all technique ideas below as provisional. No scored aesthetic judgment, no owner approval, no product-image license, no “human reviewed” transition.

| Candidate | Source specifically rechecked | Verified public information and provenance | Transfer hypothesis (NOT a verified layout) | Follow-up and anti-copy caution |
|---|---|---|---|---|
| DX-005 ぱんやSUNとえふ | [agency case](https://design-kom.com/design/w139panyasun/); [actual bakery website](https://panyasuntof.com/) | Agency says its objective was to convey repeatedly baked/fresh products. The live bakery's content includes news, a three-part concept (fresh bread, handmade production, solar energy), Instagram, and separate store-information blocks for two locations. | Test an original story-to-products-to-practical-access hierarchy; a shop's *real differentiator* may justify branded storytelling more than generic decorative motifs. | The case's monitor + smartphone device composite is not a real 1440/390 browser capture. Do not reuse bakery-specific solar imagery, logo, photography or content. Verify current product visibility, first-screen CTA and mobile store switch before learning a layout. |
| DX-002 harebare | [official live site](https://harebare.org/) | The navigation names the flagship ベーゴマクッキー, other sweets, café/kitchen, community activity and news. The live page has named product links, an online-store link, kitchen details and company/shop contact information. | Try a distinctive flagship-product story followed by a scannable product range and direct purchase option **only** when a client shop actually sells online. | Text hierarchy has been observed, but no visual hierarchy, image sizes, interaction or mobile menu behaviour was audited. Never import the original cookie shapes, product copy, brand color or navigation sequence. |
| DX-006 ON THE WAY ケーキ特設 | [creator's agency case](https://design-kom.com/design/w048ontheway_cake/) | The creator explicitly describes a cake-specific order page separate from the existing main café website for the new cake business. | For one standout new product, test a focused campaign/landing page rather than forcing the whole shop site to revolve around it. | No live independent landing-page observation or 1440/390 audit. Do not interpret agency copy as conversion data, and do not assume a landing page is right for a client who needs shop hours/menu first. |
| DX-013 DAN BRISE | [official live barber site](https://www.danbrise-barber.com/) | Public navigation contains concept, services, stylists, gallery, prices and shop information; the page has an external reservation link and multiple named service descriptions. | Test a premium-service design that keeps price and booking affordances findable instead of making atmospheric photography the only Hero content. | The presence of a booking link in page text does not prove tap targets or sticky buttons work at 390px. Do not copy its logo, imagery, service promises, typography composition or offsite booking destinations. |
| DX-027 SOLES GAUFRETTE | [gallery entry](https://muuuuu.org/industry/restaurant/13585.html); [gallery screenshot](https://choooodoii.com/gallery/1916/) | The gallery lists the brand's site URL and calls out typography, split-screen, visual impact and responsive classification. A **third-party partial desktop image** displays product packages and large headline treatment. | Test whether oversized typography can support rather than overpower an appetizing product view; include a practical sale CTA. | Gallery tags and partial third-party stills are **not** 1440/390 evidence. No claim about motion, responsive legibility, store-specific suitability or usage license is supported. |

### Remaining shortlist rechecks: evidence-strength and review order (2026-10-25)

| Candidate | Source recheck result | What is supportable now | Next evidence to collect |
|---|---|---|---|
| DX-011 aoはり治療院 | [agency case](https://design-kom.com/design/w068ao/) readable | The *agency* describes first-visitor reassurance with interior/staff/service photos, staff profiles, concern-specific menus, and daily-updated booking information. It also links to a legacy HTTP shop URL; this is **not** proof that the shop's live website is currently reachable. | Find the current official HTTPS site if available, inspect actual booking interaction and mobile legibility; no medical efficacy claims or borrowed images. |
| DX-008 TAKE整体院 | [agency case URL](https://usagi-design.jp/works/takeseitaiin) returned no readable page text in this recheck | Only the pre-existing candidate note can currently be consulted; **no fresh source-backed layout observation**. | Retry first-party case/page manually and gather attributable 1440/390 evidence before using its soft curves or trust cues. |
| DX-033 MAISON CACAO | [gallery entry](https://muuuuu.org/industry/restaurant/13421.html) readable | Gallery reports a [brand-site link](https://maisoncacao.com/) and classifies the example as typographic, minimal and visually striking. These are *gallery tags*, not firsthand observations. | Check actual current site and packaging/product hierarchy at both widths. |
| DX-036 Kariomons Coffee Roaster | [gallery entry](https://muuuuu.org/industry/restaurant/13499.html) readable | Gallery provides a [brand-site link](https://kariomons.com/) and reports video, split-screen, green-toned, responsive categories; no actual mobile interaction seen. | Inspect first-party Hero, movement controls and menu/location visibility; do not assume animations can be reused safely. |
| DX-023 NELU 高麗橋 | [gallery entry](https://muuuuu.org/industry/restaurant/19240.html) readable | Gallery provides an [official-site link](https://restaurant.nelu.osaka/) and labels typography, graphical/photo elements, dark tones and movement. Its category labels are not site-audit evidence. | Compare readable premium typography, product/menu placement, reduced-motion and mobile 390px navigation on actual site. |

**Pilot checkpoint:** All ten shortlist rows now have a source-recheck note or an explicit inability-to-recheck statement. **Zero** rows have passed first-party 1440/390 visual+interaction audit, independent Fresh Review or owner visual approval. There is no claim that all ten sites are currently live or usable for prompt generation.

**Cross-case learning question:** Does a shop's actual differentiator determine what occupies the Hero (live baking / local flagship product / focused cake order / premium service / signature luxury product), rather than selecting a fixed “bakery / salon / luxury” template? This is a research hypothesis; it will require independently verified screenshots and a human decision before becoming Design DNA.

**Evidence promotion rule:** These text-verified observations do not alter `evidence_scope` or `review_status`. A later separate audit must attach its actual captured width/state/URL/date, distinguish first-party pages from galleries and device-mock composites, provide visible evidence and trade-offs, and record an attributable human acceptance decision. This PR intentionally stores no third-party media and adds no image-worker integration.

### Provisional visual observations from attributable PUBLIC GALLERY images (not viewport audits)

**Scope and evidence boundary (2026-10-25):** We visually inspected **two images publicly embedded in source/reference pages**, not controlled browser renders. No pixels, asset files, layout CSS, or third-party media are committed. Observations describe what is actually visible in those *limited images*, not an official responsiveness, conversion, or performance evaluation.

| ID | Visible source | Directly visible, limited observation | Specific risk / trade-off | Transferable question (hypothesis only) |
|---|---|---|---|---|
| DX-005 | [COM design case's device-composite preview](https://design-kom.com/design/w139panyasun/) | A wide-angle in-store bakery image occupies most of the first visible screen in both a computer-screen frame and a phone frame. The store logo sits below that image in the composite; product detail is relatively small at this scale. | A large atmosphere photograph can conceal individual breads and their appeal. Device composites crop content, so the phone appearance is **not** proof of a genuine 390px viewport or mobile usability. | For a fresh-bread shop, test an original design that retains a genuine shop atmosphere yet gives its best product a separately legible focal shot. |
| DX-027 | [SOLES GAUFRETTE public gallery screenshot](https://choooodoii.com/gallery/1916/) | Large, close-up wafer/product-package photos dominate a warm neutral/medium-brown composition. Prominent high-contrast letterforms overlap the image region; small navigation and an online-store CTA are visible in the screenshot. | Editorial typography and overlapping layers can obscure products or harm legibility on a narrow viewport. A cropped gallery image is **not** a verifiable 1440px or 390px capture. | For a premium confectioner, test product-material photography as the main subject, with independent readable labels and shopping/store access appropriate to the *client's actual business*. |

**Critical temporal/commerce qualification for DX-027:** The [original official site](https://soles-gaufrette.com/) retains an explicit **2023-02-07 brand-closure notice**, and its shop entry marks the Tokyo store closed. It is therefore a **historical visual reference only**. Do not treat its store/online CTA, listings or navigation as evidence of an operating shop, a successful conversion funnel or current product availability. A page still loading in a browser does not mean the underlying business is open. The historical agency [SWIM case study](https://swm.jp/work/soles-gaufrette/) corroborates its nature as a design case rather than a verified current merchant.

**Design experiment candidate (NOT approved Design DNA):** Compare a bakery-led hero (real interior atmosphere → one large fresh-product close-up → hours/location CTA) against a pastry-led hero (product macro/texture → readable brand copy → factual shop/buy CTA), on fictional shop facts only. Keep imagery licensed or synthetic clearly marked as fictional, and do not duplicate either reference's logo, specific type composition, color arrangement, photos, wording or layering. Evaluate separate *actual* 1440px and 390px screens and visible product presentation before deciding any winner. No model/image/worker run is authorized by this text.

### Required per-site audit record (human-assisted, evidence attached)

1. Identify the actual source URL, source type, observation date, and whether the page remains live; distinguish a gallery or agency *case page* from the final shop website.
2. Capture or inspect the **actual** 1440px and 390px viewport states with the viewport width, page state, capture provenance and observed URL recorded. A monitor-and-phone composite or gallery card **cannot** satisfy either viewport.
3. Record concrete observations for hero hierarchy, real product/service prominence, photo-text overlap, typography readability, section rhythm, menu/navigation, and CTA/access/hours visibility. Include mobile overflow, button tapping and interaction where possible.
4. Record at least one **trade-off** and what should **not** transfer (e.g. decorative text obscuring product images, weak contrast, missing hours or inaccessible navigation).
5. Treat the original's imagery, copy, logo, CSS, and distinctive composition as non-transferable. Technique inspiration is allowed only at the abstract level. Check whether a proposed Second Root use has client-owned or licensed assets.
6. Record reviewer identity and explicit review decision separately. No inspection by a model, browser tool, or agency screenshot automatically sets `human_reviewed` or authorizes an image prompt.

**Pilot acceptance bar:** Ten review records with clear evidence labels; no fabricated 1440px or 390px screenshot observations; at least one documented mobile limitation/trade-off per reviewed case. Only actual verified and human-accepted observations may be considered for a later Design DNA extraction task. For this PR, **approved technique cards = 0** and **candidate records ready for the image worker = 0**.

### Data integrity note

The additive v0.3 batches use consecutive immutable `DX-001` through `DX-040` IDs, after the historical 40 v0.2 rows. The offline parser rejects intra-batch duplicates, and now also rejects cross-batch ID reuse, gaps or reordering using the previous-source count. Pass the entire historical v0.2 and preceding v0.3 URL list in order; incomplete source histories must not be used to claim a valid candidate sequence.

## How this batch is protected

`lib/design-agent/design-image/research-candidates.ts` is **offline only** and validates:
- exact required fields, sources as specific public HTTPS pages without credentials, tracking, localhost or private IP literals;
- count and distinct IDs;
- URL deduplication within each new batch **and against every historical v0.2 URL plus prior v0.3 batch URLs**;
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

No automatic scraping/recurring bot, no API charges, no production user data, no `main` merge. The reviewed visual database is a **future human-assisted phase**, not falsely completed by these two seeds. See Issue #126 for the scope.
