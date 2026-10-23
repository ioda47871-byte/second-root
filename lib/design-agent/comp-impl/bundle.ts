/**
 * The comp bundle loader (DEV-082). A bundle is the design-image PoC's output
 * directory (mockup.png, report.json, shop-facts.json, design-spec.json; see
 * design-image/run.ts) plus three files a person or Claude adds:
 *
 *   evaluation.json   the comp's evaluation record (docs/operations/design-image-eval-template.md)
 *   layout-spec.json  the implementation spec Claude wrote from the comp (spec.ts)
 *
 * and, beside the page, assets.json (page.ts). Facts never come from the comp:
 * the loader reads them from the source of truth (a shop fixture in the
 * repository, the same file the PoC used) and only checks that the bundle's
 * shop-facts.json is the same; a bundle whose copy differs is refused. Every
 * file is opened without following a link, as a regular file within a size cap.
 * Failures are fixed codes.
 *
 * loadCompIntake (DEV-094) runs every check up to the evaluation, so a comp can
 * be checked before Claude writes layout-spec.json; loadCompBundle is that
 * intake plus the spec checks, with the same refusal order.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DemoView } from "@/lib/sales/demo-content";
import { parseShop } from "../compare/shops";
import { DIRECTION_VERSIONS, loadPocInputs, type DirectionVersion } from "../design-image/prompt";
import { MOCKUP_PNG_LIMITS, PngError, readPngNoFollow, type PngLimits } from "../design-image/png";
import { checkCompSpec, specFactProblems, type CompSpec } from "./spec";

export class CompImplError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CompImplError";
  }
}
const refuse = (code: string): never => {
  throw new CompImplError(code);
};

const JSON_MAX_BYTES = 256 * 1024;

/** Reads a small file without following a link (a regular file within the cap), or throws the code. */
export async function readSmallFile(path: string, code: string, maxBytes = JSON_MAX_BYTES): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return refuse(code);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) refuse(code);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readJson(path: string, code: string): Promise<unknown> {
  const bytes = await readSmallFile(path, code);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return refuse(code);
  }
}

/** JSON with sorted keys (for comparing two copies of the same record). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const COMP_KINDS = ["real", "synthetic"] as const;
export type CompKind = (typeof COMP_KINDS)[number];
/** The rubric's pass mark (design-image-eval-template.md): no hard fail and a total of at least 22/25. */
export const EVAL_PASS_TOTAL = 22;
/**
 * The lowest score any one criterion may have for a pass (DEV-094). The human's policy, 2026-10-22:
 * 「22/25点以上、各項目4点以上を基本方針とする」 — a high total cannot hide one weak area.
 */
