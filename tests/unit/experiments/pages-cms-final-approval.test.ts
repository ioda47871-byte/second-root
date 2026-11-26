import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSite } from "@/experiments/pages-cms/build";
import { boxFor, fictionalRights, provenanceDirOf, Q1_TODAY, solidPng, writeFixture } from "@/experiments/pages-cms/fixtures";
import { PhotoSlots } from "@/experiments/pages-cms/photo-slots";
import { CAFE_SITE } from "@/experiments/pages-cms/shop-site";
import { stageForGates } from "@/experiments/pages-cms/stage-for-gates";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { checkDesignApproval, DESIGN_AXES } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { approvedFinal, checkFinalApproval, FINAL_AXES, type FinalInputs, writeFinalReviewPage } from "@/lib/design-agent/imagefirst-worker/final-approval";
import { runImplCompare } from "@/lib/design-agent/imagefirst-worker/impl-compare-approved";
import { approvedMaterials, materialsReviewPageSha256, parseMaterialsReview, readDeliveredMaterials } from "@/lib/design-agent/imagefirst-worker/materials-approval";
import { REHEARSAL_SHOP } from "@/lib/design-agent/imagefirst-worker/rehearsal";
import { finalApprovalMain, parseFinalApprovalArgs } from "@/scripts/design-artifact/final-approval-check";

// DEV-364 PR 3a (docs/design/quality-proof-plan.md §3.3, §6 row 3a): the second (photo-included) review and approval,
// demonstrated OFFLINE on the FICTIONAL café of the Pages CMS experiment: an invented non-synthetic whole-page design
// and its first approval, invented approved materials (A), an invented shop photo with a fictional rights record (B),
// the café built and staged (stage-for-gates), compared with the design in real Chromium (its PC 1440 / SP 390
// captures), a photo-slot spec bound to the first approval, a review, the private page and an approval written as
// the owner's decision would be (a test fixture: no owner decided anything here). Then stale and tampered inputs.

