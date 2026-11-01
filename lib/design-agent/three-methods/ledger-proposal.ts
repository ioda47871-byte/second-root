/**
 * DEV-143 (EXPERIMENTAL, opt-in): a PROPOSAL for how the live approval ledger's receipt would name the two new calls
 * of the three-method study. Nothing here writes or reads a ledger. DEV-150 added these kinds, routes and pairs to the
 * live ledger itself (which checks the pair before using an approval); the lane's tests compare the two tables.
 *
 * Before DEV-150 the ledger's receipt had kind design | image | concept_image and route A_image | B_html_prototype |
 * C_hybrid. The study needs:
 *   - kind "direction", route "direction_text": DIRECTION_FIRST's call (words, no page, no image);
 *   - kind "page_image", route "claude_page": a picture asked for by a page Claude wrote (LAYOUT_FIRST and
 *     DIRECTION_FIRST), bound to that page's SHA-256 instead of a Codex design run.
 * The receipt keeps every other field, its schema name and all limits (4 first calls, 2 retries, 15 min a call,
 * 2 h a plan, one use per approval). A retry still names a failed call of the same route and kind. The exact diff the
 * ledger would need is in docs/design/three-methods-entries.md; the lane's tests check that every receipt the
 * ledger can write today is still a valid receipt here (the proposal only adds values).
 */
import { z } from "zod";
import { sha256, type BuiltPrompt } from "./brief";

export const EXISTING_CALL_KINDS = ["design", "image", "concept_image"] as const;
export const EXISTING_ROUTES = ["A_image", "B_html_prototype", "C_hybrid"] as const;
export const PROPOSED_CALL_KINDS = [...EXISTING_CALL_KINDS, "direction", "page_image"] as const;
export const PROPOSED_ROUTES = [...EXISTING_ROUTES, "direction_text", "claude_page"] as const;
export type ProposedCallKind = (typeof PROPOSED_CALL_KINDS)[number];
export type ProposedRoute = (typeof PROPOSED_ROUTES)[number];

/** Which route each kind may be recorded with (today's pairs are what the live entries already write). */
export const KIND_ROUTES: Record<ProposedCallKind, readonly ProposedRoute[]> = {
  design: ["B_html_prototype", "C_hybrid"],
  image: ["C_hybrid"],
  concept_image: ["A_image"],
  direction: ["direction_text"],
  page_image: ["claude_page"],
};

/** Copied from the ledger, unchanged (the lane's tests compare them). */
const APPROVAL_ID = /^[a-z0-9][a-z0-9._-]{3,95}$/;
const PLAN_ID = /^[a-z0-9][a-z0-9._-]{3,63}$/;

/** The ledger's receipt with the proposed kinds and routes; every other field exactly as it is. */
export const ProposedReceipt = z.strictObject({
  schema: z.literal("phase2f_live_receipt_v1"),
  approval_id: z.string().regex(APPROVAL_ID),
  plan_id: z.string().regex(PLAN_ID),
  route: z.enum(PROPOSED_ROUTES),
  kind: z.enum(PROPOSED_CALL_KINDS),
  slot: z.string().regex(/^(first-\d+|retry-\d+|none)$/),
  retry_of: z.string().regex(APPROVAL_ID).nullable(),
  prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  prompt_chars: z.number().int().positive(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  run_id: z.string().min(1).max(100),
  reserved_at: z.string().min(1).max(40),
});
export type ProposedReceipt = z.infer<typeof ProposedReceipt>;

export function checkProposedReceipt(r: unknown): { ok: true; receipt: ProposedReceipt } | { ok: false; code: string } {
  const p = ProposedReceipt.safeParse(r);
  if (!p.success) return { ok: false, code: "RECEIPT_INVALID" };
  if (!KIND_ROUTES[p.data.kind].includes(p.data.route)) return { ok: false, code: "KIND_ROUTE_MISMATCH" };
  return { ok: true, receipt: p.data };
}

/** What the owner approved for one call (the live steps' `expected`, without the commit: no git here). */
export type Expected = { promptSha256: string; promptChars: number };

/**
 * The prompt must be exactly the approved one; checked before anything is called. The SHA-256 and the length are
 * computed here from the prompt text itself (as the live steps do): the `sha256` / `chars` a caller carries are ignored.
 */
export function checkPin(b: Pick<BuiltPrompt, "prompt">, e: Expected): { ok: true } | { ok: false; code: "PROMPT_SHA_MISMATCH" | "PROMPT_CHARS_MISMATCH" } {
  if (sha256(Buffer.from(b.prompt, "utf8")) !== e.promptSha256) return { ok: false, code: "PROMPT_SHA_MISMATCH" };
  if (b.prompt.length !== e.promptChars) return { ok: false, code: "PROMPT_CHARS_MISMATCH" };
  return { ok: true };
}
