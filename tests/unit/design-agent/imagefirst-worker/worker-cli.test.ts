import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runBounded } from "@/lib/design-agent/bounded-process";

// Issue #302 P0 (PR #301 review L2): the IMAGE_FIRST worker CLI started as a real process, in a scratch HOME, and the
// split-UTF-8 fix of runBounded. The CLI never gets an approved packet here: every run refuses (or finds no job) before
// anything is claimed or invoked. No Codex, no model, no network.

const REPO = resolve(__dirname, "../../../..");
const CLI = join(REPO, "scripts/sales-design-worker/imagefirst-worker.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");
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
  const r = spawnSync(TSX, [CLI, ...args], { cwd: REPO, encoding: "utf8", env: { ...PATH_ONLY, HOME: home, ...extra }, timeout: 50_000 });
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

/** What the commit gate must answer for this checkout (CI checkouts differ from a developer clone). */
function expectedGate(): { status: string; code: string; exit: number } {
  const git = (...a: string[]) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  const base = git("rev-parse", "origin/develop");
  if (head.status !== 0 || base.status !== 0) return { status: "refused", code: "COMMIT_UNREADABLE", exit: 2 };
  if (head.stdout.trim() !== base.stdout.trim()) return { status: "refused", code: "NOT_ON_ORIGIN_DEVELOP", exit: 2 };
  if (git("status", "--porcelain", "--untracked-files=all").stdout !== "") return { status: "refused", code: "TREE_DIRTY", exit: 2 };
  // on origin/develop and clean: the committed packet is unapproved (PR #300 is owner-merge-only)
  return { status: "no_job", code: "PACKET_NOT_APPROVED", exit: 0 };
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

  it("this checkout is not an approved worker clone: the commit gate refuses (e.g. NOT_ON_ORIGIN_DEVELOP), audit 0600, nothing claimed", () => {
    const want = expectedGate();
    const r = runCli([]);
    expect(r.status).toBe(want.exit);
    expect(r.out).toEqual({ status: want.status, code: want.code, invoked: false });
    const audit = join(stateOf(r.home), "audit.jsonl");
    expect(statSync(audit).mode & 0o777).toBe(0o600);
    expect(statSync(stateOf(r.home)).mode & 0o777).toBe(0o700);
    // the lock was released
    expect(existsSync(join(stateOf(r.home), "imagefirst.lock"))).toBe(false);
    nothingUsed(r.home);
  });
});

describe("Issue #302 P1: the worker's --precheck as a real process (no lock, no audit, no write)", () => {
  it("answers the same gates with the precheck exit (2 refused / 3 no job) and creates nothing in HOME", () => {
    const want = expectedGate();
    const r = runCli(["--precheck"]);
    expect(r.status).toBe(want.status === "no_job" ? 3 : 2);
    expect(r.out).toEqual({ status: want.status, code: want.code, invoked: false });
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
