/**
 * Issue #302 P2: the PRIVATE result bundle for ONE finished IMAGE_FIRST run. Offline code: it reads a finished run
 * directory and the worker's receipt (both written by cycle.ts, which this module never imports or calls) and seals one
 * immutable bundle next to them. It calls no model, no Codex, no network, no child process.
 *
 *   pack:   the run dir (0700, ours) + the receipt (0600, ours, status succeeded, verified, PC 2 + SP 4)
 *           → every picture read once without following a link, its SHA-256 equal to the receipt's, a well-formed PNG
 *             within the size limits, nothing else in parts/ or composites/ → the optional PC/SP composites only when
 *             the caller names their SHA-256 (from image-first-check --run) → ONE bundle directory written under a
 *             temporary name and renamed into place (0700 / 0600):
 *
 *               <bundles>/<approval id>/manifest.json   imagefirst_private_bundle_v1 (no prompt text, no secret)
 *               <bundles>/<approval id>/SHA256SUMS      "<sha256>  <path>" for every file below, sorted
 *               <bundles>/<approval id>/receipt.json    the worker's receipt with run_dir redacted (see RECEIPT_RUN_DIR_REDACTED)
 *               <bundles>/<approval id>/parts/{pc-*,sp-*}.png
 *               <bundles>/<approval id>/composites/{pc,sp}.png   (only when given)
 *
 *   The bundle SHA-256 is the SHA-256 of manifest.json's bytes; the manifest holds every file's SHA-256 and size and the
 *   SHA-256 of SHA256SUMS, so the one hash covers every byte. One approval = one bundle: a second pack for the same
 *   approval ID is refused (BUNDLE_EXISTS); a sealed bundle is never rewritten.
 *
 *   verify: the same checks again on a sealed (or received) directory — used by the sender before every send and by the
 *           receiver after every receive (transport.ts).
 *
 * Failures throw BundleStop with a fixed code only (no path, no content).
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkPng, MOCKUP_PNG_LIMITS, PngError, type PngLimits } from "../design-image/png";
import { BUNDLE_ID_RE, isRequestRunId, RUN_APPROVAL_ID_RE, runOfApprovalId } from "./run-directions";

export const BUNDLE_SCHEMA = "imagefirst_private_bundle_v1";
const MiB = 1024 * 1024;

/**
 * Explicit limits. Parts reuse the existing image-tool cap (MOCKUP_PNG_LIMITS: 24 MiB, 512–8192 px a side, 40 Mpx), the
 * same numbers the run itself was checked with, so a bundle never accepts what the run would not. The tool's pictures are
 * ~1–4 MiB in practice. Composites are the image-first-check stacks (PC 1440 wide, at most 16000 px tall), so they get a
 * taller side and 48 MiB. The total (6 parts + 2 composites + receipt) is capped at 192 MiB, below the 240 MiB sum of
 * the per-file caps, so several files at their cap cannot all pass; a real run is ~10–40 MiB. JSON stays small: a
 * receipt is a few KiB, the manifest well under 64 KiB, SHA256SUMS (9 lines) under 16 KiB.
 * Callers may only LOWER these (tests do); a higher value is refused.
 */
export const BUNDLE_LIMITS = {
  part: MOCKUP_PNG_LIMITS,
  composite: { maxBytes: 48 * MiB, minSide: 256, maxSide: 16_384, maxPixels: 40_000_000 } satisfies PngLimits,
  receiptBytes: 256 * 1024,
  manifestBytes: 64 * 1024,
  sumsBytes: 16 * 1024,
  totalBytes: 192 * MiB,
} as const;
export type BundleLimits = { part: PngLimits; composite: PngLimits; receiptBytes: number; manifestBytes: number; sumsBytes: number; totalBytes: number };

/** Retention and short-lived retrieval (data only: no real service reads them yet). */
export const BUNDLE_ACCESS = { retrievalTtlSeconds: 15 * 60, retainDays: 7 } as const;

const DAY_MS = 86_400_000;
/** What the bundled receipt holds in place of the worker's absolute local run directory. */
export const RECEIPT_RUN_DIR_REDACTED = "private_outside_repo";

/**
 * The sender's declared terms must be exactly the fixed ones (fail closed on anything else). A receiver never relies on
 * them: it computes its own deletion time and grant expiry from its own receive time (transport.ts).
 */
function termsValid(m: BundleManifest): boolean {
  const iso = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && new Date(Date.parse(v)).toISOString() === v ? Date.parse(v) : null);
  const created = iso(m.created_at);
  const after = iso(m.retention?.delete_after);
  return (
    created !== null && after !== null && m.access?.visibility === "private" && m.access?.retrieval_ttl_seconds === BUNDLE_ACCESS.retrievalTtlSeconds &&
    m.retention?.retain_days === BUNDLE_ACCESS.retainDays && after === created + BUNDLE_ACCESS.retainDays * DAY_MS &&
    Object.keys(m.access).length === 2 && Object.keys(m.retention).length === 2
  );
}

