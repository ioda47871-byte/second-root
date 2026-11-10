/**
 * DEV-196b (spec §8・T6・T21, owner decision 2026-11-10): the rights status of each image of a demo version, derived
 * (never chosen by hand) from its DB record (§4.3 `sales_demo_images`), and the version's rights summary and share
 * eligibility. Fail closed throughout: a missing, malformed or contradictory record is `unknown`, and `unknown` is
 * neither previewable nor shareable.
 *
 * Two kinds of AI image, kept apart:
 *  - `ai_generated_demo` (fictional research shops, SR-001「輪」・つぐ手): → `ai_demo_internal`. The existing
 *    checkPhotoRights / AI_DEMO_SHOPS path for the research pages is not touched by this module.
 *  - `ai_concept_internal` (a REAL shop's admin-only design study): its own check here. It needs recorded provenance,
 *    every `depicts_real_*` flag false, the owner's no-impersonation confirmation, and it always carries the admin
 *    「AI生成」label. It is admin-preview only and NEVER shareable.
 * No AI image is ever shareable: `ai_share_approved` is reserved and this module never returns it.
 *
 * Today no photo of any kind may appear on a share URL (MVP_SPEC §7, PUBLIC_DEMO_ASSETS_ENABLED = false): a version is
 * share-eligible only with zero photos. `share_cleared` is derived (for the admin view) but not yet honoured.
 *
 * Pure: the caller passes the records and the time. Dates are compared as Asia/Tokyo calendar days.
 */
import { z } from "zod";
import { AiProvenance, isIsoDate } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { jstDate } from "@/lib/sales/dates";

export const RIGHTS_STATUSES = [
  "unknown",
  "ai_demo_internal",
  "ai_concept_internal",
  "owner_provided_internal",
  "shop_provided_internal",
  "licensed_terms_pinned_internal",
  "share_cleared",
  "ai_share_approved",
  "expired",
  "revoked",
] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

export const IMAGE_SOURCE_KINDS = ["owner_provided", "shop_provided", "licensed_stock_with_terms", "ai_generated_demo", "ai_concept_internal"] as const;

/** §8.1: statuses whose image the admin preview may show (anything else rejects the whole version). */
export const ADMIN_PREVIEW_STATUSES: readonly RightsStatus[] = ["ai_demo_internal", "ai_concept_internal", "owner_provided_internal", "shop_provided_internal", "licensed_terms_pinned_internal", "share_cleared", "ai_share_approved"];

/**
 * Whether photos may appear on a share URL at all. false until DEV-196a changes MVP_SPEC §7 (Protected Scope, owner
 * approval). A literal, not an option: no caller can switch it on.
 */
export const SHARE_PHOTOS_ENABLED = false as const;

/** §8.1: the fixed admin labels (shown by the trusted outer frame, never left to the artifact's HTML). */
export const ADMIN_RIGHTS_LABELS: Partial<Record<RightsStatus, string>> = {
  ai_demo_internal: "AI 生成のデモ画像を含む (デモ専用・共有不可)",
  ai_concept_internal: "AI 生成の概念画像 (実在の商品・店内・人・設備ではありません。共有不可)",
};

const IsoDate = z.string().refine(isIsoDate, "INVALID_DATE");
const Timestamp = z.string().refine((s) => isIsoDate(s) && s.length > 10, "INVALID_DATE");

/** §4.3, as the server reads it for one image. Strict: an unknown key is a malformed record (→ unknown). */
export const DemoImageRightsRecord = z.strictObject({
  source_kind: z.enum(IMAGE_SOURCE_KINDS),
  depicts_real_shop: z.boolean(),
  depicts_identifiable_person: z.boolean(),
  depicts_real_product: z.boolean(),
  depicts_real_interior: z.boolean(),
  depicts_real_equipment: z.boolean(),
  allowed_uses: z.strictObject({ edit: z.boolean(), crop: z.boolean(), commercial: z.boolean(), public_web: z.boolean() }),
  paid: z.boolean(),
  terms_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  client_confirmed_at: Timestamp.nullable(),
  received_at: IsoDate.nullable(),
  rights_expiry: IsoDate.nullable(),
  /** AI images only: how it was made (§8.2). Required for both AI kinds, absent for the others. */
  provenance: AiProvenance.nullable(),
  /** the owner's per-image confirmation that it impersonates no real product, interior, person or equipment */
  no_factual_impersonation_confirmed_at: Timestamp.nullable(),
  /** reserved; must be null (an AI share decision needs a spec change first) */
  owner_ai_share_decision_at: z.null(),
  revoked_at: Timestamp.nullable(),
});
export type DemoImageRightsRecord = z.infer<typeof DemoImageRightsRecord>;

export type RightsReason =
  | "RECORD_INVALID"
  | "REVOKED"
  | "EXPIRED"
  | "DATE_IN_FUTURE"
  | "PAID_SOURCE"
  | "USE_NOT_ALLOWED"
  | "IDENTIFIABLE_PERSON"
  | "TERMS_NOT_PINNED"
  | "PROVENANCE_MISSING"
  | "PROVENANCE_ON_NON_AI"
  | "AI_KIND_WRONG_SHOP"
  | "DEPICTS_REAL"
  | "IMPERSONATION_NOT_CONFIRMED";

export type ImageRights = {
  status: RightsStatus;
  reasons: RightsReason[];
  adminPreview: boolean;
  /** whether this image could be on a share URL (always false today, see SHARE_PHOTOS_ENABLED) */
  shareable: boolean;
  /** the fixed label the admin frame must show beside the image, or null */
  adminLabel: string | null;
  aiGenerated: boolean;
};

export type ShopKind = "fictional" | "real";

