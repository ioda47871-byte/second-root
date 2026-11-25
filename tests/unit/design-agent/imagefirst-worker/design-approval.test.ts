import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { packBundle } from "@/lib/design-agent/imagefirst-worker/bundle";
import { approvedDesignRun, checkDesignApproval, DESIGN_AXES, designReviewPageSha256, parseDesignReview, readDeliveredRun, renderDesignReviewPage, writeDesignReviewPage } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { VIEWING_PAGE_CSP } from "@/lib/design-agent/case-study/case-study";
import { designApprovalMain } from "@/scripts/design-artifact/design-approval-check";
import { colourPng } from "../phase2f/fixtures";

// DEV-303 §6.1 change 5 (docs/design/image-first-production-flow.md §1 stage 3, §3.3): the design review of a delivered
// design run and the owner's approval. FICTIONAL data only (an invented request id and shop, synthetic pictures). No
// Codex, no model, no network.

vi.setConfig({ testTimeout: 60_000 });
const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
const tmp = (p = "sr-da-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  chmodSync(d, 0o700);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const RID = "req-test-shop-r-1";

/** A sealed whole_page bundle (PC 1 + SP 1) as the review inbox holds it. */
async function sealedRun() {
  const runs = tmp("sr-da-runs-");
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
    shop: "test-shop-r", direction: "request", approval_id: RID, plan_id: RID, commit: "c".repeat(40), packet_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), prompt_sha256: "d".repeat(64), prompt_chars: 5000,
    run_dir: runDir, images, stopped_images: [], counts: { pc: 1, sp: 1, total: 2, stopped: 0 }, verified: true,
    timings: { started_at: "2026-11-25T01:00:00.000Z", finished_at: "2026-11-25T01:10:00.000Z", elapsed_ms: 600_000 },
    mode: "request", kind: "fictional", request_id: RID, request_sha256: "a".repeat(64), facts_sha256: "e".repeat(64), images_total: 2,
    design_layout: "whole_page", reference_images: refs,
  };
  const receiptPath = join(runs, `${RID}-20261125T010000Z.receipt.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(tmp("sr-da-bundles-"), "bundles"), now: () => Date.parse("2026-11-25T02:00:00Z") });
  return { dir: sealed.dir, bundleSha: sealed.bundle_sha256, images: { pc: [{ file: images[0]!.file, sha256: images[0]!.sha256 }], sp: [{ file: images[1]!.file, sha256: images[1]!.sha256 }] } };
}

type Run = Awaited<ReturnType<typeof sealedRun>>;
const axis = (verdict: "pass" | "revise" | "fail" = "pass") => ({ verdict, evidence: [{ image: "pc", region: "最初の画面", note: "試験用の根拠（架空）" }, { image: "sp", region: "最後の区画", note: '試験用の根拠 & "引用"' }] });
const reviewObj = (run: Run, over: Record<string, unknown> = {}) => ({
  schema: "sr_design_review_v1",
  request_id: RID,
  bundle_sha256: run.bundleSha,
  images: run.images,
  axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, axis()])),
  reviewer: "independent-subagent",
  reviewed_at: "2026-11-25T03:00:00Z",
  ...over,
});
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
/** The private place of the records (outside the repository). */
function records(run: Run, review: unknown, approval?: (reviewSha: string, pageSha: string) => unknown) {
  const d = tmp("sr-da-rec-");
  const reviewBytes = bytesOf(review);
  writeFileSync(join(d, "review.json"), reviewBytes);
  let approvalPath: string | undefined;
  if (approval) {
    const parsed = parseDesignReview(reviewBytes);
    approvalPath = join(d, "approval.json");
    return readDeliveredRun(run.dir).then((dr) => {
      writeFileSync(approvalPath!, bytesOf(approval(sha(reviewBytes), designReviewPageSha256(parsed, dr))));
      return { reviewPath: join(d, "review.json"), approvalPath, reviewBytes };
    });
  }
  return Promise.resolve({ reviewPath: join(d, "review.json"), approvalPath, reviewBytes });
}
const approvalObj = (run: Run, reviewSha: string, pageSha: string, over: Record<string, unknown> = {}) => ({
  schema: "sr_design_approval_v1",
  request_id: RID,
  bundle_sha256: run.bundleSha,
  approved_images: run.images,
  review_sha256: reviewSha,
  page_sha256: pageSha,
  decision: "approve",
  decided_at: "2026-11-25T04:00:00Z",
  ...over,
});
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

describe("sr_design_review_v1: the five axes of §3.3, each with evidence, on the delivered run's images", () => {
  it("a complete review passes in draft mode and names the verdicts, the review's and the page's SHA-256", async () => {
    const run = await sealedRun();
    const r = await records(run, reviewObj(run));
    const c = await checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, repo: REPO, mode: "draft" });
    expect(c).toMatchObject({ request_id: RID, bundle_sha256: run.bundleSha, review_sha256: sha(r.reviewBytes), approval: null });
    expect(Object.keys(c.verdicts)).toEqual([...DESIGN_AXES]);
  });

  it("schema, a missing axis, an axis without evidence, unsafe text, another run or other images: fixed codes", async () => {
    const run = await sealedRun();
    const check = async (o: unknown) => codeOf(records(run, o).then((r) => checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, repo: REPO, mode: "draft" })));
    const axes = Object.fromEntries(DESIGN_AXES.map((a) => [a, axis()]));
    expect(await check({ ...reviewObj(run), extra: 1 })).toBe("DESIGN_REVIEW_INVALID");
    const four = Object.fromEntries(Object.entries(axes).filter(([k]) => k !== "japanese"));
    expect(await check(reviewObj(run, { axes: four }))).toBe("DESIGN_REVIEW_AXIS_MISSING");
    expect(await check(reviewObj(run, { axes: { ...axes, beauty: axis() } }))).toBe("DESIGN_REVIEW_INVALID");
    expect(await check(reviewObj(run, { axes: { ...axes, originality: { verdict: "pass", evidence: [] } } }))).toBe("DESIGN_REVIEW_EVIDENCE_MISSING");
    expect(await check(reviewObj(run, { axes: { ...axes, japanese: { verdict: "ok", evidence: axis().evidence } } }))).toBe("DESIGN_REVIEW_INVALID");
    expect(await check(reviewObj(run, { axes: { ...axes, japanese: { verdict: "pass", evidence: [{ image: "pc", region: "見出し", note: "改行\nあり" }] } } }))).toBe("DESIGN_REVIEW_TEXT_UNSAFE");
    expect(await check(reviewObj(run, { reviewer: "<script>" }))).toBe("DESIGN_REVIEW_TEXT_UNSAFE");
    expect(await check(reviewObj(run, { request_id: "req-test-shop-r-2" }))).toBe("DESIGN_RUN_MISMATCH");
    expect(await check(reviewObj(run, { bundle_sha256: sha("other") }))).toBe("DESIGN_RUN_MISMATCH");
    expect(await check(reviewObj(run, { images: { ...run.images, sp: [{ ...run.images.sp[0]!, sha256: sha("other") }] } }))).toBe("DESIGN_IMAGES_MISMATCH");
    expect(await check(reviewObj(run, { images: { ...run.images, pc: [...run.images.pc, { file: "parts/pc-2.png", sha256: sha("x") }] } }))).toBe("DESIGN_IMAGES_MISMATCH");
  });

  it("records inside the repository, links and oversize files are refused; a tampered bundle is DESIGN_BUNDLE_INVALID", async () => {
    const run = await sealedRun();
    expect(await codeOf(checkDesignApproval({ bundleDir: run.dir, reviewPath: resolve(REPO, "package.json"), repo: REPO, mode: "draft" }))).toBe("DESIGN_RECORD_IN_REPO");
    const r = await records(run, reviewObj(run));
    const link = join(tmp(), "review.json");
    symlinkSync(r.reviewPath, link);
    expect(await codeOf(checkDesignApproval({ bundleDir: run.dir, reviewPath: link, repo: REPO, mode: "draft" }))).toBe("DESIGN_RECORD_UNSAFE");
    const big = join(tmp(), "big.json");
    writeFileSync(big, Buffer.alloc(64 * 1024 + 1, 0x20));
    expect(await codeOf(checkDesignApproval({ bundleDir: run.dir, reviewPath: big, repo: REPO, mode: "draft" }))).toBe("DESIGN_RECORD_TOO_LARGE");
    expect(await codeOf(checkDesignApproval({ bundleDir: run.dir, reviewPath: join(tmp(), "absent.json"), repo: REPO, mode: "draft" }))).toBe("DESIGN_RECORD_MISSING");
    // a picture of the sealed bundle replaced: the bundle no longer verifies
    const pc = join(run.dir, "parts", "pc-1.png");
    rmSync(pc);
    writeFileSync(pc, colourPng(600, 600), { mode: 0o600 });
    expect(await codeOf(checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, repo: REPO, mode: "draft" }))).toBe("DESIGN_BUNDLE_INVALID");
  });
});

describe("sr_design_approval_v1: bound to the review, the page and the images; approve, and no axis fail", () => {
  it("gate passes for an approval of exactly this review and page; approvedDesignRun hands the images on", async () => {
    const run = await sealedRun();
    const r = await records(run, reviewObj(run), (rs, ps) => approvalObj(run, rs, ps));
    const c = await checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, approvalPath: r.approvalPath!, repo: REPO, mode: "gate" });
    expect(c.approval).toEqual({ sha256: sha(readFileSync(r.approvalPath!)), decision: "approve" });
    const a = await approvedDesignRun({ bundleDir: run.dir, reviewPath: r.reviewPath, approvalPath: r.approvalPath!, repo: REPO });
    expect(a).toMatchObject({ request_id: RID, bundle_sha256: run.bundleSha, review_sha256: sha(r.reviewBytes), approval_sha256: c.approval!.sha256, page_sha256: c.page_sha256 });
    expect(a.images.pc.map((i) => [i.file, i.sha256, sha(i.bytes)])).toEqual([[run.images.pc[0]!.file, run.images.pc[0]!.sha256, run.images.pc[0]!.sha256]]);
    expect(a.images.sp.map((i) => i.sha256)).toEqual([run.images.sp[0]!.sha256]);
  });

  it("no approval, another review SHA, another page SHA, other images, revise / reject, or any axis fail: refused", async () => {
    const run = await sealedRun();
    const gate = async (review: unknown, approval?: (rs: string, ps: string) => unknown) => codeOf(records(run, review, approval).then((r) => checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, ...(r.approvalPath ? { approvalPath: r.approvalPath } : {}), repo: REPO, mode: "gate" })));
    expect(await gate(reviewObj(run))).toBe("DESIGN_APPROVAL_MISSING");
    expect(await gate(reviewObj(run), (_rs, ps) => approvalObj(run, sha("another review"), ps))).toBe("DESIGN_APPROVAL_REVIEW_MISMATCH");
    expect(await gate(reviewObj(run), (rs) => approvalObj(run, rs, sha("another page")))).toBe("DESIGN_APPROVAL_PAGE_MISMATCH");
    expect(await gate(reviewObj(run), (rs, ps) => approvalObj(run, rs, ps, { approved_images: { ...run.images, pc: [{ ...run.images.pc[0]!, sha256: sha("x") }] } }))).toBe("DESIGN_APPROVAL_IMAGES_MISMATCH");
    expect(await gate(reviewObj(run), (rs, ps) => approvalObj(run, rs, ps, { bundle_sha256: sha("x") }))).toBe("DESIGN_RUN_MISMATCH");
    expect(await gate(reviewObj(run), (rs, ps) => approvalObj(run, rs, ps, { decision: "revise" }))).toBe("DESIGN_NOT_APPROVED");
    expect(await gate(reviewObj(run), (rs, ps) => approvalObj(run, rs, ps, { decision: "reject" }))).toBe("DESIGN_NOT_APPROVED");
    expect(await gate(reviewObj(run), (rs, ps) => ({ ...approvalObj(run, rs, ps), signature: "owner" }))).toBe("DESIGN_APPROVAL_INVALID");
    // a fail on any axis blocks the approval (the owner asks for a new review or design instead)
    for (const a of DESIGN_AXES) {
      const failing = reviewObj(run, { axes: Object.fromEntries(DESIGN_AXES.map((x) => [x, axis(x === a ? "fail" : "pass")])) });
      expect(await gate(failing, (rs, ps) => approvalObj(run, rs, ps)), a).toBe("DESIGN_REVIEW_HAS_FAIL");
    }
    // revise verdicts are advice: the owner may still approve
    expect(await gate(reviewObj(run, { axes: Object.fromEntries(DESIGN_AXES.map((x) => [x, axis("revise")])) }), (rs, ps) => approvalObj(run, rs, ps))).toBe("ok");
    // the review edited after the approval: the binding breaks
    const r = await records(run, reviewObj(run), (rs, ps) => approvalObj(run, rs, ps));
    writeFileSync(r.reviewPath, bytesOf(reviewObj(run, { reviewer: "independent-subagent-2" })));
    expect(await codeOf(checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, approvalPath: r.approvalPath!, repo: REPO, mode: "gate" }))).toBe("DESIGN_APPROVAL_REVIEW_MISMATCH");
  });
});

describe("the owner's viewing page: static, escaped, no script, its SHA-256 the one the approval binds", () => {
  it("CSP, no script / event handler / external reference, every text escaped, images copied, deterministic", async () => {
    const run = await sealedRun();
    const review = parseDesignReview(bytesOf(reviewObj(run)));
    const dr = await readDeliveredRun(run.dir);
    const html = renderDesignReviewPage(review, dr);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${VIEWING_PAGE_CSP}">`);
    expect(html).not.toMatch(/<script|\son[a-z]+=|https?:\/\/|@import|url\(/i);
    expect(html).toContain("試験用の根拠 &amp; &quot;引用&quot;");
    expect(html).not.toContain('試験用の根拠 & "引用"');
    for (const label of ["独自性", "店舗固有性", "情報設計", "日本語", "PC/SP の完成度"]) expect(html).toContain(label);
    expect(html).toContain("オーナー本人の署名ではない");
    const out = join(tmp(), "page");
    const w = await writeDesignReviewPage(review, dr, { outDir: out, repo: REPO });
    expect(w.page_sha256).toBe(designReviewPageSha256(review, dr));
    expect(readdirSync(join(out, "images")).sort()).toEqual(["pc-1.png", "sp-1.png"]);
    expect(sha(readFileSync(join(out, "images", "pc-1.png")))).toBe(run.images.pc[0]!.sha256);
    expect(statSync(join(out, "index.html")).mode & 0o777).toBe(0o600);
    // never inside the repository; never into a non-empty directory
    expect(await codeOf(writeDesignReviewPage(review, dr, { outDir: join(REPO, "tmp-design-review-page"), repo: REPO }))).toBe("DESIGN_PAGE_IN_REPO");
    expect(existsSync(join(REPO, "tmp-design-review-page"))).toBe(false);
    expect(await codeOf(writeDesignReviewPage(review, dr, { outDir: out, repo: REPO }))).toBe("DESIGN_PAGE_DIR_NOT_EMPTY");
  });
});

