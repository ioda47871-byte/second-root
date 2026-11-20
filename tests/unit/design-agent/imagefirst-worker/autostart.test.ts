import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { WorkerReceipt } from "@/lib/design-agent/imagefirst-worker/cycle";
import { acquireLock } from "@/lib/design-agent/worker/state";
import { APPROVAL_PACKET_PATH } from "@/lib/design-agent/phase2f-live/full-page-call";
import { UNAPPROVED_PACKET_FIXTURE } from "../image-first/fixtures/unapproved-packet";
import { cleanupTemps, commitFiles, filledPacket, git, ID, NOW, REPO, tmp, workerRepo } from "./support";

// Issue #302 P1: the automatic start (scripts/sales-design-worker/imagefirst-autostart.sh), the real file, against a fake
// WSL under SR_IMAGEFIRST_AUTOSTART_TEST_ROOT: temp dirs stand in for /etc/sr-design-worker (the owner's switch and
// one-use run marker), /var/lib (root's state, cycle.sh's lock) and the worker's home with its dedicated clone of a
// temporary bare origin (git fetch here never leaves this machine). systemctl, pgrep and npm are stubs. The clone's
// scripts/sales-design-worker/imagefirst-worker.ts imports fixtures/fake-worker.ts (run as node --import tsx): the real worker's main() over the real cycle, with the entry
// played in-process against the fake Codex. No Codex, no model, no network, no root, no systemd.

vi.setConfig({ testTimeout: 120_000 });
// removing ~30 temp worlds (each a bare origin and a clone) takes seconds under load: more than the 10 s hook default
afterAll(cleanupTemps, 60_000);
const SCRIPT = join(REPO, "scripts/sales-design-worker/imagefirst-autostart.sh");
const UNIT_DIR = join(REPO, "scripts/sales-design-worker/systemd");
const FAKE_WORKER = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/fake-worker.ts");
const exe = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

