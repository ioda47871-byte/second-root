/**
 * DEV-196r (option C): import a verified demo version package into the LOCAL database and private bucket, as the
 * local operator (service role from the local environment only). Never against a hosted project: a Supabase URL that
 * is not http://127.0.0.1 or http://localhost is refused before anything is read. (Staging needs its own approval.)
 *
 *  1. the package is verified again (readPackage / checkPackageFiles: re-hash and the same server checks);
 *  2. the existing sales_ingest_demo_version (origin manual_import) with a job id derived from the bundle, so a re-run
 *     replays the same version; a `duplicate_bundle` (the same bundle under another job) finds the existing version —
 *     never a second version for the same bundle;
 *  3. each file is uploaded to the private bucket at the version's prefix (an existing object is verified instead of
 *     overwritten), then downloaded again and its sha256 and size compared with the manifest.
 *
 * Prints nothing itself; returns ids and hashes only (never a key).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoVersionPackage } from "./package";

export const DEMO_VERSIONS_BUCKET = "sales-demo-versions";

export class ImportError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Only a local Supabase stack: http://127.0.0.1:<port> or http://localhost:<port>. */
export function assertLocalSupabaseUrl(raw: string | undefined): string {
  let u: URL;
  try {
    u = new URL(raw ?? "");
  } catch {
    throw new ImportError("SUPABASE_URL_INVALID");
  }
  if (u.protocol !== "http:" || !(u.hostname === "127.0.0.1" || u.hostname === "localhost") || u.username || u.password) {
    throw new ImportError("SUPABASE_URL_NOT_LOCAL", "only a local stack (127.0.0.1 / localhost) is allowed");
  }
  return u.origin;
}

/** The job id of a manual import: derived from the bundle, so the same package always replays. */
export function manualImportJobId(bundleSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(bundleSha256)) throw new ImportError("BUNDLE_INVALID");
  return `manual-import-${bundleSha256.slice(0, 48)}`;
}

/** The bucket operations the import needs (the Supabase Storage client in use; a stub in tests). */
export interface PackageStore {
  /** the object's bytes, or null when there is none */
  download(key: string): Promise<Uint8Array | null>;
  /** uploads without overwriting; throws when it fails */
  upload(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export function supabasePackageStore(client: SupabaseClient): PackageStore {
  const bucket = client.storage.from(DEMO_VERSIONS_BUCKET);
  return {
    async download(key) {
      const { data, error } = await bucket.download(key);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async upload(key, bytes, contentType) {
      const { error } = await bucket.upload(key, bytes, { contentType, upsert: false });
      if (error) throw new ImportError("UPLOAD_FAILED", key.split("/").slice(-2).join("/"));
    },
  };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type ImportResult = {
  versionId: string;
  versionNo: number;
  demoId: string;
  bundleSha256: string;
  /** created now, or replayed / found existing */
  created: boolean;
  files: { name: string; sha256: string; bytes: number; uploaded: boolean }[];
};

export async function importPackage(pkg: DemoVersionPackage, o: { client: SupabaseClient; store: PackageStore; demoId: string; workerCommit?: string | null }): Promise<ImportResult> {
  const jobId = manualImportJobId(pkg.bundleSha256);
  const { data, error } = await o.client.rpc("sales_ingest_demo_version", {
    p_demo_id: o.demoId,
    p_generation_job_id: jobId,
    p_parent_version_id: null,
    p_origin: "manual_import",
    p_worker_commit: o.workerCommit ?? null,
    p_direction_sha256: null,
    p_bundle_sha256: pkg.bundleSha256,
    p_manifest: pkg.manifest,
    p_images: [],
    p_validator_result: pkg.validatorResult,
    p_worker_checks: pkg.workerChecks,
    p_structure_descriptor: null,
    p_rights_summary: pkg.rightsSummary,
  });
  let versionId: string;
  let created: boolean;
  if (error) {
    if (!/duplicate_bundle/.test(error.message)) throw new ImportError("INGEST_REFUSED", error.message.split(":")[0]);
    // the same bundle is already a version of this demo (under another job): use it, never make a second one
    const existing = await o.client.from("sales_demo_versions").select("id").eq("demo_id", o.demoId).eq("bundle_sha256", pkg.bundleSha256).maybeSingle();
    if (existing.error || !existing.data) throw new ImportError("DUPLICATE_NOT_FOUND");
    versionId = (existing.data as { id: string }).id;
    created = false;
  } else {
    const r = data as { version_id: string; replayed: boolean };
    versionId = r.version_id;
    created = !r.replayed;
  }
  const row = await o.client.from("sales_demo_versions").select("id, demo_id, version_no, storage_prefix, bundle_sha256").eq("id", versionId).maybeSingle();
  const v = row.data as { id: string; demo_id: string; version_no: number; storage_prefix: string; bundle_sha256: string } | null;
  if (row.error || !v || v.demo_id !== o.demoId || v.bundle_sha256 !== pkg.bundleSha256 || v.storage_prefix !== `v1/${o.demoId}/${v.id}/`) throw new ImportError("VERSION_ROW_MISMATCH");

  const files: ImportResult["files"] = [];
  for (const entry of pkg.manifest.files) {
    const bytes = pkg.files[entry.name]!;
    const key = `${v.storage_prefix}${entry.name}`;
    const before = await o.store.download(key);
    let uploaded = false;
    if (before) {
      if (before.byteLength !== entry.bytes || sha256(before) !== entry.sha256) throw new ImportError("STORED_OBJECT_DIFFERS", entry.name);
    } else {
      await o.store.upload(key, bytes, entry.content_type);
      uploaded = true;
    }
    const after = await o.store.download(key);
    if (!after || after.byteLength !== entry.bytes || sha256(after) !== entry.sha256) throw new ImportError("UPLOAD_NOT_VERIFIED", entry.name);
    files.push({ name: entry.name, sha256: entry.sha256, bytes: entry.bytes, uploaded });
  }
  return { versionId: v.id, versionNo: v.version_no, demoId: o.demoId, bundleSha256: pkg.bundleSha256, created, files };
}
