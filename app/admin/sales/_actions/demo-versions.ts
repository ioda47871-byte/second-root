"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/auth";
import { submitDemoReview, type ReviewResult } from "@/lib/admin/demo-review";
import { DEMO_VERSION_ERROR_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { demoVersionsEnabled } from "@/lib/sales/demo-version/flags";
import { createAuthClient } from "@/lib/supabase/server";

// DEV-196d-5: the admin's quality decision (品質承認 / 修正を依頼 / 却下) on one demo version. The flag first (off →
// refused, nothing written), then the admin, then lib/admin/demo-review.ts re-checks everything against the database
// and writes only through sales_review_demo_version under the admin's own session.
export async function reviewDemoVersion(input: unknown): Promise<ReviewResult> {
  if (!demoVersionsEnabled(process.env)) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.feature_disabled! };
  await requireAdmin();
  const result = await submitDemoReview(input, { env: process.env, now: new Date(), client: await createAuthClient() });
  if (result.ok) {
    const prospectId = (input as { prospectId?: unknown }).prospectId;
    if (typeof prospectId === "string") revalidatePath(`/admin/sales/demos/${prospectId}`);
    revalidatePath("/admin/sales");
  }
  return result;
}
