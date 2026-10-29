/**
 * DEV-120: the INTAKE of research cases the owner reported as adopted but whose originals have not been checked
 * (CP-026..CP-032 today). It is a holding area, kept apart from the research set:
 *
 * - The Design Intelligence adapter (corpus.ts) never reads it. A case reaches the research set only by being added
 *   to the research manifest and success patterns (PR #142's files), after its originals are checked.
 * - Nothing here counts toward the success total: every record says `counts_toward_success: false`, and the report
 *   always says the case is not promotable.
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
export const FILE_EVIDENCE = ["approved_desktop_full_page_image", "approved_mobile_full_page_image", "html_source", "research_zip"] as const;
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
/** An image-only study has no HTML or ZIP: that is recorded, not left as missing for ever. */
const NotApplicable = z.object({ state: z.literal("not_applicable_image_only") }).strict();
const POC_ONLY: readonly EvidenceKind[] = ["html_source", "research_zip"];
const RefRecorded = z.object({ state: z.literal("recorded_unverified"), ref: ResearchRef }).strict();
const ValueRecorded = z.object({ state: z.literal("recorded_unverified"), value: z.string().regex(/^[a-z0-9_]{2,80}$/) }).strict();

const Evidence = z
  .object({
    ...Object.fromEntries(FILE_EVIDENCE.map((k) => [k, POC_ONLY.includes(k) ? z.union([Missing, FileRecorded, NotApplicable]) : z.union([Missing, FileRecorded])])),
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
        counts_toward_success: z.literal(false),
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
        success_cases: z.number().int().nonnegative(),
        local_html_css_js_poc: z.number().int().nonnegative(),
        concept_image_only: z.number().int().nonnegative(),
        not_success: z.array(CaseId),
      })
      .strict()
      .refine((b) => b.local_html_css_js_poc + b.concept_image_only === b.success_cases, "baseline_counts_do_not_add_up"),
    records: z
      .array(
        z
          .object({
            id: CaseId,
            title: Text(160),
            version_label: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
            adoption: z.object({ state: z.literal("owner_adoption_reported_unverified"), reported_in: z.string().regex(/^[a-z0-9_]{2,80}$/) }).strict(),
            evidence: Evidence,
            counts_toward_success: z.literal(false),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type IntakeReport = {
  as_of: string;
  counts: { intake_records: number; counts_toward_success: 0; promotable: 0 };
  records: { id: string; title: string; version_label: string; recorded_unverified: EvidenceKind[]; not_applicable: EvidenceKind[]; missing: EvidenceKind[]; promotable: false; blockers: string[] }[];
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
    counts: { intake_records: intake.records.length, counts_toward_success: 0, promotable: 0 },
    records: intake.records.map((rec) => {
      const ev = rec.evidence as Record<EvidenceKind, { state: string }>;
      const missing = EVIDENCE_KINDS.filter((k) => ev[k].state === "missing");
      return {
        id: rec.id,
        title: rec.title,
        version_label: rec.version_label,
        recorded_unverified: EVIDENCE_KINDS.filter((k) => ev[k].state === "recorded_unverified"),
        not_applicable: EVIDENCE_KINDS.filter((k) => ev[k].state === "not_applicable_image_only"),
        missing,
        promotable: false as const,
        blockers: [...missing.map((k) => `missing:${k}`), "originals_not_checked_by_a_person", "not_in_research_manifest_and_success_patterns"],
      };
    }),
  };
}
