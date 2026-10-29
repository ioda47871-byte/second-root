/**
 * DEV-120: the INTAKE of research cases the owner reported as adopted but whose originals have not been checked
 * (CP-026..CP-032 today). It is a holding area, kept apart from the research set:
 *
 * - The Design Intelligence adapter (corpus.ts) never reads it. A case reaches the research set only by being added
 *   to the research manifest and success patterns (PR #142's files), after its originals are checked.
 * - The owner HAS adopted these cases (30 adopted = 23 registered on PR #142 + 7 here). `counted_in_registered_dataset:
 *   false` means only that a case is not yet in the registered research dataset (the manifest the adapter checks); it
 *   does not withdraw the adoption. The report always says the case is not promotable from here.
 * - Whether a case is a still-image study or a local web prototype is recorded (`research_form`), never assumed; a
 *   deliverable the study never had is recorded as `not_implemented`.
 * - Evidence is either `missing` or `recorded_unverified` (a SHA-256 or a cited research record). There is
 *   deliberately no "verified" state: nothing here checks a file, so nothing here can claim one was checked.
 * - An intake ID must not already be a registered research case. The caller passes the registered IDs: this check
 *   is only as good as that list (the promotion step should pass the research manifest's IDs).
 *
 * Pure: imports only zod. No file access, network, model or Codex.
 */
import { z } from "zod";

export class IntakeError extends Error {
  readonly code: string;
  constructor(code: string, readonly detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "IntakeError";
    this.code = code;
  }
}

/** Evidence a case needs before it can be proposed for the research set. Files are anchored by SHA-256, the rest by a research record. */
export const FILE_EVIDENCE = ["adopted_image", "desktop_full_page_capture", "mobile_full_page_capture", "html_source", "research_zip"] as const;
export const RECORD_EVIDENCE = [
  "owner_adoption_quote",
  "design_analysis",
  "rejected_versions_history",
  "web_presence_and_source",
  "image_and_material_rights",
  "identity_lock_check",
] as const;
export const VALUE_EVIDENCE = ["shop_category"] as const;
export const EVIDENCE_KINDS = [...FILE_EVIDENCE, ...RECORD_EVIDENCE, ...VALUE_EVIDENCE] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const Text = (max: number) =>
  z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]|<<<|>>>|<\s*\/?\s*[a-z!]/i.test(s), "unsafe_text");
