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
 * Node only (sharp, the file system). Not part of the pure library.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

export const PACKAGE_FORMAT = "sales_demo_version_package_v1";
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
  format: typeof PACKAGE_FORMAT;
  manifest: ArtifactManifest;
  bundleSha256: string;
  /** manifest name → bytes */
  files: Record<string, Uint8Array>;
  workerChecks: Record<string, unknown>;
  validatorResult: { version: 1; ok: true; codes: string[]; validator_commit: string | null; checked_at: string };
  rightsSummary: { version: 1; photos: 0; by_status: Record<string, never>; earliest_expiry: null; label_required: false };
  /** where the page came from (a repository path), for the record only */
  source: string;
};

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
  source: string;
  validatorCommit?: string | null;
  now?: Date;
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
  const workerChecks = {
    // traceability of the full-size renders (the stored ones are downscaled to the 4096 px limit)
    renderer: "comp-lane renderPrototype: JavaScript off, network blocked, deviceScaleFactor 1",
    render_side_limit: RENDER_SIDE_LIMIT,
    webp: RENDER_WEBP,
    resize_kernel: "lanczos3",
    originals,
  };
  if (Buffer.byteLength(JSON.stringify(workerChecks)) > 2000) throw new PackageError("WORKER_CHECKS_TOO_LARGE");
  return {
    format: PACKAGE_FORMAT,
    manifest,
    bundleSha256: bundleSha256(manifest),
    files,
    workerChecks,
    validatorResult: { version: 1, ok: true, codes: [], validator_commit: o.validatorCommit ?? null, checked_at: (o.now ?? new Date()).toISOString() },
    rightsSummary: { version: 1, photos: 0, by_status: {}, earliest_expiry: null, label_required: false },
    source: o.source,
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

type PackageMeta = Omit<DemoVersionPackage, "files">;

/** Writes the package directory (outside the repository only): package.json (meta + manifest) and the files. */
export function writePackage(dir: string, pkg: DemoVersionPackage, repo?: string): void {
  if (insideRepo(dir, repo)) throw new PackageError("OUT_INSIDE_REPOSITORY");
  const meta: PackageMeta = { format: pkg.format, manifest: pkg.manifest, bundleSha256: pkg.bundleSha256, workerChecks: pkg.workerChecks, validatorResult: pkg.validatorResult, rightsSummary: pkg.rightsSummary, source: pkg.source };
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(pkg.files)) {
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
  if (meta.format !== PACKAGE_FORMAT) throw new PackageError("PACKAGE_FORMAT");
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
  return { ...meta, manifest, files };
}
