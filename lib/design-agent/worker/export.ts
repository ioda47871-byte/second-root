// Best-effort copy of a finished run to a folder the person can open from
// Windows (DEV-028 worker). The Linux run directory stays the record; a
// missing /mnt/c, an unwritable Desktop or any copy error never changes the
// job's outcome. Only the allowlisted files are copied, never the Instagram
// reference screenshots (they are not in the run directory at all).
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type WindowsCopy = "success" | "unavailable" | "failed";

const FIXED = ["before-desktop.png", "before-mobile.png", "after-desktop.png", "after-mobile.png", "final.json"];
const REVIEW = /^review-candidate-[0-9]{1,2}\.json$/;

export async function exportFiles(runDir: string): Promise<string[]> {
  const names = await readdir(runDir).catch(() => [] as string[]);
  return names.filter((n) => FIXED.includes(n) || REVIEW.test(n)).sort();
}

/** Copies `names` (allowlisted) from runDir to exportDir/<jobId>/. */
export async function copyToWindows(runDir: string, exportDir: string | undefined, jobId: string, names: readonly string[]): Promise<WindowsCopy> {
  if (!exportDir) return "unavailable";
  // The folder may be created, its parent (e.g. the Desktop) must already exist.
  const parent = await lstat(dirname(exportDir)).catch(() => null);
  if (!parent || !parent.isDirectory()) return "unavailable";
  try {
    const target = join(exportDir, jobId);
    await mkdir(target, { recursive: true });
    // Never write through a link someone placed on the Windows side.
    for (const dir of [exportDir, target]) if ((await lstat(dir)).isSymbolicLink()) return "failed";
    for (const name of names) {
      if (!(FIXED.includes(name) || REVIEW.test(name) || name === "report.json")) continue;
      const from = join(runDir, name);
      const info = await lstat(from);
      if (!info.isFile()) continue;
      const to = join(target, name);
      const existing = await lstat(to).catch(() => null);
      if (existing && !existing.isFile()) return "failed";
      await copyFile(from, to);
    }
    return "success";
  } catch {
    return "failed";
  }
}
