/**
 * DEV-112 Phase 1: a READ-ONLY view of the owner-selected design research
 * (PR #142, branch research/approved-editorial-cases-20261027) and of the
 * unreviewed reference candidates already on develop.
 *
 * - Reads JSON from a research checkout given at run time. It never fetches,
 *   writes, calls a model or Codex, or touches the worker / DB / sales code.
 * - Keeps three tiers apart: the owner-selected research successes, the
 *   unreviewed reference candidates and the pending review queue. Only the
 *   first may inform principles; the others are counted, never promoted.
 * - Fails closed: a missing file, a schema drift, a count mismatch or a
 *   policy string that changed stops the load with a fixed code.
 *
 * The research documents say nothing in them is auto-injected into a
 * generator. This module only produces a research brief for a Claude
 * session and the owner to read (docs/design/design-intelligence-integration-plan.md).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Files read from the research root (a checkout that contains the research branch's data). */
export const RESEARCH_FILES = {
  manifest: "design-library/success-cases/manifest.json",
  patterns: "design-library/intelligence/v01/success-patterns.json",
  queue: "design-library/intelligence/v01/review-queue.json",
  referencesV02: "design-library/research/v02/secondroot_design_library_v02_20261021.json",
  candidatesV03: ["design-library/research/v03/candidates-20261025-01.json", "design-library/research/v03/candidates-20261025-02.json"],
} as const;

export const TIERS = {
  success: "owner_selected_research_success",
  candidate: "unreviewed_reference_candidate",
  queue: "review_queue_pending",
} as const;

export type Implementation = "local_html_css_js_poc" | "concept_image_only";

export class CorpusError extends Error {
  readonly code: string;
  constructor(code: string, readonly detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CorpusError";
    this.code = code;
  }
}

/** Research text is data, never instructions: no control characters, no prompt fences, no markup tags, bounded. */
const Text = (max: number) =>
  z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]|<<<|>>>|<\s*\/?\s*[a-z!]/i.test(s), "unsafe_text");
const CaseId = z.string().regex(/^CP-\d{3}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

const PatternCase = z.object({
  id: CaseId,
  name: Text(160),
  category: z.string().regex(/^[a-z0-9_]{2,80}$/),
  owner_selection: z.string().regex(/^[a-zA-Z0-9_]{2,100}$/),
  implementation: z.enum(["local_html_css_js_poc", "concept_image_only"]),
  shop_motifs: z.array(Text(200)).min(2),
  structural_translation: Text(600),
  visual_mechanisms: z.array(Text(300)).min(1),
  why_selected: z.array(z.object({ statement: Text(400), basis: z.string().regex(/^[a-z_]{2,40}$/) })).min(1),
  known_failure_modes: z.array(Text(400)).min(1),
  not_to_copy: z.array(Text(300)).min(1),
  implementation_gap: Text(600),
  evidence_ref: z.string().regex(/^design-library\/success-cases\/CP-\d{3}-[A-Za-z0-9._-]+\.md$/),
});
export type PatternCase = z.infer<typeof PatternCase>;

const REQUIRED_DENY = [
  "copy_specific_composition",
  "copy_or_reuse_brand_logo_or_photography",
  "copy_specific_text_or_color_recipe",
  "claim_client_approval_or_website_launch",
  "feed_into_production_generators_without_separate_review",
] as const;

const Patterns = z.object({
  schema_version: z.literal(1),
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope: z.literal("research_only_not_auto_prompt_input"),
  status: z.literal("owner_selected_case_analysis_not_approved_for_automatic_reuse"),
  reuse_policy: z.object({
    deny: z.array(z.string()),
    design_principles_are_not_templates: z.literal(true),
    quality_gates: z.array(z.string().regex(/^[a-z_]{2,60}$/)).min(1),
  }),
  cases: z.array(PatternCase).min(1),
});

/** The manifest carries per-case ad-hoc *_sha256 keys; only the fields the adapter relies on are checked. */
const ManifestRecord = z
  .object({ id: CaseId, status: z.string().regex(/^owner_[a-z0-9_]+$/), view: z.string().regex(/^[a-z0-9_]{2,80}$/) })
  .passthrough();
const Manifest = z.object({
  schema_version: z.literal(1),
  records: z.array(ManifestRecord).min(1),
  policy: z
    .object({
      not_templates: z.literal(true),
      never_reuse_generated_photos_or_logos_for_other_shops: z.literal(true),
      release_or_deployment_approval: z.literal(false),
      do_not_mix_with_v02_v03_reference_candidate_counts: z.literal(true),
    })
    .passthrough(),
});

const Queue = z.object({
  schema_version: z.literal(1),
  status: z.literal("prioritized_research_queue_not_a_completed_audit"),
  queue: z.array(
    z
      .object({
        id: z.string().regex(/^DX-\d{3}$/),
        human_review: z.enum(["pending", "not_started"]),
        approval_for_generation: z.literal(false),
      })
      .passthrough(),
  ),
});

const RefsV02 = z.object({ references: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1) }).passthrough();
const CandV03 = z.object({
  status: z.literal("research_candidates_not_approved"),
  references: z.array(z.object({ id: z.string().regex(/^DX-\d{3}$/) }).passthrough()).min(1),
}).passthrough();

/** A manifest `view` names the approved form; any HTML/CSS/JS view is a local PoC, everything else an image concept. */
export function implementationFromView(view: string): Implementation {
  return /html_css_js/.test(view) ? "local_html_css_js_poc" : "concept_image_only";
}

