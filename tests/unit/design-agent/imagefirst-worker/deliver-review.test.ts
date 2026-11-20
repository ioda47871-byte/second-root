import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { verifyBundleDir } from "@/lib/design-agent/imagefirst-worker/bundle";
import { gitCommitState, IMAGEFIRST_ALLOWLIST, runImagefirstCycle, type CycleReport, type WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { deliverAfterRun, deliverReview, ReviewStop, type DeliverReviewOptions } from "@/lib/design-agent/imagefirst-worker/deliver-review";
import { verifyPreviews } from "@/lib/design-agent/imagefirst-worker/preview";
import { DUMMY_ID } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { APPROVAL_PACKET_PATH } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { acquireLock } from "@/lib/design-agent/worker/state";
import { fileAtCommit } from "@/scripts/design-artifact/phase2f-live-cli";
import { UNAPPROVED_PACKET_FIXTURE } from "../image-first/fixtures/unapproved-packet";
import { jailIdle } from "@/lib/design-agent/imagefirst-worker/jail-state";
import { cleanupTemps, commitFiles, ENV, entryInProcess, fakeCodex, filledPacket, git, ID, NOW, PLAN_ID, pointOrigin, REPO, sha, tmp, workerRepo } from "./support";

// Issue #302 P3 follow-up: a REAL finished run (the worker's cycle over a temporary clone, the entry played in-process
// against the FAKE Codex) → deliverReview / deliverAfterRun → private bundle → the real local inbox → previews + INDEX.
// Temporary directories only. No Codex, no model, no image tool, no network, no systemd.

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanupTemps);

const codeOf = async (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof ReviewStop ? e.code : `THREW ${String(e)}`));
function tree(dir: string, out: string[] = [], base = dir): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    out.push(p.slice(base.length + 1));
    if (lstatSync(p).isDirectory()) tree(p, out, base);
  }
  return out;
}

/** Every file under dir with the SHA-256 of its content (PR #310 review L4: an append is a change too). */
const hashes = (dir: string) => tree(dir).map((rel) => (lstatSync(join(dir, rel)).isFile() ? `${rel} ${sha(readFileSync(join(dir, rel)))}` : rel));

/**
 * One finished, successful worker run (claim + ledger used ONCE by the cycle itself), and what delivering needs. With
 * `linkedHome` the worker's home is reached through a symlink (the receipt then names the run by that path).
 */
async function finishedRun(mode: "six" | "fail" = "six", o: { linkedHome?: boolean } = {}) {
  const realHome = tmp("sr-dr-home-");
  chmodSync(realHome, 0o700);
  let home = realHome;
  if (o.linkedHome) {
    home = join(tmp("sr-dr-link-"), "home");
    symlinkSync(realHome, home);
  }
  const repo = workerRepo();
  const runsDir = join(home, "sr-runs");
  mkdirSync(runsDir, { mode: 0o700 });
  const stateDir = join(home, "state");
  const ledgerDir = join(home, "ledger");
  const fake = fakeCodex(mode);
  const invoked: string[][] = [];
  const report = await runImagefirstCycle(
    { repoRoot: repo, stateDir, runsDir },
    {
      commit: () => gitCommitState(repo, ENV),
      fileAt: (c, rel) => fileAtCommit(c, rel, repo),
      ledger: openLedger(ledgerDir),
      now: () => NOW,
      invoke: async (argv, signal) => {
        invoked.push(argv);
        return entryInProcess(argv, { repo, ledgerDir, fake, ...(signal ? { signal } : {}) });
      },
    },
  );
  const deps = {
    fileAt: (c: string, rel: string) => fileAtCommit(c, rel, repo),
    onOriginDevelop: async (c: string) => spawnSync("git", ["merge-base", "--is-ancestor", c, "origin/develop"], { cwd: repo }).status === 0,
  };
  const opts: DeliverReviewOptions = { approvalId: ID, runsDir, stateDir, now: () => NOW };
  /** Everything the run may use exactly once: claims, the entry's ledger, Codex executions, invocations. */
  const used = () => ({ claims: hashes(join(stateDir, "claims")), ledger: hashes(ledgerDir), execs: fake.execs, invoked: invoked.length });
  const receipt = report.receipt ?? "";
  const readReceipt = () => JSON.parse(readFileSync(receipt, "utf8")) as WorkerReceipt;
  const writeReceipt = (r: unknown) => writeFileSync(receipt, typeof r === "string" ? r : `${JSON.stringify(r, null, 2)}\n`);
  return { home, repo, runsDir, stateDir, ledgerDir, fake, report, deps, opts, used, receipt, readReceipt, writeReceipt, inbox: join(runsDir, "review-inbox"), bundles: join(runsDir, "bundles") };
}
type Run = Awaited<ReturnType<typeof finishedRun>>;
/** Nothing sealed and nothing in the inbox. */
const nothingDelivered = (w: Run) => {
  expect(existsSync(w.bundles) ? readdirSync(w.bundles) : []).toEqual([]);
  expect(existsSync(w.inbox) ? readdirSync(w.inbox) : []).toEqual([]);
};

