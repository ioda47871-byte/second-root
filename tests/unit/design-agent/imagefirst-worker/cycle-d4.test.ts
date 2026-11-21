import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildPromptPlan, loadPromptInputs } from "@/lib/design-agent/image-first/prompt";
import { BundleStop, packBundle, verifyBundleDir } from "@/lib/design-agent/imagefirst-worker/bundle";
import {
  checkRealApprovalId,
  claimApproval,
  generateArgv,
  gitCommitState,
  grantFromEnv,
  GRANT_ENV,
  IMAGEFIRST_ALLOWLIST,
  IMAGEFIRST_RUNS,
  packetPins,
  precheckImagefirstCycle,
  readApprovalAt,
  runImagefirstCycle,
  runOfApprovalId,
  type CycleDeps,
  type WorkerReceipt,
} from "@/lib/design-agent/imagefirst-worker/cycle";
import { deliverAfterRun, deliverReview, ReviewStop } from "@/lib/design-agent/imagefirst-worker/deliver-review";
import { RUN_APPROVAL_ID_RE } from "@/lib/design-agent/imagefirst-worker/run-directions";
import { APPROVAL_PACKET_PATH, D4_PACKET, P3_PACKET, readApprovalPacket } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { fileAtCommit, parseArgs } from "@/scripts/design-artifact/phase2f-live-cli";
import { UNAPPROVED_D4_PACKET_FIXTURE, UNAPPROVED_PACKET_FIXTURE } from "../image-first/fixtures/unapproved-packet";
import { cleanupTemps, D4_ID, D4_PLAN_ID, type D4Fill, ENV, entryInProcess, fakeCodex, filledD4Packet, filledPacket, FLAGS, git, ID, NOW, REPO, sha, tmp, VALUES, workerRepo } from "./support";

// Issue #302 (d4 run path): the per-direction allowlist end to end against a FAKE Codex. The worker cycle runs against a
// temporary git repository holding the P3 packet and a d4 packet filled in memory from the unapproved d4 fixture (never
// committed to this repository). No Codex, no model, no image tool, no network, no approval of this repository used.

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanupTemps);

const D3_UNAPPROVED = readFileSync(UNAPPROVED_PACKET_FIXTURE);
const D4_UNAPPROVED = readFileSync(UNAPPROVED_D4_PACKET_FIXTURE);
/** A worker clone with the given P3 packet and d4 packet, committed and on its origin/develop. */
const repoWith = (p3: Buffer, d4: Buffer) => workerRepo(p3, { [D4_PACKET.path]: d4 });

function world(repo: string) {
  const w = { repo, stateDir: tmp("sr-ifd4-state-"), runsDir: tmp("sr-ifd4-runs-"), ledgerDir: tmp("sr-ifd4-ledger-"), fake: fakeCodex("six"), invoked: [] as string[][] };
  const deps: CycleDeps = {
    commit: () => gitCommitState(repo, ENV),
    fileAt: (commit, rel) => fileAtCommit(commit, rel, repo),
    ledger: openLedger(w.ledgerDir),
    now: () => NOW,
    invoke: async (argv, signal) => {
      w.invoked.push(argv);
      return entryInProcess(argv, { repo, ledgerDir: w.ledgerDir, fake: w.fake, ...(signal ? { signal } : {}) });
    },
  };
  const cycle = (grant?: string) => runImagefirstCycle({ repoRoot: repo, stateDir: w.stateDir, runsDir: w.runsDir, ...(grant === undefined ? {} : { expectApprovalId: grant }) }, deps);
  const precheck = (grant?: string) => precheckImagefirstCycle({ repoRoot: repo, stateDir: w.stateDir, runsDir: w.runsDir, ...(grant === undefined ? {} : { expectApprovalId: grant }) }, deps);
  return { ...w, deps, cycle, precheck };
}
type World = ReturnType<typeof world>;
const nothingUsed = (w: World) => {
  expect(w.invoked).toHaveLength(0);
  expect(w.fake.execs).toBe(0);
  expect(existsSync(join(w.ledgerDir, "approvals"))).toBe(false);
  expect(existsSync(join(w.stateDir, "claims"))).toBe(false);
  expect(readdirSync(w.runsDir)).toEqual([]);
};

