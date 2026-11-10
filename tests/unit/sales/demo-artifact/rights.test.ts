import { describe, expect, it } from "vitest";
import { ADMIN_RIGHTS_LABELS, deriveImageRights, deriveVersionRights, isShareableStatus, RIGHTS_STATUSES, SHARE_PHOTOS_ENABLED } from "@/lib/sales/demo-artifact/rights";

const NOW = new Date("2026-11-10T03:00:00Z"); // 12:00 JST
const provenance = {
  generator: "image tool (test fixture)",
  model: "fixture-model",
  generated_at: "2026-11-01T00:00:00Z",
  prompt_sha256: "c".repeat(64),
  approval_id: "approval-test-0001",
  demo_only: true,
};
const photo = (o: Record<string, unknown> = {}) => ({
  source_kind: "owner_provided",
  depicts_real_shop: false,
  depicts_identifiable_person: false,
  depicts_real_product: false,
  depicts_real_interior: false,
  depicts_real_equipment: false,
  allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
  paid: false,
  terms_sha256: null,
  client_confirmed_at: null,
  received_at: "2026-10-01",
  rights_expiry: null,
  provenance: null,
  no_factual_impersonation_confirmed_at: null,
  owner_ai_share_decision_at: null,
  revoked_at: null,
  ...o,
});
const aiConcept = (o: Record<string, unknown> = {}) => photo({ source_kind: "ai_concept_internal", provenance, received_at: null, no_factual_impersonation_confirmed_at: "2026-11-02T00:00:00Z", ...o });
const aiDemo = (o: Record<string, unknown> = {}) => photo({ source_kind: "ai_generated_demo", provenance, received_at: null, ...o });
const real = (r: unknown) => deriveImageRights(r, { shopKind: "real", now: NOW });
const fictional = (r: unknown) => deriveImageRights(r, { shopKind: "fictional", now: NOW });

describe("rights status (§8.1, fail closed)", () => {
  it("is unknown for anything malformed or missing", () => {
    for (const bad of [null, undefined, {}, "x", photo({ extra: 1 }), photo({ source_kind: "web_download" }), photo({ allowed_uses: { edit: true } }), photo({ depicts_real_product: undefined }), photo({ owner_ai_share_decision_at: "2026-11-01T00:00:00Z" })]) {
      const r = real(bad);
      expect(r.status).toBe("unknown");
      expect(r.adminPreview).toBe(false);
      expect(r.shareable).toBe(false);
    }
    expect(deriveImageRights(photo(), { shopKind: "other" as "real", now: NOW }).status).toBe("unknown");
  });

  it("derives the internal statuses of human photos", () => {
    expect(real(photo()).status).toBe("owner_provided_internal");
    expect(real(photo({ source_kind: "shop_provided" })).status).toBe("shop_provided_internal");
    expect(real(photo({ source_kind: "licensed_stock_with_terms", terms_sha256: "d".repeat(64) })).status).toBe("licensed_terms_pinned_internal");
    expect(real(photo({ source_kind: "licensed_stock_with_terms" })).reasons).toContain("TERMS_NOT_PINNED");
    expect(real(photo({ received_at: null })).status).toBe("unknown");
  });

  it("refuses paid, restricted, identifiable-person and AI-provenance-on-human records", () => {
    expect(real(photo({ paid: true })).reasons).toContain("PAID_SOURCE");
    expect(real(photo({ allowed_uses: { edit: true, crop: false, commercial: true, public_web: true } })).reasons).toContain("USE_NOT_ALLOWED");
    expect(real(photo({ depicts_identifiable_person: true })).reasons).toContain("IDENTIFIABLE_PERSON");
    expect(real(photo({ provenance })).reasons).toContain("PROVENANCE_ON_NON_AI");
    expect(real(photo({ received_at: "2026-11-11" })).reasons).toContain("DATE_IN_FUTURE");
  });

  it("derives share_cleared but does not share it yet (MVP_SPEC §7: no photos on share URLs)", () => {
    const r = real(photo({ allowed_uses: { edit: true, crop: true, commercial: true, public_web: true }, client_confirmed_at: "2026-10-02T00:00:00Z" }));
    expect(r.status).toBe("share_cleared");
    expect(r.adminPreview).toBe(true);
    expect(SHARE_PHOTOS_ENABLED).toBe(false);
    expect(r.shareable).toBe(false);
  });

  it("expires on the JST calendar day after rights_expiry, and revocation wins", () => {
    expect(real(photo({ rights_expiry: "2026-11-10" })).status).toBe("owner_provided_internal");
    expect(real(photo({ rights_expiry: "2026-11-09" })).status).toBe("expired");
    // 2026-11-09T15:00Z is already 11-10 in JST
    expect(deriveImageRights(photo({ rights_expiry: "2026-11-09" }), { shopKind: "real", now: new Date("2026-11-09T15:00:00Z") }).status).toBe("expired");
    expect(deriveImageRights(photo({ rights_expiry: "2026-11-09" }), { shopKind: "real", now: new Date("2026-11-09T14:59:59Z") }).status).toBe("owner_provided_internal");
    expect(real(photo({ revoked_at: "2026-11-05T00:00:00Z", rights_expiry: "2026-01-01" })).status).toBe("revoked");
    for (const s of ["expired", "revoked"] as const) expect(isShareableStatus(s)).toBe(false);
  });
});