describe("a real finished run reaches the local review inbox (fake Codex, real inbox and previews)", () => {
  it("success: one bundle, six part previews + INDEX whose source SHAs are the bundle's and the receipt's; no claim, ledger entry or Codex run used", async () => {
    const w = await finishedRun();
    expect(w.report).toMatchObject({ status: "succeeded", invoked: true, approval_id: ID });
    const before = w.used();
    expect(before.execs).toBe(1);
    const summary = await deliverAfterRun(w.report, { runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, w.deps);
    expect(summary).toMatchObject({ status: "delivered", code: null });
    // the hand-off used nothing: same claims, same ledger, no Codex run, no invocation
    expect(w.used()).toEqual(before);
    expect(git(w.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");

    const bundleDir = join(w.inbox, ID);
    const v = await verifyBundleDir(bundleDir, { expected: { approval_id: ID, plan_id: PLAN_ID, commit: w.readReceipt().commit, bundle_sha256: summary!.bundle_sha256 } });
    expect(v.manifest.counts).toEqual({ pc: 2, sp: 4, composites: 0, files: 7 });
    expect(sha(readFileSync(join(bundleDir, "manifest.json")))).toBe(summary!.bundle_sha256);
    const ix = await verifyPreviews(join(w.inbox, "previews", ID), { bundle_sha256: summary!.bundle_sha256 });
    const sums = new Map(readFileSync(join(bundleDir, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => [l.slice(66), l.slice(0, 64)] as const));
    const receiptShas = new Map(w.readReceipt().images.map((i) => [i.file, i.sha256] as const));
    const parts = ix.previews.filter((p) => p.source.startsWith("parts/"));
    expect([...new Set(parts.map((p) => p.source))].sort()).toEqual(["parts/pc-1.png", "parts/pc-2.png", "parts/sp-1.png", "parts/sp-2.png", "parts/sp-3.png", "parts/sp-4.png"]);
    for (const p of ix.previews) {
      expect(p.source_sha256).toBe(sums.get(p.source));
      expect(p.source_sha256).toBe(receiptShas.get(p.source));
    }
    expect(readFileSync(join(w.inbox, "previews", ID, "INDEX.md"), "utf8")).toContain(summary!.bundle_sha256);
    // private: directories 0700, files 0600, inside ~/sr-runs only
    for (const rel of tree(w.runsDir)) {
      const st = lstatSync(join(w.runsDir, rel));
      expect(st.isSymbolicLink(), rel).toBe(false);
      expect(st.mode & 0o077, rel).toBe(0);
    }

    // again (manual re-send, jail stopped): idempotent, nothing re-packed or re-sent, previews unchanged
    const indexBefore = readFileSync(join(w.inbox, "previews", ID, "INDEX.json"));
    const again = await deliverReview({ ...w.opts, resend: true, jailIdle: async () => true }, w.deps);
    expect(again).toMatchObject({ status: "duplicate", bundle: "existing", sent: false, previews: "duplicate", bundle_sha256: summary!.bundle_sha256 });
    expect(readFileSync(join(w.inbox, "previews", ID, "INDEX.json")).equals(indexBefore)).toBe(true);
    // a lost delivery job: the same sealed bytes go again and the inbox answers duplicate
    rmSync(join(w.stateDir, "deliveries"), { recursive: true });
    expect(await deliverReview(w.opts, w.deps)).toMatchObject({ status: "duplicate", sent: true, bundle_sha256: summary!.bundle_sha256 });
    expect(w.used()).toEqual(before);
  });

  it("only a succeeded report is delivered automatically; a stopped run's receipt is refused by hand too", async () => {
    const w = await finishedRun("fail");
    expect(w.report.status).toBe("stopped");
    expect(await deliverAfterRun(w.report, { runsDir: w.runsDir, stateDir: w.stateDir }, w.deps)).toBeNull();
    for (const status of ["no_job", "locked", "refused", "would_run"] as const) expect(await deliverAfterRun({ status, code: null, invoked: false } as CycleReport, { runsDir: w.runsDir, stateDir: w.stateDir }, w.deps)).toBeNull();
    nothingDelivered(w);
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("RECEIPT_NOT_SUCCEEDED");
    nothingDelivered(w);
  });
});

describe("refusals before anything is sealed (nothing in the inbox, nothing used)", () => {
  it("a receipt that does not match the approval packet at its commit: expiry window, approval, plan, prompt, packet, commit", async () => {
    const w = await finishedRun();
    const before = w.used();
    const good = readFileSync(w.receipt, "utf8");
    const r = w.readReceipt();
    // another commit, put on origin/develop (so only the packet check can refuse it)
    const other = (packet: Buffer) => {
      const c = commitFiles(w.repo, { [APPROVAL_PACKET_PATH]: packet }, "another packet");
      pointOrigin(w.repo);
      return c;
    };
    // a local commit object (same approved tree) that nothing on origin/develop descends from
    const offOrigin = git(w.repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "a local commit, not on origin/develop");
    const cases: [string, unknown][] = [
      // the run started after the approval expired / further than 24 h before it
      ["RUN_NOT_IN_APPROVAL_WINDOW", { ...r, timings: { ...r.timings, started_at: "2026-11-20T09:00:01.000Z", finished_at: "2026-11-20T09:00:02.000Z" } }],
      ["RUN_NOT_IN_APPROVAL_WINDOW", { ...r, timings: { ...r.timings, started_at: "2026-11-19T08:59:59.000Z" } }],
      ["PLAN_MISMATCH", { ...r, plan_id: "hoshigama-imagefirst-p3-20261121" }],
      ["RECEIPT_ALLOWLIST_MISMATCH", { ...r, prompt_sha256: "0".repeat(64) }],
      ["RECEIPT_ALLOWLIST_MISMATCH", { ...r, plan_sha256: "0".repeat(64) }],
      ["PACKET_MISMATCH", { ...r, packet_sha256: "0".repeat(64) }],
      // the commit names another approval, an unapproved packet, or nothing at all
      ["APPROVAL_MISMATCH", { ...r, commit: other(filledPacket({ d3: "`hoshigama-imagefirst-d3-20261120-02`" })) }],
      ["PACKET_NOT_APPROVED", { ...r, commit: other(readFileSync(UNAPPROVED_PACKET_FIXTURE)) }],
      ["APPROVAL_ID_RESERVED", { ...r, commit: other(filledPacket({ d3: `\`${DUMMY_ID}\`` })) }],
      // PR #310 review M2: a commit that is not on origin/develop (a local commit, or none at all) is refused first
      ["COMMIT_NOT_ON_ORIGIN_DEVELOP", { ...r, commit: offOrigin }],
      ["COMMIT_NOT_ON_ORIGIN_DEVELOP", { ...r, commit: "1".repeat(40) }],
      ["RECEIPT_INVALID", { ...r, approval_id: "hoshigama-imagefirst-d3-20261120-02" }],
      ["RECEIPT_NOT_SUCCEEDED", { ...r, interrupted: true }],
      ["RECEIPT_NOT_SUCCEEDED", { ...r, counts: { ...r.counts, sp: 3 } }],
      ["RECEIPT_INVALID", "{"],
      ["RECEIPT_INVALID", { ...r, timings: { ...r.timings, finished_at: "2026-11-20T00:00:00.000Z" } }],
    ];
    for (const [code, receipt] of cases) {
      w.writeReceipt(receipt);
      expect(await codeOf(deliverReview(w.opts, w.deps)), code).toBe(code);
      nothingDelivered(w);
    }
    writeFileSync(w.receipt, good);
    expect(w.used()).toEqual(before);
    expect((await deliverReview(w.opts, w.deps)).status).toBe("delivered");
  });

  it("PR #310 review M2: the worker's claim marker must exist and agree with the receipt (read only, never made here)", async () => {
    const w = await finishedRun();
    const claim = join(w.stateDir, "claims", `${ID}.used`);
    const good = readFileSync(claim);
    renameSync(claim, `${claim}.away`);
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("CLAIM_MISSING");
    expect(existsSync(claim)).toBe(false);
    renameSync(`${claim}.away`, claim);
    for (const body of [{ approval_id: "hoshigama-imagefirst-d3-20261120-02", claimed_at: new Date(NOW).toISOString() }, { approval_id: ID, claimed_at: "2026-11-19T00:00:00.000Z" }, { approval_id: ID }]) {
      writeFileSync(claim, JSON.stringify(body));
      expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("CLAIM_MISMATCH");
    }
    writeFileSync(claim, good);
    renameSync(claim, `${claim}.real`);
    symlinkSync(`${claim}.real`, claim);
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("CLAIM_MISMATCH");
    rmSync(claim);
    renameSync(`${claim}.real`, claim);
    nothingDelivered(w);
    const before = readFileSync(claim);
    expect((await deliverReview(w.opts, w.deps)).status).toBe("delivered");
    expect(readFileSync(claim).equals(before)).toBe(true);
  });

  it("PR #310 review L1: a home reached through a symlink delivers (real paths compared), from the report or by hand", async () => {
    const w = await finishedRun("six", { linkedHome: true });
    expect(w.report.receipt!.startsWith(w.home)).toBe(true);
    expect(await deliverAfterRun(w.report, { runsDir: w.runsDir, stateDir: w.stateDir, now: () => NOW }, w.deps)).toMatchObject({ status: "delivered" });
    expect(await deliverReview({ ...w.opts, resend: true }, w.deps)).toMatchObject({ status: "duplicate" });
  });

  it("PR #310 review M1: a stop already requested skips the hand-off; nothing is sealed or delivered", async () => {
    const w = await finishedRun();
    const ac = new AbortController();
    ac.abort();
    expect(await deliverAfterRun(w.report, { runsDir: w.runsDir, stateDir: w.stateDir, signal: ac.signal }, w.deps)).toEqual({ status: "refused", code: "REVIEW_ABORTED" });
    expect(await codeOf(deliverReview({ ...w.opts, signal: ac.signal }, w.deps))).toBe("REVIEW_ABORTED");
    nothingDelivered(w);
  });

  it("PR #310 review L2: a re-send never packs: a missing or empty sealed bundle is SEALED_BUNDLE_MISSING", async () => {
    const w = await finishedRun();
    expect(await codeOf(deliverReview({ ...w.opts, resend: true }, w.deps))).toBe("SEALED_BUNDLE_MISSING");
    nothingDelivered(w);
    mkdirSync(join(w.bundles, ID), { recursive: true, mode: 0o700 });
    expect(await codeOf(deliverReview({ ...w.opts, resend: true }, w.deps))).toBe("SEALED_BUNDLE_MISSING");
    expect(readdirSync(join(w.bundles, ID))).toEqual([]);
    rmSync(join(w.bundles, ID), { recursive: true });
    // the automatic path packs once (one atomic rename: no temporary or empty directory is left behind)
    expect((await deliverReview(w.opts, w.deps)).status).toBe("delivered");
    expect(readdirSync(w.bundles)).toEqual([ID]);
  });

  it("a tampered picture, a symlinked part, run directory or receipt, a second receipt", async () => {
    const w = await finishedRun();
    const runDir = w.report.run_dir!;
    const part = join(runDir, "parts", "sp-2.png");
    const good = readFileSync(part);
    const bad = Buffer.from(good);
    bad[bad.length - 20] ^= 0xff;
    writeFileSync(part, bad);
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("RUN_FILE_SHA_MISMATCH");
    writeFileSync(part, good);
    nothingDelivered(w);

    const copy = join(w.home, "pc-1.png");
    renameSync(join(runDir, "parts", "pc-1.png"), copy);
    symlinkSync(copy, join(runDir, "parts", "pc-1.png"));
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("RUN_FILE_LINK");
    rmSync(join(runDir, "parts", "pc-1.png"));
    renameSync(copy, join(runDir, "parts", "pc-1.png"));
    nothingDelivered(w);

    renameSync(runDir, `${runDir}.real`);
    symlinkSync(`${runDir}.real`, runDir);
    expect(await codeOf(deliverReview(w.opts, w.deps))).toMatch(/^(RUN_DIR_UNSAFE|RECEIPT_RUN_DIR_MISMATCH|RECEIPT_INVALID)$/);
    rmSync(runDir);
    renameSync(`${runDir}.real`, runDir);
    nothingDelivered(w);

    renameSync(w.receipt, `${w.receipt}.real`);
    symlinkSync(`${w.receipt}.real`, w.receipt);
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("RECEIPT_UNSAFE");
    rmSync(w.receipt);
    renameSync(`${w.receipt}.real`, w.receipt);
    chmodSync(w.receipt, 0o644);
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("RECEIPT_UNSAFE");
    chmodSync(w.receipt, 0o600);
    // the automatic path names its receipt: another one is refused, as is a second receipt for the same approval
    expect(await codeOf(deliverReview({ ...w.opts, receiptPath: join(w.runsDir, "x.receipt.json") }, w.deps))).toBe("RECEIPT_AMBIGUOUS");
    const second = w.receipt.replace(/\d{8}T\d{6}Z/, "20261120T020000Z");
    writeFileSync(second, readFileSync(w.receipt), { mode: 0o600 });
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("RECEIPT_AMBIGUOUS");
    rmSync(second);
    nothingDelivered(w);
    expect((await deliverReview(w.opts, w.deps)).status).toBe("delivered");
  });

  it("the dummy PoC's reserved ID, a malformed ID, the jailed Claude running or unknown, the worker's lock held", async () => {
    const w = await finishedRun();
    expect(await codeOf(deliverReview({ ...w.opts, approvalId: DUMMY_ID }, w.deps))).toBe("APPROVAL_ID_RESERVED");
    expect(await codeOf(deliverReview({ ...w.opts, approvalId: "../x" }, w.deps))).toBe("APPROVAL_ID_INVALID");
    expect(await codeOf(deliverReview({ ...w.opts, jailIdle: async () => false }, w.deps))).toBe("JAIL_ACTIVE");
    expect(await codeOf(deliverReview({ ...w.opts, jailIdle: async () => null }, w.deps))).toBe("JAIL_STATE_UNKNOWN");
    expect(await codeOf(deliverReview({ ...w.opts, jailIdle: async () => Promise.reject(new Error("no systemd")) }, w.deps))).toBe("JAIL_STATE_UNKNOWN");
    const lock = await acquireLock(w.stateDir, new Date(NOW), "imagefirst.lock");
    expect(lock).toBeDefined();
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("REVIEW_LOCKED");
    await lock!.release();
    nothingDelivered(w);
  });
});

describe("a failed or interrupted hand-off is re-sent with the SAME sealed bundle only", () => {
  it("an unsafe inbox (open, symlinked) leaves the bundle sealed; the re-send after the fix delivers the same SHA", async () => {
    const w = await finishedRun();
    const before = w.used();
    mkdirSync(w.inbox, { mode: 0o750 });
    chmodSync(w.inbox, 0o750);
    const first = await deliverReview(w.opts, w.deps);
    expect(first).toMatchObject({ status: "not_delivered", code: "TRANSPORT_FAILED", bundle: "sealed", previews: null });
    expect(readdirSync(w.inbox)).toEqual([]);
    expect(readdirSync(w.bundles)).toEqual([ID]);
    // the inbox replaced by a link to elsewhere: refused, the link target untouched
    rmSync(w.inbox, { recursive: true });
    const elsewhere = tmp("sr-dr-elsewhere-");
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, w.inbox);
    expect(await deliverReview(w.opts, w.deps)).toMatchObject({ status: "not_delivered", code: "TRANSPORT_FAILED", bundle: "existing", bundle_sha256: first.bundle_sha256 });
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(w.inbox);
    // interrupted while "delivering" (a crash): counts as sealed, the same bytes go
    const job = join(w.stateDir, "deliveries", `${ID}.json`);
    writeFileSync(job, readFileSync(job, "utf8").replace(/"state": "sealed"/, '"state": "delivering"'));
    const ok = await deliverReview(w.opts, w.deps);
    expect(ok).toMatchObject({ status: "delivered", bundle: "existing", previews: "built", bundle_sha256: first.bundle_sha256 });
    expect(w.used()).toEqual(before);
  });

  it("a previews directory that is a link is refused (nothing written through it); a sealed bundle or receipt changed after sealing is never sent", async () => {
    const w = await finishedRun();
    mkdirSync(w.inbox, { mode: 0o700 });
    const elsewhere = tmp("sr-dr-pv-");
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, join(w.inbox, "previews"));
    expect(await codeOf(deliverReview(w.opts, w.deps))).toBe("PREVIEWS_DIR_UNSAFE");
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(join(w.inbox, "previews"));
    expect(await deliverReview(w.opts, w.deps)).toMatchObject({ status: "duplicate", previews: "built" });

    const w2 = await finishedRun();
    mkdirSync(w2.inbox, { mode: 0o750 });
    chmodSync(w2.inbox, 0o750);
    expect((await deliverReview(w2.opts, w2.deps)).status).toBe("not_delivered");
    chmodSync(w2.inbox, 0o700);
    // the receipt re-written (same content, other bytes): the sealed bundle no longer comes from it
    const good = readFileSync(w2.receipt);
    w2.writeReceipt(JSON.stringify(w2.readReceipt()));
    expect(await codeOf(deliverReview(w2.opts, w2.deps))).toBe("SEALED_BUNDLE_MISMATCH");
    writeFileSync(w2.receipt, good);
    // a sealed picture changed: refused by the verifier, never re-packed
    const sealedPart = join(w2.bundles, ID, "parts", "pc-2.png");
    const b = readFileSync(sealedPart);
    const bad = Buffer.from(b);
    bad[bad.length - 20] ^= 0xff;
    writeFileSync(sealedPart, bad);
    expect(await codeOf(deliverReview(w2.opts, w2.deps))).toBe("BUNDLE_FILE_SHA_MISMATCH");
    expect(readdirSync(w2.inbox)).toEqual([]);
    writeFileSync(sealedPart, b);
    expect((await deliverReview(w2.opts, w2.deps)).status).toBe("delivered");
  });
});

describe("the delivery cannot start anything", () => {
  it("imports only node built-ins, the bundle, the local inbox, the worker's lock and read-only parts of the cycle", () => {
    const src = readFileSync(resolve(REPO, "lib/design-agent/imagefirst-worker/deliver-review.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!).sort();
    expect(imports).toEqual(["../worker/state", "./bundle", "./cycle", "./local-inbox", "./preview", "./transport", "node:fs", "node:fs/promises", "node:path"]);
    const fromCycle = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/cycle"/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim())).sort();
    expect(fromCycle).toEqual(["IMAGEFIRST_ALLOWLIST", "checkRealApprovalId", "readApprovalAt", "sha256", "type CycleDeps", "type CycleReport"]);
    expect(src).not.toMatch(/\brequire\(|import\(|child_process|runBounded|bounded-process|runImagefirstCycle|precheckImagefirstCycle|claimApproval|invoke|ledger|node:net|node:https?|fetch\(|codex|image-once|image-first-generate|spool|github|anthropic|openai/i);
  });

  it("the worker CLI delivers only after a succeeded cycle, and its --deliver-review never runs the cycle", () => {
    const cli = readFileSync(resolve(REPO, "scripts/sales-design-worker/imagefirst-worker.ts"), "utf8");
    const deliverBranch = cli.slice(cli.indexOf("if (deliver)"), cli.indexOf("if (precheck)"));
    expect(deliverBranch).toMatch(/deliverReview\(\{[^}]*resend: true[^}]*signal: controller\.signal/);
    expect(deliverBranch).toMatch(/gitCommitState\(REPO, env\)/);
    expect(deliverBranch).not.toMatch(/runImagefirstCycle|\binvoke\b(?!d)|runBounded|tsEntry|openLedger|precheckImagefirstCycle/);
    // PR #310 review M1: the run's one stdout line is printed BEFORE the hand-off, which takes the stop signal; the
    // review summary goes to stderr / the audit file, never a second stdout line
    expect(cli).toMatch(/const report = await runImagefirstCycle\([\s\S]*\);\n(\s*\/\/.*\n)?\s*say\(report\);\n\s*const review = await deliverAfterRun\(report, \{ runsDir, stateDir, signal: controller\.signal \}/);
    expect(cli.match(/\bsay\(/g)!.length).toBeGreaterThan(0);
    expect(cli.slice(cli.indexOf("const review = await deliverAfterRun"))).not.toMatch(/\bsay\(/);
  });

  it("the CLI's --deliver-review refuses a malformed or reserved ID and an unknown / running jail state, writing nothing", () => {
    const run = (args: string[]) => {
      const home = tmp("sr-dr-cli-");
      const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/sales-design-worker/imagefirst-worker.ts"), ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
      const lines = r.stdout.trim().split("\n").filter(Boolean);
      return { home, status: r.status, out: JSON.parse(lines.at(-1) ?? "null") as { status: string; code: string }, lines };
    };
    for (const [args, code] of [[["--deliver-review"], "USAGE"], [["--deliver-review", "../x"], "APPROVAL_ID_INVALID"], [["--deliver-review", DUMMY_ID], "APPROVAL_ID_RESERVED"], [["--deliver-review", ID, "x"], "USAGE"]] as const) {
      const r = run([...args]);
      expect([r.status, r.out.status, r.out.code], args.join(" ")).toEqual([2, "refused", code]);
      expect(readdirSync(r.home)).toEqual([]);
    }
    expect(IMAGEFIRST_ALLOWLIST.shop).toBe("hoshigama");
    // (a valid ID's outcome depends on this checkout's commit and the host's systemd: the jail read is tested below with a
    // fake systemctl, and the whole re-send path through root's wrapper in deliver-review-wrapper.test.ts. PR #310 review L6)
  });
});

describe("the worker side's jail read (PR #310 review H1 / L5 / L6): a fake systemctl, never the host's", () => {
  /** A fake systemctl: `show` prints <active> (or fails), `is-enabled` prints <enabled> with its exit code. */
  const fake = (active: string | null, enabled: string | null, enabledExit = 0) => {
    const dir = tmp("sr-dr-sc-");
    const p = join(dir, "systemctl");
    writeFileSync(
      p,
      `#!/bin/bash\necho "$*" >> '${dir}/log'\nif [ "$1" = show ]; then ${active === null ? "exit 1" : `echo '${active}'`}; exit 0; fi\nif [ "$1" = is-enabled ]; then ${enabled === null ? "exit 1" : `echo '${enabled}'; exit ${enabledExit}`}; fi\nexit 9\n`,
    );
    chmodSync(p, 0o755);
    return { p, log: () => readFileSync(join(dir, "log"), "utf8") };
  };
  const env = { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv;
  it.each([
    ["inactive / disabled", "inactive", "disabled", 1, true],
    ["failed / masked", "failed", "masked", 1, true],
    ["inactive / masked", "inactive", "masked", 0, true],
    ["active", "active", "disabled", 1, false],
    ["activating", "activating", "disabled", 1, false],
    ["inactive / enabled", "inactive", "enabled", 0, false],
    ["inactive / static", "inactive", "static", 0, false],
    ["inactive / not-found", "inactive", "not-found", 1, false],
    ["inactive / no answer", "inactive", "", 1, false],
    ["show fails (no bus, e.g. inside the jail)", null, "disabled", 1, null],
    ["show prints nothing", "", "disabled", 1, null],
  ] as const)("%s", async (_name, active, enabled, exit, want) => {
    const f = fake(active, enabled, exit);
    expect(await jailIdle(env, f.p)).toBe(want);
    expect(f.log()).toMatch(/^show -p ActiveState --value sr-jail-claude\.service$/m);
  });
  it("uses the absolute root-owned path by default (never the caller's PATH)", () => {
    const src = readFileSync(resolve(REPO, "lib/design-agent/imagefirst-worker/jail-state.ts"), "utf8");
    expect(src).toMatch(/export const SYSTEMCTL = "\/usr\/bin\/systemctl";/);
    expect(src).toMatch(/systemctl: string = SYSTEMCTL/);
    const cli = readFileSync(resolve(REPO, "scripts/sales-design-worker/imagefirst-worker.ts"), "utf8");
    expect(cli).toMatch(/jailIdle: \(\) => jailIdle\(env\)/);
    expect(cli).not.toMatch(/"systemctl"/);
  });
});
