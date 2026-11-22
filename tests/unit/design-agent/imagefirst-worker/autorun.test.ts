import { spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exe, ID, loadPngs, PILOT, PREFLIGHT, SCRIPTS, wsl } from "./pilot-world";
import { cleanupTemps, commitFiles, git, REPO, tmp } from "./support";

// Issue #302: the automatic run (scripts/sales-design-worker/imagefirst-autorun.sh), the real file, against the pilot's fake
// WSL (./pilot-world.ts) under SR_IMAGEFIRST_AUTORUN_TEST_ROOT: the REAL pilot, preflight and re-send wrapper, the stub worker
// and audit CLIs, systemctl / setpriv / pgrep stubs, and a stand-in for admin.sh that records claude-stop / claude-start and
// flips the fake jail's state. The service's cgroup is a file of the test world (the production copy reads the kernel's).
// No root, no systemd, no Remote Control, no network, no model.

vi.setConfig({ testTimeout: 600_000 });
afterAll(cleanupTemps, 60_000);
beforeAll(loadPngs);
const AUTORUN = join(SCRIPTS, "imagefirst-autorun.sh");
const AUTOSTART = join(SCRIPTS, "imagefirst-autostart.sh");
const APPROVE = join(SCRIPTS, "imagefirst-approve.sh");
const UNIT_DIR = join(SCRIPTS, "systemd");
const D4 = "hoshigama-imagefirst-d4-20261121-01";
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Root's admin clone's stand-in (a clone of the test origin, at origin's develop) and an npm stub; returns its path. */
const adminClone = (w: ReturnType<typeof wsl>) => {
  const admin = join(w.t, "root", "sr-capture-admin");
  mkdirSync(join(w.t, "root"), { recursive: true });
  git(w.t, "clone", "-q", "--branch", "develop", w.origin, admin);
  exe(join(w.bin, "npm"), `echo "npm $* userconfig=\${npm_config_userconfig:-} globalconfig=\${npm_config_globalconfig:-}" >> '${w.sc}/npm.log'`);
  return admin;
};
const insideService = (w: ReturnType<typeof wsl>) => {
  mkdirSync(join(w.t, "proc", "self"), { recursive: true });
  writeFileSync(join(w.t, "proc", "self", "cgroup"), "0::/system.slice/sr-imagefirst-autorun.service\n");
};
/** Push a commit to the test origin (develop moves on). */
const pushOrigin = (w: ReturnType<typeof wsl>, name: string) => {
  const c = tmp("sr-ifr-push-");
  git(c, "clone", "-q", "--branch", "develop", w.origin, ".");
  commitFiles(c, { [`docs/${name}.md`]: Buffer.from(name) }, name);
  git(c, "push", "-q", "origin", "HEAD:refs/heads/develop");
  return git(c, "rev-parse", "HEAD");
};

/** The pilot's fake WSL, plus the owner's files, root's admin clone, the service's cgroup, Remote Control up, admin.sh's stand-in. */
function world() {
  const w = wsl();
  const etc = join(w.t, "etc", "sr-design-worker");
  mkdirSync(etc, { recursive: true });
  const admin = adminClone(w);
  const state = join(w.t, "var", "lib", "sr-imagefirst-autostart");
  const events = join(w.t, "events.log");
  // inside sr-imagefirst-autorun.service (a oneshot is "activating" while it runs)
  insideService(w);
  writeFileSync(join(w.sc, "sr-imagefirst-autorun.service"), "activating");
  writeFileSync(join(w.sc, "enabled-sr-imagefirst-autorun.timer"), "enabled");
  // Remote Control up: the jailed Claude active and enabled, processes of the worker user
  const rcUp = () => {
    writeFileSync(join(w.sc, "sr-jail-claude.service"), "active");
    writeFileSync(join(w.sc, "enabled-sr-jail-claude.service"), "enabled");
    writeFileSync(join(w.sc, "pgrep"), "");
  };
  rcUp();
  // admin.sh: claude-stop stops the jail (unless rc-stuck: a process of the worker user stays; move-develop: a helper
  // clone pushes to origin meanwhile), claude-start starts it
  exe(
    join(w.t, "admin.sh"),
    `echo "admin $1" >> '${events}'
case "$1" in
  claude-stop) if [ -d '${w.sc}/move-develop' ]; then git -C '${w.sc}/move-develop' push -q origin HEAD:refs/heads/develop; fi
    echo inactive > '${w.sc}/sr-jail-claude.service'; echo disabled > '${w.sc}/enabled-sr-jail-claude.service'; [ -f '${w.sc}/rc-stuck' ] || rm -f '${w.sc}/pgrep'; echo CLAUDE_STOPPED ;;
  claude-start) if [ -f '${w.sc}/claude-start-fail' ]; then echo "HOST_UNSAFE: fix the lines above first"; exit 3; fi
    echo active > '${w.sc}/sr-jail-claude.service'; echo enabled > '${w.sc}/enabled-sr-jail-claude.service'; touch '${w.sc}/pgrep'; echo "CLAUDE_STARTED (jailed)" ;;
  *) exit 2 ;;
esac`,
  );
  // the privilege drop's stand-in (as the pilot world's), which also records, for the one worker run, root's used/ entries
  exe(
    join(w.bin, "setpriv"),
    `opts=(); while [ "$1" != "--" ]; do opts+=("$1"); shift; done; shift; echo "\${opts[*]}" >> '${w.sc}/setpriv.log'
if [ "\${@: -1}" = scripts/sales-design-worker/imagefirst-worker.ts ]; then echo "worker used=$(ls '${state}/used' 2>/dev/null | tr '\\n' ,)" >> '${events}'; fi
exec "$@"`,
  );
  const env = { ...w.env, SR_IMAGEFIRST_AUTORUN_TEST_ROOT: w.t, SR_IMAGEFIRST_APPROVE_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv;
  const parse = (status: number | null, stdout: string) => {
    const last = stdout.trim().split("\n").pop() ?? "";
    const m = /^IMAGEFIRST_AUTORUN (\S+) approval=(\S+) pilot=(\S+) remote_control=(\S+) exit=(\d+)$/.exec(last);
    expect(m, stdout).not.toBeNull();
    expect(Number(m![5]), stdout).toBe(status);
    expect(existsSync(join(w.sc, "model-cli.log")), "a codex / claude binary was started").toBe(false);
    return { status, stdout, code: m![1]!, approval: m![2]!, pilot: m![3]!, rc: m![4]! };
  };
  const run = (args: string[] = []) => {
    const r = spawnSync("bash", [AUTORUN, ...args], { env, encoding: "utf8", timeout: 400_000 });
    return parse(r.status, r.stdout);
  };
  const runAsync = () => {
    const child = spawnChild("bash", [AUTORUN], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    const done = new Promise<ReturnType<typeof parse>>((res) => child.on("close", (c) => res(parse(c, out))));
    return { child, done };
  };
  return {
    ...w,
    etc,
    admin,
    state,
    env,
    run,
    runAsync,
    rcUp,
    switchOn: (body: object = { enabled: true }) => writeFileSync(join(etc, "imagefirst-autostart.json"), JSON.stringify(body), { mode: 0o644 }),
    marker: (id: string = ID, expires: string = utc(Date.now() + 3600_000)) => writeFileSync(join(etc, "imagefirst-run.json"), JSON.stringify({ approval_id: id, expires_at: expires }), { mode: 0o644 }),
    events: () => (existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").filter(Boolean) : []),
    used: () => (existsSync(join(state, "used")) ? readdirSync(join(state, "used")) : []),
    attempted: () => (existsSync(join(state, "autorun")) ? readdirSync(join(state, "autorun")) : []),
    flag: () => existsSync(join(state, "autorun.restore-pending")),
    review: (id: string = ID) => join(w.home, "sr-runs", "review-inbox", "runs", `${id}.share.txt`),
  };
}
type World = ReturnType<typeof world>;

/** Remote Control never touched, nothing started, nothing used or attempted. */
const untouched = (w: World) => {
  expect(w.events()).toEqual([]);
  expect(w.starts()).toEqual([]);
  expect(w.used()).toEqual([]);
  expect(w.attempted()).toEqual([]);
};

describe("Issue #302 automatic run: nothing due = a quiet exit, Remote Control untouched", () => {
  it("switch absent / off / invalid, no marker, expired, invalid, used, attempted: no claude-stop, no pilot", () => {
    const w = world();
    w.marker();
    expect(w.run()).toMatchObject({ status: 0, code: "AUTORUN_OFF", approval: "none", rc: "untouched" });
    expect(existsSync(w.state)).toBe(false);
    w.switchOn({ enabled: false });
    expect(w.run()).toMatchObject({ status: 0, code: "AUTORUN_OFF" });
    w.switchOn({ enabled: "yes" });
    expect(w.run()).toMatchObject({ status: 2, code: "AUTORUN_SWITCH_INVALID" });
    w.switchOn();
    rmSync(join(w.etc, "imagefirst-run.json"));
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_NO_MARKER", rc: "untouched" });
    w.marker(ID, utc(Date.now() - 60_000));
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_MARKER_EXPIRED" });
    w.marker(ID, utc(Date.now() + 25 * 3600_000));
    expect(w.run()).toMatchObject({ status: 2, code: "AUTORUN_MARKER_INVALID" });
    w.marker("hoshigama-imagefirst-d3-00000000-01");
    expect(w.run()).toMatchObject({ status: 2, code: "AUTORUN_MARKER_INVALID" });
    rmSync(join(w.etc, "imagefirst-run.json"));
    writeFileSync(join(w.etc, "elsewhere.json"), JSON.stringify({ approval_id: ID, expires_at: utc(Date.now() + 3600_000) }), { mode: 0o644 });
    symlinkSync(join(w.etc, "elsewhere.json"), join(w.etc, "imagefirst-run.json"));
    expect(w.run()).toMatchObject({ status: 2, code: "AUTORUN_MARKER_UNSAFE" });
    untouched(w);
    rmSync(join(w.etc, "imagefirst-run.json"));
    w.marker();
    mkdirSync(join(w.state, "used", ID), { recursive: true });
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_MARKER_USED", approval: ID, rc: "untouched" });
    rmSync(join(w.state, "used"), { recursive: true });
    mkdirSync(join(w.state, "autorun", ID), { recursive: true });
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_ATTEMPTED", rc: "untouched" });
    expect(w.events()).toEqual([]);
    expect(w.starts()).toEqual([]);
  });

  it("outside sr-imagefirst-autorun.service, with the old automatic start enabled, or a design cycle on: refused / busy before anything", () => {
    const cases: [string, (w: World) => void, number, string][] = [
      ["not the service (another cgroup)", (w) => writeFileSync(join(w.t, "proc", "self", "cgroup"), "0::/user.slice/user-0.slice/session-1.scope\n"), 2, "AUTORUN_NOT_SERVICE"],
      ["the old automatic start's timer enabled", (w) => writeFileSync(join(w.sc, "enabled-sr-imagefirst-autostart.timer"), "enabled"), 2, "AUTORUN_AUTOSTART_ENABLED"],
      ["the old automatic start's service active", (w) => writeFileSync(join(w.sc, "sr-imagefirst-autostart.service"), "activating"), 2, "AUTORUN_AUTOSTART_ENABLED"],
      ["the design cycle's timer enabled", (w) => writeFileSync(join(w.sc, "enabled-sr-design-cycle.timer"), "enabled"), 12, "AUTORUN_BUSY"],
      ["a design cycle running", (w) => writeFileSync(join(w.sc, "sr-design-cycle.service"), "active"), 12, "AUTORUN_BUSY"],
    ];
    for (const [name, arrange, status, code] of cases) {
      const w = world();
      w.switchOn();
      w.marker();
      arrange(w);
      expect(w.run(), name).toMatchObject({ status, code, rc: "untouched" });
      untouched(w);
    }
  });
});

describe("Issue #302 automatic run: claude-stop, the pilot once, ALWAYS claude-start", () => {
  it("success: claude-stop → idle → used/<id> before the worker → one worker run → audit → review-ready file → claude-start; a second firing: nothing", () => {
    const w = world();
    w.switchOn();
    w.marker();
    // review M1: what the jailed Claude could have planted in the worker clone while Remote Control ran: a hook, an
    // fsmonitor, another origin URL, attributes, a trusted-looking npm hash. None of it may run or be used.
    const planted = join(w.sc, "planted-ran");
    exe(join(w.sc, "evil"), `touch '${planted}'`);
    mkdirSync(join(w.sc, "hooks"));
    for (const h of ["post-checkout", "reference-transaction", "pre-auto-gc"]) exe(join(w.sc, "hooks", h), `touch '${planted}'`);
    git(w.clone, "config", "core.hooksPath", join(w.sc, "hooks"));
    git(w.clone, "config", "core.fsmonitor", join(w.sc, "evil"));
    git(w.clone, "config", "remote.origin.url", join(w.t, "elsewhere.git"));
    writeFileSync(join(w.clone, ".git", "info", "attributes"), "* filter=evil\n");
    git(w.clone, "config", "filter.evil.smudge", join(w.sc, "evil"));
    git(w.clone, "config", "filter.evil.clean", join(w.sc, "evil"));
    const sha = git(w.admin, "rev-parse", "HEAD");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: ID, pilot: "PILOT_DONE", rc: "restored" });
    expect(existsSync(planted), "a planted hook / fsmonitor / filter ran").toBe(false);
    expect(r.stdout).toContain(`pinned to root's verified commit ${sha}`);
    expect(r.stdout).toMatch(new RegExp(`\\| clone +\\| PASS \\| clean, HEAD = origin/develop = root's verified ${sha}`));
    const config = readFileSync(join(w.clone, ".git", "config"), "utf8");
    expect(config).toContain(`\turl = ${w.origin}\n`);
    expect(config).toContain("\thooksPath = /dev/null\n");
    expect(config).not.toMatch(/evil|elsewhere/);
    expect(existsSync(join(w.clone, ".git", "info", "attributes"))).toBe(false);
    expect(git(w.clone, "rev-parse", "HEAD")).toBe(sha);
    // npm ci always (the hash file and node_modules are never trusted), with no user / global npm config
    expect(readFileSync(join(w.sc, "npm.log"), "utf8").trim().split("\n")).toEqual(["npm ci --no-audit --no-fund --loglevel=error userconfig=/dev/null globalconfig=/dev/null"]);
    expect(w.events()).toEqual(["admin claude-stop", `worker used=${ID},`, "admin claude-start"]);
    expect(readFileSync(join(w.state, "autorun", ID, "attempt"), "utf8")).toContain(`commit=${sha}\n`);
    expect(w.spent().map((s) => [s.cli, s.argv.join(" ")])).toEqual([["worker", ""], ["audit", ID]]);
    expect(w.starts().filter((s) => s.cli === "worker" && s.argv[0] !== "--check-codex-auth-only").map((s) => s.grant)).toEqual([ID, ID]);
    expect(w.used()).toEqual([ID]);
    expect(readFileSync(join(w.state, "used", ID, "used"), "utf8")).toMatch(new RegExp(`^approval_id=${ID}\\nused_by=imagefirst-autorun\\n`));
    expect(w.attempted()).toEqual([ID]);
    expect(w.flag()).toBe(false);
    expect(readFileSync(join(w.sc, "sr-jail-claude.service"), "utf8").trim()).toBe("active");
    // the review-ready file: the worker's, 0600, only shareable lines
    const f = w.review();
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(lines[0]).toBe(`imagefirst-pilot: share: approval=${ID} codex_runs=1 (one worker run; never retried) delivery=delivered`);
    expect(lines).toContain("imagefirst-pilot: share: verdict=show_owner (advisory only; the owner decides)");
    expect(lines.at(-2)).toBe(`IMAGEFIRST_PILOT PILOT_DONE phase=after_claim approval=${ID} exit=0`);
    expect(lines.at(-1)).toBe(`IMAGEFIRST_AUTORUN_RESULT AUTORUN_DONE approval=${ID} pilot=PILOT_DONE exit=0`);
    for (const l of lines) {
      expect(l, l).toMatch(/^(imagefirst-pilot: share: |IMAGEFIRST_PILOT |IMAGEFIRST_AUTORUN_RESULT )/);
      expect(l, l).not.toMatch(/[0-9a-f]{64}|\/home\/|sr-runs|\/tmp\/|local-only/);
    }
    expect(readdirSync(join(w.home, "sr-runs", "review-inbox", "runs"))).toEqual([`${ID}.share.txt`]);
    // the next firings: the marker is used; Remote Control is not touched again, nothing runs again
    for (let i = 0; i < 2; i++) expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_MARKER_USED", rc: "untouched" });
    expect(w.events()).toHaveLength(3);
    expect(w.spent()).toHaveLength(2);
  });

  it("the preflight fails (not approved): no worker, Remote Control restored, used/<id> not created, the attempt recorded; never retried", () => {
    const w = world();
    w.switchOn();
    w.marker();
    mkdirSync(join(w.home, "sr-runs"), { mode: 0o700 });
    writeFileSync(join(w.home, "stub-precheck"), "PACKET_NOT_APPROVED");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", pilot: "PILOT_PREFLIGHT_FAILED", rc: "restored" });
    expect(w.events()).toEqual(["admin claude-stop", "admin claude-start"]);
    expect(w.spent()).toEqual([]);
    expect(w.used()).toEqual([]);
    expect(w.attempted()).toEqual([ID]);
    expect(readFileSync(w.review(), "utf8")).toBe(`IMAGEFIRST_PILOT PILOT_PREFLIGHT_FAILED phase=before_claim approval=${ID} exit=20\nIMAGEFIRST_AUTORUN_RESULT AUTORUN_PILOT_STOPPED approval=${ID} pilot=PILOT_PREFLIGHT_FAILED exit=1\n`);
    // fixed now, the next firing still does nothing (one attempt per id)
    rmSync(join(w.home, "stub-precheck"));
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_ATTEMPTED", rc: "untouched" });
    expect(w.events()).toHaveLength(2);
    expect(w.spent()).toEqual([]);
  });

  it("the worker stops (or refuses): claude-start all the same, the marker used, never retried", () => {
    for (const [mode, pilot] of [["fail", "PILOT_WORKER_STOPPED"], ["refuse", "PILOT_WORKER_REFUSED"]] as const) {
      const w = world();
      w.switchOn();
      w.marker();
      writeFileSync(join(w.home, "stub-worker-mode"), mode);
      const r = w.run();
      expect(r, `${mode}\n${r.stdout}`).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", pilot, rc: "restored" });
      expect(w.events(), mode).toEqual(["admin claude-stop", `worker used=${ID},`, "admin claude-start"]);
      expect(w.used(), mode).toEqual([ID]);
      expect(w.run(), mode).toMatchObject({ status: 10, code: "AUTORUN_IDLE_MARKER_USED" });
      expect(w.spent().filter((s) => s.cli === "worker"), mode).toHaveLength(1);
    }
  });

  it("a stop signal while the worker runs: passed on through the pilot to the worker (its receipt), then claude-start", async () => {
    const w = world();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.home, "stub-worker-mode"), "sleep");
    const p = w.runAsync();
    for (let i = 0; i < 6000 && !existsSync(join(w.home, "stub-sleeping")); i++) await new Promise((res) => setTimeout(res, 20));
    expect(existsSync(join(w.home, "stub-sleeping"))).toBe(true);
    p.child.kill("SIGTERM");
    const r = await p.done;
    expect(r, r.stdout).toMatchObject({ status: 1, code: "AUTORUN_INTERRUPTED", pilot: "PILOT_INTERRUPTED", rc: "restored" });
    expect(readFileSync(join(w.home, "stub-term.log"), "utf8")).toContain("term");
    expect(w.events()).toEqual(["admin claude-stop", `worker used=${ID},`, "admin claude-start"]);
    expect(readFileSync(w.review(), "utf8")).toMatch(/share: receipt=status=stopped stop_code=WORKER_INTERRUPTED/);
    expect(w.flag()).toBe(false);
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_MARKER_USED" });
  });

  it("review L1: the worker user still busy at the end: no pilot, no in-script claude-start; the flag is left for ExecStopPost (--restore)", () => {
    const w = world();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.sc, "rc-stuck"), "");
    writeFileSync(join(w.t, "idle-wait"), "2");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 1, code: "AUTORUN_STOP_NOT_IDLE", pilot: "none", rc: "deferred" });
    expect(w.events()).toEqual(["admin claude-stop"]);
    expect(w.flag()).toBe(true);
    expect(w.starts()).toEqual([]);
    expect(w.used()).toEqual([]);
    expect(w.attempted()).toEqual([ID]);
    // a worker process was left, so the review-ready file is not written (root runs nothing as the worker then)
    expect(existsSync(w.review())).toBe(false);
    // the unit's ExecStopPost (after systemd ended what was left in the unit): claude-start once, the flag removed
    expect(w.run(["--restore"])).toMatchObject({ status: 0, code: "AUTORUN_RESTORED", rc: "restored" });
    expect(w.events()).toEqual(["admin claude-stop", "admin claude-start"]);
    expect(w.flag()).toBe(false);
  });

  it("review L4: Remote Control was disabled before the run: it is left stopped afterwards (no claude-start)", () => {
    const w = world();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.sc, "sr-jail-claude.service"), "inactive");
    writeFileSync(join(w.sc, "enabled-sr-jail-claude.service"), "disabled");
    rmSync(join(w.sc, "pgrep"));
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", pilot: "PILOT_DONE", rc: "left_stopped" });
    expect(w.events()).toEqual(["admin claude-stop", `worker used=${ID},`]);
    expect(w.flag()).toBe(false);
    expect(readFileSync(join(w.sc, "sr-jail-claude.service"), "utf8").trim()).toBe("inactive");
    // --restore with a flag that says "was not enabled": nothing started either
    writeFileSync(join(w.state, "autorun.restore-pending"), `was_enabled=no\napproval_id=${ID}\n`);
    expect(w.run(["--restore"])).toMatchObject({ status: 0, code: "AUTORUN_RESTORE_LEFT_STOPPED", rc: "left_stopped" });
    expect(w.events()).toHaveLength(2);
    expect(w.flag()).toBe(false);
  });

  it("review L2: a stop signal between the restore flag and claude-stop: no claude-stop, no flag left, exit 40", async () => {
    const w = world();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.t, "hold-before-stop"), "");
    const p = w.runAsync();
    for (let i = 0; i < 3000 && !existsSync(join(w.t, "holding-before-stop")); i++) await new Promise((res) => setTimeout(res, 20));
    expect(existsSync(join(w.t, "holding-before-stop"))).toBe(true);
    expect(w.flag()).toBe(true);
    p.child.kill("SIGTERM");
    await new Promise((res) => setTimeout(res, 300));
    rmSync(join(w.t, "hold-before-stop"));
    const r = await p.done;
    expect(r, r.stdout).toMatchObject({ status: 40, code: "AUTORUN_STOP_SIGNAL", rc: "untouched" });
    expect(w.events()).toEqual([]);
    expect(w.flag()).toBe(false);
    // the attempt was recorded before the window: no second attempt for this id
    expect(w.attempted()).toEqual([ID]);
    expect(w.run(["--restore"])).toMatchObject({ code: "AUTORUN_RESTORE_NOTHING" });
    expect(w.events()).toEqual([]);
  });

  it("review M1: root's admin clone not at origin's develop (refused, Remote Control untouched), or develop moving during the stop (no pilot)", () => {
    const w = world();
    w.switchOn();
    w.marker();
    pushOrigin(w, "merged-after-approval");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 2, code: "AUTORUN_ADMIN_NOT_DEVELOP", rc: "untouched" });
    expect(r.stdout).toContain("checkout -q --detach origin/develop");
    untouched(w);
    writeFileSync(join(w.admin, "stray.txt"), "x");
    git(w.admin, "fetch", "-q", "origin");
    git(w.admin, "checkout", "-q", "--detach", "origin/develop");
    expect(w.run()).toMatchObject({ status: 2, code: "AUTORUN_ADMIN_CLONE_DIRTY", rc: "untouched" });
    untouched(w);
    // develop moves while Remote Control is being stopped: no pilot, nothing used, Remote Control back
    const v = world();
    v.switchOn();
    v.marker();
    const helper = join(v.sc, "move-develop");
    git(v.t, "clone", "-q", "--branch", "develop", v.origin, helper);
    commitFiles(helper, { "docs/moved.md": Buffer.from("x") }, "moved");
    const m = v.run();
    expect(m, m.stdout).toMatchObject({ status: 1, code: "AUTORUN_STOP_DEVELOP_MOVED", pilot: "none", rc: "restored" });
    expect(v.events()).toEqual(["admin claude-stop", "admin claude-start"]);
    expect(v.starts()).toEqual([]);
    expect(v.used()).toEqual([]);
  });

  it("claude-start fails: exit 3, the flag stays; the unit's ExecStopPost (--restore) starts it once; --restore without the flag does nothing", () => {
    const w = world();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.sc, "claude-start-fail"), "");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 3, code: "AUTORUN_RC_NOT_RESTORED", pilot: "PILOT_DONE", rc: "not_restored" });
    expect(r.stdout).toMatch(/Remote Control was NOT started again/);
    expect(w.flag()).toBe(true);
    rmSync(join(w.sc, "claude-start-fail"));
    expect(w.run(["--restore"])).toMatchObject({ status: 0, code: "AUTORUN_RESTORED", rc: "restored" });
    expect(w.flag()).toBe(false);
    expect(w.events()).toEqual(["admin claude-stop", `worker used=${ID},`, "admin claude-start", "admin claude-start"]);
    expect(w.run(["--restore"])).toMatchObject({ status: 0, code: "AUTORUN_RESTORE_NOTHING", rc: "untouched" });
    expect(w.events()).toHaveLength(4);
    // --restore only inside the service
    writeFileSync(join(w.t, "proc", "self", "cgroup"), "0::/user.slice\n");
    expect(w.run(["--restore"])).toMatchObject({ status: 2, code: "AUTORUN_NOT_SERVICE" });
  });

  it("d3 and d4: the pilot, the preflight's precheck and the worker get exactly the marker's id (its direction picks the packet)", () => {
    for (const id of [ID, D4]) {
      const w = world();
      w.switchOn();
      w.marker(id);
      const r = w.run();
      expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: id, pilot: "PILOT_DONE" });
      const workers = w.starts().filter((s) => s.cli === "worker" && s.argv[0] !== "--check-codex-auth-only");
      expect(workers.map((s) => [s.argv.join(" "), s.grant])).toEqual([["--precheck", id], ["", id]]);
      expect(w.spent().filter((s) => s.cli === "audit").map((s) => s.argv)).toEqual([[id]]);
      expect(w.used()).toEqual([id]);
    }
  });

  it("the review-ready file: no link followed in its directory, never overwritten", () => {
    const w = world();
    w.switchOn();
    w.marker();
    const outside = tmp("sr-ifr-outside-");
    mkdirSync(join(w.home, "sr-runs", "review-inbox"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(w.home, "sr-runs", "review-inbox", "runs"));
    const r = w.run();
    expect(r).toMatchObject({ status: 0, code: "AUTORUN_DONE", rc: "restored" });
    expect(r.stdout).toMatch(/the review-ready file is not written/);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(w.home, "sr-runs", "review-inbox", "runs")).isSymbolicLink()).toBe(true);
    // an existing file is kept as it is
    const v = world();
    v.switchOn();
    v.marker();
    mkdirSync(join(v.home, "sr-runs", "review-inbox", "runs"), { recursive: true, mode: 0o700 });
    writeFileSync(v.review(), "earlier\n", { mode: 0o600 });
    expect(v.run()).toMatchObject({ status: 0, code: "AUTORUN_DONE" });
    expect(readFileSync(v.review(), "utf8")).toBe("earlier\n");
  });

  it("refuses arguments, and any copy outside the root-only clone without the test world", () => {
    const w = world();
    expect(w.run(["--now"])).toMatchObject({ status: 2, code: "AUTORUN_USAGE" });
    const r = spawnSync("bash", [AUTORUN], { env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout.trim().split("\n").pop()).toBe("IMAGEFIRST_AUTORUN AUTORUN_USAGE approval=none pilot=none remote_control=untouched exit=2");
    untouched(w);
  });
});

