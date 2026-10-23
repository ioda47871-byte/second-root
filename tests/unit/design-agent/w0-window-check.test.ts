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

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const CAPTURE_RUN = "/home/sr-igcapture/second-root/scripts/sales-design-capture/run.sh";
const exec = (key: string, path: string, args: string[] = []) =>
  `${key}={ path=${path} ; argv[]=${[path, ...args].join(" ")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

type Timer = {
  name: string;
  next: number | null; // seconds from now; null = no next run
  service: string;
  enabled?: string; // UnitFileState
  unitFile?: boolean; // listed by list-unit-files (sr-* only)
  loaded?: boolean; // listed by list-timers
  svc: string[]; // the service's `systemctl show` lines
  svcActive?: string;
};
type World = {
  timers: Timer[];
  timersJson?: string; // overrides the list-timers output
  timersRc?: number;
  unitFilesRaw?: string;
  unitFilesRc?: number;
  units: string[];
  workerProcess?: boolean;
  pids: string[];
  ps: string[];
  lock: "free" | "held" | "none";
};

const capture = (svc: Partial<Record<"user" | "netns" | "exec", string>> & { extra?: string[]; args?: string[] } = {}): Timer => ({
  name: "sr-capture.timer",
  next: 53,
  service: "sr-capture.service",
  enabled: "enabled",
  svc: [
    `User=${svc.user ?? "sr-igcapture"}`,
    `NetworkNamespacePath=${svc.netns ?? ""}`,
    "JoinsNamespaceOf=",
    exec("ExecStart", svc.exec ?? CAPTURE_RUN, svc.args ?? []),
    ...(svc.extra ?? []),
  ],
});
const cycle = (next: number | null): Timer => ({
  name: "sr-design-cycle.timer",
  next,
  service: "sr-design-cycle.service",
  enabled: next === null ? "disabled" : "enabled",
  svc: ["User=", "NetworkNamespacePath=", "JoinsNamespaceOf=", exec("ExecStart", "/usr/bin/bash", ["/root/sr-capture-admin/scripts/sales-design-worker/cycle.sh"])],
});
const authWatch = (): Timer => ({
  name: "sr-claude-auth-watch.timer",
  next: 20 * 3600,
  service: "sr-claude-auth-watch.service",
  enabled: "enabled",
  svc: [
    "User=someone",
    "NetworkNamespacePath=",
    "JoinsNamespaceOf=",
    "Environment=SR_AUTH_TOKEN=s3cretENV",
    exec("ExecStart", "/usr/local/bin/sr-claude-auth-watch", ["--token=s3cretARG"]),
  ],
});
const aptDaily = (): Timer => ({
  name: "apt-daily.timer",
  next: 5 * 3600,
  service: "apt-daily.service",
  enabled: "enabled",
  unitFile: false,
  svc: ["User=", "NetworkNamespacePath=", "JoinsNamespaceOf=", exec("ExecStart", "/usr/lib/apt/apt.systemd.daily", ["update"])],
});

const base = (): World => ({
  timers: [capture(), aptDaily()],
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
  *) [ -s "$W/pids" ] || exit 1; cat "$W/pids" ;;
esac
`,
  ps: '#!/bin/bash\nprintf "ps %s\\n" "$*" >> "$SR_TEST_WORLD/calls"\ncat "$SR_TEST_WORLD/ps"\n',
  flock: '#!/bin/bash\nprintf "flock %s\\n" "$*" >> "$SR_TEST_WORLD/calls"\n[ "$(cat "$SR_TEST_WORLD/lock")" = held ] && exit 75\nexit 0\n',
};