const CaseId = z.string().regex(/^CP-\d{3}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Commit = z.string().regex(/^[0-9a-f]{40}$/);
const ResearchRef = z.string().regex(/^design-library\/[A-Za-z0-9._/-]+\.md(#[A-Za-z0-9._-]+)?$/).refine((s) => !s.includes(".."), "path_traversal");

const Missing = z.object({ state: z.literal("missing") }).strict();
const FileRecorded = z.object({ state: z.literal("recorded_unverified"), sha256: Sha }).strict();
/**
 * A deliverable the study never had (a still-image study has no HTML, ZIP or full-page captures; a study may have
 * no mobile view). Recorded as not implemented, never assumed to exist. Only the adopted image itself is always required.
 */
const NotImplemented = z.object({ state: z.literal("not_implemented") }).strict();
const MAY_NOT_EXIST: readonly EvidenceKind[] = ["desktop_full_page_capture", "mobile_full_page_capture", "html_source", "research_zip"];
const RefRecorded = z.object({ state: z.literal("recorded_unverified"), ref: ResearchRef }).strict();
const ValueRecorded = z.object({ state: z.literal("recorded_unverified"), value: z.string().regex(/^[a-z0-9_]{2,80}$/) }).strict();

const Evidence = z
  .object({
    ...Object.fromEntries(FILE_EVIDENCE.map((k) => [k, MAY_NOT_EXIST.includes(k) ? z.union([Missing, FileRecorded, NotImplemented]) : z.union([Missing, FileRecorded])])),
    ...Object.fromEntries(RECORD_EVIDENCE.map((k) => [k, z.union([Missing, RefRecorded])])),
    ...Object.fromEntries(VALUE_EVIDENCE.map((k) => [k, z.union([Missing, ValueRecorded])])),
  } as unknown as Record<EvidenceKind, z.ZodTypeAny>)
  .strict();

export const ResearchIntake = z
  .object({
    schema: z.literal("research_intake_v1"),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    scope: z.literal("intake_unverified_not_a_research_set"),
    policy: z
      .object({
        /** Not yet added to the registered research dataset (PR #142's manifest). It does NOT withdraw the owner's adoption. */
        counted_in_registered_dataset: z.literal(false),
        approval_for_generation: z.literal(false),
        not_templates: z.literal(true),
        read_by_design_intelligence_adapter: z.literal(false),
      })
      .strict(),
    baseline: z
      .object({
        research_pr: z.number().int().positive(),
        research_pr_head: Commit,
        develop: Commit,
        /** Research the owner formally adopted, registered or not. */
        owner_adopted_research_total: z.number().int().nonnegative(),
        /** Of those, registered on PR #142 and checkable by the adapter. */
        registered_success_cases: z.number().int().nonnegative(),
        local_html_css_js_poc: z.number().int().nonnegative(),
        concept_image_only: z.number().int().nonnegative(),
        /** Adopted, originals not checked, not registered: the records of this file. */
        adopted_not_registered: z.number().int().nonnegative(),
        not_success: z.array(CaseId),
      })
      .strict()
      .refine((b) => b.local_html_css_js_poc + b.concept_image_only === b.registered_success_cases, "baseline_counts_do_not_add_up")
      .refine((b) => b.registered_success_cases + b.adopted_not_registered === b.owner_adopted_research_total, "adopted_total_does_not_add_up"),
    records: z
      .array(
        z
          .object({
            id: CaseId,
            title: Text(160),
            version_label: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
            /** The owner adopted it; only the originals are not checked yet. Not a withdrawal of the adoption. */
            adoption: z.object({ state: z.literal("owner_adopted_originals_not_checked"), reported_in: z.string().regex(/^[a-z0-9_]{2,80}$/) }).strict(),
            /** Still-image study or local web prototype; `unknown` until the originals say. Never assumed. */
            research_form: z.enum(["unknown", "static_image_study", "local_web_poc"]),
            evidence: Evidence,
            counted_in_registered_dataset: z.literal(false),
          })
          .strict()
          .superRefine((rec, ctx) => {
            const ev = rec.evidence as Record<EvidenceKind, { state: string }>;
            const notImpl = MAY_NOT_EXIST.filter((k) => ev[k].state === "not_implemented");
            // "not implemented" is said only once the form is known, and a web prototype always has its HTML
            if (notImpl.length && rec.research_form === "unknown") ctx.addIssue({ code: "custom", message: "not_implemented_needs_known_form", path: ["research_form"] });
            if (rec.research_form === "local_web_poc" && ev.html_source.state === "not_implemented") ctx.addIssue({ code: "custom", message: "web_poc_without_html", path: ["evidence", "html_source"] });
          }),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine((i) => i.records.length === i.baseline.adopted_not_registered, "adopted_not_registered_does_not_match_records");

export type IntakeReport = {
  as_of: string;
  counts: { intake_records: number; counted_in_registered_dataset: 0; promotable: 0 };
  records: { id: string; title: string; version_label: string; research_form: "unknown" | "static_image_study" | "local_web_poc"; recorded_unverified: EvidenceKind[]; not_implemented: EvidenceKind[]; missing: EvidenceKind[]; promotable: false; blockers: string[] }[];
};

/**
 * Checks an intake file and reports, per case, what is recorded (unverified) and what is missing. Never promotes:
 * `promotable` is always false, because the originals have to be checked by a person and the case added to the
 * research manifest and success patterns, which this file is not.
 */
export function checkIntake(json: unknown, o: { registeredCaseIds: readonly string[] }): IntakeReport {
  const r = ResearchIntake.safeParse(json);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join(".") ?? "";
    throw new IntakeError("INTAKE_SCHEMA_INVALID", where);
  }
  const intake = r.data;
  const ids = intake.records.map((x) => x.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new IntakeError("INTAKE_DUPLICATE_ID", dup);
  const taken = ids.filter((id) => o.registeredCaseIds.includes(id) || intake.baseline.not_success.includes(id));
  if (taken.length) throw new IntakeError("INTAKE_ID_ALREADY_REGISTERED", taken.join(","));
  return {
    as_of: intake.as_of,
    counts: { intake_records: intake.records.length, counted_in_registered_dataset: 0, promotable: 0 },
    records: intake.records.map((rec) => {
      const ev = rec.evidence as Record<EvidenceKind, { state: string }>;
      const missing = EVIDENCE_KINDS.filter((k) => ev[k].state === "missing");
      return {
        id: rec.id,
        title: rec.title,
        version_label: rec.version_label,
        research_form: rec.research_form,
        recorded_unverified: EVIDENCE_KINDS.filter((k) => ev[k].state === "recorded_unverified"),
        not_implemented: EVIDENCE_KINDS.filter((k) => ev[k].state === "not_implemented"),
        missing,
        promotable: false as const,
        blockers: [...missing.map((k) => `missing:${k}`), "originals_not_checked_by_a_person", "not_in_research_manifest_and_success_patterns"],
      };
    }),
  };
}
