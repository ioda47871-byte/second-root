/**
 * DEV-303 Issue #336 / docs/design/image-first-production-flow.md §1 stage 1, §2 principles 1-2, §3.1, §6.1 row 2: the
 * per-shop success-case analysis record (`sr_case_study_v1`, a private `case-study.json` OUTSIDE the repository, e.g.
 * ~/second-root-shops/<shop_id>/case-study.json) and its check. Before any design work the record must prove that at
 * least 3 success-case originals were actually viewed (each file listed exists and its SHA-256 matches), and — in gate
 * mode — that the owner confirmed the selection and the principles on the viewing page.
 *
 * Every listed file (fatal, the whole record stops):
 *   - exists with its SHA-256, no link; a repo-relative path lies under design-library/; an absolute path lies outside
 *     the repository and is never a copy of an indexed repository original (same SHA-256);
 *   - no SHA-256 appears twice in the record (one file cannot stand for two cases);
 *   - evidence "image": image files (png / jpeg / webp / gif, extension AND magic bytes) or a cited source archive (.zip,
 *     magic bytes); "page_render": the same plus .html / .htm / .css / .json; "text_only": anything (it never counts).
 *
 * Counting (a case counts toward the 3 only when all of these hold):
 *   - evidence_kind is "image" or "page_render"; SR-001 never counts (hard rule, also its ledger policy);
 *   - an id in the originals index (design-library/success-cases/originals-index.json) counts when counts_as_reference is
 *     true and it viewed at least one of that entry's own files (same repo-relative path and SHA-256);
 *   - an id in the index's unavailable_ids (category C) never counts;
 *   - a category B id (private_original_ids) counts only when the case is marked private_verified, every file is an
 *     absolute path outside the repository, at least one file's SHA-256 is one RECORDED for that id (manifest.json's
 *     sha256 fields, rejected / not-preferred revisions excluded, or the index's expected_sha256), and a cited archive's
 *     SHA-256 is recorded for that id and comes with the viewed images listed next to it.
 *
 * Gate mode (request mode, before design): ≥ 3 counted cases and owner_confirmation (confirmed true) whose selected_ids
 * are exactly the counted ids and whose page_sha256 is the SHA-256 of the viewing page this record renders to (the page
 * the owner looked at: viewingPageHtml, deterministic, independent of owner_confirmation). Claude writes
 * owner_confirmation after the owner says so; page_sha256 binds that statement to exactly what the owner saw.
 *
 * The viewing page (writeViewingPage): a static local HTML (no script, no network, no external font; a CSP that allows
 * only its own images and inline style) in a directory the caller names (never inside the repository, links resolved),
 * with the viewed image files copied next to it. Every text is escaped.
 *
 * Failures throw CaseStudyStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const CASE_STUDY_SCHEMA = "sr_case_study_v1";
export const ORIGINALS_INDEX_SCHEMA = "sr_success_originals_index_v1";
export const ORIGINALS_INDEX_PATH = "design-library/success-cases/originals-index.json";
export const SUCCESS_MANIFEST_PATH = "design-library/success-cases/manifest.json";
/** Repo-relative viewed files live only here (the success cases and the research pages). */
export const REPO_FILES_ROOT = "design-library/";
/** The Second Root page that is viewable but never a reference for other shops. */
export const NEVER_COUNTED_IDS: readonly string[] = ["SR-001"];
/** The record is small text; anything bigger is refused before parsing. */
export const CASE_STUDY_MAX_BYTES = 64 * 1024;
/** One viewed file (an image, a page screenshot, a page's HTML/CSS) is at most this large. */
export const CASE_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** A cited source archive (.zip; hashed as a stream, never kept in memory) is at most this large. */
export const CASE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
/** The originals a shop's analysis must have viewed (§1 stage 1). */
export const MIN_COUNTED_ORIGINALS = 3;

