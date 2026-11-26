/**
 * Issue #336: the owner's PRIVATE viewer of all 37 adopted success cases, and the check of originals the owner hands over.
 *
 * Inputs (all read-only):
 *   - design-library/success-cases/originals-handover.json (`sr_success_originals_handover_v1`): every adopted case, what
 *     the owner hands over and the SHA-256 recorded for each ADOPTED original (metadata only, committed);
 *   - originals-index.json and manifest.json (the files in the repository, and other recorded SHA-256s: viewing copies,
 *     drafts, comparison sheets — these are reported, never promoted to an original);
 *   - a private root OUTSIDE the repository (e.g. ~/second-root-originals/) where the owner puts what they hand over:
 *       <root>/<ID>/<file>          a provided file (a ZIP, a PNG, ...), left untouched;
 *       <root>/<ID>/pseudo/<file>   a pseudo-restoration (never an original, whatever its SHA-256).
 *
 * verifyProvidedOriginals writes only under the root:
 *   <root>/_extracted/<ID>/<label>/...            the members of a verified ZIP (0700 dirs, 0600 files, never overwritten);
 *   <root>/_index/private-originals-index.json    the PRIVATE index (`sr_private_originals_index_v1`).
 * A provided file is an original only when its SHA-256 is one the handover list records as an adopted original of that
 * id. A ZIP whose own SHA-256 is not recorded is "verified via member": ONLY its members whose SHA-256 is recorded are
 * originals; its other members are shown as unverified, never as originals. A ZIP with a SHA256SUMS must match it
 * entirely. An id without a recorded SHA-256 (category C) can never be verified. Pseudo-restorations are labelled only.
 *
 * writeSuccessCasesViewer writes a static page (no script, no network, no external font; CSP) to a directory outside the
 * repository, with the verified images copied next to it. Every file is re-hashed and every private entry is re-checked
 * against the CURRENT records first. Every text is escaped.
 *
 * Memory: a provided ZIP is read whole (ZIP_MAX_BYTES) and its members inflated in memory (ZIP_MAX_TOTAL), about 1 GiB
 * at most per ZIP, one ZIP at a time.
 *
 * Nothing here commits, sends or generates anything. Failures throw OriginalsStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { z } from "zod";

export const HANDOVER_PATH = "design-library/success-cases/originals-handover.json";
export const HANDOVER_SCHEMA = "sr_success_originals_handover_v1";
export const PRIVATE_INDEX_SCHEMA = "sr_private_originals_index_v1";
export const PRIVATE_INDEX_REL = "_index/private-originals-index.json";
export const EXTRACTED_DIR = "_extracted";
export const PSEUDO_DIR = "pseudo";
const ORIGINALS_INDEX_PATH = "design-library/success-cases/originals-index.json";
const MANIFEST_PATH = "design-library/success-cases/manifest.json";
const RESEARCH_LEDGER_PATH = "design-library/success-cases/second-root-research-successes.json";
/** A provided ZIP is read into memory: at most this large. */
export const ZIP_MAX_BYTES = 256 * 1024 * 1024;
/** The inflated members of one ZIP, all held in memory: at most this much. */
export const ZIP_MAX_TOTAL = 768 * 1024 * 1024;
/** Any other provided or viewed file, and any one ZIP member. */
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 4000;
/** The page shows at most this many images per case (the rest are listed). */
const VIEWER_MAX_IMAGES_PER_CASE = 24;

export const ORIGINALS_CODES = [
  "ORIGINALS_HANDOVER_INVALID",
  "ORIGINALS_ROOT_INVALID",
  "ORIGINALS_ROOT_IN_REPO",
  "ORIGINALS_INDEX_INVALID",
  "ORIGINALS_EXTRACT_CONFLICT",
  "ORIGINALS_OUT_IN_REPO",
  "ORIGINALS_OUT_NOT_EMPTY",
  "ORIGINALS_SR001_JOB_INVALID",
] as const;
export type OriginalsCode = (typeof ORIGINALS_CODES)[number];
export class OriginalsStop extends Error {
  constructor(readonly code: OriginalsCode) {
    super(code);
    this.name = "OriginalsStop";
  }
}

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const CASE_ID_RE = /^(?:CP|SR)-\d{3}$/;
const CASE_ID = z.string().regex(CASE_ID_RE);
const Line = z.string().min(1).max(400).refine((s) => !/[\u0000-\u001f\u007f]/.test(s));

export const HandoverFile = z.strictObject({
  name: Line.nullable(),
  sha256: SHA.nullable(),
  role: z.string().regex(/^[a-z_]{2,30}$/),
  label: Line.optional(),
  /** Where the file name is recorded when it is not in this branch's records (e.g. an unmerged PR). */
  name_source: Line.optional(),
});
export const HandoverCase = z.strictObject({
  id: CASE_ID,
  title: Line,
  category: z.enum(["A", "B", "C"]),
  record: Line,
  adoption_record: Line,
  request: z.array(HandoverFile).max(12),
  note: Line.optional(),
});
export const Handover = z.object({
  schema: z.literal(HANDOVER_SCHEMA),
  as_of: z.string(),
  cases: z.array(HandoverCase).min(1).max(100),
});
export type Handover = z.infer<typeof Handover>;
export type HandoverCase = z.infer<typeof HandoverCase>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// ---- records -------------------------------------------------------------------------------------------------------

/** manifest.json's field names that record a version that was NOT adopted (never evidence of the original). */
const NOT_ADOPTED_KEY = /rejected|not_preferred/;

export type RecordedSha = { role: string; name: string | null; label: string | null; source: "handover" | "manifest" | "index" };
export type Records = {
  handover: Handover;
  /** Per id: the SHA-256s of ADOPTED originals (the handover list's request). Only these promote a case. */
  originals: Map<string, Map<string, RecordedSha>>;
  /** Per id: other recorded SHA-256s (manifest.json / index fields not in the request: viewing copies, drafts, ...). */
  other: Map<string, Map<string, RecordedSha>>;
  /** Repository files per id (originals-index.json), with their recorded SHA-256. */
  repoFiles: Map<string, { path: string; sha256: string; role: string }[]>;
  sr001PageHashes: { html: string; css: string; copy: string } | null;
};

