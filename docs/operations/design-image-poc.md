# Design image PoC — 架空菓庵 (local only)

## Purpose
Use Second Root's curated v0.2 art-direction knowledge and the existing DEV-073 **fictional wagashi** facts to ask Codex (signed in with ChatGPT) for **one visual PNG mockup**, not a website. Compare later with the existing generator only after the visual is reviewed. This PoC **does not** publish or modify a site.

## Source of truth
- Store facts: `scripts/sales-design-worker/compare/shops/wagashi.json` (never copy facts from generated pixels).
- Curated art direction: `design-library/poc/wagashi-art-direction.json`.
- Generator: `scripts/sales-design-worker/design-image-poc.mjs`.
- Reference research v0.2 is a working draft; claims about unverified sites are not treated as confirmed and third-party imagery is not used as an asset.

## Safety
- **Human approval required for each Codex image generation run**; no job/timer automatically invokes this script.
- Use only the existing isolated `sr-designgen` WSL account with its own ChatGPT-authenticated Codex; **do not** use the account that runs 怪異読本, copy tokens, or move auth files.
- Codex runs through **the existing `prepareCodexSandbox` bubblewrap OS jail**, with the same `workerProtectedPaths` concept. Its own `--sandbox read-only` alone is not adequate.
- No Supabase, Staging, Production, Vercel, bridge, worker queue, browser helper, timer, sales DM, or GitHub push is involved.
- Generated image can be imperfect: text may be wrong, aspect ratio may differ from requested layout, and three sections may not fit. Report actual PNG size, do not claim success until viewed.
- Photo-free means no unapproved product photographs **and no invented photorealistic product imagery**.
- No first-party credentials or API keys are copied into this repo. Never log full Codex stdout, stderr, responses, or auth tokens.

## Run (only after explicit human WSL approval)
```bash
# As the dedicated sr-designgen WSL user:
cd ~/work/second-root
git fetch origin feature/design-image-poc-v02
# Review the entire PR and use a separate safe detached checkout/worktree.
# Ensure timers and worker are not being changed by this experiment.
pnpm install --frozen-lockfile
pnpm exec tsx scripts/sales-design-worker/design-image-poc.mjs --human-approval-confirmed
```
If `--human-approval-confirmed` is omitted, it stops **before reading files, preparing sandbox, or using Codex**. The flag means consent to the **one** image-generation Codex call and potential ChatGPT usage quota consumption; do not run it automatically in CI.

## Output
On success, the script prints a path under `~/sr-design-image-poc/wagashi-XXXXXX/` holding:
- `mockup.png` — unapproved *design concept*, not deployed.
- `shop-facts.json` — exact copied fictional facts from DEV-073 fixture.
- `design-spec.json` — curated art direction.
- `report.json` — actual PNG dimensions/hash and **IMAGE_GENERATED_NOT_IMPLEMENTED** status.

No code implementation or screenshot QA has yet happened. Review image visually first; then Claude can implement the 3-section page in a **separate** isolated PoC, screenshot 1440/390, and compare. Existing worker / staging integration needs a distinct review and approval.

## Stop and failure handling
If Codex is not signed in, sandbox probe fails, API-key authentication is detected, quota is reached, no image was produced, image invalid, or time limit hit: **stop**. No fallback to an unrestricted Codex process, external API, screenshot copying, or worker run.

## Success criteria for this stage
One generated PNG genuinely reflects art direction; recognizable shop name; no fabricated factual content or photos; 3 coherent short sections; aesthetically strong first-fold composition. Passing a file checksum **is not** passing design review.
