import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runBounded } from "@/lib/design-agent/bounded-process";
import { IMAGEFIRST_ALLOWLIST, PRECHECK_MIN_LEFT_MS, tsEntry } from "@/lib/design-agent/imagefirst-worker/cycle";
import { ownJailUnit } from "@/lib/design-agent/imagefirst-worker/jail-state";
import { MAX_APPROVAL_WINDOW_MS, parseUtcInstant, readApprovalPacket } from "@/lib/design-agent/phase2f-live/full-page-call";

// Issue #302 P0 (PR #301 review L2): the IMAGE_FIRST worker CLI started as a real process, in a scratch HOME, and the
// split-UTF-8 fix of runBounded. Every run here refuses (or finds no job) before anything is claimed or invoked; when the
// committed packet is approved and inside its window (a clean origin/develop checkout, e.g. CI on develop), the real run is
// not started at all and only the write-free precheck runs. No Codex, no model, no network.

const REPO = resolve(__dirname, "../../../..");
const CLI = join(REPO, "scripts/sales-design-worker/imagefirst-worker.ts");
const PROBE = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/signal-probe.ts");
const PATH_ONLY = { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv;
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

/** The CLI as a process with only PATH and a scratch HOME (plus what the test adds). */
function runCli(args: string[], extra: Record<string, string> = {}) {
  const home = tmp("sr-ifw-cli-home-");
  // started as the runbook says: node with the tsx loader (never the tsx CLI, which relays signals a second time)
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO, encoding: "utf8", env: { ...PATH_ONLY, HOME: home, ...extra }, timeout: 50_000 });
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  return { home, status: r.status, out: JSON.parse(lines[lines.length - 1] ?? "null") as { status: string; code: string | null; invoked: boolean } | null, lines };
}
const stateOf = (home: string) => join(home, ".local", "state", "sr-design-worker", "imagefirst-worker");
/** Nothing was claimed, no run directory exists, the entry's ledger was never opened for writing. */
function nothingUsed(home: string) {
  expect(existsSync(join(stateOf(home), "claims"))).toBe(false);
  expect(existsSync(join(home, "sr-runs")) ? readdirSync(join(home, "sr-runs")) : []).toEqual([]);
  expect(existsSync(join(home, ".local", "state", "sr-design-worker", "phase2f-live", "approvals"))).toBe(false);
}

/**
 * What the CLI must answer for this checkout (CI checkouts differ from a developer clone). DEV-302: first the jail guard,
 * with the CLI's own reader (the spawned CLI runs in this process's cgroup): inside a requester jail unit (the suite run by
 * the jailed Claude or `admin.sh run`) RUN_INSIDE_JAIL_UNIT, where /proc/self/cgroup cannot be read OWN_CGROUP_UNREADABLE.
 */
type CliOut = { status: string; code: string | null; invoked: false; approval_id?: string; expires_at?: string };
/** The exact expected output of the run (or "skip": never start it) and of --precheck, with their exit codes. */
type Gate = { run: { exit: number; out: CliOut } | "skip"; precheck: { exit: number; out: CliOut } | "skip"; why: string };
const both = (exit: number, out: CliOut, precheckExit = exit): Gate => ({ run: { exit, out }, precheck: { exit: precheckExit, out }, why: out.code ?? out.status });
/** Within this distance of a gate boundary the test and the worker could read the clock on different sides: skip. */
const BOUNDARY_MARGIN_MS = 60_000;

