import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { PROMPT_INPUTS } from "@/lib/design-agent/image-first/prompt";
import { claimApproval, exitCodeOf, generateArgv, gitCommitState, grantFromEnv, GRANT_ENV, IMAGEFIRST_ALLOWLIST, packetPins, runImagefirstCycle, WORKER_STOP, type CycleDeps, type CycleOptions, type WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { APPROVAL_PACKET_PATH } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { acquireLock } from "@/lib/design-agent/worker/state";
import { fileAtCommit, parseArgs } from "@/scripts/design-artifact/phase2f-live-cli";
import { colourPng } from "../phase2f/fixtures";
import { UNAPPROVED_PACKET_FIXTURE } from "../image-first/fixtures/unapproved-packet";
import { cleanupTemps, commitFiles, ENV, entryInProcess, fakeCodex, FLAGS, filledPacket, git, ID, NOW, PLAN_ID, pointOrigin, REPO, sha, tmp, VALUES, workerRepo } from "./support";

// Issue #298 P1: the IMAGE_FIRST worker adapter, end to end against a FAKE Codex. The worker cycle runs against a
// temporary git repository (its own origin/develop) holding a filled-in d3 packet built here (never committed to this
// repository) and the three prompt inputs. The existing entry is played in-process exactly as
// scripts/design-artifact/image-first-generate.ts main() does (same flags, same runFullPageCall, same batch mapping),
// with generateImagesInOneRun driven by the in-process fake sandbox the image-once tests use. No Codex, no model, no
// image tool, no network, no bubblewrap. (Issue #302 P1: the helpers live in ./support, shared with the automatic
// start's fake worker.)

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanupTemps);


/** One worker world: a clone, a state dir, a runs dir, a ledger, a fake Codex, and a counter of invocations. */
function world(o: { repo?: string; mode?: "six" | "fail"; ledgerDir?: string; stateDir?: string; runsDir?: string } = {}) {
  const repo = o.repo ?? workerRepo();
  const w = { repo, stateDir: o.stateDir ?? tmp("sr-ifw-state-"), runsDir: o.runsDir ?? tmp("sr-ifw-runs-"), ledgerDir: o.ledgerDir ?? tmp("sr-ifw-ledger-"), fake: fakeCodex(o.mode ?? "six"), invoked: [] as string[][] };
  const deps = (invoke?: CycleDeps["invoke"]): CycleDeps => ({
    commit: () => gitCommitState(repo, ENV),
    fileAt: (commit, rel) => fileAtCommit(commit, rel, repo),
    ledger: openLedger(w.ledgerDir),
    now: () => NOW,
    invoke:
      invoke ??
      (async (argv, signal) => {
        w.invoked.push(argv);
        return entryInProcess(argv, { repo, ledgerDir: w.ledgerDir, fake: w.fake, ...(signal ? { signal } : {}) });
      }),
  });
  const cycle = (invoke?: CycleDeps["invoke"], extra: Pick<CycleOptions, "signal" | "onInvoking" | "expectApprovalId"> = {}) => runImagefirstCycle({ repoRoot: repo, stateDir: w.stateDir, runsDir: w.runsDir, ...extra }, deps(invoke));
  return { ...w, cycle };
}

