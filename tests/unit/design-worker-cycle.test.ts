import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/sales-design-worker/cycle.sh (DEV-052): one cycle of the design bridge and the worker.
// The real script runs against a fake world under SR_DESIGN_CYCLE_TEST_ROOT: fake preflight,
// admin.sh (the jailed worker), bridge run.sh, git, systemctl and pgrep. Nothing real is touched.

const REPO = join(__dirname, "../..");
const CYCLE = join(REPO, "scripts/sales-design-worker/cycle.sh");
const UNIT_DIR = join(REPO, "scripts/sales-design-worker/systemd");
const DOC = join(REPO, "docs/operations/design-worker-cycle.md");

const JOB = "b-0f1e2d3c-4b5a-4968-8776-655443322110";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_000_000;
const DELIVER_NONE = "bridge: delivered 0, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)";
const ts = "2026-10-19T03:00:00.000Z";

type World = ReturnType<typeof world>;

function exe(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function world() {
  const t = mkdtempSync(join(tmpdir(), "sr-cycle-"));
  const sc = join(t, "sc");
  const calls = join(t, "calls.log");
  const bin = join(t, "bin");
  const ledger = join(t, "home/sr-designbridge/.local/state/sr-design-bridge/ledger.json");
  mkdirSync(sc, { recursive: true });
  writeFileSync(calls, "");
  writeFileSync(join(t, "clock"), String(T0));
  // a fake step: counts its calls, logs its arguments, then plays sc/<name>-<n>.{clock,ledger,out,rc}
  const step = (name: string, extra = "") => `n=$(( $(cat '${sc}/${name}.n' 2>/dev/null || echo 0) + 1 )); echo $n > '${sc}/${name}.n'
echo "${name}#$n $*${extra}" >> '${calls}'
[ ! -f '${sc}'/${name}-$n.clock ] || cp '${sc}'/${name}-$n.clock '${t}/clock'
[ ! -f '${sc}'/${name}-$n.sleep ] || sleep 30
[ ! -f '${sc}'/${name}-$n.ledger ] || { mkdir -p '${dirname(ledger)}'; cp '${sc}'/${name}-$n.ledger '${ledger}'; }
[ ! -f '${sc}'/${name}-$n.out ] || cat '${sc}'/${name}-$n.out
exit $(cat '${sc}'/${name}-$n.rc 2>/dev/null || echo 0)`;
  exe(join(t, "root/sr-capture-admin/scripts/ops/wsl-resource-preflight.sh"), step("preflight"));
  exe(join(t, "root/sr-capture-admin/scripts/sales-design-capture/admin.sh"), step("admin"));
  exe(join(t, "home/sr-designbridge/second-root/scripts/sales-design-bridge/run.sh"), step("bridge", " api=${SR_DESIGN_BRIDGE_API_URL:+set} spool=${SR_DESIGN_BRIDGE_SPOOL:-} home=${HOME:-} bypass=${SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE:-none}@${SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN:-none}"));
  exe(join(t, "home/sr-designgen/work/second-root/scripts/sales-design-worker/run.sh"), "exit 99");
  exe(join(bin, "git"), `echo "git $*" >> '${calls}'
case "$*" in
  *"rev-parse HEAD"*) cat '${sc}/head' ;;
  *status*) [ ! -f '${sc}'/dirty-$(basename "$2") ] || echo " M scripts/x" ;;
esac`);
  exe(join(bin, "systemctl"), `u="\${@: -1}"; case "$1" in is-active) [ -f '${sc}'/active-$u ] ;; is-enabled) [ -f '${sc}'/enabled-$u ] ;; *) exit 1 ;; esac`);
  // sc/pgrep: both checks see a process; sc/pgrep-worker: only the worker check (pgrep -f)
  exe(join(bin, "pgrep"), `case " $* " in *" -f "*) [ -f '${sc}/pgrep' ] || [ -f '${sc}/pgrep-worker' ] ;; *) [ -f '${sc}/pgrep' ] ;; esac`);
  writeFileSync(join(sc, "head"), `${SHA}\n`);

  mkdirSync(join(t, "etc/second-root"), { recursive: true });
  writeFileSync(join(t, "etc/second-root/design-cycle.conf"), `# approved bridge commit\nSR_DESIGN_CYCLE_BRIDGE_SHA=${SHA}\n`, { mode: 0o644 });
  const conf = join(t, "home/sr-designbridge/.config/second-root");
  mkdirSync(conf, { recursive: true });
  const apiUrl = `https://staging-${randomBytes(4).toString("hex")}.invalid`;
  const token = `Tk9${randomBytes(48).toString("base64")}`;
  writeFileSync(join(conf, "design-bridge.env"), `SR_DESIGN_BRIDGE_API_URL=${apiUrl}\n`, { mode: 0o600 });
  writeFileSync(join(conf, "design-bridge.token"), token, { mode: 0o600 });
  for (const d of ["srv/sr-design-bridge/to-worker", "srv/sr-design-bridge/from-worker", "home/sr-designgen/sr-design-jobs/inbox", "home/sr-designgen/sr-design-jobs/processing"]) mkdirSync(join(t, d), { recursive: true });

  const w = { t, sc, calls, bin, ledger, apiUrl, token };
  play(w, "preflight", 1, { out: "MemTotal 16000 MiB / MemAvailable 12000 MiB / SwapTotal 4096 MiB / SwapFree 4096 MiB\nOK: at most 2 heavy jobs at a time." });
  play(w, "admin", 1, {
    out: [`JAIL_OK`, `${ts} design worker 0123456789ab (max 1, budget 55 min)`, `${ts} bridge: imported 0`, `${ts} no jobs in the inbox`, `{ "status": "idle", "recovered": [] }`, `${ts} bridge: exported 0, removed 1`].join("\n"),
  });
  play(w, "bridge", 1, { out: DELIVER_NONE });
  play(w, "bridge", 2, { out: `job ${JOB}: claimed (attempt 1)\nbridge: delivered 0, superseded 0, refused 0, expired 0, claimed ${JOB}`, ledger: ledgerWith(false) });
  play(w, "admin", 2, {
    out: [`JAIL_OK`, `${ts} design worker 0123456789ab (max 1, budget 55 min)`, `${ts} bridge: imported 1`, `${ts} job ${JOB}: claimed`, `${ts} job ${JOB}: signed-in capture LOGIN_OK`, `${ts} job ${JOB}: done; windows copy unavailable`, `${ts} bridge: exported 1`].join("\n"),
  });
  play(w, "bridge", 3, { out: `result ${JOB}: delivered (ready)\nbridge: delivered 1, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)`, ledger: ledgerWith(true) });
  return w;
}

function ledgerWith(closed: boolean) {
  const entry = { jobId: JOB.slice(2), claimedAt: "2026-10-19T03:00:00.000Z", ...(closed ? { closed: { at: "2026-10-19T03:50:00.000Z", as: "delivered" } } : {}) };
  return JSON.stringify({ version: 1, jobs: { [JOB]: entry } });
}

function play(w: { sc: string }, name: string, n: number, s: { out?: string; rc?: number; clock?: number; ledger?: string }) {
  if (s.out !== undefined) writeFileSync(join(w.sc, `${name}-${n}.out`), `${s.out}\n`);
  if (s.rc !== undefined) writeFileSync(join(w.sc, `${name}-${n}.rc`), String(s.rc));
  if (s.clock !== undefined) writeFileSync(join(w.sc, `${name}-${n}.clock`), String(s.clock));
  if (s.ledger !== undefined) writeFileSync(join(w.sc, `${name}-${n}.ledger`), s.ledger);
}

function cycle(w: World, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [CYCLE, ...args], {
    encoding: "utf8",
    env: { PATH: `${w.bin}:${process.env.PATH}`, SR_DESIGN_CYCLE_TEST_ROOT: w.t, SOME_SECRET_KEY: "should-not-pass", ...env } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  const lines = r.stdout.trimEnd().split("\n");
  return { ...r, out: r.stdout + r.stderr, last: lines[lines.length - 1]!, calls: readFileSync(w.calls, "utf8") };
}

const count = (calls: string, name: string) => calls.split("\n").filter((l) => l.startsWith(`${name}#`)).length;

describe("cycle.sh: the file", () => {
  it("is valid bash, executable, and refuses to run outside the root-only clone without the test world", () => {
    expect(spawnSync("bash", ["-n", CYCLE]).status).toBe(0);
    expect(readFileSync(CYCLE, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(statSync(CYCLE).mode & 0o111).not.toBe(0);
    const r = spawnSync("bash", [CYCLE], { encoding: "utf8", env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("run from the root-only clone");
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("CYCLE_RESULT CYCLE_USAGE phase=before_claim job=none exit=2");
  });

  it("runs the same when invoked by a relative path (the path is resolved before cd /)", () => {
    const w = world();
    const r = spawnSync("bash", ["sales-design-worker/cycle.sh", "--dry-run"], {
      cwd: join(REPO, "scripts"),
      encoding: "utf8",
      env: { PATH: `${w.bin}:${process.env.PATH}`, SR_DESIGN_CYCLE_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.stdout.trimEnd().split("\n").pop()).toBe("CYCLE_RESULT CYCLE_DRY_RUN_OK phase=before_claim job=none exit=0");
  });

  // The production guards, exercised for real: a private mount namespace (unprivileged user
  // namespace) puts a copy of the script at /root/sr-capture-admin on a tmpfs that only this
  // test's processes see. Nothing outside the namespace is touched, and the test hook stays
  // refused there: no production path takes it.
  const canUnshare = spawnSync("unshare", ["-rm", "true"]).status === 0;
  it.skipIf(!canUnshare)("the production copy refuses the test hook (absolute and relative path) and a non-root user", () => {
    const w = world();
    const copy = join(w.t, "cycle-copy.sh");
    writeFileSync(copy, readFileSync(CYCLE));
    const prod = "/root/sr-capture-admin/scripts/sales-design-worker";
    const script = [
      "set -u",
      "mount -t tmpfs -o mode=0755 none /root",
      `mkdir -p ${prod}`,
      `cp '${copy}' ${prod}/cycle.sh`,
      `echo '--- absolute'; SR_DESIGN_CYCLE_TEST_ROOT='${w.t}' bash ${prod}/cycle.sh`,
      `echo '--- relative'; cd /root/sr-capture-admin/scripts && SR_DESIGN_CYCLE_TEST_ROOT='${w.t}' bash sales-design-worker/cycle.sh; cd /`,
      `echo '--- nobody'; unshare --user bash ${prod}/cycle.sh`,
      "true",
    ].join("\n");
    const r = spawnSync("unshare", ["-rm", "bash", "-c", script], { encoding: "utf8", env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
    const parts = Object.fromEntries(
      r.stdout
        .split(/^--- /m)
        .filter(Boolean)
        .map((p) => [p.split("\n")[0], p]),
    );
    for (const k of ["absolute", "relative"]) {
      expect(parts[k]).toContain("CYCLE_TEST_HOOK_REFUSED: test hooks are refused in /root/sr-capture-admin");
      expect(parts[k]).toContain("CYCLE_RESULT CYCLE_USAGE phase=before_claim job=none exit=2");
    }
    expect(parts.nobody).toContain("run as root: sudo bash /root/sr-capture-admin/scripts/sales-design-worker/cycle.sh");
    expect(parts.nobody).toContain("CYCLE_RESULT CYCLE_USAGE phase=before_claim job=none exit=2");
    // nothing of the fake world ran, and no state directory was made in it
    expect(readFileSync(w.calls, "utf8")).toBe("");
    expect(existsSync(join(w.t, "var/lib/sr-design-cycle"))).toBe(false);
  });
});

describe("cycle.sh: one cycle", () => {
  it("success: idle run → deliver-only → claim one → worker → deliver that job", () => {
    const w = world();
    const r = cycle(w);
    expect(r.status).toBe(0);
    expect(r.last).toBe(`CYCLE_RESULT CYCLE_OK phase=done job=${JOB} exit=0`);
    const order = r.calls.split("\n").filter((l) => /^(preflight|admin|bridge)#/.test(l)).map((l) => l.split(" ").slice(0, 2).join(" "));
    expect(order).toEqual(["preflight#1 ", "admin#1 run", "bridge#1 --deliver-only", "bridge#2 --once", "admin#2 run", "bridge#3 --deliver-only"]);
    // the worker is started exactly as before: admin.sh run, the jail, REF=develop, budget 3300, --max=1
    const spool = join(w.t, "srv/sr-design-bridge");
    const workerRun = join(w.t, "home/sr-designgen/work/second-root/scripts/sales-design-worker/run.sh");
    for (const line of r.calls.split("\n").filter((l) => l.startsWith("admin#"))) {
      expect(line).toMatch(new RegExp(`^admin#\\d run \\S+ -- /usr/bin/env SR_DESIGN_WORKER_REF=develop SR_DESIGN_BRIDGE_SPOOL=${spool} SR_DESIGN_WORKER_BUDGET_SECONDS=3300 ${workerRun} --max=1$`));
    }
    // the bridge gets the API URL (never on its command line), the spool and its own HOME
    for (const line of r.calls.split("\n").filter((l) => l.startsWith("bridge#"))) {
      expect(line).toContain(`api=set spool=${spool} home=${join(w.t, "home/sr-designbridge")}`);
    }
    // JAIL_OK in the worker output is not a stop code
    expect(r.stdout).toContain("JAIL_OK");
    expect(r.stdout).not.toContain("should-not-pass");
  });

  it("idle: nothing to claim → CYCLE_IDLE (exit 10), no worker run after it", () => {
    const w = world();
    play(w, "bridge", 2, { out: "bridge: delivered 0, superseded 0, refused 0, expired 0, claimed none" });
    writeFileSync(join(w.sc, "bridge-2.ledger"), JSON.stringify({ version: 1, jobs: {} }));
    const r = cycle(w);
    expect(r.status).toBe(10);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_IDLE phase=before_claim job=none exit=10");
    expect(count(r.calls, "admin")).toBe(1);
    expect(count(r.calls, "bridge")).toBe(2);
  });

  it("SERIAL from the preflight still runs (the cycle is one heavy job)", () => {
    const w = world();
    play(w, "preflight", 1, { out: "SERIAL: one heavy job at a time.", rc: 10 });
    expect(cycle(w).status).toBe(0);
  });

  it("dry run: preflight and checks only", () => {
    const w = world();
    const r = cycle(w, ["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_DRY_RUN_OK phase=before_claim job=none exit=0");
    expect(count(r.calls, "admin") + count(r.calls, "bridge")).toBe(0);
  });
});

describe("cycle.sh: STOP before the claim (nothing changed in Staging)", () => {
  it("resource preflight STOP → CYCLE_STOP_PREFLIGHT, nothing started", () => {
    const w = world();
    play(w, "preflight", 1, { out: "STOP: less than 3 GiB available.", rc: 20 });
    const r = cycle(w);
    expect(r.status).toBe(20);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_STOP_PREFLIGHT phase=before_claim job=none exit=20");
    expect(count(r.calls, "admin") + count(r.calls, "bridge")).toBe(0);
  });

  const checks: [string, (w: World) => void, string][] = [
    ["bridge timer active", (w) => writeFileSync(join(w.sc, "active-sr-design-bridge.timer"), ""), "CHECK_UNIT_ACTIVE"],
    ["old worker service active", (w) => writeFileSync(join(w.sc, "active-sr-design-worker.service"), ""), "CHECK_UNIT_ACTIVE"],
    ["bridge timer enabled", (w) => writeFileSync(join(w.sc, "enabled-sr-design-bridge.timer"), ""), "CHECK_UNIT_ENABLED"],
    ["a bridge / worker process", (w) => writeFileSync(join(w.sc, "pgrep"), ""), "CHECK_BRIDGE_RUNNING"],
    ["only a worker process of sr-designgen", (w) => writeFileSync(join(w.sc, "pgrep-worker"), ""), "CHECK_WORKER_RUNNING"],
    ["bridge not at the approved commit", (w) => writeFileSync(join(w.sc, "head"), "f".repeat(40)), "CHECK_BRIDGE_NOT_AT_SHA"],
    ["bridge checkout dirty", (w) => writeFileSync(join(w.sc, "dirty-second-root"), ""), "CHECK_BRIDGE_DIRTY"],
    ["root clone dirty", (w) => writeFileSync(join(w.sc, "dirty-sr-capture-admin"), ""), "CHECK_ROOT_CLONE_DIRTY"],
    ["no config", (w) => writeFileSync(join(w.t, "etc/second-root/design-cycle.conf"), "# nothing\n"), "CHECK_CONFIG_INVALID"],
    ["config writable by others", (w) => chmodSync(join(w.t, "etc/second-root/design-cycle.conf"), 0o666), "CHECK_CONFIG_UNSAFE"],
    ["token file 0644", (w) => chmodSync(join(w.t, "home/sr-designbridge/.config/second-root/design-bridge.token"), 0o644), "CHECK_TOKEN_FILE_UNSAFE"],
    ["env file 0640", (w) => chmodSync(join(w.t, "home/sr-designbridge/.config/second-root/design-bridge.env"), 0o640), "CHECK_ENV_FILE_UNSAFE"],
    ["env file without https URL", (w) => writeFileSync(join(w.t, "home/sr-designbridge/.config/second-root/design-bridge.env"), "SR_DESIGN_BRIDGE_API_URL=http://x.invalid\n"), "CHECK_ENV_INVALID"],
    ["an open job in the ledger (a stopped cycle)", (w) => { mkdirSync(dirname(w.ledger), { recursive: true }); writeFileSync(w.ledger, ledgerWith(false)); }, "CHECK_LEDGER_OPEN"],
    ["an unreadable ledger", (w) => { mkdirSync(dirname(w.ledger), { recursive: true }); writeFileSync(w.ledger, "{"); }, "CHECK_LEDGER_INVALID"],
    ["a job file in to-worker", (w) => writeFileSync(join(w.t, `srv/sr-design-bridge/to-worker/${JOB}.json`), "{}"), "CHECK_SPOOL_PENDING"],
    ["a job in the worker inbox", (w) => writeFileSync(join(w.t, "home/sr-designgen/sr-design-jobs/inbox/shop-001.json"), "{}"), "CHECK_WORKER_QUEUE_BUSY"],
  ];
  it.each(checks)("%s → CYCLE_STOP_CHECK", (_, set, code) => {
    const w = world();
    set(w);
    const r = cycle(w);
    expect(r.status).toBe(21);
    expect(r.stdout).toContain(`check: ${code}`);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_STOP_CHECK phase=before_claim job=none exit=21");
    expect(count(r.calls, "admin") + count(r.calls, "bridge")).toBe(0);
  });

  it("the env file's URL and the token are never printed, even when the check fails", () => {
    const w = world();
    chmodSync(join(w.t, "home/sr-designbridge/.config/second-root/design-bridge.token"), 0o644);
    const r = cycle(w);
    expect(r.out).not.toContain(w.apiUrl);
    expect(r.out).not.toContain(w.token);
  });

  it("the idle run is not idle (it imported a job) → CYCLE_STOP_IDLE_RUN", () => {
    const w = world();
    play(w, "admin", 1, { out: `${ts} bridge: imported 1\n${ts} job ${JOB}: claimed\n${ts} bridge: exported 0` });
    const r = cycle(w);
    expect(r.status).toBe(22);
    expect(count(r.calls, "bridge")).toBe(0);
  });

  it("LOGIN_REQUIRED in the idle run → CYCLE_STOP_IDLE_RUN", () => {
    const w = world();
    play(w, "admin", 1, { out: `${ts} bridge: imported 0\n${ts} no jobs in the inbox\n${ts} capture helper LOGIN_REQUIRED\n${ts} bridge: exported 0` });
    const r = cycle(w);
    expect(r.status).toBe(22);
    expect(r.stdout).toContain("stop codes: LOGIN_REQUIRED");
  });

  it("deliver-only that supersedes something → CYCLE_STOP_DELIVER_BEFORE, no claim", () => {
    const w = world();
    play(w, "bridge", 1, { out: `result ${JOB}: superseded\nbridge: delivered 0, superseded 1, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)` });
    const r = cycle(w);
    expect(r.status).toBe(23);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_STOP_DELIVER_BEFORE phase=before_claim job=none exit=23");
    expect(count(r.calls, "bridge")).toBe(1);
  });

  it("the claim stops with BRIDGE_UNAUTHORIZED (nothing claimed) → CYCLE_STOP_CLAIM before the claim", () => {
    const w = world();
    play(w, "bridge", 2, { out: "stopped: BRIDGE_UNAUTHORIZED\nbridge: delivered 0, superseded 0, refused 0, expired 0, claimed none", rc: 3, ledger: JSON.stringify({ version: 1, jobs: {} }) });
    const r = cycle(w);
    expect(r.status).toBe(25);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_STOP_CLAIM phase=before_claim job=none exit=25");
    expect(count(r.calls, "admin")).toBe(1);
  });

  it("claimed none (BRIDGE_WORKER_IDLE) right after the idle run is a stop, not idle", () => {
    const w = world();
    play(w, "bridge", 2, { out: "not claiming: the worker has not run recently (BRIDGE_WORKER_IDLE)\nbridge: delivered 0, superseded 0, refused 0, expired 0, claimed none (BRIDGE_WORKER_IDLE)" });
    expect(cycle(w).status).toBe(25);
  });

  it("a claim pass that also delivered or expired something is not exactly one claim", () => {
    const w = world();
    play(w, "bridge", 2, { out: `bridge: delivered 0, superseded 0, refused 0, expired 1, claimed ${JOB}` });
    const r = cycle(w);
    expect(r.status).toBe(25);
    // the ledger holds the claimed job: the stop says so
    expect(r.last).toBe(`CYCLE_RESULT CYCLE_STOP_CLAIM phase=after_claim job=${JOB} exit=25`);
    expect(r.stdout).toContain(`job ${JOB} may stay 'processing' in Staging`);
    expect(count(r.calls, "admin")).toBe(1);
  });

  it("time guard before the claim: fewer than 4220 s left → no claim", () => {
    const w = world();
    play(w, "bridge", 1, { out: DELIVER_NONE, clock: T0 + 281 });
    const r = cycle(w);
    expect(r.status).toBe(24);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_STOP_TIME_BEFORE_CLAIM phase=before_claim job=none exit=24");
    expect(r.calls).not.toContain("--once");
  });

  it("exactly 4220 s left is still enough for the claim (the deadline is fixed at the start)", () => {
    const w = world();
    play(w, "bridge", 1, { out: DELIVER_NONE, clock: T0 + 280 });
    play(w, "bridge", 2, { out: `job ${JOB}: claimed (attempt 1)\nbridge: delivered 0, superseded 0, refused 0, expired 0, claimed ${JOB}`, ledger: ledgerWith(false), clock: T0 + 540 });
    expect(cycle(w).status).toBe(0);
  });

  it.each([
    ["the ledger cannot be read after the pass", "{"],
    ["the ledger holds two open jobs", JSON.stringify({ version: 1, jobs: { [JOB]: { jobId: JOB.slice(2), claimedAt: ts }, [`b-${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`]: { jobId: "x", claimedAt: ts } } })],
  ])("a failed claim pass and %s → phase=claim_unknown, job=none, the person is told", (_, ledger) => {
    const w = world();
    play(w, "bridge", 2, { out: "stopped: BRIDGE_API_UNAVAILABLE\nbridge: delivered 0, superseded 0, refused 0, expired 0, claimed none", rc: 3, ledger });
    const r = cycle(w);
    expect(r.status).toBe(25);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_STOP_CLAIM phase=claim_unknown job=none exit=25");
    expect(r.stdout).toContain("job none may stay 'processing' in Staging");
    expect(count(r.calls, "admin")).toBe(1);
  });
});

describe("cycle.sh: STOP after the claim (the job stays processing; a person recovers it)", () => {
  const after = (r: ReturnType<typeof cycle>, code: string, rc: number) => {
    expect(r.status).toBe(rc);
    expect(r.last).toBe(`CYCLE_RESULT ${code} phase=after_claim job=${JOB} exit=${rc}`);
    expect(r.stdout).toContain(`job ${JOB} may stay 'processing' in Staging`);
    expect(r.stdout).toContain("§6");
  };

  it("time guard before the worker: fewer than 3960 s left → the worker is not started", () => {
    const w = world();
    play(w, "bridge", 2, { out: `bridge: delivered 0, superseded 0, refused 0, expired 0, claimed ${JOB}`, ledger: ledgerWith(false), clock: T0 + 541 });
    const r = cycle(w);
    after(r, "CYCLE_STOP_TIME_BEFORE_WORKER", 30);
    expect(count(r.calls, "admin")).toBe(1);
  });

  it.each([
    ["LOGIN_WALL", `${ts} job ${JOB}: PUBLIC_SOURCE_UNAVAILABLE (LOGIN_WALL)`],
    ["LOGIN_REQUIRED", `${ts} job ${JOB}: signed-in capture LOGIN_REQUIRED`],
    ["JAIL_UNSAFE", "JAIL_UNSAFE NETWORK_NOT_PRIVATE"],
    ["BRIDGE_SPOOL_UNAVAILABLE", `${ts} bridge: export skipped (BRIDGE_SPOOL_UNAVAILABLE)`],
    ["INSTAGRAM_CHALLENGE", `${ts} job ${JOB}: signed-in capture INSTAGRAM_CHALLENGE`],
    ["RATE_LIMITED", `${ts} job ${JOB}: PUBLIC_SOURCE_UNAVAILABLE (RATE_LIMITED)`],
    ["RATE_LIMITED", `${ts} job ${JOB}: website PUBLIC_SOURCE_UNAVAILABLE (RATE_LIMITED)`],
  ])("%s in the worker output → CYCLE_STOP_WORKER_SIGNAL, no delivery", (code, line) => {
    const w = world();
    play(w, "admin", 2, { out: [`${ts} bridge: imported 1`, `${ts} job ${JOB}: claimed`, line, `${ts} bridge: exported 1`].join("\n") });
    const r = cycle(w);
    after(r, "CYCLE_STOP_WORKER_SIGNAL", 31);
    expect(r.stdout).toContain(`stop codes: ${code}`);
    expect(count(r.calls, "bridge")).toBe(2);
  });

  it("RATE_LIMITED only as a whole word: RATE_LIMITED_X is not a stop code", () => {
    const w = world();
    play(w, "admin", 2, { out: [`${ts} bridge: imported 1`, `${ts} job ${JOB}: claimed`, `${ts} job ${JOB}: note RATE_LIMITED_X`, `${ts} bridge: exported 1`].join("\n") });
    expect(cycle(w).status).toBe(0);
  });

  it.each(["CAPTURE_HELPER_TIMEOUT", "CAPTURE_HELPER_UNAVAILABLE", "BROWSER_BUSY", "HELPER_BUSY", "HELPER_ERROR", "CAPTURE_FAILED", "CAPTURE_RESULT_INVALID"])(
    "the helper gave no answer (%s) and the public fallback ended PUBLIC_SOURCE_UNAVAILABLE → CYCLE_STOP_WORKER_SIGNAL",
    (code) => {
      const w = world();
      play(w, "admin", 2, {
        out: [`${ts} bridge: imported 1`, `${ts} job ${JOB}: claimed`, `${ts} job ${JOB}: signed-in capture ${code}`, `${ts} job ${JOB}: PUBLIC_SOURCE_UNAVAILABLE (EMPTY_PAGE)`, `${ts} job ${JOB}: PUBLIC_SOURCE_UNAVAILABLE; windows copy unavailable`, `${ts} bridge: exported 1`].join("\n"),
      });
      const r = cycle(w);
      after(r, "CYCLE_STOP_WORKER_SIGNAL", 31);
      expect(r.stdout).toContain(`the capture helper gave no answer: ${code}`);
      expect(count(r.calls, "bridge")).toBe(2);
    },
  );

  it("the helper gave no answer but the public capture worked → delivered", () => {
    const w = world();
    play(w, "admin", 2, {
      out: [`${ts} bridge: imported 1`, `${ts} job ${JOB}: claimed`, `${ts} job ${JOB}: signed-in capture CAPTURE_HELPER_TIMEOUT`, `${ts} job ${JOB}: instagram captured (3 images)`, `${ts} job ${JOB}: done; windows copy unavailable`, `${ts} bridge: exported 1`].join("\n"),
    });
    expect(cycle(w).status).toBe(0);
  });

  it("the helper's own answer PUBLIC_SOURCE_UNAVAILABLE (PRIVATE_OR_MISSING) is delivered", () => {
    const w = world();
    play(w, "admin", 2, {
      out: [`${ts} bridge: imported 1`, `${ts} job ${JOB}: claimed`, `${ts} job ${JOB}: signed-in capture PUBLIC_SOURCE_UNAVAILABLE (PRIVATE_OR_MISSING)`, `${ts} job ${JOB}: PUBLIC_SOURCE_UNAVAILABLE (PRIVATE_OR_MISSING)`, `${ts} job ${JOB}: PUBLIC_SOURCE_UNAVAILABLE; windows copy unavailable`, `${ts} bridge: exported 1`].join("\n"),
    });
    expect(cycle(w).status).toBe(0);
  });

  it("time guard before the last pass: fewer than 260 s left → CYCLE_STOP_TIME_BEFORE_DELIVER", () => {
    const w = world();
    play(w, "admin", 2, { clock: T0 + 4500 - 259 });
    const r = cycle(w);
    after(r, "CYCLE_STOP_TIME_BEFORE_DELIVER", 35);
    expect(count(r.calls, "bridge")).toBe(2);
  });

  it("an unexpected error after the claim → CYCLE_STOP_INTERNAL, the job is reported", () => {
    const w = world();
    // a clock that is not a number makes the next time guard fail inside the script
    writeFileSync(join(w.sc, "admin-2.clock"), "1x\n");
    const r = cycle(w);
    after(r, "CYCLE_STOP_INTERNAL", 41);
    expect(r.stdout).toContain("stopped by an unexpected error");
    expect(count(r.calls, "bridge")).toBe(2);
  });

  it("worker exit 1 → CYCLE_STOP_WORKER_EXIT, no delivery", () => {
    const w = world();
    play(w, "admin", 2, { out: `${ts} bridge: imported 1\n${ts} job ${JOB}: claimed\n${ts} bridge: exported 1`, rc: 1 });
    const r = cycle(w);
    after(r, "CYCLE_STOP_WORKER_EXIT", 32);
    expect(count(r.calls, "bridge")).toBe(2);
    expect(r.calls).not.toContain("--oom-check");
  });

  it("worker killed (137) → the OOM check is run and shown, then the stop", () => {
    const w = world();
    play(w, "admin", 2, { out: `${ts} bridge: imported 1`, rc: 137 });
    play(w, "preflight", 2, { out: "NO_OOM_KILL in the kernel log (since: 2 hours ago)" });
    const r = cycle(w);
    after(r, "CYCLE_STOP_WORKER_EXIT", 32);
    expect(r.calls).toContain("preflight#2 --oom-check --since 2 hours ago");
    expect(r.stdout).toContain("oom-check| NO_OOM_KILL");
  });

  it("the worker did not run that job (claimed line missing) → CYCLE_STOP_WORKER_RESULT", () => {
    const w = world();
    play(w, "admin", 2, { out: `${ts} bridge: imported 1\n${ts} not enough time left for another job\n${ts} bridge: exported 0` });
    after(cycle(w), "CYCLE_STOP_WORKER_RESULT", 33);
  });

  it("the last deliver-only delivers nothing → CYCLE_STOP_DELIVER_AFTER", () => {
    const w = world();
    play(w, "bridge", 3, { out: DELIVER_NONE });
    after(cycle(w), "CYCLE_STOP_DELIVER_AFTER", 34);
  });

  it("stopped by systemd (SIGTERM) during the worker → CYCLE_STOP_SIGNAL, no delivery", async () => {
    const w = world();
    writeFileSync(join(w.sc, "admin-2.sleep"), "");
    const child: ChildProcess = spawn("bash", [CYCLE], { env: { PATH: `${w.bin}:${process.env.PATH}`, SR_DESIGN_CYCLE_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    for (let i = 0; i < 200 && !readFileSync(w.calls, "utf8").includes("admin#2"); i += 1) await new Promise((r) => setTimeout(r, 50));
    // systemd stops the whole cgroup: the cycle and the step it waits for
    process.kill(-child.pid!, "SIGTERM");
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).toBe(40);
    expect(stdout.trimEnd().split("\n").pop()).toBe(`CYCLE_RESULT CYCLE_STOP_SIGNAL phase=after_claim job=${JOB} exit=40`);
    expect(stdout).toContain(`job ${JOB} may stay 'processing' in Staging`);
    expect(count(readFileSync(w.calls, "utf8"), "bridge")).toBe(2);
  });

  it("the last deliver-only stops with BRIDGE_UNAUTHORIZED → CYCLE_STOP_DELIVER_AFTER", () => {
    const w = world();
    play(w, "bridge", 3, { out: "stopped: BRIDGE_UNAUTHORIZED\nbridge: delivered 0, superseded 0, refused 0, expired 0, claimed none (BRIDGE_DELIVER_ONLY)", rc: 3 });
    after(cycle(w), "CYCLE_STOP_DELIVER_AFTER", 34);
  });
});

describe("cycle.sh: the Vercel bypass of the bridge (DEV-059, off by default)", () => {
  const ALIAS = "https://second-root-git-develop-brot-yanagi.vercel.app";
  const confPath = (w: World) => join(w.t, "etc/second-root/design-cycle.conf");
  const bridgeConf = (w: World) => join(w.t, "home/sr-designbridge/.config/second-root");
  /** The bridge's env file pointing at the alias, with the two bypass lines, a 0600 bypass file, and root's switch. */
  function withBypass(w: World, opts: { switch?: string; envLines?: string[]; mode?: number; apiUrl?: string } = {}) {
    const file = join(bridgeConf(w), "design-bridge.vercel-bypass");
    const value = `Vb${randomBytes(15).toString("hex")}`;
    writeFileSync(file, value, { mode: opts.mode ?? 0o600 });
    chmodSync(file, opts.mode ?? 0o600);
    const lines = opts.envLines ?? [`SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${file}`, `SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}`];
    writeFileSync(join(bridgeConf(w), "design-bridge.env"), [`SR_DESIGN_BRIDGE_API_URL=${opts.apiUrl ?? ALIAS}`, ...lines, ""].join("\n"), { mode: 0o600 });
    if (opts.switch !== undefined) writeFileSync(confPath(w), `SR_DESIGN_CYCLE_BRIDGE_SHA=${SHA}\n${opts.switch}\n`, { mode: 0o644 });
    return { file, value };
  }
  const bridgeLines = (calls: string) => calls.split("\n").filter((l) => l.startsWith("bridge#"));

  it("off by default: nothing is passed to the bridge, even when the env file has the bypass lines", () => {
    const plain = world();
    const r0 = cycle(plain);
    expect(r0.status).toBe(0);
    expect(r0.stdout).toContain("cycle: vercel bypass: off");
    for (const line of bridgeLines(r0.calls)) expect(line).toMatch(/ bypass=none@none$/);
    for (const sw of [undefined, "SR_DESIGN_CYCLE_VERCEL_BYPASS=off"]) {
      const w = world();
      const { value } = withBypass(w, { switch: sw });
      const r = cycle(w);
      expect(r.last).toBe(`CYCLE_RESULT CYCLE_OK phase=done job=${JOB} exit=0`);
      expect(r.stdout).toContain("cycle: vercel bypass: off");
      expect(bridgeLines(r.calls)).toHaveLength(3);
      for (const line of bridgeLines(r.calls)) expect(line).toMatch(/ bypass=none@none$/);
      expect(r.out).not.toContain(value);
    }
  });

  it("on (root's config): the bridge gets the file path and the origin, never the value; the cycle never reads it", () => {
    const w = world();
    const { file, value } = withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on" });
    const r = cycle(w);
    expect(r.last).toBe(`CYCLE_RESULT CYCLE_OK phase=done job=${JOB} exit=0`);
    expect(r.stdout).toContain("cycle: vercel bypass: on");
    expect(bridgeLines(r.calls)).toHaveLength(3);
    for (const line of bridgeLines(r.calls)) expect(line.endsWith(` bypass=${file}@${ALIAS}`)).toBe(true);
    expect(r.out).not.toContain(value);
    expect(r.calls).not.toContain(value);
    expect(r.out).not.toContain(ALIAS);
  });

  it("dry run with the bypass on checks it and passes", () => {
    const w = world();
    withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on" });
    const r = cycle(w, ["--dry-run"]);
    expect(r.last).toBe("CYCLE_RESULT CYCLE_DRY_RUN_OK phase=before_claim job=none exit=0");
    expect(r.stdout).toContain("cycle: vercel bypass: on");
  });

  const bypassChecks: [string, (w: World) => void, string][] = [
    ["a switch that is not on / off", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=yes" }), "CHECK_CONFIG_INVALID"],
    ["two switch lines", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on\nSR_DESIGN_CYCLE_VERCEL_BYPASS=off" }), "CHECK_CONFIG_INVALID"],
    ["on without the env lines", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", envLines: [] }), "CHECK_BYPASS_INVALID"],
    ["on with only the file line", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", envLines: ["SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=/x/y"] }), "CHECK_BYPASS_INVALID"],
    ["a relative file path", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", envLines: ["SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=x/y", `SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}`] }), "CHECK_BYPASS_INVALID"],
    ["an origin that is not *.vercel.app", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", apiUrl: "https://secondroot.jp", envLines: ["SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=/x/y", "SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=https://secondroot.jp"] }), "CHECK_BYPASS_INVALID"],
    ["an origin with a trailing slash", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", envLines: ["SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=/x/y", `SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}/`] }), "CHECK_BYPASS_INVALID"],
    ["an origin that is not the API URL's", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", apiUrl: "https://second-root-75vcnoz75-brot-yanagi.vercel.app" }), "CHECK_BYPASS_INVALID"],
    ["a bypass file readable by the group", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", mode: 0o640 }), "CHECK_BYPASS_FILE_UNSAFE"],
    ["a bypass file readable by others", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", mode: 0o604 }), "CHECK_BYPASS_FILE_UNSAFE"],
    ["a missing bypass file", (w) => withBypass(w, { switch: "SR_DESIGN_CYCLE_VERCEL_BYPASS=on", envLines: [`SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE=${join(w.t, "nowhere")}`, `SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN=${ALIAS}`] }), "CHECK_BYPASS_FILE_UNSAFE"],
  ];
  it.each(bypassChecks)("%s → CYCLE_STOP_CHECK", (_, set, code) => {
    const w = world();
    set(w);
    const r = cycle(w);
    expect(r.status).toBe(21);
    expect(r.stdout).toContain(`check: ${code}`);
    expect(r.out).not.toContain(ALIAS);
    expect(count(r.calls, "admin") + count(r.calls, "bridge")).toBe(0);
  });

  it("a child line with the bypass header is redacted", () => {
    const w = world();
    const value = `Vb${randomBytes(15).toString("hex")}`;
    play(w, "bridge", 1, { out: `debug x-vercel-protection-bypass: ${value}\n${DELIVER_NONE}` });
    const r = cycle(w);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(value);
    expect(r.out).toContain("x-vercel-protection-bypass: [redacted]");
  });
});

describe("cycle.sh: lock and output", () => {
  it("another cycle holds the lock → CYCLE_LOCKED (exit 11) without doing anything", async () => {
    const w = world();
    const state = join(w.t, "var/lib/sr-design-cycle");
    mkdirSync(state, { recursive: true });
    const holder = spawn("flock", [join(state, "cycle.lock"), "-c", `touch '${join(w.t, "held")}'; sleep 30`], { stdio: "ignore" });
    for (let i = 0; i < 100 && !existsSync(join(w.t, "held")); i += 1) await new Promise((r) => setTimeout(r, 50));
    try {
      const r = cycle(w);
      expect(r.status).toBe(11);
      expect(r.last).toBe("CYCLE_RESULT CYCLE_LOCKED phase=before_claim job=none exit=11");
      expect(r.calls).toBe("");
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("prints no URL, e-mail, bearer value, key=value secret, JWT or random token from a child", () => {
    const w = world();
    const random = `Rq7${randomBytes(40).toString("base64")}`;
    const jwt = ["eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiJ4In0", ".", "c2lnbmF0dXJlLXZhbHVl"].join("");
    const hex = randomBytes(16).toString("hex");
    const hex2 = randomBytes(20).toString("hex");
    const leaks = [`https://www.instagram.com/some_shop/`, "owner@shop.example", "Authorization: Bearer abc.def.ghi", `token=${random}`, `cookie: sessionid=abcdef123456`, jwt, random, w.apiUrl, w.token, hex, hex2];
    // JSON keys, header style, every cookie pair
    const values = ["qvalue1z", "ckvalA1", "ckvalB2", "ckvalC3", "setckv9", "hdrval7q", "sqvalue2"];
    const shapes = [
      `"access_token": "${hex}"`,
      `{"refresh_token":"qvalue1z","n":1}`,
      `x-api-key ${hex2}`,
      "X-Api-Key: hdrval7q",
      "Cookie: a=ckvalA1; b=ckvalB2; c=ckvalC3",
      "Set-Cookie: sid=setckv9; Path=/; HttpOnly",
      "'client_secret': 'sqvalue2'",
    ];
    play(w, "admin", 2, {
      out: [`${ts} bridge: imported 1`, `${ts} job ${JOB}: claimed`, ...[...leaks, ...shapes].map((l) => `${ts} job ${JOB}: debug ${l}`), `${ts} job ${JOB}: demo ${JOB.slice(2)}`, `${ts} bridge: exported 1`].join("\n"),
    });
    const r = cycle(w);
    expect(r.status).toBe(0);
    for (const leak of [...leaks, ...values]) expect(r.out).not.toContain(leak);
    // the keys stay readable, only the values go
    expect(r.out).toContain('"access_token": [redacted]');
    expect(r.out).toContain('"refresh_token":[redacted]');
    expect(r.out).toContain("x-api-key [redacted]");
    expect(r.out).toContain("Cookie: a=[redacted]");
    // a plain UUID (the demo's design_job_id) stays
    expect(r.out).toContain(`demo ${JOB.slice(2)}`);
    expect(r.out).not.toContain("abcdef123456");
    expect(r.out).toContain("[url]");
    expect(r.out).toContain("[email]");
    expect(r.out).toContain("[redacted]");
    // job ids, fixed codes and commits stay readable
    expect(r.out).toContain(`job ${JOB}: claimed`);
    expect(r.out).toContain("design worker 0123456789ab");
  });
});

describe("cycle.sh: budget and units agree with the code they call", () => {
  const script = readFileSync(CYCLE, "utf8");
  const num = (name: string) => Number(new RegExp(`^${name}=(\\d+)`, "m").exec(script)![1]);

  it("follows R2: claim with ≥ 4220 s left, the worker with ≥ 3960 s, budget 4500 s, worker budget 3300 s", () => {
    expect(num("CYCLE_BUDGET")).toBe(4500);
    expect(num("CLAIM_MIN_LEFT")).toBe(4220);
    expect(num("WORKER_MIN_LEFT")).toBe(3960);
    expect(num("WORKER_BUDGET")).toBe(3300);
    const admin = readFileSync(join(REPO, "scripts/sales-design-capture/admin.sh"), "utf8");
    expect(num("WORKER_RUNTIME_MAX")).toBe(Number(/RuntimeMaxSec=(\d+)/.exec(admin)![1]));
    const workerRun = readFileSync(join(REPO, "scripts/sales-design-worker/run.sh"), "utf8");
    expect(num("WORKER_BUDGET")).toBe(Number(/\[ "\$BUDGET" -le (\d+) \]/.exec(workerRun)![1]));
    const bridgeRun = readFileSync(join(REPO, "scripts/sales-design-bridge/run.sh"), "utf8");
    const [, kill, bridgeTimeout] = /timeout --kill-after=(\d+) (\d+) /.exec(bridgeRun)!;
    expect(num("BRIDGE_TIMEOUT")).toBe(Number(bridgeTimeout));
    expect(num("BRIDGE_MAX")).toBeGreaterThanOrEqual(Number(bridgeTimeout) + Number(kill) + 5);
    // the worker at worst (RuntimeMaxSec + the stop grace) and the last pass fit after the worker guard
    expect(num("WORKER_MIN_LEFT")).toBeGreaterThanOrEqual(num("WORKER_RUNTIME_MAX") + num("WORKER_STOP_GRACE") + num("BRIDGE_MAX"));
    // the claim pass at worst (BRIDGE_MAX, not the bridge's own timeout) and the worker guard fit after the claim guard
    expect(num("CLAIM_MIN_LEFT")).toBeGreaterThanOrEqual(num("WORKER_MIN_LEFT") + num("BRIDGE_MAX"));
    expect(script).toMatch(/\$\(\(WORKER_MIN_LEFT \+ BRIDGE_MAX\)\)/);
    expect(script).toContain("SR_DESIGN_WORKER_REF=\"$WORKER_REF\"");
    expect(script).toMatch(/^WORKER_REF=develop$/m);
  });

  it("the service gives the cycle more than its budget, and nothing in the repo installs or enables it", () => {
    const service = readFileSync(join(UNIT_DIR, "sr-design-cycle.service"), "utf8");
    const timer = readFileSync(join(UNIT_DIR, "sr-design-cycle.timer"), "utf8");
    const timeoutStart = Number(/^TimeoutStartSec=(\d+)$/m.exec(service)![1]);
    expect(timeoutStart).toBeGreaterThan(num("CYCLE_BUDGET") + 60);
    expect(service).toMatch(/^ExecStart=\/usr\/bin\/bash \/root\/sr-capture-admin\/scripts\/sales-design-worker\/cycle\.sh$/m);
    expect(service).toMatch(/^SuccessExitStatus=10 11$/m);
    expect(service).not.toMatch(/^User=/m);
    for (const unit of [service, timer]) expect(unit.split("\n")[0]).toMatch(/NOT installed or enabled/);
    expect(timer).toMatch(/^RandomizedDelaySec=/m);
    for (const f of ["scripts", "docs"]) {
      const grep = spawnSync("grep", ["-rlE", "systemctl (--now )?enable( --now)? sr-design-cycle", join(REPO, f)], { encoding: "utf8" });
      // only the runbook shows the (human, approved) enable command
      expect(grep.stdout.trim().split("\n").filter(Boolean).every((p) => p === DOC)).toBe(true);
    }
  });
});
