# Experimental art direction for the wagashi fixture from design research v0.2 (DEV-100)

**Status: research only, exploratory, unreviewed.** No image was generated. The pinned v2 prompt
(`7334ea19…12aa`, 6801 characters), the v1/v2 direction files and the worker are unchanged. The brief is
`design-library/poc/design-dna/wagashi-v02-experiment.json` (a Design DNA brief, validated by `parseDesignDna`).

## How it was chosen

`exploreV02Techniques` with the fixture's own inputs:

| input | value | source |
|---|---|---|
| name | 架空菓庵 (4 kanji) | DEV-073 wagashi.json |
| facts on the page | 5 (hours, closed days, address, access, phone) | DEV-073 wagashi.json |
| imagery | `ai_concept_local` (3 crops the owner approved for local use, Issue #117) | owner approval |
| owner tone | `luxury` — "more premium feel and originality" after the v2 build | owner, 2026-10-24 |
| motif | dots read as the azuki grains of the tsubu-an cooked every morning | description (fact) |

Picked (each with its reason in the output): **A02** vertical Japanese accent, **A03** one fact-grounded mark,
**A04** quiet, few elements, **A07** a different lead for each section. Not picked: A01 (the shop has approved
imagery, so a photo-free name-only hero is not supported), A05/A08 (no owner tone for them), A06/A09 (limit of
four). Cited references, visually observed only, each under the part its card is assigned to: DR-022 (A02, typography), DR-032 (A04, palette), DR-027 (A03, product_visual), DR-021 (A07, section_rhythm) — principles only.

## The direction in one paragraph

The four-kanji name stands as a tall vertical column on the right third; the approved dorayaki crop sits in a
framed window on the left with open ground between. A short row of small azuki-plum dots is the only mark. The
middle section is led by one verbatim description sentence set large, with the namagashi crop small beside it.
The last section is a narrow factual ledger. One accent colour, no filled button, no equal cards. On a phone
the name turns horizontal above the image, then everything in one column.

## Against v1 and v2

| | v1 (0.2-poc) | v2 (0.3-poc, built in #117) | v0.2-research experiment |
|---|---|---|---|
| hero lead | the name only, no image | image 2/3 + name 1/3, left-right split | vertical name column + framed image, open ground |
| products | none (poster-like) | two equal image cards | one sentence leads, one small image |
| accent | red-brown | vermilion CTA block | azuki-plum dots + active nav only |
| shop-specific mark | none | none | dot row from the tsubu-an fact |
| research link | A01/A02/A06/A07 by hand | B01–B05 written for v2 | A02/A03/A04/A07 chosen from the shop's inputs, with cited, labelled references |
| the human verdict | poster-like rather than a web structure (paraphrase of the issue #110 record in `.ai/progress.md`) | 23/25 in the human-confirmed `evaluation.json` of the v2 bundle (reported in an Issue #117 comment; the bundle is not in the repo); after the build the owner asked for more premium feel and originality (Issue #117 session) | not yet judged |

**Expected improvements (hypotheses, not results):** the hero stops reading as a stock split; each section
has its own lead, so the page has rhythm instead of image–image–table; the accent and the mark come from the
shop's own fact, so a second shop gets a different page; the web structure of v2 (header, three sections,
ledger) is kept, so v1's failure is not repeated.

**Limits:** the research is model-made and unreviewed; a vertical name is built as a one-character-wide box
because the page CSS allows horizontal writing only; this is not a comp. Turning it into a new prompt version
or a real image needs separate approval (HUMAN-017/018 rules).
