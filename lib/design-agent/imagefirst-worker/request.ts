/**
 * DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 B): the files of an IMAGE_FIRST
 * request run, outside git. Read only, apart from the real shop's private run record (writeRealShopRecord).
 *
 *   the request:     the copy root validated and placed in the run's private directory (`--request-file`), named
 *                    <id>.json, a regular file (no link), at most 16 KiB, outside the repository; its bytes' SHA-256 must
 *                    equal `--request-sha256` and its id `--request` (image-first/request-prompt.ts parseRequest).
 *   the facts pack:  facts_ref.root "second-root-shops" → ~/second-root-shops/<shop_id>/facts-pack.json, or
 *                    "local-shops" → <clone>/.local-shops/<shop_id>/facts-pack.json (gitignored); no link at the root,
 *                    the shop directory or the file, its real path exactly that path, at most FACTS_MAX_BYTES, its
 *                    SHA-256 = the request's facts_sha256. Owner-verified values only (Identity Lock).
 *   the shop:        real_shop — the pack's shop_id is the request's, and it is not a fictional shop (no "fictional-"
 *                    prefix, not a research-log FICTIONAL_SHOPS slug); fictional — the research log's fictional-shop
 *                    check (assertFictionalShop) and the pack is that shop's own (the same fictional shop_id as the
 *                    committed pack).
 *   the record:      real_shop only, ~/second-root-shops/<shop_id>/runs/<id>.json (metadata: ids, codes, SHA-256s;
 *                    0700 / 0600, written once). A real shop never enters design-library/research-log (public repo).
 *
 * Failures throw PromptStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { PromptStop } from "../image-first/prompt";
import { buildRequestPlan, FACTS_MAX_BYTES, parseRequest, parseRequestFacts, REQUEST_MAX_BYTES, requestDirectionBytes, type FactsRoot, type ImagefirstRequest, type RequestPlan } from "../image-first/request-prompt";
import type { FactsPack } from "../quality-pipeline/facts-pack";
import { assertFictionalShop, FICTIONAL_SHOPS } from "../research-log/shops";

export const SHOPS_DIR = "second-root-shops";
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

export type RequestRunInputs = {
  request: ImagefirstRequest;
  requestBytes: Buffer;
  requestSha256: string;
  factsBytes: Buffer;
  facts: FactsPack;
  directionBytes: Buffer;
  plan: RequestPlan;
};

/** Everything a request run is built from, checked, and its plan (the worker and the entry each rebuild it the same way). */
export async function loadRequestRun(o: { requestFile: string; requestSha256: string; requestId: string; home: string; repo: string }): Promise<RequestRunInputs> {
  const r = await readRequestFile(o);
  const f = await readRequestFacts(r.request, { home: o.home, repo: o.repo });
  await checkRequestShop(r.request, f.facts, o.repo);
  const plan = buildRequestPlan({ request: r.request, requestSha256: r.sha256, factsBytes: f.bytes, facts: f.facts });
  if (plan.batch.images !== r.request.max_images) throw new PromptStop("REQUEST_IMAGES_MISMATCH");
  return { request: r.request, requestBytes: r.bytes, requestSha256: r.sha256, factsBytes: f.bytes, facts: f.facts, directionBytes: requestDirectionBytes(r.request), plan };
}

/** Where root's pilot puts the run's private copy of the request (an absolute path to <dir>/<request id>.json). */
export const REQUEST_FILE_ENV = "SR_IMAGEFIRST_REQUEST_FILE";

/**
 * `--validate-request <file>`: the whole worker-side check of a request Claude is about to drop into ~/sr-runs/requests/
 * (root's quota counts a refused request too) — the file (named <id>.json, regular, no link, at most 16 KiB, outside the
 * repository), the strict schema, the facts pack (resolution, no link, size, facts_sha256), the shop's kind and the plan
 * (6 pictures). Its SHA-256 is computed here (root later binds it with --request-sha256). Read only: no claim, no ledger,
 * no write, no network, no Codex.
 */
export async function validateRequestFile(o: { file: string; home: string; repo: string }): Promise<{ request_id: string; kind: ImagefirstRequest["kind"]; request_sha256: string; facts_sha256: string; plan_sha256: string }> {
  const file = resolve(o.file);
  const name = basename(file);
  if (!name.endsWith(".json")) throw new PromptStop("REQUEST_FILE_NAME_MISMATCH");
  const requestId = name.slice(0, -".json".length);
  const bytes = await readChecked(file, REQUEST_MAX_BYTES, { unsafe: "REQUEST_FILE_UNSAFE", big: "REQUEST_TOO_LARGE", missing: "REQUEST_FILE_MISSING" });
  const run = await loadRequestRun({ requestFile: file, requestSha256: createHash("sha256").update(bytes).digest("hex"), requestId, home: o.home, repo: o.repo });
  return { request_id: run.request.id, kind: run.request.kind, request_sha256: run.requestSha256, facts_sha256: run.plan.facts_sha256, plan_sha256: run.plan.plan_sha256 };
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
  use: "internal_design_reference_only";
  recorded_at: string;
};

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
