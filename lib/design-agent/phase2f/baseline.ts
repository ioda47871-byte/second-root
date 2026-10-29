/**
 * DEV-121: a comparison BASELINE of a real Phase 2f-2 run, kept apart from the Design Artifact and the run's own
 * records. It records what one run produced and how it was judged, so a later run (e.g. route B with research) can be
 * compared against it. It is not an artifact and never stands in for one.
 *
 * - The generation facts use the Design Artifact's own `Generation` schema, so they mean the same thing.
 * - A stopped package means no formal artifact: `formal_artifact_passed` is false then, whatever the preview shows.
 * - A preview made by hand is marked as such, with every preview-only change named; Codex's answer is never changed.
 * - Quality has two separate parts: a provisional evaluation (by ChatGPT or Claude) and the owner's final decision.
 *   The owner's decision is `pending` until the owner gives it, with the quote; a provisional verdict is never it.
 *
 * Pure: imports only zod and the artifact schema. No file access, network, model or Codex.
 */
import { z } from "zod";
import { Generation, Text, VIEWPORTS } from "../artifact/schema";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const RepoPath = z.string().regex(/^design-library\/[A-Za-z0-9._/-]+\.json$/).refine((s) => !s.includes(".."), "path_traversal");
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/);
const Issue = z.string().regex(/^[a-z][a-z0-9_]{2,60}$/);

const PreviewImage = (width: number) =>
  z.strictObject({
    width: z.literal(width),
    height: z.number().int().positive().max(16000),
    bytes: z.number().int().positive(),
    sha256: Sha,
    /** The page's measured scrollWidth; above `width` means horizontal overflow. Null when not measured. */
    scroll_width: z.number().int().positive().nullable(),
  });

const OwnerDecision = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending"), quote_verbatim: z.null(), decided_on: z.null() }),
  z.strictObject({ status: z.enum(["adopted", "rejected"]), quote_verbatim: Text(1000), decided_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

export const Phase2fBaseline = z
  .strictObject({
    schema: z.literal("phase2f_baseline_v1"),
    baseline_id: z.string().regex(/^[a-z0-9][a-z0-9-]{3,80}$/),
    recorded_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shop: z.strictObject({ shop_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/), display_name: Text(120) }),
    route: z.enum(["A_image", "B_html_prototype", "C_hybrid"]),
    research_used: z.boolean(),
    role: z.enum(["comparison_baseline_without_research", "comparison_run_with_research"]),
    inputs: z.strictObject({ facts_pack: RepoPath, brief: RepoPath, prompt_sha256: Sha, prompt_chars: z.number().int().positive() }),
    generation: Generation,
    /** The research the prompt was built with (null without research): PR #142's head and the two files' SHA-256. */
    research_brief: z
      .strictObject({ research_pr_head: z.string().regex(/^[0-9a-f]{40}$/), manifest_sha256: Sha, patterns_sha256: Sha, case_ids: z.array(z.string().regex(/^CP-\d{3}$/)).min(1).max(10) })
      .nullable(),
    retry_of: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/).nullable(),
    package: z.strictObject({
      status: z.enum(["succeeded", "stopped"]),
      code: Code.nullable(),
      class: z.string().regex(/^[a-z]{2,20}$/).nullable(),
      artifact_created: z.boolean(),
    }),
    formal_artifact_passed: z.boolean(),
    preview: z
      .strictObject({
        kind: z.enum(["manual_preview_not_an_artifact_render", "artifact_render"]),
        answer_modified: z.literal(false),
        preview_only_changes: z.array(Issue).max(10),
        images: z.strictObject({ desktop_1440: PreviewImage(VIEWPORTS.desktop_1440), mobile_390: PreviewImage(VIEWPORTS.mobile_390) }),
        images_in_repository: z.boolean(),
      })
      .nullable(),
    quality: z.strictObject({
      provisional_evaluation: z.strictObject({ by: z.enum(["chatgpt", "claude"]), verdict: z.enum(["pass", "fail"]), issues: z.array(Issue).max(20) }).nullable(),
      owner_final_decision: OwnerDecision,
    }),
    source_of_values: z.string().regex(/^[a-z0-9_]{4,120}$/),
    notes: z.array(Text(300)).max(10),
  })
  .superRefine((b, ctx) => {
    const bad = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    // the role and the research flag say the same thing
    if (b.research_used !== (b.role === "comparison_run_with_research")) bad("role_and_research_disagree", ["research_used"]);
    // research is recorded exactly when it was used
    if (b.research_used !== (b.research_brief !== null)) bad("research_brief_and_flag_disagree", ["research_brief"]);
    // the run was made from the recorded prompt
    if (b.generation.prompt_sha256 !== b.inputs.prompt_sha256) bad("prompt_sha_mismatch", ["generation", "prompt_sha256"]);
    // a stopped package has its code and made no artifact; only a passing artifact may say it passed
    if (b.package.status === "stopped" && (!b.package.code || b.package.artifact_created)) bad("stopped_package_inconsistent", ["package"]);
    if (b.package.status === "succeeded" && (b.package.code !== null || !b.package.artifact_created || b.generation.status !== "succeeded")) bad("succeeded_package_inconsistent", ["package"]);
    // a formal pass needs a packaged artifact and its own render
    if (b.formal_artifact_passed && (b.package.status !== "succeeded" || b.preview?.kind !== "artifact_render")) bad("artifact_pass_without_artifact", ["formal_artifact_passed"]);
    // a hand-made preview is never the artifact's render, and a render exists only with an artifact
    if (b.preview?.kind === "artifact_render" && !b.package.artifact_created) bad("artifact_render_without_artifact", ["preview", "kind"]);
    if (b.preview?.kind === "manual_preview_not_an_artifact_render" && b.formal_artifact_passed) bad("manual_preview_cannot_pass", ["preview", "kind"]);
    // a horizontal overflow seen in the preview is in the provisional issues (each width)
    for (const [key, issue] of [["mobile_390", "mobile_horizontal_overflow"], ["desktop_1440", "desktop_horizontal_overflow"]] as const) {
      const img = b.preview?.images[key];
      if (img?.scroll_width && img.scroll_width > img.width && !b.quality.provisional_evaluation?.issues.includes(issue)) bad("overflow_not_recorded", ["quality", "provisional_evaluation"]);
    }
  });
export type Phase2fBaseline = z.infer<typeof Phase2fBaseline>;

export class BaselineError extends Error {
  constructor(readonly code: string, readonly detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BaselineError";
  }
}

/** Checks a baseline record; reports the owner's decision and the mobile overflow (px) as they are. */
export function checkBaseline(json: unknown): { baseline_id: string; research_used: boolean; formal_artifact_passed: boolean; owner_decision: "pending" | "adopted" | "rejected"; mobile_overflow_px: number | null } {
  const r = Phase2fBaseline.safeParse(json);
  if (!r.success) throw new BaselineError("BASELINE_INVALID", r.error.issues[0]?.path.join(".") ?? "");
  const b = r.data;
  const sp = b.preview?.images.mobile_390;
  return {
    baseline_id: b.baseline_id,
    research_used: b.research_used,
    formal_artifact_passed: b.formal_artifact_passed,
    owner_decision: b.quality.owner_final_decision.status,
    mobile_overflow_px: sp?.scroll_width ? Math.max(0, sp.scroll_width - sp.width) : null,
  };
}
