/**
 * DEV-303 §6.1 change 8 (docs/design/image-first-production-flow.md §1 stage 6): compare the implemented static site with
 * the owner-approved whole-page design of a request-mode run.
 *
 *   approved design  the delivered bundle + its review and approval records (design-approval.ts approvedDesignRun: the
 *                    bundle verified, five axes, approval bound to review / page / images, decision approve, no axis
 *                    fail). Any DESIGN_* stop is this module's stop with the same code. One PC and one SP whole-page
 *                    picture (a section-split run is not compared here: IMPL_DESIGN_NOT_WHOLE_PAGE).
 *   site             a private folder OUTSIDE the repository (e.g. ~/second-root-shops/<shop_id>/site-<n>/): index.html,
 *                    style.css and assets/*.png only are served (the existing renderer's rule); no link anywhere, size
 *                    caps; anything else in the folder is never read or served.
 *   capture          the IMAGE_FIRST adapter (imported directly; owner approval 2026-11-25): Chromium, JS off, network blocked, PC 1440 and SP 390
 *                    full pages; the approved picture drawn at the same width; page-level comparison with the existing
 *                    impl-lane machinery (grid SSIM, colour blocks, edge IoU, height ratio; DEV-131 cause codes) plus
 *                    what the capture shows (horizontal overflow, requests not served such as a missing picture). A
 *                    capture that fails is a stop (IMPL_CAPTURE_FAILED), never a clean result.
 *   output           a private folder OUTSIDE the repository (empty or absent; 0700, files 0600, never overwritten):
 *                    record.json (`sr_impl_compare_v1`: the approval's SHA-256s, the site files' and captures' SHA-256s,
 *                    per-viewport scores, differences and findings, tool versions), images/ (the scaled design and the
 *                    capture per viewport) and index.html, a static review page (no script, no network, the case-study
 *                    page's CSP, every text escaped).
 *
 * ADVICE for the owner's review (production flow §1 stage 6 and §3.3): `passing` is always false and no score decides
 * anything. Failures throw ImplCompareStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Browser } from "playwright";
import { escapeHtml, VIEWING_PAGE_CSP } from "../case-study/case-study";
import { approvedDesignRun, DesignApprovalStop } from "./design-approval";
import { compareApprovedDesign, toApprovedImplInput, type ApprovedCompareReport } from "../image-first/adapter";

export const IMPL_COMPARE_SCHEMA = "sr_impl_compare_v1";
/** The site files the renderer serves, and their caps (the implementation lane comparison's IMPL_COMPARE_LIMITS, restated). */
export const SITE_LIMITS = { html: 384 * 1024, css: 256 * 1024, asset: 16 * 1024 * 1024, assets: 32 } as const;
/** All the site files together (index.html, style.css and every asset): 64 MiB, so 32 large assets cannot add up. */
export const SITE_TOTAL_MAX = 64 * 1024 * 1024;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const IMPL_COMPARE_CODES = [
  "IMPL_DESIGN_NOT_WHOLE_PAGE",
  "IMPL_SITE_MISSING",
  "IMPL_SITE_IN_REPO",
  "IMPL_SITE_UNSAFE",
  "IMPL_SITE_INVALID",
  "IMPL_SITE_TOO_LARGE",
  "IMPL_SITE_TOTAL_TOO_LARGE",
  "IMPL_OUT_IN_REPO",
  "IMPL_OUT_NOT_EMPTY",
  "IMPL_CAPTURE_FAILED",
] as const;
export class ImplCompareStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ImplCompareStop";
  }
}
const stop = (code: (typeof IMPL_COMPARE_CODES)[number]): never => {
  throw new ImplCompareStop(code);
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The served site, read once: its bytes are what is drawn and hashed. */
export type Site = { html: string; css: string; assets: Map<string, Buffer>; files: { path: string; sha256: string; bytes: number }[] };

async function readFileNoFollow(path: string, max: number): Promise<Buffer | null> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    return stop("IMPL_SITE_UNSAFE");
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1) stop("IMPL_SITE_UNSAFE");
    if (st.size > max) stop("IMPL_SITE_TOO_LARGE");
    const b = await h.readFile();
    if (b.length > max) stop("IMPL_SITE_TOO_LARGE");
    return b;
  } finally {
    await h.close();
  }
}

