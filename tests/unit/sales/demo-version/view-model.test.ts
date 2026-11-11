import { describe, expect, it } from "vitest";
import { AI_CONCEPT_BADGE, RIGHTS_BLOCKED_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { AI_CONCEPT_ADMIN_LABEL } from "@/lib/sales/demo-version/ai-concept-rights";
import {
  buildDemoVersionsView,
  effectiveRights,
  lineage,
  provenanceSummary,
  unshareableReasons,
  VERSIONED_SHARING_ENABLED,
  type DemoImageDb,
  type QualityReviewDb,
  type VersionFileDb,
  type VersionRowDb,
} from "@/lib/sales/demo-version/view-model";

const NOW = new Date("2026-11-11T03:00:00Z"); // 2026-11-11 12:00 JST
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const h = (c: string) => c.repeat(64);
const FACTS = h("f");

const version = (n: number, over: Partial<VersionRowDb> = {}): VersionRowDb => ({
  id: id(n),
  demo_id: DEMO,
  version_no: n,
  parent_version_id: null,
  origin: "manual_import",
  worker_commit: "abcdef1",
  facts_sha256: FACTS,
  bundle_sha256: h(String(n)),
  status: "draft",
  validator_result: { ok: true, codes: [] },
  structure_descriptor: null,
  rights_summary: null,
  expires_at: "2027-01-01T00:00:00Z",
  revoked_at: null,
  revoke_code: null,
  created_at: "2026-11-10T00:00:00Z",
  ...over,
});

const file = (v: number, path: string, role: string, over: Partial<VersionFileDb> = {}): VersionFileDb => ({
  version_id: id(v),
  path,
  role,
  sha256: h("9"),
  bytes: 10,
  content_type: role === "html" ? "text/html" : role === "css" ? "text/css" : "image/webp",
  width: role === "photo" || role === "render" ? 100 : null,
  height: role === "photo" || role === "render" ? 200 : null,
  image_id: null,
  ...over,
});

const baseFiles = (v: number) => [
  file(v, "page/index.html", "html"),
  file(v, "page/style.css", "css"),
  file(v, "renders/desktop_1440.webp", "render", { sha256: h("a") }),
  file(v, "renders/mobile_390.webp", "render", { sha256: h("b") }),
];

const image = (n: number, over: Partial<DemoImageDb> = {}): DemoImageDb => ({
  id: id(500 + n),
  sha256: h("c"),
  width: 100,
  height: 200,
  format: "webp",
  source_kind: "ai_concept_internal",
  rights_status: "ai_concept_internal",
  depicts_real_shop: false,
  depicts_identifiable_person: false,
  depicts_real_product: false,
  depicts_real_interior: false,
  depicts_real_equipment: false,
  no_factual_impersonation_confirmed_at: "2026-11-10T00:00:00Z",
  rights_expiry: null,
  provenance: { generator: "free text never shown", model: "model-x", generated_at: "2026-11-09T10:00:00Z", prompt_sha256: h("e"), approval_id: "grant-0001", admin_preview_only: true },
  revoked_at: null,
  ...over,
});

const build = (o: Partial<Parameters<typeof buildDemoVersionsView>[0]> = {}) =>
  buildDemoVersionsView({ versions: [version(1)], files: baseFiles(1), images: [], reviews: [], approvals: [], approvedVersionId: null, demoDisabled: false, currentFactsSha256: FACTS, now: NOW, ...o });

describe("buildDemoVersionsView: preview and review", () => {
  it("a clean draft with both renders is previewable, reviewable and approvable", () => {
    const v = build().versions[0]!;
    expect(v.previewable).toBe(true);
    expect(v.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "mobile_390"]);
    expect(v.renders[0]).toMatchObject({ urlPath: "renders/desktop_1440.webp", sha256: h("a"), width: 100, height: 200 });
    expect(v.reviewBlockers).toEqual([]);
    expect(v.approveBlockers).toEqual([]);
    expect(v.facts).toBe("same");
    expect(v.statusLabel).toBe("下書き（品質承認前）");
  });

  it("a missing required render blocks approval but not a rejection", () => {
    const v = build({ files: baseFiles(1).filter((f) => f.path !== "renders/mobile_390.webp") }).versions[0]!;
    expect(v.missingRequiredRenders).toEqual(["mobile_390"]);
    expect(v.approveBlockers).toEqual(["RENDER_MISSING"]);
    expect(v.reviewBlockers).toEqual([]);
  });

  it("a render the screen cannot show (unknown viewport or no size) blocks approval: the database demands every render viewed", () => {
    const odd = build({ files: [...baseFiles(1), file(1, "renders/watch_200.webp", "render")] }).versions[0]!;
    expect(odd.approveBlockers).toEqual(["RENDER_UNVIEWABLE"]);
    expect(odd.reviewBlockers).toEqual([]);
    const noSize = build({ files: [...baseFiles(1), file(1, "renders/tablet_768.webp", "render", { width: null })] }).versions[0]!;
    expect(noSize.approveBlockers).toEqual(["RENDER_UNVIEWABLE"]);
    const tablet = build({ files: [...baseFiles(1), file(1, "renders/tablet_768.webp", "render")] }).versions[0]!;
    expect(tablet.approveBlockers).toEqual([]);
    expect(tablet.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "tablet_768", "mobile_390"]);
  });

  it("revoked, expired, uploading and rejected versions are not previewable or reviewable", () => {
    for (const over of [{ status: "revoked", revoked_at: "2026-11-10T00:00:00Z", revoke_code: "FACT_ERROR" }, { expires_at: "2026-11-11T02:59:59Z" }, { status: "uploading" }, { status: "rejected" }, { status: "expired" }, { status: "nonsense" }]) {
      const v = build({ versions: [version(1, over)] }).versions[0]!;
      expect(v.previewable, JSON.stringify(over)).toBe(false);
      expect(v.reviewBlockers, JSON.stringify(over)).toContain("VERSION_NOT_REVIEWABLE");
    }
    expect(build({ versions: [version(1, { status: "nonsense" })] }).versions[0]!.statusLabel).toBe("不明な状態");
  });

  it("an approved version is previewable but not reviewable again; superseded can be re-reviewed", () => {
    expect(build({ versions: [version(1, { status: "approved" })] }).versions[0]!.reviewBlockers).toEqual(["VERSION_NOT_REVIEWABLE"]);
    expect(build({ versions: [version(1, { status: "superseded" })] }).versions[0]!.reviewBlockers).toEqual([]);
  });

  it("validator not ok, disabled demo and changed facts block every decision; unknown facts never claim 'same'", () => {
    expect(build({ versions: [version(1, { validator_result: { ok: false, codes: ["HTML_SCRIPT"] } })] }).versions[0]!.reviewBlockers).toEqual(["VALIDATOR_NOT_OK"]);
    expect(build({ versions: [version(1, { validator_result: null })] }).versions[0]!.reviewBlockers).toEqual(["VALIDATOR_NOT_OK"]);
    expect(build({ demoDisabled: true }).versions[0]!.reviewBlockers).toEqual(["DEMO_DISABLED"]);
    const changed = build({ currentFactsSha256: h("0") }).versions[0]!;
    expect(changed.facts).toBe("changed");
    expect(changed.reviewBlockers).toEqual(["FACTS_CHANGED"]);
    for (const unknown of [null, "not-a-hash"]) {
      const v = build({ currentFactsSha256: unknown }).versions[0]!;
      expect(v.facts).toBe("unknown");
      expect(v.reviewBlockers).toEqual([]);
    }
  });

  it("an open send (send_opened) blocks approving, and is listed for settling on the Today screen", () => {
    const view = build({ approvals: [{ id: id(900), outreach_id: id(901), state: "send_opened", demo_version_id: null }, { id: id(902), outreach_id: id(903), state: "sent", demo_version_id: null }] });
    expect(view.openSends).toEqual([{ approvalId: id(900), outreachId: id(901) }]);
    expect(view.versions[0]!.approveBlockers).toEqual(["APPROVAL_OPEN"]);
    expect(view.versions[0]!.reviewBlockers).toEqual([]);
  });
});

