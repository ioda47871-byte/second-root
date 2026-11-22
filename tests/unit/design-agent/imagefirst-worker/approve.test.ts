import { spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ID, loadPngs, SCRIPTS, wsl } from "./pilot-world";
import { APPROVAL_PACKET_PATH, D4_PACKET } from "@/lib/design-agent/phase2f-live/full-page-call";
import { cleanupTemps, commitFiles, filledD4Packet, filledPacket, git, tmp } from "./support";

// Issue #302: the owner's approval command (scripts/sales-design-worker/imagefirst-approve.sh), the real file, against the
// pilot's fake WSL (./pilot-world.ts) under SR_IMAGEFIRST_APPROVE_TEST_ROOT: the owner's switch and marker in a temporary
// /etc, root's state in a temporary /var/lib, a stand-in for root's admin clone (a clone of the temporary bare origin), the
// worker's dedicated clone with the stub worker CLI. No root, no systemd, no network, no model; nothing is ever generated.

vi.setConfig({ testTimeout: 300_000 });
afterAll(cleanupTemps, 60_000);
beforeAll(loadPngs);
const APPROVE = join(SCRIPTS, "imagefirst-approve.sh");
const D4 = "hoshigama-imagefirst-d4-20261121-01";
const OTHER = "hoshigama-imagefirst-d3-20261121-02";
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A worker CLI whose --precheck prints exactly $HOME/precheck-out and exits $HOME/precheck-exit (pushed to origin). */
const ECHO_WORKER = `import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME ?? "";
appendFileSync(join(home, "stub.log"), JSON.stringify({ cli: "worker", argv: process.argv.slice(2), grant: process.env.SR_IMAGEFIRST_EXPECT_APPROVAL_ID ?? "", env: [] }) + "\\n");
process.stdout.write(readFileSync(join(home, "precheck-out"), "utf8"));
process.exit(Number(readFileSync(join(home, "precheck-exit"), "utf8")));
`;

/** The approved packets on develop: d3 (the p3 packet) for ID and d4 for D4, with this expiry (in memory fixtures only). */
const packets = (expires: string, d3 = ID, d4 = D4) => ({
  [APPROVAL_PACKET_PATH]: filledPacket({ d3: `\`${d3}\``, expires: `\`${expires}\`` }),
  [D4_PACKET.path]: filledD4Packet({ d4: `\`${d4}\``, expires: `\`${expires}\`` }),
});

function world(packetExpires?: string) {
  const w = wsl();
  const etc = join(w.t, "etc", "sr-design-worker");
  mkdirSync(etc, { recursive: true });
  const state = join(w.t, "var", "lib", "sr-imagefirst-autostart");
  // the worker would run now with 2 h of the approval left (the stub's precheck reports this expiry, as the packet says)
  const expires = utc(Date.now() + 2 * 3600_000);
  writeFileSync(join(w.home, "stub-expires"), expires);
  const pushIn = (files: Record<string, Buffer>, msg: string) => {
    const c = tmp("sr-ifa-push-");
    git(c, "clone", "-q", "--branch", "develop", w.origin, ".");
    commitFiles(c, files, msg);
    git(c, "push", "-q", "origin", "HEAD:refs/heads/develop");
    return git(c, "rev-parse", "HEAD");
  };
  pushIn(packets(packetExpires ?? expires), "the owner merged the approved packets (test)");
  const admin = join(w.t, "root", "sr-capture-admin");
  mkdirSync(join(w.t, "root"));
  git(w.t, "clone", "-q", "--branch", "develop", w.origin, admin);
  const env = { ...w.env, SR_IMAGEFIRST_APPROVE_TEST_ROOT: w.t } as unknown as NodeJS.ProcessEnv;
  const marker = join(etc, "imagefirst-run.json");
  const approve = (args: string[]) => {
    const r = spawnSync("bash", [APPROVE, ...args], { env, encoding: "utf8", timeout: 200_000 });
    const last = r.stdout.trim().split("\n").pop() ?? "";
    const m = /^IMAGEFIRST_APPROVE (\S+) approval=(\S+) exit=(\d+)$/.exec(last);
    expect(m, r.stdout + r.stderr).not.toBeNull();
    expect(Number(m![3]), r.stdout).toBe(r.status);
    expect(existsSync(join(w.sc, "model-cli.log")), "a codex / claude binary was started").toBe(false);
    return { status: r.status, code: m![1]!, approval: m![2]!, stdout: r.stdout };
  };
  /** Push a commit to origin (the owner merged something on develop). */
  const push = pushIn;
  return {
    ...w,
    etc,
    state,
    admin,
    expires,
    marker,
    approve,
    push,
    switchOn: (body: object = { enabled: true }) => writeFileSync(join(etc, "imagefirst-autostart.json"), JSON.stringify(body), { mode: 0o644 }),
    writeMarker: (id: string, exp: string) => writeFileSync(marker, JSON.stringify({ approval_id: id, expires_at: exp }), { mode: 0o644 }),
    /** Remote Control up: the jailed Claude active and enabled, processes of the worker user. */
    rcUp: () => {
      writeFileSync(join(w.sc, "sr-jail-claude.service"), "active");
      writeFileSync(join(w.sc, "enabled-sr-jail-claude.service"), "enabled");
      writeFileSync(join(w.sc, "pgrep"), "");
    },
  };
}
type World = ReturnType<typeof world>;

