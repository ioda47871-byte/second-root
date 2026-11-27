import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSite } from "@/experiments/pages-cms/build";
import { readPackage } from "@/lib/demo-version-package/package";
import { DeliveryError, writeDelivery } from "@/experiments/pages-cms/delivery";
import { boxFor, fictionalRights, Q1_TODAY, solidPng, writeFixture } from "@/experiments/pages-cms/fixtures";
import { runQ1OnRepo } from "@/experiments/pages-cms/q1-check";
import { BAKERY_SITE } from "@/experiments/pages-cms/shop-site";
import { stageForGates } from "@/experiments/pages-cms/stage-for-gates";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { checkDesignApproval, DESIGN_AXES } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { approvedFinal, checkFinalApproval, FINAL_AXES, writeFinalReviewPage } from "@/lib/design-agent/imagefirst-worker/final-approval";
import { runImplCompare } from "@/lib/design-agent/imagefirst-worker/impl-compare-approved";
import { approvedMaterials, materialsReviewPageSha256, parseMaterialsReview, readDeliveredMaterials } from "@/lib/design-agent/imagefirst-worker/materials-approval";
import { checkMaterialsInSite } from "@/lib/design-agent/imagefirst-worker/materials-impl-check";
import { printRequestPlan, validateRequestFile } from "@/lib/design-agent/imagefirst-worker/request";
import { assertCaseStudyGate, inspectCaseStudy } from "@/lib/design-agent/case-study/case-study";
import { approveRehearsal, REHEARSAL_ID, REHEARSAL_SHOP, sealRehearsal } from "@/lib/design-agent/imagefirst-worker/rehearsal";
import { checkImageFirstTransforms, IMAGE_FIRST_DEPICTION_SCHEMA, IMAGE_FIRST_DEPICTION_STATEMENT, IMAGE_FIRST_MODEL_ROLE, IMAGE_FIRST_PACKAGE_SCHEMA, imageFirstProvenance, main as packageLocal, type PhotoTransform } from "@/scripts/sales/demo-version/package-local";
import { caseStudyObject } from "../design-agent/imagefirst-worker/support";

// DEV-364 P0 (the owner's reprioritisation 2026-11-26: ONE completed demo first): the fictional bakery end to end, in
// temporary folders only, with the existing gates. FICTIONAL data (the research log's fictional bakery 架空のパン屋),
// invented pictures, and MOCK records wherever an owner's decision or a generation would be: each mock record carries
// モック／架空 in its note, and the step report marks every step real / mock / synthetic / blocked.
//
// The first-approved design here is CIRCULAR, a mock: it is the bakery page's own PC / SP drawing sealed with packBundle
// (the tests' way; no CLI can mint such a bundle, and the synthetic refusals stay as they are). The real flow is the
// other way round: Codex draws the whole-page design, the owner approves it, Claude implements the page from it.
// Nothing is generated (no Codex), sent, published or written into the repository.

vi.setConfig({ testTimeout: 300_000 });
const REPO = resolve(__dirname, "../../..");
const temps: string[] = [];
const tmp = (p = "sr-p0-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const write = (p: string, b: Buffer) => writeFileSync(p, b, { mode: 0o600 });
const MOCK = "モック／架空（試験の fixture。オーナーの判断・実際の生成ではない）";

const SHOP = "hoshigama";
const FACTS = readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bakery/facts-pack.json"));
const DESIGN_ID = "req-hoshigama-p0-design-1";
const MAT_ID = "req-hoshigama-p0-photos-1";
/** The two pictures the approved materials will be (invented): a 3:2 and a square. */
const PICTURES: Record<string, Buffer> = { "photo-1.png": solidPng(768, 512, [150, 98, 60]), "photo-3.png": solidPng(600, 600, [222, 200, 160]) };
const MATERIALS = [
  { id: "crust-texture", kind: "photo", aspect: "landscape_3x2", placement: "PC の品書きの最初の写真の枠", note: "焼き色のついたパンの皮の質感の接写" },
  { id: "flour-board", kind: "photo", aspect: "square_1x1", placement: "品書きの二つ目の写真の枠", note: "台に広がった小麦粉の淡い面" },
];
const FILE_OF: Record<string, string> = { "crust-texture": "photo-1.png", "flour-board": "photo-3.png" };

type Kind = "real" | "mock" | "synthetic" | "blocked";
type StepRow = { n: string; step: string; kind: Kind; result: string; note?: string };

/** The page as the menu shows it: items-3 of the bakery with the two pictures as generated materials (A). */
async function bakeryRepo(repo: string) {
  const fx = BAKERY_SITE.fixtures()["items-3"]!;
  const names = Object.keys(PICTURES);
  const menu = fx.menu.map((m, k) => (k < names.length ? { ...m, image: `/media/${names[k]}`, imageAlt: `試験の画像 ${k + 1}`, imageKind: "generated" as const } : { ...m, image: "", imageAlt: "" }));
  await writeFixture(repo, { ...fx, menu, media: PICTURES, generated: names });
}

/** A staged site drawn at PC 1440 / SP 390 (JS off, its own files only); SP at 2× to meet the bundle's 512 px minimum. */
async function drawing(siteDir: string): Promise<{ pc: Buffer; sp: Buffer }> {
  const shot = async (width: number) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: false, deviceScaleFactor: width < 512 ? 2 : 1 });
    try {
      await ctx.route("**/*", async (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^\/+/, "") || "index.html";
        const ok = /^(index\.html|style\.css|assets\/[A-Za-z0-9._-]+\.png)$/.test(rel);
        return ok ? route.fulfill({ status: 200, body: readFileSync(join(siteDir, rel)), contentType: rel.endsWith(".html") ? "text/html; charset=utf-8" : rel.endsWith(".css") ? "text/css" : "image/png" }) : route.fulfill({ status: 404, body: "" });
      });
      const page = await ctx.newPage();
      await page.goto("http://design.invalid/index.html", { waitUntil: "load" });
      return await page.screenshot({ fullPage: true });
    } finally {
      await ctx.close();
    }
  };
  return { pc: await shot(1440), sp: await shot(390) };
}

