import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { generateImagesInOneRun } from "@/lib/design-agent/design-image/image-once";
import { PromptStop } from "@/lib/design-agent/image-first/prompt";
import { buildPhotoPlan, buildRequestPlan, DEMO_MARKER, parseRequest, PHOTO_LABEL, type DesignRequest, type PhotoMaterialsRequest } from "@/lib/design-agent/image-first/request-prompt";
import { gitCommitState, type WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { IMAGE_MATERIAL_LABEL, verifyBundleDir } from "@/lib/design-agent/imagefirst-worker/bundle";
import { deliverReview } from "@/lib/design-agent/imagefirst-worker/deliver-review";
import { loadRequestRun, validateRequestFile } from "@/lib/design-agent/imagefirst-worker/request";
import { runRequestCycle } from "@/lib/design-agent/imagefirst-worker/request-cycle";
import { runLoadedRequest } from "@/lib/design-agent/imagefirst-worker/request-run";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { entryFromInbox } from "@/lib/design-agent/research-log/intake";
import { parseArgs } from "@/scripts/design-artifact/phase2f-live-cli";
import { colourPng } from "../phase2f/fixtures";
import { cleanupTemps, ENV, fakeCodex, git, NOW, REPO, sha, THREAD, tmp, workerRepo, type Fake } from "./support";

// DEV-303 (owner decision 2026-11-24): the two-stage IMAGE_FIRST request flow — stage 1 photo_materials (1..6 picture
// materials, one Codex run), stage 2 design with photo_inputs (the stage-1 pictures attached to the one Codex run with
// --image, never copied into the design run or its inbox bundle). FICTIONAL fixtures only (the "real_shop" pack is
// invented for the test). A FAKE Codex: no model, no image tool, no network.

vi.setConfig({ testTimeout: 90_000 });
afterAll(cleanupTemps);

const SHOP = "test-shop-p";
const FACTS: FactsPack = {
  schema: "shop_facts_pack_v1",
  shop_id: SHOP,
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
const FACTS_BYTES = Buffer.from(`${JSON.stringify(FACTS, null, 2)}\n`);
const DIRECTION = {
  name: "粉の朝",
  concept: "粉の白さと朝の光を、余白の多い静かな画面にする。",
  palette: "生成りの地に焦げ茶と薄い灰。",
  typography: "明朝体の大きな見出しと細いゴシックの本文。",
  layout_pc: "左右二段。左に大きな店名、右に情報をまとめる。",
  layout_sp: "一段。店名を最初の画面いっぱいに置く。",
  avoid: "派手なグラデーション。",
};
const BRIEF = {
  subjects: ["焼き色のついたパンの皮の質感の接写", "台に広がった小麦粉と木の麺棒", "生地をこねる手元（顔は写さない）", "朝の窓から差す斜めの光と粉の舞い", "使い込んだ焼き型と布", "割ったパンの断面の気泡"],
  mood: "朝の静かな光、自然な色、やわらかい影。",
  avoid: "文字、看板、ロゴ、人の顔、店の外観や店内。",
};
const PHOTO_ID = "req-test-shop-p-photos-1";
const DESIGN_ID = "req-test-shop-p-design-1";
const envelope = (id: string) => ({ schema: "sr_imagefirst_request_v1", id, shop_id: SHOP, kind: "real_shop", created_at: "2026-11-24T00:30:00Z", facts_ref: { root: "second-root-shops", shop_id: SHOP }, facts_sha256: sha(FACTS_BYTES), codex_runs: 1 });
const photoRequest = (over: Record<string, unknown> = {}) => ({ ...envelope(PHOTO_ID), stage: "photo_materials", photo_brief: BRIEF, max_images: 6, ...over });
const designRequest = (over: Record<string, unknown> = {}) => ({ ...envelope(DESIGN_ID), stage: "design", direction: DIRECTION, max_images: 6, ...over });
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
          const r = await generateImagesInOneRun({ sandbox: fake.sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: fake.tmpBase, maxImages: o.maxImages, ...(o.inputImages ? { inputImages: o.inputImages } : {}) });
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

/** Stage 1 in a fresh home: 6 photo materials; returns the home, the report and the files as photo_inputs names them. */
async function stageOne() {
  const w = home();
  const one = await w.cycle(photoRequest());
  expect(one.report).toMatchObject({ status: "succeeded", stage: "photo_materials", approval_id: PHOTO_ID });
  const files = one.report.photo_files!;
  return { w, one, files };
}

describe("DEV-303 photo_materials request schema (strict; same unsafe-text filter as direction)", () => {
  it("accepts the documented photo request; one picture per subject (max_images = subjects)", () => {
    expect(parseCode(photoRequest())).toBe("ok");
    expect(parseCode(photoRequest({ photo_brief: { ...BRIEF, subjects: BRIEF.subjects.slice(0, 2) }, max_images: 2 }))).toBe("ok");
  });
  it("refuses wrong counts, lengths, extra fields and a mixed stage", () => {
    for (const over of [
      { max_images: 5 },
      { photo_brief: { ...BRIEF, subjects: [] }, max_images: 1 },
      { photo_brief: { ...BRIEF, subjects: [...BRIEF.subjects, "七つ目"] }, max_images: 7 },
      { photo_brief: { ...BRIEF, subjects: ["あ".repeat(201)] }, max_images: 1 },
      { photo_brief: { ...BRIEF, mood: "あ".repeat(301) } },
      { photo_brief: { ...BRIEF, avoid: "あ".repeat(301) } },
      { photo_brief: { ...BRIEF, extra: "x" } },
      { direction: DIRECTION },
      { photo_inputs: { request_id: "req-other-1", files: [{ name: "photo-1.png", sha256: "a".repeat(64) }] } },
      { codex_runs: 2 },
      { stage: "photos" },
    ]) expect(parseCode(photoRequest(over)), JSON.stringify(over).slice(0, 80)).toBe("REQUEST_INVALID");
    expect(parseCode(designRequest({ photo_brief: BRIEF }))).toBe("REQUEST_INVALID");
  });
  it("refuses URLs, HTML, quotes, digit runs, currency and control characters in the brief", () => {
    for (const bad of ["https://example.com の写真", "<b>パン</b>", "「新作」の札", "\"Fresh\"", "2026 年の朝", "500円のパン", "改行\nあり", "www.example.jp 風"]) {
      expect(parseCode(photoRequest({ photo_brief: { ...BRIEF, subjects: [bad] }, max_images: 1 })), bad).toBe("REQUEST_PHOTO_BRIEF_UNSAFE");
      expect(parseCode(photoRequest({ photo_brief: { ...BRIEF, mood: bad } })), bad).toBe("REQUEST_PHOTO_BRIEF_UNSAFE");
    }
  });
  it("design photo_inputs: shape only (1..6 files, photo-N.png, SHA-256, unique, another request id)", () => {
    const f = (n: number) => ({ name: `photo-${n}.png`, sha256: sha(String(n)) });
    expect(parseCode(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: [1, 2, 3, 4, 5, 6].map(f) } }))).toBe("ok");
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
  const plan = buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS });
  it("stage 1: one prompt per subject, web-friendly frames, no facts value, the material rules", () => {
    expect([plan.photos.length, plan.batch.images]).toEqual([6, 6]);
    expect(plan.photos.map((p) => p.aspect)).toEqual(["landscape_3x2", "landscape_3x2", "square_1x1", "square_1x1", "portrait_2x3", "portrait_2x3"]);
    expect(plan.photos.map((p) => p.file)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `parts/photo-${n}.png`));
    for (const p of plan.photos) {
      for (const f of FACTS.facts) if (f.key !== "category") expect(p.prompt.includes(f.value), `${p.name}: ${f.key}`).toBe(false);
      expect(p.prompt).toContain("特定の店の記録写真ではなく");
      expect(p.prompt).toContain("文字・数字・記号・看板・ロゴ");
      expect(p.prompt).toContain("人の顔や頭を写さない");
      expect(p.prompt).toContain("値札・メニュー表を写さない");
    }
    expect(plan.batch.prompt).toContain("exactly 6 times");
    expect(plan.batch.prompt).toContain("1536x1024");
    expect(buildPhotoPlan({ request: photo, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS }).plan_sha256).toBe(plan.plan_sha256);
  });
  it("stage 1: a brief quoting a facts value is refused", () => {
    const quoting = { ...photo, photo_brief: { ...photo.photo_brief, mood: "架空パン工房 こむぎの木 の朝" } };
    expect(() => buildPhotoPlan({ request: quoting, requestSha256: "a".repeat(64), factsBytes: FACTS_BYTES, facts: FACTS })).toThrow(PromptStop);
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

describe("DEV-303 two stages end to end (fake Codex): 2 runs, at most 12 pictures", () => {
  it("stage 1 makes 6 materials in its own run; stage 2 attaches them with --image and leaves only its own 6 pictures in parts/ and the inbox", async () => {
    const { w, one, files } = await stageOne();
    expect([one.fake.execs, one.fake.attached[0]]).toEqual([1, []]);
    const photoRun = one.report.run_dir!;
    expect(photoRun.startsWith(w.runsDir)).toBe(true);
    expect(statSync(photoRun).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(photoRun, "parts")).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `photo-${n}.png`));
    expect(existsSync(join(photoRun, "photo-brief.json"))).toBe(true);
    const r1 = JSON.parse(readFileSync(one.report.receipt!, "utf8")) as WorkerReceipt;
    expect(r1).toMatchObject({ status: "succeeded", verified: true, mode: "request", request_stage: "photo_materials", request_id: PHOTO_ID, kind: "real_shop", shop: SHOP, counts: { pc: 0, sp: 0, photo: 6, total: 6, stopped: 0 }, images_total: 6 });
    expect(files.map((f) => f.name)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `photo-${n}.png`));
    expect(files.map((f) => f.sha256)).toEqual(r1.images.map((i) => i.sha256));
    // one use per request id
    expect((await w.cycle(photoRequest())).report).toMatchObject({ status: "refused", code: "REQUEST_ALREADY_CLAIMED", invoked: false });

    // stage 1 reaches the review inbox like a design: sealed, verified, marked as image materials, at most 6 pictures
    const d1 = await deliverReview({ approvalId: PHOTO_ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
    expect(d1).toMatchObject({ status: "delivered", approval_id: PHOTO_ID, bundle: "sealed" });
    const photoInbox = join(w.runsDir, "review-inbox", PHOTO_ID);
    expect(imagesUnder(photoInbox).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `parts/photo-${n}.png`));
    const pm = JSON.parse(readFileSync(join(photoInbox, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(pm).toMatchObject({ bundle_id: PHOTO_ID, mode: "request", kind: "real_shop", image_material: true, image_material_label: IMAGE_MATERIAL_LABEL, counts: { pc: 0, sp: 0, photo: 6, composites: 0 } });
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
    // never logged in the research log (a real shop's, and a photo-materials bundle in any case)
    expect(await codeOf(entryFromInbox({ repo: w.repo, inbox: join(w.runsDir, "review-inbox"), bundleId: PHOTO_ID, shop: SHOP, direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-24T02:00:00Z" }))).not.toBe("resolved");
    const fakeInbox = tmp("sr-photo-intake-");
    mkdirSync(join(fakeInbox, "req-hoshigama-photos-1"));
    mkdirSync(join(fakeInbox, "previews", "req-hoshigama-photos-1"), { recursive: true });
    const idx = JSON.parse(readFileSync(join(w.runsDir, "review-inbox", "previews", PHOTO_ID, "INDEX.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(fakeInbox, "previews", "req-hoshigama-photos-1", "INDEX.json"), JSON.stringify({ ...idx, bundle_id: "req-hoshigama-photos-1", approval_id: "req-hoshigama-photos-1", plan_id: "req-hoshigama-photos-1" }));
    writeFileSync(join(fakeInbox, "req-hoshigama-photos-1", "manifest.json"), JSON.stringify({ bundle_id: "req-hoshigama-photos-1", mode: "request", kind: "fictional", shop: "hoshigama", image_material: true }));
    expect(await codeOf(entryFromInbox({ repo: REPO, inbox: fakeInbox, bundleId: "req-hoshigama-photos-1", shop: "hoshigama", direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-24T02:00:00Z" }))).toBe("PHOTO_MATERIALS_NOT_LOGGED");

    // stage 2: the design request naming all 6 pictures
    const two = await w.cycle(designRequest({ photo_inputs: { request_id: PHOTO_ID, files } }));
    expect(two.report).toMatchObject({ status: "succeeded", approval_id: DESIGN_ID });
    expect(two.fake.execs).toBe(1);
    // the one exec got exactly the 6 pictures as --image attachments (copies in the call's temporary work dir)
    expect(two.fake.attached[0]).toEqual(files.map((f) => f.sha256));
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
    expect(JSON.parse(readFileSync(join(designRun, "photo-inputs.json"), "utf8"))).toMatchObject({ request_id: PHOTO_ID, files });
    const r2 = JSON.parse(readFileSync(two.report.receipt!, "utf8")) as WorkerReceipt;
    expect(r2).toMatchObject({ status: "succeeded", counts: { pc: 2, sp: 4, total: 6, stopped: 0 }, images_total: 6, photo_inputs: { request_id: PHOTO_ID, files } });
    const d = await deliverReview({ approvalId: DESIGN_ID, runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, { fileAt: async () => null, onOriginDevelop: async () => true });
    expect(d.status).toBe("delivered");
    const inboxCopy = join(w.runsDir, "review-inbox", DESIGN_ID);
    expect(imagesUnder(inboxCopy).length).toBe(6);
    for (const n of imagesUnder(inboxCopy)) expect(inputShas.has(sha(readFileSync(join(inboxCopy, n))))).toBe(false);
    // the stage-1 run and its inbox copy are untouched: still 6 pictures each (root's per-directory count, at most 6)
    expect(imagesUnder(join(photoRun, "parts")).length).toBe(6);
    expect(imagesUnder(photoInbox).length).toBe(6);
    for (const dir of [join(photoRun, "parts"), photoInbox, join(designRun, "parts"), inboxCopy]) expect(imagesUnder(dir).length, dir).toBeLessThanOrEqual(6);
    // in all: 2 runs, 12 pictures; the design request is used once
    expect(w.fakes.reduce((n, f) => n + f.execs, 0)).toBe(2);
    expect((await w.cycle(designRequest({ photo_inputs: { request_id: PHOTO_ID, files } }))).report.code).toBe("REQUEST_ALREADY_CLAIMED");
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
    rewrite((r) => (r.kind = "fictional"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-6")).code).toBe("PHOTO_INPUT_RUN_MISMATCH");
    rewrite((r) => (r.shop = "test-shop-q"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-7")).code).toBe("PHOTO_INPUT_RUN_MISMATCH");
    rewrite((r) => (r.status = "stopped"));
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-8")).code).toBe("PHOTO_INPUT_RUN_NOT_SUCCEEDED");
    rewrite((r) => delete r.request_stage);
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-9")).code).toBe("PHOTO_INPUT_RUN_NOT_SUCCEEDED");
    rewrite(() => undefined);
    expect(execs()).toBe(1);
    // with everything restored, the first picture resolves again
    expect((await tryWith({ request_id: PHOTO_ID, files: [files[0]] }, "req-test-shop-p-d-10")).status).toBe("succeeded");
  });

  it("--validate-request: photo_inputs shape offline, files checked only once the photo run exists; it writes nothing", async () => {
    const w = home();
    const f = [{ name: "photo-1.png", sha256: sha("1") }];
    const design = w.place(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: f } }));
    expect(await validateRequestFile({ file: design.file, home: w.h, repo: w.repo })).toMatchObject({ request_id: DESIGN_ID, stage: "design", photo_inputs: "unchecked" });
    const photo = w.place(photoRequest());
    expect(await validateRequestFile({ file: photo.file, home: w.h, repo: w.repo })).toMatchObject({ request_id: PHOTO_ID, stage: "photo_materials", photo_inputs: null });
    const plain = w.place(designRequest({ id: "req-test-shop-p-plain-1" }));
    expect(await validateRequestFile({ file: plain.file, home: w.h, repo: w.repo })).toMatchObject({ stage: "design", photo_inputs: null });
    expect(existsSync(w.stateDir) || existsSync(w.ledgerDir)).toBe(false);
    // the run of an unchecked request is refused before anything (a run never starts on unchecked inputs)
    expect((await w.cycle(designRequest({ photo_inputs: { request_id: PHOTO_ID, files: f } }))).report).toMatchObject({ status: "refused", code: "PHOTO_INPUT_RUN_MISSING", invoked: false });

    const { w: w2, files } = await stageOne();
    const good = w2.place(designRequest({ photo_inputs: { request_id: PHOTO_ID, files } }));
    expect(await validateRequestFile({ file: good.file, home: w2.h, repo: w2.repo })).toMatchObject({ photo_inputs: "checked" });
    const bad = w2.place(designRequest({ id: "req-test-shop-p-bad-1", photo_inputs: { request_id: PHOTO_ID, files: f } }));
    expect(await codeOf(validateRequestFile({ file: bad.file, home: w2.h, repo: w2.repo }))).toBe("PHOTO_INPUT_SHA_MISMATCH");
  });
});

describe("DEV-303 image-once: --image only when photo inputs are given", () => {
  it("no inputs: the PoC's command line unchanged; more than 6 inputs refused", async () => {
    const f = recordingFake();
    await generateImagesInOneRun({ sandbox: f.sandbox, prompt: "p", timeoutMs: 1_000, tmpBase: f.tmpBase, maxImages: 6 });
    expect(f.argv[0]).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-c", 'model_provider="openai"', "-c", "features.image_generation=true", "--cd", f.argv[0]![10]!, "-"]);
    await expect(generateImagesInOneRun({ sandbox: f.sandbox, prompt: "p", timeoutMs: 1_000, tmpBase: f.tmpBase, maxImages: 6, inputImages: Array.from({ length: 7 }, () => Buffer.alloc(30)) })).rejects.toThrow("at most 6 input images");
  });
});
