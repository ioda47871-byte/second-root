// Asset intake (DEV-029): a person puts one photo into the asset store of a
// job. The photo is checked, decoded and drawn again by Chromium into a new
// PNG, so nothing of the original file (EXIF, GPS, colour profiles, text
// chunks, trailing data) reaches the store. The store lives outside the
// repository and apart from everything that holds reference screenshots.
//
// A reference screenshot never becomes an asset: intake refuses any file in
// the capture spool, the capture user's home, a worker temp root or the
// preview output, and the store itself may not sit in any of them.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Page } from "playwright";
import { CAPTURE_SPOOL, CAPTURE_USER_HOME } from "../protected-paths";
import { SIGNATURES } from "../worker/images";
import { STALE_TEMP_NAME } from "../worker/temp";
import { AssetManifestSchema, emptyManifest, JOB_ID, MAX_ASSETS_PER_JOB, type AssetManifest, type AssetRecord, type ConsentScope } from "./manifest";
import { toPublicAssetId, type PublicAssetId } from "./types";

export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
export const MIN_SIDE = 320;
export const MAX_SIDE = 2400;
const MANIFEST = "manifest.json";

export type IntakeCode =
  | "JOB_ID"
  | "STORE_UNSAFE"
  | "SOURCE_REFERENCE"
  | "NOT_FILE"
  | "SYMLINK"
  | "SIZE"
  | "TYPE_UNSUPPORTED"
  | "SIGNATURE"
  | "DECODE"
  | "DIMENSIONS"
  | "COUNT"
  | "DUPLICATE"
  | "PEOPLE_NOT_CONFIRMED"
  | "CONSENT"
  | "MANIFEST_INVALID";

export class IntakeError extends Error {
  constructor(readonly code: IntakeCode) {
    super(code);
  }
}

export type IntakeSource =
  | { sourceKind: "generated_concept"; createdBy: string; createdAt: string }
  | { sourceKind: "approved_real"; consentId: string; approvedBy: string; approvedAt: string; scopes: ConsentScope[] };

/** Decodes an image and draws it again as a PNG no larger than MAX_SIDE. */
export type Normalizer = (bytes: Buffer, mime: string) => Promise<{ png: Buffer; width: number; height: number }>;

export { assetStoreRoot } from "./store-root";

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Places that hold reference screenshots or render output. */
export function referenceLocations(env: Record<string, string | undefined>): string[] {
  return [CAPTURE_SPOOL, CAPTURE_USER_HOME, ...(env.SR_DESIGN_PREVIEW_ROOT && isAbsolute(env.SR_DESIGN_PREVIEW_ROOT) ? [env.SR_DESIGN_PREVIEW_ROOT] : []), join(env.HOME ?? "/nonexistent", ".local", "share", "second-root-design")];
}

/** Whether a resolved path is in a reference location (including any worker / Codex temp root). */
export function isReferenceLocation(path: string, env: Record<string, string | undefined>): boolean {
  if (referenceLocations(env).some((r) => inside(path, r))) return true;
  const tmp = resolve(env.TMPDIR ?? tmpdir());
  if (!inside(path, tmp)) return false;
  const first = relative(tmp, path).split(sep)[0] ?? "";
  return STALE_TEMP_NAME.test(first);
}

/** The store may not be in the repository, a reference location or a temp directory. */
export function checkStoreRoot(root: string, options: { repoDir: string; env: Record<string, string | undefined> }): boolean {
  if (!isAbsolute(root)) return false;
  const r = resolve(root);
  if (inside(r, resolve(options.repoDir)) || inside(resolve(options.repoDir), r)) return false;
  if (referenceLocations(options.env).some((ref) => inside(r, ref) || inside(ref, r))) return false;
  if (inside(r, resolve(options.env.TMPDIR ?? tmpdir()))) return false;
  return true;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** HEIC / HEIF / AVIF (ISO BMFF "ftyp" boxes): refused in the MVP. */
export function isIsoMedia(head: Buffer): boolean {
  return head.subarray(4, 8).toString("latin1") === "ftyp";
}

/** Reads a source photo after checking where it is and what it is. */
export async function readSource(path: string, env: Record<string, string | undefined>): Promise<{ bytes: Buffer; mime: string }> {
  if (!isAbsolute(path)) throw new IntakeError("NOT_FILE");
  const info = await lstat(path).catch(() => null);
  if (!info) throw new IntakeError("NOT_FILE");
  if (info.isSymbolicLink()) throw new IntakeError("SYMLINK");
  if (!info.isFile()) throw new IntakeError("NOT_FILE");
  const real = await realpath(path);
  if (isReferenceLocation(real, env) || isReferenceLocation(await realpath(dirname(path)), env)) throw new IntakeError("SOURCE_REFERENCE");
  if (info.size === 0 || info.size > MAX_SOURCE_BYTES) throw new IntakeError("SIZE");
  const mime = MIME[extname(path).toLowerCase()];
  // Opened without following a link, then checked again on the open file: a swap after lstat is caught.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new IntakeError("SYMLINK");
  });
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new IntakeError("NOT_FILE");
    if (opened.size === 0 || opened.size > MAX_SOURCE_BYTES) throw new IntakeError("SIZE");
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const head = bytes.subarray(0, 16);
  if (!mime || isIsoMedia(head)) throw new IntakeError("TYPE_UNSUPPORTED");
  if (!SIGNATURES[extname(path).toLowerCase()](head)) throw new IntakeError("SIGNATURE");
  return { bytes, mime };
}

