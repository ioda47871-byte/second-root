import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { generateImagesInOneRun } from "@/lib/design-agent/design-image/image-once";
import { PromptStop } from "@/lib/design-agent/image-first/prompt";
import { buildPhotoPlan, buildRequestPlan, DEMO_MARKER, parseRequest, PHOTO_LABEL, PHOTO_TOOL_MAX_REFS, type DesignRequest, type PhotoMaterialsRequest } from "@/lib/design-agent/image-first/request-prompt";
import { IMAGE_TOOL_MAX_REFS, REFERENCE_DIR_TOKEN } from "@/lib/design-agent/image-tool-limits";
import { checkDesignApproval, DESIGN_AXES } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { gitCommitState, type WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { IMAGE_MATERIAL_LABEL, packBundle, verifyBundleDir } from "@/lib/design-agent/imagefirst-worker/bundle";
import { deliverReview } from "@/lib/design-agent/imagefirst-worker/deliver-review";
import { loadRequestRun, recordUseOf, validateRequestFile } from "@/lib/design-agent/imagefirst-worker/request";
import { runRequestCycle } from "@/lib/design-agent/imagefirst-worker/request-cycle";
import { runLoadedRequest } from "@/lib/design-agent/imagefirst-worker/request-run";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { entryFromInbox } from "@/lib/design-agent/research-log/intake";
import { parseArgs } from "@/scripts/design-artifact/phase2f-live-cli";
import { colourPng } from "../phase2f/fixtures";
import { CASE_STUDY_FILE, caseStudyBytes, cleanupTemps, ENV, fakeCodex, git, NOW, REPO, sha, THREAD, tmp, workerRepo, type Fake } from "./support";

// DEV-303 (owner decision 2026-11-24): the two-stage IMAGE_FIRST request flow — stage 1 photo_materials (1..6 picture
// materials, one Codex run), stage 2 design with photo_inputs (the stage-1 pictures attached to the one Codex run with
// --image, never copied into the design run or its inbox bundle). FICTIONAL fixtures only. A FAKE Codex: no model, no
// image tool, no network.
// DEV-303 §6.1 row 3: a real_shop design is whole_page only and a whole_page design never takes photo_inputs, so the
// section-split design with photo_inputs below runs on the research log's fictional bakery (hoshigama); the invented
// "real_shop"-shaped pack (PIN_FACTS) stays only for the pinned section-split prompt (built without parseRequest).

vi.setConfig({ testTimeout: 90_000 });
afterAll(cleanupTemps);

const SHOP = "hoshigama";
/** The research log's fictional bakery (its committed pack): the fictional-shop check accepts it. */
const FACTS_BYTES = readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bakery/facts-pack.json"));
const FACTS = JSON.parse(FACTS_BYTES.toString("utf8")) as FactsPack;
/** The invented real_shop-shaped pack of the pinned section-split prompt (see the pin below). */
const PIN_FACTS: FactsPack = {
  schema: "shop_facts_pack_v1",
  shop_id: "test-shop-p",
  facts: [
    { id: "F1", key: "name", value: "架空パン工房 こむぎの木", source_id: "S1" },
    { id: "F2", key: "category", value: "bakery", source_id: "S1" },
    { id: "F3", key: "address", value: "架空市架空町9-9-9", source_id: "S1" },
    { id: "F4", key: "description", value: "テスト用の架空のパン屋です。実在しません。", source_id: "S1" },
    { id: "F5", key: "hours", value: "7:00〜15:00", source_id: "S1" },
    { id: "F6", key: "closed_days", value: "月曜", source_id: "S1" },
    { id: "F7", key: "service_1", value: "架空の食パン", source_id: "S1" },
  ],
};
const PIN_FACTS_BYTES = Buffer.from(`${JSON.stringify(PIN_FACTS, null, 2)}\n`);
const DIRECTION = {
  name: "粉の朝",
  concept: "粉の白さと朝の光を、余白の多い静かな画面にする。",
  palette: "生成りの地に焦げ茶と薄い灰。",
  typography: "明朝体の大きな見出しと細いゴシックの本文。",
  layout_pc: "左右二段。左に大きな店名、右に情報をまとめる。",
  layout_sp: "一段。店名を最初の画面いっぱいに置く。",
  avoid: "派手なグラデーション。",
};
/**
 * DEV-303 §6.1 change 6: the materials an approved design needs (two per aspect, so the files are photo-1..6 in the
 * aspect slots: 1-2 landscape, 3-4 square, 5-6 portrait).
 */
const MATERIALS = [
  { id: "hero-texture", kind: "photo", aspect: "landscape_3x2", placement: "PC の最初の画面の右の写真の枠", note: "焼き色のついたパンの皮の質感の接写" },
  { id: "flour-band", kind: "background", aspect: "landscape_3x2", placement: "PC の紹介の帯の背景", note: "台に広がった小麦粉の淡い面" },
  { id: "hands", kind: "photo", aspect: "square_1x1", placement: "SP の紹介の写真の枠", note: "生地をこねる手元（顔は写さない）" },
  { id: "light", kind: "photo", aspect: "square_1x1", placement: "PC の言葉の区画の小さな写真の枠", note: "朝の窓から差す斜めの光と粉の舞い" },
  { id: "tins", kind: "photo", aspect: "portrait_2x3", placement: "SP の最初の画面の写真の枠", note: "使い込んだ焼き型と布" },
  { id: "crumb-line", kind: "decoration", aspect: "portrait_2x3", placement: "PC の情報の区画の左の飾り", note: "割ったパンの断面の気泡を思わせる点の模様" },
];
const MOOD = "朝の静かな光、自然な色、やわらかい影。";
const AVOID = "文字、看板、ロゴ、人の顔、店の外観や店内。";
const PHOTO_ID = "req-test-shop-p-photos-1";
/** The design run the materials are for (approved by the owner before any material is made). */
const BASE_ID = "req-test-shop-p-base-1";
const REVIEW_FILE = `${BASE_ID}.review.json`;
const APPROVAL_FILE = `${BASE_ID}.approval.json`;
const DESIGN_ID = "req-test-shop-p-design-1";
const envelope = (id: string) => ({ schema: "sr_imagefirst_request_v1", id, shop_id: SHOP, kind: "fictional", created_at: "2026-11-24T00:30:00Z", facts_ref: { root: "second-root-shops", shop_id: SHOP }, facts_sha256: sha(FACTS_BYTES), codex_runs: 1 });
/** approved: the base run's bundle SHA-256 once it is delivered (a placeholder for the schema-only tests). */
let approvedBundleSha = "b".repeat(64);
const photoRequest = (over: Record<string, unknown> = {}) => ({ ...envelope(PHOTO_ID), stage: "photo_materials", approved_design: { bundle_id: BASE_ID, bundle_sha256: approvedBundleSha, review_file: REVIEW_FILE, approval_file: APPROVAL_FILE }, materials: MATERIALS, mood: MOOD, avoid: AVOID, max_images: 6, ...over });
/** A synthetic approved design for the pure plan tests (the worker resolves the real one). */
const AD = { bundle_id: BASE_ID, bundle_sha256: "b".repeat(64), review_sha256: sha("review"), approval_sha256: sha("approval"), references: [{ id: "ref-1", image: "pc-1", name: "ref-1.png", sha256: sha("pc") }, { id: "ref-2", image: "sp-1", name: "ref-2.png", sha256: sha("sp") }] };
// Issue #336: a design request may name its owner-confirmed case study (invented text, the repository's images; checked when named)
const CASE_STUDY = caseStudyBytes(SHOP);
const designRequest = (over: Record<string, unknown> = {}) => ({ ...envelope(DESIGN_ID), stage: "design", direction: DIRECTION, case_study: { path: CASE_STUDY_FILE, sha256: sha(CASE_STUDY) }, max_images: 6, ...over });
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const parseCode = (o: Record<string, unknown>) => {
  const b = bytesOf(o);
  try {
    parseRequest(b, sha(b), o.id as string);
    return "ok";
  } catch (error) {
    return error instanceof PromptStop ? error.code : String(error);
  }
};
const codeOf = async (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code ?? String(e));
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** Every image file under a directory (recursive), as root's after-run count sees them. */
function imagesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) out.push(...imagesUnder(p).map((x) => `${n}/${x}`));
    else if (IMAGE_EXT.test(n)) out.push(n);
  }
  return out;
}

/**
 * A fake Codex that records each exec's argv and the SHA-256 of every --image file it was handed. `landscape`: its six
 * pictures are other bytes than the default fake's (so a photo material can be told apart from a design part).
 */
