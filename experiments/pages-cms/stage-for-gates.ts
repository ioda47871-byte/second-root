/**
 * PR (5): the read-only bridge from a CMS build (dist/: index.html, style.css, media/*) to the two existing gate
 * checks, which read an implementation-lane folder (index.html, style.css, assets/*):
 *
 *   impl-compare-approved   (stage 6: the implemented site against the approved whole-page design)
 *   materials-impl-check    (stage 5: only approved materials, byte-identical, in a <figure> with イメージ)
 *
 * stageForGates copies the built page into an EMPTY private folder outside the repository (0700) in that shape:
 * every `src="/media/<name>"` becomes `src="assets/<name>"` and media/<name> is copied, unchanged, to assets/<name>
 * (so the materials check still compares the exact bytes). Nothing else of the page changes; dist/ is only read.
 * Both checks then run on the staged folder exactly as they run on a hand-made implementation, through their own
 * modules or CLIs — no gate module is imported here and no import pin changes.
 *
 * Stops (StageError): STAGE_DIST_INVALID (no index.html / style.css, a link, an odd file name), STAGE_MEDIA_REFERENCE
 * (the page still names /media/ after the rewrite, e.g. a CSS url() or a srcset the rewrite does not cover),
 * STAGE_ASSET_NOT_PNG (impl-compare-approved serves PNG assets only: a JPEG / WebP picture cannot be compared yet —
 * a documented gap), and the output folder's own codes (q1-check safeOutDir).
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeOutDir } from "./q1-check";

export class StageError extends Error {
  constructor(
    readonly code: "STAGE_DIST_INVALID" | "STAGE_MEDIA_REFERENCE" | "STAGE_ASSET_NOT_PNG",
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = "StageError";
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function regularFile(path: string, what: string): Promise<Buffer> {
  const st = await lstat(path).catch(() => null);
  if (!st || !st.isFile()) throw new StageError("STAGE_DIST_INVALID", what);
  return readFile(path);
}

export type Staged = { dir: string; rewrites: number; assets: string[] };

/** Stages <dist> as an implementation-lane folder in <outDir> (outside the repository, empty or absent). */
export async function stageForGates(o: { dist: string; outDir: string }): Promise<Staged> {
  const html = (await regularFile(join(o.dist, "index.html"), "index.html")).toString("utf8");
  const css = await regularFile(join(o.dist, "style.css"), "style.css");
  const mediaDir = join(o.dist, "media");
  const media = (await lstat(mediaDir).catch(() => null))?.isDirectory() ? (await readdir(mediaDir)).sort() : [];
  const files: [string, Buffer][] = [];
  for (const name of media) {
    if (!NAME.test(name)) throw new StageError("STAGE_DIST_INVALID", `media/${name}`);
    const bytes = await regularFile(join(mediaDir, name), `media/${name}`);
    if (!name.toLowerCase().endsWith(".png") || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new StageError("STAGE_ASSET_NOT_PNG", name);
    files.push([name, bytes]);
  }
  let rewrites = 0;
  const staged = html.replace(/(\ssrc=")\/media\/([A-Za-z0-9][A-Za-z0-9._-]{0,80})"/g, (_m, pre: string, name: string) => {
    rewrites++;
    return `${pre}assets/${name}"`;
  });
  if (/\/media\//.test(staged) || /\/media\//.test(css.toString("utf8"))) throw new StageError("STAGE_MEDIA_REFERENCE", "/media/");
  const out = await safeOutDir(o.outDir);
  await mkdir(join(out, "assets"), { mode: 0o700 });
  await writeFile(join(out, "index.html"), staged, { mode: 0o600 });
  await writeFile(join(out, "style.css"), css, { mode: 0o600 });
  for (const [name, bytes] of files) await writeFile(join(out, "assets", name), bytes, { mode: 0o600 });
  return { dir: out, rewrites, assets: files.map(([n]) => `assets/${n}`) };
}
