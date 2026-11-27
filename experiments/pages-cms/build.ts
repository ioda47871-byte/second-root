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
import { ContentError, loadContent } from "./content-model";
import { pagesYaml } from "./pages-config";
import { appliedSlots, checkPhotoSlots, loadPhotoSlots, slotCss, type AppliedSlot, type SlotContext } from "./photo-slots";
import { checkPhotos, loadGeneratedEntries, photoProvenance, type PhotoCheck, type PhotoProvenance } from "./photos";
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

export type BuildResult = { html: string; css: string; media: string[]; photos: PhotoCheck[]; provenance: PhotoProvenance[]; slots: AppliedSlot[]; price_report: PriceReport };

/**
 * Builds <repo>/content + media into <outDir> (absent or empty) with the site's profile (fixed name, its trade
 * extensions) and page code. `today` decides which closures are still ahead. The 総額表示 report rides along: advice only, it never
 * stops the build and never changes a price.
 */
/** provenanceDir (DEV-364 PR 2a): the private folder (outside the repository) of the B pictures' rights records.
 * delivery: Second Root's delivery build (refuses customer pictures, class C); separate from provenanceDir so an audit
 * with the private folder keeps legitimate C pictures (review #371 Low); it requires provenanceDir (a delivery checks the
 * full B rights records, not just the index: CONTENT_DELIVERY_RIGHTS_DIR_MISSING, before anything is read).
 * DEV-364 PR 2b: the photo-slot spec (content/photo-slots.json, photo-slots.ts) — the page applies each slot's
 * object-position to the pictures of its materials (data-slot + the appended CSS); without a spec the output is unchanged.
 * Review #372 M1: a delivery build of a repository with a spec needs slotContext (the approval, the approved materials,
 * the approved image sizes) and runs checkPhotoSlots (CONTENT_SLOTS_*), or stops (CONTENT_DELIVERY_SLOT_CONTEXT_MISSING). */
export async function buildSite(o: { repo: string; outDir: string; today: string; site?: ShopSite; provenanceDir?: string; delivery?: boolean; slotContext?: SlotContext }): Promise<BuildResult> {
  if (o.delivery && !o.provenanceDir) throw new ContentError("CONTENT_DELIVERY_RIGHTS_DIR_MISSING", "provenanceDir");
  const site = o.site ?? BAKERY_SITE;
  const content = await loadContent(o.repo, site.profile);
  const existing = await lstat(o.outDir).catch(() => null);
  if (existing && (!existing.isDirectory() || (await readdir(o.outDir)).length > 0)) throw new BuildError("BUILD_OUT_NOT_EMPTY", basename(o.outDir));
  const photos = await checkPhotos(o.repo, content, site.profile);
  const provenance = await photoProvenance(o.repo, content, photos, { ...(o.provenanceDir ? { provenanceDir: o.provenanceDir } : {}), ...(o.delivery ? { delivery: true } : {}) });
  const spec = await loadPhotoSlots(o.repo);
  if (spec && o.delivery) {
    if (!o.slotContext) throw new ContentError("CONTENT_DELIVERY_SLOT_CONTEXT_MISSING", "slotContext");
    checkPhotoSlots(spec, o.slotContext);
  }
  const slots = appliedSlots(spec, photos, await loadGeneratedEntries(o.repo));
  const slotOf = new Map(slots.map((a) => [`/media/${a.file}`, a.slot]));
  const page = site.render(content, o.today, slots.length ? (image: string) => slotOf.get(image) : undefined);
  const html = page.html;
  const css = page.css + slotCss(slots, site.spMaxWidth);
  const named = photos.map((p) => p.file);
  await mkdir(join(o.outDir, "media"), { recursive: true });
  for (const n of named) await copyFile(join(o.repo, "media", n), join(o.outDir, "media", n));
  await writeFile(join(o.outDir, "index.html"), html);
  await writeFile(join(o.outDir, "style.css"), css);
  return { html, css, media: named, photos, provenance, slots, price_report: priceDisplayReport(content) };
}

/** Writes the generated .pages.yml at the repository root (the CMS configuration, derived from the content model). */
export async function writePagesYaml(repo: string, site: ShopSite = BAKERY_SITE): Promise<string> {
  const text = pagesYaml({ extensions: site.profile.extensions, ...(site.profile.collections ? { collections: site.profile.collections } : {}) });
  await writeFile(join(repo, ".pages.yml"), text);
  return text;
}
