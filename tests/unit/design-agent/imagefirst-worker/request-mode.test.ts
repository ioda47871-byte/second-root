import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { generateImagesInOneRun } from "@/lib/design-agent/design-image/image-once";
import { buildPromptPlan, loadPromptInputs, NAV_LABELS, PromptStop } from "@/lib/design-agent/image-first/prompt";
import { buildRequestPlan, isRequestId, parseRequest, REQUEST_MAX_BYTES, RESERVED_REQUEST_IDS, type DesignRequest, type RequestPlan } from "@/lib/design-agent/image-first/request-prompt";
import { loadRequestAuditMaterial, requestMaterialId } from "@/lib/design-agent/imagefirst-worker/claude-audit";
import { gitCommitState, IMAGEFIRST_RUNS, type WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { deliverReview } from "@/lib/design-agent/imagefirst-worker/deliver-review";
import { jaRenderingsRefusalDetailOf, loadRequestRun, readRequestFacts, REAL_SHOP_RECORD_SCHEMA, validateRequestFile, writeRealShopRecord } from "@/lib/design-agent/imagefirst-worker/request";
import { entriesSha256 } from "@/lib/design-agent/ja-renderings/ja-renderings";
import { precheckRequestCycle, runRequestCycle } from "@/lib/design-agent/imagefirst-worker/request-cycle";
import { runLoadedRequest } from "@/lib/design-agent/imagefirst-worker/request-run";
import { BUNDLE_ID_RE, REQUEST_RUN_ID_RE } from "@/lib/design-agent/imagefirst-worker/run-directions";
import { REFERENCE_DIR_TOKEN } from "@/lib/design-agent/image-tool-limits";
import { runRequestFullPageCall } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { entryFromInbox } from "@/lib/design-agent/research-log/intake";
import { parseArgs } from "@/scripts/design-artifact/phase2f-live-cli";
import { CASE_STUDY_FILE, CASE_STUDY_REPO_FILES, caseStudyBytes, cleanupTemps, ENV, fakeCodex, git, NOW, REPO, sha, tmp, workerRepo, type Fake } from "./support";

// DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 B): IMAGE_FIRST request mode, worker
// side, end to end against a FAKE Codex. FICTIONAL fixtures only: the "real_shop" pack below is invented for the test
// (no real shop's data anywhere). No Codex, no model, no image tool, no network.

vi.setConfig({ testTimeout: 90_000 });
afterAll(cleanupTemps);

const ID = "req-test-shop-a-1";
const SHOP = "test-shop-a";
/** An invented pack in the real-shop shape (kind real_shop in the test only). */
const FACTS: FactsPack = {
  schema: "shop_facts_pack_v1",
  shop_id: SHOP,
  facts: [
    { id: "F1", key: "name", value: "架空喫茶 しずく", source_id: "S1" },
    { id: "F2", key: "category", value: "cafe", source_id: "S1" },
    { id: "F3", key: "address", value: "架空市架空町1-2-3", source_id: "S1" },
    { id: "F4", key: "description", value: "テスト用の架空の喫茶店です。実在しません。", source_id: "S1" },
    { id: "F5", key: "hours", value: "8:00〜17:00", source_id: "S1" },
    { id: "F6", key: "closed_days", value: "水曜", source_id: "S1" },
    { id: "F7", key: "phone", value: "000-0000-0000", source_id: "S1" },
    { id: "F8", key: "statement_1", value: "豆は架空の焙煎所から届きます", source_id: "S1" },
    { id: "F9", key: "service_1", value: "架空ブレンド", source_id: "S1" },
    { id: "F10", key: "service_2", value: "架空トースト", source_id: "S1" },
  ],
};
const FACTS_BYTES = Buffer.from(`${JSON.stringify(FACTS, null, 2)}\n`);
const DIRECTION = {
  name: "朝の窓辺",
  concept: "朝の光が差す窓辺のように、余白の多い静かな画面にする。",
  palette: "生成りの地に深い緑と薄い灰。",
  typography: "明朝体の大きな見出しと細いゴシックの本文。",
  layout_pc: "左右二段。左に大きな店名、右に情報をまとめる。",
  layout_sp: "一段。店名を最初の画面いっぱいに置く。",
  avoid: "派手なグラデーションや写真風の表現。",
};
const BAKERY = "design-library/research/quality-pipeline/poc/bakery/facts-pack.json";
/** Issue #336: the shop's owner-confirmed case study (invented text; it counts the repository's CP-001..003). */
const CASE_STUDY = caseStudyBytes(SHOP);
/** DEV-303 §6.1 row 3: the reference pictures a whole_page run attaches: the counted cases' first image each (owner order). */
const REFS = ["CP-001", "CP-002", "CP-003"].map((case_id, n) => ({ id: `ref-${n + 1}`, case_id, sha256: sha(readFileSync(resolve(REPO, CASE_STUDY_REPO_FILES[n + 1]!))) }));

function requestObject(over: Record<string, unknown> = {}, facts: Buffer = FACTS_BYTES): Record<string, unknown> {
  return {
    schema: "sr_imagefirst_request_v1",
    id: ID,
    shop_id: SHOP,
    kind: "real_shop",
    created_at: "2026-11-20T00:30:00Z",
    direction: DIRECTION,
    case_study: { path: CASE_STUDY_FILE, sha256: sha(CASE_STUDY) },
    facts_ref: { root: "second-root-shops", shop_id: SHOP },
    facts_sha256: sha(facts),
    // DEV-303 §6.1 row 3: a real shop's design is one whole-page picture per viewport (PC 1 + SP 1)
    layout: "whole_page",
    max_images: 2,
    codex_runs: 1,
    ...over,
  };
}
/** The section split (no layout, PC 2 + SP 4): fictional / research requests only. */
const SECTION_SPLIT = { layout: undefined, max_images: 6 } as const;
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const codeOf = async (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code ?? String(e));
const syncCode = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (error) {
    return error instanceof PromptStop ? error.code : String(error);
  }
};

/** The entry's request-mode arguments, read from its source (a drift between the cycle's argv and the entry fails here). */
const ENTRY_SRC = readFileSync(resolve(REPO, "scripts/design-artifact/image-first-generate.ts"), "utf8");
const REQUEST_VALUES = new Set([...(/const REQUEST_VALUES = new Set\(\[([^\]]*)\]\)/.exec(ENTRY_SRC)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!));