/** A Normalizer on a blank Chromium page: decode, scale, draw, encode as PNG. */
export function chromiumNormalizer(newPage: () => Promise<{ page: Page; close: () => Promise<void> }>): Normalizer {
  return async (bytes, mime) => {
    const { page, close } = await newPage();
    try {
      // No named functions inside page callbacks (tsx keepNames adds a __name helper the page lacks).
      const out = await page.evaluate(
        async ({ src, maxSide }) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
          return { data: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
        },
        { src: `data:${mime};base64,${bytes.toString("base64")}`, maxSide: MAX_SIDE },
      );
      return { png: Buffer.from(out.data.slice(out.data.indexOf(",") + 1), "base64"), width: out.width, height: out.height };
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      throw new IntakeError("DECODE");
    } finally {
      await close().catch(() => undefined);
    }
  };
}

async function readManifest(dir: string, jobId: string): Promise<AssetManifest> {
  const raw = await readFile(join(dir, MANIFEST), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  if (raw === null) return emptyManifest(jobId);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new IntakeError("MANIFEST_INVALID");
  }
  const parsed = AssetManifestSchema.safeParse(json);
  if (!parsed.success || parsed.data.jobId !== jobId) throw new IntakeError("MANIFEST_INVALID");
  return parsed.data;
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

export type IntakeOptions = {
  storeRoot: string;
  repoDir: string;
  env: Record<string, string | undefined>;
  jobId: string;
  file: string;
  source: IntakeSource;
  /** A person confirms the photo shows no people (MVP rule). */
  peopleConfirmedNone: boolean;
  normalize: Normalizer;
  now?: Date;
};

export async function intakeAsset(o: IntakeOptions): Promise<{ assetId: PublicAssetId; manifest: AssetManifest }> {
  if (!JOB_ID.test(o.jobId)) throw new IntakeError("JOB_ID");
  if (!o.peopleConfirmedNone) throw new IntakeError("PEOPLE_NOT_CONFIRMED");
  if (o.source.sourceKind === "approved_real" && o.source.scopes.length === 0) throw new IntakeError("CONSENT");
  if (!checkStoreRoot(o.storeRoot, { repoDir: o.repoDir, env: o.env })) throw new IntakeError("STORE_UNSAFE");

  const { bytes, mime } = await readSource(o.file, o.env);
  await mkdir(o.storeRoot, { recursive: true, mode: 0o700 });
  // The same checks on the real location, before anything is written: a store root that is a link
  // into the repository or a reference place is refused.
  if (!checkStoreRoot(await realpath(o.storeRoot), { repoDir: await realpath(o.repoDir), env: o.env })) throw new IntakeError("STORE_UNSAFE");
  const dir = join(o.storeRoot, o.jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || (dirInfo.mode & 0o077) !== 0) throw new IntakeError("STORE_UNSAFE");
  const manifest = await readManifest(dir, o.jobId);
  if (manifest.assets.length >= MAX_ASSETS_PER_JOB) throw new IntakeError("COUNT");

  const { png, width, height } = await o.normalize(bytes, mime).catch((e: unknown) => {
    throw e instanceof IntakeError ? e : new IntakeError("DECODE");
  });
  if (Math.min(width, height) < MIN_SIDE) throw new IntakeError("DIMENSIONS");
  const sha256 = createHash("sha256").update(png).digest("hex");
  if (manifest.assets.some((a) => a.sha256 === sha256)) throw new IntakeError("DUPLICATE");

  const assetId = toPublicAssetId(`asset-${randomBytes(12).toString("hex")}`)!;
  const at = (o.now ?? new Date()).toISOString();
  const common = { assetId, file: `${assetId}.png`, sha256, width, height, bytes: png.length, intakeAt: at, people: "none" as const };
  const record: AssetRecord =
    o.source.sourceKind === "generated_concept"
      ? { ...common, sourceKind: "generated_concept", generation: { method: "human_upload", createdBy: o.source.createdBy, createdAt: o.source.createdAt } }
      : { ...common, sourceKind: "approved_real", consent: { consentId: o.source.consentId, approvedBy: o.source.approvedBy, approvedAt: o.source.approvedAt, scopes: o.source.scopes } };
  const next = AssetManifestSchema.safeParse({ ...manifest, assets: [...manifest.assets, record] });
  if (!next.success) throw new IntakeError(o.source.sourceKind === "approved_real" ? "CONSENT" : "MANIFEST_INVALID");

  await writeAtomic(join(dir, record.file), png);
  await writeAtomic(join(dir, MANIFEST), `${JSON.stringify(next.data, null, 2)}\n`);
  return { assetId, manifest: next.data };
}

/** Reads a job's manifest from the store (null when there is none or it is invalid). */
export async function loadManifest(storeRoot: string, jobId: string): Promise<AssetManifest | null> {
  if (!JOB_ID.test(jobId)) return null;
  return readManifest(join(storeRoot, jobId), jobId).catch(() => null);
}

/** PNG chunk types, in order (for checks that nothing but pixels survived). */
export function pngChunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  let at = 8;
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    types.push(png.subarray(at + 4, at + 8).toString("latin1"));
    at += 12 + length;
  }
  return types;
}