/** Opens a directory with O_DIRECTORY | O_NOFOLLOW (a link or a file is refused by the kernel, not only by lstat). */
async function openDirNoFollow(path: string): Promise<"dir" | "missing" | "not_dir"> {
  let h: Awaited<ReturnType<typeof open>> | null = null;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return (await h.stat()).isDirectory() ? "dir" : "not_dir";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "not_dir";
  } finally {
    await h?.close().catch(() => undefined);
  }
}

/** The implemented site folder: outside the repository, real (no link on the path), index.html + style.css + assets/*.png. */
export async function readSite(siteDir: string, repo: string): Promise<Site> {
  const dir = resolve(siteDir);
  const real = await realpath(dir).catch(() => null);
  if (real === null) return stop("IMPL_SITE_MISSING");
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (within(real, realRepo) || within(dir, resolve(repo))) stop("IMPL_SITE_IN_REPO");
  if (real !== dir) stop("IMPL_SITE_UNSAFE");
  if ((await openDirNoFollow(dir)) !== "dir") stop("IMPL_SITE_INVALID");
  const html = await readFileNoFollow(join(dir, "index.html"), SITE_LIMITS.html);
  const css = await readFileNoFollow(join(dir, "style.css"), SITE_LIMITS.css);
  if (!html || !css) return stop("IMPL_SITE_INVALID");
  let total = html.length + css.length;
  const files = [
    { path: "index.html", sha256: sha256(html), bytes: html.length },
    { path: "style.css", sha256: sha256(css), bytes: css.length },
  ];
  const assets = new Map<string, Buffer>();
  const assetsDir = join(dir, "assets");
  const ai = await openDirNoFollow(assetsDir);
  if (ai !== "missing") {
    if (ai !== "dir") stop("IMPL_SITE_UNSAFE");
    const names = (await readdir(assetsDir)).sort();
    if (names.length > SITE_LIMITS.assets) stop("IMPL_SITE_TOO_LARGE");
    for (const name of names) {
      if (!ASSET_NAME.test(name)) stop("IMPL_SITE_INVALID");
      const b = await readFileNoFollow(join(assetsDir, name), SITE_LIMITS.asset);
      if (!b || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return stop("IMPL_SITE_INVALID");
      total += b.length;
      if (total > SITE_TOTAL_MAX) stop("IMPL_SITE_TOTAL_TOO_LARGE");
      assets.set(`assets/${name}`, b);
      files.push({ path: `assets/${name}`, sha256: sha256(b), bytes: b.length });
    }
  }
  return { html: html.toString("utf8"), css: css.toString("utf8"), assets, files };
}

/** The nearest existing ancestor's real path joined with the rest (a link above is resolved). */
async function realPlace(path: string): Promise<string | null> {
  const rest: string[] = [];
  let anc = resolve(path);
  while (!(await lstat(anc).then(() => true, () => false))) {
    const up = dirname(anc);
    if (up === anc) return null;
    rest.unshift(basename(anc));
    anc = up;
  }
  const real = await realpath(anc).catch(() => null);
  return real === null ? null : join(real, ...rest);
}

/** The output folder: outside the repository (links resolved), empty or absent, ours and private; created 0700. */
async function prepareOut(outDir: string, repo: string): Promise<string> {
  const out = resolve(outDir);
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  const inRepo = (p: string | null) => p === null || within(p, realRepo) || within(p, resolve(repo));
  if (inRepo(out) || inRepo(await realPlace(out))) stop("IMPL_OUT_IN_REPO");
  const existing = await lstat(out).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(out)).length > 0 || existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0)) stop("IMPL_OUT_NOT_EMPTY");
  await mkdir(join(out, "images"), { recursive: true, mode: 0o700 });
  if (inRepo(await realpath(out).catch(() => null))) stop("IMPL_OUT_IN_REPO");
  const images = await lstat(join(out, "images")).catch(() => null);
  if (!images || !images.isDirectory() || images.isSymbolicLink()) stop("IMPL_OUT_NOT_EMPTY");
  return out;
}

const VIEWPORTS = ["desktop_1440", "mobile_390"] as const;
const TAG = { desktop_1440: "pc", mobile_390: "sp" } as const;