export const EVAL_MIN_CRITERION = 4;
const Score = z.number().int().min(1).max(5);
export const EvaluationSchema = z.strictObject({
  version: z.literal(1),
  comp_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** synthetic: a test comp made for this PoC (never a design result); real: a Codex comp from a human-approved run. */
  comp_kind: z.enum(COMP_KINDS),
  hard_fails: z.strictObject({ invented_facts: z.boolean(), store_or_people: z.boolean(), disclosure: z.boolean(), logo_or_realism: z.boolean(), shop_facts: z.boolean() }),
  scores: z.strictObject({ beauty: Score, fit: Score, originality: Score, structure: Score, implementability: Score }).nullable(),
  total: z.number().int().min(5).max(25).nullable(),
  /** The human confirmed the sheet (rubric step 3). Claude's own scoring alone is never a confirmation. */
  human_confirmed: z.boolean(),
  confirmed_by: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/).nullable(),
  confirmed_at: z.string().datetime({ offset: true }).nullable(),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;
/**
 * The rubric's criteria, in the rubric's order: derived from the keys of `EvaluationSchema.scores`, so a criterion
 * added to the schema is always held to `EVAL_MIN_CRITERION` too (never a hand-kept copy).
 */
export const EVAL_CRITERIA: readonly EvalCriterion[] = EvaluationSchema.shape.scores.unwrap().keyof().options;
export type EvalCriterion = keyof NonNullable<Evaluation["scores"]>;

/** Why an evaluation does not approve its comp (fixed codes). */
export const EVAL_VERDICT_REASONS = ["EVAL_CRITERION_BELOW_MIN", "EVAL_NOT_CONFIRMED", "EVAL_NOT_REAL", "EVAL_NO_SCORES", "EVAL_TOTAL_BELOW_PASS"] as const;
export type EvalVerdictReason = (typeof EVAL_VERDICT_REASONS)[number];
export type EvalVerdict = {
  /** The comp may be implemented as a design result. */
  pass: boolean;
  /** Fixed codes, sorted; empty exactly when `pass`. */
  reasons: EvalVerdictReason[];
  /** The criteria scored below EVAL_MIN_CRITERION, in the rubric's order (keys only). */
  low_criteria: EvalCriterion[];
};

/**
 * The rubric's verdict on an evaluation (pure): a pass needs a `real` comp, the human's confirmation, scores,
 * a total of at least EVAL_PASS_TOTAL and every criterion at least EVAL_MIN_CRITERION. The hard fails and
 * the sheet's consistency (comp sha, kind, total = sum, a complete confirmation) are the loader's refusals.
 */
export function evaluationVerdict(ev: Pick<Evaluation, "comp_kind" | "human_confirmed" | "scores" | "total">): EvalVerdict {
  const reasons: EvalVerdictReason[] = [];
  if (ev.comp_kind !== "real") reasons.push("EVAL_NOT_REAL");
  if (!ev.human_confirmed) reasons.push("EVAL_NOT_CONFIRMED");
  const low_criteria: EvalCriterion[] = [];
  if (!ev.scores) reasons.push("EVAL_NO_SCORES");
  else {
    if (ev.total === null || ev.total < EVAL_PASS_TOTAL) reasons.push("EVAL_TOTAL_BELOW_PASS");
    for (const k of EVAL_CRITERIA) if (ev.scores[k] < EVAL_MIN_CRITERION) low_criteria.push(k);
    if (low_criteria.length > 0) reasons.push("EVAL_CRITERION_BELOW_MIN");
  }
  reasons.sort();
  return { pass: reasons.length === 0, reasons, low_criteria };
}

/** The PoC's report.json fields the loader relies on (the rest is ignored). */
const PocReportSchema = z.looseObject({
  status: z.literal("IMAGE_GENERATED_NOT_IMPLEMENTED"),
  shop: z.string().regex(/^[a-z]{3,12}$/),
  direction_version: z.enum(DIRECTION_VERSIONS),
  width: z.number().int(),
  height: z.number().int(),
  png_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  synthetic: z.literal(true).optional(),
});

export type CompBundle = {
  dir: string;
  comp: { bytes: Buffer; width: number; height: number; sha256: string; kind: CompKind };
  /** Whether the comp may be implemented as a design result (a real comp that passed the human-confirmed rubric). */
  compApproved: boolean;
  evaluation: Evaluation;
  directionVersion: DirectionVersion;
  shopKey: string;
  /** The verified facts (from the source of truth, after the worker's fact filter). */
  facts: Record<string, unknown>;
  demo: DemoView;
  spec: CompSpec;
};

export type LoadBundleOptions = {
  /** The repository (for the art direction and the default facts source). */
  repoDir: string;
  /** The facts source of truth: a shop fixture (compare/shops format). */
  factsSourcePath: string;
  /** PNG limits of the comp (tests may pass smaller ones; never larger than the PoC's). */
  pngLimits?: PngLimits;
};

/** Where the comp came from: report-only fields of the PoC's report.json (never a reason to refuse). */
export type CompProvenance = {
  /** The repository commit the design-image run used, when the report has a well-formed one. */
  worker_commit: string | null;
  prompt_chars: number | null;
  direction_version: DirectionVersion;
};

/** Everything checked before the implementation spec exists (DEV-094): the comp, the report, the facts, the direction and the evaluation. */
export type CompIntake = Omit<CompBundle, "spec"> & {
  verdict: EvalVerdict;
  provenance: CompProvenance;
  /** Whether layout-spec.json is present as a regular file (report-only; it is not read here). */
  layoutSpecPresent: boolean;
};

/** Thrown for a real comp the rubric did not pass: `problems` holds the verdict's reasons, `low_criteria` the weak criteria. */
export type CompNotApprovedError = CompImplError & { problems: EvalVerdictReason[]; low_criteria: EvalCriterion[] };

const pickWorkerCommit = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{7,40}$/.test(v) ? v : null);
const pickCount = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Loads and checks a bundle up to (not including) the implementation spec; throws CompImplError with a fixed code
 * when anything is unsafe or inconsistent, in the same order as loadCompBundle. Run it before writing layout-spec.json.
 */