/** image-first-generate.ts requestMain(), in-process: the same arguments, loadRequestRun and runRequestFullPageCall. */
async function requestEntry(argv: string[], w: { repo: string; home: string; ledgerDir: string; fake: Fake; signal?: AbortSignal }): Promise<BoundedResult> {
  const line = (o: object, code: number): BoundedResult => ({ code, signal: null, stdout: `${JSON.stringify(o)}\n`, stderr: "", timedOut: false });
  const args = parseArgs(argv, new Set(), REQUEST_VALUES);
  const chars = Number(args?.get("--expected-prompt-chars"));
  if (!args || [...REQUEST_VALUES].some((f) => !args.has(f)) || !Number.isInteger(chars)) return line({ status: "refused", code: "USAGE" }, 2);
  let run;
  try {
    run = await loadRequestRun({ requestFile: args.get("--request-file")!, requestSha256: args.get("--request-sha256")!, requestId: args.get("--request-id")!, home: w.home, repo: w.repo });
  } catch (error) {
    return line({ status: "refused", code: error instanceof PromptStop ? error.code : "REQUEST_UNREADABLE" }, 2);
  }
  const result = await runLoadedRequest(
    {
      run,
      expected: { promptSha256: args.get("--expected-prompt-sha256")!, promptChars: chars, commit: args.get("--expected-commit")!, planSha256: args.get("--expected-plan-sha256")! },
      outDir: args.get("--out")!,
      repoRoot: w.repo,
      ...(w.signal ? { signal: w.signal } : {}),
    },
    {
      ledger: openLedger(w.ledgerDir),
      commit: () => gitCommitState(w.repo, ENV),
      preflight: async () => null,
      now: () => NOW,
      batch: async (o) => {
        const r = await generateImagesInOneRun({ sandbox: w.fake.sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: w.fake.tmpBase, maxImages: o.maxImages, ...(o.inputImages ? { inputImages: o.inputImages } : {}), ...(o.referenceImages ? { referenceImages: o.referenceImages } : {}), ...(o.signal === undefined ? {} : { signal: o.signal }) });
        return { images: r.images, outcome: r.outcome, stopCode: r.stopCode, imageCalls: r.imageCalls, imageFailed: r.imageFailed, imageCallIds: r.imageCallIds ?? [], threadId: r.threadId, cliVersion: r.cliVersion, model: r.model };
      },
    },
  );
  if (result.status === "succeeded") return line({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id }, 0);
  return line({ status: "stopped", code: result.code, stage: result.stage }, result.stage === "precheck" ? 2 : 1);
}

/** One worker world: a clone, a home with ~/second-root-shops, the runs / state / ledger dirs, root's request copy. */
function world(o: { request?: Record<string, unknown>; facts?: Buffer; shopDir?: string; id?: string; caseStudy?: Buffer | null } = {}) {
  const home = tmp("sr-req-home-");
  const repo = workerRepo(undefined, { ".gitignore": Buffer.from("/.local-shops/\n") });
  const shopDir = join(home, "second-root-shops", o.shopDir ?? SHOP);
  mkdirSync(shopDir, { recursive: true });
  writeFileSync(join(shopDir, "facts-pack.json"), o.facts ?? FACTS_BYTES);
  if (o.caseStudy !== null) writeFileSync(join(shopDir, CASE_STUDY_FILE), o.caseStudy ?? CASE_STUDY);
  const runsDir = join(home, "sr-runs");
  mkdirSync(runsDir, { mode: 0o700 });
  const stateDir = join(home, "state");
  const ledgerDir = join(home, "ledger");
  const id = o.id ?? ID;
  // root's validated copy in the run's private directory (outside the clone)
  const privateDir = join(runsDir, "requests-private", id);
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const requestObj = o.request ?? requestObject({}, o.facts ?? FACTS_BYTES);
  const requestBytes = bytesOf(requestObj);
  const requestFile = join(privateDir, `${id}.json`);
  writeFileSync(requestFile, requestBytes);
  const fake = fakeCodex(requestObj.layout === "whole_page" ? "two" : "six");
  const invoked: string[][] = [];
  const opts = { repoRoot: repo, stateDir, runsDir, home, requestId: id, requestSha256: sha(requestBytes), requestFile };
  const deps = {
    commit: () => gitCommitState(repo, ENV),
    ledger: openLedger(ledgerDir),
    now: () => NOW,
    invoke: async (argv: string[], signal?: AbortSignal) => {
      invoked.push(argv);
      return requestEntry(argv, { repo, home, ledgerDir, fake, ...(signal ? { signal } : {}) });
    },
  };
  const cycle = () => runRequestCycle(opts, deps);
  return { home, repo, runsDir, stateDir, ledgerDir, requestFile, requestBytes, fake, invoked, opts, deps, cycle, id };
}

describe("DEV-303 request schema (strict; root validates only the envelope)", () => {
  const ok = bytesOf(requestObject());
  it("accepts the documented request, bound to root's SHA-256 and id", () => {
    const r = parseRequest(ok, sha(ok), ID);
    expect(r.request.kind).toBe("real_shop");
    expect(r.sha256).toBe(sha(ok));
  });
  it("refuses an oversize file, extra fields, wrong counts, a SHA or id mismatch, reserved ids", () => {
    const big = Buffer.concat([ok, Buffer.alloc(REQUEST_MAX_BYTES, 0x20)]);
    expect(syncCode(() => parseRequest(big, sha(big), ID))).toBe("REQUEST_TOO_LARGE");
    for (const over of [{ extra: 1 }, { max_images: 5 }, { max_images: 7 }, { codex_runs: 2 }, { kind: "real" }, { created_at: "2026-11-20 00:30" }, { facts_ref: { root: "home", shop_id: SHOP } }, { facts_ref: { root: "local-shops", shop_id: "other-shop" } }, { facts_ref: { root: "local-shops", shop_id: SHOP } }, { created_at: "2026-11-20T00:30:00.000Z" }, { created_at: "2026-11-20T00:30:00+09:00" }, { direction: { ...DIRECTION, extra: "x" } }, { facts_sha256: "x" }]) {
      const b = bytesOf(requestObject(over));
      expect(syncCode(() => parseRequest(b, sha(b), ID)), JSON.stringify(over)).toBe("REQUEST_INVALID");
    }
    expect(syncCode(() => parseRequest(ok, sha("other"), ID))).toBe("REQUEST_SHA_MISMATCH");
    expect(syncCode(() => parseRequest(ok, sha(ok), "req-test-shop-b-1"))).toBe("REQUEST_ID_MISMATCH");
    expect(syncCode(() => parseRequest(ok, sha(ok), "hoshigama-imagefirst-d3-20261120-01"))).toBe("REQUEST_ID_INVALID");
    expect(syncCode(() => parseRequest(ok, sha(ok), "previews"))).toBe("REQUEST_ID_INVALID");
    expect(syncCode(() => parseRequest(ok, sha(ok), "test-shop-a-1"))).toBe("REQUEST_ID_INVALID");
    expect(syncCode(() => parseRequest(ok, sha(ok), "req-imagefirst-x"))).toBe("REQUEST_ID_RESERVED");
    expect(syncCode(() => parseRequest(ok, sha(ok), "../x"))).toBe("REQUEST_ID_INVALID");
    expect(syncCode(() => parseRequest(Buffer.from("{"), sha("{"), ID))).toBe("REQUEST_INVALID");
  });
  it("refuses URLs, HTML, prompt fences, control characters and plain fact signs in the direction", () => {
    for (const bad of ["https://example.com を参考に", "www.example.jp 風", "<b>太字</b>", "見出し<<<", "改行\nあり", "電話 052-123-4567 を大きく", "価格は500円", "メール a@b", " 前に空白", "example.com の雰囲気", "見出しに「本日限定」と書く", "『特製』の文字", "\"Fresh\" を大きく", "it's", "“新作”", "‘印’"]) {
      const b = bytesOf(requestObject({ direction: { ...DIRECTION, concept: bad } }));
      expect(syncCode(() => parseRequest(b, sha(b), ID)), bad).toBe("REQUEST_DIRECTION_UNSAFE");
    }
    const long = bytesOf(requestObject({ direction: { ...DIRECTION, name: "あ".repeat(41) } }));
    expect(syncCode(() => parseRequest(long, sha(long), ID))).toBe("REQUEST_INVALID");
  });
  it("the worker's request id rule = the schema's (minus reserved ids), disjoint from every approval id", () => {
    for (const id of [ID, "req-abc", "req-ab", "req--ab", `req-${"x".repeat(59)}`, `req-${"x".repeat(60)}`, "abc", "req-Abc", "req-a_b", "hoshigama-imagefirst-d3-20261120-01", "req-imagefirst-1", ...RESERVED_REQUEST_IDS]) {
      expect(REQUEST_RUN_ID_RE.test(id), id).toBe(isRequestId(id));
    }
    expect(BUNDLE_ID_RE.test("hoshigama-imagefirst-d4-20261120-01")).toBe(true);
    expect(isRequestId("hoshigama-imagefirst-d4-20261120-01")).toBe(false);
  });
});

