# Second Root — v2 / v3 visual critique and next art direction (DEV-104)

**Status: assistant's provisional visual assessment, NOT owner-confirmed, NOT a formal evaluation, NOT a v4 Codex authorization.** Research/docs + an offline advisory comparison only. Neither existing evaluation thresholds nor v1/v2/v3 pinned prompts change.

## Actual basis

This is a visual comparison of the **user-shared 1024×1536 desktop comps** in the ChatGPT discussion. Both mounted PNGs were readable; **their bytes do not match the original WSL report PNGs**. The preview images do **not** prove mobile layout, HTML/CSS fidelity, asset approval or a new result of `comp-impl --intake`.

| Direction | WSL original PNG sha256 (reported) | Viewed preview sha256 | Source |
|---|---|---|---|
| v2 | `101c1c04eaef8ff957eae910c6ab1b72b6444645a4a3952aed0156ce60da91ac` | `ef7799232b84c0bdaf1010b63c862c788c3ba62894671c98a067387f22e65f55` | user preview |
| v3 | `edc7af3dc8ac9aab371a09bc9dbf3cb196d0acf42f4ad99508a3c3274afcf87f` | `80118235673f7a66ddee4fd2e42d35422e51129eb623d969bfca345632e293de` | user preview |

The machine-readable `design-library/poc/wagashi-v2-v3-review-provisional.json` and `lib/design-agent/design-image/design-comparison.ts` record seven areas separately. The contract forbids treating an unobserved mobile/render quality question as a visual win, forging owner confirmation, and calling a preview the certified original. It **does not automatically judge aesthetic quality**.

## v2 vs v3: what evidence actually shows

| Dimension | v2 (seen) | v3 (seen) | Provisional conclusion |
|---|---|---|---|
| Hero | Big appetising dorayaki, with naturally faded cream transition and a clear, filled CTA | Framed photograph and four large vertical characters, restrained text link | **Mixed** — v3 more distinctive, v2 better image integration |
| Product experience | Two generous, captioned images; seasonal and dorayaki sweets independently visible | Large story sentence, one small image and three visually empty hairlines | **v2** — clearer and more appetising offer |
| Brand identity | Calm Mincho and vermilion; recognisable but familiar two-column layout | Large vertical-name axis; quieter ink and azuki | **v3** — stronger memory of name |
| Section rhythm | Hero, two equal cards, factual table | Hero, oversized sentence + inset, table | **v3** — more varied, though the middle feels unfinished |
| Factual table | Four readable rows on muted ground | Four readable rows on muted ground | **Mixed** — neither is visually memorable |
| Mobile | No actual 390px rendering compared | No actual 390px rendering compared | **Unknown** |
| Implementation | v2 previously implemented separately, not measured against THIS original in this exercise | No implementation reviewed here | **Unknown** |

**Do not assign 23/25 to this comparison.** Our earlier assistant's 23/25 claim for v3 was optimistic and was withdrawn when the user challenged it. In particular: a distinctive font treatment is not proof of better total art direction. The existing `docs/operations/design-image-eval-template.md` remains the sole formal PoC rubric: no hard fails, human-confirmed, total ≥22/25, every criterion ≥4. This report does not supply an approval to `evaluationVerdict`.

## A better experimental direction: "食べたくなる和菓子 × 編集的な余白"

This is a **concept brief only**, not a new fixed-size template, no runnable image prompt and no new Codex call.

### 1. Store evidence first

The DEV-073 fixture establishes only this fictional shop name, hours, closed days, address, phone, and the exact description of **seasonal jō-namagashi and dorayaki filled with morning-cooked tsubu-an, wrapped individually at the small shopfront**. No claim of established history, artisans, scarcity, customer ratings, secret recipes, price, awards, order/booking, etc. No real shop photography. AI-generated pastry imagery must be disclosed and later individually approved for local use.

The earlier 40 references and nine study cards are **research candidates**, not licensed layouts. A02 supports treating short vertical Japanese name as a possible principle; A07 supports varying the reading rhythm. A09's hero text scale has no verified research visual support. No copying a source's logo/photography/composition.

### 2. One-shop-specific composition experiment

- **Opening scene:** one clean, appetite-first dorayaki cross-section, large enough to show azuki beans. Integrate this image with cream negative space naturally; avoid both v2's unvarying 60/40 split and v3's abrupt rectangular photograph-and-big-title compartments. The shop name uses expressive Mincho, but its size is **secondary to the confection**, not the only dominant image. One text link `店舗情報を見る`, legible without a filled vermilion rectangle.
- **Second scene:** lead with the verified description phrase rather than a newly invented slogan; follow with **two differently scaled confection images**, not two equal product cards, and not v3's single tiny inset. The seasonal namagashi should get an editorial close-up and the dorayaki a complementary, meaningfully smaller visual echo. Show only verified captions (`季節の上生菓子`, `粒あんのどら焼き`). Do not add decorative horizontal strokes where no content exists.
- **Final scene:** maintain a readable factual ledger with deliberate spacing, slim rules and a calm typographic finish. No decorative fake maps, invented directions or unverifiable opening claims.
- **Palette:** kinari, sumi, restrained azuki tone. Accent hierarchy must aid wayfinding, not just decoration. Text/imagery placement, relative scale and page rhythm should derive from the particular shop facts and user feedback, **not a hardcoded industry preset**.
- **Typography:** if the four-character vertical name is essential, use real `writing-mode:vertical-rl` in the **offline comp PoC only after approved capability PR #123 is merged**. Font must render characters with correct vertical metrics, order and non-overlap. Do not fake it with a single-character-wide box. If it cannot be rendered faithfully, revise the comp rather than silently compromising the hero.

### 3. Mobile is a separate design problem

At **390px**, plan the full sequence: readable compact header → horizontal full-name (unless a separately tested vertical mobile composition succeeds) → prominent hero food image → one short verified story sentence → two products of deliberately different scale → shop details → complete disclosure. Real captions and shop facts stay horizontal and legible. Do **not** call a desktop comp's 1024px image a mobile mockup.

### 4. Before any *further* real image call

Use the **same existing v2/v3** images for critique, not another billable/model call. Document:
1. What would make the hero uniquely belong to this shop instead of any wagashi shop?
2. Which two products are recognizable on sight, and why are they not treated as equal cards?
3. What exactly earns each large blank area? No fake text-line decoration.
4. Can an actual 1440px / 390px HTML/CSS build preserve the design with currently approved capabilities, font metrics and real facts?
5. What gets worse relative to v2 or v3? A recommendation **must disclose** regressions, not just praise novelty.

An art director (or owner) reviews these answers before a separately approved v4 image request. `review_ready` here is **not** permission to invoke Codex or to publish.

## Safety and handoff

The research is still **partly unreviewed**; never upgrade DR-022/023/021/037 to `human_reviewed` without owner evidence. This work is advisory only, no new thresholds, no change to `evaluationVerdict`, no worker/bridge/staging/production, no auto-approval.

**Next checks:** independent Fresh Review, CI, and optional owner review of the written design direction. Once the owner chooses to produce a **new** comp, separately approve an exact new prompt SHA and one real image call. For implementation, first intake the untouched original WSL PNG and report from its original output directory; the preview SHA above is not the one the WSL report asserts.