describe("Issue #302 automatic run: the pilot's --autorun mode and the preflight's timers row", () => {
  it("pilot --autorun outside the service: refused before anything; inside it with used/<id> present: refused before the preflight", () => {
    const w = wsl();
    const admin = adminClone(w);
    const sha = git(admin, "rev-parse", "HEAD");
    const r = w.pilot(["--autorun", ID, sha]);
    expect([r.status, r.code, r.phase]).toEqual([2, "PILOT_AUTORUN_REFUSED", "before_claim"]);
    expect(w.starts()).toEqual([]);
    for (const bad of [["--autorun", ID], ["--autorun", "../x", sha], ["--autorun", "hoshigama-imagefirst-d3-00000000-01", sha], ["--autorun", ID, ID], ["--autorun", ID, sha.toUpperCase()], ["--autorun", ID, sha, sha]]) expect(w.pilot(bad).status, bad.join(" ")).toBe(2);
    insideService(w);
    // review M1: another commit than root's admin clone's, or an admin clone with changes: refused before anything
    expect(w.pilot(["--autorun", ID, "0".repeat(40)])).toMatchObject({ status: 2, code: "PILOT_AUTORUN_SHA_MISMATCH" });
    writeFileSync(join(admin, "stray.txt"), "x");
    expect(w.pilot(["--autorun", ID, sha])).toMatchObject({ status: 2, code: "PILOT_AUTORUN_SHA_MISMATCH" });
    rmSync(join(admin, "stray.txt"));
    mkdirSync(join(w.t, "var", "lib", "sr-imagefirst-autostart", "used", ID), { recursive: true });
    expect(w.pilot(["--autorun", ID, sha])).toMatchObject({ status: 2, code: "PILOT_MARKER_USED", phase: "before_claim" });
    expect(w.starts()).toEqual([]);
  });

  it("review M1: pilot --autorun with origin's develop not at root's commit, or a dirty worker clone: stopped before the preflight, nothing spent", () => {
    const w = wsl();
    const admin = adminClone(w);
    insideService(w);
    writeFileSync(join(w.sc, "sr-imagefirst-autorun.service"), "activating");
    const sha = git(admin, "rev-parse", "HEAD");
    pushOrigin(w, "moved");
    expect(w.pilot(["--autorun", ID, sha])).toMatchObject({ status: 20, code: "PILOT_AUTORUN_DEVELOP_MOVED", phase: "before_claim" });
    expect(w.starts()).toEqual([]);
    const v = wsl();
    const vadmin = adminClone(v);
    insideService(v);
    writeFileSync(join(v.clone, "stray.txt"), "x");
    expect(v.pilot(["--autorun", ID, git(vadmin, "rev-parse", "HEAD")])).toMatchObject({ status: 20, code: "PILOT_AUTORUN_TREE_DIRTY" });
    expect(existsSync(join(v.clone, "stray.txt"))).toBe(true);
    expect(v.starts()).toEqual([]);
  });

  it("the manual preflight refuses while the automatic run's timer or service is on; inside the service it accepts exactly that service", () => {
    for (const [file, state] of [["enabled-sr-imagefirst-autorun.timer", "enabled"], ["sr-imagefirst-autorun.service", "activating"], ["sr-imagefirst-autorun.timer", "active"]]) {
      const w = wsl();
      writeFileSync(join(w.sc, file!), state!);
      const p = w.preflight([ID]);
      expect([p.status, p.rows.timers?.ok], file).toEqual([20, false]);
      expect(w.spent()).toEqual([]);
    }
    // inside the service: its own unit must be running (a stale cgroup claim with the service inactive fails)
    const v = wsl();
    const vadmin = adminClone(v);
    insideService(v);
    writeFileSync(join(v.sc, "enabled-sr-imagefirst-autorun.timer"), "enabled");
    expect(v.preflight([ID]).rows.timers?.ok).toBe(false);
    writeFileSync(join(v.sc, "sr-imagefirst-autorun.service"), "activating");
    const ok = v.preflight([ID]);
    expect(ok.status, ok.stdout).toBe(0);
    expect(ok.rows.timers?.why).toMatch(/inside sr-imagefirst-autorun\.service \(activating\)/);
    expect(ok.rows.clone?.why).toBe(`clean, HEAD = origin/develop = root's verified ${git(vadmin, "rev-parse", "HEAD")}`);
    // review M1: inside the service the clone row compares with root's commit, not only with the clone's own origin/develop
    commitFiles(vadmin, { "docs/admin-only.md": Buffer.from("x") }, "a commit only in the admin clone");
    expect(v.preflight([ID]).rows.clone?.ok).toBe(false);
    git(vadmin, "reset", "-q", "--hard", "HEAD~1");
    // the old automatic start is refused there too
    writeFileSync(join(v.sc, "enabled-sr-imagefirst-autostart.timer"), "enabled");
    expect(v.preflight([ID]).rows.timers?.ok).toBe(false);
  });
});

