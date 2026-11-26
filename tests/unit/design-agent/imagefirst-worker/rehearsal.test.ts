import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { packBundle, verifyBundleDir } from "@/lib/design-agent/imagefirst-worker/bundle";
import { gitCommitState } from "@/lib/design-agent/imagefirst-worker/cycle";
import { deliverReview } from "@/lib/design-agent/imagefirst-worker/deliver-review";
import { approvedDesignRun, checkDesignApproval, writeDesignReviewPage } from "@/lib/design-agent/imagefirst-worker/design-approval";
import { runImplCompare } from "@/lib/design-agent/imagefirst-worker/impl-compare-approved";
import { approveRehearsal, REHEARSAL_COMMIT, REHEARSAL_FACTS, REHEARSAL_ID, REHEARSAL_SHOP, sealRehearsal } from "@/lib/design-agent/imagefirst-worker/rehearsal";
import { loadRequestRun, validateRequestFile } from "@/lib/design-agent/imagefirst-worker/request";
import { precheckRequestCycle } from "@/lib/design-agent/imagefirst-worker/request-cycle";
import { runLoadedRequest } from "@/lib/design-agent/imagefirst-worker/request-run";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { entryFromInbox } from "@/lib/design-agent/research-log/intake";
import { cleanupTemps, ENV, NOW, REPO, sha, tmp, workerRepo } from "./support";

// DEV-303 (owner goal 2026-11-26): the SYNTHETIC whole_page rehearsal of stages 3 → 6 on disk — seal into a temporary
// review inbox through the existing transport, design-approval-check's draft and page, a fictional approval, the
// materials request's --validate-request and impl-compare-approved — and every place that must refuse it as a real
// result. FICTIONAL data only (the committed fictional cafe pack, pictures drawn by the module). No Codex, no model, no
// image tool, no network (Chromium only for impl-compare-approved, network blocked as in its own test).

vi.setConfig({ testTimeout: 120_000 });
let browser: Browser | null = null;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) }).catch(() => null);
});
afterAll(async () => {
  await browser?.close();
  cleanupTemps();
});

const ID = REHEARSAL_ID;
const T0 = Date.parse("2026-11-26T01:00:00Z");
const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code ?? String(e));

async function sealed() {
  const home = tmp("sr-rehearsal-home-");
  const r = await sealRehearsal({ home, repo: REPO, now: () => T0 });
  return { home, r, inbox: join(home, "sr-runs", "review-inbox"), reviews: join(home, "second-root-shops", REHEARSAL_SHOP, "design-reviews") };
}

