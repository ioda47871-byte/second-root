/**
 * DEV-150 (Issue #180, owner approval A′, 2026-11-01): the check of ONE generated picture placed on a page of the
 * three-method pilot (VISUAL_FIRST's C1-c picture from the lane, LAYOUT_FIRST / DIRECTION_FIRST's page picture).
 *
 * Why not the site-wide Identity Lock's image audit: that one is for a generated FULL design, which must show the
 * shop's name. A pilot picture is an asset whose prompt asks for no text at all, so the shop's name is normally absent;
 * the Lock's image audit would hold every correct picture. The Lock itself and its audits stay exactly as they are; the
 * site's identity is still checked on the page's visible text (auditPageText), never here.
 *
 * What this checks: the picture is the one inspected (SHA-256), it comes from an approved image call (its origin, given
 * by the caller from a recorded step), and what a person (or Claude) RECORDED seeing in it: no other shop's name or
 * mark, no text other than the target's own names, the right kind of shop, nothing against the facts. The verdict uses
 * only the `observed` and `answers` parts; `inferred` is kept for the record and never read. Nothing is read from pixels.
 *
 *   REJECT  the inspected SHA is not this picture's; unknown origin; another shop's name or mark seen; another
 *           category; a contradiction with the facts (which fact is recorded); a Lock that does not check
 *   HOLD    no or an incomplete record; no SHA; unreadable text; any visible text or mark that is not the target's
 *           allowed names (even a generic word such as "BREAD": the owner decides); any "unknown" answer
 *   PASS_ASSET_ONLY  only "this picture shows nothing against the shop": never a site identity, never PASS_IDENTITY_ONLY,
 *           never a quality score or an approval
 *
 * The Lock's own checks (schema, target, prompt, research only) are re-implemented here with the same rules as the
 * Lock's (the lane's tests compare the two on the same locks); only its exported `cleanName` is reused. Pure: no I/O.
 */
import { z } from "zod";
import { cleanName } from "../identity/identity-lock";
import type { FactsPack } from "./brief";

export type AssetImageStatus = "REJECT" | "HOLD" | "PASS_ASSET_ONLY";
export type AssetImageResult = {
  status: AssetImageStatus;
  errors: string[];
  pending: string[];
  /** The facts the record says the picture contradicts (REJECT). */
  contradicted_fact_ids: string[];
  counts_as_site_identity: false;
  note: string;
};

const NOTE = "PASS_ASSET_ONLY means only that the recorded inspection of this exact picture shows nothing against the shop. It is not a site identity (that is the page text's audit), not a quality score and not an approval.";

const Answer = z.enum(["yes", "no", "unknown"]);
const Line = (max: number) => z.string().max(max).refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s), "unsafe_text");
const Filled = (max: number) => Line(max).refine((s) => s.trim().length > 0, "empty");

/** The record of one visual inspection of one picture. Strict: an unknown key is refused (the record is incomplete). */
export const AssetInspection = z.strictObject({
  schema: z.literal("three_method_asset_inspection_v0"),
  image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  method: z.enum(["assistant_visual", "human_visual"]),
  inspector: Filled(200),
  observed: z.strictObject({
    /** Every text seen in the picture, as seen (empty when there is none: the normal case for an asset). */
    visible_text: z.array(Filled(200)).max(50),
    /** Every logo, mark or signboard seen, described (empty when none). */
    logos_or_marks: z.array(Filled(300)).max(20),
    depicted: Filled(1000),
    category_cues: z.array(Filled(200)).max(20),
  }),
  /** The inspector's interpretation: kept for the record, NEVER used for the verdict. */
  inferred: Line(2000),
  answers: z.strictObject({
    other_shop_name_or_logo: Answer,
    category_mismatch: Answer,
    contradicts_facts: Answer,
    /** Required (and only allowed) when contradicts_facts is "yes". */
    contradicted_fact_ids: z.array(z.string().regex(/^F\d{1,3}$/)).max(50),
    unreadable_text: Answer,
  }),
  note: Line(2000),
});
export type AssetInspection = z.infer<typeof AssetInspection>;

