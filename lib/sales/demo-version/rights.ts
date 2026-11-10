/**
 * DEV-196b (spec §8.1・§8.3・§8.3.1・§8.4・T6・T21, owner decisions 2026-11-10): the rights status of each image of a
 * demo version, derived by the server (never chosen by hand), and the version's summary and share eligibility.
 *
 * Two derivations, kept apart (§8.1):
 *  - human photos, licensed material with pinned terms, and a FICTIONAL research shop's AI demo picture: the
 *    `photo_rights_v0` record through `checkPhotoRights`, unchanged. `aiDemoAllowed` is passed only for a fictional
 *    shop the caller lists (photo-swap's AI_DEMO_SHOPS); a real shop never gets it, so `ai_generated_demo` there is
 *    `unknown`. `share_cleared` is the `purpose: "public_site"` result.
 *  - a REAL shop's AI concept image: the `ai_concept_rights_v0` record through `checkAiConceptRights`
 *    (ai-concept-rights.ts) → `ai_concept_internal`, admin preview only.
 *
 * Fail closed: anything that does not pass is `unknown` (not previewable, not shareable). No AI status is ever
 * shareable; `ai_share_approved` is reserved and never derived. Today no photo of any kind may be on a share URL
 * (MVP_SPEC §7, PUBLIC_DEMO_ASSETS_ENABLED = false): a version is share-eligible only with zero photos.
 *
 * Dates: the check day is the Asia/Tokyo calendar day of `now` (rights expire after their last JST day).
 *
 * Pure: the caller loads the records and measures the bytes (`measurePhotoBytes`).
 */
import { checkPhotoRights, type PhotoBytesInfo, type PhotoRightsCode } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { jstDate } from "@/lib/sales/dates";
import { AI_CONCEPT_ADMIN_LABEL, checkAiConceptRights, type AiConceptCode } from "./ai-concept-rights";

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

/** §8.1: statuses whose image the admin preview may show (anything else rejects the whole version). */
export const ADMIN_PREVIEW_STATUSES: readonly RightsStatus[] = ["ai_demo_internal", "ai_concept_internal", "owner_provided_internal", "shop_provided_internal", "licensed_terms_pinned_internal", "share_cleared"];

/**
 * Whether photos may be on a share URL at all: false until a later, separate approval changes MVP_SPEC §7 (Protected
 * Scope; not part of DEV-196a). A literal, not an option: no caller can switch it on.
 */
export const SHARE_PHOTOS_ENABLED = false as const;

/** §8.1: the fixed labels the trusted admin frame shows beside an image. */
export const ADMIN_RIGHTS_LABELS: Partial<Record<RightsStatus, string>> = {
  ai_demo_internal: "AI 生成のデモ画像を含む (デモ専用・共有不可)",
  ai_concept_internal: AI_CONCEPT_ADMIN_LABEL,
};

export type ShopKind = "fictional" | "real";

export type ImageRightsInput =
  /** a human photo, licensed material, or a fictional shop's AI demo picture */
  | { record_schema: "photo_rights_v0"; record: unknown; bytesInfo: PhotoBytesInfo | null; revokedAt: Date | null }
  /** a real shop's AI concept image */
  | { record_schema: "ai_concept_rights_v0"; record: unknown; bytesInfo: PhotoBytesInfo | null; revokedAt: Date | null };

export type RightsContext = {
  shopKind: ShopKind;
  /** the version's prospect (an AI concept image is bound to one) */
  prospectId: string;
  /** a fictional shop the caller allows AI demo pictures for (AI_DEMO_SHOPS). Ignored (false) for a real shop. */
  aiDemoAllowed: boolean;
  forbiddenSha256: ReadonlySet<string>;
  now: Date;
};

export type ImageRights = {
  status: RightsStatus;
  codes: Array<PhotoRightsCode | AiConceptCode | "REVOKED" | "WRONG_SHOP_KIND" | "INPUT_INVALID">;
  adminPreview: boolean;
  adminLabel: string | null;
};

const result = (status: RightsStatus, codes: ImageRights["codes"] = []): ImageRights => ({
  status,
  codes,
  adminPreview: ADMIN_PREVIEW_STATUSES.includes(status),
  adminLabel: ADMIN_RIGHTS_LABELS[status] ?? null,
});

