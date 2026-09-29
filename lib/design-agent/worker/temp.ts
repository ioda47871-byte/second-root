// Temporary directories of the design worker (DEV-028 worker).
//
// Each run makes one root `<tmp>/sr-design-worker-XXXXXX` (0700) and points
// TMPDIR at it, so the Instagram screenshots, the browser's throwaway profile
// and Codex's scratch directories all live inside and go with it. Signals and
// `finally` delete it; a run killed with SIGKILL, a WSL shutdown or a reboot
// can leave it behind, so every run first removes stale ones.
//
// Cleanup touches only direct children of the tmp directory whose name has
// the worker's own prefix, that are real directories (not symlinks) and owned
// by this user; of those, a worker root whose holder process is gone is
// removed at once (it may still hold browser caches of the page), anything
// else only when older than TEMP_STALE_MS and not held by a live process.
// Nothing else in /tmp is looked at.
import { rmSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { holderAlive, parseHolder, type Holder } from "./state";

export const TEMP_PREFIX = "sr-design-worker-";
/** Names cleanup may remove: the worker's roots and Codex scratch dirs of the manual CLI. */
export const STALE_TEMP_NAME = /^sr-design-(worker|codex)-[A-Za-z0-9]{6}$/;
export const TEMP_STALE_MS = 6 * 60 * 60 * 1000;
const MARKER = ".sr-design-worker.json";

const active = new Set<string>();

export async function createTempRoot(base: string, holder: Holder): Promise<string> {
  const dir = await mkdtemp(join(base, TEMP_PREFIX));
  active.add(dir);
  await writeFile(join(dir, MARKER), JSON.stringify(holder), { mode: 0o600 });
  return dir;
}

/** For signal handlers: removes this process's temp roots synchronously. */
export function removeActiveTempRootsSync(): void {
  for (const dir of active) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the next run's cleanup takes it */
    }
  }
  active.clear();
}

export async function removeTempRoot(dir: string): Promise<boolean> {
  active.delete(dir);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return lstat(dir).then(
    () => false,
    () => true,
  );
}

export async function cleanStaleTemp(base: string, now: Date, uid: number | undefined = process.getuid?.()): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!STALE_TEMP_NAME.test(name)) continue;
    const path = join(base, name);
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    if (uid !== undefined && info.uid !== uid) continue;
    const holder = parseHolder(await readFile(join(path, MARKER), "utf8").then((t) => JSON.parse(t) as unknown).catch(() => null));
    if (holder && (await holderAlive(holder))) continue;
    if (!holder && now.getTime() - info.mtimeMs < TEMP_STALE_MS) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    removed.push(name);
  }
  return removed;
}