/**
 * A ほし窯 d3 or d4 approval id (run-directions.ts; the receipt's direction must be the one its id names) or, DEV-303, a
 * request run's id (a receipt with mode "request", direction "request"). The two forms never overlap.
 */
export const APPROVAL_ID_RE = BUNDLE_ID_RE;
const SHOP_ID_RE = /^[a-z0-9_-]{2,41}$/;
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const PART_RE = /^parts\/(?:(pc|sp)-[a-z0-9-]{1,36}|photo-[1-6])\.png$/;
/** DEV-303 (owner decision 2026-11-24): a photo-materials run's pictures (parts/photo-1.png .. photo-6.png). */
const PHOTO_PART_RE = /^parts\/photo-([1-6])\.png$/;
/** The marker a photo-materials bundle carries: image materials for a proposal demo, never photos of the shop. */
export const IMAGE_MATERIAL_LABEL = "イメージ素材";
/** The frame of photo-N (the worker's request-prompt.ts photoAspectOf: 1-2 landscape 3:2, 3-4 square, 5-6 portrait 2:3). */
export const photoFrameOf = (file: string): "3:2" | "1:1" | "2:3" | null => {
  const m = PHOTO_PART_RE.exec(file);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 2 ? "3:2" : n <= 4 ? "1:1" : "2:3";
};
const COMPOSITE_RE = /^composites\/(pc|sp)\.png$/;
/** The only paths a bundle can hold (besides manifest.json and SHA256SUMS). No "..", no absolute path, no other dir. */
export const isBundleFilePath = (p: string) => p === "receipt.json" || PART_RE.test(p) || COMPOSITE_RE.test(p);
export const BUNDLE_DIRS = ["parts", "composites"] as const;
export const IMAGES = { pc: 2, sp: 4 } as const;
/** DEV-303 §6.1 row 3: a whole_page request run's pictures (one full-page picture per viewport). */
export const WHOLE_PAGE_IMAGES = { pc: 1, sp: 1 } as const;
/**
 * The image tool's reference limit (lib/design-agent/image-tool-limits.ts IMAGE_TOOL_MAX_REFS), restated: this module's
 * imports are pinned (bundle.test.ts); whole-page.test.ts asserts the two are equal.
 */
export const BUNDLE_MAX_REFERENCES = 5;

export type BundleCode =
  | "LIMITS_RAISED"
  | "RECEIPT_UNREADABLE"
  | "RECEIPT_INVALID"
  | "RECEIPT_NOT_SUCCEEDED"
  | "RECEIPT_RUN_DIR_MISMATCH"
  | "RUN_DIR_UNSAFE"
  | "RUN_FILE_UNEXPECTED"
  | "RUN_FILE_MISSING"
  | "RUN_FILE_LINK"
  | "RUN_FILE_OUTSIDE"
  | "RUN_FILE_TOO_LARGE"
  | "RUN_FILE_SHA_MISMATCH"
  | "RUN_FILE_NOT_PNG"
  | "COMPOSITE_SHA_INVALID"
  | "TOTAL_TOO_LARGE"
  | "BUNDLES_DIR_UNSAFE"
  | "BUNDLE_EXISTS"
  | "BUNDLE_WRITE_FAILED"
  | "BUNDLE_DIR_UNSAFE"
  | "BUNDLE_LINK_OR_SPECIAL"
  | "BUNDLE_FILE_SET_MISMATCH"
  | "BUNDLE_MANIFEST_INVALID"
  | "BUNDLE_SUMS_MISMATCH"
  | "BUNDLE_FILE_TOO_LARGE"
  | "BUNDLE_FILE_SHA_MISMATCH"
  | "BUNDLE_FILE_NOT_PNG"
  | "BUNDLE_RECEIPT_MISMATCH"
  | "BUNDLE_COUNTS_INVALID"
  | "BUNDLE_SHA_MISMATCH"
  | "BUNDLE_RECORD_MISMATCH"
  | "BUNDLE_TERMS_INVALID";

