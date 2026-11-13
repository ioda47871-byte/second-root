/**
 * DEV-196r (option C, owner approval 2026-11-11): build a demo version package from a committed B-route page
 * (index.html + style.css) and its full-page renders, offline, with the SAME checks the server applies
 * (lib/sales/demo-version: checkArtifactHtml, validateManifest, checkFileBytes, bundleSha256).
 *
 * The 4096 px limit (ARTIFACT_LIMITS.imageSidePx, also the database's check on sales_demo_version_files) is NOT
 * loosened: a render taller (or wider) than 4096 px is downscaled proportionally so its longest side is 4096, with a
 * high-quality filter (lanczos3), a fixed WebP quality and no metadata (deterministic for the same input). The
 * original full-size render's sha256, size and pixel size go into worker_checks for traceability. The 1:1 view of
 * the page is the live page tab. Raising the render limit (up to WebP's 16383) needs a migration on the
 * sales_demo_version_files check — pending the owner's approval (option 1).
 *
 * DEV-196s: a package may also hold a photo-swapped page's photos (WebP, prepared by swap-package.ts) and their
 * image records (`images`, the p_images of the ingest: AI demo pictures of the fictional 輪 only). The records are
 * checked against the manifest's photos (one each, same sha256 / size / pixel size) on build and on every read.
 *
 * DEV-199d (owner Issue #258, decision ②): format `sales_demo_version_package_v2` (PACKAGE_FORMAT_COPY) also holds the
 * page's copy in structured form — the facts pack, the copy record (copy.json), the copy quality review and its earlier
 * rounds — bound by sha256 in a separate copy manifest (`copy`, ./copy.ts) and checked again on build, on every read
 * and on import (verifyPackageCopy: re-hash, the existing copy check, the review re-audited). The page manifest
 * (ArtifactManifest version 1, the database's) and the bundle hash do not change: the copy files are never uploaded.
 * A v1 package (no copy) is still read, but only as `copy_unreviewed`, which can never become sendable.
 *
 * Node only (sharp, the file system). Not part of the pure library.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { ARTIFACT_LIMITS, bundleSha256, CSS_NAME, HTML_NAME, type ManifestFile, type RenderViewport } from "@/lib/sales/demo-version/manifest";
import { CopyPackageError, copyRoleOfName, makeCopyFiles, type CopyInput, type CopyManifest } from "./copy";
import { type PackageImage } from "./swap-rights";
import { checkPackageCopy, checkPackageFiles, checkPackageImages, PACKAGE_FORMAT, PACKAGE_FORMAT_COPY, PackageError, packageFromSource, packageRightsSummary, type DemoVersionPackage } from "./verify";

// DEV-263i: the pure checks live in ./verify (no sharp); re-exported so every existing import keeps working
export { checkPackageCopy, checkPackageFiles, checkPackageImages, PACKAGE_FORMAT, PACKAGE_FORMAT_COPY, PackageError, packageFromSource, packageRightsSummary, type DemoVersionPackage } from "./verify";

/** Fixed WebP settings (deterministic output for the same input). */
export const RENDER_WEBP = { quality: 85, effort: 6, smartSubsample: false } as const;
export const RENDER_SIDE_LIMIT = ARTIFACT_LIMITS.imageSidePx;
export const VIEWPORT_WIDTH: Readonly<Record<RenderViewport, number>> = { desktop_1440: 1440, tablet_768: 768, mobile_390: 390 };

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export type RenderOriginal = { sha256: string; bytes: number; width: number; height: number };
export type DownscaledRender = { webp: Uint8Array; width: number; height: number; original: RenderOriginal };

/**
 * One full-page PNG render → WebP whose longest side is at most RENDER_SIDE_LIMIT, proportionally (never enlarged).
 * Metadata is not written (sharp drops it unless asked). The result passes checkFileBytes as a render.
 */
