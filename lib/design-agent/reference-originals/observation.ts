/**
 * DEV-155 (Issue #193): a written observation of one success-case original, tied to the picture by its SHA-256 and to
 * places in it by pixel boxes. Strict: an unknown key is refused. Pure.
 *
 * Why boxes: Issue #193 asks that analysis be grounded in the image, not in a description. Every observed item names
 * where in the picture it is seen, so a reviewer can open the same picture and check it. Interpretation lives in
 * `inferred` and the learning notes; it is never mixed with what is seen.
 */
import { z } from "zod";

const Line = (max: number) => z.string().min(1).max(max).refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s), "unsafe_text");
const Box = z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1) });
const Seen = z.strictObject({ what: Line(400), box: Box });

export const ReferenceObservation = z.strictObject({
  schema: z.literal("reference_observation_v0"),
  case_id: z.string().regex(/^CP-\d{3}$/),
  /** The picture the observation is of (as the intake record names it). */
  image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  view: z.enum(["desktop", "mobile", "concept"]),
  inspector: Line(200),
  observed: z.strictObject({
    /** The shop's own thing that the page is built around (seen). */
    motif: z.array(Seen).min(1).max(6),
    /** Where that thing becomes structure (layout, order, navigation), not decoration. */
    motif_to_structure: z.array(Seen).max(8),
    /** The first screen's reading order, step by step. */
    hero_reading_order: z.array(Seen).min(1).max(8),
    /** Section by section: what changes (ground, scale, image size, placement). */
    section_rhythm: z.array(Seen).max(16),
    typography: z.array(Seen).max(8),
    colour: z.array(Seen).max(8),
    /** Each photograph or illustration and the role it plays (hero, object, place, hands, texture...). */
    image_roles: z.array(Seen).max(16),
    /** Mobile only: how the page is composed again for a narrow screen (empty for desktop and concepts). */
    mobile_recomposition: z.array(Seen).max(10),
    /** Defects seen even in the adopted version (overlaps, cut text...). */
    defects: z.array(Seen).max(10),
  }),
  inferred: Line(2000),
  /** Structural principles worth learning (not a recipe). */
  learn: z.array(Line(300)).min(1).max(10),
  /** What must never be copied into another shop's page. */
  do_not_copy: z.array(Line(300)).min(1).max(10),
});
export type ReferenceObservation = z.infer<typeof ReferenceObservation>;

/** The intake record (`reference_original_record_v0`), checked before an observation is compared with it. */
export const ReferenceRecord = z.object({
  schema: z.literal("reference_original_record_v0"),
  case_id: z.string().regex(/^CP-\d{3}$/),
  key: z.string().regex(/sha256$/),
  kind: z.enum(["original", "registered_preview"]),
  view: z.enum(["desktop", "mobile", "concept"]),
  image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  recorded_sha256_matches: z.literal(true),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(40000),
});
export type ReferenceRecord = z.infer<typeof ReferenceRecord>;

export type ObservationCheck = { ok: true } | { ok: false; codes: string[] };

/** The observation against the intake record of the picture it claims to describe. */
export function checkObservation(raw: unknown, record: { case_id: string; image_sha256: string; view: string; width: number; height: number }): ObservationCheck {
  const parsed = ReferenceObservation.safeParse(raw);
  if (!parsed.success) return { ok: false, codes: ["OBSERVATION_SCHEMA"] };
  const o = parsed.data;
  const codes: string[] = [];
  if (o.case_id !== record.case_id) codes.push("OBSERVATION_CASE_MISMATCH");
  if (o.image_sha256 !== record.image_sha256) codes.push("OBSERVATION_IMAGE_MISMATCH");
  if (o.view !== record.view) codes.push("OBSERVATION_VIEW_MISMATCH");
  const items = Object.values(o.observed).flat();
  if (items.some((s) => s.box.x + s.box.w > record.width || s.box.y + s.box.h > record.height)) codes.push("OBSERVATION_BOX_OUTSIDE");
  if (o.view !== "mobile" && o.observed.mobile_recomposition.length > 0) codes.push("OBSERVATION_MOBILE_ONLY");
  return codes.length ? { ok: false, codes } : { ok: true };
}
