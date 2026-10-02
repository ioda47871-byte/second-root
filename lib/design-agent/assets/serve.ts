// Serving a job's photos to the local design preview (DEV-029).
//
// The only way a photo reaches a page: GET /design-preview/<runId>/asset/<assetId>.
// Nothing from the URL becomes a path. The run directory names its asset job
// (assets.json); the asset id must be a well-formed PublicAssetId listed in
// that job's manifest, allowed for the local preview; the file path is built
// from the store root, the job id and the manifest's own file name. The file
// must be a plain file (no link), a PNG, and match the manifest's hash.
// Reference screenshots live elsewhere and have no route at all.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUN_ID } from "../preview";
import { assetStoreRoot, checkStoreRoot, loadManifest } from "./intake";
import { assetUsableIn, findAsset, JOB_ID, type AssetManifest } from "./manifest";
import { toPublicAssetId, type PublicAssetId } from "./types";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** The asset job a run uses: `{ "jobId": "..." }` in the run directory, or null. */
export async function runAssetJob(runDir: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(join(runDir, "assets.json"), "utf8")) as { jobId?: unknown };
    return typeof value.jobId === "string" && JOB_ID.test(value.jobId) && Object.keys(value).length === 1 ? value.jobId : null;
  } catch {
    return null;
  }
}

/** The store and manifest of a run's asset job, when the store is in a safe place. */
export async function runAssets(runDir: string, options: { env: Record<string, string | undefined>; repoDir: string }): Promise<{ store: string; jobId: string; manifest: AssetManifest } | null> {
  const jobId = await runAssetJob(runDir);
  if (!jobId) return null;
  const store = assetStoreRoot(options.env);
  if (!checkStoreRoot(store, { repoDir: options.repoDir, env: options.env })) return null;
  const manifest = await loadManifest(store, jobId);
  return manifest ? { store, jobId, manifest } : null;
}

export function previewAssetUrl(runId: string, id: PublicAssetId): string {
  return `/design-preview/${runId}/asset/${id}`;
}

/** The PNG bytes of one asset for the local preview, or null for anything not allowed. */
export async function readPreviewAsset(o: { previewRoot: string; runId: string; assetId: string; env: Record<string, string | undefined>; repoDir: string }): Promise<Buffer | null> {
  if (!RUN_ID.test(o.runId)) return null;
  const id = toPublicAssetId(o.assetId);
  if (!id) return null;
  const run = await runAssets(join(o.previewRoot, o.runId), { env: o.env, repoDir: o.repoDir });
  if (!run) return null;
  const asset = findAsset(run.manifest, id);
  if (!asset || !assetUsableIn(asset, "local_preview")) return null;

  const jobDir = join(run.store, run.jobId);
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
      if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) return null;
      return bytes;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
