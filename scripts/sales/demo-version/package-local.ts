/**
 * DEV-196r (option C): package a committed B-route page as a demo version, offline.
 *
 *   npx tsx scripts/sales/demo-version/package-local.ts --out <dir outside the repository> \
 *     [--source design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9] [--png-out <dir for full-size PNGs>]
 *
 * DEV-196s (owner approval 2026-11-11): or package 輪's photo-swapped page with its AI demo photos, every input read-only:
 *
 *   npx tsx scripts/sales/demo-version/package-local.ts --out <dir outside the repository> \
 *     --page <swap>/page --rights <swap>/rights.private.json --originals <the run's photo bundle dir> \
 *     --depiction-confirmation <the owner's confirmation file, kept outside the repository> \
 *     [--summary <swap>/swap-summary.json (default: beside the page)] [--compare-renders <swap>/renders] [--png-out <dir>]
 *
 * The photos become WebP (lossless when it fits the server's 2,000,000-byte limit, else the highest quality that fits;
 * sRGB, no ICC, no metadata; the pixel size unchanged), named as the server requires (the slot's hyphens become
 * underscores); ONLY those photo URLs are rewritten in the stored HTML / CSS, and a normalised comparison proves that
 * nothing else changed. The image records come from the rights file (ai_generated_demo, depicts nothing real, no public
 * web, full provenance), each record checked against its original photo as the swap checked it; whether a photo shows
 * a real product, interior or equipment comes only from the owner's per-photo confirmation (docs/operations/
 * rin-ai-photos-local.md §5), never assumed. Nothing in the inputs
 * is changed; the package is written outside the repository only.
 *
 * Renders PC 1440 and SP 390 full pages with the comp-lane renderer (renderPrototype: JavaScript off, network blocked,
 * deviceScaleFactor 1, this machine's fonts as in the research renders), downscales any render whose side exceeds
 * 4096 px (the server's limit; see lib/demo-version-package/package.ts), builds the manifest and runs the same checks
 * the server runs, then writes the package (refused inside the repository). With --compare-renders, the full-size
 * renders are compared pixel by pixel with the research renders (desktop_1440.png, mobile_390.png). Prints ids, hashes,
 * sizes and modes only (never a path of the inputs, an owner, a consent record or a provenance).
 * Exit 0 on success, 1 when a check fails, 2 for a usage error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { renderPrototype } from "../../../lib/design-agent/phase2f/render-prototype";
import { buildPackage, insideRepo, PackageError, writePackage } from "../../../lib/demo-version-package/package";
import { forbiddenHashes, PhotoError, pixelDiff, prepareSwap, readOriginals, readSwapPage, SwapInputError, SwapRightsError, type PixelDiff, type PreparedSwap } from "../../../lib/demo-version-package/swap-package";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const REPO = resolve(__dirname, "../../..");
const DEFAULT_SOURCE = "design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9";

async function main(): Promise<number> {
  const out = arg("--out");
  const page = arg("--page");
  const rightsPath = arg("--rights");
  const originalsDir = arg("--originals");
  const depictionPath = arg("--depiction-confirmation");
  const summaryPath = arg("--summary") ?? (page ? join(dirname(resolve(page)), "swap-summary.json") : undefined);
  const compareDir = arg("--compare-renders");
  const source = arg("--source") ?? DEFAULT_SOURCE;
  const pngOut = arg("--png-out");
  if (!out || (page && arg("--source")) || (page && (!rightsPath || !originalsDir || !depictionPath)) || (!page && (rightsPath || originalsDir || depictionPath || arg("--summary") || compareDir))) {
    process.stderr.write(
      "usage: package-local.ts --out <dir outside the repository> [--source <comp dir>] [--png-out <dir>]\n" +
        "       package-local.ts --out <dir> --page <swap>/page --rights <rights.private.json> --originals <photo dir> --depiction-confirmation <file> [--summary <swap-summary.json>] [--compare-renders <dir>] [--png-out <dir>]\n",
    );
    return 2;
  }
  if (insideRepo(out) || (pngOut && insideRepo(pngOut))) {
    process.stderr.write("refused: write the package outside the repository\n");
    return 2;
  }
  try {
    let html: string;
    let css: string;
    let swap: PreparedSwap | null = null;
    if (page) {
      if (!summaryPath || !existsSync(summaryPath)) throw new SwapInputError("SUMMARY_MISSING");
      const read = (p: string, code: string) => {
        try {
          return JSON.parse(readFileSync(p, "utf8")) as unknown;
        } catch {
          throw new SwapInputError(code);
        }
      };
      swap = await prepareSwap({
        page: readSwapPage(page),
        rights: read(rightsPath!, "RIGHTS_UNREADABLE"),
        depictions: read(depictionPath!, "DEPICTION_CONFIRMATION_UNREADABLE"),
        summary: read(summaryPath, "SUMMARY_UNREADABLE"),
        originals: readOriginals(originalsDir!),
        forbiddenSha256: forbiddenHashes(REPO),
        now: new Date().toISOString().slice(0, 10),
      });
      html = swap.html;
      css = swap.css;
    } else {
      const dir = resolve(REPO, source);
      html = readFileSync(join(dir, "index.html"), "utf8");
      css = readFileSync(join(dir, "style.css"), "utf8");
    }
    const assets = new Map([...(swap?.photos ?? new Map<string, Uint8Array>())].map(([k, v]) => [k, Buffer.from(v)]));
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    let renders;
    try {
      renders = await renderPrototype(browser, { html, css }, assets, []);
    } finally {
      await browser.close();
    }
    if (renders.desktop_1440.blocked || renders.mobile_390.blocked) {
      process.stderr.write("refused: the page tried outside requests\n");
      return 1;
    }
    const compare: Record<string, PixelDiff> = {};
    if (compareDir) {
      for (const v of ["desktop_1440", "mobile_390"] as const) {
        const research = join(compareDir, `${v}.png`);
        if (existsSync(research)) compare[v] = await pixelDiff(renders[v].png, readFileSync(research));
      }
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
    const conversions = swap?.conversions ?? [];
    const pkg = await buildPackage({
      html,
      css,
      renders: { desktop_1440: renders.desktop_1440.png, mobile_390: renders.mobile_390.png },
      ...(swap
        ? {
            photos: swap.photos,
            images: swap.images,
            photoChecks: {
              count: conversions.length,
              lossless: conversions.filter((c) => c.mode === "lossless").length,
              lossless_after_srgb8_conversion: conversions.filter((c) => c.mode === "lossless_after_srgb8_conversion").length,
              lossy: conversions.filter((c) => c.mode === "lossy").length,
              min_quality: conversions.some((c) => c.mode === "lossy") ? Math.min(...conversions.map((c) => c.quality ?? 100)) : null,
              rewrite_html_refs: swap.proof.html.refs,
              rewrite_css_refs: swap.proof.css.refs,
            },
            local: { conversions, sources: swap.sources, rewrite_proof: swap.proof, compare },
          }
        : {}),
      source: swap ? "swap-copy" : source,
      validatorCommit: commit,
    });
    writePackage(out, pkg);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "OK",
          source: pkg.source,
          bundle_sha256: pkg.bundleSha256,
          files: pkg.manifest.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes, ...(f.width ? { width: f.width, height: f.height } : {}) })),
          originals: (pkg.workerChecks as { originals: unknown }).originals,
          ...(swap
            ? {
                photos: conversions.map((c) => ({ stored: c.stored, mode: c.mode, quality: c.quality, original_sha256: c.original.sha256, original_bytes: c.original.bytes, original_bit_depth: c.original.bit_depth, original_icc: c.original.icc, width: c.original.width, height: c.original.height, webp_bytes: c.webp_bytes })),
                rewrite_proof: swap.proof,
                rights_summary: pkg.rightsSummary,
                compare,
              }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof PackageError || e instanceof SwapInputError || e instanceof PhotoError || e instanceof SwapRightsError) {
      process.stdout.write(`${JSON.stringify({ status: "FAIL", code: e.code, details: e.details })}\n`);
      return 1;
    }
    throw e;
  }
}

main().then((code) => process.exit(code));