export type ResearchCorpus = {
  as_of: string;
  source_sha256: Record<string, string>;
  /** Owner-selected research successes. Research only: not client work, not a template, not prompt input. */
  successes: (PatternCase & { tier: typeof TIERS.success; manifest_status: string; manifest_view: string })[];
  counts: {
    success_cases: number;
    local_html_css_js_poc: number;
    concept_image_only: number;
    unreviewed_reference_candidates: number;
    review_queue_pending: number;
  };
  reuse_policy: { deny: string[]; quality_gates: string[] };
};

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join(".") ?? "";
    throw new CorpusError("CORPUS_SCHEMA_INVALID", `${file}${where ? ` at ${where}` : ""}`);
  }
  return r.data;
}

/** Pure cross-check of already-read JSON values (exported for tests). */
export function buildCorpus(files: {
  manifest: unknown;
  patterns: unknown;
  queue: unknown;
  referencesV02: unknown;
  candidatesV03: unknown[];
  sha256: Record<string, string>;
}): ResearchCorpus {
  const manifest = parseOrThrow(Manifest, files.manifest, RESEARCH_FILES.manifest);
  const patterns = parseOrThrow(Patterns, files.patterns, RESEARCH_FILES.patterns);
  const queue = parseOrThrow(Queue, files.queue, RESEARCH_FILES.queue);
  const v02 = parseOrThrow(RefsV02, files.referencesV02, RESEARCH_FILES.referencesV02);
  const v03 = files.candidatesV03.map((c, i) => parseOrThrow(CandV03, c, RESEARCH_FILES.candidatesV03[i] ?? "candidates"));

  for (const d of REQUIRED_DENY) if (!patterns.reuse_policy.deny.includes(d)) throw new CorpusError("CORPUS_POLICY_CHANGED", d);

  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  const dup = (xs: string[]) => xs.find((x, i) => xs.indexOf(x) !== i);
  const caseIds = ids(patterns.cases);
  const recordIds = ids(manifest.records);
  const d1 = dup(caseIds) ?? dup(recordIds);
  if (d1) throw new CorpusError("CORPUS_DUPLICATE_ID", d1);
  const missing = caseIds.filter((id) => !recordIds.includes(id)).concat(recordIds.filter((id) => !caseIds.includes(id)));
  if (missing.length) throw new CorpusError("CORPUS_REGISTRY_MISMATCH", missing.sort().join(","));

  const byId = new Map(manifest.records.map((r) => [r.id, r]));
  const successes = patterns.cases.map((c) => {
    const rec = byId.get(c.id)!;
    if (implementationFromView(rec.view) !== c.implementation) throw new CorpusError("CORPUS_IMPLEMENTATION_MISMATCH", c.id);
    return { ...c, tier: TIERS.success, manifest_status: rec.status, manifest_view: rec.view };
  });

  const candidateIds = [...ids(v02.references), ...v03.flatMap((c) => ids(c.references))];
  const d2 = dup(candidateIds);
  if (d2) throw new CorpusError("CORPUS_DUPLICATE_ID", d2);
  const queueIds = ids(queue.queue);
  const d3 = dup(queueIds);
  if (d3) throw new CorpusError("CORPUS_DUPLICATE_ID", d3);
  const strayQueue = queueIds.filter((id) => !candidateIds.includes(id));
  if (strayQueue.length) throw new CorpusError("CORPUS_QUEUE_NOT_A_CANDIDATE", strayQueue.join(","));

  const poc = successes.filter((c) => c.implementation === "local_html_css_js_poc").length;
  return {
    as_of: patterns.as_of,
    source_sha256: files.sha256,
    successes: [...successes].sort((a, b) => a.id.localeCompare(b.id)),
    counts: {
      success_cases: successes.length,
      local_html_css_js_poc: poc,
      concept_image_only: successes.length - poc,
      unreviewed_reference_candidates: candidateIds.length,
      review_queue_pending: queueIds.length,
    },
    reuse_policy: { deny: [...patterns.reuse_policy.deny], quality_gates: [...patterns.reuse_policy.quality_gates] },
  };
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

async function readJson(root: string, rel: string, sha: Record<string, string>): Promise<unknown> {
  let buf: Buffer;
  try {
    buf = await readFile(join(root, rel));
  } catch {
    throw new CorpusError("CORPUS_FILE_MISSING", rel);
  }
  if (buf.length > MAX_FILE_BYTES) throw new CorpusError("CORPUS_FILE_TOO_LARGE", rel);
  sha[rel] = createHash("sha256").update(buf).digest("hex");
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new CorpusError("CORPUS_JSON_INVALID", rel);
  }
}

/** Reads and cross-checks the research corpus under `root`. Read-only. */
export async function loadResearchCorpus(root: string): Promise<ResearchCorpus> {
  const sha: Record<string, string> = {};
  const manifest = await readJson(root, RESEARCH_FILES.manifest, sha);
  const patterns = await readJson(root, RESEARCH_FILES.patterns, sha);
  const queue = await readJson(root, RESEARCH_FILES.queue, sha);
  const referencesV02 = await readJson(root, RESEARCH_FILES.referencesV02, sha);
  const candidatesV03: unknown[] = [];
  for (const f of RESEARCH_FILES.candidatesV03) candidatesV03.push(await readJson(root, f, sha));
  for (const v of Object.values(sha)) Sha.parse(v);
  return buildCorpus({ manifest, patterns, queue, referencesV02, candidatesV03, sha256: sha });
}
