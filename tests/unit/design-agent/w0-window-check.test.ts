import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// DEV-090: W-0, the read-only window check before A-3's D-0 / D-2 and the passt update's V-0 / V-2
// (docs/operations/passt-update-plan.md §5.0). The human pastes the block from the plan, so this test runs exactly
// that block, taken from the doc, with stand-ins for sudo, systemctl, pgrep, ps and flock. Nothing here starts,
// stops or changes a unit, a namespace or a lock on this machine.
const REPO = join(__dirname, "../../..");
const PLAN = readFileSync(join(REPO, "docs/operations/passt-update-plan.md"), "utf8");
const block = (name: string): string => {
  const m = new RegExp(`<!-- ${name}:BEGIN -->\\n\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\`\\n<!-- ${name}:END -->`).exec(PLAN);
  expect(m, name).not.toBeNull();
  return m![1]!;
};
const W0 = block("W0");
const FACTS = block("W0-FACTS");
const LOCK = "/var/lib/sr-design-cycle/cycle.lock";
const LINGER = "/var/lib/systemd/linger";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const CAPTURE_RUN = "/home/sr-igcapture/second-root/scripts/sales-design-capture/run.sh";
// one command as `systemctl show` (v255) prints it: the plain property and its Ex twin with the flags
const cmd = (key: string, path: string, args: string[] = [], flags = ""): string[] => {
  const argv = [path, ...args].join(" ");
  const tail = "start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }";
  return [
    `${key}={ path=${path} ; argv[]=${argv} ; ignore_errors=${flags.includes("ignore-failure") ? "yes" : "no"} ; ${tail}`,
    `${key}Ex={ path=${path} ; argv[]=${argv} ; flags=${flags} ; ${tail}`,
  ];
};

type Timer = {
  name: string;
  next: number | null; // seconds from now; null = no next run
  service: string;
  enabled?: string; // UnitFileState
  unitFile?: boolean; // listed by list-unit-files (sr-* only)
  loaded?: boolean; // listed by list-timers
  frag?: string; // the timer's FragmentPath
  drop?: string; // the timer's DropInPaths
  svcFrag?: string;
  svcDrop?: string;
  svc: string[]; // the service's other `systemctl show` lines
  svcActive?: string;
};
type World = {
  timers: Timer[];
  timersJson?: string; // overrides the list-timers output
  timersRc?: number;
  unitFilesRaw?: string;
  unitFilesRc?: number;
  units: string[];
  pgrepFRc?: number; // pgrep -f (worker / PoC / Codex): 0 found, 1 none, 2 error
  pgrepRc?: number; // pgrep -u sr-designgen (all): default 0 with pids, 1 without
  pids: string[];
  ps: string[];
  psRc?: number;
  linger?: string[];
  lock: "free" | "held" | "none";
};

const capture = (o: { user?: string; netns?: string; exec?: string; args?: string[]; flags?: string; extra?: string[] } = {}): Timer => ({
  name: "sr-capture.timer",
  next: 53,
  service: "sr-capture.service",
  enabled: "enabled",
  svc: [`User=${o.user ?? "sr-igcapture"}`, `NetworkNamespacePath=${o.netns ?? ""}`, "JoinsNamespaceOf=", ...cmd("ExecStart", o.exec ?? CAPTURE_RUN, o.args ?? [], o.flags ?? ""), ...(o.extra ?? [])],
});
const cycle = (next: number | null): Timer => ({
  name: "sr-design-cycle.timer",
  next,
  service: "sr-design-cycle.service",
  enabled: next === null ? "disabled" : "enabled",
  svc: ["User=", "NetworkNamespacePath=", "JoinsNamespaceOf=", ...cmd("ExecStart", "/usr/bin/bash", ["/root/sr-capture-admin/scripts/sales-design-worker/cycle.sh"])],
});
const authWatch = (next: number | null = 20 * 3600): Timer => ({
  name: "sr-claude-auth-watch.timer",
  next,
  service: "sr-claude-auth-watch.service",
  enabled: "enabled",
  svc: ["User=someone", "NetworkNamespacePath=", "JoinsNamespaceOf=", "Environment=SR_AUTH_TOKEN=s3cretENV", ...cmd("ExecStart", "/usr/local/bin/sr-claude-auth-watch", ["--token=s3cretARG"])],
});
// an sr-* timer nothing classifies
const otherSr = (next: number | null = 20 * 3600): Timer => ({ ...authWatch(next), name: "sr-other-watch.timer", service: "sr-other-watch.service" });
const distro = (name: string, next: number, exec: string[]): Timer => ({
  name,
  next,
  service: name.replace(/\.timer$/, ".service"),
  enabled: "enabled",
  unitFile: false,
  frag: `/usr/lib/systemd/system/${name}`,
  svcFrag: `/usr/lib/systemd/system/${name.replace(/\.timer$/, ".service")}`,
  svc: ["User=", "NetworkNamespacePath=", "JoinsNamespaceOf=", ...cmd("ExecStart", exec[0]!, exec.slice(1))],
});
const fstrim = () => distro("fstrim.timer", 5 * 3600, ["/sbin/fstrim", "--listed-in", "/etc/fstab"]);