/** The handover list (adopted originals) plus every other recorded SHA-256 (reported, never promoting). */
export async function readRecords(repo: string): Promise<Records> {
  let handover: Handover;
  try {
    handover = Handover.parse(JSON.parse(await readFile(join(repo, HANDOVER_PATH), "utf8")));
  } catch {
    throw new OriginalsStop("ORIGINALS_HANDOVER_INVALID");
  }
  const ids = handover.cases.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new OriginalsStop("ORIGINALS_HANDOVER_INVALID");
  try {
    const index = JSON.parse(await readFile(join(repo, ORIGINALS_INDEX_PATH), "utf8")) as {
      originals?: { id: string; files: { path: string; sha256: string; role?: string }[] }[];
      expected_sha256?: Record<string, string[]>;
    };
    const manifest = JSON.parse(await readFile(join(repo, MANIFEST_PATH), "utf8")) as { records?: Record<string, unknown>[] };
    const originals = new Map<string, Map<string, RecordedSha>>();
    const other = new Map<string, Map<string, RecordedSha>>();
    for (const c of handover.cases) {
      const o = new Map<string, RecordedSha>();
      for (const f of c.request) if (f.sha256) o.set(f.sha256, { role: f.role, name: f.name, label: f.label ?? null, source: "handover" });
      const x = new Map<string, RecordedSha>();
      for (const [k, v] of Object.entries(manifest.records?.find((r) => r.id === c.id) ?? {}))
        if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) && !NOT_ADOPTED_KEY.test(k) && !o.has(v)) x.set(v, { role: k, name: null, label: null, source: "manifest" });
      for (const v of index.expected_sha256?.[c.id] ?? []) if (SHA.safeParse(v).success && !o.has(v) && !x.has(v)) x.set(v, { role: "expected_sha256", name: null, label: null, source: "index" });
      // the repository's own viewing copies / pages: a private copy of one is never a new original
      for (const f of index.originals?.find((r) => r.id === c.id)?.files ?? []) if (SHA.safeParse(f.sha256).success && !o.has(f.sha256) && !x.has(f.sha256)) x.set(f.sha256, { role: `repo_${f.role ?? "file"}`, name: null, label: null, source: "index" });
      originals.set(c.id, o);
      other.set(c.id, x);
    }
    const repoFiles = new Map<string, { path: string; sha256: string; role: string }[]>();
    for (const o of index.originals ?? []) repoFiles.set(o.id, o.files.map((f) => ({ path: f.path, sha256: f.sha256, role: f.role ?? "file" })));
    let sr001PageHashes: Records["sr001PageHashes"] = null;
    try {
      const ledger = JSON.parse(await readFile(join(repo, RESEARCH_LEDGER_PATH), "utf8")) as { records?: { id: string; page_hashes?: Record<string, string> }[] };
      const ph = ledger.records?.find((r) => r.id === "SR-001")?.page_hashes;
      if (ph && SHA.safeParse(ph.html_sha256).success && SHA.safeParse(ph.css_sha256).success && SHA.safeParse(ph.copy_sha256).success) sr001PageHashes = { html: ph.html_sha256!, css: ph.css_sha256!, copy: ph.copy_sha256! };
    } catch {
      sr001PageHashes = null;
    }
    return { handover, originals, other, repoFiles, sr001PageHashes };
  } catch {
    throw new OriginalsStop("ORIGINALS_HANDOVER_INVALID");
  }
}

// ---- reading files safely ------------------------------------------------------------------------------------------

/** A regular file read on one handle: no link at the last step, a single name, within the cap. */
export async function readRegularFile(path: string, max: number): Promise<{ bytes: Buffer; reason: null } | { bytes: null; reason: "missing" | "unsafe" | "too_large" }> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return { bytes: null, reason: (e as { code?: string }).code === "ENOENT" ? "missing" : "unsafe" };
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1) return { bytes: null, reason: "unsafe" };
    if (st.size > max) return { bytes: null, reason: "too_large" };
    const bytes = await h.readFile();
    return bytes.length > max ? { bytes: null, reason: "too_large" } : { bytes, reason: null };
  } finally {
    await h.close();
  }
}

const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  ".png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".jpg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  ".gif": (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")),
};
/** An image by extension AND magic bytes. */
export const isImage = (name: string, bytes: Buffer) => {
  const check = IMAGE_MAGIC[extname(name).toLowerCase()];
  return check !== undefined && check(bytes);
};
const isHtmlName = (name: string) => /\.html?$/i.test(name);
const ZIP_MAGIC = (b: Buffer) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06));

// ---- ZIP (stored / deflate only; no encryption, no ZIP64, no links, no unsafe names) --------------------------------

export type ZipEntry = { name: string; data: Buffer };
export type ZipResult = { ok: true; entries: ZipEntry[] } | { ok: false; reason: string };

/** A member path: relative, "/"-separated, no "." / ".." / empty segment, no backslash, colon or control character. */
export const safeMemberName = (n: string) =>
  n.length > 0 && n.length <= 300 && !n.startsWith("/") && !/[\\:\u0000-\u001f\u007f]/.test(n) && n.split("/").every((s) => s !== "" && s !== "." && s !== "..") && n.split("/").length <= 12;