const startLog = (home: string) =>
  existsSync(join(home, "fake-worker-starts.log")) ? readFileSync(join(home, "fake-worker-starts.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; grant: string | null; execArgv: string[] }) : [];

/** One fake WSL. The origin starts with the UNAPPROVED packet; `approve()` pushes the owner's filled-in §10. */
function wsl() {
  const t = tmp("sr-ifa-");
  const etc = join(t, "etc", "sr-design-worker");
  const home = join(t, "home", "sr-designgen");
  const sc = join(t, "sc");
  const bin = join(t, "bin");
  for (const d of [etc, join(t, "var", "lib"), home, sc, bin]) mkdirSync(d, { recursive: true });
  chmodSync(home, 0o700);
  writeFileSync(join(t, "clock"), String(NOW / 1000));
  // systemctl show -p ActiveState --value <unit>: sc/<unit> holds the state (default inactive); sc/show-fail = an error
  // systemctl is-enabled <unit>: sc/enabled-<unit> holds the answer (default disabled, exit 1); sc/isenabled-fail = no answer
  exe(
    join(bin, "systemctl"),
    `echo "$*" >> '${sc}/systemctl.log'; u="\${@: -1}"
if [ "$1" = is-enabled ]; then [ -f '${sc}/isenabled-fail' ] && exit 1; if [ -f '${sc}'/enabled-"$u" ]; then cat '${sc}'/enabled-"$u"; exit 0; fi; echo disabled; exit 1; fi
[ -f '${sc}/show-fail' ] && exit 1; if [ -f '${sc}'/"$u" ]; then cat '${sc}'/"$u"; else echo inactive; fi`,
  );
  // the privilege drop's stand-in: records its options, then execs the command after "--" (as setpriv does: no
  // supervising parent). A test may swap in a runuser-like supervisor to show that path loses the worker's line.
  exe(join(bin, "setpriv"), `opts=(); while [ "$1" != "--" ]; do opts+=("$1"); shift; done; shift; echo "\${opts[*]}" >> '${sc}/setpriv.log'; exec "$@"`);
  // pgrep: sc/pgrep = a process of the worker user; sc/pgrep-error = pgrep cannot tell
  exe(join(bin, "pgrep"), `[ -f '${sc}/pgrep-error' ] && exit 3; [ -f '${sc}/pgrep' ] && exit 0; exit 1`);
  exe(join(bin, "npm"), `echo "npm $*" >> '${sc}/npm.log'`);
  // the approved code at origin/develop: the prompt inputs, the packet, a lockfile, node_modules ignored
  const src = workerRepo(readFileSync(UNAPPROVED_PACKET_FIXTURE));
  // the clone's worker is the fake worker (imported by absolute path), started as the real one: node --import tsx <it>
  commitFiles(
    src,
    { ".gitignore": Buffer.from("node_modules\n"), "package-lock.json": Buffer.from("{}\n"), "scripts/sales-design-worker/imagefirst-worker.ts": Buffer.from(`import ${JSON.stringify(FAKE_WORKER)};\n`) },
    "lockfile and worker (test)",
  );
  const origin = join(t, "origin.git");
  git(t, "init", "-q", "--bare", origin);
  git(src, "push", "-q", origin, "HEAD:refs/heads/develop");
  const clone = join(home, "imagefirst", "second-root");
  mkdirSync(join(home, "imagefirst"));
  git(t, "clone", "-q", "--branch", "develop", origin, clone);
  // the tsx loader (the repository's own) for `node --import tsx`; the tsx CLI must not be used (it relays signals twice)
  mkdirSync(join(clone, "node_modules", ".bin"), { recursive: true });
  symlinkSync(join(REPO, "node_modules", "tsx"), join(clone, "node_modules", "tsx"), "dir");
  exe(join(clone, "node_modules", ".bin", "tsx"), `echo "the tsx CLI was used" >> '${sc}/tsx-cli.log'; exit 99`);
  writeFileSync(join(home, "fake-codex-mode"), "six");
  const w = {
    t,
    etc,
    home,
    sc,
    bin,
    src,
    origin,
    clone,
    env: { PATH: `${bin}:${process.env.PATH}`, SR_IMAGEFIRST_AUTOSTART_TEST_ROOT: t, OPENAI_API_KEY: "should-not-pass" } as unknown as NodeJS.ProcessEnv,
    state: join(t, "var", "lib", "sr-imagefirst-autostart"),
    switchOn: (body: object = { enabled: true }) => writeFileSync(join(etc, "imagefirst-autostart.json"), JSON.stringify(body), { mode: 0o644 }),
    marker: (body: object = { approval_id: ID, expires_at: "2026-11-20T09:00:00Z" }) => writeFileSync(join(etc, "imagefirst-run.json"), JSON.stringify(body), { mode: 0o644 }),
    approve: (packet: Buffer = filledPacket()) => {
      commitFiles(src, { [APPROVAL_PACKET_PATH]: packet }, "owner approval (test)");
      git(src, "push", "-q", origin, "HEAD:refs/heads/develop");
    },
    /** worker runs (prechecks excluded) */
    starts: () => startLog(home).filter((e) => !e.argv.includes("--precheck")),
    prechecks: () => startLog(home).filter((e) => e.argv.includes("--precheck")),
    execs: () => (existsSync(join(home, "codex-execs.log")) ? readFileSync(join(home, "codex-execs.log"), "utf8").trim().split("\n").filter(Boolean).length : 0),
    used: () => (existsSync(join(t, "var", "lib", "sr-imagefirst-autostart", "used")) ? readdirSync(join(t, "var", "lib", "sr-imagefirst-autostart", "used")) : []),
    receipts: () => (existsSync(join(home, "sr-runs")) ? readdirSync(join(home, "sr-runs")).filter((n) => n.endsWith(".receipt.json")).map((n) => JSON.parse(readFileSync(join(home, "sr-runs", n), "utf8")) as WorkerReceipt) : []),
  };
  return w;
}
type W = ReturnType<typeof wsl>;

type Poll = { status: number | null; stdout: string; code: string; phase: string; approval: string; worker: { status?: string; code?: string | null; invoked?: boolean } | null };
function parse(status: number | null, stdout: string): Poll {
  const last = stdout.trim().split("\n").pop() ?? "";
  const m = /^IMAGEFIRST_AUTOSTART (\S+) phase=(\S+) approval=(\S+) exit=(\d+)$/.exec(last);
  expect(m, stdout).not.toBeNull();
  expect(Number(m![4])).toBe(status);
  const workerLine = /^imagefirst-autostart: worker: (\{.*\})$/m.exec(stdout);
  return { status, stdout, code: m![1]!, phase: m![2]!, approval: m![3]!, worker: workerLine ? (JSON.parse(workerLine[1]!) as Poll["worker"]) : null };
}
const poll = (w: W, args: string[] = []): Poll => {
  const r = spawnSync("bash", [SCRIPT, ...args], { env: w.env, encoding: "utf8", timeout: 100_000 });
  return parse(r.status, r.stdout);
};
function pollAsync(w: W): { child: ChildProcess; done: Promise<Poll> } {
  const child = spawn("bash", [SCRIPT], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
  const done = new Promise<Poll>((res) => child.on("close", (code) => res(parse(code, out))));
  return { child, done };
}
const until = async (cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};
/** Nothing was started and the marker is unused. */
const nothingRan = (w: W) => {
  expect(w.starts()).toEqual([]);
  expect(w.execs()).toBe(0);
  expect(w.used()).toEqual([]);
  expect(w.receipts()).toEqual([]);
};

describe("Issue #302 P1 automatic start: owner-approved commit → poll → single call → receipt (fake WSL, fake Codex)", () => {
  it("unapproved: no job and the marker stays unused; approved: one call, a receipt; the next poll: nothing", async () => {
    const w = wsl();
    w.switchOn();
    w.marker();
    // the packet at origin/develop is not approved yet: zero calls, the owner's marker is kept for later
    const before = poll(w);
    expect(before).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_NOT_RUNNABLE", phase: "before_claim", approval: ID });
    expect(before.stdout).toContain('"status":"no_job","code":"PACKET_NOT_APPROVED"');
    nothingRan(w);
    // the worker's own precheck answered, with the marker's approval id, and wrote nothing
    expect(w.prechecks()).toEqual([{ argv: ["scripts/sales-design-worker/imagefirst-worker.ts", "--precheck"], grant: ID, execArgv: ["--import", "tsx"] }]);
    expect(existsSync(join(w.home, ".local", "state", "sr-design-worker", "imagefirst-worker"))).toBe(false);
    // the owner merges the filled-in §10; the next hourly poll picks it up
    w.approve();
    const run = poll(w);
    expect(run).toMatchObject({ status: 0, code: "AUTOSTART_RAN", phase: "after_claim", approval: ID });
    expect(run.worker).toMatchObject({ status: "succeeded", code: null, invoked: true });
    expect(w.starts()).toEqual([{ argv: ["scripts/sales-design-worker/imagefirst-worker.ts"], grant: ID, execArgv: ["--import", "tsx"] }]);
    expect(w.execs()).toBe(1);
    expect(w.used()).toEqual([ID]);
    expect(statSync(join(w.state, "used", ID)).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(w.state, "used", ID, "used"), "utf8")).toContain(`approval_id=${ID}\ncommit=${git(w.src, "rev-parse", "HEAD")}`);
    const [receipt] = w.receipts();
    expect(receipt).toMatchObject({ status: "succeeded", approval_id: ID, verified: true, counts: { pc: 2, sp: 4, total: 6 }, commit: git(w.src, "rev-parse", "HEAD") });
    // the clone was fast-forwarded onto origin/develop, nothing changed in it
    expect(git(w.clone, "rev-parse", "HEAD")).toBe(git(w.src, "rev-parse", "HEAD"));
    expect(git(w.clone, "status", "--porcelain", "--untracked-files=all")).toBe("");
    // npm ci ran once for the new lockfile, never with an API key in the environment
    expect(readFileSync(join(w.sc, "npm.log"), "utf8").trim().split("\n")).toEqual(["npm ci --no-audit --no-fund --loglevel=error"]);
    expect(run.stdout).not.toContain("should-not-pass");
    // second poll: the marker is used: no call
    expect(poll(w)).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_MARKER_USED" });
    expect(w.starts()).toHaveLength(1);
    expect(w.execs()).toBe(1);
    // even a fresh marker for the same approval id: used (the worker's claim and the entry's ledger would refuse too)
    w.marker();
    expect(poll(w)).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_MARKER_USED" });
    expect(w.execs()).toBe(1);
  });

  it("the switch: absent = OFF and nothing touched; enabled:false = OFF; unsafe or invalid = refused; no call in any case", () => {
    const w = wsl();
    w.approve();
    w.marker();
    expect(poll(w)).toMatchObject({ status: 0, code: "AUTOSTART_OFF", approval: "none" });
    expect(existsSync(w.state)).toBe(false);
    w.switchOn({ enabled: false });
    expect(poll(w)).toMatchObject({ status: 0, code: "AUTOSTART_OFF" });
    w.switchOn({ enabled: "yes" });
    expect(poll(w)).toMatchObject({ status: 2, code: "AUTOSTART_SWITCH_INVALID" });
    w.switchOn({ enabled: true, extra: 1 });
    expect(poll(w)).toMatchObject({ status: 2, code: "AUTOSTART_SWITCH_INVALID" });
    w.switchOn();
    chmodSync(join(w.etc, "imagefirst-autostart.json"), 0o666);
    expect(poll(w)).toMatchObject({ status: 2, code: "AUTOSTART_SWITCH_UNSAFE" });
    nothingRan(w);
  });

  it("the marker: missing, expired, too far, invalid (the dummy PoC's reserved date included) or already used = no call", () => {
    const w = wsl();
    w.approve();
    w.switchOn();
    expect(poll(w)).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_NO_MARKER" });
    w.marker({ approval_id: ID, expires_at: "2026-11-20T00:59:59Z" });
    expect(poll(w)).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_MARKER_EXPIRED" });
    w.marker({ approval_id: ID, expires_at: "2026-11-21T01:00:01Z" });
    expect(poll(w)).toMatchObject({ status: 2, code: "AUTOSTART_MARKER_INVALID" });
    for (const bad of [{ approval_id: "tsugute-imagefirst-d3-20261120-01", expires_at: "2026-11-20T09:00:00Z" }, { approval_id: ID }, { approval_id: `${ID}/../x`, expires_at: "2026-11-20T09:00:00Z" }, { approval_id: "hoshigama-imagefirst-d3-00000000-00", expires_at: "2026-11-20T09:00:00Z" }]) {
      w.marker(bad);
      expect(poll(w)).toMatchObject({ status: 2, code: "AUTOSTART_MARKER_INVALID" });
    }
    w.marker();
    chmodSync(join(w.etc, "imagefirst-run.json"), 0o664);
    expect(poll(w)).toMatchObject({ status: 2, code: "AUTOSTART_MARKER_UNSAFE" });
    nothingRan(w);
    // used before (root's state): no call
    chmodSync(join(w.etc, "imagefirst-run.json"), 0o644);
    mkdirSync(join(w.state, "used", ID), { recursive: true });
    expect(poll(w)).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_MARKER_USED" });
    expect(w.starts()).toEqual([]);
    expect(w.execs()).toBe(0);
  });

  it("the jailed Claude or a design cycle running (or unknown), or any worker-user process: busy, no call, marker unused", async () => {
    const cases: [string, (w: W) => void | Promise<void>][] = [
      ["sr-jail-claude active", (w) => writeFileSync(join(w.sc, "sr-jail-claude.service"), "active")],
      ["sr-design-cycle activating", (w) => writeFileSync(join(w.sc, "sr-design-cycle.service"), "activating")],
      ["systemctl fails", (w) => writeFileSync(join(w.sc, "show-fail"), "")],
      ["a worker-user process", (w) => writeFileSync(join(w.sc, "pgrep"), "")],
      ["pgrep cannot tell", (w) => writeFileSync(join(w.sc, "pgrep-error"), "")],
      // as cycle.sh's DEV-187 grant: an enabled jailed Claude is started again by sr-jail-net, so it is busy even when inactive
      ["sr-jail-claude enabled (inactive)", (w) => writeFileSync(join(w.sc, "enabled-sr-jail-claude.service"), "enabled")],
      ["sr-jail-claude is-enabled gives no answer", (w) => writeFileSync(join(w.sc, "isenabled-fail"), "")],
    ];
    for (const [name, arrange] of cases) {
      const w = wsl();
      w.approve();
      w.switchOn();
      w.marker();
      await arrange(w);
      expect(poll(w), name).toMatchObject({ status: 12, code: "AUTOSTART_BUSY" });
      nothingRan(w);
    }
    // cycle.sh's own lock held by a running cycle
    const w = wsl();
    w.approve();
    w.switchOn();
    w.marker();
    const cycleState = join(w.t, "var", "lib", "sr-design-cycle");
    mkdirSync(cycleState, { mode: 0o700 });
    const ready = join(w.sc, "cycle-holds");
    const holder = spawn("flock", [join(cycleState, "cycle.lock"), "bash", "-c", `touch '${ready}'; sleep 30`], { stdio: "ignore" });
    await until(() => existsSync(ready));
    expect(poll(w)).toMatchObject({ status: 12, code: "AUTOSTART_BUSY" });
    nothingRan(w);
    holder.kill("SIGKILL");
  });

  it("git fetch fails, or the clone is dirty / diverged: stopped before the marker, no call", () => {
    const w = wsl();
    w.approve();
    w.switchOn();
    w.marker();
    renameSync(w.origin, `${w.origin}.gone`);
    expect(poll(w)).toMatchObject({ status: 20, code: "AUTOSTART_STOP_FETCH", phase: "before_claim" });
    nothingRan(w);
    renameSync(`${w.origin}.gone`, w.origin);
    writeFileSync(join(w.clone, "stray.txt"), "x");
    expect(poll(w)).toMatchObject({ status: 20, code: "AUTOSTART_STOP_TREE_DIRTY" });
    nothingRan(w);
    expect(existsSync(join(w.clone, "stray.txt"))).toBe(true);
    const diverged = wsl();
    diverged.approve();
    diverged.switchOn();
    diverged.marker();
    commitFiles(diverged.clone, { "local.txt": Buffer.from("x") }, "a local commit (test)");
    expect(poll(diverged)).toMatchObject({ status: 20, code: "AUTOSTART_STOP_NOT_FAST_FORWARD" });
    nothingRan(diverged);
  });

  it("two polls at once: one wins (the other is locked), one call", async () => {
    const w = wsl();
    w.approve();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.home, "fake-worker-hold"), "");
    const first = pollAsync(w);
    await until(() => w.starts().length === 1);
    expect(poll(w)).toMatchObject({ status: 11, code: "AUTOSTART_LOCKED" });
    // remove the hold: the first poll's single run finishes
    spawnSync("rm", ["-f", join(w.home, "fake-worker-hold")]);
    expect(await first.done).toMatchObject({ status: 0, code: "AUTOSTART_RAN" });
    expect(w.starts()).toHaveLength(1);
    expect(w.execs()).toBe(1);
    expect(w.used()).toEqual([ID]);
  });

  it("a stop signal during the run: passed on to the worker, which ends with its WORKER_INTERRUPTED receipt; no retry", async () => {
    const w = wsl();
    w.approve();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.home, "fake-codex-mode"), "hang");
    // the stop takes longer than runuser's 2 s: the poll must still wait for the worker's receipt
    writeFileSync(join(w.home, "fake-codex-stop-delay-ms"), "3500");
    const p = pollAsync(w);
    await until(() => w.execs() === 1);
    p.child.kill("SIGTERM");
    const r = await p.done;
    expect(r, r.stdout).toMatchObject({ status: 1, code: "AUTOSTART_INTERRUPTED", phase: "after_claim" });
    expect(r.worker, r.stdout).toMatchObject({ status: "stopped", code: "WORKER_INTERRUPTED", invoked: true });
    // the worker ran through the privilege drop's stand-in with the production options
    expect(readFileSync(join(w.sc, "setpriv.log"), "utf8")).toMatch(/^--reuid=\d+ --regid=\d+ --init-groups --reset-env --no-new-privs$/m);
    // node with the tsx loader, never the tsx CLI (M4: one stop = one SIGTERM to the worker)
    expect(existsSync(join(w.sc, "tsx-cli.log"))).toBe(false);
    expect(startLog(w.home).every((e) => e.execArgv.join(" ") === "--import tsx")).toBe(true);
    const [receipt] = w.receipts();
    expect(receipt).toMatchObject({ status: "stopped", stop_code: "WORKER_INTERRUPTED", interrupted: true, approval_id: ID });
    const audit = readFileSync(join(w.home, ".local", "state", "sr-design-worker", "imagefirst-worker", "audit.jsonl"), "utf8");
    expect(audit).toContain('"code":"WORKER_INTERRUPTED"');
    // the next poll: nothing (the marker is used; the worker's claim would refuse too)
    writeFileSync(join(w.home, "fake-codex-mode"), "six");
    expect(poll(w)).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_MARKER_USED" });
    expect(w.starts()).toHaveLength(1);
    expect(w.execs()).toBe(1);
  });

  it("the worker's precheck says it would not run (expired, a pin mismatch, another approval id): the marker is NOT used, no call", () => {
    const plan = "a19b6896ffd50111df9ad7029f49ded5757999ddfb31943103a206f6a44072a8";
    const cases: [string, Buffer, object | undefined, string][] = [
      ["expired packet", filledPacket({ expires: "`2026-11-20T00:59:59Z`" }), undefined, "APPROVAL_EXPIRED"],
      ["pin mismatch", filledPacket({}, (t) => t.replace(`\`${plan}\``, `\`${"0".repeat(64)}\``)), undefined, "PACKET_PIN_MISMATCH"],
      ["another approval id than the marker's", filledPacket(), { approval_id: "hoshigama-imagefirst-d3-20261120-02", expires_at: "2026-11-20T09:00:00Z" }, "APPROVAL_NOT_GRANTED"],
    ];
    for (const [name, packet, marker, code] of cases) {
      const w = wsl();
      w.approve(packet);
      w.switchOn();
      w.marker(marker);
      const r = poll(w);
      expect(r, name).toMatchObject({ status: 10, code: "AUTOSTART_IDLE_NOT_RUNNABLE", phase: "before_claim" });
      expect(r.stdout, name).toContain(`"code":"${code}"`);
      nothingRan(w);
      expect(w.prechecks(), name).toHaveLength(1);
      expect(existsSync(join(w.home, "sr-runs")), name).toBe(false);
    }
  });

  it("a supervising privilege drop (runuser-like: SIGKILL 2 s after passing on SIGTERM) would end the poll without the worker's line", async () => {
    // the failure the setpriv exec avoids: shown with a stand-in, so the stop test above is known to detect it
    const w = wsl();
    w.approve();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.home, "fake-codex-mode"), "hang");
    // the worker's stop cannot end until the test has looked (deterministic under load: no race with the orphan)
    writeFileSync(join(w.home, "fake-codex-stop-hold"), "");
    exe(join(w.bin, "setpriv"), `while [ "$1" != "--" ]; do shift; done; shift; "$@" & c=$!; trap 'kill -TERM $c; sleep 2; kill -KILL $c 2>/dev/null; exit 1' TERM; wait $c; wait $c`);
    const p = pollAsync(w);
    await until(() => w.execs() === 1);
    const signalledAt = Date.now();
    p.child.kill("SIGTERM");
    const r = await p.done;
    // the supervisor's SIGKILL (2 s) ends the poll: far inside the worker's own stop windows (graceful 35 s, hard 50 s).
    // Without the supervisor the poll would wait for the worker's hard stop (~50 s) and fail here.
    expect(Date.now() - signalledAt).toBeLessThan(15_000);
    expect(r.worker).toBeNull();
    expect(r.stdout).toContain("worker: <no line>");
    // The worker's graceful stop never finished (it is held): no receipt of it. Whether a receipt exists already depends
    // on the timeout(1) between the stand-in and node. GNU coreutils 9.4: none yet. uutils timeout (Ubuntu 26.04, the CI
    // runner) sets the child's parent-death signal to SIGTERM, so the stand-in's SIGKILL of timeout reaches node as a
    // second SIGTERM 2 s after the first: the worker's hard stop, which writes the receipt from what is on disk with no
    // result of the entry (cli_exit null) and exits. Either way the poll ended without the worker's line.
    const early = w.receipts();
    expect(early.length).toBeLessThanOrEqual(1);
    for (const x of early) expect(x).toMatchObject({ status: "stopped", stop_code: "WORKER_INTERRUPTED", stage: "call", interrupted: true, cli_exit: null, approval_id: ID });
    // let the orphaned fake worker (if still running) finish before the temp dir goes
    // (in production systemd's KillMode=mixed SIGKILLs it here)
    spawnSync("rm", ["-f", join(w.home, "fake-codex-stop-hold")]);
    await until(() => w.receipts().length === 1);
    // the run ends exactly once: a hard stop's receipt is never replaced by a later one
    if (early.length === 1) expect(w.receipts()).toEqual(early);
  });

  it("the worker's own lock held when it starts after the marker: AUTOSTART_USED_LOCKED (not RAN), nothing called", async () => {
    const w = wsl();
    w.approve();
    w.switchOn();
    w.marker();
    const held = await acquireLock(join(w.home, ".local", "state", "sr-design-worker", "imagefirst-worker"), new Date(), "imagefirst.lock");
    expect(held).toBeDefined();
    const r = poll(w);
    expect(r).toMatchObject({ status: 10, code: "AUTOSTART_USED_LOCKED", phase: "after_claim" });
    expect(r.worker).toMatchObject({ status: "locked", invoked: false });
    expect(w.execs()).toBe(0);
    expect(w.used()).toEqual([ID]);
    await held!.release();
  });

  it("refuses arguments, and any copy outside the root-only clone without the test world", () => {
    const w = wsl();
    expect(poll(w, ["--now"])).toMatchObject({ status: 2, code: "AUTOSTART_USAGE" });
    const r = spawnSync("bash", [SCRIPT], { env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(parse(r.status, r.stdout)).toMatchObject({ status: 2, code: "AUTOSTART_USAGE" });
    expect(r.stdout).toContain("run from the root-only clone");
  });
});

