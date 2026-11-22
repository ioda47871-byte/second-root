import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { exe, ID, PILOT, PREFLIGHT, SCRIPTS } from "./pilot-world";
import { cleanupTemps, commitFiles, git, sha, tmp } from "./support";

// Issue #302: the owner's bundled one-time setup (scripts/sales-design-worker/imagefirst-autorun-setup.sh), the real file,
// against a fake WSL under SR_IMAGEFIRST_SETUP_TEST_ROOT: a temporary /usr, /etc, /var/lib, /root and /home; a stand-in for
// root's admin clone (a clone of a temporary bare origin, detached); an npm stub (at the test root's /usr/bin/npm) that writes
// a fake package tree with package.json versions; systemctl / systemd-run stubs that log every call. No root, no systemd,
// no network, no npm registry, no model CLI.

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanupTemps, 60_000);
const SETUP = join(SCRIPTS, "imagefirst-autorun-setup.sh");
const CODEX_CONFIG_REPO = join(SCRIPTS, "codex-config.toml");
const UNIT_SRC = join(SCRIPTS, "systemd");
const UNITS = ["sr-imagefirst-autorun.service", "sr-imagefirst-autorun.timer"];
const PKG = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" } as const;
const VER = { claude: "2.1.295", codex: "0.159.0" } as const;