/** Reads a ZIP held in memory. Every entry's CRC-32 and size are checked; directories and macOS metadata are skipped. */
export function readZip(buf: Buffer): ZipResult {
  const fail = (reason: string): ZipResult => ({ ok: false, reason });
  if (!ZIP_MAGIC(buf)) return fail("not_a_zip");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail("no_end_record");
  // a ZIP64 end-of-central-directory locator right before the end record
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) return fail("zip64_unsupported");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) return fail("multi_disk");
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) return fail("zip64_unsupported");
  if (total > ZIP_MAX_ENTRIES) return fail("too_many_entries");
  if (cdOffset + cdSize > eocd) return fail("bad_central_directory");
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  let sum = 0;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return fail("bad_central_directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) return fail("encrypted");
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) return fail("zip64_unsupported");
    let name: string;
    try {
      name = utf8.decode(rawName);
    } catch {
      name = `entry-${n + 1}${/\.[A-Za-z0-9]{1,5}$/.exec(rawName.toString("latin1"))?.[0] ?? ""}`;
    }
    if (name.endsWith("/")) continue;
    if (name.startsWith("__MACOSX/") || basename(name) === ".DS_Store") continue;
    if (((external >>> 16) & 0o170000) === 0o120000) return fail("link_entry");
    if (!safeMemberName(name)) return fail("unsafe_name");
    const key = name.toLowerCase();
    if (seen.has(key)) return fail("duplicate_name");
    seen.add(key);
    if (usize > FILE_MAX_BYTES) return fail("entry_too_large");
    sum += usize;
    if (sum > ZIP_MAX_TOTAL) return fail("too_large_total");
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return fail("bad_local_header");
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + csize > buf.length) return fail("truncated");
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) {
      if (csize !== usize) return fail("bad_size");
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
      } catch {
        return fail("inflate_failed");
      }
    } else return fail("unsupported_method");
    if (data.length !== usize) return fail("bad_size");
    if (crc32(data) >>> 0 !== crc) return fail("crc_mismatch");
    entries.push({ name, data });
  }
  // a file that is also a folder of another member ("a" and "a/b") cannot be extracted
  for (const k of seen) {
    const parts = k.split("/");
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join("/"))) return fail("path_conflict");
  }
  return { ok: true, entries };
}

/** SHA256SUMS lines ("<sha>  <path>" or "<sha> *<path>"), paths relative to the file's folder or to the ZIP root. */
export function checkSha256Sums(entries: ZipEntry[]): { present: boolean; listed: number; matched: number; mismatched: number; missing: number } {
  const sums = entries.find((e) => /(^|\/)SHA256SUMS(\.txt)?$/i.test(e.name));
  if (!sums) return { present: false, listed: 0, matched: 0, mismatched: 0, missing: 0 };
  const dir = sums.name.includes("/") ? sums.name.slice(0, sums.name.lastIndexOf("/") + 1) : "";
  const byName = new Map(entries.map((e) => [e.name, e]));
  let listed = 0;
  let matched = 0;
  let mismatched = 0;
  let missing = 0;
  for (const line of sums.data.toString("utf8").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (!m) continue;
    listed++;
    const rel = m[2]!.replace(/^\.\//, "");
    const e = byName.get(dir + rel) ?? byName.get(rel);
    if (!e) missing++;
    else if (sha256(e.data) === m[1]!.toLowerCase()) matched++;
    else mismatched++;
  }
  return { present: true, listed, matched, mismatched, missing };
}

// ---- the private root ------------------------------------------------------------------------------------------------

/** The root: an existing directory (not a link) outside the repository (links resolved). Returns its real path. */
export async function checkPrivateRoot(root: string, repo: string): Promise<string> {
  if (!isAbsolute(root)) throw new OriginalsStop("ORIGINALS_ROOT_INVALID");
  const st = await lstat(root).catch(() => null);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new OriginalsStop("ORIGINALS_ROOT_INVALID");
  const real = await realpath(root);
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (within(real, realRepo) || within(realRepo, real) || within(resolve(root), resolve(repo))) throw new OriginalsStop("ORIGINALS_ROOT_IN_REPO");
  return real;
}

export const PROVIDED_STATUSES = [
  "verified",
  "verified_via_member",
  "verified_private_chain",
  "recorded_not_original",
  "sha_mismatch",
  "unverifiable_no_recorded_sha",
  "pseudo_restoration",
  "zip_invalid",
  "zip_sums_mismatch",
  "unsafe",
  "too_large",
] as const;
export type ProvidedStatus = (typeof PROVIDED_STATUSES)[number];

const MemberSchema = z.strictObject({ path: z.string().refine(safeMemberName), sha256: SHA, bytes: z.number().int().nonnegative(), image: z.boolean(), html: z.boolean(), recorded: z.boolean() });
const MatchedSchema = z.strictObject({ role: z.string().max(80), name: z.string().max(400).nullable(), label: z.string().max(400).nullable(), source: z.enum(["handover", "manifest", "index", "private_chain"]) });
const ProvidedSchema = z.strictObject({
  id: CASE_ID,
  file: z.string().refine((p) => isAbsolute(p) && !/[\u0000-\u001f]/.test(p)),
  name: z.string().min(1).max(400),
  sha256: SHA.nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  status: z.enum(PROVIDED_STATUSES),
  pseudo: z.boolean(),
  matched: MatchedSchema.nullable(),
  note: z.string().max(200).optional(),
  chain: z.strictObject({ job: z.string().refine(isAbsolute), viewport: z.string().regex(/^[a-z]+_\d{3,4}$/) }).optional(),
  zip: z
    .strictObject({
      reason: z.string().max(80).nullable(),
      sums: z.strictObject({ present: z.boolean(), listed: z.number().int(), matched: z.number().int(), mismatched: z.number().int(), missing: z.number().int() }),
      extracted_dir: z.string().refine(isAbsolute).nullable(),
      members: z.array(MemberSchema).max(ZIP_MAX_ENTRIES),
    })
    .optional(),
});
export type MemberRecord = z.infer<typeof MemberSchema>;
export type ProvidedRecord = z.infer<typeof ProvidedSchema>;
const PrivateIndexSchema = z.strictObject({
  schema: z.literal(PRIVATE_INDEX_SCHEMA),
  generated_at: z.string(),
  root: z.string().refine(isAbsolute),
  entries: z.array(ProvidedSchema),
  ignored: z.array(z.string()),
});
export type PrivateIndex = z.infer<typeof PrivateIndexSchema>;

async function writeNew(path: string, bytes: Buffer | string) {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(bytes);
  } finally {
    await h.close();
  }
}

