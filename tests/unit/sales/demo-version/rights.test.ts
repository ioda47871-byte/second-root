import { describe, expect, it } from "vitest";
import { checkPhotoRights, type PhotoBytesInfo } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { AI_CONCEPT_ADMIN_LABEL, checkAiConceptRights } from "@/lib/sales/demo-version/ai-concept-rights";
import { ADMIN_RIGHTS_LABELS, deriveRightsStatus, deriveVersionRights, isShareableStatus, RIGHTS_STATUSES, SHARE_PHOTOS_ENABLED, shareEligible, type ImageRightsInput, type RightsContext } from "@/lib/sales/demo-version/rights";

const NOW = new Date("2026-11-10T03:00:00Z"); // 12:00 JST
const PROSPECT = "12345678-1234-4234-8234-123456789abc";
const OWNER = "87654321-1234-4234-8234-123456789abc";
const SHA = "e".repeat(64);
const bytes: PhotoBytesInfo = { sha256: SHA, bytes: 1000, width: 800, height: 600, format: "webp", orientation: 1 };
const NONE = new Set<string>();

// ---- photo_rights_v0 (human photos, licensed material, fictional AI demo pictures) ----
const photo = (o: Record<string, unknown> = {}) => ({
  schema: "photo_rights_v0",
  asset_id: "photo-test-1",
  sha256: SHA,
  bytes: 1000,
  width: 800,
  height: 600,
  format: "webp",
  source_kind: "owner_provided",
  owner: "Example Owner",
  license: "written permission (example)",
  paid: false,
  allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
  consent_record_ref: "consent-example-1",
  received_at: "2026-10-01",
  expiry: null,
  private_path: ".intake/photos/test-1.webp",
  depicts_identifiable_person: false,
  depicts_real_shop: false,
  ...o,
});
const demoProvenance = { generator: "image tool (test fixture)", model: "fixture-model", generated_at: "2026-11-01T00:00:00Z", prompt_sha256: "c".repeat(64), approval_id: "approval-test-0001", demo_only: true };

// ---- ai_concept_rights_v0 (a real shop's admin-only concept image) ----
const concept = (o: Record<string, unknown> = {}) => ({
  schema: "ai_concept_rights_v0",
  source_kind: "ai_concept_internal",
  sha256: SHA,
  bytes: 1000,
  width: 800,
  height: 600,
  format: "webp",
  provenance: { generator: "image tool (test fixture)", model: "fixture-model", generated_at: "2026-11-01T00:00:00Z", prompt_sha256: "c".repeat(64), approval_id: "approval-test-0002", admin_preview_only: true },
  depicts_real_product: false,
  depicts_real_interior: false,
  depicts_identifiable_person: false,
  depicts_real_equipment: false,
  depicts_real_shop: false,
  no_factual_impersonation_confirmed_at: "2026-11-02T00:00:00Z",
  no_factual_impersonation_confirmed_by: OWNER,
  admin_label: AI_CONCEPT_ADMIN_LABEL,
  prospect_id: PROSPECT,
  ...o,
});

const real: RightsContext = { shopKind: "real", prospectId: PROSPECT, aiDemoAllowed: false, forbiddenSha256: NONE, now: NOW };
const fictional: RightsContext = { ...real, shopKind: "fictional", aiDemoAllowed: true };
const P = (record: unknown, o: Partial<ImageRightsInput> = {}): ImageRightsInput => ({ record_schema: "photo_rights_v0", record, bytesInfo: bytes, revokedAt: null, ...o }) as ImageRightsInput;
const C = (record: unknown, o: Partial<ImageRightsInput> = {}): ImageRightsInput => ({ record_schema: "ai_concept_rights_v0", record, bytesInfo: bytes, revokedAt: null, ...o }) as ImageRightsInput;

