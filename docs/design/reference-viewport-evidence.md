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

## Order

1. Build the schema and its tests (offline), then run Fresh Review and CI.
2. Capture three cases and present a comparison sheet to the owner.
3. After the owner confirms the method, capture the remaining seven.
4. The owner decides which techniques to adopt.
5. The adopted techniques go into Design DNA in a separate step.

Production, Staging, Supabase, the image worker, real Codex and develop→main are not touched.
