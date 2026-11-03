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
 *   refs  a cited (or set-aside) case is one of the 20 ChatGPT-viewed cases, the principle exists, and the case is tagged with that
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
export const REFERENCE_MODES = ["TEXT_ONLY_PROVISIONAL", "VISUAL_VERIFIED", "MISSING_OR_HOLD"] as const;
export type ReferenceMode = (typeof REFERENCE_MODES)[number];
export type SetCheck = { status: "READY_FOR_COMPS" | "HOLD"; findings: Finding[]; note: string; reference_mode: ReferenceMode };

const NOTE = "READY_FOR_COMPS means only that the machine-checkable parts hold and no designer answer is 'no'. It is not a quality verdict: the owner decides on real PC/SP pictures.";

/**
 * Text compared for "the same": width (NFKC), case, spaces, digits (ASCII, full-width and the kanji numerals) and
 * punctuation do not make two lines different. Roman numerals and other number words are not stripped (a known limit).
 */
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\d〇零一二三四五六七八九十百千万\p{P}\p{S}]/gu, "");

/** Character-bigram Jaccard of two normalised lines (0..1); an empty line is similar to nothing. */
function similar(a: string, b: string): number {
  const [p, q] = [norm(a), norm(b)];
  if (!p || !q) return 0;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(s.length - 1, 1) }, (_, i) => s.slice(i, i + 2)));
  const [x, y] = [grams(p), grams(q)];
  const inter = [...x].filter((g) => y.has(g)).length;
  return inter / (x.size + y.size - inter);
}

/** Share of one multiset found in the other (matched one to one), over the larger size. */
function bagOverlap(a: readonly string[], b: readonly string[]): number {
  const rest = [...b];
  let n = 0;
  for (const v of a) {
    const i = rest.indexOf(v);
    if (i >= 0) {
      n++;
      rest.splice(i, 1);
    }
  }
  return n / Math.max(a.length, b.length, 1);
}

/** A direction's facets with the prefix and suffix that all of them share removed (so padding every line does not hide a copy). */
function coreFacets(d: Direction): string[] {
  const f = d.sections.map((x) => norm(x.motif_facet));
  if (f.length < 2) return f;
  let pre = 0;
  while (pre < Math.min(...f.map((x) => x.length)) && f.every((x) => x[pre] === f[0]![pre])) pre++;
  let suf = 0;
  while (suf < Math.min(...f.map((x) => x.length)) - pre && f.every((x) => x[x.length - 1 - suf] === f[0]![f[0]!.length - 1 - suf])) suf++;
  return f.map((x) => x.slice(pre, x.length - suf));
}

/**
 * The body (every section but the last: every page ends at the visit) of a and b compared one to one.
 *   copied   a section with the same id, ground and layout, or a facet that reads nearly the same (bigram similarity
 *            >= 0.7 after the padding all facets of a direction share is removed, and >= 0.6 as written, so that two
            directions naming the same stages through different lenses are not a copy)
 *   pairs    the same (ground, layout) pair in the same place
 * This is a lexical check; a thorough rewrite of every line gets past it. The owner's review of the comps decides.
 */
function bodyOverlap(a: Direction, b: Direction): { copied: number; pairs: number; n: number } {
  const n = Math.min(a.sections.length, b.sections.length) - 1;
  const [fa, fb] = [coreFacets(a), coreFacets(b)];
  const rest = b.sections.slice(0, -1).map((y, j) => ({ y, core: fb[j]! }));
  let copied = 0;
  a.sections.slice(0, -1).forEach((x, i) => {
    const k = rest.findIndex(({ y, core }) => (x.id === y.id && norm(x.ground) === norm(y.ground) && x.layout === y.layout) || (similar(fa[i]!, core) >= 0.7 && similar(x.motif_facet, y.motif_facet) >= 0.6));
    if (k >= 0) {
      copied++;
      rest.splice(k, 1);
    }
  });
  let pairs = 0;
  for (let i = 0; i < n; i++) if (norm(a.sections[i]!.ground) === norm(b.sections[i]!.ground) && a.sections[i]!.layout === b.sections[i]!.layout) pairs++;
  return { copied, pairs, n };
}

