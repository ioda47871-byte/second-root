/**
 * Issue #302 P3: Claude-readable PREVIEWS of one verified IMAGE_FIRST bundle (bundle.ts). Offline: no model, no Codex,
 * no network, no child process. The originals are never changed: the bundle is verified from scratch (verifyBundleDir,
 * against the record the caller expects, the bundle SHA included) and the previews are derived from exactly the bytes
 * that verification hashed, so a file swapped after the check cannot reach a preview.
 *
 *   <previews dir>/INDEX.md     for the reviewer: bundle id + SHA, each preview with its source path and source SHA-256
 *   <previews dir>/INDEX.json   the same, machine-readable (imagefirst_review_previews_v1); verifyPreviews() checks it
 *   <previews dir>/<name>.png   each part / composite downscaled so that both sides ≤ PREVIEW_LIMITS.maxSide and the file
 *                               ≤ PREVIEW_LIMITS.maxBytes; a tall picture (height > tallRatio × width after the width is
 *                               fitted) is cut into vertical tiles (with a small overlap) plus one low-detail overview
 *
 * Written into a temporary sibling (0700 / 0600) and renamed into place; never overwritten. Building again for the same
 * bundle is a no-op ("duplicate") only when the directory holds exactly the previews rebuilt from this bundle's verified
 * bytes; a different bundle SHA under the same name is refused (PREVIEWS_CONFLICT), anything else not derived from this
 * bundle too (PREVIEWS_NOT_FROM_BUNDLE). A concurrent builder's still-empty claim is waited for (PREVIEWS_BUSY if never filled).
 * Failures throw PreviewStop with a fixed code only (no path, no content).
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { checkPng, PngError } from "../design-image/png";
import { BundleStop, verifyBundleDir, type ExpectedRecord } from "./bundle";

const MiB = 1024 * 1024;

/**
 * Conservative sizes a Claude Read of an image can show without the picture being refused or shrunk server-side:
 * 1568 px on the longest side (the size above which images are downscaled anyway) and 3.5 MiB per file (well under the
 * 5 MB per-image cap after base64). Tiles overlap by 64 px so a line of text on a tile boundary is whole on one tile.
 */
export const PREVIEW_LIMITS = { maxSide: 1568, maxBytes: 3.5 * MiB, tallRatio: 2, overlap: 64, maxTiles: 16, maxInputPixels: 40_000_000 } as const;
export const PREVIEW_SCHEMA = "imagefirst_review_previews_v1";

