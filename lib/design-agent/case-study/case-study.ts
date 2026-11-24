/**
 * DEV-303 Issue #336 / docs/design/image-first-production-flow.md §1 stage 1, §2 principles 1-2, §3.1, §6.1 row 2: the
 * per-shop success-case analysis record (`sr_case_study_v1`, a private `case-study.json` OUTSIDE the repository, e.g.
 * ~/second-root-shops/<shop_id>/case-study.json) and its check. Before any design work the record must prove that at
 * least 3 success-case originals were actually viewed (each file listed exists and its SHA-256 matches), and — in gate
 * mode — that the owner confirmed the selection and the principles on the viewing page.
 *
 * Counting (a case counts toward the 3 only when all of these hold):
 *   - evidence_kind is "image" or "page_render" ("text_only" never counts);
 *   - every file it lists exists and has the recorded SHA-256 (else the whole record stops);
 *   - its id is in the repository's originals index (design-library/success-cases/originals-index.json) with
 *     counts_as_reference true AND it viewed at least one of that entry's files (same repo-relative path and SHA-256);
 *     SR-001 is in the index with counts_as_reference false and never counts;
 *   - or its id is one of the index's private_original_ids, it is marked private_verified, and every file it lists is an
 *     absolute path OUTSIDE the repository (a restored original in a private place; the SHA-256 proves the bytes Claude
 *     opened, and the owner sees them on the viewing page before confirming).
 *
 * Gate mode (request mode, before design): the counted cases are ≥ 3, owner_confirmation is present (confirmed true) and
 * its selected_ids are exactly the counted ids. Draft mode: the same file checks and counting, no owner confirmation.
 *
 * The viewing page (writeViewingPage): a static local HTML (no script, no network, no external font) in a directory the
 * caller names (never inside the repository), with the viewed image files copied next to it. Every text is escaped.
 *
 * Failures throw CaseStudyStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const CASE_STUDY_SCHEMA = "sr_case_study_v1";
export const ORIGINALS_INDEX_SCHEMA = "sr_success_originals_index_v1";
export const ORIGINALS_INDEX_PATH = "design-library/success-cases/originals-index.json";
/** The record is small text; anything bigger is refused before parsing. */
export const CASE_STUDY_MAX_BYTES = 64 * 1024;
/** One viewed file (an image, a page screenshot, a page's HTML/CSS) is at most this large. */
export const CASE_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** The originals a shop's analysis must have viewed (§1 stage 1). */
export const MIN_COUNTED_ORIGINALS = 3;

export const CASE_STUDY_CODES = [
  "CASE_STUDY_TOO_LARGE",
  "CASE_STUDY_INVALID",
  "CASE_STUDY_TEXT_UNSAFE",
  "CASE_STUDY_DUPLICATE_CASE",
  "CASE_STUDY_INDEX_INVALID",
  "CASE_STUDY_FILE_MISSING",
  "CASE_STUDY_FILE_UNSAFE",
  "CASE_STUDY_FILE_TOO_LARGE",
  "CASE_STUDY_PRIVATE_IN_REPO",
  "CASE_STUDY_SHA_MISMATCH",
  "CASE_STUDY_TOO_FEW_ORIGINALS",
  "CASE_STUDY_NOT_OWNER_CONFIRMED",
  "CASE_STUDY_SELECTION_MISMATCH",
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
    files: z.array(CaseFile).max(8),
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
  private_original_ids: z.array(CASE_ID),
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
  return r.data;
}

/** The repository's originals index (design-library/success-cases/originals-index.json). */
export async function readOriginalsIndex(repo: string): Promise<OriginalsIndex> {
  try {
    const r = OriginalsIndex.safeParse(JSON.parse(await readFile(join(repo, ORIGINALS_INDEX_PATH), "utf8")));
    if (r.success) return r.data;
  } catch {
    // fall through
  }
  throw new CaseStudyStop("CASE_STUDY_INDEX_INVALID");
}