/** §8.1: whether a status may be shared. AI statuses never; share_cleared only once photos may be shared at all. */
export function isShareableStatus(status: RightsStatus): boolean {
  if (status === "ai_demo_internal" || status === "ai_concept_internal" || status === "ai_share_approved") return false;
  return status === "share_cleared" && (SHARE_PHOTOS_ENABLED as boolean);
}

/** The rights status of one image (§8.1). */
export function deriveRightsStatus(input: ImageRightsInput, ctx: RightsContext): ImageRights {
  if (ctx.shopKind !== "fictional" && ctx.shopKind !== "real") return result("unknown", ["INPUT_INVALID"]);
  if (input.revokedAt !== null) return result("revoked", ["REVOKED"]);
  if (input.record_schema === "ai_concept_rights_v0") {
    if (ctx.shopKind !== "real") return result("unknown", ["WRONG_SHOP_KIND"]);
    const r = checkAiConceptRights(input.record, input.bytesInfo, { forbiddenSha256: ctx.forbiddenSha256, prospectId: ctx.prospectId, now: ctx.now });
    return r.status === "ai_concept_internal" ? result("ai_concept_internal") : result("unknown", r.codes);
  }
  if (input.record_schema !== "photo_rights_v0") return result("unknown", ["INPUT_INVALID"]);
  const today = jstDate(ctx.now);
  const base = { now: today, forbiddenSha256: ctx.forbiddenSha256, aiDemoAllowed: ctx.shopKind === "fictional" && ctx.aiDemoAllowed === true };
  const internal = checkPhotoRights(input.record, input.bytesInfo, { ...base, purpose: "quality_verification" });
  if (!internal.ok) {
    // an expired record that is otherwise in order is "expired"; any other problem is "unknown"
    if (internal.codes.length === 1 && internal.codes[0] === "RIGHTS_EXPIRED") return result("expired", internal.codes);
    return result("unknown", internal.codes);
  }
  const r = internal.record;
  if (r.source_kind === "ai_generated_demo") return result("ai_demo_internal");
  if (checkPhotoRights(input.record, input.bytesInfo, { ...base, purpose: "public_site" }).ok) return result("share_cleared");
  return result(r.source_kind === "owner_provided" ? "owner_provided_internal" : r.source_kind === "shop_provided" ? "shop_provided_internal" : "licensed_terms_pinned_internal");
}

/**
 * §8.3: whether a version may be on a share URL, from its images' statuses re-derived at this moment. Zero photos →
 * true. Any AI image (ai_concept_internal included) → false. Otherwise false until photos may be shared.
 */
export function shareEligible(statuses: readonly RightsStatus[]): boolean {
  if (statuses.length === 0) return true;
  if (statuses.some((s) => s === "ai_concept_internal" || s === "ai_demo_internal" || s === "ai_share_approved")) return false;
  return statuses.every(isShareableStatus);
}

/** §8.4 `rights_summary`: fixed keys only. */
export type RightsSummary = {
  version: 1;
  photos: number;
  by_status: Partial<Record<RightsStatus, number>>;
  earliest_expiry: string | null;
  label_required: boolean;
};

export type VersionRights = { summary: RightsSummary; adminPreviewAllowed: boolean; shareEligible: boolean; images: ImageRights[] };

/**
 * The version's rights at `now`: every image derived, the §8.4 summary, whether the admin preview may show it (no
 * image unknown / expired / revoked: a version is never shown with holes) and whether it may be shared.
 * `expiries` are the images' `rights_expiry` dates (YYYY-MM-DD or null), for the summary only.
 */
export function deriveVersionRights(images: ReadonlyArray<ImageRightsInput & { expiry?: string | null }>, ctx: RightsContext): VersionRights {
  const derived = images.map((i) => deriveRightsStatus(i, ctx));
  const by_status: Partial<Record<RightsStatus, number>> = {};
  for (const d of derived) by_status[d.status] = (by_status[d.status] ?? 0) + 1;
  const expiries = images.map((i) => i.expiry ?? null).filter((e): e is string => typeof e === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  return {
    summary: { version: 1, photos: derived.length, by_status, earliest_expiry: expiries[0] ?? null, label_required: derived.some((d) => d.adminLabel !== null) },
    adminPreviewAllowed: derived.every((d) => d.adminPreview),
    shareEligible: shareEligible(derived.map((d) => d.status)),
    images: derived,
  };
}
