/**
 * DEV-196b (spec §8.3・§8.3.1・T21, owner decision 2026-11-10): the rights record and check of a REAL shop's
 * AI-generated concept image, used only in the admin's design study.
 *
 * Kept apart from photo_rights_v0 / checkPhotoRights / AI_DEMO_SHOPS (the fictional research shops' rules, unchanged):
 * an `ai_concept_rights_v0` record is its own strict schema with its own `source_kind`, and `checkPhotoRights` refuses
 * it. The check returns `ai_concept_internal` only when EVERY condition holds; anything missing → `unknown`.
 *
 * The result can only mean "visible in the admin preview": there is no share purpose and no share field in the result
 * type. A version holding such an image is never share-eligible (rights.ts `shareEligible`).
 *
 * Pure: the caller measures the bytes (`measurePhotoBytes`) and passes the forbidden hashes and the version's prospect.
 */
import { z } from "zod";
import { isIsoDate, PHOTO_FORMATS, type PhotoBytesInfo } from "@/lib/design-agent/quality-pipeline/photo-rights";

/** The fixed admin label every such image carries (shown by the trusted admin frame, never by the artifact's HTML). */
export const AI_CONCEPT_ADMIN_LABEL = "AI 生成の概念画像。実在の商品・店内・人・設備ではありません。共有不可";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.string().refine((s) => isIsoDate(s) && s.length > 10, "INVALID_DATE");
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** How the image was made: the AiProvenance fields, with `admin_preview_only: true` instead of `demo_only`. DB only (§8.2). */
export const AiConceptProvenance = z.strictObject({
  generator: z.string().trim().min(1).max(300),
  model: z.string().regex(/^[0-9A-Za-z._-]{1,60}$/).refine((m) => m.toLowerCase() !== "unknown", "MODEL_UNKNOWN"),
  generated_at: Timestamp,
  prompt_sha256: Sha256,
  approval_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/),
  admin_preview_only: z.literal(true),
});

export const AiConceptRights = z.strictObject({
  schema: z.literal("ai_concept_rights_v0"),
  source_kind: z.literal("ai_concept_internal"),
  sha256: Sha256,
  bytes: z.number().int().positive().max(50_000_000),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
  format: z.enum(PHOTO_FORMATS),
  provenance: AiConceptProvenance,
  depicts_real_product: z.boolean(),
  depicts_real_interior: z.boolean(),
  depicts_identifiable_person: z.boolean(),
  depicts_real_equipment: z.boolean(),
  depicts_real_shop: z.boolean(),
  no_factual_impersonation_confirmed_at: Timestamp,
  no_factual_impersonation_confirmed_by: UUID,
  admin_label: z.string(),
  prospect_id: UUID,
});
export type AiConceptRights = z.infer<typeof AiConceptRights>;

export type AiConceptCode =
  | "SCHEMA_INVALID"
  | "PROVENANCE_MISSING"
  | "DEPICTS_REAL"
  | "IMPERSONATION_NOT_CONFIRMED"
  | "ADMIN_LABEL_MISMATCH"
  | "HASH_MISMATCH"
  | "SIZE_MISMATCH"
  | "DIMENSION_MISMATCH"
  | "FORMAT_MISMATCH"
  | "FORBIDDEN_SOURCE_HASH"
  | "PROSPECT_MISMATCH"
  | "DATE_IN_FUTURE";

/** No share field: this result can only ever allow the admin preview. */
export type AiConceptResult = { status: "ai_concept_internal"; adminLabel: typeof AI_CONCEPT_ADMIN_LABEL } | { status: "unknown"; codes: AiConceptCode[] };

/** Fields whose absence is named by what is missing rather than folded into SCHEMA_INVALID. */
const MISSING: Record<string, AiConceptCode> = {
  provenance: "PROVENANCE_MISSING",
  no_factual_impersonation_confirmed_at: "IMPERSONATION_NOT_CONFIRMED",
  no_factual_impersonation_confirmed_by: "IMPERSONATION_NOT_CONFIRMED",
  admin_label: "ADMIN_LABEL_MISMATCH",
  depicts_real_product: "DEPICTS_REAL",
  depicts_real_interior: "DEPICTS_REAL",
  depicts_identifiable_person: "DEPICTS_REAL",
  depicts_real_equipment: "DEPICTS_REAL",
  depicts_real_shop: "DEPICTS_REAL",
};

/** §8.3.1 conditions 1–6. Every failing condition is returned. */
export function checkAiConceptRights(record: unknown, bytesInfo: PhotoBytesInfo | null, opts: { forbiddenSha256: ReadonlySet<string>; prospectId: string; now: Date }): AiConceptResult {
  const parsed = AiConceptRights.safeParse(record);
  if (!parsed.success) {
    const codes = new Set<AiConceptCode>();
    for (const i of parsed.error.issues) codes.add(MISSING[String(i.path[0] ?? "")] ?? "SCHEMA_INVALID");
    return { status: "unknown", codes: [...codes] };
  }
  const r = parsed.data;
  const codes = new Set<AiConceptCode>();
  if (r.depicts_real_product || r.depicts_real_interior || r.depicts_identifiable_person || r.depicts_real_equipment || r.depicts_real_shop) codes.add("DEPICTS_REAL");
  if (r.admin_label !== AI_CONCEPT_ADMIN_LABEL) codes.add("ADMIN_LABEL_MISMATCH");
  const now = opts.now.getTime();
  if (Date.parse(r.provenance.generated_at) > now || Date.parse(r.no_factual_impersonation_confirmed_at) > now) codes.add("DATE_IN_FUTURE");
  // the owner confirms after the image exists, never before
  if (Date.parse(r.no_factual_impersonation_confirmed_at) < Date.parse(r.provenance.generated_at)) codes.add("IMPERSONATION_NOT_CONFIRMED");
  if (!bytesInfo) codes.add("HASH_MISMATCH");
  else {
    if (bytesInfo.sha256 !== r.sha256) codes.add("HASH_MISMATCH");
    if (bytesInfo.bytes !== r.bytes) codes.add("SIZE_MISMATCH");
    if (bytesInfo.width !== r.width || bytesInfo.height !== r.height) codes.add("DIMENSION_MISMATCH");
    if (bytesInfo.format !== r.format) codes.add("FORMAT_MISMATCH");
  }
  if (opts.forbiddenSha256.has(r.sha256) || (bytesInfo && opts.forbiddenSha256.has(bytesInfo.sha256))) codes.add("FORBIDDEN_SOURCE_HASH");
  if (r.prospect_id !== opts.prospectId) codes.add("PROSPECT_MISMATCH");
  return codes.size ? { status: "unknown", codes: [...codes] } : { status: "ai_concept_internal", adminLabel: AI_CONCEPT_ADMIN_LABEL };
}
