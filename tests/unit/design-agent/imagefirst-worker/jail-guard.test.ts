import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jailUnitOf, ownJailUnit } from "@/lib/design-agent/imagefirst-worker/jail-state";

// DEV-302 (docs/operations/remote-control-resilience.md §7): the IMAGE_FIRST worker refuses its one-shot run and its
// precheck inside a requester jail unit (sr-jail-*.service). Remote Control's unit (and a jailed shell / admin.sh run, all
// bound to sr-jail-net) is restarted with everything in it (KillMode=control-group); a run there could be killed after
// its claim, spending the approval id. Root's pilot / automatic start run the worker outside the jail.
const REPO = resolve(__dirname, "../../../..");
const CLI = readFileSync(join(REPO, "scripts/sales-design-worker/imagefirst-worker.ts"), "utf8");

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
    const guard = CLI.indexOf("const jailUnit = await ownJailUnit();");
    expect(guard).toBeGreaterThan(0);
    expect(CLI).toContain('if (jailUnit !== null) return (say({ status: "refused", code: jailUnit === "unknown" ? "OWN_CGROUP_UNREADABLE" : "RUN_INSIDE_JAIL_UNIT", invoked: false }), 2);');
    expect(guard).toBeLessThan(CLI.indexOf("precheckImagefirstCycle({"));
    expect(guard).toBeLessThan(CLI.indexOf("runImagefirstCycle(\n"));
    // called with the real /proc/self/cgroup reader only: no environment variable or argument reaches it
    expect(CLI.match(/ownJailUnit\(/g)).toHaveLength(1);
  });
});
