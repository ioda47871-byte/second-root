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
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";
import {
  ARTIFACT_LIMITS,
  bundleSha256,
  checkFileBytes,
  CSS_NAME,
  HTML_NAME,
  validateManifest,
  type ArtifactManifest,
  type ManifestFile,
  type RenderViewport,
} from "@/lib/sales/demo-version/manifest";
import type { RightsSummary } from "@/lib/sales/demo-version/rights";
import { COPY_LIMITS, CopyManifest, CopyPackageError, copyRoleOfName, LEGACY_COPY_RESULT, makeCopyFiles, verifyPackageCopy, type CopyInput, type PackageCopyResult } from "./copy";
import { packageImageProblems, type PackageImage } from "./swap-rights";

export const PACKAGE_FORMAT = "sales_demo_version_package_v1";
/** DEV-199d: v1 + the copy files and their copy manifest (`copy`). */
export const PACKAGE_FORMAT_COPY = "sales_demo_version_package_v2";
/** Fixed WebP settings (deterministic output for the same input). */
export const RENDER_WEBP = { quality: 85, effort: 6, smartSubsample: false } as const;
export const RENDER_SIDE_LIMIT = ARTIFACT_LIMITS.imageSidePx;
export const VIEWPORT_WIDTH: Readonly<Record<RenderViewport, number>> = { desktop_1440: 1440, tablet_768: 768, mobile_390: 390 };

