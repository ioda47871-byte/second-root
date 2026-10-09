import { z } from "zod";
import { DesignProfileSchema } from "@/lib/design-agent/profile";
import { DESIGN_ERROR_CODE, DESIGN_MAX_ATTEMPTS, DESIGN_STATUSES, WORKER_COMMIT } from "./design";

// The narrow bridge API (DEV-030): POST /api/internal/sales-design/jobs.
// One schema module for both sides, the server (app/api/internal/
// sales-design/jobs) and the local bridge (lib/design-agent/bridge/), so
// what the bridge may send is exactly what the server accepts.
//
// Everything is strict: an unknown key (a screenshot, raw HTML, a cookie, a
// prompt, Codex's output, stderr, a reasoning text) fails validation and
// nothing is written. The only free-form value in a submit is the
// DesignProfile, itself an enum-only schema whose rationale must be empty.

/** The keys of sales_demos.content a design job carries (the fact-only DemoView's inputs). */
export const DESIGN_FACT_KEYS = ["name", "category", "ward", "address", "hours", "closed_days", "access", "phone", "description", "menu_items"] as const;

/** The worker's job id for a bridge job: fixed prefix + the server's job id (worker JOB_ID pattern). */
export function workerJobIdFor(jobId: string): string {
  return `b-${jobId.toLowerCase()}`;
}
export const WORKER_JOB_ID = /^b-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const factText = (max: number) => z.string().min(1).max(max);

export const DesignFactsSchema = z.strictObject({
  name: factText(200),
  category: z.enum(["bakery", "baked_goods", "cafe"]),
  ward: factText(20).optional(),
  address: factText(300).optional(),
  hours: factText(500).optional(),
  closed_days: factText(500).optional(),
  access: factText(500).optional(),
  phone: factText(30).optional(),
  description: factText(500).optional(),
  menu_items: z.array(factText(100)).max(12).optional(),
});
export type DesignFacts = z.infer<typeof DesignFactsSchema>;

/** A job as the server hands it out (the claim answer). */
export const DesignJobSchema = z
  .strictObject({
    jobId: z.uuid(),
    workerJobId: z.string().regex(WORKER_JOB_ID),
    attempt: z.number().int().min(1).max(DESIGN_MAX_ATTEMPTS),
    facts: DesignFactsSchema,
    source: z
      .strictObject({ website_url: z.string().max(300).optional(), instagram_url: z.string().max(200).optional() })
      .refine((s) => s.website_url !== undefined || s.instagram_url !== undefined, { message: "a source is required" }),
  })
  .refine((j) => j.workerJobId === workerJobIdFor(j.jobId), { message: "workerJobId must match jobId" });
export type DesignJob = z.infer<typeof DesignJobSchema>;

export const DESIGN_OUTCOMES = ["ready", "blocked", "failed"] as const;

const submitBody = z.strictObject({
  action: z.literal("submit"),
  jobId: z.uuid(),
  outcome: z.enum(DESIGN_OUTCOMES),
  profile: DesignProfileSchema.nullable(),
  errorCode: z.string().regex(DESIGN_ERROR_CODE).nullable(),
  workerCommit: z.string().regex(WORKER_COMMIT).nullable(),
  lineage: z.strictObject({ workerJobId: z.string().regex(WORKER_JOB_ID) }),
});
export type DesignSubmit = z.infer<typeof submitBody>;

export const designBridgeRequest = z
  .discriminatedUnion("action", [z.strictObject({ action: z.literal("claim") }), submitBody])
  .superRefine((body, ctx) => {
    if (body.action !== "submit") return;
    if ((body.outcome === "ready") !== (body.profile !== null)) ctx.addIssue({ code: "custom", path: ["profile"], message: "profile only with ready" });
    if ((body.outcome === "ready") !== (body.errorCode === null)) ctx.addIssue({ code: "custom", path: ["errorCode"], message: "errorCode only without ready" });
    if (body.profile && body.profile.rationale.length > 0) ctx.addIssue({ code: "custom", path: ["profile", "rationale"], message: "rationale must be empty" });
    if (body.lineage.workerJobId !== workerJobIdFor(body.jobId)) ctx.addIssue({ code: "custom", path: ["lineage", "workerJobId"], message: "lineage mismatch" });
  });
export type DesignBridgeRequest = z.infer<typeof designBridgeRequest>;

/** What submit answers (and the bridge checks). */
export const DesignResultSchema = z.strictObject({
  jobId: z.uuid(),
  status: z.enum(DESIGN_STATUSES),
  errorCode: z.string().regex(DESIGN_ERROR_CODE).nullable(),
  attempts: z.number().int().min(0).max(DESIGN_MAX_ATTEMPTS),
  replayed: z.boolean(),
});
export type DesignResult = z.infer<typeof DesignResultSchema>;

export const ClaimResponseSchema = z.strictObject({ job: DesignJobSchema.nullable() });
export const SubmitResponseSchema = z.strictObject({ result: DesignResultSchema });