describe("DEV-303 the facts pack a request names (outside git, no link, its SHA-256)", () => {
  it("refuses a symlinked facts file or shop directory, a SHA mismatch, a missing pack", async () => {
    const w = world();
    const request = parseRequest(w.requestBytes, sha(w.requestBytes), ID).request;
    const places = { home: w.home, repo: w.repo };
    expect((await readRequestFacts(request, places)).facts.shop_id).toBe(SHOP);
    const shopDir = join(w.home, "second-root-shops", SHOP);
    const elsewhere = tmp("sr-req-else-");
    writeFileSync(join(elsewhere, "facts-pack.json"), FACTS_BYTES);
    rmSync(join(shopDir, "facts-pack.json"));
    symlinkSync(join(elsewhere, "facts-pack.json"), join(shopDir, "facts-pack.json"));
    expect(await codeOf(readRequestFacts(request, places))).toBe("FACTS_PATH_UNSAFE");
    rmSync(shopDir, { recursive: true });
    symlinkSync(elsewhere, shopDir);
    expect(await codeOf(readRequestFacts(request, places))).toBe("FACTS_PATH_UNSAFE");
    rmSync(shopDir);
    expect(await codeOf(readRequestFacts(request, places))).toBe("FACTS_MISSING");
    mkdirSync(shopDir);
    writeFileSync(join(shopDir, "facts-pack.json"), Buffer.concat([FACTS_BYTES, Buffer.from(" ")]));
    expect(await codeOf(readRequestFacts(request, places))).toBe("FACTS_SHA_MISMATCH");
  });

  it("refuses a real_shop request on a fictional shop and a pack of another shop; a fictional request needs the fictional check", async () => {
    const bakery = readFileSync(resolve(REPO, BAKERY));
    const fictionalAsReal = world({ request: requestObject({ shop_id: "hoshigama", facts_ref: { root: "second-root-shops", shop_id: "hoshigama" } }, bakery), facts: bakery, shopDir: "hoshigama" });
    expect((await fictionalAsReal.cycle()).report).toMatchObject({ status: "refused", code: "REAL_SHOP_IS_FICTIONAL", invoked: false });
    const other = Buffer.from(JSON.stringify({ ...FACTS, shop_id: "test-shop-b" }));
    expect((await world({ request: requestObject({}, other), facts: other }).cycle()).report.code).toBe("FACTS_SHOP_MISMATCH");
    const notListed = world({ request: requestObject({ kind: "fictional", ...SECTION_SPLIT }) });
    expect((await notListed.cycle()).report.code).toBe("SHOP_NOT_FICTIONAL");
    expect(notListed.fake.execs + fictionalAsReal.fake.execs).toBe(0);
  });

  it("a request file inside the clone, a linked one, or one named for another id is refused before anything", async () => {
    const w = world();
    const inRepo = join(w.repo, `${ID}.json`);
    writeFileSync(inRepo, w.requestBytes);
    expect(await codeOf(loadRequestRun({ requestFile: inRepo, requestSha256: sha(w.requestBytes), requestId: ID, home: w.home, repo: w.repo }))).toBe("REQUEST_FILE_IN_REPO");
    rmSync(inRepo);
    const link = join(tmp("sr-req-link-"), `${ID}.json`);
    symlinkSync(w.requestFile, link);
    expect(await codeOf(loadRequestRun({ requestFile: link, requestSha256: sha(w.requestBytes), requestId: ID, home: w.home, repo: w.repo }))).toBe("REQUEST_FILE_UNSAFE");
    expect(await codeOf(loadRequestRun({ requestFile: w.requestFile, requestSha256: sha(w.requestBytes), requestId: "req-test-shop-a-2", home: w.home, repo: w.repo }))).toBe("REQUEST_FILE_NAME_MISMATCH");
    // a link on a directory of the path (root hands a real path) is refused too
    const linkedDir = join(tmp("sr-req-ldir-"), "via");
    symlinkSync(join(w.runsDir, "requests-private", ID), linkedDir);
    expect(await codeOf(loadRequestRun({ requestFile: join(linkedDir, `${ID}.json`), requestSha256: sha(w.requestBytes), requestId: ID, home: w.home, repo: w.repo }))).toBe("REQUEST_FILE_UNSAFE");
  });

  it("--validate-request's check: valid, or a fixed code; it claims, writes and invokes nothing", async () => {
    const w = world();
    const before = readdirSync(w.home).sort();
    expect(await validateRequestFile({ file: w.requestFile, home: w.home, repo: w.repo })).toMatchObject({ request_id: ID, kind: "real_shop", request_sha256: sha(w.requestBytes), facts_sha256: sha(FACTS_BYTES) });
    const bad = join(tmp("sr-req-val-"), `${ID}.json`);
    writeFileSync(bad, bytesOf(requestObject({ max_images: 4 })));
    expect(await codeOf(validateRequestFile({ file: bad, home: w.home, repo: w.repo }))).toBe("REQUEST_INVALID");
    writeFileSync(bad, bytesOf(requestObject({ facts_sha256: sha("other") })));
    expect(await codeOf(validateRequestFile({ file: bad, home: w.home, repo: w.repo }))).toBe("FACTS_SHA_MISMATCH");
    const misnamed = join(tmp("sr-req-val-"), "req-other-id.json");
    writeFileSync(misnamed, w.requestBytes);
    expect(await codeOf(validateRequestFile({ file: misnamed, home: w.home, repo: w.repo }))).toBe("REQUEST_ID_MISMATCH");
    expect(readdirSync(w.home).sort()).toEqual(before);
    expect(existsSync(w.stateDir) || existsSync(w.ledgerDir) || w.invoked.length > 0).toBe(false);
  });

  it("Issue #336: a real_shop design request needs an owner-confirmed case study of ≥ 3 viewed originals (validate and worker alike)", async () => {
    const w = world();
    expect((await validateRequestFile({ file: w.requestFile, home: w.home, repo: w.repo })).case_study).toEqual({ sha256: sha(CASE_STUDY), counted: ["CP-001", "CP-002", "CP-003"] });
    const dir = tmp("sr-req-cs-");
    const check = async (request: Record<string, unknown>, caseStudy?: Buffer) => {
      if (caseStudy) writeFileSync(join(w.home, "second-root-shops", SHOP, "case-study-2.json"), caseStudy);
      const file = join(dir, `${ID}.json`);
      writeFileSync(file, bytesOf(request));
      return codeOf(validateRequestFile({ file, home: w.home, repo: w.repo }));
    };
    const named = (b: Buffer) => requestObject({ case_study: { path: "case-study-2.json", sha256: sha(b) } });
    // no case study at all
    expect(await check(requestObject({ case_study: undefined }))).toBe("CASE_STUDY_REQUIRED");
    expect(syncCode(() => parseRequest(bytesOf(requestObject({ case_study: undefined })), sha(bytesOf(requestObject({ case_study: undefined }))), ID))).toBe("CASE_STUDY_REQUIRED");
    // a path that is not a plain file name, or the facts pack itself
    expect(await check(requestObject({ case_study: { path: "../case-study.json", sha256: sha(CASE_STUDY) } }))).toBe("REQUEST_INVALID");
    expect(await check(requestObject({ case_study: { path: "facts-pack.json", sha256: sha(FACTS_BYTES) } }))).toBe("REQUEST_INVALID");
    // missing, or bytes other than the request names
    expect(await check(requestObject({ case_study: { path: "absent.json", sha256: sha(CASE_STUDY) } }))).toBe("CASE_STUDY_RECORD_MISSING");
    expect(await check(requestObject({ case_study: { path: CASE_STUDY_FILE, sha256: sha("other") } }))).toBe("CASE_STUDY_RECORD_SHA_MISMATCH");
    // a draft (no owner confirmation), too few originals, another shop's record
    const draft = caseStudyBytes(SHOP, { owner_confirmation: undefined });
    expect(await check(named(draft), draft)).toBe("CASE_STUDY_NOT_OWNER_CONFIRMED");
    const two = Buffer.from(JSON.stringify({ ...JSON.parse(CASE_STUDY.toString()), cases: JSON.parse(CASE_STUDY.toString()).cases.slice(0, 2), owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001", "CP-002"], page_sha256: "0".repeat(64) } }));
    expect(await check(named(two), two)).toBe("CASE_STUDY_TOO_FEW_ORIGINALS");
    // a confirmation that is not bound to the page this record renders to
    const wrongPage = caseStudyBytes(SHOP, { owner_confirmation: { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001", "CP-002", "CP-003"], page_sha256: "0".repeat(64) } });
    expect(await check(named(wrongPage), wrongPage)).toBe("CASE_STUDY_PAGE_MISMATCH");
    const other = caseStudyBytes("test-shop-b");
    expect(await check(named(other), other)).toBe("CASE_STUDY_SHOP_MISMATCH");
    // a linked record is refused
    symlinkSync(join(w.home, "second-root-shops", SHOP, CASE_STUDY_FILE), join(w.home, "second-root-shops", SHOP, "linked.json"));
    expect(await check(requestObject({ case_study: { path: "linked.json", sha256: sha(CASE_STUDY) } }))).toBe("CASE_STUDY_RECORD_UNSAFE");
    // the worker's own load refuses the same way (nothing invoked)
    const noCase = world({ caseStudy: null });
    expect((await noCase.cycle()).report.status).toBe("refused");
    expect(noCase.invoked).toEqual([]);
    expect(await codeOf(loadRequestRun({ requestFile: noCase.requestFile, requestSha256: sha(noCase.requestBytes), requestId: ID, home: noCase.home, repo: noCase.repo }))).toBe("CASE_STUDY_RECORD_MISSING");
  });

  it("Issue #336: a fictional design request works without a case study, and one it names is checked", async () => {
    const bakery = readFileSync(resolve(REPO, BAKERY));
    const id = "req-hoshigama-cs-1";
    const cs = caseStudyBytes("hoshigama");
    const w = world({ id, request: requestObject({ id, kind: "fictional", ...SECTION_SPLIT, case_study: { path: CASE_STUDY_FILE, sha256: sha(cs) }, shop_id: "hoshigama", facts_ref: { root: "second-root-shops", shop_id: "hoshigama" } }, bakery), facts: bakery, shopDir: "hoshigama", caseStudy: cs });
    expect((await validateRequestFile({ file: w.requestFile, home: w.home, repo: w.repo })).case_study?.counted).toEqual(["CP-001", "CP-002", "CP-003"]);
    const without = world({ id, request: requestObject({ id, kind: "fictional", ...SECTION_SPLIT, case_study: undefined, shop_id: "hoshigama", facts_ref: { root: "second-root-shops", shop_id: "hoshigama" } }, bakery), facts: bakery, shopDir: "hoshigama", caseStudy: null });
    expect((await validateRequestFile({ file: without.requestFile, home: without.home, repo: without.repo })).case_study).toBeNull();
  });
});

describe("DEV-303 request prompts: text from the facts pack only; the pinned prompts unchanged", () => {
  // DEV-303 §6.1 row 3: parseRequest refuses a real_shop section split; the pure builder's section-split prompts are
  // unchanged (pinned), so they are built here from the same request object without the layout
  const parsed = parseRequest(bytesOf(requestObject()), sha(bytesOf(requestObject())), ID).request as DesignRequest;
  const request = { ...parsed, max_images: 6 } as DesignRequest;
  delete (request as { layout?: unknown }).layout;
  const plan = buildRequestPlan({ request, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS });
  const parts = [...plan.viewports.desktop_1440.parts, ...plan.viewports.mobile_390.parts];

  it("PC 2 + SP 4 = 6 pictures in one batch; every quoted text in a prompt is a facts value or a facts-schema label", () => {
    expect([plan.viewports.desktop_1440.parts.length, plan.viewports.mobile_390.parts.length, plan.batch.images]).toEqual([2, 4, 6]);
    const values = new Set(FACTS.facts.map((f) => f.value));
    const labels = new Set(NAV_LABELS.map(([, l]) => l));
    for (const p of parts) {
      const quoted = [...p.prompt.matchAll(/「([^」]+)」/g)].map((m) => m[1]!);
      // section ids are quoted as 区画「id」; everything else quoted must be a fact value or a label word
      const sectionIds = new Set(plan.viewports.desktop_1440.section_order);
      for (const q of quoted) expect(values.has(q) || labels.has(q) || sectionIds.has(q), `${p.name}: ${q}`).toBe(true);
      expect(p.prompt).toContain("写真や写真風の絵は使わず");
      expect(p.prompt).toContain("実在の店。この画像は社内のデザインの参考だけに使い");
      expect(p.prompt).not.toMatch(/https?:|<[a-z]/i);
      // the category code is context, never a text to draw
      expect(quoted).not.toContain("cafe");
    }
    expect(plan.batch.prompt).toContain("internal design reference only");
    expect(plan.batch.prompt).not.toContain("The shop is fictional.");
    // every fact a section shows reaches some prompt exactly
    for (const key of ["name", "description", "statement_1", "service_1", "service_2", "hours", "closed_days", "address", "phone"]) expect(parts.some((p) => p.prompt.includes(`「${FACTS.facts.find((f) => f.key === key)!.value}」`)), key).toBe(true);
  });

  it("deterministic; a direction quoting a fact, or too few facts for 4 sections, is refused", () => {
    expect(buildRequestPlan({ request, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS }).plan_sha256).toBe(plan.plan_sha256);
    const quoting: DesignRequest = { ...request, direction: { ...request.direction, concept: "架空喫茶 しずく の名前を大きく" } };
    expect(syncCode(() => buildRequestPlan({ request: quoting, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS }))).toBe("REQUEST_DIRECTION_HAS_FACT");
    const few: FactsPack = { ...FACTS, facts: FACTS.facts.filter((f) => ["name", "description", "address"].includes(f.key)) };
    expect(syncCode(() => buildRequestPlan({ request, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: few }))).toBe("REQUEST_FACTS_TOO_FEW");
    const split: FactsPack = { ...FACTS, facts: FACTS.facts.filter((f) => !f.key.startsWith("service") && !f.key.startsWith("statement")) };
    expect(buildRequestPlan({ request, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: split }).viewports.desktop_1440.section_order).toEqual(["hero", "intro", "visit", "hours"]);
  });

  it("d1 / d3 / d4 pinned plans are byte-identical to their pins", async () => {
    const reader = (p: string) => Promise.resolve(readFileSync(resolve(REPO, p)));
    for (const k of ["d3", "d4"] as const) {
      const pinned = buildPromptPlan(await loadPromptInputs(reader, k));
      expect([pinned.plan_sha256, pinned.batch.sha256, pinned.batch.chars], k).toEqual([IMAGEFIRST_RUNS[k].planSha256, IMAGEFIRST_RUNS[k].promptSha256, IMAGEFIRST_RUNS[k].promptChars]);
    }
    expect(buildPromptPlan(await loadPromptInputs(reader, "d1")).direction_key).toBe("d1");
  });
});

describe("DEV-303 the request cycle end to end (fake Codex)", () => {
  it("real_shop: one invocation, a whole-page PC 1 + SP 1 in a private run outside the clone, one use per request id, delivered, private record", async () => {
    const w = world();
    expect((await precheckRequestCycle(w.opts, w.deps)).report).toMatchObject({ status: "would_run", approval_id: ID, kind: "real_shop" });
    const { report, run } = await w.cycle();
    expect(report).toMatchObject({ mode: "request", status: "succeeded", code: null, invoked: true, approval_id: ID, kind: "real_shop" });
    expect([w.invoked.length, w.fake.execs]).toEqual([1, 1]);
    const runDir = report.run_dir!;
    expect(runDir.startsWith(w.runsDir)).toBe(true);
    expect(runDir.startsWith(w.repo)).toBe(false);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(runDir, "parts")).sort()).toEqual(["pc-1.png", "sp-1.png"]);
    expect(readFileSync(join(runDir, "facts-pack.json"))).toEqual(FACTS_BYTES);
    const receipt = JSON.parse(readFileSync(report.receipt!, "utf8")) as WorkerReceipt;
    expect(receipt).toMatchObject({ status: "succeeded", mode: "request", kind: "real_shop", request_id: ID, approval_id: ID, plan_id: ID, shop: SHOP, direction: "request", packet_sha256: sha(w.requestBytes), request_sha256: sha(w.requestBytes), facts_sha256: sha(FACTS_BYTES), counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, verified: true, images_total: 2, design_layout: "whole_page" });
    // DEV-303 §6.1 row 3: the success-case references by id, case and SHA-256 only (the counted cases, owner order)
    expect(receipt.reference_images).toEqual(REFS);
    expect(run!.referenceImages).toEqual(REFS);
    expect(JSON.parse(readFileSync(join(runDir, "reference-inputs.json"), "utf8"))).toEqual({ schema: "image_first_reference_inputs_v0", layout: "whole_page", references: REFS });
    expect(JSON.parse(readFileSync(join(runDir, "run-plan.json"), "utf8")).viewports.desktop_1440).toMatchObject({ mode: "whole_page", section_order: ["page"] });
    // Issue #336 follow-up: the checked case study is bound by its SHA-256 (an allowlisted field; never its path or content)
    expect(receipt.case_study_sha256).toBe(sha(CASE_STUDY));
    expect(run!.caseStudySha256).toBe(sha(CASE_STUDY));
    expect(JSON.stringify(receipt)).not.toContain(CASE_STUDY_FILE);
    // the receipt holds no prompt and no facts value
    expect(JSON.stringify(receipt)).not.toContain("架空喫茶");
    // nothing was written into the clone (git sees a clean tree)
    expect(git(w.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");

    // one use per request id: the claim refuses; with the claim gone, the ledger still refuses; nothing invoked
    expect((await w.cycle()).report).toMatchObject({ status: "refused", code: "REQUEST_ALREADY_CLAIMED", invoked: false });
    rmSync(join(w.stateDir, "claims", `${ID}.used`));
    expect((await w.cycle()).report).toMatchObject({ status: "refused", code: "REQUEST_ALREADY_USED", invoked: false });
    expect((await precheckRequestCycle(w.opts, w.deps)).report.code).toBe("REQUEST_ALREADY_USED");
    expect([w.invoked.length, w.fake.execs]).toEqual([1, 1]);
    writeFileSync(join(w.stateDir, "claims", `${ID}.used`), `${JSON.stringify({ approval_id: ID, claimed_at: new Date(NOW).toISOString() })}\n`, { mode: 0o600 });

    // the review hand-off with the request id as the bundle id
    const d = await deliverReview({ approvalId: ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
    expect(d).toMatchObject({ status: "delivered", approval_id: ID, bundle: "sealed" });
    const inbox = join(w.runsDir, "review-inbox");
    const manifest = JSON.parse(readFileSync(join(inbox, ID, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ bundle_id: ID, approval_id: ID, shop: SHOP, direction: "request", mode: "request", kind: "real_shop", counts: { pc: 1, sp: 1 } });
    expect(existsSync(join(inbox, "previews", ID, "INDEX.json"))).toBe(true);

    // the audit material comes from the run itself, never the repository
    const material = await loadRequestAuditMaterial(w.runsDir, ID);
    expect(material.direction.id).toBe(requestMaterialId(ID));
    expect(material.facts).toContainEqual({ key: "name", value: "架空喫茶 しずく" });

    // the research log never takes a real shop's run
    expect(await codeOf(entryFromInbox({ repo: REPO, inbox, bundleId: ID, shop: "hoshigama", direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-20T02:00:00Z" }))).toBe("REAL_SHOP_NOT_LOGGED");

    // the private record: ~/second-root-shops/<shop_id>/runs/<id>.json, metadata only
    const path = await writeRealShopRecord({
      home: w.home,
      repo: w.repo,
      record: { schema: REAL_SHOP_RECORD_SCHEMA, request_id: ID, shop_id: SHOP, kind: "real_shop", request_sha256: run!.requestSha256, facts_sha256: run!.factsSha256, plan_sha256: run!.planSha256, case_study_sha256: run!.caseStudySha256, design_layout: "whole_page", reference_images: run!.referenceImages!, commit: run!.commit, run: { status: "succeeded", code: null, invoked: true, receipt_written: true }, review: { status: d.status, code: d.code, bundle_sha256: d.bundle_sha256 }, use: "internal_design_reference_only", recorded_at: "2026-11-20T02:00:00Z" },
    });
    expect(path).toBe(join(w.home, "second-root-shops", SHOP, "runs", `${ID}.json`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("架空喫茶");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ case_study_sha256: sha(CASE_STUDY), facts_sha256: sha(FACTS_BYTES), design_layout: "whole_page", reference_images: REFS });
    expect(readFileSync(path, "utf8")).not.toMatch(/design-library|\.webp|\//);
    expect(await codeOf(writeRealShopRecord({ home: w.home, repo: w.repo, record: JSON.parse(readFileSync(path, "utf8")) }))).toBe("RECORD_EXISTS");
    expect(git(w.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("DEV-303 §6.1 row 3: the success-case references reach the one exec as --image copies and ABSOLUTE staged paths in the prompt; the run keeps only the token", async () => {
    const w = world();
    const seen: { stdin: string; argv: string[]; staged: Record<string, string> }[] = [];
    const base = w.fake.sandbox.run.bind(w.fake.sandbox);
    w.fake.sandbox.run = async (a, o) => {
      if (a[0] === "exec") {
        const dir = join(o.workDir!, "inputs");
        seen.push({ stdin: String(o.input ?? ""), argv: [...a], staged: Object.fromEntries(readdirSync(dir).sort().map((n) => [n, sha(readFileSync(join(dir, n)))])) });
      }
      return base(a, o);
    };
    const { report } = await w.cycle();
    expect(report.status).toBe("succeeded");
    expect(seen).toHaveLength(1);
    const argv = seen[0]!.argv;
    const inputs = join(argv[argv.indexOf("--cd") + 1]!, "inputs");
    expect(inputs.startsWith("/")).toBe(true);
    const names = ["ref-1.webp", "ref-2.webp", "ref-3.webp"];
    expect(seen[0]!.staged).toEqual(Object.fromEntries(names.map((n, k) => [n, REFS[k]!.sha256])));
    expect(argv.filter((x) => x.startsWith("--image="))).toEqual(names.map((n) => `--image=${join(inputs, n)}`));
    expect(seen[0]!.stdin).toContain(`set referenced_image_paths to exactly [${names.map((n) => `"${join(inputs, n)}"`).join(", ")}]`);
    expect(seen[0]!.stdin).not.toContain(REFERENCE_DIR_TOKEN);
    // the private run keeps the pinned prompt (the token, never the temporary path); the copies are gone with the work dir
    const batch = readFileSync(join(report.run_dir!, "prompts", "batch.txt"), "utf8");
    expect(batch).toContain(`"${REFERENCE_DIR_TOKEN}/ref-1.webp"`);
    expect(batch).not.toContain(inputs);
    expect(existsSync(inputs)).toBe(false);
    expect(readFileSync(report.receipt!, "utf8")).not.toMatch(/design-library|\.webp|inputs\//);
    // review L4: delivery holds the receipt's reference list to the run's own reference-inputs.json
    const deliver = () => codeOf(deliverReview({ approvalId: ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true }));
    const receiptPath = report.receipt!;
    const original = readFileSync(receiptPath, "utf8");
    const rewrite = (path: string, text: string) => {
      rmSync(path);
      writeFileSync(path, text, { mode: 0o600 });
    };
    // a receipt whose list was reordered (each entry still well-formed): REFERENCE_INPUTS_MISMATCH
    const reordered = JSON.parse(original) as { reference_images: { id: string }[] };
    reordered.reference_images = [REFS[1]!, REFS[0]!, REFS[2]!].map((r, n) => ({ ...r, id: `ref-${n + 1}` }));
    rewrite(receiptPath, JSON.stringify(reordered));
    expect(await deliver()).toBe("REFERENCE_INPUTS_MISMATCH");
    // the receipt as written, but the run's reference-inputs.json changed: REFERENCE_INPUTS_MISMATCH
    rewrite(receiptPath, original);
    const inputsPath = join(report.run_dir!, "reference-inputs.json");
    const inputsOriginal = readFileSync(inputsPath, "utf8");
    const edited = JSON.parse(inputsOriginal) as { references: { sha256: string }[] };
    edited.references[2]!.sha256 = sha("another picture");
    rewrite(inputsPath, JSON.stringify(edited));
    expect(await deliver()).toBe("REFERENCE_INPUTS_MISMATCH");
    rewrite(inputsPath, inputsOriginal);
    // a forged (over-long) list is refused before delivery too
    const forged = JSON.parse(original) as Record<string, unknown>;
    forged.reference_images = [...REFS, ...REFS, ...REFS].map((r, n) => ({ ...r, id: `ref-${n + 1}` }));
    rewrite(receiptPath, JSON.stringify(forged));
    expect(await deliver()).toBe("REFERENCE_INPUTS_MISMATCH");
    // with both restored, it is delivered
    rewrite(receiptPath, original);
    expect(await deliver()).toBe("resolved");
  });

  it("DEV-303 §6.1 change 4: approved Japanese renderings — gate-checked, shown with 原文 in the prompt, bound by SHA-256 in plan, receipt and record", async () => {
    const entries = [{ fact_key: "statement_1", source_text: "豆は架空の焙煎所から届きます", ja_text: "架空の焙煎所から豆が届きます" }];
    const jaRecord = (over: Record<string, unknown> = {}) => Buffer.from(`${JSON.stringify({ schema: "sr_ja_renderings_v1", shop_id: SHOP, entries, owner_confirmation: { confirmed: true, confirmed_at: "2026-11-25T03:00:00Z", entries_sha256: entriesSha256(entries) }, ...over }, null, 2)}\n`);
    const JA = jaRecord();
    const w = world({ request: requestObject({ ja_renderings: { path: "ja-renderings.json", sha256: sha(JA) } }) });
    writeFileSync(join(w.home, "second-root-shops", SHOP, "ja-renderings.json"), JA);
    expect(await validateRequestFile({ file: w.requestFile, home: w.home, repo: w.repo })).toMatchObject({ layout: "whole_page", ja_renderings: { sha256: sha(JA), keys: ["statement_1"] } });
    const { report, run } = await w.cycle();
    expect(report.status).toBe("succeeded");
    const prompt = readFileSync(join(report.run_dir!, "prompts", "pc-1.txt"), "utf8");
    expect(prompt).toContain("- 「架空の焙煎所から豆が届きます」（オーナーが承認した日本語訳。原文: 「豆は架空の焙煎所から届きます」。画像には日本語訳だけを書き、原文は書かない）");
    const receipt = JSON.parse(readFileSync(report.receipt!, "utf8")) as WorkerReceipt;
    expect(receipt.ja_renderings_sha256).toBe(sha(JA));
    expect(run!.jaRenderingsSha256).toBe(sha(JA));
    expect(readFileSync(report.receipt!, "utf8")).not.toContain("ja-renderings.json");
    const plan = (await loadRequestRun({ requestFile: w.requestFile, requestSha256: sha(w.requestBytes), requestId: ID, home: w.home, repo: w.repo })).plan as RequestPlan;
    expect(plan.ja_renderings_sha256).toBe(sha(JA));
    // sealed and delivered as a whole_page run with the field
    expect((await deliverReview({ approvalId: ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true })).status).toBe("delivered");
    // the real shop's private record keeps the SHA-256 only
    const path = await writeRealShopRecord({ home: w.home, repo: w.repo, record: { schema: REAL_SHOP_RECORD_SCHEMA, request_id: ID, shop_id: SHOP, kind: "real_shop", request_sha256: run!.requestSha256, facts_sha256: run!.factsSha256, plan_sha256: run!.planSha256, case_study_sha256: run!.caseStudySha256, design_layout: "whole_page", reference_images: run!.referenceImages!, ja_renderings_sha256: run!.jaRenderingsSha256!, commit: run!.commit, run: { status: "succeeded", code: null, invoked: true, receipt_written: true }, review: null, use: "internal_design_reference_only", recorded_at: "2026-11-25T04:00:00Z" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ ja_renderings_sha256: sha(JA) });
    expect(readFileSync(path, "utf8")).not.toContain("焙煎所");

    // refusals (validate and worker alike; nothing invoked)
    const check = async (bytes: Buffer, over: Record<string, unknown> = {}) => {
      const v = world({ request: requestObject({ ja_renderings: { path: "ja-renderings.json", sha256: sha(bytes) }, ...over }) });
      writeFileSync(join(v.home, "second-root-shops", SHOP, "ja-renderings.json"), bytes);
      const refused = await validateRequestFile({ file: v.requestFile, home: v.home, repo: v.repo }).then(() => null, (e: unknown) => e);
      const cyc = await v.cycle();
      expect(v.invoked).toEqual([]);
      return { code: (refused as { code?: string } | null)?.code ?? "ok", detail: jaRenderingsRefusalDetailOf(refused), cycle: cyc.report.code };
    };
    expect(await check(jaRecord({ owner_confirmation: undefined }))).toMatchObject({ code: "JA_RENDERINGS_NOT_OWNER_CONFIRMED", cycle: "JA_RENDERINGS_NOT_OWNER_CONFIRMED" });
    const badEntries = [{ ...entries[0]!, ja_text: "職人の焙煎所から豆が届きます" }];
    expect(await check(jaRecord({ entries: badEntries, owner_confirmation: { confirmed: true, confirmed_at: "2026-11-25T03:00:00Z", entries_sha256: entriesSha256(badEntries) } }))).toEqual({ code: "JA_RENDERING_ADDS_FACT", detail: { category: "people", field: "ja_text", fact_key: "statement_1" }, cycle: "JA_RENDERING_ADDS_FACT" });
    const wrongSource = [{ ...entries[0]!, source_text: "豆は届きます" }];
    expect((await check(jaRecord({ entries: wrongSource, owner_confirmation: { confirmed: true, confirmed_at: "2026-11-25T03:00:00Z", entries_sha256: entriesSha256(wrongSource) } }))).code).toBe("JA_RENDERINGS_SOURCE_MISMATCH");
    // the request's SHA-256 is not the file's
    const mismatch = world({ request: requestObject({ ja_renderings: { path: "ja-renderings.json", sha256: sha("other") } }) });
    writeFileSync(join(mismatch.home, "second-root-shops", SHOP, "ja-renderings.json"), JA);
    expect(await codeOf(validateRequestFile({ file: mismatch.requestFile, home: mismatch.home, repo: mismatch.repo }))).toBe("JA_RENDERINGS_RECORD_SHA_MISMATCH");
    // missing, or a link
    const missing = world({ request: requestObject({ ja_renderings: { path: "ja-renderings.json", sha256: sha(JA) } }) });
    expect(await codeOf(validateRequestFile({ file: missing.requestFile, home: missing.home, repo: missing.repo }))).toBe("JA_RENDERINGS_RECORD_MISSING");
    const elsewhere = join(tmp("sr-req-ja-"), "ja.json");
    writeFileSync(elsewhere, JA);
    symlinkSync(elsewhere, join(missing.home, "second-root-shops", SHOP, "ja-renderings.json"));
    expect(await codeOf(validateRequestFile({ file: missing.requestFile, home: missing.home, repo: missing.repo }))).toBe("JA_RENDERINGS_RECORD_UNSAFE");
  });

  it("fictional: the fictional-shop check passes, the bundle is delivered and the research log intake accepts it", async () => {
    const bakery = readFileSync(resolve(REPO, BAKERY));
    const id = "req-hoshigama-1";
    const w = world({ id, request: requestObject({ id, kind: "fictional", ...SECTION_SPLIT, case_study: undefined, shop_id: "hoshigama", facts_ref: { root: "second-root-shops", shop_id: "hoshigama" } }, bakery), facts: bakery, shopDir: "hoshigama" });
    const { report, run } = await w.cycle();
    expect(report).toMatchObject({ status: "succeeded", kind: "fictional", approval_id: id });
    // no case study on this fictional request: nothing to bind
    expect(run!.caseStudySha256).toBeNull();
    expect(JSON.parse(readFileSync(report.receipt!, "utf8"))).not.toHaveProperty("case_study_sha256");
    const prompt = readFileSync(join(report.run_dir!, "prompts", "pc-1.txt"), "utf8");
    expect(prompt).toContain("比較研究用の架空の店");
    const d = await deliverReview({ approvalId: id, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
    expect(d.status).toBe("delivered");
    const inbox = join(w.runsDir, "review-inbox");
    const entry = await entryFromInbox({ repo: REPO, inbox, bundleId: id, shop: "hoshigama", direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-20T02:00:00Z" });
    expect(entry).toMatchObject({ entry_id: id, shop: "hoshigama", fictional: true, provenance: { approval_id: id, plan_id: id } });
    expect(await codeOf(entryFromInbox({ repo: REPO, inbox, bundleId: id, shop: "bicycle", direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-20T02:00:00Z" }))).toBe("INTAKE_SHOP_MISMATCH");
  });

  it("local-shops root (the clone's gitignored .local-shops; fictional only) works and leaves the tree clean", async () => {
    const bakery = readFileSync(resolve(REPO, BAKERY));
    const id = "req-hoshigama-local-1";
    const w = world({ id, request: requestObject({ id, kind: "fictional", ...SECTION_SPLIT, case_study: undefined, shop_id: "hoshigama", facts_ref: { root: "local-shops", shop_id: "hoshigama" } }, bakery), facts: bakery, shopDir: "hoshigama" });
    mkdirSync(join(w.repo, ".local-shops", "hoshigama"), { recursive: true });
    writeFileSync(join(w.repo, ".local-shops", "hoshigama", "facts-pack.json"), bakery);
    expect((await w.cycle()).report.status).toBe("succeeded");
    expect(git(w.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("refuses a dirty clone, a request SHA mismatch and a run directory inside the clone; nothing invoked", async () => {
    const w = world();
    expect((await runRequestCycle({ ...w.opts, requestSha256: sha("other") }, w.deps)).report.code).toBe("REQUEST_SHA_MISMATCH");
    writeFileSync(join(w.repo, "stray.txt"), "x");
    expect((await w.cycle()).report.code).toBe("TREE_DIRTY");
    rmSync(join(w.repo, "stray.txt"));
    expect(w.invoked.length).toBe(0);
    const run = await loadRequestRun({ requestFile: w.requestFile, requestSha256: sha(w.requestBytes), requestId: ID, home: w.home, repo: w.repo });
    const r = await runRequestFullPageCall(
      { plan: run.plan as RequestPlan, inputs: { factsBytes: run.factsBytes, directionBytes: run.directionBytes }, requestId: ID, requestSha256: run.requestSha256, expected: { promptSha256: run.plan.batch.sha256, promptChars: run.plan.batch.chars, commit: git(w.repo, "rev-parse", "HEAD"), planSha256: run.plan.plan_sha256 }, outDir: join(w.repo, "out"), repoRoot: w.repo },
      { ledger: openLedger(w.ledgerDir), commit: () => gitCommitState(w.repo, ENV), batch: async () => Promise.reject(new Error("never")) },
    );
    expect(r).toMatchObject({ status: "stopped", code: "RUN_DIR_IN_REPO", stage: "precheck" });
    expect(existsSync(w.ledgerDir)).toBe(false);
  });
});

describe("DEV-303 the worker CLI's request arguments", () => {
  const ENTRY = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/worker-cli-entry.ts");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const home = tmp("sr-req-cli-");
    const r = spawnSync(process.execPath, ["--import", "tsx", ENTRY, "0::/\n", ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    return { status: r.status, out: JSON.parse(lines.at(-1) ?? "null") as { status: string; code: string } | null, home };
  };
  it("malformed request arguments are refused (USAGE, exit 2) and nothing is written", () => {
    const h = "a".repeat(64);
    const file = { SR_IMAGEFIRST_REQUEST_FILE: `/x/${ID}.json` };
    for (const [args, env] of [
      [["--request", ID], file],
      [["--request", ID, "--request-sha256", h], {}],
      [["--request", ID, "--request-sha256", h], { SR_IMAGEFIRST_REQUEST_FILE: `relative/${ID}.json` }],
      [["--request", "../x", "--request-sha256", h], file],
      [["--request", ID, "--request-sha256", "zz"], file],
      [["--request", ID, "--request-sha256", h, "--extra"], file],
      [["--request", ID, "--request", ID, "--request-sha256", h], file],
      [["--request", ID, "--request-sha256", h], { ...file, SR_IMAGEFIRST_EXPECT_APPROVAL_ID: "hoshigama-imagefirst-d3-20261120-01" }],
      [["--validate-request"], {}],
    ] as const) {
      const r = run([...args], { ...env });
      expect([r.status, r.out?.status, r.out?.code], args.join(" ")).toEqual([2, "refused", "USAGE"]);
      expect(readdirSync(r.home)).toEqual([]);
    }
  });

  it("--validate-request through the real CLI: refused with a fixed code (exit 2), nothing written", () => {
    const dir = tmp("sr-req-cli-val-");
    const file = join(dir, `${ID}.json`);
    writeFileSync(file, bytesOf(requestObject({ codex_runs: 2 })));
    const r = run(["--validate-request", file]);
    expect([r.status, r.out?.status, r.out?.code]).toEqual([2, "refused", "REQUEST_INVALID"]);
    writeFileSync(file, bytesOf(requestObject()));
    // valid shape, but HOME has no ~/second-root-shops: the facts pack is missing
    const m = run(["--validate-request", file]);
    expect([m.status, m.out?.code]).toEqual([2, "FACTS_MISSING"]);
    expect(readdirSync(m.home)).toEqual([]);
  });

  it("review Q5 follow-up: a case-study text refusal names its category, field and case in the CLI line (never the text)", () => {
    const home = tmp("sr-req-cli-q5-");
    const shopDir = join(home, "second-root-shops", SHOP);
    mkdirSync(shopDir, { recursive: true });
    writeFileSync(join(shopDir, "facts-pack.json"), FACTS_BYTES);
    const base = JSON.parse(CASE_STUDY.toString("utf8")) as { cases: { do_not_copy: string[] }[] };
    const cases = base.cases.map((c, n) => (n === 1 ? { ...c, do_not_copy: ["円の札を写さない"] } : c));
    const cs = caseStudyBytes(SHOP, { cases });
    writeFileSync(join(shopDir, CASE_STUDY_FILE), cs);
    const file = join(tmp("sr-req-cli-q5f-"), `${ID}.json`);
    writeFileSync(file, bytesOf(requestObject({ case_study: { path: CASE_STUDY_FILE, sha256: sha(cs) } })));
    const r = run(["--validate-request", file], { HOME: home });
    expect([r.status, r.out?.status, r.out?.code]).toEqual([2, "refused", "CASE_STUDY_TEXT_HAS_FACT"]);
    expect((r.out as unknown as { detail?: unknown }).detail).toEqual({ category: "money", field: "do_not_copy", case_id: "CP-002" });
    expect(JSON.stringify(r.out)).not.toContain("円");
  });

  it("DEV-303 §6.1 change 4: a rendering that adds a fact names its category, field and key in the CLI line (never the text)", () => {
    const home = tmp("sr-req-cli-ja-");
    const shopDir = join(home, "second-root-shops", SHOP);
    mkdirSync(shopDir, { recursive: true });
    writeFileSync(join(shopDir, "facts-pack.json"), FACTS_BYTES);
    writeFileSync(join(shopDir, CASE_STUDY_FILE), CASE_STUDY);
    const entries = [{ fact_key: "statement_1", source_text: "豆は架空の焙煎所から届きます", ja_text: "職人の焙煎所から豆が届きます" }];
    const ja = Buffer.from(JSON.stringify({ schema: "sr_ja_renderings_v1", shop_id: SHOP, entries, owner_confirmation: { confirmed: true, confirmed_at: "2026-11-25T03:00:00Z", entries_sha256: entriesSha256(entries) } }));
    writeFileSync(join(shopDir, "ja-renderings.json"), ja);
    const file = join(tmp("sr-req-cli-jaf-"), `${ID}.json`);
    writeFileSync(file, bytesOf(requestObject({ ja_renderings: { path: "ja-renderings.json", sha256: sha(ja) } })));
    const r = run(["--validate-request", file], { HOME: home });
    expect([r.status, r.out?.status, r.out?.code]).toEqual([2, "refused", "JA_RENDERING_ADDS_FACT"]);
    expect((r.out as unknown as { detail?: unknown }).detail).toEqual({ category: "people", field: "ja_text", fact_key: "statement_1" });
    expect(JSON.stringify(r.out)).not.toContain("職人");
  });
});