const base = (): World => ({
  timers: [capture(), fstrim()],
  units: [
    "sr-jail-claude.service loaded active running Claude Code Remote Control (sr-designgen, jailed)",
    "sr-jail-net.service loaded active running Requester jail network (pasta)",
  ],
  pids: ["101", "102"],
  ps: ["  101 sr-jail-claude.service", "  102 sr-jail-claude.service"],
  lock: "free",
});

// systemctl show: only the requested properties, in the file's order; --value prints values only
const SYSTEMCTL = `#!/bin/bash
W="$SR_TEST_WORLD"
printf '%s\\n' "$*" >> "$W/calls"
case "$1" in
  list-timers) cat "$W/timers.json"; exit "$(cat "$W/timers.rc")" ;;
  list-unit-files) cat "$W/unit-files"; exit "$(cat "$W/unit-files.rc")" ;;
  list-units) cat "$W/units"; exit 0 ;;
  show)
    shift; u="$1"; shift; keys=(); val=0
    while [ $# -gt 0 ]; do case "$1" in -p) keys+=("$2"); shift 2 ;; --value) val=1; shift ;; *) shift ;; esac; done
    f="$W/show/$u"; [ -f "$f" ] || f="$W/show/.not-found"
    while IFS= read -r line; do
      for k in "\${keys[@]}"; do
        [ "\${line%%=*}" = "$k" ] || continue
        if [ "$val" = 1 ]; then printf '%s\\n' "\${line#*=}"; else printf '%s\\n' "$line"; fi
      done
    done < "$f"
    ;;
  *) echo "systemctl stand-in: refused $1" >&2; exit 99 ;;
esac
`;
const STUBS: Record<string, string> = {
  sudo: '#!/bin/bash\nprintf "sudo %s\\n" "$1" >> "$SR_TEST_WORLD/calls"\nexec "$@"\n',
  systemctl: SYSTEMCTL,
  pgrep: `#!/bin/bash
W="$SR_TEST_WORLD"
printf 'pgrep %s\\n' "$*" >> "$W/calls"
case "$*" in
  *" -f "*) exit "$(cat "$W/pgrep-f.rc")" ;;
  *) rc="$(cat "$W/pgrep.rc")"; [ "$rc" = 0 ] && cat "$W/pids"; exit "$rc" ;;
esac
`,
  ps: '#!/bin/bash\nprintf "ps %s\\n" "$*" >> "$SR_TEST_WORLD/calls"\ncat "$SR_TEST_WORLD/ps"\nexit "$(cat "$SR_TEST_WORLD/ps.rc")"\n',
  flock: '#!/bin/bash\nprintf "flock %s\\n" "$*" >> "$SR_TEST_WORLD/calls"\n[ "$(cat "$SR_TEST_WORLD/lock")" = held ] && exit 75\nexit 0\n',
};

