import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { jailUnitOf, ownJailUnit } from "@/lib/design-agent/imagefirst-worker/jail-state";

// DEV-302 (docs/operations/remote-control-resilience.md §7): the IMAGE_FIRST worker refuses its one-shot run and its
// precheck inside a requester jail unit (sr-jail-*.service). Remote Control's unit (and a jailed shell / admin.sh run, all
// bound to sr-jail-net) is restarted with everything in it (KillMode=control-group); a run there could be killed after
// its claim, spending the approval id. Root's pilot / automatic start run the worker outside the jail.
const REPO = resolve(__dirname, "../../../..");
const CLI = readFileSync(join(REPO, "scripts/sales-design-worker/imagefirst-worker.ts"), "utf8");
vi.setConfig({ testTimeout: 120_000 });
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe("the worker's own cgroup", () => {
  it("names the jail unit from the cgroup v2 line, and nothing else", () => {
    expect(jailUnitOf("0::/system.slice/sr-jail-claude.service\n")).toBe("sr-jail-claude.service");
    expect(jailUnitOf("1:name=systemd:/\n0::/system.slice/sr-jail-shell-4242.service\n")).toBe("sr-jail-shell-4242.service");
    expect(jailUnitOf("0::/system.slice/sr-jail-run-17-993.service\n")).toBe("sr-jail-run-17-993.service");
    // a sub-cgroup of a jail unit is still inside it (fail-safe: refused)
    expect(jailUnitOf("0::/system.slice/sr-jail-claude.service/tmux\n")).toBe("sr-jail-claude.service");
    for (const outside of [
      "0::/system.slice/sr-imagefirst-autostart.service\n", // root's automatic start
      "0::/user.slice/user-0.slice/session-3.scope\n", // root's pilot from a terminal
      "0::/system.slice/sr-design-cycle.service\n",
      "0::/\n",
      "1:name=systemd:/system.slice/sr-jail-claude.service\n0::/user.slice\n", // only the v2 line counts
      "0::/system.slice/not-sr-jail-claude.service\n",
      "",
    ]) {
      expect(jailUnitOf(outside), outside).toBeNull();
    }
  });

  it("an unreadable cgroup is 'unknown' (the worker refuses then)", async () => {
    expect(await ownJailUnit(async () => "0::/system.slice/sr-jail-claude.service\n")).toBe("sr-jail-claude.service");
    expect(await ownJailUnit(async () => "0::/\n")).toBeNull();
    expect(
      await ownJailUnit(async () => {
        throw new Error("EACCES");
      }),
    ).toBe("unknown");
    // this test process (not in a jail unit) reads its own cgroup
    expect(await ownJailUnit()).not.toBe("unknown");
  });
});

describe("imagefirst-worker.ts wiring", () => {
  it("refuses before the precheck and the run (so before any lock, claim or invocation), with no way to turn it off", () => {
    const guard = CLI.indexOf("const jailUnit = await ownJailUnit(readCgroup);");
    expect(guard).toBeGreaterThan(0);
    expect(CLI).toContain('if (jailUnit !== null) return (say({ status: "refused", code: jailUnit === "unknown" ? "OWN_CGROUP_UNREADABLE" : "RUN_INSIDE_JAIL_UNIT", invoked: false }), 2);');
    expect(guard).toBeLessThan(CLI.indexOf("precheckImagefirstCycle({"));
    expect(guard).toBeLessThan(CLI.indexOf("runImagefirstCycle(\n"));
    // the production entry passes no reader (its own /proc/self/cgroup); only the test entry, by importing main, can
    expect(CLI.match(/ownJailUnit\(/g)).toHaveLength(1);
    expect(CLI).toContain("if (require.main === module) runMain(() => main());");
    expect(CLI.match(/readCgroup/g)).toHaveLength(3); // the parameter, its doc line, the one call
    expect(CLI).not.toMatch(/process\.env\.[A-Z_]*CGROUP|cgroup[^\n]*process\.argv/i);
  });
});

describe("the refusal through the real worker CLI (the test-only entry gives the cgroup)", () => {
  const ENTRY = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/worker-cli-entry.ts");
  const run = (cgroup: string, args: string[]) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "sr-ifw-jail-")));
    homes.push(home);
    const r = spawnSync(process.execPath, ["--import", "tsx", ENTRY, cgroup, ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    return { status: r.status, out: JSON.parse(lines.at(-1) ?? "null") as { status: string; code: string | null; invoked: boolean } | null, lines, home };
  };

  it("inside sr-jail-claude, a jailed shell or admin.sh run: RUN_INSIDE_JAIL_UNIT, exit 2, nothing created in HOME (run and precheck)", () => {
    for (const cg of ["0::/system.slice/sr-jail-claude.service\n", "1:name=systemd:/\n0::/system.slice/sr-jail-shell-77.service\n", "0::/system.slice/sr-jail-run-9-1.service\n"]) {
      for (const args of [[], ["--precheck"]]) {
        const r = run(cg, args);
        expect(r.status, cg).toBe(2);
        expect(r.out).toEqual({ status: "refused", code: "RUN_INSIDE_JAIL_UNIT", invoked: false });
        expect(r.lines).toHaveLength(1);
        expect(readdirSync(r.home)).toEqual([]);
      }
    }
  });

  it("an unreadable cgroup: OWN_CGROUP_UNREADABLE, exit 2, nothing created", () => {
    const r = run("unreadable", []);
    expect(r.status).toBe(2);
    expect(r.out).toEqual({ status: "refused", code: "OWN_CGROUP_UNREADABLE", invoked: false });
    expect(readdirSync(r.home)).toEqual([]);
  });

  it("outside the jail (root's pilot / automatic start): the guard lets it through to the later gates", () => {
    for (const cg of ["0::/system.slice/sr-imagefirst-autostart.service\n", "0::/user.slice/user-0.slice/session-3.scope\n"]) {
      const r = run(cg, ["--precheck"]);
      expect(r.out?.code).not.toBe("RUN_INSIDE_JAIL_UNIT");
      expect(r.out?.code).not.toBe("OWN_CGROUP_UNREADABLE");
      expect(r.out?.invoked).toBe(false);
    }
  });

  it("the checks before the guard still answer first (USAGE)", () => {
    const r = run("0::/system.slice/sr-jail-claude.service\n", ["--now"]);
    expect(r.out).toEqual({ status: "refused", code: "USAGE", invoked: false });
  });
});
