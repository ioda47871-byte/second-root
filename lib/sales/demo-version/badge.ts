/**
 * DEV-196d-7: the one-word state of a shop's demo versions for the Today card, derived from the view model (never a
 * database value as text).
 *
 *  - the shop has an approved version (sales_demos.approved_version_id):
 *      approved (its status is approved and it is within expires_at) · expired (past expires_at, or an unreadable
 *      expires_at — the same rule as the view model) · revoked · unknown (any other status, or the row is missing)
 *  - otherwise, from the NEWEST version: expired (past / unreadable expires_at, or status expired) · revoked ·
 *    uploading · validator_rejected · awaiting_review (draft / superseded, no active decision) · changes_requested /
 *    rejected_by_admin (its newest active decision) · unknown (an unknown status, or "approved" on a version that is
 *    not the shop's approved one — never guessed as awaiting review)
 *  - none: no version at all (sending uses the React demo, as before)
 *
 * Pure.
 */
import type { DemoVersionsView, SendStop, VersionView } from "./view-model";

export type DemoVersionBadgeState =
  | "none"
  | "awaiting_review"
  | "changes_requested"
  | "rejected_by_admin"
  | "approved"
  | "revoked"
  | "uploading"
  | "validator_rejected"
  | "expired"
  | "unknown";

export type DemoVersionBadge = { state: DemoVersionBadgeState; versionNo: number | null; sendStop: SendStop | null };

/** Past expires_at, or an unreadable one (fail closed, as the view model does). */
export function versionExpired(v: Pick<VersionView, "expiresAt">, now: Date): boolean {
  const t = Date.parse(v.expiresAt);
  return !Number.isFinite(t) || t <= now.getTime();
}

export function demoVersionBadge(view: DemoVersionsView, now: Date): DemoVersionBadge {
  const sendStop = view.sendStop;
  if (view.approvedVersionId) {
    const approved = view.versions.find((v) => v.id === view.approvedVersionId);
    if (!approved) return { state: "unknown", versionNo: null, sendStop };
    const at = (state: DemoVersionBadgeState): DemoVersionBadge => ({ state, versionNo: approved.versionNo, sendStop });
    if (approved.revoked) return at("revoked");
    if (approved.status !== "approved") return at("unknown");
    return at(versionExpired(approved, now) ? "expired" : "approved");
  }
  const newest = view.versions[0]; // the view lists versions newest first
  if (!newest) return { state: "none", versionNo: null, sendStop };
  const at = (state: DemoVersionBadgeState): DemoVersionBadge => ({ state, versionNo: newest.versionNo, sendStop });
  if (newest.revoked) return at("revoked");
  switch (newest.status) {
    case "uploading":
      return at(versionExpired(newest, now) ? "expired" : "uploading");
    case "rejected":
      return at("validator_rejected");
    case "expired":
      return at("expired");
    case "draft":
    case "superseded": {
      if (versionExpired(newest, now)) return at("expired");
      const decision = newest.reviews.find((r) => r.state === "active")?.decision;
      return at(decision === "changes_requested" ? "changes_requested" : decision === "rejected" ? "rejected_by_admin" : "awaiting_review");
    }
    default:
      // "approved" on a version that is not the shop's approved one, or a status the screen does not know
      return at("unknown");
  }
}
