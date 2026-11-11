/**
 * DEV-196r (option C): package a committed B-route page as a demo version, offline.
 *
 *   npx tsx scripts/sales/demo-version/package-local.ts --out <dir outside the repository> \
 *     [--source design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9] [--png-out <dir for full-size PNGs>]
 *
 * Renders PC 1440 and SP 390 full pages with the comp-lane renderer (renderPrototype: JavaScript off, network blocked,
 * deviceScaleFactor 1, this machine's fonts as in the research renders), downscales any render whose side exceeds
 * 4096 px (the server's limit; see lib/demo-version-package/package.ts), builds the manifest and runs the same checks
 * the server runs, then writes the package (refused inside the repository). Prints ids and hashes only.
 * Exit 0 on success, 1 when a check fails, 2 for a usage error.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { renderPrototype } from "../../../lib/design-agent/phase2f/render-prototype";
import { buildPackage, insideRepo, PackageError, writePackage } from "../../../lib/demo-version-package/package";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const REPO = resolve(__dirname, "../../..");
const DEFAULT_SOURCE = "design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9";

async function main(): Promise<number> {
  const out = arg("--out");
  const source = arg("--source") ?? DEFAULT_SOURCE;
  const pngOut = arg("--png-out");
  if (!out) {
    process.stderr.write("usage: package-local.ts --out <dir outside the repository> [--source <comp dir>] [--png-out <dir>]\n");
    return 2;
  }
  if (insideRepo(out) || (pngOut && insideRepo(pngOut))) {
    process.stderr.write("refused: write the package outside the repository\n");
    return 2;
  }
  const dir = resolve(REPO, source);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const css = readFileSync(join(dir, "style.css"), "utf8");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  let renders;
  try {
    renders = await renderPrototype(browser, { html, css }, new Map(), []);
  } finally {
    await browser.close();
  }
  if (renders.desktop_1440.blocked || renders.mobile_390.blocked) {
    process.stderr.write("refused: the page tried outside requests\n");
    return 1;
  }
  if (pngOut) {
    mkdirSync(pngOut, { recursive: true });
    writeFileSync(join(pngOut, "desktop_1440.full.png"), renders.desktop_1440.png);
    writeFileSync(join(pngOut, "mobile_390.full.png"), renders.mobile_390.png);
  }
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    commit = null;
  }
  try {
    const pkg = await buildPackage({ html, css, renders: { desktop_1440: renders.desktop_1440.png, mobile_390: renders.mobile_390.png }, source, validatorCommit: commit });
    writePackage(out, pkg);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "OK",
          source,
          bundle_sha256: pkg.bundleSha256,
          files: pkg.manifest.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes, ...(f.width ? { width: f.width, height: f.height } : {}) })),
          originals: (pkg.workerChecks as { originals: unknown }).originals,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof PackageError) {
      process.stdout.write(`${JSON.stringify({ status: "FAIL", code: e.code, details: e.details })}\n`);
      return 1;
    }
    throw e;
  }
}

main().then((code) => process.exit(code));
