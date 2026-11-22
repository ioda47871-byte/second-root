import { spawn as spawnChild, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { childEnvironment } from "@/lib/design-agent/worker/env";
import { exe, ID, loadPngs, PILOT, PREFLIGHT, SCRIPTS, wsl } from "./pilot-world";
import { cleanupTemps, commitFiles, git, REPO, sha, tmp } from "./support";

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
const CODEX_CONFIG_REPO = join(SCRIPTS, "codex-config.toml");
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Root's admin clone's stand-in (a clone of the test origin, at origin's develop) and an npm stub; returns its path. */
const adminClone = (w: ReturnType<typeof wsl>) => {
  const admin = join(w.t, "root", "sr-capture-admin");
  mkdirSync(join(w.t, "root"), { recursive: true });
  git(w.t, "clone", "-q", "--branch", "develop", w.origin, admin);
  // npm ci's stand-in: records how it was run and, as npm ci would, gives the clone its tsx loader
  exe(
    join(w.bin, "npm"),
    `echo "npm $* userconfig=\${npm_config_userconfig:-} globalconfig=\${npm_config_globalconfig:-} cwd=$PWD" >> '${w.sc}/npm.log'
mkdir -p node_modules && ln -sfn '${join(REPO, "node_modules", "tsx")}' node_modules/tsx`,
  );
  return admin;
};
/** Root's reviewed Codex config (the repository's file, 0644) and the worker's Claude sign-in (a placeholder: presence only). */
const configTrust = (w: ReturnType<typeof wsl>) => {
  mkdirSync(join(w.t, "etc", "sr-design-worker"), { recursive: true });
  writeFileSync(join(w.t, "etc", "sr-design-worker", "codex-config.toml"), readFileSync(CODEX_CONFIG_REPO), { mode: 0o644 });
  mkdirSync(join(w.home, ".claude"), { recursive: true, mode: 0o700 });
  writeFileSync(join(w.home, ".claude", ".credentials.json"), "claude-sign-in\n", { mode: 0o600 });
  writeFileSync(join(w.home, ".codex", "auth.json"), "codex-sign-in\n", { mode: 0o600 });
};
/** A run's config dir exactly as the pilot builds it. */
const buildCfg = (cfg: string) => {
  mkdirSync(join(cfg, "codex"), { recursive: true, mode: 0o700 });
  mkdirSync(join(cfg, "claude"), { recursive: true, mode: 0o700 });
  writeFileSync(join(cfg, "codex", "config.toml"), readFileSync(CODEX_CONFIG_REPO), { mode: 0o600 });
  writeFileSync(join(cfg, "codex", "auth.json"), "codex-sign-in\n", { mode: 0o600 });
  writeFileSync(join(cfg, "claude", ".credentials.json"), "claude-sign-in\n", { mode: 0o600 });
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
  configTrust(w);
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
if [ "\${@: -1}" = scripts/sales-design-worker/imagefirst-worker.ts ] || [[ " $* " == *" scripts/sales-design-worker/imagefirst-worker.ts --request "* ]]; then echo "worker used=$(ls '${state}/used' 2>/dev/null | tr '\\n' ,)" >> '${events}'; fi
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
  const run = (args: string[] = [], script: string = AUTORUN) => {
    const r = spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: 400_000 });
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
    /** DEV-303: the owner's standing policy (root's file, 0644). */
    standing: (over: Record<string, unknown> = {}, days = 30) =>
      writeFileSync(join(etc, "imagefirst-standing.json"), JSON.stringify({ schema: "sr_imagefirst_standing_v1", per_day: 2, per_week: 8, not_after: utc(Date.now() + days * 86400_000), created_at: utc(Date.now() - 60_000), worker_commit: git(admin, "rev-parse", "HEAD"), ...over }), { mode: 0o644 }),
    /** DEV-303: Claude's request file (the worker's ~/sr-runs/requests/<id>.json); returns its bytes. */
    request: (id: string, over: Record<string, unknown> = {}) => {
      mkdirSync(join(w.home, "sr-runs", "requests"), { recursive: true, mode: 0o700 });
      const b = Buffer.from(JSON.stringify({ schema: "sr_imagefirst_request_v1", id, shop_id: "hoshigama", kind: "fictional", created_at: "2026-11-23T00:00:00Z", direction: "worker's business", ...over }));
      writeFileSync(join(w.home, "sr-runs", "requests", `${id}.json`), b, { mode: 0o600 });
      return b;
    },
    rejected: () => (existsSync(join(state, "rejected")) ? readdirSync(join(state, "rejected")).sort() : []),
    /** A stand-in pilot (fast): records its arguments; PILOT_DONE unless <sc>/pilot-fail. */
    fastPilot: () =>
      writeFileSync(
        join(w.t, "pilot-stand-in.sh"),
        `echo "$*" >> '${w.sc}/pilot-args.log'\ncode=PILOT_DONE; rc=0; if [ -f '${w.sc}/pilot-fail' ]; then code=PILOT_WORKER_STOPPED; rc=1; fi\necho "IMAGEFIRST_PILOT $code phase=after_claim approval=$2 exit=$rc" > '${join(state, "autorun-result")}'\nexit $rc\n`,
      ),
    pilotArgs: () => (existsSync(join(w.sc, "pilot-args.log")) ? readFileSync(join(w.sc, "pilot-args.log"), "utf8").trim().split("\n").filter(Boolean) : []),
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
    // review M1 / H1: what the jailed Claude could have planted while Remote Control ran, in the reused clone (a hook, an
    // fsmonitor, another origin URL, attributes + a filter, a skip-worktree tracked file with other content, an
    // alternates file, a forged loose object, an ignored .env) and in the worker's home (~/.gitconfig with an include,
    // ~/.config/git/config and attributes with a smudge filter). None of it may run, or reach the run's clone.
    const planted = join(w.sc, "planted-ran");
    const workerFile = "scripts/sales-design-worker/imagefirst-worker.ts";
    const head0 = git(w.clone, "rev-parse", "HEAD");
    git(w.clone, "update-index", "--skip-worktree", workerFile);
    writeFileSync(join(w.clone, workerFile), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(planted)}, "worker");\n`);
    exe(join(w.sc, "evil"), `touch '${planted}'; cat`);
    mkdirSync(join(w.sc, "hooks"));
    for (const h of ["post-checkout", "reference-transaction", "pre-auto-gc"]) exe(join(w.sc, "hooks", h), `touch '${planted}'`);
    git(w.clone, "config", "core.hooksPath", join(w.sc, "hooks"));
    git(w.clone, "config", "core.fsmonitor", join(w.sc, "evil"));
    git(w.clone, "config", "remote.origin.url", join(w.t, "elsewhere.git"));
    writeFileSync(join(w.clone, ".git", "info", "attributes"), "* filter=evil\n");
    git(w.clone, "config", "filter.evil.smudge", join(w.sc, "evil"));
    git(w.clone, "config", "filter.evil.clean", join(w.sc, "evil"));
    mkdirSync(join(w.sc, "alt-objects"));
    writeFileSync(join(w.clone, ".git", "objects", "info", "alternates"), `${join(w.sc, "alt-objects")}\n`);
    mkdirSync(join(w.clone, ".git", "objects", "ff"), { recursive: true });
    writeFileSync(join(w.clone, ".git", "objects", "ff", "f".repeat(38)), "forged");
    writeFileSync(join(w.clone, ".env"), "SECRET=planted\n");
    writeFileSync(join(w.clone, ".gitignore"), "node_modules\n.env\n");
    writeFileSync(join(w.home, ".gitconfig"), `[include]\n\tpath = ${join(w.home, "inc.gitconfig")}\n`);
    writeFileSync(join(w.home, "inc.gitconfig"), `[filter "evil"]\n\tsmudge = ${join(w.sc, "evil")}\n\tclean = ${join(w.sc, "evil")}\n\trequired = true\n[core]\n\thooksPath = ${join(w.sc, "hooks")}\n\tfsmonitor = ${join(w.sc, "evil")}\n`);
    mkdirSync(join(w.home, ".config", "git"), { recursive: true });
    writeFileSync(join(w.home, ".config", "git", "attributes"), "* filter=evil\n");
    writeFileSync(join(w.home, ".config", "git", "config"), `[filter "evil"]\n\tsmudge = ${join(w.sc, "evil")}\n\trequired = true\n`);
    const sha = git(w.admin, "rev-parse", "HEAD");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: ID, pilot: "PILOT_DONE", rc: "restored" });
    expect(existsSync(planted), "a planted hook / fsmonitor / filter / worker file ran").toBe(false);
    expect(r.stdout).toContain(`a fresh clone at root's verified commit ${sha}`);
    expect(r.stdout).toMatch(new RegExp(`\\| clone +\\| PASS \\| clean, HEAD = origin/develop = root's verified ${sha}`));
    // the run's clone: new, under the root-chosen prefix, at exactly root's commit, with git's own fresh config
    const fresh = readdirSync(join(w.home, "imagefirst")).filter((n) => n.startsWith(`autorun-${ID}-`));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(new RegExp(`^autorun-${ID}-\\d{8}T\\d{6}Z$`));
    const fc = join(w.home, "imagefirst", fresh[0]!);
    expect(readFileSync(join(w.state, "autorun-clone"), "utf8")).toBe(`${fc}\n`);
    const fgit = (...a: string[]) => spawnSync("git", ["-C", fc, ...a], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: w.t, GIT_CONFIG_NOSYSTEM: "1" } as unknown as NodeJS.ProcessEnv }).stdout.trim();
    expect(fgit("rev-parse", "HEAD")).toBe(sha);
    expect(readFileSync(join(fc, ".git", "config"), "utf8")).not.toMatch(/evil|elsewhere|hooks/);
    expect(existsSync(join(fc, ".git", "objects", "info", "alternates"))).toBe(false);
    expect(existsSync(join(fc, ".git", "objects", "ff", "f".repeat(38)))).toBe(false);
    expect(existsSync(join(fc, ".env"))).toBe(false);
    expect(readFileSync(join(fc, workerFile), "utf8")).not.toContain("planted");
    expect(fgit("ls-files", "-v", workerFile)).toMatch(/^H /);
    // every worker command ran in the fresh clone; the reused clone was not touched
    for (const s of w.starts().filter((x) => x.cli === "worker")) expect(s.cwd, s.argv.join(" ")).toBe(fc);
    expect(git(w.clone, "rev-parse", "HEAD")).toBe(head0);
    // npm ci always, in the fresh clone, with no user / global npm config
    expect(readFileSync(join(w.sc, "npm.log"), "utf8").trim().split("\n")).toEqual([`npm ci --no-audit --no-fund --loglevel=error userconfig=/dev/null globalconfig=/dev/null cwd=${fc}`]);
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

  it("PR #325 CI: a timeout(1) that exits 143 after passing on a stop (as uutils' does) still gives the pilot's own result", async () => {
    // the CI runner's timeout exited 143 although the pilot ended exit 1 (PILOT_INTERRUPTED): with the old stdout + exit
    // status hand-off that was PILOT_NO_RESULT. A stand-in with exactly that behaviour, in front of the real one
    const realTimeout = spawnSync("bash", ["-c", "command -v timeout"], { encoding: "utf8", env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv }).stdout.trim();
    expect(realTimeout).toMatch(/^\//);
    const w = world();
    w.switchOn();
    w.marker();
    exe(join(w.bin, "timeout"), `'${realTimeout}' "$@" & c=$!
trap 'got=1; kill -TERM $c 2>/dev/null' TERM
wait $c; rc=$?
while kill -0 $c 2>/dev/null; do wait $c; rc=$?; done
wait $c; rc=$?
if [ "\${got:-}" = 1 ]; then exit 143; fi
exit $rc`);
    writeFileSync(join(w.home, "stub-worker-mode"), "sleep");
    const p = w.runAsync();
    for (let i = 0; i < 6000 && !existsSync(join(w.home, "stub-sleeping")); i++) await new Promise((res) => setTimeout(res, 20));
    expect(existsSync(join(w.home, "stub-sleeping"))).toBe(true);
    p.child.kill("SIGTERM");
    const r = await p.done;
    expect(r, r.stdout).toMatchObject({ status: 1, code: "AUTORUN_INTERRUPTED", pilot: "PILOT_INTERRUPTED", rc: "restored" });
    expect(readFileSync(w.review(), "utf8")).toContain(`IMAGEFIRST_PILOT PILOT_INTERRUPTED phase=after_claim approval=${ID} exit=1\n`);
  });

  it("PR #325 CI: the pilot's result comes from its result file, never from its stdout (a misleading or missing stdout line changes nothing)", () => {
    const cases: [string, string, string, number, string][] = [
      // the result file says done, stdout says nothing: done
      ["result file only", `echo "IMAGEFIRST_PILOT PILOT_DONE phase=after_claim approval=${ID} exit=0" > '@RESULT@'`, "exit 0", 0, "PILOT_DONE"],
      // stdout says done, no result file: no result
      ["stdout only", `echo "IMAGEFIRST_PILOT PILOT_DONE phase=after_claim approval=${ID} exit=0"`, "exit 0", 1, "PILOT_NO_RESULT"],
      // another approval id in the result file: no result
      ["another id", `echo "IMAGEFIRST_PILOT PILOT_DONE phase=after_claim approval=${D4} exit=0" > '@RESULT@'`, "exit 0", 1, "PILOT_NO_RESULT"],
    ];
    for (const [name, write, end, status, pilot] of cases) {
      const w = world();
      w.switchOn();
      w.marker();
      writeFileSync(join(w.t, "pilot-stand-in.sh"), `${write.replace("@RESULT@", join(w.state, "autorun-result"))}\n${end}\n`);
      expect(w.run(), name).toMatchObject({ status, pilot, rc: "restored" });
    }
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

  it("review M1 (no standing policy, as before DEV-303): root's admin clone not at origin's develop (refused, Remote Control untouched), or develop moving during the stop (no pilot)", () => {
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

  it("DEV-303 CRITICAL: under a standing policy every run executes ONLY the owner-pinned worker_commit (never develop's tip, no ancestor rule); develop moving changes nothing", () => {
    // develop moves on before and during the run; the admin clone has changes: none of it matters, the pin runs
    const w = world();
    w.switchOn();
    const pinned = git(w.admin, "rev-parse", "HEAD");
    w.standing({ worker_commit: pinned });
    w.marker();
    const tip = pushOrigin(w, "claude-merged-later");
    writeFileSync(join(w.admin, "stray.txt"), "x");
    const helper = join(w.sc, "move-develop");
    git(w.t, "clone", "-q", "--branch", "develop", w.origin, helper);
    commitFiles(helper, { "docs/moved.md": Buffer.from("x") }, "moved");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: ID, pilot: "PILOT_DONE", rc: "restored" });
    expect(r.stdout).toContain(`a fresh clone at root's verified commit ${pinned}`);
    expect(r.stdout).toMatch(new RegExp(`\\| clone +\\| PASS \\| clean, HEAD = origin/develop = root's verified ${pinned}`));
    expect(readFileSync(join(w.state, "autorun", ID, "attempt"), "utf8")).toContain(`commit=${pinned}\n`);
    const fresh = readdirSync(join(w.home, "imagefirst")).filter((n) => /^autorun-.*Z$/.test(n));
    expect(git(join(w.home, "imagefirst", fresh[0]!), "rev-parse", "HEAD")).toBe(pinned);
    expect(git(w.origin, "rev-parse", "refs/heads/develop")).not.toBe(pinned);
    expect(tip).not.toBe(pinned);
    // a pinned commit that is not on develop at all (another branch the origin has): exactly it runs
    const v = world();
    v.switchOn();
    const side = tmp("sr-ifr-side-");
    git(side, "clone", "-q", "--branch", "develop", v.origin, ".");
    commitFiles(side, { "docs/side.md": Buffer.from("side") }, "side");
    git(side, "push", "-q", "origin", "HEAD:refs/heads/side");
    const sideSha = git(side, "rev-parse", "HEAD");
    v.standing({ worker_commit: sideSha });
    v.request("req-side");
    expect(v.run()).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: "req-side" });
    expect(readFileSync(join(v.state, "autorun", "req-side", "attempt"), "utf8")).toContain(`commit=${sideSha}\n`);
    // the origin no longer has the pin: nothing attempted, nothing spent, Remote Control untouched
    const u = world();
    u.switchOn();
    u.standing({ worker_commit: "0123456789abcdef0123456789abcdef01234567" });
    u.request("req-gone");
    const g = u.run();
    expect(g, g.stdout).toMatchObject({ status: 20, code: "AUTORUN_STANDING_COMMIT_UNAVAILABLE", rc: "untouched" });
    untouched(u);
    expect(u.rejected()).toEqual([]);
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
    const r = w.pilot(["--autorun", ID, sha, w.origin]);
    expect([r.status, r.code, r.phase]).toEqual([2, "PILOT_AUTORUN_REFUSED", "before_claim"]);
    expect(w.starts()).toEqual([]);
    for (const bad of [["--autorun", ID], ["--autorun", ID, sha], ["--autorun", "../x", sha, w.origin], ["--autorun", "hoshigama-imagefirst-d3-00000000-01", sha, w.origin], ["--autorun", ID, ID, w.origin], ["--autorun", ID, sha.toUpperCase(), w.origin], ["--autorun", ID, sha, sha, sha], ["--autorun-request", "x", sha, w.origin, "a".repeat(64)], ["--autorun-request", "req-ok", sha, w.origin, "short"]]) expect(w.pilot(bad).status, bad.join(" ")).toBe(2);
    insideService(w);
    // DEV-303: the origin URL is root's (passed by the automatic run); an unusual one is refused before anything
    expect(w.pilot(["--autorun", ID, sha, "-uhoh"])).toMatchObject({ status: 2, code: "PILOT_AUTORUN_ORIGIN_INVALID" });
    expect(w.pilot(["--autorun", ID, sha, "a b"])).toMatchObject({ status: 2, code: "PILOT_AUTORUN_ORIGIN_INVALID" });
    mkdirSync(join(w.t, "var", "lib", "sr-imagefirst-autostart", "used", ID), { recursive: true });
    expect(w.pilot(["--autorun", ID, sha, w.origin])).toMatchObject({ status: 2, code: "PILOT_MARKER_USED", phase: "before_claim" });
    expect(w.starts()).toEqual([]);
  });

  it("DEV-303: pilot --autorun fetches exactly root's commit by id; one the origin does not have: PILOT_STANDING_COMMIT_UNAVAILABLE before the preflight, nothing spent", () => {
    const w = wsl();
    adminClone(w);
    insideService(w);
    writeFileSync(join(w.sc, "sr-imagefirst-autorun.service"), "activating");
    expect(w.pilot(["--autorun", ID, "0123456789abcdef0123456789abcdef01234567", w.origin])).toMatchObject({ status: 20, code: "PILOT_STANDING_COMMIT_UNAVAILABLE", phase: "before_claim" });
    expect(w.starts()).toEqual([]);
    expect(existsSync(join(w.t, "var", "lib", "sr-imagefirst-autostart", "used"))).toBe(false);
    // the pilot never compares with develop's tip or accepts an ancestor: the source has no merge-base / clone --branch
    const pilot = readFileSync(PILOT, "utf8");
    expect(pilot).not.toMatch(/merge-base --is-ancestor "\$AUTORUN_SHA"|clone --quiet --no-local/);
    expect(pilot).toContain('fetch --quiet --no-tags origin "+$AUTORUN_SHA:refs/remotes/origin/develop"');
    expect(readFileSync(PREFLIGHT, "utf8")).not.toMatch(/has moved on|merge-base --is-ancestor "\$admin_head"/);
  });

  it("review H1: old fresh clones: the newest kept, older ones removed; links, other names and other places never touched", () => {
    const w = world();
    w.switchOn();
    w.marker();
    const base = join(w.home, "imagefirst");
    const old = ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"].map((s, i) => {
      const d = join(base, `autorun-hoshigama-imagefirst-d3-20200101-0${i + 1}-${s}`);
      mkdirSync(join(d, "x"), { recursive: true });
      const t = new Date(Date.UTC(2020, 0, 1 + i));
      utimesSync(d, t, t);
      return d;
    });
    const outside = tmp("sr-ifr-keep-");
    writeFileSync(join(outside, "keep.txt"), "x");
    symlinkSync(outside, join(base, "autorun-hoshigama-imagefirst-d3-20200101-09-20200109T000000Z"));
    mkdirSync(join(base, "keepme"));
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE" });
    expect(existsSync(old[0]!)).toBe(false);
    expect(existsSync(old[1]!)).toBe(false);
    expect(existsSync(old[2]!)).toBe(true);
    expect(lstatSync(join(base, "autorun-hoshigama-imagefirst-d3-20200101-09-20200109T000000Z")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("x");
    expect(existsSync(join(base, "keepme"))).toBe(true);
    expect(existsSync(join(base, "second-root"))).toBe(true);
    expect(readdirSync(base).filter((n) => n.startsWith(`autorun-${ID}-`))).toHaveLength(1);
  });

  it("review H1: the hand-off did not deliver: the one re-send runs from the fresh clone (--deliver-review), then the audit", () => {
    const w = world();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.home, "stub-review-fail"), "");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", pilot: "PILOT_DONE" });
    const resend = w.starts().filter((s) => s.argv[0] === "--deliver-review");
    expect(resend.map((s) => s.argv)).toEqual([["--deliver-review", ID]]);
    expect(resend[0]!.cwd).toMatch(new RegExp(`/imagefirst/autorun-${ID}-\\d{8}T\\d{6}Z$`));
    expect(readFileSync(w.review(), "utf8")).toMatch(/delivery=delivered_by_resend/);
  });

  it("re-review: a pilot that exits 137 or dies by SIGKILL ends the step at once with that status; Remote Control restored, the review file and result written", () => {
    for (const [name, end] of [["exit 137", "exit 137"], ["SIGKILL", "kill -KILL $$"]] as const) {
      const w = world();
      w.switchOn();
      w.marker();
      mkdirSync(join(w.home, "sr-runs"), { mode: 0o700 });
      const line = `IMAGEFIRST_PILOT PILOT_STOP_INTERNAL phase=after_claim approval=${ID} exit=137`;
      writeFileSync(join(w.t, "pilot-stand-in.sh"), `echo "imagefirst-pilot: share: approval=${ID} stand-in=${name.replace(" ", "_")}"\necho "${line}" > '${join(w.state, "autorun-result")}'\necho "${line}"\n${end}\n`);
      const started = Date.now();
      const r = w.run();
      expect(Date.now() - started, name).toBeLessThan(60_000);
      expect(r, `${name}\n${r.stdout}`).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", pilot: "PILOT_STOP_INTERNAL", rc: "restored" });
      expect(r.stdout, name).toContain("the pilot ended PILOT_STOP_INTERNAL (its exit 137; the step returned 137)");
      expect(w.events(), name).toEqual(["admin claude-stop", "admin claude-start"]);
      expect(readFileSync(w.review(), "utf8"), name).toBe(
        `imagefirst-pilot: share: approval=${ID} stand-in=${name.replace(" ", "_")}\nIMAGEFIRST_PILOT PILOT_STOP_INTERNAL phase=after_claim approval=${ID} exit=137\nIMAGEFIRST_AUTORUN_RESULT AUTORUN_PILOT_STOPPED approval=${ID} pilot=PILOT_STOP_INTERNAL exit=1\n`,
      );
      expect(w.flag(), name).toBe(false);
    }
  });

  it("config trust: planted ~/.codex config / AGENTS.md and ~/.claude CLAUDE.md / settings hooks are invisible to the CLIs; refreshed sign-ins go back; the run's dir is removed", () => {
    const w = world();
    w.switchOn();
    w.marker();
    writeFileSync(join(w.home, ".codex", "config.toml"), `notify = ["/bin/sh", "-c", "touch /tmp/planted"]\n[mcp_servers.evil]\ncommand = "/bin/sh"\n[model_providers.evil]\nbase_url = "http://127.0.0.1:1"\n`);
    writeFileSync(join(w.home, ".codex", "AGENTS.md"), "planted instructions\n");
    mkdirSync(join(w.home, ".codex", "prompts"));
    writeFileSync(join(w.home, ".codex", "prompts", "x.md"), "planted\n");
    // (~/.claude/CLAUDE.md is not "invisible": the audit's directory lies under the home, and Claude reads .claude/CLAUDE.md
    // in its parents as project memory, so config_trust refuses it: see the next test)
    writeFileSync(join(w.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "touch /tmp/planted" }] }] } }));
    mkdirSync(join(w.home, ".claude", "agents"));
    writeFileSync(join(w.home, ".claude.json"), JSON.stringify({ mcpServers: { evil: { command: "/bin/sh" } } }));
    writeFileSync(join(w.home, "stub-refresh"), "");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", pilot: "PILOT_DONE" });
    expect(r.stdout).toMatch(/\| config_trust \| PASS \|/);
    const fresh = readdirSync(join(w.home, "imagefirst")).filter((n) => /^autorun-.*Z$/.test(n));
    const cfg = join(w.home, "imagefirst", `${fresh[0]}.cfg`);
    // every worker command (the precheck, the Codex sign-in check, the run) saw only the run's CODEX_HOME, holding only
    // root's config and the sign-in copy; every audit command only the run's CLAUDE_CONFIG_DIR with the sign-in copy
    const workers = w.starts().filter((s) => s.cli === "worker");
    expect(workers.length).toBeGreaterThanOrEqual(3);
    for (const s of workers) expect([s.argv.join(" "), s.codexHome, s.codexFiles], s.argv.join(" ")).toEqual([s.argv.join(" "), join(cfg, "codex"), ["auth.json", "config.toml"]]);
    const audits = w.starts().filter((s) => s.cli === "audit");
    expect(audits.length).toBeGreaterThanOrEqual(3);
    for (const s of audits) expect([s.argv.join(" "), s.claudeDir, s.claudeFiles], s.argv.join(" ")).toEqual([s.argv.join(" "), join(cfg, "claude"), [".credentials.json"]]);
    // the refreshed sign-ins are back in their own places; the run's dir (with its copies) is gone; the planted files stay
    expect(readFileSync(join(w.home, ".codex", "auth.json"), "utf8")).toBe("refreshed-codex\n");
    expect(readFileSync(join(w.home, ".claude", ".credentials.json"), "utf8")).toBe("refreshed-claude\n");
    expect(statSync(join(w.home, ".codex", "auth.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(cfg)).toBe(false);
    expect(readdirSync(join(w.home, ".codex")).filter((n) => n.startsWith(".sr-copyback"))).toEqual([]);
    expect(readFileSync(join(w.home, ".codex", "AGENTS.md"), "utf8")).toBe("planted instructions\n");
  });

  it("config trust: root's config missing, another content, writable by others or a link; a sign-in file linked or missing; a CLAUDE.md above the audit's directory: the preflight FAILs before the claim", () => {
    const cases: [string, (w: World) => void][] = [
      ["root config missing", (w) => rmSync(join(w.etc, "codex-config.toml"))],
      ["root config: another content (SHA-256)", (w) => writeFileSync(join(w.etc, "codex-config.toml"), "[mcp_servers.x]\ncommand = \"/bin/sh\"\n", { mode: 0o644 })],
      ["root config group-writable", (w) => chmodSync(join(w.etc, "codex-config.toml"), 0o664)],
      ["root config a link", (w) => { const f = join(w.etc, "codex-config.toml"); writeFileSync(join(w.t, "real.toml"), readFileSync(f), { mode: 0o644 }); rmSync(f); symlinkSync(join(w.t, "real.toml"), f); }],
      ["~/.codex/auth.json a link", (w) => { const f = join(w.home, ".codex", "auth.json"); writeFileSync(join(w.t, "auth.json"), "x"); rmSync(f); symlinkSync(join(w.t, "auth.json"), f); }],
      ["~/.claude/.credentials.json a link", (w) => { const f = join(w.home, ".claude", ".credentials.json"); writeFileSync(join(w.t, "cred.json"), "x"); rmSync(f); symlinkSync(join(w.t, "cred.json"), f); }],
      ["~/.claude a link", (w) => { const d = join(w.t, "claude-elsewhere"); mkdirSync(d); writeFileSync(join(d, ".credentials.json"), "x"); rmSync(join(w.home, ".claude"), { recursive: true }); symlinkSync(d, join(w.home, ".claude")); }],
      ["the Claude sign-in missing", (w) => rmSync(join(w.home, ".claude", ".credentials.json"))],
      ["a CLAUDE.md in ~/.local", (w) => { mkdirSync(join(w.home, ".local"), { recursive: true }); writeFileSync(join(w.home, ".local", "CLAUDE.md"), "planted\n"); }],
      ["~/.claude/CLAUDE.md (project memory of the home)", (w) => writeFileSync(join(w.home, ".claude", "CLAUDE.md"), "planted\n")],
      ["~/.claude/rules/x.md", (w) => { mkdirSync(join(w.home, ".claude", "rules")); writeFileSync(join(w.home, ".claude", "rules", "x.md"), "planted\n"); }],
      ["~/.local/state/.claude/CLAUDE.md", (w) => { mkdirSync(join(w.home, ".local", "state", ".claude"), { recursive: true }); writeFileSync(join(w.home, ".local", "state", ".claude", "CLAUDE.md"), "planted\n"); }],
      // review M2: a model CLI program the worker could replace (resolved through a link into its home)
      ["claude resolves into the worker's home", (w) => { const d = join(w.home, ".npm-global", "bin"); mkdirSync(d, { recursive: true }); exe(join(d, "claude"), "exit 97"); rmSync(join(w.bin, "claude")); symlinkSync(join(d, "claude"), join(w.bin, "claude")); }],
      ["codex in the worker's home", (w) => { const d = join(w.home, ".local", "bin"); mkdirSync(d, { recursive: true }); exe(join(d, "codex"), "exit 97"); rmSync(join(w.bin, "codex")); symlinkSync(join(d, "codex"), join(w.bin, "codex")); }],
    ];
    for (const [name, arrange] of cases) {
      const w = world();
      w.switchOn();
      w.marker();
      arrange(w);
      const r = w.run();
      expect(r, `${name}\n${r.stdout}`).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", pilot: "PILOT_PREFLIGHT_FAILED", rc: "restored" });
      expect(r.stdout, name).toMatch(/\| config_trust \| FAIL \|/);
      expect(w.spent(), name).toEqual([]);
      expect(w.used(), name).toEqual([]);
      expect(readdirSync(join(w.home, "imagefirst")).filter((n) => n.endsWith(".cfg")), name).toEqual([]);
    }
  });

  it("review M1a: a stale .cfg left by a killed run: its sign-in copies newer than their places go back before it is removed; older ones do not", () => {
    const w = world();
    w.switchOn();
    w.marker();
    const stale = join(w.home, "imagefirst", "autorun-hoshigama-imagefirst-d3-20200101-01-20200101T000000Z.cfg");
    mkdirSync(join(stale, "codex"), { recursive: true });
    mkdirSync(join(stale, "claude"), { recursive: true });
    writeFileSync(join(stale, "codex", "auth.json"), "rotated-codex\n");
    writeFileSync(join(stale, "claude", ".credentials.json"), "older-claude\n");
    const later = new Date(Date.now() + 3600_000);
    const earlier = new Date(Date.now() - 3600_000);
    utimesSync(join(stale, "codex", "auth.json"), later, later);
    utimesSync(join(stale, "claude", ".credentials.json"), earlier, earlier);
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE" });
    expect(readFileSync(join(w.home, ".codex", "auth.json"), "utf8")).toBe("rotated-codex\n");
    expect(readFileSync(join(w.home, ".claude", ".credentials.json"), "utf8")).toBe("claude-sign-in\n");
    expect(existsSync(stale)).toBe(false);
    // and the run itself used the rotated sign-in (built after the cleanup)
    expect(readdirSync(join(w.home, "imagefirst")).filter((n) => n.endsWith(".cfg"))).toEqual([]);
  });

  it("review M1b: a pilot killed after the run's .cfg was built: autorun copies the refreshed sign-ins back (as the worker) before Remote Control returns", () => {
    const w = world();
    w.switchOn();
    w.marker();
    const fresh = join(w.home, "imagefirst", `autorun-${ID}-20261122T000000Z`);
    const cfg = `${fresh}.cfg`;
    writeFileSync(
      join(w.t, "pilot-stand-in.sh"),
      `mkdir -p '${cfg}/codex' '${cfg}/claude'
echo refreshed-codex > '${cfg}/codex/auth.json'
echo refreshed-claude > '${cfg}/claude/.credentials.json'
echo '${fresh}' > '${join(w.state, "autorun-clone")}'
kill -KILL $$
`,
    );
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", pilot: "PILOT_NO_RESULT", rc: "restored" });
    expect(r.stdout).toContain("the killed pilot's sign-in copies were handled");
    expect(readFileSync(join(w.home, ".codex", "auth.json"), "utf8")).toBe("refreshed-codex\n");
    expect(readFileSync(join(w.home, ".claude", ".credentials.json"), "utf8")).toBe("refreshed-claude\n");
    expect(existsSync(cfg)).toBe(false);
    // a state file naming a path outside the strict form: nothing is touched
    const v = world();
    v.switchOn();
    v.marker();
    const odd = join(v.home, "imagefirst", "elsewhere.cfg");
    writeFileSync(join(v.t, "pilot-stand-in.sh"), `mkdir -p '${odd}/codex'\necho x > '${odd}/codex/auth.json'\necho '${join(v.home, "imagefirst", "elsewhere")}' > '${join(v.state, "autorun-clone")}'\nkill -KILL $$\n`);
    expect(v.run()).toMatchObject({ status: 1, pilot: "PILOT_NO_RESULT", rc: "restored" });
    expect(readFileSync(join(v.home, ".codex", "auth.json"), "utf8")).toBe("codex-sign-in\n");
    expect(existsSync(odd)).toBe(true);
  });

  it("config trust: the pinned SHA-256 is the repository's codex-config.toml in both scripts; the manual preflight has no config_trust row", () => {
    const want = sha(readFileSync(CODEX_CONFIG_REPO));
    for (const f of [PILOT, PREFLIGHT]) expect(new RegExp(`^CODEX_CONFIG_SHA256=${want}$`, "m").test(readFileSync(f, "utf8")), f).toBe(true);
    const config = readFileSync(CODEX_CONFIG_REPO, "utf8");
    // comments only: no MCP server, notify, provider, profile or any other setting
    for (const l of config.split("\n")) expect(l, l).toMatch(/^(#.*)?$/);
    const w = wsl();
    const p = w.preflight([ID]);
    expect(p.status, p.stdout).toBe(0);
    expect(Object.keys(p.rows)).not.toContain("config_trust");
  });

  it("re-review M1: a node_modules / .node_modules / .node_libraries / package.json in the worker's home or ~/imagefirst: refused before the claim", () => {
    const plants: [string, (w: World) => void][] = [
      ["~/node_modules/bufferutil", (w) => { mkdirSync(join(w.home, "node_modules", "bufferutil"), { recursive: true }); writeFileSync(join(w.home, "node_modules", "bufferutil", "index.js"), "module.exports = {};\n"); }],
      ["~/.node_modules (a link)", (w) => symlinkSync(tmp("sr-ifr-nm-"), join(w.home, ".node_modules"))],
      ["~/.node_libraries", (w) => mkdirSync(join(w.home, ".node_libraries"))],
      ["~/imagefirst/node_modules", (w) => mkdirSync(join(w.home, "imagefirst", "node_modules"))],
      ["~/package.json", (w) => writeFileSync(join(w.home, "package.json"), '{"type":"module"}')],
      ["~/imagefirst/package.json", (w) => writeFileSync(join(w.home, "imagefirst", "package.json"), '{"imports":{}}')],
    ];
    for (const [name, plant] of plants) {
      const w = world();
      w.switchOn();
      w.marker();
      plant(w);
      const r = w.run();
      expect(r, `${name}\n${r.stdout}`).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", pilot: "PILOT_AUTORUN_NODE_PATHS", rc: "restored" });
      expect(w.starts(), name).toEqual([]);
      expect(w.used(), name).toEqual([]);
      expect(readdirSync(join(w.home, "imagefirst")).filter((n) => n.startsWith("autorun-")), name).toEqual([]);
    }
  });

  it("re-review L1: a planted name with a newline (or any other name) is never removed, and nothing else is removed because of it", () => {
    const w = world();
    w.switchOn();
    w.marker();
    const base = join(w.home, "imagefirst");
    const valid = join(base, "autorun-hoshigama-imagefirst-d3-20200101-01-20200101T000000Z");
    const nl = join(base, "autorun-hoshigama-imagefirst-d3-20200101-02-20200102T000000Z\nkeepme");
    const odd = join(base, "autorun-hoshigama-imagefirst-d3-odd");
    for (const d of [valid, nl, odd, join(base, "keepme")]) mkdirSync(d);
    const t = new Date(Date.UTC(2020, 0, 1));
    utimesSync(nl, t, t);
    utimesSync(odd, t, t);
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE" });
    // the only valid earlier clone is the newest valid one: kept; the others are not fresh clones: untouched
    for (const d of [valid, nl, odd, join(base, "keepme"), join(base, "second-root")]) expect(existsSync(d), d).toBe(true);
  });

  it("re-review L2 / L3: the worker gets no user / system git config and no attributes file (and no NODE_PATH); the disk row asks 2 GiB more", () => {
    const w = world();
    w.switchOn();
    w.marker();
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE" });
    const run = w.starts().find((s) => s.cli === "worker" && s.argv.length === 0)!;
    for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) expect(run.env, k).toContain(k);
    expect(run.env).not.toContain("NODE_PATH");
    // and the worker passes them on to its own git (worker/env.ts), never NODE_PATH
    const child = childEnvironment({ PATH: "/usr/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.attributesFile", GIT_CONFIG_VALUE_0: "/dev/null", NODE_PATH: "/x" });
    expect(child).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.attributesFile", GIT_CONFIG_VALUE_0: "/dev/null" });
    expect(child.NODE_PATH).toBeUndefined();
    // the test world asks 1 MiB; inside the automatic run 2048 MiB more (production: 4096 + 2048)
    expect(r.stdout).toMatch(/\| disk +\| PASS \| \d+ MiB free \(at least 2049\)/);
    expect(readFileSync(PREFLIGHT, "utf8")).toMatch(/^MIN_FREE_MIB=4096$/m);
    expect(readFileSync(PREFLIGHT, "utf8")).toMatch(/^AUTORUN_EXTRA_MIB=2048$/m);
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
    // the pilot's fresh clone, named in root's state file (as the pilot leaves it before the preflight)
    const fc = join(v.home, "imagefirst", `autorun-${ID}-20261121T000000Z`);
    git(v.t, "clone", "-q", "--branch", "develop", v.origin, fc);
    mkdirSync(join(fc, "node_modules"));
    symlinkSync(join(REPO, "node_modules", "tsx"), join(fc, "node_modules", "tsx"), "dir");
    mkdirSync(join(v.t, "var", "lib", "sr-imagefirst-autostart"), { recursive: true });
    writeFileSync(join(v.t, "var", "lib", "sr-imagefirst-autostart", "autorun-clone"), `${fc}\n`);
    // DEV-303: the commit root pinned (the pilot writes it next to the clone's name)
    const pinned = git(vadmin, "rev-parse", "HEAD");
    writeFileSync(join(v.t, "var", "lib", "sr-imagefirst-autostart", "autorun-commit"), `${pinned}\n`);
    // and its own config dirs, as the pilot builds them
    configTrust(v);
    buildCfg(`${fc}.cfg`);
    writeFileSync(join(v.sc, "enabled-sr-imagefirst-autorun.timer"), "enabled");
    expect(v.preflight([ID]).rows.timers?.ok).toBe(false);
    writeFileSync(join(v.sc, "sr-imagefirst-autorun.service"), "activating");
    const ok = v.preflight([ID]);
    expect(ok.status, ok.stdout).toBe(0);
    expect(ok.rows.timers?.why).toMatch(/inside sr-imagefirst-autorun\.service \(activating\)/);
    expect(ok.rows.clone?.why).toBe(`clean, HEAD = origin/develop = root's verified ${pinned}`);
    // review M1 / DEV-303: inside the service the clone row compares with root's PINNED commit (root's state file), not
    // with the clone's own origin/develop; a missing or other pin fails
    writeFileSync(join(v.t, "var", "lib", "sr-imagefirst-autostart", "autorun-commit"), `${"0".repeat(40)}\n`);
    expect(v.preflight([ID]).rows.clone?.ok).toBe(false);
    rmSync(join(v.t, "var", "lib", "sr-imagefirst-autostart", "autorun-commit"));
    expect(v.preflight([ID]).rows.clone?.why).toMatch(/pinned commit .* missing/);
    writeFileSync(join(v.t, "var", "lib", "sr-imagefirst-autostart", "autorun-commit"), `${pinned}\n`);
    // DEV-303: no ancestor rule: the clone's origin/develop anything but the pin (e.g. a later commit) fails
    commitFiles(fc, { "docs/later.md": Buffer.from("x") }, "later on develop");
    git(fc, "update-ref", "refs/remotes/origin/develop", "HEAD");
    git(fc, "reset", "-q", "--hard", "HEAD~1");
    expect(v.preflight([ID]).rows.clone?.ok).toBe(false);
    git(fc, "update-ref", "refs/remotes/origin/develop", "HEAD");
    // the state file naming another id's clone, or a path outside the prefix: the worker rows fail (the reused clone is never used)
    for (const bad of [join(v.home, "imagefirst", `autorun-${D4}-20261121T000000Z`), v.clone, `${fc}/../second-root`]) {
      writeFileSync(join(v.t, "var", "lib", "sr-imagefirst-autostart", "autorun-clone"), `${bad}\n`);
      const p = v.preflight([ID]);
      expect([p.status, p.rows.clone?.ok, p.rows.approval?.ok], bad).toEqual([20, false, false]);
    }
    writeFileSync(join(v.t, "var", "lib", "sr-imagefirst-autostart", "autorun-clone"), `${fc}\n`);
    // the old automatic start is refused there too
    writeFileSync(join(v.sc, "enabled-sr-imagefirst-autostart.timer"), "enabled");
    expect(v.preflight([ID]).rows.timers?.ok).toBe(false);
  });
});