vi.setConfig({ testTimeout: 120_000 });
const REPO = resolve(__dirname, "../../..");
const temps: string[] = [];
const tmp = (p = "sr-final-") => {
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
const write = (path: string, b: Buffer) => writeFileSync(path, b, { mode: 0o600 });
const T0 = Date.parse("2026-11-26T01:00:00Z");
const DESIGN_ID = "req-cafe-design-final-1";
const MAT_ID = "req-cafe-materials-final-1";
/** The approved materials (A) and the shop's own photo (B): invented pictures. */
const PICTURES = { "photo-1.png": solidPng(768, 512, [120, 84, 60]), "photo-3.png": solidPng(600, 600, [214, 196, 160]) };
const SHOP_PHOTO = { "shop-1.png": solidPng(640, 480, [90, 120, 100]) };
const MATERIAL_IDS = ["counter-texture", "linen-light"];

type DesignRecords = { bundleDir: string; reviewPath: string; approvalPath: string };
type DesignBinding = { bundle_id: string; bundle_sha256: string; review_sha256: string; approval_sha256: string };

/** A FICTIONAL, non-synthetic approved whole-page design of the café (the #368 gates test's pattern). */
async function fictionalDesign(): Promise<{ design: DesignRecords; binding: DesignBinding }> {
  const runs = tmp("sr-final-druns-");
  const runDir = join(runs, `${DESIGN_ID}-20261126T010000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const images = (["pc", "sp"] as const).map((view, n) => {
    const bytes = solidPng(1024, 1536, [200 - n * 40, 180, 150]);
    writeFileSync(join(runDir, "parts", `${view}-1.png`), bytes, { mode: 0o600 });
    return { file: `parts/${view}-1.png`, sha256: sha(bytes), bytes: bytes.length };
  });
  const references = [{ id: "ref-1", case_id: "CP-001", sha256: sha("invented reference") }];
  writeFileSync(join(runDir, "reference-inputs.json"), JSON.stringify({ schema: "image_first_reference_inputs_v0", layout: "whole_page", references }), { mode: 0o600 });
  const receipt = {
    schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, cli_exit: 0, cli_timed_out: false, interrupted: false,
    shop: REHEARSAL_SHOP, direction: "request", approval_id: DESIGN_ID, plan_id: DESIGN_ID, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 4000,
    run_dir: runDir, images, stopped_images: [], verified: true,
    timings: { started_at: "2026-11-26T01:00:00.000Z", finished_at: "2026-11-26T01:05:00.000Z", elapsed_ms: 300_000 },
    mode: "request", kind: "fictional", request_id: DESIGN_ID, request_sha256: "a".repeat(64), facts_sha256: "e".repeat(64), images_total: 2,
    counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, design_layout: "whole_page", reference_images: references,
  };
  const receiptPath = join(runs, "design.receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(tmp("sr-final-dinbox-"), "review-inbox"), now: () => T0 });
  const recs = tmp("sr-final-drec-");
  const pick = (view: "pc" | "sp") => images.filter((i) => i.file.startsWith(`parts/${view}-`)).map((i) => ({ file: i.file, sha256: i.sha256 }));
  const axis = { verdict: "pass", evidence: [{ image: "pc", region: "ページ全体", note: "試験用の根拠（架空）" }] };
  const review = bytesOf({ schema: "sr_design_review_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, images: { pc: pick("pc"), sp: pick("sp") }, axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, axis])), reviewer: "independent-subagent", reviewed_at: "2026-11-26T01:10:00Z" });
  const reviewPath = join(recs, "design.review.json");
  write(reviewPath, review);
  const draft = await checkDesignApproval({ bundleDir: sealed.dir, reviewPath, repo: REPO, mode: "draft" });
  const approval = bytesOf({ schema: "sr_design_approval_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, approved_images: { pc: pick("pc"), sp: pick("sp") }, review_sha256: draft.review_sha256, page_sha256: draft.page_sha256, decision: "approve", decided_at: "2026-11-26T01:20:00Z" });
  const approvalPath = join(recs, "design.approval.json");
  write(approvalPath, approval);
  return { design: { bundleDir: sealed.dir, reviewPath, approvalPath }, binding: { bundle_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, review_sha256: draft.review_sha256, approval_sha256: sha(approval) } };
}

/** The approved materials run of that design (its records). */
async function materialsFor(approved_design: DesignBinding) {
  const runs = tmp("sr-final-runs-");
  const runDir = join(runs, `${MAT_ID}-20261126T020000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const images = Object.entries(PICTURES).map(([name, bytes]) => {
    writeFileSync(join(runDir, "parts", name), bytes, { mode: 0o600 });
    return { file: `parts/${name}`, sha256: sha(bytes), bytes: bytes.length };
  });
  const materials_sha256 = "9".repeat(64);
  writeFileSync(join(runDir, "approved-design-input.json"), JSON.stringify({ schema: "image_first_approved_design_input_v0", ...approved_design, materials_sha256 }), { mode: 0o600 });
  const receipt = {
    schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, cli_exit: 0, cli_timed_out: false, interrupted: false,
    shop: REHEARSAL_SHOP, direction: "request", approval_id: MAT_ID, plan_id: MAT_ID, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 4000,
    run_dir: runDir, images, stopped_images: [], verified: true,
    timings: { started_at: "2026-11-26T02:00:00.000Z", finished_at: "2026-11-26T02:05:00.000Z", elapsed_ms: 300_000 },
    mode: "request", kind: "fictional", request_id: MAT_ID, request_sha256: "a".repeat(64), facts_sha256: "e".repeat(64), images_total: images.length,
    counts: { pc: 0, sp: 0, photo: images.length, total: images.length, stopped: 0 }, request_stage: "photo_materials", approved_design, materials_sha256,
  };
  const receiptPath = join(runs, "materials.receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(tmp("sr-final-inbox-"), "review-inbox"), now: () => T0 + 120_000 });
  const recs = tmp("sr-final-rec-");
  const review = bytesOf({
    schema: "sr_materials_review_v1", request_id: MAT_ID, bundle_sha256: sealed.bundle_sha256,
    materials: images.map((img, n) => ({ id: MATERIAL_IDS[n], file: img.file, sha256: img.sha256, verdict: "pass", note: "試験用の所見（架空）" })),
    reviewer: "independent-subagent", reviewed_at: "2026-11-26T03:00:00Z",
  });
  const reviewPath = join(recs, "materials.review.json");
  write(reviewPath, review);
  const pageSha = materialsReviewPageSha256(parseMaterialsReview(review), await readDeliveredMaterials(sealed.dir));
  const approvalPath = join(recs, "materials.approval.json");
  write(approvalPath, bytesOf({ schema: "sr_materials_approval_v1", request_id: MAT_ID, bundle_sha256: sealed.bundle_sha256, review_sha256: sha(review), page_sha256: pageSha, approved_materials: images.map((i) => ({ file: i.file, sha256: i.sha256 })), decision: "approve", decided_at: "2026-11-26T04:00:00Z" }));
  return { bundleDir: sealed.dir, reviewPath, approvalPath };
}

type World = Awaited<ReturnType<typeof makeWorld>>;
/** The whole fictional chain up to the second review's inputs. */
async function makeWorld() {
  const d = await fictionalDesign();
  const materials = await materialsFor(d.binding);
  const approved = await approvedMaterials({ design: d.design, ...materials, repo: REPO });
  // the café built with the two approved materials (A, イメージ) and the shop's photo (B, with its rights record)
  const repo = join(tmp(), "repo");
  const fx = CAFE_SITE.fixtures()["items-3"]!;
  const pictures = { ...PICTURES, ...SHOP_PHOTO };
  const names = Object.keys(pictures);
  const menu = fx.menu.map((m, k) => ({ ...m, image: `/media/${names[k]}`, imageAlt: `試験の画像 ${k + 1}`, imageKind: k < 2 ? ("generated" as const) : ("shop_provided" as const) }));
  await writeFixture(repo, { ...fx, menu, media: pictures, generated: Object.keys(PICTURES), rights: [fictionalRights(SHOP_PHOTO["shop-1.png"])] });
  const dist = join(tmp(), "dist");
  await buildSite({ repo, outDir: dist, today: Q1_TODAY, site: CAFE_SITE });
  const staged = await stageForGates({ dist, outDir: join(tmp(), "staged") });
  // stage 6 against the approved design: the record and its PC 1440 / SP 390 captures
  const implDir = join(tmp(), "impl");
  const impl = await runImplCompare({ ...d.design, siteDir: staged.dir, outDir: implDir, repo: REPO, browser, now: () => T0 + 600_000 });
  // the private provenance folder: A records (material + materials approval), B as the delivery wrote it
  const prov = tmp("sr-final-prov-");
  for (const [n, bytes] of Object.values(PICTURES).entries())
    write(join(prov, `${sha(bytes)}.json`), bytesOf({ schema: "sr_photo_provenance_v1", class: "A", sha256: sha(bytes), material_id: MATERIAL_IDS[n], materials_approval_sha256: approved.approval_sha256 }));
  const bSha = sha(SHOP_PHOTO["shop-1.png"]);
  copyFileSync(join(provenanceDirOf(repo), `${bSha}.json`), join(prov, `${bSha}.json`));
  // the photo-slot spec bound to the first approval (a real sr_photo_slots_v1)
  const view = (v: "pc" | "sp") => ({ box: boxFor(v, "1:1", v === "pc" ? 0.06 : 0.16), aspect: "1:1" as const, shape: "rounded" as const, object_position: "50% 50%", subject: "center" as const, text_gap: "adjacent" as const });
  const slots = {
    schema: "sr_photo_slots_v1",
    approved_design: { bundle_id: DESIGN_ID, bundle_sha256: d.binding.bundle_sha256, review_file: basename(d.design.reviewPath), approval_file: basename(d.design.approvalPath), approval_sha256: d.binding.approval_sha256 },
    slots: [{ id: "slot-counter", role: "product", material_ids: [MATERIAL_IDS[0]!], pc: view("pc"), sp: view("sp") }],
  };
  expect(PhotoSlots.safeParse(slots).success).toBe(true);
  const recs = tmp("sr-final-frec-");
  const slotsPath = join(recs, "photo-slots.json");
  write(slotsPath, bytesOf(slots));
  const inputs: FinalInputs = { design: d.design, materials, slotsPath, provenanceDir: prov, siteDir: staged.dir, implCompareDir: implDir };
  const site = impl.record.site.files;
  const assets = site.filter((f) => f.path.startsWith("assets/"));
  const review = {
    schema: "sr_final_review_v1",
    advice_only: true,
    design: slots.approved_design,
    photo_slots_sha256: sha(readFileSync(slotsPath)),
    materials: assets.map((f) => ({ asset: f.path, class: f.path.includes("shop-") ? "B" : "A", sha256: f.sha256, provenance_sha256: sha(readFileSync(join(prov, `${f.sha256}.json`))) })),
    build: { files: site },
    captures: { pc: { width: 1440, sha256: impl.record.viewports.desktop_1440.capture.sha256 }, sp: { width: 390, sha256: impl.record.viewports.mobile_390.capture.sha256 } },
    impl_compare_sha256: impl.record_sha256,
    composition_change: "none",
    axes: Object.fromEntries(FINAL_AXES.map((a) => [a, { verdict: "pass", evidence: [{ image: "pc", region: "ページ全体", note: "試験用の根拠（架空）" }] }])),
    reviewer: "independent-subagent",
    reviewed_at: "2026-11-26T05:00:00Z",
  };
  return { d, materials, approved, inputs, staged, implDir, prov, recs, review };
}

let decisions = 0;
/** Writes a review and (as the owner's decision would be recorded) its approval bound to the draft's page. */
async function recordDecision(w: World, review: object = w.review, approval: Record<string, unknown> = {}) {
  const n = ++decisions;
  const reviewPath = join(w.recs, `review-${n}.json`);
  write(reviewPath, bytesOf(review));
  const draft = await checkFinalApproval({ ...w.inputs, reviewPath, repo: REPO, mode: "draft" });
  const r = draft.review;
  const approvalPath = join(w.recs, `approval-${n}.json`);
  write(
    approvalPath,
    bytesOf({
      schema: "sr_final_approval_v1",
      not_owner_signature: true,
      design_approval_sha256: draft.design.approval_sha256,
      photo_slots_sha256: r.photo_slots_sha256,
      materials: r.materials.map((m) => ({ asset: m.asset, sha256: m.sha256, provenance_sha256: m.provenance_sha256 })),
      build_files_sha256: draft.build_files_sha256,
      captures: { pc: r.captures.pc.sha256, sp: r.captures.sp.sha256 },
      impl_compare_sha256: r.impl_compare_sha256,
      review_sha256: draft.review_sha256,
      page_sha256: draft.page_sha256,
      decision: "approve",
      decided_at: "2026-11-26T06:00:00Z",
      ...approval,
    }),
  );
  return { reviewPath, approvalPath, draft };
}
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

describe("DEV-364 PR 3a: the second (photo-included) review and approval on the fictional café", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
  }, 180_000);

  it("the positive path: draft, the private page (no script, no network), the recorded decision, the gate", async () => {
    const { reviewPath, approvalPath, draft } = await recordDecision(w);
    expect(draft.route).toBe("second_approval");
    expect(Object.values(draft.verdicts).every((v) => v === "pass")).toBe(true);
    const out = join(tmp(), "page");
    const page = await writeFinalReviewPage(draft.review, draft.evidence, { outDir: out, repo: REPO });
    expect(page.page_sha256).toBe(draft.page_sha256);
    const html = readFileSync(page.page, "utf8");
    expect(html).not.toMatch(/<script|https?:\/\/|@import|<link/i);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("オーナー本人の署名ではない");
    expect(html).not.toContain("approval_sha256\":");
    for (const f of ["images/pc-capture.png", "images/sp-capture.png", "images/material-1.png", "images/material-3.png"]) expect(readFileSync(join(out, f)).length).toBeGreaterThan(0);
    const ok = await approvedFinal({ ...w.inputs, reviewPath, approvalPath, repo: REPO });
    expect(ok.files.map((f) => f.path)).toEqual(["index.html", "style.css", "assets/photo-1.png", "assets/photo-3.png", "assets/shop-1.png"]);
    expect(ok.design.request_id).toBe(DESIGN_ID);
    // the CLI: gate passes (exit 0), arguments are strict (exit 2)
    const args = ["--design-bundle", w.d.design.bundleDir, "--design-review", w.d.design.reviewPath, "--design-approval", w.d.design.approvalPath, "--materials-bundle", w.materials.bundleDir, "--materials-review", w.materials.reviewPath, "--materials-approval", w.materials.approvalPath, "--slots", w.inputs.slotsPath, "--provenance", w.prov, "--site", w.staged.dir, "--impl-compare", w.implDir, "--review", reviewPath];
    const out2 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await finalApprovalMain(["--check", ...args, "--approval", approvalPath])).toBe(0);
      expect(JSON.parse(String(out2.mock.calls.at(-1)![0]))).toMatchObject({ status: "passed", mode: "gate", route: "second_approval", approval: { decision: "approve" } });
      expect(await finalApprovalMain(["--check", ...args])).toBe(1); // gate without the approval: stopped
      expect(JSON.parse(String(out2.mock.calls.at(-1)![0]))).toEqual({ status: "stopped", code: "FINAL_APPROVAL_MISSING" });
    } finally {
      out2.mockRestore();
    }
    expect(parseFinalApprovalArgs(["--check", ...args.slice(0, 6)])).toBeNull();
    expect(parseFinalApprovalArgs(["--check", "--page", ...args])).toBeNull();
    expect(parseFinalApprovalArgs(["--check", ...args, "--materials-bundle", "x"])).toBeNull();
  });

  it("the gate refuses: a decision other than approve, an axis fail, a major composition change (back to the first approval), a C picture", async () => {
    expect(await codeOf(recordDecision(w, w.review, { decision: "revise" }).then((r) => approvedFinal({ ...w.inputs, ...r, repo: REPO })))).toBe("FINAL_NOT_APPROVED");
    const failing = { ...w.review, axes: { ...w.review.axes, rights: { verdict: "fail", evidence: [{ image: "sp", region: "店の写真", note: "許可の範囲が不明（架空）" }] } } };
    expect(await codeOf(recordDecision(w, failing).then((r) => approvedFinal({ ...w.inputs, ...r, repo: REPO })))).toBe("FINAL_REVIEW_HAS_FAIL");
    const major = await recordDecision(w, { ...w.review, composition_change: "major" });
    expect(major.draft.route).toBe("first_approval");
    expect(await codeOf(approvedFinal({ ...w.inputs, ...major, repo: REPO }))).toBe("FINAL_COMPOSITION_CHANGED");
    // a C class in the review, or a C provenance record
    const asC = { ...w.review, materials: w.review.materials.map((m) => (m.class === "B" ? { ...m, class: "C" } : m)) };
    expect(await codeOf(recordDecision(w, asC))).toBe("FINAL_MATERIAL_CLASS");
    // every axis is named; the review is advice only
    const lessAxes = Object.fromEntries(Object.entries(w.review.axes).filter(([k]) => k !== "rights"));
    expect(Object.keys(lessAxes)).toHaveLength(FINAL_AXES.length - 1);
    expect(await codeOf(recordDecision(w, { ...w.review, axes: lessAxes }))).toBe("FINAL_REVIEW_AXIS_MISSING");
    expect(await codeOf(recordDecision(w, { ...w.review, advice_only: false }))).toBe("FINAL_REVIEW_INVALID");
    // the approval must say it is not the owner's signature
    expect(await codeOf(recordDecision(w, w.review, { not_owner_signature: false }).then((r) => approvedFinal({ ...w.inputs, ...r, repo: REPO })))).toBe("FINAL_APPROVAL_INVALID");
  });

  it("any SHA change makes the approval stale: the review, a site file, a capture, a provenance record, the slot spec", async () => {
    const { reviewPath, approvalPath } = await recordDecision(w);
    const gate = () => codeOf(approvedFinal({ ...w.inputs, reviewPath, approvalPath, repo: REPO }));
    expect(await gate()).toBe("ok");
    const tamper = async (path: string, change: (b: Buffer) => Buffer, want: string) => {
      const before = readFileSync(path);
      write(path, change(before));
      expect(await gate(), path).toBe(want);
      write(path, before);
      expect(await gate()).toBe("ok");
    };
    const addText = (b: Buffer) => Buffer.concat([b, Buffer.from("\n")]);
    // the review edited after the decision
    await tamper(reviewPath, (b) => Buffer.from(b.toString("utf8").replace("independent-subagent", "another-reviewer")), "FINAL_APPROVAL_REVIEW_MISMATCH");
    // the site's CSS changed after the comparison and the review (the comparison no longer matches the site)
    await tamper(join(w.staged.dir, "style.css"), (b) => Buffer.concat([b, Buffer.from(".x{color:red}")]), "FINAL_IMPL_COMPARE_MISMATCH");
    // a picture swapped: the shop photo replaced by other bytes (no provenance record for them)
    await tamper(join(w.staged.dir, "assets", "shop-1.png"), () => solidPng(640, 480, [1, 2, 3]), "FINAL_IMPL_COMPARE_MISMATCH");
    // a capture replaced
    await tamper(join(w.implDir, "images", "sp-capture.png"), () => solidPng(390, 800, [9, 9, 9]), "FINAL_CAPTURE_MISMATCH");
    // the B record turned into a customer's upload (C never belongs to a Second Root approval)
    await tamper(join(w.prov, `${sha(SHOP_PHOTO["shop-1.png"])}.json`), (b) => Buffer.from(b.toString("utf8").replace('"class": "B"', '"class": "C"')), "FINAL_MATERIAL_CLASS");
    // the B rights record rewritten (still valid JSON, another SHA-256)
    await tamper(join(w.prov, `${sha(SHOP_PHOTO["shop-1.png"])}.json`), addText, "FINAL_PROVENANCE_MISMATCH");
    // an A record naming another materials approval
    const aPath = join(w.prov, `${sha(PICTURES["photo-1.png"])}.json`);
    await tamper(aPath, (b) => Buffer.from(b.toString("utf8").replace(/"materials_approval_sha256": "[0-9a-f]+"/, `"materials_approval_sha256": "${"0".repeat(64)}"`)), "FINAL_MATERIAL_NOT_APPROVED");
    // the slot spec changed (still bound to the same approval) or bound to another approval
    await tamper(w.inputs.slotsPath, addText, "FINAL_SLOTS_MISMATCH");
    await tamper(w.inputs.slotsPath, (b) => Buffer.from(b.toString("utf8").replace(/"approval_sha256": "[0-9a-f]+"/, `"approval_sha256": "${"f".repeat(64)}"`)), "FINAL_SLOTS_MISMATCH");
    // the comparison record rewritten
    await tamper(join(w.implDir, "record.json"), addText, "FINAL_IMPL_COMPARE_MISMATCH");
  });

  it("a stale first approval: the design's approval re-recorded stops the chain (its own gate, then everything bound to it)", async () => {
    const { reviewPath, approvalPath } = await recordDecision(w);
    const path = w.d.design.approvalPath;
    const before = readFileSync(path);
    write(path, Buffer.from(before.toString("utf8").replace('"decided_at"', '"note": "再記録（架空）",\n  "decided_at"')));
    // the design still passes its own gate, but its approval SHA-256 changed: the slot spec (and all else) names the old one
    expect(await codeOf(approvedFinal({ ...w.inputs, reviewPath, approvalPath, repo: REPO }))).toBe("FINAL_SLOTS_MISMATCH");
    // the design's approval with a non-approve decision fails the first gate itself (its code passes through)
    write(path, Buffer.from(before.toString("utf8").replace('"decision": "approve"', '"decision": "revise"')));
    expect(await codeOf(approvedFinal({ ...w.inputs, reviewPath, approvalPath, repo: REPO }))).toBe("DESIGN_NOT_APPROVED");
    write(path, before);
    expect(await codeOf(approvedFinal({ ...w.inputs, reviewPath, approvalPath, repo: REPO }))).toBe("ok");
  });

  it("refuses inputs it cannot bind: no materials records for an A picture, a missing provenance record, records or the page inside the repository", async () => {
    const { reviewPath, approvalPath, draft } = await recordDecision(w);
    const noMaterials: FinalInputs = { design: w.inputs.design, slotsPath: w.inputs.slotsPath, provenanceDir: w.inputs.provenanceDir, siteDir: w.inputs.siteDir, implCompareDir: w.inputs.implCompareDir };
    expect(await codeOf(approvedFinal({ ...noMaterials, reviewPath, approvalPath, repo: REPO }))).toBe("FINAL_MATERIALS_RECORDS_MISSING");
    expect(await codeOf(approvedFinal({ ...w.inputs, provenanceDir: tmp(), reviewPath, approvalPath, repo: REPO }))).toBe("FINAL_PROVENANCE_MISSING");
    expect(await codeOf(approvedFinal({ ...w.inputs, reviewPath: join(REPO, "package.json"), approvalPath, repo: REPO }))).toBe("FINAL_RECORD_IN_REPO");
    expect(await codeOf(writeFinalReviewPage(draft.review, draft.evidence, { outDir: join(REPO, "tmp-final-page"), repo: REPO }))).toBe("FINAL_PAGE_IN_REPO");
  });
});

describe("DEV-364 PR 3a: the module's reach (no pin change)", () => {
  const specifiers = (source: string) => [...source.matchAll(/(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
  it("imports only its siblings (as materials-approval.ts does), names no IMAGE_FIRST contract path, and calls nothing", () => {
    const lib = readFileSync(join(REPO, "lib/design-agent/imagefirst-worker/final-approval.ts"), "utf8");
    expect([...new Set(specifiers(lib))].sort()).toEqual(["../case-study/case-study", "./design-approval", "./impl-compare-approved", "./materials-approval", "node:crypto", "node:fs", "node:fs/promises", "node:path", "zod"]);
    const cli = readFileSync(join(REPO, "scripts/design-artifact/final-approval-check.ts"), "utf8");
    expect(specifiers(cli).sort()).toEqual(["../../lib/design-agent/imagefirst-worker/final-approval", "node:path"]);
    for (const source of [lib, cli]) {
      expect(source).not.toMatch(/design-agent\/image-first|image-first\//);
      expect(source).not.toMatch(/anthropic|openai|\bfetch\(|node:https?|child_process|spawn|execFile|codex/i);
    }
  });
});