describe("the CLI (offline)", () => {
  const run1 = async (argv: string[]) => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    try {
      const code = await designApprovalMain(argv);
      return { code, out: JSON.parse(out.join("")) as Record<string, unknown> };
    } finally {
      spy.mockRestore();
    }
  };
  it("--page prints page_sha256 and review_sha256; --check gate passes once the approval binds them; bad args refused", async () => {
    const run = await sealedRun();
    const r = await records(run, reviewObj(run));
    const out = join(tmp(), "page");
    const p = await run1(["--page", "--bundle", run.dir, "--review", r.reviewPath, "--out", out]);
    expect(p).toMatchObject({ code: 0, out: { status: "page_written", review_sha256: sha(r.reviewBytes) } });
    const approvalPath = join(tmp(), "approval.json");
    writeFileSync(approvalPath, bytesOf(approvalObj(run, p.out.review_sha256 as string, p.out.page_sha256 as string)));
    expect(sha(readFileSync(join(out, "index.html")))).toBe(p.out.page_sha256);
    expect(await run1(["--check", "--bundle", run.dir, "--review", r.reviewPath, "--approval", approvalPath])).toMatchObject({ code: 0, out: { status: "passed", mode: "gate", approval: { decision: "approve" } } });
    expect(await run1(["--check", "--bundle", run.dir, "--review", r.reviewPath])).toMatchObject({ code: 1, out: { status: "stopped", code: "DESIGN_APPROVAL_MISSING" } });
    expect(await run1(["--check", "--bundle", run.dir, "--review", r.reviewPath, "--draft"])).toMatchObject({ code: 0, out: { status: "passed", mode: "draft", approval: null } });
    expect((await run1(["--check", "--page", "--bundle", run.dir, "--review", r.reviewPath])).out).toEqual({ status: "refused", code: "ARGS_INVALID" });
    expect((await run1(["--page", "--bundle", run.dir, "--review", r.reviewPath])).code).toBe(2);
  });
});

