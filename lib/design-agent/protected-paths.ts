/**
 * What Codex must never see, whatever the sandbox's general rules hide
 * (sandbox.ts checks each one with its probe before every Codex call, and
 * hides one that lies outside the usual hidden areas). Listed here, apart
 * from the worker, so the worker's own code never names the browser profile.
 */
import { join } from "node:path";
import { assetStoreRoot } from "./assets/store-root";
import { DEFAULT_PROFILE_DIR } from "./browser/profile";

/** The capture user's home and the capture spool (capture-helper.ts). */
export const CAPTURE_USER_HOME = "/home/sr-igcapture";
export const CAPTURE_SPOOL = "/srv/sr-capture";

export function workerProtectedPaths(options: { stateDir: string; queueRoot: string; outRoot: string; env: Record<string, string | undefined> }): string[] {
  const home = options.env.HOME ?? "/nonexistent";
  return [
    DEFAULT_PROFILE_DIR,
    join(home, ".local", "share", "sr-instagram-browser"),
    CAPTURE_USER_HOME,
    CAPTURE_SPOOL,
    join(home, ".config", "sr-design-worker"),
    join(home, ".ssh"),
    join(home, ".git-credentials"),
    join(home, ".config", "gh"),
    join(home, ".claude"),
    options.stateDir,
    options.queueRoot,
    options.outRoot,
    // The design asset store (DEV-029), wherever SR_DESIGN_ASSETS_ROOT puts it: Codex gets checked copies only.
    assetStoreRoot(options.env),
    "/mnt/c",
  ];
}