describe("buildDemoVersionsView: images and rights (fail closed)", () => {
  const withPhoto = (img: DemoImageDb | null, fileOver: Partial<VersionFileDb> = {}) =>
    build({ files: [...baseFiles(1), file(1, "page/photos/hero-desktop.webp", "photo", { sha256: h("c"), image_id: img?.id ?? id(599), ...fileOver })], images: img ? [img] : [] }).versions[0]!;

  it("an AI concept image: previewable, fixed label and red badge, needs the admin's per-image confirmation", () => {
    const v = withPhoto(image(1));
    expect(v.previewable).toBe(true);
    expect(v.images[0]).toMatchObject({ rightsStatus: "ai_concept_internal", previewable: true, aiConcept: true, aiBadge: AI_CONCEPT_BADGE, adminLabel: AI_CONCEPT_ADMIN_LABEL, needsImpersonationConfirm: true });
    expect(v.impersonationConfirmImageIds).toEqual([id(501)]);
    expect(v.unshareableReasons).toEqual(["versioned_sharing_disabled", "ai_images", "photos_not_shareable"]);
  });

  it("provenance is reduced to a date, a yes/no and a hash prefix (no model, no free text)", () => {
    const p = withPhoto(image(1)).images[0]!.provenance;
    expect(p).toEqual({ generatedOn: "2026-11-09", hasApprovalId: true, promptShaPrefix: "eeeeeeee" });
    expect(JSON.stringify(withPhoto(image(1)))).not.toMatch(/model-x|free text never shown|grant-0001/);
    expect(provenanceSummary("x")).toBeNull();
    expect(provenanceSummary({ generated_at: "yesterday", prompt_sha256: "short" })).toEqual({ generatedOn: null, hasApprovalId: false, promptShaPrefix: null });
  });

  it("unknown, revoked, expired (JST day), missing or mismatched images hide the whole version", () => {
    const cases: Array<[DemoImageDb | null, Partial<VersionFileDb>, string]> = [
      [image(1, { rights_status: "unknown" }), {}, "unknown"],
      [image(1, { revoked_at: "2026-11-10T00:00:00Z", rights_status: "revoked" }), {}, "revoked"],
      [image(1, { rights_expiry: "2026-11-10" }), {}, "expired"],
      [image(1, { rights_status: "something_new" }), {}, "unknown"],
      [null, {}, "unknown"],
      [image(1), { sha256: h("d") }, "unknown"],
    ];
    for (const [img, over, status] of cases) {
      const v = withPhoto(img, over);
      expect(v.previewable, status).toBe(false);
      expect(v.images[0]!.rightsStatus).toBe(status);
      expect(v.images[0]!.rightsLabel).toBe(RIGHTS_BLOCKED_LABEL);
      expect(v.images[0]!.needsImpersonationConfirm).toBe(false);
      expect(v.reviewBlockers).toContain("RIGHTS_NOT_PREVIEWABLE");
    }
  });

  it("rights expire after their last JST day, not before", () => {
    expect(effectiveRights(image(1, { rights_expiry: "2026-11-11" }), NOW).previewable).toBe(true);
    // 2026-11-11T15:00Z is already 2026-11-12 in Tokyo
    expect(effectiveRights(image(1, { rights_expiry: "2026-11-11" }), new Date("2026-11-11T15:00:00Z"))).toEqual({ status: "expired", previewable: false });
    expect(effectiveRights(image(1, { rights_expiry: "11/12/2026" }), NOW)).toEqual({ status: "expired", previewable: false });
  });

  it("a human photo with internal rights: no AI badge, no confirmation, still unshareable today", () => {
    const v = withPhoto(image(1, { source_kind: "owner_provided", rights_status: "owner_provided_internal", provenance: null }));
    expect(v.images[0]).toMatchObject({ aiConcept: false, aiBadge: null, needsImpersonationConfirm: false, adminLabel: null, provenance: null });
    expect(v.unshareableReasons).toEqual(["versioned_sharing_disabled", "photos_not_shareable"]);
  });

  it("a version with zero photos is still unshareable while versioned sharing is off", () => {
    expect(VERSIONED_SHARING_ENABLED).toBe(false);
    expect(unshareableReasons([])).toEqual(["versioned_sharing_disabled"]);
  });
});