/** mkdir -p under a base, refusing any existing link or non-folder on the way (base itself already checked). */
async function mkdirUnder(base: string, rel: string): Promise<string> {
  let cur = base;
  for (const part of rel.split("/").filter(Boolean)) {
    cur = join(cur, part);
    const st = await lstat(cur).catch(() => null);
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new OriginalsStop("ORIGINALS_EXTRACT_CONFLICT");
    if (!st) {
      try {
        await mkdir(cur, { mode: 0o700 });
      } catch {
        throw new OriginalsStop("ORIGINALS_EXTRACT_CONFLICT");
      }
    }
  }
  return cur;
}

/** Extracts into <root>/_extracted/<id>/<label>/; an existing folder is reused only when every member matches. */
async function extract(root: string, id: string, label: string, entries: ZipEntry[]): Promise<string> {
  const dir = join(root, EXTRACTED_DIR, id, label);
  const existing = await lstat(dir).catch(() => null);
  await mkdirUnder(root, `${EXTRACTED_DIR}/${id}`);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new OriginalsStop("ORIGINALS_EXTRACT_CONFLICT");
    for (const e of entries) {
      const got = await readRegularFile(join(dir, e.name), FILE_MAX_BYTES);
      if (!got.bytes || sha256(got.bytes) !== sha256(e.data)) throw new OriginalsStop("ORIGINALS_EXTRACT_CONFLICT");
    }
    return dir;
  }
  await mkdirUnder(root, `${EXTRACTED_DIR}/${id}/${label}`);
  for (const e of entries) {
    const target = join(dir, e.name);
    if (!within(target, dir)) throw new OriginalsStop("ORIGINALS_EXTRACT_CONFLICT");
    await mkdirUnder(dir, dirname(e.name) === "." ? "" : dirname(e.name));
    try {
      await writeNew(target, e.data);
    } catch {
      throw new OriginalsStop("ORIGINALS_EXTRACT_CONFLICT");
    }
  }
  return dir;
}

/** One provided file judged against the records of its id. */
async function judgeFile(root: string, id: string, file: string, pseudo: boolean, records: Records): Promise<ProvidedRecord> {
  const originals = records.originals.get(id)!;
  const other = records.other.get(id)!;
  const name = basename(file);
  const base = { id, file, name, pseudo, matched: null };
  const zipLike = extname(name).toLowerCase() === ".zip";
  const got = await readRegularFile(file, zipLike ? ZIP_MAX_BYTES : FILE_MAX_BYTES);
  if (!got.bytes) return { ...base, sha256: null, bytes: null, status: got.reason === "too_large" ? "too_large" : "unsafe" };
  const bytes = got.bytes;
  const sha = sha256(bytes);
  const own = originals.get(sha) ?? null;
  const otherOwn = other.get(sha) ?? null;
  const noRecord = originals.size === 0 && other.size === 0;
  const pseudoNote = pseudo && (own || otherOwn) ? "sha_is_recorded_but_placed_as_pseudo" : undefined;
  const isZip = ZIP_MAGIC(bytes);
  if (!isZip) {
    if (pseudo) return { ...base, sha256: sha, bytes: bytes.length, status: "pseudo_restoration", ...(pseudoNote ? { note: pseudoNote } : {}) };
    if (own) return { ...base, sha256: sha, bytes: bytes.length, status: "verified", matched: own };
    if (otherOwn) return { ...base, sha256: sha, bytes: bytes.length, status: "recorded_not_original", matched: otherOwn };
    return { ...base, sha256: sha, bytes: bytes.length, status: noRecord || originals.size === 0 ? "unverifiable_no_recorded_sha" : "sha_mismatch" };
  }
  const zip = readZip(bytes);
  if (!zip.ok) return { ...base, sha256: sha, bytes: bytes.length, status: pseudo ? "pseudo_restoration" : "zip_invalid", zip: { reason: zip.reason, sums: checkSha256Sums([]), extracted_dir: null, members: [] }, ...(pseudoNote ? { note: pseudoNote } : {}) };
  const sums = checkSha256Sums(zip.entries);
  const members: MemberRecord[] = zip.entries.map((e) => {
    const s = sha256(e.data);
    return { path: e.name, sha256: s, bytes: e.data.length, image: isImage(e.name, e.data), html: isHtmlName(e.name), recorded: !pseudo && originals.has(s) };
  });
  const sumsOk = !sums.present || (sums.mismatched === 0 && sums.missing === 0 && sums.listed > 0);
  let status: ProvidedStatus;
  if (pseudo) status = "pseudo_restoration";
  else if (!sumsOk) status = "zip_sums_mismatch";
  else if (own) status = "verified";
  else if (members.some((m) => m.recorded)) status = "verified_via_member";
  else if (otherOwn) status = "recorded_not_original";
  else status = originals.size === 0 ? "unverifiable_no_recorded_sha" : "sha_mismatch";
  const shouldExtract = status === "verified" || status === "verified_via_member" || status === "pseudo_restoration";
  const extracted = shouldExtract ? await extract(root, id, `${pseudo ? "pseudo-" : ""}${sha.slice(0, 12)}`, zip.entries) : null;
  return { ...base, sha256: sha, bytes: bytes.length, status, matched: pseudo ? null : (own ?? otherOwn), ...(pseudoNote ? { note: pseudoNote } : {}), zip: { reason: null, sums, extracted_dir: extracted, members } };
}

/** The regular files directly in a folder (links and others reported as ignored). */
async function listFiles(dir: string, ignored: string[]): Promise<string[]> {
  const out: string[] = [];
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const n of names.sort()) {
    const p = join(dir, n);
    const st = await lstat(p);
    if (st.isFile()) out.push(p);
    else if (!(st.isDirectory() && n === PSEUDO_DIR)) ignored.push(p);
  }
  return out;
}

