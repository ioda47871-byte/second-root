/**
 * Issue #302 P5: the design research log — what was made, where its pictures came from, what the owner decided and why,
 * and where to pick up next time. Pure (zod only).
 *
 * The committed log (design-library/research-log/) holds metadata only: SHA-256s, IDs, scores, and the owner's own
 * decision and reasons. Never the pictures, never the audit's findings text (those stay in the private review inbox).
 * Fictional shops only: a real shop's log is refused here (DEV-263h: a real shop's data never enters the repository).
 *
 * Nothing in this log is an approval. An entry never issues, claims or spends an approval ID, and an `adopt` decision
 * records the owner's choice; it does not register a CP-* research case (design-library/success-cases/).
 */
import { z } from "zod";

export const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const IsoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
const Text = z.string().min(1).max(400);

export const VIEWPORTS = ["desktop_1440", "mobile_390"] as const;
export const DECISIONS = ["adopt", "revise", "reject"] as const;
export const PHASES = [
  /** a run is delivered; the owner has not decided */
  "awaiting_owner_review",
  /** the owner asked for an improved version: write the brief and prompt, then ask for an approval */
  "improving",
  /** the improved prompt and packet are ready; generation waits for the owner's approval of that packet */
  "awaiting_generation_approval",
  /** the owner adopted the shop's design; the next shop is next */
  "adopted",
  /** the shop is set aside */
  "closed",
] as const;

/** One preview the owner and the auditor saw, tied to the original part in the sealed bundle. */
const Preview = z.strictObject({
  file: z.string().regex(/^(pc|sp)-\d{1,2}(-t\d{1,2}|-overview)?\.png$/),
  viewport: z.enum(VIEWPORTS),
  source: z.string().regex(/^parts\/[a-z0-9-]+\.png$/),
  source_sha256: Sha,
  preview_sha256: Sha,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const ViewportAudit = z.strictObject({ total: z.number().int().min(0).max(25), lowest: z.number().int().min(0).max(5), verdict: z.string().min(1).max(32), low_criteria: z.array(z.string().max(64)).max(10) });

/** One generated design: the run's provenance and the advisory audit's numbers (never its text). Write-once. */
export const ResearchEntry = z.strictObject({
  schema: z.literal("design_research_entry_v1"),
  entry_id: Slug,
  shop: Slug,
  fictional: z.literal(true),
  direction: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  /** 0 for the first run of a direction, then 1, 2, … for each improved version. */
  iteration: z.number().int().min(0).max(99),
  parent_entry_id: Slug.nullable(),
  provenance: z.strictObject({
    approval_id: Slug,
    plan_id: Slug,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    bundle_sha256: Sha,
    previews_index_sha256: Sha,
    previews: z.array(Preview).min(2).max(40),
  }),
  audit: z
    .strictObject({
      schema: z.string().max(64),
      rubric_version: z.string().max(64),
      rubric_sha256: Sha,
      audit_json_sha256: Sha,
      advisory_only: z.literal(true),
      verdict: z.string().min(1).max(32),
      viewports: z.strictObject({ desktop_1440: ViewportAudit, mobile_390: ViewportAudit }),
    })
    .nullable(),
  recorded_at: IsoTime,
});
export type ResearchEntry = z.infer<typeof ResearchEntry>;

/** The owner's decision on one entry, in the owner's terms. Append-only: a later decision supersedes, never edits. */
export const OwnerDecision = z.strictObject({
  schema: z.literal("design_research_decision_v1"),
  entry_id: Slug,
  seq: z.number().int().min(1).max(99),
  decision: z.enum(DECISIONS),
  decided_by: z.literal("owner"),
  /** The owner's words, as given in the chat (short). */
  owner_words: Text,
  /** What to keep in the next version, what to improve, and why. */
  keep: z.array(Text).max(12),
  improve: z.array(Text).max(12),
  reasons: z.array(Text).min(1).max(12),
  /** Claude wrote the file from the owner's words; it is not the owner's signature. */
  recorded_by: z.literal("claude"),
  decided_at: IsoTime,
});
export type OwnerDecision = z.infer<typeof OwnerDecision>;

/** Where the research stands. The only mutable file; every change also leaves the entry/decision trail. */
export const ResearchState = z.strictObject({
  schema: z.literal("design_research_state_v1"),
  current: z
    .strictObject({ shop: Slug, direction: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), entry_id: Slug.nullable(), phase: z.enum(PHASES), brief: z.string().regex(/^briefs\/[a-z0-9-]+\.md$/).nullable() })
    .nullable(),
  /** Fictional shops to study next, in order. "次の店へ" takes the first. */
  shop_queue: z.array(z.strictObject({ shop: Slug, note: Text })).max(50),
  /** One plain sentence: what the next session does first. */
  next_action: Text,
  /** Things only the owner can do before the next step (approvals, merges). Empty when nothing waits on the owner. */
  waiting_on_owner: z.array(Text).max(10),
  updated_at: IsoTime,
});
export type ResearchState = z.infer<typeof ResearchState>;