const run = (w: World) => {
  const d = mkdtempSync(join(tmpdir(), "sr-w0-"));
  roots.push(d);
  const bin = join(d, "bin");
  mkdirSync(bin);
  mkdirSync(join(d, "show"));
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
  writeFileSync(join(d, "timers.json"), (w.timersJson ?? json) + "\n");
  writeFileSync(join(d, "timers.rc"), String(w.timersRc ?? 0));
  const files = w.timers.filter((t) => t.name.startsWith("sr-") && t.unitFile !== false).map((t) => `${t.name} ${t.enabled ?? "enabled"} enabled`);
  writeFileSync(join(d, "unit-files"), w.unitFilesRaw ?? files.map((l) => `${l}\n`).join(""));
  writeFileSync(join(d, "unit-files.rc"), String(w.unitFilesRc ?? 0));
  writeFileSync(join(d, "units"), w.units.map((l) => `${l}\n`).join(""));
  writeFileSync(join(d, "pgrep-f.rc"), w.workerProcess ? "0" : "1");
  writeFileSync(join(d, "pids"), w.pids.map((l) => `${l}\n`).join(""));
  writeFileSync(join(d, "ps"), w.ps.map((l) => `${l}\n`).join(""));
  writeFileSync(join(d, "lock"), w.lock);
  writeFileSync(join(d, "calls"), "");
  writeFileSync(join(d, "show", ".not-found"), "LoadState=not-found\nActiveState=inactive\n");
  for (const t of w.timers) {
    writeFileSync(
      join(d, "show", t.name),
      [`Unit=${t.service}`, `UnitFileState=${t.enabled ?? "enabled"}`, `ActiveState=${t.next === null ? "inactive" : "active"}`, "LoadState=loaded", ""].join("\n"),
    );
    writeFileSync(join(d, "show", t.service), ["LoadState=loaded", `ActiveState=${t.svcActive ?? "inactive"}`, ...t.svc, ""].join("\n"));
  }
  const lock = join(d, "cycle.lock");
  if (w.lock !== "none") writeFileSync(lock, "");
  const script = W0.split(LOCK).join(lock);
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, SR_TEST_WORLD: d, LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv,
  });
  const lines = r.stdout.trim().split("\n");
  return { out: r.stdout, err: r.stderr, status: r.status, last: lines[lines.length - 1]!, lines, calls: readFileSync(join(d, "calls"), "utf8") };
};
const timerLine = (r: ReturnType<typeof run>, t: string) => r.lines.find((l) => l.split(" ")[2] === t);

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
    // D-0 and D-2 and V-2 point at W-0 and require W0_OK
    const d0 = PLAN.slice(PLAN.indexOf("**W-0 + D-0 —"), PLAN.indexOf("**D-2 — deploy"));
    expect(d0).toContain("**D-0 runs only after W-0 printed `W0_OK` as its last line**");
    expect(d0).toContain("e525371c4f768e24889954652d3f01241d8a6627");
    expect(PLAN).toContain("**D-2 — deploy (approval 2).** Run W-0 (§5.0) again right before it; go on only on `W0_OK`.");
    expect(PLAN).toContain("right after W-0 (§5.0) printed `W0_OK`");
  });

  it("is read only: it only lists and shows, never starts, stops, enables, masks, kills or writes", () => {
    const code = W0.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload|set-property|edit|reset-failed)/);
    expect(code).not.toMatch(/\b(pkill|kill|rm|mv|cp|tee|install|chmod|chown|ip|nsenter|systemd-run|usermod)\b\s/);
    // no redirection into a file: only to /dev/null (the "->" in the W0_TIMER line is text)
    expect(code).not.toMatch(/(?<![-\w])\d?>>?\s*(?!\/dev\/null|&\d)/);
    const r = run(base());
    const verbs = r.calls
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")[0]);
    expect(new Set(verbs)).toEqual(new Set(["sudo", "list-timers", "list-unit-files", "show", "list-units", "pgrep", "ps", "flock"]));
    // the lock is only tried (-n): the stand-in would have been called with exactly this
    expect(r.calls).toMatch(/^flock -n -E 75 \S+cycle\.lock true$/m);
  });

  it("the capture timer as installed is KNOWN-UNRELATED, an unrelated system timer is only counted: W0_OK", () => {
    const r = run(base());
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(timerLine(r, "sr-capture.timer")).toMatch(
      /^W0_TIMER KNOWN-UNRELATED sr-capture\.timer -> sr-capture\.service user=sr-igcapture netns=none exec=\/home\/sr-igcapture\/second-root\/scripts\/sales-design-capture\/run\.sh enabled=enabled next=\S+\(in 5[0-3]s\)$/,
    );
    expect(timerLine(r, "apt-daily.timer")).toBeUndefined();
    expect(r.out).toContain("W0_INFO other timers (not sr-*, no BLOCKING rule): 1\n");
    expect(r.out).toContain("W0_INFO jail sr-jail-net=active sr-jail-claude=active\n");
    expect(r.out).toContain("W0_CHECK OK every process of sr-designgen is in sr-jail-claude.service (2)\n");
    expect(r.out).toContain("W0_CHECK OK cycle lock free\n");
    expect(r.last).toBe("W0_OK");
  });

  it.each([
    ["another user", capture({ user: "sr-designgen" })],
    ["a network namespace", capture({ netns: "/run/netns/srjail" })],
    ["another path", capture({ exec: "/home/sr-igcapture/other/run.sh" })],
    ["an argument", capture({ args: ["--all"] })],
    ["an extra ExecStartPre", capture({ extra: [exec("ExecStartPre", "/usr/bin/true")] })],
    ["root (no User=)", capture({ user: "" })],
  ])("the capture timer with %s is UNKNOWN: W0_HOLD whatever its schedule", (_, t) => {
    const w = base();
    w.timers = [{ ...t, next: 6 * 3600 }, aptDaily()];
    const r = run(w);
    expect(timerLine(r, "sr-capture.timer")).toMatch(/^W0_TIMER UNKNOWN sr-capture\.timer -> sr-capture\.service /);
    expect(r.last).toBe("W0_HOLD unknown:sr-capture.timer");
    expect(r.status).toBe(1);
  });

  it("the capture timer whose service does not load, or that triggers another service, is UNKNOWN", () => {
    const w = base();
    w.timers = [{ ...capture(), service: "sr-capture-other.service" }];
    expect(run(w).last).toBe("W0_HOLD unknown:sr-capture.timer");
  });

  it("sr-claude-auth-watch.timer (not defined in this repository) is UNKNOWN: W0_HOLD although it is due only tomorrow; no secret printed", () => {
    const w = base();
    w.timers.push(authWatch());
    const r = run(w);
    expect(timerLine(r, "sr-claude-auth-watch.timer")).toMatch(
      /^W0_TIMER UNKNOWN sr-claude-auth-watch\.timer -> sr-claude-auth-watch\.service user=someone netns=none exec=\/usr\/local\/bin\/sr-claude-auth-watch enabled=enabled next=\S+\(in 7\d{4}s\)$/,
    );
    expect(timerLine(r, "sr-capture.timer")).toMatch(/^W0_TIMER KNOWN-UNRELATED /);
    expect(r.last).toBe("W0_HOLD unknown:sr-claude-auth-watch.timer");
    // only the exec path: never an argument, never the environment
    expect(r.out).not.toContain("s3cret");
    expect(r.out).not.toContain("--token");
    expect(r.calls).not.toMatch(/-p Environment/);
  });

  it("an UNKNOWN sr-* timer with no unit file loaded (e.g. a transient one) is UNKNOWN too", () => {
    const w = base();
    w.timers.push({ ...authWatch(), name: "sr-transient.timer", service: "sr-transient.service", unitFile: false });
    expect(run(w).last).toBe("W0_HOLD unknown:sr-transient.timer");
  });

  it("an UNKNOWN sr-* timer that is disabled and not loaded still holds", () => {
    const w = base();
    w.timers.push({ ...authWatch(), next: null, enabled: "disabled", loaded: false });
    const r = run(w);
    expect(timerLine(r, "sr-claude-auth-watch.timer")).toMatch(/ enabled=disabled next=none$/);
    expect(r.last).toBe("W0_HOLD unknown:sr-claude-auth-watch.timer");
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
      svc: ["User=sr-designbridge", exec("ExecStart", "/home/sr-designbridge/second-root/scripts/sales-design-bridge/run.sh", ["--once"])],
    });
    const r = run(w);
    for (const t of ["sr-design-cycle.timer", "sr-design-worker.timer", "sr-design-bridge.timer"]) {
      expect(timerLine(r, t), t).toMatch(new RegExp(`^W0_TIMER BLOCKING ${t.replace(/\./g, "\\.")} .* enabled=disabled next=none$`));
    }
    expect(r.last).toBe("W0_OK");
  });

  it.each([
    ["User=sr-designgen", { name: "sr-foo.timer", svc: ["User=sr-designgen", exec("ExecStart", "/usr/bin/true")] }],
    ["a NetworkNamespacePath", { name: "sr-foo.timer", svc: ["NetworkNamespacePath=/run/netns/srjail", exec("ExecStart", "/usr/bin/true")] }],
    ["JoinsNamespaceOf", { name: "sr-foo.timer", svc: ["JoinsNamespaceOf=sr-jail-net.service", exec("ExecStart", "/usr/bin/true")] }],
    ["admin.sh in an argument", { name: "sr-foo.timer", svc: [exec("ExecStart", "/usr/bin/bash", ["/root/sr-capture-admin/scripts/sales-design-capture/admin.sh", "run"])] }],
    ["codex in an ExecStartPre path", { name: "sr-foo.timer", svc: [exec("ExecStartPre", "/usr/local/bin/codex"), exec("ExecStart", "/usr/bin/true")] }],
    ["an sr-jail-* name", { name: "sr-jail-probe.timer", svc: [exec("ExecStart", "/usr/bin/true")] }],
    ["a non-sr timer that runs cycle.sh", { name: "nightly.timer", unitFile: false, svc: [exec("ExecStart", "/usr/bin/bash", ["/root/sr-capture-admin/scripts/sales-design-worker/cycle.sh"])] }],
  ])("a timer with %s is BLOCKING (held only when due)", (_, t) => {
    const mk = (next: number): Timer => ({ service: t.name.replace(/\.timer$/, ".service"), enabled: "enabled", ...t, next });
    const w = base();
    w.timers.push(mk(300));
    const r = run(w);
    expect(timerLine(r, t.name)).toMatch(new RegExp(`^W0_TIMER BLOCKING ${t.name.replace(/\./g, "\\.")} `));
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

  it("a worker, PoC or Codex process of sr-designgen: W0_HOLD", () => {
    const r = run({ ...base(), workerProcess: true });
    expect(r.out).toContain("W0_CHECK HOLD a worker, PoC or Codex process of sr-designgen is running\n");
    expect(r.last).toBe("W0_HOLD worker-process");
    expect(r.calls).toContain("pgrep -u sr-designgen -f scripts/sales-design-worker/|sales-design-bridge/|design-image-poc|codex");
  });

  it("a process of sr-designgen outside Claude's own jail unit: W0_HOLD", () => {
    const w = base();
    w.pids.push("103", "104");
    w.ps.push("  103 sr-jail-shell-4242.service", "  104 -");
    const r = run(w);
    expect(r.out).toContain("W0_CHECK HOLD a process of sr-designgen runs outside sr-jail-claude.service\n");
    expect(r.last).toBe("W0_HOLD process-outside-claude:sr-jail-shell-4242.service process-outside-claude:-");
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
    const r = run(w);
    expect(r.last).toBe(last);
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
    ["a list-timers object with a strange unit name", { timersJson: '[{"next":1,"unit":"sr-capture\\\\x2dold.timer"}]' }, "unparseable:list-timers"],
    ["list-unit-files fails", { unitFilesRc: 1, unitFilesRaw: "" }, "unparseable:list-unit-files"],
    ["list-unit-files prints garbage", { unitFilesRaw: "Failed to connect to bus: No such file or directory\n" }, "unparseable:list-unit-files"],
  ])("unparseable systemctl output: %s → W0_HOLD", (_, over, reason) => {
    const r = run({ ...base(), ...over });
    expect(r.last.startsWith("W0_HOLD ")).toBe(true);
    expect(r.last.split(" ")).toContain(reason);
    expect(r.last).not.toBe("W0_OK");
  });

  it("an unparseable list-units line holds too", () => {
    const w = base();
    w.units.push("garbage");
    expect(run(w).last).toBe("W0_HOLD unparseable:list-units");
  });
});