/** A mock materials run (sealed with packBundle), its review and its approval, for a given approved design. */
async function sealMockMaterials(o: { id: string; shop: string; approved_design: { bundle_id: string; bundle_sha256: string; review_sha256: string; approval_sha256: string }; reviews: string; inbox: string }) {
  const runs = tmp("sr-p0-mruns-");
  const mRun = join(runs, `${o.id}-20261126T020000Z`);
  mkdirSync(join(mRun, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(mRun, 0o700);
  const mImages = Object.entries(PICTURES).map(([name, b]) => {
    write(join(mRun, "parts", name), b);
    return { file: `parts/${name}`, sha256: sha(b), bytes: b.length };
  });
  write(join(mRun, "approved-design-input.json"), Buffer.from(JSON.stringify({ schema: "image_first_approved_design_input_v0", ...o.approved_design, materials_sha256: "9".repeat(64) })));
  const receipt = {
    schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, cli_exit: 0, cli_timed_out: false, interrupted: false,
    shop: o.shop, direction: "request", approval_id: o.id, plan_id: o.id, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 4000,
    run_dir: mRun, images: mImages, stopped_images: [], verified: true,
    timings: { started_at: "2026-11-26T02:00:00.000Z", finished_at: "2026-11-26T02:05:00.000Z", elapsed_ms: 300_000 },
    mode: "request", kind: "fictional", request_id: o.id, request_sha256: "a".repeat(64), facts_sha256: "e".repeat(64), images_total: mImages.length,
    counts: { pc: 0, sp: 0, photo: mImages.length, total: mImages.length, stopped: 0 }, request_stage: "photo_materials", approved_design: o.approved_design, materials_sha256: "9".repeat(64),
  };
  const receiptPath = join(runs, "materials.receipt.json");
  write(receiptPath, Buffer.from(JSON.stringify(receipt)));
  const sealed = await packBundle({ runDir: mRun, receiptPath, bundlesDir: o.inbox, now: () => Date.parse("2026-11-26T02:06:00Z") });
  const review = bytesOf({ schema: "sr_materials_review_v1", request_id: o.id, bundle_sha256: sealed.bundle_sha256, materials: mImages.map((img, n) => ({ id: MATERIALS[n]!.id, file: img.file, sha256: img.sha256, verdict: "pass", note: MOCK })), reviewer: "mock-review", reviewed_at: "2026-11-26T03:00:00Z" });
  const reviewPath = join(o.reviews, `${o.id}.materials-review.json`);
  write(reviewPath, review);
  const approvalPath = join(o.reviews, `${o.id}.materials-approval.json`);
  write(approvalPath, bytesOf({ schema: "sr_materials_approval_v1", request_id: o.id, bundle_sha256: sealed.bundle_sha256, review_sha256: sha(review), page_sha256: materialsReviewPageSha256(parseMaterialsReview(review), await readDeliveredMaterials(sealed.dir)), approved_materials: mImages.map((i) => ({ file: i.file, sha256: i.sha256 })), decision: "approve", decided_at: "2026-11-26T04:00:00Z", note: MOCK }));
  return { bundleDir: sealed.dir, reviewPath, approvalPath };
}

describe("DEV-364 P0: the fictional bakery end to end (temp only; mock owner decisions; no generation)", () => {
  it("runs every step with the existing gates and writes the step report", async () => {
    const steps: StepRow[] = [];
    const step = (n: string, s: string, kind: Kind, result: string, note?: string) => steps.push({ n, step: s, kind, result, ...(note ? { note } : {}) });
    const home = tmp("sr-p0-home-");
    const shopDir = join(home, "second-root-shops", SHOP);
    const reviews = join(shopDir, "design-reviews");
    mkdirSync(reviews, { recursive: true, mode: 0o700 });
    write(join(shopDir, "facts-pack.json"), FACTS);
    mkdirSync(join(home, "sr-runs"), { mode: 0o700 });

    // 1. success-case reference and analysis (mock owner confirmation)
    const csPath = join(shopDir, "case-study.json");
    // (the fixture's owner_confirmation is the mock; the record's strict schema has no note field)
    write(csPath, bytesOf(caseStudyObject(SHOP)));
    const cs = await inspectCaseStudy(readFileSync(csPath), { repo: REPO });
    assertCaseStudyGate(cs, "gate");
    step("1", "success-case reference and analysis (case-study gate)", "mock", "passed", "fixture analysis of 3 repository originals; owner_confirmation is a mock");

    // 2. shop-specific direction: the whole-page design request, validated, and what the one Codex run would be sent
    const reqDir = tmp("sr-p0-req-");
    const envelope = (id: string) => ({ schema: "sr_imagefirst_request_v1", id, shop_id: SHOP, kind: "fictional", created_at: "2026-11-26T00:30:00Z", facts_ref: { root: "second-root-shops", shop_id: SHOP }, facts_sha256: sha(FACTS), codex_runs: 1 });
    const direction = { name: "粉の朝", concept: "粉の白さと朝の光を、余白の多い静かな画面にする。", palette: "生成りの地に焦げ茶と薄い灰。", typography: "明朝体の大きな見出しと細いゴシックの本文。", layout_pc: "左右二段。左に大きな店名、右に情報をまとめる。", layout_sp: "一段。店名を最初の画面いっぱいに置く。", avoid: "派手なグラデーション。" };
    const designReqPath = join(reqDir, `${DESIGN_ID}.json`);
    write(designReqPath, bytesOf({ ...envelope(DESIGN_ID), stage: "design", layout: "whole_page", direction, case_study: { path: "case-study.json", sha256: sha(readFileSync(csPath)) }, max_images: 2 }));
    const v = await validateRequestFile({ file: designReqPath, home, repo: REPO });
    const plan = await printRequestPlan({ file: designReqPath, home, repo: REPO, checkout: async () => ({ head: null, base: null, clean: false }) });
    expect(plan.plan_sha256).toBe(v.plan_sha256);
    expect(plan.sent.max_images).toBe(2);
    step("2", "shop-specific direction: whole-page request validated and its Codex plan printed", "real", "valid", "the direction text is written for the fictional bakery; no Codex run");

    // 3. PC / SP whole-page composition: MOCK, circular — the bakery page's own drawing sealed as the "design"
    const draftRepo = join(tmp(), "repo");
    await bakeryRepo(draftRepo);
    const draftDist = join(tmp(), "dist");
    await buildSite({ repo: draftRepo, outDir: draftDist, today: Q1_TODAY });
    const draftStaged = await stageForGates({ dist: draftDist, outDir: join(tmp(), "staged") });
    const pics = await drawing(draftStaged.dir);
    const runs = tmp("sr-p0-runs-");
    const runDir = join(runs, `${DESIGN_ID}-20261126T010000Z`);
    mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);
    const images = (["pc", "sp"] as const).map((view) => {
      write(join(runDir, "parts", `${view}-1.png`), pics[view]);
      return { file: `parts/${view}-1.png`, sha256: sha(pics[view]), bytes: pics[view].length };
    });
    const references = [{ id: "ref-1", case_id: "CP-001", sha256: sha("p0 reference (mock)") }];
    write(join(runDir, "reference-inputs.json"), Buffer.from(JSON.stringify({ schema: "image_first_reference_inputs_v0", layout: "whole_page", references })));
    const reqSha = sha(readFileSync(designReqPath));
    const receipt = {
      schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, cli_exit: 0, cli_timed_out: false, interrupted: false,
      shop: SHOP, direction: "request", approval_id: DESIGN_ID, plan_id: DESIGN_ID, commit: "c".repeat(40), packet_sha256: reqSha, plan_sha256: v.plan_sha256, prompt_sha256: plan.sent.prompt_sha256, prompt_chars: plan.sent.prompt_chars,
      run_dir: runDir, images, stopped_images: [], verified: true,
      timings: { started_at: "2026-11-26T01:00:00.000Z", finished_at: "2026-11-26T01:05:00.000Z", elapsed_ms: 300_000 },
      mode: "request", kind: "fictional", request_id: DESIGN_ID, request_sha256: reqSha, facts_sha256: sha(FACTS), images_total: 2,
      counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, design_layout: "whole_page", reference_images: references,
    };
    const receiptPath = join(runs, "design.receipt.json");
    write(receiptPath, Buffer.from(JSON.stringify(receipt)));
    const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(home, "sr-runs", "review-inbox"), now: () => Date.parse("2026-11-26T01:06:00Z") });
    expect(sealed.manifest.synthetic).toBeUndefined();
    step("3", "PC/SP whole-page composition", "mock", "sealed", "CIRCULAR mock: the bakery page's own drawing sealed with packBundle in place of a Codex run (real flow: design first, then Claude implements)");

    // 4. first approval (mock)
    const pick = (view: "pc" | "sp") => images.filter((i) => i.file.startsWith(`parts/${view}-`)).map((i) => ({ file: i.file, sha256: i.sha256 }));
    const axis = { verdict: "pass", evidence: [{ image: "pc", region: "ページ全体", note: MOCK }] };
    const reviewPath = join(reviews, `${DESIGN_ID}.review.json`);
    write(reviewPath, bytesOf({ schema: "sr_design_review_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, images: { pc: pick("pc"), sp: pick("sp") }, axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, axis])), reviewer: "mock-review", reviewed_at: "2026-11-26T01:10:00Z" }));
    const dDraft = await checkDesignApproval({ bundleDir: sealed.dir, reviewPath, repo: REPO, mode: "draft" });
    const approvalPath = join(reviews, `${DESIGN_ID}.approval.json`);
    write(approvalPath, bytesOf({ schema: "sr_design_approval_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, approved_images: { pc: pick("pc"), sp: pick("sp") }, review_sha256: dDraft.review_sha256, page_sha256: dDraft.page_sha256, decision: "approve", decided_at: "2026-11-26T01:20:00Z", note: MOCK }));
    const design = { bundleDir: sealed.dir, reviewPath, approvalPath };
    const gate1 = await checkDesignApproval({ ...design, repo: REPO, mode: "gate" });
    step("4", "first approval (design gate)", "mock", "approved", "review and approval are mocks");

    // 5. photo materials: the request after the approved design (real check), the pictures and approval (mocks)
    const matReqPath = join(reqDir, `${MAT_ID}.json`);
    write(matReqPath, bytesOf({ ...envelope(MAT_ID), stage: "photo_materials", approved_design: { bundle_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, review_file: basename(reviewPath), approval_file: basename(approvalPath) }, materials: MATERIALS, mood: "朝の静かな光、自然な色。", avoid: "文字、看板、ロゴ、人の顔、店の外観や店内。", max_images: 2 }));
    const mv = await validateRequestFile({ file: matReqPath, home, repo: REPO });
    expect(mv).toMatchObject({ stage: "photo_materials" });
    const mRun = join(runs, `${MAT_ID}-20261126T020000Z`);
    mkdirSync(join(mRun, "parts"), { recursive: true, mode: 0o700 });
    chmodSync(mRun, 0o700);
    const mImages = Object.entries(PICTURES).map(([name, b]) => {
      write(join(mRun, "parts", name), b);
      return { file: `parts/${name}`, sha256: sha(b), bytes: b.length };
    });
    const approved_design = { bundle_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, review_sha256: gate1.review_sha256, approval_sha256: gate1.approval!.sha256 };
    write(join(mRun, "approved-design-input.json"), Buffer.from(JSON.stringify({ schema: "image_first_approved_design_input_v0", ...approved_design, materials_sha256: "9".repeat(64) })));
    const mSha = sha(readFileSync(matReqPath));
    const { design_layout: _l, reference_images: _r, ...designOnly } = receipt;
    void _l;
    void _r;
    const mReceipt = { ...designOnly, approval_id: MAT_ID, plan_id: MAT_ID, packet_sha256: mSha, request_sha256: mSha, run_dir: mRun, images: mImages, request_id: MAT_ID, images_total: 2, counts: { pc: 0, sp: 0, photo: 2, total: 2, stopped: 0 }, request_stage: "photo_materials", approved_design, materials_sha256: "9".repeat(64),
      // DEV-364 PR 3c: the generation facts a real materials run seals (cycle.ts); here a MOCK (no Codex ran)
      generation: { generator: "codex exec, its image generation tool (one batch) — モック／架空", session_model: "mock-session-model", generated_at: "2026-11-26T02:05:00.000Z", prompt_sha256: designOnly.prompt_sha256, request_id: MAT_ID } };
    const mReceiptPath = join(runs, "materials.receipt.json");
    write(mReceiptPath, Buffer.from(JSON.stringify(mReceipt)));
    const mSealed = await packBundle({ runDir: mRun, receiptPath: mReceiptPath, bundlesDir: join(home, "sr-runs", "review-inbox"), now: () => Date.parse("2026-11-26T02:06:00Z") });
    const mReview = bytesOf({ schema: "sr_materials_review_v1", request_id: MAT_ID, bundle_sha256: mSealed.bundle_sha256, materials: mImages.map((img, n) => ({ id: MATERIALS[n]!.id, file: img.file, sha256: img.sha256, verdict: "pass", note: MOCK })), reviewer: "mock-review", reviewed_at: "2026-11-26T03:00:00Z" });
    const mReviewPath = join(reviews, `${MAT_ID}.materials-review.json`);
    write(mReviewPath, mReview);
    const mApprovalPath = join(reviews, `${MAT_ID}.materials-approval.json`);
    write(mApprovalPath, bytesOf({ schema: "sr_materials_approval_v1", request_id: MAT_ID, bundle_sha256: mSealed.bundle_sha256, review_sha256: sha(mReview), page_sha256: materialsReviewPageSha256(parseMaterialsReview(mReview), await readDeliveredMaterials(mSealed.dir)), approved_materials: mImages.map((i) => ({ file: i.file, sha256: i.sha256 })), decision: "approve", decided_at: "2026-11-26T04:00:00Z", note: MOCK }));
    const materials = { bundleDir: mSealed.dir, reviewPath: mReviewPath, approvalPath: mApprovalPath };
    const approved = await approvedMaterials({ design, ...materials, repo: REPO });
    step("5", "photo materials: request validated; pictures, review and approval", "mock", "approved", "the request check is real; the materials run and its approval are mocks (no Codex)");

    // 6. delivery: handover record with material ids, the photo-slot spec bound to the first approval, A provenance —
    // from the data the gates above verified (the caller reads the records; the writer gets plain values)
    const repo = join(tmp(), "repo");
    await bakeryRepo(repo);
    const prov = join(tmp(), "provenance");
    const approval = { bundle_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, review_file: basename(reviewPath), approval_file: basename(approvalPath), approval_sha256: approved.design.approval_sha256 };
    const view = (v: "pc" | "sp") => ({ box: boxFor(v, "4:3", v === "pc" ? 0.2 : 0.42), aspect: "4:3", shape: "rect", object_position: "50% 50%", subject: "center", text_gap: "adjacent" });
    const delivered = approved.materials.map((m) => ({ file: FILE_OF[m.id]!, sha256: m.sha256, material_id: m.id, materials_approval_sha256: approved.approval_sha256 }));
    const slots = delivered.map((m) => ({ id: `slot-${m.material_id}`, role: "product", material_ids: [m.material_id], pc: view("pc"), sp: view("sp") }));
    await writeDelivery({ repo, provenanceDir: prov, approval, approvedMaterials: { approval_sha256: approved.approval_sha256, sha256s: approved.materials.map((m) => m.sha256) }, materials: delivered, slots });
    step("6", "delivery: handover record (material ids), photo-slot spec, A provenance", "real", "written", "the writer takes values the design and materials gates verified");

    // 7. the build (Claude's page code for this shop; here the fictional bakery's hand-written page) and its gates
    const dist = join(tmp(), "dist");
    const built = await buildSite({ repo, outDir: dist, today: Q1_TODAY });
    expect(built.slots.map((s) => s.slot).sort()).toEqual(slots.map((s) => s.id).sort());
    const staged = await stageForGates({ dist, outDir: join(tmp(), "staged") });
    const mi = await checkMaterialsInSite({ approved, siteDir: staged.dir, repo: REPO });
    expect(mi.problems).toEqual([]);
    expect(mi.status).toBe("ok");
    const implDir = join(tmp(), "impl");
    const impl = await runImplCompare({ ...design, siteDir: staged.dir, outDir: implDir, repo: REPO, browser, now: () => Date.parse("2026-11-26T04:30:00Z") });
    step("7", "build + materials-impl-check --site + stage-6 comparison", "real", `materials ${mi.status}; comparison ${impl.record.status}`, "the page code is the fictional bakery's own (not drawn from a real approved design picture)");

    // 8. the second (photo-included) review and approval (mock) — must pass
    const slotsPath = join(repo, "content", "photo-slots.json");
    const site = impl.record.site.files;
    const finalReview = {
      schema: "sr_final_review_v1",
      advice_only: true,
      design: approval,
      photo_slots_sha256: sha(readFileSync(slotsPath)),
      materials: site.filter((f) => f.path.startsWith("assets/")).map((f) => ({ asset: f.path, class: "A", sha256: f.sha256, provenance_sha256: sha(readFileSync(join(prov, `${f.sha256}.json`))) })),
      build: { files: site },
      captures: { pc: { width: 1440, sha256: impl.record.viewports.desktop_1440.capture.sha256 }, sp: { width: 390, sha256: impl.record.viewports.mobile_390.capture.sha256 } },
      impl_compare_sha256: impl.record_sha256,
      composition_change: "none",
      axes: Object.fromEntries(FINAL_AXES.map((a) => [a, { verdict: "pass", evidence: [{ image: "pc", region: "ページ全体", note: MOCK }] }])),
      reviewer: "mock-review",
      reviewed_at: "2026-11-26T05:00:00Z",
    };
    const fReviewPath = join(reviews, "final.review.json");
    write(fReviewPath, bytesOf(finalReview));
    const inputs = { design, materials, slotsPath, provenanceDir: prov, siteDir: staged.dir, implCompareDir: implDir };
    const fDraft = await checkFinalApproval({ ...inputs, reviewPath: fReviewPath, repo: REPO, mode: "draft" });
    expect(fDraft.route).toBe("second_approval");
    expect(fDraft.measured_change).toBeNull();
    const page = await writeFinalReviewPage(fDraft.review, fDraft.evidence, { outDir: join(tmp(), "final-page"), repo: REPO });
    expect(page.page_sha256).toBe(fDraft.page_sha256);
    const fApprovalPath = join(reviews, "final.approval.json");
    const r = fDraft.review;
    write(fApprovalPath, bytesOf({ schema: "sr_final_approval_v1", not_owner_signature: true, design_approval_sha256: fDraft.design.approval_sha256, photo_slots_sha256: r.photo_slots_sha256, materials: r.materials.map((m) => ({ asset: m.asset, sha256: m.sha256, provenance_sha256: m.provenance_sha256 })), build_files_sha256: fDraft.build_files_sha256, captures: { pc: r.captures.pc.sha256, sp: r.captures.sp.sha256 }, impl_compare_sha256: r.impl_compare_sha256, review_sha256: fDraft.review_sha256, page_sha256: fDraft.page_sha256, decision: "approve", decided_at: "2026-11-26T06:00:00Z", note: MOCK }));
    const final = await approvedFinal({ ...inputs, reviewPath: fReviewPath, approvalPath: fApprovalPath, repo: REPO });
    expect(final.files.map((f) => f.path)).toEqual(["index.html", "style.css", "assets/photo-1.png", "assets/photo-3.png"]);
    step("8", "photo-included second review page + second approval (gate)", "mock", "approved", "the review and approval are mocks; the gate recomputed every SHA-256 and the composition rule");

    // 9. Pages CMS update (local: a product's name and price, a customer's photo C), rebuilt, and Q1 on that repository
    const itemFile = join(repo, "content", "menu", "item-1.json");
    write(itemFile, bytesOf({ ...(JSON.parse(readFileSync(itemFile, "utf8")) as object), name: "季節の木の実のカンパーニュ（更新）", priceDisplay: "520円（税込）" }));
    write(join(repo, "media", "owner-photo.png"), solidPng(800, 600, [90, 120, 100]));
    const item2File = join(repo, "content", "menu", "item-2.json");
    write(item2File, bytesOf({ ...(JSON.parse(readFileSync(item2File, "utf8")) as object), image: "/media/owner-photo.png", imageKind: "customer_cms" }));
    const after = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY });
    expect(after.html).toContain("季節の木の実のカンパーニュ（更新）");
    expect(after.provenance.find((p) => p.file === "owner-photo.png")?.class).toBe("C");
    const q1 = await runQ1OnRepo({ outDir: join(tmp(), "q1"), browser, repo, siteId: "bakery", name: "p0-after-cms" });
    expect(q1.findings).toEqual([]);
    step("9", "Pages CMS update (product, price, a customer's photo C) + rebuild + Q1 PC/SP on that repository", "real", "clean", "local content edits stand in for Pages CMS (a real Pages CMS / Cloudflare round trip is Q2-Q4)");

    // 10. demo packaging: the IMAGE_FIRST mode runs the second approval's gate and writes the UPLOADABLE demo package (WebP
    // via convertPhoto, image records with the sealed provenance, one transform record per photo) only when every check
    // passes; the owner's per-photo depiction confirmation is a MOCK here
    const depPath = join(tmp("sr-p0-dep-"), "depiction-confirmation.json");
    const depiction = (over: (p: { sha256: string }) => Record<string, unknown> = () => ({}), only?: number) =>
      bytesOf({ schema: IMAGE_FIRST_DEPICTION_SCHEMA, note: MOCK, photos: final.files.filter((f) => f.path.startsWith("assets/")).slice(0, only).map((f) => ({ sha256: f.sha256, depicts_real_product: false, depicts_real_interior: false, depicts_real_equipment: false, confirmation: IMAGE_FIRST_DEPICTION_STATEMENT, ...over(f) })) });
    write(depPath, depiction());
    const pkg = async (over: Record<string, string> = {}, drop: string[] = []) => {
      const flags: Record<string, string> = {
        "--imagefirst": staged.dir,
        "--out": join(tmp(), "package"),
        "--design-bundle": design.bundleDir,
        "--design-review": design.reviewPath,
        "--design-approval": design.approvalPath,
        "--materials-bundle": materials.bundleDir,
        "--materials-review": materials.reviewPath,
        "--materials-approval": materials.approvalPath,
        "--slots": slotsPath,
        "--provenance-dir": prov,
        "--impl-compare": implDir,
        "--final-review": fReviewPath,
        "--final-approval": fApprovalPath,
        "--depiction-confirmation": depPath,
        ...over,
      };
      const out: string[] = [];
      const err: string[] = [];
      const code = await packageLocal(Object.entries(flags).filter(([k]) => !drop.includes(k)).flat(), { write: (x) => void out.push(x), writeErr: (x) => void err.push(x) });
      const text = out.join("").trim();
      return { code, json: text ? (JSON.parse(text) as { status: string; code?: string }) : null, out: flags["--out"]! };
    };
    const packed = await pkg();
    expect([packed.code, packed.json?.status === "OK" ? "OK" : JSON.stringify(packed.json)]).toEqual([0, "OK"]);
    const manifest = JSON.parse(readFileSync(join(packed.out, "imagefirst-package.json"), "utf8")) as { schema: string; final_approval_sha256: string; build_files_sha256: string; files: { path: string; sha256: string }[]; converted: boolean; uploadable_demo_package: boolean; transforms: { source: string; source_sha256: string; stored: string; delivered_sha256: string }[]; provenance_model_role: string };
    expect(manifest).toMatchObject({ schema: IMAGE_FIRST_PACKAGE_SCHEMA, final_approval_sha256: final.approval_sha256, build_files_sha256: final.build_files_sha256, converted: true, uploadable_demo_package: true, provenance_model_role: IMAGE_FIRST_MODEL_ROLE });
    expect(manifest.files).toEqual(final.files);
    for (const f of final.files) expect(sha(readFileSync(join(packed.out, "site", f.path))), f.path).toBe(f.sha256);
    // the site copy carries the IMAGE_FIRST marker (not one of the approved files)
    expect(JSON.parse(readFileSync(join(packed.out, "site", "sr-origin.json"), "utf8"))).toMatchObject({ origin: "image_first" });
    expect(final.files.some((f) => f.path === "sr-origin.json")).toBe(false);
    // the sales demo package: WebP photos whose SHA-256s the transform records name, sourced from the approved PNGs
    expect(manifest.transforms.map((t) => [t.source, t.stored])).toEqual([["assets/photo-1.png", "photos/photo_1-desktop.webp"], ["assets/photo-3.png", "photos/photo_3-desktop.webp"]]);
    for (const t of manifest.transforms) {
      expect(t.source_sha256).toBe(final.files.find((f) => f.path === t.source)!.sha256);
      expect(sha(readFileSync(join(packed.out, "package", "page", t.stored)))).toBe(t.delivered_sha256);
      const rec = JSON.parse(readFileSync(join(packed.out, "transforms", `photo-${manifest.transforms.indexOf(t) + 1}.json`), "utf8")) as PhotoTransform;
      expect(rec).toMatchObject({ schema: "sr_photo_transform_v1", source_sha256: t.source_sha256, delivered_sha256: t.delivered_sha256 });
    }
    // the package reads back and verifies again (the server's checks), with its two photos and their image records
    const back = readPackage(join(packed.out, "package"));
    expect(back.manifest.files.filter((f) => f.role === "photo").map((f) => f.name)).toEqual(["page/photos/photo_1-desktop.webp", "page/photos/photo_3-desktop.webp"]);
    expect(back.images.map((i) => [i.source_kind, i.provenance.model, i.allowed_uses.public_web])).toEqual([["ai_generated_demo", "mock-session-model", false], ["ai_generated_demo", "mock-session-model", false]]);
    // #379 review Low: the package shows which owner confirmation it relied on (its SHA-256, in both records)
    expect((manifest as unknown as { depiction_confirmation_sha256: string }).depiction_confirmation_sha256).toBe(sha(readFileSync(depPath)));
    expect((JSON.parse(readFileSync(join(packed.out, "package", "package.json"), "utf8")) as { local: { depiction_confirmation_sha256: string } }).local.depiction_confirmation_sha256).toBe(sha(readFileSync(depPath)));
    // the output folder is private
    expect(statSync(packed.out).mode & 0o077).toBe(0);
    // the existing modes never package IMAGE_FIRST output (the staged site, or the packaged site copy)
    for (const dir of [staged.dir, join(packed.out, "site")]) {
      const plain: string[] = [];
      expect(await packageLocal(["--out", join(tmp(), "package"), "--source", dir], { write: (x) => void plain.push(x), writeErr: () => undefined })).toBe(1);
      expect(plain.join("")).toContain("IMAGE_FIRST_OUTPUT");
      const viaCopy: string[] = [];
      expect(await packageLocal(["--out", join(tmp(), "package"), "--copy", dir, "--facts", join(dir, "facts.json")], { write: (x) => void viaCopy.push(x), writeErr: () => undefined })).toBe(1);
      expect(viaCopy.join("")).toContain("IMAGE_FIRST_OUTPUT");
    }
    step("10", "demo packaging: the uploadable IMAGE_FIRST demo package (second approval's gate, WebP + image records + transform records)", "mock", "packaged (uploadable, local only)", "the approvals, the materials run's generation facts and the depiction confirmation are mocks; nothing uploaded, published or sent; --source / --copy still refuse IMAGE_FIRST output");

    // deliberate mismatches: each refused with its code, nothing written
    const refused = async (over: Record<string, string>, drop: string[] = []) => {
      const r = await pkg(over, drop);
      expect(r.code, JSON.stringify(over)).not.toBe(0);
      expect(readdirSync(join(r.out, "..")).includes("package") && readdirSync(r.out).length > 0).toBe(false);
      return r.json?.code ?? `exit ${r.code}`;
    };
    const tamper = async (path: string, change: (b: Buffer) => Buffer, want: string) => {
      const before = readFileSync(path);
      writeFileSync(path, change(before));
      expect(await refused({}), path).toBe(want);
      writeFileSync(path, before);
    };
    // PR 3c: the owner's depiction confirmation missing for a photo, a photo said to show something real, or no file given
    write(depPath, depiction(() => ({}), 1));
    expect(await refused({})).toBe("IMAGE_FIRST_DEPICTION_NOT_CONFIRMED");
    write(depPath, depiction((f) => (f.sha256 === sha(PICTURES["photo-3.png"]!) ? { depicts_real_product: true } : {})));
    expect(await refused({})).toBe("IMAGE_FIRST_DEPICTS_REAL");
    write(depPath, depiction());
    expect(await refused({}, ["--depiction-confirmation"])).toBe("exit 2");
    // #379 review Low: the confirmation is read as a private record: readable by others, through a link, or inside the repository → refused
    chmodSync(depPath, 0o644);
    expect(await refused({})).toBe("IMAGE_FIRST_DEPICTION_UNREADABLE");
    chmodSync(depPath, 0o600);
    const depLink = join(tmp("sr-p0-deplink-"), "depiction-confirmation.json");
    symlinkSync(depPath, depLink);
    expect(await refused({ "--depiction-confirmation": depLink })).toBe("IMAGE_FIRST_DEPICTION_UNREADABLE");
    expect(await refused({ "--depiction-confirmation": join(REPO, "package.json") })).toBe("IMAGE_FIRST_DEPICTION_UNREADABLE");
    // a bad output folder: readable by others, a file, inside the repository
    const open = tmp();
    chmodSync(open, 0o755);
    expect(await refused({ "--out": open })).toBe("IMAGE_FIRST_OUT_UNSAFE");
    const fileOut = join(tmp(), "a-file");
    writeFileSync(fileOut, "x");
    expect((await pkg({ "--out": fileOut })).json?.code).toBe("IMAGE_FIRST_OUT_UNSAFE");
    expect((await pkg({ "--out": join(REPO, "tmp-imagefirst-out") })).code).toBe(2);
    // the HTML changed, or a photo swapped, after the approval
    await tamper(join(staged.dir, "index.html"), (b) => Buffer.from(b.toString("utf8").replace("</body>", "<p>追加</p></body>")), "FINAL_IMPL_COMPARE_MISMATCH");
    await tamper(join(staged.dir, "assets", "photo-1.png"), () => solidPng(768, 512, [1, 1, 1]), "FINAL_IMPL_COMPARE_MISMATCH");
    // an AI material disguised as the shop's photo (a valid B rights record for an approved picture's bytes)
    await tamper(join(prov, `${sha(PICTURES["photo-1.png"]!)}.json`), () => bytesOf(fictionalRights(PICTURES["photo-1.png"]!)), "FINAL_GENERATED_AS_SHOP");
    // a stale second approval: the review edited after the decision
    await tamper(fReviewPath, (b) => Buffer.from(b.toString("utf8").replace("mock-review", "another-review")), "FINAL_APPROVAL_REVIEW_MISMATCH");
    // the CSS edited after the approval; a picture added that the approval does not name
    await tamper(join(staged.dir, "style.css"), (b) => Buffer.concat([b, Buffer.from(".x{color:red}")]), "FINAL_IMPL_COMPARE_MISMATCH");
    writeFileSync(join(staged.dir, "assets", "extra.png"), solidPng(400, 400, [1, 2, 3]));
    expect(await refused({})).toBe("FINAL_IMPL_COMPARE_MISMATCH");
    unlinkSync(join(staged.dir, "assets", "extra.png"));
    // a picture recorded as a customer's upload (C): an approved material's bytes as C
    await tamper(join(prov, `${sha(PICTURES["photo-1.png"]!)}.json`), () => bytesOf({ schema: "sr_photo_provenance_v1", class: "C", sha256: sha(PICTURES["photo-1.png"]!), uploaded_via: "pages_cms", checks: { type: "ok", bytes: "ok", dimensions: "ok", ratio: "ok" } }), "FINAL_GENERATED_AS_SHOP");
    // a wrong first-approval SHA-256 in the second approval
    await tamper(fApprovalPath, (b) => Buffer.from(b.toString("utf8").replace(/"design_approval_sha256": "[0-9a-f]+"/, `"design_approval_sha256": "${"0".repeat(64)}"`)), "FINAL_APPROVAL_DESIGN_MISMATCH");
    // missing records
    expect(await refused({ "--final-approval": join(tmp(), "none.json") })).toBe("FINAL_RECORD_MISSING");
    expect(await refused({ "--provenance-dir": tmp() })).toBe("FINAL_PROVENANCE_MISSING");
    expect(await refused({}, ["--materials-approval"])).toBe("exit 2");
    // a synthetic first approval (the rehearsal): materials for it never pass, so it never packages
    const rehHome = tmp("sr-p0-reh-");
    const reh = await sealRehearsal({ home: rehHome, repo: REPO, now: () => Date.parse("2026-11-26T01:00:00Z") });
    const rehDraft = await checkDesignApproval({ bundleDir: reh.bundle_dir, reviewPath: reh.review, repo: REPO, mode: "draft" });
    const rehApproval = await approveRehearsal({ home: rehHome, repo: REPO, pageSha256: rehDraft.page_sha256, now: () => Date.parse("2026-11-26T01:01:00Z") });
    const rehMaterials = await sealMockMaterials({ id: "req-cafe-p0-photos-1", shop: REHEARSAL_SHOP, approved_design: { bundle_id: REHEARSAL_ID, bundle_sha256: reh.bundle_sha256, review_sha256: rehDraft.review_sha256, approval_sha256: rehApproval.approval_sha256 }, reviews: tmp("sr-p0-rehrec-"), inbox: join(tmp("sr-p0-rehinbox-"), "review-inbox") });
    expect(await refused({ "--design-bundle": reh.bundle_dir, "--design-review": reh.review, "--design-approval": rehApproval.approval, "--materials-bundle": rehMaterials.bundleDir, "--materials-review": rehMaterials.reviewPath, "--materials-approval": rehMaterials.approvalPath })).toBe("MATERIALS_DESIGN_SYNTHETIC");
    // an output that is not empty
    const full = tmp();
    writeFileSync(join(full, "x"), "x");
    expect((await pkg({ "--out": full })).json?.code).toBe("IMAGE_FIRST_OUT_NOT_EMPTY");
    // and the approved package still builds after every restore
    expect((await pkg()).code).toBe(0);
    // the transform records are checked separately: a delivered SHA-256 that is not the package's, or a source that is not approved
    const good = manifest.transforms.map((t, n) => JSON.parse(readFileSync(join(packed.out, "transforms", `photo-${n + 1}.json`), "utf8")) as PhotoTransform);
    const pkgPhotos = (JSON.parse(readFileSync(join(packed.out, "package", "package.json"), "utf8")) as { manifest: { files: { name: string; role: string; sha256: string; bytes: number; width?: number; height?: number }[] } }).manifest.files.filter((f) => f.role === "photo");
    const approvedPics = final.files.filter((f) => f.path.startsWith("assets/")).map((f) => ({ path: f.path, sha256: f.sha256 }));
    expect(checkImageFirstTransforms(good, approvedPics, pkgPhotos)).toEqual([]);
    expect(checkImageFirstTransforms([{ ...good[0]!, delivered_sha256: "0".repeat(64) }, good[1]!], approvedPics, pkgPhotos)).toEqual(["TRANSFORM_DELIVERED_MISMATCH photos/photo_1-desktop.webp"]);
    expect(checkImageFirstTransforms([{ ...good[0]!, source_sha256: "0".repeat(64) }, good[1]!], approvedPics, pkgPhotos)).toEqual(["TRANSFORM_SOURCE_MISMATCH assets/photo-1.png"]);
    expect(checkImageFirstTransforms([good[0]!], approvedPics, pkgPhotos)).toEqual(expect.arrayContaining(["TRANSFORM_MISSING assets/photo-3.png", "TRANSFORM_PHOTO_COUNT"]));
    // the AI provenance is the sealed facts only: none sealed, another run's, or no session model → refused
    const g = { generator: "codex exec", session_model: "mock-session-model", generated_at: "2026-11-26T02:05:00.000Z", prompt_sha256: "d".repeat(64), request_id: MAT_ID };
    expect(imageFirstProvenance(null, MAT_ID)).toEqual({ code: "IMAGE_FIRST_PROVENANCE_MISSING" });
    expect(imageFirstProvenance({ ...g, request_id: "req-other-photos-1" }, MAT_ID)).toEqual({ code: "IMAGE_FIRST_PROVENANCE_MISMATCH" });
    expect(imageFirstProvenance({ ...g, session_model: null }, MAT_ID)).toEqual({ code: "IMAGE_FIRST_MODEL_UNKNOWN" });
    expect(imageFirstProvenance(g, MAT_ID)).toMatchObject({ provenance: { model: "mock-session-model", approval_id: MAT_ID } });
    expect((imageFirstProvenance(g, MAT_ID) as { provenance: { generator: string } }).provenance.generator).toContain(IMAGE_FIRST_MODEL_ROLE);

    // the step report
    const reportPath = join(tmp("sr-p0-report-"), "p0-steps.json");
    writeFileSync(reportPath, bytesOf({ schema: "sr_p0_bakery_e2e_v0", fictional: true, note: "temp only; mock records carry モック／架空; the first-approved design is a circular mock", steps }));
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { steps: StepRow[] };
    expect(report.steps.map((s) => s.n)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(report.steps.filter((s) => s.kind === "blocked").map((s) => s.n)).toEqual([]);
    for (const s of report.steps) expect(["real", "mock", "synthetic", "blocked"]).toContain(s.kind);
    // every mock record says so
    for (const f of [reviewPath, approvalPath, mReviewPath, mApprovalPath, fReviewPath, fApprovalPath, depPath]) expect(readFileSync(f, "utf8"), f).toContain("モック／架空");
  });

  it("the delivery writer refuses what it cannot bind (PR #376 review M1-M3 included)", async () => {
    const repo = join(tmp(), "repo");
    await bakeryRepo(repo);
    const approval = { bundle_id: DESIGN_ID, bundle_sha256: "a".repeat(64), review_file: `${DESIGN_ID}.review.json`, approval_file: `${DESIGN_ID}.approval.json`, approval_sha256: "b".repeat(64) };
    const MA = "c".repeat(64);
    const shaOf = (f: string) => sha(PICTURES[f]!);
    const verified = { approval_sha256: MA, sha256s: [shaOf("photo-1.png"), shaOf("photo-3.png")] };
    const ok = [{ file: "photo-1.png", sha256: shaOf("photo-1.png"), material_id: "crust-texture", materials_approval_sha256: MA }];
    const both = [...ok, { file: "photo-3.png", sha256: shaOf("photo-3.png"), material_id: "flour-board", materials_approval_sha256: MA }];
    const view = (v: "pc" | "sp") => ({ box: boxFor(v, "4:3", v === "pc" ? 0.2 : 0.42), aspect: "4:3", shape: "rect", object_position: "50% 50%", subject: "center", text_gap: "adjacent" });
    const slot = { id: "slot-crust", role: "product", material_ids: ["crust-texture"], pc: view("pc"), sp: view("sp") };
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof DeliveryError ? e.code : String(e)));
    const deliver = (over: Partial<Parameters<typeof writeDelivery>[0]> = {}) => writeDelivery({ repo, provenanceDir: join(tmp(), "p"), approval, approvedMaterials: verified, materials: ok, slots: [slot], ...over });
    expect(await code(deliver({ materials: [{ ...ok[0]!, sha256: "d".repeat(64) }], approvedMaterials: { ...verified, sha256s: [...verified.sha256s, "d".repeat(64)] } }))).toBe("DELIVERY_PICTURE_MISMATCH");
    expect(await code(deliver({ slots: [{ ...slot, material_ids: ["flour-board"] }] }))).toBe("DELIVERY_SLOTS_UNBOUND");
    expect(await code(deliver({ slots: [{ ...slot, pc: { ...view("pc"), text_gap: "overlay" } }] }))).toBe("DELIVERY_SLOTS_INVALID");
    // M1: the provenance folder itself, resolved: inside the repository, through a link into it, or a link anywhere
    expect(await code(deliver({ provenanceDir: join(repo, "private") }))).toBe("DELIVERY_PROVENANCE_IN_REPO");
    mkdirSync(join(repo, "private-target"));
    const linkIn = join(tmp(), "prov-link");
    symlinkSync(join(repo, "private-target"), linkIn);
    expect(await code(deliver({ provenanceDir: linkIn }))).toBe("DELIVERY_PROVENANCE_IN_REPO");
    const linkOut = join(tmp(), "prov-link-out");
    symlinkSync(tmp(), linkOut);
    expect(await code(deliver({ provenanceDir: linkOut }))).toBe("DELIVERY_PROVENANCE_UNSAFE");
    // M3: an unapproved picture, an invented approval SHA-256, a file name / material id outside the record's form
    writeFileSync(join(repo, "media", "photo-9.png"), solidPng(500, 500, [9, 9, 9]));
    expect(await code(deliver({ materials: [{ file: "photo-9.png", sha256: sha(readFileSync(join(repo, "media", "photo-9.png"))), material_id: "crust-texture", materials_approval_sha256: MA }] }))).toBe("DELIVERY_MATERIAL_NOT_APPROVED");
    expect(await code(deliver({ materials: [{ ...ok[0]!, materials_approval_sha256: "e".repeat(64) }] }))).toBe("DELIVERY_MATERIAL_NOT_APPROVED");
    expect(await code(deliver({ materials: [{ ...ok[0]!, file: "../photo-1.png" }] }))).toBe("DELIVERY_RECORD_INVALID");
    expect(await code(deliver({ materials: [{ ...ok[0]!, material_id: "Crust" }] }))).toBe("DELIVERY_RECORD_INVALID");
    // M2: the record must cover every shown generated picture (no record left, only one of the two delivered)
    unlinkSync(join(repo, "content", "generated-materials.json"));
    expect(await code(deliver())).toBe("DELIVERY_RECORD_INCOMPLETE");
    // the reviewer's probe: deliver both, re-deliver with fewer materials, relabel the dropped one → still caught
    expect(await code(deliver({ materials: both, slots: [slot] }))).toBe("ok");
    expect(await code(deliver({ materials: ok }))).toBe("ok");
    const record = JSON.parse(readFileSync(join(repo, "content", "generated-materials.json"), "utf8")) as { files: { file: string; material_id?: string }[] };
    expect(record.files.map((f) => [f.file, f.material_id])).toEqual([["photo-1.png", "crust-texture"], ["photo-3.png", "flour-board"]]);
    const item2 = join(repo, "content", "menu", "item-2.json");
    writeFileSync(item2, bytesOf({ ...(JSON.parse(readFileSync(item2, "utf8")) as object), imageKind: "customer_cms" }));
    expect(await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY }).then(() => "ok", (e: { code?: string }) => e.code ?? String(e))).toBe("CONTENT_GENERATED_AS_SHOP");
    writeFileSync(item2, bytesOf({ ...(JSON.parse(readFileSync(item2, "utf8")) as object), imageKind: "generated" }));
    // a re-delivery that disagrees with a recorded entry (another material id for the same file) is refused
    expect(await code(deliver({ materials: [{ ...ok[0]!, material_id: "other-id" }], slots: [{ ...slot, material_ids: ["other-id"] }] }))).toBe("DELIVERY_RECORD_CONFLICT");
    // a shop photo (B): a valid rights record of its own picture is written (index + private record); another picture's is refused
    writeFileSync(join(repo, "media", "shop-1.png"), solidPng(640, 480, [10, 20, 30]));
    const rights = fictionalRights(readFileSync(join(repo, "media", "shop-1.png")));
    expect(await code(deliver({ shopPhotos: [{ file: "shop-1.png", rights: { ...rights, sha256: "e".repeat(64) } }] }))).toBe("DELIVERY_RIGHTS_INVALID");
    const prov = join(tmp(), "p");
    const w = await deliver({ provenanceDir: prov, shopPhotos: [{ file: "shop-1.png", rights }] });
    expect(w.written).toEqual(["content/generated-materials.json", "content/photo-slots.json", "content/photo-provenance.json"]);
    expect(JSON.parse(readFileSync(join(prov, `${rights.sha256}.json`), "utf8"))).toMatchObject({ class: "B", provided_by: "店主" });
    expect(JSON.parse(readFileSync(join(prov, `${ok[0]!.sha256}.json`), "utf8"))).toEqual({ schema: "sr_photo_provenance_v1", class: "A", sha256: ok[0]!.sha256, material_id: "crust-texture", materials_approval_sha256: MA });
  });
});
