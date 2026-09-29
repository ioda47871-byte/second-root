// Checks on reference screenshots before they reach Codex (DEV-028 worker):
// count, extension, real file type (magic bytes), size, owner, permissions,
// and no symbolic links.
import { lstat, open } from "node:fs/promises";
import { basename, extname } from "node:path";

export const MAX_REFERENCES = 6;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  ".png": (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".jpg": (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  ".jpeg": (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  ".webp": (h) => h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP",
};

export type ImageProblem = "COUNT" | "TYPE" | "SIGNATURE" | "SIZE" | "SYMLINK" | "NOT_FILE" | "OWNER" | "MODE" | "NAME";

export async function checkReferenceImages(paths: readonly string[], uid: number | undefined = process.getuid?.()): Promise<ImageProblem | null> {
  if (paths.length === 0 || paths.length > MAX_REFERENCES) return "COUNT";
  for (const path of paths) {
    if (!/^[A-Za-z0-9._-]+$/.test(basename(path))) return "NAME";
    const check = SIGNATURES[extname(path).toLowerCase()];
    if (!check) return "TYPE";
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "SYMLINK";
    if (!info.isFile()) return "NOT_FILE";
    if (info.size === 0 || info.size > MAX_IMAGE_BYTES) return "SIZE";
    if (uid !== undefined && info.uid !== uid) return "OWNER";
    if ((info.mode & 0o077) !== 0) return "MODE";
    const handle = await open(path, "r");
    try {
      const head = Buffer.alloc(12);
      await handle.read(head, 0, 12, 0);
      if (!check(head)) return "SIGNATURE";
    } finally {
      await handle.close();
    }
  }
  return null;
}
