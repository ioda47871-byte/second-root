import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// scripts/sales-design-capture/rc-diagnose.sh (docs/operations/remote-control-resilience.md): the owner's READ-ONLY
// diagnostic of why the jailed Remote Control disconnects. The real script runs against a fake WSL under
// SR_RC_DIAGNOSE_TEST_ROOT: systemctl and journalctl are stubs that answer from fixtures and log every call, /proc is a
// fixture tree, id / getent answer for the requester, and every command that could change something or run as the
// requester (tmux, sudo, runuser, setpriv, su, pkill, pgrep, systemd-run, loginctl, claude, codex) is a logging stub
// that must never run. No root, no systemd, no network, no model.
const DIR = join(__dirname, "../../../scripts/sales-design-capture");
const SCRIPT = join(DIR, "rc-diagnose.sh");
const TEXT = readFileSync(SCRIPT, "utf8");
const ADMIN = readFileSync(join(DIR, "admin.sh"), "utf8");
const HOST_CHECK = readFileSync(join(DIR, "host-check.sh"), "utf8");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const NOW = Math.floor(Date.parse("2026-11-21T06:00:30Z") / 1000);
const H = 3600;
const D = 24 * H;
const UID = 1001;
const CANARY = "CANARY-SECRET-7f3a91";
const SESSION = "cse_CANARYSESSION0123456789";
const FORBIDDEN = ["tmux", "sudo", "runuser", "setpriv", "su", "pkill", "pgrep", "systemd-run", "loginctl", "claude", "codex", "kill", "nsenter", "machinectl"];
const JAIL = "/system.slice/sr-jail-claude.service";

type Proc = { comm: string; argv: string[]; cgroup?: string; uid?: number; start?: number; /** where /proc/<pid>/cwd points */ cwd?: string; /** index in procs of its parent (PPid) */ parent?: number };
type World = {
  /** systemctl show answers per unit (key=value); a unit not listed is LoadState=not-found */
  units?: Record<string, Record<string, string>>;
  /** journal lines per unit, as [epoch, text] */
  journals?: Record<string, Array<[number, string]>>;
  boots?: Array<{ index: number; first: number; last: number }>;
  uptime?: number;
  procs?: Proc[];
  showFail?: boolean;
  journalFail?: boolean;
  noProc?: boolean;
  shell?: string;
  /** seconds since Remote Control's resume pointer was written; undefined = no pointer */
  pointerAge?: number;
};
/** The project key the CLI derives from /home/sr-designgen/work/second-root (never printed). */
const POINTER_KEY = "-home-sr-designgen-work-second-root";

const WORKDIR = "/home/sr-designgen/work/second-root";
const RC_ARGV = ["node", "/home/sr-designgen/.npm-global/bin/claude", "remote-control"];
const activeUnit = (since: number, extra: Record<string, string> = {}) => ({
  LoadState: "loaded",
  ActiveState: "active",
  SubState: "running",
  Result: "success",
  NRestarts: "0",
  ExecMainStartTimestamp: `@${since}`,
  ActiveEnterTimestamp: `@${since}`,
  UnitFileState: "enabled",
  KillMode: "control-group",
  WantedBy: "multi-user.target",
  ...extra,
});
/** A WSL that has run for two days, Claude started with the boot three hours ago (today's unit as admin.sh writes it). */
function healthy(): World {
  return {
    units: {
      "sr-jail-claude.service": activeUnit(NOW - 3 * H),
      "sr-jail-net.service": activeUnit(NOW - 3 * H),
    },
    journals: {
      "sr-jail-claude.service": [
        [NOW - 3 * H - 5, "host systemd[1]: Starting sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)..."],
        [NOW - 3 * H - 2, "host python3[812]: JAIL_OK"],
        [NOW - 3 * H, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
      ],
      "sr-jail-net.service": [[NOW - 3 * H - 10, "host systemd[1]: Started sr-jail-net.service - Requester jail network (pasta)."]],
    },
    boots: [
      { index: -1, first: NOW - 10 * D, last: NOW - 2 * D - 600 },
      { index: 0, first: NOW - 2 * D, last: NOW },
    ],
    uptime: 2 * D,
    pointerAge: 3 * H - 60,
    procs: [
      { comm: "tmux: server", argv: ["tmux: server (/home/sr-designgen/.sr-claude.tmux)"], start: NOW - 3 * H },
      { comm: "bash", argv: ["bash", "-c", "cd ~/work/second-root && exec claude remote-control"], start: NOW - 3 * H },
      { comm: "node", argv: RC_ARGV, start: NOW - 3 * H + 1, cwd: WORKDIR },
      { comm: "sshd", argv: ["sshd: someone"], uid: 1000, cgroup: "/system.slice/ssh.service" },
    ],
  };
}

const exe = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = lstatSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${p} ${s.size} ${s.mtimeMs} ${s.mode}`);
    }
  };
  walk(dir);
  return out;
}

function run(world: World, args: string[] = []) {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "sr-rcd-")));
  roots.push(t);
  const r = join(t, "root");
  const bin = join(t, "bin");
  const log = join(t, "log");
  const tmp = join(t, "tmp");
  for (const d of [r, bin, log, tmp]) mkdirSync(d, { recursive: true });
  const sc = join(t, "sc");
  mkdirSync(sc);
  writeFileSync(join(r, "clock"), `${NOW}\n`);
  // systemctl: `show` answers from sc/show-<unit>; any other verb is logged as a mutation and fails
  for (const [unit, keys] of Object.entries(world.units ?? {})) {
    writeFileSync(join(sc, `show-${unit}`), Object.entries(keys).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  }
  if (world.showFail) writeFileSync(join(sc, "show-fail"), "");
  exe(
    join(bin, "systemctl"),
    `printf '%s\\n' "$*" >> '${log}/systemctl.log'; u="\${@: -1}"
case "$1" in
  show) [ -f '${sc}/show-fail' ] && exit 1; if [ -f '${sc}'/show-"$u" ]; then cat '${sc}'/show-"$u"; else printf 'LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nUnitFileState=\\n'; fi ;;
  *) printf '%s\\n' "$*" >> '${log}/mutation.log'; exit 1 ;;