const run = (w: World) => {
  const d = mkdtempSync(join(tmpdir(), "sr-w0-"));
  roots.push(d);
  const bin = join(d, "bin");
  for (const sub of ["bin", "show", "linger"]) mkdirSync(join(d, sub));
  for (const [name, text] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const now = Math.floor(Date.now() / 1000);
  const loaded = w.timers.filter((t) => t.loaded !== false);
  const json = `[${loaded
    .map((t) => {
      const next = t.next === null ? "null" : String((now + t.next) * 1_000_000);
      return `{"next":${next},"left":${next},"last":null,"passed":null,"unit":"${t.name}","activates":"${t.service}"}`;
    })
    .join(",")}]`;
  const put = (f: string, text: string) => writeFileSync(join(d, f), text);
  put("timers.json", (w.timersJson ?? json) + "\n");
  put("timers.rc", String(w.timersRc ?? 0));
  const files = w.timers.filter((t) => t.name.startsWith("sr-") && t.unitFile !== false).map((t) => `${t.name} ${t.enabled ?? "enabled"} enabled`);
  put("unit-files", w.unitFilesRaw ?? files.map((l) => `${l}\n`).join(""));
  put("unit-files.rc", String(w.unitFilesRc ?? 0));
  put("units", w.units.map((l) => `${l}\n`).join(""));
  put("pgrep-f.rc", String(w.pgrepFRc ?? 1));
  put("pgrep.rc", String(w.pgrepRc ?? (w.pids.length ? 0 : 1)));
  put("pids", w.pids.map((l) => `${l}\n`).join(""));
  put("ps", w.ps.map((l) => `${l}\n`).join(""));
  put("ps.rc", String(w.psRc ?? 0));
  put("lock", w.lock);
  put("calls", "");
  for (const u of w.linger ?? []) put(join("linger", u), "");
  put(join("show", ".not-found"), "LoadState=not-found\nActiveState=inactive\n");
  for (const t of w.timers) {
    put(
      join("show", t.name),
      [`Unit=${t.service}`, `UnitFileState=${t.enabled ?? "enabled"}`, "LoadState=loaded", `FragmentPath=${t.frag ?? `/etc/systemd/system/${t.name}`}`, `DropInPaths=${t.drop ?? ""}`, ""].join("\n"),
    );
    put(
      join("show", t.service),
      ["LoadState=loaded", `ActiveState=${t.svcActive ?? "inactive"}`, `FragmentPath=${t.svcFrag ?? `/etc/systemd/system/${t.service}`}`, `DropInPaths=${t.svcDrop ?? ""}`, ...t.svc, ""].join("\n"),
    );
  }
  const lock = join(d, "cycle.lock");
  if (w.lock !== "none") writeFileSync(lock, "");
  const script = W0.split(LOCK).join(lock).split(LINGER).join(join(d, "linger"));
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, SR_TEST_WORLD: d, LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv,
  });
  const lines = r.stdout.trim().split("\n");
  return { out: r.stdout, err: r.stderr, status: r.status, last: lines[lines.length - 1]!, lines, calls: readFileSync(join(d, "calls"), "utf8") };
};
const timerLine = (r: ReturnType<typeof run>, t: string) => r.lines.find((l) => l.split(" ")[2] === t);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("W-0 (DEV-090): the block in passt-update-plan.md §5.0", () => {
  it("is valid bash, defines one function and runs it under sudo; the doc has exactly one W-0 and one fact sheet", () => {
    for (const b of [W0, FACTS]) {
      const r = spawnSync("bash", ["-n", "-c", b], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    }
    expect(W0.trimEnd().split("\n").pop()).toBe('sudo bash -c "$(declare -f sr_w0); sr_w0"');
    expect(FACTS.trimEnd().split("\n").pop()).toBe('sudo bash -c "$(declare -f sr_w0_facts); sr_w0_facts sr-claude-auth-watch.timer"');
    expect(PLAN.match(/^sr_w0\(\) \{/gm)).toHaveLength(1);
    expect(PLAN.match(/^sr_w0_facts\(\) \{/gm)).toHaveLength(1);
    expect(PLAN.match(/<!-- W0:BEGIN -->/g)).toHaveLength(1);
    // the old rule that could never pass while the capture helper is enabled is gone everywhere
    expect(PLAN).not.toMatch(/no `sr-\*`\s+timer\s+due within 30 minutes\)/);
    expect(PLAN).not.toMatch(/no `sr-\*` timer\s+is enabled with a next run within 30 minutes/);
    // D-0 and V-2 point at W-0 and require W0_OK
    const d0 = PLAN.slice(PLAN.indexOf("**W-0 + D-0 —"), PLAN.indexOf("**D-2 — deploy"));
    expect(d0).toContain("**D-0 runs only after W-0 printed `W0_OK` as its last line**");
    expect(PLAN).toContain("right after W-0 (§5.0) printed `W0_OK`");
    expect(PLAN).toContain("only when it is the only reason in `W0_HOLD`, use L-1");
  });

  it("is read only: it only lists and shows, never starts, stops, enables, masks, kills or writes", () => {
    const code = W0.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload|set-property|edit|reset-failed)/);
    expect(code).not.toMatch(/\b(pkill|kill|rm|mv|cp|tee|install|chmod|chown|ip|nsenter|systemd-run|usermod|loginctl)\b\s/);
    // no redirection into a file: only to /dev/null (the "->" in the W0_TIMER line is text)
    expect(code).not.toMatch(/(?<![-\w])\d?>>?\s*(?!\/dev\/null|&\d)/);
    const r = run(base());
    const verbs = r.calls
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")[0]);
    expect(new Set(verbs)).toEqual(new Set(["sudo", "list-timers", "list-unit-files", "show", "list-units", "pgrep", "ps", "flock"]));
    expect(r.calls).toMatch(/^flock -n -E 75 \S+cycle\.lock true$/m);
  });

  it("the capture timer as installed is KNOWN-UNRELATED, a distribution timer is only counted: W0_OK", () => {
    const r = run(base());
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(timerLine(r, "sr-capture.timer")).toMatch(
      /^W0_TIMER KNOWN-UNRELATED sr-capture\.timer -> sr-capture\.service user=sr-igcapture netns=none exec=\/home\/sr-igcapture\/second-root\/scripts\/sales-design-capture\/run\.sh enabled=enabled next=\S+\(in 5[0-3]s\)$/,
    );
    expect(timerLine(r, "fstrim.timer")).toBeUndefined();
    expect(r.out).toContain("W0_INFO other timers (distribution unit files, no local drop-in, no BLOCKING rule): 1\n");
    expect(r.out).toContain("W0_INFO jail sr-jail-net=active sr-jail-claude=active\n");
    expect(r.out).toContain("W0_CHECK OK no linger for sr-designgen or sr-designbridge\n");
    expect(r.out).toContain("W0_CHECK OK every process of sr-designgen is in sr-jail-claude.service (2)\n");
    expect(r.out).toContain("W0_CHECK OK cycle lock free\n");
    expect(r.last).toBe("W0_OK");
  });

  it.each([
    ["another user", capture({ user: "sr-designgen" })],
    ["a network namespace", capture({ netns: "/run/netns/srjail" })],
    ["another path", capture({ exec: "/home/sr-igcapture/other/run.sh" })],
    ["an argument", capture({ args: ["--all"] })],
    ["an argument that hides behind ' ; '", capture({ args: [";", "ignore_errors=no"] })],
    ["an extra ExecStartPre", capture({ extra: cmd("ExecStartPre", "/usr/bin/true") })],
    ["root (no User=)", capture({ user: "" })],
    ["the + (privileged) flag", capture({ flags: "privileged" })],
    ["the ! flag", capture({ flags: "no-setuid" })],
    ["no ExecStartEx line", { ...capture(), svc: capture().svc.filter((l) => !l.startsWith("ExecStartEx=")) }],
  ])("the capture timer with %s is UNKNOWN: W0_HOLD whatever its schedule", (_, t) => {
    const w = base();
    w.timers = [{ ...t, next: 6 * 3600 }, fstrim()];
    const r = run(w);
    expect(timerLine(r, "sr-capture.timer")).toMatch(/^W0_TIMER UNKNOWN sr-capture\.timer -> sr-capture\.service /);
    expect(r.last).toBe("W0_HOLD unknown:sr-capture.timer");
    expect(r.status).toBe(1);
  });

  it("the capture timer that triggers another service is UNKNOWN", () => {
    const w = base();
    w.timers = [{ ...capture(), service: "sr-capture-other.service" }];
    expect(run(w).last).toBe("W0_HOLD unknown:sr-capture.timer");
  });

  it("sr-claude-auth-watch.timer is BLOCKING by name: OK while not due, HOLD when due or running; no secret printed", () => {
    const w = base();
    w.timers.push(authWatch());
    const r = run(w);
    expect(timerLine(r, "sr-claude-auth-watch.timer")).toMatch(
      /^W0_TIMER BLOCKING sr-claude-auth-watch\.timer -> sr-claude-auth-watch\.service user=someone netns=none exec=\/usr\/local\/bin\/sr-claude-auth-watch enabled=enabled next=\S+\(in 7\d{4}s\)$/,
    );
    expect(r.last).toBe("W0_OK");
    expect(r.out).not.toContain("s3cret");
    expect(r.out).not.toContain("--token");
    expect(r.calls).not.toMatch(/-p Environment/);
    const due = base();
    due.timers.push(authWatch(900));
    expect(run(due).last).toBe("W0_HOLD due:sr-claude-auth-watch.timer");
    const running = base();
    running.timers.push({ ...authWatch(), svcActive: "active" });
    expect(run(running).last).toBe("W0_HOLD running:sr-claude-auth-watch.service");
  });

  it("any other sr-* timer is UNKNOWN: W0_HOLD although it is due only tomorrow; no secret printed", () => {
    const w = base();
    w.timers.push(otherSr());
    const r = run(w);
    expect(timerLine(r, "sr-other-watch.timer")).toMatch(/^W0_TIMER UNKNOWN sr-other-watch\.timer -> sr-other-watch\.service user=someone /);
    expect(r.last).toBe("W0_HOLD unknown:sr-other-watch.timer");
    expect(r.out).not.toContain("s3cret");
  });

  it("an UNKNOWN sr-* timer that is transient (no unit file), or disabled and not loaded, still holds", () => {
    const w = base();
    w.timers.push({ ...otherSr(), unitFile: false });
    expect(run(w).last).toBe("W0_HOLD unknown:sr-other-watch.timer");
    const off = base();
    off.timers.push({ ...otherSr(null), enabled: "disabled", loaded: false });
    const r = run(off);
    expect(timerLine(r, "sr-other-watch.timer")).toMatch(/ enabled=disabled next=none$/);
    expect(r.last).toBe("W0_HOLD unknown:sr-other-watch.timer");
  });

  it("a non-sr timer made by an administrator (/etc or /run), or a distribution timer with a local drop-in, is UNKNOWN", () => {
    for (const t of [
      { ...fstrim(), name: "backup.timer", service: "backup.service", frag: "/etc/systemd/system/backup.timer", svcFrag: "/etc/systemd/system/backup.service" },
      { ...fstrim(), name: "run-x.timer", service: "run-x.service", frag: "/run/systemd/transient/run-x.timer", svcFrag: "/run/systemd/transient/run-x.service" },
      { ...fstrim(), svcFrag: "/etc/systemd/system/fstrim.service" },
      { ...fstrim(), drop: "/etc/systemd/system/fstrim.timer.d/override.conf" },
      { ...fstrim(), svcDrop: "/usr/lib/systemd/system/fstrim.service.d/a.conf /etc/systemd/system/fstrim.service.d/b.conf" },
    ]) {
      const w = base();
      w.timers = [capture(), t];
      const r = run(w);
      expect(timerLine(r, t.name), t.name).toMatch(new RegExp(`^W0_TIMER UNKNOWN ${esc(t.name)} `));
      expect(r.last, JSON.stringify(t)).toBe(`W0_HOLD unknown:${t.name}`);
    }
    // a distribution drop-in under /usr/lib keeps it info only, as does /lib/systemd
    const w = base();
    w.timers = [capture(), { ...fstrim(), drop: "/usr/lib/systemd/system/fstrim.timer.d/x.conf", svcFrag: "/lib/systemd/system/fstrim.service" }];
    expect(run(w).last).toBe("W0_OK");
  });

  it("apt-daily-upgrade / apt-daily / unattended-upgrade are BLOCKING: held when due, info otherwise", () => {
    const up = distro("apt-daily-upgrade.timer", 600, ["/usr/lib/apt/apt.systemd.daily", "install"]);
    const w = base();
    w.timers.push(up);
    expect(run(w).last).toBe("W0_HOLD due:apt-daily-upgrade.timer");
    const later = base();
    later.timers.push({ ...up, next: 5 * 3600 }, distro("apt-daily.timer", 6 * 3600, ["/usr/lib/apt/apt.systemd.daily", "update"]));
    const r = run(later);
    expect(timerLine(r, "apt-daily.timer")).toMatch(/^W0_TIMER BLOCKING apt-daily\.timer /);
    expect(r.last).toBe("W0_OK");
    const ua = base();
    ua.timers.push(distro("my-upgrade.timer", 300, ["/usr/bin/Unattended-Upgrade", "-d"]));
    expect(run(ua).last).toBe("W0_HOLD due:my-upgrade.timer");
  });

  it("the cycle timer due in 10 minutes is BLOCKING: W0_HOLD due", () => {
    const w = base();
    w.timers.push(cycle(600));
    const r = run(w);
    expect(timerLine(r, "sr-design-cycle.timer")).toMatch(
      /^W0_TIMER BLOCKING sr-design-cycle\.timer -> sr-design-cycle\.service user=root netns=none exec=\/usr\/bin\/bash enabled=enabled next=\S+\(in (59\d|600)s\)$/,
    );
    expect(r.out).not.toContain("/root/sr-capture-admin/scripts/sales-design-worker/cycle.sh");
    expect(r.last).toBe("W0_HOLD due:sr-design-cycle.timer");
  });

  it("the cycle timer due in 2 hours is BLOCKING but does not hold: W0_OK", () => {
    const w = base();
    w.timers.push(cycle(7200));
    const r = run(w);
    expect(timerLine(r, "sr-design-cycle.timer")).toMatch(/^W0_TIMER BLOCKING sr-design-cycle\.timer .* next=\S+\(in 7\d{3}s\)$/);
    expect(r.last).toBe("W0_OK");
  });

  it("the cycle timer just under and just over 30 minutes; overdue counts as due", () => {
    for (const [next, last] of [
      [1790, "W0_HOLD due:sr-design-cycle.timer"],
      [1900, "W0_OK"],
      [-5, "W0_HOLD due:sr-design-cycle.timer"],
    ] as const) {
      const w = base();
      w.timers.push(cycle(next));
      expect(run(w).last, String(next)).toBe(last);
    }
  });

  it("a disabled cycle timer and the old worker / bridge timers without a next run do not hold", () => {
    const w = base();
    w.timers.push(cycle(null), { ...cycle(null), name: "sr-design-worker.timer", service: "sr-design-worker.service" }, {
      ...cycle(null),
      name: "sr-design-bridge.timer",
      service: "sr-design-bridge.service",
      svc: ["User=sr-designbridge", ...cmd("ExecStart", "/home/sr-designbridge/second-root/scripts/sales-design-bridge/run.sh", ["--once"])],
    });
    const r = run(w);
    for (const t of ["sr-design-cycle.timer", "sr-design-worker.timer", "sr-design-bridge.timer"]) {
      expect(timerLine(r, t), t).toMatch(new RegExp(`^W0_TIMER BLOCKING ${esc(t)} .* enabled=disabled next=none$`));
    }
    expect(r.last).toBe("W0_OK");
  });

  it.each([
    ["User=sr-designgen", { name: "sr-foo.timer", svc: ["User=sr-designgen", ...cmd("ExecStart", "/usr/bin/true")] }],
    ["a NetworkNamespacePath", { name: "sr-foo.timer", svc: ["NetworkNamespacePath=/run/netns/srjail", ...cmd("ExecStart", "/usr/bin/true")] }],
    ["JoinsNamespaceOf", { name: "sr-foo.timer", svc: ["JoinsNamespaceOf=sr-jail-net.service", ...cmd("ExecStart", "/usr/bin/true")] }],
    ["admin.sh in an argument", { name: "sr-foo.timer", svc: cmd("ExecStart", "/usr/bin/bash", ["/root/sr-capture-admin/scripts/sales-design-capture/admin.sh", "run"]) }],
    ["codex in an ExecStartPre path", { name: "sr-foo.timer", svc: [...cmd("ExecStartPre", "/usr/local/bin/codex"), ...cmd("ExecStart", "/usr/bin/true")] }],
    ["Codex in another case", { name: "sr-foo.timer", svc: cmd("ExecStart", "/opt/Codex/BIN") }],
    ["admin.sh after an argument with ' ; '", { name: "sr-foo.timer", svc: cmd("ExecStart", "/usr/bin/bash", ["-c", "true ; bash /root/x/admin.sh run"]) }],
    ["an sr-jail-* name", { name: "sr-jail-probe.timer", svc: cmd("ExecStart", "/usr/bin/true") }],
    ["a non-sr timer that runs cycle.sh", { name: "nightly.timer", unitFile: false, svc: cmd("ExecStart", "/usr/bin/bash", ["/root/sr-capture-admin/scripts/sales-design-worker/cycle.sh"]) }],
  ])("a timer with %s is BLOCKING (held only when due)", (_, t) => {
    const mk = (next: number): Timer => ({ service: t.name.replace(/\.timer$/, ".service"), enabled: "enabled", ...t, next });
    const w = base();
    w.timers.push(mk(300));
    const r = run(w);
    expect(timerLine(r, t.name)).toMatch(new RegExp(`^W0_TIMER BLOCKING ${esc(t.name)} `));
    expect(r.last).toBe(`W0_HOLD due:${t.name}`);
    const later = base();
    later.timers.push(mk(4 * 3600));
    expect(run(later).last).toBe("W0_OK");
  });

  it("a BLOCKING timer whose service is running holds even when its next run is far away", () => {
    const w = base();
    w.timers.push({ ...cycle(3 * 3600), svcActive: "activating" });
    expect(run(w).last).toBe("W0_HOLD running:sr-design-cycle.service");
  });

  it("linger on for sr-designgen or sr-designbridge: W0_HOLD; for another user: nothing", () => {
    const r = run({ ...base(), linger: ["sr-designgen"] });
    expect(r.out).toContain("W0_CHECK HOLD sr-designgen has linger on (its own systemd --user could run timers)\n");
    expect(r.last).toBe("W0_HOLD linger:sr-designgen");
    expect(run({ ...base(), linger: ["sr-designbridge"] }).last).toBe("W0_HOLD linger:sr-designbridge");
    expect(run({ ...base(), linger: ["ioda"] }).last).toBe("W0_OK");
  });

  it("a worker, PoC or Codex process of sr-designgen: W0_HOLD; pgrep failing: W0_HOLD", () => {
    const r = run({ ...base(), pgrepFRc: 0 });
    expect(r.out).toContain("W0_CHECK HOLD a worker, PoC or Codex process of sr-designgen is running\n");
    expect(r.last).toBe("W0_HOLD worker-process");
    expect(r.calls).toContain("pgrep -u sr-designgen -f scripts/sales-design-worker/|sales-design-bridge/|design-image-poc|codex");
    expect(run({ ...base(), pgrepFRc: 2 }).last).toBe("W0_HOLD unparseable:pgrep");
    expect(run({ ...base(), pgrepRc: 2 }).last).toBe("W0_HOLD unparseable:pgrep");
  });

  it("a process of sr-designgen outside Claude's own jail unit: W0_HOLD", () => {
    const w = base();
    w.pids.push("103", "104");
    w.ps.push("  103 sr-jail-shell-4242.service", "  104 -");
    const r = run(w);
    expect(r.last).toBe("W0_HOLD process-outside-claude:sr-jail-shell-4242.service process-outside-claude:-");
  });

  it("ps failing, or ps showing fewer processes than pgrep found: W0_HOLD unparseable:ps (fail closed)", () => {
    const failed = run({ ...base(), psRc: 1, ps: [] });
    expect(failed.out).toContain("W0_CHECK HOLD ps did not account for every process of sr-designgen (0 of 2)\n");
    expect(failed.last).toBe("W0_HOLD unparseable:ps");
    const fewer = run({ ...base(), ps: ["  101 sr-jail-claude.service"] });
    expect(fewer.last).toBe("W0_HOLD unparseable:ps");
    // even with a zero exit and the right count, a line ps could not have printed holds
    expect(run({ ...base(), ps: ["  101 sr-jail-claude.service", "  x y"] }).last).toBe("W0_HOLD unparseable:ps");
  });

  it("no process of sr-designgen at all (Claude stopped) is fine", () => {
    const r = run({ ...base(), pids: [], ps: [] });
    expect(r.out).toContain("W0_CHECK OK no process of sr-designgen\n");
    expect(r.last).toBe("W0_OK");
  });

  it("the cycle lock held: W0_HOLD; no lock file at all (the cycle never ran) is fine", () => {
    const held = run({ ...base(), lock: "held" });
    expect(held.out).toContain("W0_CHECK HOLD a cycle holds the lock\n");
    expect(held.last).toBe("W0_HOLD cycle-lock-held");
    const none = run({ ...base(), lock: "none" });
    expect(none.out).toContain("W0_CHECK OK no cycle state (the cycle never ran)\n");
    expect(none.calls).not.toContain("flock");
    expect(none.last).toBe("W0_OK");
  });

  it.each([
    ["an sr-jail-run unit active", "sr-jail-run-123-456.service loaded active running /usr/bin/bash run.sh", "W0_HOLD unit:sr-jail-run-123-456.service"],
    ["an sr-jail-shell unit activating", "sr-jail-shell-99.service loaded activating start /bin/bash -l", "W0_HOLD unit:sr-jail-shell-99.service"],
    ["the cycle service running", "sr-design-cycle.service loaded active running Second Root design worker cycle", "W0_HOLD unit:sr-design-cycle.service"],
    ["a jail scope with the bullet", "● sr-jail-x.scope loaded active running x", "W0_HOLD unit:sr-jail-x.scope"],
  ])("%s: W0_HOLD", (_, unit, last) => {
    const w = base();
    w.units.push(unit);
    expect(run(w).last).toBe(last);
  });

  it("a finished (inactive or failed) jail check unit does not hold", () => {
    const w = base();
    w.units.push("sr-jail-check-77.service loaded failed failed x", "sr-design-cycle.service loaded inactive dead x", "sr-design-cycle.timer loaded active waiting x");
    expect(run(w).last).toBe("W0_OK");
  });

  it.each([
    ["list-timers prints its text table (no JSON)", { timersJson: "NEXT LEFT LAST PASSED UNIT ACTIVATES\nFri 2026-10-23 12:17:00 JST 53s - - sr-capture.timer sr-capture.service" }, "unparseable:list-timers"],
    ["list-timers fails", { timersRc: 1, timersJson: "" }, "unparseable:list-timers"],
    ["a list-timers object without next", { timersJson: '[{"left":1,"unit":"sr-capture.timer","activates":"sr-capture.service"}]' }, "unparseable:list-timers"],
    ["a list-timers object without unit", { timersJson: '[{"next":1,"left":1,"activates":"x.service"}]' }, "unparseable:list-timers"],
    // a "unit" outside any object W-0 can read: only the object / unit count catches it
    ["a unit key outside the objects", { timersJson: '[{"next":1,"unit":"fstrim.timer"},"unit":"sr-x.timer"]' }, "unparseable:list-timers"],
    ["a list-timers object with a strange unit name", { timersJson: '[{"next":1,"unit":"sr-capture\\\\x2dold.timer"}]' }, "unparseable:list-timers"],
    ["list-unit-files fails", { unitFilesRc: 1, unitFilesRaw: "" }, "unparseable:list-unit-files"],
    ["list-unit-files prints garbage", { unitFilesRaw: "Failed to connect to bus: No such file or directory\n" }, "unparseable:list-unit-files"],
  ])("unparseable systemctl output: %s → W0_HOLD", (_, over, reason) => {
    const r = run({ ...base(), ...over });
    expect(r.last.startsWith("W0_HOLD ")).toBe(true);
    expect(r.last.split(" ")).toContain(reason);
  });

  it("an unparseable list-units line holds too", () => {
    const w = base();
    w.units.push("garbage");
    expect(run(w).last).toBe("W0_HOLD unparseable:list-units");
  });
});