export class BundleStop extends Error {
  constructor(readonly code: BundleCode) {
    super(code);
    this.name = "BundleStop";
  }
}
const stop = (code: BundleCode): never => {
  throw new BundleStop(code);
};

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export type BundleFile = { path: string; role: "receipt" | "part" | "composite"; sha256: string; bytes: number };
export type BundleManifest = {
  schema: typeof BUNDLE_SCHEMA;
  bundle_id: string;
  approval_id: string;
  plan_id: string;
  commit: string;
  shop: string;
  direction: string;
  packet_sha256: string;
  plan_sha256: string;
  /** DEV-303: a request run's bundle (absent on a pinned direction's). */
  mode?: "request";
  kind?: "real_shop" | "fictional";
  /** SHA-256 of the bundled (redacted) receipt.json. */
  receipt_sha256: string;
  /** SHA-256 of the worker's original receipt bytes: checkable only against the original on the worker's machine. */
  receipt_original_sha256: string;
  files: BundleFile[];
  sha256sums_sha256: string;
  /** photo: DEV-303 only on a photo-materials bundle (then pc and sp are 0). */
  counts: { pc: number; sp: number; composites: number; files: number; photo?: number };
  /** DEV-303 (owner decision 2026-11-24): only on a photo-materials bundle — image materials, never photos of the shop. */
  image_material?: true;
  image_material_label?: typeof IMAGE_MATERIAL_LABEL;
  photos?: { file: string; sha256: string; frame: "3:2" | "1:1" | "2:3" }[];
  total_bytes: number;
  created_at: string;
  access: { visibility: "private"; retrieval_ttl_seconds: number };
  retention: { retain_days: number; delete_after: string };
};
/** What the receiver expects this bundle to be (from the owner's approval record, not from the bundle). */
export type ExpectedRecord = { approval_id: string; plan_id: string; commit: string; bundle_sha256?: string };
export type BundleEntry = { path: string; bytes: Buffer };
export type VerifiedBundle = { bundle_sha256: string; manifest: BundleManifest; entries: BundleEntry[] };
export type SealedBundle = { dir: string; bundle_id: string; bundle_sha256: string; manifest: BundleManifest };

/** The receipt fields this module relies on (cycle.ts's imagefirst_worker_receipt_v1; not imported on purpose). */
type Receipt = {
  schema: string;
  status: string;
  stop_code: unknown;
  verified: unknown;
  shop: unknown;
  direction: unknown;
  approval_id: unknown;
  plan_id: unknown;
  commit: unknown;
  packet_sha256: unknown;
  plan_sha256: unknown;
  run_dir: unknown;
  images: unknown;
  stopped_images: unknown;
  counts: unknown;
  mode?: unknown;
  kind?: unknown;
  request_id?: unknown;
  request_sha256?: unknown;
  facts_sha256?: unknown;
  images_total?: unknown;
  request_stage?: unknown;
  design_layout?: unknown;
  reference_images?: unknown;
};
type ReceiptImage = { file: string; sha256: string; bytes: number };

function checkLimits(l: BundleLimits): BundleLimits {
  const D = BUNDLE_LIMITS;
  const png = (a: PngLimits, b: PngLimits) => a.maxBytes <= b.maxBytes && a.maxSide <= b.maxSide && a.maxPixels <= b.maxPixels && a.minSide >= b.minSide;
  const ok = png(l.part, D.part) && png(l.composite, D.composite) && l.receiptBytes <= D.receiptBytes && l.manifestBytes <= D.manifestBytes && l.sumsBytes <= D.sumsBytes && l.totalBytes <= D.totalBytes;
  return ok ? l : stop("LIMITS_RAISED");
}

/** A regular file read without following a link, within `max` bytes; null when it is missing. */
async function readNoFollow(path: string, max: number, codes: { link: BundleCode; big: BundleCode }, ownPrivate = false): Promise<Buffer | null> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // ELOOP (a link at the last step) or anything else but "missing" stops
    if ((error as { code?: string }).code === "ENOENT") return null;
    return stop(codes.link);
  }
  try {
    const info = await h.stat();
    if (!info.isFile() || info.nlink !== 1) stop(codes.link);
    // checked on the same handle that is read (no window between the mode check and the read)
    if (ownPrivate && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) stop(codes.link);
    if (info.size > max) stop(codes.big);
    const bytes = await h.readFile();
    if (bytes.length > max) stop(codes.big);
    return bytes;
  } finally {
    await h.close();
  }
}

/** Ours: a real directory (not a link), owned by this user, closed to group and others. */
async function ownPrivateDir(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

/** Every entry under `dir` (recursive, lstat): files as relative paths; a link or special file anywhere stops. */
async function walk(dir: string, linkCode: BundleCode, prefix = ""): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(dir, rel));
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) stop(linkCode);
    if (info.isDirectory()) {
      dirs.push(rel);
      const sub = await walk(dir, linkCode, rel);
      files.push(...sub.files);
      dirs.push(...sub.dirs);
    } else files.push(rel);
  }
  return { files, dirs };
}

const asPng = (bytes: Buffer, limits: PngLimits, code: BundleCode) => {
  try {
    return checkPng(bytes, limits);
  } catch (error) {
    if (error instanceof PngError) return stop(code);
    throw error;
  }
};

