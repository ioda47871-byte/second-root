# AI wagashi visuals as reusable image assets — design only (DEV-075 → DEV-076 backlog)

> **Design, not implementation.** Nothing here is built. No generator exists, and the design-image PoC
> (`docs/operations/design-image-poc.md`) stays at **exactly one Codex call** (the comp).
> Each future asset call needs **its own explicit human approval**, like HUMAN-018 / HUMAN-019.
> The work item is DEV-076 in `.ai/tasks.json` (backlog); it starts only after this design is approved separately.

## Why separate assets
The 第2案 comp (one PNG of a whole page) shows the direction. It is not a source of production images:
**cropping the wagashi out of the comp is low quality (small, compressed, text and UI around it) and is not the plan.**
Crops may be used for internal reference only (e.g. to compare the implementation with the comp), never drawn on a page.
When Claude later implements the page, it needs each visual as its own full-resolution, reviewed file.

## Assets (one image per Codex call)
| asset | content | aspect (image-tool size) | used in |
|---|---|---|---|
| `hero-dorayaki-cross-section` | a dorayaki cut in half, glossy tsubu-an with whole azuki, on washi / wooden tray | 3:2 landscape (1536 × 1024) | Hero |
| `namagashi-seasonal-1` (… `-2`, optional `-3`) | one seasonal jō-namagashi on a small matte plate (e.g. autumn maple, chestnut) | 1:1 (1024 × 1024) | 商品・こだわり cards |
| `tsubu-an-macro` | a close macro of the tsubu-an texture | 1:1 (1024 × 1024) | 商品・こだわり card or a band |

Recommended set: hero + 2 namagashi + macro = **4 calls** (5 with a third namagashi). One asset per call keeps each image reviewable, re-runnable and free of layout text.

## How each call would work (same safety design as the PoC)
- **Same prompt source:** the `food_visuals` block of `design-library/poc/wagashi-art-direction-v2.json` (status, lighting, surfaces, cross-section, macro, seasonal motif, consistency, never), **copied verbatim** into every asset prompt, plus one line naming the asset and its aspect. This keeps light direction, surfaces and camera height consistent across the set. The prompt adds: no text, no people or hands, no store, no logo or packaging brand; a plain background with room to crop.
- **Same entry pattern:** a wrapper like `design-image-poc.sh` (`--human-approval-confirmed`, env allowlist, resource preflight, the worker's `run.lock` with `flock -n`, pinned `origin/develop`, time budget inside the jail's 3500 s); `--asset <id>` from a fixed list; **one call per run**.
- **Same jail:** `prepareCodexSandbox` with `workerProtectedPaths` plus the output root, ChatGPT sign-in only, `--sandbox read-only`, prompt on stdin, no reference image attached.
- **Same image intake:** taken only from `CODEX_HOME/generated_images/<thread>/`, opened with `O_NOFOLLOW` and checked by `lib/design-agent/design-image/png.ts` (signature, chunk walk with CRC, IHDR, IEND last, nothing after it, size limits).
- **Same cleanup:** thread image dir, image dirs that appeared during the run, this run's session logs, the work dir — on every exit including a signal.
- **Same reporting:** fixed codes and numbers only; never Codex's words.

## Storage, review and intake
1. **Outside the repository first:** e.g. `~/sr-design-image-assets/<asset id>-XXXXXX/` (0700 / 0600), never inside the repo, the worker's dirs, CODEX_HOME or the asset store. Never committed or published.
2. **Human review and approval** of each image (the hard fails of `design-image-eval-template.md` apply: no store, people, hands, logo, text in the image; looks like wagashi; consistent with the set). The approval is recorded by the human (e.g. an entry in the review record), with the asset's sha256.
3. **Only then intake into the asset store.** Today the store cannot take them, by design:
   - `lib/design-agent/assets/manifest.ts` accepts `sourceKind: "approved_real"` only. DEV-070 (2026-10-20, the human's decision) **removed `generated_concept`**; a manifest listing any other kind fails to parse.
   - `intake.ts` (`intakeAsset`) refuses any other source kind (`SOURCE_KIND`), requires `peopleConfirmedNone`, re-draws the image through Chromium into a new PNG (no metadata survives), stores it under a random `asset-<24 hex>` id, at most 3 per job, in the store root (`assetStoreRoot`: `SR_DESIGN_ASSETS_ROOT` or `~/.local/share/second-root-design-assets`, hidden from Codex by the jail).
   - `PUBLIC_DEMO_ASSETS_ENABLED = false`: the public demo shows no stored image at all.

   Adding an `ai_generated_concept` source kind (its schema, the renderer's use rule, the disclosure on the page, the public-demo switch) **reverses part of DEV-070 and needs a separate human decision**. Until then, approved AI assets stay outside the store and are used only by a separate, local implementation PoC.

## Metadata per asset (proposed record)
```json
{
  "assetName": "hero-dorayaki-cross-section",
  "source": "ai_generated_concept",
  "promptVersion": "wagashi-art-direction 0.3-poc food_visuals + asset line v1",
  "sha256": "<64 hex of the accepted PNG>",
  "width": 1536, "height": 1024,
  "generatedAt": "<ISO time>", "workerCommit": "<git sha>",
  "approval": { "approvedBy": "<handle>", "approvedAt": "<ISO time>", "recordId": "<review record id>" },
  "people": "none",
  "alt": "どら焼きの断面と粒あんのイメージ（AI生成）"
}
```
Alt text describes the image as an image (イメージ・AI生成); it never claims a real product (no 「当店の」「実物」「人気の」).

## Disclosure wherever they are used
Any page that shows these assets shows a legible line such as 「和菓子の画像はAI生成のイメージです」 (with 「架空店舗のデザイン提案」 for the fictional shop), near the images or in the footer. No caption, alt or copy may present them as photos of a shop's actual products.

## Not allowed
- cropping the comp's visuals as production assets (internal reference only)
- images of a store, interior, exterior, signage, staff, people, hands; logos, crests or branded packaging; text inside the images
- using the assets for a real shop's demo as if they were that shop's products
- intake into the asset store, the worker, presets, the renderer or a public page without the separate human decision above
- more than one Codex call per approved run; any API key or paid API

## Cost and time (rough, per asset)
- **1 Codex image call** on the ChatGPT plan of `sr-designgen` (plan usage, **no API billing**). Usually a few minutes; cut at 15 min.
- One run (checkout + call + cleanup): about 5–20 min, capped at 55 min. A set of 4 assets = 4 separately approved runs (≈ 4 × the PoC's plan usage); a rejected image means another approved run.
- Human time: about 5 min per asset to copy out, look at and approve or reject.