/** No marker, no root state of use, nothing started as the worker. */
const nothing = (w: World, startsAllowed = false) => {
  expect(existsSync(w.marker)).toBe(false);
  expect(existsSync(join(w.state, "used"))).toBe(false);
  expect(existsSync(join(w.state, "autorun"))).toBe(false);
  if (!startsAllowed) expect(w.starts()).toEqual([]);
  expect(w.spent()).toEqual([]);
  expect(readdirSync(w.etc).filter((n) => n.startsWith(".imagefirst-run"))).toEqual([]);
};

describe("Issue #302 approval command: refusals (no marker is written)", () => {
  it("usage, a malformed id, the dummy's reserved date: refused before anything", () => {
    const w = world();
    w.switchOn();
    for (const args of [[], [ID, ID], ["../x"], [`${ID}\n`], ["tsugute-imagefirst-d3-20261121-01"], ["hoshigama-imagefirst-d5-20261121-01"]]) expect(w.approve(args).status, args.join(" ")).toBe(2);
    expect(w.approve(["hoshigama-imagefirst-d3-00000000-01"])).toMatchObject({ status: 2, code: "APPROVE_ID_RESERVED" });
    expect(w.approve(["hoshigama-imagefirst-d4-00000000-01"])).toMatchObject({ status: 2, code: "APPROVE_ID_RESERVED" });
    nothing(w);
  });

  it("the switch: absent (prints how to turn it on), enabled:false, invalid, unsafe (a link, writable by others): refused", () => {
    const w = world();
    const off = w.approve([ID]);
    expect(off).toMatchObject({ status: 2, code: "APPROVE_SWITCH_OFF" });
    expect(off.stdout).toContain(`echo '{"enabled": true}' | sudo tee /etc/sr-design-worker/imagefirst-autostart.json`);
    w.switchOn({ enabled: false });
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_SWITCH_OFF" });
    w.switchOn({ enabled: true, extra: 1 });
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_SWITCH_INVALID" });
    w.switchOn();
    chmodSync(join(w.etc, "imagefirst-autostart.json"), 0o666);
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_SWITCH_UNSAFE" });
    rmSync(join(w.etc, "imagefirst-autostart.json"));
    writeFileSync(join(w.t, "elsewhere.json"), '{"enabled": true}', { mode: 0o644 });
    symlinkSync(join(w.t, "elsewhere.json"), join(w.etc, "imagefirst-autostart.json"));
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_SWITCH_UNSAFE" });
    nothing(w);
  });

  it("the admin clone dirty, or not at origin/develop after the fetch (prints the exact checkout line); it never updates itself", () => {
    const w = world();
    w.switchOn();
    writeFileSync(join(w.admin, "stray.txt"), "x");
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_ADMIN_CLONE_DIRTY" });
    rmSync(join(w.admin, "stray.txt"));
    const before = git(w.admin, "rev-parse", "HEAD");
    const merged = w.push({ "docs/merged.md": Buffer.from("x") }, "the packet PR merged");
    const r = w.approve([ID]);
    expect(r).toMatchObject({ status: 2, code: "APPROVE_ADMIN_CLONE_NOT_DEVELOP" });
    expect(r.stdout).toContain(`imagefirst-approve:   sudo git -C /root/sr-capture-admin checkout -q --detach ${merged}`);
    expect(git(w.admin, "rev-parse", "HEAD")).toBe(before);
    nothing(w);
    // after the owner's checkout it goes on
    git(w.admin, "checkout", "-q", "--detach", merged);
    expect(w.approve([ID])).toMatchObject({ status: 0, code: "APPROVE_RECORDED" });
  });

  it("the old hourly automatic start enabled or active: refused (both would read the marker)", () => {
    for (const [file, value] of [["enabled-sr-imagefirst-autostart.timer", "enabled"], ["sr-imagefirst-autostart.service", "activating"]]) {
      const w = world();
      w.switchOn();
      writeFileSync(join(w.sc, file!), value!);
      expect(w.approve([ID]), file).toMatchObject({ status: 2, code: "APPROVE_AUTOSTART_ENABLED" });
      nothing(w);
    }
  });

  it("one use per id: used/<id> or the automatic run's attempt/<id> refuses; a pending marker for another id is never replaced", () => {
    const w = world();
    w.switchOn();
    mkdirSync(join(w.state, "used", ID), { recursive: true });
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_USED" });
    rmSync(join(w.state, "used"), { recursive: true });
    mkdirSync(join(w.state, "autorun", ID), { recursive: true });
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_ATTEMPTED" });
    rmSync(join(w.state, "autorun"), { recursive: true });
    w.writeMarker(OTHER, utc(Date.now() + 3600_000));
    const before = readFileSync(w.marker, "utf8");
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_OTHER_PENDING" });
    expect(readFileSync(w.marker, "utf8")).toBe(before);
    // an unsafe or invalid current marker: refused (looked at first)
    chmodSync(w.marker, 0o666);
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_MARKER_UNSAFE" });
    writeFileSync(w.marker, "{}", { mode: 0o644 });
    chmodSync(w.marker, 0o644);
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_MARKER_INVALID" });
    rmSync(w.marker);
    writeFileSync(join(w.t, "elsewhere.json"), JSON.stringify({ approval_id: ID, expires_at: utc(Date.now() + 3600_000) }), { mode: 0o644 });
    symlinkSync(join(w.t, "elsewhere.json"), w.marker);
    expect(w.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_MARKER_UNSAFE" });
    rmSync(w.marker);
    expect(w.starts()).toEqual([]);
    // another id that is used, attempted or expired may be replaced
    for (const sub of ["used", "autorun"]) {
      w.writeMarker(OTHER, utc(Date.now() + 3600_000));
      mkdirSync(join(w.state, sub, OTHER), { recursive: true });
      expect(w.approve([ID]).code).toBe("APPROVE_RECORDED");
      rmSync(join(w.state, "used"), { recursive: true, force: true });
      rmSync(join(w.state, "autorun"), { recursive: true, force: true });
    }
    w.writeMarker(OTHER, utc(Date.now() - 60_000));
    expect(w.approve([ID]).code).toBe("APPROVE_RECORDED");
  });

  it("an automatic run in progress (its lock): refused, nothing written", async () => {
    const w = world();
    w.switchOn();
    mkdirSync(w.state, { recursive: true, mode: 0o700 });
    const ready = join(w.sc, "holds");
    const holder = spawnChild("flock", [join(w.state, "autorun.lock"), "bash", "-c", `touch '${ready}'; sleep 30`], { stdio: "ignore" });
    for (let i = 0; i < 500 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 20));
    expect(w.approve([ID])).toMatchObject({ status: 11, code: "APPROVE_LOCKED" });
    holder.kill("SIGKILL");
    nothing(w);
  });

  it("the worker's precheck (when idle) says it would not run: exit 10, no marker", () => {
    const w = world();
    w.switchOn();
    writeFileSync(join(w.home, "stub-precheck"), "PACKET_NOT_APPROVED");
    const r = w.approve([ID]);
    expect(r).toMatchObject({ status: 10, code: "APPROVE_NOT_RUNNABLE" });
    expect(r.stdout).toContain('"code":"PACKET_NOT_APPROVED"');
    expect(w.starts().map((s) => [s.argv.join(" "), s.grant])).toEqual([["--precheck", ID]]);
    nothing(w, true);
  });

  it("the precheck's line not exactly would_run for this id with a sane expiry: refused, no marker", () => {
    const ok = (o: object) => JSON.stringify({ status: "would_run", code: null, invoked: false, ...o });
    const w = world();
    const cases: [string, string, number, string][] = [
      ["another approval id", `${ok({ approval_id: OTHER, expires_at: w.expires })}\n`, 0, "APPROVE_PRECHECK_UNEXPECTED"],
      ["no expiry", `${ok({ approval_id: ID })}\n`, 0, "APPROVE_PRECHECK_UNEXPECTED"],
      ["an extra key", `${JSON.stringify({ status: "would_run", code: null, invoked: false, approval_id: ID, expires_at: w.expires, x: 1 })}\n`, 0, "APPROVE_PRECHECK_UNEXPECTED"],
      ["two lines", `{}\n${ok({ approval_id: ID, expires_at: w.expires })}\n`, 0, "APPROVE_PRECHECK_UNEXPECTED"],
      ["would_run with exit 2", `${ok({ approval_id: ID, expires_at: w.expires })}\n`, 2, "APPROVE_NOT_RUNNABLE"],
      // review M1d: the worker's expiry must be the packet's, as root read it from its own admin clone
      ["an expiry other than the packet's", `${ok({ approval_id: ID, expires_at: utc(Date.now() + 3600_000) })}\n`, 0, "APPROVE_PRECHECK_UNEXPECTED"],
      ["the expiry more than 24 h ahead", `${ok({ approval_id: ID, expires_at: "2099-01-01T00:00:00Z" })}\n`, 0, "APPROVE_PRECHECK_UNEXPECTED"],
    ];
    w.switchOn();
    const head = w.push({ "scripts/sales-design-worker/imagefirst-worker.ts": Buffer.from(ECHO_WORKER) }, "a worker that echoes its precheck line (test)");
    git(w.admin, "fetch", "-q", "origin");
    git(w.admin, "checkout", "-q", "--detach", head);
    for (const [name, out, exit, code] of cases) {
      writeFileSync(join(w.home, "precheck-out"), out);
      writeFileSync(join(w.home, "precheck-exit"), String(exit));
      expect(w.approve([ID]), name).toMatchObject({ code });
      nothing(w, true);
    }
  });
});