/** A regular file read on one checked handle: no link at the last step, one name, at most CASE_FILE_MAX_BYTES. */
async function readViewedFile(path: string): Promise<Buffer> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new CaseStudyStop((error as { code?: string }).code === "ENOENT" ? "CASE_STUDY_FILE_MISSING" : "CASE_STUDY_FILE_UNSAFE");
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1) throw new CaseStudyStop("CASE_STUDY_FILE_UNSAFE");
    if (st.size > CASE_FILE_MAX_BYTES) throw new CaseStudyStop("CASE_STUDY_FILE_TOO_LARGE");
    const bytes = await h.readFile();
    if (bytes.length > CASE_FILE_MAX_BYTES) throw new CaseStudyStop("CASE_STUDY_FILE_TOO_LARGE");
    return bytes;
  } finally {
    await h.close();
  }
}

/**
 * Where a listed path really is: a repo-relative path inside the repository (its real path exactly that path: no link on
 * the way out), an absolute path outside it (no link anywhere on the path).
 */
async function locate(path: string, repo: string): Promise<string> {
  const realRepo = await realpath(repo).catch(() => resolve(repo));
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

export type NotCountedReason = "text_only" | "not_a_reference" | "index_file_not_viewed" | "private_not_marked" | "private_file_in_repo_form" | "unknown_id";
export type ViewedFile = { case_id: string; path: string; sha256: string; bytes: Buffer };
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
function countReason(c: CaseEntry, index: OriginalsIndex): NotCountedReason | null {
  if (c.evidence_kind === "text_only") return "text_only";
  const entry = index.originals.find((o) => o.id === c.id);
  if (entry) {
    if (!entry.counts_as_reference) return "not_a_reference";
    return c.files.some((f) => entry.files.some((e) => e.path === f.path && e.sha256 === f.sha256)) ? null : "index_file_not_viewed";
  }
  if (!index.private_original_ids.includes(c.id)) return "unknown_id";
  if (c.private_verified !== true) return "private_not_marked";
  return c.files.every((f) => isAbsolute(f.path)) ? null : "private_file_in_repo_form";
}

/**
 * The record checked against the files and the repository's index: schema, every listed file (exists, no link, its
 * SHA-256), and which cases count. Throws CaseStudyStop on any fatal problem; the count itself is judged by
 * assertCaseStudyGate (so a draft can be shown with what is still missing).
 */
export async function inspectCaseStudy(bytes: Buffer, o: { repo: string; index?: OriginalsIndex }): Promise<CaseStudyInspection> {
  const record = parseCaseStudy(bytes);
  const index = o.index ?? (await readOriginalsIndex(o.repo));
  const files: ViewedFile[] = [];
  for (const c of record.cases) {
    for (const f of c.files) {
      const full = await locate(f.path, o.repo);
      const b = await readViewedFile(full);
      if (sha256(b) !== f.sha256) throw new CaseStudyStop("CASE_STUDY_SHA_MISMATCH");
      files.push({ case_id: c.id, path: f.path, sha256: f.sha256, bytes: b });
    }
  }
  const counted: string[] = [];
  const notCounted: CaseStudyInspection["not_counted"] = [];
  for (const c of record.cases) {
    const reason = countReason(c, index);
    if (reason === null) counted.push(c.id);
    else notCounted.push({ id: c.id, reason });
  }
  return { shop_id: record.shop_id, case_study_sha256: sha256(bytes), counted, not_counted: notCounted, owner_confirmed: record.owner_confirmation?.confirmed === true, record, files };
}

/**
 * The gate: at least MIN_COUNTED_ORIGINALS counted cases; in "gate" mode also the owner's confirmation, whose
 * selected_ids are exactly the counted ids (the owner confirmed what is counted, nothing more or less).
 */
export function assertCaseStudyGate(i: CaseStudyInspection, mode: "draft" | "gate"): void {
  if (i.counted.length < MIN_COUNTED_ORIGINALS) throw new CaseStudyStop("CASE_STUDY_TOO_FEW_ORIGINALS");
  if (mode === "draft") return;
  const oc = i.record.owner_confirmation;
  if (!oc || oc.confirmed !== true) throw new CaseStudyStop("CASE_STUDY_NOT_OWNER_CONFIRMED");
  const selected = new Set(oc.selected_ids);
  if (selected.size !== oc.selected_ids.length || selected.size !== i.counted.length || !i.counted.every((id) => selected.has(id))) throw new CaseStudyStop("CASE_STUDY_SELECTION_MISMATCH");
}

/** inspectCaseStudy + assertCaseStudyGate. */
export async function checkCaseStudy(bytes: Buffer, o: { repo: string; mode: "draft" | "gate"; index?: OriginalsIndex }): Promise<CaseStudyInspection> {
  const i = await inspectCaseStudy(bytes, o);
  assertCaseStudyGate(i, o.mode);
  return i;
}

// ---- the owner's viewing page --------------------------------------------------------------------------------------

const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const EVIDENCE_LABEL: Record<CaseEntry["evidence_kind"], string> = { image: "画像で確認", page_render: "頁を描画して確認", text_only: "文章だけ（参照に数えない）" };
const REASON_LABEL: Record<NotCountedReason, string> = {
  text_only: "文章だけの記録",
  not_a_reference: "他店の参照に数えない（台帳の方針）",
  index_file_not_viewed: "索引の原本ファイルを見た記録が無い",
  private_not_marked: "非公開の原本として確認済みの印が無い",
  private_file_in_repo_form: "非公開の原本の場所がリポジトリの外の絶対パスでない",
  unknown_id: "索引に無い id",
};

/** The page's HTML (pure): every text escaped, images by the given relative names, no script, no external reference. */
export function renderViewingPage(i: CaseStudyInspection, imageNames: Map<ViewedFile, string>): string {
  const e = escapeHtml;
  const list = (items: string[]) => `<ul>${items.map((t) => `<li>${e(t)}</li>`).join("")}</ul>`;
  const oc = i.record.owner_confirmation;
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
          return name ? `<figure><img src="${e(name)}" alt="${e(`${c.id} の原本`)}" loading="lazy">${caption}</figure>` : `<figure class="nofile"><p>画像ではないファイル（頁の HTML/CSS など）。原本の場所で開いて確認する。</p>${caption}</figure>`;
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
  const confirmation = oc
    ? `<p class="ok">オーナーの確認: ${e(oc.confirmed_at)}（選定: ${e(oc.selected_ids.join("、"))}）${oc.note ? ` — ${e(oc.note)}` : ""}</p>`
    : `<p class="no">オーナーの確認: まだ（このページで原本の選定と原理を確認し、記録の owner_confirmation に残す）</p>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
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
<p>参照に数える原本: ${i.counted.length} 件（${MIN_COUNTED_ORIGINALS} 件以上が必要）${enough ? "" : " — <strong class=\"no\">足りない</strong>"}。記録の SHA-256: <code>${e(i.case_study_sha256)}</code></p>
${confirmation}
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

/** A file name for a copied image: <case>-<n><ext>, nothing from the original name but its (allowed) extension. */
const imageNameOf = (f: ViewedFile, n: number) => `images/${f.case_id}-${n}${extname(f.path).toLowerCase()}`;

/**
 * Writes the viewing page: <outDir>/index.html and <outDir>/images/ (the viewed image files' verified bytes). The
 * directory must be outside the repository and empty or absent (created 0700; files 0600, never overwritten).
 */
export async function writeViewingPage(i: CaseStudyInspection, o: { outDir: string; repo: string }): Promise<{ page: string; images: string[] }> {
  const out = resolve(o.outDir);
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  const existing = await lstat(out).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new CaseStudyStop("CASE_STUDY_PAGE_DIR_NOT_EMPTY");
    if ((await readdir(out)).length > 0) throw new CaseStudyStop("CASE_STUDY_PAGE_DIR_NOT_EMPTY");
  }
  const realParent = await realpath(resolve(out, "..")).catch(() => null);
  if (within(out, resolve(o.repo)) || within(out, realRepo) || (realParent !== null && within(join(realParent, basename(out)), realRepo))) throw new CaseStudyStop("CASE_STUDY_PAGE_IN_REPO");
  await mkdir(join(out, "images"), { recursive: true, mode: 0o700 });
  const names = new Map<ViewedFile, string>();
  const counters = new Map<string, number>();
  for (const f of i.files) {
    if (!IMAGE_TYPES.has(extname(f.path).toLowerCase())) continue;
    const n = (counters.get(f.case_id) ?? 0) + 1;
    counters.set(f.case_id, n);
    names.set(f, imageNameOf(f, n));
  }
  const write = async (rel: string, bytes: Buffer | string) => {
    const h = await open(join(out, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(bytes);
    } finally {
      await h.close();
    }
  };
  for (const [f, name] of names) await write(name, f.bytes);
  await write("index.html", renderViewingPage(i, names));
  return { page: join(out, "index.html"), images: [...names.values()].map((n) => join(out, n)) };
}