describe("DEV-303 rehearsal: a synthetic whole_page bundle through stages 3 → 6", () => {
  it("seal → draft → page → fictional approval → gate → materials --validate-request → impl-compare-approved", async () => {
    const { home, r, inbox, reviews } = await sealed();
    // sealed and delivered through the local transport, marked synthetic, a fictional request run, PC 1 + SP 1
    const v = await verifyBundleDir(join(inbox, ID));
    expect(v.manifest).toMatchObject({ bundle_id: ID, mode: "request", kind: "fictional", shop: REHEARSAL_SHOP, direction: "request", commit: REHEARSAL_COMMIT, synthetic: true, counts: { pc: 1, sp: 1, composites: 0 } });
    expect(r).toMatchObject({ request_id: ID, bundle_sha256: v.bundle_sha256, synthetic: true });
    expect(JSON.parse(readFileSync(join(inbox, ID, "receipt.json"), "utf8"))).toMatchObject({ synthetic: true, design_layout: "whole_page", run_dir: "private_outside_repo" });
    expect(existsSync(join(inbox, "previews", ID, "INDEX.json"))).toBe(true);
    expect(readFileSync(join(home, "second-root-shops", REHEARSAL_SHOP, "facts-pack.json"))).toEqual(readFileSync(join(REPO, REHEARSAL_FACTS)));

    // stage 3: the review draft and the owner's page (it says synthetic)
    const draft = await checkDesignApproval({ bundleDir: join(inbox, ID), reviewPath: r.review, repo: REPO, mode: "draft" });
    expect(draft.run.synthetic).toBe(true);
    const page = await writeDesignReviewPage(draft.review, draft.run, { outDir: join(home, "page"), repo: REPO });
    expect(readFileSync(page.page, "utf8")).toContain("合成（リハーサル）");
    expect(page.page_sha256).toBe(draft.page_sha256);

    // the fictional approval: bound to the page the owner looked at, refused for another page SHA-256
    expect(await codeOf(approveRehearsal({ home, repo: REPO, pageSha256: "f".repeat(64), now: () => T0 + 60_000 }))).toBe("REHEARSAL_PAGE_SHA_MISMATCH");
    const a = await approveRehearsal({ home, repo: REPO, pageSha256: page.page_sha256, now: () => T0 + 60_000 });
    expect(a.approval).toBe(join(reviews, `${ID}.approval.json`));
    const approved = await approvedDesignRun({ bundleDir: join(inbox, ID), reviewPath: r.review, approvalPath: a.approval, repo: REPO });
    expect(approved).toMatchObject({ request_id: ID, kind: "fictional", shop: REHEARSAL_SHOP, synthetic: true, approval_sha256: a.approval_sha256 });

    // stage 4's request: --validate-request checks it against the approved synthetic design and says rehearsal_only
    const m = await validateRequestFile({ file: a.materials_request, home, repo: REPO });
    expect(m).toMatchObject({ request_id: a.materials_request_id, kind: "fictional", stage: "photo_materials", approved_design: { bundle_id: ID, bundle_sha256: v.bundle_sha256, approval_sha256: a.approval_sha256 }, rehearsal_only: true });

    // stage 6: impl-compare-approved against the rehearsal site (advice only), the record marked synthetic
    expect(browser, "Chromium must start for impl-compare-approved").not.toBeNull();
    const c = await runImplCompare({ bundleDir: join(inbox, ID), reviewPath: r.review, approvalPath: a.approval, siteDir: r.site, outDir: join(home, "impl-compare"), repo: REPO, browser, now: () => T0 + 120_000 });
    expect(c.record).toMatchObject({ request_id: ID, synthetic: true, advisory: true, passing: false });
    // nothing was written into the repository
    expect(spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: REPO, encoding: "utf8" }).stdout).not.toMatch(/rehearsal-work|second-root-shops|review-inbox/);
  });

  it("refused as a real result: the worker's materials run and entry, its review delivery, the research log", async () => {
    const { home, r, inbox } = await sealed();
    const page = (await checkDesignApproval({ bundleDir: join(inbox, ID), reviewPath: r.review, repo: REPO, mode: "draft" })).page_sha256;
    const a = await approveRehearsal({ home, repo: REPO, pageSha256: page, now: () => T0 + 60_000 });
    const requestBytes = readFileSync(a.materials_request);

    // the worker's cycle (precheck: every check up to the claim) refuses a materials run from a synthetic design
    const repo = workerRepo(undefined, { [REHEARSAL_FACTS]: readFileSync(join(REPO, REHEARSAL_FACTS)) });
    const privateDir = join(home, "sr-runs", "requests-private", a.materials_request_id);
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const requestFile = join(privateDir, `${a.materials_request_id}.json`);
    writeFileSync(requestFile, requestBytes);
    const opts = { repoRoot: repo, stateDir: join(home, "state"), runsDir: join(home, "sr-runs"), home, requestId: a.materials_request_id, requestSha256: sha(requestBytes), requestFile };
    const pre = await precheckRequestCycle(opts, { commit: () => gitCommitState(repo, ENV), ledger: openLedger(join(home, "ledger")), now: () => NOW });
    expect(pre.report).toMatchObject({ status: "refused", code: "APPROVED_DESIGN_SYNTHETIC", invoked: false });
    // and the entry's stage dispatch, before anything is called
    const loaded = await loadRequestRun({ requestFile, requestSha256: sha(requestBytes), requestId: a.materials_request_id, home, repo: REPO });
    expect(loaded.approvedDesign?.synthetic).toBe(true);
    const never = () => Promise.reject(new Error("never called"));
    const dispatched = await runLoadedRequest({ run: loaded, expected: { promptSha256: loaded.plan.batch.sha256, promptChars: loaded.plan.batch.chars, commit: "a".repeat(40), planSha256: loaded.plan.plan_sha256 }, outDir: join(home, "out"), repoRoot: REPO }, { ledger: openLedger(join(home, "ledger")), commit: never, preflight: never, batch: never });
    expect(dispatched).toEqual({ status: "stopped", code: "APPROVED_DESIGN_SYNTHETIC", stage: "precheck", aborted: false });
    expect(existsSync(join(home, "ledger"))).toBe(false);

    // the worker's review delivery never takes a synthetic receipt
    const runs = join(home, "rehearsal-work", "runs");
    expect(await codeOf(deliverReview({ approvalId: ID, runsDir: runs, stateDir: join(home, "deliver-state"), inboxDir: join(home, "other-inbox") }, { fileAt: async () => null, onOriginDevelop: async () => true }))).toBe("RECEIPT_SYNTHETIC");
    // the research log never takes it
    expect(await codeOf(entryFromInbox({ repo: REPO, inbox, bundleId: ID, shop: REHEARSAL_SHOP, direction: "request", iteration: 0, parentEntryId: null, now: "2026-11-26T02:00:00Z" }))).toBe("SYNTHETIC_NOT_LOGGED");
  });

  it("the marker is sealed: only on a fictional request run, and a manifest without it no longer verifies", async () => {
    const { home, inbox } = await sealed();
    const runs = join(home, "rehearsal-work", "runs");
    const receiptName = readdirSync(runs).find((n) => n.endsWith(".receipt.json"))!;
    const receipt = JSON.parse(readFileSync(join(runs, receiptName), "utf8")) as Record<string, unknown>;
    for (const over of [{ kind: "real_shop" }, { synthetic: "yes" }, { synthetic: false }]) {
      const path = join(runs, `${receiptName}.${Object.values(over).join("")}.json`);
      writeFileSync(path, JSON.stringify({ ...receipt, ...over }), { mode: 0o600 });
      expect(await codeOf(packBundle({ runDir: receipt.run_dir as string, receiptPath: path, bundlesDir: join(home, "bundles-2") })), JSON.stringify(over)).toBe("RECEIPT_INVALID");
    }
    const copy = join(tmp("sr-rehearsal-copy-"), ID);
    cpSync(join(inbox, ID), copy, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8")) as Record<string, unknown>;
    delete manifest.synthetic;
    writeFileSync(join(copy, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    expect(await codeOf(verifyBundleDir(copy))).toBe("BUNDLE_RECEIPT_MISMATCH");
  });

  it("the rehearsal home: never the real home, never in the repository, empty for a seal", async () => {
    expect(await codeOf(sealRehearsal({ home: homedir(), repo: REPO }))).toBe("REHEARSAL_HOME_IS_REAL_HOME");
    expect(await codeOf(sealRehearsal({ home: join(REPO, "lib"), repo: REPO }))).toBe("REHEARSAL_HOME_IN_REPO");
    expect(await codeOf(sealRehearsal({ home: "relative/home", repo: REPO }))).toBe("REHEARSAL_HOME_INVALID");
    const used = tmp("sr-rehearsal-used-");
    writeFileSync(join(used, "x"), "x");
    expect(await codeOf(sealRehearsal({ home: used, repo: REPO }))).toBe("REHEARSAL_HOME_NOT_EMPTY");
    expect(await codeOf(sealRehearsal({ home: tmp("sr-rehearsal-id-"), repo: REPO, id: "req-test-shop-a-1" }))).toBe("REHEARSAL_ID_INVALID");
  });

  it("the CLIs: --seal, then --validate-request of the materials request with HOME = the rehearsal home", async () => {
    const home = tmp("sr-rehearsal-cli-");
    const run = (file: string, args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", file, ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", ...env } as unknown as NodeJS.ProcessEnv, timeout: 90_000 });
    const CLI = join(REPO, "scripts/design-artifact/imagefirst-rehearsal.ts");
    expect([run(CLI, ["--seal"]).status, run(CLI, ["--approve", "--home", home]).status]).toEqual([2, 2]);
    const s = run(CLI, ["--seal", "--home", home]);
    expect(s.status).toBe(0);
    expect(JSON.parse(s.stdout)).toMatchObject({ status: "sealed", request_id: ID, synthetic: true });
    const p = run(join(REPO, "scripts/design-artifact/design-approval-check.ts"), ["--page", "--bundle", join(home, "sr-runs/review-inbox", ID), "--review", join(home, "second-root-shops", REHEARSAL_SHOP, "design-reviews", `${ID}.review.json`), "--out", join(home, "page")]);
    expect(p.status).toBe(0);
    const pageOut = JSON.parse(p.stdout) as { page_sha256: string; synthetic?: boolean };
    expect(pageOut.synthetic).toBe(true);
    const ap = run(CLI, ["--approve", "--home", home, "--page-sha256", pageOut.page_sha256]);
    expect(ap.status).toBe(0);
    const approved = JSON.parse(ap.stdout) as { materials_request: string };
    const val = run(join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/worker-cli-entry.ts"), ["0::/\n", "--validate-request", approved.materials_request], { HOME: home });
    expect(val.status).toBe(0);
    expect(JSON.parse(val.stdout.trim())).toMatchObject({ status: "valid", stage: "photo_materials", rehearsal_only: true });
  });
});
