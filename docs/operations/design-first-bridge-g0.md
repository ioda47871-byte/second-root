# DEV-112 — existing Sales Design Bridge → design-first G0 fact handoff (offline)

## Scope and the existing system (do not reinvent it)

The existing [Sales Agent MVP spec](../MVP_SPEC.md), [Architecture §10](../ARCHITECTURE.md), [design worker](design-worker-wsl.md), [DEV-052 cycle](design-worker-cycle.md) and [Design-first G0–G6](../design/design-first-workflow-decision.md) remain the source of truth.

Already implemented:
- Scheduled prospect discovery specification, bounded ingestion, dedupe/DNC and human-send queue
- Bridge job: a strict `DesignJobSchema` claim, converted to the worker's `JobSchema` through `lib/design-agent/bridge/worker-side.ts`
- Capture helper and existing `runJobPipeline` (DesignProfile/renderer, not image-first)
- DEV-107 `ShopFacts` → two design research proposals; this is **offline** research
- G2 one-shot image PoC, separate G4 comp-to-site harness; neither is an unattended bridge stage.

**The gap is not a missing automation platform.** The existing Bridge/worker's fact-only job is not yet wired into the independent, evidence-first Design DNA / image-first comp / implementation path. The first safe seam is to align the fact contracts before touching the live worker.

## This PR

File `lib/design-agent/design-first/bridge-g0.ts` exports `traceBridgeJobFacts(rawJob, rawEvidence)`:

1. Parse the **existing worker `JobSchema`** without adding a second job queue or new `design_status` lifecycle.
2. Require the **existing Bridge `DesignFactsSchema`** instead of silently accepting unknown fields (the existing worker historically uses `pickFacts`).
3. Check worker source URL syntax via the existing official-site / Instagram profile parsers.
4. Match each text evidence row's fact key and quote to the **exact supplied worker value**, and the source URL to that job's previously accepted source URLs. Track each menu item separately by index.
5. Return `missing_evidence` / `inconsistent_evidence` / `invalid_*` when not traceable. When every presented text fact is traceable, return `traceable_not_verified` and `shop_facts` using the DEV-107 helper, with `category` intentionally omitted from the research choices.
6. **Always** return separate flags denying photo/model input, edit, image generation, comp-to-site, publishing and outreach. All successful traces still require independent source verification and owner review.

This function does **not** fetch any site and **cannot prove** that a quotation appeared on the site. A fabricated matching text quote or an incorrect official URL would pass the text-matching part if the upstream job is wrong. `traceable_not_verified` must never be labeled `G0_PASSED`, `owner_approved` or `image_authorized`.

**Implementation changes:** one pure offline module + unit tests + this runbook + task record. Neither Bridge API nor DesignProfile schemas, worker execution, queues, DB, timers, flags, capture helper, asset rules, image approval gates nor CSS rules change.

## Why this alone does not make it fully automatic

A `DesignJobSchema` claim holds **validated facts and source URLs** but *not verifiable individual-source quotations*, approved image rights, a real-shop photo brief or an owner-selected aesthetic direction. An Instagram helper `CAPTURED` returns privacy-blurred PNGs, not licensed product images. This module must not claim these missing fields were recovered automatically.

## How to use in the next offline implementation phase

- The already existing worker job provides the `rawJob` input. For now, provide fake/fixed evidence rows **only in offline tests**; real evidence must be collected, screened and verified separately.
- Next implementation can feed actual evidence rows into this boundary, then use DEV-107's proposal validation **only after independent verification and authorization**. No images or text from reference screenshots are automatically promoted to assets or site facts.
- The **old DesignProfile path remains the live default**. Add a versioned feature gate for a separate design-first branch only when the requested source rights, per-campaign budget, model-call authorization, result lineage and quality thresholds have a tested, approved contract. Never repurpose `sales_demos.design_status=ready` to mean `mockup generated` or `site built`.
- G2 image-to-G4 implementation is another separate handoff. It needs independent asset provenance/rights, reproducible approved prompts, immutable comp bundle intake, an isolated Claude implementation job, 1440/390 browser comparison, a stop-on-failure result and a private-only delivery model.
- Work with one offline fixture before a controlled local single-shop E2E test; latest-head required CI, Fresh Review and explicit human approval before any WSL/bridge timer/flag/Staging change.

## Tests

`npx vitest run tests/unit/design-agent/design-first-bridge-g0.test.ts`

Covers fact copying, category-independence, missing/mismatched source rows, duplicate claims, unsupported evidence/image fields, unsafe source URLs, and the unconditional deny flags. Full required CI remains mandatory.

## Rollback

Delete the new module/test and restore the task entry. No runtime actions or database/schema changes are required. The existing worker did not import this module, so rollout and rollback have no live effects.
