import "server-only";
/**
 * DEV-196d-5 (spec §7.2・§8.3・§9): records the admin's quality decision on one demo version.
 *
 *  1. the flag (off → refused, nothing read or written);
 *  2. the input's shape (ReviewInput: 7 answers, the renders viewed, the bundle seen, per-image confirmations, the
 *     acknowledgement, the note);
 *  3. the version re-derived from the database NOW, through the admin's own session (lib/admin/demo-versions.ts):
 *     checkReview refuses a stale bundle, any blocker of the view model (status, disabled demo, facts changed or
 *     unknown, validator, rights unknown / revoked / expired, missing or unviewable renders, an open send), a render
 *     not viewed to the end, an ng item on an approval, an approval without the acknowledgement, and an AI concept
 *     image not confirmed by its id and current sha256 (or a confirmation for an image the version does not have);
 *  4. only then sales_review_demo_version (DEV-196c), as the admin, which checks everything it can again.
 *
 * DEV-196c Low (c): the per-image "no factual impersonation" confirmation is enforced HERE (server side, by image id
 * and sha256). Recording it in the database as an admin action needs a new database function — not added (see the
 * review record); the coordinator reports it to the owner.
 */
import type { createAuthClient } from "@/lib/supabase/server";
import { loadDemoVersionsPage } from "@/lib/admin/demo-versions";
import { DEMO_VERSION_ERROR_LABEL, demoVersionErrorMessage, QUALITY_REVIEW_DISABLED_TEXT, REVIEW_REFUSAL_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled, type Env } from "@/lib/sales/demo-version/flags";
import type { QualityDecision } from "@/lib/sales/demo-version/quality";
import { checkReview, normaliseNote, ReviewInput, type ReviewRefusal } from "@/lib/sales/demo-version/review-input";

export type ReviewResult = { ok: true; decision: QualityDecision; replayed: boolean } | { ok: false; error: string; refusals?: ReviewRefusal[] };

type Client = Awaited<ReturnType<typeof createAuthClient>>;

export async function submitDemoReview(
  raw: unknown,
  o: { env: Env; now: Date; client: Client; factsSha256?: (demoId: string) => Promise<string | null> },
): Promise<ReviewResult> {
  // DEV-196k: a write — the quality-review flag (which needs the preview flag) or nothing is read or written
  if (!demoQualityReviewEnabled(o.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  const parsed = ReviewInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const input = parsed.data;

  const page = await loadDemoVersionsPage(input.prospectId, { env: o.env, now: o.now, client: o.client, factsSha256: o.factsSha256 });
  if (page.kind === "not_found") return { ok: false, error: DEMO_VERSION_ERROR_LABEL.not_found! };
  if (page.kind === "error") return { ok: false, error: "版を読み込めませんでした。画面を再読み込みしてください。" };
  const version = page.view.versions.find((v) => v.id === input.versionId);
  const refusals = checkReview(input, version);
  if (refusals.length) return { ok: false, error: [...new Set(refusals.map((r) => REVIEW_REFUSAL_LABEL[r]))].join(" "), refusals };

  const note = normaliseNote(input.note);
  if (!note.ok) return { ok: false, error: REVIEW_REFUSAL_LABEL.INVALID_NOTE, refusals: ["INVALID_NOTE"] };
  const viewed = Object.fromEntries(Object.entries(input.viewedRenders).filter(([, v]) => typeof v === "string"));
  const { data, error } = await o.client.rpc("sales_review_demo_version", {
    p_version_id: input.versionId,
    p_decision: input.decision,
    p_checklist: input.checklist,
    p_viewed_renders: viewed,
    p_bundle_sha256: input.bundleSha256,
    p_note: note.note,
  });
  if (error) return { ok: false, error: demoVersionErrorMessage(error.message) };
  return { ok: true, decision: input.decision, replayed: (data as { replayed?: unknown } | null)?.replayed === true };
}
