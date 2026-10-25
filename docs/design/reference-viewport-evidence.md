# Reference viewport evidence (DEV-106, Issue #128)

The ten cases of Issue #128 are observed in a real browser at desktop 1440 px and mobile 390 px. The results are recorded
in `design-library/research/v03/viewport-evidence-20261025.json` and validated by
`lib/design-agent/design-image/reference-evidence.ts`. The aim is not more records: it is a few design principles that are
actually supported, which a shop-specific original design can then use.

## Scope (owner authorization, 2026-10-25)

- **Only the ten public sites of Issue #128:** DX-005, DX-002, DX-006, DX-033, DX-027, DX-036, DX-008, DX-011, DX-013 and DX-023.
  - For a gallery or agency case study, the brand's own first-party site may be captured as a second page of the same case.
- **Both viewports:** 1440 and 390.
- **No login, no access-control workaround and no paid service.** No scheduled re-crawl, and the target list is never
  extended automatically.
- **Screenshots** stay in a temporary local directory for the analysis. They are never committed; the record keeps only
  their sha256.
- **A site that cannot be opened** is recorded as `unreachable`, `blocked` or `error` with its codes, not guessed.
- **No copying.** Third-party images, copy, logos and the site's own layout are never copied. `do_not_transfer` names
  them for each case.

## What a record says

- **Pages.** The recorded candidate page comes first.
  - A second page is optional. It must be the brand's own site (`official_brand_site`), at a different URL, with
    `link_evidence` saying where its link to the case was found. It is only allowed if the case page itself loaded.
  - `link_evidence` is the writer's own statement. Nothing offline can prove the link exists, and the screenshot that
    showed it is not committed. A reviewer who doubts the link should open the case page and check it.
  - **Operating status:**
    - `live_first_party_site` needs an official site that loaded on its own host.
    - `closed_per_public_notice` needs the notice recorded in `operating_note`.
    - Otherwise the status is `unknown`.
  - **Captures:** each page has exactly one 1440 capture and one 390 capture, each with its outcome, end URL, HTTP status,
    problem codes and the screenshot's sha256.
    - A loaded capture needs a hash, an end URL and a status below 400.
    - The end URL is never an image file and has no long query.
    - One screenshot cannot back two captures.
- **Observations** cover eight aspects per viewport: hero, product or service visibility, typography, section rhythm,
  primary CTA, practical information, navigation and visual material.
  - Each one is `observed`, with a note in our own words and the page it comes from, or `unknown`, with the reason.
  - `observed` needs a loaded capture of that page at that viewport. There is no `pass`.
- **Analysis fields:**
  - design features;
  - up to 5 transferable techniques, each with why it works, where it fits and its risk;
  - weaknesses;
  - desktop-vs-mobile differences;
  - what not to transfer.
- **Analysis** comes from a Claude session. A ChatGPT second opinion may be added only as text the owner pastes in
  (`chatgpt_via_owner`). The label is the writer's own claim: the schema cannot prove the owner pasted it, so the PR history
  is the record. Neither the analysis nor the second opinion is a human review.
- **Human review** is `pending` in schema v1. The owner alone accepts or rejects techniques; that decision is recorded in
  a later version, and only from the owner's own message.
- **Capture problems.** Problem codes also record what the headless run did not show, for example
  `OPENING_SCREEN_NOT_CLEARED` (the page stayed on its opening animation), `FULLPAGE_DARK_BELOW_FOLD`,
  `SCROLL_REVEAL_NOT_RENDERED`, `LAZY_IMAGES_MISSING`, `TEXT_FADE_IN_PARTIAL`, `POSSIBLE_SLIDE_IN_MID_STATE` and
  `HERO_CAROUSEL_ROTATES` (the first screen and the full page showed different slides). Where the design is seen only
  indirectly: `DESIGN_SEEN_AS_REDUCED_IMAGE` (an agency's image of it), `DESIGN_SEEN_AS_GALLERY_THUMBNAIL`,
  `GALLERY_SHOWS_OLDER_DESIGN`. An aspect hidden this way is `unknown`; a capture gap is not counted as a weakness of
  the design.
- **Fold shots.** `image_sha256` is the full-page screenshot. `FOLD_SHOT_USED` marks a capture whose observations come
  from the first-screen shot instead. This applies to the DX-013 desktop retake: its full-page image stayed one solid
  colour (`FULLPAGE_BLANK`), byte-identical to the first attempt, so its hash cannot tell the two runs apart. The
  observations come from the retake's first-screen shot and page text.
- **Capture method.** The first three cases were captured without scrolling. From DX-005 on, and for the one DX-013
  desktop retake the owner allowed, the page is scrolled through first so lazy and scroll-revealed content renders.
  Viewport screenshots at each step are kept locally (`STEP_SHOTS_USED` when an observation relies on them), and a
  read-only DOM check records fixed headers or bars at mid-page and text such as opening hours.
- **Second opinions** exist only where the owner pasted one (DX-002, DX-013 and DX-033, 2026-10-25). They were written
  from the PR records, not from the screenshots.

## Order

1. Build the schema and its tests (offline), then run Fresh Review and CI.
2. Capture three cases and present a comparison sheet to the owner.
3. After the owner confirms the method, capture the remaining seven.
4. The owner decides which techniques to adopt.
5. The adopted techniques go into Design DNA in a separate step.

The shortlist proposed to the owner after all ten cases is `docs/design/reference-technique-shortlist.md`.

Production, Staging, Supabase, the image worker, real Codex and develop→main are not touched.
