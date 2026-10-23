/**
 * The comp-to-site PoC (DEV-082, docs/operations/comp-to-site.md): checks a
 * page Claude implemented from a design comp. LOCAL ONLY: no Codex, no model
 * or API call, no network (the page is rendered with every request routed),
 * no database, nothing published. Never invoked by the worker, a timer, cron,
 * Vercel or CI.
 *
 *   npx tsx scripts/sales-design-worker/comp-impl-poc.ts --synthetic
 *       the SYNTHETIC fixture (scripts/sales-design-worker/comp-impl/synthetic-wagashi)
 *   npx tsx scripts/sales-design-worker/comp-impl-poc.ts --bundle <dir> --page <dir> [--facts <shop fixture>]
 *       a comp bundle (the design-image PoC's output dir + evaluation.json + layout-spec.json)
 *       and the page directory (index.html, style.css, assets.json, assets/)
 *   npx tsx scripts/sales-design-worker/comp-impl-poc.ts --intake <dir> [--facts <shop fixture>]
 *       DEV-094: checks a comp bundle up to its evaluation (before layout-spec.json is written);
 *       no Chromium, no output directory, no file written. Prints one line:
 *       COMP_INTAKE ok=… comp_kind=… comp_approved=… reasons=… low=… sha=… size=WxH direction=…
 *       worker_commit=… layout_spec_present=…
 *       Exit: 0 loaded (an approved real comp, or a synthetic one), 1 COMP_NOT_APPROVED, 2 refused / usage.
 *
 * --facts is the facts source of truth (default: the DEV-073 wagashi fixture);
 * the bundle's shop-facts.json must equal it. Output: a new directory under
 * $SR_COMP_IMPL_POC_ROOT or ~/sr-comp-impl-poc (0700 / 0600) with report.json,
 * desktop.png and mobile.png. Printed: fixed codes, numbers and that path.
 * Exit: 0 every mechanical check passed, 1 a check failed, 2 refused / usage.
 */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { chromium } from "playwright";
import { CompImplError, loadCompIntake, type CompNotApprovedError } from "../../lib/design-agent/comp-impl/bundle";
import { runCompImpl, writeCompImplOutputs } from "../../lib/design-agent/comp-impl/run";
import { buildSyntheticBundle, SYNTHETIC_FIXTURE_DIR } from "../../lib/design-agent/comp-impl/synthetic";
import { FIXTURE_PATH } from "../../lib/design-agent/design-image/prompt";

const REPO = resolve(__dirname, "../..");
process.umask(0o077);

type Args = { synthetic: boolean; bundle?: string; page?: string; facts?: string; intake?: string };

function args(argv: string[]): Args | null {
  const out: Args = { synthetic: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--synthetic") out.synthetic = true;
    else if ((a === "--bundle" || a === "--page" || a === "--facts" || a === "--intake") && argv[i + 1]) out[a.slice(2) as "bundle" | "page" | "facts" | "intake"] = resolve(argv[++i]!);
    else return null;
  }
  if (out.intake) return out.synthetic || out.bundle || out.page ? null : out;
  if (out.synthetic === Boolean(out.bundle || out.page)) return null;
  if (!out.synthetic && !(out.bundle && out.page)) return null;
  return out;
}

const list = (xs: readonly string[] | undefined) => (xs && xs.length > 0 ? xs.join(",") : "none");

/** --intake: the bundle checks up to the evaluation. No browser, no output root, nothing written. */
async function intake(dir: string, facts: string | undefined): Promise<number> {
  try {
    const b = await loadCompIntake(dir, { repoDir: REPO, factsSourcePath: facts ?? join(REPO, FIXTURE_PATH) });
    console.log(
      `COMP_INTAKE ok=true comp_kind=${b.comp.kind} comp_approved=${b.compApproved} reasons=${list(b.verdict.reasons)} low=${list(b.verdict.low_criteria)} sha=${b.comp.sha256} size=${b.comp.width}x${b.comp.height} direction=${b.directionVersion} worker_commit=${b.provenance.worker_commit ?? "none"} layout_spec_present=${b.layoutSpecPresent}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof CompImplError && error.code === "COMP_NOT_APPROVED") {
      const e = error as CompNotApprovedError;
      console.log(`COMP_INTAKE ok=false refused=COMP_NOT_APPROVED comp_kind=real comp_approved=false reasons=${list(e.problems)} low=${list(e.low_criteria)}`);
      return 1;
    }
    if (error instanceof CompImplError) {
      console.log(`COMP_INTAKE ok=false refused=${error.code}`);
      return 2;
    }
    console.log("COMP_INTAKE ok=false refused=UNEXPECTED");
    return 2;
  }
}

async function main(): Promise<number> {
  const o = args(process.argv.slice(2));
  if (!o) {
    console.log("USAGE: comp-impl-poc.ts --synthetic | --bundle <dir> --page <dir> [--facts <shop fixture>] | --intake <dir> [--facts <shop fixture>]");
    return 2;
  }
  if (o.intake) return intake(o.intake, o.facts);
  const envRoot = process.env.SR_COMP_IMPL_POC_ROOT;
  const outRoot = envRoot && isAbsolute(envRoot) ? envRoot : join(homedir(), "sr-comp-impl-poc");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  let scratch: string | undefined;
  try {
    let bundleDir = o.bundle;
    if (o.synthetic) {
      // a private scratch bundle outside the output root (removed at the end)
      scratch = await mkdtemp(join(tmpdir(), "sr-comp-impl-synthetic-"));
      await chmod(scratch, 0o700);
      await buildSyntheticBundle(browser, REPO, scratch);
      bundleDir = scratch;
    }
    const pageDir = o.page ?? join(REPO, SYNTHETIC_FIXTURE_DIR, "page");
    const result = await runCompImpl({ bundleDir: bundleDir!, pageDir, repoDir: REPO, factsSourcePath: o.facts ?? join(REPO, FIXTURE_PATH), browser });
    const dest = await writeCompImplOutputs(outRoot, result, { repoDir: REPO, env: process.env, inputs: [bundleDir!, pageDir] });
    const r = result.report;
    console.log(`COMP_IMPL fidelity=${r.fidelity_status} mechanical_ok=${r.mechanical_ok} failed=${r.failed.join(",") || "none"}`);
    console.log(`COMP_IMPL anti_template min_distance=${r.anti_template.min_distance} nearest=${r.anti_template.nearest} css_reuse=${r.anti_template.css_reuse_share}`);
    console.log(`COMP_IMPL similarity status=${r.similarity.status} passing=false ssim=${r.similarity.ssim} colour_blocks=${r.similarity.colour_blocks} edges_iou=${r.similarity.edges_iou}`);
    console.log(`COMP_IMPL_OUT: ${dest}`);
    return r.mechanical_ok ? 0 : 1;
  } catch (error) {
    if (error instanceof CompImplError) {
      const problems = (error as CompImplError & { problems?: string[] }).problems;
      console.log(`COMP_IMPL_REFUSED ${error.code}${problems ? ` ${problems.join(",")}` : ""}`);
      return 2;
    }
    console.log("COMP_IMPL_UNEXPECTED");
    return 2;
  } finally {
    await browser.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  () => process.exit(2),
);