describe("the read-only fact sheet for an UNKNOWN timer (§5.0)", () => {
  it("prints unit settings, exec paths and flags, owner / mode / sha256 and keyword counts; never an argument, an argument's file or a line", () => {
    const d = mkdtempSync(join(tmpdir(), "sr-w0-facts-"));
    roots.push(d);
    const bin = join(d, "bin");
    mkdirSync(bin);
    mkdirSync(join(d, "show"));
    writeFileSync(join(bin, "systemctl"), SYSTEMCTL);
    writeFileSync(join(bin, "sudo"), STUBS.sudo!);
    chmodSync(join(bin, "systemctl"), 0o755);
    chmodSync(join(bin, "sudo"), 0o755);
    writeFileSync(join(d, "calls"), "");
    const script = join(d, "auth-watch-SECRETNAME.sh");
    writeFileSync(script, "#!/bin/bash\nTOKEN=s3cretLINE\ncodex login status\n");
    const runner = join(d, "runner");
    writeFileSync(runner, "#!/bin/bash\n# codex Codex sr-jail admin.sh\nexec systemd-run --pipe true # s3cretRUNNER\n");
    chmodSync(runner, 0o750);
    const unitFile = join(d, "sr-claude-auth-watch.service");
    writeFileSync(unitFile, "[Service]\nEnvironment=SR_TOKEN=s3cretUNIT\nExecStart=" + runner + " " + script + "\n");
    writeFileSync(
      join(d, "show", "sr-claude-auth-watch.timer"),
      ["Id=sr-claude-auth-watch.timer", "LoadState=loaded", "UnitFileState=enabled", "ActiveState=active", "Unit=sr-claude-auth-watch.service", "TimersCalendar={ OnCalendar=*-*-* 06:00:00 ; next_elapse=Sat 2026-10-24 06:00:00 JST }", ""].join("\n"),
    );
    writeFileSync(
      join(d, "show", "sr-claude-auth-watch.service"),
      [
        "Id=sr-claude-auth-watch.service",
        "LoadState=loaded",
        "User=someone",
        "Group=someone",
        "NetworkNamespacePath=",
        "JoinsNamespaceOf=",
        "WorkingDirectory=/home/someone",
        "Environment=SR_TOKEN=s3cretENV",
        ...cmd("ExecStart", runner, [script, "--token=s3cretARG"], "privileged"),
        `FragmentPath=${unitFile}`,
        "DropInPaths=",
        "",
      ].join("\n"),
    );
    const r = spawnSync("bash", ["-c", FACTS], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, SR_TEST_WORLD: d, LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out).toContain("== timer sr-claude-auth-watch.timer\n");
    expect(out).toContain("TimersCalendar={ OnCalendar=*-*-* 06:00:00 ;");
    expect(out).toContain("User=someone\n");
    expect(out).toContain(`EXEC ExecStart path=${runner} argc=3 absolute-file-args=1\n`);
    expect(out).toContain("EXECFLAGS ExecStartEx flags=privileged\n");
    expect(out).toMatch(new RegExp(`FILE ExecStart ${esc(runner)} \\S+:\\S+ 750 \\d+ bytes sha256=[0-9a-f]{64}\\n`));
    expect(out).toContain("HITS ExecStart srjail=0 sr-designgen=0 sr-jail=1 admin.sh=1 cycle.sh=0 codex=1 netns=0 pasta=0 systemd-run=1\n");
    expect(out).toMatch(/HITS unit:sr-claude-auth-watch\.service srjail=0 /);
    expect(out.trimEnd().split("\n").pop()).toBe("FACTS_END sr-claude-auth-watch.timer");
    // nothing from inside a file, no argument, no argument's file, no environment
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("--token");
    expect(out).not.toContain("SECRETNAME");
    expect(out).not.toContain("login status");
    expect(r.stderr).not.toContain("s3cret");
    const calls = readFileSync(join(d, "calls"), "utf8");
    expect(calls).not.toMatch(/-p Environment\b|cat |status /);
    for (const l of calls.split("\n").filter(Boolean)) expect(l).toMatch(/^(sudo bash|show )/);
  });
});