export type ImplCompareRecord = {
  schema: typeof IMPL_COMPARE_SCHEMA;
  advisory: true;
  passing: false;
  status: ApprovedCompareReport["status"];
  request_id: string;
  approved: { bundle_sha256: string; review_sha256: string; approval_sha256: string };
  site: { files: { path: string; sha256: string; bytes: number }[] };
  viewports: Record<
    (typeof VIEWPORTS)[number],
    {
      design: { source_file: string; source_sha256: string; scaled_sha256: string; width: number; height: number };
      capture: { sha256: string; height: number; scroll_width: number; blocked_requests: number };
      page: { ssim: number; colour_blocks: number; edges_iou: number; height_ratio: number } | null;
      code: string | null;
      differences: string[];
      findings: string[];
    }
  >;
  differences: string[];
  findings: string[];
  measured: string[];
  not_measured: string[];
  tools: { chromium: string; comparison: string };
  created_at: string;
};

const MEASURED = ["page layout (grid SSIM)", "colour blocks", "edge density (edge IoU)", "page height ratio (an overview: expected to differ)", "horizontal overflow", "requests the page made that were not served (e.g. a missing picture)"];
const NOT_MEASURED = ["section order, position, colour and size per section (a whole-page picture declares no section boxes)", "text content and Japanese wording (the copy audit and the owner)", "fine detail (the approved picture is the page drawn smaller)", "the page's true proportions in the page-level scores (the capture is squeezed to the design picture's aspect before they are computed; the heights are recorded as they are)"];

// ---- the private review page ---------------------------------------------------------------------------------------

