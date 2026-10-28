/**
 * DEV-113 Phase 2a: the SELECTION LEDGER — a machine-readable record of which
 * version of a research case the owner selected, rejected or left pending, and
 * why, checked against the research manifest.
 *
 * Three modes (chosen by the caller, never inferred):
 * - phase1_compat: no ledger is read. The Phase 1 output is unchanged.
 * - partial:       a ledger is required and every record in it must agree with
 *                  the manifest. Manifest cases with no record are listed as
 *                  `unledgered`, not blocked.
 * - strict:        as partial, and every manifest case must have a record. Even
 *                  then it ALWAYS stops with STRICT_APPROVAL_NOT_IMPLEMENTED:
 *                  approved research sets and verified owner approvals do not
 *                  exist yet. This is a safe not-yet-implemented state, not a
 *                  working strict mode.
 *
 * What the ledger can and cannot do:
 * - It never makes anything a success. Success comes only from the manifest
 *   status (corpus.ts). A ledger that says "selected" for a case or version the
 *   manifest does not hold as the selected one stops the load.
 * - A `ledger_assigned` label is an internal identifier for a version the
 *   manifest names no label for. It is not evidence of an owner-approved version.
 * - A quote is kept verbatim as the record of what the owner said. It is not
 *   new approval evidence either.
 * - The analyst's classification is kept in its own field, apart from the owner's words.
 * - An anchor ties a version to one manifest SHA field, chosen because a cited
 *   record says so (`evidence_ref`), never from the field's name. The anchor is
 *   only a recorded value: no state here says an image file was verified, so an
 *   image without its original is never a verified asset.
 *
 * Pure: imports only zod; corpus.ts passes the manifest cases in. No file
 * access, network, model or Codex.
 */
import { z } from "zod";

export const LEDGER_MODES = ["phase1_compat", "partial", "strict"] as const;
export type LedgerMode = (typeof LEDGER_MODES)[number];

export const SELECTION_STATUSES = [
  "owner_selected",
  "owner_conditionally_selected",
  "owner_rejected_explicit",
  "not_selected_in_relative_comparison",
  "awaiting_owner_review",
  "owner_preference_without_formal_adoption",
] as const;
export type SelectionStatus = (typeof SELECTION_STATUSES)[number];

export const QUOTE_KINDS = [
  "explicit_selection",
  "conditional_selection",
  "explicit_rejection",
  "relative_preference",
  "deferral",
  "preference_without_adoption",
] as const;

/** Which kind of owner statement can support each status. `null` in the list: no quote needed. */
const QUOTE_FOR_STATUS: Record<SelectionStatus, readonly (string | null)[]> = {
  owner_selected: ["explicit_selection"],
  owner_conditionally_selected: ["conditional_selection"],
  owner_rejected_explicit: ["explicit_rejection"],
  not_selected_in_relative_comparison: ["relative_preference"],
  awaiting_owner_review: [null, "deferral"],
  owner_preference_without_formal_adoption: ["preference_without_adoption", "relative_preference"],
};

const SELECTED: readonly SelectionStatus[] = ["owner_selected", "owner_conditionally_selected"];

/** Manifest fields that carry an owner-approved version label. */
export const MANIFEST_LABEL_FIELDS = { manifest_approved_version: "approved_version", manifest_owner_approved_version: "owner_approved_version" } as const;

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, readonly detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "LedgerError";
    this.code = code;
  }
}

const Text = (max: number) =>
  z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]|<<<|>>>|<\s*\/?\s*[a-z!]/i.test(s), "unsafe_text");
const CaseId = z.string().regex(/^CP-\d{3}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);
/** A research record (Markdown) the ledger cites. */
const ResearchRef = z.string().regex(/^design-library\/[A-Za-z0-9._/-]+\.md(#[A-Za-z0-9._-]+)?$/).refine((s) => !s.includes(".."), "path_traversal");

const OwnerDecisionEvidence = z
  .object({
    quote_verbatim: Text(1000),
    quote_kind: z.string(),
    source_ref: ResearchRef,
  })
  .strict();

const Anchor = z
  .object({
    manifest_field: z.string().regex(/^[a-z0-9_]{2,80}_sha256$/),
    sha256: Sha,
    /** The research record that says this field holds this version. Required: the field is never chosen from its name. */
    evidence_ref: ResearchRef,
    /** Recorded only. There is deliberately no "verified" value: nothing here checks a file. */
    verification: z.enum(["recorded_unverified", "original_unavailable"]),
  })
  .strict();

const Version = z
  .object({
    version_label: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    version_label_source: z.enum(["manifest_approved_version", "manifest_owner_approved_version", "ledger_assigned"]),
    selection_status: z.string(),
    owner_decision_evidence: OwnerDecisionEvidence.nullable(),
    anchor: Anchor.nullable(),
  })
  .strict();

const AnalystClassification = z
  .object({
    failure_reason_codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,60}$/)).max(20),
    classified_by: z.literal("analyst_not_owner"),
  })
  .strict();

