/**
 * DEV-157 (Issue #193, improvement task T1): the record of a shop's motif and its three structurally different
 * directions (`art_direction_set_v0`), and the offline checks that can be made on it before any comp is drawn.
 *
 * The record is written by a designer (Claude or a person) at steps 2-3 of docs/design/quality-first-process.md. This
 * module checks what a machine can check, and only that:
 *   C1  the facts pack is the recorded one (bytes and shop); motif candidates cite facts that exist in it; each direction
 *       centres on a candidate (`motif_focus`) and the chosen motif is the focus of at least one direction
 *   C2  every two directions differ in hero AND flow (directionsDiffer), do not share a skeleton (structureFindings), and do
 *       not share a body (the same multiset of section layouts, or half the sections' facets): the hero/flow labels and the
 *       descriptor are both the designer's declarations, so their agreement alone cannot show two directions differ
 *   C3  every section names the facet of the motif it shows (not nearly the same text); the page has an ending (the field
 *       is required; that it names the last section is the designer's job)
 *   C4  the phone plan is written separately (first screen, reordering, overlaps) and is not the desktop plan
 *   C5  no direction has the generic landing-page skeleton. The schema already refuses a generic hero or flow (only
 *       HERO_MODES / PAGE_FLOWS), so the check that can fire is on the sections: half or more of them generic
 *       (split_copy_media / grid_cards) is LOWER_SECTIONS_GENERIC. GENERIC_SKELETON stays mapped in case the modes widen.
 *   refs  a cited (or set-aside) case is one of the 20 viewed cases, the principle exists, and the case is tagged with that
 *         principle (principles-v1.json); a case is not both used and set aside
 * The designer's evidence for each check must be written per direction: the same text in two directions holds.
 * C6 and C7 are judgement: only the designer's answer is recorded. A designer's "no" (or a machine finding against a
 * "yes") holds the set. A PASS means only "ready to draw comps"; it is never a quality verdict.
 *
 * Pure: zod and the structure module. The caller reads the files.
 */
import { z } from "zod";
import { directionsDiffer, HERO_MODES, PAGE_FLOWS, type OpenDirection } from "../phase2f/open-direction";
import { ASPECTS, GENERIC, StructureDescriptor, VOCABULARY, structureFindings } from "../structure/descriptor";

const Line = (max: number) => z.string().trim().min(1).max(max);
const SOURCES = ["object", "material", "process", "time", "space", "action", "physics"] as const;
const CHECKS = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"] as const;
const Answer = z.strictObject({ answer: z.enum(["yes", "no", "unknown"]), evidence: Line(600) });

const Section = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
  /** Which facet of the central motif this section shows (one line). */
  motif_facet: Line(200),
  ground: Line(80),
  layout: z.enum(VOCABULARY.section_layout),
  image_slots: z.array(z.strictObject({ role: Line(120), size: z.enum(["full", "large", "medium", "small"]) })).max(8),
});

export const Direction = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,40}$/),
  /** Which motif candidate this direction centres on (the three may share one or take different ones). */
  motif_focus: z.string().regex(/^M\d$/),
  concept: Line(900),
  composition: z.strictObject({ hero: z.enum(HERO_MODES), flow: z.enum(PAGE_FLOWS) }),
  /** The 8-aspect structure the direction declares (source "declared"). */
  descriptor: StructureDescriptor,
  sections: z.array(Section).min(3).max(12),
  /** Where the page ends and why it is an ending (the last section's role in the story). */
  ending: Line(300),
  pc_plan: Line(900),
  sp_plan: z.strictObject({ first_screen: Line(400), reorder: Line(400), overlaps: Line(400) }),
  /** What must not be lost when this direction is refined (principle P7). */
  protect: z.array(Line(200)).min(1).max(6),
  references: z.array(z.strictObject({ principle: z.string().regex(/^P\d$/), case_id: z.string().regex(/^CP-\d{3}$/), use: Line(300) })).min(1).max(6),
  not_used: z.array(z.strictObject({ case_id: z.string().regex(/^CP-\d{3}$/), reason: Line(300) })).max(6),
  checklist: z.strictObject(Object.fromEntries(CHECKS.map((c) => [c, Answer])) as Record<(typeof CHECKS)[number], typeof Answer>),
});
export type Direction = z.infer<typeof Direction>;

export const DirectionSet = z.strictObject({
  schema: z.literal("art_direction_set_v0"),
  shop_id: z.string().min(1).max(80),
  facts_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  motif: z.strictObject({
    candidates: z
      .array(z.strictObject({ id: z.string().regex(/^M\d$/), what: Line(200), source: z.enum(SOURCES), fact_refs: z.array(z.string().regex(/^F\d{1,3}$/)).min(1).max(8), becomes_structure: Line(300) }))
      .min(3)
      .max(6),
    chosen: z.string().regex(/^M\d$/),
    why: Line(600),
  }),
  directions: z.array(Direction).length(3),
});
export type DirectionSet = z.infer<typeof DirectionSet>;