describe("DEV-303 standing pre-authorization: the owner's one-time policy and Claude's request files", () => {
  const RID = "req-hoshigama-001";

  it("one request end to end: picked up as the worker, root's copy + SHA-256, the worker gets --request <id> --request-sha256 <hex> and a private copy; never twice", () => {
    const w = world();
    w.switchOn();
    w.standing();
    const bytes = w.request(RID);
    const want = sha(bytes);
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: RID, pilot: "PILOT_DONE", rc: "restored" });
    // root's copy: 0600 in root's 0700 state, the very bytes; the attempt records the request's SHA-256 and the pinned commit
    const copy = join(w.state, "requests", `${RID}.json`);
    expect(readFileSync(copy)).toEqual(bytes);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    const attempt = readFileSync(join(w.state, "autorun", RID, "attempt"), "utf8");
    expect(attempt).toMatch(new RegExp(`^request_id=${RID}\\nkind=standing\\nattempted_at=\\d+\\ncommit=${git(w.admin, "rev-parse", "HEAD")}\\nrequest_sha256=${want}\\n$`));
    // the worker: once, with the request id and root's SHA-256, no approval grant, the run's private copy (same bytes)
    const fresh = readdirSync(join(w.home, "imagefirst")).filter((n) => /^autorun-req-hoshigama-001-\d{8}T\d{6}Z$/.test(n));
    expect(fresh).toHaveLength(1);
    const fc = join(w.home, "imagefirst", fresh[0]!);
    const runs = w.spent().filter((x) => x.cli === "worker");
    expect(runs.map((x) => x.argv)).toEqual([["--request", RID, "--request-sha256", want]]);
    expect(runs[0]!.requestFile).toBe(`${fc}.request/${RID}.json`);
    expect(runs[0]!.requestSha).toBe(want);
    expect(runs[0]!.env).not.toContain("SR_IMAGEFIRST_EXPECT_APPROVAL_ID");
    expect(statSync(`${fc}.request/${RID}.json`).mode & 0o777).toBe(0o600);
    expect(w.spent().filter((x) => x.cli === "audit").map((x) => x.argv)).toEqual([[RID]]);
    expect(r.stdout).toMatch(/\| approval +\| PASS \| standing request req-hoshigama-001/);
    // no packet precheck for a request
    expect(w.starts().filter((x) => x.cli === "worker" && x.argv[0] === "--precheck")).toEqual([]);
    expect(w.events()).toEqual(["admin claude-stop", `worker used=${RID},`, "admin claude-start"]);
    expect(readFileSync(w.review(RID), "utf8")).toContain(`IMAGEFIRST_AUTORUN_RESULT AUTORUN_DONE approval=${RID} pilot=PILOT_DONE exit=0`);
    // the next firings: nothing new, Remote Control untouched, nothing spent again (the request file is still there)
    for (let i = 0; i < 2; i++) expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_NO_REQUEST", approval: "none", rc: "untouched" });
    expect(w.events()).toHaveLength(3);
    expect(w.spent()).toHaveLength(2);
  });

  it("no, expired, unsafe or invalid policy: nothing runs and no request is read", () => {
    const cases: [string, (w: World) => void, number, string][] = [
      ["no policy", () => {}, 10, "AUTORUN_IDLE_NO_MARKER"],
      ["expired", (w) => w.standing({ not_after: utc(Date.now() - 60_000), created_at: utc(Date.now() - 86400_000) }), 10, "AUTORUN_IDLE_STANDING_EXPIRED"],
      ["writable by others (not root's only)", (w) => { w.standing(); chmodSync(join(w.etc, "imagefirst-standing.json"), 0o666); }, 2, "AUTORUN_STANDING_UNSAFE"],
      ["a link", (w) => { w.standing(); writeFileSync(join(w.etc, "elsewhere.json"), readFileSync(join(w.etc, "imagefirst-standing.json")), { mode: 0o644 }); rmSync(join(w.etc, "imagefirst-standing.json")); symlinkSync(join(w.etc, "elsewhere.json"), join(w.etc, "imagefirst-standing.json")); }, 2, "AUTORUN_STANDING_UNSAFE"],
      ["per_day over 4", (w) => w.standing({ per_day: 5, per_week: 20 }), 2, "AUTORUN_STANDING_INVALID"],
      ["per_week over 20", (w) => w.standing({ per_week: 21 }), 2, "AUTORUN_STANDING_INVALID"],
      ["per_week under per_day", (w) => w.standing({ per_day: 3, per_week: 2 }), 2, "AUTORUN_STANDING_INVALID"],
      ["more than 90 days", (w) => w.standing({}, 91), 2, "AUTORUN_STANDING_INVALID"],
      ["created in the future", (w) => w.standing({ created_at: utc(Date.now() + 3600_000) }), 2, "AUTORUN_STANDING_INVALID"],
      ["another key", (w) => w.standing({ unlimited: true }), 2, "AUTORUN_STANDING_INVALID"],
      ["another schema", (w) => w.standing({ schema: "sr_imagefirst_standing_v2" }), 2, "AUTORUN_STANDING_INVALID"],
      ["a boolean limit", (w) => w.standing({ per_day: true }), 2, "AUTORUN_STANDING_INVALID"],
      ["an unusual origin_url", (w) => w.standing({ origin_url: "-uhoh" }), 2, "AUTORUN_STANDING_INVALID"],
      ["no worker_commit", (w) => w.standing({ worker_commit: undefined }), 2, "AUTORUN_STANDING_INVALID"],
      ["a short worker_commit", (w) => w.standing({ worker_commit: "abc123" }), 2, "AUTORUN_STANDING_INVALID"],
      ["an invalid policy blocks a due marker too", (w) => { w.standing({ per_day: 9 }); w.marker(); }, 2, "AUTORUN_STANDING_INVALID"],
    ];
    for (const [name, arrange, status, code] of cases) {
      const w = world();
      w.switchOn();
      w.request(RID);
      arrange(w);
      expect(w.run(), name).toMatchObject({ status, code, approval: "none", rc: "untouched" });
      untouched(w);
      expect(w.rejected(), name).toEqual([]);
      expect(existsSync(join(w.state, "requests")), name).toBe(false);
    }
  });

  it("the limits: per day and per week, rolling, from root's attempt records (a failed attempt counts, an unreadable one counts as now)", () => {
    const w = world();
    w.switchOn();
    w.standing({ per_day: 2, per_week: 3 });
    w.fastPilot();
    const s = Math.floor(Date.now() / 1000);
    const plant = (id: string, at: string | null) => {
      mkdirSync(join(w.state, "autorun", id), { recursive: true, mode: 0o700 });
      if (at !== null) writeFileSync(join(w.state, "autorun", id, "attempt"), `request_id=${id}\nkind=standing\nattempted_at=${at}\n`);
    };
    plant("old-a", String(s - 23 * 3600));
    plant("old-b", String(s - 25 * 3600));
    w.request("req-one", { created_at: "2026-11-01T00:00:00Z" });
    w.request("req-two", { created_at: "2026-11-02T00:00:00Z" });
    // 1 in 24 h (< 2), 2 in 7 days (< 3): the oldest request runs; its pilot fails, the attempt counts all the same
    writeFileSync(join(w.sc, "pilot-fail"), "");
    expect(w.run()).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", approval: "req-one", pilot: "PILOT_WORKER_STOPPED" });
    rmSync(join(w.sc, "pilot-fail"));
    // now 2 in 24 h and 3 in 7 days: the limit; req-two is not even read
    const q = w.run();
    expect(q, q.stdout).toMatchObject({ status: 10, code: "AUTORUN_IDLE_QUOTA", approval: "none", rc: "untouched" });
    expect(existsSync(join(w.state, "requests", "req-two.json"))).toBe(false);
    // 2 h later: old-a left the 24 h window, but the week still holds 3
    writeFileSync(join(w.t, "clock"), String(s + 2 * 3600));
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_QUOTA" });
    // 8 days later: every earlier attempt is out of both windows: req-two runs
    writeFileSync(join(w.t, "clock"), String(s + 8 * 86400));
    expect(w.run()).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: "req-two" });
    expect(w.pilotArgs().map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["--autorun-request req-one", "--autorun-request req-two"]);
    // an attempt record without a readable time counts as now (fail closed)
    const v = world();
    v.switchOn();
    v.standing({ per_day: 1, per_week: 8 });
    v.fastPilot();
    mkdirSync(join(v.state, "autorun", "broken"), { recursive: true, mode: 0o700 });
    v.request("req-three");
    expect(v.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_QUOTA" });
    expect(v.pilotArgs()).toEqual([]);
  });

  it("the oldest valid request first (created_at, then id); one attempt per id even after a failure, never retried or re-read", () => {
    const w = world();
    w.switchOn();
    w.standing({ per_day: 4, per_week: 20 });
    w.fastPilot();
    w.request("req-c01", { created_at: "2026-11-20T00:00:00Z" });
    w.request("req-b01", { created_at: "2026-11-21T00:00:00Z" });
    w.request("req-a01", { created_at: "2026-11-21T00:00:00Z", kind: "real_shop", shop_id: "some_shop-1" });
    writeFileSync(join(w.sc, "pilot-fail"), "");
    expect(w.run()).toMatchObject({ status: 1, code: "AUTORUN_PILOT_STOPPED", approval: "req-c01" });
    rmSync(join(w.sc, "pilot-fail"));
    // the failed request rewritten by the worker afterwards: never read again
    w.request("req-c01", { created_at: "2020-01-01T00:00:00Z" });
    expect(w.run()).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: "req-a01" });
    expect(w.run()).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: "req-b01" });
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_NO_REQUEST" });
    const origin = git(w.admin, "config", "--get", "remote.origin.url");
    const head = git(w.admin, "rev-parse", "HEAD");
    const args = w.pilotArgs();
    expect(args.map((l) => l.split(" ")[1])).toEqual(["req-c01", "req-a01", "req-b01"]);
    for (const l of args) expect(l).toMatch(new RegExp(`^--autorun-request req-[a-c]01 ${head} ${origin.replace(/[.]/g, "\\.")} [0-9a-f]{64}$`));
    expect(w.attempted().sort()).toEqual(["req-a01", "req-b01", "req-c01"]);
    expect(w.events()).toEqual(["admin claude-stop", "admin claude-start", "admin claude-stop", "admin claude-start", "admin claude-stop", "admin claude-start"]);
  });

  it("invalid requests: root's rejected/<id> with a reason, the worker's notice (written as the worker), never retried; links, FIFOs, directories and oversize files are refused", () => {
    const w = world();
    w.switchOn();
    w.standing({ per_day: 4, per_week: 20 });
    w.fastPilot();
    const dir = join(w.home, "sr-runs", "requests");
    w.request("req-bad-schema", { schema: "sr_imagefirst_request_v0" });
    w.request("req-id-mismatch", { id: "someone-else" });
    w.request("req-bad-shop", { shop_id: "Hoshi Gama!" });
    w.request("req-bad-kind", { kind: "prospect" });
    w.request("req-bad-time", { created_at: "2026-11-23 00:00" });
    w.request("req-good", { created_at: "2026-11-23T01:00:00Z" });
    writeFileSync(join(dir, "req-not-json.json"), "{nope", { mode: 0o600 });
    writeFileSync(join(dir, "req-too-big.json"), JSON.stringify({ schema: "sr_imagefirst_request_v1", id: "req-too-big", shop_id: "x1", kind: "fictional", created_at: "2026-11-01T00:00:00Z", pad: "x".repeat(17_000) }), { mode: 0o600 });
    writeFileSync(join(w.t, "outside.json"), JSON.stringify({ schema: "sr_imagefirst_request_v1", id: "req-link", shop_id: "x1", kind: "fictional", created_at: "2026-11-01T00:00:00Z" }));
    symlinkSync(join(w.t, "outside.json"), join(dir, "req-link.json"));
    expect(spawnSync("mkfifo", [join(dir, "req-fifo.json")]).status).toBe(0);
    mkdirSync(join(dir, "req-dir.json"));
    // names that are no request id: ignored, never recorded
    writeFileSync(join(dir, "Bad_Name.json"), "{}");
    writeFileSync(join(dir, "ab.json"), "{}");
    // an approval id's form (or any id without req-) is never a request
    writeFileSync(join(dir, `${ID}.json`), JSON.stringify({ schema: "sr_imagefirst_request_v1", id: ID, shop_id: "x1", kind: "fictional", created_at: "2026-11-01T00:00:00Z" }));
    writeFileSync(join(dir, "good-but-no-prefix.json"), JSON.stringify({ schema: "sr_imagefirst_request_v1", id: "good-but-no-prefix", shop_id: "x1", kind: "fictional", created_at: "2026-11-01T00:00:00Z" }));
    const started = Date.now();
    const r = w.run();
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: "req-good" });
    const want: Record<string, string> = { "req-bad-schema": "REQ_SCHEMA", "req-id-mismatch": "REQ_ID_MISMATCH", "req-bad-shop": "REQ_SHOP_ID", "req-bad-kind": "REQ_KIND", "req-bad-time": "REQ_CREATED_AT", "req-not-json": "REQ_NOT_JSON", "req-too-big": "REQ_TOO_LARGE", "req-link": "REQ_NOT_REGULAR", "req-fifo": "REQ_NOT_REGULAR", "req-dir": "REQ_NOT_REGULAR" };
    expect(w.rejected()).toEqual(Object.keys(want).sort());
    const notices = join(w.home, "sr-runs", "review-inbox", "requests");
    for (const [id, why] of Object.entries(want)) {
      expect(readFileSync(join(w.state, "rejected", id, "reason"), "utf8"), id).toMatch(new RegExp(`^request_id=${id}\\nreason=${why}\\nrejected_at=\\d+\\n$`));
      expect(readFileSync(join(notices, `${id}.rejected`), "utf8"), id).toBe(`IMAGEFIRST_REQUEST_REJECTED id=${id} reason=${why}\n`);
      expect(statSync(join(notices, `${id}.rejected`)).mode & 0o777, id).toBe(0o600);
      expect(existsSync(join(w.state, "requests", `${id}.json`)), id).toBe(false);
    }
    expect(readdirSync(notices).sort()).toEqual(Object.keys(want).map((id) => `${id}.rejected`).sort());
    // every read and every notice went through the worker's privilege drop (the setpriv stand-in logs each)
    expect(readFileSync(join(w.sc, "setpriv.log"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(1 + Object.keys(want).length * 2);
    // never retried: the same files (even fixed ones) are not read again; the notices are not rewritten
    w.request("req-bad-schema");
    const before = Object.fromEntries(Object.keys(want).map((id) => [id, statSync(join(w.state, "rejected", id, "reason")).mtimeMs]));
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_NO_REQUEST" });
    for (const id of Object.keys(want)) expect(statSync(join(w.state, "rejected", id, "reason")).mtimeMs, id).toBe(before[id]);
    expect(w.pilotArgs().map((l) => l.split(" ")[1])).toEqual(["req-good"]);
    // the requests directory (or ~/sr-runs) as a link: nothing read at all
    const v = world();
    v.switchOn();
    v.standing();
    v.fastPilot();
    mkdirSync(join(v.t, "elsewhere"), { recursive: true });
    mkdirSync(join(v.home, "sr-runs"), { recursive: true });
    symlinkSync(join(v.t, "elsewhere"), join(v.home, "sr-runs", "requests"));
    writeFileSync(join(v.t, "elsewhere", "req-planted.json"), JSON.stringify({ schema: "sr_imagefirst_request_v1", id: "req-planted", shop_id: "x1", kind: "fictional", created_at: "2026-11-01T00:00:00Z" }));
    expect(v.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_NO_REQUEST", rc: "untouched" });
    expect(v.rejected()).toEqual([]);
    expect(v.pilotArgs()).toEqual([]);
  });

  it("the per-run approval (the manual fallback) still works with a standing policy present, and goes first; a used marker falls through to the requests", () => {
    const w = world();
    w.switchOn();
    w.standing({ per_day: 4, per_week: 20 });
    w.fastPilot();
    w.marker();
    w.request(RID);
    expect(w.run()).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: ID });
    // the stand-in pilot did not create used/<id>: the attempt record stops the marker; the request runs next
    expect(w.run()).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: RID });
    expect(w.run()).toMatchObject({ status: 10, code: "AUTORUN_IDLE_NO_REQUEST" });
    const args = w.pilotArgs();
    // under the policy the per-run approval also runs the owner-pinned worker_commit
    expect(args[0]).toMatch(new RegExp(`^--autorun ${ID} ${git(w.admin, "rev-parse", "HEAD")} \\S+$`));
    expect(args[1]).toMatch(new RegExp(`^--autorun-request ${RID} [0-9a-f]{40} \\S+ [0-9a-f]{64}$`));
    // the approval's attempt keeps its own form
    expect(readFileSync(join(w.state, "autorun", ID, "attempt"), "utf8")).toMatch(new RegExp(`^approval_id=${ID}\\nattempted_at=\\d+\\ncommit=[0-9a-f]{40}\\n$`));
    // and without any policy the per-run approval works as before (the success test above runs the real pilot)
  });

  it("the installed copy: run from root's SHA256SUMS-recorded copy; a file writable by others, changed, unrecorded or missing is refused before anything", () => {
    const w = world();
    w.switchOn();
    w.standing();
    w.request(RID);
    const inst = join(w.t, "usr", "local", "lib", "sr-imagefirst");
    const setupSrc = readFileSync(join(SCRIPTS, "imagefirst-autorun-setup.sh"), "utf8");
    const files = /^INSTALL_FILES=\(\n([\s\S]*?)\n\)$/m.exec(setupSrc)![1]!.split("\n").map((l) => l.trim());
    expect(files).toContain("scripts/sales-design-worker/imagefirst-autorun.sh");
    const install = () => {
      for (const rel of files) {
        mkdirSync(join(inst, rel, ".."), { recursive: true, mode: 0o755 });
        writeFileSync(join(inst, rel), readFileSync(join(REPO, rel)), { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
        chmodSync(join(inst, rel), rel.endsWith(".sh") ? 0o755 : 0o644);
      }
      writeFileSync(join(inst, "SHA256SUMS"), files.map((rel) => `${sha(readFileSync(join(REPO, rel)))}  ${rel}\n`).join(""), { mode: 0o644 });
      for (const d of [join(w.t, "usr"), join(w.t, "usr", "local"), join(w.t, "usr", "local", "lib")]) chmodSync(d, 0o755);
    };
    install();
    const AT = join(inst, "scripts", "sales-design-worker", "imagefirst-autorun.sh");
    const PILOT_AT = join(inst, "scripts", "sales-design-worker", "imagefirst-pilot.sh");
    const refusals: [string, () => void][] = [
      ["the pilot writable by others", () => chmodSync(PILOT_AT, 0o775)],
      ["a directory writable by others", () => chmodSync(join(inst, "scripts"), 0o777)],
      ["the pilot changed", () => writeFileSync(PILOT_AT, `${readFileSync(PILOT_AT, "utf8")}\n# changed\n`)],
      ["admin.sh not recorded", () => writeFileSync(join(inst, "SHA256SUMS"), readFileSync(join(inst, "SHA256SUMS"), "utf8").split("\n").filter((l) => !l.endsWith("sales-design-capture/admin.sh")).join("\n"))],
      ["SHA256SUMS missing", () => rmSync(join(inst, "SHA256SUMS"))],
      ["the memory check a link", () => { const f = join(inst, "scripts", "ops", "wsl-resource-preflight.sh"); rmSync(f); symlinkSync(join(REPO, "scripts", "ops", "wsl-resource-preflight.sh"), f); }],
    ];
    for (const [name, spoil] of refusals) {
      spoil();
      const r = w.run([], AT);
      expect(r, `${name}\n${r.stdout}`).toMatchObject({ status: 2, code: "AUTORUN_INSTALL_UNTRUSTED", rc: "untouched" });
      untouched(w);
      rmSync(inst, { recursive: true, force: true });
      install();
    }
    // the recorded copy: the run goes through the INSTALLED pilot (and its preflight)
    const ok = w.run([], AT);
    expect(ok, ok.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: RID, pilot: "PILOT_DONE" });
    expect(ok.stdout).toContain(`imagefirst-autorun: the pilot: ${PILOT_AT}`);
    // the production copy refuses to run from the admin clone (the unit starts the installed copy only)
    const src = readFileSync(AUTORUN, "utf8");
    expect(src).toMatch(/if \[ "\$REPO" = "\$PROD_CLONE" \]; then\n[^\n]*\n\s*say "AUTORUN_NOT_INSTALLED_COPY/);
    expect(src).toContain("INSTALL_DIR=/usr/local/lib/sr-imagefirst");
  });

  it("HIGH 1: root counts the run's images after the run (as the worker); more than 6: AUTORUN_IMAGE_CAP_EXCEEDED and standing pick-ups frozen until the owner unfreezes", () => {
    const w = world();
    w.switchOn();
    w.standing({ per_day: 4, per_week: 20 });
    w.request("req-seven", { created_at: "2026-11-01T00:00:00Z" });
    w.request("req-next", { created_at: "2026-11-02T00:00:00Z" });
    writeFileSync(join(w.home, "stub-seven"), "");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 1, code: "AUTORUN_IMAGE_CAP_EXCEEDED", approval: "req-seven", pilot: "PILOT_DONE", rc: "restored" });
    expect(r.stdout).toContain("left 7 images (at most 6)");
    expect(readFileSync(join(w.state, "standing.frozen"), "utf8")).toMatch(/^frozen_at=\d+\nid=req-seven\nreason=AUTORUN_IMAGE_CAP_EXCEEDED 7 images \(at most 6\)\n$/);
    // frozen: nothing is read or run, Remote Control untouched, until the owner removes the freeze (setup standing --unfreeze)
    rmSync(join(w.home, "stub-seven"));
    expect(w.run()).toMatchObject({ status: 2, code: "AUTORUN_STANDING_FROZEN", rc: "untouched" });
    expect(existsSync(join(w.state, "requests", "req-next.json"))).toBe(false);
    rmSync(join(w.state, "standing.frozen"));
    const ok = w.run();
    expect(ok, ok.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: "req-next" });
    expect(ok.stdout).toContain("images of this run: 6 (at most 6)");
  });

  it("LOW: an attempt record without a readable time counts at its directory's time; rejected/ stops growing at 200 records", () => {
    const w = world();
    w.switchOn();
    w.standing({ per_day: 1, per_week: 8 });
    w.fastPilot();
    mkdirSync(join(w.state, "autorun", "old-broken"), { recursive: true, mode: 0o700 });
    const old = (Date.now() - 2 * 86400_000) / 1000;
    utimesSync(join(w.state, "autorun", "old-broken"), old, old);
    w.request("req-after-old");
    const r = w.run();
    expect(r, r.stdout).toMatchObject({ status: 0, code: "AUTORUN_DONE", approval: "req-after-old" });
    expect(r.stdout).toContain("the attempt record old-broken has no readable attempted_at: its directory's time is counted");
    const v = world();
    v.switchOn();
    v.standing({ per_day: 4, per_week: 20 });
    v.fastPilot();
    for (let i = 0; i < 200; i++) mkdirSync(join(v.state, "rejected", `req-filler-${i}`), { recursive: true, mode: 0o700 });
    v.request("req-bad-one", { kind: "nope" });
    const q = v.run();
    expect(q, q.stdout).toMatchObject({ status: 10, code: "AUTORUN_IDLE_NO_REQUEST" });
    expect(q.stdout).toContain("rejected/ holds 200 records already: not recorded (skipped)");
    expect(existsSync(join(v.state, "rejected", "req-bad-one"))).toBe(false);
  });

  it("MVP_SPEC §7.1: generation under the owner's one-time standing pre-authorization within root's limits; real-shop images internal only; publishing and sending still need the owner", () => {
    const spec = readFileSync(join(REPO, "docs", "MVP_SPEC.md"), "utf8");
    const s71 = spec.slice(spec.indexOf("### 7.1 "), spec.indexOf("\n### ", spec.indexOf("### 7.1 ") + 5));
    expect(s71).not.toContain("今までどおり 1 回ごとのオーナーの承認が要る");
    expect(s71).toContain("**オーナーが一度だけ設定する包括的な事前許可**（オーナー決定 2026-11-23、DEV-303）");
    expect(s71).toContain("上限は root が守る");
    expect(s71).toContain("**実店舗の画像は社内のデザインの参考だけ**: 相手（prospect）に見せない・共有しない・版に入れない。");
    expect(s71).toContain("**本番の公開と営業の送信は、今までどおりオーナーの確認が要る**。自動送信は作らない。");
    const doc = readFileSync(join(REPO, "docs", "operations", "imagefirst-autorun.md"), "utf8");
    for (const l of ["check --expect <sha>", "apply --yes --expect <sha>", "standing --yes --expect <sha> --per-day", "enable-timer --yes --expect <sha>", "standing --revoke --yes"]) expect(doc, l).toContain(l);
  });

  it("the request envelope and limits are pinned: the shared interface (id, size, schema, kinds) and the setup's ceilings", () => {
    const src = readFileSync(AUTORUN, "utf8");
    expect(src).toContain("REQ_ID_RE='^req-[a-z0-9][a-z0-9-]{2,58}$'");
    // an approval id can never start with req- (every parser of one wants hoshigama-imagefirst-...), and a request id never
    // has an approval id's form
    for (const f of [AUTORUN, APPROVE, PILOT, PREFLIGHT]) for (const m of readFileSync(f, "utf8").matchAll(/hoshigama-imagefirst-d\[34\]-\[0-9\]\{8\}-\[0-9\]\{2\}/g)) expect(m[0]).not.toMatch(/^req-/);
    expect(/^req-[a-z0-9][a-z0-9-]{2,58}$/.test(ID)).toBe(false);
    expect(/^hoshigama-imagefirst-d[34]-[0-9]{8}-[0-9]{2}$/.test("req-hoshigama-001")).toBe(false);
    expect(src).toMatch(/^REQ_MAX_BYTES=16384$/m);
    expect(src).toContain('if d.get("schema") != "sr_imagefirst_request_v1": rej("REQ_SCHEMA")');
    expect(src).toContain('re.fullmatch(r"[a-z0-9_-]{2,41}", s, re.ASCII)');
    expect(src).toContain('if d.get("kind") not in ("real_shop", "fictional"): rej("REQ_KIND")');
    const setup = readFileSync(join(SCRIPTS, "imagefirst-autorun-setup.sh"), "utf8");
    for (const [k, v] of [["MAX_PER_DAY", 4], ["MAX_PER_WEEK", 20], ["MAX_POLICY_DAYS", 90]] as const) {
      expect(src, k).toMatch(new RegExp(`^${k}=${v}$`, "m"));
      expect(setup, k).toMatch(new RegExp(`^${k}=${v}$`, "m"));
    }
    // root never opens a worker file itself: every read of a request is the worker's (setpriv) into root's work file
    const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/(cat|head|<)\s*"?\$WORKER_HOME\/sr-runs\/requests/);
    expect(code.match(/sr-runs\/requests\/\$1\.json/g)).toHaveLength(1);
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
    expect(code.match(/bash "\$PILOT" [^\n]*/g)).toEqual(['bash "$PILOT" --autorun-request "$APPROVAL" "$ADMIN_SHA" "$ORIGIN" "$REQ_SHA"', 'bash "$PILOT" --autorun "$APPROVAL" "$ADMIN_SHA" "$ORIGIN"']);
    // PR #325 CI / re-review: after a stop signal the pilot's own exit status is always collected: wait while it runs, then
    // once more (bash returns the saved status on every later wait), never a loop keyed on the status itself
    const step = /\nstep\(\) \{\n[\s\S]*?\n\}\n/.exec(src(AUTORUN))![0].split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(step).toMatch(/\n\s*wait "\$CPID"\n\s*STEP_RC=\$\?\n\s*while kill -0 "\$CPID" 2>\/dev\/null; do\n\s*wait "\$CPID"\n\s*STEP_RC=\$\?\n\s*done\n\s*wait "\$CPID"\n\s*STEP_RC=\$\?\n/);
    expect(step).not.toMatch(/STEP_RC" -gt 128/);
    // the pilot's result is its result file, read after the step; never a line taken from its stdout
    expect(code).not.toMatch(/grep -a '\^IMAGEFIRST_PILOT /);
    expect(code).toMatch(/\nRESULT="\$STATE\/autorun-result"\nrm -f -- "\$RESULT" "\$STATE"\/\.autorun-result\.\* "\$STATE\/autorun-clone" "\$STATE\/autorun-commit"\nif \[ "\$KIND" = request \]; then\n {2}step "\$WORK\/pilot" /);
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
    // DEV-303: only the owner's installed copy (never the admin clone)
    expect(service).toMatch(/^ExecStart=\/usr\/bin\/bash \/usr\/local\/lib\/sr-imagefirst\/scripts\/sales-design-worker\/imagefirst-autorun\.sh$/m);
    // review M2: ExecStopPost without the unit's sandboxing ("+"), still in the unit's cgroup
    expect(service).toMatch(/^ExecStopPost=\+\/usr\/bin\/bash \/usr\/local\/lib\/sr-imagefirst\/scripts\/sales-design-worker\/imagefirst-autorun\.sh --restore$/m);
    expect(service).not.toMatch(/sr-capture-admin\/scripts/);
    // review L3 / L-a: never together with the old automatic start's timer; never Conflicts= with its service (that would
    // stop a running worker in the middle of a generation)
    expect(service).toMatch(/^Conflicts=sr-imagefirst-autostart\.timer$/m);
    expect(service).not.toMatch(/^Conflicts=.*sr-imagefirst-autostart\.service/m);
    expect(service).not.toMatch(/^User=/m);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^KillMode=mixed$/m);
    expect(service).toMatch(/^SuccessExitStatus=10 11 12$/m);
    const num = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(src(AUTORUN))![1]);
    const start = Number(/^TimeoutStartSec=(\d+)$/m.exec(service)![1]);
    const stop = Number(/^TimeoutStopSec=(\d+)$/m.exec(service)![1]);
    const admin = num("ADMIN_TIMEOUT") + num("KILL_AFTER");
    // one ls-remote; the request reads (the names, then per name a read and a notice, each cut at REQ_READ_TIMEOUT + 5 s)
    const reads = (1 + 2 * num("REQ_MAX_NAMES")) * (num("REQ_READ_TIMEOUT") + 5);
    expect(start).toBeGreaterThan(2 * admin + (num("ADMIN_FETCH_TIMEOUT") + num("KILL_AFTER")) + reads + num("IDLE_WAIT") + num("PILOT_TIMEOUT") + num("PILOT_KILL_AFTER"));
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