export async function downscaleRender(png: Uint8Array): Promise<DownscaledRender> {
  const meta = await sharp(png).metadata();
  if (meta.format !== "png" || !meta.width || !meta.height) throw new PackageError("RENDER_NOT_PNG");
  const scale = Math.min(1, RENDER_SIDE_LIMIT / Math.max(meta.width, meta.height));
  const width = Math.max(1, Math.min(RENDER_SIDE_LIMIT, Math.round(meta.width * scale)));
  const height = Math.max(1, Math.min(RENDER_SIDE_LIMIT, Math.round(meta.height * scale)));
  const webp = await sharp(png)
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .webp({ ...RENDER_WEBP })
    .toBuffer();
  return { webp: new Uint8Array(webp), width, height, original: { sha256: sha256(png), bytes: png.byteLength, width: meta.width, height: meta.height } };
}

/** Builds the package: the page's two files and the downscaled renders, the manifest, and the same checks. */
export async function buildPackage(o: {
  html: string;
  css: string;
  /** full-page PNGs at deviceScaleFactor 1 */
  renders: Partial<Record<RenderViewport, Uint8Array>>;
  /** DEV-196s: the page's photos, by their URL path in the page (photos/<slot>-<range>.webp) */
  photos?: ReadonlyMap<string, Uint8Array>;
  /** DEV-196s: their image records (required with photos) */
  images?: readonly PackageImage[];
  /** DEV-196s: compact facts for worker_checks (kept within its size limit) */
  photoChecks?: Record<string, unknown>;
  local?: Record<string, unknown>;
  source: string;
  validatorCommit?: string | null;
  now?: Date;
  /** DEV-199d: the page's copy (facts pack, copy record, review and earlier rounds) → a v2 package */
  copy?: CopyInput;
}): Promise<DemoVersionPackage> {
  if (!o.renders.desktop_1440 || !o.renders.mobile_390) throw new PackageError("RENDER_MISSING");
  const files: Record<string, Uint8Array> = {
    [HTML_NAME]: new TextEncoder().encode(o.html),
    [CSS_NAME]: new TextEncoder().encode(o.css),
  };
  const entries: ManifestFile[] = [
    { name: HTML_NAME, role: "html", sha256: sha256(files[HTML_NAME]!), bytes: files[HTML_NAME]!.byteLength, content_type: "text/html" },
    { name: CSS_NAME, role: "css", sha256: sha256(files[CSS_NAME]!), bytes: files[CSS_NAME]!.byteLength, content_type: "text/css" },
  ];
  for (const [url, bytes] of [...(o.photos ?? new Map<string, Uint8Array>())].sort(([a], [b]) => a.localeCompare(b))) {
    const name = `page/${url}`;
    const meta = await sharp(bytes).metadata();
    if (meta.format !== "webp" || !meta.width || !meta.height) throw new PackageError("PHOTO_NOT_WEBP", [url]);
    files[name] = bytes;
    entries.push({ name, role: "photo", sha256: sha256(bytes), bytes: bytes.byteLength, content_type: "image/webp", width: meta.width, height: meta.height });
  }
  const originals: Record<string, RenderOriginal & { scaled: boolean }> = {};
  for (const viewport of ["desktop_1440", "tablet_768", "mobile_390"] as const) {
    const png = o.renders[viewport];
    if (!png) continue;
    const r = await downscaleRender(png);
    const name = `renders/${viewport}.webp`;
    files[name] = r.webp;
    entries.push({ name, role: "render", sha256: sha256(r.webp), bytes: r.webp.byteLength, content_type: "image/webp", width: r.width, height: r.height });
    originals[viewport] = { ...r.original, scaled: r.width !== r.original.width || r.height !== r.original.height };
  }
  const manifest = checkPackageFiles({ version: 1, files: entries }, files);
  const images = checkPackageImages(manifest, [...(o.images ?? [])]);
  const workerChecks = {
    // traceability of the full-size renders (the stored ones are downscaled to the 4096 px limit)
    renderer: "comp-lane renderPrototype: JavaScript off, network blocked, deviceScaleFactor 1",
    render_side_limit: RENDER_SIDE_LIMIT,
    webp: RENDER_WEBP,
    resize_kernel: "lanczos3",
    originals,
    ...(o.photoChecks ? { photos: o.photoChecks } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(workerChecks)) > 2000) throw new PackageError("WORKER_CHECKS_TOO_LARGE");
  const bundle = bundleSha256(manifest);
  let copy: { copy: CopyManifest; copyFiles: Record<string, Uint8Array> } | null = null;
  if (o.copy) {
    try {
      copy = makeCopyFiles(o.copy, bundle);
    } catch (e) {
      if (e instanceof CopyPackageError) throw new PackageError("COPY_INVALID", [e.code, ...e.details]);
      throw e;
    }
    // the same check as on read and import: a package whose copy would be refused is never built
    checkPackageCopy({ format: PACKAGE_FORMAT_COPY, manifest, bundleSha256: bundle, files, images, ...copy });
  }
  return {
    format: copy ? PACKAGE_FORMAT_COPY : PACKAGE_FORMAT,
    manifest,
    bundleSha256: bundle,
    files,
    workerChecks,
    validatorResult: { version: 1, ok: true, codes: [], validator_commit: o.validatorCommit ?? null, checked_at: (o.now ?? new Date()).toISOString() },
    rightsSummary: packageRightsSummary(images),
    images,
    ...(o.local ? { local: o.local } : {}),
    source: o.source,
    ...(copy ?? {}),
  };
}