describe("Issue #302 automatic run: copied primitives, units not installed, nothing enables them", () => {
  const src = (f: string) => readFileSync(f, "utf8");
  const block = (file: string, head: string) => {
    const s = src(file);
    const start = s.indexOf(`\n${head}\n`);
    expect(start, `${file}: ${head}`).toBeGreaterThanOrEqual(0);
    return s.slice(start, s.indexOf("\n}\n", start) + 3);
  };
  const quoted = (file: string, name: string) => {
    const s = src(file);
    const start = s.indexOf(`\n${name}='\n`);
    expect(start, `${file}: ${name}`).toBeGreaterThanOrEqual(0);
    return s.slice(start, s.indexOf("\n'\n", start) + 3);
  };

  it("busy(), trusted_path(), owner_file() and the switch / marker parsers are the automatic start's, verbatim; unit_off() is the preflight's", () => {
    for (const f of [AUTORUN, APPROVE]) {
      for (const head of ["busy() {", "trusted_path() {", "owner_file() {"]) expect(block(f, head), `${f} ${head}`).toBe(block(AUTOSTART, head));
      expect(block(f, "unit_off() {"), f).toBe(block(PREFLIGHT, "unit_off() {"));
      for (const name of ["SWITCH_PY", "MARKER_PY"]) expect(quoted(f, name), `${f} ${name}`).toBe(quoted(AUTOSTART, name));
    }
    // approve's worker steps are the automatic start's, verbatim (the privilege drop, step 5, the precheck line)
    expect(src(APPROVE).split("\n").map((l) => l.trim()).find((l) => l.startsWith("AS_WORKER=(setpriv "))).toBe(src(AUTOSTART).split("\n").find((l) => l.startsWith("AS_WORKER=(setpriv ")));
    const approve = src(APPROVE).split("\n").map((l) => l.trim());
    for (const l of src(AUTOSTART).split("\n").filter((x) => /^(in_clone |dirty="\$\(in_clone |head="\$\(in_clone |base="\$\(in_clone )/.test(x))) expect(approve, l).toContain(l.trim());
    // the review writer's privilege drop has the production options
    expect(src(AUTORUN)).toMatch(/local as_worker=\(setpriv --reuid="\$uid" --regid="\$gid" --init-groups --reset-env --no-new-privs -- env -i /);
  });

  it("the automatic run starts only admin.sh claude-stop / claude-start and the pilot; never the worker, a model CLI or a unit change", () => {
    const code = src(AUTORUN).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code.match(/bash "\$ADMIN" [^\n]*/g)).toEqual(['bash "$ADMIN" claude-start 2>&1 7>&- 8>&- 9>&-)" || rc=$?', 'bash "$ADMIN" claude-stop 2>&1 7>&- 8>&- 9>&-)"']);
    expect(code.match(/bash "\$PILOT" [^\n]*/g)).toEqual(['bash "$PILOT" --autorun "$APPROVAL" "$ADMIN_SHA"']);
    expect(code).not.toMatch(/imagefirst-worker\.ts|imagefirst-audit\.ts|image-first-generate|anthropic|openai/i);
    for (const c of [code, src(APPROVE).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")]) for (const m of c.matchAll(/systemctl\s+(\S+)/g)) expect(["show", "is-enabled"]).toContain(m[1]);
    // approve starts no pilot, no admin.sh, never the worker run (only its precheck), never claims
    const approve = src(APPROVE).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(approve).not.toMatch(/admin\.sh claude|bash "\$PILOT"|mkdir[^\n]*(used|autorun)/);
    expect(approve.match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 7>&- 8>&- 9>&-']);
  });

  it("the units: oneshot root service with ExecStopPost --restore, a 10-minute timer without catch-up; never installed or enabled here", () => {
    const service = src(join(UNIT_DIR, "sr-imagefirst-autorun.service"));
    const timer = src(join(UNIT_DIR, "sr-imagefirst-autorun.timer"));
    for (const unit of [service, timer]) expect(unit.split("\n")[0]).toMatch(/NOT installed or enabled/);
    expect(service).toMatch(/^ExecStart=\/usr\/bin\/bash \/root\/sr-capture-admin\/scripts\/sales-design-worker\/imagefirst-autorun\.sh$/m);
    // review M2: ExecStopPost without the unit's sandboxing ("+"), still in the unit's cgroup
    expect(service).toMatch(/^ExecStopPost=\+\/usr\/bin\/bash \/root\/sr-capture-admin\/scripts\/sales-design-worker\/imagefirst-autorun\.sh --restore$/m);
    // review L3: never together with the old automatic start
    expect(service).toMatch(/^Conflicts=sr-imagefirst-autostart\.service sr-imagefirst-autostart\.timer$/m);
    expect(service).not.toMatch(/^User=/m);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^KillMode=mixed$/m);
    expect(service).toMatch(/^SuccessExitStatus=10 11 12$/m);
    const num = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(src(AUTORUN))![1]);
    const start = Number(/^TimeoutStartSec=(\d+)$/m.exec(service)![1]);
    const stop = Number(/^TimeoutStopSec=(\d+)$/m.exec(service)![1]);
    const admin = num("ADMIN_TIMEOUT") + num("KILL_AFTER");
    expect(start).toBeGreaterThan(2 * admin + 2 * (num("ADMIN_FETCH_TIMEOUT") + num("KILL_AFTER")) + num("IDLE_WAIT") + num("PILOT_TIMEOUT") + num("PILOT_KILL_AFTER"));
    expect(stop).toBeGreaterThan(num("PILOT_KILL_AFTER") + admin);
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* \*:00\/10:00$/m);
    expect(timer).toMatch(/^RandomizedDelaySec=\d+$/m);
    expect(timer).toMatch(/^Persistent=false$/m);
    const grep = (pattern: string) => spawnSync("git", ["grep", "--untracked", "-lE", pattern, "--", ".", ":!tests/**"], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
    expect(grep("systemctl.*(enable|start).*sr-imagefirst-autorun")).toEqual(["docs/operations/imagefirst-autorun.md"]);
    // only the service starts the script (the script's own header names its ExecStopPost)
    expect(grep("(bash|ExecStart|ExecStopPost)\\b.*imagefirst-autorun\\.sh").filter((p) => !p.startsWith("docs/"))).toEqual(["scripts/sales-design-worker/imagefirst-autorun.sh", "scripts/sales-design-worker/systemd/sr-imagefirst-autorun.service"]);
    expect(PILOT).toMatch(/imagefirst-pilot\.sh$/);
  });
});
