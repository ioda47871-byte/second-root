// The shop site's build (what Cloudflare Pages runs on every commit: `npm run build`, output dist/).
//
//   1. The CMS configuration is fixed: .pages.yml (Pages CMS) and, when site.config.json has a `sveltia` entry,
//      admin/config.yml (Sveltia CMS, Issue #380 PoC) must each be exactly what the site's content model generates
//      (PAGES_YML_CHANGED / SVELTIA_CONFIG_CHANGED); at least one must exist (NO_CMS_CONFIG). The Sveltia admin page
//      (admin/) is published at /admin/ only when it is configured.
//   2. content/ and media/ are copied into a working folder (.build/); the repository's files are never changed.
//   3. photo-prep.mjs fits the customer's own photos (not the delivered generated materials, not the shop-provided B
//      photos — those keep their exact bytes) into the photo limits, upright, without metadata.
//   4. The site's page code (site/, a copy of Second Root's experiments/pages-cms, generated — do not edit) builds the
//      page from the working copy with every content and photo check.
//   5. Only when everything passed does the new page replace dist/. A stopped build leaves dist/ as it was (and on
//      Cloudflare Pages the last successful deployment stays published).
//
// No network, no secrets, no model. Node 22 (see .node-version).
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import { preparePhotos } from "./photo-prep.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Today in Japan (YYYY-MM-DD): which special closures are still ahead. */
export const tokyoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export class TemplateBuildError extends Error {
  constructor(code, detail) {
    super(`${code} ${detail}`);
    this.name = "TemplateBuildError";
    this.code = code;
    this.file = detail;
  }
}

let unregister;
async function siteModules(root) {
  unregister ??= register();
  const load = (name) => import(pathToFileURL(join(root, "site", name)).href);
  const [build, shopSite, pagesConfig, contentModel, photos, provenance, sveltiaConfig] = await Promise.all([
    load("build.ts"),
    load("shop-site.ts"),
    load("pages-config.ts"),
    load("content-model.ts"),
    load("photos.ts"),
    load("provenance.ts"),
    load("sveltia-config.ts"),
  ]);
  return { build, shopSite, pagesConfig, contentModel, photos, provenance, sveltiaConfig };
}

const exists = (p) => stat(p).then(() => true, () => false);

/**
 * Builds <root> into <root>/dist. Returns the photo report. Throws the site's ContentError (code, file) or a
 * TemplateBuildError; dist/ is then unchanged.
 */
export async function build({ root = HERE, today = tokyoToday() } = {}) {
  const m = await siteModules(root);
  const config = JSON.parse(await readFile(join(root, "site.config.json"), "utf8"));
  const site = m.shopSite.SHOP_SITES.find((s) => s.id === config.site);
  if (!site) throw new TemplateBuildError("SITE_UNKNOWN", String(config.site));
  // 1. the CMS configuration is fixed (each one that exists; at least one)
  const schema = { extensions: site.profile.extensions, ...(site.profile.collections ? { collections: site.profile.collections } : {}) };
  const pagesYml = await readFile(join(root, ".pages.yml"), "utf8").catch(() => null);
  if (pagesYml !== null && pagesYml !== m.pagesConfig.pagesYaml(schema)) throw new TemplateBuildError("PAGES_YML_CHANGED", ".pages.yml");
  const adminYml = await readFile(join(root, "admin", "config.yml"), "utf8").catch(() => null);
  if (adminYml !== null && !config.sveltia) throw new TemplateBuildError("SVELTIA_CONFIG_CHANGED", "admin/config.yml without site.config.json sveltia");
  if (config.sveltia && adminYml !== m.sveltiaConfig.sveltiaYaml(schema, config.sveltia)) throw new TemplateBuildError("SVELTIA_CONFIG_CHANGED", "admin/config.yml");
  // the admin page too (the pinned script, its integrity and the CSP)
  if (config.sveltia && (await readFile(join(root, "admin", "index.html"), "utf8").catch(() => null)) !== m.sveltiaConfig.sveltiaAdminHtml(config.sveltia)) throw new TemplateBuildError("SVELTIA_CONFIG_CHANGED", "admin/index.html");
  if (pagesYml === null && adminYml === null) throw new TemplateBuildError("NO_CMS_CONFIG", ".pages.yml");
  // 2. the working copy
  const work = join(root, ".build");
  await rm(work, { recursive: true, force: true });
  const repo = join(work, "repo");
  await mkdir(repo, { recursive: true });
  for (const d of ["content", "media"]) if (await exists(join(root, d))) await cp(join(root, d), join(repo, d), { recursive: true });
  // 3. the customer's photos, fitted (only the pictures the page shows; the rest is not published)
  const content = await m.contentModel.loadContent(repo, site.profile);
  const names = [...new Set(m.contentModel.shownPictures(content).map((p) => p.image.replace(/^\/media\//, "")))].sort();
  // (the site's own static design pictures count as generated too: a copy of their bytes in media/ is never re-encoded,
  // so the content checks still recognise it)
  const designShas = site.design ? (await m.photos.loadDesignMaterials(site.design)).shas : new Set();
  const protectedShas = new Set([...(await m.photos.loadGeneratedRecord(repo, site.profile.generatedDelivered === true)), ...(await m.provenance.loadProvenanceIndex(repo)).keys(), ...designShas]);
  const photos = await preparePhotos({ media: join(repo, "media"), names, protectedShas, limits: m.photos.PHOTO_LIMITS });
  // 4. the page, with every check
  const next = join(work, "dist");
  const result = await m.build.buildSite({ repo, outDir: next, today, site });
  // the Sveltia admin page (its own page: it loads the pinned Sveltia script; the shop's page never links to it)
  if (config.sveltia) {
    await mkdir(join(next, "admin"), { recursive: true });
    for (const f of ["index.html", "config.yml"]) await cp(join(root, "admin", f), join(next, "admin", f));
  }
  // 5. swap in only now
  const dist = join(root, "dist");
  const old = join(work, "dist-old");
  if (await exists(dist)) await rename(dist, old);
  await rename(next, dist);
  await writeFile(join(work, "photo-report.json"), `${JSON.stringify(photos, null, 2)}\n`);
  return { photos, media: result.media };
}

/** The plain message for a stopped build (photo codes carry the customer advice). */
export async function explain(error, root = HERE) {
  const code = error?.code ?? "BUILD_FAILED";
  const file = error?.file ?? "";
  let advice = "";
  try {
    advice = (await siteModules(root)).photos.PHOTO_ADVICE?.[code] ?? "";
  } catch {
    // the message still names the code
  }
  return `build stopped: ${code} ${file}${advice ? `\n${advice}` : ""}\nThe last published page stays as it was.`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build().then(
    (r) => {
      const changed = r.photos.filter((p) => p.action !== "kept").length;
      process.stdout.write(`build ok: ${r.media.length} pictures (${changed} customer photos fitted or re-encoded without metadata)\n`);
    },
    async (error) => {
      process.stderr.write(`${await explain(error)}\n`);
      process.exit(1);
    },
  );
}
