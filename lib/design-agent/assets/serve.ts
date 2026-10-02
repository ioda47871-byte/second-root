// Serving a job's photos to the local design preview (DEV-029).
//
// The only way a photo reaches a page: GET /design-preview/<runId>/asset/<assetId>.
// Nothing from the URL becomes a path. The run directory names its asset job
// (assets.json); the asset id must be a well-formed PublicAssetId listed in
// that job's manifest; readVerifiedAsset (read.ts) does the rest: allowed for
// the local preview, path from the manifest's own file name, no link, same
// inode, a PNG of the manifest's size and hash.
// Reference screenshots live elsewhere and have no route at all.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUN_ID } from "../preview";
import { assetStoreRoot, checkStoreRoot, loadManifest } from "./intake";
import { findAsset, JOB_ID, type AssetManifest } from "./manifest";
import { readVerifiedAsset } from "./read";
import { toPublicAssetId, type PublicAssetId } from "./types";

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
  return asset ? readVerifiedAsset(run.store, run.jobId, asset, "local_preview") : null;
}
