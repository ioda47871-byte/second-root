/**
 * DEV-196d-5 (spec §7.2・§8.3・§9, DEV-196c Lows a / c / d): the admin's quality decision as the server receives it,
 * and the server's own re-check of it against the version as the database shows it NOW. The client's state (what
 * was ticked, what was scrolled, which images were confirmed) is never trusted: every condition is checked again here,
 * then again by sales_review_demo_version.
 *
 * Pure.
 */
import { z } from "zod";
import { RENDER_VIEWPORTS, type RenderViewport } from "./manifest";
import { evaluateQualityDecision, QUALITY_CHECKLIST_ITEMS, QualityChecklist, QUALITY_DECISIONS, type QualityChecklistItem } from "./quality";
import type { VersionView } from "./view-model";

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const ReviewInput = z.strictObject({
  prospectId: Uuid,
  versionId: Uuid,
  decision: z.enum(QUALITY_DECISIONS),
  /** every one of the 7 items answered by the admin: "ok" or "ng" (no default, nothing inferred) */
  checklist: QualityChecklist,
  /** viewport → sha256 of each render the screen showed to its very end (RenderPane data-viewed) */
  viewedRenders: z.strictObject(Object.fromEntries(RENDER_VIEWPORTS.map((v) => [v, Sha256.optional()])) as Record<RenderViewport, z.ZodOptional<typeof Sha256>>),
  /** the version's bundle hash the screen was built from (stale if it differs) */
  bundleSha256: Sha256,
  /** per-image "no factual impersonation" confirmations: each AI concept image of the version, by id AND sha256 */
  impersonation: z.array(z.strictObject({ imageId: Uuid, sha256: Sha256 })).max(40),
  /** the admin acknowledged, before approving, that the approval stops this shop's sending (Low d) */
  acknowledgedSendStop: z.boolean(),
  note: z.string().max(2000).nullable(),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

/**
 * DEV-196c Low (a): sales_demo_note_valid, mirrored so the form can say what is wrong before sending (the database
 * stays the judge). Trims and turns an empty note into null; refuses a URL, a domain-like word ("style.css",
 * "example.com") or an email address, and more than 500 characters.
 */
export function normaliseNote(raw: string | null | undefined): { ok: true; note: string | null } | { ok: false } {
  const n = (raw ?? "").trim();
  if (n === "") return { ok: true, note: null };
  if ([...n].length > 500) return { ok: false };
  const k = n.normalize("NFKC");
  const lower = k.toLowerCase();
  if (/([a-z][a-z0-9+.-]*:\/\/|https?:|www\.)/.test(lower)) return { ok: false };
  // Postgres \M (end of word) after the top-level part: the next character is not a word character
  if (/[a-z0-9_-]+(\.[a-z0-9_-]+)*\.[a-z]{2,}(?=[/:]|[^a-z0-9_]|$)/u.test(lower)) return { ok: false };
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(k)) return { ok: false };
  return { ok: true, note: n };
}

export type ReviewRefusal =
  | "VERSION_NOT_FOUND"
  | "STALE"
  | "BLOCKED"
  | "CHECKLIST_INVALID"
  | "CHECKLIST_HAS_NG"
  | "DECISION_NEEDS_NG"
  | "RENDER_MISSING"
  | "RENDER_NOT_VIEWED"
  | "IMPERSONATION_NOT_CONFIRMED"
  | "IMPERSONATION_UNKNOWN_IMAGE"
  | "SEND_STOP_NOT_ACKNOWLEDGED"
  | "INVALID_NOTE";

/**
 * The server's re-check of a decision against the version as just re-derived from the database (view model).
 * Returns every reason to refuse; empty means the RPC may be called.
 */
export function checkReview(input: ReviewInput, version: VersionView | undefined): ReviewRefusal[] {
  if (!version) return ["VERSION_NOT_FOUND"];
  const out = new Set<ReviewRefusal>();
  if (input.bundleSha256 !== version.bundleSha256) out.add("STALE");
  if (!normaliseNote(input.note).ok) out.add("INVALID_NOTE");
  const approving = input.decision === "approved";
  if ((approving ? version.approveBlockers : version.reviewBlockers).length) out.add("BLOCKED");

  const renders: Partial<Record<RenderViewport, string>> = Object.fromEntries(version.renders.map((r) => [r.viewport, r.sha256]));
  const evaluated = evaluateQualityDecision({ decision: input.decision, checklist: input.checklist, renders, viewedRenders: input.viewedRenders });
  if (!evaluated.ok) for (const c of evaluated.codes) if (c !== "DECISION_INVALID") out.add(c);
  // a shown render must be this version's render (any decision): never a sha the version does not have
  for (const v of RENDER_VIEWPORTS) {
    const seen = input.viewedRenders[v];
    if (seen !== undefined && renders[v] !== seen) out.add("RENDER_NOT_VIEWED");
  }
  if (!approving && QUALITY_CHECKLIST_ITEMS.every((k: QualityChecklistItem) => input.checklist[k] === "ok")) out.add("DECISION_NEEDS_NG");

  if (approving) {
    if (!input.acknowledgedSendStop) out.add("SEND_STOP_NOT_ACKNOWLEDGED");
    // every AI concept image of the version, confirmed by its id AND its current sha256; nothing else
    const required = new Map(version.images.filter((i) => i.aiConcept).map((i) => [i.imageId ?? "", i.sha256]));
    const given = new Map<string, string>();
    for (const c of input.impersonation) {
      if (given.has(c.imageId) || !required.has(c.imageId) || required.get(c.imageId) !== c.sha256) out.add("IMPERSONATION_UNKNOWN_IMAGE");
      given.set(c.imageId, c.sha256);
    }
    for (const [imageId, sha] of required) if (imageId === "" || given.get(imageId) !== sha) out.add("IMPERSONATION_NOT_CONFIRMED");
  }
  return [...out];
}