describe("Issue #302 P1 automatic start: the units are code and documentation only (never installed or enabled here)", () => {
  const service = readFileSync(join(UNIT_DIR, "sr-imagefirst-autostart.service"), "utf8");
  const timer = readFileSync(join(UNIT_DIR, "sr-imagefirst-autostart.timer"), "utf8");
  const script = readFileSync(SCRIPT, "utf8");
  const num = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(script)![1]);

  it("the service: root's script from the root-only clone, hourly oneshot, budgets inside its limits, resource limits", () => {
    for (const unit of [service, timer]) expect(unit.split("\n")[0]).toMatch(/NOT installed or enabled/);
    expect(service).toMatch(/^ExecStart=\/usr\/bin\/bash \/root\/sr-capture-admin\/scripts\/sales-design-worker\/imagefirst-autostart\.sh$/m);
    expect(service).not.toMatch(/^User=/m);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^SuccessExitStatus=10 11 12$/m);
    expect(service).toMatch(/^KillMode=mixed$/m);
    const start = Number(/^TimeoutStartSec=(\d+)$/m.exec(service)![1]);
    const stop = Number(/^TimeoutStopSec=(\d+)$/m.exec(service)![1]);
    const k = num("KILL_AFTER");
    const worst = num("FETCH_TIMEOUT") + k + 5 * (num("GIT_TIMEOUT") + k) + num("NPM_TIMEOUT") + k + num("PRECHECK_TIMEOUT") + k + num("WORKER_TIMEOUT") + num("WORKER_KILL_AFTER");
    expect(start).toBeGreaterThan(worst);
    // the worker's own stop (50 s hard stop + 10 s receipt) fits inside both the wrapper's kill-after and the unit's stop
    expect(num("WORKER_KILL_AFTER")).toBeGreaterThan(60);
    expect(stop).toBeGreaterThan(num("WORKER_KILL_AFTER"));
    // the worker runs with no supervising parent: setpriv execs (runuser would SIGKILL it 2 s after passing on a SIGTERM)
    expect(script).toMatch(/^AS_WORKER=\(setpriv --reuid="\$worker_uid" --regid="\$worker_gid" --init-groups --reset-env --no-new-privs -- env -i /m);
    for (const l of script.split("\n").filter((x) => /imagefirst-worker\.ts/.test(x) && !x.trimStart().startsWith("#"))) expect(l).toMatch(/^\s*node --import tsx scripts\/sales-design-worker\/imagefirst-worker\.ts/);
    expect(script.match(/timeout --foreground --kill-after=/g)).toHaveLength(2);
    expect(script.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n")).not.toMatch(/\brunuser\b/);
    expect(script).not.toMatch(/PRECHECK_PY|python3 -I -c "\$PRECHECK/);
    for (const key of ["MemoryMax", "MemoryHigh", "CPUWeight", "TasksMax", "Nice", "IOSchedulingClass"]) expect(service).toMatch(new RegExp(`^${key}=\\S+$`, "m"));
    expect(service).toMatch(/^StateDirectory=sr-imagefirst-autostart$/m);
    expect(service).toMatch(/^StateDirectoryMode=0700$/m);
    expect(service).toMatch(/^NoNewPrivileges=yes$/m);
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* \*:\d{2}:00$/m);
    expect(timer).toMatch(/^RandomizedDelaySec=/m);
  });

  it("nothing in the repository installs, enables or starts it; only the runbook shows the owner's commands", () => {
    const grep = (pattern: string) => spawnSync("git", ["grep", "--untracked", "-lE", pattern, "--", ".", ":!tests/**"], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
    expect(grep("systemctl.*(enable|start).*sr-imagefirst-autostart")).toEqual(["docs/operations/imagefirst-worker-port.md"]);
    // only the service names the script; only the script names the worker on a command line
    expect(grep("(bash|sh|ExecStart)\\b.*imagefirst-autostart\\.sh").filter((p) => !p.startsWith("docs/"))).toEqual(["scripts/sales-design-worker/imagefirst-autostart.sh", "scripts/sales-design-worker/systemd/sr-imagefirst-autostart.service"]);
    expect(service).not.toMatch(/imagefirst-worker\.ts/);
    // the existing cycle units are untouched by this change: still their own script, never the automatic start
    const cycle = readFileSync(join(UNIT_DIR, "sr-design-cycle.service"), "utf8");
    expect(cycle).not.toMatch(/imagefirst/);
  });
});