export const CASE_STUDY_CODES = [
  "CASE_STUDY_TOO_LARGE",
  "CASE_STUDY_INVALID",
  "CASE_STUDY_TEXT_UNSAFE",
  "CASE_STUDY_DUPLICATE_CASE",
  "CASE_STUDY_DUPLICATE_FILE",
  "CASE_STUDY_INDEX_INVALID",
  "CASE_STUDY_FILE_MISSING",
  "CASE_STUDY_FILE_UNSAFE",
  "CASE_STUDY_FILE_OUTSIDE_LIBRARY",
  "CASE_STUDY_FILE_TOO_LARGE",
  "CASE_STUDY_EVIDENCE_FILE_INVALID",
  "CASE_STUDY_PRIVATE_IN_REPO",
  "CASE_STUDY_PRIVATE_IS_REPO_ORIGINAL",
  "CASE_STUDY_SHA_MISMATCH",
  "CASE_STUDY_TOO_FEW_ORIGINALS",
  "CASE_STUDY_NOT_OWNER_CONFIRMED",
  "CASE_STUDY_SELECTION_MISMATCH",
  "CASE_STUDY_PAGE_MISMATCH",
  "CASE_STUDY_PAGE_IN_REPO",
  "CASE_STUDY_PAGE_DIR_NOT_EMPTY",
] as const;
export type CaseStudyCode = (typeof CASE_STUDY_CODES)[number];
/** A refusal with a fixed CASE_STUDY_* code (request mode rethrows it as its PromptStop with the same code). */
export class CaseStudyStop extends Error {
  constructor(readonly code: CaseStudyCode) {
    super(code);
    this.name = "CaseStudyStop";
  }
}

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const CASE_ID = z.string().regex(/^(?:CP|SR)-\d{3}$/);
/** The shop slug (request-prompt.ts REQUEST_SHOP_ID_RE). */
const SHOP_ID = z.string().regex(/^[a-z0-9_-]{2,41}$/);
/** Exactly YYYY-MM-DDTHH:MM:SSZ (the request's rule). */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Plain text: one line, no control character, no markup (no < > or backtick), no link. The page escapes every text
 * anyway; this keeps HTML and URLs out of the record itself.
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u2028\u2029]|[<>`]|https?:|ftp:|:\/\/|www\./i;
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0 && s === s.trim() && !UNSAFE_TEXT.test(s), "case_study_text_unsafe");

/**
 * A viewed file: a repo-relative POSIX path (letters, digits, . _ - /; no "..", no leading /) or an absolute path to a
 * private place outside the repository (no control character, quote, < > or backtick, no ".." segment).
 */
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,400}$/;
const ABS_PATH = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))[^\u0000-\u001f\u007f<>"'`\\]{1,500}$/;
const FilePath = z.string().refine((p) => REPO_PATH.test(p) || ABS_PATH.test(p), "case_study_path_invalid");

export const CaseFile = z.strictObject({ path: FilePath, sha256: SHA });
export const CaseObservations = z.strictObject({
  composition: Text(600),
  information_design: Text(600),
  shop_character: Text(600),
  pc_sp: Text(600),
});

export const CaseEntry = z
  .strictObject({
    id: CASE_ID,
    evidence_kind: z.enum(["image", "page_render", "text_only"]),
    private_verified: z.literal(true).optional(),
    files: z.array(CaseFile).max(12),
    observations: CaseObservations,
    principles_to_bring: z.array(Text(300)).min(1).max(8),
    do_not_copy: z.array(Text(300)).min(1).max(8),
  })
  // a case seen as an image or a rendered page names what was seen
  .refine((c) => c.evidence_kind === "text_only" || c.files.length > 0, "case_study_files_required");
export type CaseEntry = z.infer<typeof CaseEntry>;

export const OwnerConfirmation = z.strictObject({
  confirmed: z.literal(true),
  confirmed_at: z.string().regex(UTC).refine((s) => Number.isFinite(Date.parse(s)), "confirmed_at_invalid"),
  selected_ids: z.array(CASE_ID).min(1).max(12),
  /** The SHA-256 of the viewing page's index.html the owner looked at (writeViewingPage prints it). */
  page_sha256: SHA,
  note: Text(400).optional(),
});

export const CaseStudy = z.strictObject({
  schema: z.literal(CASE_STUDY_SCHEMA),
  shop_id: SHOP_ID,
  cases: z.array(CaseEntry).min(1).max(12),
  shop_specific_principles: z.array(Text(400)).min(1).max(10),
  owner_confirmation: OwnerConfirmation.optional(),
});
export type CaseStudy = z.infer<typeof CaseStudy>;