esac`,
  );
  for (const [unit, lines] of Object.entries(world.journals ?? {})) {
    writeFileSync(join(sc, `journal-${unit}`), lines.map(([e, l]) => `${e}.123456 ${l}`).join("\n") + (lines.length ? "\n" : ""));
  }
  if (world.boots) {
    writeFileSync(
      join(sc, "boots.json"),
      JSON.stringify(world.boots.map((b) => ({ index: b.index, boot_id: `bootid${String(b.index).replace("-", "m")}CANARYBOOT`, first_entry: b.first * 1e6, last_entry: b.last * 1e6 }))) + "\n",
    );
  }
  if (world.journalFail) writeFileSync(join(sc, "journal-fail"), "");
  exe(
    join(bin, "journalctl"),
    `printf '%s\\n' "$*" >> '${log}/journalctl.log'
[ -f '${sc}/journal-fail' ] && exit 1
for a in "$@"; do case "$a" in --vacuum* | --rotate | --flush | --sync | --relinquish-var | --setup-keys | --update-catalog) printf '%s\\n' "$*" >> '${log}/mutation.log'; exit 1 ;; esac; done
case " $* " in *" --list-boots "*) [ -f '${sc}/boots.json' ] && cat '${sc}/boots.json' || exit 1; exit 0 ;; esac
# every -u given: their journals, merged in time order
prev=""; for a in "$@"; do [ "$prev" = -u ] && [ -f '${sc}'/journal-"$a" ] && cat '${sc}'/journal-"$a"; prev="$a"; done | sort -n -s -k1,1; exit 0`,
  );
  exe(join(bin, "id"), `if [ "$1" = -u ] && [ "$2" = sr-designgen ]; then echo ${UID}; exit 0; fi; [ "$1" = -u ] && [ -n "$2" ] && exit 1; exec /usr/bin/id "$@"`);
  exe(join(bin, "getent"), `[ "$1 $2" = "passwd sr-designgen" ] && { echo "sr-designgen:x:${UID}:${UID}::/home/sr-designgen:${world.shell ?? "/usr/sbin/nologin"}"; exit 0; }; exit 2`);
  for (const name of FORBIDDEN) exe(join(bin, name), `printf '%s %s\\n' "${name}" "$*" >> '${log}/forbidden.log'; exit 97`);
  // /proc
  if (!world.noProc) {
    const proc = join(r, "proc");
    mkdirSync(proc);
    const up = world.uptime ?? 2 * D;
    const btime = NOW - up;
    writeFileSync(join(proc, "uptime"), `${up}.42 ${up * 3}.10\n`);
    writeFileSync(join(proc, "stat"), `cpu  1 2 3 4\nbtime ${btime}\nprocesses 1234\n`);
    (world.procs ?? []).forEach((p, i) => {
      const pid = 200 + i;
      const d = join(proc, String(pid));
      mkdirSync(d);
      const uid = p.uid ?? UID;
      writeFileSync(join(d, "status"), `Name:\t${p.comm.slice(0, 15)}\nPPid:\t${p.parent === undefined ? 1 : 200 + p.parent}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\nGroups:\t${uid}\n`);
      writeFileSync(join(d, "cgroup"), `0::${p.cgroup ?? JAIL}\n`);
      writeFileSync(join(d, "comm"), `${p.comm.slice(0, 15)}\n`);
      writeFileSync(join(d, "cmdline"), p.argv.join("\0") + "\0");
      if (p.cwd) symlinkSync(p.cwd, join(d, "cwd"));
      const ticks = ((p.start ?? NOW - H) - btime) * 100;
      writeFileSync(join(d, "stat"), `${pid} (${p.comm.slice(0, 15)}) S 1 ${pid} ${pid} 0 -1 4194560 ${"0 ".repeat(12)}${ticks} 12345 678\n`);
    });
  }
  // the requester's home: Claude's and Codex's sign-in and session files. The sign-in files are FIFOs: opening one
  // for reading would block until the test's timeout; the session file holds a canary that must never be printed.
  const home = join(r, "home", "sr-designgen");
  for (const d of [".claude", ".codex", join(".claude", "projects")]) mkdirSync(join(home, d), { recursive: true });
  for (const f of [join(".claude", ".credentials.json"), join(".codex", "auth.json")]) {
    expect(spawnSync("mkfifo", [join(home, f)]).status).toBe(0);
  }
  writeFileSync(join(home, ".claude", "projects", "session.jsonl"), `{"sessionId":"${SESSION}","secret":"${CANARY}"}\n`);
  // Remote Control's resume pointer: a FIFO too (stat only; opening it would block), with the mtime asked for
  if (world.pointerAge !== undefined) {
    const dir = join(home, ".claude", "projects", POINTER_KEY);
    mkdirSync(dir, { recursive: true });
    const pointer = join(dir, "bridge-pointer.json");
    expect(spawnSync("mkfifo", [pointer]).status).toBe(0);
    utimesSync(pointer, NOW - world.pointerAge, NOW - world.pointerAge);
  }
  const before = snapshot(r);
  // a file made and removed in TMPDIR (bash backs a here-string over 64 KiB with one) still changes its mtime
  utimesSync(tmp, 1_000_000_000, 1_000_000_000);
  const res = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, SR_RC_DIAGNOSE_TEST_ROOT: r, TMPDIR: tmp, LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv,
  });
  const read = (n: string) => {
    try {
      return readFileSync(join(log, n), "utf8");
    } catch {
      return "";
    }
  };
  const out = `${res.stdout}${res.stderr}`;
  const last = out.trim().split("\n").at(-1) ?? "";
  const m = /^RC_DIAGNOSE (\S+) codes=(\S+)$/.exec(last);
  return {
    code: res.status,
    signal: res.signal,
    out,
    last,
    primary: m?.[1],
    codes: (m?.[2] ?? "").split(","),
    t,
    r,
    systemctl: read("systemctl.log"),
    journalctl: read("journalctl.log"),
    mutation: read("mutation.log"),
    forbidden: read("forbidden.log"),
    unchanged: JSON.stringify(snapshot(r)) === JSON.stringify(before),
    tmpEmpty: readdirSync(tmp).length === 0 && statSync(tmp).mtimeMs === 1_000_000_000_000,
  };
}

/** Every run: read only, nothing as the requester, no secret, no path, no session id, exit 0. */
function expectSafe(res: ReturnType<typeof run>) {
  expect(res.signal, res.out).toBeNull();
  expect(res.code, res.out).toBe(0);
  expect(res.mutation).toBe("");
  expect(res.forbidden).toBe("");
  expect(res.unchanged).toBe(true);
  expect(res.tmpEmpty).toBe(true);
  for (const line of res.systemctl.trim().split("\n").filter(Boolean)) expect(line).toMatch(/^show /);
  for (const bad of [CANARY, SESSION, "CANARYBOOT", res.t, "/home", "/root", "/tmp", "remote-control\0", "npm-global", "second-root", "bridge-pointer", "projects", POINTER_KEY]) {
    expect(res.out, bad).not.toContain(bad);
  }
  for (const line of res.out.trim().split("\n")) expect(line, line).not.toMatch(/(^|[\s=])\/[A-Za-z]/);
}

describe("rc-diagnose.sh: each cause", () => {
  it("a stable machine: no Linux cause, plain restore, the resume window open", () => {
    const res = run(healthy());
    expectSafe(res);
    expect(res.primary).toBe("RC_NO_LINUX_CAUSE_FOUND");
    expect(res.codes).toEqual(["RC_RESUME_WINDOW_OPEN"]);
    for (const line of [
      "RC_UNIT_ACTIVE=active/running",
      "RC_UNIT_FILE=enabled",
      "RC_UNIT_KILLMODE=control-group",
      "RC_PROCESSES=1",
      "RC_PROC_UNIT=sr-jail-claude.service",
      "RC_PROC_STARTED_WITH_UNIT=yes",
      "RC_MODE=server",
      "RC_ARGV_RESTORE=plain",
      "RC_ARGV_CREATE_SESSION_IN_DIR=default",
      "RC_PROC_CWD=expected",
      "RC_BRIDGE_POINTER_SINCE_PROC_START=yes",
      "OTHER_USER_CLAUDE_PROCS=0",
      "RC_UNIT_EXITS_7D=0",
      "RC_EXITS_AFTER_NETWORK_ERROR_7D=0",
      "RC_ARGV_NAME=no",
      "RC_ARGV_CONTINUE=no",
      "RC_ARGV_SESSION_ID=no",
      "RC_ARGV_SPAWN=default",
      "RC_UNIT_WANTED_BY_MULTI_USER=yes",
      "RC_BRIDGE_POINTER=present",
      "RC_BRIDGE_POINTER_AGE=lt4h",
      "RC_BRIDGE_POINTER_AGE_MIN=179",
      "RC_TMUX_SERVERS=1",
      "RC_TMUX_UNIT=sr-jail-claude.service",
      "RC_UNIT_OTHER_PROCS=0",
      "REQUESTER_OUTSIDE_JAIL_PROCS=0",
      "WSL_BOOTS_LISTED=2",
      "WSL_BOOT_AGE_MIN=2880",
      "RC_UNIT_STARTS_THIS_BOOT=1",
      "RC_SERVERS=1",
      "RC_PROC_STARTED=2026-11-21T03:00Z",
    ]) {
      expect(res.out).toContain(`rc-diagnose: ${line}\n`);
    }
    // times are rounded to the minute
    expect(res.out).not.toMatch(/T\d\d:\d\d:\d\d/);
    expect(res.out).toContain("rc-diagnose: PILOT_UNIT sr-imagefirst-autostart.timer load=not-found");
    expect(res.out).toContain("wsl -l -v");
    expect(res.out).toContain("Get-Content $env:USERPROFILE\\.wslconfig");
  });

  it("WSL_RESTARTED_RECENTLY: the VM came back 30 minutes ago, and when it was down", () => {
    const w = healthy();
    w.boots = [
      { index: -2, first: NOW - 5 * D, last: NOW - 3 * D },
      { index: -1, first: NOW - 3 * D + 3600, last: NOW - 2 * H },
      { index: 0, first: NOW - 30 * 60, last: NOW },
    ];
    w.uptime = 30 * 60 + 20;
    w.units!["sr-jail-claude.service"] = activeUnit(NOW - 29 * 60);
    w.procs![2]!.start = NOW - 29 * 60;
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("WSL_RESTARTED_RECENTLY");
    expect(res.codes).not.toContain("WSL_DISTRO_RESTARTED_VM_KEPT");
    expect(res.out).toContain("rc-diagnose: WSL_BOOTS_7D=3\n");
    expect(res.out).toContain("rc-diagnose: WSL_BOOT at=2026-11-21T05:30Z down_before_min=90\n");
  });

  it("WSL_DISTRO_RESTARTED_VM_KEPT: the distro is younger than the VM (wsl --terminate)", () => {
    const w = healthy();
    w.boots = [
      { index: -1, first: NOW - 2 * D, last: NOW - H },
      { index: 0, first: NOW - 50 * 60, last: NOW },
    ];
    w.uptime = 2 * D;
    const res = run(w);
    expectSafe(res);
    expect(res.codes).toEqual(expect.arrayContaining(["WSL_RESTARTED_RECENTLY", "WSL_DISTRO_RESTARTED_VM_KEPT"]));
  });

  it("WSL_JOURNAL_ONE_BOOT: a journal with only this boot cannot count restarts", () => {
    const w = healthy();
    w.boots = [{ index: 0, first: NOW - 20 * 60, last: NOW }];
    const res = run(w);
    expectSafe(res);
    expect(res.codes).toContain("WSL_JOURNAL_ONE_BOOT");
    expect(res.codes).not.toContain("WSL_RESTARTED_RECENTLY");
  });

  it("RC_UNIT_RESTARTS: Claude exited and systemd started it again inside the boot", () => {
    const w = healthy();
    const j = w.journals!["sr-jail-claude.service"]!;
    for (const ago of [2 * H, 80 * 60, 20 * 60]) {
      j.push([NOW - ago - 60, "host systemd[1]: sr-jail-claude.service: Deactivated successfully."]);
      j.push([NOW - ago - 1, "host systemd[1]: sr-jail-claude.service: Scheduled restart job, restart counter is at 1."]);
      j.push([NOW - ago, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."]);
    }
    w.units!["sr-jail-claude.service"] = activeUnit(NOW - 20 * 60, { NRestarts: "3" });
    w.procs![2]!.start = NOW - 20 * 60;
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("RC_UNIT_RESTARTS");
    expect(res.out).toContain("rc-diagnose: RC_UNIT_RESTARTS=3\n");
    expect(res.out).toContain("rc-diagnose: RC_UNIT_NRESTARTS=3\n");
    expect(res.out).toContain("rc-diagnose: RC_UNIT_EXITED_CLEANLY_7D=3\n");
    expect(res.out).toContain("rc-diagnose: RC_UNIT_LAST_START=2026-11-21T05:40Z\n");
  });

  it("RC_UNIT_STOPPED_BY_OWNER: claude-stop (the pilot's exclusion) leaves it disabled; the pilot units are shown", () => {
    const w = healthy();
    w.units!["sr-jail-claude.service"] = { ...activeUnit(0), ActiveState: "inactive", SubState: "dead", UnitFileState: "disabled", ActiveEnterTimestamp: "", ExecMainStartTimestamp: "", WantedBy: "" };
    w.units!["sr-imagefirst-autostart.service"] = { LoadState: "loaded", ActiveState: "inactive", SubState: "dead", UnitFileState: "disabled" };
    w.procs = [];
    w.journals!["sr-jail-claude.service"]!.push([NOW - H, "host systemd[1]: Stopped sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."]);
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("RC_UNIT_STOPPED_BY_OWNER");
    expect(res.out).toContain("rc-diagnose: RC_UNIT_STOPS_7D=1\n");
    expect(res.out).toContain("rc-diagnose: RC_PROCESSES=0\n");
    expect(res.codes).not.toContain("RC_PROC_MISSING");
    expect(res.out).toContain("rc-diagnose: PILOT_UNIT sr-imagefirst-autostart.service load=loaded active=inactive file=disabled\n");
    expect(res.out).toContain("rc-diagnose: RC_UNIT_WANTED_BY_MULTI_USER=no\n");
  });

  it("the resume pointer: absent, inside the 4 h window, or past it (stat only; never opened, path and key never printed)", () => {
    const none = run({ ...healthy(), pointerAge: undefined });
    expectSafe(none);
    expect(none.out).toContain("rc-diagnose: RC_BRIDGE_POINTER=absent\n");
    expect(none.codes).toContain("RC_NO_RESUME_POINTER");
    const fresh = run({ ...healthy(), pointerAge: 4 * H - 60 });
    expectSafe(fresh);
    expect(fresh.codes).toContain("RC_RESUME_WINDOW_OPEN");
    expect(fresh.out).toContain("rc-diagnose: RC_BRIDGE_POINTER_AGE=lt4h\n");
    // overnight: WSL was shut down for 10 h and nothing has run since
    const w = healthy();
    w.units!["sr-jail-claude.service"] = { ...activeUnit(0), ActiveState: "inactive", SubState: "dead", UnitFileState: "disabled", ActiveEnterTimestamp: "", WantedBy: "" };
    w.procs = [];
    w.pointerAge = 10 * H;
    const old = run(w);
    expectSafe(old);
    expect(old.codes).toContain("RC_RESUME_WINDOW_EXPIRED");
    expect(old.out).toContain("rc-diagnose: RC_BRIDGE_POINTER_AGE=gt4h\n");
    expect(old.out).toContain("rc-diagnose: RC_BRIDGE_POINTER_AGE_MIN=600\n");
  });

  it("RC_UNIT_START_LIMIT: systemd gave up (10 starts an hour), from the unit's result or its journal", () => {
    const w = healthy();
    w.units!["sr-jail-claude.service"] = { ...activeUnit(0), ActiveState: "failed", SubState: "failed", Result: "start-limit-hit", ActiveEnterTimestamp: "" };
    w.procs = [];
    expect(run(w).primary).toBe("RC_UNIT_START_LIMIT");
    const w2 = healthy();
    w2.journals!["sr-jail-claude.service"]!.push([NOW - 2 * H, "host systemd[1]: sr-jail-claude.service: Start request repeated too quickly."]);
    const res = run(w2);
    expectSafe(res);
    expect(res.primary).toBe("RC_UNIT_START_LIMIT");
    expect(res.codes.filter((c) => c === "RC_UNIT_START_LIMIT")).toHaveLength(1);
  });

  it("RC_UNIT_PROBE_FAILED: the jail's probe refused a start", () => {
    const w = healthy();
    w.journals!["sr-jail-claude.service"]!.push([NOW - 2 * H, "host python3[9]: JAIL_UNSAFE DNS_RULES_NOT_EXACT"]);
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("RC_UNIT_PROBE_FAILED");
    expect(res.out).not.toContain("DNS_RULES_NOT_EXACT");
  });

  it("RC_NET_RESTARTS: the net unit was restarted (BindsTo restarts Claude with it)", () => {
    const w = healthy();
    w.journals!["sr-jail-net.service"]!.push([NOW - 2 * H, "host systemd[1]: Started sr-jail-net.service - Requester jail network (pasta)."]);
    w.journals!["sr-jail-net.service"]!.push([NOW - H, "host systemd[1]: Started sr-jail-net.service - Requester jail network (pasta)."]);
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("RC_NET_RESTARTS");
    expect(res.out).toContain("rc-diagnose: RC_NET_RESTARTS=2\n");
  });

  it("RC_PROC_MISSING: the unit is active but no `claude remote-control` runs", () => {
    const w = healthy();
    w.procs = w.procs!.filter((p) => p.argv !== RC_ARGV);
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("RC_PROC_MISSING");
  });

  it("the mode, the restore option, spawn and create-session flags are reported (option names only; the argv is never printed)", () => {
    for (const [argv, flags] of [
      [[...RC_ARGV, "--continue", "--name", CANARY], "MODE=server ARGV_RESTORE=continue ARGV_CONTINUE=yes ARGV_SESSION_ID=no ARGV_NAME=yes ARGV_SPAWN=default"],
      [[...RC_ARGV, "--session-id", SESSION], "MODE=server ARGV_RESTORE=session-id ARGV_CONTINUE=no ARGV_SESSION_ID=yes ARGV_NAME=no"],
      [["claude", "rc", `--name=${CANARY}`, "-c", "--spawn=session"], "MODE=server ARGV_RESTORE=continue ARGV_NAME=yes ARGV_SPAWN=session"],
      [[...RC_ARGV, "--spawn", "worktree"], "MODE=server ARGV_RESTORE=plain ARGV_SPAWN=worktree"],
      [["claude", "--remote-control"], "MODE=interactive ARGV_RESTORE=plain ARGV_NAME=no"],
      [["claude", `--remote-control=${CANARY}`], "MODE=interactive ARGV_NAME=yes"],
    ] as const) {
      const w = healthy();
      w.procs![2] = { comm: "claude", argv: [...argv], start: NOW - 3 * H, cwd: WORKDIR };
      const res = run(w);
      expectSafe(res);
      for (const f of flags.split(" ")) expect(res.out).toContain(`rc-diagnose: RC_${f}\n`);
      expect(res.primary).toBe("RC_NO_LINUX_CAUSE_FOUND");
    }
    // "rc" counts only right after the program; a claude without Remote Control is not a server
    const w = healthy();
    w.procs![2] = { comm: "claude", argv: ["claude", "--name", "rc"], start: NOW - 3 * H };
    expect(run(w).primary).toBe("RC_PROC_MISSING");
  });

  it("(e) RC_NO_CREATE_SESSION_IN_DIR, RC_MULTIPLE_SERVERS and RC_PROC_CWD_UNEXPECTED: setups in which a stop archives or misses the sessions", () => {
    const a = healthy();
    a.procs![2]!.argv = [...RC_ARGV, "--no-create-session-in-dir"];
    const ra = run(a);
    expectSafe(ra);
    expect(ra.primary).toBe("RC_NO_CREATE_SESSION_IN_DIR");
    expect(ra.out).toContain("rc-diagnose: RC_ARGV_CREATE_SESSION_IN_DIR=off\n");
    const b = healthy();
    b.procs!.push({ comm: "node", argv: RC_ARGV, start: NOW - H, cwd: WORKDIR });
    const rb = run(b);
    expectSafe(rb);
    expect(rb.primary).toBe("RC_MULTIPLE_SERVERS");
    expect(rb.out).toContain("rc-diagnose: RC_MULTIPLE_SERVERS=2\n");
    const c = healthy();
    c.procs![2]!.cwd = "/home/sr-designgen";
    const rc = run(c);
    expectSafe(rc);
    expect(rc.primary).toBe("RC_PROC_CWD_UNEXPECTED");
    expect(rc.out).toContain("rc-diagnose: RC_PROC_CWD=other\n");
  });

  it("(a) RC_EXIT_AFTER_NETWORK_LOSS: the server exited after network errors (e.g. Windows sleep) and systemd started it again", () => {
    const w = healthy();
    w.journals!["systemd-resolved.service"] = [[NOW - 2 * H - 700, "host systemd-resolved[300]: Using degraded feature set for DNS server CANARYDNS: Network is unreachable"]];
    w.journals!["sr-jail-claude.service"]!.push(
      [NOW - 2 * H, "host systemd[1]: sr-jail-claude.service: Deactivated successfully."],
      [NOW - 2 * H + 1, "host systemd[1]: sr-jail-claude.service: Main process exited, code=exited, status=0/SUCCESS"],
      [NOW - 2 * H + 60, "host systemd[1]: sr-jail-claude.service: Scheduled restart job, restart counter is at 1."],
      [NOW - 2 * H + 61, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
      // a later exit with no network error before it is not counted
      [NOW - H, "host systemd[1]: sr-jail-claude.service: Deactivated successfully."],
      [NOW - H + 60, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
    );
    w.units!["sr-jail-claude.service"] = activeUnit(NOW - H + 60, { NRestarts: "2" });
    w.procs![2]!.start = NOW - H + 61;
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("RC_EXIT_AFTER_NETWORK_LOSS");
    for (const line of ["RC_EXIT_AFTER_NETWORK_LOSS=1", "RC_EXITS_AFTER_NETWORK_ERROR_7D=1", "RC_NETWORK_ERROR_LINES_7D=1", "RC_UNIT_EXITS_7D=2", "RC_LAST_EXIT_TO_START_MIN=1"]) {
      expect(res.out).toContain(`rc-diagnose: ${line}\n`);
    }
    expect(res.out).not.toContain("CANARYDNS");
    expect(res.codes).not.toContain("RC_STOP_GAP_OVER_4H");
  });

  it("(b) RC_STOP_GAP_OVER_4H: from the unit's exit to its next start, or from the last boot's end to this boot", () => {
    const w = healthy();
    w.journals!["sr-jail-claude.service"]!.push(
      [NOW - 9 * H, "host systemd[1]: Stopped sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
      [NOW - 2 * H, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
    );
    w.journals!["sr-jail-claude.service"]!.sort((x, y) => x[0] - y[0]);
    const res = run(w);
    expectSafe(res);
    expect(res.primary).toBe("RC_STOP_GAP_OVER_4H");
    expect(res.out).toContain("rc-diagnose: RC_STOP_GAP_OVER_4H=360\n");
    // overnight: WSL was off for 10 h (no stop line in the journal, the VM just ended)
    const o = healthy();
    o.boots = [
      { index: -1, first: NOW - 3 * D, last: NOW - 12 * H },
      { index: 0, first: NOW - 2 * H, last: NOW },
    ];
    o.uptime = 2 * H;
    const ro = run(o);
    expectSafe(ro);
    expect(ro.primary).toBe("RC_STOP_GAP_OVER_4H");
    expect(ro.codes).toContain("WSL_RESTARTED_RECENTLY");
  });

  it("(f) a Claude of another user (e.g. a Claude Desktop WSL-local session) is counted, never described", () => {
    const w = healthy();
    w.procs!.push({ comm: "claude", argv: ["/home/someone/.local/bin/claude", "--remote-control", CANARY], uid: 1000, cgroup: "/user.slice/user-1000.slice/session-2.scope" });
    const res = run(w);
    expectSafe(res);
    expect(res.out).toContain("rc-diagnose: OTHER_USER_CLAUDE_PROCS=1\n");
    expect(res.out).toContain("rc-diagnose: OTHER_USER_RC_PROCS=1\n");
    expect(res.codes).toContain("OTHER_USER_CLAUDE_RUNNING");
    expect(res.out).toContain("Claude Desktop");
    expect(res.out).not.toContain("someone");
  });

  it("RC_PROC_YOUNGER_THAN_UNIT and RC_UNIT_JOBS_AT_RISK: a job inside the unit dies with a restart (KillMode=control-group)", () => {
    const w = healthy();
    w.procs![2]!.start = NOW - H;
    w.procs!.push({ comm: "node", argv: ["node", "scripts/sales-design-worker/imagefirst-worker.ts", "--approval", CANARY] });
    w.procs!.push({ comm: "chrome", argv: ["/opt/chrome/chrome", "--headless"] });
    const res = run(w);
    expectSafe(res);
    expect(res.codes).toEqual(expect.arrayContaining(["RC_PROC_YOUNGER_THAN_UNIT", "RC_UNIT_JOBS_AT_RISK"]));
    expect(res.out).toContain("rc-diagnose: RC_UNIT_JOBS_AT_RISK=2\n");
    expect(res.out).not.toContain("imagefirst-worker");
  });

  it("processes of the requester outside the jail are reported by unit (host-check.sh's own check gives the code)", () => {
    const w = healthy();
    w.procs!.push({ comm: "node", argv: ["node", "imagefirst-worker.ts"], cgroup: "/system.slice/sr-imagefirst-autostart.service" });
    w.procs!.push({ comm: "bash", argv: ["bash"], cgroup: "/user.slice/user-1000.slice/session-3.scope" });
    const res = run(w);
    expectSafe(res);
    expect(res.codes).toContain("REQUESTER_OUTSIDE_JAIL");
    expect(res.out).toContain("rc-diagnose: REQUESTER_OUTSIDE_JAIL_PROCS=2\n");
    expect(res.out).toContain("rc-diagnose: REQUESTER_OUTSIDE_JAIL_UNIT sr-imagefirst-autostart.service=1\n");
    expect(res.out).toContain("rc-diagnose: REQUESTER_OUTSIDE_JAIL_UNIT other=1\n");
    expect(run({ ...healthy(), shell: "/bin/bash" }).codes).toContain("REQUESTER_HAS_LOGIN_SHELL");
  });

  it("nothing readable: every check reads as UNREADABLE and it still exits 0", () => {
    const res = run({ showFail: true, journalFail: true, noProc: true });
    expectSafe(res);
    expect(res.primary).toBe("RC_DIAGNOSE_UNREADABLE");
    expect(res.codes).toEqual(expect.arrayContaining(["WSL_BOOTS_UNREADABLE", "WSL_UPTIME_UNREADABLE", "RC_UNIT_UNREADABLE", "RC_NET_UNREADABLE", "RC_JOURNAL_UNREADABLE", "RC_PROC_UNREADABLE"]));
    expect(res.out).toContain("rc-diagnose: PILOT_UNIT sr-design-cycle.service UNREADABLE\n");
  });

  it("journals over 64 KiB are streamed: no temporary file in TMPDIR (the check itself is proven on a here-string)", () => {
    // the control: a here-string over 64 KiB makes bash create and remove a file in TMPDIR, which changes its mtime
    const ctl = realpathSync(mkdtempSync(join(tmpdir(), "sr-rcd-ctl-")));
    roots.push(ctl);
    utimesSync(ctl, 1_000_000_000, 1_000_000_000);
    spawnSync("bash", ["-c", 'x=$(head -c 100000 /dev/zero | tr "\\0" a); cat <<<"$x" >/dev/null'], { env: { PATH: "/usr/bin:/bin", TMPDIR: ctl } as unknown as NodeJS.ProcessEnv });
    expect(statSync(ctl).mtimeMs).not.toBe(1_000_000_000_000);
    // the diagnostic over large journals (~600 KiB of resolved lines, ~200 KiB of probe lines in the unit)
    const w = healthy();
    const filler = "x".repeat(90);
    w.journals!["systemd-resolved.service"] = Array.from({ length: 6000 }, (_, i) => [NOW - 6 * D + i * 60, `host systemd-resolved[300]: Using DNS server ${filler} ${i}`] as [number, string]);
    w.journals!["systemd-resolved.service"]!.push([NOW - 2 * H - 600, "host systemd-resolved[300]: Network is unreachable"]);
    w.journals!["systemd-resolved.service"]!.sort((x, y) => x[0] - y[0]);
    const unit = w.journals!["sr-jail-claude.service"]!;
    for (let i = 0; i < 2000; i++) unit.push([NOW - 5 * D + i * 60, `host python3[812]: JAIL_OK ${filler}`]);
    unit.push([NOW - 2 * H, "host systemd[1]: sr-jail-claude.service: Deactivated successfully."], [NOW - 2 * H + 60, "host systemd[1]: sr-jail-claude.service: Scheduled restart job, restart counter is at 1."], [NOW - 2 * H + 61, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."]);
    unit.sort((x, y) => x[0] - y[0]);
    const res = run(w);
    expectSafe(res);
    expect(res.out).toContain("rc-diagnose: RC_NETWORK_ERROR_LINES_7D=1\n");
    expect(res.out).toContain("rc-diagnose: RC_EXIT_AFTER_NETWORK_LOSS=1\n");
    expect(res.out).toContain("rc-diagnose: RC_UNIT_RESTARTS=1\n");
  });

  it("RC_UNIT_RESTARTS counts systemd's automatic restarts in this boot only: not a person's stop / start, not an earlier boot", () => {
    const w = healthy();
    w.journals!["sr-jail-claude.service"]!.push(
      // an automatic restart in the previous boot
      [NOW - 3 * D, "host systemd[1]: sr-jail-claude.service: Scheduled restart job, restart counter is at 1."],
      [NOW - 3 * D + 1, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
      // claude-stop / claude-start in this boot
      [NOW - 2 * H, "host systemd[1]: Stopped sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
      [NOW - H, "host systemd[1]: Started sr-jail-claude.service - Claude Code Remote Control (sr-designgen, jailed)."],
    );
    w.journals!["sr-jail-claude.service"]!.sort((x, y) => x[0] - y[0]);
    const res = run(w);
    expectSafe(res);
    expect(res.codes).not.toContain("RC_UNIT_RESTARTS");
    for (const line of ["RC_UNIT_AUTO_RESTARTS_7D=1", "RC_UNIT_AUTO_RESTARTS_THIS_BOOT=0", "RC_UNIT_STOPS_THIS_BOOT=1", "RC_UNIT_STARTS_THIS_BOOT=2", "RC_LAST_EXIT_TO_START_MIN=60"]) {
      expect(res.out).toContain(`rc-diagnose: ${line}\n`);
    }
  });

  it("Claude is recognised by its program only: Playwright's cli.js, `grep claude` and `tmux -s claude` are not Claude; `--rc` is interactive", () => {
    const w = healthy();
    w.procs!.push({ comm: "node", argv: ["node", "/home/sr-designgen/work/second-root/node_modules/playwright/cli.js", "test"] });
    w.procs!.push({ comm: "grep", argv: ["grep", "claude", "notes.txt"], uid: 1000, cgroup: "/user.slice/user-1000.slice/session-2.scope" });
    w.procs!.push({ comm: "tmux", argv: ["tmux", "attach", "-t", "claude"], uid: 1000, cgroup: "/user.slice/user-1000.slice/session-2.scope" });
    const res = run(w);
    expectSafe(res);
    expect(res.out).toContain("rc-diagnose: RC_UNIT_OTHER_PROCS=1\n"); // the Playwright run is a job at risk
    expect(res.out).toContain("rc-diagnose: OTHER_USER_CLAUDE_PROCS=0\n");
    for (const argv of [["claude", "--rc"], ["claude", `--rc=${CANARY}`], ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "--remote-control"]]) {
      const v = healthy();
      v.procs![2] = { comm: argv[0]!, argv, start: NOW - 3 * H, cwd: WORKDIR };
      const r = run(v);
      expectSafe(r);
      expect(r.out).toContain("rc-diagnose: RC_MODE=interactive\n");
    }
  });

  it("RC_MULTIPLE_SERVERS counts servers, not their child processes (a Remote Control process whose parent is one)", () => {
    const w = healthy();
    w.procs!.push({ comm: "node", argv: [...RC_ARGV], start: NOW - H, parent: 2 });
    const res = run(w);
    expectSafe(res);
    expect(res.out).toContain("rc-diagnose: RC_PROCESSES=2\n");
    expect(res.out).toContain("rc-diagnose: RC_SERVERS=1\n");
    expect(res.codes).not.toContain("RC_MULTIPLE_SERVERS");
  });

  it("no value of any parsed option is ever printed (a canary in each)", () => {
    for (const extra of [
      [`--spawn=${CANARY}`],
      ["--spawn", CANARY],
      ["--name", CANARY],
      [`--name=${CANARY}`],
      ["--session-id", CANARY],
      [`--session-id=${CANARY}`],
      ["--continue", CANARY],
      ["--no-create-session-in-dir", CANARY],
      ["--capacity", CANARY],
      [CANARY],
    ]) {
      const w = healthy();
      w.procs![2]!.argv = [...RC_ARGV, ...extra];
      const res = run(w);
      expectSafe(res);
      if (extra[0]!.startsWith("--spawn")) expect(res.out).toContain("rc-diagnose: RC_ARGV_SPAWN=other\n");
    }
    for (const argv of [["claude", `--remote-control=${CANARY}`], ["claude", `--rc=${CANARY}`], ["claude", "--remote-control", CANARY]]) {
      const w = healthy();
      w.procs![2] = { comm: "claude", argv, start: NOW - 3 * H, cwd: `/home/${CANARY}` };
      expectSafe(run(w));
    }
  });

  it("usage: any argument is refused with exit 2; a copy outside the admin clone needs the test root", () => {
    const res = run(healthy(), ["--fix"]);
    expect(res.code).toBe(2);
    expect(res.last).toBe("RC_DIAGNOSE RC_DIAGNOSE_USAGE codes=RC_DIAGNOSE_USAGE");
    expect(res.systemctl).toBe("");
    const bare = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
    expect(bare.status).toBe(2);
    expect(bare.stdout).toContain("run from the root-only clone");
  });
});

describe("rc-diagnose.sh: read only and secret-free by construction", () => {
  const code = TEXT.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  // the commands only: quoted strings (messages, patterns) removed
  const commands = code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");

  it("asks systemd only `show`, the journal only to read, and runs nothing as the requester", () => {
    const calls = code.match(/\bsystemctl\b[^\n|;)]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/^systemctl show /);
    for (const verb of ["start", "stop", "restart", "enable", "disable", "mask", "kill", "reset-failed", "daemon-reload", "reload"]) {
      expect(code).not.toMatch(new RegExp(`systemctl[^\\n]*\\b${verb}\\b`));
    }
    expect(code).not.toMatch(/--vacuum|--rotate|--flush/);
    for (const cmd of ["tmux", "sudo", "runuser", "setpriv", "su ", "pkill", "pgrep", "systemd-run", "loginctl", "nsenter", "mktemp", "mkdir", "rm ", "tee", "touch"]) {
      expect(commands, cmd).not.toMatch(new RegExp(`(^|[\\s;|&(])${cmd.trim()}\\b`, "m"));
    }
    // no redirection into a file (only /dev/null and here-strings)
    expect(commands.replace(/\$\(\([^)]*\)\)/g, "0").match(/>\s*(?!\/dev\/null|&)[^\s>&]/g) ?? []).toEqual([]);
  });

  it("never names the requester's sign-in, session or key files (nor does host-check.sh, which it sources)", () => {
    expect(HOST_CHECK).not.toMatch(/\.claude\b|\.codex\b|auth\.json|credential|\.npmrc|\.git-credentials|\.ssh\b|token/i);
    // the one place in the requester's Claude state: the resume pointer's path, then only `stat` and an unset
    const lines = code.split("\n");
    const named = lines.filter((l) => /\.claude\b/.test(l));
    expect(named).toEqual(['  pointer="$R$home/.claude/projects/$key/bridge-pointer.json"']);
    const uses = lines.filter((l) => /\$pointer\b|\bpointer\b/.test(l) && !l.includes('pointer="$R$home'));
    expect(uses).toEqual(['  if mtime="$(stat -c %Y -- "$pointer" 2>/dev/null)" && [[ "$mtime" =~ ^[0-9]+$ ]]; then', "unset home key pointer mtime"]);
    expect(code).not.toMatch(/\.codex\b|auth\.json|credential|\.npmrc|\.git-credentials|\.ssh\b|token/i);
  });

  it("reuses admin.sh: the same unit names, root-only clone and trusted_path; host-check.sh's jail check", () => {
    for (const line of ["JAIL_CLAUDE=sr-jail-claude.service", "JAIL_NET=sr-jail-net.service", "ROOT_CLONE=/root/sr-capture-admin"]) {
      expect(ADMIN).toContain(line);
      expect(TEXT).toContain(line);
    }
    const fn = (s: string) => /trusted_path\(\) \{[\s\S]*?\n\}\n/.exec(s)?.[0];
    expect(fn(TEXT)).toBeDefined();
    expect(fn(TEXT)).toBe(fn(ADMIN));
    expect(TEXT).toContain('. "$SELF_DIR/host-check.sh"');
    expect(TEXT).toContain('sr_check_requester_jailed "$REQ"');
    // the production copy refuses the test hook and checks itself and host-check.sh before sourcing it
    expect(TEXT).toContain("RC_DIAGNOSE_TEST_HOOK_REFUSED");
    expect(TEXT.indexOf('trusted_path "$f"')).toBeLessThan(TEXT.indexOf('. "$SELF_DIR/host-check.sh"'));
    // this PR does not change how admin.sh writes the unit (that is the follow-up after the owner's approval)
    expect(ADMIN).toContain('exec claude remote-control\\""');
  });
});