function recordingFake(landscape = false): Fake & { argv: string[][]; attached: string[][] } {
  const f = fakeCodex("six") as Fake & { argv: string[][]; attached: string[][] };
  f.argv = [];
  f.attached = [];
  const run = f.sandbox.run.bind(f.sandbox);
  f.sandbox.run = async (a, o) => {
    if (a[0] === "exec") {
      f.argv.push([...a]);
      f.attached.push(a.filter((x) => x.startsWith("--image=")).map((x) => sha(readFileSync(x.slice("--image=".length)))));
    }
    const res = await run(a, o);
    if (a[0] === "exec" && landscape) {
      for (let i = 0; i < 6; i++) {
        const p = join(f.codexHome, "generated_images", THREAD, `ig_${i}.png`);
        writeFileSync(p, colourPng(1536, 1024 + i));
        const t = new Date(Date.UTC(2026, 10, 20, 1, 0, i));
        utimesSync(p, t, t);
      }
    }
    return res;
  };
  return f;
}

/** One worker home (a clone, ~/second-root-shops with the invented pack, ~/sr-runs, state, ledger) for several requests. */
function home() {
  const h = tmp("sr-photo-home-");
  const repo = workerRepo();
  const shopDir = join(h, "second-root-shops", SHOP);
  mkdirSync(shopDir, { recursive: true });
  writeFileSync(join(shopDir, "facts-pack.json"), FACTS_BYTES);
  writeFileSync(join(shopDir, CASE_STUDY_FILE), CASE_STUDY);
  const runsDir = join(h, "sr-runs");
  mkdirSync(runsDir, { mode: 0o700 });
  const stateDir = join(h, "state");
  const ledgerDir = join(h, "ledger");
  const fakes: ReturnType<typeof recordingFake>[] = [];
  /** root's private copy of a request (outside the clone). */
  const place = (o: Record<string, unknown>) => {
    const id = o.id as string;
    const dir = join(runsDir, "requests-private", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${id}.json`);
    const bytes = bytesOf(o);
    writeFileSync(file, bytes);
    return { id, file, bytes };
  };
  const entry = async (argv: string[], fake: Fake): Promise<BoundedResult> => {
    const line = (o: object, code: number): BoundedResult => ({ code, signal: null, stdout: `${JSON.stringify(o)}\n`, stderr: "", timedOut: false });
    const VALUES = new Set(["--request-file", "--request-id", "--request-sha256", "--out", "--expected-commit", "--expected-plan-sha256", "--expected-prompt-sha256", "--expected-prompt-chars"]);
    const args = parseArgs(argv, new Set(), VALUES)!;
    let run;
    try {
      run = await loadRequestRun({ requestFile: args.get("--request-file")!, requestSha256: args.get("--request-sha256")!, requestId: args.get("--request-id")!, home: h, repo });
    } catch (error) {
      return line({ status: "refused", code: error instanceof PromptStop ? error.code : "REQUEST_UNREADABLE" }, 2);
    }
    const result = await runLoadedRequest(
      { run, expected: { promptSha256: args.get("--expected-prompt-sha256")!, promptChars: Number(args.get("--expected-prompt-chars")), commit: args.get("--expected-commit")!, planSha256: args.get("--expected-plan-sha256")! }, outDir: args.get("--out")!, repoRoot: repo },
      {
        ledger: openLedger(ledgerDir),
        commit: () => gitCommitState(repo, ENV),
        preflight: async () => null,
        now: () => NOW,
        batch: async (o) => {
          const r = await generateImagesInOneRun({ sandbox: fake.sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: fake.tmpBase, maxImages: o.maxImages, ...(o.inputImages ? { inputImages: o.inputImages } : {}), ...(o.referenceImages ? { referenceImages: o.referenceImages } : {}) });
          return { images: r.images, outcome: r.outcome, stopCode: r.stopCode, imageCalls: r.imageCalls, imageFailed: r.imageFailed, imageCallIds: r.imageCallIds ?? [], threadId: r.threadId, cliVersion: r.cliVersion, model: r.model };
        },
      },
    );
    return result.status === "succeeded" ? line({ status: "succeeded" }, 0) : line({ status: "stopped", code: result.code, stage: result.stage }, result.stage === "precheck" ? 2 : 1);
  };
  const cycle = (o: Record<string, unknown>) => {
    const r = place(o);
    const fake = recordingFake(o.stage === "photo_materials");
    fakes.push(fake);
    return runRequestCycle(
      { repoRoot: repo, stateDir, runsDir, home: h, requestId: r.id, requestSha256: sha(r.bytes), requestFile: r.file },
      { commit: () => gitCommitState(repo, ENV), ledger: openLedger(ledgerDir), now: () => NOW, invoke: (argv) => entry(argv, fake) },
    ).then((res) => ({ ...res, fake }));
  };
  return { h, repo, runsDir, stateDir, ledgerDir, place, cycle, fakes };
}

/**
 * DEV-303 §6.1 change 6: the order design → review / approval → materials. A design run delivered to the review inbox,
 * its five-axis review and the owner's approval (as Claude records it, fictional) in the shop's design-reviews folder.
 */
async function approvedBase(w: ReturnType<typeof home>, o: { decision?: "approve" | "revise" | "reject"; fail?: boolean } = {}) {
  const base = await w.cycle(designRequest({ id: BASE_ID }));
  expect(base.report.status).toBe("succeeded");
  await deliverReview({ approvalId: BASE_ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
  const bundleDir = join(w.runsDir, "review-inbox", BASE_ID);
  const v = await verifyBundleDir(bundleDir);
  const parts = v.manifest.files.filter((f) => f.role === "part");
  const images = { pc: parts.filter((f) => f.path.startsWith("parts/pc-")).map((f) => ({ file: f.path, sha256: f.sha256 })), sp: parts.filter((f) => f.path.startsWith("parts/sp-")).map((f) => ({ file: f.path, sha256: f.sha256 })) };
  const axis = (verdict: string) => ({ verdict, evidence: [{ image: "pc", region: "最初の画面", note: "試験用の根拠（架空）" }] });
  const review = { schema: "sr_design_review_v1", request_id: BASE_ID, bundle_sha256: v.bundle_sha256, images, axes: Object.fromEntries(DESIGN_AXES.map((a, n) => [a, axis(o.fail && n === 0 ? "fail" : "pass")])), reviewer: "independent-subagent", reviewed_at: "2026-11-24T01:00:00Z" };
  const dir = join(w.h, "second-root-shops", SHOP, "design-reviews");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, REVIEW_FILE), bytesOf(review));
  const c = await checkDesignApproval({ bundleDir, reviewPath: join(dir, REVIEW_FILE), repo: w.repo, mode: "draft" });
  writeFileSync(join(dir, APPROVAL_FILE), bytesOf({ schema: "sr_design_approval_v1", request_id: BASE_ID, bundle_sha256: v.bundle_sha256, approved_images: images, review_sha256: c.review_sha256, page_sha256: c.page_sha256, decision: o.decision ?? "approve", decided_at: "2026-11-24T02:00:00Z" }));
  approvedBundleSha = v.bundle_sha256;
  return { bundleDir, bundleSha: v.bundle_sha256, images, dir };
}

/** Stage 1 in a fresh home: the approved design, then 6 materials for it; the files as photo_inputs names them. */
async function stageOne() {
  const w = home();
  const approved = await approvedBase(w);
  const one = await w.cycle(photoRequest());
  expect(one.report).toMatchObject({ status: "succeeded", stage: "photo_materials", approval_id: PHOTO_ID });
  const files = one.report.photo_files!;
  // stage 2 needs the stage-1 run sealed and delivered to the review inbox
  const d1 = await deliverReview({ approvalId: PHOTO_ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
  return { w, one, files, d1, approved };
}

describe("DEV-303 photo_materials request schema (strict; same unsafe-text filter as direction)", () => {
  it("accepts the documented materials request; one picture per listed material (max_images = materials)", () => {
    expect(parseCode(photoRequest())).toBe("ok");
    expect(parseCode(photoRequest({ materials: MATERIALS.slice(0, 2), max_images: 2 }))).toBe("ok");
  });
  it("DEV-303 §6.1 change 6: no approved design (the old photo_brief order included) is APPROVED_DESIGN_REQUIRED; two of one aspect at most", () => {
    const old: Record<string, unknown> = { ...photoRequest(), photo_brief: { subjects: ["質感"], mood: MOOD, avoid: AVOID }, max_images: 1 };
    delete old.approved_design;
    delete old.materials;
    expect(parseCode(old)).toBe("APPROVED_DESIGN_REQUIRED");
    const noRef: Record<string, unknown> = photoRequest();
    delete noRef.approved_design;
    expect(parseCode(noRef)).toBe("APPROVED_DESIGN_REQUIRED");
    expect(parseCode({ ...noRef, kind: "real_shop" })).toBe("APPROVED_DESIGN_REQUIRED");
    const threeWide = [MATERIALS[0], MATERIALS[1], { ...MATERIALS[2], aspect: "landscape_3x2" }];
    expect(parseCode(photoRequest({ materials: threeWide, max_images: 3 }))).toBe("MATERIALS_ASPECT_FULL");
    for (const approved_design of [
      { bundle_id: BASE_ID, bundle_sha256: "x", review_file: REVIEW_FILE, approval_file: APPROVAL_FILE },
      { bundle_id: BASE_ID, bundle_sha256: "b".repeat(64), review_file: "../r.json", approval_file: APPROVAL_FILE },
      { bundle_id: BASE_ID, bundle_sha256: "b".repeat(64), review_file: REVIEW_FILE, approval_file: REVIEW_FILE },
      { bundle_id: PHOTO_ID, bundle_sha256: "b".repeat(64), review_file: REVIEW_FILE, approval_file: APPROVAL_FILE },
      { bundle_id: "hoshigama-imagefirst-d3-20261120-01", bundle_sha256: "b".repeat(64), review_file: REVIEW_FILE, approval_file: APPROVAL_FILE },
      { bundle_id: BASE_ID, bundle_sha256: "b".repeat(64), review_file: REVIEW_FILE, approval_file: APPROVAL_FILE, path: "/x" },
    ]) expect(parseCode(photoRequest({ approved_design })), JSON.stringify(approved_design).slice(0, 80)).toBe("REQUEST_INVALID");
  });
  it("refuses wrong counts, lengths, extra fields and a mixed stage", () => {
    for (const over of [
      { max_images: 5 },
      { materials: [], max_images: 1 },
      { materials: [...MATERIALS, { ...MATERIALS[0], id: "seventh" }], max_images: 7 },
      { materials: [{ ...MATERIALS[0], note: "あ".repeat(201) }], max_images: 1 },
      { materials: [{ ...MATERIALS[0], kind: "logo" }], max_images: 1 },
      { materials: [{ ...MATERIALS[0], aspect: "panorama" }], max_images: 1 },
      { materials: [MATERIALS[0], MATERIALS[0]], max_images: 2 },
      { materials: [{ ...MATERIALS[0], extra: "x" }], max_images: 1 },
      { mood: "あ".repeat(301) },
      { avoid: "あ".repeat(301) },
      { photo_brief: { subjects: ["x"], mood: MOOD, avoid: AVOID } },
      { direction: DIRECTION },
      { photo_inputs: { request_id: "req-other-1", files: [{ name: "photo-1.png", sha256: "a".repeat(64) }] } },
      { codex_runs: 2 },
      { stage: "photos" },
    ]) expect(parseCode(photoRequest(over)), JSON.stringify(over).slice(0, 80)).toBe("REQUEST_INVALID");
    expect(parseCode(designRequest({ materials: MATERIALS }))).toBe("REQUEST_INVALID");
  });
  it("refuses URLs, HTML, quotes, digit runs, currency and control characters in the materials list", () => {
    for (const bad of ["https://example.com の写真", "<b>パン</b>", "「新作」の札", "\"Fresh\"", "2026 年の朝", "500円のパン", "改行\nあり", "www.example.jp 風"]) {
      expect(parseCode(photoRequest({ materials: [{ ...MATERIALS[0], note: bad }], max_images: 1 })), bad).toBe("REQUEST_MATERIALS_UNSAFE");
      expect(parseCode(photoRequest({ materials: [{ ...MATERIALS[0], placement: bad }], max_images: 1 })), bad).toBe("REQUEST_MATERIALS_UNSAFE");
      expect(parseCode(photoRequest({ mood: bad })), bad).toBe("REQUEST_MATERIALS_UNSAFE");
    }
  });
  it("design photo_inputs: schema 1..6 files, tool limit 5 (photo-N.png, SHA-256, unique, another request id)", () => {
    const f = (n: number) => ({ name: `photo-${n}.png`, sha256: sha(String(n)) });
    expect(parseCode(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: [1, 2, 3, 4, 5].map(f) } }))).toBe("ok");
    // Issue #335: 6 fit the schema but not the image tool (at most 5 reference pictures per call)
    expect(parseCode(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: [1, 2, 3, 4, 5, 6].map(f) } }))).toBe("PHOTO_INPUTS_OVER_TOOL_LIMIT");
    expect(parseCode(designRequest())).toBe("ok");
    // the original request (no stage) is still the design stage
    const noStage: Record<string, unknown> = designRequest();
    delete noStage.stage;
    expect(parseCode(noStage)).toBe("ok");
    for (const photo_inputs of [
      { request_id: PHOTO_ID, files: [] },
      { request_id: PHOTO_ID, files: [1, 2, 3, 4, 5, 6, 1].map(f) },
      { request_id: PHOTO_ID, files: [f(1), f(1)] },
      { request_id: PHOTO_ID, files: [{ name: "photo-7.png", sha256: sha("7") }] },
      { request_id: PHOTO_ID, files: [{ name: "../photo-1.png", sha256: sha("1") }] },
      { request_id: PHOTO_ID, files: [{ name: "photo-1.jpg", sha256: sha("1") }] },
      { request_id: PHOTO_ID, files: [{ name: "photo-1.png", sha256: "x" }] },
      { request_id: PHOTO_ID, files: [{ ...f(1), path: "/etc" }] },
      { request_id: "not-a-request", files: [f(1)] },
      { request_id: "req-imagefirst-x", files: [f(1)] },
      { request_id: DESIGN_ID, files: [f(1)] },
      { request_id: PHOTO_ID, files: [f(1)], dir: "/tmp" },
    ]) expect(parseCode(designRequest({ photo_inputs })), JSON.stringify(photo_inputs).slice(0, 80)).toBe("REQUEST_INVALID");
  });
});

describe("DEV-303 the prompts of both stages", () => {
  const photo = parseRequest(bytesOf(photoRequest()), sha(bytesOf(photoRequest())), PHOTO_ID).request as PhotoMaterialsRequest;
  const plan = buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: AD });
  it("materials: one prompt per listed material in its aspect slot, the approved design as references, no facts value, the material rules", () => {
    expect([plan.photos.length, plan.batch.images]).toEqual([6, 6]);
    expect(plan.photos.map((p) => p.aspect)).toEqual(["landscape_3x2", "landscape_3x2", "square_1x1", "square_1x1", "portrait_2x3", "portrait_2x3"]);
    expect(plan.photos.map((p) => p.file)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `parts/photo-${n}.png`));
    for (const p of plan.photos) {
      for (const f of FACTS.facts) if (f.key !== "category") expect(p.prompt.includes(f.value), `${p.name}: ${f.key}`).toBe(false);
      expect(p.prompt).toContain("特定の店の記録写真ではなく");
      expect(p.prompt).toContain("文字・数字・記号・看板・ロゴ");
      expect(p.prompt).toContain("人の顔や頭を写さない");
      expect(p.prompt).toContain("値札・メニュー表を写さない");
      expect(p.prompt).toContain("承認したデザインの中");
      expect(p.prompt).toContain(`「${PHOTO_LABEL}」と表示し`);
      expect(p.prompt).toContain("参照画像として渡す");
    }
    expect(plan.photos.map((p) => [p.material_id, p.kind])).toEqual(MATERIALS.map((m) => [m.id, m.kind]));
    expect(plan.photos[0]!.prompt).toContain(`置く場所（承認したデザインの中）: ${MATERIALS[0]!.placement}`);
    expect(plan.batch.prompt).toContain("exactly 6 times");
    expect(plan.batch.prompt).toContain("1536x1024");
    expect(plan.batch.prompt).toContain(`set referenced_image_paths to exactly ["${REFERENCE_DIR_TOKEN}/ref-1.png", "${REFERENCE_DIR_TOKEN}/ref-2.png"]`);
    expect(plan.approved_design).toEqual({ bundle_id: BASE_ID, bundle_sha256: AD.bundle_sha256, review_sha256: AD.review_sha256, approval_sha256: AD.approval_sha256 });
    expect(plan.materials_sha256).toBe(plan.direction_sha256);
    expect(plan.references.map((r) => r.image)).toEqual(["pc-1", "sp-1"]);
    expect(buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: AD }).plan_sha256).toBe(plan.plan_sha256);
    // the slot follows the aspect, not the list order
    const swapped = { ...photo, materials: [photo.materials[4]!, photo.materials[0]!] , max_images: 2 } as PhotoMaterialsRequest;
    expect(buildPhotoPlan({ request: swapped, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: AD }).photos.map((p) => p.file)).toEqual(["parts/photo-1.png", "parts/photo-5.png"]);
  });
  it("materials: a list quoting a facts value, no approved design, another design, or bad references are refused", () => {
    const code = (f: () => unknown) => {
      try {
        f();
        return "ok";
      } catch (e) {
        return e instanceof PromptStop ? e.code : String(e);
      }
    };
    const quoting = { ...photo, mood: "架空パン店 ほし窯 の朝" };
    expect(code(() => buildPhotoPlan({ request: quoting, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: AD }))).toBe("REQUEST_MATERIALS_HAS_FACT");
    expect(code(() => buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: null }))).toBe("APPROVED_DESIGN_REQUIRED");
    expect(code(() => buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: { ...AD, bundle_sha256: sha("other") } }))).toBe("APPROVED_DESIGN_MISMATCH");
    expect(code(() => buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: { ...AD, references: [] } }))).toBe("REFERENCE_IMAGES_MISSING");
    expect(code(() => buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS, approvedDesign: { ...AD, references: [{ ...AD.references[0]!, id: "ref-2" }] } }))).toBe("REFERENCE_IMAGES_INVALID");
  });
  it("stage 2 with photo_inputs: the イメージ label, the 提案用デモ marker, replaceable frames, facts kept apart; without them the prompt is unchanged", () => {
    const files = [1, 2, 3].map((n) => ({ name: `photo-${n}.png`, sha256: sha(String(n)) }));
    const withObj = designRequest({ photo_inputs: { request_id: PHOTO_ID, files } });
    const withPhotos = parseRequest(bytesOf(withObj), sha(bytesOf(withObj)), DESIGN_ID).request as DesignRequest;
    const without = { ...withPhotos, photo_inputs: undefined } as DesignRequest;
    delete (without as { photo_inputs?: unknown }).photo_inputs;
    const a = buildRequestPlan({ request: withPhotos, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS });
    const b = buildRequestPlan({ request: without, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS });
    const parts = [...a.viewports.desktop_1440.parts, ...a.viewports.mobile_390.parts];
    for (const p of parts) {
      expect(p.prompt).toContain(`「${PHOTO_LABEL}」`);
      expect(p.prompt).toContain("差し替えられる");
      expect(p.prompt).toContain("写真が店の事実を写しているように見せない");
      expect(p.prompt).not.toContain("写真や写真風の絵は使わず");
    }
    for (const vp of [a.viewports.desktop_1440.parts, a.viewports.mobile_390.parts]) {
      expect(vp[0]!.prompt).toContain(`「${DEMO_MARKER}」`);
      expect(vp.at(-1)!.prompt).toContain(`「${DEMO_MARKER}」`);
    }
    expect(a.batch.prompt).toContain("3 photographs are attached as input images");
    expect(a.photo_inputs).toEqual({ request_id: PHOTO_ID, files });
    expect(a.plan_sha256).not.toBe(b.plan_sha256);
    // no photo inputs: the original request-mode prompt, no photo field in the plan
    expect("photo_inputs" in b).toBe(false);
    for (const p of [...b.viewports.desktop_1440.parts, ...b.viewports.mobile_390.parts]) {
      expect(p.prompt).toContain("写真や写真風の絵は使わず");
      expect(p.prompt).not.toContain(`「${PHOTO_LABEL}」`);
      expect(p.prompt).not.toContain(DEMO_MARKER);
    }
    expect(b.batch.prompt).not.toContain("attached");
  });
});

describe("Issue #335 (production flow §3.5, §6.1 row 1): at most 5 reference pictures per image-tool call, refused at request validation", () => {
  const filesOf = (n: number) => Array.from({ length: n }, (_, k) => ({ name: `photo-${k + 1}.png`, sha256: sha(String(k + 1)) }));
  it("a design request naming 6 photo inputs is PHOTO_INPUTS_OVER_TOOL_LIMIT; 5 or fewer pass", () => {
    expect(PHOTO_TOOL_MAX_REFS).toBe(5);
    expect(parseCode(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: filesOf(6) } }))).toBe("PHOTO_INPUTS_OVER_TOOL_LIMIT");
    for (const n of [1, 5]) expect(parseCode(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: filesOf(n) } }))).toBe("ok");
    // 7 is outside the schema as before
    expect(parseCode(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: [...filesOf(6), { name: "photo-1.png", sha256: sha("x") }] } }))).toBe("REQUEST_INVALID");
  });
  it("the plan builder refuses it too (never a plan whose run would hand the tool 6)", () => {
    const obj = designRequest({ photo_inputs: { request_id: PHOTO_ID, files: filesOf(5) } });
    const request = parseRequest(bytesOf(obj), sha(bytesOf(obj)), DESIGN_ID).request as DesignRequest;
    const six = { ...request, photo_inputs: { request_id: PHOTO_ID, files: filesOf(6) } } as DesignRequest;
    expect(() => buildRequestPlan({ request: six, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS })).toThrow(expect.objectContaining({ code: "PHOTO_INPUTS_OVER_TOOL_LIMIT" }));
    expect(buildRequestPlan({ request, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS }).photo_inputs?.files).toHaveLength(5);
  });
  it("without photo_inputs the batch prompt and plan are byte-identical to before (pinned SHA-256)", () => {
    // DEV-303 §6.1 row 3: parseRequest now refuses a real_shop section split (REAL_SHOP_WHOLE_PAGE_REQUIRED); the pure
    // plan builder is unchanged for it, so the pinned section-split prompt is rebuilt from the same request object
    const obj = designRequest();
    expect(parseCode({ ...obj, kind: "real_shop" })).toBe("REAL_SHOP_WHOLE_PAGE_REQUIRED");
    const request = { ...(parseRequest(bytesOf(obj), sha(bytesOf(obj)), DESIGN_ID).request as DesignRequest), kind: "real_shop" } as DesignRequest;
    const b = buildRequestPlan({ request, requestSha256: "a".repeat(64), factsBytes: PIN_FACTS_BYTES, facts: PIN_FACTS });
    expect(b.batch.sha256).toBe("61e75a79e31101647392792236145ff5f68796991626963c3f5af264c8b532fe");
    expect(b.plan_sha256).toBe("f8f33e416a1d0fae0f6ae6cea13d0a3fe298c990eead810576eace226365e775");
  });
});

describe("DEV-303 §6.1 change 6: a materials request runs only on the owner-approved design (validate and worker alike)", () => {
  it("each refusal of the approved design stops the request before anything runs; the approved one passes", async () => {
    const w = home();
    const a = await approvedBase(w);
    const validate = async () => {
      const r = w.place(photoRequest());
      return validateRequestFile({ file: r.file, home: w.h, repo: w.repo }).then((v) => v, (e: { code?: string }) => e.code ?? String(e));
    };
    // the approved design passes: its record of it is in the output (SHA-256s and the bundle id, no path)
    const ok = (await validate()) as Record<string, unknown>;
    expect(ok).toMatchObject({ stage: "photo_materials", approved_design: { bundle_id: BASE_ID, bundle_sha256: a.bundleSha }, materials_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(ok)).not.toMatch(/design-reviews|\.review\.json/);
    const approvalPath = join(a.dir, APPROVAL_FILE);
    const reviewPath = join(a.dir, REVIEW_FILE);
    const approvalBytes = readFileSync(approvalPath);
    const reviewBytes = readFileSync(reviewPath);
    const restore = () => {
      rmSync(approvalPath, { force: true });
      rmSync(reviewPath, { force: true });
      writeFileSync(approvalPath, approvalBytes);
      writeFileSync(reviewPath, reviewBytes);
    };
    const editApproval = (edit: (x: Record<string, unknown>) => void) => {
      const x = JSON.parse(approvalBytes.toString("utf8")) as Record<string, unknown>;
      edit(x);
      rmSync(approvalPath);
      writeFileSync(approvalPath, bytesOf(x));
    };
    editApproval((x) => (x.decision = "revise"));
    expect(await validate()).toBe("DESIGN_NOT_APPROVED");
    editApproval((x) => (x.review_sha256 = sha("another review")));
    expect(await validate()).toBe("DESIGN_APPROVAL_REVIEW_MISMATCH");
    editApproval((x) => (x.page_sha256 = sha("another page")));
    expect(await validate()).toBe("DESIGN_APPROVAL_PAGE_MISMATCH");
    restore();
    // a review with a fail (the approval rebound to it) is never approvable
    const review = JSON.parse(reviewBytes.toString("utf8")) as { axes: Record<string, { verdict: string }> };
    review.axes.originality!.verdict = "fail";
    rmSync(reviewPath);
    writeFileSync(reviewPath, bytesOf(review));
    const c = await checkDesignApproval({ bundleDir: a.bundleDir, reviewPath, repo: w.repo, mode: "draft" });
    editApproval((x) => {
      x.review_sha256 = c.review_sha256;
      x.page_sha256 = c.page_sha256;
    });
    expect(await validate()).toBe("DESIGN_REVIEW_HAS_FAIL");
    restore();
    // missing records, a linked folder, another bundle SHA-256 than the request names
    rmSync(approvalPath);
    expect(await validate()).toBe("APPROVED_DESIGN_MISSING");
    restore();
    const realDir = join(tmp("sr-photo-dr-"), "design-reviews");
    cpSync(a.dir, realDir, { recursive: true });
    rmSync(a.dir, { recursive: true });
    symlinkSync(realDir, a.dir);
    expect(await validate()).toBe("APPROVED_DESIGN_UNSAFE");
    rmSync(a.dir);
    cpSync(realDir, a.dir, { recursive: true });
    const saved = approvedBundleSha;
    approvedBundleSha = sha("another bundle");
    expect(await validate()).toBe("APPROVED_DESIGN_MISMATCH");
    approvedBundleSha = saved;
    // the delivered design changed after the approval: the bundle no longer verifies
    const pc = join(a.bundleDir, "parts", "pc-1.png");
    const pcBytes = readFileSync(pc);
    rmSync(pc);
    writeFileSync(pc, colourPng(640, 640), { mode: 0o600 });
    expect(await validate()).toBe("DESIGN_BUNDLE_INVALID");
    rmSync(pc);
    writeFileSync(pc, pcBytes, { mode: 0o600 });
    expect(((await validate()) as Record<string, unknown>).stage).toBe("photo_materials");
    // the worker refuses the same way, nothing invoked
    editApproval((x) => (x.decision = "reject"));
    expect((await w.cycle(photoRequest({ id: "req-test-shop-p-photos-9" }))).report).toMatchObject({ status: "refused", code: "DESIGN_NOT_APPROVED", invoked: false });
    expect(w.fakes.reduce((n, f) => n + f.execs, 0)).toBe(1);
  });

  it("review L1: another shop's or kind's design, a materials bundle, swapped record files or one linked record are refused", async () => {
    const { w, approved } = await stageOne();
    const validate = async (over: Record<string, unknown>, id = "req-test-shop-p-photos-7") => {
      const r = w.place(photoRequest({ id, ...over }));
      return validateRequestFile({ file: r.file, home: w.h, repo: w.repo }).then(() => "ok", (e: { code?: string }) => e.code ?? String(e));
    };
    /** A sealed whole-page design bundle in the review inbox of another shop / kind, reviewed and approved (fictional). */
    const otherBundle = async (id: string, receiptOver: Record<string, unknown>) => {
      const runs = tmp("sr-photo-other-");
      chmodSync(runs, 0o700);
      const runDir = join(runs, `${id}-20261124T010000Z`);
      mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
      chmodSync(runDir, 0o700);
      const images = ["pc-1", "sp-1"].map((n, k) => {
        const bytes = colourPng(512 + k, 768);
        writeFileSync(join(runDir, "parts", `${n}.png`), bytes, { mode: 0o600 });
        return { file: `parts/${n}.png`, sha256: sha(bytes), bytes: bytes.length };
      });
      const refs = [{ id: "ref-1", case_id: "CP-001", sha256: "f".repeat(64) }];
      writeFileSync(join(runDir, "reference-inputs.json"), JSON.stringify({ schema: "image_first_reference_inputs_v0", layout: "whole_page", references: refs }), { mode: 0o600 });
      const receipt = {
        schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, cli_exit: 0, cli_timed_out: false, interrupted: false,
        shop: SHOP, direction: "request", approval_id: id, plan_id: id, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 5000,
        run_dir: runDir, images, stopped_images: [], counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, verified: true,
        timings: { started_at: "2026-11-24T01:00:00.000Z", finished_at: "2026-11-24T01:10:00.000Z", elapsed_ms: 600_000 },
        mode: "request", kind: "fictional", request_id: id, request_sha256: "a".repeat(64), facts_sha256: "e".repeat(64), images_total: 2,
        design_layout: "whole_page", reference_images: refs, ...receiptOver,
      };
      const receiptPath = join(runs, `${id}-20261124T010000Z.receipt.json`);
      writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(w.runsDir, "review-inbox"), now: () => NOW });
      const reviewFile = `${id}.review.json`;
      const approvalFile = `${id}.approval.json`;
      const axis = { verdict: "pass", evidence: [{ image: "pc", region: "最初の画面", note: "試験用の根拠（架空）" }] };
      const imgs = { pc: [{ file: images[0]!.file, sha256: images[0]!.sha256 }], sp: [{ file: images[1]!.file, sha256: images[1]!.sha256 }] };
      writeFileSync(join(approved.dir, reviewFile), bytesOf({ schema: "sr_design_review_v1", request_id: id, bundle_sha256: sealed.bundle_sha256, images: imgs, axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, axis])), reviewer: "independent-subagent", reviewed_at: "2026-11-24T01:00:00Z" }));
      const c = await checkDesignApproval({ bundleDir: sealed.dir, reviewPath: join(approved.dir, reviewFile), repo: w.repo, mode: "draft" });
      writeFileSync(join(approved.dir, approvalFile), bytesOf({ schema: "sr_design_approval_v1", request_id: id, bundle_sha256: sealed.bundle_sha256, approved_images: imgs, review_sha256: c.review_sha256, page_sha256: c.page_sha256, decision: "approve", decided_at: "2026-11-24T02:00:00Z" }));
      return { approved_design: { bundle_id: id, bundle_sha256: sealed.bundle_sha256, review_file: reviewFile, approval_file: approvalFile } };
    };
    // a design of another shop, and one of another kind: approved, but not this request's design
    expect(await validate(await otherBundle("req-test-shop-z-design-1", { shop: "test-shop-z" }))).toBe("APPROVED_DESIGN_MISMATCH");
    expect(await validate(await otherBundle("req-test-shop-p-real-1", { kind: "real_shop" }))).toBe("APPROVED_DESIGN_MISMATCH");
    // the materials bundle itself named as the approved design
    expect(await validate({ approved_design: { bundle_id: PHOTO_ID, bundle_sha256: approvedBundleSha, review_file: REVIEW_FILE, approval_file: APPROVAL_FILE } })).toBe("DESIGN_BUNDLE_NOT_A_DESIGN");
    // the review and approval files swapped: the approval does not parse as a review
    expect(await validate({ approved_design: { bundle_id: BASE_ID, bundle_sha256: approvedBundleSha, review_file: APPROVAL_FILE, approval_file: REVIEW_FILE } })).toBe("DESIGN_REVIEW_INVALID");
    // one record file replaced by a link (the folder itself real)
    const approvalPath = join(approved.dir, APPROVAL_FILE);
    const keep = join(tmp("sr-photo-keep-ap-"), APPROVAL_FILE);
    cpSync(approvalPath, keep);
    rmSync(approvalPath);
    symlinkSync(keep, approvalPath);
    expect(await validate({})).toBe("APPROVED_DESIGN_UNSAFE");
    rmSync(approvalPath);
    cpSync(keep, approvalPath);
    expect(await validate({})).toBe("ok");
  });

  it("sealing and delivery hold the receipt to the run's own approved-design-input.json", async () => {
    const { w, one } = await stageOne();
    const input = join(one.report.run_dir!, "approved-design-input.json");
    const original = readFileSync(input, "utf8");
    const deliver = () => deliverReview({ approvalId: PHOTO_ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true }).then((r) => r.status, (e: { code?: string }) => e.code ?? String(e));
    const edited = JSON.parse(original) as Record<string, unknown>;
    edited.materials_sha256 = sha("another list");
    rmSync(input);
    writeFileSync(input, JSON.stringify(edited), { mode: 0o600 });
    expect(await deliver()).toBe("APPROVED_DESIGN_INPUT_MISMATCH");
    rmSync(input);
    expect(await deliver()).toBe("APPROVED_DESIGN_INPUT_MISMATCH");
    writeFileSync(input, original, { mode: 0o600 });
    // restored: it passes again (stageOne already delivered this run, so the re-send reports the same sealed bundle)
    expect(await deliver()).toBe("duplicate");
  });
});

describe("DEV-303 design → approval → materials → (research) design with photo inputs, end to end (fake Codex)", () => {
  it("materials are made after the approved design, with its PC / SP pictures as references; a research design may then attach them, leaving only its own 6 pictures", async () => {
    const { w, one, files, d1, approved } = await stageOne();
    // DEV-303 §6.1 change 6: the approved design's pictures (2 + 4 > 5: the first PC and the first SP part) are the references
    expect([one.fake.execs, one.fake.attached[0]]).toEqual([1, [approved.images.pc[0]!.sha256, approved.images.sp[0]!.sha256]]);
    const photoRun = one.report.run_dir!;
    expect(photoRun.startsWith(w.runsDir)).toBe(true);
    expect(statSync(photoRun).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(photoRun, "parts")).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `photo-${n}.png`));
    expect(existsSync(join(photoRun, "materials.json"))).toBe(true);
    const r1 = JSON.parse(readFileSync(one.report.receipt!, "utf8")) as WorkerReceipt;
    expect(r1).toMatchObject({ status: "succeeded", verified: true, mode: "request", request_stage: "photo_materials", request_id: PHOTO_ID, kind: "fictional", shop: SHOP, counts: { pc: 0, sp: 0, photo: 6, total: 6, stopped: 0 }, images_total: 6 });
    expect(r1.approved_design).toMatchObject({ bundle_id: BASE_ID, bundle_sha256: approved.bundleSha });
    expect(r1.materials_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(photoRun, "approved-design-input.json"), "utf8"))).toEqual({ schema: "image_first_approved_design_input_v0", ...r1.approved_design, materials_sha256: r1.materials_sha256 });
    expect(JSON.stringify(r1)).not.toMatch(/design-reviews|\.review\.json|\.approval\.json/);
    expect(files.map((f) => f.name)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `photo-${n}.png`));
    expect(files.map((f) => f.sha256)).toEqual(r1.images.map((i) => i.sha256));
    // one use per request id
    expect((await w.cycle(photoRequest())).report).toMatchObject({ status: "refused", code: "REQUEST_ALREADY_CLAIMED", invoked: false });

    // stage 1 reaches the review inbox like a design: sealed, verified, marked as image materials, at most 6 pictures
    expect(d1).toMatchObject({ status: "delivered", approval_id: PHOTO_ID, bundle: "sealed" });
    const photoInbox = join(w.runsDir, "review-inbox", PHOTO_ID);
    expect(imagesUnder(photoInbox).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `parts/photo-${n}.png`));
    const pm = JSON.parse(readFileSync(join(photoInbox, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(pm).toMatchObject({ bundle_id: PHOTO_ID, mode: "request", kind: "fictional", image_material: true, image_material_label: IMAGE_MATERIAL_LABEL, counts: { pc: 0, sp: 0, photo: 6, composites: 0 } });
    expect(pm.photos).toEqual(files.map((f, n) => ({ file: `parts/${f.name}`, sha256: f.sha256, frame: ["3:2", "3:2", "1:1", "1:1", "2:3", "2:3"][n] })));
    expect(JSON.parse(readFileSync(join(photoInbox, "receipt.json"), "utf8"))).toMatchObject({ request_stage: "photo_materials", images_total: 6 });
    expect((await verifyBundleDir(photoInbox)).manifest.image_material).toBe(true);
    expect(existsSync(join(w.runsDir, "review-inbox", "previews", PHOTO_ID, "INDEX.json"))).toBe(true);
    // a copy whose manifest drops the marker is refused by the verifier
    const forged = join(tmp("sr-photo-forged-"), PHOTO_ID);
    cpSync(photoInbox, forged, { recursive: true });
    chmodSync(forged, 0o700);
    const fm = JSON.parse(readFileSync(join(forged, "manifest.json"), "utf8")) as Record<string, unknown>;
    delete fm.image_material;
    rmSync(join(forged, "manifest.json"));
    writeFileSync(join(forged, "manifest.json"), `${JSON.stringify(fm, null, 2)}\n`, { mode: 0o600 });
    expect(await codeOf(verifyBundleDir(forged))).toBe("BUNDLE_MANIFEST_INVALID");
    // never logged in the research log (a photo-materials bundle is never logged)
    expect(await codeOf(entryFromInbox({ repo: w.repo, inbox: join(w.runsDir, "review-inbox"), bundleId: PHOTO_ID, shop: SHOP, direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-24T02:00:00Z" }))).not.toBe("resolved");
    const fakeInbox = tmp("sr-photo-intake-");
    mkdirSync(join(fakeInbox, "req-hoshigama-photos-1"));
    mkdirSync(join(fakeInbox, "previews", "req-hoshigama-photos-1"), { recursive: true });
    const idx = JSON.parse(readFileSync(join(w.runsDir, "review-inbox", "previews", PHOTO_ID, "INDEX.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(fakeInbox, "previews", "req-hoshigama-photos-1", "INDEX.json"), JSON.stringify({ ...idx, bundle_id: "req-hoshigama-photos-1", approval_id: "req-hoshigama-photos-1", plan_id: "req-hoshigama-photos-1" }));
    writeFileSync(join(fakeInbox, "req-hoshigama-photos-1", "manifest.json"), JSON.stringify({ bundle_id: "req-hoshigama-photos-1", mode: "request", kind: "fictional", shop: "hoshigama", image_material: true }));
    expect(await codeOf(entryFromInbox({ repo: REPO, inbox: fakeInbox, bundleId: "req-hoshigama-photos-1", shop: "hoshigama", direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-24T02:00:00Z" }))).toBe("PHOTO_MATERIALS_NOT_LOGGED");

    // Issue #335: naming all 6 pictures is refused before anything runs (the image tool takes at most 5 per call)
    expect((await w.cycle(designRequest({ id: "req-test-shop-p-design-6", photo_inputs: { request_id: PHOTO_ID, files } }))).report).toMatchObject({ status: "refused", code: "PHOTO_INPUTS_OVER_TOOL_LIMIT", invoked: false });
    // stage 2: the design request naming 5 of the pictures
    const inputs = files.slice(0, 5);
    const two = await w.cycle(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: inputs } }));
    expect(two.report).toMatchObject({ status: "succeeded", approval_id: DESIGN_ID });
    expect(two.fake.execs).toBe(1);
    // the one exec got exactly the 5 pictures as --image attachments (copies in the call's temporary work dir)
    expect(two.fake.attached[0]).toEqual(inputs.map((f) => f.sha256));
    const designRun = two.report.run_dir!;
    for (const a of two.fake.argv[0]!.filter((x) => x.startsWith("--image="))) {
      expect(a.startsWith(`--image=${two.fake.tmpBase}`)).toBe(true);
      expect(existsSync(a.slice("--image=".length))).toBe(false);
    }
    // CRITICAL (root's after-run count): the design run and its inbox copy hold exactly its own 6 pictures
    expect(readdirSync(join(designRun, "parts")).sort()).toEqual(["pc-1.png", "pc-2.png", "sp-1.png", "sp-2.png", "sp-3.png", "sp-4.png"]);
    expect(imagesUnder(designRun).sort()).toEqual(["pc-1.png", "pc-2.png", "sp-1.png", "sp-2.png", "sp-3.png", "sp-4.png"].map((n) => `parts/${n}`));
    const inputShas = new Set(files.map((f) => f.sha256));
    for (const n of readdirSync(join(designRun, "parts"))) expect(inputShas.has(sha(readFileSync(join(designRun, "parts", n))))).toBe(false);
    expect(JSON.parse(readFileSync(join(designRun, "photo-inputs.json"), "utf8"))).toMatchObject({ request_id: PHOTO_ID, files: inputs });
    const r2 = JSON.parse(readFileSync(two.report.receipt!, "utf8")) as WorkerReceipt;
    expect(r2).toMatchObject({ status: "succeeded", counts: { pc: 2, sp: 4, total: 6, stopped: 0 }, images_total: 6, photo_inputs: { request_id: PHOTO_ID, files: inputs } });
    const d = await deliverReview({ approvalId: DESIGN_ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
    expect(d.status).toBe("delivered");
    const inboxCopy = join(w.runsDir, "review-inbox", DESIGN_ID);
    expect(imagesUnder(inboxCopy).length).toBe(6);
    for (const n of imagesUnder(inboxCopy)) expect(inputShas.has(sha(readFileSync(join(inboxCopy, n))))).toBe(false);
    // the stage-1 run and its inbox copy are untouched: still 6 pictures each (root's per-directory count, at most 6)
    expect(imagesUnder(join(photoRun, "parts")).length).toBe(6);
    expect(imagesUnder(photoInbox).length).toBe(6);
    for (const dir of [join(photoRun, "parts"), photoInbox, join(designRun, "parts"), inboxCopy]) expect(imagesUnder(dir).length, dir).toBeLessThanOrEqual(6);
    // in all: 3 runs (the approved design, its materials, the research design); the design request is used once
    expect(w.fakes.reduce((n, f) => n + f.execs, 0)).toBe(3);
    expect((await w.cycle(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: inputs } }))).report.code).toBe("REQUEST_ALREADY_CLAIMED");
    expect(git(w.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("refuses photo inputs that are missing, mismatched, linked, oversize or from another run; nothing invoked", async () => {
    const { w, one, files } = await stageOne();
    const photoRun = one.report.run_dir!;
    const tryWith = async (photo_inputs: unknown, id: string) => (await w.cycle(designRequest({ id, photo_inputs }))).report;
    const execs = () => w.fakes.reduce((n, f) => n + f.execs, 0);
    // no such run
    expect(await tryWith({ request_id: "req-test-shop-p-nothing-1", files: [files[0]] }, "req-test-shop-p-d-1")).toMatchObject({ status: "refused", code: "PHOTO_INPUT_RUN_MISSING", invoked: false });
    // a SHA-256 the run does not have
    expect((await tryWith({ request_id: PHOTO_ID, files: [{ name: "photo-1.png", sha256: sha("other") }] }, "req-test-shop-p-d-2")).code).toBe("PHOTO_INPUT_SHA_MISMATCH");
    // a name the run does not have
    expect((await tryWith({ request_id: PHOTO_ID, files: [{ name: "photo-6.png", sha256: files[0]!.sha256 }] }, "req-test-shop-p-d-3")).code).toBe("PHOTO_INPUT_SHA_MISMATCH");
    // the file replaced by a link to the same bytes
    const parts = join(photoRun, "parts");
    const keep = join(tmp("sr-photo-keep-"), "photo-1.png");
    writeFileSync(keep, readFileSync(join(parts, "photo-1.png")));
    rmSync(join(parts, "photo-1.png"));
    symlinkSync(keep, join(parts, "photo-1.png"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-4")).code).toBe("PHOTO_INPUT_UNSAFE");
    rmSync(join(parts, "photo-1.png"));
    writeFileSync(join(parts, "photo-1.png"), readFileSync(keep));
    // a file grown past the cap (sparse; its size is checked before any read)
    truncateSync(join(parts, "photo-2.png"), 21 * 1024 * 1024);
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[1]] }, "req-test-shop-p-d-5")).code).toBe("PHOTO_INPUT_TOO_LARGE");
    // the receipt says another shop / kind, or not succeeded
    const receipt = one.report.receipt!;
    const original = readFileSync(receipt, "utf8");
    const rewrite = (edit: (r: Record<string, unknown>) => void) => {
      const r = JSON.parse(original) as Record<string, unknown>;
      edit(r);
      rmSync(receipt);
      writeFileSync(receipt, JSON.stringify(r), { mode: 0o600 });
    };
    rewrite((r) => (r.kind = "real_shop"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-6")).code).toBe("PHOTO_INPUT_RUN_MISMATCH");
    rewrite((r) => (r.shop = "test-shop-q"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-7")).code).toBe("PHOTO_INPUT_RUN_MISMATCH");
    rewrite((r) => (r.status = "stopped"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-8")).code).toBe("PHOTO_INPUT_RUN_NOT_SUCCEEDED");
    rewrite((r) => delete r.request_stage);
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-9")).code).toBe("PHOTO_INPUT_RUN_NOT_SUCCEEDED");
    rewrite((r) => (r.stop_code = "CODEX_TIMEOUT"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-11")).code).toBe("PHOTO_INPUT_RUN_NOT_SUCCEEDED");
    rewrite((r) => (r.interrupted = true));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-12")).code).toBe("PHOTO_INPUT_RUN_NOT_SUCCEEDED");
    // a receipt whose bytes are not the ones sealed into the inbox copy: not delivered
    rewrite(() => undefined);
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-13")).code).toBe("PHOTO_INPUT_NOT_DELIVERED");
    rmSync(receipt);
    writeFileSync(receipt, original, { mode: 0o600 });
    // no inbox copy, or a damaged one: not delivered
    const inboxCopy = join(w.runsDir, "review-inbox", PHOTO_ID);
    const aside = join(w.runsDir, "review-inbox", "aside-copy");
    cpSync(inboxCopy, aside, { recursive: true });
    rmSync(inboxCopy, { recursive: true });
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-14")).code).toBe("PHOTO_INPUT_NOT_DELIVERED");
    cpSync(aside, inboxCopy, { recursive: true });
    chmodSync(inboxCopy, 0o700);
    const sealed = join(inboxCopy, "parts", "photo-3.png");
    const keep3 = readFileSync(sealed);
    rmSync(sealed);
    writeFileSync(sealed, readFileSync(join(parts, "photo-4.png")), { mode: 0o600 });
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-15")).code).toBe("PHOTO_INPUT_NOT_DELIVERED");
    rmSync(sealed);
    writeFileSync(sealed, keep3, { mode: 0o600 });
    rmSync(aside, { recursive: true });
    // the approved design and the materials run only
    expect(execs()).toBe(2);
    // with everything restored, the first picture resolves again
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-10")).status).toBe("succeeded");
  });

  it("--validate-request: photo_inputs shape offline, files checked only once the photo run exists; it writes nothing", async () => {
    const w = home();
    const f = [{ name: "photo-1.png", sha256: sha("1") }];
    const design = w.place(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: f } }));
    expect(await validateRequestFile({ file: design.file, home: w.h, repo: w.repo })).toMatchObject({ request_id: DESIGN_ID, stage: "design", photo_inputs: "unchecked" });
    // DEV-303 §6.1 change 6: no approved design in this home yet: the materials request is refused
    const photo = w.place(photoRequest());
    expect(await codeOf(validateRequestFile({ file: photo.file, home: w.h, repo: w.repo }))).toBe("APPROVED_DESIGN_MISSING");
    const plain = w.place(designRequest({ id: "req-test-shop-p-plain-1" }));
    expect(await validateRequestFile({ file: plain.file, home: w.h, repo: w.repo })).toMatchObject({ stage: "design", photo_inputs: null });
    expect(existsSync(w.stateDir) || existsSync(w.ledgerDir)).toBe(false);
    // the run of an unchecked request is refused before anything (a run never starts on unchecked inputs)
    expect((await w.cycle(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: f } }))).report).toMatchObject({ status: "refused", code: "PHOTO_INPUT_RUN_MISSING", invoked: false });

    const { w: w2, files } = await stageOne();
    const good = w2.place(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: files.slice(0, 5) } }));
    expect(await validateRequestFile({ file: good.file, home: w2.h, repo: w2.repo })).toMatchObject({ photo_inputs: "checked" });
    // Issue #335: --validate-request names a request that would hand the image tool 6 reference pictures
    const six = w2.place(designRequest({ id: "req-test-shop-p-six-1", photo_inputs: { request_id: PHOTO_ID, files } }));
    expect(await codeOf(validateRequestFile({ file: six.file, home: w2.h, repo: w2.repo }))).toBe("PHOTO_INPUTS_OVER_TOOL_LIMIT");
    const bad = w2.place(designRequest({ id: "req-test-shop-p-bad-1", photo_inputs: { request_id: PHOTO_ID, files: f } }));
    expect(await codeOf(validateRequestFile({ file: bad.file, home: w2.h, repo: w2.repo }))).toBe("PHOTO_INPUT_SHA_MISMATCH");
  });
});

describe("DEV-303 image-once: --image only when photo inputs are given", () => {
  it("no inputs: the PoC's command line unchanged; more than 5 inputs (the image tool's limit) refused before any exec", async () => {
    const f = recordingFake();
    await generateImagesInOneRun({ sandbox: f.sandbox, prompt: "p", timeoutMs: 1_000, tmpBase: f.tmpBase, maxImages: 6 });
    expect(f.argv[0]).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-c", 'model_provider="openai"', "-c", "features.image_generation=true", "--cd", f.argv[0]![10]!, "-"]);
    // Issue #335 follow-up: the lower-level guard shares the request check's limit (lib/design-agent/image-tool-limits.ts)
    expect(IMAGE_TOOL_MAX_REFS).toBe(5);
    expect(PHOTO_TOOL_MAX_REFS).toBe(IMAGE_TOOL_MAX_REFS);
    for (const n of [6, 7]) await expect(generateImagesInOneRun({ sandbox: f.sandbox, prompt: "p", timeoutMs: 1_000, tmpBase: f.tmpBase, maxImages: 6, inputImages: Array.from({ length: n }, () => Buffer.alloc(30)) })).rejects.toThrow("at most 5 input and reference images");
    expect(f.argv).toHaveLength(1);
  });
});

describe("Issue #335 image-once with photo inputs (fake Codex): staged paths, a refused call named, the run's fixed facts", () => {
  it("5 --image args under <cwd>/inputs, TOOL_REFUSED_ARGS / CODEX_IMAGE_ARGS_REFUSED and the fixed diagnostics", async () => {
    const f = fakeCodex("six");
    const seen: { argv: string[]; stdin: string; staged: string[] }[] = [];
    const base = f.sandbox.run.bind(f.sandbox);
    f.sandbox.run = async (a, o) => {
      if (a[0] !== "exec") return base(a, o);
      f.execs += 1;
      seen.push({ argv: [...a], stdin: String(o.input ?? ""), staged: existsSync(join(o.workDir!, "inputs")) ? readdirSync(join(o.workDir!, "inputs")).sort() : [] });
      // what 0.159.0 leaves for a code-mode cell whose image call was refused before it started: no item, no picture
      const sessions = join(f.codexHome, "sessions", "2026", "11", "25");
      mkdirSync(sessions, { recursive: true });
      const recs = [
        { type: "session_meta", payload: { id: THREAD, cwd: o.workDir, cli_version: "0.159.0", history_mode: "paginated" } },
        { type: "turn_context", payload: { cwd: o.workDir, model: "gpt-6.1-terra" } },
        { type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "cell_1", name: "exec", input: "await tools.image_gen__imagegen({ prompt: 'x', referenced_image_paths: [] })" } },
        { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cell_1", output: [{ type: "input_text", text: "Script failed\nWall time 0.4 seconds\nOutput:\n" }, { type: "input_text", text: "Script error:\n`referenced_image_paths` must contain at most 5 paths" }] } },
      ];
      writeFileSync(join(sessions, `rollout-2026-11-25T01-00-00-${THREAD}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const stdout = [{ type: "thread.started", thread_id: THREAD }, { type: "item.completed", item: { type: "agent_message", text: "I stopped: the image tool refused the call." } }].map((e) => JSON.stringify(e)).join("\n");
      return { code: 0, signal: null, stdout: `${stdout}\n`, stderr: "", timedOut: false };
    };
    const photos = Array.from({ length: 5 }, (_, i) => colourPng(64 + i, 64));
    const prompt = "a fictional design batch\n";
    const r = await generateImagesInOneRun({ sandbox: f.sandbox, prompt, timeoutMs: 1_000, tmpBase: f.tmpBase, maxImages: 6, inputImages: photos });
    expect(seen).toHaveLength(1);
    const argv = seen[0]!.argv;
    const cwd = argv[argv.indexOf("--cd") + 1]!;
    expect(argv.filter((x) => x.startsWith("--image="))).toEqual([1, 2, 3, 4, 5].map((k) => `--image=${join(cwd, "inputs", `photo-${k}.png`)}`));
    expect(seen[0]!.staged).toEqual([1, 2, 3, 4, 5].map((k) => `photo-${k}.png`));
    expect(seen[0]!.stdin).toBe(prompt);
    expect(r).toMatchObject({ images: [], outcome: "TOOL_REFUSED_ARGS", stopCode: "CODEX_IMAGE_ARGS_REFUSED", imageCalls: 0, imageFailed: 0, threadId: THREAD });
    expect(r.diagnostics).toEqual({ exec_cells: 1, cell_named_image_tool: true, arg_error: true, arg_error_kind: "REF_PATHS_TOO_MANY", other_tool_calls: 0, tool_mode: "unknown", model: "gpt-6.1-terra", cli_version: "0.163.0", image_failure_reasons: [], answer: "TEXT_REFUSAL" });
    expect(JSON.stringify(r.diagnostics)).not.toMatch(/stopped|refused the call|must contain/);
    // without input images: no --image, the same naming of the refusal
    seen.length = 0;
    expect((await generateImagesInOneRun({ sandbox: f.sandbox, prompt, timeoutMs: 1_000, tmpBase: f.tmpBase, maxImages: 6 })).stopCode).toBe("CODEX_IMAGE_ARGS_REFUSED");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.stdin).toBe(prompt);
    expect(seen[0]!.argv.some((x) => x.startsWith("--image="))).toBe(false);
  });
});