export const OriginalsIndex = z.object({
  schema: z.literal(ORIGINALS_INDEX_SCHEMA),
  originals: z
    .array(
      z.object({
        id: CASE_ID,
        kind: z.enum(["image", "page_render"]),
        files: z.array(z.object({ path: z.string().regex(REPO_PATH), sha256: SHA })).min(1),
        counts_as_reference: z.boolean(),
      }),
    )
    .min(1),
  /** Category B: originals outside the repository, countable as private_verified against a recorded SHA-256. */
  private_original_ids: z.array(CASE_ID),
  /** Recorded SHA-256s (adoption records) for B ids that manifest.json does not hold. */
  expected_sha256: z.record(CASE_ID, z.array(SHA).min(1)),
  /** Category C: no verifiable original; never counted. */
  unavailable_ids: z.array(CASE_ID),
});
export type OriginalsIndex = z.infer<typeof OriginalsIndex>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The record's bytes: within the cap, strict JSON of the shape above. */
export function parseCaseStudy(bytes: Buffer): CaseStudy {
  if (bytes.length > CASE_STUDY_MAX_BYTES) throw new CaseStudyStop("CASE_STUDY_TOO_LARGE");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CaseStudyStop("CASE_STUDY_INVALID");
  }
  const r = CaseStudy.safeParse(json);
  if (!r.success) throw new CaseStudyStop(r.error.issues.some((i) => i.message === "case_study_text_unsafe") ? "CASE_STUDY_TEXT_UNSAFE" : "CASE_STUDY_INVALID");
  if (new Set(r.data.cases.map((c) => c.id)).size !== r.data.cases.length) throw new CaseStudyStop("CASE_STUDY_DUPLICATE_CASE");
  const shas = r.data.cases.flatMap((c) => c.files.map((f) => f.sha256));
  if (new Set(shas).size !== shas.length) throw new CaseStudyStop("CASE_STUDY_DUPLICATE_FILE");
  return r.data;
}

/** manifest.json's field names that record a version that was NOT adopted (never evidence of the original). */
const NOT_ADOPTED_KEY = /rejected|not_preferred/;

/**
 * The repository's originals index plus, per category B id, the SHA-256s recorded for it: manifest.json's 64-hex fields
 * (rejected / not-preferred revisions excluded) and the index's expected_sha256.
 */
export async function readOriginalsIndex(repo: string): Promise<{ index: OriginalsIndex; recorded: Map<string, Set<string>> }> {
  try {
    const index = OriginalsIndex.parse(JSON.parse(await readFile(join(repo, ORIGINALS_INDEX_PATH), "utf8")));
    const manifest = JSON.parse(await readFile(join(repo, SUCCESS_MANIFEST_PATH), "utf8")) as { records?: Record<string, unknown>[] };
    const recorded = new Map<string, Set<string>>();
    for (const id of index.private_original_ids) {
      const set = new Set(index.expected_sha256[id] ?? []);
      for (const [k, v] of Object.entries(manifest.records?.find((r) => r.id === id) ?? {})) if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) && !NOT_ADOPTED_KEY.test(k)) set.add(v);
      recorded.set(id, set);
    }
    return { index, recorded };
  } catch {
    throw new CaseStudyStop("CASE_STUDY_INDEX_INVALID");
  }
}

const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  ".png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".jpg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  ".gif": (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")),
};
const isImagePath = (p: string) => Object.hasOwn(IMAGE_MAGIC, extname(p).toLowerCase());
const isArchivePath = (p: string) => extname(p).toLowerCase() === ".zip";
const PAGE_TYPES = new Set([".html", ".htm", ".css", ".json"]);
const ZIP_MAGIC = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06));

/** The file type the evidence kind allows, its magic bytes checked (text_only: anything). */
function evidenceFileOk(kind: CaseEntry["evidence_kind"], path: string, head: Buffer): boolean {
  if (kind === "text_only") return true;
  const ext = extname(path).toLowerCase();
  if (isImagePath(path)) return IMAGE_MAGIC[ext]!(head);
  if (isArchivePath(path)) return ZIP_MAGIC(head);
  return kind === "page_render" && PAGE_TYPES.has(ext);
}

/**
 * A regular file read on one checked handle (no link at the last step, one name): its SHA-256, its first bytes and, for a
 * non-archive within CASE_FILE_MAX_BYTES, its bytes (an archive is hashed as a stream and not kept).
 */