const renderSums = (files: readonly BundleFile[]) => files.map((f) => `${f.sha256}  ${f.path}\n`).join("");
const sortFiles = (files: BundleFile[]) => files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/**
 * DEV-303 §6.1 row 3: a request design run's layout. A whole_page receipt (design_layout "whole_page") lists 1..5
 * reference pictures by id (ref-1.. in order), case id and SHA-256 only; anything else, or the fields on any other
 * receipt, is invalid. Its pictures are PC 1 + SP 1; every other design run's PC 2 + SP 4.
 */
function designImagesOf(r: Receipt): { readonly pc: number; readonly sp: number } {
  if (r.design_layout === undefined && r.reference_images === undefined) return IMAGES;
  if (r.mode !== "request" || r.request_stage !== undefined || r.design_layout !== "whole_page" || !Array.isArray(r.reference_images)) return stop("RECEIPT_INVALID");
  const refs = r.reference_images as unknown[];
  const ok = refs.length >= 1 && refs.length <= BUNDLE_MAX_REFERENCES && refs.every((x, n) => {
    const e = x as { id?: unknown; case_id?: unknown; sha256?: unknown } | null;
    return !!e && typeof e === "object" && Object.keys(e).sort().join(",") === "case_id,id,sha256" && e.id === `ref-${n + 1}` && typeof e.case_id === "string" && /^(?:CP|SR)-\d{3}$/.test(e.case_id) && typeof e.sha256 === "string" && SHA_RE.test(e.sha256);
  });
  if (!ok) stop("RECEIPT_INVALID");
  return WHOLE_PAGE_IMAGES;
}

function parseReceipt(bytes: Buffer): { r: Receipt; images: ReceiptImage[]; photo: boolean; design: { readonly pc: number; readonly sp: number } } {
  let r: Receipt;
  try {
    r = JSON.parse(bytes.toString("utf8")) as Receipt;
  } catch {
    return stop("RECEIPT_INVALID");
  }
  if (!r || typeof r !== "object" || r.schema !== "imagefirst_worker_receipt_v1") stop("RECEIPT_INVALID");
  if (typeof r.approval_id !== "string" || !APPROVAL_ID_RE.test(r.approval_id)) stop("RECEIPT_INVALID");
  if (typeof r.plan_id !== "string" || !PLAN_ID_RE.test(r.plan_id)) stop("RECEIPT_INVALID");
  if (typeof r.commit !== "string" || !COMMIT_RE.test(r.commit)) stop("RECEIPT_INVALID");
  if (typeof r.packet_sha256 !== "string" || !SHA_RE.test(r.packet_sha256) || typeof r.plan_sha256 !== "string" || !SHA_RE.test(r.plan_sha256)) stop("RECEIPT_INVALID");
  if (r.mode === "request") {
    // DEV-303: a request run: its id has the request form, its shop is the request's, the request is its approval
    if (!isRequestRunId(r.approval_id as string) || r.request_id !== r.approval_id || r.plan_id !== r.approval_id || r.direction !== "request" || typeof r.shop !== "string" || !SHOP_ID_RE.test(r.shop)) stop("RECEIPT_INVALID");
    if ((r.kind !== "real_shop" && r.kind !== "fictional") || r.request_sha256 !== r.packet_sha256 || typeof r.facts_sha256 !== "string" || !SHA_RE.test(r.facts_sha256) || typeof r.run_dir !== "string") stop("RECEIPT_INVALID");
  } else {
    // the direction is the one the approval id names (a d3 id never seals a d4 receipt, nor the other way round)
    if (r.mode !== undefined || r.kind !== undefined || !RUN_APPROVAL_ID_RE.test(r.approval_id as string)) stop("RECEIPT_INVALID");
    if (r.shop !== "hoshigama" || r.direction !== runOfApprovalId(r.approval_id as string)?.direction || typeof r.run_dir !== "string") stop("RECEIPT_INVALID");
  }
  if (!Array.isArray(r.images) || !Array.isArray(r.stopped_images)) stop("RECEIPT_INVALID");
  const images = r.images as ReceiptImage[];
  for (const i of images) {
    if (!i || typeof i.file !== "string" || typeof i.sha256 !== "string" || !SHA_RE.test(i.sha256) || !Number.isSafeInteger(i.bytes) || i.bytes < 0) stop("RECEIPT_INVALID");
    // a path the bundle cannot hold ("../", absolute, another directory, another name) is refused before any read
    if (!PART_RE.test(i.file)) stop("RUN_FILE_OUTSIDE");
  }
  if (new Set(images.map((i) => i.file)).size !== images.length) stop("RECEIPT_INVALID");
  // DEV-303: a request run's reported picture count is the receipt's own list, never more than one batch's 6
  if (r.mode === "request" && (r.images_total !== images.length || images.length > 6)) stop("RECEIPT_INVALID");
  if (r.status !== "succeeded" || r.stop_code !== null || r.verified !== true || (r.stopped_images as unknown[]).length !== 0) stop("RECEIPT_NOT_SUCCEEDED");
  const pc = images.filter((i) => i.file.startsWith("parts/pc-")).length;
  const sp = images.filter((i) => i.file.startsWith("parts/sp-")).length;
  const photos = images.filter((i) => PHOTO_PART_RE.test(i.file)).length;
  const c = r.counts as { pc?: unknown; sp?: unknown; total?: unknown; stopped?: unknown; photo?: unknown } | null;
  // DEV-303 (owner decision 2026-11-24): a photo-materials request run: 1..6 parts/photo-N.png and nothing else
  const photo = r.mode === "request" && r.request_stage === "photo_materials";
  if (r.request_stage !== undefined && !photo) stop("RECEIPT_INVALID");
  const design = designImagesOf(r);
  if (photo) {
    if (pc !== 0 || sp !== 0 || photos < 1 || photos > 6 || photos !== images.length || !c || c.pc !== 0 || c.sp !== 0 || c.photo !== photos || c.total !== images.length || c.stopped !== 0) stop("RECEIPT_NOT_SUCCEEDED");
  } else if (photos !== 0 || pc !== design.pc || sp !== design.sp || !c || c.pc !== pc || c.sp !== sp || c.total !== images.length || c.stopped !== 0 || c.photo !== undefined) stop("RECEIPT_NOT_SUCCEEDED");
  return { r, images, photo, design };
}

