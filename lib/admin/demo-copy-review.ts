import "server-only";
/**
 * DEV-199b (owner Issue #258, 2/3): the copy review of a demo version on the admin screen, and the owner's copy
 * decision (承認 / 改稿を依頼 / 却下).
 *
 * Reads go through the ADMIN'S OWN SESSION (RLS: sales_demo_copy_*_admin_read). The decision:
 *   1. the quality-review write flag (SALES_DEMO_QUALITY_REVIEW_ENABLED with the preview flag; off → refused, nothing
 *      read or written) — the action has already checked the admin (requireAdmin);
 *   2. the input's shape (the version, the review and the five hashes the screen showed, the decision, the note);
 *   3. the version must be the prospect's demo's; the store re-read NOW: the review must still be the version's linked
 *      review with the same hashes (a stale screen is refused), and copyDecisionRefusals (gate.ts) must be empty —
 *      the database's rules, and for an approval the facts-path check on the version's facts and the audit re-run on
 *      the stored bytes;
 *   4. only then sales_decide_copy_review as the admin (auth.uid()), which checks everything again and binds the
 *      record to the review id, its sha256 and the facts / copy / HTML / CSS hashes. Records cannot be changed.
 */
import { z } from "zod";
import { COPY_DECISIONS, copyDecisionRefusals, type CopyDecision } from "@/lib/sales/copy-review/gate";
import { COPY_DECISION_DB_ERROR_LABEL, COPY_DECISION_REFUSAL_LABEL } from "@/lib/sales/copy-review/labels";
import { loadVersionCopyContext } from "@/lib/sales/copy-review/store";
import { buildCopyReviewView, type CopyReviewView } from "@/lib/sales/copy-review/view";
import { DEMO_VERSION_ERROR_LABEL, errorCodeOf, QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled, type Env } from "@/lib/sales/demo-version/flags";
import { normaliseNote } from "@/lib/sales/demo-version/review-input";
import { NOTE_MAX_CHARS } from "@/lib/sales/demo-version/review-client";
import type { createAuthClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createAuthClient>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

/** The copy review panel of one version; `error` when the store could not be read (the screen says so). */
export async function loadVersionCopyReview(client: Client, versionId: string): Promise<{ kind: "ok"; view: CopyReviewView } | { kind: "error" }> {
  try {
    return { kind: "ok", view: buildCopyReviewView(await loadVersionCopyContext(client, versionId)) };
  } catch {
    return { kind: "error" };
  }
}

export const CopyDecisionInput = z.strictObject({
  prospectId: z.string().regex(UUID),
  versionId: z.string().regex(UUID),
  reviewId: z.string().regex(UUID),
  decision: z.enum(COPY_DECISIONS),
  reviewSha256: Sha,
  factsSha256: Sha,
  copySha256: Sha,
  pageHtmlSha256: Sha,
  pageCssSha256: Sha,
  // the database's limit (sales_demo_note_valid via normaliseNote), not a looser one (PR #264 review L)
  note: z.string().max(NOTE_MAX_CHARS * 4).refine((n) => [...n.trim()].length <= NOTE_MAX_CHARS).nullable().optional(),
});

export type CopyDecisionResult = { ok: true; decision: CopyDecision } | { ok: false; error: string; refusals?: string[] };

const refuse = (codes: string[]): CopyDecisionResult => ({
  ok: false,
  error: [...new Set(codes.map((c) => COPY_DECISION_REFUSAL_LABEL[c] ?? c))].join(" "),
  refusals: codes,
});

export async function submitCopyDecision(raw: unknown, o: { env: Env; client: Client }): Promise<CopyDecisionResult> {
  if (!demoQualityReviewEnabled(o.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  const parsed = CopyDecisionInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const input = parsed.data;
  const note = normaliseNote(input.note ?? null);
  if (!note.ok) return { ok: false, error: COPY_DECISION_DB_ERROR_LABEL.invalid_note! };

  const demo = await o.client.from("sales_demos").select("id").eq("prospect_id", input.prospectId).maybeSingle();
  if (demo.error) return refuse(["COPY_REVIEW_UNREADABLE"]);
  const demoId = (demo.data as { id?: unknown } | null)?.id;
  if (typeof demoId !== "string") return { ok: false, error: DEMO_VERSION_ERROR_LABEL.not_found! };
  let ctx: Awaited<ReturnType<typeof loadVersionCopyContext>>;
  try {
    ctx = await loadVersionCopyContext(o.client, input.versionId);
  } catch {
    return refuse(["COPY_REVIEW_UNREADABLE"]);
  }
  if (ctx.demoId !== demoId) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.not_found! };
  const q = ctx.linkedReviewId ? ctx.state.reviews.find((r) => r.id === ctx.linkedReviewId) : undefined;
  if (!q) return refuse(["COPY_REVIEW_MISSING"]);
  const same = q.id === input.reviewId && q.review_sha256 === input.reviewSha256 && q.facts_sha256 === input.factsSha256 && q.copy_sha256 === input.copySha256 && q.page_html_sha256 === input.pageHtmlSha256 && q.page_css_sha256 === input.pageCssSha256;
  if (!same) return refuse(["COPY_STALE_INPUT"]);
  const refusals = copyDecisionRefusals(ctx, input.decision);
  if (refusals.length) return refuse(refusals);

  const { error } = await o.client.rpc("sales_decide_copy_review", {
    p_version_id: input.versionId,
    p_review_id: q.id,
    p_decision: input.decision,
    p_review_sha256: q.review_sha256,
    p_facts_sha256: q.facts_sha256,
    p_copy_sha256: q.copy_sha256,
    p_page_html_sha256: q.page_html_sha256,
    p_page_css_sha256: q.page_css_sha256,
    p_note: note.note,
  });
  if (error) {
    const code = errorCodeOf(error.message);
    return { ok: false, error: Object.hasOwn(COPY_DECISION_DB_ERROR_LABEL, code) ? COPY_DECISION_DB_ERROR_LABEL[code]! : "記録できませんでした。画面を再読み込みしてください。" };
  }
  return { ok: true, decision: input.decision };
}