export type PreviewCode = "BUNDLE_UNVERIFIED" | "PREVIEWS_DIR_UNSAFE" | "PREVIEWS_CONFLICT" | "PREVIEW_TOO_LARGE" | "PREVIEW_TOO_MANY_TILES" | "PREVIEW_DECODE_FAILED" | "PREVIEW_INDEX_INVALID" | "PREVIEW_FILE_SET_MISMATCH" | "PREVIEW_SHA_MISMATCH" | "PREVIEWS_NOT_FROM_BUNDLE" | "PREVIEWS_BUSY" | "PREVIEWS_STALE_CLAIM";
export class PreviewStop extends Error {
  constructor(readonly code: PreviewCode) {
    super(code);
    this.name = "PreviewStop";
  }
}
const stop = (code: PreviewCode): never => {
  throw new PreviewStop(code);
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export type PreviewEntry = {
  file: string;
  kind: "full" | "tile" | "overview";
  /** The bundle path it was made from (parts/… or composites/…) and that file's SHA-256 (= the bundle's SHA256SUMS line). */
  source: string;
  source_sha256: string;
  source_width: number;
  source_height: number;
  preview_sha256: string;
  width: number;
  height: number;
  bytes: number;
  /** Tiles only: 1-based index, count, and the rows of the SOURCE picture this tile shows (y0 inclusive, y1 exclusive). */
  tile?: { index: number; count: number; y0: number; y1: number };
};
export type PreviewIndex = {
  schema: typeof PREVIEW_SCHEMA;
  bundle_id: string;
  bundle_sha256: string;
  approval_id: string;
  plan_id: string;
  commit: string;
  /**
   * DEV-303 (PR #362 review Low 3): only on a synthetic rehearsal bundle's previews (never a generated design).
   * Informational only (the reader sees the banner): every real refusal (research log, audit, worker delivery, materials
   * run) reads the VERIFIED bundle manifest's `synthetic`, never this field.
   */
  synthetic?: true;
  limits: { max_side: number; max_bytes: number };
  previews: PreviewEntry[];
};
export type PreviewResult = { status: "built" | "duplicate"; dir: string; index: PreviewIndex };

const NAME_RE = /^[a-z0-9-]+(\.(tile-\d{2}-of-\d{2}|overview))?\.png$/;
const OUTPUT_LIMITS = { maxBytes: PREVIEW_LIMITS.maxBytes, minSide: 1, maxSide: PREVIEW_LIMITS.maxSide, maxPixels: PREVIEW_LIMITS.maxSide * PREVIEW_LIMITS.maxSide };

/** parts/pc-1.png → pc-1, composites/pc.png → composite-pc */
const stem = (source: string) => (source.startsWith("composites/") ? `composite-${basename(source, ".png")}` : basename(source, ".png"));

const img = (b: Buffer) => sharp(b, { limitInputPixels: PREVIEW_LIMITS.maxInputPixels, failOn: "error" });

/** PNG within the byte cap: lossless first, then a palette (lossy, fine for a preview), then 0.8× steps. */
async function encode(raw: Buffer, w: number, h: number): Promise<{ bytes: Buffer; width: number; height: number }> {
  let width = w;
  let height = h;
  for (let step = 0; step < 6; step++) {
    const base = () => sharp(raw, { raw: { width: w, height: h, channels: 4 } }).resize(width, height, { fit: "fill" });
    for (const opts of [{ compressionLevel: 9 }, { compressionLevel: 9, palette: true, quality: 90 }]) {
      const bytes = await base().png(opts).toBuffer();
      if (bytes.length <= PREVIEW_LIMITS.maxBytes) return { bytes, width, height };
    }
    width = Math.max(1, Math.floor(width * 0.8));
    height = Math.max(1, Math.floor(height * 0.8));
  }
  return stop("PREVIEW_TOO_LARGE");
}

/** Exported for tests: the previews of one picture, in memory. */
export async function previewsOf(source: string, bytes: Buffer): Promise<{ name: string; entry: Omit<PreviewEntry, "file">; bytes: Buffer }[]> {
  const L = PREVIEW_LIMITS;
  let meta;
  try {
    meta = await img(bytes).metadata();
  } catch {
    return stop("PREVIEW_DECODE_FAILED");
  }
  const sw = meta.width ?? 0;
  const sh = meta.height ?? 0;
  if (!sw || !sh) return stop("PREVIEW_DECODE_FAILED");
  const base = { source, source_sha256: sha256(bytes), source_width: sw, source_height: sh };
  const out: { name: string; entry: Omit<PreviewEntry, "file">; bytes: Buffer }[] = [];
  const add = async (name: string, kind: PreviewEntry["kind"], raw: Buffer, w: number, h: number, tile?: PreviewEntry["tile"]) => {
    const e = await encode(raw, w, h);
    try {
      checkPng(e.bytes, OUTPUT_LIMITS);
    } catch (error) {
      if (error instanceof PngError) stop("PREVIEW_TOO_LARGE");
      throw error;
    }
    out.push({ name, bytes: e.bytes, entry: { kind, ...base, preview_sha256: sha256(e.bytes), width: e.width, height: e.height, bytes: e.bytes.length, ...(tile ? { tile } : {}) } });
  };
  const rgba = async (w: number, h: number) => {
    try {
      return await img(bytes).resize(w, h, { fit: "fill" }).ensureAlpha().raw().toBuffer();
    } catch {
      return stop("PREVIEW_DECODE_FAILED");
    }
  };
  // fit the width first; a picture that is then still taller than the cap and clearly tall is tiled
  const s = Math.min(1, L.maxSide / sw);
  const W = Math.max(1, Math.round(sw * s));
  const H = Math.max(1, Math.round(sh * s));
  const name = stem(source);
  if (H <= L.maxSide || H <= L.tallRatio * W) {
    const f = Math.min(1, L.maxSide / sw, L.maxSide / sh);
    const w = Math.max(1, Math.round(sw * f));
    const h = Math.max(1, Math.round(sh * f));
    await add(`${name}.png`, "full", await rgba(w, h), w, h);
    return out;
  }
  const step = L.maxSide - L.overlap;
  const count = Math.ceil((H - L.overlap) / step);
  if (count > L.maxTiles) return stop("PREVIEW_TOO_MANY_TILES");
  const scaled = await rgba(W, H);
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < count; i++) {
    const top = Math.min(i * step, H - L.maxSide);
    const th = Math.min(L.maxSide, H - top);
    const raw = await sharp(scaled, { raw: { width: W, height: H, channels: 4 } }).extract({ left: 0, top, width: W, height: th }).raw().toBuffer();
    const y0 = Math.floor(top / s);
    const y1 = Math.min(sh, Math.ceil((top + th) / s));
    await add(`${name}.tile-${pad(i + 1)}-of-${pad(count)}.png`, "tile", raw, W, th, { index: i + 1, count, y0, y1 });
  }
  const f = Math.min(L.maxSide / sw, L.maxSide / sh);
  const ow = Math.max(1, Math.round(sw * f));
  const oh = Math.max(1, Math.round(sh * f));
  await add(`${name}.overview.png`, "overview", await rgba(ow, oh), ow, oh);
  return out;
}