export const SelectionLedger = z
  .object({
    schema: z.literal("selection_ledger_v1"),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    records: z
      .array(
        z
          .object({
            case_id: CaseId,
            versions: z.array(Version).min(1).max(20),
            analyst_classification: AnalystClassification.nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type SelectionLedger = z.infer<typeof SelectionLedger>;

/** One manifest case as corpus.ts has already checked it (an owner-selected research success). */
export type ManifestCaseInput = {
  id: string;
  conditional: boolean;
  /** The raw manifest record: labels and the per-case `*_sha256` fields. */
  fields: Record<string, unknown>;
};

export type LedgerReport = {
  mode: "partial";
  status: "partial_validation_only_not_strict";
  ledger_sha256: string;
  as_of: string;
  recorded_cases: string[];
  /** Owner-selected successes in the manifest with no ledger record: their versions are unknown. */
  unledgered_success_cases: string[];
  versions: {
    case_id: string;
    version_label: string;
    /** True for a `ledger_assigned` label: an internal identifier, not an owner-approved version label. */
    label_is_internal_identifier: boolean;
    selection_status: SelectionStatus;
    quote_kind: string | null;
    anchor: { manifest_field: string; verification: "recorded_unverified" | "original_unavailable" } | null;
  }[];
  notes: string[];
};

export const LEDGER_NOTES = [
  "Success comes from the manifest status only; the ledger cannot make a case or version a success.",
  "Owner quotes are checked as records of what the owner said, not as new approval evidence.",
  "ledger_assigned labels are internal identifiers, not owner-approved version labels.",
  "Anchors are recorded manifest values; no image here is a verified asset.",
  "Analyst classifications are the analyst's, not the owner's.",
] as const;

function parseLedger(value: unknown): SelectionLedger {
  const r = SelectionLedger.safeParse(value);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join(".") ?? "";
    throw new LedgerError("LEDGER_SCHEMA_INVALID", where);
  }
  return r.data;
}

/**
 * Checks a ledger against the manifest cases. Returns the partial report, or
 * throws a LedgerError. In strict mode it never returns.
 */
export function validateLedger(input: { ledger: unknown; ledgerSha256: string; manifestCases: ManifestCaseInput[]; mode: "partial" | "strict" }): LedgerReport {
  const ledger = parseLedger(input.ledger);
  const manifest = new Map(input.manifestCases.map((c) => [c.id, c]));

  const seenCases = new Set<string>();
  for (const rec of ledger.records) {
    if (seenCases.has(rec.case_id)) throw new LedgerError("LEDGER_DUPLICATE_CASE", rec.case_id);
    seenCases.add(rec.case_id);
    const m = manifest.get(rec.case_id);

    const labels = new Set<string>();
    const anchorFields = new Set<string>();
    for (const v of rec.versions) {
      const where = `${rec.case_id}/${v.version_label}`;
      if (!(SELECTION_STATUSES as readonly string[]).includes(v.selection_status)) throw new LedgerError("LEDGER_UNKNOWN_STATUS", where);
      const status = v.selection_status as SelectionStatus;
      if (labels.has(v.version_label)) throw new LedgerError("LEDGER_DUPLICATE_VERSION", where);
      labels.add(v.version_label);

      // the owner's words: a status that rests on a statement needs one, of a kind that supports it
      const allowed = QUOTE_FOR_STATUS[status];
      if (v.owner_decision_evidence === null) {
        if (!allowed.includes(null)) {
          // a ledger-assigned label with a selected status and no quote would make the label itself the approval
          if (v.version_label_source === "ledger_assigned" && SELECTED.includes(status)) throw new LedgerError("LEDGER_ASSIGNED_LABEL_AS_APPROVAL", where);
          throw new LedgerError("LEDGER_QUOTE_MISSING", where);
        }
      } else if (!(QUOTE_KINDS as readonly string[]).includes(v.owner_decision_evidence.quote_kind) || !allowed.includes(v.owner_decision_evidence.quote_kind)) {
        throw new LedgerError("LEDGER_QUOTE_KIND_MISMATCH", where);
      }

      // anchors: only a value the manifest holds for this case, each field for one version at most
      if (v.anchor) {
        if (!m) throw new LedgerError("LEDGER_ANCHOR_UNSUPPORTED", `${where}: case not in manifest`);
        if (m.fields[v.anchor.manifest_field] !== v.anchor.sha256) throw new LedgerError("LEDGER_ANCHOR_UNSUPPORTED", `${where}: ${v.anchor.manifest_field}`);
        if (anchorFields.has(v.anchor.manifest_field)) throw new LedgerError("LEDGER_ANCHOR_UNSUPPORTED", `${where}: field anchors two versions`);
        anchorFields.add(v.anchor.manifest_field);
      }
    }

    // agreement with the manifest: the ledger never creates or moves a success
    const selected = rec.versions.filter((v) => SELECTED.includes(v.selection_status as SelectionStatus));
    if (!m) {
      if (selected.length) throw new LedgerError("LEDGER_CONTRADICTS_MANIFEST", `${rec.case_id}: selected but not an owner success in the manifest`);
    } else {
      if (selected.length !== 1) throw new LedgerError("LEDGER_CONTRADICTS_MANIFEST", `${rec.case_id}: ${selected.length} selected versions for one manifest success`);
      const sel = selected[0]!;
      const want = m.conditional ? "owner_conditionally_selected" : "owner_selected";
      if (sel.selection_status !== want) throw new LedgerError("LEDGER_CONTRADICTS_MANIFEST", `${rec.case_id}: manifest says ${want}`);

      const manifestLabels = Object.entries(MANIFEST_LABEL_FIELDS)
        .map(([source, field]) => [source, m.fields[field]] as const)
        .filter((e): e is readonly [string, string] => typeof e[1] === "string");
      for (const v of rec.versions) {
        const isSel = v === sel;
        if (v.version_label_source !== "ledger_assigned") {
          const field = MANIFEST_LABEL_FIELDS[v.version_label_source];
          if (!isSel) throw new LedgerError("VERSION_LABEL_MISMATCH", `${rec.case_id}/${v.version_label}: only the selected version can carry the manifest label`);
          if (m.fields[field] !== v.version_label) throw new LedgerError("VERSION_LABEL_MISMATCH", `${rec.case_id}/${v.version_label}: manifest ${field}`);
        } else if (isSel && manifestLabels.length) {
          // the manifest names the approved version: the ledger may not replace it with its own label
          throw new LedgerError("VERSION_LABEL_MISMATCH", `${rec.case_id}/${v.version_label}: manifest has ${manifestLabels.map((e) => e[0]).join(",")}`);
        }
        if (!isSel && manifestLabels.some((e) => e[1] === v.version_label))
          throw new LedgerError("LEDGER_CONTRADICTS_MANIFEST", `${rec.case_id}/${v.version_label}: the manifest's approved label on a non-selected version`);
      }
    }
  }

  const unledgered = [...manifest.keys()].filter((id) => !seenCases.has(id)).sort();
  if (input.mode === "strict") {
    if (unledgered.length) throw new LedgerError("LEDGER_INCOMPLETE", unledgered.join(","));
    // Every ledger check passed. Strict still stops: approved research sets and verified owner approvals are not implemented (later PRs).
    throw new LedgerError("STRICT_APPROVAL_NOT_IMPLEMENTED", "strict mode is a safe not-yet-implemented state");
  }

  return {
    mode: "partial",
    status: "partial_validation_only_not_strict",
    ledger_sha256: input.ledgerSha256,
    as_of: ledger.as_of,
    recorded_cases: [...seenCases].sort(),
    unledgered_success_cases: unledgered,
    versions: ledger.records
      .flatMap((r) =>
        r.versions.map((v) => ({
          case_id: r.case_id,
          version_label: v.version_label,
          label_is_internal_identifier: v.version_label_source === "ledger_assigned",
          selection_status: v.selection_status as SelectionStatus,
          quote_kind: v.owner_decision_evidence?.quote_kind ?? null,
          anchor: v.anchor ? { manifest_field: v.anchor.manifest_field, verification: v.anchor.verification } : null,
        })),
      )
      .sort((a, b) => a.case_id.localeCompare(b.case_id) || a.version_label.localeCompare(b.version_label)),
    notes: [...LEDGER_NOTES],
  };
}
