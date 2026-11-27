/**
 * Issue #380 PR 3: writes a STANDALONE shop repository (the delivery-repo template) for one fictional site — what the
 * customer's own repository would hold: content/ + media/ (a fictional sample), the generated .pages.yml, the build
 * (delivery-template/build.mjs, photo-prep.mjs), the site's page code and checks copied verbatim from this folder into
 * site/ (one implementation: these very files, never a rewrite), its own pinned package.json and lockfile, its tests,
 * and the Cloudflare Pages settings in its README. It does not depend on Second Root, holds no secret and no model.
 *
 *   npx tsx experiments/pages-cms/export-delivery.ts --out <empty dir outside the repository> [--site auto] [--fixture works-10]
 *
 * LOCAL only: nothing is pushed, uploaded or published (a real repository / Pages project needs the owner's approval).
 * The output is deterministic: the same commit writes the same bytes (tests/unit/experiments/pages-cms-delivery.test.ts).
 * Its dependencies (sharp, tsx, zod — exact versions) live only in ITS package.json, never in Second Root's.
 */
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { writeFixture } from "./fixtures";
import { pagesYaml } from "./pages-config";
import { SHOP_SITES } from "./shop-site";

const HERE = __dirname;
const REPO = resolve(HERE, "../..");
const TEMPLATE = join(HERE, "delivery-template");

/** The page code and checks the build needs (build.ts's import closure), copied verbatim into site/. */
export const SITE_FILES = [
  "auto-fixtures.ts",
  "auto-site.ts",
  "bakery-site.ts",
  "build.ts",
  "cafe-fixtures.ts",
  "cafe-site.ts",
  "content-model.ts",
  "fixtures.ts",
  "image-meta.ts",
  "pages-config.ts",
  "photo-slots.ts",
  "photos.ts",
  "price-display.ts",
  "provenance.ts",
  "shop-site.ts",
] as const;
/** Template file → its name in the exported repository. */
export const TEMPLATE_FILES: Record<string, string> = {
  "build.mjs": "build.mjs",
  "photo-prep.mjs": "photo-prep.mjs",
  "README.md": "README.md",
  "gitignore.template": ".gitignore",
  "package.template.json": "package.json",
  "package-lock.template.json": "package-lock.json",
  "tests/template.test.mjs": "tests/template.test.mjs",
};
export const NODE_VERSION = "22";

export class ExportError extends Error {
  constructor(readonly code: "EXPORT_OUT_UNSAFE" | "EXPORT_SITE_UNKNOWN" | "EXPORT_FIXTURE_UNKNOWN", detail: string) {
    super(`${code} ${detail}`);
    this.name = "ExportError";
  }
}

async function safeOut(outDir: string): Promise<string> {
  const out = resolve(outDir);
  const realRepo = await realpath(REPO);
  const parent = await realpath(resolve(out, "..")).catch(() => null);
  const outside = (p: string) => relative(realRepo, p).startsWith("..");
  if (!parent || !outside(parent)) throw new ExportError("EXPORT_OUT_UNSAFE", basename(out));
  const st = await lstat(out).catch(() => null);
  if (st && (!st.isDirectory() || st.isSymbolicLink() || (await readdir(out)).length > 0)) throw new ExportError("EXPORT_OUT_UNSAFE", basename(out));
  await mkdir(out, { recursive: true });
  return out;
}

/** Writes the standalone repository into <outDir> (absent or empty, outside Second Root). Returns its files. */
export async function exportDelivery(o: { outDir: string; site?: string; fixture?: string }): Promise<string[]> {
  const site = SHOP_SITES.find((s) => s.id === (o.site ?? "auto"));
  if (!site) throw new ExportError("EXPORT_SITE_UNKNOWN", String(o.site));
  const fixtureName = o.fixture ?? (site.id === "auto" ? "works-10" : "items-10");
  const fixture = site.fixtures()[fixtureName];
  if (!fixture) throw new ExportError("EXPORT_FIXTURE_UNKNOWN", fixtureName);
  const out = await safeOut(o.outDir);
  // the sample content: written by the fixture writer into a scratch folder; only content/ and media/ are taken
  // (a fixture's private B records go next to its folder — they never enter the exported repository)
  const scratch = await mkdtemp(join(tmpdir(), "sr-export-delivery-"));
  try {
    const sample = join(scratch, "repo");
    await writeFixture(sample, fixture);
    await cp(join(sample, "content"), join(out, "content"), { recursive: true });
    await cp(join(sample, "media"), join(out, "media"), { recursive: true });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await mkdir(join(out, "site"), { recursive: true });
  for (const f of SITE_FILES) await copyFile(join(HERE, f), join(out, "site", f));
  await mkdir(join(out, "tests"), { recursive: true });
  for (const [from, to] of Object.entries(TEMPLATE_FILES)) await copyFile(join(TEMPLATE, from), join(out, to));
  await writeFile(join(out, ".pages.yml"), pagesYaml({ extensions: site.profile.extensions, ...(site.profile.collections ? { collections: site.profile.collections } : {}) }));
  await writeFile(join(out, "site.config.json"), `${JSON.stringify({ site: site.id }, null, 2)}\n`);
  await writeFile(join(out, ".node-version"), `${NODE_VERSION}\n`);
  return listFiles(out);
}

/** Every file under <dir>, relative, sorted. */
export async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

export const readText = (p: string) => readFile(p, "utf8");

if (require.main === module) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const outDir = arg("--out");
  if (!outDir) {
    process.stdout.write('{"status":"refused","code":"ARGS_INVALID"}\n');
    process.exit(2);
  }
  exportDelivery({ outDir, ...(arg("--site") ? { site: arg("--site")! } : {}), ...(arg("--fixture") ? { fixture: arg("--fixture")! } : {}) }).then(
    (files) => process.stdout.write(`${JSON.stringify({ status: "written", files: files.length })}\n`),
    (error: unknown) => {
      process.stdout.write(`${JSON.stringify({ status: "stopped", code: error instanceof Error ? error.message : "EXPORT_FAILED" })}\n`);
      process.exit(2);
    },
  );
}
