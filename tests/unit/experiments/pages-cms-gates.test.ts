import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSite } from "@/experiments/pages-cms/build";
import { Q1_TODAY, solidPng, writeFixture } from "@/experiments/pages-cms/fixtures";
import { CAFE_SITE } from "@/experiments/pages-cms/shop-site";
import { StageError, stageForGates } from "@/experiments/pages-cms/stage-for-gates";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { checkDesignApproval } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { runImplCompare } from "@/lib/design-agent/imagefirst-worker/impl-compare-approved";
import { approvedMaterials, materialsReviewPageSha256, parseMaterialsReview, readDeliveredMaterials } from "@/lib/design-agent/imagefirst-worker/materials-approval";
import { checkMaterialsInSite } from "@/lib/design-agent/imagefirst-worker/materials-impl-check";
import { approveRehearsal, REHEARSAL_ID, REHEARSAL_SHOP, sealRehearsal } from "@/lib/design-agent/imagefirst-worker/rehearsal";

// DEV-303 Pages CMS PR (5): the CMS build output (dist/ with /media/*) staged into the implementation-lane shape and
// checked by the two existing gates — materials-impl-check (only approved materials, byte-identical, labelled イメージ)
// and impl-compare-approved (against the SYNTHETIC rehearsal design; advice only). FICTIONAL data only: the café of
// the Pages CMS experiment, the rehearsal's synthetic design, an invented materials run. Real Chromium for stage 6.