function world() {
  const base = tmp("sr-ifs-");
  const R = join(base, "R");
  const sc = join(base, "sc");
  const bin = join(base, "bin");
  const home = join(R, "home", "sr-designgen");
  for (const d of [sc, bin, join(R, "usr", "bin"), join(R, "usr", "local", "bin"), join(R, "usr", "local", "lib"), join(R, "etc", "systemd", "system"), join(R, "var", "lib"), join(R, "root"), join(home, ".npm-global", "bin"), join(home, ".local", "bin")]) mkdirSync(d, { recursive: true });
  // the machine as it is today: root's symlinks /usr/local/bin/{claude,codex} into the worker's home
  const oldTargets = { claude: join(home, ".npm-global", "bin", "claude"), codex: join(home, ".local", "bin", "codex") };
  for (const [name, target] of Object.entries(oldTargets)) {
    writeFileSync(target, `#!/bin/sh\necho ${name} must never run >> '${sc}/model-cli.log'\nexit 97\n`, { mode: 0o755 });
    symlinkSync(target, join(R, "usr", "local", "bin", name));
  }
  // root's node (never executed: a placeholder) and the npm stub
  writeFileSync(join(R, "usr", "bin", "node"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  exe(
    join(R, "usr", "bin", "npm"),
    `echo "npm $* HOME=$HOME umask=$(umask) env=$(env | cut -d= -f1 | LC_ALL=C sort | tr '\\n' ,)" >> '${sc}/npm.log'
[ -f '${sc}/npm-fail' ] && exit 1
cmd="$1"; shift; prefix=""; pkgs=()
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2 ;; --userconfig|--globalconfig) shift 2 ;; -*) shift ;; *) pkgs+=("$1"); shift ;; esac; done
for spec in "\${pkgs[@]}"; do
  if [ "$cmd" = install ]; then name="\${spec%@*}"; ver="\${spec##*@}"; [ -f '${sc}/npm-version' ] && ver="$(cat '${sc}/npm-version')"; else name="$spec"; fi
  case "$name" in @anthropic-ai/claude-code) b=claude; rel=cli.js ;; @openai/codex) b=codex; rel=bin/codex.js ;; *) exit 2 ;; esac
  d="$prefix/lib/node_modules/$name"
  if [ "$cmd" = install ]; then
    # as npm: an entry of another package in the way is an error (EEXIST)
    if [ -e "$prefix/bin/$b" ] || [ -L "$prefix/bin/$b" ]; then case "$(readlink -f "$prefix/bin/$b")" in "$d"/*) ;; *) echo "EEXIST $prefix/bin/$b" >&2; exit 1 ;; esac; fi
    mkdir -p "$d/bin"; printf '{"name":"%s","version":"%s"}\\n' "$name" "$ver" > "$d/package.json"
    printf '#!/usr/bin/env node\\n' > "$d/$rel"; chmod 755 "$d/$rel"; ln -sfn "../lib/node_modules/$name/$rel" "$prefix/bin/$b"
  else rm -rf "$d"; rm -f "$prefix/bin/$b"; fi
done`,
  );
  exe(
    join(bin, "systemctl"),
    `echo "$*" >> '${sc}/systemctl.log'; u="\${@: -1}"
case "$1" in
  show) f='${sc}'/"$3-$u"; if [ -f "$f" ]; then cat "$f"; exit 0; fi
    case "$3" in ActiveState) echo inactive ;; LoadState) if [ -f '${R}/etc/systemd/system/'"$u" ]; then echo loaded; else echo not-found; fi ;; NeedDaemonReload) echo no ;; *) echo ;; esac ;;
  is-enabled) if [ -f '${sc}'/enabled-"$u" ]; then cat '${sc}'/enabled-"$u"; [ "$(cat '${sc}'/enabled-"$u")" = enabled ]; exit; fi
    if [ -f '${R}/etc/systemd/system/'"$u" ]; then echo disabled; else echo not-found; fi; exit 1 ;;
  enable) [ -f '${sc}/enable-fail' ] && exit 1; echo enabled > '${sc}'/enabled-"$u" ;;
  disable) echo disabled > '${sc}'/enabled-"$u"; echo inactive > '${sc}'/ActiveState-"$u" ;;
  daemon-reload) ;;
  list-timers) echo "Sun 2026-11-22 10:10:00 UTC 4min left - - $u sr-imagefirst-autorun.service" ;;
  *) exit 1 ;;
esac`,
  );
  exe(
    join(bin, "systemd-run"),
    `echo "$*" >> '${sc}/systemd-run.log'
if [ -f '${sc}/hardening-fail' ]; then echo "admin.sh: line 12: /root/x: Read-only file system"; exit 1; fi
printf 'drwx------ sr-designgen:sr-designgen /home/sr-designgen\\napproved: none\\nnode: none\\njail: enabled / active\\njail network rules:\\n'`,
  );
  // origin and root's admin clone, detached at origin's develop
  const src = tmp("sr-ifs-src-");
  git(src, "init", "-q", "-b", "develop");
  commitFiles(src, { "README.md": Buffer.from("x\n") }, "init (test)");
  const origin = join(base, "origin.git");
  git(base, "init", "-q", "--bare", origin);
  git(src, "push", "-q", origin, "HEAD:refs/heads/develop");
  const admin = join(R, "root", "sr-capture-admin");
  git(base, "clone", "-q", "--branch", "develop", origin, admin);
  git(admin, "checkout", "-q", "--detach", "origin/develop");
  const head = git(admin, "rev-parse", "HEAD");
  const state = join(R, "var", "lib", "sr-imagefirst-autostart");
  const etc = join(R, "etc", "sr-design-worker");
  const env = { PATH: [bin, "/usr/local/bin", "/usr/bin", "/bin"].join(":"), SR_IMAGEFIRST_SETUP_TEST_ROOT: R } as unknown as NodeJS.ProcessEnv;
  const run = (args: string[]) => {
    const r = spawnSync("bash", [SETUP, ...args], { env, encoding: "utf8", timeout: 100_000 });
    const last = r.stdout.trim().split("\n").pop() ?? "";
    const m = /^IMAGEFIRST_SETUP (\S+) exit=(\d+)$/.exec(last);
    expect(m, r.stdout + r.stderr).not.toBeNull();
    expect(Number(m![2]), r.stdout + r.stderr).toBe(r.status);
    expect(existsSync(join(sc, "model-cli.log")), "a claude / codex binary was started").toBe(false);
    const steps: Record<string, { state: string; why: string }> = {};
    for (const x of r.stdout.matchAll(/^SETUP_STEP (\S+) (DONE|TODO|BLOCKED) (.*)$/gm)) steps[x[1]!] = { state: x[2]!, why: x[3]! };
    return { status: r.status, code: m![1]!, stdout: r.stdout, steps };
  };
  const lines = (f: string) => (existsSync(join(sc, f)) ? readFileSync(join(sc, f), "utf8").trim().split("\n").filter(Boolean) : []);
  /** Every path under the test root: type, mode, size, mtime, link target, content hash. */
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        const s = lstatSync(p);
        const k = p.slice(R.length);
        if (s.isSymbolicLink()) out[k] = `link ${readlinkSync(p)}`;
        else if (s.isDirectory()) { out[k] = `dir ${s.mode.toString(8)} ${s.mtimeMs}`; walk(p); }
        else out[k] = `file ${s.mode.toString(8)} ${s.size} ${s.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
      }
    };
    walk(R);
    return out;
  };
  const allDone = (steps: Record<string, { state: string }>) => Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.state]));
  return { base, R, sc, bin, home, admin, origin, src, head, state, etc, oldTargets, run, lines, snapshot, allDone };
}
type World = ReturnType<typeof world>;
const DONE4 = { cli: "DONE", codex_config: "DONE", units: "DONE", hardening_check: "DONE" };
const apply = (w: World) => w.run(["apply", "--yes", "--expect", w.head]);

describe("Issue #302 one-time setup: check is read-only", () => {
  it("on today's machine: every step TODO, CHECK_OK, nothing written anywhere, only systemctl show / is-enabled", () => {
    const w = world();
    const before = w.snapshot();
    const r = w.run(["check", "--expect", w.head]);
    expect(r).toMatchObject({ status: 0, code: "CHECK_OK" });
    expect(w.allDone(r.steps)).toEqual({ cli: "TODO", codex_config: "TODO", units: "TODO", hardening_check: "TODO" });
    expect(r.steps.cli!.why).toContain(`claude: /usr/local/bin/claude -> ${w.oldTargets.claude}`);
    expect(r.stdout).toContain(`codex-config.toml SHA-256 ${sha(readFileSync(CODEX_CONFIG_REPO))}`);
    expect(w.snapshot()).toEqual(before);
    expect(existsSync(w.state)).toBe(false);
    for (const l of w.lines("systemctl.log")) expect(l).toMatch(/^(show -p \S+ --value|is-enabled) \S+$/);
    expect(w.lines("npm.log")).toEqual([]);
    expect(w.lines("systemd-run.log")).toEqual([]);
    // the default mode is check
    expect(w.run(["--expect", w.head])).toMatchObject({ status: 0, code: "CHECK_OK" });
    expect(w.snapshot()).toEqual(before);
  });
});

describe("Issue #302 one-time setup: refusals (nothing changed)", () => {
  it("usage, no --yes, no / malformed --expect, a check with --yes, an unknown mode", () => {
    const w = world();
    const before = w.snapshot();
    expect(w.run(["apply", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["enable-timer", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["rollback", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_NEEDS_YES" });
    expect(w.run(["apply", "--yes"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["rollback", "--yes"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["check"])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["apply", "--yes", "--expect", w.head.slice(0, 12)])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["apply", "--yes", "--expect", w.head.toUpperCase()])).toMatchObject({ status: 2, code: "SETUP_EXPECT_REQUIRED" });
    expect(w.run(["check", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.run(["install", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.run(["apply", "--yes", "--expect", w.head, "--force"])).toMatchObject({ status: 2, code: "SETUP_USAGE" });
    expect(w.snapshot()).toEqual(before);
    expect(w.lines("npm.log")).toEqual([]);
  });

  it("a wrong --expect, develop moved on, a dirty or attached admin clone", () => {
    const w = world();
    const before = w.snapshot();
    expect(w.run(["apply", "--yes", "--expect", "a".repeat(40)])).toMatchObject({ status: 2, code: "SETUP_ADMIN_NOT_EXPECTED" });
    // develop moved on: the admin clone still at the old commit, which is no longer origin's develop
    commitFiles(w.src, { "docs/x.md": Buffer.from("x") }, "merged (test)");
    git(w.src, "push", "-q", w.origin, "HEAD:refs/heads/develop");
    const moved = w.run(["apply", "--yes", "--expect", w.head]);
    expect(moved).toMatchObject({ status: 2, code: "SETUP_EXPECT_NOT_DEVELOP" });
    expect(w.run(["check", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_EXPECT_NOT_DEVELOP" });
    git(w.src, "push", "-q", "--force", w.origin, `${w.head}:refs/heads/develop`);
    writeFileSync(join(w.admin, "stray.txt"), "x");
    expect(w.run(["apply", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_ADMIN_CLONE_DIRTY" });
    expect(w.run(["check", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_ADMIN_CLONE_DIRTY" });
    rmSync(join(w.admin, "stray.txt"));
    git(w.admin, "checkout", "-q", "-B", "develop");
    expect(w.run(["apply", "--yes", "--expect", w.head])).toMatchObject({ status: 2, code: "SETUP_ADMIN_NOT_DETACHED" });
    git(w.admin, "checkout", "-q", "--detach");
    git(w.admin, "branch", "-q", "-D", "develop");
    expect(w.run(["check", "--expect", w.head])).toMatchObject({ status: 0, code: "CHECK_OK" });
    const after = w.snapshot();
    // only the admin clone changed (the test's stray file, checkout -B / branch -D), nothing the setup owns
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!k.startsWith("/root/sr-capture-admin")) expect(after[k], k).toBe(before[k]);
    expect(w.lines("npm.log")).toEqual([]);
    expect(w.lines("systemd-run.log")).toEqual([]);
  });

  it("an unexpected /usr/local/bin/claude (a link elsewhere, a regular file, a link with ..): BLOCKED, nothing touched", () => {
    const w = world();
    const slot = join(w.R, "usr", "local", "bin", "claude");
    mkdirSync(join(w.R, "opt"));
    writeFileSync(join(w.R, "opt", "claude"), "x", { mode: 0o755 });
    const variants: [string, () => void][] = [
      ["a link outside the worker's home", () => symlinkSync(join(w.R, "opt", "claude"), slot)],
      ["a regular file", () => writeFileSync(slot, "x", { mode: 0o755 })],
      ["a link through ..", () => symlinkSync(join(w.home, "..", "..", "opt", "claude"), slot)],
    ];
    for (const [what, make] of variants) {
      rmSync(slot, { force: true });
      make();
      const before = w.snapshot();
      const c = w.run(["check", "--expect", w.head]);
      expect(c, what).toMatchObject({ status: 3, code: "CHECK_BLOCKED" });
      expect(c.steps.cli!.state, what).toBe("BLOCKED");
      const a = apply(w);
      expect(a, what).toMatchObject({ status: 3, code: "SETUP_BLOCKED" });
      expect(w.snapshot(), what).toEqual(before);
    }
    expect(w.lines("npm.log")).toEqual([]);
    expect(w.lines("systemd-run.log")).toEqual([]);
    expect(w.lines("systemctl.log").filter((l) => !/^(show|is-enabled) /.test(l))).toEqual([]);
  });
});

describe("Issue #302 one-time setup: apply", () => {
  it("installs the pinned CLIs root-owned, the config, the units and the switch; runs check 1; never enables the timer; idempotent", () => {
    const w = world();
    // the old hourly automatic start is installed and enabled: apply disables it
    writeFileSync(join(w.sc, "LoadState-sr-imagefirst-autostart.timer"), "loaded");
    writeFileSync(join(w.sc, "enabled-sr-imagefirst-autostart.timer"), "enabled");
    const r = apply(w);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.allDone(r.steps)).toEqual(DONE4);
    // npm: once, root's prefix, no user / global config, HOME=/root, umask 022, a clean environment
    const npm = w.lines("npm.log");
    expect(npm).toHaveLength(1);
    expect(npm[0]).toContain(`npm install -g --prefix ${w.R}/usr/local --userconfig /dev/null --globalconfig /dev/null --no-audit --no-fund --loglevel=error ${PKG.claude}@${VER.claude} ${PKG.codex}@${VER.codex} HOME=${w.R}/root umask=0022 `);
    expect(npm[0]).toMatch(/ env=HOME,LANG,PATH,(PWD,)?(SHLVL,)?(_,)?$/);
    for (const name of ["claude", "codex"] as const) {
      const real = realpathSync(join(w.R, "usr", "local", "bin", name));
      expect(real.startsWith(join(w.R, "usr", "local", "lib", "node_modules", PKG[name]) + "/"), real).toBe(true);
      expect(JSON.parse(readFileSync(join(w.R, "usr", "local", "lib", "node_modules", PKG[name], "package.json"), "utf8"))).toEqual({ name: PKG[name], version: VER[name] });
      // the worker's own CLIs are untouched
      expect(readFileSync(w.oldTargets[name], "utf8")).toContain("must never run");
    }
    // the reviewed Codex config, the units, the switch
    expect(sha(readFileSync(join(w.etc, "codex-config.toml")))).toBe(sha(readFileSync(CODEX_CONFIG_REPO)));
    expect(statSync(join(w.etc, "codex-config.toml")).mode & 0o777).toBe(0o644);
    expect(statSync(w.etc).mode & 0o777).toBe(0o755);
    for (const u of UNITS) {
      expect(readFileSync(join(w.R, "etc", "systemd", "system", u))).toEqual(readFileSync(join(UNIT_SRC, u)));
      expect(statSync(join(w.R, "etc", "systemd", "system", u)).mode & 0o777).toBe(0o644);
    }
    expect(JSON.parse(readFileSync(join(w.etc, "imagefirst-autostart.json"), "utf8"))).toEqual({ enabled: true });
    expect(statSync(join(w.etc, "imagefirst-autostart.json")).mode & 0o777).toBe(0o644);
    // systemctl: the old timer disabled, daemon-reload, and never an enable
    const scl = w.lines("systemctl.log");
    expect(scl).toContain("disable --now sr-imagefirst-autostart.timer");
    expect(scl).toContain("daemon-reload");
    expect(scl.filter((l) => l.startsWith("enable"))).toEqual([]);
    expect(existsSync(join(w.sc, "enabled-sr-imagefirst-autorun.timer"))).toBe(false);
    // check 1: once, with the unit's hardening, admin.sh status
    const hr = w.lines("systemd-run.log");
    expect(hr).toHaveLength(1);
    expect(hr[0]).toMatch(/^--wait --pipe --collect -p ProtectSystem=strict .* \/usr\/bin\/bash \S+\/scripts\/sales-design-capture\/admin\.sh status$/);
    // root's log: 0600 in a 0700 state dir, with what the old links pointed to
    expect(statSync(w.state).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.state, "setup.log")).mode & 0o777).toBe(0o600);
    const log = readFileSync(join(w.state, "setup.log"), "utf8");
    expect(log).toContain(`apply OLD_LINK claude -> ${w.oldTargets.claude}\n`);
    expect(log).toContain(`apply OLD_LINK codex -> ${w.oldTargets.codex}\n`);
    expect(r.stdout).toContain("The timer is NOT enabled");

    // a second apply: every step DONE, nothing run again
    const before = w.snapshot();
    const again = apply(w);
    expect(again).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.allDone(again.steps)).toEqual(DONE4);
    expect(again.stdout).toContain("nothing to do");
    expect(w.lines("npm.log")).toHaveLength(1);
    expect(w.lines("systemd-run.log")).toHaveLength(1);
    expect(w.lines("systemctl.log").filter((l) => !/^(show|is-enabled) /.test(l))).toEqual(["disable --now sr-imagefirst-autostart.timer", "daemon-reload"]);
    // only the log (and its lock) moved
    const after = w.snapshot();
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!/^\/var\/lib\/sr-imagefirst-autostart(\/setup\.(log|lock))?$/.test(k)) expect(after[k], k).toBe(before[k]);
    const c = w.run(["check", "--expect", w.head]);
    expect(c).toMatchObject({ status: 0, code: "CHECK_OK" });
    expect(w.allDone(c.steps)).toEqual(DONE4);
  });

  it("keeps an owner's existing switch (enabled:false) and replaces a wrong-version package", () => {
    const w = world();
    mkdirSync(w.etc, { mode: 0o755 });
    writeFileSync(join(w.etc, "imagefirst-autostart.json"), '{"enabled": false}\n', { mode: 0o644 });
    writeFileSync(join(w.sc, "npm-version"), "2.0.0");
    const first = apply(w);
    expect(first).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(first.stdout).toContain("is not the pinned 2.1.295");
    expect(first.stdout).toContain("rollback --yes --expect");
    rmSync(join(w.sc, "npm-version"));
    const c = w.run(["check", "--expect", w.head]);
    expect(c.steps.cli!.state).toBe("TODO");
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(readFileSync(join(w.etc, "imagefirst-autostart.json"), "utf8")).toBe('{"enabled": false}\n');
    // the old links were recorded once (the first apply) and the log still says where they pointed
    const log = readFileSync(join(w.state, "setup.log"), "utf8");
    expect(log.match(/OLD_LINK claude/g)).toHaveLength(1);
  });

  it("a hardening failure stops before anything further: no recorded pass, the timer off, enable-timer refused", () => {
    const w = world();
    writeFileSync(join(w.sc, "hardening-fail"), "");
    const r = apply(w);
    expect(r).toMatchObject({ status: 33, code: "SETUP_HARDENING_FAILED" });
    expect(r.stdout).toContain("Read-only file system");
    expect(r.stdout).toContain(`rollback --yes --expect ${w.head}`);
    expect(r.stdout).not.toContain("after apply:");
    expect(existsSync(join(w.state, "setup-hardening.ok"))).toBe(false);
    expect(w.lines("systemctl.log").filter((l) => l.startsWith("enable"))).toEqual([]);
    const t = w.run(["enable-timer", "--yes", "--expect", w.head]);
    expect(t).toMatchObject({ status: 4, code: "TIMER_NOT_READY" });
    expect(t.steps.hardening_check!.state).toBe("TODO");
    expect(w.lines("systemctl.log").filter((l) => l.startsWith("enable"))).toEqual([]);
    // fixed: only check 1 runs again
    rmSync(join(w.sc, "hardening-fail"));
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.lines("npm.log")).toHaveLength(1);
    expect(w.lines("systemd-run.log")).toHaveLength(2);
  });
});

describe("Issue #302 one-time setup: enable-timer and rollback", () => {
  it("enable-timer refuses unless every step is DONE, then enables the timer once and prints its list-timers line", () => {
    const w = world();
    expect(w.run(["enable-timer", "--yes", "--expect", w.head])).toMatchObject({ status: 4, code: "TIMER_NOT_READY" });
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    const t = w.run(["enable-timer", "--yes", "--expect", w.head]);
    expect(t).toMatchObject({ status: 0, code: "TIMER_ENABLED" });
    expect(t.stdout).toMatch(/list-timers: .*sr-imagefirst-autorun\.timer sr-imagefirst-autorun\.service/);
    expect(w.lines("systemctl.log").filter((l) => l.startsWith("enable"))).toEqual(["enable --now sr-imagefirst-autorun.timer"]);
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toContain("enable-timer systemctl enable --now sr-imagefirst-autorun.timer");
  });

  it("rollback restores the old links exactly, removes what apply added, and never touches used/, autorun/ or the switch", () => {
    const w = world();
    expect(apply(w)).toMatchObject({ status: 0, code: "APPLY_OK" });
    expect(w.run(["enable-timer", "--yes", "--expect", w.head])).toMatchObject({ status: 0, code: "TIMER_ENABLED" });
    for (const d of ["used", "autorun"]) {
      mkdirSync(join(w.state, d, ID), { recursive: true, mode: 0o700 });
      writeFileSync(join(w.state, d, ID, "commit"), "c\n");
    }
    // rollback does not ask for develop: it works after develop moved on
    commitFiles(w.src, { "docs/x.md": Buffer.from("x") }, "merged (test)");
    git(w.src, "push", "-q", w.origin, "HEAD:refs/heads/develop");
    const r = w.run(["rollback", "--yes", "--expect", w.head]);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    for (const name of ["claude", "codex"] as const) {
      expect(readlinkSync(join(w.R, "usr", "local", "bin", name))).toBe(w.oldTargets[name]);
      expect(existsSync(join(w.R, "usr", "local", "lib", "node_modules", PKG[name]))).toBe(false);
    }
    for (const u of UNITS) expect(existsSync(join(w.R, "etc", "systemd", "system", u))).toBe(false);
    expect(existsSync(join(w.etc, "codex-config.toml"))).toBe(false);
    expect(existsSync(join(w.state, "setup-hardening.ok"))).toBe(false);
    expect(existsSync(join(w.etc, "imagefirst-autostart.json"))).toBe(true);
    for (const d of ["used", "autorun"]) expect(readFileSync(join(w.state, d, ID, "commit"), "utf8")).toBe("c\n");
    const scl = w.lines("systemctl.log");
    expect(scl).toContain("disable --now sr-imagefirst-autorun.timer");
    expect(w.lines("npm.log").pop()).toContain(`npm uninstall -g --prefix ${w.R}/usr/local --userconfig /dev/null --globalconfig /dev/null --no-audit --no-fund --loglevel=error ${PKG.claude} ${PKG.codex} HOME=${w.R}/root umask=0022 `);
    expect(readFileSync(join(w.state, "setup.log"), "utf8")).toContain(`rollback restored ${w.R}/usr/local/bin/claude -> ${w.oldTargets.claude}`);
  });

  it("rollback after a failed npm install restores the links; a gone target is not restored; a running service refuses", () => {
    const w = world();
    writeFileSync(join(w.sc, "npm-fail"), "");
    const a = apply(w);
    expect(a).toMatchObject({ status: 30, code: "SETUP_CLI_FAILED" });
    expect(existsSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(false);
    rmSync(w.oldTargets.codex);
    writeFileSync(join(w.sc, "ActiveState-sr-imagefirst-autorun.service"), "activating");
    expect(w.run(["rollback", "--yes", "--expect", w.head])).toMatchObject({ status: 3, code: "SETUP_BLOCKED" });
    expect(existsSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(false);
    rmSync(join(w.sc, "ActiveState-sr-imagefirst-autorun.service"));
    const r = w.run(["rollback", "--yes", "--expect", w.head]);
    expect(r).toMatchObject({ status: 0, code: "ROLLBACK_DONE" });
    expect(readlinkSync(join(w.R, "usr", "local", "bin", "claude"))).toBe(w.oldTargets.claude);
    expect(existsSync(join(w.R, "usr", "local", "bin", "codex"))).toBe(false);
    expect(r.stdout).toContain("no longer exists: not restored");
  });
});

describe("Issue #302 one-time setup: pinned values", () => {
  it("the codex-config SHA-256 is the one the pilot and its preflight pin (read from them), and the repository's file", () => {
    const want = sha(readFileSync(CODEX_CONFIG_REPO));
    for (const f of [PILOT, PREFLIGHT]) expect(new RegExp(`^CODEX_CONFIG_SHA256=${want}$`, "m").test(readFileSync(f, "utf8")), f).toBe(true);
    const script = readFileSync(SETUP, "utf8");
    // no copy of its own: it reads the pilot's and the preflight's
    expect(script).not.toMatch(/[0-9a-f]{64}/);
    expect(script).toContain("imagefirst-pilot-preflight.sh imagefirst-pilot.sh");
    const w = world();
    expect(w.run(["check", "--expect", w.head]).stdout).toContain(`codex-config.toml SHA-256 ${want}`);
  });

  it("check 1's hardening properties are the service unit's", () => {
    const unit = readFileSync(join(UNIT_SRC, "sr-imagefirst-autorun.service"), "utf8");
    const script = readFileSync(SETUP, "utf8");
    const props = [...script.matchAll(/-p "?([A-Za-z]+=[^"\n]*?)"?(?= -p|\)|\n|$)/g)].map((m) => m[1]!.trim());
    expect(props.length).toBeGreaterThanOrEqual(10);
    for (const p of props) {
      const [k, v] = p.split("=", 2) as [string, string];
      const line = new RegExp(`^${k}=(.*)$`, "m").exec(unit)?.[1];
      expect(line, p).toBeDefined();
      // ReadWritePaths: the unit also allows cycle.sh's optional lock dir
      if (k === "ReadWritePaths") expect(line!.split(" ")).toContain(v);
      else expect(line, p).toBe(v);
    }
  });

  it("the production copy refuses a test hook (the guard is in the file)", () => {
    const script = readFileSync(SETUP, "utf8");
    expect(script).toContain('[ -z "$TEST_ROOT" ] || { say "SETUP_TEST_HOOK_REFUSED');
    expect(script).toContain('[ "$(id -u)" = 0 ] ||');
  });
});