const SR001_LABEL = "AI 写真入り完成版のレンダー（非公開。台帳の頁の SHA-256 → 実行の要約 → レンダーの連鎖で照合）";

/**
 * SR-001's completed AI-photo version lives in a private image-run output. It is registered only through a chain: the
 * run's swap summary names the page whose SHA-256s the ledger records, and each render's SHA-256 matches the summary.
 * Every listed render must be present and match (an empty list, a missing or changed render stops).
 */
export async function checkSr001Job(job: string, records: Records): Promise<ProvidedRecord[]> {
  const ph = records.sr001PageHashes;
  const got = await readRegularFile(join(job, "swap", "swap-summary.json"), 4 * 1024 * 1024);
  if (!ph || !got.bytes) throw new OriginalsStop("ORIGINALS_SR001_JOB_INVALID");
  let s: { schema?: string; source_hashes?: Record<string, string>; renders?: { viewport?: string; sha256?: string }[] };
  try {
    s = JSON.parse(got.bytes.toString("utf8"));
  } catch {
    throw new OriginalsStop("ORIGINALS_SR001_JOB_INVALID");
  }
  const src = s.source_hashes ?? {};
  if (s.schema !== "photo_swap_summary_v0" || src.html !== ph.html || src.css !== ph.css || src.copy !== ph.copy) throw new OriginalsStop("ORIGINALS_SR001_JOB_INVALID");
  const renders = Array.isArray(s.renders) ? s.renders : [];
  if (renders.length === 0) throw new OriginalsStop("ORIGINALS_SR001_JOB_INVALID");
  const out: ProvidedRecord[] = [];
  for (const r of renders) {
    if (!r.viewport || !/^[a-z]+_\d{3,4}$/.test(r.viewport) || !r.sha256 || !SHA.safeParse(r.sha256).success) throw new OriginalsStop("ORIGINALS_SR001_JOB_INVALID");
    const file = join(job, "swap", "renders", `${r.viewport}.png`);
    const f = await readRegularFile(file, FILE_MAX_BYTES);
    if (!f.bytes || sha256(f.bytes) !== r.sha256 || !isImage(file, f.bytes)) throw new OriginalsStop("ORIGINALS_SR001_JOB_INVALID");
    out.push({ id: "SR-001", file, name: basename(file), sha256: r.sha256, bytes: f.bytes.length, pseudo: false, status: "verified_private_chain", matched: { role: `render_${r.viewport}`, name: null, label: SR001_LABEL, source: "private_chain" }, chain: { job, viewport: r.viewport } });
  }
  return out;
}

/**
 * Judges every provided file under the root and writes the private index (and the extracted members) under the root.
 * SR-001's chain entries: --sr001-job registers them; without it, the previous index's chain entries are carried over
 * only after their chain is checked again (a broken chain stops), so a run without the flag never silently drops them.
 */
export async function verifyProvidedOriginals(o: { repo: string; root: string; sr001Job?: string; now?: Date }): Promise<PrivateIndex> {
  const records = await readRecords(o.repo);
  const root = await checkPrivateRoot(o.root, o.repo);
  const ignored: string[] = [];
  const entries: ProvidedRecord[] = [];
  const known = new Set(records.handover.cases.map((c) => c.id));
  for (const n of (await readdir(root)).sort()) {
    // the tool's own folders (_extracted, _index) and the owner's viewer outputs (e.g. _viewer-<date>)
    if (n.startsWith("_")) continue;
    const p = join(root, n);
    const st = await lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink() || !CASE_ID_RE.test(n) || !known.has(n)) {
      ignored.push(p);
      continue;
    }
    for (const f of await listFiles(p, ignored)) entries.push(await judgeFile(root, n, f, false, records));
    const pd = join(p, PSEUDO_DIR);
    const pst = await lstat(pd).catch(() => null);
    if (pst?.isDirectory() && !pst.isSymbolicLink()) for (const f of await listFiles(pd, ignored)) entries.push(await judgeFile(root, n, f, true, records));
  }
  if (o.sr001Job) entries.push(...(await checkSr001Job(resolve(o.sr001Job), records)));
  else {
    const prev = await readPrivateIndexIfPresent(root);
    const jobs = [...new Set((prev?.entries ?? []).filter((e) => e.status === "verified_private_chain" && e.chain).map((e) => e.chain!.job))];
    for (const job of jobs) entries.push(...(await checkSr001Job(job, records)));
  }
  const index: PrivateIndex = { schema: PRIVATE_INDEX_SCHEMA, generated_at: (o.now ?? new Date()).toISOString(), root, entries, ignored };
  await mkdirUnder(root, "_index");
  const target = join(root, PRIVATE_INDEX_REL);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeNew(tmp, `${JSON.stringify(index, null, 2)}\n`);
  await rename(tmp, target);
  return index;
}

/** The private index, strictly checked (an unknown field, status or shape stops); a missing index is ORIGINALS_INDEX_INVALID. */
export async function readPrivateIndex(root: string): Promise<PrivateIndex> {
  const got = await readRegularFile(join(root, PRIVATE_INDEX_REL), 64 * 1024 * 1024);
  if (!got.bytes) throw new OriginalsStop("ORIGINALS_INDEX_INVALID");
  try {
    return PrivateIndexSchema.parse(JSON.parse(got.bytes.toString("utf8")));
  } catch {
    throw new OriginalsStop("ORIGINALS_INDEX_INVALID");
  }
}

/** No index yet (verify never ran) is null; a present but invalid index stops (ORIGINALS_INDEX_INVALID). */
export async function readPrivateIndexIfPresent(root: string): Promise<PrivateIndex | null> {
  const st = await lstat(join(root, PRIVATE_INDEX_REL)).catch(() => null);
  return st ? readPrivateIndex(root) : null;
}

