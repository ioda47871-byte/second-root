import { z } from "zod";
import { CATEGORIES, LIMITS, REPLY_TYPES, SOURCE_TYPES, WEBSITE_STATUSES } from "./types";
import { isSafeHttpUrl } from "./url";

// Request schema for POST /api/internal/sales-agent/runs (docs/ARCHITECTURE.md
// §5). Every object is strict: unknown fields are rejected, never ignored.

const runId = z.uuid();
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "invalid candidate key");
const text = (max: number) => z.string().trim().min(1).max(max);
const safeUrl = z.string().max(2048).refine(isSafeHttpUrl, "unsafe or invalid URL");
const optionalUrl = safeUrl.nullable().optional();
const category = z.enum(CATEGORIES);

const FACT_FIELDS = ["name", "address", "hours", "closed_days", "access", "phone", "description", "menu_item"] as const;

export const discoveredStub = z.strictObject({
  key,
  name: text(200),
  category,
  ward: z.string().max(20).nullable().optional(),
  websiteUrl: optionalUrl,
  instagramUrl: optionalUrl,
});

export const fact = z.strictObject({
  field: z.enum(FACT_FIELDS),
  value: text(500),
  sourceUrl: safeUrl,
  sourceType: z.enum(SOURCE_TYPES),
  verifiedAt: z.iso.datetime({ offset: true }),
});

export const verifiedCandidateInput = z.strictObject({
  key,
  name: text(200),
  address: text(300),
  category: z.string().max(40),
  website: z.strictObject({
    status: z.enum(WEBSITE_STATUSES),
    url: optionalUrl,
    /** Independent searches for an official site (not_found needs ≥ 2). */
    checks: z.int().min(0).max(10),
  }),
  instagramUrl: optionalUrl,
  email: z
    .strictObject({
      address: z.string().max(254),
      sourceUrl: safeUrl,
      sourceType: z.enum(SOURCE_TYPES),
    })
    .nullable()
    .optional(),
  facts: z.array(fact).max(20),
  message: z.strictObject({
    subject: z.string().trim().max(100).nullable().optional(),
    body: text(1200),
  }),
});
export type VerifiedCandidateInput = z.infer<typeof verifiedCandidateInput>;

const uniqueKeys = (items: Array<{ key: string }>) => new Set(items.map((i) => i.key)).size === items.length;

const checkpointRequest = z.discriminatedUnion("phase", [
  z.strictObject({
    action: z.literal("checkpoint"),
    runId,
    phase: z.literal("discovered"),
    candidates: z.array(discoveredStub).max(LIMITS.discoveredPerRun).refine(uniqueKeys, "duplicate candidate keys"),
  }),
  z.strictObject({
    action: z.literal("checkpoint"),
    runId,
    phase: z.literal("verified"),
    candidates: z.array(verifiedCandidateInput).max(LIMITS.verifiedPerRun).refine(uniqueKeys, "duplicate candidate keys"),
  }),
]);

export const ingestRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start"), runId }),
  z.strictObject({ action: z.literal("status"), runId: runId.optional() }),
  checkpointRequest,
  z.strictObject({ action: z.literal("persist"), runId }),
  // Instagram inbox (DEV-021): read conversations that need a draft, and
  // submit a classification + reply draft. Nothing here can send.
  z.strictObject({ action: z.literal("inbox_pending"), limit: z.int().min(1).max(20).optional() }),
  z.strictObject({
    action: z.literal("inbox_draft"),
    threadId: z.uuid(),
    messageId: z.uuid(),
    replyType: z.enum(REPLY_TYPES),
    body: z.string().max(3000),
    futureContactRefused: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("abort"),
    runId,
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    errorSummary: z.string().max(500),
  }),
]);
export type IngestRequest = z.infer<typeof ingestRequest>;