async function readViewedFile(path: string): Promise<{ sha256: string; head: Buffer; bytes: Buffer | null }> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new CaseStudyStop((error as { code?: string }).code === "ENOENT" ? "CASE_STUDY_FILE_MISSING" : "CASE_STUDY_FILE_UNSAFE");
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1) throw new CaseStudyStop("CASE_STUDY_FILE_UNSAFE");
    const archive = isArchivePath(path);
    if (st.size > (archive ? CASE_ARCHIVE_MAX_BYTES : CASE_FILE_MAX_BYTES)) throw new CaseStudyStop("CASE_STUDY_FILE_TOO_LARGE");
    if (!archive) {
      const bytes = await h.readFile();
      if (bytes.length > CASE_FILE_MAX_BYTES) throw new CaseStudyStop("CASE_STUDY_FILE_TOO_LARGE");
      return { sha256: sha256(bytes), head: bytes.subarray(0, 16), bytes };
    }
    const hash = createHash("sha256");
    let head: Buffer | null = null;
    let total = 0;
    for await (const chunk of h.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) {
      head ??= Buffer.from(chunk.subarray(0, 16));
      total += chunk.length;
      if (total > CASE_ARCHIVE_MAX_BYTES) throw new CaseStudyStop("CASE_STUDY_FILE_TOO_LARGE");
      hash.update(chunk);
    }
    return { sha256: hash.digest("hex"), head: head ?? Buffer.alloc(0), bytes: null };
  } finally {
    await h.close();
  }
}

/**
 * Where a listed path really is: a repo-relative path under design-library/ inside the repository (its real path exactly
 * that path: no link on the way out), an absolute path outside it (no link anywhere on the path).
 */
async function locate(path: string, repo: string): Promise<string> {
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (!isAbsolute(path) && !path.startsWith(REPO_FILES_ROOT)) throw new CaseStudyStop("CASE_STUDY_FILE_OUTSIDE_LIBRARY");
  const full = isAbsolute(path) ? resolve(path) : resolve(realRepo, path);
  if (isAbsolute(path) && (within(full, realRepo) || within(full, resolve(repo)))) throw new CaseStudyStop("CASE_STUDY_PRIVATE_IN_REPO");
  const real = await realpath(full).catch(() => null);
  if (real === null) {
    if (!(await lstat(full).then(() => true, () => false))) throw new CaseStudyStop("CASE_STUDY_FILE_MISSING");
    throw new CaseStudyStop("CASE_STUDY_FILE_UNSAFE");
  }
  if (real !== full) throw new CaseStudyStop(isAbsolute(path) && within(real, realRepo) ? "CASE_STUDY_PRIVATE_IN_REPO" : "CASE_STUDY_FILE_UNSAFE");
  if (!isAbsolute(path) && !within(real, realRepo)) throw new CaseStudyStop("CASE_STUDY_FILE_UNSAFE");
  return full;
}

export type NotCountedReason =
  | "text_only"
  | "not_a_reference"
  | "index_file_not_viewed"
  | "original_unavailable"
  | "private_not_marked"
  | "private_file_in_repo_form"
  | "private_sha_unrecorded"
  | "archive_sha_unrecorded"
  | "archive_without_images"
  | "unknown_id";
/** A verified file; `bytes` is null for a cited archive (hashed, never copied). */
export type ViewedFile = { case_id: string; path: string; sha256: string; bytes: Buffer | null };
export type CaseStudyInspection = {
  shop_id: string;
  case_study_sha256: string;
  counted: string[];
  not_counted: { id: string; reason: NotCountedReason }[];
  owner_confirmed: boolean;
  record: CaseStudy;
  files: ViewedFile[];
};

