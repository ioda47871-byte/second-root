/**
 * DEV-139 — TESTS ONLY. A STUB approval record for ほし窯 (bakery, a FICTIONAL bakery), written before the owner's
 * approval so the offline tests could show the whole photo path (bundle writer → intake → swap → package). Since the
 * owner's approval of 2026-11-18 the repository holds the real record (HOSHIGAMA_APPROVAL) and the approved swap spec;
 * this stub names the same byte pins under a test-only record name and run approval id, and never reaches the worker.
 *
 *  - STUB_APPROVAL: an approval record naming the DRAFT prompt's pins (as the owner's would, if the owner approved the
 *    draft unchanged), with the upscale list of the brief's proposal. Handed explicitly to the writer and the intake.
 *  - approvedBakerySpec() / approvedSpecFor: a NEW spec object with the two fields the owner's approval would set
 *    (aiDemoAllowed true, aiDemoPromptSha256 the draft's SHA-256), handed explicitly to the in-process seams. The
 *    committed SWAP_SHOP_SPECS are frozen; no CLI can take this spec.
 */
import { HOSHIGAMA_PROMPT_DRAFT_BYTES, HOSHIGAMA_PROMPT_DRAFT_SHA256, HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS, HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256, type HoshigamaApproval } from "../../lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { SWAP_SHOP_SPECS, type SwapShopSpec } from "../../lib/design-agent/quality-pipeline/photo-swap-shops";

export const STUB_APPROVAL: HoshigamaApproval = {
  approval_record: "test-stub-hoshigama-approval",
  decided_by: "owner",
  decided_on: "2026-11-17",
  evidence: "test stub (no approval exists)",
  shop: "bakery",
  page: "d2-v2",
  jobs: 1,
  max_image_calls: 3,
  codex_runs: 1,
  timeout_minutes: 15,
  retry: false,
  core_prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256,
  core_prompt_bytes: HOSHIGAMA_PROMPT_DRAFT_BYTES,
  run_prompt_sha256: HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256,
  run_prompt_chars: HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS,
  upscale_allowed: ["ph-mouth-pc", "ph-loaf"],
};
export const STUB_RUN_APPROVAL_ID = "test-stub-hoshigama-run-01";

/**
 * The spec ほし窯's swap would have after the owner's approval (aiDemoAllowed true, the draft's prompt SHA-256 pinned) —
 * a NEW object; the committed SWAP_SHOP_SPECS are frozen and unchanged. Handed only to the in-process seams
 * (swapPage's `spec`, prepareSwap / package-local main's `aiDemoSpecFor`).
 */
export function approvedBakerySpec(): SwapShopSpec {
  return { ...SWAP_SHOP_SPECS.bakery, aiDemoAllowed: true, aiDemoPromptSha256: HOSHIGAMA_PROMPT_DRAFT_SHA256 };
}
/** the resolver for prepareSwap / package-local main: the approved ほし窯 spec, every other shop as committed */
export const approvedSpecFor = (shop: string): SwapShopSpec | null =>
  shop === "bakery" ? approvedBakerySpec() : Object.prototype.hasOwnProperty.call(SWAP_SHOP_SPECS, shop) ? SWAP_SHOP_SPECS[shop as keyof typeof SWAP_SHOP_SPECS] : null;
