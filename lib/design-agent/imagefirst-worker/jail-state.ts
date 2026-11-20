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
