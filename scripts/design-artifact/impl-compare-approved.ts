/**
 * DEV-303 §6.1 change 8 CLI — OFFLINE, REPORT-ONLY: stage 6, the implemented site against the owner-approved whole-page
 * design of a request-mode run (lib/design-agent/imagefirst-worker/impl-compare-approved.ts).
 *
 *   npx tsx scripts/design-artifact/impl-compare-approved.ts --bundle <review-inbox/<id>> --review <review.json> --approval <approval.json> --site <site dir> --out <private dir>
 *
 * The approval is gate-checked first (design-approval.ts; a DESIGN_* stop ends it). The site (index.html, style.css,
 * assets/*.png) and --out must be outside this repository; --out empty or absent. Chromium draws the site at PC 1440 and
 * SP 390 with JS off and the network blocked (PLAYWRIGHT_CHROMIUM_EXECUTABLE may name the browser). Writes record.json
 * (sr_impl_compare_v1), images/ and index.html into --out only. The scores are advice for the owner, never a pass.
 *
 * Exit: 0 written, 1 stopped (a named code), 2 refused (bad arguments).
 */
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { ImplCompareStop, runImplCompare } from "../../lib/design-agent/imagefirst-worker/impl-compare-approved";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

export function parseImplCompareArgs(argv: string[]): { bundle: string; review: string; approval: string; site: string; out: string } | null {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || !v || v.startsWith("--") || !["--bundle", "--review", "--approval", "--site", "--out"].includes(k) || k in o) return null;
    o[k] = v;
  }
  const need = ["--bundle", "--review", "--approval", "--site", "--out"];
  if (need.some((k) => !o[k])) return null;
  return { bundle: resolve(o["--bundle"]!), review: resolve(o["--review"]!), approval: resolve(o["--approval"]!), site: resolve(o["--site"]!), out: resolve(o["--out"]!) };
}

export async function implCompareMain(argv: string[], repoRoot: string = REPO, launch: () => Promise<Browser> = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })): Promise<number> {
  const args = parseImplCompareArgs(argv);
  if (!args) return (say({ status: "refused", code: "ARGS_INVALID" }), 2);
  const browser = await launch().catch(() => null);
  try {
    const r = await runImplCompare({ bundleDir: args.bundle, reviewPath: args.review, approvalPath: args.approval, siteDir: args.site, outDir: args.out, repo: repoRoot, browser });
    say({ status: "written", record_sha256: r.record_sha256, page: r.page, page_sha256: r.page_sha256, compare_status: r.record.status, differences: r.record.differences, findings: r.record.findings, advisory: true, passing: false });
    return 0;
  } catch (error) {
    if (!(error instanceof ImplCompareStop)) throw error;
    say({ status: "stopped", code: error.code });
    return 1;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

if (require.main === module)
  implCompareMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
