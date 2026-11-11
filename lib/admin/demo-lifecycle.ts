import "server-only";
/**
 * DEV-196d-6 (spec §4.6・§6.6・§9.4・§9.5): withdrawing a quality approval and revoking a version.
 *
 * Each: the flag (off → refused, nothing read or written) → the input's shape (with the explicit second confirmation)
 * → the version re-read NOW through the admin's own session → the re-check (stale, still the active approval / still
 * revocable, an open send, the urgent reasons) → only then the DEV-196c function, as the admin. Nothing is settled,
 * cancelled, approved or switched automatically: an open send is shown and the action stops (approval_open).
 */
import type { createAuthClient } from "@/lib/supabase/server";
import { loadDemoVersionsPage } from "@/lib/admin/demo-versions";
import { DEMO_VERSION_ERROR_LABEL, demoVersionErrorMessage, LIFECYCLE_REFUSAL_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { demoVersionsEnabled, type Env } from "@/lib/sales/demo-version/flags";
import { checkRevoke, checkWithdraw, RevokeInput, WithdrawInput, type LifecycleRefusal } from "@/lib/sales/demo-version/lifecycle-input";

export type LifecycleResult = { ok: true; replayed: boolean } | { ok: false; error: string; refusals?: LifecycleRefusal[] };
type Client = Awaited<ReturnType<typeof createAuthClient>>;
type Deps = { env: Env; now: Date; client: Client; factsSha256?: (demoId: string) => Promise<string | null> };

async function reread(prospectId: string, o: Deps) {
  const page = await loadDemoVersionsPage(prospectId, { env: o.env, now: o.now, client: o.client, factsSha256: o.factsSha256 });
  if (page.kind === "not_found") return { error: DEMO_VERSION_ERROR_LABEL.not_found! } as const;
  if (page.kind === "error") return { error: "版を読み込めませんでした。画面を再読み込みしてください。" } as const;
  return { page } as const;
}
const refused = (r: LifecycleRefusal[]): LifecycleResult => ({ ok: false, error: [...new Set(r.map((x) => LIFECYCLE_REFUSAL_LABEL[x]))].join(" "), refusals: r });

export async function submitWithdraw(raw: unknown, o: Deps): Promise<LifecycleResult> {
  if (!demoVersionsEnabled(o.env)) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.feature_disabled! };
  const parsed = WithdrawInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const r = await reread(parsed.data.prospectId, o);
  if ("error" in r) return { ok: false, error: r.error! };
  const refusals = checkWithdraw(parsed.data, r.page.view, r.page.view.versions.find((v) => v.id === parsed.data.versionId));
  if (refusals.length) return refused(refusals);
  const { data, error } = await o.client.rpc("sales_withdraw_demo_quality_review", { p_review_id: parsed.data.reviewId });
  if (error) return { ok: false, error: demoVersionErrorMessage(error.message) };
  return { ok: true, replayed: (data as { replayed?: unknown } | null)?.replayed === true };
}

export async function submitRevoke(raw: unknown, o: Deps): Promise<LifecycleResult> {
  if (!demoVersionsEnabled(o.env)) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.feature_disabled! };
  const parsed = RevokeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: DEMO_VERSION_ERROR_LABEL.invalid_input! };
  const r = await reread(parsed.data.prospectId, o);
  if ("error" in r) return { ok: false, error: r.error! };
  const refusals = checkRevoke(parsed.data, r.page.view, r.page.view.versions.find((v) => v.id === parsed.data.versionId));
  if (refusals.length) return refused(refusals);
  const { data, error } = await o.client.rpc("sales_revoke_demo_version", { p_version_id: parsed.data.versionId, p_code: parsed.data.code });
  if (error) return { ok: false, error: demoVersionErrorMessage(error.message) };
  return { ok: true, replayed: (data as { replayed?: unknown } | null)?.replayed === true };
}
