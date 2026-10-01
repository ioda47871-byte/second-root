/**
 * Instagram capture helper entry (DEV-028 Phase 3). Started by run.sh from
 * the sr-capture systemd service, as sr-igcapture only. Processes the spool
 * (lib/design-agent/capture-helper/helper.ts) and prints codes only.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { currentProfileEnv, DEFAULT_PROFILE_DIR, ProfileError } from "../../lib/design-agent/browser/profile";
import type { LaunchPersistent } from "../../lib/design-agent/browser/session";
import { cleanWorkRoot, HelperError, runCaptureHelper } from "../../lib/design-agent/capture-helper/helper";
import { SPOOL_ROOT } from "../../lib/design-agent/capture-helper/spool";

const REPO = resolve(__dirname, "../..");
process.umask(0o027);
const say = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

const launchPersistent: LaunchPersistent = (dir, options) =>
  chromium.launchPersistentContext(dir, {
    ...options,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: "chromium" }),
  });

async function main(): Promise<number> {
  const env = currentProfileEnv(REPO);
  if (env.user !== env.expectedUser) {
    say("WRONG_USER");
    return 2;
  }
  const workRoot = join(homedir(), ".local", "share", "sr-capture-work");
  await cleanWorkRoot(workRoot);
  const run = await runCaptureHelper({
    spoolRoot: SPOOL_ROOT,
    profileDir: DEFAULT_PROFILE_DIR,
    stateDir: join(homedir(), ".local", "state", "sr-capture"),
    workRoot,
    env,
    launchPersistent,
    log: say,
    // run.sh: the host lets the requester become another user (host-check.sh); the profile stays closed
    ...(process.env.SR_CAPTURE_HOST_UNSAFE ? { hostUnsafe: process.env.SR_CAPTURE_HOST_UNSAFE } : {}),
  });
  say(`done: ${run.processed.length} answered, ${run.deferred} deferred, ${run.removedResults} old result(s) removed`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    say(error instanceof HelperError || error instanceof ProfileError ? error.code : "HELPER_FAILED");
    process.exit(2);
  },
);
