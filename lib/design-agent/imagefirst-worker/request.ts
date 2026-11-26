/**
 * DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 B): the files of an IMAGE_FIRST
 * request run, outside git. Read only, apart from the real shop's private run record (writeRealShopRecord).
 *
 *   the request:     the copy root validated and placed in the run's private directory (`--request-file`), named
 *                    <id>.json, a regular file (no link), at most 16 KiB, outside the repository; its bytes' SHA-256 must
 *                    equal `--request-sha256` and its id `--request` (image-first/request-prompt.ts parseRequest).
 *   the facts pack:  facts_ref.root "second-root-shops" → ~/second-root-shops/<shop_id>/facts-pack.json (the only root a
 *                    real_shop request may name; the schema refuses another), or (fictional only)
 *                    "local-shops" → <clone>/.local-shops/<shop_id>/facts-pack.json (gitignored); no link at the root,
 *                    the shop directory or the file, its real path exactly that path, at most FACTS_MAX_BYTES, its
 *                    SHA-256 = the request's facts_sha256. Owner-verified values only (Identity Lock).
 *   the shop:        real_shop — the pack's shop_id is the request's, and it is not a fictional shop (no "fictional-"
 *                    prefix, not a research-log FICTIONAL_SHOPS slug); fictional — the research log's fictional-shop
 *                    check (assertFictionalShop) and the pack is that shop's own (the same fictional shop_id as the
 *                    committed pack).
 *   the case study:  Issue #336 (docs/design/image-first-production-flow.md §1 stage 1, §6.1 row 2): a design request's
 *                    case_study.path in the same shop directory as its facts pack (no link, at most
 *                    CASE_STUDY_MAX_BYTES, SHA-256 = case_study.sha256, the same shop_id), checked in gate mode
 *                    (case-study/case-study.ts: every viewed file and SHA-256, ≥ 3 counted originals, the owner's
 *                    confirmation). Required for real_shop (parseRequest refuses CASE_STUDY_REQUIRED); checked when
 *                    present on a fictional request. A section-split plan never reads it. DEV-303 §6.1 row 3: a
 *                    whole_page plan takes its principles (shop_specific_principles, each counted case's
 *                    principles_to_bring / do_not_copy) into the prompt, and the counted cases' original pictures
 *                    (selectReferenceImages, at most 5) are attached to the one Codex run; never the record's paths,
 *                    observations or bytes in any record (ids and SHA-256 only).
 *   the record:      real_shop only, ~/second-root-shops/<shop_id>/runs/<id>.json (metadata: ids, codes, SHA-256s;
 *                    0700 / 0600, written once). A real shop never enters design-library/research-log (public repo).
 *
 * Failures throw PromptStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { CASE_STUDY_MAX_BYTES, CaseStudyStop, checkCaseStudy, type CaseStudyInspection, type ViewedFile } from "../case-study/case-study";
import { PromptStop } from "../image-first/prompt";
import { buildDetailCompPlan, buildPhotoPlan, buildRequestPlan, CASE_STUDY_TEXT_CATEGORIES, type DetailPlan, isDetailCompBytes, parseDetailCompRequest, type RequestEnvelope, CASE_STUDY_TEXT_FIELDS, CaseStudyTextStop, FACTS_MAX_BYTES, type CaseStudyTextField, isPhotoRequest, layoutOf, materialsBytes, parseRequest, parseRequestFacts, PHOTO_FILE_RE, type ApprovedDesignUse, type DesignReference, type PhotoMaterialsRequest, REQUEST_MAX_BYTES, requestDirectionBytes, type DesignRequest, type FactsRoot, type ImagefirstRequest, type PhotoPlan, type PlanReference, type RequestCaseStudyUse, type RequestPlan } from "../image-first/request-prompt";
import { IMAGE_TOOL_MAX_REFS, REFERENCE_DIR_TOKEN } from "../image-tool-limits";
import { checkJaRenderings, JA_RENDERINGS_MAX_BYTES, jaRenderingDetailOf, JaRenderingsStop, type CheckedJaRenderings, type JaRenderingDetail } from "../ja-renderings/ja-renderings";
import type { FactsPack } from "../quality-pipeline/facts-pack";
import { assertFictionalShop, FICTIONAL_SHOPS } from "../research-log/shops";
import { verifyBundleDir } from "./bundle";
import { approvedDesignRun, DesignApprovalStop } from "./design-approval";

export const SHOPS_DIR = "second-root-shops";
/** The worker's private runs directory under its home (~/sr-runs; the worker CLI uses the same place). */
export const RUNS_DIR = "sr-runs";
export const LOCAL_SHOPS_DIR = ".local-shops";
export const SHOP_RUNS = "runs";
export const REAL_SHOP_RECORD_SCHEMA = "sr_imagefirst_request_run_v1";

const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A regular file read on one handle that was checked: no link, one name, at most `max` bytes. */
async function readChecked(path: string, max: number, codes: { unsafe: string; big: string; missing: string }): Promise<Buffer> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new PromptStop((error as { code?: string }).code === "ENOENT" ? codes.missing : codes.unsafe);
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1) throw new PromptStop(codes.unsafe);
    if (st.size > max) throw new PromptStop(codes.big);
    const bytes = await h.readFile();
    if (bytes.length > max) throw new PromptStop(codes.big);
    return bytes;
  } finally {
    await h.close();
  }
}

/** The request root handed over: <id>.json, outside the repository, checked and parsed (request-prompt.ts parseRequest). */
export async function readRequestFile(o: { requestFile: string; requestSha256: string; requestId: string; repo: string }): Promise<{ request: ImagefirstRequest; bytes: Buffer; sha256: string }> {
  if (!isAbsolute(o.requestFile)) throw new PromptStop("REQUEST_FILE_INVALID");
  if (basename(o.requestFile) !== `${o.requestId}.json`) throw new PromptStop("REQUEST_FILE_NAME_MISMATCH");
  const real = await realpath(o.requestFile).catch(() => null);
  const repo = await realpath(o.repo).catch(() => o.repo);
  if (real === null) throw new PromptStop("REQUEST_FILE_MISSING");
  if (within(real, repo) || within(o.requestFile, o.repo)) throw new PromptStop("REQUEST_FILE_IN_REPO");
  // no link anywhere on the path (root hands a real path: <fresh clone>.request/<id>.json)
  if (real !== resolve(o.requestFile)) throw new PromptStop("REQUEST_FILE_UNSAFE");
  // a link at the last step refuses (O_NOFOLLOW); 1 byte over the envelope cap is enough to refuse
  const bytes = await readChecked(o.requestFile, REQUEST_MAX_BYTES, { unsafe: "REQUEST_FILE_UNSAFE", big: "REQUEST_TOO_LARGE", missing: "REQUEST_FILE_MISSING" });
  const { request, sha256 } = parseRequest(bytes, o.requestSha256, o.requestId);
  return { request, bytes, sha256 };
}

