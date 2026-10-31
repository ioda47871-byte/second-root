/**
 * DEV-136 (Stage 3, step 2): the structure descriptors of the success cases and of the rejected versions, as a set a
 * new design can be compared with OFFLINE — is it the skeleton of a success case (a copy), or the skeleton of a version
 * the owner rejected?
 *
 * The set (design-library/intelligence/v02/structure-descriptors-v0.json) is DECLARED from the research records (and,
 * for CP-001..003 only, from their preview images); nothing in it was measured, most originals are not in the
 * repository, and an aspect the record does not state is null. The vocabulary and the thresholds are provisional
 * (Issue #159). So this is advisory research data: never a generation input, never a pass, never a stop. Using it in a
 * generator or the Phase 2f runner is a separate approval (the structure module's isolation).
 *
 * Pure: zod and the descriptor module only.
 */
import { z } from "zod";
import { MIN_COVERAGE, similarityDetail, StructureDescriptor, structuralSimilarity, THRESHOLDS } from "./descriptor";

const CaseId = z.string().regex(/^CP-\d{3}$/);
const Basis = z.array(z.string().min(1).max(300)).min(1).max(8);

export const ReferenceDescriptors = z
  .strictObject({
    schema: z.literal("reference_structure_descriptors_v0"),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.literal("provisional_declared_from_research_records"),
    scope: z.literal("offline_advisory_only_not_generation_input"),
    vocabulary: z.literal("structure_descriptor_v0"),
    note: z.string().min(1).max(2000),
    success: z
      .array(z.strictObject({ id: CaseId, evidence: z.enum(["image", "text_record", "original_unavailable"]), basis: Basis, descriptor: StructureDescriptor }))
      .min(1)
      .max(60),
    rejected: z
      .array(z.strictObject({ id: z.string().regex(/^[A-Z][A-Z0-9]*-[0-9A-Za-z-]{1,40}$/), case: CaseId, verdict: z.string().min(1).max(120), basis: Basis, descriptor: StructureDescriptor }))
      .max(60),
  })
  // every aspect is declared: the set never claims a measurement
  .refine((s) => [...s.success, ...s.rejected].every((e) => Object.entries(e.descriptor).every(([k, v]) => k === "schema" || v === null || (v as { source: string }).source === "declared")), "reference_aspect_not_declared")
  .refine((s) => new Set([...s.success, ...s.rejected].map((e) => e.id)).size === s.success.length + s.rejected.length, "reference_id_duplicate");
export type ReferenceDescriptors = z.infer<typeof ReferenceDescriptors>;

/** Provisional: a candidate this close to a rejected skeleton repeats what the owner turned down. */
export const CLOSE_TO_REJECTED = THRESHOLDS.siblings_same_skeleton;

export type ReferenceMatch = { id: string; similarity: number };
export type ReferenceComparison = {
  /** Success cases whose skeleton the candidate repeats (similarity ≥ too_close_to_reference): a copy, not a lesson. */
  too_close_to_success: ReferenceMatch[];
  /** Rejected versions whose skeleton the candidate repeats (similarity ≥ CLOSE_TO_REJECTED). */
  close_to_rejected: ReferenceMatch[];
  /** References the comparison could not decide (under MIN_COVERAGE of the weight known on both sides). */
  undecided: string[];
  advisory: true;
};

/**
 * Compares one candidate descriptor (measured or declared) with every reference. Sorted by similarity, highest first.
 * A reference too sparse to decide is listed as undecided, never as "not close".
 */
export function compareWithReferences(candidate: StructureDescriptor, set: ReferenceDescriptors): ReferenceComparison {
  const undecided: string[] = [];
  const score = (id: string, d: StructureDescriptor) => {
    if (similarityDetail(candidate, d).coverage < MIN_COVERAGE) {
      undecided.push(id);
      return null;
    }
    return { id, similarity: structuralSimilarity(candidate, d) };
  };
  const close = (list: { id: string; descriptor: StructureDescriptor }[], min: number) =>
    list
      .map((e) => score(e.id, e.descriptor))
      .filter((m): m is ReferenceMatch => m !== null && m.similarity >= min)
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
  return {
    too_close_to_success: close(set.success, THRESHOLDS.too_close_to_reference),
    close_to_rejected: close(set.rejected, CLOSE_TO_REJECTED),
    undecided: undecided.sort(),
    advisory: true,
  };
}
