/**
 * DEV-196b (spec §4.6・§6.4 steps 3–4・§6.6・§9.4・§9.5・T5・T8・T20・T22, owner decisions 2026-11-10): what each
 * version state permits, the share rule, the `send_opened` guard and the retention dates.
 *
 * Share rule: a share URL serves exactly the version pinned by a `sent` approval, unless that version is revoked,
 * expired, not share-eligible, or the demo is no longer public; then 404. It never falls back to another version,
 * the newest version, or the React demo. Only a `sent` approval that pinned no version (a legacy demo) keeps the
 * existing React demo.
 *
 * Pure: the caller loads the rows (DB) and passes them in. Reading and writing them is DEV-196c+.
 */
import { addDays } from "@/lib/sales/dates";
import { isDemoPublic, type DemoVisibility } from "@/lib/sales/demo";

export const VERSION_STATUSES = ["uploading", "rejected", "draft", "approved", "superseded", "revoked", "expired"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** §4.6 table: what a status permits by itself (share also needs a `sent` pin: see resolveSharedVersion). */
export const VERSION_STATE_PERMISSIONS: Readonly<Record<VersionStatus, { adminPreview: boolean; newSendApproval: boolean; servableWhenSentPinned: boolean }>> = {
  uploading: { adminPreview: false, newSendApproval: false, servableWhenSentPinned: false },
  rejected: { adminPreview: false, newSendApproval: false, servableWhenSentPinned: false },
  draft: { adminPreview: true, newSendApproval: false, servableWhenSentPinned: true },
  approved: { adminPreview: true, newSendApproval: true, servableWhenSentPinned: true },
  superseded: { adminPreview: true, newSendApproval: false, servableWhenSentPinned: true },
  revoked: { adminPreview: false, newSendApproval: false, servableWhenSentPinned: false },
  expired: { adminPreview: false, newSendApproval: false, servableWhenSentPinned: false },
};

export type VersionRow = { id: string; demo_id: string; status: VersionStatus; revoked_at: Date | null; expires_at: Date };

/** §6.4 step 3 for scope `a`: the version exists, is not revoked, its status allows preview and it is within expires_at. */
export function canAdminPreview(v: VersionRow | null, now: Date): boolean {
  if (!v || !VERSION_STATUSES.includes(v.status)) return false;
  return v.revoked_at === null && VERSION_STATE_PERMISSIONS[v.status].adminPreview && v.expires_at.getTime() > now.getTime();
}

export type ApprovalState = "approved" | "send_opened" | "sent" | "superseded" | "withdrawn";
export type ApprovalPin = { state: ApprovalState; demo_version_id: string | null };

export type ShareDecision =
  /** serve this version (only through `/demo-frame/p/…`, after the rights re-check passed) */
  | { kind: "version"; versionId: string }
  /** the `sent` approval pinned no version: the existing React demo, exactly as before DEV-196 */
  | { kind: "legacy" }
  /** 404 — never a fallback */
  | { kind: "not_found" };

/**
 * §6.4 steps 3–4 for scope `p` (and for the outer share page): which version, if any, the share URL shows.
 * `shareEligible` is the version's rights re-derived at this request (deriveVersionRights(...).shareEligible), never
 * a stored flag. The version's `status` is not consulted beyond "revoked / expired / never valid": a pinned version
 * whose quality approval was withdrawn (draft) or superseded is still the one that was sent.
 */
export function resolveSharedVersion(o: {
  demo: DemoVisibility;
  approvals: readonly ApprovalPin[];
  /** the pinned version's row (null if it does not exist) */
  version: VersionRow | null;
  demoId: string;
  shareEligible: boolean;
  now: Date;
}): ShareDecision {
  if (!isDemoPublic(o.demo, o.now)) return { kind: "not_found" };
  const sent = o.approvals.filter((a) => a.state === "sent");
  if (sent.length === 0) return { kind: "not_found" };
  const pins = new Set(sent.map((a) => a.demo_version_id));
  // two sent approvals that disagree on what was sent: we cannot tell which page the reader got
  if (pins.size !== 1) return { kind: "not_found" };
  const pinned = [...pins][0]!;
  if (pinned === null) return { kind: "legacy" };
  const v = o.version;
  if (!v || v.id !== pinned || v.demo_id !== o.demoId) return { kind: "not_found" };
  if (!VERSION_STATUSES.includes(v.status) || !VERSION_STATE_PERMISSIONS[v.status].servableWhenSentPinned) return { kind: "not_found" };
  if (v.revoked_at !== null || !o.shareEligible) return { kind: "not_found" };
  return { kind: "version", versionId: v.id };
}

/** §9.5: admin operations that change `sales_demo_version(d)` (the hash a send approval is checked against). */
export const HASH_CHANGING_OPERATIONS = ["approve_new_version", "revoke_version", "withdraw_quality_review", "revoke_image_rights", "urgent_revoke_version"] as const;
export type HashChangingOperation = (typeof HASH_CHANGING_OPERATIONS)[number];

/**
 * §9.5 rule 1 and 3: while any approval of the demo is `send_opened` (the owner may have sent it from their own app),
 * a hash-changing operation writes nothing and answers `approval_open`. The urgent revoke too: each open send must be
 * settled first (marked sent or withdrawn by the owner), never decided for them.
 */
export function guardHashChange(op: HashChangingOperation, approvals: readonly { state: ApprovalState }[]): { ok: true } | { ok: false; code: "approval_open" } {
  if (!HASH_CHANGING_OPERATIONS.includes(op)) throw new Error(`unknown operation: ${String(op)}`);
  return approvals.some((a) => a.state === "send_opened") ? { ok: false, code: "approval_open" } : { ok: true };
}

/** §6.6 (owner decision 2026-11-10): an unsent version stays viewable about 60 days from creation. */
export const UNSENT_RETENTION_DAYS = 60;
/** …and a sent version about 30 days after its share period ends (admin preview only). */
export const SENT_RETENTION_DAYS_AFTER_SHARE = 30;

/**
 * The version's `expires_at`: 60 days from creation while unsent; once sent, 30 days after the share period ends
 * (`shareEndsAt`, the demo's `expires_at`). A keep-alive demo has no share end, so the caller passes null and the
 * version is not cleaned up while it is kept alive (returns null). Deleting objects after it is a separate approval.
 */
export function versionRetentionUntil(o: { createdAt: Date; sent: boolean; shareEndsAt: Date | null }): Date | null {
  if (!o.sent) return addDays(o.createdAt, UNSENT_RETENTION_DAYS);
  return o.shareEndsAt === null ? null : addDays(o.shareEndsAt, SENT_RETENTION_DAYS_AFTER_SHARE);
}