/** The facts pack's root directory for `root` (the home's ~/second-root-shops, or the clone's gitignored .local-shops). */
export const factsBase = (root: FactsRoot, places: { home: string; repo: string }) => (root === "second-root-shops" ? join(places.home, SHOPS_DIR) : join(places.repo, LOCAL_SHOPS_DIR));

/** A real directory, not a link. */
const realDir = async (p: string) => {
  const info = await lstat(p).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink();
};

/** The facts pack the request names: no link anywhere below its root, its real path that path, the request's SHA-256. */
export async function readRequestFacts(request: RequestEnvelope, places: { home: string; repo: string }): Promise<{ bytes: Buffer; facts: FactsPack; path: string }> {
  const base = factsBase(request.facts_ref.root, places);
  const shopDir = join(base, request.facts_ref.shop_id);
  const path = join(shopDir, "facts-pack.json");
  if (!(await lstat(base).then(() => true, () => false)) || !(await lstat(shopDir).then(() => true, () => false))) throw new PromptStop("FACTS_MISSING");
  if (!(await realDir(base)) || !(await realDir(shopDir))) throw new PromptStop("FACTS_PATH_UNSAFE");
  const realBase = await realpath(base);
  if ((await realpath(path).catch(() => null)) !== join(realBase, request.facts_ref.shop_id, "facts-pack.json")) {
    if (!(await lstat(path).then(() => true, () => false))) throw new PromptStop("FACTS_MISSING");
    throw new PromptStop("FACTS_PATH_UNSAFE");
  }
  const bytes = await readChecked(path, FACTS_MAX_BYTES, { unsafe: "FACTS_PATH_UNSAFE", big: "FACTS_TOO_LARGE", missing: "FACTS_MISSING" });
  return { bytes, facts: parseRequestFacts(bytes, request), path };
}

/**
 * DEV-303 §6.1 change 4: a refused renderings record as request mode's stop (the same JA_RENDERING* code), keeping the
 * category / field / key of an added fact for --validate-request (never the text).
 */
export class RequestJaRenderingsStop extends PromptStop {
  constructor(
    code: string,
    readonly detail: JaRenderingDetail | null,
  ) {
    super(code);
  }
}
/** What --validate-request may print of a renderings refusal (allowlisted; never the text). null otherwise. */
export const jaRenderingsRefusalDetailOf = (error: unknown): JaRenderingDetail | null => (error instanceof RequestJaRenderingsStop && error.detail ? jaRenderingDetailOf(new JaRenderingsStop("JA_RENDERING_ADDS_FACT", error.detail)) : null);

/**
 * DEV-303 §6.1 change 4: the whole_page design request's owner-approved Japanese renderings (`sr_ja_renderings_v1`),
 * next to its facts pack (the same root and shop directory, no link, as readRequestCaseStudy), bound by the request's
 * SHA-256, checked in gate mode against the pack (ja-renderings.ts checkJaRenderings). null when the request names none.
 */
export async function readRequestJaRenderings(request: DesignRequest, facts: FactsPack, places: { home: string; repo: string }): Promise<CheckedJaRenderings | null> {
  const ref = request.ja_renderings;
  if (!ref) return null;
  const base = factsBase(request.facts_ref.root, places);
  const shopDir = join(base, request.facts_ref.shop_id);
  const path = join(shopDir, ref.path);
  if (!(await realDir(base)) || !(await realDir(shopDir))) throw new PromptStop("JA_RENDERINGS_RECORD_MISSING");
  if ((await realpath(path).catch(() => null)) !== join(await realpath(shopDir), ref.path)) {
    if (!(await lstat(path).then(() => true, () => false))) throw new PromptStop("JA_RENDERINGS_RECORD_MISSING");
    throw new PromptStop("JA_RENDERINGS_RECORD_UNSAFE");
  }
  const bytes = await readChecked(path, JA_RENDERINGS_MAX_BYTES, { unsafe: "JA_RENDERINGS_RECORD_UNSAFE", big: "JA_RENDERINGS_TOO_LARGE", missing: "JA_RENDERINGS_RECORD_MISSING" });
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new PromptStop("JA_RENDERINGS_RECORD_SHA_MISMATCH");
  try {
    return checkJaRenderings(bytes, facts, { mode: "gate" });
  } catch (error) {
    if (error instanceof JaRenderingsStop) throw new RequestJaRenderingsStop(error.code, error.detail);
    throw error;
  }
}

/**
 * Issue #336: the design request's success-case analysis record, next to its facts pack (the same root and shop
 * directory, no link), bound by the request's SHA-256, of the request's shop, and passing the gate (case-study.ts).
 * null when the request names none (a fictional request; parseRequest already refused a real_shop one).
 */
export async function readRequestCaseStudy(request: DesignRequest, places: { home: string; repo: string }): Promise<CheckedCaseStudy | null> {
  const ref = request.case_study;
  if (!ref) return null;
  const base = factsBase(request.facts_ref.root, places);
  const shopDir = join(base, request.facts_ref.shop_id);
  const path = join(shopDir, ref.path);
  if (!(await realDir(base)) || !(await realDir(shopDir))) throw new PromptStop("CASE_STUDY_RECORD_MISSING");
  if ((await realpath(path).catch(() => null)) !== join(await realpath(shopDir), ref.path)) {
    if (!(await lstat(path).then(() => true, () => false))) throw new PromptStop("CASE_STUDY_RECORD_MISSING");
    throw new PromptStop("CASE_STUDY_RECORD_UNSAFE");
  }
  const bytes = await readChecked(path, CASE_STUDY_MAX_BYTES, { unsafe: "CASE_STUDY_RECORD_UNSAFE", big: "CASE_STUDY_TOO_LARGE", missing: "CASE_STUDY_RECORD_MISSING" });
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new PromptStop("CASE_STUDY_RECORD_SHA_MISMATCH");
  const checked = await checkCaseStudy(bytes, { repo: places.repo, mode: "gate" }).catch((error: unknown) => {
    // the same fixed code, as request mode's own stop (the worker and the entry report PromptStop codes only)
    throw error instanceof CaseStudyStop ? new PromptStop(error.code) : error;
  });
  if (checked.shop_id !== request.shop_id) throw new PromptStop("CASE_STUDY_SHOP_MISMATCH");
  return { sha256: checked.case_study_sha256, counted: checked.counted, ...caseStudyUseOf(checked) };
}

/** DEV-303 §6.1 row 3: one chosen reference picture with its verified bytes (never a path past this point). */
export type ResolvedReference = PlanReference & { bytes: Buffer };
/**
 * Issue #336 + DEV-303 §6.1 row 3: the checked case study as request mode uses it. `use` feeds a whole_page plan
 * (principles and reference metadata, no path); `references` carries the chosen pictures' verified bytes for the run.
 */
export type CheckedCaseStudy = { sha256: string; counted: string[]; use: RequestCaseStudyUse; references: ResolvedReference[]; usableCases: number };