describe("photo_rights_v0 through checkPhotoRights (§8.1)", () => {
  it("derives the internal statuses", () => {
    expect(deriveRightsStatus(P(photo()), real).status).toBe("owner_provided_internal");
    expect(deriveRightsStatus(P(photo({ source_kind: "shop_provided" })), real).status).toBe("shop_provided_internal");
    expect(deriveRightsStatus(P(photo({ source_kind: "licensed_stock_with_terms", terms_sha256: "d".repeat(64) })), real).status).toBe("licensed_terms_pinned_internal");
  });

  it("derives share_cleared from the public_site check, but does not share it yet", () => {
    const r = deriveRightsStatus(P(photo({ allowed_uses: { edit: true, crop: true, commercial: true, public_web: true }, client_confirmation_ref: "confirm-example" })), real);
    expect(r.status).toBe("share_cleared");
    expect(r.adminPreview).toBe(true);
    expect(SHARE_PHOTOS_ENABLED).toBe(false);
    expect(isShareableStatus("share_cleared")).toBe(false);
  });

  it("is unknown for malformed, paid, restricted, person, forbidden-hash or mismatched records (fail closed)", () => {
    for (const rec of [null, {}, photo({ extra: 1 }), photo({ paid: true }), photo({ allowed_uses: { edit: true, crop: false, commercial: true, public_web: false } }), photo({ depicts_identifiable_person: true }), photo({ source_kind: "licensed_stock_with_terms" })]) {
      const r = deriveRightsStatus(P(rec), real);
      expect(r.status).toBe("unknown");
      expect(r.adminPreview).toBe(false);
    }
    expect(deriveRightsStatus(P(photo()), { ...real, forbiddenSha256: new Set([SHA]) }).codes).toContain("FORBIDDEN_SOURCE_HASH");
    expect(deriveRightsStatus(P(photo(), { bytesInfo: { ...bytes, sha256: "f".repeat(64) } }), real).status).toBe("unknown");
    expect(deriveRightsStatus(P(photo(), { bytesInfo: null }), real).status).toBe("unknown");
  });

  it("expires after the last JST day; revocation wins", () => {
    expect(deriveRightsStatus(P(photo({ expiry: "2026-11-10" })), real).status).toBe("owner_provided_internal");
    expect(deriveRightsStatus(P(photo({ expiry: "2026-11-09" })), real).status).toBe("expired");
    // 2026-11-09T15:00Z is already 11-10 in Tokyo; 14:59:59Z is still 11-09
    expect(deriveRightsStatus(P(photo({ expiry: "2026-11-09" })), { ...real, now: new Date("2026-11-09T15:00:00Z") }).status).toBe("expired");
    expect(deriveRightsStatus(P(photo({ expiry: "2026-11-09" })), { ...real, now: new Date("2026-11-09T14:59:59Z") }).status).toBe("owner_provided_internal");
    expect(deriveRightsStatus(P(photo({ expiry: "2026-01-01" }), { revokedAt: new Date("2026-11-01T00:00:00Z") }), real).status).toBe("revoked");
  });

  it("fictional AI demo pictures: ai_demo_internal only for a listed fictional shop; never for a real shop", () => {
    const rec = photo({ source_kind: "ai_generated_demo", ai_provenance: demoProvenance });
    const f = deriveRightsStatus(P(rec), fictional);
    expect(f.status).toBe("ai_demo_internal");
    expect(f.adminLabel).toBe(ADMIN_RIGHTS_LABELS.ai_demo_internal);
    expect(deriveRightsStatus(P(rec), { ...fictional, aiDemoAllowed: false }).codes).toContain("AI_DEMO_NOT_ALLOWED");
    // a real shop never passes aiDemoAllowed, even if the caller asks
    expect(deriveRightsStatus(P(rec), { ...real, aiDemoAllowed: true }).status).toBe("unknown");
  });
});