describe("the read-only fact sheet for an UNKNOWN timer (§5.0)", () => {
  it("prints unit settings, exec paths, owner / mode / sha256 and keyword counts, never a line of the script or an argument", () => {
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
    const script = join(d, "auth-watch.sh");
    writeFileSync(script, "#!/bin/bash\nTOKEN=s3cretLINE\ncodex login status\ncodex --version # codex\nexec systemd-run --pipe true\n");
    const unitFile = join(d, "sr-claude-auth-watch.service");
    writeFileSync(unitFile, "[Service]\nEnvironment=SR_TOKEN=s3cretUNIT\nExecStart=/usr/bin/bash " + script + "\n");
    writeFileSync(
      join(d, "show", "sr-claude-auth-watch.timer"),
      ["Id=sr-claude-auth-watch.timer", "LoadState=loaded", "UnitFileState=enabled", "ActiveState=active", "Unit=sr-claude-auth-watch.service", "TimersCalendar={ OnCalendar=*-*-* 06:00:00 ; next_elapse=Sat 2026-10-24 06:00:00 JST }", "FragmentPath=/etc/systemd/system/sr-claude-auth-watch.timer", ""].join("\n"),
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
        exec("ExecStart", "/usr/bin/bash", [script, "--token=s3cretARG"]),
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
    expect(out).toContain("NetworkNamespacePath=\n");
    expect(out).toContain("EXEC ExecStart path=/usr/bin/bash argc=3\n");
    expect(out).toMatch(new RegExp(`FILE ExecStart-arg ${script.replace(/[.]/g, "\\.")} \\S+:\\S+ 6\\d\\d \\d+ bytes sha256=[0-9a-f]{64}\\n`));
    expect(out).toContain("HITS ExecStart-arg srjail=0 sr-designgen=0 sr-jail=0 admin.sh=0 cycle.sh=0 codex=3 netns=0 pasta=0 systemd-run=1\n");
    expect(out).toMatch(/HITS unit:sr-claude-auth-watch\.service srjail=0 /);
    expect(out.trimEnd().split("\n").pop()).toBe("FACTS_END sr-claude-auth-watch.timer");
    // nothing from inside a file, no argument, no environment
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("--token");
    expect(out).not.toContain("login status");
    expect(r.stderr).not.toContain("s3cret");
    const calls = readFileSync(join(d, "calls"), "utf8");
    expect(calls).not.toMatch(/-p Environment\b|cat |status /);
    for (const l of calls.split("\n").filter(Boolean)) expect(l).toMatch(/^(sudo bash|show )/);
  });
});