export class PackageError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${code}: ${details.join(",")}` : code);
  }
}

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

export type DemoVersionPackage = {
  format: typeof PACKAGE_FORMAT | typeof PACKAGE_FORMAT_COPY;
  manifest: ArtifactManifest;
  bundleSha256: string;
  /** manifest name → bytes */
  files: Record<string, Uint8Array>;
  workerChecks: Record<string, unknown>;
  validatorResult: { version: 1; ok: true; codes: string[]; validator_commit: string | null; checked_at: string };
  rightsSummary: RightsSummary;
  /** DEV-196s: the p_images of the ingest, one per photo of the manifest (empty for a page without photos) */
  images: PackageImage[];
  /** DEV-196s: the package's own local record (never sent to the database): conversions, sources, proofs, comparison */
  local?: Record<string, unknown>;
  /** where the page came from (a repository path, or "swap-copy" for a photo-swapped page), for the record only */
  source: string;
  /** DEV-199d (v2 only): the copy manifest — names, roles, sha256 and sizes of the copy files, and the page bundle */
  copy?: CopyManifest;
  /** DEV-199d (v2 only): copy file name → bytes (never in the page manifest, never uploaded) */
  copyFiles?: Record<string, Uint8Array>;
};

/**
 * DEV-199d: the package's copy, checked on its bytes. v1 (no copy) → `copy_unreviewed` (never sendable); a v1 package
 * carrying copy files, or a v2 package without them, is refused. Throws PackageError("COPY_INVALID", [code, ...]).
 */
export function checkPackageCopy(pkg: Pick<DemoVersionPackage, "format" | "manifest" | "bundleSha256" | "files" | "images" | "copy" | "copyFiles">, o: Parameters<typeof verifyPackageCopy>[1] = {}): PackageCopyResult {
  if (pkg.format === PACKAGE_FORMAT) {
    if (pkg.copy !== undefined || pkg.copyFiles !== undefined) throw new PackageError("COPY_INVALID", ["COPY_IN_V1_PACKAGE"]);
    return LEGACY_COPY_RESULT;
  }
  if (pkg.format !== PACKAGE_FORMAT_COPY) throw new PackageError("PACKAGE_FORMAT");
  try {
    return verifyPackageCopy(pkg, o);
  } catch (e) {
    if (e instanceof CopyPackageError) throw new PackageError("COPY_INVALID", [e.code, ...e.details]);
    throw e;
  }
}

/**
 * DEV-196s: the image records against the manifest: exactly one record per photo (same sha256, size and pixel size),
 * no record without a photo, every record in the fixed AI-demo shape. Throws PackageError("IMAGES_INVALID").
 */
export function checkPackageImages(manifest: ArtifactManifest, images: readonly unknown[]): PackageImage[] {
  const photos = manifest.files.filter((f) => f.role === "photo");
  if (!Array.isArray(images) || images.length !== photos.length) throw new PackageError("IMAGES_INVALID", ["count"]);
  const bySha = new Map<string, unknown>();
  for (const e of images) {
    const problems = packageImageProblems(e);
    if (problems.length) throw new PackageError("IMAGES_INVALID", problems);
    const sha = (e as PackageImage).sha256;
    if (bySha.has(sha)) throw new PackageError("IMAGES_INVALID", ["duplicate"]);
    bySha.set(sha, e);
  }
  for (const f of photos) {
    const e = bySha.get(f.sha256) as PackageImage | undefined;
    if (!e || e.bytes !== f.bytes || e.width !== f.width || e.height !== f.height) throw new PackageError("IMAGES_INVALID", [f.name]);
  }
  return images as PackageImage[];
}

/** The §8.4 summary of a package's images (all AI demo pictures, admin preview only). */
export function packageRightsSummary(images: readonly PackageImage[]): RightsSummary {
  const expiries = images.map((i) => i.rights_expiry).filter((e): e is string => e !== null).sort();
  return images.length === 0
    ? { version: 1, photos: 0, by_status: {}, earliest_expiry: null, label_required: false }
    : { version: 1, photos: images.length, by_status: { ai_demo_internal: images.length }, earliest_expiry: expiries[0] ?? null, label_required: true };
}

/** Everything the server would check, on bytes in memory. Throws PackageError with the fixed codes. */
export function checkPackageFiles(manifest: unknown, files: Readonly<Record<string, Uint8Array>>): ArtifactManifest {
  const m = validateManifest(manifest);
  if (!m.ok) throw new PackageError("MANIFEST_INVALID", m.codes);
  const names = new Set(m.manifest.files.map((f) => f.name));
  for (const name of Object.keys(files)) if (!names.has(name)) throw new PackageError("FILE_NOT_IN_MANIFEST", [name]);
  for (const entry of m.manifest.files) {
    const bytes = files[entry.name];
    if (!bytes) throw new PackageError("FILE_MISSING", [entry.name]);
    const checked = checkFileBytes(entry, bytes);
    if (!checked.ok) throw new PackageError("FILE_CHECK_FAILED", [entry.name, ...checked.codes]);
  }
  const html = new TextDecoder("utf-8", { fatal: true }).decode(files[HTML_NAME]);
  const css = new TextDecoder("utf-8", { fatal: true }).decode(files[CSS_NAME]);
  const photos = new Set(m.manifest.files.filter((f) => f.role === "photo").map((f) => f.name.slice("page/".length)));
  const safety = checkArtifactHtml(html, css, photos);
  if (!safety.ok) throw new PackageError("HTML_CHECK_FAILED", safety.findings.map((f) => f.code));
  return m.manifest;
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

/** Reads a package directory and verifies it again (re-hash and the same checks). Throws PackageError. */
export function readPackage(dir: string): DemoVersionPackage {
  let meta: PackageMeta;
  try {
    meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageMeta;
  } catch {
    throw new PackageError("PACKAGE_UNREADABLE");
  }
  if (meta.format !== PACKAGE_FORMAT && meta.format !== PACKAGE_FORMAT_COPY) throw new PackageError("PACKAGE_FORMAT");
  const m = validateManifest(meta.manifest);
  if (!m.ok) throw new PackageError("MANIFEST_INVALID", m.codes);
  const files: Record<string, Uint8Array> = {};
  for (const f of m.manifest.files) {
    // names are the manifest's fixed shapes (no "..", no absolute path): validateManifest refused anything else
    const path = join(dir, f.name);
    if (!existsSync(path)) throw new PackageError("FILE_MISSING", [f.name]);
    files[f.name] = new Uint8Array(readFileSync(path));
  }
  const manifest = checkPackageFiles(m.manifest, files);
  if (bundleSha256(manifest) !== meta.bundleSha256) throw new PackageError("BUNDLE_MISMATCH");
  if (meta.validatorResult?.ok !== true) throw new PackageError("VALIDATOR_NOT_OK");
  // a package written before DEV-196s has no images: only valid when it has no photos
  const images = checkPackageImages(manifest, meta.images ?? []);
  const summary = packageRightsSummary(images);
  if (JSON.stringify(meta.rightsSummary) !== JSON.stringify(summary)) throw new PackageError("RIGHTS_SUMMARY_MISMATCH");
  // DEV-199d: the copy files, read only by the names the copy manifest's schema allows, then checked on their bytes
  let copyFiles: Record<string, Uint8Array> | undefined;
  if (meta.format === PACKAGE_FORMAT_COPY) {
    copyFiles = {};
    // the schema first (it caps the number of files and each size), then every name, role and the total, then each
    // file's size on disk against its entry — nothing is read before all of that holds (Fresh Review L5)
    const cm = CopyManifest.safeParse(meta.copy);
    if (!cm.success) throw new PackageError("COPY_INVALID", ["COPY_MANIFEST_INVALID"]);
    let total = 0;
    for (const f of cm.data.files) {
      const role = copyRoleOfName(f.name);
      if (!role) throw new PackageError("COPY_INVALID", ["COPY_NAME_NOT_ALLOWED", f.name]);
      if (role.role !== f.role) throw new PackageError("COPY_INVALID", ["COPY_ROLE_MISMATCH", f.name]);
      total += f.bytes;
    }
    if (total > COPY_LIMITS.totalBytes) throw new PackageError("COPY_INVALID", ["COPY_TOTAL_TOO_LARGE"]);
    for (const f of cm.data.files) {
      const path = join(dir, f.name);
      if (!existsSync(path)) throw new PackageError("COPY_INVALID", ["COPY_FILE_MISSING", f.name]);
      const st = statSync(path);
      if (!st.isFile() || st.size !== f.bytes) throw new PackageError("COPY_INVALID", ["COPY_FILE_HASH_MISMATCH", f.name]);
    }
    for (const f of cm.data.files) copyFiles[f.name] = new Uint8Array(readFileSync(join(dir, f.name)));
  }
  const pkg: DemoVersionPackage = { ...meta, manifest, images, rightsSummary: summary, files, ...(copyFiles ? { copyFiles } : {}) };
  checkPackageCopy(pkg);
  return pkg;
}