describe("AI images (§8.3・T21, owner decision 2026-11-10)", () => {
  it("ai_concept_internal: a real shop's admin-only concept image with provenance, no real depiction and the owner's confirmation", () => {
    const r = real(aiConcept());
    expect(r).toEqual({ status: "ai_concept_internal", reasons: [], adminPreview: true, shareable: false, adminLabel: ADMIN_RIGHTS_LABELS.ai_concept_internal, aiGenerated: true });
    expect(r.adminLabel).toContain("AI 生成");
  });

  it.each([
    ["no provenance", { provenance: null }, "PROVENANCE_MISSING"],
    ["provenance with unknown model", { provenance: { ...provenance, model: "unknown" } }, "RECORD_INVALID"],
    ["depicts a real product", { depicts_real_product: true }, "DEPICTS_REAL"],
    ["depicts the real interior", { depicts_real_interior: true }, "DEPICTS_REAL"],
    ["depicts real equipment", { depicts_real_equipment: true }, "DEPICTS_REAL"],
    ["depicts the real shop", { depicts_real_shop: true }, "DEPICTS_REAL"],
    ["depicts a person", { depicts_identifiable_person: true }, "IDENTIFIABLE_PERSON"],
    ["no owner confirmation", { no_factual_impersonation_confirmed_at: null }, "IMPERSONATION_NOT_CONFIRMED"],
    ["generated in the future", { provenance: { ...provenance, generated_at: "2026-12-01T00:00:00Z" } }, "DATE_IN_FUTURE"],
  ])("ai_concept_internal with %s is unknown", (_n, o, reason) => {
    const r = real(aiConcept(o));
    expect(r.status).toBe("unknown");
    expect(r.adminPreview).toBe(false);
    if (reason !== "RECORD_INVALID") expect(r.reasons).toContain(reason);
  });

  it("keeps the two AI kinds apart: concept only for real shops, demo only for fictional shops", () => {
    expect(fictional(aiConcept()).reasons).toContain("AI_KIND_WRONG_SHOP");
    expect(real(aiDemo()).reasons).toContain("AI_KIND_WRONG_SHOP");
    const r = fictional(aiDemo());
    expect(r.status).toBe("ai_demo_internal");
    expect(r.adminLabel).toBe(ADMIN_RIGHTS_LABELS.ai_demo_internal);
    expect(r.shareable).toBe(false);
  });

  it("never shares an AI status, whatever the flags", () => {
    for (const s of ["ai_demo_internal", "ai_concept_internal", "ai_share_approved"] as const) expect(isShareableStatus(s)).toBe(false);
    expect(real(aiConcept({ allowed_uses: { edit: true, crop: true, commercial: true, public_web: true }, client_confirmed_at: "2026-11-02T00:00:00Z" })).shareable).toBe(false);
  });

  it("never derives the reserved ai_share_approved", () => {
    const derived = new Set([photo(), aiConcept(), aiDemo()].flatMap((r) => [real(r).status, fictional(r).status]));
    expect(derived.has("ai_share_approved")).toBe(false);
    expect(RIGHTS_STATUSES).toContain("ai_share_approved");
  });
});

describe("version rights (§8.4)", () => {
  it("is share-eligible only with zero photos today", () => {
    expect(deriveVersionRights([], { shopKind: "real", now: NOW })).toMatchObject({ shareEligible: true, adminPreviewAllowed: true, summary: { version: 1, photos: 0, by_status: {}, earliest_expiry: null, label_required: false } });
    const cleared = photo({ allowed_uses: { edit: true, crop: true, commercial: true, public_web: true }, client_confirmed_at: "2026-10-02T00:00:00Z" });
    expect(deriveVersionRights([cleared], { shopKind: "real", now: NOW }).shareEligible).toBe(false);
  });

  it("summarises statuses, the earliest expiry and the label requirement", () => {
    const v = deriveVersionRights([photo({ rights_expiry: "2027-01-01" }), aiConcept({ rights_expiry: "2026-12-01" })], { shopKind: "real", now: NOW });
    expect(v.summary).toEqual({ version: 1, photos: 2, by_status: { owner_provided_internal: 1, ai_concept_internal: 1 }, earliest_expiry: "2026-12-01", label_required: true });
    expect(v.adminPreviewAllowed).toBe(true);
    expect(v.shareEligible).toBe(false);
  });

  it("is not previewable when any image is unknown, expired or revoked (fail closed, no holes)", () => {
    for (const bad of [{}, photo({ rights_expiry: "2026-01-01" }), photo({ revoked_at: "2026-11-01T00:00:00Z" })]) {
      expect(deriveVersionRights([photo(), bad], { shopKind: "real", now: NOW }).adminPreviewAllowed).toBe(false);
    }
  });
});