// ---- the viewer ------------------------------------------------------------------------------------------------------

export type CaseStatus = "original_verified_private" | "repo_verified" | "pseudo_only" | "sha_mismatch" | "unverified" | "missing";
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  original_verified_private: "原本を照合済み（非公開の写し）",
  repo_verified: "リポジトリの登録ファイル（閲覧用の写し・頁）を照合済み。採用原本は未受領",
  pseudo_only: "疑似復元だけ（原本ではない）",
  sha_mismatch: "渡されたファイルが記録の SHA-256 と一致しない",
  unverified: "渡されたが採用原本として照合できない（原本として扱わない）",
  missing: "原本なし（オーナーの受け渡し待ち）",
};
const PROVIDED_LABEL: Record<ProvidedStatus, string> = {
  verified: "原本（採用原本として記録された SHA-256 と一致）",
  verified_via_member: "ZIP 自体は記録なし。記録と一致した中のファイルだけが原本",
  verified_private_chain: "非公開の完成版（連鎖で照合）",
  recorded_not_original: "記録にはあるが採用原本ではない（閲覧用の写し・下書き・比較など）",
  sha_mismatch: "SHA-256 不一致（原本ではない）",
  unverifiable_no_recorded_sha: "未照合（採用原本の SHA-256 の記録が無い）",
  pseudo_restoration: "疑似復元（原本ではない）",
  zip_invalid: "ZIP を読めない",
  zip_sums_mismatch: "ZIP の SHA256SUMS と中身が一致しない",
  unsafe: "リンクなど安全でないファイル（読まない）",
  too_large: "大きすぎる",
};
export const VIEWER_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

type ShownFile = { label: string; path: string; sha256: string; status: string; image: string | null; link: string | null };
export type ViewerCase = {
  c: HandoverCase;
  status: CaseStatus;
  /** A provided file did not match (shown even when the case has other verified files). */
  has_mismatch: boolean;
  files: ShownFile[];
  /** Members of a ZIP verified only through other members, and files recorded but not adopted originals. Never inline. */
  unverified: ShownFile[];
  pseudo: ShownFile[];
  expected: { name: string; role: string; sha256: string | null; found: string }[];
};
export type ViewerModel = { cases: ViewerCase[]; counts: Record<CaseStatus, number>; with_mismatch: number; privateRoot: string | null; generatedFrom: string | null };

/**
 * Builds the page model: every case with its status, the repository files (re-hashed now) and the private files of the
 * private index. Each private entry is re-hashed AND re-judged against the current records: a verified entry stays an
 * original only while its SHA-256 (or, via member, a member's) is still recorded as an adopted original of that id, and
 * a chain entry only while its chain still holds. Images to copy are collected with their verified bytes.
 */
