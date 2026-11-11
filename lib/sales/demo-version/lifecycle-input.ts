/**
 * DEV-196d-6 (spec §4.6・§6.6・§9.4・§9.5): withdrawing a quality approval and revoking a version, as the server receives
 * them, and the server's own re-check against the version as the database shows it NOW (view model). The client is
 * never trusted; sales_withdraw_demo_quality_review / sales_revoke_demo_version check again.
 *
 * Pure.
 */
import { z } from "zod";
import { REVOKE_REASONS, type RevokeReason } from "./admin-messages";
import type { DemoVersionsView, VersionView } from "./view-model";

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** The reasons an URGENT revoke may give (a fact error, a rights complaint, a safety concern). */
export const URGENT_REVOKE_REASONS = ["FACT_ERROR", "RIGHTS_COMPLAINT", "SAFETY_CONCERN"] as const satisfies readonly RevokeReason[];

export const WithdrawInput = z.strictObject({
  prospectId: Uuid,
  versionId: Uuid,
  /** the active approval the screen showed */
  reviewId: Uuid,
  bundleSha256: Sha256,
  /** the second, explicit confirmation step */
  confirmed: z.literal(true),
});
export type WithdrawInput = z.infer<typeof WithdrawInput>;

export const RevokeInput = z.strictObject({
  prospectId: Uuid,
  versionId: Uuid,
  bundleSha256: Sha256,
  code: z.enum(REVOKE_REASONS),
  urgent: z.boolean(),
  confirmed: z.literal(true),
});
export type RevokeInput = z.infer<typeof RevokeInput>;

export type LifecycleRefusal = "VERSION_NOT_FOUND" | "STALE" | "NOT_AN_ACTIVE_APPROVAL" | "NOT_REVOCABLE" | "APPROVAL_OPEN" | "URGENT_CODE";

export function checkWithdraw(input: WithdrawInput, view: DemoVersionsView, version: VersionView | undefined): LifecycleRefusal[] {
  if (!version) return ["VERSION_NOT_FOUND"];
  const out: LifecycleRefusal[] = [];
  if (input.bundleSha256 !== version.bundleSha256) out.push("STALE");
  // the approval the screen showed must still be this version's active approval
  if (!version.activeApproval || version.activeApproval.id !== input.reviewId) out.push("NOT_AN_ACTIVE_APPROVAL");
  // §9.5: a send screen is open — settle it on the Today screen first (never settled from here)
  if (view.openSends.length) out.push("APPROVAL_OPEN");
  return out;
}

export function checkRevoke(input: RevokeInput, view: DemoVersionsView, version: VersionView | undefined): LifecycleRefusal[] {
  if (!version) return ["VERSION_NOT_FOUND"];
  const out: LifecycleRefusal[] = [];
  if (input.bundleSha256 !== version.bundleSha256) out.push("STALE");
  if (!version.revocable || version.revoked) out.push("NOT_REVOCABLE");
  if (view.openSends.length) out.push("APPROVAL_OPEN");
  if (input.urgent && !(URGENT_REVOKE_REASONS as readonly string[]).includes(input.code)) out.push("URGENT_CODE");
  return out;
}