/** Why a case does not count, or null when it counts (its files already verified). */
function countReason(c: CaseEntry, index: OriginalsIndex, recorded: Map<string, Set<string>>): NotCountedReason | null {
  if (c.evidence_kind === "text_only") return "text_only";
  if (NEVER_COUNTED_IDS.includes(c.id)) return "not_a_reference";
  const entry = index.originals.find((o) => o.id === c.id);
  if (entry) {
    if (!entry.counts_as_reference) return "not_a_reference";
    return c.files.some((f) => entry.files.some((e) => e.path === f.path && e.sha256 === f.sha256)) ? null : "index_file_not_viewed";
  }
  if (index.unavailable_ids.includes(c.id)) return "original_unavailable";
  if (!index.private_original_ids.includes(c.id)) return "unknown_id";
  if (c.private_verified !== true) return "private_not_marked";
  if (!c.files.every((f) => isAbsolute(f.path))) return "private_file_in_repo_form";
  const known = recorded.get(c.id) ?? new Set<string>();
  const archives = c.files.filter((f) => isArchivePath(f.path));
  if (archives.some((f) => !known.has(f.sha256))) return "archive_sha_unrecorded";
  if (archives.length > 0 && !c.files.some((f) => isImagePath(f.path))) return "archive_without_images";
  return c.files.some((f) => known.has(f.sha256)) ? null : "private_sha_unrecorded";
}

/**
 * The record checked against the files and the repository's index: schema, every listed file (exists, no link, its
 * SHA-256, its type for the evidence kind), and which cases count. Throws CaseStudyStop on any fatal problem; the count
 * itself is judged by assertCaseStudyGate (so a draft can be shown with what is still missing).
 */
export async function inspectCaseStudy(bytes: Buffer, o: { repo: string }): Promise<CaseStudyInspection> {
  const record = parseCaseStudy(bytes);
  const { index, recorded } = await readOriginalsIndex(o.repo);
  const repoOriginals = new Set(index.originals.flatMap((x) => x.files.map((f) => f.sha256)));
  const files: ViewedFile[] = [];
  for (const c of record.cases) {
    for (const f of c.files) {
      const full = await locate(f.path, o.repo);
      const got = await readViewedFile(full);
      if (got.sha256 !== f.sha256) throw new CaseStudyStop("CASE_STUDY_SHA_MISMATCH");
      if (!evidenceFileOk(c.evidence_kind, f.path, got.head)) throw new CaseStudyStop("CASE_STUDY_EVIDENCE_FILE_INVALID");
      // a "private original" that is a copy of a repository original proves nothing new
      if (isAbsolute(f.path) && repoOriginals.has(f.sha256)) throw new CaseStudyStop("CASE_STUDY_PRIVATE_IS_REPO_ORIGINAL");
      files.push({ case_id: c.id, path: f.path, sha256: f.sha256, bytes: got.bytes });
    }
  }
  const counted: string[] = [];
  const notCounted: CaseStudyInspection["not_counted"] = [];
  for (const c of record.cases) {
    const reason = countReason(c, index, recorded);
    if (reason === null) counted.push(c.id);
    else notCounted.push({ id: c.id, reason });
  }
  return { shop_id: record.shop_id, case_study_sha256: sha256(bytes), counted, not_counted: notCounted, owner_confirmed: record.owner_confirmation?.confirmed === true, record, files };
}

/**
 * The gate: at least MIN_COUNTED_ORIGINALS counted cases; in "gate" mode also the owner's confirmation, whose
 * selected_ids are exactly the counted ids and whose page_sha256 is the page this record renders to.
 */
export function assertCaseStudyGate(i: CaseStudyInspection, mode: "draft" | "gate"): void {
  if (i.counted.length < MIN_COUNTED_ORIGINALS) throw new CaseStudyStop("CASE_STUDY_TOO_FEW_ORIGINALS");
  if (mode === "draft") return;
  const oc = i.record.owner_confirmation;
  if (!oc || oc.confirmed !== true) throw new CaseStudyStop("CASE_STUDY_NOT_OWNER_CONFIRMED");
  const selected = new Set(oc.selected_ids);
  if (selected.size !== oc.selected_ids.length || selected.size !== i.counted.length || !i.counted.every((id) => selected.has(id))) throw new CaseStudyStop("CASE_STUDY_SELECTION_MISMATCH");
  if (oc.page_sha256 !== viewingPageSha256(i)) throw new CaseStudyStop("CASE_STUDY_PAGE_MISMATCH");
}

/** inspectCaseStudy + assertCaseStudyGate. */
export async function checkCaseStudy(bytes: Buffer, o: { repo: string; mode: "draft" | "gate" }): Promise<CaseStudyInspection> {
  const i = await inspectCaseStudy(bytes, o);
  assertCaseStudyGate(i, o.mode);
  return i;
}