const REPO = resolve(__dirname, "../..");

/** Whether a path is inside the repository (after following links of its nearest existing ancestor). */
export function insideRepo(p: string, repo: string = REPO): boolean {
  let probe = resolve(p);
  const rest: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    rest.unshift(basename(probe));
    probe = dirname(probe);
  }
  const real = join(realpathSync(probe), ...rest);
  const rel = relative(realpathSync(repo), real);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

type PackageMeta = Omit<DemoVersionPackage, "files" | "copyFiles">;

/** Writes the package directory (outside the repository only): package.json (meta + manifest) and the files. */
export function writePackage(dir: string, pkg: DemoVersionPackage, repo?: string): void {
  if (insideRepo(dir, repo)) throw new PackageError("OUT_INSIDE_REPOSITORY");
  const meta: PackageMeta = { format: pkg.format, manifest: pkg.manifest, bundleSha256: pkg.bundleSha256, workerChecks: pkg.workerChecks, validatorResult: pkg.validatorResult, rightsSummary: pkg.rightsSummary, images: pkg.images, ...(pkg.local ? { local: pkg.local } : {}), source: pkg.source, ...(pkg.copy ? { copy: pkg.copy } : {}) };
  // DEV-199d (Fresh Review L6): only the copy manifest's fixed names are written; anything else is refused before writing
  for (const name of Object.keys(pkg.copyFiles ?? {})) if (!copyRoleOfName(name)) throw new PackageError("COPY_INVALID", ["COPY_NAME_NOT_ALLOWED", name]);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of [...Object.entries(pkg.files), ...Object.entries(pkg.copyFiles ?? {})]) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Reads a package directory and verifies it again (re-hash and the same checks, packageFromSource). Throws PackageError. */
export function readPackage(dir: string): DemoVersionPackage {
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    throw new PackageError("PACKAGE_UNREADABLE");
  }
  return packageFromSource(meta, {
    pageFile: (name) => (existsSync(join(dir, name)) ? new Uint8Array(readFileSync(join(dir, name))) : null),
    copySize: (name) => {
      const path = join(dir, name);
      if (!existsSync(path)) return null;
      const st = statSync(path);
      return st.isFile() ? st.size : -1;
    },
    copyFile: (name) => new Uint8Array(readFileSync(join(dir, name))),
  });
}