describe("Issue #298 IMAGE_FIRST worker adapter: the approved d3 job end to end (fake Codex)", () => {
  it("one cycle: one invocation, one Codex run, PC 2 + SP 4 in a private bundle, receipt SHAs = the files, stop code null", async () => {
    const w = world();
    const report = await w.cycle();
    expect(report).toMatchObject({ status: "succeeded", code: null, invoked: true, approval_id: ID });
    expect(exitCodeOf(report.status)).toBe(0);
    expect(w.invoked).toHaveLength(1);
    expect(w.fake.execs).toBe(1);
    // the private run directory: outside the repository, 0700, six parts
    const runDir = report.run_dir!;
    expect(runDir.startsWith(w.runsDir)).toBe(true);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(runDir, "parts")).sort()).toEqual(["pc-1.png", "pc-2.png", "sp-1.png", "sp-2.png", "sp-3.png", "sp-4.png"]);
    const receipt = JSON.parse(readFileSync(report.receipt!, "utf8")) as WorkerReceipt;
    expect(statSync(report.receipt!).mode & 0o777).toBe(0o600);
    expect(receipt).toMatchObject({ status: "succeeded", stop_code: null, stage: null, cli_exit: 0, verified: true, counts: { pc: 2, sp: 4, total: 6, stopped: 0 }, approval_id: ID, plan_id: PLAN_ID, shop: "hoshigama", direction: "d3", plan_sha256: IMAGEFIRST_ALLOWLIST.planSha256, prompt_sha256: IMAGEFIRST_ALLOWLIST.promptSha256 });
    for (const img of receipt.images) expect(sha(readFileSync(join(runDir, img.file)))).toBe(img.sha256);
    expect(receipt.commit).toBe(git(w.repo, "rev-parse", "HEAD"));
    expect(receipt.packet_sha256).toBe(sha(readFileSync(join(w.repo, APPROVAL_PACKET_PATH))));
    // codes, SHAs, counts and timings only: no prompt text in the receipt
    const text = readFileSync(report.receipt!, "utf8");
    expect(text).not.toMatch(/prompt"\s*:|デザインカンプ|Web サイト/);
    // the entry's ledger used the approval once
    expect(readdirSync(join(w.ledgerDir, "approvals"))).toEqual([ID]);
    // nothing written into the clone
    expect(git(w.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    // a second cycle after the run: refused before anything (the claim), no second invocation
    expect(await w.cycle()).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false });
    expect(w.invoked).toHaveLength(1);
    expect(w.fake.execs).toBe(1);
  });

  it("the arguments are exactly the entry's flags, every value from the packet at the commit or the fixed allowlist", () => {
    const argv = generateArgv({ repoRoot: "/r", outDir: "/o/run", planId: PLAN_ID, approvalId: ID, expires: "2026-11-20T09:00:00Z", packetSha256: "a".repeat(64), commit: "b".repeat(40) });
    const args = parseArgs(argv, FLAGS, VALUES);
    expect(args).not.toBeNull();
    expect([...args!.keys()].sort()).toEqual([...FLAGS, ...VALUES].sort());
    expect(Object.fromEntries(args!)).toMatchObject({ "--direction": "d3", "--packet": `/r/${APPROVAL_PACKET_PATH}`, "--expected-plan-sha256": IMAGEFIRST_ALLOWLIST.planSha256, "--expected-prompt-chars": "12338" });
  });

  it("the fixed pins are the packet's own §3 d3 column", () => {
    expect(packetPins(readFileSync(UNAPPROVED_PACKET_FIXTURE))).toEqual({ planSha256: IMAGEFIRST_ALLOWLIST.planSha256, promptSha256: IMAGEFIRST_ALLOWLIST.promptSha256, promptChars: IMAGEFIRST_ALLOWLIST.promptChars });
  });
});