describe("Issue #302 approval command: the marker", () => {
  it("idle: the worker's precheck (synced clone, this id as the grant), then exactly {approval_id, expires_at} written atomically, 0644", () => {
    const w = world();
    w.switchOn();
    const r = w.approve([ID]);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "APPROVE_RECORDED", approval: ID });
    expect(readFileSync(w.marker, "utf8")).toBe(`{"approval_id": "${ID}", "expires_at": "${w.expires}"}\n`);
    expect(statSync(w.marker).mode & 0o777).toBe(0o644);
    expect(readdirSync(w.etc).sort()).toEqual(["imagefirst-autostart.json", "imagefirst-run.json"]);
    // only the precheck ran as the worker (the production privilege drop's options), never the run, the pilot or admin.sh
    expect(w.starts().map((s) => [s.cli, s.argv.join(" "), s.grant])).toEqual([["worker", "--precheck", ID]]);
    expect(new Set(readFileSync(join(w.sc, "setpriv.log"), "utf8").trim().split("\n"))).toEqual(new Set([expect.stringMatching(/^--reuid=\d+ --regid=\d+ --init-groups --reset-env --no-new-privs$/)]));
    expect(existsSync(join(w.state, "used"))).toBe(false);
    expect(existsSync(join(w.state, "autorun"))).toBe(false);
    expect(readFileSync(join(w.sc, "systemctl.log"), "utf8")).not.toMatch(/^(start|stop|enable|disable)/m);
    // the same command again for the same id: the marker is written again (the same id; nothing used)
    expect(w.approve([ID]).code).toBe("APPROVE_RECORDED");
    // a d4 id after that one is used: its own marker (its direction picks its own packet at run time)
    mkdirSync(join(w.state, "used", ID), { recursive: true });
    expect(w.approve([D4])).toMatchObject({ status: 0, code: "APPROVE_RECORDED", approval: D4 });
    expect(JSON.parse(readFileSync(w.marker, "utf8"))).toEqual({ approval_id: D4, expires_at: w.expires });
    expect(w.starts().filter((s) => s.grant === D4).map((s) => s.argv.join(" "))).toEqual(["--precheck"]);
  });

  it("Remote Control up (the usual case): nothing runs as the worker; the marker gets the packet's expiry, checked at run time", () => {
    const w = world();
    w.switchOn();
    w.rcUp();
    const r = w.approve([ID]);
    expect(r, r.stdout).toMatchObject({ status: 0, code: "APPROVE_RECORDED_DEFERRED", approval: ID });
    expect(r.stdout).toMatch(/nothing runs as the worker now/);
    expect(w.starts()).toEqual([]);
    expect(existsSync(join(w.sc, "setpriv.log"))).toBe(false);
    const m = JSON.parse(readFileSync(w.marker, "utf8")) as { approval_id: string; expires_at: string };
    expect(Object.keys(m)).toEqual(["approval_id", "expires_at"]);
    expect(m.approval_id).toBe(ID);
    // the packet's own expiry, read by root from its admin clone (review M1d)
    expect(m.expires_at).toBe(w.expires);
    expect(statSync(w.marker).mode & 0o777).toBe(0o644);
    // the worker's clone was not touched
    expect(existsSync(join(w.sc, "systemctl-other.log"))).toBe(false);
  });

  it("review M1d: the packet in root's admin clone: no row for this id, not approved, or expired: refused (both paths)", () => {
    for (const busyNow of [false, true]) {
      const w = world();
      w.switchOn();
      if (busyNow) w.rcUp();
      // the packet names another id (the owner typed an id that is not the approved one)
      expect(w.approve([OTHER]), `busy=${busyNow}`).toMatchObject({ status: 2, code: "APPROVE_PACKET_NO_ID" });
      expect(w.approve(["hoshigama-imagefirst-d4-20261121-02"]), `busy=${busyNow}`).toMatchObject({ status: 2, code: "APPROVE_PACKET_NO_ID" });
      // the d3 id is only looked up in the d3 packet (the d4 packet naming it does not count)
      const head = w.push(packets(w.expires, OTHER, ID), "the d4 packet names the d3 id (test)");
      git(w.admin, "fetch", "-q", "origin");
      git(w.admin, "checkout", "-q", "--detach", head);
      expect(w.approve([ID]), `busy=${busyNow}`).toMatchObject({ status: 2, code: "APPROVE_PACKET_NO_ID" });
      // the status not 承認済み
      const unapproved = w.push({ [APPROVAL_PACKET_PATH]: filledPacket({ d3: `\`${ID}\``, status: "未承認", expires: `\`${w.expires}\`` }) }, "unapproved (test)");
      git(w.admin, "fetch", "-q", "origin");
      git(w.admin, "checkout", "-q", "--detach", unapproved);
      expect(w.approve([ID]), `busy=${busyNow}`).toMatchObject({ status: 2, code: "APPROVE_PACKET_NO_ID" });
      // expired
      const past = w.push(packets(utc(Date.now() - 60_000)), "expired (test)");
      git(w.admin, "fetch", "-q", "origin");
      git(w.admin, "checkout", "-q", "--detach", past);
      expect(w.approve([ID]), `busy=${busyNow}`).toMatchObject({ status: 2, code: "APPROVE_PACKET_EXPIRED" });
      expect(existsSync(w.marker)).toBe(false);
      expect(w.starts()).toEqual([]);
    }
  });

  it("review M1d: Remote Control up: the marker carries the packet's own expiry; over 24 h ahead: now + 24 h with a note; under 20 min: refused", () => {
    const w = world();
    w.switchOn();
    w.rcUp();
    expect(w.approve([ID])).toMatchObject({ status: 0, code: "APPROVE_RECORDED_DEFERRED" });
    expect(readFileSync(w.marker, "utf8")).toBe(`{"approval_id": "${ID}", "expires_at": "${w.expires}"}\n`);
    const far = world(utc(Date.now() + 30 * 3600_000));
    far.switchOn();
    far.rcUp();
    const r = far.approve([ID]);
    expect(r).toMatchObject({ status: 0, code: "APPROVE_RECORDED_DEFERRED" });
    expect(r.stdout).toMatch(/more than 24 h ahead\): the marker gets now \+ 24 h/);
    expect(Date.parse((JSON.parse(readFileSync(far.marker, "utf8")) as { expires_at: string }).expires_at)).toBeLessThanOrEqual(Date.now() + 86_400_000);
    const soon = world(utc(Date.now() + 10 * 60_000));
    soon.switchOn();
    soon.rcUp();
    expect(soon.approve([ID])).toMatchObject({ status: 2, code: "APPROVE_TOO_LATE" });
    expect(existsSync(soon.marker)).toBe(false);
  });

  it("refuses any copy outside the root-only clone without the test world", () => {
    const r = spawnSync("bash", [APPROVE, ID], { env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout.trim().split("\n").pop()).toBe(`IMAGEFIRST_APPROVE APPROVE_USAGE approval=${ID} exit=2`);
    expect(r.stdout).toContain("run from the root-only clone");
  });
});