// ---- the owner's viewing page --------------------------------------------------------------------------------------

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const EVIDENCE_LABEL: Record<CaseEntry["evidence_kind"], string> = { image: "画像で確認", page_render: "頁を描画して確認", text_only: "文章だけ（参照に数えない）" };
const REASON_LABEL: Record<NotCountedReason, string> = {
  text_only: "文章だけの記録",
  not_a_reference: "他店の参照に数えない（台帳の方針）",
  index_file_not_viewed: "索引の原本ファイルを見た記録が無い",
  original_unavailable: "原本の所在が不明（区分 C）",
  private_not_marked: "非公開の原本として確認済みの印が無い",
  private_file_in_repo_form: "非公開の原本の場所がリポジトリの外の絶対パスでない",
  private_sha_unrecorded: "見たファイルの SHA-256 が、その成功例の記録の値と一致しない",
  archive_sha_unrecorded: "原本の ZIP の SHA-256 が記録の値と一致しない",
  archive_without_images: "ZIP だけで、中の見た画像が記録に無い",
  unknown_id: "索引に無い id",
};
/** Only the page's own images and its inline style; nothing else loads (no script, no network, no font). */
export const VIEWING_PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

/** The copied image names: images/<case>-<n><ext> in record order (nothing from the original name but its extension). */
export function viewingPageImageNames(i: CaseStudyInspection): Map<ViewedFile, string> {
  const names = new Map<ViewedFile, string>();
  const counters = new Map<string, number>();
  for (const f of i.files) {
    if (!isImagePath(f.path) || f.bytes === null) continue;
    const n = (counters.get(f.case_id) ?? 0) + 1;
    counters.set(f.case_id, n);
    names.set(f, `images/${f.case_id}-${n}${extname(f.path).toLowerCase()}`);
  }
  return names;
}

/**
 * The page's HTML (pure): every text escaped, images by the given relative names, no script, no external reference.
 * It never shows owner_confirmation, so the page the owner viewed and the page rebuilt after the confirmation is recorded
 * are byte-identical (viewingPageSha256).
 */
