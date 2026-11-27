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
 * DEV-263a (Issue #263): or package a committed photo-less comp WITH its copy, as a v2 package (sales_demo_version_package_v2):
 *
 *   npx tsx scripts/sales/demo-version/package-local.ts --out <dir outside the repository> \
 *     --copy <comp dir with index.html, style.css, copy.json, copy-review.json [, copy-rounds/<i>/]> --facts <facts-pack.json> [--png-out <dir>]
 *
 * The page is the comp's own index.html / style.css; the copy is its facts pack, copy record, copy review
 * (scripts/design-artifact/comp-copy.ts --audit) and the earlier rounds of the revision chain, handed to buildPackage's
 * `copy` as bytes (lib/demo-version-package/local-inputs.ts compCopyInput). buildPackage checks the copy again and
 * refuses what fails. Without --copy, nothing changes (a v1 package as before).
 *
 * DEV-139: or package a photo-swapped page WITH its copy, as a v2 package holding both (the photo mode above plus --facts):
 *
 *   npx tsx scripts/sales/demo-version/package-local.ts --out <dir outside the repository> \
 *     --page <swap>/page --rights <rights.private.json> --originals <photo dir> --depiction-confirmation <file> \
 *     --facts <facts-pack.json> [--summary <swap-summary.json>] [--compare-renders <dir>] [--png-out <dir>]
 *
 * Every photo check of the photo mode runs unchanged (prepareSwap). The copy is the swap page's own copy.json (bound to
 * the research page by the summary's source copy hash) with each swapped placeholder caption item (写真｜<alt>) turned
 * into the picture's alt text, and the existing copy audit of exactly the stored page as round 0 (package.ts
 * swapCopyInput → copy.ts deriveSwapCopy); buildPackage checks the copy again and refuses what fails. --copy (a comp dir) stays photo-less.
 *
 * Renders PC 1440 and SP 390 full pages with the comp-lane renderer (renderPrototype: JavaScript off, network blocked,
 * deviceScaleFactor 1, this machine's fonts as in the research renders), downscales any render whose side exceeds
 * 4096 px (the server's limit; see lib/demo-version-package/package.ts), builds the manifest and runs the same checks
 * the server runs, then writes the package (refused inside the repository). With --compare-renders, the full-size
 * renders are compared pixel by pixel with the research renders (desktop_1440.png, mobile_390.png). Prints ids, hashes,
 * sizes and modes only (never a path of the inputs, an owner, a consent record or a provenance).
 * Exit 0 on success, 1 when a check fails, 2 for a usage error.
 *
 * DEV-364 (origin marker, quality-proof-plan §2.10 / §6 row 3b): --source and --copy refuse a folder holding the
 * IMAGE_FIRST origin marker (sr-origin.json, written by the IMAGE_FIRST staging: experiments/pages-cms/stage-for-gates.ts)
 * with FAIL IMAGE_FIRST_OUTPUT, before anything is read or rendered. An IMAGE_FIRST page is packaged only by its own mode,
 * which needs the second approval (a later PR). The marker is a TRIPWIRE against a mistake, NOT tamper-proof (deleting
 * it defeats it); the real binding is the page's SHA-256 in the second approval and, later, the DB send gate. A folder
 * without the marker is packaged exactly as before.
 *
 * DEV-364 PR 3b (the owner's approval 2026-11-27, option (a): the one import of final-approval.ts, for this mode only):
 * the IMAGE_FIRST packaging mode, the only way an IMAGE_FIRST page is packaged:
 *
 *   npx tsx scripts/sales/demo-version/package-local.ts --imagefirst <staged site> --out <dir outside the repository> \
 *     --design-bundle <dir> --design-review <f> --design-approval <f> \
 *     --materials-bundle <dir> --materials-review <f> --materials-approval <f> \
 *     --slots <photo-slots.json> --provenance-dir <private dir> --impl-compare <comparison dir> \
 *     --final-review <f> --final-approval <f>
 *
 * It runs the second approval's gate (final-approval.ts approvedFinal: the first approval, the approved materials, the
 * slot spec, A / B provenance only, the comparison and its captures, every SHA-256 recomputed) and writes <out>/site/
 * with exactly the bytes the gate read and hashed (approvedFinal's contents: the approved build, UNCONVERTED; nothing is
 * read a second time) and <out>/imagefirst-package.json (sr_imagefirst_package_v1: the files bound to the final
 * approval's SHA-256s). Any refusal of the gate is FAIL with its FINAL_* / DESIGN_* / MATERIALS_* code; nothing is written.
 * This is a LOCAL package of the approved files, not the uploadable sales demo package (that format needs WebP photos and
 * their image records: converting the photos needs the sr_photo_transform_v1 record, left for a later step). No DB, no
 * send guard, nothing published or sent.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { renderPrototype } from "../../../lib/design-agent/phase2f/render-prototype";
import { compCopyInput, LocalInputError, type CompCopyInput } from "../../../lib/demo-version-package/local-inputs";
import { approvedFinal, FinalApprovalStop } from "../../../lib/design-agent/imagefirst-worker/final-approval";
import { buildPackage, insideRepo, PackageError, swapCopyInput, writePackage } from "../../../lib/demo-version-package/package";
import { forbiddenHashes, PhotoError, pixelDiff, prepareSwap, readOriginals, readSwapCopyInputs, readSwapPage, SwapInputError, SwapRightsError, type PixelDiff, type PreparedSwap } from "../../../lib/demo-version-package/swap-package";

const REPO = resolve(__dirname, "../../..");
const DEFAULT_SOURCE = "design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9";
/** The IMAGE_FIRST origin marker's file name (stage-for-gates.ts ORIGIN_MARKER, restated: no new import here). */
export const IMAGE_FIRST_ORIGIN_MARKER = "sr-origin.json";
/** Whether a folder holds the marker (any kind of entry by that name, a link included: lstat, never followed). */
const hasOriginMarker = (dir: string) => {
  try {
    lstatSync(join(dir, IMAGE_FIRST_ORIGIN_MARKER));
    return true;
  } catch {
    return false;
  }
};

/**
 * DEV-139 (PR #288 review M1): the programmatic entry. `seams` is for in-process tests only (the CLI below passes none):
 * `aiDemoSpecFor` stands in for the frozen swap specs (photo-swap-shops.ts) when the photos' image records are built,
 * `write` / `writeErr` capture what the CLI prints.
 */
export type PackageLocalSeams = { aiDemoSpecFor?: Parameters<typeof prepareSwap>[0]["aiDemoSpecFor"]; write?: (s: string) => void; writeErr?: (s: string) => void };
export async function main(argv: string[], seams: PackageLocalSeams = {}): Promise<number> {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out_ = seams.write ?? ((s: string) => void process.stdout.write(s));
  const err_ = seams.writeErr ?? ((s: string) => void process.stderr.write(s));
  // DEV-364 PR 3b: the IMAGE_FIRST mode is its own path (the other modes below are unchanged)
  if (argv.includes("--imagefirst")) return imageFirstPackage(argv, out_, err_);
  const out = arg("--out");
  const page = arg("--page");
  const rightsPath = arg("--rights");
  const originalsDir = arg("--originals");
  const depictionPath = arg("--depiction-confirmation");
  const summaryPath = arg("--summary") ?? (page ? join(dirname(resolve(page)), "swap-summary.json") : undefined);
  const compareDir = arg("--compare-renders");
  const source = arg("--source") ?? DEFAULT_SOURCE;
  const pngOut = arg("--png-out");
  const copyDir = arg("--copy");
  const factsArg = arg("--facts");
  if (!out || (copyDir ? !factsArg || page || arg("--source") : factsArg && !page) || (page && arg("--source")) || (page && (!rightsPath || !originalsDir || !depictionPath)) || (!page && (rightsPath || originalsDir || depictionPath || arg("--summary") || compareDir))) {
    err_(
      "usage: package-local.ts --out <dir outside the repository> [--source <comp dir>] [--png-out <dir>]\n" +
        "       package-local.ts --out <dir> --copy <comp dir> --facts <facts-pack.json> [--png-out <dir>]\n" +
        "       package-local.ts --out <dir> --page <swap>/page --rights <rights.private.json> --originals <photo dir> --depiction-confirmation <file> [--facts <facts-pack.json>] [--summary <swap-summary.json>] [--compare-renders <dir>] [--png-out <dir>]\n",
    );
    return 2;
  }
  if (insideRepo(out) || (pngOut && insideRepo(pngOut))) {
    err_("refused: write the package outside the repository\n");
    return 2;
  }
  // DEV-364: the IMAGE_FIRST output is never packaged by --source / --copy (a tripwire; see the header)
  const plainDir = copyDir ? resolve(copyDir) : page ? null : resolve(REPO, source);
  if (plainDir && hasOriginMarker(plainDir)) {
    out_(`${JSON.stringify({ status: "FAIL", code: "IMAGE_FIRST_OUTPUT" })}\n`);
    return 1;
  }
  try {
    let html: string;
    let css: string;
    let swap: PreparedSwap | null = null;
    let compCopy: CompCopyInput | null = null;
    let swapCopy: ReturnType<typeof swapCopyInput> | null = null;
    if (copyDir) {
      compCopy = compCopyInput(resolve(copyDir), resolve(factsArg!));
      html = compCopy.html;
      css = compCopy.css;
    } else if (page) {
      if (!summaryPath || !existsSync(summaryPath)) throw new SwapInputError("SUMMARY_MISSING");
      const read = (p: string, code: string) => {
        try {
          return JSON.parse(readFileSync(p, "utf8")) as unknown;
        } catch {
          throw new SwapInputError(code);
        }
      };
      const summary = read(summaryPath, "SUMMARY_UNREADABLE");
      swap = await prepareSwap({
        page: readSwapPage(page),
        rights: read(rightsPath!, "RIGHTS_UNREADABLE"),
        depictions: read(depictionPath!, "DEPICTION_CONFIRMATION_UNREADABLE"),
        summary,
        originals: readOriginals(originalsDir!),
        forbiddenSha256: forbiddenHashes(REPO),
        now: new Date().toISOString().slice(0, 10),
        ...(seams.aiDemoSpecFor ? { aiDemoSpecFor: seams.aiDemoSpecFor } : {}),
      });
      html = swap.html;
      css = swap.css;
      // DEV-139: --facts with --page: the swapped page's copy (its copy.json, the placeholder captions → alt texts) → v2
      if (factsArg) {
        const inputs = readSwapCopyInputs(resolve(page), resolve(factsArg));
        swapCopy = swapCopyInput({ ...inputs, summary, html, css, photoUrls: new Set(swap.photos.keys()) });
      }
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
      err_("refused: the page tried outside requests\n");
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
      ...(compCopy ? { copy: compCopy.copy } : swapCopy ? { copy: swapCopy.copy } : {}),
      source: swap ? "swap-copy" : compCopy ? (insideRepo(copyDir!) ? relative(REPO, resolve(copyDir!)).split(sep).join("/") : "comp-copy") : source,
      validatorCommit: commit,
    });
    writePackage(out, pkg);
    out_(
      `${JSON.stringify(
        {
          status: "OK",
          source: pkg.source,
          bundle_sha256: pkg.bundleSha256,
          ...(pkg.copy ? { format: pkg.format, copy_files: pkg.copy.files.map((f) => ({ name: f.name, role: f.role, sha256: f.sha256, bytes: f.bytes })) } : {}),
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
    if (e instanceof LocalInputError) {
      out_(`${JSON.stringify({ status: "FAIL", code: e.code })}\n`);
      return 1;
    }
    if (e instanceof PackageError || e instanceof SwapInputError || e instanceof PhotoError || e instanceof SwapRightsError) {
      out_(`${JSON.stringify({ status: "FAIL", code: e.code, details: e.details })}\n`);
      return 1;
    }
    throw e;
  }
}

const IMAGE_FIRST_FLAGS = ["--imagefirst", "--out", "--design-bundle", "--design-review", "--design-approval", "--materials-bundle", "--materials-review", "--materials-approval", "--slots", "--provenance-dir", "--impl-compare", "--final-review", "--final-approval"] as const;
export const IMAGE_FIRST_PACKAGE_SCHEMA = "sr_imagefirst_package_v1";

/**
 * DEV-364 PR 3b: the IMAGE_FIRST packaging mode (see the header). The only code path that uses final-approval.ts.
 * Exit 0 written, 1 refused (FAIL with a code), 2 usage.
 */
async function imageFirstPackage(argv: string[], out_: (s: string) => void, err_: (s: string) => void): Promise<number> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const v = argv[i + 1];
    if (!(IMAGE_FIRST_FLAGS as readonly string[]).includes(k) || !v || v.startsWith("--") || k in o) {
      err_("usage: package-local.ts --imagefirst <staged site> --out <dir> --design-bundle <dir> --design-review <f> --design-approval <f> --materials-bundle <dir> --materials-review <f> --materials-approval <f> --slots <f> --provenance-dir <dir> --impl-compare <dir> --final-review <f> --final-approval <f>\n");
      return 2;
    }
    o[k] = v;
  }
  if (IMAGE_FIRST_FLAGS.some((k) => !o[k])) {
    err_("usage: package-local.ts --imagefirst needs every one of its flags\n");
    return 2;
  }
  const out = resolve(o["--out"]!);
  if (insideRepo(out)) {
    err_("refused: write the package outside the repository\n");
    return 2;
  }
  if (existsSync(out) && (!lstatSync(out).isDirectory() || readdirSync(out).length > 0)) {
    out_(`${JSON.stringify({ status: "FAIL", code: "IMAGE_FIRST_OUT_NOT_EMPTY" })}\n`);
    return 1;
  }
  let approved;
  try {
    approved = await approvedFinal({
      design: { bundleDir: resolve(o["--design-bundle"]!), reviewPath: resolve(o["--design-review"]!), approvalPath: resolve(o["--design-approval"]!) },
      materials: { bundleDir: resolve(o["--materials-bundle"]!), reviewPath: resolve(o["--materials-review"]!), approvalPath: resolve(o["--materials-approval"]!) },
      slotsPath: resolve(o["--slots"]!),
      provenanceDir: resolve(o["--provenance-dir"]!),
      siteDir: resolve(o["--imagefirst"]!),
      implCompareDir: resolve(o["--impl-compare"]!),
      reviewPath: resolve(o["--final-review"]!),
      approvalPath: resolve(o["--final-approval"]!),
      repo: REPO,
    });
  } catch (e) {
    if (e instanceof FinalApprovalStop) {
      out_(`${JSON.stringify({ status: "FAIL", code: e.code })}\n`);
      return 1;
    }
    throw e;
  }
  // the bytes written are exactly the ones the gate read and hashed (approvedFinal's contents): no second read here
  const listed = approved.files;
  if (listed.length !== approved.contents.size || listed.some((f) => approved.contents.get(f.path)?.length !== f.bytes)) {
    out_(`${JSON.stringify({ status: "FAIL", code: "IMAGE_FIRST_FILES_MISMATCH" })}\n`);
    return 1;
  }
  mkdirSync(join(out, "site", "assets"), { recursive: true, mode: 0o700 });
  for (const f of listed) writeFileSync(join(out, "site", f.path), approved.contents.get(f.path)!, { mode: 0o600 });
  const manifest = {
    schema: IMAGE_FIRST_PACKAGE_SCHEMA,
    design: approved.design,
    final_review_sha256: approved.review_sha256,
    final_page_sha256: approved.page_sha256,
    final_approval_sha256: approved.approval_sha256,
    build_files_sha256: approved.build_files_sha256,
    files: listed,
    converted: false,
    uploadable_demo_package: false,
    note: "the approved files, unconverted; the uploadable sales demo package (WebP photos and their image records, with sr_photo_transform_v1) is a later step",
  };
  writeFileSync(join(out, "imagefirst-package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  out_(`${JSON.stringify({ status: "OK", mode: "imagefirst", final_approval_sha256: approved.approval_sha256, build_files_sha256: approved.build_files_sha256, files: listed }, null, 2)}\n`);
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
