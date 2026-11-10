import { checkpointProblem } from "./checkpoint";
import { containsContactOrLink } from "./draft";

// DEV-195: why a shop was chosen (selection rationale) and what could be
// improved for it (improvement hypothesis). Both are optional and written by
// someone — Operational Claude through ingest, or the owner in the admin —
// and stored with that provenance (sales_prospect_insights). Nothing here
// ever makes one up: a missing note is shown as 未確認.

export const INSIGHT_KINDS = ["selection_rationale", "improvement_hypothesis"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

/** Same bound as the sales_prospect_insights check. */
export const MAX_INSIGHT_LENGTH = 300;

export const INSIGHT_LABEL: Record<InsightKind, string> = {
  selection_rationale: "選んだ理由（記録）",
  improvement_hypothesis: "改善の仮説",
};

export type InsightProblem = "too_long" | "contact_or_link" | "unsafe_content";

/** The trimmed note, null for an empty one (= remove), or why it cannot be stored. */
export function checkInsight(value: string): { ok: true; body: string | null } | { ok: false; reason: InsightProblem } {
  const body = value.trim();
  if (body.length === 0) return { ok: true, body: null };
  if (body.length > MAX_INSIGHT_LENGTH) return { ok: false, reason: "too_long" };
  if (containsContactOrLink(body)) return { ok: false, reason: "contact_or_link" };
  if (checkpointProblem(body) !== null) return { ok: false, reason: "unsafe_content" };
  return { ok: true, body };
}

export const INSIGHT_PROBLEM_LABEL: Record<InsightProblem, string> = {
  too_long: `長すぎます（${MAX_INSIGHT_LENGTH}文字まで）。`,
  contact_or_link: "メールアドレスや URL は入れられません。",
  unsafe_content: "入れられない内容（HTML や鍵のような文字列）が含まれています。",
};

/** As stored in the run checkpoint (snake_case, like the rest of the prepared candidate). */
export type PreparedInsights = Partial<Record<InsightKind, string>>;

/**
 * The ingest input's optional notes → the ones that may be stored. A note
 * that does not pass (not a string, too long, contact details, links, unsafe
 * content) is dropped, never fixed up, and unknown keys are ignored (PR #239
 * L4); undefined when none is left, so a candidate without notes is prepared
 * exactly as before.
 */
export function preparedInsights(input: unknown): PreparedInsights | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const out: PreparedInsights = {};
  for (const [kind, value] of [
    ["selection_rationale", raw.selectionRationale],
    ["improvement_hypothesis", raw.improvementHypothesis],
  ] as const) {
    // Only an own string property; anything else (and any other key) is ignored.
    if (typeof value !== "string" || value.length > 2000) continue;
    const checked = checkInsight(value);
    if (checked.ok && checked.body) out[kind] = checked.body;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One stored note as the admin reads it (RLS: admin only). */
export type InsightRow = {
  kind: string;
  body: string;
  source: string;
  run_id: string | null;
  written_at: string;
};

export type Insight = {
  kind: InsightKind;
  body: string;
  source: "ingest" | "owner";
  runId: string | null;
  writtenAt: string;
};

/** Stored rows → one note per kind; rows of unknown shape are dropped. */
export function mapInsights(rows: InsightRow[] | null | undefined): Partial<Record<InsightKind, Insight>> {
  const out: Partial<Record<InsightKind, Insight>> = {};
  for (const r of rows ?? []) {
    if (!r || !(INSIGHT_KINDS as readonly string[]).includes(r.kind) || typeof r.body !== "string" || r.body.trim() === "") continue;
    if (r.source !== "ingest" && r.source !== "owner") continue;
    out[r.kind as InsightKind] = { kind: r.kind as InsightKind, body: r.body, source: r.source, runId: r.run_id ?? null, writtenAt: r.written_at };
  }
  return out;
}
