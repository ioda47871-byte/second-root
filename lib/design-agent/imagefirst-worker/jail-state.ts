/**
 * Issue #302 P3 follow-up (PR #310 review H1 / L5 / L6): the worker side's read of whether the jailed Claude
 * (sr-jail-claude.service) is idle, for the manual review re-send (imagefirst-worker.ts --deliver-review). Defense in
 * depth only: the real gate is root's wrapper scripts/sales-design-worker/imagefirst-deliver-review.sh, which runs the
 * automatic start's busy() check as root and then drops to the worker user OUTSIDE the jail. (Inside the jail there is
 * no /run and no system bus: this read answers null there, and the re-send is refused.)
 *
 * The rule is the automatic start's (imagefirst-autostart.sh busy()): idle only when ActiveState is inactive or failed
 * AND `is-enabled` says disabled or masked. Any other answer (active, activating, enabled, static, not-found, ...) is not
 * idle (false); an error or no answer cannot be told (null). systemctl is run by its absolute, root-owned path, never
 * looked up in the caller's PATH (a user-writable PATH entry could plant a fake). Read only.
 */
import { readFile } from "node:fs/promises";
import { runBounded } from "../bounded-process";

export const SYSTEMCTL = "/usr/bin/systemctl";
export const JAIL_UNIT = "sr-jail-claude.service";

/** true = idle, false = running / enabled / any other state, null = cannot tell. `systemctl` is injectable for tests only. */
export async function jailIdle(env: NodeJS.ProcessEnv, systemctl: string = SYSTEMCTL): Promise<boolean | null> {
  const run = (args: string[]) => runBounded(systemctl, args, { cwd: "/", env, timeoutMs: 30_000 }).catch(() => null);
  const active = await run(["show", "-p", "ActiveState", "--value", JAIL_UNIT]);
  const state = active?.code === 0 ? active.stdout.trim() : "";
  if (state === "") return null;
  if (!/^(inactive|failed)$/.test(state)) return false;
  const enabled = await run(["is-enabled", JAIL_UNIT]);
  if (!enabled || enabled.timedOut || enabled.code === null) return null;
  return /^(disabled|masked)$/.test(enabled.stdout.trim());
}

/**
 * DEV-302 (docs/operations/remote-control-resilience.md §7): the unit this process itself runs in, from its own
 * /proc/self/cgroup (the cgroup v2 line). A one-shot run inside a requester jail unit (sr-jail-claude.service, Remote
 * Control's unit, or a jailed shell / `admin.sh run`, which all go away with sr-jail-net) is killed with that unit
 * (KillMode=control-group): a restart of Remote Control, of the jail's network or of WSL would end it after its claim was
 * spent. The worker refuses such a run before its precheck and before any claim; one-shot generation runs only through
 * root's pilot / automatic start, which start the worker outside the jail in their own unit. Only narrows: no input of
 * the caller can turn the refusal off (the CLI's production entry passes no reader; only its test entry under tests/
 * does). An accident guard, not a security boundary: a jailed process could get around it (NODE_OPTIONS, importing
 * cycle.ts, the entry itself); the claim and the entry's ledger stay the once-only gate. Only the cgroup v2 line is read:
 * a cgroup-v1-only host has none (the run goes through); without /proc/self/cgroup (macOS, Windows) it is "unknown".
 */
export const JAIL_CGROUP_LINE = /^0::\/system\.slice\/(sr-jail-[a-z0-9-]+\.service)(?:\/.*)?$/m;

/** The sr-jail-*.service unit named by this /proc/<pid>/cgroup text, or null outside every one of them. */
export function jailUnitOf(cgroupText: string): string | null {
  return JAIL_CGROUP_LINE.exec(cgroupText)?.[1] ?? null;
}

/** The jail unit the current process runs in; "unknown" when its own cgroup cannot be read (callers refuse then). */
export async function ownJailUnit(read: () => Promise<string> = () => readFile("/proc/self/cgroup", "utf8")): Promise<string | null | "unknown"> {
  try {
    return jailUnitOf(await read());
  } catch {
    return "unknown";
  }
}
