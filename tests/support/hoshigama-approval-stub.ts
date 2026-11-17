/**
 * DEV-139 — TESTS ONLY. A STUB of the owner's approval for ほし窯 (bakery, a FICTIONAL bakery), so the offline tests can
 * show that the whole photo path (bundle writer → intake → swap → package) runs once the owner approves — without any
 * approval existing. Nothing here is an approval: HOSHIGAMA_APPROVAL stays null and photo-swap-shops.ts keeps
 * aiDemoAllowed: false in the repository.
 *
 *  - STUB_APPROVAL: an approval record naming the DRAFT prompt's pins (as the owner's would, if the owner approved the
 *    draft unchanged), with the upscale list of the brief's proposal. Handed explicitly to the writer and the intake.
 *  - simulateOwnerApproval(): sets, in THIS process only, the two fields of ほし窯's swap spec the owner's approval would
 *    set (aiDemoAllowed true, aiDemoPromptSha256 the draft's SHA-256) and returns the function that restores them.
 *    The real CLIs never call it; tests/support/hoshigama-approved-package-local.ts runs package-local.ts after it.
 */
import { HOSHIGAMA_PROMPT_DRAFT_BYTES, HOSHIGAMA_PROMPT_DRAFT_SHA256, HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS, HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256, type HoshigamaApproval } from "../../lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { SWAP_SHOP_SPECS } from "../../lib/design-agent/quality-pipeline/photo-swap-shops";

export const STUB_APPROVAL: HoshigamaApproval = {
  approval_record: "test-stub-hoshigama-approval",
  decided_by: "owner",
  decided_on: "2026-11-17",
  evidence: "test stub (no approval exists)",
  shop: "bakery",
  page: "d2-v1",
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

export function simulateOwnerApproval(): () => void {
  const spec = SWAP_SHOP_SPECS.bakery as { aiDemoAllowed: boolean; aiDemoPromptSha256?: string };
  const before = { aiDemoAllowed: spec.aiDemoAllowed, aiDemoPromptSha256: spec.aiDemoPromptSha256 };
  spec.aiDemoAllowed = true;
  spec.aiDemoPromptSha256 = HOSHIGAMA_PROMPT_DRAFT_SHA256;
  return () => {
    spec.aiDemoAllowed = before.aiDemoAllowed;
    if (before.aiDemoPromptSha256 === undefined) delete spec.aiDemoPromptSha256;
    else spec.aiDemoPromptSha256 = before.aiDemoPromptSha256;
  };
}
