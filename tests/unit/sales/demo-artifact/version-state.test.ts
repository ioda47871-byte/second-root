import { describe, expect, it } from "vitest";
import { canAdminPreview, guardHashChange, HASH_CHANGING_OPERATIONS, resolveSharedVersion, VERSION_STATE_PERMISSIONS, VERSION_STATUSES, versionRetentionUntil, type VersionRow } from "@/lib/sales/demo-artifact/version-state";
import { DEMO_ID, VERSION_ID } from "./fixtures";

const NOW = new Date("2026-11-10T03:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const row = (o: Partial<VersionRow> = {}): VersionRow => ({ id: VERSION_ID, demo_id: DEMO_ID, status: "approved", revoked_at: null, expires_at: days(30), ...o });
const publicDemo = { expiresAt: days(20), disabledAt: null, keepAlive: false };
const sent = [{ state: "sent" as const, demo_version_id: VERSION_ID }];
const share = (o: Partial<Parameters<typeof resolveSharedVersion>[0]> = {}) => resolveSharedVersion({ demo: publicDemo, approvals: sent, version: row(), demoId: DEMO_ID, shareEligible: true, now: NOW, ...o });

describe("version states (§4.6)", () => {
  it("has the spec's permission table", () => {
    expect(VERSION_STATUSES.filter((s) => VERSION_STATE_PERMISSIONS[s].adminPreview)).toEqual(["draft", "approved", "superseded"]);
    expect(VERSION_STATUSES.filter((s) => VERSION_STATE_PERMISSIONS[s].newSendApproval)).toEqual(["approved"]);
    expect(VERSION_STATUSES.filter((s) => VERSION_STATE_PERMISSIONS[s].servableWhenSentPinned)).toEqual(["draft", "approved", "superseded"]);
  });

  it("admin preview: previewable status, not revoked, within expires_at", () => {
    expect(canAdminPreview(row({ status: "draft" }), NOW)).toBe(true);
    expect(canAdminPreview(row({ status: "superseded" }), NOW)).toBe(true);
    for (const status of ["uploading", "rejected", "revoked", "expired"] as const) expect(canAdminPreview(row({ status }), NOW)).toBe(false);
    expect(canAdminPreview(row({ revoked_at: days(-1) }), NOW)).toBe(false);
    expect(canAdminPreview(row({ expires_at: NOW }), NOW)).toBe(false);
    expect(canAdminPreview(null, NOW)).toBe(false);
  });
});

describe("share rule (§6.4・§9.4・T5・T8・T22)", () => {
  it("serves exactly the version pinned by the sent approval", () => {
    expect(share()).toEqual({ kind: "version", versionId: VERSION_ID });
  });

  it("keeps serving the pinned version after its quality approval was withdrawn or superseded", () => {
    expect(share({ version: row({ status: "draft" }) })).toEqual({ kind: "version", versionId: VERSION_ID });
    expect(share({ version: row({ status: "superseded" }) })).toEqual({ kind: "version", versionId: VERSION_ID });
    // the version's own expires_at does not end the share; the demo's share period does
    expect(share({ version: row({ expires_at: days(-1) }) })).toEqual({ kind: "version", versionId: VERSION_ID });
  });

  it("is 404 — never a fallback to another version or the React demo — when the pinned version is revoked, expired or not shareable", () => {
    expect(share({ version: row({ revoked_at: days(-1) }) })).toEqual({ kind: "not_found" });
    expect(share({ version: row({ status: "revoked" }) })).toEqual({ kind: "not_found" });
    expect(share({ version: row({ status: "expired" }) })).toEqual({ kind: "not_found" });
    expect(share({ version: row({ status: "rejected" }) })).toEqual({ kind: "not_found" });
    expect(share({ shareEligible: false })).toEqual({ kind: "not_found" });
    expect(share({ version: null })).toEqual({ kind: "not_found" });
    expect(share({ version: row({ id: "99999999-2222-4333-8444-555555555555" }) })).toEqual({ kind: "not_found" });
    expect(share({ version: row({ demo_id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) })).toEqual({ kind: "not_found" });
  });

  it("is 404 for an unsent demo, even with an approved version (no unapproved or newest version)", () => {
    expect(share({ approvals: [{ state: "approved", demo_version_id: VERSION_ID }] })).toEqual({ kind: "not_found" });
    expect(share({ approvals: [{ state: "send_opened", demo_version_id: VERSION_ID }] })).toEqual({ kind: "not_found" });
    expect(share({ approvals: [] })).toEqual({ kind: "not_found" });
  });

  it("is 404 when the demo is not public (DNC disabled, 30 days over, never sent)", () => {
    expect(share({ demo: { ...publicDemo, disabledAt: days(-1) } })).toEqual({ kind: "not_found" });
    expect(share({ demo: { ...publicDemo, expiresAt: days(-1) } })).toEqual({ kind: "not_found" });
    expect(share({ demo: { ...publicDemo, expiresAt: null } })).toEqual({ kind: "not_found" });
    expect(share({ demo: { expiresAt: days(-1), disabledAt: null, keepAlive: true } })).toEqual({ kind: "version", versionId: VERSION_ID });
  });

  it("keeps the React demo only for a sent approval that pinned no version", () => {
    expect(share({ approvals: [{ state: "sent", demo_version_id: null }], version: null })).toEqual({ kind: "legacy" });
    expect(share({ approvals: [{ state: "sent", demo_version_id: null }], demo: { ...publicDemo, disabledAt: days(-1) } })).toEqual({ kind: "not_found" });
  });

  it("is 404 when sent approvals disagree on the version", () => {
    expect(share({ approvals: [...sent, { state: "sent", demo_version_id: null }] })).toEqual({ kind: "not_found" });
  });
});

describe("send_opened guard (§9.5・T20)", () => {
  it.each(HASH_CHANGING_OPERATIONS)("%s answers approval_open while a send is open", (op) => {
    expect(guardHashChange(op, [{ state: "sent" }, { state: "send_opened" }])).toEqual({ ok: false, code: "approval_open" });
    expect(guardHashChange(op, [{ state: "approved" }, { state: "sent" }, { state: "withdrawn" }])).toEqual({ ok: true });
    expect(guardHashChange(op, [])).toEqual({ ok: true });
  });
  it("refuses an unknown operation", () => {
    expect(() => guardHashChange("delete_everything" as never, [])).toThrow();
  });
});

describe("retention (§6.6, owner decision 2026-11-10)", () => {
  it("is 60 days from creation unsent, 30 days after the share period once sent", () => {
    expect(versionRetentionUntil({ createdAt: NOW, sent: false, shareEndsAt: null })).toEqual(days(60));
    expect(versionRetentionUntil({ createdAt: NOW, sent: true, shareEndsAt: days(30) })).toEqual(days(60));
    expect(versionRetentionUntil({ createdAt: NOW, sent: true, shareEndsAt: null })).toBeNull();
  });
});