/** A reference picture is at most the Codex input cap (sandbox.ts MAX_INPUT_BYTES). */
export const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
const REFERENCE_TYPES: readonly { ext: readonly string[]; media: PlanReference["media_type"]; name: string; magic: (b: Buffer) => boolean }[] = [
  { ext: [".png"], media: "image/png", name: "png", magic: (b) => b.subarray(0, 8).equals(PNG_MAGIC) },
  { ext: [".jpg", ".jpeg"], media: "image/jpeg", name: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: [".webp"], media: "image/webp", name: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** The inspection fields reference selection reads. */
type SelectionInput = Pick<CaseStudyInspection, "counted" | "record" | "files" | "counting_files">;
/** A counted case's verified originals that can be attached: PNG / JPEG / WebP by extension and magic bytes, with bytes. */
function usableOriginals(i: SelectionInput, caseId: string): { file: ViewedFile; type: (typeof REFERENCE_TYPES)[number] }[] {
  const originals = i.counting_files[caseId] ?? [];
  const out: { file: ViewedFile; type: (typeof REFERENCE_TYPES)[number] }[] = [];
  for (const f of i.files.filter((x) => x.case_id === caseId && originals.some((o) => o.path === x.path && o.sha256 === x.sha256))) {
    const type = REFERENCE_TYPES.find((t) => t.ext.includes(extname(f.path).toLowerCase()));
    if (type && f.bytes !== null && type.magic(f.bytes)) out.push({ file: f, type });
  }
  return out;
}
const ownerOrder = (i: Pick<CaseStudyInspection, "counted" | "record">) => i.record.owner_confirmation?.selected_ids.filter((id) => i.counted.includes(id)) ?? i.counted;

/**
 * DEV-303 §6.1 row 3: the reference pictures of a gate-checked case study, chosen deterministically: the counted cases in
 * the owner's selection order (owner_confirmation.selected_ids; gate mode made it exactly the counted set), per case its
 * FIRST verified original (review M1: only the files that made the case count — its originals-index entry's path and
 * SHA-256, or a SHA-256 recorded for a private original; never another file listed under the case) that is a PNG / JPEG /
 * WebP picture (by extension and magic bytes; never a page's HTML/CSS, a GIF or an archive), at most IMAGE_TOOL_MAX_REFS
 * in all. A picture already chosen for an earlier case is skipped (review L3: the case's next original, if any). Their
 * bytes are the ones the gate check read and hashed. A picture over REFERENCE_MAX_BYTES stops (REFERENCE_IMAGE_TOO_LARGE).
 * `usableCases`: the counted cases with at least one attachable original (for the real-shop minimum). Pure.
 */
export function selectReferences(i: SelectionInput): { references: ResolvedReference[]; usableCases: number } {
  const out: ResolvedReference[] = [];
  let usableCases = 0;
  for (const caseId of ownerOrder(i)) {
    const usable = usableOriginals(i, caseId);
    if (usable.length > 0) usableCases += 1;
    if (out.length >= IMAGE_TOOL_MAX_REFS) continue;
    for (const { file: f, type } of usable) {
      if (out.some((r) => r.sha256 === f.sha256)) continue;
      if (f.bytes!.length > REFERENCE_MAX_BYTES) throw new PromptStop("REFERENCE_IMAGE_TOO_LARGE");
      if (createHash("sha256").update(f.bytes!).digest("hex") !== f.sha256) throw new PromptStop("REFERENCE_IMAGE_SHA_MISMATCH");
      const id = `ref-${out.length + 1}`;
      out.push({ id, case_id: caseId, name: `${id}.${type.name}`, sha256: f.sha256, media_type: type.media, bytes: f.bytes! });
      break;
    }
  }
  return { references: out, usableCases };
}
export const selectReferenceImages = (i: SelectionInput): ResolvedReference[] => selectReferences(i).references;

/**
 * Review Q4: a real shop's whole-page run attaches at least min(3, the counted cases with an attachable original)
 * references (and at least one): REFERENCE_IMAGES_MISSING with none, REFERENCE_IMAGES_TOO_FEW below the minimum.
 */
export function assertRealShopReferences(references: readonly unknown[], usableCases: number): void {
  if (references.length === 0) throw new PromptStop("REFERENCE_IMAGES_MISSING");
  if (references.length < Math.min(3, usableCases)) throw new PromptStop("REFERENCE_IMAGES_TOO_FEW");
}

/** The case study as request mode uses it (counted cases in the owner's order; the chosen references). Pure. */
export function caseStudyUseOf(i: SelectionInput & Pick<CaseStudyInspection, "case_study_sha256">): { use: RequestCaseStudyUse; references: ResolvedReference[]; usableCases: number } {
  const { references, usableCases } = selectReferences(i);
  const cases = ownerOrder(i).flatMap((id) => i.record.cases.filter((c) => c.id === id)).map((c) => ({ id: c.id, principles_to_bring: [...c.principles_to_bring], do_not_copy: [...c.do_not_copy] }));
  return {
    use: { sha256: i.case_study_sha256, shop_specific_principles: [...i.record.shop_specific_principles], cases, references: references.map((r) => ({ id: r.id, case_id: r.case_id, name: r.name, sha256: r.sha256, media_type: r.media_type })) },
    references,
    usableCases,
  };
}

/** The request's kind against the pack (see the header). Throws PromptStop. */
export async function checkRequestShop(request: RequestEnvelope, facts: FactsPack, repo: string): Promise<void> {
  const fictionalSlug = Object.hasOwn(FICTIONAL_SHOPS, request.shop_id);
  if (request.kind === "real_shop") {
    if (fictionalSlug || request.shop_id.startsWith("fictional") || facts.shop_id.startsWith("fictional")) throw new PromptStop("REAL_SHOP_IS_FICTIONAL");
    if (facts.shop_id !== request.shop_id) throw new PromptStop("FACTS_SHOP_MISMATCH");
    return;
  }
  try {
    await assertFictionalShop(repo, request.shop_id);
  } catch {
    throw new PromptStop("SHOP_NOT_FICTIONAL");
  }
  let committed: unknown;
  try {
    committed = (JSON.parse(await readFile(join(repo, FICTIONAL_SHOPS[request.shop_id]!), "utf8")) as { shop_id?: unknown }).shop_id;
  } catch {
    throw new PromptStop("SHOP_NOT_FICTIONAL");
  }
  if (!facts.shop_id.startsWith("fictional-") || facts.shop_id !== committed) throw new PromptStop("FACTS_SHOP_MISMATCH");
}

/** DEV-303 §6.1 change 6: where a shop's design review / approval records live (inside its private shop directory). */
export const DESIGN_REVIEWS_DIR = "design-reviews";
/** The approved design a materials request names, gate-checked: what the plan uses, and the reference pictures' bytes. */
/**
 * synthetic (DEV-303, owner goal 2026-11-26): the approved design is a synthetic rehearsal bundle (rehearsal.ts).
 * --validate-request still checks it (and says rehearsal_only); the worker's run and the entry refuse it.
 */
export type ResolvedApprovedDesign = { use: ApprovedDesignUse; references: (DesignReference & { bytes: Buffer })[]; synthetic?: true };

/**
 * DEV-303 §6.1 change 6 (production flow §1 stage 4, §3.4): the owner-approved design a photo-materials request names.
 * The review and approval records are plain file names in the shop's private design-reviews folder next to its facts
 * pack (the same root and shop directory, no link anywhere, as readRequestCaseStudy); the run is the review inbox's
 * sealed bundle ~/sr-runs/review-inbox/<bundle_id>. approvedDesignRun (design-approval.ts) runs the gate check (bundle
 * verified, five axes, approval bound to review / page / images, decision approve, no axis fail); its DESIGN_* stop is
 * request mode's stop with the same code. The run must be the named one (id, SHA-256) and of the request's shop and kind.
 * References: the approved PC / SP pictures (all of them when at most IMAGE_TOOL_MAX_REFS, else the first PC and the
 * first SP part), as ref-N.png.
 */
export async function readApprovedDesign(request: Pick<PhotoMaterialsRequest, "approved_design" | "facts_ref" | "shop_id" | "kind">, places: { home: string; repo: string }): Promise<ResolvedApprovedDesign> {
  const ref = request.approved_design;
  const base = factsBase(request.facts_ref.root, places);
  const shopDir = join(base, request.facts_ref.shop_id);
  const dir = join(shopDir, DESIGN_REVIEWS_DIR);
  if (!(await realDir(base)) || !(await realDir(shopDir))) throw new PromptStop("APPROVED_DESIGN_MISSING");
  if (!(await realDir(dir))) throw new PromptStop((await lstat(dir).then(() => true, () => false)) ? "APPROVED_DESIGN_UNSAFE" : "APPROVED_DESIGN_MISSING");
  const realDirPath = join(await realpath(shopDir), DESIGN_REVIEWS_DIR);
  if ((await realpath(dir).catch(() => null)) !== realDirPath) throw new PromptStop("APPROVED_DESIGN_UNSAFE");
  for (const name of [ref.review_file, ref.approval_file]) {
    if ((await realpath(join(dir, name)).catch(() => null)) !== join(realDirPath, name)) throw new PromptStop((await lstat(join(dir, name)).then(() => true, () => false)) ? "APPROVED_DESIGN_UNSAFE" : "APPROVED_DESIGN_MISSING");
  }
  let a;
  try {
    a = await approvedDesignRun({ bundleDir: join(places.home, RUNS_DIR, "review-inbox", ref.bundle_id), reviewPath: join(dir, ref.review_file), approvalPath: join(dir, ref.approval_file), repo: places.repo });
  } catch (error) {
    if (error instanceof DesignApprovalStop) throw new PromptStop(error.code);
    throw error;
  }
  if (a.request_id !== ref.bundle_id || a.bundle_sha256 !== ref.bundle_sha256 || a.shop !== request.shop_id || a.kind !== request.kind) throw new PromptStop("APPROVED_DESIGN_MISMATCH");
  const all = [...a.images.pc, ...a.images.sp];
  const chosen = all.length <= IMAGE_TOOL_MAX_REFS ? all : [a.images.pc[0]!, a.images.sp[0]!];
  const references = chosen.map((img, n) => ({ id: `ref-${n + 1}`, image: basename(img.file, ".png"), name: `ref-${n + 1}.png`, sha256: img.sha256, bytes: img.bytes }));
  return {
    use: { bundle_id: a.request_id, bundle_sha256: a.bundle_sha256, review_sha256: a.review_sha256, approval_sha256: a.approval_sha256, references: references.map((r) => ({ id: r.id, image: r.image, name: r.name, sha256: r.sha256 })) },
    references,
    ...(a.synthetic ? { synthetic: true as const } : {}),
  };
}

/** DEV-303 (owner decision 2026-11-24): one resolved photo input (its bytes checked against the request's SHA-256). */
export type ResolvedPhoto = { name: string; sha256: string; bytes: Buffer };
export type RequestRunInputs = {
  request: ImagefirstRequest;
  requestBytes: Buffer;
  requestSha256: string;
  factsBytes: Buffer;
  facts: FactsPack;
  /** direction.json (design) or materials.json (photo materials). */
  directionBytes: Buffer;
  plan: RequestPlan | PhotoPlan;
  /** The design stage's photo inputs: resolved, "unchecked" (validation only, the photo run not there yet) or null (none). */
  photos: ResolvedPhoto[] | "unchecked" | null;
  /**
   * Issue #336: the design stage's checked success-case analysis (gate mode), or null (photo materials; fictional without
   * one). DEV-303 §6.1 row 3: with its use in a whole_page plan and the chosen reference pictures' bytes.
   */
  caseStudy: CheckedCaseStudy | null;
  /** DEV-303 §6.1 row 3: the reference pictures attached to a whole_page run (the plan's references, with bytes); null otherwise. */
  references: ResolvedReference[] | null;
  /** DEV-303 §6.1 change 6: a photo-materials run's gate-checked approved design and its reference pictures; null otherwise. */
  approvedDesign: ResolvedApprovedDesign | null;
  /** DEV-303 §6.1 change 4: a whole_page design's checked owner-approved Japanese renderings, or null (none named). */
  jaRenderings: CheckedJaRenderings | null;
};

/**
 * Everything a request run is built from, checked, and its plan (the worker and the entry each rebuild it the same way).
 * `photoInputs` "if_present" (only --validate-request): a design request's photo inputs are checked only when the
 * photo-materials run they name has a receipt; otherwise "unchecked". Runs always need them ("required").
 */
export async function loadRequestRun(o: { requestFile: string; requestSha256: string; requestId: string; home: string; repo: string; photoInputs?: "required" | "if_present" }): Promise<RequestRunInputs> {
  const r = await readRequestFile(o);
  const f = await readRequestFacts(r.request, { home: o.home, repo: o.repo });
  await checkRequestShop(r.request, f.facts, o.repo);
  const base = { request: r.request, requestBytes: r.bytes, requestSha256: r.sha256, factsBytes: f.bytes, facts: f.facts };
  if (isPhotoRequest(r.request)) {
    // DEV-303 §6.1 change 6: the owner-approved design first (gate-checked), then the materials it needs
    const approvedDesign = await readApprovedDesign(r.request, { home: o.home, repo: o.repo });
    const plan = buildPhotoPlan({ request: r.request, requestSha256: r.sha256, factsBytes: f.bytes, facts: f.facts, approvedDesign: approvedDesign.use });
    if (plan.batch.images !== r.request.max_images) throw new PromptStop("REQUEST_IMAGES_MISMATCH");
    return { ...base, directionBytes: materialsBytes(r.request), plan, photos: null, caseStudy: null, references: null, approvedDesign, jaRenderings: null };
  }
  const caseStudy = await readRequestCaseStudy(r.request, { home: o.home, repo: o.repo });
  const whole = layoutOf(r.request) === "whole_page";
  // review Q4: a real shop's whole page attaches at least min(3, counted cases with an attachable original) references
  if (whole && r.request.kind === "real_shop" && caseStudy) assertRealShopReferences(caseStudy.references, caseStudy.usableCases);
  // DEV-303 §6.1 row 3: a whole-page plan reads the case study's principles and reference metadata (never a path)
  const jaRenderings = await readRequestJaRenderings(r.request, f.facts, { home: o.home, repo: o.repo });
  const plan = buildRequestPlan({ request: r.request, requestSha256: r.sha256, factsBytes: f.bytes, facts: f.facts, ...(whole ? { caseStudy: caseStudy?.use ?? null } : {}), ...(jaRenderings ? { jaRenderings: { sha256: jaRenderings.sha256, entries: jaRenderings.entries } } : {}) });
  if (plan.batch.images !== r.request.max_images) throw new PromptStop("REQUEST_IMAGES_MISMATCH");
  const photos = r.request.photo_inputs ? await resolvePhotoInputs(r.request, { runsDir: join(o.home, RUNS_DIR), mode: o.photoInputs ?? "required" }) : null;
  return { ...base, directionBytes: requestDirectionBytes(r.request), plan, photos, caseStudy, references: whole ? (caseStudy?.references ?? null) : null, approvedDesign: null, jaRenderings };
}

/** A photo input is at most this large (the Codex input cap, sandbox.ts MAX_INPUT_BYTES). */
export const PHOTO_INPUT_MAX_BYTES = 20 * 1024 * 1024;
const RECEIPT_MAX_BYTES = 256 * 1024;
const STAMP = "\\d{8}T\\d{6}Z";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Ours: a real directory (no link), owned by this user, closed to group and others. */
const ownPrivateDir = async (p: string) => {
  const info = await lstat(p).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
};

/**
 * DEV-303 (owner decision 2026-11-24): the design stage's photo inputs, resolved ONLY inside the named photo-materials
 * run's own private directory under ~/sr-runs: its one receipt <id>-<UTC>.receipt.json (ours, 0600, no link) says
 * succeeded and verified, stage photo_materials, mode request, the same request id, the same kind and shop; the run
 * directory is exactly <runs>/<id>-<UTC> (ours, 0700, no link) and parts/ a real directory; each named file is a regular
 * file (no link, one name), a PNG within PHOTO_INPUT_MAX_BYTES, whose SHA-256 is the request's and the receipt's.
 * The bytes are returned (the caller hands them to the one Codex run); nothing is copied anywhere. PromptStop codes only.
 */
export async function resolvePhotoInputs(request: DesignRequest, o: { runsDir: string; mode: "required" | "if_present" }): Promise<ResolvedPhoto[] | "unchecked"> {
  const p = request.photo_inputs;
  if (!p) throw new PromptStop("PHOTO_INPUTS_MISSING");
  const runsInfo = await lstat(o.runsDir).catch(() => null);
  if (!runsInfo) {
    if (o.mode === "if_present") return "unchecked";
    throw new PromptStop("PHOTO_INPUT_RUN_MISSING");
  }
  if (!(await ownPrivateDir(o.runsDir))) throw new PromptStop("PHOTO_INPUT_UNSAFE");
  const re = new RegExp(`^${p.request_id}-${STAMP}\\.receipt\\.json$`);
  const found = (await readdir(o.runsDir)).filter((n) => re.test(n));
  if (found.length === 0) {
    if (o.mode === "if_present") return "unchecked";
    throw new PromptStop("PHOTO_INPUT_RUN_MISSING");
  }
  if (found.length > 1) throw new PromptStop("PHOTO_INPUT_RUN_AMBIGUOUS");
  const receiptPath = join(o.runsDir, found[0]!);
  const receiptBytes = await readChecked(receiptPath, RECEIPT_MAX_BYTES, { unsafe: "PHOTO_INPUT_UNSAFE", big: "PHOTO_INPUT_UNSAFE", missing: "PHOTO_INPUT_RUN_MISSING" });
  const st = await lstat(receiptPath);
  if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new PromptStop("PHOTO_INPUT_UNSAFE");
  let r: { status?: unknown; stop_code?: unknown; interrupted?: unknown; verified?: unknown; request_stage?: unknown; mode?: unknown; request_id?: unknown; kind?: unknown; shop?: unknown; run_dir?: unknown; images?: unknown };
  try {
    r = JSON.parse(receiptBytes.toString("utf8")) as typeof r;
  } catch {
    throw new PromptStop("PHOTO_INPUT_RUN_INVALID");
  }
  if (!r || r.status !== "succeeded" || r.stop_code !== null || r.interrupted !== false || r.verified !== true || r.request_stage !== "photo_materials" || r.mode !== "request" || r.request_id !== p.request_id) throw new PromptStop("PHOTO_INPUT_RUN_NOT_SUCCEEDED");
  if (r.kind !== request.kind || r.shop !== request.shop_id) throw new PromptStop("PHOTO_INPUT_RUN_MISMATCH");
  const runDir = join(o.runsDir, basename(found[0]!, ".receipt.json"));
  const realRuns = await realpath(o.runsDir);
  if (typeof r.run_dir !== "string" || (await realpath(r.run_dir).catch(() => null)) !== join(realRuns, basename(runDir))) throw new PromptStop("PHOTO_INPUT_RUN_INVALID");
  if (!(await ownPrivateDir(runDir)) || !(await realDir(join(runDir, "parts")))) throw new PromptStop("PHOTO_INPUT_UNSAFE");
  const recorded = new Map((Array.isArray(r.images) ? (r.images as { file?: unknown; sha256?: unknown }[]) : []).map((i) => [i.file, i.sha256]));
  for (const f of p.files) if (!PHOTO_FILE_RE.test(f.name) || recorded.get(`parts/${f.name}`) !== f.sha256) throw new PromptStop("PHOTO_INPUT_SHA_MISMATCH");
  // sealed and delivered: the review inbox's copy of this run verifies (bundle.ts), is its image-materials bundle sealed
  // from exactly this receipt, and lists every named file with the same SHA-256
  let delivered;
  try {
    delivered = (await verifyBundleDir(join(o.runsDir, "review-inbox", p.request_id))).manifest;
  } catch {
    throw new PromptStop("PHOTO_INPUT_NOT_DELIVERED");
  }
  if (delivered.image_material !== true || delivered.bundle_id !== p.request_id || delivered.receipt_original_sha256 !== createHash("sha256").update(receiptBytes).digest("hex")) throw new PromptStop("PHOTO_INPUT_NOT_DELIVERED");
  if (!p.files.every((f) => delivered.photos?.some((x) => x.file === `parts/${f.name}` && x.sha256 === f.sha256))) throw new PromptStop("PHOTO_INPUT_NOT_DELIVERED");
  const out: ResolvedPhoto[] = [];
  for (const f of p.files) {
    if (!PHOTO_FILE_RE.test(f.name)) throw new PromptStop("PHOTO_INPUT_UNSAFE");
    if (recorded.get(`parts/${f.name}`) !== f.sha256) throw new PromptStop("PHOTO_INPUT_SHA_MISMATCH");
    const bytes = await readChecked(join(runDir, "parts", f.name), PHOTO_INPUT_MAX_BYTES, { unsafe: "PHOTO_INPUT_UNSAFE", big: "PHOTO_INPUT_TOO_LARGE", missing: "PHOTO_INPUT_MISSING" });
    if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new PromptStop("PHOTO_INPUT_NOT_PNG");
    if (createHash("sha256").update(bytes).digest("hex") !== f.sha256) throw new PromptStop("PHOTO_INPUT_SHA_MISMATCH");
    out.push({ name: f.name, sha256: f.sha256, bytes });
  }
  return out;
}

/**
 * DEV-303 §6.1 row 3: what a run's records keep of its reference pictures — the allowlisted fields id, case_id and
 * sha256 only (never a path, a name on disk or the bytes).
 */
export type ReferenceRecord = { id: string; case_id: string; sha256: string };
export const referenceRecordOf = (refs: readonly Pick<PlanReference, "id" | "case_id" | "sha256">[]): ReferenceRecord[] => refs.map((r) => ({ id: r.id, case_id: r.case_id, sha256: r.sha256 }));

/**
 * Review Q5 follow-up: what `--validate-request` may add to a CASE_STUDY_TEXT_HAS_FACT refusal: the matched category
 * (a fixed list), the field and the case id, each re-checked against its allowlist (never the text). null otherwise.
 */
export function refusalDetailOf(error: unknown): { category: string; field: CaseStudyTextField; case_id: string | null } | null {
  if (!(error instanceof CaseStudyTextStop)) return null;
  if (!CASE_STUDY_TEXT_CATEGORIES.includes(error.category) || !(CASE_STUDY_TEXT_FIELDS as readonly string[]).includes(error.field)) return null;
  if (error.caseId !== null && !/^(?:CP|SR)-\d{3}$/.test(error.caseId)) return null;
  return { category: error.category, field: error.field, case_id: error.caseId };
}

/** Where root's pilot puts the run's private copy of the request (an absolute path to <dir>/<request id>.json). */
export const REQUEST_FILE_ENV = "SR_IMAGEFIRST_REQUEST_FILE";

/**
 * `--validate-request <file>`: the whole worker-side check of a request Claude is about to drop into ~/sr-runs/requests/
 * (root's quota counts a refused request too) — the file (named <id>.json, regular, no link, at most 16 KiB, outside the
 * repository), the strict schema, the facts pack (resolution, no link, size, facts_sha256), the shop's kind and the plan
 * (6 pictures), and (Issue #336) the design stage's case study in gate mode. Its SHA-256 is computed here (root later binds it with --request-sha256). Read only: no claim, no ledger,
 * no write, no network, no Codex.
 */
export type RequestValidation = { request_id: string; kind: ImagefirstRequest["kind"]; stage: "design" | "photo_materials" | "detail_comp"; request_sha256: string; facts_sha256: string; plan_sha256: string; photo_inputs: "checked" | "unchecked" | null; case_study: { sha256: string; counted: string[] } | null; layout?: "whole_page"; reference_images?: ReferenceRecord[]; approved_design?: ApprovedDesignRecord; materials_sha256?: string; ja_renderings?: { sha256: string; keys: string[] }; rehearsal_only?: true };
export async function validateRequestFile(o: { file: string; home: string; repo: string }): Promise<RequestValidation | DetailValidation> {
  const detail = await loadDetailCompOffline(o);
  if (detail) return detailValidationOf(detail);
  return validationOf(await loadRequestFileOffline(o));
}

/**
 * DEV-364 PR 4: what --validate-request says of a detail comp request (request-prompt.ts DetailCompRequest). It is
 * checked and planned offline only: `runnable: false` (the worker's run path refuses the stage, DETAIL_COMP_NOT_RUNNABLE),
 * `support_only: true` (never a design success).
 */
export type DetailValidation = Omit<RequestValidation, "stage" | "approved_design"> & {
  stage: "detail_comp";
  approved_design: ApprovedDesignRecord;
  targets: { id: string; view: "pc" | "sp"; box: { x: number; y: number; w: number; h: number } }[];
  support_only: true;
  runnable: false;
};
export type DetailCompRun = { plan: DetailPlan; requestSha256: string; references: (ResolvedApprovedDesign["references"][number])[] };

/** The PNG's own width and height (its IHDR), or a stop. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(sig) || bytes.toString("latin1", 12, 16) !== "IHDR") throw new PromptStop("APPROVED_DESIGN_MISMATCH");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * DEV-364 PR 4: a detail comp request file, read and checked offline (null when the file is not a detail comp): the same
 * file rules as the other stages, the strict schema, the facts pack and shop, the approved design through its own gate
 * (readApprovedDesign → approvedDesignRun), which must be a WHOLE PAGE (one PC and one SP picture;
 * DETAIL_COMP_NOT_WHOLE_PAGE) and not a synthetic rehearsal (DETAIL_COMP_DESIGN_SYNTHETIC), then the plan.
 */
async function loadDetailCompOffline(o: { file: string; home: string; repo: string }): Promise<DetailCompRun | null> {
  const file = resolve(o.file);
  const name = basename(file);
  if (!name.endsWith(".json")) return null;
  const bytes = await readChecked(file, REQUEST_MAX_BYTES, { unsafe: "REQUEST_FILE_UNSAFE", big: "REQUEST_TOO_LARGE", missing: "REQUEST_FILE_MISSING" });
  if (!isDetailCompBytes(bytes)) return null;
  const requestSha256 = createHash("sha256").update(bytes).digest("hex");
  const { request } = parseDetailCompRequest(bytes, requestSha256, name.slice(0, -".json".length));
  const facts = await readRequestFacts(request, o);
  await checkRequestShop(request, facts.facts, o.repo);
  const design = await readApprovedDesign(request, o);
  if (design.synthetic) throw new PromptStop("DETAIL_COMP_DESIGN_SYNTHETIC");
  const pc = design.references.filter((r) => r.image.startsWith("pc-"));
  const sp = design.references.filter((r) => r.image.startsWith("sp-"));
  if (pc.length !== 1 || sp.length !== 1 || design.references.length !== 2) throw new PromptStop("DETAIL_COMP_NOT_WHOLE_PAGE");
  const image = (r: (typeof pc)[number]) => ({ image: r.image, sha256: r.sha256, ...pngSize(r.bytes) });
  const plan = buildDetailCompPlan({ request, requestSha256, factsBytes: facts.bytes, facts: facts.facts, approved: { bundle_id: design.use.bundle_id, bundle_sha256: design.use.bundle_sha256, review_sha256: design.use.review_sha256, approval_sha256: design.use.approval_sha256, pc: image(pc[0]!), sp: image(sp[0]!) } });
  const used = new Set(plan.references.map((r) => r.sha256));
  return { plan, requestSha256, references: design.references.filter((r) => used.has(r.sha256)) };
}

function detailValidationOf(d: DetailCompRun): DetailValidation {
  return {
    request_id: d.plan.request_id,
    kind: d.plan.kind,
    stage: "detail_comp",
    request_sha256: d.requestSha256,
    facts_sha256: d.plan.facts_sha256,
    plan_sha256: d.plan.plan_sha256,
    photo_inputs: null,
    case_study: null,
    approved_design: d.plan.approved_design,
    targets: d.plan.details.map((x) => ({ id: x.target, view: x.view, box: x.box })),
    support_only: true,
    runnable: false,
  };
}

/** The request file as --validate-request and --print-plan read it (named <id>.json; its own bytes' SHA-256), loaded and checked. */
async function loadRequestFileOffline(o: { file: string; home: string; repo: string }): Promise<RequestRunInputs> {
  const file = resolve(o.file);
  const name = basename(file);
  if (!name.endsWith(".json")) throw new PromptStop("REQUEST_FILE_NAME_MISMATCH");
  const requestId = name.slice(0, -".json".length);
  const bytes = await readChecked(file, REQUEST_MAX_BYTES, { unsafe: "REQUEST_FILE_UNSAFE", big: "REQUEST_TOO_LARGE", missing: "REQUEST_FILE_MISSING" });
  return loadRequestRun({ requestFile: file, requestSha256: createHash("sha256").update(bytes).digest("hex"), requestId, home: o.home, repo: o.repo, photoInputs: "if_present" });
}

function validationOf(run: RequestRunInputs): RequestValidation {
  return {
    request_id: run.request.id,
    kind: run.request.kind,
    stage: isPhotoRequest(run.request) ? "photo_materials" : "design",
    request_sha256: run.requestSha256,
    facts_sha256: run.plan.facts_sha256,
    plan_sha256: run.plan.plan_sha256,
    photo_inputs: run.photos === null ? null : run.photos === "unchecked" ? "unchecked" : "checked",
    case_study: run.caseStudy ? { sha256: run.caseStudy.sha256, counted: run.caseStudy.counted } : null,
    ...(run.jaRenderings ? { ja_renderings: { sha256: run.jaRenderings.sha256, keys: run.jaRenderings.entries.map((e) => e.fact_key) } } : {}),
    ...(run.references ? { layout: "whole_page" as const, reference_images: referenceRecordOf(run.references) } : {}),
    ...(run.approvedDesign && "materials_sha256" in run.plan ? { approved_design: approvedDesignRecordOf(run.approvedDesign), materials_sha256: run.plan.materials_sha256 } : {}),
    // DEV-303 (owner goal 2026-11-26): the approved design is a synthetic rehearsal bundle; the worker would refuse the run
    ...(run.approvedDesign?.synthetic ? { rehearsal_only: true as const } : {}),
  };
}

/**
 * DEV-303 (owner goal 2026-11-26, the first real whole-page generation's review): `--print-plan <file>` — exactly what
 * the request's ONE Codex run would be sent, built by the same loadRequestRun as --validate-request, the worker and the
 * entry (so plan_sha256 is theirs). Offline and read only, like validateRequestFile: no claim, no ledger, no write, no
 * network, no Codex.
 *
 *   sent.prompt       the pinned batch prompt (the codex exec's stdin); each reference is named in it as
 *                     `<reference_dir_token>/ref-N.<ext>` and the image call replaces the token with the absolute staged
 *                     directory (`<codex work dir>/inputs`, a fresh temporary directory per run) right before the exec.
 *   sent.attachments  the `--image` files in exec order (photo inputs first, staged as photo-<n>.png, then the references
 *                     under their own names), each with its SHA-256, media type, size and staged path.
 *   entry_pins        what the worker passes the entry to re-check (request-cycle.ts requestArgv).
 *   plan              the whole plan object (per-picture prompts included); plan_sha256 is its canonical form's SHA-256.
 *   commit / on_origin_develop / clean
 *                     the checkout the print was built from (PR #361 review M1: read-only git, injected by the CLI). The
 *                     worker builds its plan in its own clone at origin/develop, so the print is the worker's only from a
 *                     clean checkout at origin/develop; the owner still compares plan_sha256 with the worker's precheck /
 *                     receipt before approving.
 *
 * It reads the caller's HOME (the facts pack, the case study, and the photo-materials run a design names): run it as the
 * worker's user, or with that HOME.
 * A design request's photo inputs whose photo-materials run is not there yet are "unchecked": their attachments are not
 * listed (attachments_complete: false). The output holds the facts values the prompt quotes: it is for the owner's review.
 */
export const PLAN_PRINT_SCHEMA = "sr_imagefirst_plan_print_v1";
/** Where the image call stages a run's attachments (inside the run's fresh temporary Codex work dir; sandbox.ts). */
export const STAGED_INPUTS_DIR = "<codex work dir>/inputs";
export type PlanAttachment = { order: number; kind: "photo_input" | "reference"; name: string; staged_name: string; staged_path: string; sha256: string; media_type: string; bytes: number; id?: string; case_id?: string; image?: string };
/** HEAD, origin/develop and a clean tree, as the worker's gitCommitState reads them (structural; this module starts no process). */
export type PlanCheckout = { head: string | null; base: string | null; clean: boolean };
export type RequestPlanPrint = (RequestValidation | DetailValidation) & {
  schema: typeof PLAN_PRINT_SCHEMA;
  codex_invoked: false;
  commit: string | null;
  on_origin_develop: boolean;
  clean: boolean;
  sent: { codex_runs: 1; max_images: number; prompt_sha256: string; prompt_chars: number; prompt: string; reference_dir_token: string | null; staged_dir: string; attachments: PlanAttachment[]; attachments_complete: boolean };
  entry_pins: { expected_plan_sha256: string; expected_prompt_sha256: string; expected_prompt_chars: number };
  plan: RequestPlan | PhotoPlan | DetailPlan;
};

/**
 * The `--image` attachments of a loaded run in exec order (the image call's one exec): the input images first
 * (stageInputBytes renames them photo-<n>.png in the given order), then the references under their own names (a whole
 * page's success-case originals, or a materials run's approved PC / SP pictures, always PNG). Unchecked photo inputs list
 * nothing. Pure.
 */
export function planAttachmentsOf(run: Pick<RequestRunInputs, "photos" | "references" | "approvedDesign">): PlanAttachment[] {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const attachments: PlanAttachment[] = [];
  const add = (a: Omit<PlanAttachment, "order" | "staged_path">) => attachments.push({ order: attachments.length + 1, ...a, staged_path: `${STAGED_INPUTS_DIR}/${a.staged_name}` });
  if (Array.isArray(run.photos)) run.photos.forEach((p, n) => add({ kind: "photo_input", name: p.name, staged_name: `photo-${n + 1}.png`, sha256: sha(p.bytes), media_type: "image/png", bytes: p.bytes.length }));
  for (const r of run.references ?? []) add({ kind: "reference", id: r.id, case_id: r.case_id, name: r.name, staged_name: r.name, sha256: sha(r.bytes), media_type: r.media_type, bytes: r.bytes.length });
  for (const r of run.approvedDesign?.references ?? []) add({ kind: "reference", id: r.id, image: r.image, name: r.name, staged_name: r.name, sha256: sha(r.bytes), media_type: "image/png", bytes: r.bytes.length });
  return attachments;
}

export async function printRequestPlan(o: { file: string; home: string; repo: string; checkout: () => Promise<PlanCheckout> }): Promise<RequestPlanPrint> {
  const detail = await loadDetailCompOffline(o);
  if (detail) {
    // DEV-364 PR 4: what a detail comp's ONE run would be sent — shown for review; the worker does not run it in this version
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const attachments: PlanAttachment[] = detail.plan.references.map((r, n) => {
      const bytes = detail.references.find((x) => x.sha256 === r.sha256)!.bytes;
      return { order: n + 1, kind: "reference", id: r.id, image: r.image, name: r.name, staged_name: r.name, staged_path: `${STAGED_INPUTS_DIR}/${r.name}`, sha256: sha(bytes), media_type: "image/png", bytes: bytes.length };
    });
    const c = await o.checkout().catch(() => null);
    const commit = c?.head && /^[0-9a-f]{40}$/.test(c.head) ? c.head : null;
    const p = detail.plan;
    return {
      schema: PLAN_PRINT_SCHEMA,
      ...detailValidationOf(detail),
      codex_invoked: false,
      commit,
      on_origin_develop: commit !== null && c?.base === commit,
      clean: c?.clean === true,
      sent: { codex_runs: 1, max_images: p.batch.images, prompt_sha256: p.batch.sha256, prompt_chars: p.batch.chars, prompt: p.batch.prompt, reference_dir_token: REFERENCE_DIR_TOKEN, staged_dir: STAGED_INPUTS_DIR, attachments, attachments_complete: true },
      entry_pins: { expected_plan_sha256: p.plan_sha256, expected_prompt_sha256: p.batch.sha256, expected_prompt_chars: p.batch.chars },
      plan: p,
    };
  }
  const run = await loadRequestFileOffline(o);
  const plan = run.plan;
  const attachments = planAttachmentsOf(run);
  const hasRefs = attachments.some((a) => a.kind === "reference");
  const c = await o.checkout().catch(() => null);
  const commit = c?.head && /^[0-9a-f]{40}$/.test(c.head) ? c.head : null;
  return {
    schema: PLAN_PRINT_SCHEMA,
    ...validationOf(run),
    codex_invoked: false,
    commit,
    on_origin_develop: commit !== null && c?.base === commit,
    clean: c?.clean === true,
    sent: { codex_runs: 1, max_images: plan.batch.images, prompt_sha256: plan.batch.sha256, prompt_chars: plan.batch.chars, prompt: plan.batch.prompt, reference_dir_token: hasRefs ? REFERENCE_DIR_TOKEN : null, staged_dir: STAGED_INPUTS_DIR, attachments, attachments_complete: run.photos !== "unchecked" },
    entry_pins: { expected_plan_sha256: plan.plan_sha256, expected_prompt_sha256: plan.batch.sha256, expected_prompt_chars: plan.batch.chars },
    plan,
  };
}

/** DEV-303 §6.1 change 6: what records keep of a materials run's approved design (SHA-256s and the bundle id; no path). */
export type ApprovedDesignRecord = { bundle_id: string; bundle_sha256: string; review_sha256: string; approval_sha256: string };
export const approvedDesignRecordOf = (a: ResolvedApprovedDesign): ApprovedDesignRecord => ({ bundle_id: a.use.bundle_id, bundle_sha256: a.use.bundle_sha256, review_sha256: a.use.review_sha256, approval_sha256: a.use.approval_sha256 });

export type RealShopRecord = {
  schema: typeof REAL_SHOP_RECORD_SCHEMA;
  request_id: string;
  shop_id: string;
  kind: "real_shop";
  request_sha256: string;
  facts_sha256: string;
  plan_sha256: string | null;
  /** Issue #336: the SHA-256 of the case study the run was checked against (readRequestCaseStudy); null for a photo-materials run. */
  case_study_sha256: string | null;
  /** DEV-303 §6.1 change 6: only on a photo-materials run — the approved design it is for and the materials list's SHA-256. */
  approved_design?: ApprovedDesignRecord;
  materials_sha256?: string;
  /** DEV-303 §6.1 change 4: only when the run used owner-approved Japanese renderings — that record's SHA-256 (no path). */
  ja_renderings_sha256?: string;
  /** DEV-303 §6.1 row 3: only on a whole_page design run — the layout and its reference pictures (id, case_id, sha256). */
  design_layout?: "whole_page";
  reference_images?: ReferenceRecord[];
  commit: string | null;
  run: { status: string; code: string | null; invoked: boolean; receipt_written: boolean };
  review: { status: string; code: string | null; bundle_sha256: string | null } | null;
  /** DEV-303 (owner decision 2026-11-24): what the run is for (recordUseOf). */
  use: RecordUse;
  recorded_at: string;
};
export type RecordUse = "internal_design_reference_only" | "sales_proposal_image_material" | "proposal_demo_design";
/** A photo-materials run: sales proposal image materials; a design with photo inputs: a proposal demo design; else internal reference. */
export const recordUseOf = (request: ImagefirstRequest): RecordUse =>
  isPhotoRequest(request) ? "sales_proposal_image_material" : request.photo_inputs ? "proposal_demo_design" : "internal_design_reference_only";

/**
 * The real shop's private run record: ~/second-root-shops/<shop_id>/runs/<request id>.json (metadata only; never a
 * prompt, a facts value or a picture). The shop directory must already exist as a real directory (the owner made it for
 * the facts pack); runs/ is created 0700; the file is created once (O_EXCL | O_NOFOLLOW, 0600). Never inside the repository.
 */
export async function writeRealShopRecord(o: { home: string; repo: string; record: RealShopRecord }): Promise<string> {
  const base = join(o.home, SHOPS_DIR);
  const shopDir = join(base, o.record.shop_id);
  const repo = await realpath(o.repo).catch(() => o.repo);
  if (!(await realDir(base)) || !(await realDir(shopDir))) throw new PromptStop("SHOP_DIR_UNSAFE");
  if (within(await realpath(shopDir), repo)) throw new PromptStop("SHOP_DIR_IN_REPO");
  const runs = join(shopDir, SHOP_RUNS);
  await mkdir(runs, { mode: 0o700 }).catch((e: { code?: string }) => (e.code === "EEXIST" ? undefined : Promise.reject(new PromptStop("SHOP_DIR_UNSAFE"))));
  const info = await lstat(runs).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new PromptStop("SHOP_DIR_UNSAFE");
  const path = join(runs, `${o.record.request_id}.json`);
  let h;
  try {
    h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw new PromptStop((error as { code?: string }).code === "EEXIST" ? "RECORD_EXISTS" : "RECORD_UNWRITABLE");
  }
  try {
    await h.writeFile(`${JSON.stringify(o.record, null, 2)}\n`);
  } finally {
    await h.close();
  }
  return path;
}
