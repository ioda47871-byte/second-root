import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { generateImagesInOneRun } from "@/lib/design-agent/design-image/image-once";
import { buildPromptPlan, loadPromptInputs, PROMPT_INPUTS, PromptStop, type DirectionKey } from "@/lib/design-agent/image-first/prompt";
import { exitCodeOf, generateArgv, gitCommitState, IMAGEFIRST_ALLOWLIST, packetPins, runImagefirstCycle, type CycleDeps, type WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { APPROVAL_PACKET_PATH, PACKET_FIELDS, runFullPageCall } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { CodexSandbox } from "@/lib/design-agent/sandbox";
import { childEnvironment } from "@/lib/design-agent/worker/env";
import { acquireLock } from "@/lib/design-agent/worker/state";
import { fileAtCommit, parseArgs } from "@/scripts/design-artifact/phase2f-live-cli";
import { colourPng } from "../phase2f/fixtures";
import { UNAPPROVED_PACKET_FIXTURE } from "../image-first/fixtures/unapproved-packet";

// Issue #298 P1: the IMAGE_FIRST worker adapter, end to end against a FAKE Codex. The worker cycle runs against a
// temporary git repository (its own origin/develop) holding a filled-in d3 packet built here (never committed to this
// repository) and the three prompt inputs. The existing entry is played in-process exactly as
// scripts/design-artifact/image-first-generate.ts main() does (same flags, same runFullPageCall, same batch mapping),
// with generateImagesInOneRun driven by the in-process fake sandbox the image-once tests use. No Codex, no model, no
// image tool, no network, no bubblewrap.

const REPO = resolve(__dirname, "../../../..");
vi.setConfig({ testTimeout: 60_000 });
const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const NOW = Date.parse("2026-11-20T01:00:00Z");
const ID = "hoshigama-imagefirst-d3-20261120-01";
const PLAN_ID = "hoshigama-imagefirst-p3-20261120";
const THREAD = "0f0e0d0c-0b0a-4908-8706-050403020100";
const ENV = childEnvironment(process.env);

/** The entry's flag sets, read from its source (a drift between the adapter's arguments and the entry fails here). */
const ENTRY = readFileSync(resolve(REPO, "scripts/design-artifact/image-first-generate.ts"), "utf8");
const setOf = (name: string) => new Set([...(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(ENTRY)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
const FLAGS = setOf("FLAGS");
const VALUES = setOf("VALUES");

// ---- the filled-in packet (in memory; written only into the temporary repository) ----------------------------------
type Fill = Record<keyof typeof PACKET_FIELDS, string>;
const D3: Fill = { status: "`承認済み`", directions: "`d3`", d1: "`なし`", d3: `\`${ID}\``, expires: "`2026-11-20T09:00:00Z`", planId: `\`${PLAN_ID}\``, approvedBy: "2026-11-20 owner (test)" };
function filledPacket(values: Partial<Fill> = {}, edit: (t: string) => string = (t) => t): Buffer {
  let text = readFileSync(UNAPPROVED_PACKET_FIXTURE, "utf8").replace("**状態: 未承認。**", "**状態: 承認済み。**");
  const at = text.indexOf("## 10. 承認欄");
  let section = text.slice(at);
  for (const [k, label] of Object.entries(PACKET_FIELDS) as [keyof Fill, string][]) {
    const re = new RegExp(`^(\\| ${label}(?:（[^|]*)? \\| ).*( \\|)$`, "m");
    expect(re.test(section), label).toBe(true);
    section = section.replace(re, `$1${values[k] ?? D3[k]}$2`);
  }
  text = text.slice(0, at) + section;
  return Buffer.from(edit(text));
}

// ---- the temporary worker clone ----------------------------------------------------------------------------------
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
function commitFiles(repo: string, files: Record<string, Buffer>, msg: string) {
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), bytes);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}
function workerRepo(packet: Buffer = filledPacket()): string {
  const repo = tmp("sr-ifw-repo-");
  git(repo, "init", "-q");
  const inputs = [PROMPT_INPUTS.factsPack.path, PROMPT_INPUTS.directionSet.path, PROMPT_INPUTS.principles.path];
  for (const p of inputs) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    cpSync(resolve(REPO, p), join(repo, p));
  }
  const head = commitFiles(repo, { [APPROVAL_PACKET_PATH]: packet }, "approved packet (test)");
  git(repo, "update-ref", "refs/remotes/origin/develop", head);
  return repo;
}
const pointOrigin = (repo: string) => git(repo, "update-ref", "refs/remotes/origin/develop", git(repo, "rev-parse", "HEAD"));

// ---- the fake Codex (the image-once tests' in-process sandbox) ----------------------------------------------------
type Fake = { execs: number; codexHome: string; tmpBase: string; sandbox: CodexSandbox };
const ok = (stdout = ""): BoundedResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
function fakeCodex(mode: "six" | "fail"): Fake {
  const root = tmp("sr-ifw-codex-");
  const codexHome = join(root, "home", ".codex");
  const tmpBase = join(root, "tmp");
  for (const d of [codexHome, tmpBase]) mkdirSync(d, { recursive: true });
  const f: Fake = {
    execs: 0,
    codexHome,
    tmpBase,
    sandbox: {
      env: { HOME: join(root, "home"), CODEX_HOME: codexHome },
      async run(a, o) {
        if (a[0] === "login") return ok("Logged in using ChatGPT\n");
        if (a[0] === "--version") return ok("codex-cli 0.163.0\n");
        f.execs += 1;
        if (mode === "fail") return { ...ok(), code: 1, stderr: "fake failure" };
        // what the CLI leaves: a session log with one completed image call per picture, and the pictures (PC 2 + SP 4)
        const sessions = join(codexHome, "sessions", "2026", "11", "20");
        mkdirSync(sessions, { recursive: true });
        const recs = [
          { type: "session_meta", payload: { id: THREAD, cwd: o.workDir, cli_version: "0.163.0", model_provider: "fake" } },
          { type: "turn_context", payload: { cwd: o.workDir, model: "fake-session" } },
          ...Array.from({ length: 6 }, (_, i) => ({ type: "response_item", payload: { type: "image_generation_call", id: `ig_${i}`, status: "completed" } })),
        ];
        writeFileSync(join(sessions, `rollout-2026-11-20T01-00-00-${THREAD}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
        const dir = join(codexHome, "generated_images", THREAD);
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 6; i++) {
          const p = join(dir, `ig_${i}.png`);
          writeFileSync(p, colourPng(1024 + i, 1536));
          const t = new Date(Date.UTC(2026, 10, 20, 1, 0, i));
          utimesSync(p, t, t);
        }
        return ok(`${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`);
      },
    },
  };
  return f;
}

/** image-first-generate.ts main(), in-process: the same flags, checks, runFullPageCall and batch mapping; exit 0 / 2 / 1. */
async function entryInProcess(argv: string[], w: { repo: string; ledgerDir: string; fake: Fake; signal?: AbortSignal }): Promise<BoundedResult> {
  const line = (o: object, code: number): BoundedResult => ({ code, signal: null, stdout: `${JSON.stringify(o)}\n`, stderr: "", timedOut: false });
  const args = parseArgs(argv, FLAGS, VALUES);
  const chars = Number(args?.get("--expected-prompt-chars"));
  const key = args?.get("--direction");
  if (!args || [...VALUES].some((f) => !args.has(f)) || !Number.isInteger(chars) || (key !== "d1" && key !== "d3")) return line({ status: "refused", code: "USAGE" }, 2);
  let inputs;
  let plan;
  try {
    inputs = await loadPromptInputs((p) => readFile(resolve(w.repo, p)), key as DirectionKey);
    plan = buildPromptPlan(inputs);
  } catch (error) {
    return line({ status: "refused", code: error instanceof PromptStop ? error.code : "INPUT_UNREADABLE" }, 2);
  }
  const result = await runFullPageCall(
    {
      plan,
      inputs,
      packetPath: resolve(args.get("--packet")!),
      humanApprovalConfirmed: args.has("--human-approval-confirmed"),
      approvalId: args.get("--approval-id")!,
      planId: args.get("--plan-id")!,
      approvalExpires: args.get("--approval-expires")!,
      expected: { promptSha256: args.get("--expected-prompt-sha256")!, promptChars: chars, commit: args.get("--expected-commit")!, planSha256: args.get("--expected-plan-sha256")!, packetSha256: args.get("--expected-packet-sha256")! },
      outDir: args.get("--out")!,
      repoRoot: w.repo,
      ...(w.signal ? { signal: w.signal } : {}),
    },
    {
      ledger: openLedger(w.ledgerDir),
      commit: () => gitCommitState(w.repo, ENV),
      packetAt: (commit, rel) => fileAtCommit(commit, rel, w.repo),
      preflight: async () => null,
      now: () => NOW,
      batch: async (o) => {
        const r = await generateImagesInOneRun({ sandbox: w.fake.sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: w.fake.tmpBase, maxImages: o.maxImages, ...(o.signal === undefined ? {} : { signal: o.signal }) });
        return { images: r.images, outcome: r.outcome, stopCode: r.stopCode, imageCalls: r.imageCalls, imageFailed: r.imageFailed, imageCallIds: r.imageCallIds ?? [], threadId: r.threadId, cliVersion: r.cliVersion, model: r.model };
      },
    },
  );
  if (result.status === "succeeded") return line({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.runId, images: result.images }, 0);
  return line({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call" }, result.stage === "precheck" ? 2 : 1);
}

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
  const cycle = (invoke?: CycleDeps["invoke"]) => runImagefirstCycle({ repoRoot: repo, stateDir: w.stateDir, runsDir: w.runsDir }, deps(invoke));
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
