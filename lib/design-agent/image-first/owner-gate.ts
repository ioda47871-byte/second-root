/**
 * Issue #293 P2 gate, offline: the owner's evaluation of a model comp, BEFORE Claude implements it.
 *
 * The rubric is the design-image one, reused as code (comp-impl/bundle.ts: EvaluationSchema, evaluationVerdict —
 * no hard fail, total ≥ 22/25, every criterion ≥ 4, the human's confirmation, a `real` comp). This file only binds it to
 * an IMAGE_FIRST run: the exact manifest bytes, the exact set of PC and SP pictures (both viewports, all parts), and the
 * image-first hard fails the owner answers on top of the rubric's (not a website, hero only, SP not independent, another
 * shop, fabricated text). Claude's own scoring is never a confirmation (EvaluationSchema.human_confirmed). Pure.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { EvaluationSchema, evaluationVerdict, type EvalVerdict } from "../comp-impl/bundle";
import { IMAGE_FIRST_HARD_FAILS, VIEWPORTS, type ModelFullPageComp } from "./record";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const OwnerEvaluation = z.strictObject({
  schema: z.literal("image_first_owner_evaluation_v0"),
  run_id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  /** SHA-256 of manifest.json's bytes as evaluated. */
  record_sha256: Sha,
  /** compSetSha256 of the record: every PC and SP part, in page order. */
  comp_set_sha256: Sha,
  /** The owner looked at both composites (PC 1440, SP 390) and every part, not one picture. */
  viewed_composites: z.boolean(),
  image_first_hard_fails: z.strictObject(Object.fromEntries(IMAGE_FIRST_HARD_FAILS.map((k) => [k, z.boolean()])) as Record<(typeof IMAGE_FIRST_HARD_FAILS)[number], z.ZodBoolean>),
  /** The design-image rubric's sheet; its comp_sha256 is comp_set_sha256. */
  evaluation: EvaluationSchema,
});
export type OwnerEvaluation = z.infer<typeof OwnerEvaluation>;

/** One SHA for the whole comp: "desktop_1440:<sha>,<sha>\nmobile_390:<sha>,…" over the parts in page order. */
export function compSetSha256(r: Pick<ModelFullPageComp, "viewports">): string | null {
  if (!r.viewports.desktop_1440 || !r.viewports.mobile_390) return null;
  const line = (v: (typeof VIEWPORTS)[number]) => `${v}:${r.viewports[v]!.parts.map((p) => p.png_sha256).join(",")}`;
  return createHash("sha256").update(VIEWPORTS.map(line).join("\n")).digest("hex");
}

export const OWNER_GATE_REASONS = ["EVAL_INVALID", "EVAL_BINDING_MISMATCH", "EVAL_NOT_VIEWED_WHOLE", "EVAL_HARD_FAIL", "EVAL_TOTAL_MISMATCH", "EVAL_CONFIRMATION_INCOMPLETE"] as const;
export type OwnerGate = { pass: boolean; reasons: string[]; verdict: EvalVerdict | null };

/** The gate: the rubric's verdict plus the binding to this run. `pass` only when every check holds. */
export function ownerGate(raw: unknown, o: { runId: string; recordSha256: string; compSetSha256: string | null }): OwnerGate {
  const parsed = OwnerEvaluation.safeParse(raw);
  if (!parsed.success) return { pass: false, reasons: ["EVAL_INVALID"], verdict: null };
  const e = parsed.data;
  const reasons: string[] = [];
  if (e.run_id !== o.runId || e.record_sha256 !== o.recordSha256 || !o.compSetSha256 || e.comp_set_sha256 !== o.compSetSha256 || e.evaluation.comp_sha256 !== o.compSetSha256) reasons.push("EVAL_BINDING_MISMATCH");
  if (!e.viewed_composites) reasons.push("EVAL_NOT_VIEWED_WHOLE");
  if (Object.values(e.evaluation.hard_fails).some(Boolean) || Object.values(e.image_first_hard_fails).some(Boolean)) reasons.push("EVAL_HARD_FAIL");
  const ev = e.evaluation;
  if (ev.scores && ev.total !== Object.values(ev.scores).reduce((a, b) => a + b, 0)) reasons.push("EVAL_TOTAL_MISMATCH");
  if (ev.human_confirmed && (!ev.confirmed_by || !ev.confirmed_at || !ev.scores)) reasons.push("EVAL_CONFIRMATION_INCOMPLETE");
  const verdict = evaluationVerdict(ev);
  reasons.push(...verdict.reasons);
  return { pass: reasons.length === 0 && verdict.pass, reasons: [...new Set(reasons)].sort(), verdict };
}