export type Finding = { check: (typeof CHECKS)[number] | "refs" | "schema"; code: string; direction?: string; detail?: string };
export type SetCheck = { status: "READY_FOR_COMPS" | "HOLD"; findings: Finding[]; note: string };

const NOTE = "READY_FOR_COMPS means only that the machine-checkable parts hold and no designer answer is 'no'. It is not a quality verdict: the owner decides on real PC/SP pictures.";

/** Text compared for "the same": case, spaces, digits and punctuation do not make two lines different. */
const norm = (s: string) => s.toLowerCase().replace(/[\s\d\p{P}\p{S}]/gu, "");

export type CheckInputs = {
  shopId: string;
  factIds: readonly string[];
  factsSha256: string;
  viewedCases: readonly string[];
  principleIds: readonly string[];
  /** case id -> the principles principles-v1.json tags it with */
  casePrinciples: Readonly<Record<string, readonly string[]>>;
};

/** The set against its shop's facts (shop, ids and SHA) and the principles data (viewed cases, principles per case). */
export function checkDirectionSet(raw: unknown, o: CheckInputs): SetCheck {
  const parsed = DirectionSet.safeParse(raw);
  if (!parsed.success) return { status: "HOLD", findings: [{ check: "schema", code: "SET_SCHEMA", detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }], note: NOTE };
  const s = parsed.data;
  const f: Finding[] = [];
  if (s.facts_sha256 !== o.factsSha256) f.push({ check: "C1", code: "FACTS_SHA_MISMATCH" });
  if (s.shop_id !== o.shopId) f.push({ check: "C1", code: "SHOP_ID_MISMATCH", detail: `${s.shop_id}:${o.shopId}` });
  // C1
  const chosen = s.motif.candidates.find((c) => c.id === s.motif.chosen);
  if (!chosen) f.push({ check: "C1", code: "MOTIF_CHOSEN_UNKNOWN" });
  if (new Set(s.motif.candidates.map((c) => c.id)).size !== s.motif.candidates.length) f.push({ check: "C1", code: "MOTIF_IDS_DUPLICATED" });
  for (const c of s.motif.candidates) for (const r of c.fact_refs) if (!o.factIds.includes(r)) f.push({ check: "C1", code: "MOTIF_FACT_UNKNOWN", detail: `${c.id}:${r}` });
  const candidateIds = s.motif.candidates.map((c) => c.id);
  for (const d of s.directions) if (!candidateIds.includes(d.motif_focus)) f.push({ check: "C1", code: "MOTIF_FOCUS_UNKNOWN", direction: d.id, detail: d.motif_focus });
  if (chosen && !s.directions.some((d) => d.motif_focus === chosen.id)) f.push({ check: "C1", code: "MOTIF_CHOSEN_UNUSED" });
  // C2 and C5
  const ids = s.directions.map((d) => d.id);
  if (new Set(ids).size !== ids.length) f.push({ check: "C2", code: "DIRECTION_IDS_DUPLICATED" });
  const asOpen = (d: Direction) => ({ direction_id: d.id, composition: d.composition }) as unknown as OpenDirection;
  for (let i = 0; i < s.directions.length; i++)
    for (let j = i + 1; j < s.directions.length; j++) {
      const [a, b] = [s.directions[i]!, s.directions[j]!];
      if (!directionsDiffer(asOpen(a), asOpen(b))) f.push({ check: "C2", code: "HERO_OR_FLOW_SHARED", direction: `${a.id}|${b.id}` });
      // the body: the same layouts in any order, or half the facets of the shorter one repeated in the other
      const bag = (d: Direction) => d.sections.map((x) => x.layout).sort().join(",");
      const fa = new Set(a.sections.map((x) => norm(x.motif_facet)));
      const sharedFacets = b.sections.filter((x) => fa.has(norm(x.motif_facet))).length;
      if (bag(a) === bag(b) || sharedFacets * 2 >= Math.min(a.sections.length, b.sections.length))
        f.push({ check: "C2", code: "SECTIONS_SHARED", direction: `${a.id}|${b.id}`, detail: `facets:${sharedFacets}` });
      // the designer's evidence is per direction
      for (const c of CHECKS) if (norm(a.checklist[c].evidence) === norm(b.checklist[c].evidence)) f.push({ check: c, code: "EVIDENCE_COPIED", direction: `${a.id}|${b.id}` });
    }
  for (const d of s.directions) {
    // the declared composition and the descriptor must agree (else the hero/flow check could be gamed)
    if (d.descriptor.hero?.value !== d.composition.hero || d.descriptor.flow?.value !== d.composition.flow) f.push({ check: "C2", code: "DESCRIPTOR_COMPOSITION_MISMATCH", direction: d.id });
    const layouts = d.descriptor.section_layouts?.value ?? [];
    if (layouts.join(",") !== d.sections.map((x) => x.layout).join(",")) f.push({ check: "C2", code: "DESCRIPTOR_SECTIONS_MISMATCH", direction: d.id });
    const measured = ASPECTS.filter((k) => d.descriptor[k] && d.descriptor[k]!.source !== "declared");
    if (measured.length) f.push({ check: "C2", code: "DESCRIPTOR_NOT_DECLARED", direction: d.id, detail: measured.join(",") });
    const siblings = Object.fromEntries(s.directions.filter((x) => x.id !== d.id).map((x) => [x.id, x.descriptor]));
    for (const finding of structureFindings(d.descriptor, { siblings })) {
      if (finding.code === "SIBLINGS_SAME_SKELETON") f.push({ check: "C2", code: "SIBLINGS_SAME_SKELETON", direction: d.id, detail: `${finding.sibling}:${finding.similarity}` });
      if (finding.code === "GENERIC_SKELETON") f.push({ check: "C5", code: "GENERIC_SKELETON", direction: d.id, detail: finding.reasons.join(",") });
      // an aspect left unknown would make the sibling comparison skip it
      if (finding.code === "ASPECTS_UNKNOWN") f.push({ check: "C2", code: "DESCRIPTOR_ASPECTS_UNKNOWN", direction: d.id, detail: finding.aspects.join(",") });
    }
    const generic = d.sections.filter((x) => GENERIC.section_layout.has(x.layout)).length;
    if (generic * 2 >= d.sections.length) f.push({ check: "C5", code: "LOWER_SECTIONS_GENERIC", direction: d.id, detail: `${generic}/${d.sections.length}` });
    // C3: every section a facet, facets not all the same, an ending
    const facets = d.sections.map((x) => norm(x.motif_facet));
    if (new Set(facets).size < Math.max(2, d.sections.length - 1)) f.push({ check: "C3", code: "MOTIF_FACETS_REPEATED", direction: d.id });
    if (new Set(d.sections.map((x) => x.id)).size !== d.sections.length) f.push({ check: "C3", code: "SECTION_IDS_DUPLICATED", direction: d.id });
    // C4: the phone plan is its own
    const sp = [d.sp_plan.first_screen, d.sp_plan.reorder, d.sp_plan.overlaps].map(norm);
    if (sp.some((t) => t === norm(d.pc_plan)) || new Set(sp).size < 3) f.push({ check: "C4", code: "SP_PLAN_NOT_SEPARATE", direction: d.id });
    // refs: only the viewed cases, only known principles
    for (const r of d.references) {
      if (!o.viewedCases.includes(r.case_id)) f.push({ check: "refs", code: "REFERENCE_NOT_VIEWED", direction: d.id, detail: r.case_id });
      if (!o.principleIds.includes(r.principle)) f.push({ check: "refs", code: "PRINCIPLE_UNKNOWN", direction: d.id, detail: r.principle });
      else if (o.viewedCases.includes(r.case_id) && !(o.casePrinciples[r.case_id] ?? []).includes(r.principle))
        f.push({ check: "refs", code: "REFERENCE_PRINCIPLE_NOT_IN_CASE", direction: d.id, detail: `${r.principle}:${r.case_id}` });
    }
    for (const n of d.not_used) {
      if (!o.viewedCases.includes(n.case_id)) f.push({ check: "refs", code: "REFERENCE_NOT_VIEWED", direction: d.id, detail: n.case_id });
      if (d.references.some((r) => r.case_id === n.case_id)) f.push({ check: "refs", code: "REFERENCE_BOTH_USED_AND_NOT", direction: d.id, detail: n.case_id });
    }
    // the designer's answers: a "no" holds; a machine finding against a "yes" is recorded as a mismatch
    for (const c of CHECKS) if (d.checklist[c].answer === "no") f.push({ check: c, code: "DESIGNER_ANSWERED_NO", direction: d.id });
  }
  for (const d of s.directions)
    for (const c of ["C1", "C2", "C3", "C4", "C5"] as const)
      if (d.checklist[c].answer === "yes" && f.some((x) => x.check === c && x.code !== "DESIGNER_ANSWERED_NO" && (x.direction === undefined || x.direction.split("|").includes(d.id))))
        f.push({ check: c, code: "ANSWER_CONTRADICTED_BY_CHECK", direction: d.id });
  return { status: f.length ? "HOLD" : "READY_FOR_COMPS", findings: f, note: NOTE };
}