export type PackOptions = {
  /** The finished run directory the worker wrote (0700). */
  runDir: string;
  /** The worker's receipt for that run (0600). */
  receiptPath: string;
  /** Where sealed bundles live (0700, outside the repository; created if missing). */
  bundlesDir: string;
  /** SHA-256 of the assembled composites (image-first-check --run prints them); a composite file without one is refused. */
  composites?: Partial<Record<"pc" | "sp", string>>;
  now?: () => number;
  limits?: BundleLimits;
};

/** Packs and seals ONE private bundle. Throws BundleStop; on any failure nothing is left under the bundle's name. */
export async function packBundle(o: PackOptions): Promise<SealedBundle> {
  const limits = checkLimits(o.limits ?? BUNDLE_LIMITS);
  const now = o.now ?? Date.now;

  // ---- the receipt ----
  const receiptBytes = await readNoFollow(o.receiptPath, limits.receiptBytes, { link: "RECEIPT_UNREADABLE", big: "RECEIPT_UNREADABLE" }, true);
  if (!receiptBytes) return stop("RECEIPT_UNREADABLE");
  const { r, images, photo, design } = parseReceipt(receiptBytes);
  // a photo-materials bundle has no composites (there is no page to stack)
  if (photo && Object.values(o.composites ?? {}).some((v) => v !== undefined)) stop("COMPOSITE_SHA_INVALID");

  // ---- the run directory: ours, and the one the receipt names ----
  if (!(await ownPrivateDir(o.runDir))) stop("RUN_DIR_UNSAFE");
  const root = await realpath(o.runDir);
  const named = await realpath(r.run_dir as string).catch(() => null);
  if (named !== root) stop("RECEIPT_RUN_DIR_MISMATCH");

  // ---- what may be there: exactly the receipt's parts, and the composites the caller named ----
  const composites: [string, string][] = [];
  for (const [view, want] of Object.entries(o.composites ?? {}) as ["pc" | "sp", string | undefined][]) {
    if (want === undefined) continue;
    if (!SHA_RE.test(want)) stop("COMPOSITE_SHA_INVALID");
    composites.push([`composites/${view}.png`, want]);
  }
  const expected = new Map<string, { sha: string; role: "part" | "composite"; size?: number }>([
    ...images.map((i): [string, { sha: string; role: "part"; size: number }] => [i.file, { sha: i.sha256, role: "part", size: i.bytes }]),
    ...composites.map(([p, s]): [string, { sha: string; role: "composite" }] => [p, { sha: s, role: "composite" }]),
  ]);
  const present: string[] = [];
  for (const sub of BUNDLE_DIRS) {
    const info = await lstat(join(root, sub)).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) stop("RUN_FILE_LINK");
    for (const name of await readdir(join(root, sub))) {
      const rel = `${sub}/${name}`;
      const st = await lstat(join(root, rel));
      if (st.isSymbolicLink()) stop("RUN_FILE_LINK");
      if (!st.isFile()) stop("RUN_FILE_UNEXPECTED");
      if (!expected.has(rel)) stop("RUN_FILE_UNEXPECTED");
      present.push(rel);
    }
  }
  for (const rel of expected.keys()) if (!present.includes(rel)) stop("RUN_FILE_MISSING");

  // ---- read each file ONCE (these bytes are what gets sealed), hash, size and PNG checks ----
  const files: BundleFile[] = [];
  const bytesOf = new Map<string, Buffer>();
  let total = receiptBytes.length;
  for (const [rel, want] of [...expected.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = join(root, rel);
    const real = await realpath(path).catch(() => null);
    if (real !== path) stop("RUN_FILE_OUTSIDE");
    const pngLimits = want.role === "part" ? limits.part : limits.composite;
    const bytes = await readNoFollow(path, pngLimits.maxBytes, { link: "RUN_FILE_LINK", big: "RUN_FILE_TOO_LARGE" });
    if (!bytes) return stop("RUN_FILE_MISSING");
    total += bytes.length;
    if (total > limits.totalBytes) stop("TOTAL_TOO_LARGE");
    const got = sha256(bytes);
    if (got !== want.sha || (want.size !== undefined && want.size !== bytes.length)) stop("RUN_FILE_SHA_MISMATCH");
    asPng(bytes, pngLimits, "RUN_FILE_NOT_PNG");
    files.push({ path: rel, role: want.role, sha256: got, bytes: bytes.length });
    bytesOf.set(rel, bytes);
  }
  // the bundled receipt drops the worker's absolute local run_dir (a home path) so it cannot leave the machine; every
  // other field, the part SHAs included, is kept; the original bytes' SHA goes into the manifest
  const bundledReceipt = Buffer.from(`${JSON.stringify({ ...r, run_dir: RECEIPT_RUN_DIR_REDACTED }, null, 2)}\n`);
  if (bundledReceipt.length > limits.receiptBytes) stop("RECEIPT_INVALID");
  total += bundledReceipt.length - receiptBytes.length;
  files.push({ path: "receipt.json", role: "receipt", sha256: sha256(bundledReceipt), bytes: bundledReceipt.length });
  bytesOf.set("receipt.json", bundledReceipt);
  sortFiles(files);

  // ---- the manifest (codes, ids, SHAs and sizes only) ----
  const created = now();
  const sums = renderSums(files);
  const bundleId = r.approval_id as string;
  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    bundle_id: bundleId,
    approval_id: bundleId,
    plan_id: r.plan_id as string,
    commit: r.commit as string,
    shop: r.shop as string,
    direction: r.direction as string,
    ...(r.mode === "request" ? { mode: "request" as const, kind: r.kind as "real_shop" | "fictional" } : {}),
    packet_sha256: r.packet_sha256 as string,
    plan_sha256: r.plan_sha256 as string,
    receipt_sha256: sha256(bundledReceipt),
    receipt_original_sha256: sha256(receiptBytes),
    files,
    sha256sums_sha256: sha256(sums),
    ...(photo
      ? {
          counts: { pc: 0, sp: 0, composites: 0, files: files.length, photo: images.length },
          image_material: true as const,
          image_material_label: IMAGE_MATERIAL_LABEL,
          photos: files.filter((f) => f.role === "part").map((f) => ({ file: f.path, sha256: f.sha256, frame: photoFrameOf(f.path)! })),
        }
      : { counts: { pc: design.pc, sp: design.sp, composites: composites.length, files: files.length } }),
    total_bytes: total,
    created_at: new Date(created).toISOString(),
    access: { visibility: "private", retrieval_ttl_seconds: BUNDLE_ACCESS.retrievalTtlSeconds },
    retention: { retain_days: BUNDLE_ACCESS.retainDays, delete_after: new Date(created + BUNDLE_ACCESS.retainDays * DAY_MS).toISOString() },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifestBytes.length > limits.manifestBytes || sums.length > limits.sumsBytes) stop("BUNDLE_MANIFEST_INVALID");

  // ---- write under a temporary name, then claim the final name and rename into it (never overwrite) ----
  await mkdir(o.bundlesDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (!(await ownPrivateDir(o.bundlesDir))) stop("BUNDLES_DIR_UNSAFE");
  const bundles = await realpath(o.bundlesDir);
  const final = join(bundles, bundleId);
  if (await lstat(final).then(() => true, () => false)) stop("BUNDLE_EXISTS");
  const tmp = join(bundles, `.tmp-${bundleId}-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(tmp, { mode: 0o700 });
    await writeEntries(tmp, [...[...bytesOf.entries()].map(([path, bytes]) => ({ path, bytes })), { path: "SHA256SUMS", bytes: Buffer.from(sums) }, { path: "manifest.json", bytes: manifestBytes }]);
    // one atomic rename of the finished directory: the final name never exists empty or half-written (PR #310 review L2:
    // no empty placeholder a crash could leave behind). A non-empty final (another pack won) refuses: ENOTEMPTY / EEXIST.
    try {
      await rename(tmp, final);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // a file or link appearing at the final name in the window: ENOTDIR / EISDIR, the same "already there" (re-review L-d)
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") stop("BUNDLE_EXISTS");
      throw error;
    }
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof BundleStop) throw error;
    return stop("BUNDLE_WRITE_FAILED");
  }

  // ---- read the sealed bundle back through the same verifier the receiver uses ----
  const verified = await verifyBundleDir(final, { limits, expected: { approval_id: manifest.approval_id, plan_id: manifest.plan_id, commit: manifest.commit, bundle_sha256: sha256(manifestBytes) } });
  return { dir: final, bundle_id: bundleId, bundle_sha256: verified.bundle_sha256, manifest: verified.manifest };
}

/** Writes entries into a fresh private directory: 0700 dirs, 0600 files, O_EXCL | O_NOFOLLOW. Paths must be bundle paths. */
export async function writeEntries(dir: string, entries: readonly BundleEntry[]): Promise<void> {
  for (const e of entries) {
    if (!(e.path === "manifest.json" || e.path === "SHA256SUMS" || isBundleFilePath(e.path))) stop("BUNDLE_FILE_SET_MISMATCH");
    const slash = e.path.indexOf("/");
    if (slash > 0) await mkdir(join(dir, e.path.slice(0, slash)), { mode: 0o700 }).catch((err: { code?: string }) => (err.code === "EEXIST" ? undefined : Promise.reject(err)));
    const h = await open(join(dir, e.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(e.bytes);
      await h.sync();
    } finally {
      await h.close();
    }
  }
}

export type VerifyOptions = { limits?: BundleLimits; expected?: ExpectedRecord };

/**
 * Verifies a sealed or received bundle directory from scratch and returns the exact bytes it checked. Checks: the
 * directory is ours and private; no link or special file anywhere; the file set equals the manifest's (no extra, no
 * missing, only bundle paths); SHA256SUMS equals the manifest's list and SHA; each file's size and SHA-256; every
 * picture a well-formed PNG within its limits; the receipt matches the manifest (ids, commit, every part's SHA and size);
 * PC 2 + SP 4; the total; and, when given, the expected approval / plan / commit / bundle SHA.
 */
export async function verifyBundleDir(dir: string, o: VerifyOptions = {}): Promise<VerifiedBundle> {
  const limits = checkLimits(o.limits ?? BUNDLE_LIMITS);
  if (!(await ownPrivateDir(dir))) stop("BUNDLE_DIR_UNSAFE");
  const { files: present, dirs } = await walk(dir, "BUNDLE_LINK_OR_SPECIAL");
  if (dirs.some((d) => !(BUNDLE_DIRS as readonly string[]).includes(d))) stop("BUNDLE_FILE_SET_MISMATCH");
  const io = { link: "BUNDLE_LINK_OR_SPECIAL" as const, big: "BUNDLE_FILE_TOO_LARGE" as const };
  const manifestBytes = await readNoFollow(join(dir, "manifest.json"), limits.manifestBytes, io);
  const sumsBytes = await readNoFollow(join(dir, "SHA256SUMS"), limits.sumsBytes, io);
  if (!manifestBytes || !sumsBytes) return stop("BUNDLE_FILE_SET_MISMATCH");
  const bundleSha = sha256(manifestBytes);

  let m: BundleManifest;
  try {
    m = JSON.parse(manifestBytes.toString("utf8")) as BundleManifest;
  } catch {
    return stop("BUNDLE_MANIFEST_INVALID");
  }
  const okManifest =
    m && typeof m === "object" && m.schema === BUNDLE_SCHEMA && typeof m.bundle_id === "string" && APPROVAL_ID_RE.test(m.bundle_id) && m.approval_id === m.bundle_id &&
    typeof m.plan_id === "string" && PLAN_ID_RE.test(m.plan_id) && typeof m.commit === "string" && COMMIT_RE.test(m.commit) && Array.isArray(m.files) &&
    typeof m.sha256sums_sha256 === "string" && typeof m.receipt_sha256 === "string" && typeof m.receipt_original_sha256 === "string" && SHA_RE.test(m.receipt_original_sha256) &&
    !!m.access && typeof m.access === "object" && !!m.retention && typeof m.retention === "object";
  if (!okManifest) stop("BUNDLE_MANIFEST_INVALID");
  if (!termsValid(m)) stop("BUNDLE_TERMS_INVALID");
  for (const f of m.files) {
    if (!f || typeof f.path !== "string" || !isBundleFilePath(f.path) || typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0) stop("BUNDLE_MANIFEST_INVALID");
    const role = f.path === "receipt.json" ? "receipt" : PART_RE.test(f.path) ? "part" : "composite";
    if (f.role !== role) stop("BUNDLE_MANIFEST_INVALID");
  }
  const listed = m.files.map((f) => f.path);
  if (new Set(listed).size !== listed.length) stop("BUNDLE_MANIFEST_INVALID");
  const want = new Set([...listed, "manifest.json", "SHA256SUMS"]);
  if (present.length !== want.size || present.some((p) => !want.has(p))) stop("BUNDLE_FILE_SET_MISMATCH");
  const sorted = sortFiles([...m.files]);
  if (sorted.some((f, i) => f !== m.files[i])) stop("BUNDLE_MANIFEST_INVALID");
  if (sumsBytes.toString("utf8") !== renderSums(m.files) || sha256(sumsBytes) !== m.sha256sums_sha256) stop("BUNDLE_SUMS_MISMATCH");

  const entries: BundleEntry[] = [];
  let total = 0;
  for (const f of m.files) {
    const pngLimits = f.role === "composite" ? limits.composite : limits.part;
    const max = f.role === "receipt" ? limits.receiptBytes : pngLimits.maxBytes;
    const bytes = await readNoFollow(join(dir, f.path), max, io);
    if (!bytes) return stop("BUNDLE_FILE_SET_MISMATCH");
    total += bytes.length;
    if (total > limits.totalBytes) stop("BUNDLE_FILE_TOO_LARGE");
    if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) stop("BUNDLE_FILE_SHA_MISMATCH");
    if (f.role !== "receipt") asPng(bytes, pngLimits, "BUNDLE_FILE_NOT_PNG");
    entries.push({ path: f.path, bytes });
  }
  if (total !== m.total_bytes) stop("BUNDLE_MANIFEST_INVALID");

  // the receipt inside agrees with the manifest
  const receipt = entries.find((e) => e.path === "receipt.json");
  if (!receipt || sha256(receipt.bytes) !== m.receipt_sha256) return stop("BUNDLE_RECEIPT_MISMATCH");
  let parsed: ReturnType<typeof parseReceipt>;
  try {
    parsed = parseReceipt(receipt.bytes);
  } catch {
    return stop("BUNDLE_RECEIPT_MISMATCH");
  }
  const { r, images, photo, design } = parsed;
  if (r.approval_id !== m.approval_id || r.plan_id !== m.plan_id || r.commit !== m.commit || r.packet_sha256 !== m.packet_sha256 || r.plan_sha256 !== m.plan_sha256 || r.run_dir !== RECEIPT_RUN_DIR_REDACTED) stop("BUNDLE_RECEIPT_MISMATCH");
  if (m.shop !== r.shop || m.direction !== r.direction || m.mode !== r.mode || m.kind !== r.kind) stop("BUNDLE_RECEIPT_MISMATCH");
  const parts = m.files.filter((f) => f.role === "part");
  if (parts.length !== images.length || images.some((i) => !parts.some((p) => p.path === i.file && p.sha256 === i.sha256 && p.bytes === i.bytes))) stop("BUNDLE_RECEIPT_MISMATCH");
  const pc = parts.filter((p) => p.path.startsWith("parts/pc-")).length;
  const sp = parts.filter((p) => p.path.startsWith("parts/sp-")).length;
  const comps = m.files.filter((f) => f.role === "composite").length;
  if (photo) {
    // DEV-303: a photo-materials bundle: its marker, 1..6 photos listed with their SHA-256 and frame, nothing else
    const listed = Array.isArray(m.photos) ? m.photos : [];
    const okPhotos = listed.length === parts.length && parts.every((p, n) => listed[n]?.file === p.path && listed[n]?.sha256 === p.sha256 && listed[n]?.frame === photoFrameOf(p.path));
    if (m.image_material !== true || m.image_material_label !== IMAGE_MATERIAL_LABEL || !okPhotos) stop("BUNDLE_MANIFEST_INVALID");
    if (pc !== 0 || sp !== 0 || comps !== 0 || parts.length < 1 || parts.length > 6 || m.counts?.pc !== 0 || m.counts?.sp !== 0 || m.counts?.photo !== parts.length || m.counts?.composites !== 0 || m.counts?.files !== m.files.length) stop("BUNDLE_COUNTS_INVALID");
  } else {
    if (m.image_material !== undefined || m.image_material_label !== undefined || m.photos !== undefined || m.counts?.photo !== undefined) stop("BUNDLE_MANIFEST_INVALID");
    if (pc !== design.pc || sp !== design.sp || m.counts?.pc !== pc || m.counts?.sp !== sp || m.counts?.composites !== comps || m.counts?.files !== m.files.length) stop("BUNDLE_COUNTS_INVALID");
  }

  if (o.expected) {
    const e = o.expected;
    if (e.approval_id !== m.approval_id || e.plan_id !== m.plan_id || e.commit !== m.commit) stop("BUNDLE_RECORD_MISMATCH");
    if (e.bundle_sha256 !== undefined && e.bundle_sha256 !== bundleSha) stop("BUNDLE_SHA_MISMATCH");
  }
  return {
    bundle_sha256: bundleSha,
    manifest: m,
    entries: [...entries, { path: "SHA256SUMS", bytes: sumsBytes }, { path: "manifest.json", bytes: manifestBytes }],
  };
}