export async function loadCompIntake(bundleDir: string, o: LoadBundleOptions): Promise<CompIntake> {
  let dir: string;
  try {
    dir = await realpath(bundleDir);
  } catch {
    return refuse("BUNDLE_MISSING");
  }
  const limits = o.pngLimits ?? MOCKUP_PNG_LIMITS;
  if (limits.maxBytes > MOCKUP_PNG_LIMITS.maxBytes || limits.maxSide > MOCKUP_PNG_LIMITS.maxSide || limits.maxPixels > MOCKUP_PNG_LIMITS.maxPixels) refuse("BUNDLE_LIMITS");
  let png;
  try {
    png = await readPngNoFollow(join(dir, "mockup.png"), limits);
  } catch (error) {
    if (error instanceof PngError) refuse("COMP_PNG_INVALID");
    throw error;
  }
  const compSha = sha256(png.bytes);

  const report = PocReportSchema.safeParse(await readJson(join(dir, "report.json"), "BUNDLE_REPORT_INVALID"));
  if (!report.success) return refuse("BUNDLE_REPORT_INVALID");
  if (report.data.png_sha256 !== compSha || report.data.width !== png.width || report.data.height !== png.height) refuse("BUNDLE_REPORT_MISMATCH");

  // Facts: the source of truth only. The bundle's copy must be the same record.
  let sourceRaw: unknown;
  try {
    sourceRaw = JSON.parse(await readFile(o.factsSourcePath, "utf8")) as unknown;
  } catch {
    return refuse("FACTS_SOURCE_INVALID");
  }
  const shop = parseShop(sourceRaw);
  if (!shop || shop.key !== report.data.shop) return refuse("FACTS_SOURCE_INVALID");
  const bundleFacts = await readJson(join(dir, "shop-facts.json"), "BUNDLE_FACTS_INVALID");
  if (stableJson(bundleFacts) !== stableJson(shop.facts)) refuse("BUNDLE_FACTS_MISMATCH");

  // The art direction the comp was made from: the same as the repository's (the comp is not re-specified here).
  const direction = await readJson(join(dir, "design-spec.json"), "BUNDLE_DIRECTION_INVALID");
  let inputs;
  try {
    inputs = await loadPocInputs(o.repoDir, report.data.direction_version);
  } catch {
    return refuse("BUNDLE_DIRECTION_INVALID");
  }
  if (inputs.demo.name !== shop.demo.name || stableJson(direction) !== stableJson(inputs.direction)) refuse("BUNDLE_DIRECTION_MISMATCH");

  const evaluation = EvaluationSchema.safeParse(await readJson(join(dir, "evaluation.json"), "EVAL_INVALID"));
  if (!evaluation.success) return refuse("EVAL_INVALID");
  const ev = evaluation.data;
  if (ev.comp_sha256 !== compSha) refuse("EVAL_COMP_MISMATCH");
  if ((report.data.synthetic === true) !== (ev.comp_kind === "synthetic")) refuse("EVAL_KIND_MISMATCH");
  if (Object.values(ev.hard_fails).some(Boolean)) refuse("EVAL_HARD_FAIL");
  if (ev.scores && ev.total !== Object.values(ev.scores).reduce((a, b) => a + b, 0)) refuse("EVAL_TOTAL_MISMATCH");
  if (ev.human_confirmed && (!ev.confirmed_by || !ev.confirmed_at || !ev.scores)) refuse("EVAL_CONFIRMATION_INCOMPLETE");
  const verdict = evaluationVerdict(ev);
  const compApproved = ev.comp_kind === "real" && verdict.pass;
  // A real comp is implemented only after the human-confirmed rubric passed it (total and every criterion).
  if (ev.comp_kind === "real" && !compApproved) throw Object.assign(new CompImplError("COMP_NOT_APPROVED"), { problems: verdict.reasons, low_criteria: verdict.low_criteria });

  let layoutSpecPresent = false;
  try {
    layoutSpecPresent = (await lstat(join(dir, "layout-spec.json"))).isFile();
  } catch {
    layoutSpecPresent = false;
  }
  const r = report.data as Record<string, unknown>;
  return {
    dir,
    comp: { bytes: png.bytes, width: png.width, height: png.height, sha256: compSha, kind: ev.comp_kind },
    compApproved,
    evaluation: ev,
    directionVersion: report.data.direction_version,
    shopKey: shop.key,
    facts: shop.facts,
    demo: shop.demo,
    verdict,
    provenance: { worker_commit: pickWorkerCommit(r.worker_commit), prompt_chars: pickCount(r.prompt_chars), direction_version: report.data.direction_version },
    layoutSpecPresent,
  };
}

/** Loads and checks a bundle; throws CompImplError with a fixed code when anything is unsafe or inconsistent. */
export async function loadCompBundle(bundleDir: string, o: LoadBundleOptions): Promise<CompBundle> {
  const intake = await loadCompIntake(bundleDir, o);
  const { dir, comp, demo } = intake;
  const compSha = comp.sha256;
  const specCheck = checkCompSpec(await readJson(join(dir, "layout-spec.json"), "SPEC_INVALID"));
  if (!specCheck.ok) return refuse(specCheck.problems[0] ?? "SPEC_INVALID");
  const spec = specCheck.spec;
  if (spec.comp_sha256 !== compSha) refuse("SPEC_COMP_MISMATCH");
  if (spec.artboard.width_px !== comp.width || spec.artboard.height_px !== comp.height) refuse("SPEC_ARTBOARD_MISMATCH");
  const factProblems = specFactProblems(spec, demo);
  if (factProblems.length > 0) refuse(factProblems[0]!);

  return {
    dir,
    comp,
    compApproved: intake.compApproved,
    evaluation: intake.evaluation,
    directionVersion: intake.directionVersion,
    shopKey: intake.shopKey,
    facts: intake.facts,
    demo,
    spec,
  };
}