describe("review Lows (PR #345): the bundle after approval, the decision time, the page directory", () => {
  it("L7: a bundle changed after the approval stops the gate and approvedDesignRun (DESIGN_BUNDLE_INVALID)", async () => {
    const run = await sealedRun();
    const r = await records(run, reviewObj(run), (rs, ps) => approvalObj(run, rs, ps));
    expect((await checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, approvalPath: r.approvalPath!, repo: REPO, mode: "gate" })).approval?.decision).toBe("approve");
    const sp = join(run.dir, "parts", "sp-1.png");
    rmSync(sp);
    writeFileSync(sp, colourPng(700, 700), { mode: 0o600 });
    expect(await codeOf(checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, approvalPath: r.approvalPath!, repo: REPO, mode: "gate" }))).toBe("DESIGN_BUNDLE_INVALID");
    expect(await codeOf(approvedDesignRun({ bundleDir: run.dir, reviewPath: r.reviewPath, approvalPath: r.approvalPath!, repo: REPO }))).toBe("DESIGN_BUNDLE_INVALID");
  });

  it("L5: an approval decided before the review is refused (DESIGN_APPROVAL_BEFORE_REVIEW); the same instant is fine", async () => {
    const run = await sealedRun();
    const at = async (decided_at: string) => codeOf(records(run, reviewObj(run), (rs, ps) => approvalObj(run, rs, ps, { decided_at })).then((r) => checkDesignApproval({ bundleDir: run.dir, reviewPath: r.reviewPath, approvalPath: r.approvalPath!, repo: REPO, mode: "gate" })));
    expect(await at("2026-11-25T02:59:59Z")).toBe("DESIGN_APPROVAL_BEFORE_REVIEW");
    expect(await at("2026-11-25T03:00:00Z")).toBe("ok");
  });

  it("L2 / L7: an existing empty page directory must be private (0700) and ours; a fresh one is created 0700", async () => {
    const run = await sealedRun();
    const review = parseDesignReview(bytesOf(reviewObj(run)));
    const dr = await readDeliveredRun(run.dir);
    const open = join(tmp(), "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(await codeOf(writeDesignReviewPage(review, dr, { outDir: open, repo: REPO }))).toBe("DESIGN_PAGE_DIR_UNSAFE");
    expect(readdirSync(open)).toEqual([]);
    const priv = join(tmp(), "private");
    mkdirSync(priv, { mode: 0o700 });
    expect(await codeOf(writeDesignReviewPage(review, dr, { outDir: priv, repo: REPO }))).toBe("ok");
    const fresh = join(tmp(), "fresh");
    await writeDesignReviewPage(review, dr, { outDir: fresh, repo: REPO });
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(statSync(join(fresh, "images")).isDirectory()).toBe(true);
    // a link in place of the directory is refused
    const link = join(tmp(), "link");
    symlinkSync(priv, link);
    expect(await codeOf(writeDesignReviewPage(review, dr, { outDir: link, repo: REPO }))).toBe("DESIGN_PAGE_DIR_NOT_EMPTY");
  });

  it("L1: --page renders the page from the same review bytes whose SHA-256 it prints", async () => {
    const run = await sealedRun();
    const r = await records(run, reviewObj(run));
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((x) => (out.push(String(x)), true));
    try {
      expect(await designApprovalMain(["--page", "--bundle", run.dir, "--review", r.reviewPath, "--out", join(tmp(), "page")])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const printed = JSON.parse(out.join("")) as { review_sha256: string; page_sha256: string; page: string };
    expect(printed.review_sha256).toBe(sha(r.reviewBytes));
    expect(printed.page_sha256).toBe(designReviewPageSha256(parseDesignReview(r.reviewBytes), await readDeliveredRun(run.dir)));
    expect(sha(readFileSync(printed.page))).toBe(printed.page_sha256);
  });
});