export type CheckInputs = {
  shopId: string;
  factIds: readonly string[];
  factsSha256: string;
  viewedCases: readonly string[];
  principleIds: readonly string[];
  /** case id -> the principles principles-v1.json tags it with */
  casePrinciples: Readonly<Record<string, readonly string[]>>;
  /** principles-v1.json `visual_mode` (TEXT_ONLY_PROVISIONAL until Claude's own reads back the principles). */
  referenceMode: ReferenceMode;
};

/** The set against its shop's facts (shop, ids and SHA) and the principles data (ChatGPT-viewed cases, principles per case). */
export function checkDirectionSet(raw: unknown, o: CheckInputs): SetCheck {
  const parsed = DirectionSet.safeParse(raw);
  if (!parsed.success) return { status: "HOLD", findings: [{ check: "schema", code: "SET_SCHEMA", detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }], note: NOTE, reference_mode: o.referenceMode };
  const s = parsed.data;
  const f: Finding[] = [];
  if (o.referenceMode === "MISSING_OR_HOLD") f.push({ check: "refs", code: "REFERENCE_MODE_HOLD" });
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
      // the body (see bodyOverlap). Held when: every body section is copied; or half of 4+ body sections are; or half are
      // and the layouts (all sections, the visit included) nearly match; or 3+ and 60% of the places repeat the same
      // ground and layout; or 4+ body sections have exactly the same layouts. Pages that only share the shop's facts
      // (a class, a visit) are not held.
      const { copied, pairs, n } = bodyOverlap(a, b);
      const layouts = bagOverlap(a.sections.map((x) => x.layout), b.sections.map((x) => x.layout));
      const half = copied >= 2 && copied * 2 >= n;
      if ((n >= 2 && copied === n) || (half && (n >= 4 || layouts >= 0.8)) || (pairs >= 3 && pairs >= 0.6 * n) || (layouts === 1 && n >= 4))
        f.push({ check: "C2", code: "SECTIONS_SHARED", direction: `${a.id}|${b.id}`, detail: `copied:${copied}/${n},pairs:${pairs},layouts:${layouts.toFixed(2)}` });
      // the designer's evidence is per direction (nearly the same text counts as copied)
      for (const c of CHECKS) if (similar(a.checklist[c].evidence, b.checklist[c].evidence) >= 0.9) f.push({ check: c, code: "EVIDENCE_COPIED", direction: `${a.id}|${b.id}` });
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
    if (facets.some((x) => !x)) f.push({ check: "C3", code: "MOTIF_FACET_EMPTY", direction: d.id });
    if (new Set(facets).size < Math.max(2, d.sections.length - 1)) f.push({ check: "C3", code: "MOTIF_FACETS_REPEATED", direction: d.id });
    if (new Set(d.sections.map((x) => x.id)).size !== d.sections.length) f.push({ check: "C3", code: "SECTION_IDS_DUPLICATED", direction: d.id });
    // C4: the phone plan is its own
    const sp = [d.sp_plan.first_screen, d.sp_plan.reorder, d.sp_plan.overlaps].map(norm);
    if (sp.some((t) => t === norm(d.pc_plan)) || new Set(sp).size < 3) f.push({ check: "C4", code: "SP_PLAN_NOT_SEPARATE", direction: d.id });
    // refs: only the ChatGPT-viewed cases, only known principles
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
      if (d.checklist[c].answer === "yes" && f.some((x) => x.check === c && !["DESIGNER_ANSWERED_NO", "EVIDENCE_COPIED"].includes(x.code) && (x.direction === undefined || x.direction.split("|").includes(d.id))))
        f.push({ check: c, code: "ANSWER_CONTRADICTED_BY_CHECK", direction: d.id });
  return { status: f.length ? "HOLD" : "READY_FOR_COMPS", findings: f, note: NOTE, reference_mode: o.referenceMode };
}
