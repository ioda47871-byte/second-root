/**
 * DEV-196q (spec §7.5, owner decisions 2026-11-10 / 2026-11-11): the stored structure findings of a demo version —
 * the strict shape (the same as quality.ts StructureFindingInput and the database's sales_structure_findings_valid),
 * and how the admin quality screen shows them beside checklist items 3 and 4: as ADVICE only.
 *
 * Nothing here computes a similarity: the structure descriptor module is isolated (provisional vocabulary), and who may
 * compute the findings is a separate approval. The caller passes findings computed elsewhere; this module only checks
 * their shape and turns stored ones into warnings (templateWarnings: `blocking` is always false).
 *
 * Pure.
 */
import { z } from "zod";
import { templateWarnings, type StructureFindingInput, type TemplateWarning } from "./quality";

const Similarity = z.number().finite().min(0).max(1);
const ASPECT_NAMES = ["hero", "flow", "navigation", "reading_path", "section_layouts", "transitions", "text_direction", "imagery"] as const;

export const StructureFindingSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("TOO_CLOSE_TO_REFERENCE"), reference: z.string().regex(/^[A-Z][A-Z0-9]*-[0-9A-Za-z-]{1,40}$/), similarity: Similarity }),
  z.strictObject({ code: z.literal("SIBLINGS_SAME_SKELETON"), sibling: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), similarity: Similarity }),
  z.strictObject({ code: z.literal("GENERIC_SKELETON"), reasons: z.array(z.string().regex(/^[a-z_]{1,40}:[a-z_0-9/]{1,40}$/)).min(1).max(8) }),
  z.strictObject({ code: z.literal("ASPECTS_UNKNOWN"), aspects: z.array(z.enum(ASPECT_NAMES)).min(1).max(8) }),
]);

export const StructureFindings = z.array(StructureFindingSchema).max(64);

/** spec §7.5: at most this many recently approved versions of other shops are compared. */
export const MAX_SIBLINGS_COMPARED = 20;

export const STRUCTURE_FINDING_SOURCES = ["observation_report"] as const;
export type StructureFindingSource = (typeof STRUCTURE_FINDING_SOURCES)[number];

export type StructureFindingsRecord = {
  source: StructureFindingSource;
  findings: StructureFindingInput[];
  siblingsCompared: number;
};

/** The findings to store, or the reason they are refused (never stored partly). */
export function parseStructureFindingsInput(raw: unknown): { ok: true; value: StructureFindingsRecord } | { ok: false; code: "STRUCTURE_FINDINGS_INVALID" } {
  const o = z
    .strictObject({ source: z.enum(STRUCTURE_FINDING_SOURCES), findings: StructureFindings, siblingsCompared: z.number().int().min(0).max(MAX_SIBLINGS_COMPARED) })
    .safeParse(raw);
  return o.success ? { ok: true, value: o.data as StructureFindingsRecord } : { ok: false, code: "STRUCTURE_FINDINGS_INVALID" };
}

/** What the screen shows for one version: not stored, stored but unreadable, or the advisory warnings. */
export type StructureAdvice =
  | { kind: "not_stored" }
  | { kind: "unreadable" }
  | { kind: "stored"; warnings: TemplateWarning[]; siblingsCompared: number; blocking: false };

/** A stored row (or null) → advice. A row that does not parse is "unreadable", never "no warnings". */
export function structureAdviceOf(row: { findings: unknown; siblings_compared: unknown } | null): StructureAdvice {
  if (!row) return { kind: "not_stored" };
  const f = StructureFindings.safeParse(row.findings);
  const n = row.siblings_compared;
  if (!f.success || !Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > MAX_SIBLINGS_COMPARED) return { kind: "unreadable" };
  const { warnings } = templateWarnings(f.data as StructureFindingInput[]);
  return { kind: "stored", warnings, siblingsCompared: n as number, blocking: false };
}
