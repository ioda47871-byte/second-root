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
 *                    present on a fictional request. Never handed to Codex; the prompts and plan do not change.
 *   the record:      real_shop only, ~/second-root-shops/<shop_id>/runs/<id>.json (metadata: ids, codes, SHA-256s;
 *                    0700 / 0600, written once). A real shop never enters design-library/research-log (public repo).
 *
 * Failures throw PromptStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { CASE_STUDY_MAX_BYTES, CaseStudyStop, checkCaseStudy } from "../case-study/case-study";
import { PromptStop } from "../image-first/prompt";
import { buildPhotoPlan, buildRequestPlan, FACTS_MAX_BYTES, isPhotoRequest, parseRequest, parseRequestFacts, photoBriefBytes, PHOTO_FILE_RE, REQUEST_MAX_BYTES, requestDirectionBytes, type DesignRequest, type FactsRoot, type ImagefirstRequest, type PhotoPlan, type RequestPlan } from "../image-first/request-prompt";
import type { FactsPack } from "../quality-pipeline/facts-pack";
import { assertFictionalShop, FICTIONAL_SHOPS } from "../research-log/shops";
import { verifyBundleDir } from "./bundle";

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
export async function readRequestFacts(request: ImagefirstRequest, places: { home: string; repo: string }): Promise<{ bytes: Buffer; facts: FactsPack; path: string }> {
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
 * Issue #336: the design request's success-case analysis record, next to its facts pack (the same root and shop
 * directory, no link), bound by the request's SHA-256, of the request's shop, and passing the gate (case-study.ts).
 * null when the request names none (a fictional request; parseRequest already refused a real_shop one).
 */
export async function readRequestCaseStudy(request: DesignRequest, places: { home: string; repo: string }): Promise<{ sha256: string; counted: string[] } | null> {
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
  return { sha256: checked.case_study_sha256, counted: checked.counted };
}

/** The request's kind against the pack (see the header). Throws PromptStop. */
export async function checkRequestShop(request: ImagefirstRequest, facts: FactsPack, repo: string): Promise<void> {
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

/** DEV-303 (owner decision 2026-11-24): one resolved photo input (its bytes checked against the request's SHA-256). */
export type ResolvedPhoto = { name: string; sha256: string; bytes: Buffer };
export type RequestRunInputs = {
  request: ImagefirstRequest;
  requestBytes: Buffer;
  requestSha256: string;
  factsBytes: Buffer;
  facts: FactsPack;
  /** direction.json (design) or photo-brief.json (photo materials). */
  directionBytes: Buffer;
  plan: RequestPlan | PhotoPlan;
  /** The design stage's photo inputs: resolved, "unchecked" (validation only, the photo run not there yet) or null (none). */
  photos: ResolvedPhoto[] | "unchecked" | null;
  /** Issue #336: the design stage's checked success-case analysis (gate mode), or null (photo materials; fictional without one). */
  caseStudy: { sha256: string; counted: string[] } | null;
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
    const plan = buildPhotoPlan({ request: r.request, requestSha256: r.sha256, factsBytes: f.bytes, facts: f.facts });
    if (plan.batch.images !== r.request.max_images) throw new PromptStop("REQUEST_IMAGES_MISMATCH");
    return { ...base, directionBytes: photoBriefBytes(r.request), plan, photos: null, caseStudy: null };
  }
  const caseStudy = await readRequestCaseStudy(r.request, { home: o.home, repo: o.repo });
  const plan = buildRequestPlan({ request: r.request, requestSha256: r.sha256, factsBytes: f.bytes, facts: f.facts });
  if (plan.batch.images !== r.request.max_images) throw new PromptStop("REQUEST_IMAGES_MISMATCH");
  const photos = r.request.photo_inputs ? await resolvePhotoInputs(r.request, { runsDir: join(o.home, RUNS_DIR), mode: o.photoInputs ?? "required" }) : null;
  return { ...base, directionBytes: requestDirectionBytes(r.request), plan, photos, caseStudy };
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

/** Where root's pilot puts the run's private copy of the request (an absolute path to <dir>/<request id>.json). */
export const REQUEST_FILE_ENV = "SR_IMAGEFIRST_REQUEST_FILE";

/**
 * `--validate-request <file>`: the whole worker-side check of a request Claude is about to drop into ~/sr-runs/requests/
 * (root's quota counts a refused request too) — the file (named <id>.json, regular, no link, at most 16 KiB, outside the
 * repository), the strict schema, the facts pack (resolution, no link, size, facts_sha256), the shop's kind and the plan
 * (6 pictures), and (Issue #336) the design stage's case study in gate mode. Its SHA-256 is computed here (root later binds it with --request-sha256). Read only: no claim, no ledger,
 * no write, no network, no Codex.
 */
export async function validateRequestFile(o: { file: string; home: string; repo: string }): Promise<{ request_id: string; kind: ImagefirstRequest["kind"]; stage: "design" | "photo_materials"; request_sha256: string; facts_sha256: string; plan_sha256: string; photo_inputs: "checked" | "unchecked" | null; case_study: { sha256: string; counted: string[] } | null }> {
  const file = resolve(o.file);
  const name = basename(file);
  if (!name.endsWith(".json")) throw new PromptStop("REQUEST_FILE_NAME_MISMATCH");
  const requestId = name.slice(0, -".json".length);
  const bytes = await readChecked(file, REQUEST_MAX_BYTES, { unsafe: "REQUEST_FILE_UNSAFE", big: "REQUEST_TOO_LARGE", missing: "REQUEST_FILE_MISSING" });
  const run = await loadRequestRun({ requestFile: file, requestSha256: createHash("sha256").update(bytes).digest("hex"), requestId, home: o.home, repo: o.repo, photoInputs: "if_present" });
  return {
    request_id: run.request.id,
    kind: run.request.kind,
    stage: isPhotoRequest(run.request) ? "photo_materials" : "design",
    request_sha256: run.requestSha256,
    facts_sha256: run.plan.facts_sha256,
    plan_sha256: run.plan.plan_sha256,
    photo_inputs: run.photos === null ? null : run.photos === "unchecked" ? "unchecked" : "checked",
    case_study: run.caseStudy,
  };
}

export type RealShopRecord = {
  schema: typeof REAL_SHOP_RECORD_SCHEMA;
  request_id: string;
  shop_id: string;
  kind: "real_shop";
  request_sha256: string;
  facts_sha256: string;
  plan_sha256: string | null;
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
