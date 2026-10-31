/**
 * DEV-138 (Issue #175) CLI — OFFLINE, REPORT-ONLY: the structure observation of a packaged Phase 2f prototype.
 *
 *   npx tsx scripts/design-artifact/phase2f-structure-observe.ts --package <artifact dir> --out <report.json> [--references <json>]
 *
 * Reads the package's prototype (quarantine/index.html, quarantine/style.css and its assets/*.png) and draws it again
 * (JS off, closed origin) at PC 1440 and SP 390 to compare its measured structure with the declared reference set
 * (default: design-library/intelligence/v02/structure-descriptors-v0.json). Writes the report to --out, which must be
 * outside the package and must not exist: the package (its pictures, files and hashes) is never touched, and nothing
 * here runs before or inside the design run.
 *
 * Exit: 0 report written (observed or check_failed, incl. a browser that did not start), 2 refused (bad arguments,
 * --out inside the package even through links, not a B/C package, unreadable or oversized files, existing --out).
 * Never calls Codex, a model or the network. Advisory only: no gate, no approval.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { failedObservation, observeStructure, type StructureObservation } from "../../lib/design-agent/structure/observe";
import { ReferenceDescriptors } from "../../lib/design-agent/structure/references";

const DEFAULT_REFERENCES = "design-library/intelligence/v02/structure-descriptors-v0.json";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string) => (say({ status: "refused", code }), 2);

function parseArgs(argv: string[]): { pkg: string; out: string; references: string } | null {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || !v || !["--package", "--out", "--references"].includes(k) || k in o) return null;
    o[k] = v;
  }
  if (!o["--package"] || !o["--out"]) return null;
  return { pkg: resolve(o["--package"]), out: resolve(o["--out"]), references: resolve(o["--references"] ?? DEFAULT_REFERENCES) };
}

/** Inside (or equal to) the directory: a report there would become an undeclared file of the package. */
const inside = (dir: string, path: string) => {
  const r = relative(dir, path);
  // "..report.json" is inside; only ".." itself or "../…" leaves the directory (review M1)
  return r === "" || !(r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r));
};

/** Size caps for what is read from a package (the prototype limits of the artifact schema, and generous for pictures). */
const MAX_BYTES = { html: 384 * 1024, css: 256 * 1024, asset: 10 * 1024 * 1024 } as const;

/** A regular file (never a link) no larger than `max`; else null. */
async function readRegular(path: string, max: number): Promise<Buffer | null> {
  const st = await lstat(path).catch(() => null);
  if (!st || !st.isFile() || st.size > max) return null;
  return readFile(path);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) return refuse("ARGS_INVALID");
  if (inside(args.pkg, args.out)) return refuse("OUT_INSIDE_PACKAGE");
  // the same with every link resolved: a linked package or a linked directory above --out must not lead back in (M2)
  let pkgReal: string;
  let outReal: string;
  try {
    pkgReal = await realpath(args.pkg);
    outReal = join(await realpath(dirname(args.out)), basename(args.out));
  } catch {
    return refuse("PATH_UNRESOLVABLE");
  }
  if (inside(pkgReal, outReal)) return refuse("OUT_INSIDE_PACKAGE");
  let artifact: { artifact_id?: unknown; route?: unknown };
  try {
    artifact = JSON.parse(await readFile(join(args.pkg, "artifact.json"), "utf8")) as typeof artifact;
  } catch {
    return refuse("PACKAGE_UNREADABLE");
  }
  if (artifact.route !== "B_html_prototype" && artifact.route !== "C_hybrid") return refuse("NOT_A_PROTOTYPE_PACKAGE");
  const htmlBytes = await readRegular(join(pkgReal, "quarantine/index.html"), MAX_BYTES.html);
  const cssBytes = await readRegular(join(pkgReal, "quarantine/style.css"), MAX_BYTES.css);
  if (!htmlBytes || !cssBytes) return refuse("PROTOTYPE_FILES_MISSING");
  const html = htmlBytes.toString("utf8");
  const css = cssBytes.toString("utf8");
  const assets: Record<string, Buffer> = {};
  for (const f of await readdir(join(pkgReal, "assets")).catch(() => [] as string[])) {
    if (!/^A\d{1,2}\.png$/.test(f)) continue;
    const bytes = await readRegular(join(pkgReal, "assets", f), MAX_BYTES.asset);
    if (!bytes) return refuse("PACKAGE_ASSET_INVALID");
    assets[`assets/${f}`] = bytes;
  }
  let refsText: string;
  try {
    refsText = await readFile(args.references, "utf8");
  } catch {
    return refuse("REFERENCES_UNREADABLE");
  }
  let refsJson: unknown;
  try {
    refsJson = JSON.parse(refsText);
  } catch {
    return refuse("REFERENCES_INVALID");
  }
  const parsed = ReferenceDescriptors.safeParse(refsJson);
  if (!parsed.success) return refuse("REFERENCES_INVALID");

  // a browser that does not start is a check that could not run: recorded in the report, never a clean result (L2)
  const launched = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) }).then(
    (browser) => ({ browser, error: null }),
    (error: unknown) => ({ browser: null, error }),
  );
  let observation: StructureObservation;
  if (!launched.browser) observation = failedObservation("BROWSER_LAUNCH_FAILED", launched.error);
  else {
    try {
      observation = await observeStructure(launched.browser, { html, css, assets }, parsed.data);
    } finally {
      await launched.browser.close().catch(() => undefined);
    }
  }
  const report = {
    ...observation,
    package: { artifact_id: typeof artifact.artifact_id === "string" ? artifact.artifact_id : null, route: artifact.route, html_sha256: sha256(html), css_sha256: sha256(css) },
    reference_set: { path: relative(process.cwd(), args.references) || args.references, sha256: sha256(refsText), status: parsed.data.status },
  };
  try {
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    return refuse("OUT_EXISTS_OR_UNWRITABLE");
  }
  say({ status: report.status, out: args.out, ...(report.check_failed ? { check_failed: report.check_failed } : {}) });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => {
    say({ status: "refused", code: "REFUSED" });
    process.exit(2);
  },
);
