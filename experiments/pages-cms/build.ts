/**
 * DEV-303 §6.1 row 12, first experiment: the static build of a shop repository (what Cloudflare Pages would run on
 * each commit; here only locally). It reads content/ (content-model.ts), renders the shop's own page code (a ShopSite,
 * shop-site.ts: the bakery unless another site is given), copies the pictures the page shows from media/ and writes
 * dist/ (index.html, style.css, media/) plus the generated .pages.yml next to the content. No server, no network, no
 * script on the page.
 *
 * PR (4): every picture the page shows is checked first (photos.ts: missing, type, bytes, pixel size, ratio) and the
 * build stops with a CONTENT_PHOTO_* code; a failed build keeps the last good publish on Cloudflare Pages (Q2), so
 * stopping is safe. Pictures are copied unchanged (no build-time optimisation: see the plan, PR (4) evaluation).
 */
import { copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadContent } from "./content-model";
import { pagesYaml } from "./pages-config";
import { checkPhotos, photoProvenance, type PhotoCheck, type PhotoProvenance } from "./photos";
import { priceDisplayReport, type PriceReport } from "./price-display";
import { BAKERY_SITE, type ShopSite } from "./shop-site";

export class BuildError extends Error {
  constructor(
    readonly code: "BUILD_OUT_NOT_EMPTY",
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = "BuildError";
  }
}

export type BuildResult = { html: string; css: string; media: string[]; photos: PhotoCheck[]; provenance: PhotoProvenance[]; price_report: PriceReport };

/**
 * Builds <repo>/content + media into <outDir> (absent or empty) with the site's profile (fixed name, its trade
 * extensions) and page code. `today` decides which closures are still ahead. The 総額表示 report rides along: advice only, it never
 * stops the build and never changes a price.
 */
/** provenanceDir (DEV-364 PR 2a): the private folder (outside the repository) of the B pictures' rights records.
 * delivery: Second Root's delivery build (refuses customer pictures, class C); separate from provenanceDir so an audit
 * with the private folder keeps legitimate C pictures (review #371 Low). */
export async function buildSite(o: { repo: string; outDir: string; today: string; site?: ShopSite; provenanceDir?: string; delivery?: boolean }): Promise<BuildResult> {
  const site = o.site ?? BAKERY_SITE;
  const content = await loadContent(o.repo, site.profile);
  const existing = await lstat(o.outDir).catch(() => null);
  if (existing && (!existing.isDirectory() || (await readdir(o.outDir)).length > 0)) throw new BuildError("BUILD_OUT_NOT_EMPTY", basename(o.outDir));
  const { html, css } = site.render(content, o.today);
  const photos = await checkPhotos(o.repo, content, site.profile);
  const provenance = await photoProvenance(o.repo, content, photos, { ...(o.provenanceDir ? { provenanceDir: o.provenanceDir } : {}), ...(o.delivery ? { delivery: true } : {}) });
  const named = photos.map((p) => p.file);
  await mkdir(join(o.outDir, "media"), { recursive: true });
  for (const n of named) await copyFile(join(o.repo, "media", n), join(o.outDir, "media", n));
  await writeFile(join(o.outDir, "index.html"), html);
  await writeFile(join(o.outDir, "style.css"), css);
  return { html, css, media: named, photos, provenance, price_report: priceDisplayReport(content) };
}

/** Writes the generated .pages.yml at the repository root (the CMS configuration, derived from the content model). */
export async function writePagesYaml(repo: string, site: ShopSite = BAKERY_SITE): Promise<string> {
  const text = pagesYaml({ extensions: site.profile.extensions });
  await writeFile(join(repo, ".pages.yml"), text);
  return text;
}
