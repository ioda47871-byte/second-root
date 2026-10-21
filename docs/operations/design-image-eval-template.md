# Design image PoC — evaluation rubric and template (第2案, DEV-075)

> **PoC only.** This rubric judges the one mockup PNG of the design-image PoC (`docs/operations/design-image-poc.md`).
> It is not a quality gate of the worker, the demo or CI, and it changes no existing gate, threshold or check.
> A generated image is not a result: `report.json` carries `EVALUATION_REQUIRED` until this sheet is filled in and the human confirms it.

## How to use
1. The human uploads `kakuu-kaan-mockup-v2.png` (and `report.json`) into the Claude session.
2. Claude checks the hard fails first, then scores the 5 criteria with the anchors below, citing what is visible (never Codex's words).
3. The human confirms or corrects the score. The confirmed sheet goes into the PR / `.ai/reviews/DEV-075.md` (scores and short notes only; the PNG is not committed).
4. **Pass = no hard fail AND total ≥ 22/25** (the human's target). DEV-075 is done only after a pass on a human-run image.
   *Proposed by Claude, for the human to confirm (not a pass requirement until confirmed):* no criterion below 4, so that a high total cannot hide one weak area. The sheet records whether it holds either way.
   The hard fails are not a Claude addition: they enforce the human's own rules for this PoC (no invented facts, no store or people imagery, the disclosure, no logo or realism claim, the shop facts as given).

## Hard fails (independent of the score; any one fails the image)
- [ ] **Invented facts**: a price, review / rating, award, founding year / history, person or staff name, a product name or claim not in the facts (beyond verbatim description phrases), a purchase / reservation / order UI
- [ ] **Store or people imagery**: a shop exterior, interior, counter, shelf, signage or noren with writing, a street; any person, face, hand or body
- [ ] **Disclosure missing or altered**: 「架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです」 not legible or not exact
- [ ] **Logo / emblem / crest**, or a text claiming the visuals are real photos (実物・商品写真 …)
- [ ] **Garbled or wrong shop facts**: the shop name not exactly 架空菓庵, or a shown hours / closed days / address / phone value that differs from `shop-facts.json`

(Leaving out the テスト placeholders — menu names, the test station — is expected, not a fail.)

## Criteria and anchors (1–5 each)

### 1. デザインの美しさ (beauty)
- 5: a refined, premium comp a client would want; palette, type and whitespace are coherent and calm; the wagashi look appetising
- 4: clearly attractive and consistent, with one or two weak spots (a cramped area, a slightly off colour)
- 3: pleasant but ordinary, or uneven between sections
- 2: cluttered, muddy colour, awkward type or food that looks unappetising
- 1: unattractive or broken

### 2. 店舗との相性 (fit with the shop)
- 5: unmistakably a high-end contemporary wagashi shop; the sweets (dorayaki / tsubu-an, seasonal namagashi) are the clear subject
- 4: fits well; the sweets are prominent, with a minor generic element
- 3: Japanese and food-related but could be any café / sweets shop
- 2: weak link to wagashi; mostly the shop name
- 1: does not fit

### 3. 独自性 (originality)
- 5: a distinctive composition that does not look like a template or a known site
- 4: mostly original; one familiar pattern used well
- 3: competent but template-like (generic 和風 site)
- 2: clichés dominate (shrine motifs, seigaiha wallpaper, brush splashes)
- 1: looks copied

### 4. Webサイトとしての構成 (structure as a website)
- 5: header nav with anchors to the sections, CTA, Hero / 商品・こだわり (2–3 visual cards) / 店舗情報 (definition list or table) clearly separated, clear hierarchy, realistic web type sizes
- 4: all parts present, one is weak (e.g. small nav, cards a bit crowded)
- 3: one required part missing (no nav, or a text-only middle section, or an unstructured info block)
- 2: reads more like a poster than a page
- 1: a single poster

### 5. 実装可能性 (implementability)
- 5: a developer could build it in HTML / CSS on a 12-col grid with web fonts and image crops; no hand-composited effects
- 4: implementable with one small compromise
- 3: needs several approximations (complex overlaps, text on busy images)
- 2: relies on effects that are hard to reproduce
- 1: not implementable as a web page

## Template (copy into the review)

```text
Image: kakuu-kaan-mockup-v2.png   report.json: direction_version=v2, png_sha256=<…>, width×height=<…>
Run: HUMAN-019 on <date>, worker_commit=<…>

Hard fails
  invented facts ............ none / <what>
  store or people imagery ... none / <what>
  disclosure ................ exact and legible / <problem>
  logo / realism claim ...... none / <what>
  shop facts ................ match / <which differs>

Scores (1–5)
  1 デザインの美しさ ........ <n>  <one-line reason>
  2 店舗との相性 ............ <n>  <one-line reason>
  3 独自性 .................. <n>  <one-line reason>
  4 Webサイトとしての構成 ... <n>  <one-line reason>
  5 実装可能性 .............. <n>  <one-line reason>
  total ..................... <n>/25   lowest <n>

Result: PASS (no hard fail, ≥22/25) / FAIL (<reason>)
Proposed extra condition (none below 4): holds / does not hold (<which>) — human: adopt / do not adopt
Confirmed by the human: <yes / corrected to …> on <date>
Next: <e.g. implement as a page in a separate PoC / adjust the direction and ask for another approved run>
```