describe("Issue #298 IMAGE_FIRST worker adapter: fail closed (nothing invoked)", () => {
  const refusedWith = async (w: ReturnType<typeof world>, status: string, code: string | RegExp) => {
    const r = await w.cycle();
    expect(r.status).toBe(status);
    if (typeof code === "string") expect(r.code).toBe(code);
    else expect(r.code).toMatch(code);
    expect(r.invoked).toBe(false);
    expect(w.invoked).toHaveLength(0);
    expect(w.fake.execs).toBe(0);
    expect(existsSync(join(w.ledgerDir, "approvals"))).toBe(false);
    expect(readdirSync(w.runsDir)).toEqual([]);
    return r;
  };

  it("an unapproved packet is no job", async () => {
    const r = await refusedWith(world({ repo: workerRepo(readFileSync(UNAPPROVED_PACKET_FIXTURE)) }), "no_job", "PACKET_NOT_APPROVED");
    expect(exitCodeOf(r.status)).toBe(0);
  });

  it("expired, or further than 24 h ahead", async () => {
    await refusedWith(world({ repo: workerRepo(filledPacket({ expires: "`2026-11-20T00:59:59Z`" })) }), "refused", "APPROVAL_EXPIRED");
    await refusedWith(world({ repo: workerRepo(filledPacket({ expires: "`2026-11-21T01:00:01Z`" })) }), "refused", "APPROVAL_EXPIRY_TOO_FAR");
  });

  it("the wrong commit: HEAD is not origin/develop, or the tree is dirty", async () => {
    const ahead = workerRepo();
    commitFiles(ahead, { "extra.txt": Buffer.from("x") }, "not on origin/develop");
    await refusedWith(world({ repo: ahead }), "refused", "NOT_ON_ORIGIN_DEVELOP");
    const dirty = workerRepo();
    writeFileSync(join(dirty, "untracked.txt"), "x");
    await refusedWith(world({ repo: dirty }), "refused", "TREE_DIRTY");
    // an approved packet only in the working tree (the commit has the unapproved one) is dirty, never read
    const wt = workerRepo(readFileSync(UNAPPROVED_PACKET_FIXTURE));
    writeFileSync(join(wt, APPROVAL_PACKET_PATH), filledPacket());
    await refusedWith(world({ repo: wt }), "refused", "TREE_DIRTY");
  });

  it("d1, or d1 and d3 together", async () => {
    await refusedWith(world({ repo: workerRepo(filledPacket({ directions: "`d1`", d1: "`hoshigama-imagefirst-d1-20261120-01`", d3: "`なし`" })) }), "refused", "SCOPE_NOT_ALLOWED");
    await refusedWith(world({ repo: workerRepo(filledPacket({ directions: "`d1,d3`", d1: "`hoshigama-imagefirst-d1-20261120-01`" })) }), "refused", "SCOPE_NOT_ALLOWED");
  });

  it("another shop's approval id", async () => {
    await refusedWith(world({ repo: workerRepo(filledPacket({ d3: "`tsugute-imagefirst-d3-20261120-01`" })) }), "refused", "SHOP_NOT_ALLOWED");
  });

  it("an invalid plan ID is refused before the one-use approval claim", async () => {
    for (const invalid of ["--other-flag", "../wrong-plan", "hoshigama-imagefirst-p3-wrong", "other-imagefirst-p3-20261120"]) {
      const w = world({ repo: workerRepo(filledPacket({ planId: `\`${invalid}\`` })) });
      await refusedWith(w, "refused", "PLAN_ID_INVALID");
      expect(existsSync(join(w.stateDir, "claims"))).toBe(false);
    }
  });

  it("an unsafe claims directory (world-readable or symlink) is refused before using the approval", async () => {
    const loose = world();
    mkdirSync(join(loose.stateDir, "claims"), { mode: 0o700 });
    chmodSync(join(loose.stateDir, "claims"), 0o755);
    await refusedWith(loose, "refused", "CLAIMS_DIR_UNSAFE");
    expect(readdirSync(join(loose.stateDir, "claims"))).toEqual([]);

    const linked = world();
    const outside = tmp("sr-ifw-untrusted-claims-");
    symlinkSync(outside, join(linked.stateDir, "claims"), "dir");
    await refusedWith(linked, "refused", "CLAIMS_DIR_UNSAFE");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("a tampered packet pin or plan input", async () => {
    const plan = IMAGEFIRST_ALLOWLIST.planSha256;
    await refusedWith(world({ repo: workerRepo(filledPacket({}, (t) => t.replace(`\`${plan}\``, `\`${"0".repeat(64)}\``))) }), "refused", "PACKET_PIN_MISMATCH");
    const tampered = workerRepo();
    const set = JSON.parse(readFileSync(join(tampered, PROMPT_INPUTS.directionSet.path), "utf8")) as { directions: { id: string; [k: string]: unknown }[] };
    const d3 = set.directions.find((x) => x.id === "d3-flour-crust")!;
    d3.tampered = true;
    commitFiles(tampered, { [PROMPT_INPUTS.directionSet.path]: Buffer.from(JSON.stringify(set, null, 2)) }, "tamper");
    pointOrigin(tampered);
    await refusedWith(world({ repo: tampered }), "refused", /^PLAN_/);
  });

  it("an approval id the entry's ledger already used (another state dir, same ledger)", async () => {
    const first = world();
    expect((await first.cycle()).status).toBe("succeeded");
    const again = world({ repo: first.repo, ledgerDir: first.ledgerDir });
    expect(await again.cycle()).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_USED", invoked: false });
    expect(again.invoked).toHaveLength(0);
    expect(readdirSync(again.runsDir)).toEqual([]);
    expect(again.fake.execs).toBe(0);
  });

  it("a second cycle while one runs is refused by the lock; the held one finishes once", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = w.cycle(async (argv) => {
      w.invoked.push(argv);
      entered();
      await gate;
      return entryInProcess(argv, { repo: w.repo, ledgerDir: w.ledgerDir, fake: w.fake });
    });
    await inside;
    expect(await w.cycle()).toMatchObject({ status: "locked", code: "WORKER_LOCKED", invoked: false });
    release();
    expect((await first).status).toBe("succeeded");
    expect(w.invoked).toHaveLength(1);
    expect(w.fake.execs).toBe(1);
    // a lock held by another live holder: also refused
    const held = await acquireLock(w.stateDir, new Date(), "imagefirst.lock");
    expect(held).toBeDefined();
    expect(await w.cycle()).toMatchObject({ status: "locked", invoked: false });
    await held!.release();
  });

  it("a failing fake Codex: the stop code is recorded, nothing is retried, the approval stays used", async () => {
    const w = world({ mode: "fail" });
    const r = await w.cycle();
    expect(r).toMatchObject({ status: "stopped", invoked: true, approval_id: ID });
    expect(exitCodeOf(r.status)).toBe(1);
    expect(w.invoked).toHaveLength(1);
    expect(w.fake.execs).toBe(1);
    const receipt = JSON.parse(readFileSync(r.receipt!, "utf8")) as WorkerReceipt;
    expect(receipt).toMatchObject({ status: "stopped", stage: "call", cli_exit: 1, verified: false, counts: { total: 0 } });
    expect(receipt.stop_code).toMatch(/^CODEX_/);
    expect(r.code).toBe(receipt.stop_code);
    expect(await w.cycle()).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false });
    expect(w.invoked).toHaveLength(1);
    expect(w.fake.execs).toBe(1);
  });

  it("an invocation that throws or is killed still uses the approval once (no retry)", async () => {
    const w = world();
    const r = await w.cycle(async (argv) => {
      w.invoked.push(argv);
      return { code: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true };
    });
    expect(r).toMatchObject({ status: "stopped", code: "CLI_TIMEOUT", invoked: true });
    expect(await w.cycle()).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED" });
    expect(w.invoked).toHaveLength(1);
  });
});