function renderIndexMd(ix: PreviewIndex): string {
  const lines = [
    `# IMAGE_FIRST review previews — ${ix.bundle_id}`,
    "",
    ...(ix.synthetic ? ["**SYNTHETIC rehearsal bundle (合成・リハーサル): locally drawn pictures, not a generated design. Do not review or log it as one.**", ""] : []),
    "Derived, downscaled copies for reading in a Claude session. **Not the originals.** The originals are the verified bundle",
    `\`../../${ix.bundle_id}/\` (check it with \`cd ../../${ix.bundle_id} && sha256sum -c SHA256SUMS\` and \`sha256sum manifest.json\`).`,
    "",
    `- bundle SHA-256 (= SHA-256 of manifest.json): \`${ix.bundle_sha256}\``,
    `- approval: \`${ix.approval_id}\` · plan: \`${ix.plan_id}\` · commit: \`${ix.commit}\``,
    `- limits: longest side ≤ ${ix.limits.max_side} px, ≤ ${ix.limits.max_bytes} bytes per preview`,
    "",
    "| preview | kind | size | source | source SHA-256 | preview SHA-256 |",
    "|---|---|---|---|---|---|",
    ...ix.previews.map((p) => `| \`${p.file}\` | ${p.kind}${p.tile ? ` ${p.tile.index}/${p.tile.count} (source rows ${p.tile.y0}–${p.tile.y1})` : ""} | ${p.width}×${p.height} | \`${p.source}\` (${p.source_width}×${p.source_height}) | \`${p.source_sha256}\` | \`${p.preview_sha256}\` |`),
    "",
  ];
  return lines.join("\n");
}

async function writeFile0600(path: string, bytes: Buffer | string) {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } finally {
    await h.close();
  }
}

/** A real directory (not a link), ours, closed to group and others. */
async function ownPrivateDir(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

async function readSmall(path: string, max: number): Promise<Buffer> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return stop("PREVIEW_FILE_SET_MISMATCH");
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > max || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) stop("PREVIEW_FILE_SET_MISMATCH");
    return await h.readFile();
  } finally {
    await h.close();
  }
}

/**
 * Checks a previews directory: ours and private, exactly INDEX.md + INDEX.json + the listed files, each preview's SHA,
 * size and limits, and (when given) that it belongs to this bundle SHA. Returns the index.
 */
export async function verifyPreviews(dir: string, o: { bundle_sha256?: string } = {}): Promise<PreviewIndex> {
  return (await verifyPreviewsDetailed(dir, o)).index;
}

