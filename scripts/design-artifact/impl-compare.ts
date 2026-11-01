/**
 * DEV-139 (Issue #177 A) CLI — OFFLINE, REPORT-ONLY: compares Claude's implementation with the design's originals.
 *
 *   npx tsx scripts/design-artifact/impl-compare.ts --lane <implementation lane> --impl <implementation dir> --out <report.json>
 *
 * --lane is a directory built by prepareImplementationLane (DEV-128: lane.json, artifact.json, originals/*.png).
 * --impl holds the implementation: index.html, style.css and, optionally, assets/<name>.png (the page links its CSS as
 * style.css and its pictures as assets/<name>.png; nothing else is served). Both are only read. The report goes to
 * --out, which must be outside both and must not exist.
 *
 * Exit: 0 report written (compared, partial or not_compared, incl. a browser that did not start), 2 refused (bad
 * arguments, --out inside an input even through links, unusable lane, unreadable or oversized implementation files,
 * existing --out). Never calls Codex, a model or the network. Advisory only: no gate, no approval, no repair.
 */
import { lstat, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { compareImplementation, IMPL_COMPARE_LIMITS, insideDir as inside, LaneReadError, readInside } from "../../lib/design-agent/impl-lane/impl-compare";

const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string) => (say({ status: "refused", code }), 2);

function parseArgs(argv: string[]): { lane: string; impl: string; out: string } | null {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || !v || !["--lane", "--impl", "--out"].includes(k) || k in o) return null;
    o[k] = v;
  }
  if (!o["--lane"] || !o["--impl"] || !o["--out"]) return null;
  return { lane: resolve(o["--lane"]), impl: resolve(o["--impl"]), out: resolve(o["--out"]) };
}

const isRealDir = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() === true;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) return refuse("ARGS_INVALID");
  if (inside(args.lane, args.out) || inside(args.impl, args.out)) return refuse("OUT_INSIDE_INPUT");
  let laneReal: string;
  let implReal: string;
  let outReal: string;
  try {
    laneReal = await realpath(args.lane);
    implReal = await realpath(args.impl);
    outReal = join(await realpath(dirname(args.out)), basename(args.out));
  } catch {
    return refuse("PATH_UNRESOLVABLE");
  }
  // the same with every link resolved: a linked input or a linked directory above --out must not lead back in
  if (inside(laneReal, outReal) || inside(implReal, outReal)) return refuse("OUT_INSIDE_INPUT");
  if (!(await isRealDir(laneReal)) || !(await isRealDir(implReal))) return refuse("INPUT_NOT_A_DIRECTORY");

  // read on an open handle (no link anywhere on the path when checked, the last step never followed, size checked on the handle)
  const htmlBytes = await readInside(implReal, "index.html", IMPL_COMPARE_LIMITS.html);
  const cssBytes = await readInside(implReal, "style.css", IMPL_COMPARE_LIMITS.css);
  if (!htmlBytes || !cssBytes) return refuse("IMPL_FILES_MISSING");
  const assets = new Map<string, Buffer>();
  const assetDir = join(implReal, "assets");
  const assetStat = await lstat(assetDir).catch(() => null);
  if (assetStat && !assetStat.isDirectory()) return refuse("IMPL_ASSET_INVALID");
  for (const f of assetStat ? (await readdir(assetDir)).sort() : []) {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}\.png$/i.test(f) || assets.size >= IMPL_COMPARE_LIMITS.assets) return refuse("IMPL_ASSET_INVALID");
    const bytes = await readInside(implReal, `assets/${f}`, IMPL_COMPARE_LIMITS.asset);
    if (!bytes) return refuse("IMPL_ASSET_INVALID");
    assets.set(`assets/${f}`, bytes);
  }
  const impl = { html: htmlBytes.toString("utf8"), css: cssBytes.toString("utf8"), assets };

  // a browser that does not start is a comparison that could not run: written in the report, never a clean result
  const launched = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) }).then(
    (browser) => ({ browser, error: null as unknown }),
    (error: unknown) => ({ browser: null, error }),
  );
  let report;
  try {
    report = await compareImplementation(launched.browser, laneReal, impl, launched.error);
  } catch (e) {
    if (e instanceof LaneReadError) return refuse(e.code);
    throw e;
  } finally {
    await launched.browser?.close().catch(() => undefined);
  }
  try {
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    return refuse("OUT_EXISTS_OR_UNWRITABLE");
  }
  say({ status: report.status, out: args.out, differences: report.differences.length });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => {
    say({ status: "refused", code: "REFUSED" });
    process.exit(2);
  },
);
