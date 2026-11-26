/**
 * DEV-303 §6.1 row 12, first experiment: the static build of a shop repository (what Cloudflare Pages would run on
 * each commit; here only locally). It reads content/ (content-model.ts), renders the shop's own page code (a ShopSite,
 * shop-site.ts: the bakery unless another site is given), copies the pictures the content names from media/ and writes dist/ (index.html, style.css, media/)
 * plus the generated .pages.yml next to the content. No server, no network, no script on the page.
 *
 * A picture the content names but the repository does not have is reported (missing_media) and the build stops
 * (BUILD_MEDIA_MISSING): a failed build keeps the last good publish on Cloudflare Pages (Q2), so stopping is safe.
 */
import { copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadContent } from "./content-model";
import { pagesYaml } from "./pages-config";
import { priceDisplayReport, type PriceReport } from "./price-display";
import { BAKERY_SITE, type ShopSite } from "./shop-site";

export class BuildError extends Error {
  constructor(
    readonly code: "BUILD_MEDIA_MISSING" | "BUILD_OUT_NOT_EMPTY",
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = "BuildError";
  }
}

export type BuildResult = { html: string; css: string; media: string[]; price_report: PriceReport };

/**
 * Builds <repo>/content + media into <outDir> (absent or empty) with the site's profile (fixed name, its trade
 * extensions) and page code. `today` decides which closures are still ahead. The 総額表示 report rides along: advice only, it never
 * stops the build and never changes a price.
 */
export async function buildSite(o: { repo: string; outDir: string; today: string; site?: ShopSite }): Promise<BuildResult> {
  const site = o.site ?? BAKERY_SITE;
  const content = await loadContent(o.repo, site.profile);
  const existing = await lstat(o.outDir).catch(() => null);
  if (existing && (!existing.isDirectory() || (await readdir(o.outDir)).length > 0)) throw new BuildError("BUILD_OUT_NOT_EMPTY", basename(o.outDir));
  const { html, css } = site.render(content, o.today);
  const named = [...new Set(content.menu.filter((m) => m.visible && m.image).map((m) => m.image.replace(/^\/media\//, "")))].sort();
  for (const n of named) {
    const st = await lstat(join(o.repo, "media", n)).catch(() => null);
    if (!st || !st.isFile()) throw new BuildError("BUILD_MEDIA_MISSING", n);
  }
  await mkdir(join(o.outDir, "media"), { recursive: true });
  for (const n of named) await copyFile(join(o.repo, "media", n), join(o.outDir, "media", n));
  await writeFile(join(o.outDir, "index.html"), html);
  await writeFile(join(o.outDir, "style.css"), css);
  return { html, css, media: named, price_report: priceDisplayReport(content) };
}

/** Writes the generated .pages.yml at the repository root (the CMS configuration, derived from the content model). */
export async function writePagesYaml(repo: string, site: ShopSite = BAKERY_SITE): Promise<string> {
  const text = pagesYaml({ extensions: site.profile.extensions });
  await writeFile(join(repo, ".pages.yml"), text);
  return text;
}