describe("DEV-303 the audit CLI skips an image-materials bundle; the private record's use", () => {
  const ENTRY = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/audit-cli-entry.ts");
  /** The real audit CLI function through its test entry, with a fake claude that leaves a mark if it is ever started. */
  const audit = (h: string, args: string[]) => {
    const bin = tmp("sr-photo-claude-");
    const mark = join(bin, "claude-was-started");
    const claude = join(bin, "claude");
    writeFileSync(claude, `#!/bin/sh\ntouch '${mark}'\nexit 1\n`, { mode: 0o700 });
    const r = spawnSync(process.execPath, ["--import", "tsx", ENTRY, claude, "/bin/false", ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h, XDG_STATE_HOME: join(h, "xdg-state") } as unknown as NodeJS.ProcessEnv, timeout: 120_000 });
    const line = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null") as Record<string, unknown> | null;
    return { status: r.status, line, started: existsSync(mark) };
  };

  it("photo materials: --dry-run 'planned' and the run 'completed', audit skipped, exit 0, no claude, nothing written; a design run is audited as before", async () => {
    const { w, d1 } = await stageOne();
    const inbox = join(w.runsDir, "review-inbox");
    const before = readdirSync(inbox).sort();
    for (const [args, status] of [[[PHOTO_ID, "--dry-run"], "planned"], [[PHOTO_ID], "completed"]] as const) {
      const r = audit(w.h, [...args]);
      expect([r.status, r.started], args.join(" ")).toEqual([0, false]);
      expect(r.line).toMatchObject({ status, code: null, approval_id: PHOTO_ID, bundle_sha256: d1.bundle_sha256, image_material: true, audit: "skipped", skipped: "image materials are reviewed by Claude, no audit call", calls: 0, verdict: null });
    }
    expect(readdirSync(inbox).sort()).toEqual(before);
    expect(existsSync(join(inbox, "audits"))).toBe(false);
    expect(existsSync(join(w.h, "xdg-state"))).toBe(false);

    // a design run goes through the design audit path unchanged (no skip)
    const two = await w.cycle(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: [] } }));
    expect(two.report.status).toBe("refused");
    const design = await w.cycle(designRequest({ id: "req-test-shop-p-design-2" }));
    expect(design.report.status).toBe("succeeded");
    await deliverReview({ approvalId: "req-test-shop-p-design-2", runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
    // (the fake systemctl answers nothing, so the design audit's own jail check refuses: the design path, never the skip)
    const r = audit(w.h, ["req-test-shop-p-design-2", "--dry-run"]);
    expect([r.started, r.line?.audit, r.line?.image_material, r.line?.code]).toEqual([false, undefined, undefined, "JAIL_STATE_UNKNOWN"]);
  });

  it("the real shop's private record says what the run is for", () => {
    const parse = (o: Record<string, unknown>) => parseRequest(bytesOf(o), sha(bytesOf(o)), o.id as string).request;
    expect(recordUseOf(parse(photoRequest()))).toBe("sales_proposal_image_material");
    expect(recordUseOf(parse(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: [{ name: "photo-1.png", sha256: sha("1") }] } })))).toBe("proposal_demo_design");
    expect(recordUseOf(parse(designRequest()))).toBe("internal_design_reference_only");
  });
});
