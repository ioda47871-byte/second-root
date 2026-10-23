/**
 * The SYNTHETIC comp bundle of DEV-082 (scripts/sales-design-worker/comp-impl/
 * synthetic-wagashi/): renders the hand-drawn stand-in comp (comp.html, a flat
 * 1440 × 2050 artboard) to mockup.png at half scale, and writes it with the
 * PoC's other bundle files into a new directory, so the harness can run end to
 * end without a real Codex comp. Every file says what it is: report.json has
 * `synthetic: true`, evaluation.json `comp_kind: "synthetic"` and no human
 * confirmation. The comp's words are never read.
 *
 * The only edits to the fixture's layout-spec.json and evaluation.json are the
 * comp's sha256 (the PNG's bytes depend on the machine's fonts).
 */
import { constants } from "node:fs";
import { chmod, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { parseShop } from "../compare/shops";
import { FIXTURE_PATH, loadPocInputs } from "../design-image/prompt";
import { checkPng } from "../design-image/png";
import { waitForFrame } from "../frame-ready";
import { sha256 } from "./bundle";

export const SYNTHETIC_FIXTURE_DIR = "scripts/sales-design-worker/comp-impl/synthetic-wagashi";
export const SYNTHETIC_ARTBOARD = { width: 1440, height: 2050, scale: 0.5 } as const;

async function writeNew(path: string, data: string | Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Renders comp.html (network shut, no script) to a PNG at the artboard's half scale. */
export async function renderSyntheticComp(browser: Browser, html: string): Promise<Buffer> {
  const a = SYNTHETIC_ARTBOARD;
  const context = await browser.newContext({ viewport: { width: a.width, height: a.height }, deviceScaleFactor: a.scale, javaScriptEnabled: false });
  try {
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // DEV-098: a brand-new page may have no frame to copy yet ("Unable to capture screenshot" on a loaded machine)
    await waitForFrame(page);
    return await page.screenshot({ clip: { x: 0, y: 0, width: a.width, height: a.height }, animations: "disabled", caret: "hide" });
  } finally {
    await context.close();
  }
}

/** Writes a complete synthetic bundle into `outDir` (an existing, empty, private directory). */
export async function buildSyntheticBundle(browser: Browser, repoDir: string, outDir: string): Promise<{ compSha256: string }> {
  const fixture = join(repoDir, SYNTHETIC_FIXTURE_DIR);
  const png = await renderSyntheticComp(browser, await readFile(join(fixture, "comp.html"), "utf8"));
  const info = checkPng(png);
  const compSha256 = sha256(png);
  const shop = parseShop(JSON.parse(await readFile(join(repoDir, FIXTURE_PATH), "utf8")) as unknown);
  if (!shop) throw new Error("fixture");
  const inputs = await loadPocInputs(repoDir, "v2");
  const spec = JSON.parse(await readFile(join(fixture, "layout-spec.json"), "utf8")) as Record<string, unknown>;
  const evaluation = JSON.parse(await readFile(join(fixture, "evaluation.json"), "utf8")) as Record<string, unknown>;
  const report = {
    status: "IMAGE_GENERATED_NOT_IMPLEMENTED",
    shop: shop.key,
    direction_version: "v2",
    width: info.width,
    height: info.height,
    png_sha256: compSha256,
    synthetic: true,
    notes: ["SYNTHETIC comp for the DEV-082 harness: drawn by hand, not Codex output, not a design result."],
  };
  await chmod(outDir, 0o700);
  await writeNew(join(outDir, "mockup.png"), png);
  await writeNew(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeNew(join(outDir, "shop-facts.json"), `${JSON.stringify(shop.facts, null, 2)}\n`);
  await writeNew(join(outDir, "design-spec.json"), `${JSON.stringify(inputs.direction, null, 2)}\n`);
  await writeNew(join(outDir, "evaluation.json"), `${JSON.stringify({ ...evaluation, comp_sha256: compSha256 }, null, 2)}\n`);
  await writeNew(join(outDir, "layout-spec.json"), `${JSON.stringify({ ...spec, comp_sha256: compSha256 }, null, 2)}\n`);
  return { compSha256 };
}
