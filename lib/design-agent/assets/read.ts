// Reading one photo out of the design asset store (DEV-029), for the local
// preview's asset route and for the copies Codex is given. One code path for
// both: the asset must be in the manifest and allowed for the use; the path is
// built from the store, the job id and the manifest's own file name only; the
// job directory and the file must not be links; the file is opened without
// following a link and must be the same inode that was checked; it must be a
// PNG of the manifest's size and hash.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { assetUsableIn, JOB_ID, type AssetRecord, type ConsentScope } from "./manifest";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** Width and height from a PNG's IHDR, or null. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The checked PNG bytes of one asset, or null for anything not allowed or not as recorded. */
export async function readVerifiedAsset(store: string, jobId: string, asset: AssetRecord, scope: ConsentScope): Promise<Buffer | null> {
  if (!JOB_ID.test(jobId) || !assetUsableIn(asset, scope) || asset.file !== `${asset.assetId}.png`) return null;
  const jobDir = join(store, jobId);
  const path = join(jobDir, asset.file);
  try {
    const dirInfo = await lstat(jobDir);
    const info = await lstat(path);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || info.isSymbolicLink() || !info.isFile() || info.size > MAX_ASSET_BYTES) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || !opened.isFile()) return null;
      const bytes = await handle.readFile();
      const size = pngSize(bytes);
      if (!size || size.width !== asset.width || size.height !== asset.height || bytes.length !== asset.bytes) return null;
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) return null;
      return bytes;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