const result = (status: RightsStatus, reasons: RightsReason[] = [], aiGenerated = false): ImageRights => ({
  status,
  reasons,
  adminPreview: ADMIN_PREVIEW_STATUSES.includes(status),
  shareable: isShareableStatus(status),
  adminLabel: ADMIN_RIGHTS_LABELS[status] ?? null,
  aiGenerated,
});

/** §8.1・§8.3: whether a status may be shared. AI statuses never; share_cleared only once photos may be shared. */
export function isShareableStatus(status: RightsStatus): boolean {
  if (status === "ai_demo_internal" || status === "ai_concept_internal" || status === "ai_share_approved") return false;
  return status === "share_cleared" && (SHARE_PHOTOS_ENABLED as boolean);
}

/** The rights status of one image for a shop (fictional research shop or real prospect), at `now` (JST days). */
export function deriveImageRights(raw: unknown, o: { shopKind: ShopKind; now: Date }): ImageRights {
  if (o.shopKind !== "fictional" && o.shopKind !== "real") return result("unknown", ["RECORD_INVALID"]);
  const parsed = DemoImageRightsRecord.safeParse(raw);
  if (!parsed.success) return result("unknown", ["RECORD_INVALID"]);
  const r = parsed.data;
  const ai = r.source_kind === "ai_generated_demo" || r.source_kind === "ai_concept_internal";
  const today = jstDate(o.now);
  const day = (s: string) => (s.length === 10 ? s : jstDate(new Date(s)));
  if (r.revoked_at !== null) return result("revoked", ["REVOKED"], ai);
  if (r.rights_expiry !== null && day(r.rights_expiry) < today) return result("expired", ["EXPIRED"], ai);

  const reasons: RightsReason[] = [];
  if (r.paid) reasons.push("PAID_SOURCE");
  if (!r.allowed_uses.edit || !r.allowed_uses.crop || !r.allowed_uses.commercial) reasons.push("USE_NOT_ALLOWED");
  if (r.depicts_identifiable_person) reasons.push("IDENTIFIABLE_PERSON");
  for (const d of [r.received_at, r.client_confirmed_at, r.no_factual_impersonation_confirmed_at, r.provenance?.generated_at ?? null]) {
    if (d !== null && day(d) > today) reasons.push("DATE_IN_FUTURE");
  }

  if (ai) {
    if (r.provenance === null) reasons.push("PROVENANCE_MISSING");
    if (r.source_kind === "ai_generated_demo") {
      // the research kind is for fictional shops only
      if (o.shopKind !== "fictional") reasons.push("AI_KIND_WRONG_SHOP");
      if (r.depicts_real_shop) reasons.push("DEPICTS_REAL");
      return reasons.length ? result("unknown", uniq(reasons), true) : result("ai_demo_internal", [], true);
    }
    // ai_concept_internal: a real shop's admin-only concept image (§8.3 conditions 1–3)
    if (o.shopKind !== "real") reasons.push("AI_KIND_WRONG_SHOP");
    if (r.depicts_real_shop || r.depicts_real_product || r.depicts_real_interior || r.depicts_real_equipment) reasons.push("DEPICTS_REAL");
    if (r.no_factual_impersonation_confirmed_at === null) reasons.push("IMPERSONATION_NOT_CONFIRMED");
    return reasons.length ? result("unknown", uniq(reasons), true) : result("ai_concept_internal", [], true);
  }

  if (r.provenance !== null) reasons.push("PROVENANCE_ON_NON_AI");
  if (r.received_at === null) reasons.push("RECORD_INVALID");
  if (r.source_kind === "licensed_stock_with_terms" && r.terms_sha256 === null) reasons.push("TERMS_NOT_PINNED");
  if (reasons.length) return result("unknown", uniq(reasons));
  if (r.allowed_uses.public_web && r.client_confirmed_at !== null) return result("share_cleared");
  return result(r.source_kind === "owner_provided" ? "owner_provided_internal" : r.source_kind === "shop_provided" ? "shop_provided_internal" : "licensed_terms_pinned_internal");
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** §8.4 `rights_summary`: fixed keys only. */
export type RightsSummary = {
  version: 1;
  photos: number;
  by_status: Partial<Record<RightsStatus, number>>;
  earliest_expiry: string | null;
  label_required: boolean;
};

export type VersionRights = {
  summary: RightsSummary;
  /** every image may be shown in the admin preview (otherwise the version is rejected / not shown) */
  adminPreviewAllowed: boolean;
  /** §8.3: may this version be on a share URL. Today: only with zero photos. Re-derive on every request. */
  shareEligible: boolean;
  images: ImageRights[];
};

/** The version's rights from its images' records, at `now`. Re-run on every send guard and every share request. */
export function deriveVersionRights(records: readonly unknown[], o: { shopKind: ShopKind; now: Date }): VersionRights {
  const images = records.map((r) => deriveImageRights(r, o));
  const by_status: Partial<Record<RightsStatus, number>> = {};
  for (const i of images) by_status[i.status] = (by_status[i.status] ?? 0) + 1;
  let earliest: string | null = null;
  for (const r of records) {
    const p = DemoImageRightsRecord.safeParse(r);
    const e = p.success ? p.data.rights_expiry : null;
    if (e !== null && (earliest === null || e < earliest)) earliest = e;
  }
  return {
    summary: { version: 1, photos: images.length, by_status, earliest_expiry: earliest, label_required: images.some((i) => i.adminLabel !== null) },
    adminPreviewAllowed: images.every((i) => i.adminPreview),
    shareEligible: images.length === 0 || ((SHARE_PHOTOS_ENABLED as boolean) && images.every((i) => i.shareable)),
    images,
  };
}