const filled = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const obj = (x: unknown): Record<string, unknown> => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** The Lock's before-generation checks, with the same rules and codes as the Identity Lock's own (compared in the tests). */
export function lockErrors(lock: unknown): { errors: string[]; allowed: string[]; others: string[]; category: unknown } {
  const a = obj(lock);
  const target = obj(a.target);
  const prompt = obj(a.prompt);
  const errors: string[] = [];
  if (a.schema_version !== 1 || !/^CP-\d{3}$/.test(typeof a.case_id === "string" ? a.case_id : "")) errors.push("SCHEMA_OR_CASE_ID_INVALID");
  if (!filled(target.official_name) || !filled(target.category_code) || !filled(target.official_source_url)) errors.push("TARGET_IDENTITY_INCOMPLETE");
  const allowed = [target.official_name, ...(Array.isArray(target.allowed_aliases) ? target.allowed_aliases : [])].filter(filled).map(cleanName).filter((n) => n.length > 0);
  if (allowed.length === 0) errors.push("TARGET_NAME_MISSING");
  if (!allowed.includes(cleanName(prompt.shop_name))) errors.push("PROMPT_WRONG_SHOP");
  if (prompt.category_code !== target.category_code) errors.push("PROMPT_WRONG_CATEGORY");
  if (prompt.is_research_only !== true) errors.push("NOT_MARKED_RESEARCH_ONLY");
  const others = (Array.isArray(a.other_shop_names) ? a.other_shop_names : []).filter(filled).map(cleanName).filter((n) => n.length >= 2);
  return { errors, allowed, others, category: target.category_code };
}

/**
 * One picture: its SHA-256 as placed in the render, its origin (the approved image call it was made by, from a recorded
 * step; null = unknown), the record of its inspection (undefined = none), the Lock and the facts pack.
 */
export function auditAssetImage(o: { lock: unknown; facts: Pick<FactsPack, "facts">; image: { sha256: string | null; origin: { approval_id: string; kind: string } | null }; inspection: unknown }): AssetImageResult {
  const { errors, allowed, others } = lockErrors(o.lock);
  const pending: string[] = [];
  const contradicted: string[] = [];
  const done = (): AssetImageResult => ({ status: errors.length ? "REJECT" : pending.length ? "HOLD" : "PASS_ASSET_ONLY", errors: [...new Set(errors)], pending: [...new Set(pending)], contradicted_fact_ids: contradicted, counts_as_site_identity: false, note: NOTE });
  const sha = o.image.sha256;
  if (sha === null || !/^[0-9a-f]{64}$/.test(sha)) pending.push("IMAGE_HASH_MISSING");
  if (o.image.origin === null) errors.push("ASSET_ORIGIN_UNKNOWN");
  if (o.inspection === undefined) {
    pending.push("ASSET_INSPECTION_REQUIRED");
    return done();
  }
  const parsed = AssetInspection.safeParse(o.inspection);
  if (!parsed.success) {
    pending.push("ASSET_INSPECTION_INCOMPLETE");
    return done();
  }
  const r = parsed.data;
  // without the picture's own SHA nothing can be matched (HOLD above); otherwise the record must be of exactly it
  if (sha !== null && r.image_sha256 !== sha) errors.push("INSPECTION_IMAGE_NOT_MATCHED");
  // what was seen: another shop's name is REJECT; any other text or mark (even a generic word) is the owner's call
  const seen = [...r.observed.visible_text, ...r.observed.logos_or_marks].map(cleanName);
  if (seen.some((t) => others.some((n) => t.includes(n)))) errors.push("OTHER_SHOP_VISIBLE");
  if (r.observed.visible_text.some((t) => !allowed.includes(cleanName(t)))) pending.push("VISIBLE_TEXT_NOT_TARGET");
  if (r.observed.logos_or_marks.some((t) => !allowed.includes(cleanName(t)))) pending.push("LOGO_OR_MARK_NOT_TARGET");
  const answer = (v: "yes" | "no" | "unknown", yes: () => void, code: string) => (v === "yes" ? yes() : v === "unknown" ? pending.push(`${code}_UNKNOWN`) : undefined);
  answer(r.answers.other_shop_name_or_logo, () => errors.push("OTHER_SHOP_VISIBLE"), "OTHER_SHOP");
  answer(r.answers.category_mismatch, () => errors.push("CATEGORY_MISMATCH"), "CATEGORY");
  answer(r.answers.unreadable_text, () => pending.push("UNREADABLE_TEXT"), "UNREADABLE_TEXT");
  const ids = new Set(o.facts.facts.map((f) => f.id));
  const named = r.answers.contradicted_fact_ids;
  if (r.answers.contradicts_facts === "yes") {
    // which fact must be recorded (and be one of this shop's): otherwise the record is incomplete
    if (named.length === 0 || named.some((id) => !ids.has(id))) pending.push("ASSET_INSPECTION_INCOMPLETE");
    else {
      errors.push("CONTRADICTS_FACTS");
      contradicted.push(...named);
    }
  } else {
    if (named.length > 0) pending.push("ASSET_INSPECTION_INCOMPLETE");
    if (r.answers.contradicts_facts === "unknown") pending.push("CONTRADICTS_FACTS_UNKNOWN");
  }
  return done();
}