describe("Issue #302 P0: unsafe places are refused before the claim (PR #301 L2, PR #303 L1/L2)", () => {
  const nothingUsed = (w: ReturnType<typeof world>) => {
    expect(w.invoked).toHaveLength(0);
    expect(w.fake.execs).toBe(0);
    expect(existsSync(join(w.ledgerDir, "approvals"))).toBe(false);
  };

  it("a runs dir open to others, or a link, is RUNS_DIR_UNSAFE: nothing claimed, nothing invoked", async () => {
    const loose = world();
    chmodSync(loose.runsDir, 0o755);
    expect(await loose.cycle()).toMatchObject({ status: "refused", code: "RUNS_DIR_UNSAFE", invoked: false });
    nothingUsed(loose);
    expect(readdirSync(join(loose.stateDir, "claims"))).toEqual([]);
    expect(readdirSync(loose.runsDir)).toEqual([]);

    const target = tmp("sr-ifw-runs-target-");
    const link = join(tmp("sr-ifw-runs-link-"), "runs");
    symlinkSync(target, link, "dir");
    const linked = world({ runsDir: link });
    expect(await linked.cycle()).toMatchObject({ status: "refused", code: "RUNS_DIR_UNSAFE", invoked: false });
    nothingUsed(linked);
    expect(readdirSync(join(linked.stateDir, "claims"))).toEqual([]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("a state dir open to others, or a link, is CLAIMS_DIR_UNSAFE: no marker anywhere", async () => {
    const loose = world();
    chmodSync(loose.stateDir, 0o755);
    expect(await loose.cycle()).toMatchObject({ status: "refused", code: "CLAIMS_DIR_UNSAFE", invoked: false });
    nothingUsed(loose);
    expect(existsSync(join(loose.stateDir, "claims"))).toBe(false);
    expect(readdirSync(loose.runsDir)).toEqual([]);

    const target = tmp("sr-ifw-state-target-");
    const link = join(tmp("sr-ifw-state-link-"), "state");
    symlinkSync(target, link, "dir");
    const linked = world({ stateDir: link });
    expect(await linked.cycle()).toMatchObject({ status: "refused", code: "CLAIMS_DIR_UNSAFE", invoked: false });
    nothingUsed(linked);
    expect(existsSync(join(target, "claims"))).toBe(false);
  });

  it("the claim itself checks the open directory handles (a path swapped after the lstat checks cannot redirect it)", async () => {
    // claimApproval is called here without the cycle's earlier lstat checks: only its own handle checks stand
    const linkedClaims = tmp("sr-ifw-claim-a-");
    const outside = tmp("sr-ifw-claim-outside-");
    symlinkSync(outside, join(linkedClaims, "claims"), "dir");
    expect(await claimApproval(linkedClaims, ID, NOW)).toBe("CLAIMS_DIR_UNSAFE");
    expect(readdirSync(outside)).toEqual([]);

    const looseClaims = tmp("sr-ifw-claim-b-");
    mkdirSync(join(looseClaims, "claims"));
    chmodSync(join(looseClaims, "claims"), 0o755);
    expect(await claimApproval(looseClaims, ID, NOW)).toBe("CLAIMS_DIR_UNSAFE");
    expect(readdirSync(join(looseClaims, "claims"))).toEqual([]);

    const linkedState = join(tmp("sr-ifw-claim-c-"), "state");
    const stateTarget = tmp("sr-ifw-claim-c-target-");
    symlinkSync(stateTarget, linkedState, "dir");
    expect(await claimApproval(linkedState, ID, NOW)).toBe("CLAIMS_DIR_UNSAFE");
    expect(readdirSync(stateTarget)).toEqual([]);

    const looseState = tmp("sr-ifw-claim-d-");
    chmodSync(looseState, 0o755);
    expect(await claimApproval(looseState, ID, NOW)).toBe("CLAIMS_DIR_UNSAFE");
    expect(readdirSync(looseState)).toEqual([]);

    // a private state dir: claimed once (0600 marker inside a 0700 claims dir), then already claimed
    const good = tmp("sr-ifw-claim-e-");
    expect(await claimApproval(good, ID, NOW)).toBe("claimed");
    expect(statSync(join(good, "claims")).mode & 0o777).toBe(0o700);
    expect(statSync(join(good, "claims", `${ID}.used`)).mode & 0o777).toBe(0o600);
    expect(await claimApproval(good, ID, NOW)).toBe("APPROVAL_ALREADY_CLAIMED");
    // the marker name itself as a dangling link: never followed
    const dangling = tmp("sr-ifw-claim-f-");
    mkdirSync(join(dangling, "claims"), { mode: 0o700 });
    symlinkSync(join(outside, "planted"), join(dangling, "claims", `${ID}.used`));
    expect(await claimApproval(dangling, ID, NOW)).toBe("APPROVAL_ALREADY_CLAIMED");
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("Issue #302 P0: the bundle is verified, and an interrupted run still ends with a receipt (PR #301 L1/L2)", () => {
  it("a picture changed or missing after the entry recorded it: BUNDLE_VERIFY_FAILED, stage verify, no retry", async () => {
    for (const damage of ["tamper", "remove"] as const) {
      const w = world();
      const r = await w.cycle(async (argv, signal) => {
        w.invoked.push(argv);
        const res = await entryInProcess(argv, { repo: w.repo, ledgerDir: w.ledgerDir, fake: w.fake, ...(signal ? { signal } : {}) });
        const out = argv[argv.indexOf("--out") + 1]!;
        if (damage === "tamper") writeFileSync(join(out, "parts", "pc-1.png"), colourPng(64, 64));
        else rmSync(join(out, "parts", "sp-4.png"));
        return res;
      });
      expect(r).toMatchObject({ status: "stopped", code: "BUNDLE_VERIFY_FAILED", invoked: true, approval_id: ID });
      const receipt = JSON.parse(readFileSync(r.receipt!, "utf8")) as WorkerReceipt;
      expect(receipt).toMatchObject({ status: "stopped", stop_code: "BUNDLE_VERIFY_FAILED", stage: "verify", cli_exit: 0, verified: false, interrupted: false });
      expect(w.fake.execs).toBe(1);
      expect(await w.cycle()).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false });
      expect(w.invoked).toHaveLength(1);
      expect(w.fake.execs).toBe(1);
    }
  });

  const auditLines = (stateDir: string) =>
    readFileSync(join(stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { status: string; code: string | null; invoked: boolean });

  it("a stop signal during the run: the invocation is aborted, the receipt says WORKER_INTERRUPTED, one audit line, the claim stays used", async () => {
    const w = world();
    const controller = new AbortController();
    const r = await w.cycle(
      async (argv, signal) => {
        w.invoked.push(argv);
        expect(signal).toBe(controller.signal);
        controller.abort();
        // what runBounded returns once the aborted entry's group is gone
        return { code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, aborted: true };
      },
      { signal: controller.signal },
    );
    expect(r).toMatchObject({ status: "stopped", code: "WORKER_INTERRUPTED", invoked: true, approval_id: ID });
    expect(exitCodeOf(r.status)).toBe(1);
    const receipt = JSON.parse(readFileSync(r.receipt!, "utf8")) as WorkerReceipt;
    expect(receipt).toMatchObject({ status: "stopped", stop_code: "WORKER_INTERRUPTED", stage: "call", interrupted: true, cli_exit: null, verified: false });
    expect(auditLines(w.stateDir).filter((l) => l.code === "WORKER_INTERRUPTED")).toHaveLength(1);
    expect(existsSync(join(w.stateDir, "claims", `${ID}.used`))).toBe(true);
    expect(await w.cycle()).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false });
    expect(w.invoked).toHaveLength(1);
  });

  it("the worker must exit before the invocation returns: recordInterrupted writes the receipt and the audit line from disk, once", async () => {
    const w = world();
    let record: (() => Promise<void>) | null = null;
    let release!: (r: BoundedResult) => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const run = w.cycle(
      async (argv) => {
        w.invoked.push(argv);
        // a picture the entry had already written when the worker was stopped
        const out = argv[argv.indexOf("--out") + 1]!;
        mkdirSync(join(out, "parts"), { recursive: true });
        writeFileSync(join(out, "parts", "pc-1.png"), colourPng(32, 32));
        entered();
        return new Promise<BoundedResult>((r) => (release = r));
      },
      { onInvoking: (fn) => (record = fn) },
    );
    await inside;
    expect(record).not.toBeNull();
    await record!();
    const receipts = () => readdirSync(w.runsDir).filter((n) => n.endsWith(".receipt.json"));
    expect(receipts()).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(join(w.runsDir, receipts()[0]!), "utf8")) as WorkerReceipt;
    expect(receipt).toMatchObject({ status: "stopped", stop_code: "WORKER_INTERRUPTED", stage: "call", interrupted: true, cli_exit: null, verified: false, counts: { pc: 1, total: 1 } });
    expect(receipt.images[0]!.file).toBe("parts/pc-1.png");
    expect(auditLines(w.stateDir)).toEqual([expect.objectContaining({ status: "stopped", code: "WORKER_INTERRUPTED", invoked: true })]);
    // calling it again changes nothing
    await record!();
    expect(receipts()).toHaveLength(1);
    // the invocation returning afterwards (even looking successful) is the same interrupted end: no second receipt or line
    release({ code: 0, signal: null, stdout: `${JSON.stringify({ status: "succeeded" })}\n`, stderr: "", timedOut: false });
    expect(await run).toMatchObject({ status: "stopped", code: "WORKER_INTERRUPTED", invoked: true });
    expect(receipts()).toHaveLength(1);
    expect(auditLines(w.stateDir)).toHaveLength(1);
    expect(await w.cycle()).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false });
    expect(w.invoked).toHaveLength(1);
    expect(w.fake.execs).toBe(0);
  });

  it("recordInterrupted after the run ended waits for that receipt and writes nothing more", async () => {
    const w = world();
    let record: (() => Promise<void>) | null = null;
    const r = await w.cycle(undefined, { onInvoking: (fn) => (record = fn) });
    expect(r.status).toBe("succeeded");
    await record!();
    expect(readdirSync(w.runsDir).filter((n) => n.endsWith(".receipt.json"))).toHaveLength(1);
    expect(auditLines(w.stateDir)).toEqual([expect.objectContaining({ status: "succeeded", code: null })]);
  });

  it("the stop timings: the entry's own stop fits inside the worker's grace, the grace inside the worker's hard stop", () => {
    // the entry: 20 s hard stop + 10 s clean-up (phase2f-live-cli stopSignals), read from its source
    const cli = readFileSync(resolve(REPO, "scripts/design-artifact/phase2f-live-cli.ts"), "utf8");
    expect(cli).toMatch(/setTimeout\(hardExit, o\.hardStopMs \?\? 20_000\)/);
    expect(cli).toMatch(/setTimeout\(r, 10_000\)/);
    expect(WORKER_STOP.entryStopMs).toBe(30_000);
    expect(WORKER_STOP.graceMs).toBeGreaterThan(WORKER_STOP.entryStopMs);
    expect(WORKER_STOP.hardStopMs).toBeGreaterThan(WORKER_STOP.graceMs);
    expect(WORKER_STOP.recordMs).toBe(10_000);
    const worker = readFileSync(resolve(REPO, "scripts/sales-design-worker/imagefirst-worker.ts"), "utf8");
    expect(worker).toMatch(/stopSignals\(\{ hardStopMs: WORKER_STOP\.hardStopMs, cleanup: /);
    expect(worker).toMatch(/graceMs: WORKER_STOP\.graceMs/);
    expect(worker).toMatch(/onInvoking: \(record\) => \(recordInterrupted = record\)/);
  });
});

describe("Issue #302 P1: root's grant (the automatic start) only narrows the job", () => {
  it("the grant names the packet's approval id: the same single run", async () => {
    const w = world();
    expect(await w.cycle(undefined, { expectApprovalId: ID })).toMatchObject({ status: "succeeded", invoked: true, approval_id: ID });
    expect(w.fake.execs).toBe(1);
  });

  it("the grant names another approval id: APPROVAL_NOT_GRANTED before the claim, nothing used", async () => {
    const w = world();
    expect(await w.cycle(undefined, { expectApprovalId: "hoshigama-imagefirst-d3-20261120-02" })).toMatchObject({ status: "refused", code: "APPROVAL_NOT_GRANTED", invoked: false });
    expect(w.invoked).toHaveLength(0);
    expect(w.fake.execs).toBe(0);
    expect(existsSync(join(w.stateDir, "claims"))).toBe(false);
    expect(existsSync(join(w.ledgerDir, "approvals"))).toBe(false);
    // an unapproved packet stays no_job with or without a grant (zero calls)
    const unapproved = world({ repo: workerRepo(readFileSync(UNAPPROVED_PACKET_FIXTURE)) });
    expect(await unapproved.cycle(undefined, { expectApprovalId: ID })).toMatchObject({ status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false });
    expect(unapproved.fake.execs).toBe(0);
  });

  it("grantFromEnv: absent = a run by hand, a ほし窯 d3 id = that grant, anything else = refused", () => {
    expect(grantFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(grantFromEnv({ [GRANT_ENV]: ID } as unknown as NodeJS.ProcessEnv)).toBe(ID);
    for (const bad of ["", "tsugute-imagefirst-d3-20261120-01", `${ID}\n`, "--approval-id", "hoshigama-imagefirst-d1-20261120-01"]) expect(grantFromEnv({ [GRANT_ENV]: bad } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