describe("the per-direction allowlist: d3 unchanged, d4 its own row", () => {
  it("the d3 row is exactly the approved d3 pilot's allowlist (and the default without a grant)", () => {
    expect(IMAGEFIRST_ALLOWLIST).toBe(IMAGEFIRST_RUNS.d3);
    expect(IMAGEFIRST_RUNS.d3).toMatchObject({ shop: "hoshigama", shopId: "fictional-bakery-hoshigama", direction: "d3", planSha256: "a19b6896ffd50111df9ad7029f49ded5757999ddfb31943103a206f6a44072a8", promptSha256: "291475d9ae66b2308d147a7b56ae1a0c9c53822e44cd5425d60976513712e398", promptChars: 12338, images: { pc: 2, sp: 4 }, packet: P3_PACKET });
    expect(IMAGEFIRST_RUNS.d3.packet.path).toBe("docs/design/image-first-hoshigama-p3-packet.md");
    expect(packetPins(D3_UNAPPROVED)).toEqual({ planSha256: IMAGEFIRST_RUNS.d3.planSha256, promptSha256: IMAGEFIRST_RUNS.d3.promptSha256, promptChars: IMAGEFIRST_RUNS.d3.promptChars });
  });

  it("the d4 row is the plan the builder makes from the repository's inputs, and the d4 packet's own §3", async () => {
    const plan = buildPromptPlan(await loadPromptInputs((p) => readFile(resolve(REPO, p)), "d4"));
    const d4 = IMAGEFIRST_RUNS.d4;
    expect({ plan: plan.plan_sha256, prompt: plan.batch.sha256, chars: plan.batch.chars, shop: plan.shop.shop_id, pc: plan.viewports.desktop_1440.parts.length, sp: plan.viewports.mobile_390.parts.length }).toEqual({ plan: d4.planSha256, prompt: d4.promptSha256, chars: d4.promptChars, shop: d4.shopId, pc: d4.images.pc, sp: d4.images.sp });
    expect(d4).toMatchObject({ planSha256: "0c3849b2d2e22f65601c7c3515028a999eb1ef39256b2fe08681bd8f771338cd", promptSha256: "993d938ab72df308fefef55f84d1fca0b197cb5f913273809dcd7ad464ae7e7e", promptChars: 14408, packet: D4_PACKET });
    for (const bytes of [D4_UNAPPROVED, readFileSync(resolve(REPO, D4_PACKET.path))]) expect(packetPins(bytes, d4)).toEqual({ planSha256: d4.planSha256, promptSha256: d4.promptSha256, promptChars: d4.promptChars });
    // each packet's pins are read only with its own row
    expect(packetPins(D4_UNAPPROVED)).toBeNull();
    expect(packetPins(D3_UNAPPROVED, d4)).toBeNull();
  });

  it("an approval id names exactly one row; the dummy date and other directions are never a real run's", async () => {
    expect(runOfApprovalId(ID)?.direction).toBe("d3");
    expect(runOfApprovalId(D4_ID)?.direction).toBe("d4");
    for (const bad of ["hoshigama-imagefirst-d1-20261120-01", "hoshigama-imagefirst-d2-20261120-01", "hoshigama-imagefirst-d5-20261120-01", "tsugute-imagefirst-d4-20261120-01", `${D4_ID}\n`, "hoshigama-imagefirst-p4-20261120"]) {
      expect(runOfApprovalId(bad), bad).toBeNull();
      expect(checkRealApprovalId(bad), bad).toBe("APPROVAL_ID_INVALID");
      expect(RUN_APPROVAL_ID_RE.test(bad), bad).toBe(false);
    }
    expect(checkRealApprovalId(D4_ID)).toBe("ok");
    expect(checkRealApprovalId("hoshigama-imagefirst-d4-00000000-00")).toBe("APPROVAL_ID_RESERVED");
    expect(checkRealApprovalId("hoshigama-imagefirst-d4-20261332-01")).toBe("APPROVAL_ID_INVALID");
    expect(grantFromEnv({ [GRANT_ENV]: D4_ID } as unknown as NodeJS.ProcessEnv)).toBe(D4_ID);
    expect(grantFromEnv({ [GRANT_ENV]: "hoshigama-imagefirst-d4-00000000-01" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    const state = tmp("sr-ifd4-claim-");
    expect(await claimApproval(state, "hoshigama-imagefirst-d4-00000000-00", NOW)).toBe("APPROVAL_ID_RESERVED");
    expect(existsSync(join(state, "claims"))).toBe(false);
    // plan ids: each row its own form
    expect(IMAGEFIRST_RUNS.d4.planId.test(D4_PLAN_ID)).toBe(true);
    expect(IMAGEFIRST_RUNS.d4.planId.test("hoshigama-imagefirst-p3-20261120")).toBe(false);
    expect(IMAGEFIRST_RUNS.d3.planId.test(D4_PLAN_ID)).toBe(false);
  });

  it("the entry's arguments for d4: its direction, its packet and its pins; d3's unchanged", () => {
    const o = { repoRoot: "/r", outDir: "/o/run", planId: D4_PLAN_ID, approvalId: D4_ID, expires: "2026-11-20T09:00:00Z", packetSha256: "a".repeat(64), commit: "b".repeat(40) };
    const args = parseArgs(generateArgv(o, IMAGEFIRST_RUNS.d4), FLAGS, VALUES);
    expect([...args!.keys()].sort()).toEqual([...FLAGS, ...VALUES].sort());
    expect(Object.fromEntries(args!)).toMatchObject({ "--direction": "d4", "--packet": `/r/${D4_PACKET.path}`, "--expected-plan-sha256": IMAGEFIRST_RUNS.d4.planSha256, "--expected-prompt-sha256": IMAGEFIRST_RUNS.d4.promptSha256, "--expected-prompt-chars": "14408" });
    expect(generateArgv(o)).toEqual(generateArgv(o, IMAGEFIRST_RUNS.d3));
    expect(Object.fromEntries(parseArgs(generateArgv(o), FLAGS, VALUES)!)).toMatchObject({ "--direction": "d3", "--packet": `/r/${APPROVAL_PACKET_PATH}`, "--expected-prompt-chars": "12338" });
  });
});

describe("d4 runs only with its own approved packet and a grant naming a d4 id (fake Codex)", () => {
  it("approved d4 packet + d4 grant: one invocation of the entry as d4, a d4 receipt; the d3 packet stays untouched", async () => {
    const w = world(repoWith(D3_UNAPPROVED, filledD4Packet()));
    expect(await w.precheck(D4_ID)).toMatchObject({ status: "would_run", approval_id: D4_ID });
    const report = await w.cycle(D4_ID);
    expect(report).toMatchObject({ status: "succeeded", code: null, invoked: true, approval_id: D4_ID });
    expect(w.invoked).toHaveLength(1);
    expect(Object.fromEntries(parseArgs(w.invoked[0]!, FLAGS, VALUES)!)).toMatchObject({ "--direction": "d4", "--packet": join(w.repo, D4_PACKET.path), "--approval-id": D4_ID, "--plan-id": D4_PLAN_ID });
    expect(w.fake.execs).toBe(1);
    const receipt = JSON.parse(readFileSync(report.receipt!, "utf8")) as WorkerReceipt;
    expect(receipt).toMatchObject({ status: "succeeded", verified: true, direction: "d4", shop: "hoshigama", approval_id: D4_ID, plan_id: D4_PLAN_ID, plan_sha256: IMAGEFIRST_RUNS.d4.planSha256, prompt_sha256: IMAGEFIRST_RUNS.d4.promptSha256, prompt_chars: 14408, counts: { pc: 2, sp: 4, total: 6, stopped: 0 } });
    expect(receipt.packet_sha256).toBe(sha(readFileSync(join(w.repo, D4_PACKET.path))));
    expect(readdirSync(join(w.ledgerDir, "approvals"))).toEqual([D4_ID]);
    // never twice
    expect(await w.cycle(D4_ID)).toMatchObject({ status: "refused", code: "APPROVAL_ALREADY_CLAIMED", invoked: false });
    expect(w.invoked).toHaveLength(1);
    // the approval as committed, read for the d4 row only
    expect(await readApprovalAt(receipt.commit, w.deps.fileAt, Date.parse(receipt.timings.started_at), IMAGEFIRST_RUNS.d4)).toMatchObject({ approvalId: D4_ID, planId: D4_PLAN_ID, packetSha256: receipt.packet_sha256 });
    expect(await readApprovalAt(receipt.commit, w.deps.fileAt)).toEqual({ code: "PACKET_NOT_APPROVED" });
  });

  it("without a grant (a run by hand) the cycle reads only the d3 row: an approved d4 packet is no job for it", async () => {
    const w = world(repoWith(D3_UNAPPROVED, filledD4Packet()));
    expect(await w.cycle()).toMatchObject({ status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false });
    nothingUsed(w);
  });

  it("while the d4 packet is unapproved (the fixture, and the repository's own packet while its header says 未承認), a d4 grant is no job", async () => {
    const w = world(repoWith(filledPacket(), D4_UNAPPROVED));
    expect(await w.cycle(D4_ID)).toMatchObject({ status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false });
    nothingUsed(w);
    const real = readFileSync(resolve(REPO, D4_PACKET.path));
    const header = real.toString("utf8").slice(0, real.toString("utf8").indexOf("\n## "));
    if (header.includes("**状態: 未承認。**")) {
      expect(readApprovalPacket(real, D4_PACKET)).toBeNull();
      const r = world(repoWith(filledPacket(), real));
      expect(await r.cycle(D4_ID)).toMatchObject({ status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false });
      nothingUsed(r);
    } else {
      // once the owner approved it: d4 alone, with a d4 id and a d4 plan id
      const p = readApprovalPacket(real, D4_PACKET);
      expect(p?.directions).toEqual(["d4"]);
      expect(runOfApprovalId(p!.approvalIds.d4!)?.direction).toBe("d4");
      expect(IMAGEFIRST_RUNS.d4.planId.test(p!.planId)).toBe(true);
    }
  });

  it("cross-direction ids never run: a d3 grant cannot use the d4 packet, a d3 id in the d4 packet is refused", async () => {
    // an approved d4 packet, an unapproved P3 packet: a d3 grant reads the P3 packet only
    const a = world(repoWith(D3_UNAPPROVED, filledD4Packet()));
    expect(await a.cycle(ID)).toMatchObject({ status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false });
    nothingUsed(a);
    // an approved d3 packet, an unapproved d4 packet: a d4 grant never falls back to d3
    const b = world(repoWith(filledPacket(), D4_UNAPPROVED));
    expect(await b.cycle(D4_ID)).toMatchObject({ status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false });
    nothingUsed(b);
    // a d3 id written into the d4 packet's d4 row
    const c = world(repoWith(D3_UNAPPROVED, filledD4Packet({ d4: `\`${ID}\`` })));
    expect(await c.cycle(D4_ID)).toMatchObject({ status: "refused", code: "SHOP_NOT_ALLOWED", invoked: false });
    nothingUsed(c);
    // another d4 id than the grant's
    const d = world(repoWith(D3_UNAPPROVED, filledD4Packet({ d4: "`hoshigama-imagefirst-d4-20261120-02`" })));
    expect(await d.cycle(D4_ID)).toMatchObject({ status: "refused", code: "APPROVAL_NOT_GRANTED", invoked: false });
    nothingUsed(d);
    // a grant that names no row (the cycle used directly) runs nothing
    const e = world(repoWith(D3_UNAPPROVED, filledD4Packet()));
    expect(await e.cycle("hoshigama-imagefirst-d1-20261120-01")).toMatchObject({ status: "refused", code: "GRANT_INVALID", invoked: false });
    nothingUsed(e);
  });

  it("the d4 packet's own rules: d4 alone, a p4 plan id, its §3 pins, not the reserved date", async () => {
    const cases: [Partial<D4Fill>, string, string][] = [
      [{ directions: "`d3`" }, "no_job", "PACKET_NOT_APPROVED"],
      [{ directions: "`d3,d4`" }, "no_job", "PACKET_NOT_APPROVED"],
      [{ d4: "`なし`" }, "no_job", "PACKET_NOT_APPROVED"],
      [{ planId: "`hoshigama-imagefirst-p3-20261120`" }, "refused", "PLAN_ID_INVALID"],
      [{ expires: "`2026-11-21T01:00:01Z`" }, "refused", "APPROVAL_EXPIRY_TOO_FAR"],
    ];
    for (const [fill, status, code] of cases) {
      const w = world(repoWith(D3_UNAPPROVED, filledD4Packet(fill)));
      expect(await w.cycle(D4_ID), JSON.stringify(fill)).toMatchObject({ status, code, invoked: false });
      nothingUsed(w);
    }
    // the reserved date cannot even be a grant (grantFromEnv refuses it), so it is checked on the committed d4 packet
    const reserved = world(repoWith(D3_UNAPPROVED, filledD4Packet({ d4: "`hoshigama-imagefirst-d4-00000000-00`" })));
    expect(await readApprovalAt(git(reserved.repo, "rev-parse", "HEAD"), reserved.deps.fileAt, undefined, IMAGEFIRST_RUNS.d4)).toEqual({ code: "APPROVAL_ID_RESERVED" });
    const pin = IMAGEFIRST_RUNS.d4.planSha256;
    const tampered = world(repoWith(D3_UNAPPROVED, filledD4Packet({}, (t) => t.replace(pin, "0".repeat(64)))));
    expect(await tampered.cycle(D4_ID)).toMatchObject({ status: "refused", code: "PACKET_PIN_MISMATCH", invoked: false });
    nothingUsed(tampered);
  });
});

describe("a finished d4 run is delivered as d4 only", () => {
  it("delivered with its own direction; a receipt that claims the other direction is refused before anything is sealed", async () => {
    const home = tmp("sr-ifd4-home-");
    chmodSync(home, 0o700);
    const runsDir = join(home, "sr-runs");
    mkdirSync(runsDir, { mode: 0o700 });
    const repo = repoWith(D3_UNAPPROVED, filledD4Packet());
    const w = world(repo);
    const stateDir = join(home, "state");
    const report = await runImagefirstCycle({ repoRoot: repo, stateDir, runsDir, expectApprovalId: D4_ID }, w.deps);
    expect(report).toMatchObject({ status: "succeeded", approval_id: D4_ID });
    const deps = { fileAt: w.deps.fileAt, onOriginDevelop: async (c: string) => spawnSync("git", ["merge-base", "--is-ancestor", c, "origin/develop"], { cwd: repo }).status === 0 };
    const original = readFileSync(report.receipt!);
    const receipt = JSON.parse(original.toString("utf8")) as WorkerReceipt;

    // the receipt rewritten to say d3 (with d3's pins): refused by the delivery, and by the bundle itself
    writeFileSync(report.receipt!, `${JSON.stringify({ ...receipt, direction: "d3", plan_sha256: IMAGEFIRST_RUNS.d3.planSha256, prompt_sha256: IMAGEFIRST_RUNS.d3.promptSha256, prompt_chars: IMAGEFIRST_RUNS.d3.promptChars }, null, 2)}\n`);
    const code = await deliverReview({ approvalId: D4_ID, runsDir, stateDir, now: () => NOW }, deps).then(() => "OK", (e: unknown) => (e instanceof ReviewStop ? e.code : String(e)));
    expect(code).toBe("RECEIPT_ALLOWLIST_MISMATCH");
    const packed = await packBundle({ runDir: report.run_dir!, receiptPath: report.receipt!, bundlesDir: join(home, "other-bundles"), now: () => NOW }).then(() => "OK", (e: unknown) => (e instanceof BundleStop ? e.code : String(e)));
    expect(packed).toBe("RECEIPT_INVALID");
    expect(existsSync(join(runsDir, "bundles")) ? readdirSync(join(runsDir, "bundles")) : []).toEqual([]);

    // the receipt as written: delivered, the manifest names d4
    writeFileSync(report.receipt!, original);
    const summary = await deliverAfterRun(report, { runsDir, stateDir, now: () => NOW }, deps);
    expect(summary).toMatchObject({ status: "delivered", code: null });
    const v = await verifyBundleDir(join(runsDir, "review-inbox", D4_ID), { expected: { approval_id: D4_ID, plan_id: D4_PLAN_ID, commit: receipt.commit } });
    expect(v.manifest).toMatchObject({ direction: "d4", shop: "hoshigama", plan_sha256: IMAGEFIRST_RUNS.d4.planSha256 });
  });
});
