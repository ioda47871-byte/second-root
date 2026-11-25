import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VIEWING_PAGE_CSP } from "@/lib/design-agent/case-study/case-study";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { checkDesignApproval, DESIGN_AXES } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { IMPL_COMPARE_SCHEMA, ImplCompareStop, renderImplComparePage, runImplCompare, type ImplCompareRecord } from "@/lib/design-agent/imagefirst-worker/impl-compare-approved";
import { implCompareMain } from "@/scripts/design-artifact/impl-compare-approved";
import { colourPng } from "../phase2f/fixtures";

// DEV-303 §6.1 change 8 (docs/design/image-first-production-flow.md §1 stage 6): the implemented site against the
// owner-approved whole-page design of a request-mode run. FICTIONAL data only (an invented request and shop, synthetic
// pictures, a tiny invented site). The real Chromium draws it (JS off, network blocked); no model, no network.

vi.setConfig({ testTimeout: 60_000 });
const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
const tmp = (p = "sr-ica-") => {
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
const RID = "req-test-shop-c-1";

/** A sealed whole-page bundle (PC 1 + SP 1) with its five-axis review and the owner's approval (fictional). */
async function approvedRun(decision: "approve" | "revise" = "approve") {
  const runs = tmp("sr-ica-runs-");
  const runDir = join(runs, `${RID}-20261125T010000Z`);
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
    shop: "test-shop-c", direction: "request", approval_id: RID, plan_id: RID, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 5000,
    run_dir: runDir, images, stopped_images: [], counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, verified: true,
    timings: { started_at: "2026-11-25T01:00:00.000Z", finished_at: "2026-11-25T01:10:00.000Z", elapsed_ms: 600_000 },
    mode: "request", kind: "fictional", request_id: RID, request_sha256: "a".repeat(64), facts_sha256: "e".repeat(64), images_total: 2,
    design_layout: "whole_page", reference_images: refs,
  };
  const receiptPath = join(runs, `${RID}-20261125T010000Z.receipt.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(tmp("sr-ica-inbox-"), "review-inbox"), now: () => Date.parse("2026-11-25T02:00:00Z") });
  const recs = tmp("sr-ica-rec-");
  const imgs = { pc: [{ file: images[0]!.file, sha256: images[0]!.sha256 }], sp: [{ file: images[1]!.file, sha256: images[1]!.sha256 }] };
  const axis = { verdict: "pass", evidence: [{ image: "pc", region: "最初の画面", note: "試験用の根拠（架空）" }] };
  const reviewPath = join(recs, "review.json");
  writeFileSync(reviewPath, bytesOf({ schema: "sr_design_review_v1", request_id: RID, bundle_sha256: sealed.bundle_sha256, images: imgs, axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, axis])), reviewer: "independent-subagent", reviewed_at: "2026-11-25T03:00:00Z" }));
  const c = await checkDesignApproval({ bundleDir: sealed.dir, reviewPath, repo: REPO, mode: "draft" });
  const approvalPath = join(recs, "approval.json");
  writeFileSync(approvalPath, bytesOf({ schema: "sr_design_approval_v1", request_id: RID, bundle_sha256: sealed.bundle_sha256, approved_images: imgs, review_sha256: c.review_sha256, page_sha256: c.page_sha256, decision, decided_at: "2026-11-25T04:00:00Z" }));
  return { bundleDir: sealed.dir, bundleSha: sealed.bundle_sha256, reviewPath, approvalPath, images };
}

/** A tiny invented site: index.html, style.css and one picture (optionally a wide block and a missing picture). */
function site(o: { overflow?: boolean; missing?: boolean } = {}) {
  const dir = join(tmp("sr-ica-site-"), "site-1");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><header><h1>架空の店</h1></header><main><p>試験用の架空のページです。</p><img src="assets/a.png" alt="">${o.missing ? '<img src="assets/missing.png" alt="">' : ""}${o.overflow ? '<div class="wide">広い</div>' : ""}</main></body></html>`);
  writeFileSync(join(dir, "style.css"), "body{margin:0;font-family:sans-serif;background:#f4efe6}header{padding:40px;background:#3b2f2a;color:#fff}main{padding:24px;min-height:1200px}img{display:block;max-width:100%}.wide{width:3000px;height:20px;background:#c33}");
  writeFileSync(join(dir, "assets", "a.png"), colourPng(64, 64));
  return dir;
}
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ImplCompareStop ? e.code : String(e)));