/** The review page (pure): the approval's SHA-256s, both viewports' design and capture side by side, scores, findings; escaped. */
export function renderImplComparePage(r: ImplCompareRecord): string {
  const e = escapeHtml;
  const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : e(String(n)));
  const list = (items: string[]) => (items.length ? `<ul>${items.map((t) => `<li><code>${e(t)}</code></li>`).join("")}</ul>` : "<p>なし</p>");
  const views = VIEWPORTS.map((v) => {
    const x = r.viewports[v];
    return `<section><h2>${v === "desktop_1440" ? "PC 1440" : "SP 390"}</h2>
<div class="pair"><figure><img src="images/${TAG[v]}-design.png" alt="承認したデザイン"><figcaption>承認したデザイン（${e(x.design.source_file)}、幅 ${num(x.design.width)} に拡大縮小）<br><code>${e(x.design.source_sha256)}</code></figcaption></figure>
<figure><img src="images/${TAG[v]}-capture.png" alt="実装の画面"><figcaption>実装（Chromium、JS なし、通信なし）<br><code>${e(x.capture.sha256)}</code></figcaption></figure></div>
<table><tr><th>配置の近さ（SSIM）</th><td>${num(x.page?.ssim)}</td></tr><tr><th>色の塊</th><td>${num(x.page?.colour_blocks)}</td></tr><tr><th>線の密度（edge IoU）</th><td>${num(x.page?.edges_iou)}</td></tr><tr><th>高さの比</th><td>${num(x.page?.height_ratio)}</td></tr><tr><th>横幅（scroll）</th><td>${num(x.capture.scroll_width)}</td></tr><tr><th>読み込めなかった要求</th><td>${num(x.capture.blocked_requests)}</td></tr></table>
<h3>違い（DEV-131 の暫定の閾値）</h3>${list(x.differences)}<h3>画面の所見</h3>${list(x.findings)}</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEWING_PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${e(r.request_id)} 実装と承認したデザインの比較</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1b; --bg: #fbfaf7; --muted: #6a6862; --line: #d9d6cf; }
@media (prefers-color-scheme: dark) { :root { --fg: #ecebe7; --bg: #171716; --muted: #a3a19b; --line: #3a3936; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; line-height: 1.7; }
main { max-width: 1200px; margin: 0 auto; }
h2 { border-top: 1px solid var(--line); padding-top: 20px; }
.pair { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 0; flex: 1 1 360px; max-width: 100%; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
figcaption, code { font-size: 0.8rem; color: var(--muted); word-break: break-all; }
th { text-align: left; padding-right: 16px; font-weight: normal; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${e(r.request_id)} — 実装と承認したデザインの比較（非公開・ローカル）</h1>
<p>段 6 の比較は<strong>オーナーの確認のための助言</strong>で、合否を決めない（passing は常に false）。承認: bundle <code>${e(r.approved.bundle_sha256)}</code>、承認の記録 <code>${e(r.approved.approval_sha256)}</code>。</p>
<p>測るもの: ${MEASURED.map(e).join("、")}。測らないもの: ${NOT_MEASURED.map(e).join("、")}。</p>
${views}
</main>
</body>
</html>
`;
}

/**
 * The comparison of an approved run with its implemented site (see the header). `browser` null (it did not start):
 * IMPL_CAPTURE_FAILED. Writes only into the new output folder.
 */
export async function runImplCompare(o: { bundleDir: string; reviewPath: string; approvalPath: string; siteDir: string; outDir: string; repo: string; browser: Browser | null; now?: () => number }): Promise<{ record: ImplCompareRecord; record_sha256: string; page: string; page_sha256: string }> {
  let a;
  try {
    a = await approvedDesignRun({ bundleDir: o.bundleDir, reviewPath: o.reviewPath, approvalPath: o.approvalPath, repo: o.repo });
  } catch (error) {
    if (error instanceof DesignApprovalStop) throw new ImplCompareStop(error.code);
    throw error;
  }
  if (a.images.pc.length !== 1 || a.images.sp.length !== 1) stop("IMPL_DESIGN_NOT_WHOLE_PAGE");
  const site = await readSite(o.siteDir, o.repo);
  const out = await prepareOut(o.outDir, o.repo);
  if (!o.browser) return stop("IMPL_CAPTURE_FAILED");
  const input = await toApprovedImplInput(o.browser, { request_id: a.request_id, bundle_sha256: a.bundle_sha256, review_sha256: a.review_sha256, approval_sha256: a.approval_sha256, pictures: { desktop_1440: a.images.pc[0]!, mobile_390: a.images.sp[0]! } }).catch(() => stop("IMPL_CAPTURE_FAILED"));
  const report = await compareApprovedDesign(o.browser, input, { html: site.html, css: site.css, assets: site.assets });
  if (VIEWPORTS.some((v) => report.viewports[v].implementation.state !== "rendered" || !report.viewports[v].implementation.png)) stop("IMPL_CAPTURE_FAILED");
  const now = o.now ?? Date.now;
  const viewports = Object.fromEntries(
    VIEWPORTS.map((v) => {
      const x = report.viewports[v];
      const im = x.implementation;
      return [v, { design: x.design, capture: { sha256: im.png_sha256!, height: im.height!, scroll_width: im.scroll_width!, blocked_requests: im.blocked_requests! }, page: x.compare?.page ?? null, code: x.compare?.code ?? null, differences: x.differences, findings: x.findings }];
    }),
  ) as ImplCompareRecord["viewports"];
  const record: ImplCompareRecord = {
    schema: IMPL_COMPARE_SCHEMA,
    advisory: true,
    passing: false,
    status: report.status,
    request_id: a.request_id,
    approved: { bundle_sha256: a.bundle_sha256, review_sha256: a.review_sha256, approval_sha256: a.approval_sha256 },
    site: { files: site.files },
    viewports,
    differences: report.differences,
    findings: report.findings,
    measured: MEASURED,
    not_measured: NOT_MEASURED,
    tools: { chromium: o.browser.version(), comparison: "the implementation lane comparison (DEV-131 provisional thresholds) via the IMAGE_FIRST adapter compareApprovedDesign" },
    created_at: new Date(now()).toISOString(),
  };
  const write = async (rel: string, bytes: Buffer | string) => {
    const h = await open(join(out, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(bytes);
    } finally {
      await h.close();
    }
  };
  for (const v of VIEWPORTS) {
    await write(`images/${TAG[v]}-design.png`, input.viewports[v].png);
    await write(`images/${TAG[v]}-capture.png`, report.viewports[v].implementation.png!);
  }
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  await write("record.json", recordText);
  const html = renderImplComparePage(record);
  await write("index.html", html);
  return { record, record_sha256: sha256(recordText), page: join(out, "index.html"), page_sha256: sha256(html) };
}
