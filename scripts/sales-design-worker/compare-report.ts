/**
 * The comparison's metrics report again (DEV-073), from the run directories
 * of one comparison: compare-report.json / .md and contact-sheet.png. Reads
 * local files only (no Codex, no build, no network); compare.ts writes the
 * same report at the end of its run. See docs/operations/design-compare-local.md.
 *
 *   tsx scripts/sales-design-worker/compare-report.ts --compare-id cmp-<n> [--no-sheet]
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { writeCompareReport } from "../../lib/design-agent/compare/report";
import { COMPARE_ID } from "../../lib/design-agent/compare/run";

const argv = process.argv.slice(2);
const i = argv.indexOf("--compare-id");
const compareId = argv.find((a) => a.startsWith("--compare-id="))?.slice(13) ?? (i >= 0 ? argv[i + 1] : undefined) ?? "";
if (!COMPARE_ID.test(compareId)) {
  process.stderr.write("usage: --compare-id cmp-<n> [--no-sheet]\n");
  process.exit(2);
}
const root = resolve((process.env.SR_DESIGN_COMPARE_ROOT ?? "~/sr-design-compare").replace(/^~(?=$|\/)/, homedir()));

async function main(): Promise<number> {
  const sheet = !argv.includes("--no-sheet");
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const browser = sheet ? await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) }) : undefined;
  try {
    const out = await writeCompareReport(join(root, compareId), { browser });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } finally {
    await browser?.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    process.stderr.write("COMPARE_REPORT_FAILED\n");
    process.exit(1);
  },
);