/** verifyPreviews, plus the SHA-256 of the exact INDEX.json bytes it checked (Issue #302: the audit records that hash). */
export async function verifyPreviewsDetailed(dir: string, o: { bundle_sha256?: string } = {}): Promise<{ index: PreviewIndex; index_sha256: string }> {
  if (!(await ownPrivateDir(dir))) stop("PREVIEWS_DIR_UNSAFE");
  let ix: PreviewIndex;
  let indexSha: string;
  try {
    const indexBytes = await readSmall(join(dir, "INDEX.json"), 1 * MiB);
    indexSha = sha256(indexBytes);
    ix = JSON.parse(indexBytes.toString("utf8")) as PreviewIndex;
  } catch (error) {
    if (error instanceof PreviewStop) throw error;
    return stop("PREVIEW_INDEX_INVALID");
  }
  if (!ix || ix.schema !== PREVIEW_SCHEMA || typeof ix.bundle_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ix.bundle_sha256) || !Array.isArray(ix.previews) || ix.previews.length === 0) stop("PREVIEW_INDEX_INVALID");
  if (ix.synthetic !== undefined && ix.synthetic !== true) stop("PREVIEW_INDEX_INVALID");
  if (o.bundle_sha256 !== undefined && o.bundle_sha256 !== ix.bundle_sha256) stop("PREVIEWS_CONFLICT");
  const names = ix.previews.map((p) => p?.file);
  if (names.some((n) => typeof n !== "string" || !NAME_RE.test(n)) || new Set(names).size !== names.length) stop("PREVIEW_INDEX_INVALID");
  const present = (await readdir(dir)).sort();
  const want = [...names, "INDEX.json", "INDEX.md"].sort();
  if (present.length !== want.length || present.some((n, i) => n !== want[i])) stop("PREVIEW_FILE_SET_MISMATCH");
  for (const p of ix.previews) {
    const bytes = await readSmall(join(dir, p.file), PREVIEW_LIMITS.maxBytes);
    if (sha256(bytes) !== p.preview_sha256 || bytes.length !== p.bytes) stop("PREVIEW_SHA_MISMATCH");
    try {
      const info = checkPng(bytes, OUTPUT_LIMITS);
      if (info.width !== p.width || info.height !== p.height) stop("PREVIEW_SHA_MISMATCH");
    } catch (error) {
      if (error instanceof PngError) stop("PREVIEW_SHA_MISMATCH");
      throw error;
    }
  }
  const md = (await readSmall(join(dir, "INDEX.md"), 1 * MiB)).toString("utf8");
  if (md !== renderIndexMd(ix)) stop("PREVIEW_INDEX_INVALID");
  return { index: ix, index_sha256: indexSha };
}

export type BuildPreviewsOptions = {
  /** The verified bundle copy (e.g. the review inbox's <inbox>/<bundle id>/). Read only. */
  bundleDir: string;
  /** What the bundle must be (the owner's approval record and the bundle SHA the delivery confirmed). */
  expected: ExpectedRecord & { bundle_sha256: string };
  /** The previews directory to create (its parent must exist, be ours and 0700). */
  outDir: string;
  /** Tests only: how long to wait for a concurrent builder (default PREVIEW_WAIT). */
  wait?: { totalMs: number; stepMs: number };
};

/** How long a builder waits for a concurrent builder's claimed (still empty) previews directory to be filled. */
export const PREVIEW_WAIT = { totalMs: 10_000, stepMs: 100 } as const;
/**
 * An empty claimed directory older than this (by mtime) is a builder that died between claiming and renaming (OOM, a
 * kill): refused as PREVIEWS_STALE_CLAIM at once, never waited on or reused (PR #309 review L3). Recovery is by hand
 * (docs/operations/imagefirst-review-handoff.md §2): remove that empty directory, then build again.
 */
export const PREVIEW_STALE_CLAIM_MS = 120_000;

