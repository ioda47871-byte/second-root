/**
 * Second Root design bridge (DEV-030, Sales Design Bridge). Started by
 * scripts/sales-design-bridge/run.sh as the dedicated Linux user
 * sr-designbridge (never as the worker user sr-designgen).
 *
 *   tsx scripts/sales-design-bridge/bridge.ts --once
 *
 * One pass: deliver finished worker results, expire unanswered jobs, claim
 * at most one new job. See docs/operations/design-bridge.md.
 *
 * Settings (environment, all optional except the URL):
 *   SR_DESIGN_BRIDGE_API_URL     https origin of Second Root (e.g. https://secondroot.jp)
 *   SR_DESIGN_BRIDGE_TOKEN_FILE  default ~/.config/second-root/design-bridge.token (0600, this user)
 *   SR_DESIGN_BRIDGE_SPOOL       default /srv/sr-design-bridge
 *
 * Output: fixed codes and job ids only. Exit 0 = done (or nothing to do),
 * 3 = stopped (configuration, auth, API or spool), 2 = usage.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError, readTokenFile, runBridgeOnce } from "../../lib/design-agent/bridge/client";
import { bridgeSpool } from "../../lib/design-agent/bridge/spool";

process.umask(0o077);

const say = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--once") {
    process.stderr.write("usage: bridge.ts --once\n");
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
  let report;
  try {
    report = await runBridgeOnce({
      spool: bridgeSpool(process.env.SR_DESIGN_BRIDGE_SPOOL ?? undefined),
      stateDir: join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "sr-design-bridge"),
      apiUrl,
      token,
      log: say,
    });
  } catch (error) {
    say(`stopped: ${error instanceof BridgeError ? error.code : "BRIDGE_SPOOL_INVALID"}`);
    return 3;
  }
  say(
    `bridge: delivered ${report.delivered.length}, superseded ${report.superseded.length}, refused ${report.refused.length}, expired ${report.expired.length}, claimed ${report.claimed ?? (report.workerIdle ? "none (BRIDGE_WORKER_IDLE)" : "none")}`,
  );
  return report.stopped ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  () => {
    say("stopped: BRIDGE_INTERNAL_ERROR");
    process.exit(3);
  },
);