describe("ai_concept_internal (§8.3.1, its own record and check)", () => {
  it("passes only with every condition, and carries the fixed admin label", () => {
    expect(checkAiConceptRights(concept(), bytes, { forbiddenSha256: NONE, prospectId: PROSPECT, now: NOW })).toEqual({ status: "ai_concept_internal", adminLabel: AI_CONCEPT_ADMIN_LABEL });
    const r = deriveRightsStatus(C(concept()), real);
    expect(r).toEqual({ status: "ai_concept_internal", codes: [], adminPreview: true, adminLabel: AI_CONCEPT_ADMIN_LABEL });
  });

  it("is unknown through checkPhotoRights (the research path never accepts it)", () => {
    expect(checkPhotoRights(concept(), bytes, { forbiddenSha256: NONE, now: "2026-11-10", aiDemoAllowed: true }).ok).toBe(false);
    expect(deriveRightsStatus(P(concept()), real).status).toBe("unknown");
  });

  it.each([
    ["depicts a real product", { depicts_real_product: true }, "DEPICTS_REAL"],
    ["depicts the real interior", { depicts_real_interior: true }, "DEPICTS_REAL"],
    ["depicts a person", { depicts_identifiable_person: true }, "DEPICTS_REAL"],
    ["depicts real equipment", { depicts_real_equipment: true }, "DEPICTS_REAL"],
    ["depicts the real shop", { depicts_real_shop: true }, "DEPICTS_REAL"],
    ["a missing depicts flag", { depicts_real_product: undefined }, "DEPICTS_REAL"],
    ["no owner confirmation", { no_factual_impersonation_confirmed_at: null }, "IMPERSONATION_NOT_CONFIRMED"],
    ["a confirmation before the image existed", { no_factual_impersonation_confirmed_at: "2026-10-01T00:00:00Z" }, "IMPERSONATION_NOT_CONFIRMED"],
    ["a different label", { admin_label: "AI image" }, "ADMIN_LABEL_MISMATCH"],
    ["no provenance", { provenance: undefined }, "PROVENANCE_MISSING"],
    ["provenance with an unknown model", { provenance: { ...concept().provenance, model: "unknown" } }, "PROVENANCE_MISSING"],
    ["provenance marked demo_only instead of admin_preview_only", { provenance: { ...demoProvenance } }, "PROVENANCE_MISSING"],
    ["another prospect", { prospect_id: "00000000-1234-4234-8234-123456789abc" }, "PROSPECT_MISMATCH"],
    ["an unknown key", { public_web: true }, "SCHEMA_INVALID"],
    ["generated in the future", { provenance: { ...concept().provenance, generated_at: "2026-12-01T00:00:00Z" }, no_factual_impersonation_confirmed_at: "2026-12-02T00:00:00Z" }, "DATE_IN_FUTURE"],
  ])("with %s → unknown", (_n, o, code) => {
    const r = deriveRightsStatus(C(concept(o)), real);
    expect(r.status).toBe("unknown");
    expect(r.adminPreview).toBe(false);
    expect(r.codes).toContain(code);
  });

  it("checks the bytes and the forbidden hashes", () => {
    expect(deriveRightsStatus(C(concept(), { bytesInfo: { ...bytes, width: 801 } }), real).codes).toContain("DIMENSION_MISMATCH");
    expect(deriveRightsStatus(C(concept()), { ...real, forbiddenSha256: new Set([SHA]) }).codes).toContain("FORBIDDEN_SOURCE_HASH");
    expect(deriveRightsStatus(C(concept(), { bytesInfo: null }), real).status).toBe("unknown");
  });

  it("is only for real shops", () => {
    expect(deriveRightsStatus(C(concept()), fictional)).toMatchObject({ status: "unknown", codes: ["WRONG_SHOP_KIND"] });
  });

  it("has no share field in its result", () => {
    const r = checkAiConceptRights(concept(), bytes, { forbiddenSha256: NONE, prospectId: PROSPECT, now: NOW });
    expect(Object.keys(r).sort()).toEqual(["adminLabel", "status"]);
  });
});

describe("share eligibility (§8.3: never AI, no photos today)", () => {
  it("is true only with zero photos", () => {
    expect(shareEligible([])).toBe(true);
    for (const s of RIGHTS_STATUSES) expect(shareEligible([s])).toBe(false);
  });
  it("is false whenever an ai_concept_internal image is present", () => {
    expect(shareEligible(["ai_concept_internal"])).toBe(false);
    expect(shareEligible(["share_cleared", "ai_concept_internal"])).toBe(false);
    for (const s of ["ai_demo_internal", "ai_concept_internal", "ai_share_approved"] as const) expect(isShareableStatus(s)).toBe(false);
  });
  it("never derives the reserved ai_share_approved", () => {
    const seen = [P(photo()), P(photo({ source_kind: "ai_generated_demo", ai_provenance: demoProvenance })), C(concept())].flatMap((i) => [deriveRightsStatus(i, real).status, deriveRightsStatus(i, fictional).status]);
    expect(seen).not.toContain("ai_share_approved");
  });
});

describe("version rights (§8.4)", () => {
  it("summarises and keeps the version admin-only with an AI concept image", () => {
    const v = deriveVersionRights([{ ...P(photo()), expiry: "2027-01-01" }, { ...C(concept()), expiry: "2026-12-01" }], real);
    expect(v.summary).toEqual({ version: 1, photos: 2, by_status: { owner_provided_internal: 1, ai_concept_internal: 1 }, earliest_expiry: "2026-12-01", label_required: true });
    expect(v.adminPreviewAllowed).toBe(true);
    expect(v.shareEligible).toBe(false);
  });
  it("is not previewable when any image is unknown, expired or revoked (no holes)", () => {
    for (const bad of [P({}), P(photo({ expiry: "2026-01-01" })), P(photo(), { revokedAt: NOW })]) expect(deriveVersionRights([P(photo()), bad], real).adminPreviewAllowed).toBe(false);
  });
  it("is share-eligible with zero photos", () => {
    expect(deriveVersionRights([], real)).toMatchObject({ shareEligible: true, adminPreviewAllowed: true, summary: { photos: 0, label_required: false } });
  });
});
