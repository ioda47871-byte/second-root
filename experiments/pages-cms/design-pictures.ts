/**
 * PR #390 (the repository's image lock): Second Root keeps a site's design RECORD only (design/<site>/generated-materials.json);
 * the design pictures themselves stay outside its git. Before Second Root builds such a site (Q1, the export), this
 * stages them: it takes the pictures from an outside folder, finds each by the SHA-256 the record gives (whatever the
 * file is called there), and copies it under the record's file name, with the record, into a working folder. The site
 * is then built from that folder by the unchanged build (photos.ts loadDesignMaterials checks every byte again).
 *
 * Second Root only: this file is NOT part of the delivery repository (export-delivery.ts SITE_FILES), whose
 * site/design/<site>/ already holds the record and the pictures the export placed there.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ContentError } from "./content-model";
import { DESIGN_RECORD, PHOTO_LIMITS } from "./photos";
import type { ShopSite } from "./shop-site";

/** The default outside folder: $SR_DESIGN_DIR, else ~/second-root-trial/sorairo-source (where the owner's files are). */
export const DEFAULT_DESIGN_DIR = process.env.SR_DESIGN_DIR ?? join(homedir(), "second-root-trial", "sorairo-source");

/**
 * Stages <site>'s design pictures from <picturesDir> into <into> (created) and returns the site built from there.
 * recordDir: the record to follow (default the site's committed record). A site without design is returned as it is.
 * A missing folder, or a picture whose recorded bytes are not in it: CONTENT_PHOTO_MISSING (the build's own code).
 */
export async function stageDesignPictures(site: ShopSite, picturesDir: string, into: string, recordDir?: string): Promise<ShopSite> {
  if (!site.design) return site;
  const from = recordDir ?? site.design.dir;
  let record: { files?: { file?: unknown; sha256?: unknown }[] };
  try {
    record = JSON.parse((await readFile(join(from, DESIGN_RECORD))).toString("utf8")) as typeof record;
  } catch {
    throw new ContentError("CONTENT_GENERATED_RECORD_MISSING", `design/${DESIGN_RECORD}`);
  }
  const names = await readdir(picturesDir).catch(() => null);
  if (!names) throw new ContentError("CONTENT_PHOTO_MISSING", "design pictures folder");
  const bySha = new Map<string, string>();
  for (const n of names.sort().slice(0, 200)) {
    const p = join(picturesDir, n);
    const st = await lstat(p).catch(() => null);
    if (!st || !st.isFile() || st.size > PHOTO_LIMITS.bytes) continue;
    bySha.set(createHash("sha256").update(await readFile(p)).digest("hex"), p);
  }
  await mkdir(into, { recursive: true });
  await copyFile(join(from, DESIGN_RECORD), join(into, DESIGN_RECORD));
  for (const file of [...new Set(site.design.pictures.map((p) => p.file))].sort()) {
    const want = (record.files ?? []).find((e) => e.file === file);
    const path = typeof want?.sha256 === "string" ? bySha.get(want.sha256) : undefined;
    if (!path) throw new ContentError("CONTENT_PHOTO_MISSING", `design/${file}`);
    await copyFile(path, join(into, file));
  }
  return { ...site, design: { ...site.design, dir: into } };
}