/** The same index, field for field (both are plain JSON built by this module). */
const sameIndex = (a: PreviewIndex, b: PreviewIndex) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An existing previews directory for this name. While it is the empty placeholder a concurrent builder has just claimed
 * (PR #308 review L2), wait for that builder to rename its finished directory in (PREVIEWS_BUSY if it never does or gives
 * up). Then verify it and require it to be exactly the previews of THIS bundle (PR #308 review L1): the index rebuilt
 * from the verified bundle bytes (every source path and SHA, every preview's SHA: the encoding is deterministic, the ids)
 * must equal the one on disk. Otherwise PREVIEWS_NOT_FROM_BUNDLE: never silently reused.
 */
async function existingPreviews(final: string, want: PreviewIndex, wait: { totalMs: number; stepMs: number }): Promise<PreviewResult> {
  for (let waited = 0; ; waited += wait.stepMs) {
    const info = await lstat(final).catch(() => null);
    if (!info) return stop("PREVIEWS_BUSY");
    // every pass: a real directory of ours, 0700 (PR #309 review L2); a readdir error is a fixed code, never a raw error
    if (!(await ownPrivateDir(final))) return stop("PREVIEWS_DIR_UNSAFE");
    let names: string[];
    try {
      names = await readdir(final);
    } catch {
      return stop("PREVIEWS_DIR_UNSAFE");
    }
    if (names.length > 0) break;
    if (Date.now() - info.mtimeMs > PREVIEW_STALE_CLAIM_MS) return stop("PREVIEWS_STALE_CLAIM");
    if (waited >= wait.totalMs) return stop("PREVIEWS_BUSY");
    await new Promise((r) => setTimeout(r, wait.stepMs));
  }
  const have = await verifyPreviews(final, { bundle_sha256: want.bundle_sha256 });
  if (!sameIndex(have, want)) stop("PREVIEWS_NOT_FROM_BUNDLE");
  return { status: "duplicate", dir: final, index: have };
}

/**
 * Verifies the bundle, builds its previews in memory, then writes them and INDEX; or, when the directory exists, confirms
 * it holds exactly these previews (a concurrent builder's result included) and reports "duplicate".
 */
export async function buildPreviews(o: BuildPreviewsOptions): Promise<PreviewResult> {
  let verified;
  try {
    verified = await verifyBundleDir(o.bundleDir, { expected: o.expected });
  } catch (error) {
    if (error instanceof BundleStop) return stop("BUNDLE_UNVERIFIED");
    throw error;
  }
  const parent = dirname(o.outDir);
  if (!(await ownPrivateDir(parent))) stop("PREVIEWS_DIR_UNSAFE");
  const final = join(await realpath(parent), basename(o.outDir));
  const wait = o.wait ?? PREVIEW_WAIT;
  const m = verified.manifest;
  const previews: PreviewEntry[] = [];
  const files: { name: string; bytes: Buffer }[] = [];
  for (const e of verified.entries) {
    if (!e.path.startsWith("parts/") && !e.path.startsWith("composites/")) continue;
    for (const p of await previewsOf(e.path, e.bytes)) {
      previews.push({ file: p.name, ...p.entry });
      files.push({ name: p.name, bytes: p.bytes });
    }
  }
  const index: PreviewIndex = {
    schema: PREVIEW_SCHEMA,
    bundle_id: m.bundle_id,
    bundle_sha256: verified.bundle_sha256,
    approval_id: m.approval_id,
    plan_id: m.plan_id,
    commit: m.commit,
    ...(m.synthetic === true ? { synthetic: true as const } : {}),
    limits: { max_side: PREVIEW_LIMITS.maxSide, max_bytes: PREVIEW_LIMITS.maxBytes },
    previews,
  };
  if (await lstat(final).then(() => true, () => false)) return existingPreviews(final, index, wait);
  const tmp = join(dirname(final), `.tmp-previews-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(tmp, { mode: 0o700 });
    for (const f of files) await writeFile0600(join(tmp, f.name), f.bytes);
    await writeFile0600(join(tmp, "INDEX.json"), `${JSON.stringify(index, null, 2)}\n`);
    await writeFile0600(join(tmp, "INDEX.md"), renderIndexMd(index));
    try {
      await mkdir(final, { mode: 0o700 });
    } catch (error) {
      // someone else claimed it meanwhile: wait for their result; the same previews are a duplicate, anything else refused
      if ((error as { code?: string }).code === "EEXIST") return await existingPreviews(final, index, wait);
      throw error;
    }
    // the empty directory just claimed is replaced by the finished one (never a half-written name)
    await rename(tmp, final).catch(async (error: unknown) => {
      await rmdir(final).catch(() => undefined);
      throw error;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  const built = await verifyPreviews(final, { bundle_sha256: verified.bundle_sha256 });
  if (!sameIndex(built, index)) stop("PREVIEWS_NOT_FROM_BUNDLE");
  return { status: "built", dir: final, index: built };
}
