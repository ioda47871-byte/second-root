import { execFile, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// scripts/sales-design-worker/run.sh is the worker's one entry point. These
// tests run the real file (copied into a throwaway repo layout) with fake
// git / npm / tsx on PATH, and check its time budget against the systemd
// unit in the runbook.

const run = promisify(execFile);
const REPO = resolve(__dirname, "../../..");
const RUN_SH = join(REPO, "scripts/sales-design-worker/run.sh");
const RUNBOOK = join(REPO, "docs/operations/design-worker-wsl.md");

function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), "srdw-runsh-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const record = join(root, "record.log");
  mkdirSync(join(repo, "scripts/sales-design-worker"), { recursive: true });
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(home);
  cpSync(RUN_SH, join(repo, "scripts/sales-design-worker/run.sh"));
  writeFileSync(join(repo, "package-lock.json"), "{}");
  const tool = (path: string, name: string, extra = "") => {
    writeFileSync(path, `#!/bin/bash\necho "${name} $*" >> '${record}'\n${extra}\nexit 0\n`);
    chmodSync(path, 0o755);
  };
  tool(join(bin, "git"), "git");
  tool(join(bin, "npm"), "npm");
  // the fake worker prints which variables it could see
  tool(
    join(repo, "node_modules/.bin/tsx"),
    "tsx",
    `env | cut -d= -f1 | sort | tr '\\n' ' ' | sed 's/^/env /' >> '${record}'; echo >> '${record}'; echo "ref=\${SR_DESIGN_WORKER_REF:-}" >> '${record}'; if [ -f '${root}/slow' ]; then sleep 3; fi`,
  );
  return { root, repo, bin, home, record, script: join(repo, "scripts/sales-design-worker/run.sh") };
}

const envFor = (f: ReturnType<typeof fakeRepo>, extra: Record<string, string> = {}) => ({
  PATH: `${f.bin}:${process.env.PATH}`,
  HOME: f.home,
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENAI_API_KEY: "sk-test",
  GITHUB_TOKEN: "ghp_test",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  SOME_OTHER_VAR: "y",
  // a caller cannot skip the clean restart with a variable
  SR_DESIGN_WORKER_CLEAN_ENV: "1",
  ...extra,
}) as unknown as NodeJS.ProcessEnv;

describe("run.sh (the real file)", () => {
  it("is valid bash and executable", async () => {
    await run("bash", ["-n", RUN_SH]);
    expect(readFileSync(RUN_SH, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
    const mode = (await import("node:fs")).statSync(RUN_SH).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("pins the checkout to origin/<ref>, installs once, and starts the worker with a budget and a clean environment", async () => {
    const f = fakeRepo();
    const { stdout } = await run(f.script, ["--max=1"], { env: envFor(f, { SR_DESIGN_WORKER_REF: "feature/example" }) });
    expect(stdout).toBe("");
    const log = readFileSync(f.record, "utf8");
    expect(log).toContain("git fetch --quiet --no-tags origin +refs/heads/feature/example:refs/remotes/origin/feature/example");
    expect(log).toContain("git checkout --quiet --force --detach origin/feature/example");
    expect(log).toContain("git clean -q -f -d");
    expect(log).toContain("npm ci --no-audit --no-fund --loglevel=error");
    const tsx = log.split("\n").find((l) => l.startsWith("tsx "))!;
    expect(tsx).toMatch(/scripts\/sales-design-worker\/worker\.ts --max=1 --budget-seconds=(\d+)$/);
    const budget = Number(/--budget-seconds=(\d+)/.exec(tsx)![1]);
    expect(budget).toBeGreaterThan(900);
    expect(budget).toBeLessThanOrEqual(3300 - 120);
    const seen = log.split("\n").find((l) => l.startsWith("env "))!;
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "SOME_OTHER_VAR"]) expect(seen).not.toContain(name);
    expect(seen).toContain("HOME");
    expect(log).toContain("ref=feature/example");
    // state dir is private
    const state = join(f.home, ".local/state/sr-design-worker");
    expect((await import("node:fs")).statSync(state).mode & 0o077).toBe(0);
    // a second run with the same lock file skips npm ci
    writeFileSync(f.record, "");
    await run(f.script, [], { env: envFor(f, { SR_DESIGN_WORKER_REF: "feature/example" }) });
    expect(readFileSync(f.record, "utf8")).not.toContain("npm ci");
  });

  it("defaults to develop and refuses a ref that is not a branch name", async () => {
    const f = fakeRepo();
    await run(f.script, [], { env: envFor(f) });
    expect(readFileSync(f.record, "utf8")).toContain("git checkout --quiet --force --detach origin/develop");
    const bad = await run(f.script, [], { env: envFor(f, { SR_DESIGN_WORKER_REF: "x; rm -rf /" }) }).catch((e: { code: number; stdout: string }) => e);
    expect((bad as { code: number }).code).toBe(2);
  });

  it("runs the checkout as it is with SR_DESIGN_WORKER_NO_UPDATE=1 (no git, no npm)", async () => {
    const f = fakeRepo();
    await run(f.script, ["--max=2"], { env: envFor(f, { SR_DESIGN_WORKER_NO_UPDATE: "1", SR_DESIGN_WORKER_REF: "develop" }) });
    const log = readFileSync(f.record, "utf8");
    expect(log).not.toMatch(/^git |^npm /m);
    expect(log).toContain("--max=2");
    // no ref check without the update
    expect(log).toContain("ref=\n");
  });

  it("does nothing while another run.sh holds the lock", async () => {
    const f = fakeRepo();
    const env = envFor(f, { SR_DESIGN_WORKER_NO_UPDATE: "1" });
    // (run.sh passes the fake worker no unknown variables, so the delay is a file)
    writeFileSync(join(f.root, "slow"), "");
    const first = spawn(f.script, [], { env, stdio: "ignore" as const });
    // wait until the first one is inside the worker
    for (let i = 0; i < 50 && !(existsSync(f.record) && readFileSync(f.record, "utf8").includes("tsx ")); i += 1) await new Promise((r) => setTimeout(r, 100));
    const { stdout } = await run(f.script, [], { env });
    expect(stdout).toContain("another run.sh is running");
    await new Promise((r) => first.once("exit", r));
    expect(readFileSync(f.record, "utf8").match(/^tsx /gm)).toHaveLength(1);
  });

  it("finishes inside the systemd unit's TimeoutStartSec", () => {
    const script = readFileSync(RUN_SH, "utf8");
    const runbook = readFileSync(RUNBOOK, "utf8");
    const timeoutStart = Number(/TimeoutStartSec=(\d+)/.exec(runbook)![1]);
    const budget = Number(/BUDGET="\$\{SR_DESIGN_WORKER_BUDGET_SECONDS:-(\d+)\}"/.exec(script)![1]);
    const cap = Number(/\[ "\$BUDGET" -le (\d+) \] \|\| BUDGET=\d+/.exec(script)![1]);
    const killAfter = Number(/KILL_AFTER=(\d+)/.exec(script)![1]);
    expect(budget).toBeLessThanOrEqual(cap);
    // every step runs inside the budget; the worker gets what is left
    expect(cap + killAfter).toBeLessThan(timeoutStart);
    expect(runbook).toContain("scripts/sales-design-worker/run.sh");
    // the runbook does not carry its own copy of run.sh
    expect(runbook).not.toContain("flock -n 9");
  });
});