vi.setConfig({ testTimeout: 60_000 });
const REPO = resolve(__dirname, "../../..");
const temps: string[] = [];
const tmp = (p = "sr-gates-") => {
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
const T0 = Date.parse("2026-11-26T01:00:00Z");
const MAT_ID = "req-cafe-materials-bridge-1";

/** The materials the café shows: invented pictures (a 3:2 and a square), as an approved materials run would hold them. */
const PICTURES = { "photo-1.png": solidPng(768, 512, [120, 84, 60]), "photo-3.png": solidPng(600, 600, [214, 196, 160]) };

/** The rehearsal's synthetic approved design (shop "cafe", fictional), and a materials run sealed for it. */
async function approvedChain() {
  const home = tmp("sr-gates-home-");
  const r = await sealRehearsal({ home, repo: REPO, now: () => T0 });
  const bundleDir = join(home, "sr-runs", "review-inbox", REHEARSAL_ID);
  const draft = await checkDesignApproval({ bundleDir, reviewPath: r.review, repo: REPO, mode: "draft" });
  const a = await approveRehearsal({ home, repo: REPO, pageSha256: draft.page_sha256, now: () => T0 + 60_000 });
  const design = { bundleDir, reviewPath: r.review, approvalPath: a.approval };

  const runs = tmp("sr-gates-runs-");
  const runDir = join(runs, `${MAT_ID}-20261126T020000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const images = Object.entries(PICTURES).map(([name, bytes]) => {
    writeFileSync(join(runDir, "parts", name), bytes, { mode: 0o600 });
    return { file: `parts/${name}`, sha256: sha(bytes), bytes: bytes.length };
  });
  const approved_design = { bundle_id: REHEARSAL_ID, bundle_sha256: r.bundle_sha256, review_sha256: draft.review_sha256, approval_sha256: a.approval_sha256 };
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
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(tmp("sr-gates-inbox-"), "review-inbox"), now: () => T0 + 120_000 });
  const recs = tmp("sr-gates-rec-");
  const review = bytesOf({
    schema: "sr_materials_review_v1", request_id: MAT_ID, bundle_sha256: sealed.bundle_sha256,
    materials: images.map((img, n) => ({ id: ["counter-texture", "linen-light"][n], file: img.file, sha256: img.sha256, verdict: "pass", note: "試験用の所見（架空）" })),
    reviewer: "independent-subagent", reviewed_at: "2026-11-26T03:00:00Z",
  });
  const reviewPath = join(recs, "materials.review.json");
  writeFileSync(reviewPath, review);
  const pageSha = materialsReviewPageSha256(parseMaterialsReview(review), await readDeliveredMaterials(sealed.dir));
  const approvalPath = join(recs, "materials.approval.json");
  writeFileSync(approvalPath, bytesOf({ schema: "sr_materials_approval_v1", request_id: MAT_ID, bundle_sha256: sealed.bundle_sha256, review_sha256: sha(review), page_sha256: pageSha, approved_materials: images.map((i) => ({ file: i.file, sha256: i.sha256 })), decision: "approve", decided_at: "2026-11-26T04:00:00Z" }));
  const approved = await approvedMaterials({ design, bundleDir: sealed.dir, reviewPath, approvalPath, repo: REPO });
  return { design, approved, home };
}

/** The café's dist with the approved pictures as its generated materials (unchanged bytes), staged for the gates. */
async function cafeStaged(pictures: Record<string, Buffer> = PICTURES) {
  const repo = join(tmp(), "repo");
  const fx = CAFE_SITE.fixtures()["items-3"]!;
  const names = Object.keys(pictures);
  const menu = fx.menu.map((m, k) => (k < names.length ? { ...m, image: `/media/${names[k]}`, imageAlt: `試験の画像 ${k + 1}`, imageKind: "generated" as const } : { ...m, image: "", imageAlt: "" }));
  await writeFixture(repo, { ...fx, menu, media: pictures, generated: names });
  const dist = join(tmp(), "dist");
  await buildSite({ repo, outDir: dist, today: Q1_TODAY, site: CAFE_SITE });
  return { dist, staged: await stageForGates({ dist, outDir: join(tmp(), "staged") }) };
}

describe("DEV-303 Pages CMS (5): the CMS build checked by the existing gates through the staging bridge", () => {
  it("stages dist/ as index.html + style.css + assets/ (only /media/ src rewritten, pictures byte-identical, dist untouched)", async () => {
    const { dist, staged } = await cafeStaged();
    expect(staged.assets).toEqual(["assets/photo-1.png", "assets/photo-3.png"]);
    expect(staged.rewrites).toBe(2);
    const before = readFileSync(join(dist, "index.html"), "utf8");
    const after = readFileSync(join(staged.dir, "index.html"), "utf8");
    expect(after).toBe(before.replace(/src="\/media\//g, 'src="assets/'));
    expect(readFileSync(join(staged.dir, "style.css"))).toEqual(readFileSync(join(dist, "style.css")));
    for (const [name, bytes] of Object.entries(PICTURES)) expect(readFileSync(join(staged.dir, "assets", name))).toEqual(bytes);
    expect(existsSync(join(dist, "assets"))).toBe(false);
  });

  it("materials-impl-check on the staged café: the approved pictures are used, labelled イメージ, nothing else", async () => {
    const { approved } = await approvedChain();
    const { staged } = await cafeStaged();
    const r = await checkMaterialsInSite({ approved, siteDir: staged.dir, repo: REPO });
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ status: "ok", unused: [] });
    expect(r.used.map((u) => [u.asset, u.via, u.label])).toEqual([
      ["assets/photo-1.png", ["img"], "present"],
      ["assets/photo-3.png", ["img"], "present"],
    ]);
    // a picture that is not the approved bytes is refused through the same bridge
    const other = await cafeStaged({ "photo-1.png": solidPng(768, 512, [1, 1, 1]), "photo-3.png": PICTURES["photo-3.png"] });
    // (the page's reference to it and the demo check's own finding follow from that one picture)
    const refused = await checkMaterialsInSite({ approved, siteDir: other.staged.dir, repo: REPO });
    expect(refused.status).toBe("refused");
    expect(refused.problems).toContainEqual({ code: "MATERIALS_IMPL_IMAGE_NOT_APPROVED", detail: "assets/photo-1.png" });
    expect(refused.problems.every((p) => p.detail.includes("photo-1") || p.detail === "HTML_URL_NOT_ALLOWED")).toBe(true);
  });

  it("impl-compare-approved on the staged café against the synthetic rehearsal design: a record (advice only, marked synthetic)", async () => {
    const { design, home } = await approvedChain();
    const { staged } = await cafeStaged();
    const c = await runImplCompare({ ...design, siteDir: staged.dir, outDir: join(home, "impl-compare"), repo: REPO, browser, now: () => T0 + 600_000 });
    expect(c.record).toMatchObject({ request_id: REHEARSAL_ID, synthetic: true, advisory: true, passing: false });
    expect(c.record.site.files.map((f: { path: string }) => f.path)).toEqual(["index.html", "style.css", "assets/photo-1.png", "assets/photo-3.png"]);
  });

  it("the bridge stops on what the gates cannot read: a JPEG / WebP picture, a /media/ reference left over, a missing page, a non-empty output", async () => {
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof StageError ? e.code : e instanceof Error ? e.message : String(e)));
    const dist = tmp("sr-gates-dist-");
    mkdirSync(join(dist, "media"));
    writeFileSync(join(dist, "index.html"), '<img src="/media/a.jpg">');
    writeFileSync(join(dist, "style.css"), "body{}");
    writeFileSync(join(dist, "media", "a.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    expect(await code(stageForGates({ dist, outDir: join(tmp(), "o") }))).toBe("STAGE_ASSET_NOT_PNG");
    rmSync(join(dist, "media", "a.jpg"));
    writeFileSync(join(dist, "style.css"), ".x{background:url(/media/b.png)}");
    expect(await code(stageForGates({ dist, outDir: join(tmp(), "o") }))).toBe("STAGE_MEDIA_REFERENCE");
    rmSync(join(dist, "index.html"));
    expect(await code(stageForGates({ dist, outDir: join(tmp(), "o") }))).toBe("STAGE_DIST_INVALID");
    const { dist: good } = await cafeStaged();
    const full = tmp();
    writeFileSync(join(full, "x"), "x");
    expect(await code(stageForGates({ dist: good, outDir: full }))).toBe("Q1_OUT_NOT_EMPTY");
    expect(await code(stageForGates({ dist: good, outDir: join(REPO, "tmp-staged") }))).toBe("Q1_OUT_IN_REPO_OR_MISSING_PARENT");
    expect(existsSync(join(REPO, "tmp-staged"))).toBe(false);
  });
});