describe("buildDemoVersionsView: reviews, approval and the send warning (Low d)", () => {
  const review = (over: Partial<QualityReviewDb>): QualityReviewDb => ({
    id: id(700),
    version_id: id(1),
    decision: "approved",
    state: "active",
    checklist: { identity_lock: "ok", facts_confirmed: "ok", shop_specific_structure: "ok", no_generic_lp_regression: "ok", full_page_information: "ok", photos_truthful: "ok", not_a_copy: "ok", extra: "ok" },
    viewed_renders_sha256: {},
    reviewed_at: "2026-11-10T01:00:00Z",
    withdrawn_at: null,
    invalidated_at: null,
    invalidated_reason: null,
    ...over,
  });

  it("finds the active approval and sorts history newest first", () => {
    const view = build({
      versions: [version(1, { status: "approved" })],
      approvedVersionId: id(1),
      reviews: [review({ id: id(701), decision: "changes_requested", reviewed_at: "2026-11-09T00:00:00Z" }), review({})],
    });
    const v = view.versions[0]!;
    expect(v.activeApproval?.id).toBe(id(700));
    expect(v.reviews.map((r) => r.id)).toEqual([id(700), id(701)]);
    expect(Object.keys(v.activeApproval!.checklist)).toHaveLength(7);
  });

  it("an approved version stops sending (demo_not_shareable) and says why; no approved version → React demo as before", () => {
    expect(build().sendStoppedBy).toBeNull();
    expect(build({ versions: [version(1, { status: "approved" })], approvedVersionId: id(1) }).sendStoppedBy).toEqual(["versioned_sharing_disabled"]);
    // an approved id that is not among this demo's rows still blocks in the database
    expect(build({ approvedVersionId: id(77) }).sendStoppedBy).toEqual(["versioned_sharing_disabled"]);
  });

  it("orders versions newest first and links parents", () => {
    const view = build({ versions: [version(1), version(2, { parent_version_id: id(1) }), version(3, { parent_version_id: id(66) })], files: [] });
    expect(view.versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
    expect(view.versions[1]).toMatchObject({ parentVersionNo: 1, parentMissing: false });
    expect(view.versions[0]).toMatchObject({ parentVersionNo: null, parentMissing: true });
    expect(view.versions.every((v) => v.approveBlockers.includes("RENDER_MISSING"))).toBe(true);
  });

  it("revocable only in draft / approved / superseded", () => {
    for (const [status, ok] of [["draft", true], ["approved", true], ["superseded", true], ["revoked", false], ["uploading", false], ["rejected", false], ["expired", false]] as const) {
      expect(build({ versions: [version(1, { status })] }).versions[0]!.revocable, status).toBe(ok);
    }
  });
});

describe("lineage", () => {
  it("lists roots by number, each followed by its descendants", () => {
    const rows = [
      { id: "a", version_no: 1, parent_version_id: null },
      { id: "b", version_no: 2, parent_version_id: "a" },
      { id: "c", version_no: 3, parent_version_id: null },
      { id: "d", version_no: 4, parent_version_id: "b" },
      { id: "e", version_no: 5, parent_version_id: "a" },
    ];
    expect(lineage(rows).map((n) => `${n.versionNo}@${n.depth}`)).toEqual(["1@0", "2@1", "4@2", "5@1", "3@0"]);
  });

  it("never drops a row: a missing parent is a root, a cycle is listed flat", () => {
    const rows = [
      { id: "a", version_no: 1, parent_version_id: "z" },
      { id: "b", version_no: 2, parent_version_id: "c" },
      { id: "c", version_no: 3, parent_version_id: "b" },
    ];
    expect(lineage(rows).map((n) => `${n.versionNo}@${n.depth}`)).toEqual(["1@0", "2@0", "3@0"]);
  });
});