describe("DEV-303 §6.1 change 8: the implemented site against the approved whole-page design (real Chromium)", () => {
  let run: Awaited<ReturnType<typeof approvedRun>>;
  beforeAll(async () => {
    run = await approvedRun();
  });

  it("writes the private record, captures and review page; every SHA-256 is the bytes'; advisory, never passing", async () => {
    const siteDir = site();
    const out = join(tmp(), "compare");
    const r = await runImplCompare({ bundleDir: run.bundleDir, reviewPath: run.reviewPath, approvalPath: run.approvalPath, siteDir, outDir: out, repo: REPO, browser, now: () => Date.parse("2026-11-25T05:00:00Z") });
    const rec = JSON.parse(readFileSync(join(out, "record.json"), "utf8")) as ImplCompareRecord;
    expect(rec).toMatchObject({ schema: IMPL_COMPARE_SCHEMA, advisory: true, passing: false, request_id: RID, approved: { bundle_sha256: run.bundleSha, approval_sha256: sha(readFileSync(run.approvalPath)), review_sha256: sha(readFileSync(run.reviewPath)) }, created_at: "2026-11-25T05:00:00.000Z" });
    expect(r.record_sha256).toBe(sha(readFileSync(join(out, "record.json"))));
    expect(rec.site.files.map((f) => [f.path, f.sha256])).toEqual(["index.html", "style.css", "assets/a.png"].map((p) => [p, sha(readFileSync(join(siteDir, p)))]));
    for (const [v, tag, n] of [["desktop_1440", "pc", 0], ["mobile_390", "sp", 1]] as const) {
      const x = rec.viewports[v];
      expect(x.design.source_sha256).toBe(run.images[n]!.sha256);
      expect(x.design.width).toBe(v === "desktop_1440" ? 1440 : 390);
      expect(x.design.scaled_sha256).toBe(sha(readFileSync(join(out, "images", `${tag}-design.png`))));
      expect(x.capture.sha256).toBe(sha(readFileSync(join(out, "images", `${tag}-capture.png`))));
      expect(x.code).toBeNull();
      expect(x.page).toMatchObject({ ssim: expect.any(Number), colour_blocks: expect.any(Number), edges_iou: expect.any(Number), height_ratio: expect.any(Number) });
      expect(x.findings).toEqual([]);
    }
    expect(rec.tools.chromium).toMatch(/\d+\./);
    expect(rec.not_measured.join(" ")).toMatch(/section/);
    // the review page: CSP, no script or external reference, the approval named
    const html = readFileSync(r.page, "utf8");
    expect(sha(html)).toBe(r.page_sha256);
    expect(html).toContain(`content="${VIEWING_PAGE_CSP}"`);
    expect(html).not.toMatch(/<script|\son[a-z]+=|https?:\/\//i);
    expect(html).toContain(run.bundleSha);
    expect(html).toContain("オーナーの確認のための助言");
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(out, "images")).sort()).toEqual(["pc-capture.png", "pc-design.png", "sp-capture.png", "sp-design.png"]);
  });

  it("findings from the capture: a page wider than the viewport, a picture that is not there", async () => {
    const r = await runImplCompare({ bundleDir: run.bundleDir, reviewPath: run.reviewPath, approvalPath: run.approvalPath, siteDir: site({ overflow: true, missing: true }), outDir: join(tmp(), "compare"), repo: REPO, browser });
    expect(r.record.findings).toEqual(["PC_HORIZONTAL_OVERFLOW", "PC_UNSERVED_REQUESTS", "SP_HORIZONTAL_OVERFLOW", "SP_UNSERVED_REQUESTS"]);
  });

  it("refuses: an unapproved design (DESIGN_* passes through), a site or output inside the repository, a linked or incomplete site, no browser", async () => {
    const base = { bundleDir: run.bundleDir, reviewPath: run.reviewPath, approvalPath: run.approvalPath, repo: REPO, browser };
    const revised = await approvedRun("revise");
    expect(await codeOf(runImplCompare({ ...base, bundleDir: revised.bundleDir, reviewPath: revised.reviewPath, approvalPath: revised.approvalPath, siteDir: site(), outDir: join(tmp(), "o") }))).toBe("DESIGN_NOT_APPROVED");
    expect(await codeOf(runImplCompare({ ...base, approvalPath: join(tmp(), "absent.json"), siteDir: site(), outDir: join(tmp(), "o") }))).toBe("DESIGN_RECORD_MISSING");
    expect(await codeOf(runImplCompare({ ...base, siteDir: resolve(REPO, "design-library"), outDir: join(tmp(), "o") }))).toBe("IMPL_SITE_IN_REPO");
    const linked = join(tmp(), "linked-site");
    symlinkSync(site(), linked);
    expect(await codeOf(runImplCompare({ ...base, siteDir: linked, outDir: join(tmp(), "o") }))).toBe("IMPL_SITE_UNSAFE");
    const noCss = site();
    rmSync(join(noCss, "style.css"));
    expect(await codeOf(runImplCompare({ ...base, siteDir: noCss, outDir: join(tmp(), "o") }))).toBe("IMPL_SITE_INVALID");
    const badAsset = site();
    writeFileSync(join(badAsset, "assets", "b.png"), "not a png");
    expect(await codeOf(runImplCompare({ ...base, siteDir: badAsset, outDir: join(tmp(), "o") }))).toBe("IMPL_SITE_INVALID");
    expect(await codeOf(runImplCompare({ ...base, siteDir: join(tmp(), "absent"), outDir: join(tmp(), "o") }))).toBe("IMPL_SITE_MISSING");
    expect(await codeOf(runImplCompare({ ...base, siteDir: site(), outDir: join(REPO, "tmp-impl-compare-out") }))).toBe("IMPL_OUT_IN_REPO");
    expect(existsSync(join(REPO, "tmp-impl-compare-out"))).toBe(false);
    const full = tmp();
    writeFileSync(join(full, "x"), "x");
    expect(await codeOf(runImplCompare({ ...base, siteDir: site(), outDir: full }))).toBe("IMPL_OUT_NOT_EMPTY");
    expect(await codeOf(runImplCompare({ ...base, browser: null, siteDir: site(), outDir: join(tmp(), "o") }))).toBe("IMPL_CAPTURE_FAILED");
  });

  it("the review page escapes every text", () => {
    const rec = {
      schema: IMPL_COMPARE_SCHEMA, advisory: true, passing: false, status: "compared", request_id: RID,
      approved: { bundle_sha256: "a".repeat(64), review_sha256: "b".repeat(64), approval_sha256: "c".repeat(64) },
      site: { files: [] },
      viewports: Object.fromEntries((["desktop_1440", "mobile_390"] as const).map((v) => [v, { design: { source_file: '<img src=x onerror="y">', source_sha256: "d".repeat(64), scaled_sha256: "e".repeat(64), width: 1440, height: 2160 }, capture: { sha256: "f".repeat(64), height: 900, scroll_width: 1440, blocked_requests: 0 }, page: null, code: null, differences: ["<script>alert(1)</script>"], findings: ["</ul><a href=\"https://x\">"] }])),
      differences: [], findings: [], measured: ["<b>"], not_measured: [], tools: { chromium: "1", comparison: "x" }, created_at: "2026-11-25T05:00:00.000Z",
    } as unknown as ImplCompareRecord;
    const html = renderImplComparePage(rec);
    expect(html).not.toMatch(/<script|onerror="|<a href|<b>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("the CLI end to end: written (exit 0) with a real browser; refused arguments (exit 2); a browser that does not start stops (exit 1)", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    const lines = () => out.splice(0).join("");
    try {
      const args = ["--bundle", run.bundleDir, "--review", run.reviewPath, "--approval", run.approvalPath, "--site", site(), "--out", join(tmp(), "cli")];
      expect(await implCompareMain(args)).toBe(0);
      expect(JSON.parse(lines())).toMatchObject({ status: "written", advisory: true, passing: false });
      expect(await implCompareMain(["--bundle", run.bundleDir])).toBe(2);
      expect(JSON.parse(lines())).toEqual({ status: "refused", code: "ARGS_INVALID" });
      const args2 = ["--bundle", run.bundleDir, "--review", run.reviewPath, "--approval", run.approvalPath, "--site", site(), "--out", join(tmp(), "cli2")];
      expect(await implCompareMain(args2, REPO, () => Promise.reject(new Error("no browser")))).toBe(1);
      expect(JSON.parse(lines())).toEqual({ status: "stopped", code: "IMPL_CAPTURE_FAILED" });
    } finally {
      spy.mockRestore();
    }
  });
});
