/**
 * The dedicated Instagram browser profile of the design worker (DEV-028).
 *
 * A persistent Chromium profile that holds one Instagram sign-in, made by a
 * person once (`sales:design-browser login`). It is treated as the most
 * sensitive local credential on the worker user:
 *
 * - only inside the home of its own Linux user, `sr-igcapture` (not the
 *   worker / Codex / Claude user: they cannot read it at all, by Unix
 *   permissions; they ask the capture helper for privacy-processed PNGs,
 *   see capture-helper/), never in the repository, never under
 *   /mnt (Windows drives), never a link, directory 0700 and every entry owned
 *   by this user without group / other permissions (tightened after each use);
 * - never exported, copied, archived or read as cookies by this code: only
 *   Chromium itself reads it;
 * - its path is never put into a child's environment, a log line or a report
 *   (Codex never sees it).
 */
import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** The only Linux user that may hold and use the signed-in browser profile. */
export const BROWSER_USER = "sr-igcapture";
export const DEFAULT_PROFILE_DIR = join(homedir(), ".local", "share", "sr-instagram-browser");
/** Chromium's own lock links at the top of a profile (created while it runs). */
const CHROMIUM_LINKS = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "RunningChromeVersion"]);
const MAX_ENTRIES = 200_000;

export type ProfileProblem =
  | "WRONG_USER"
  | "PROFILE_NOT_ABSOLUTE"
  | "PROFILE_IN_REPO"
  | "PROFILE_ON_WINDOWS_DRIVE"
  | "PROFILE_OUTSIDE_HOME"
  | "PROFILE_IS_LINK"
  | "PROFILE_NOT_DIRECTORY"
  | "PROFILE_WRONG_OWNER"
  | "PROFILE_UNSAFE_ENTRY";

export class ProfileError extends Error {
  constructor(readonly code: ProfileProblem) {
    super(code);
  }
}

export type ProfileEnv = { repoDir: string; home: string; uid: number | undefined; user: string; expectedUser: string };

export function currentProfileEnv(repoDir: string): ProfileEnv {
  return { repoDir, home: homedir(), uid: process.getuid?.(), user: userInfo().username, expectedUser: BROWSER_USER };
}

const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The real path the profile would have: the nearest existing ancestor with
 * its links resolved, plus the parts that do not exist yet.
 */
async function realTarget(dir: string): Promise<string> {
  const parts: string[] = [];
  let current = resolve(dir, "..");
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return join(real, ...parts.reverse(), resolve(dir).split(sep).pop() ?? "");
    const up = resolve(current, "..");
    if (up === current) return resolve(dir);
    parts.push(current.split(sep).pop() ?? "");
    current = up;
  }
}

/** Where the profile may live. Checked on the real path (links resolved) of its ancestors. */
export async function checkProfileLocation(dir: string, env: ProfileEnv): Promise<void> {
  if (env.user !== env.expectedUser) throw new ProfileError("WRONG_USER");
  if (!dir.startsWith("/")) throw new ProfileError("PROFILE_NOT_ABSOLUTE");
  const target = await realTarget(dir);
  const repoReal = await realpath(env.repoDir).catch(() => env.repoDir);
  const homeReal = await realpath(env.home).catch(() => env.home);
  if (within(repoReal, target) || within(env.repoDir, resolve(dir))) throw new ProfileError("PROFILE_IN_REPO");
  if (/^\/mnt\//.test(target) || /^\/mnt\//.test(resolve(dir))) throw new ProfileError("PROFILE_ON_WINDOWS_DRIVE");
  if (!within(homeReal, target) || target === homeReal) throw new ProfileError("PROFILE_OUTSIDE_HOME");
}

/** Creates the profile directory (0700) if missing, then checks it. */
export async function prepareProfileDir(dir: string, env: ProfileEnv): Promise<void> {
  await checkProfileLocation(dir, env);
  const existing = await lstat(dir).catch(() => null);
  if (!existing) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Again now that every ancestor exists (a linked ancestor cannot slip through).
    await checkProfileLocation(dir, env);
  }
  await checkProfileTree(dir, env, { tighten: true });
}

/**
 * Checks every entry: owned by this user, no links except Chromium's own
 * lock links at the top. With `tighten`, removes group / other permissions
 * (files 0600-ish, directories 0700-ish) without following links.
 */
export async function checkProfileTree(dir: string, env: ProfileEnv, options: { tighten: boolean }): Promise<void> {
  const top = await lstat(dir).catch(() => null);
  if (!top) throw new ProfileError("PROFILE_NOT_DIRECTORY");
  if (top.isSymbolicLink()) throw new ProfileError("PROFILE_IS_LINK");
  if (!top.isDirectory()) throw new ProfileError("PROFILE_NOT_DIRECTORY");
  if (env.uid !== undefined && top.uid !== env.uid) throw new ProfileError("PROFILE_WRONG_OWNER");
  if ((top.mode & 0o077) !== 0) {
    if (!options.tighten) throw new ProfileError("PROFILE_UNSAFE_ENTRY");
    await chmod(dir, top.mode & 0o700);
  }
  // Walked by hand: links are never followed, and the count is checked as we go.
  const pending: string[] = [dir];
  let seen = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    // A folder that cannot be read cannot be checked: refuse rather than skip it.
    const entries = await readdir(current, { withFileTypes: true }).catch(() => {
      throw new ProfileError("PROFILE_UNSAFE_ENTRY");
    });
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_ENTRIES) throw new ProfileError("PROFILE_UNSAFE_ENTRY");
      const path = join(current, entry.name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue; // Chromium removed it meanwhile
      if (env.uid !== undefined && info.uid !== env.uid) throw new ProfileError("PROFILE_WRONG_OWNER");
      if (info.isSymbolicLink()) {
        if (current !== dir || !CHROMIUM_LINKS.has(entry.name)) throw new ProfileError("PROFILE_UNSAFE_ENTRY");
        continue;
      }
      if ((info.mode & 0o077) !== 0) {
        if (!options.tighten) throw new ProfileError("PROFILE_UNSAFE_ENTRY");
        await chmod(path, info.mode & 0o700);
      }
      if (info.isDirectory()) pending.push(path);
    }
  }
}

export const CAPTURE_KEEP_MS = 24 * 60 * 60 * 1000;
const CAPTURE_DIR = /^[0-9]{8}T[0-9]{6}Z$/;

/** Removes capture folders (named by time) older than a day. Nothing else is touched. */
export async function purgeOldCaptures(root: string, now: Date = new Date()): Promise<number> {
  let removed = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!CAPTURE_DIR.test(name)) continue;
    const path = join(root, name);
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || now.getTime() - info.mtimeMs <= CAPTURE_KEEP_MS) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Chromium options shared by login and capture. The same full Chromium in
 * both, and the basic password store, so the session written while signing in
 * is readable by the headless capture (no desktop keyring on WSL).
 */
export const PERSISTENT_ARGS = ["--password-store=basic", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"];