export async function buildViewerModel(o: { repo: string; root?: string }): Promise<{ model: ViewerModel; images: { name: string; bytes: Buffer }[] }> {
  const records = await readRecords(o.repo);
  const root = o.root ? await checkPrivateRoot(o.root, o.repo) : null;
  const index = root ? await readPrivateIndexIfPresent(root) : null;
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  const chainOk = new Map<string, Set<string>>();
  const images: { name: string; bytes: Buffer }[] = [];
  const cases: ViewerCase[] = [];
  for (const c of records.handover.cases) {
    const originals = records.originals.get(c.id)!;
    let n = 0;
    const addImage = (path: string, bytes: Buffer): string | null => {
      if (n >= VIEWER_MAX_IMAGES_PER_CASE || !isImage(path, bytes)) return null;
      n++;
      const name = `images/${c.id}-${n}${extname(path).toLowerCase()}`;
      images.push({ name, bytes });
      return name;
    };
    const files: ShownFile[] = [];
    const unverified: ShownFile[] = [];
    const pseudo: ShownFile[] = [];
    const foundShas = new Map<string, string>();
    let repoOk = false;
    let privOk = false;
    let mismatch = false;
    let unverifiedSeen = false;
    for (const f of records.repoFiles.get(c.id) ?? []) {
      const full = resolve(realRepo, f.path);
      const got = within(full, realRepo) ? await readRegularFile(full, FILE_MAX_BYTES) : { bytes: null };
      const ok = got.bytes !== null && sha256(got.bytes) === f.sha256;
      repoOk ||= ok;
      mismatch ||= !ok;
      if (ok) foundShas.set(f.sha256, "repo");
      files.push({ label: `リポジトリ（${f.role}。閲覧用の写し・頁）`, path: f.path, sha256: f.sha256, status: ok ? "記録の SHA-256 と一致" : "不一致または欠落", image: ok ? addImage(f.path, got.bytes!) : null, link: ok && isHtmlName(f.path) ? pathToFileURL(full).href : null });
    }
    for (const e of index?.entries.filter((x) => x.id === c.id) ?? []) {
      const isZip = e.zip !== undefined;
      const now = await readRegularFile(e.file, isZip ? ZIP_MAX_BYTES : FILE_MAX_BYTES);
      const stillSame = now.bytes !== null && e.sha256 !== null && sha256(now.bytes) === e.sha256;
      // re-judged against the CURRENT records, not the index's word
      let stillRecorded = false;
      if (e.status === "verified") stillRecorded = e.sha256 !== null && originals.has(e.sha256);
      else if (e.status === "verified_via_member") stillRecorded = (e.zip?.members ?? []).some((m) => originals.has(m.sha256));
      else if (e.status === "verified_private_chain" && e.chain && c.id === "SR-001") {
        if (!chainOk.has(e.chain.job)) chainOk.set(e.chain.job, new Set(await checkSr001Job(e.chain.job, records).then((r) => r.map((x) => x.sha256!), () => [] as string[])));
        stillRecorded = e.sha256 !== null && chainOk.get(e.chain.job)!.has(e.sha256);
      }
      const verified = !e.pseudo && stillSame && stillRecorded;
      const wasVerified = e.status === "verified" || e.status === "verified_via_member" || e.status === "verified_private_chain";
      if (verified) {
        privOk = true;
        if (e.status !== "verified_via_member" && e.sha256) foundShas.set(e.sha256, "private");
      } else if (e.status === "sha_mismatch" || e.status === "zip_sums_mismatch" || (wasVerified && !e.pseudo)) mismatch = true;
      else if (e.status === "unverifiable_no_recorded_sha" || e.status === "recorded_not_original") unverifiedSeen = true;
      const label = !stillSame ? "照合後に変わった（verify をやり直す）" : wasVerified && !stillRecorded ? "今の記録では採用原本ではない（verify をやり直す）" : PROVIDED_LABEL[e.status];
      // a container verified only through a member is not itself an original
      const target = e.pseudo ? pseudo : verified && e.status !== "verified_via_member" ? files : unverified;
      const showImage = stillSame && !isZip && (verified || e.pseudo) ? addImage(e.file, now.bytes!) : null;
      target.push({ label: `${e.pseudo ? "疑似復元" : "非公開の写し"}: ${e.name}`, path: e.file, sha256: e.sha256 ?? "-", status: label, image: showImage, link: null });
      const extractedOk = isZip && stillSame && e.zip?.extracted_dir && root && within(e.zip.extracted_dir, join(root, EXTRACTED_DIR));
      if (!extractedOk || !(verified || e.pseudo)) continue;
      for (const m of e.zip!.members) {
        if (!m.image && !m.html) continue;
        const mp = join(e.zip!.extracted_dir!, m.path);
        if (!within(mp, e.zip!.extracted_dir!)) continue;
        const mb = await readRegularFile(mp, FILE_MAX_BYTES);
        const same = mb.bytes !== null && sha256(mb.bytes) === m.sha256;
        const recordedNow = originals.has(m.sha256);
        // a ZIP verified only through a member: only recorded members are originals
        const memberIsOriginal = !e.pseudo && same && (e.status === "verified" || recordedNow);
        if (memberIsOriginal && recordedNow) foundShas.set(m.sha256, "private");
        const shown: ShownFile = {
          label: `${e.name} / ${m.path}`,
          path: mp,
          sha256: m.sha256,
          status: !same ? "照合後に変わった" : e.pseudo ? "疑似復元の中身（原本ではない）" : memberIsOriginal ? (recordedNow ? "ZIP の中身（採用原本として記録された SHA-256 と一致）" : "ZIP の中身（照合済みの採用 ZIP の一部）") : "未照合（記録の無い中身。原本ではない）",
          image: same && m.image && (memberIsOriginal || e.pseudo) ? addImage(mp, mb.bytes!) : null,
          link: same && m.html && (memberIsOriginal || e.pseudo) ? pathToFileURL(mp).href : null,
        };
        (e.pseudo ? pseudo : memberIsOriginal ? files : unverified).push(shown);
      }
    }
    const status: CaseStatus = privOk ? "original_verified_private" : repoOk ? "repo_verified" : mismatch ? "sha_mismatch" : pseudo.length > 0 ? "pseudo_only" : unverifiedSeen ? "unverified" : "missing";
    const expected = c.request.map((f) => ({ name: f.name ?? f.label ?? f.role, role: f.role, sha256: f.sha256, found: f.sha256 && foundShas.has(f.sha256) ? (foundShas.get(f.sha256) === "repo" ? "リポジトリにあり" : "非公開の置き場で照合済み") : f.sha256 ? "未受領" : "SHA-256 の記録なし（照合不可）" }));
    cases.push({ c, status, has_mismatch: mismatch, files, unverified, pseudo, expected });
  }
  const counts = Object.fromEntries((Object.keys(CASE_STATUS_LABEL) as CaseStatus[]).map((k) => [k, cases.filter((x) => x.status === k).length])) as Record<CaseStatus, number>;
  return { model: { cases, counts, with_mismatch: cases.filter((x) => x.has_mismatch).length, privateRoot: root, generatedFrom: index?.generated_at ?? null }, images };
}


