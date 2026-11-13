"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/auth";
import { submitCopyDecision, type CopyDecisionResult } from "@/lib/admin/demo-copy-review";
import { previewFactsPack, submitFactsPack, type FactsPackPreview, type FactsPackSubmitResult } from "@/lib/admin/demo-facts-pack";
import { previewDemoFromFacts, submitDemoFromFacts, type DemoFromFactsPreview, type DemoFromFactsResult } from "@/lib/admin/demo-onboarding";
import { submitRevoke, submitWithdraw, type LifecycleResult } from "@/lib/admin/demo-lifecycle";
import { submitDemoReview, type ReviewResult } from "@/lib/admin/demo-review";
import { QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled } from "@/lib/sales/demo-version/flags";
import { createAuthClient } from "@/lib/supabase/server";

// DEV-196k: every action here is a quality-review WRITE: SALES_DEMO_QUALITY_REVIEW_ENABLED (with the preview flag) is
// checked first; off → refused with nothing read or written.
// DEV-196d-5: the admin's quality decision (品質承認 / 修正を依頼 / 却下) on one demo version. The flag first (off →
// refused, nothing written), then the admin, then lib/admin/demo-review.ts re-checks everything against the database
// and writes only through sales_review_demo_version under the admin's own session.
export async function reviewDemoVersion(input: unknown): Promise<ReviewResult> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  const result = await submitDemoReview(input, { env: process.env, now: new Date(), client: await createAuthClient() });
  if (result.ok) {
    const prospectId = (input as { prospectId?: unknown }).prospectId;
    if (typeof prospectId === "string") revalidatePath(`/admin/sales/demos/${prospectId}`);
    revalidatePath("/admin/sales");
  }
  return result;
}

function revalidate(input: unknown) {
  const prospectId = (input as { prospectId?: unknown } | null)?.prospectId;
  if (typeof prospectId === "string") revalidatePath(`/admin/sales/demos/${prospectId}`);
  revalidatePath("/admin/sales");
}

// DEV-196d-6: 品質承認を取り下げる — the same order: flag, admin, re-read and re-check, then
// sales_withdraw_demo_quality_review as the admin. Nothing is approved or switched automatically.
export async function withdrawDemoApproval(input: unknown): Promise<LifecycleResult> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  const result = await submitWithdraw(input, { env: process.env, now: new Date(), client: await createAuthClient() });
  if (result.ok) revalidate(input);
  return result;
}

// DEV-199b: the owner's copy decision (文章を承認 / 改稿を依頼 / 却下) on a version's copy review — the same order: flag,
// admin, then lib/admin/demo-copy-review.ts re-reads the store and re-checks (stale hashes, the database's rules, for an
// approval the facts path and the re-run audit) and writes only through sales_decide_copy_review as the admin.
export async function decideCopyReview(input: unknown): Promise<CopyDecisionResult> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  const result = await submitCopyDecision(input, { env: process.env, client: await createAuthClient() });
  if (result.ok) revalidate(input);
  return result;
}

// DEV-196d-6: 版を取り消す (normal or urgent) — sales_revoke_demo_version as the admin, with a fixed reason code.
export async function revokeDemoVersion(input: unknown): Promise<LifecycleResult> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  const result = await submitRevoke(input, { env: process.env, now: new Date(), client: await createAuthClient() });
  if (result.ok) revalidate(input);
  return result;
}

// DEV-263f: 店舗の事実の登録 — the same order: flag, admin, then lib/admin/demo-facts-pack.ts checks the pasted facts
// pack against the demo's content (preview writes nothing) and registers it only through sales_register_facts_pack as
// the admin (append-only; the database checks the admin, the hashes and the demo's content again).
export async function previewDemoFactsPack(input: unknown): Promise<FactsPackPreview> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  return previewFactsPack(input, { env: process.env, client: await createAuthClient() });
}

export async function registerDemoFactsPack(input: unknown): Promise<FactsPackSubmitResult> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  const result = await submitFactsPack(input, { env: process.env, client: await createAuthClient() });
  if (result.ok) revalidate(input);
  return result;
}

// DEV-263h: デモの事実を facts pack から作る — the same order: flag, admin, then lib/admin/demo-onboarding.ts checks the
// pasted facts pack against the prospect and its demo (preview writes nothing) and writes only through
// sales_create_demo_from_facts as the admin (one transaction: the demo content derived in the database + the facts store).
export async function previewDemoFromFactsPack(input: unknown): Promise<DemoFromFactsPreview> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  return previewDemoFromFacts(input, { env: process.env, client: await createAuthClient() });
}

export async function createDemoFromFactsPack(input: unknown): Promise<DemoFromFactsResult> {
  if (!demoQualityReviewEnabled(process.env)) return { ok: false, error: QUALITY_REVIEW_DISABLED_TEXT };
  await requireAdmin();
  const result = await submitDemoFromFacts(input, { env: process.env, client: await createAuthClient() });
  if (result.ok) revalidate(input);
  return result;
}
