import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { checkDesignApproval, DESIGN_AXES } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { approvedMaterials, checkMaterialsApproval, MaterialsApprovalStop, type ApprovedMaterials } from "@/lib/design-agent/imagefirst-worker/materials-approval";
import { checkMaterialsInSite, MaterialsImplStop } from "@/lib/design-agent/imagefirst-worker/materials-impl-check";
import { materialsMain } from "@/scripts/design-artifact/materials-impl-check";
import { colourPng } from "../phase2f/fixtures";

// DEV-303 §6.1 change 7 (docs/design/image-first-production-flow.md §1 stage 4 → 5): the materials review and the
// owner's approval, bound to the approved design; and the implemented site may show only the approved materials (by
// SHA-256). FICTIONAL data only (an invented shop, synthetic pictures, a tiny invented site). No browser, no network.

vi.setConfig({ testTimeout: 30_000 });
const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
const tmp = (p = "sr-mat-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const SHOP = "test-shop-m";
const DESIGN_ID = "req-test-shop-m-design-1";
const MAT_ID = "req-test-shop-m-materials-1";
const NOW = () => Date.parse("2026-11-25T02:00:00Z");
const receiptBase = (id: string, runDir: string, images: unknown[]) => ({
  schema: "imagefirst_worker_receipt_v1", status: "succeeded", stop_code: null, stage: null, cli_exit: 0, cli_timed_out: false, interrupted: false,
  shop: SHOP, direction: "request", approval_id: id, plan_id: id, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 5000,
  run_dir: runDir, images, stopped_images: [], verified: true,
  timings: { started_at: "2026-11-25T01:00:00.000Z", finished_at: "2026-11-25T01:10:00.000Z", elapsed_ms: 600_000 },
  mode: "request", kind: "fictional", request_id: id, request_sha256: "a".repeat(64), facts_sha256: "e".repeat(64), images_total: images.length,
});
const runOf = (id: string, names: string[], size: (k: number) => [number, number]) => {
  const runs = tmp("sr-mat-runs-");
  const runDir = join(runs, `${id}-20261125T010000Z`);
  mkdirSync(join(runDir, "parts"), { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const images = names.map((n, k) => {
    const bytes = colourPng(...size(k));
    writeFileSync(join(runDir, "parts", `${n}.png`), bytes, { mode: 0o600 });
    return { file: `parts/${n}.png`, sha256: sha(bytes), bytes: bytes.length, data: bytes };
  });
  return { runs, runDir, images };
};

/** A sealed whole-page design (PC 1 + SP 1), its five-axis review and the owner's decision (fictional). */
async function design(decision: "approve" | "revise" = "approve") {
  const { runs, runDir, images } = runOf(DESIGN_ID, ["pc-1", "sp-1"], (k) => [512 + k, 768]);
  const refs = [{ id: "ref-1", case_id: "CP-001", sha256: "f".repeat(64) }];
  writeFileSync(join(runDir, "reference-inputs.json"), JSON.stringify({ schema: "image_first_reference_inputs_v0", layout: "whole_page", references: refs }), { mode: 0o600 });
  const list = images.map(({ file, sha256, bytes }) => ({ file, sha256, bytes }));
  const receipt = { ...receiptBase(DESIGN_ID, runDir, list), counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, design_layout: "whole_page", reference_images: refs };
  const receiptPath = join(runs, "design.receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(tmp("sr-mat-inbox-"), "review-inbox"), now: NOW });
  const recs = tmp("sr-mat-rec-");
  const imgs = { pc: [{ file: list[0]!.file, sha256: list[0]!.sha256 }], sp: [{ file: list[1]!.file, sha256: list[1]!.sha256 }] };
  const axis = { verdict: "pass", evidence: [{ image: "pc", region: "最初の画面", note: "試験用の根拠（架空）" }] };
  const reviewPath = join(recs, "design.review.json");
  writeFileSync(reviewPath, bytesOf({ schema: "sr_design_review_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, images: imgs, axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, axis])), reviewer: "independent-subagent", reviewed_at: "2026-11-25T03:00:00Z" }));
  const c = await checkDesignApproval({ bundleDir: sealed.dir, reviewPath, repo: REPO, mode: "draft" });
  const approvalPath = join(recs, "design.approval.json");
  const approvalBytes = bytesOf({ schema: "sr_design_approval_v1", request_id: DESIGN_ID, bundle_sha256: sealed.bundle_sha256, approved_images: imgs, review_sha256: c.review_sha256, page_sha256: c.page_sha256, decision, decided_at: "2026-11-25T04:00:00Z" });
  writeFileSync(approvalPath, approvalBytes);
  return { bundleDir: sealed.dir, reviewPath, approvalPath, bundleSha: sealed.bundle_sha256, reviewSha: c.review_sha256, approvalSha: sha(approvalBytes) };
}
type Design = Awaited<ReturnType<typeof design>>;

/** A sealed materials run (photo-1 landscape, photo-3 square) made for the given design, with its review records. */
async function materials(d: Design, o: { approvalSha?: string } = {}) {
  const { runs, runDir, images } = runOf(MAT_ID, ["photo-1", "photo-3"], (k) => (k === 0 ? [768, 512] : [600, 600]));
  const approved_design = { bundle_id: DESIGN_ID, bundle_sha256: d.bundleSha, review_sha256: d.reviewSha, approval_sha256: o.approvalSha ?? d.approvalSha };
  const materials_sha256 = "9".repeat(64);
  writeFileSync(join(runDir, "approved-design-input.json"), JSON.stringify({ schema: "image_first_approved_design_input_v0", ...approved_design, materials_sha256 }), { mode: 0o600 });
  const list = images.map(({ file, sha256, bytes }) => ({ file, sha256, bytes }));
  const receipt = { ...receiptBase(MAT_ID, runDir, list), counts: { pc: 0, sp: 0, photo: 2, total: 2, stopped: 0 }, request_stage: "photo_materials", approved_design, materials_sha256 };
  const receiptPath = join(runs, "materials.receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(tmp("sr-mat-inbox-"), "review-inbox"), now: NOW });
  return { bundleDir: sealed.dir, bundleSha: sealed.bundle_sha256, images, recs: tmp("sr-mat-rec-") };
}
type Materials = Awaited<ReturnType<typeof materials>>;

const reviewOf = (m: Materials, verdicts: ("pass" | "revise" | "fail")[] = ["pass", "pass"], extra: Record<string, unknown> = {}) =>
  bytesOf({
    schema: "sr_materials_review_v1", request_id: MAT_ID, bundle_sha256: m.bundleSha,
    materials: m.images.map((img, n) => ({ id: ["counter-texture", "linen-light"][n], file: img.file, sha256: img.sha256, verdict: verdicts[n], note: "試験用の所見（架空）" })),
    reviewer: "independent-subagent", reviewed_at: "2026-11-25T05:00:00Z", ...extra,
  });
const approvalOf = (m: Materials, review: Buffer, extra: Record<string, unknown> = {}) =>
  bytesOf({ schema: "sr_materials_approval_v1", request_id: MAT_ID, bundle_sha256: m.bundleSha, review_sha256: sha(review), approved_materials: m.images.map((i) => ({ file: i.file, sha256: i.sha256 })), decision: "approve", decided_at: "2026-11-25T06:00:00Z", ...extra });
const put = (dir: string, name: string, b: Buffer) => {
  const p = join(dir, name);
  rmSync(p, { force: true });
  writeFileSync(p, b);
  return p;
};
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof MaterialsApprovalStop || e instanceof MaterialsImplStop ? e.code : String(e)));

let d: Design;
let m: Materials;
let approved: ApprovedMaterials;
beforeAll(async () => {
  d = await design();
  m = await materials(d);
  const review = reviewOf(m);
  approved = await approvedMaterials({ design: d, bundleDir: m.bundleDir, reviewPath: put(m.recs, "r.json", review), approvalPath: put(m.recs, "a.json", approvalOf(m, review)), repo: REPO });
});

describe("DEV-303 §6.1 change 7: the materials review and the owner's approval (bound to the approved design)", () => {
  it("returns the approved pictures with their SHA-256s and the records that bind them; a subset approval leaves the rest out", async () => {
    expect(approved).toMatchObject({ request_id: MAT_ID, bundle_sha256: m.bundleSha, shop: SHOP, kind: "fictional", design: { request_id: DESIGN_ID, bundle_sha256: d.bundleSha, review_sha256: d.reviewSha, approval_sha256: d.approvalSha } });
    expect(approved.materials.map((x) => [x.id, x.file, x.sha256, sha(x.bytes)])).toEqual(m.images.map((i, n) => [["counter-texture", "linen-light"][n], i.file, i.sha256, i.sha256]));
    const review = reviewOf(m, ["pass", "fail"]);
    const reviewPath = put(m.recs, "r2.json", review);
    // draft: the review alone, with its verdicts
    expect((await checkMaterialsApproval({ design: d, bundleDir: m.bundleDir, reviewPath, repo: REPO, mode: "draft" })).verdicts.map((v) => v.verdict)).toEqual(["pass", "fail"]);
    const one = await approvedMaterials({ design: d, bundleDir: m.bundleDir, reviewPath, approvalPath: put(m.recs, "a2.json", approvalOf(m, review, { approved_materials: [{ file: m.images[0]!.file, sha256: m.images[0]!.sha256 }] })), repo: REPO });
    expect(one.materials.map((x) => x.file)).toEqual(["parts/photo-1.png"]);
  });

  it("refuses: a fail approved, not approved, an edited review, a decision before the review, an unreviewed picture, an incomplete review, unsafe text, records in the repository", async () => {
    const go = (review: Buffer, approval: Buffer | null, name: string) =>
      codeOf(approvedMaterials({ design: d, bundleDir: m.bundleDir, reviewPath: put(m.recs, `${name}.r.json`, review), approvalPath: approval ? put(m.recs, `${name}.a.json`, approval) : join(m.recs, "absent.json"), repo: REPO }));
    const failed = reviewOf(m, ["pass", "fail"]);
    expect(await go(failed, approvalOf(m, failed), "fail")).toBe("MATERIALS_APPROVAL_HAS_FAIL");
    const revised = reviewOf(m, ["pass", "revise"]);
    expect(await go(revised, approvalOf(m, revised), "revise")).toBe("ok");
    const ok = reviewOf(m);
    expect(await go(ok, approvalOf(m, ok, { decision: "revise" }), "decision")).toBe("MATERIALS_NOT_APPROVED");
    expect(await go(reviewOf(m, ["pass", "pass"], { reviewer: "another-subagent" }), approvalOf(m, ok), "edited")).toBe("MATERIALS_APPROVAL_REVIEW_MISMATCH");
    expect(await go(ok, approvalOf(m, ok, { decided_at: "2026-11-25T04:59:59Z" }), "early")).toBe("MATERIALS_APPROVAL_BEFORE_REVIEW");
    expect(await go(ok, approvalOf(m, ok, { approved_materials: [{ file: "parts/photo-1.png", sha256: "0".repeat(64) }] }), "unreviewed")).toBe("MATERIALS_APPROVAL_MATERIALS_MISMATCH");
    const reversed = approvalOf(m, ok, { approved_materials: [...m.images].reverse().map((i) => ({ file: i.file, sha256: i.sha256 })) });
    expect(await go(ok, reversed, "order")).toBe("MATERIALS_APPROVAL_MATERIALS_MISMATCH");
    const partial = bytesOf({ ...JSON.parse(ok.toString("utf8")), materials: JSON.parse(ok.toString("utf8")).materials.slice(0, 1) });
    expect(await go(partial, approvalOf(m, partial), "partial")).toBe("MATERIALS_REVIEW_MATERIALS_MISMATCH");
    expect(await go(reviewOf(m, ["pass", "pass"], { reviewer: "see https://example.invalid" }), null, "url")).toBe("MATERIALS_REVIEW_TEXT_UNSAFE");
    expect(await go(ok, null, "noapproval")).toBe("MATERIALS_RECORD_MISSING");
    // review L4: the gate without an approval path at all is named
    expect(await codeOf(checkMaterialsApproval({ design: d, bundleDir: m.bundleDir, reviewPath: put(m.recs, "gate.r.json", ok), repo: REPO, mode: "gate" }))).toBe("MATERIALS_APPROVAL_MISSING");
    expect(await codeOf(approvedMaterials({ design: d, bundleDir: m.bundleDir, reviewPath: resolve(REPO, "package.json"), approvalPath: join(m.recs, "a.json"), repo: REPO }))).toBe("MATERIALS_RECORD_IN_REPO");
  });

  it("the materials must belong to the approved design: an unapproved design stops (DESIGN_*), another design's materials and a design bundle are refused", async () => {
    const review = reviewOf(m);
    const records = { reviewPath: put(m.recs, "b.r.json", review), approvalPath: put(m.recs, "b.a.json", approvalOf(m, review)), repo: REPO };
    const revised = await design("revise");
    expect(await codeOf(approvedMaterials({ design: revised, bundleDir: m.bundleDir, ...records }))).toBe("DESIGN_NOT_APPROVED");
    const other = await materials(d, { approvalSha: "7".repeat(64) });
    const r2 = reviewOf(other);
    expect(await codeOf(approvedMaterials({ design: d, bundleDir: other.bundleDir, reviewPath: put(other.recs, "r.json", r2), approvalPath: put(other.recs, "a.json", approvalOf(other, r2)), repo: REPO }))).toBe("MATERIALS_DESIGN_MISMATCH");
    expect(await codeOf(approvedMaterials({ design: d, bundleDir: d.bundleDir, ...records }))).toBe("MATERIALS_BUNDLE_NOT_MATERIALS");
  });
});

/** A tiny invented site: the approved landscape picture in a labelled figure, the square one as a CSS background. */
function site(o: { html?: string; css?: string; files?: Record<string, Buffer> } = {}) {
  const dir = join(tmp("sr-mat-site-"), "site-1");
  mkdirSync(join(dir, "assets"), { recursive: true });
  const fig = '<figure><img src="assets/counter.png" alt="カウンターの質感"><figcaption>イメージ（差し替えできます）</figcaption></figure>';
  writeFileSync(join(dir, "index.html"), `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><main><h1>架空の店</h1><p>提案用デモ</p>${o.html ?? fig}<div class="band">試験用の架空のページです。</div></main></body></html>`);
  writeFileSync(join(dir, "style.css"), o.css ?? 'body{margin:0;font-family:sans-serif}.band{background:url("assets/linen.png")}img{display:block;max-width:100%}');
  writeFileSync(join(dir, "assets", "counter.png"), m.images[0]!.data);
  writeFileSync(join(dir, "assets", "linen.png"), m.images[1]!.data);
  for (const [k, v] of Object.entries(o.files ?? {})) {
    mkdirSync(join(dir, k, ".."), { recursive: true });
    writeFileSync(join(dir, k), v);
  }
  return dir;
}
const check = (siteDir: string) => checkMaterialsInSite({ approved, siteDir, repo: REPO });
const codes = async (siteDir: string) => (await check(siteDir)).problems.map((p) => p.code);

describe("DEV-303 §6.1 change 7: the implemented site shows only approved materials (by SHA-256), labelled イメージ", () => {
  it("accepts the approved pictures used as they are: which are used, how, and the label where it can be checked", async () => {
    const r = await check(site());
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ status: "ok", materials_request_id: MAT_ID, materials_approval_sha256: approved.approval_sha256, unused: [] });
    expect(r.used).toEqual([
      { id: "counter-texture", file: "parts/photo-1.png", sha256: m.images[0]!.sha256, asset: "assets/counter.png", via: ["img"], label: "present" },
      { id: "linen-light", file: "parts/photo-3.png", sha256: m.images[1]!.sha256, asset: "assets/linen.png", via: ["css"], label: "not_checked" },
    ]);
    expect(r.site_files.map((f) => f.path)).toEqual(["assets/counter.png", "assets/linen.png", "index.html", "style.css"]);
  });

  it("refuses an unapproved or re-encoded picture, a picture outside assets/, external and unapproved references, a missing label, what the demo check refuses", async () => {
    expect(await codes(site({ files: { "assets/other.png": colourPng(700, 500) } }))).toEqual(["MATERIALS_IMPL_IMAGE_NOT_APPROVED"]);
    // the approved picture with one byte changed is another picture
    const changed = Buffer.from(m.images[0]!.data);
    changed[changed.length - 20] ^= 1;
    expect(await codes(site({ files: { "assets/counter.png": changed } }))).toContain("MATERIALS_IMPL_IMAGE_NOT_APPROVED");
    // a picture by its first bytes, whatever its name; and one outside assets/
    expect(await codes(site({ files: { "assets/notes.txt": colourPng(520, 520) } }))).toEqual(["MATERIALS_IMPL_IMAGE_NOT_APPROVED"]);
    expect(await codes(site({ files: { "img/counter.png": m.images[0]!.data } }))).toEqual(["MATERIALS_IMPL_IMAGE_OUTSIDE_ASSETS"]);
    const ext = await check(site({ html: '<figure><img src="https://example.invalid/a.jpg" alt=""><figcaption>イメージ</figcaption></figure>', css: "body{font-family:sans-serif;background:url(//example.invalid/b.png)}" }));
    expect(ext.problems.filter((p) => p.code === "MATERIALS_IMPL_EXTERNAL_IMAGE").map((p) => p.detail)).toEqual(["https://example.invalid/a.jpg", "//example.invalid/b.png"]);
    expect(ext.status).toBe("refused");
    expect(await codes(site({ html: '<figure><img src="assets/missing.png" alt=""><figcaption>イメージ</figcaption></figure>' }))).toContain("MATERIALS_IMPL_IMAGE_REF_NOT_APPROVED");
    expect(await codes(site({ html: '<figure><img src="data:image/png;base64,AAAA" alt=""><figcaption>イメージ</figcaption></figure>' }))).toContain("MATERIALS_IMPL_IMAGE_REF_NOT_APPROVED");
    // the label: no figure, or a caption without イメージ
    expect(await codes(site({ html: '<img src="assets/counter.png" alt="">' }))).toEqual(["MATERIALS_IMPL_LABEL_MISSING"]);
    const r = await check(site({ html: '<figure><img src="assets/counter.png" alt=""><figcaption>カウンター</figcaption></figure>' }));
    expect([r.problems.map((p) => p.code), r.used[0]!.label]).toEqual([["MATERIALS_IMPL_LABEL_MISSING"], "missing"]);
    // review L1: a hidden caption, or a hidden figure or ancestor, shows no label
    expect(await codes(site({ html: '<figure><img src="assets/counter.png" alt=""><figcaption hidden>イメージ</figcaption></figure>' }))).toEqual(["MATERIALS_IMPL_LABEL_MISSING"]);
    expect(await codes(site({ html: '<figure><img src="assets/counter.png" alt=""><figcaption aria-hidden="true">イメージ</figcaption></figure>' }))).toEqual(["MATERIALS_IMPL_LABEL_MISSING"]);
    expect(await codes(site({ html: '<div aria-hidden="TRUE"><figure><img src="assets/counter.png" alt=""><figcaption>イメージ</figcaption></figure></div>' }))).toEqual(["MATERIALS_IMPL_LABEL_MISSING"]);
    // #350 review Low: the label only inside a hidden descendant of the caption is no label; a visible one beside it is
    expect(await codes(site({ html: '<figure><img src="assets/counter.png" alt=""><figcaption><span hidden>イメージ</span>カウンター</figcaption></figure>' }))).toEqual(["MATERIALS_IMPL_LABEL_MISSING"]);
    expect(await codes(site({ html: '<figure><img src="assets/counter.png" alt=""><figcaption><span aria-hidden="true">イメージ</span></figcaption></figure>' }))).toEqual(["MATERIALS_IMPL_LABEL_MISSING"]);
    expect(await codes(site({ html: '<figure><img src="assets/counter.png" alt=""><figcaption><span hidden>説明</span><span>イメージ</span></figcaption></figure>' }))).toEqual([]);
    // review M1: an approved material from an SVG attribute (the demo check allows it as a declared picture) is refused,
    // so no use escapes the count and the label rule; an in-page #id reference stays allowed
    const svg = await check(site({ html: '<figure><img src="assets/counter.png" alt=""><figcaption>イメージ</figcaption></figure><svg width="10" height="10"><defs><lineargradient id="g"><stop offset="0"></stop></lineargradient></defs><rect width="10" height="10" mask="url(assets/linen.png)" fill="url(#g)"></rect></svg>', css: "body{font-family:sans-serif}" }));
    expect(svg.problems).toEqual([{ code: "MATERIALS_IMPL_IMAGE_IN_ATTRIBUTE", detail: "rect mask: assets/linen.png" }]);
    // the demo version's own check, fail closed (a style element could carry a picture)
    const styled = await check(site({ html: '<style>.x{background:url("assets/other.png")}</style><figure><img src="assets/counter.png" alt=""><figcaption>イメージ</figcaption></figure>' }));
    expect(styled.problems).toContainEqual({ code: "MATERIALS_IMPL_HTML_UNSAFE", detail: "HTML_STYLE_ELEMENT" });
  });

  it("stops on the site itself: in the repository, a link inside, missing files, absent", async () => {
    expect(await codeOf(check(resolve(REPO, "design-library")))).toBe("MATERIALS_IMPL_SITE_IN_REPO");
    const linked = site();
    rmSync(join(linked, "assets", "linen.png"));
    symlinkSync(join(site(), "assets", "linen.png"), join(linked, "assets", "linen.png"));
    expect(await codeOf(check(linked))).toBe("MATERIALS_IMPL_SITE_UNSAFE");
    // review L3: a hard link (a file shared with somewhere else) is refused as well
    const hard = site();
    rmSync(join(hard, "assets", "linen.png"));
    linkSync(join(site(), "assets", "linen.png"), join(hard, "assets", "linen.png"));
    expect(await codeOf(check(hard))).toBe("MATERIALS_IMPL_SITE_UNSAFE");
    const linkedSite = join(tmp(), "linked-site");
    symlinkSync(site(), linkedSite);
    expect(await codeOf(check(linkedSite))).toBe("MATERIALS_IMPL_SITE_UNSAFE");
    const noCss = site();
    rmSync(join(noCss, "style.css"));
    expect(await codeOf(check(noCss))).toBe("MATERIALS_IMPL_SITE_INVALID");
    expect(await codeOf(check(join(tmp(), "absent")))).toBe("MATERIALS_IMPL_SITE_MISSING");
  });

  it("the CLI: draft (exit 0), approved (exit 0), a site refused (exit 1), bad arguments (exit 2); it writes nothing", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    try {
      const review = reviewOf(m);
      const reviewPath = put(m.recs, "cli.r.json", review);
      const approvalPath = put(m.recs, "cli.a.json", approvalOf(m, review));
      const base = ["--design-bundle", d.bundleDir, "--design-review", d.reviewPath, "--design-approval", d.approvalPath, "--materials-bundle", m.bundleDir, "--materials-review", reviewPath];
      expect(await materialsMain(base, REPO)).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({ status: "draft", request_id: MAT_ID });
      expect(await materialsMain([...base, "--materials-approval", approvalPath], REPO)).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({ status: "approved", materials: [{ id: "counter-texture" }, { id: "linen-light" }] });
      const bad = site({ files: { "assets/other.png": colourPng(700, 500) } });
      expect(await materialsMain([...base, "--materials-approval", approvalPath, "--site", bad], REPO)).toBe(1);
      expect(JSON.parse(out.pop()!)).toMatchObject({ status: "refused", problems: [{ code: "MATERIALS_IMPL_IMAGE_NOT_APPROVED", detail: "assets/other.png" }] });
      expect(await materialsMain([...base, "--site", bad], REPO)).toBe(2);
      expect(await materialsMain(base.slice(0, 4), REPO)).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(m.recs, "cli.r.json")).length).toBeGreaterThan(0);
  });
});