/** The page's HTML (pure): every text escaped; images by relative names; links only to local file: URLs. */
export function renderViewer(m: ViewerModel): string {
  const e = escapeHtml;
  const fig = (f: ShownFile) => {
    const cap = `<figcaption><b>${e(f.label)}</b><br>${e(f.status)}<br><code>${e(f.sha256)}</code><br><span class="path">${e(f.path)}</span>${f.link ? `<br><a href="${e(f.link)}">原本の頁を開く（別の頁。原本の HTML なので、スクリプトや外部への通信を含むことがある）</a>` : ""}</figcaption>`;
    return f.image ? `<figure><img src="${e(f.image)}" alt="${e(f.label)}" loading="lazy">${cap}</figure>` : `<figure class="nofile">${cap}</figure>`;
  };
  const cats = { A: "A 原本あり", B: "B 文章のみ・所在は記録済み", C: "C 所在不明" } as const;
  const warn = (x: ViewerCase) => (x.has_mismatch && x.status !== "sha_mismatch" ? ` <span class="st st-sha_mismatch">不一致のファイルあり</span>` : "");
  const summary = (Object.keys(CASE_STATUS_LABEL) as CaseStatus[]).map((k) => `<li><span class="st st-${k}">${e(CASE_STATUS_LABEL[k])}</span>: ${m.counts[k]} 件</li>`).join("");
  const toc = m.cases.map((x) => `<li><a href="#${e(x.c.id)}">${e(x.c.id)}</a> <span class="st st-${x.status}">${e(CASE_STATUS_LABEL[x.status])}</span>${warn(x)}</li>`).join("");
  const sections = m.cases
    .map((x) => {
      const exp = x.expected.length
        ? `<table><thead><tr><th>受け渡すもの</th><th>種類</th><th>記録の SHA-256</th><th>状態</th></tr></thead><tbody>${x.expected.map((f) => `<tr><td>${e(f.name)}</td><td>${e(f.role)}</td><td><code>${e(f.sha256 ?? "記録なし")}</code></td><td>${e(f.found)}</td></tr>`).join("")}</tbody></table>`
        : "<p>受け渡すファイルの指定なし。</p>";
      return `<section class="case" id="${e(x.c.id)}">
<h2>${e(x.c.id)} — ${e(x.c.title)}</h2>
<p><span class="cat">${e(cats[x.c.category])}</span> <span class="st st-${x.status}">${e(CASE_STATUS_LABEL[x.status])}</span>${warn(x)}</p>
<p class="refs">記録: ${e(x.c.record)} ／ 採用記録: ${e(x.c.adoption_record)}</p>
${x.c.note ? `<p class="note">${e(x.c.note)}</p>` : ""}
${exp}
${x.files.length ? `<h3>見られるファイル</h3><div class="figs">${x.files.map(fig).join("")}</div>` : "<p class=\"none\">見られる原本はまだありません。</p>"}
${x.unverified.length ? `<h3 class="unv-h">未照合・原本ではない（記録の無い中身、閲覧用の写し・下書き、不一致など）</h3><div class="figs unv">${x.unverified.map(fig).join("")}</div>` : ""}
${x.pseudo.length ? `<h3 class="pseudo-h">疑似復元（原本ではない。参照に数えない）</h3><div class="figs pseudo">${x.pseudo.map(fig).join("")}</div>` : ""}
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>成功例の原本一覧</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1b; --bg: #fbfaf7; --muted: #6a6862; --line: #d9d6cf; --ok: #1f6b3a; --warn: #9a3412; --info: #1e4e8c; }
@media (prefers-color-scheme: dark) { :root { --fg: #ecebe7; --bg: #171716; --muted: #a3a19b; --line: #3a3936; --ok: #6fcf97; --warn: #f4a261; --info: #8ab4f8; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; line-height: 1.7; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 8px; }
h2 { font-size: 1.15rem; border-top: 1px solid var(--line); padding-top: 24px; }
h3 { font-size: 0.95rem; }
.st { font-size: 0.85rem; padding: 1px 6px; border: 1px solid currentColor; border-radius: 4px; }
.st-original_verified_private, .st-repo_verified { color: var(--ok); }
.st-pseudo_only, .st-sha_mismatch, .st-unverified { color: var(--warn); }
.st-missing { color: var(--muted); }
.cat, .refs, .path { color: var(--muted); font-size: 0.85rem; }
.note { border-left: 3px solid var(--info); padding-left: 8px; }
.pseudo-h, .unv-h { color: var(--warn); }
.pseudo figure, .unv figure { border: 2px dashed var(--warn); padding: 4px; }
.figs { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 0; flex: 1 1 320px; max-width: 100%; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
figcaption { font-size: 0.8rem; word-break: break-all; }
.nofile { border: 1px dashed var(--line); padding: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
code { font-size: 0.75rem; word-break: break-all; }
.toc { columns: 2 280px; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
<h1>承認された成功例 ${m.cases.length} 件 — 原本の一覧（非公開・ローカル）</h1>
<p>このページはこの機械の中だけで開く。このページ自体はスクリプトも通信も使わない。原本はリポジトリ（公開）に入れない。</p>
<p>「原本」と書くのは、ファイルの SHA-256 が採用原本として記録された値と一致したものだけ。疑似復元・不一致・記録の無いもの・閲覧用の写しは原本として扱わない。</p>
<p>「原本の頁を開く」は原本の HTML を別の頁として開く。その頁はこのページの制限の外で、スクリプトや外部への通信を含むことがある。画像が表示されない場合は、ブラウザが file: のページの画像（img-src 'self'）を許しているか確かめる。</p>
<p class="refs">非公開の置き場: ${e(m.privateRoot ?? "（指定なし。リポジトリのファイルだけ）")} ／ 非公開の索引の作成: ${e(m.generatedFrom ?? "なし")}</p>
<ul>${summary}<li>不一致のファイルがある件: ${m.with_mismatch} 件</li></ul>
<ul class="toc">${toc}</ul>
${sections}
</main>
</body>
</html>
`;
}

/** The real place a path would have (its nearest existing ancestor resolved). */
async function realPlace(path: string): Promise<string | null> {
  const rest: string[] = [];
  let anc = resolve(path);
  while (!(await lstat(anc).then(() => true, () => false))) {
    const up = dirname(anc);
    if (up === anc) return null;
    rest.unshift(basename(anc));
    anc = up;
  }
  const real = await realpath(anc).catch(() => null);
  return real === null ? null : join(real, ...rest);
}

/** Writes <out>/index.html and <out>/images/ (out: outside the repository, empty or absent; 0700 / 0600, no overwrite). */
export async function writeSuccessCasesViewer(o: { repo: string; root?: string; out: string }): Promise<{ page: string; page_sha256: string; images: number; counts: Record<CaseStatus, number>; with_mismatch: number }> {
  const out = resolve(o.out);
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  const inRepo = (p: string | null) => p === null || within(p, realRepo) || within(p, resolve(o.repo));
  if (inRepo(out) || inRepo(await realPlace(out))) throw new OriginalsStop("ORIGINALS_OUT_IN_REPO");
  const existing = await lstat(out).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(out)).length > 0)) throw new OriginalsStop("ORIGINALS_OUT_NOT_EMPTY");
  const { model, images } = await buildViewerModel({ repo: o.repo, root: o.root });
  await mkdir(join(out, "images"), { recursive: true, mode: 0o700 });
  if (inRepo(await realpath(out).catch(() => null))) throw new OriginalsStop("ORIGINALS_OUT_IN_REPO");
  for (const img of images) await writeNew(join(out, img.name), img.bytes);
  const html = renderViewer(model);
  await writeNew(join(out, "index.html"), html);
  return { page: join(out, "index.html"), page_sha256: sha256(html), images: images.length, counts: model.counts, with_mismatch: model.with_mismatch };
}
