/**
 * DEV-263i: the pure half of a demo version package (no sharp, no file system): the formats, the error, the package
 * type, every check a package goes through on read (checkPackageFiles, checkPackageImages, packageRightsSummary,
 * checkPackageCopy) and `packageFromSource`, the one place that turns a package's meta and its bytes into a verified
 * package. readPackage (package.ts, a directory) and the owner's hosted upload (lib/admin/demo-version-upload.ts, bytes
 * from the request and the private bucket) both go through it, so the checks and their order are the same.
 *
 * Moved here from package.ts unchanged (package.ts re-exports them), so the server can import the checks without
 * sharp (used only by the offline packager).
 */
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";
import { bundleSha256, checkFileBytes, CSS_NAME, HTML_NAME, validateManifest, type ArtifactManifest } from "@/lib/sales/demo-version/manifest";
import type { RightsSummary } from "@/lib/sales/demo-version/rights";
import { COPY_LIMITS, CopyManifest, CopyPackageError, copyRoleOfName, LEGACY_COPY_RESULT, verifyPackageCopy, type PackageCopyResult } from "./copy";
import { packageImageProblems, type PackageImage } from "./swap-rights";

export const PACKAGE_FORMAT = "sales_demo_version_package_v1";
/** DEV-199d: v1 + the copy files and their copy manifest (`copy`). */
export const PACKAGE_FORMAT_COPY = "sales_demo_version_package_v2";
export class PackageError extends Error {
  /** DEV-199e: the round of an honest failed copy review (COPY_INVALID only), which the importer records before refusing */
  failedCopyRound?: number;
  constructor(
    public readonly code: string,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${code}: ${details.join(",")}` : code);
  }
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
    // DEV-199e: an honest failed review keeps its round, so the importer can record it before refusing
    if (e instanceof CopyPackageError) throw Object.assign(new PackageError("COPY_INVALID", [e.code, ...e.details]), { failedCopyRound: e.failedRound });
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

export type PackageMeta = Omit<DemoVersionPackage, "files" | "copyFiles">;

/**
 * Where a package's bytes come from. `pageFile` / `copyFile` give a file's bytes or null when there is none;
 * `copySize` gives a copy file's size (null when there is none; anything but a plain file gives a size that never
 * matches) — asked for every copy file before any copy file is read.
 */
export interface PackageSource {
  pageFile(name: string): Uint8Array | null;
  copySize(name: string): number | null;
  copyFile(name: string): Uint8Array | null;
}

/** A source over bytes already in memory (the upload path). Only own keys count. */
export function memoryPackageSource(pageFiles: Readonly<Record<string, Uint8Array>>, copyFiles: Readonly<Record<string, Uint8Array>> = {}): PackageSource {
  const own = (r: Readonly<Record<string, Uint8Array>>, name: string) => (Object.prototype.hasOwnProperty.call(r, name) ? r[name]! : null);
  return { pageFile: (n) => own(pageFiles, n), copySize: (n) => own(copyFiles, n)?.byteLength ?? null, copyFile: (n) => own(copyFiles, n) };
}

/** The meta (package.json, parsed) and the source → the verified package (re-hash and the same checks). Throws PackageError. */
export function packageFromSource(raw: unknown, src: PackageSource): DemoVersionPackage {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new PackageError("PACKAGE_UNREADABLE");
  const meta = raw as PackageMeta;
  if (meta.format !== PACKAGE_FORMAT && meta.format !== PACKAGE_FORMAT_COPY) throw new PackageError("PACKAGE_FORMAT");
  const m = validateManifest(meta.manifest);
  if (!m.ok) throw new PackageError("MANIFEST_INVALID", m.codes);
  const files: Record<string, Uint8Array> = {};
  for (const f of m.manifest.files) {
    // names are the manifest's fixed shapes (no "..", no absolute path): validateManifest refused anything else
    const bytes = src.pageFile(f.name);
    if (!bytes) throw new PackageError("FILE_MISSING", [f.name]);
    files[f.name] = bytes;
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
    // file's size against its entry — nothing is read before all of that holds (Fresh Review L5)
    const cm = checkCopyManifestShape(meta.copy);
    for (const f of cm.files) {
      const size = src.copySize(f.name);
      if (size === null) throw new PackageError("COPY_INVALID", ["COPY_FILE_MISSING", f.name]);
      if (size !== f.bytes) throw new PackageError("COPY_INVALID", ["COPY_FILE_HASH_MISMATCH", f.name]);
    }
    for (const f of cm.files) {
      const bytes = src.copyFile(f.name);
      if (!bytes) throw new PackageError("COPY_INVALID", ["COPY_FILE_MISSING", f.name]);
      copyFiles[f.name] = bytes;
    }
  }
  const pkg: DemoVersionPackage = { ...meta, manifest, images, rightsSummary: summary, files, ...(copyFiles ? { copyFiles } : {}) };
  checkPackageCopy(pkg);
  return pkg;
}

/** The copy manifest's schema, then every name, role and the total (no bytes needed). Throws PackageError. */
export function checkCopyManifestShape(raw: unknown): CopyManifest {
  const cm = CopyManifest.safeParse(raw);
  if (!cm.success) throw new PackageError("COPY_INVALID", ["COPY_MANIFEST_INVALID"]);
  let total = 0;
  for (const f of cm.data.files) {
    const role = copyRoleOfName(f.name);
    if (!role) throw new PackageError("COPY_INVALID", ["COPY_NAME_NOT_ALLOWED", f.name]);
    if (role.role !== f.role) throw new PackageError("COPY_INVALID", ["COPY_ROLE_MISMATCH", f.name]);
    total += f.bytes;
  }
  if (total > COPY_LIMITS.totalBytes) throw new PackageError("COPY_INVALID", ["COPY_TOTAL_TOO_LARGE"]);
  return cm.data;
}
