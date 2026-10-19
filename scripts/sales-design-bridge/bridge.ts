/**
 * Second Root design bridge (DEV-030, Sales Design Bridge). Started by
 * scripts/sales-design-bridge/run.sh as the dedicated Linux user
 * sr-designbridge (never as the worker user sr-designgen).
 *
 *   tsx scripts/sales-design-bridge/bridge.ts --once
 *   tsx scripts/sales-design-bridge/bridge.ts --deliver-only
 *
 * One pass: deliver finished worker results, expire unanswered jobs, claim
 * at most one new job. `--deliver-only` does the first two and never claims
 * (no claim request, no new job file). See docs/operations/design-bridge.md.
 *
 * Settings (environment, all optional except the URL):
 *   SR_DESIGN_BRIDGE_API_URL     https origin of Second Root (e.g. https://secondroot.jp)
 *   SR_DESIGN_BRIDGE_TOKEN_FILE  default ~/.config/second-root/design-bridge.token (0600, this user)
 *   SR_DESIGN_BRIDGE_SPOOL       default /srv/sr-design-bridge
 *   SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE / SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN
 *                                (DEV-059, both or neither; off by default) a dedicated Vercel
 *                                Protection Bypass value in a 0600 file of this user, sent only
 *                                to that exact https://<name>.vercel.app origin, which must be the
 *                                API URL's. See docs/operations/design-bridge-access.md.
 *
 * Output: fixed codes and job ids only. Exit 0 = done (or nothing to do),
 * 3 = stopped (configuration, auth, API or spool), 2 = usage.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError, bridgeModeFor, bridgeSummary, readTokenFile, runBridgeOnce } from "../../lib/design-agent/bridge/client";
import { bridgeSpool } from "../../lib/design-agent/bridge/spool";
import { BypassError, loadVercelBypass, type VercelBypass } from "../../lib/design-agent/bridge/vercel-bypass";

process.umask(0o077);

const say = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mode = bridgeModeFor(args);
  if (!mode) {
    process.stderr.write("usage: bridge.ts --once | --deliver-only\n");
    return 2;
  }
  const home = homedir();
  const apiUrl = process.env.SR_DESIGN_BRIDGE_API_URL;
  if (!apiUrl) {
    say("stopped: BRIDGE_NOT_CONFIGURED");
    return 3;
  }
  let token: string;
  try {
    token = await readTokenFile(process.env.SR_DESIGN_BRIDGE_TOKEN_FILE ?? join(home, ".config/second-root/design-bridge.token"));
  } catch (error) {
    say(`stopped: ${error instanceof BridgeError ? error.code : "BRIDGE_NOT_CONFIGURED"}`);
    return 3;
  }
  let vercelBypass: VercelBypass | null;
  try {
    vercelBypass = await loadVercelBypass({
      file: process.env.SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE,
      origin: process.env.SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN,
      apiUrl,
      token,
    });
  } catch (error) {
    // Fixed codes only: never the value, the path or the origin.
    say(`stopped: ${error instanceof BypassError ? error.code : "BRIDGE_BYPASS_UNSAFE"}`);
    return 3;
  }
  if (vercelBypass) say("vercel protection bypass in use (configured origin only)");
  let report;
  try {
    report = await runBridgeOnce({
      spool: bridgeSpool(process.env.SR_DESIGN_BRIDGE_SPOOL ?? undefined),
      stateDir: join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "sr-design-bridge"),
      apiUrl,
      token,
      mode,
      vercelBypass,
      log: say,
    });
  } catch (error) {
    say(`stopped: ${error instanceof BridgeError ? error.code : "BRIDGE_SPOOL_INVALID"}`);
    return 3;
  }
  say(bridgeSummary(report, mode));
  return report.stopped ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  () => {
    say("stopped: BRIDGE_INTERNAL_ERROR");
    process.exit(3);
  },
);