export function renderViewingPage(i: CaseStudyInspection, imageNames: Map<ViewedFile, string>): string {
  const e = escapeHtml;
  const list = (items: string[]) => `<ul>${items.map((t) => `<li>${e(t)}</li>`).join("")}</ul>`;
  const enough = i.counted.length >= MIN_COUNTED_ORIGINALS;
  const cases = i.record.cases
    .map((c) => {
      const counted = i.counted.includes(c.id);
      const reason = i.not_counted.find((n) => n.id === c.id)?.reason;
      const viewed = i.files.filter((f) => f.case_id === c.id);
      const figures = viewed
        .map((f) => {
          const name = imageNames.get(f);
          const caption = `<figcaption>${e(f.path)}<br><code>${e(f.sha256)}</code></figcaption>`;
          if (name) return `<figure><img src="${e(name)}" alt="${e(`${c.id} の原本`)}" loading="lazy">${caption}</figure>`;
          const what = isArchivePath(f.path) ? "原本の ZIP（SHA-256 を照合済み。中の画像は別に並べる）" : "画像ではないファイル（頁の HTML/CSS など）。原本の場所で開いて確認する。";
          return `<figure class="nofile"><p>${e(what)}</p>${caption}</figure>`;
        })
        .join("");
      return `<section class="case">
<h2>${e(c.id)} <span class="kind">${e(EVIDENCE_LABEL[c.evidence_kind])}</span> <span class="${counted ? "ok" : "no"}">${counted ? "参照に数える" : reason ? `数えない: ${e(REASON_LABEL[reason])}` : "数えない"}</span></h2>
<div class="figs">${figures || "<p>見たファイルの記録なし</p>"}</div>
<div class="cols">
<div><h3>持ち込む原理</h3>${list(c.principles_to_bring)}</div>
<div><h3>写さないこと</h3>${list(c.do_not_copy)}</div>
</div>
<details><summary>観察</summary><dl>
<dt>構図</dt><dd>${e(c.observations.composition)}</dd>
<dt>情報設計</dt><dd>${e(c.observations.information_design)}</dd>
<dt>店らしさ</dt><dd>${e(c.observations.shop_character)}</dd>
<dt>PC/SP</dt><dd>${e(c.observations.pc_sp)}</dd>
</dl></details>
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEWING_PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${e(i.shop_id)} 成功例の確認</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1b; --bg: #fbfaf7; --muted: #6a6862; --line: #d9d6cf; --ok: #1f6b3a; --no: #9a3412; }
@media (prefers-color-scheme: dark) { :root { --fg: #ecebe7; --bg: #171716; --muted: #a3a19b; --line: #3a3936; --ok: #6fcf97; --no: #f4a261; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; line-height: 1.7; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 8px; }
h2 { font-size: 1.15rem; border-top: 1px solid var(--line); padding-top: 24px; }
h3 { font-size: 0.95rem; margin: 8px 0 4px; }
.kind { font-weight: normal; color: var(--muted); font-size: 0.9rem; margin-left: 8px; }
.ok { color: var(--ok); } .no { color: var(--no); }
h2 .ok, h2 .no { font-size: 0.85rem; font-weight: normal; margin-left: 8px; }
.figs { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 0; flex: 1 1 320px; max-width: 100%; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
figcaption { font-size: 0.8rem; color: var(--muted); word-break: break-all; }
.nofile { border: 1px dashed var(--line); padding: 12px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
dt { font-weight: bold; } dd { margin: 0 0 8px; }
code { font-size: 0.75rem; }
</style>
</head>
<body>
<main>
<h1>${e(i.shop_id)} — 成功例の原本と採用する原理（非公開・ローカル）</h1>
<p>参照に数える原本: ${i.counted.length} 件（${MIN_COUNTED_ORIGINALS} 件以上が必要）${enough ? "" : " — <strong class=\"no\">足りない</strong>"}。</p>
<p>オーナーが原本の選定と原理を確認したら、Claude がその旨を記録の owner_confirmation に書く（selected_ids と、このページの index.html の SHA-256 を page_sha256 に）。このページの内容が変われば、確認はやり直しになる。</p>
<section>
<h2>この店固有のデザインの原理</h2>
${list(i.record.shop_specific_principles)}
</section>
${cases}
</main>
</body>
</html>
`;
}

/** The page's HTML exactly as writeViewingPage writes it. */
export const viewingPageHtml = (i: CaseStudyInspection) => renderViewingPage(i, viewingPageImageNames(i));
/** The SHA-256 of that index.html (what owner_confirmation.page_sha256 must equal). */
export const viewingPageSha256 = (i: CaseStudyInspection) => sha256(viewingPageHtml(i));

/**
 * The real place a path would have: its nearest existing ancestor's real path joined with the rest (a link anywhere
 * above is resolved, so a linked ancestor cannot lead into the repository).
 */
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

/**
 * Writes the viewing page: <outDir>/index.html and <outDir>/images/ (the viewed image files' verified bytes). The
 * directory must be outside the repository (links resolved before and after it is made) and empty or absent (created
 * 0700; files 0600, never overwritten).
 */
export async function writeViewingPage(i: CaseStudyInspection, o: { outDir: string; repo: string }): Promise<{ page: string; page_sha256: string; images: string[] }> {
  const out = resolve(o.outDir);
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  const inRepo = (p: string | null) => p === null || within(p, realRepo) || within(p, resolve(o.repo));
  if (inRepo(out) || inRepo(await realPlace(out))) throw new CaseStudyStop("CASE_STUDY_PAGE_IN_REPO");
  const existing = await lstat(out).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new CaseStudyStop("CASE_STUDY_PAGE_DIR_NOT_EMPTY");
    if ((await readdir(out)).length > 0) throw new CaseStudyStop("CASE_STUDY_PAGE_DIR_NOT_EMPTY");
  }
  await mkdir(join(out, "images"), { recursive: true, mode: 0o700 });
  // checked again once it exists: nothing may have moved it into the repository in between
  if (inRepo(await realpath(out).catch(() => null))) throw new CaseStudyStop("CASE_STUDY_PAGE_IN_REPO");
  const names = viewingPageImageNames(i);
  const write = async (rel: string, bytes: Buffer | string) => {
    const h = await open(join(out, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(bytes);
    } finally {
      await h.close();
    }
  };
  for (const [f, name] of names) await write(name, f.bytes!);
  const html = renderViewingPage(i, names);
  await write("index.html", html);
  return { page: join(out, "index.html"), page_sha256: sha256(html), images: [...names.values()].map((n) => join(out, n)) };
}