async function expectedGate(): Promise<Gate> {
  const refused = (code: string, approvalId?: string): CliOut => ({ status: "refused", code, invoked: false, ...(approvalId ? { approval_id: approvalId } : {}) });
  const unit = await ownJailUnit();
  if (unit === "unknown") return both(2, refused("OWN_CGROUP_UNREADABLE"));
  if (unit !== null) return both(2, refused("RUN_INSIDE_JAIL_UNIT"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  const base = git("rev-parse", "origin/develop");
  if (head.status !== 0 || base.status !== 0) return both(2, refused("COMMIT_UNREADABLE"));
  if (head.stdout.trim() !== base.stdout.trim()) return both(2, refused("NOT_ON_ORIGIN_DEVELOP"));
  if (git("status", "--porcelain", "--untracked-files=all").stdout !== "") return both(2, refused("TREE_DIRTY"));
  // On origin/develop and clean (CI's push runs on develop): a run by hand reads the d3 row's packet as committed. Since
  // PR #315 that packet is approved, so the answer depends on its expiry (Issue #302: the test used to assume an
  // unapproved packet and failed on every develop push). Refusals after the id check carry approval_id (cycle.ts refuse).
  // Inside the window the real cycle would claim and invoke: the run is never started by this test.
  const shown = git("show", `${head.stdout.trim()}:${IMAGEFIRST_ALLOWLIST.packet.path}`);
  const packet = shown.status === 0 ? readApprovalPacket(Buffer.from(shown.stdout, "utf8"), IMAGEFIRST_ALLOWLIST.packet) : null;
  if (!packet) return both(0, { status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false }, 3);
  const id = packet.approvalIds.d3 ?? "";
  const expires = parseUtcInstant(packet.expires);
  if (expires === null) return both(2, refused("APPROVAL_EXPIRY_INVALID", id));
  const left = expires - Date.now();
  const near = [0, PRECHECK_MIN_LEFT_MS, MAX_APPROVAL_WINDOW_MS].some((edge) => Math.abs(left - edge) < BOUNDARY_MARGIN_MS);
  if (near) return { run: "skip", precheck: "skip", why: "within a minute of a gate boundary" };
  if (left < 0) return both(2, refused("APPROVAL_EXPIRED", id));
  if (left > MAX_APPROVAL_WINDOW_MS) return both(2, refused("APPROVAL_EXPIRY_TOO_FAR", id));
  // inside the window: the run would claim and invoke (skipped); the precheck answers without writing
  if (left < PRECHECK_MIN_LEFT_MS) return { run: "skip", precheck: { exit: 2, out: refused("APPROVAL_EXPIRES_SOON", id) }, why: "inside the window" };
  return { run: "skip", precheck: { exit: 0, out: { status: "would_run", code: null, invoked: false, approval_id: id, expires_at: packet.expires } }, why: "inside the window" };
}

describe("Issue #302 P0: the IMAGE_FIRST worker CLI as a real process (nothing invoked)", () => {
  it("any argument is USAGE, exit 2, before any place is touched", () => {
    const r = runCli(["--approval-id", "x"]);
    expect(r.status).toBe(2);
    expect(r.out).toEqual({ status: "refused", code: "USAGE", invoked: false });
    expect(r.lines).toHaveLength(1);
    expect(existsSync(stateOf(r.home))).toBe(false);
    nothingUsed(r.home);
  });

  it("a state dir inside the repository is PLACE_INSIDE_REPO, exit 2, and nothing is created there", () => {
    const inside = join(REPO, `.sr-ifw-cli-test-${process.pid}-does-not-exist`);
    const r = runCli([], { XDG_STATE_HOME: inside });
    expect(r.status).toBe(2);
    expect(r.out).toEqual({ status: "refused", code: "PLACE_INSIDE_REPO", invoked: false });
    expect(existsSync(inside)).toBe(false);
    nothingUsed(r.home);
  });

  it("this checkout is not an approved worker clone: the commit gate refuses (e.g. NOT_ON_ORIGIN_DEVELOP), audit 0600, nothing claimed", async () => {
    const gate = await expectedGate();
    if (gate.run === "skip") {
      // never start a real run from a test (inside an approval window it would claim and invoke)
      console.warn(`worker-cli: the real run is not started by this test (${gate.why})`);
      return;
    }
    const want = gate.run;
    const r = runCli([]);
    expect(r.status).toBe(want.exit);
    expect(r.out).toEqual(want.out);
    if (want.out.code === "RUN_INSIDE_JAIL_UNIT" || want.out.code === "OWN_CGROUP_UNREADABLE") {
      // refused by the jail guard, before the state dir, the lock and the audit line
      expect(readdirSync(r.home)).toEqual([]);
      return;
    }
    const audit = join(stateOf(r.home), "audit.jsonl");
    expect(statSync(audit).mode & 0o777).toBe(0o600);
    expect(statSync(stateOf(r.home)).mode & 0o777).toBe(0o700);
    // the lock was released
    expect(existsSync(join(stateOf(r.home), "imagefirst.lock"))).toBe(false);
    nothingUsed(r.home);
  });
});

describe("Issue #302 P1: the worker's --precheck as a real process (no lock, no audit, no write)", () => {
  it("answers the same gates with the precheck exit (2 refused / 3 no job) and creates nothing in HOME", async () => {
    const gate = await expectedGate();
    if (gate.precheck === "skip") {
      console.warn(`worker-cli: precheck not compared (${gate.why})`);
      return;
    }
    const r = runCli(["--precheck"]);
    expect(r.status).toBe(gate.precheck.exit);
    expect(r.out).toEqual(gate.precheck.out);
    // nothing at all under the scratch HOME: no state dir, no audit line, no runs dir
    expect(readdirSync(r.home)).toEqual([]);
  });

  it("--precheck with anything else is USAGE; a malformed grant is GRANT_INVALID, both before any place is touched", () => {
    const usage = runCli(["--precheck", "--now"]);
    expect(usage.status).toBe(2);
    expect(usage.out).toEqual({ status: "refused", code: "USAGE", invoked: false });
    const bad = runCli(["--precheck"], { SR_IMAGEFIRST_EXPECT_APPROVAL_ID: "tsugute-imagefirst-d3-20261120-01" });
    expect(bad.status).toBe(2);
    expect(bad.out).toEqual({ status: "refused", code: "GRANT_INVALID", invoked: false });
    expect(readdirSync(bad.home)).toEqual([]);
  });
});

describe("Issue #298 fix kept: runBounded decodes a UTF-8 character split across two pipe reads", () => {
  it("あいう×3 written in two chunks, split inside a character, comes back intact (no U+FFFD)", async () => {
    const text = "あいう".repeat(3);
    const bytes = Buffer.from(text, "utf8");
    // cut inside the second character's three bytes, with a pause so the two halves arrive as separate reads
    const script = `const b=Buffer.from(${JSON.stringify(text)},"utf8");process.stdout.write(b.subarray(0,4));setTimeout(()=>process.stdout.write(b.subarray(4)),150);`;
    expect(bytes.length).toBe(27);
    const r = await runBounded(process.execPath, ["-e", script], { env: PATH_ONLY, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(text);
    expect(r.stdout).not.toContain("�");
    // stderr is decoded the same way
    const e = await runBounded(process.execPath, ["-e", script.replaceAll("process.stdout", "process.stderr")], { env: PATH_ONLY, timeoutMs: 10_000 });
    expect(e.stderr).toBe(text);
  });
});

describe("Issue #302 review M4: one stop is one signal (node --import tsx, not the tsx CLI)", () => {
  const until = async (cond: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("the worker starts the entry as node --import tsx (no tsx CLI parent in its process group)", () => {
    expect(tsEntry("/r/e.ts", ["--x", "1"])).toEqual({ bin: process.execPath, args: ["--import=tsx", "/r/e.ts", "--x", "1"] });
    const worker = readFileSync(CLI, "utf8");
    expect(worker).toMatch(/runBounded\(tsEntry\(join\(REPO, GENERATE_ENTRY\), argv\)\.bin, tsEntry\(join\(REPO, GENERATE_ENTRY\), argv\)\.args, \{ cwd: REPO,/);
    expect(worker).not.toMatch(/node_modules\/\.bin\/tsx"/);
    // the runbook's manual start (Ctrl-C reaches node once)
    const doc = readFileSync(join(REPO, "docs/operations/imagefirst-worker-port.md"), "utf8");
    expect(doc).not.toMatch(/^\.\/node_modules\/\.bin\/tsx scripts\/sales-design-worker\/imagefirst-worker\.ts/m);
    expect(doc).toMatch(/^node --import tsx scripts\/sales-design-worker\/imagefirst-worker\.ts$/m);
  });

  it("runBounded's abort reaches an entry started that way exactly once, even with a busy event loop", async () => {
    for (let i = 0; i < 3; i++) {
      const out = join(tmp("sr-ifw-probe-"), "count");
      const c = new AbortController();
      const e = tsEntry(PROBE, [out, "count"]);
      const run = runBounded(e.bin, e.args, { cwd: REPO, env: PATH_ONLY, timeoutMs: 30_000, graceMs: 5_000, signal: c.signal });
      await until(() => existsSync(`${out}.ready`));
      c.abort();
      const r = await run;
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("1");
    }
  });

  it("the worker's stop: a signal repeated within 1 s is the same stop (graceful); a later one is the hard stop", async () => {
    const probe = async (gapMs: number) => {
      const out = join(tmp("sr-ifw-probe-"), "stop");
      const child = spawn(process.execPath, ["--import", "tsx", PROBE, out, "stop"], { cwd: REPO, env: PATH_ONLY, stdio: "ignore" });
      const done = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
      await until(() => existsSync(`${out}.ready`));
      child.kill("SIGTERM");
      // the gap is measured from the moment the probe took the first signal (its "abort" line), not from the send:
      // under load the first handler can run late, which would shrink a gap measured from the send
      if (gapMs > 100) await until(() => existsSync(out) && readFileSync(out, "utf8").includes("abort"));
      await new Promise((r) => setTimeout(r, gapMs));
      child.kill("SIGTERM");
      const code = await done;
      return { code, text: readFileSync(out, "utf8") };
    };
    expect(await probe(20)).toEqual({ code: 0, text: "abort\ngraceful\n" });
    expect(await probe(1_500)).toEqual({ code: 1, text: "abort\nhard\n" });
  });
});
