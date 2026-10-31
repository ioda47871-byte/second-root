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
 * Exit: 0 report written (observed or check_failed), 2 refused (bad arguments, not a B/C package, existing --out).
 * Never calls Codex, a model or the network. Advisory only: no gate, no approval.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "playwright";
import { observeStructure } from "../../lib/design-agent/structure/observe";
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
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) return refuse("ARGS_INVALID");
  if (inside(args.pkg, args.out)) return refuse("OUT_INSIDE_PACKAGE");
  let artifact: { artifact_id?: unknown; route?: unknown };
  try {
    artifact = JSON.parse(await readFile(join(args.pkg, "artifact.json"), "utf8")) as typeof artifact;
  } catch {
    return refuse("PACKAGE_UNREADABLE");
  }
  if (artifact.route !== "B_html_prototype" && artifact.route !== "C_hybrid") return refuse("NOT_A_PROTOTYPE_PACKAGE");
  let html: string;
  let css: string;
  try {
    html = await readFile(join(args.pkg, "quarantine/index.html"), "utf8");
    css = await readFile(join(args.pkg, "quarantine/style.css"), "utf8");
  } catch {
    return refuse("PROTOTYPE_FILES_MISSING");
  }
  const assets: Record<string, Buffer> = {};
  for (const f of await readdir(join(args.pkg, "assets")).catch(() => [] as string[])) if (/^A\d{1,2}\.png$/.test(f)) assets[`assets/${f}`] = await readFile(join(args.pkg, "assets", f));
  let refsText: string;
  try {
    refsText = await readFile(args.references, "utf8");
  } catch {
    return refuse("REFERENCES_UNREADABLE");
  }
  const parsed = ReferenceDescriptors.safeParse(JSON.parse(refsText));
  if (!parsed.success) return refuse("REFERENCES_INVALID");

  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  let observation;
  try {
    observation = await observeStructure(browser, { html, css, assets }, parsed.data);
  } finally {
    await browser.close();
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
