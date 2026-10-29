/**
 * Phase 2f-1 CLI — OFFLINE ONLY: runs the 2f runner on recorded inputs (a Codex-shaped
 * answer file, image files and generation facts described in a plan), never on Codex.
 *
 *   npx tsx scripts/design-artifact/phase2f.ts --plan <plan.json>
 *
 * Paths in the plan are relative to the plan file. The package is written to the plan's
 * `out` directory (which must not exist), then checked by the DEV-114 intake. Prints the
 * run result (JSON) to stdout. Exit: 0 package written and checked (any state), 2 stopped
 * or refused. Real Codex and image runs are Phase 2f-2 and need separate approval.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { z } from "zod";
import { FactsPack, IMAGE_OUTCOMES } from "../../lib/design-agent/artifact/schema";
import { DesignBrief } from "../../lib/design-agent/phase2f/prompt";
import { packageConceptRun, runPrototypeRoute, type AssetPort, type DesignPort, type RunResult } from "../../lib/design-agent/phase2f/runner";

const Rel = z.string().min(1).max(300).refine((p) => !p.includes("\0"));
const Gen = z.strictObject({
  status: z.enum(["succeeded", "stopped", "unknown"]),
  tool: z.literal("codex_cli").nullable(),
  tool_version: z.string().nullable(),
  model_reported: z.string().nullable(),
  approval_id: z.string().nullable(),
  prompt_sha256: z.string().nullable(),
  worker_commit: z.string().nullable(),
  run_id: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
const Plan = z.strictObject({
  schema: z.literal("phase2f_offline_plan_v1"),
  route: z.enum(["A_image", "B_html_prototype", "C_hybrid"]),
  facts: Rel,
  shop: z.strictObject({ shop_id: z.string(), display_name: z.string() }),
  artifact_id: z.string(),
  out: Rel,
  generation: Gen,
  brief: Rel.optional(),
  answer: Rel.optional(),
  assets: z.record(z.string().regex(/^A\d{1,2}$/), z.strictObject({ png: Rel.nullable(), image_outcome: z.enum(IMAGE_OUTCOMES), stop_code: z.string().nullable(), approval_id: z.string().nullable() })).optional(),
  poc_dir: Rel.optional(),
});

function parseArgs(argv: string[]): string | null {
  return argv.length === 2 && argv[0] === "--plan" && argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
}

async function main(): Promise<number> {
  const planPath = parseArgs(process.argv.slice(2));
  if (!planPath) {
    console.error("usage: --plan <plan.json>   (offline: recorded inputs only, never Codex)");
    return 2;
  }
  const base = dirname(resolve(planPath));
  const at = (p: string) => resolve(base, p);
  const planRaw = Plan.safeParse(JSON.parse(await readFile(resolve(planPath), "utf8")));
  if (!planRaw.success) {
    console.error(`PLAN_INVALID: ${planRaw.error.issues[0]?.path.join(".") ?? ""}`);
    return 2;
  }
  const plan = planRaw.data;
  const pack = FactsPack.safeParse(JSON.parse(await readFile(at(plan.facts), "utf8")));
  if (!pack.success) {
    console.error("FACTS_INVALID");
    return 2;
  }
  const common = { facts: { path: at(plan.facts), pack: pack.data }, shop: plan.shop, artifactId: plan.artifact_id, outDir: at(plan.out) };
  // checked again by intake (formats, unknowns); offline, these are the recorded run's facts
  const generation = plan.generation as Awaited<ReturnType<DesignPort>>["generation"];
  let result: RunResult;
  if (plan.route === "A_image") {
    if (!plan.poc_dir) return (console.error("PLAN_INVALID: poc_dir"), 2);
    result = await packageConceptRun({ ...common, pocDir: at(plan.poc_dir), generation });
  } else {
    if (!plan.brief || !plan.answer) return (console.error("PLAN_INVALID: brief and answer"), 2);
    const brief = DesignBrief.safeParse(JSON.parse(await readFile(at(plan.brief), "utf8")));
    if (!brief.success) return (console.error("BRIEF_INVALID"), 2);
    const answer = JSON.parse(await readFile(at(plan.answer), "utf8"));
    // pseudo ports: the recorded answer and images stand in for Codex (offline only)
    const designPort: DesignPort = async () => ({ answer, generation });
    const assetPort: AssetPort = async ({ assetId }) => {
      const a = plan.assets?.[assetId];
      if (!a) return { png: null, image_outcome: "TOOL_NOT_CALLED", stop_code: "CODEX_NO_IMAGE", approval_id: null };
      return { png: a.png ? await readFile(at(a.png)) : null, image_outcome: a.image_outcome, stop_code: a.stop_code, approval_id: a.approval_id };
    };
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    try {
      result = await runPrototypeRoute({ ...common, route: plan.route, browser, brief: brief.data, designPort, assetPort });
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify({ mode: "offline_recorded_inputs", ...result }, null, 2));
  return result.status === "done" ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error("REFUSED");
    process.exit(2);
  },
);
