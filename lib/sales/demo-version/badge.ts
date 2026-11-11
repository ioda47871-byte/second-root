/**
 * DEV-196d-7: the one-word state of a shop's demo versions for the Today card, derived from the view model (never a
 * database value as text).
 *
 *  - approved:          the shop has a quality-approved version (sales_demos.approved_version_id is that version)
 *  - otherwise, from the NEWEST version:
 *    awaiting_review (draft / superseded, no active decision) · changes_requested / rejected_by_admin (its newest
 *    active decision) · revoked · uploading · validator_rejected · expired
 *  - none:              no version at all (sending uses the React demo, as before)
 *
 * Pure.
 */
import type { DemoVersionsView, SendStop } from "./view-model";

export type DemoVersionBadgeState =
  | "none"
  | "awaiting_review"
  | "changes_requested"
  | "rejected_by_admin"
  | "approved"
  | "revoked"
  | "uploading"
  | "validator_rejected"
  | "expired";

export type DemoVersionBadge = { state: DemoVersionBadgeState; versionNo: number | null; sendStop: SendStop | null };

export function demoVersionBadge(view: DemoVersionsView): DemoVersionBadge {
  const sendStop = view.sendStop;
  const approved = view.approvedVersionId ? view.versions.find((v) => v.id === view.approvedVersionId) : undefined;
  if (approved && approved.status === "approved") return { state: "approved", versionNo: approved.versionNo, sendStop };
  const newest = view.versions[0]; // the view lists versions newest first
  if (!newest) return { state: "none", versionNo: null, sendStop };
  const at = (state: DemoVersionBadgeState): DemoVersionBadge => ({ state, versionNo: newest.versionNo, sendStop });
  if (newest.revoked) return at("revoked");
  switch (newest.status) {
    case "uploading":
      return at("uploading");
    case "rejected":
      return at("validator_rejected");
    case "expired":
      return at("expired");
    case "draft":
    case "superseded": {
      const decision = newest.reviews.find((r) => r.state === "active")?.decision;
      return at(decision === "changes_requested" ? "changes_requested" : decision === "rejected" ? "rejected_by_admin" : "awaiting_review");
    }
    case "approved":
      // approved but not the shop's approved version: the database calls the send state unavailable — say "check"
      return at("awaiting_review");
    default:
      return at("awaiting_review");
  }
}
