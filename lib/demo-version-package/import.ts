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
 * DEV-196s: a package with photos (AI demo pictures, `images`) is imported only into the fictional 輪 demo
 * (RIN_PROSPECT_ID, checked on the demo's row before anything is written); the images go through the existing ingest
 * as its p_images, where the database derives each image's rights status.
 *
 * DEV-199d: before anything is read from or written to the database, the package's copy is checked again on its bytes
 * (checkPackageCopy: re-hash, the existing copy check, the review re-audited with its chain) — a package whose copy is
 * tampered, stale, forged or failed is refused. The computed result (never the package's declared one) is returned
 * as `copy`; a v1 package returns `copy_unreviewed`. No result here is sendable.
 *
 * DEV-199e: the review is also STORED (append-only, lib/sales/copy-review). Before anything is written, every stored
 * review of the shop is read and each round of the package (earlier rounds first) must be appendable: the owner's
 * revise requests come from the owner's store (never the package), copyReviewAppendBlockers runs against all stored
 * reviews of the shop (a round 0 replayed from another package is refused) and checkCopyQualityReview against the
 * stored chain with the page's photo URLs. After the version is ingested and its files verified, the rounds are
 * recorded with sales_record_copy_review and the last one is linked to the version. The facts pack counts as from the
 * facts path only when the trusted facts are given; without them what is stored is never sendable. Nothing here writes
 * an owner decision.
 *
 * DEV-263f: the trusted facts come from the facts store (`factsFromStore`: the shop's CURRENT stored facts pack,
 * sales_demo_facts_packs, registered by the owner — never by this importer). The database records a facts-path check
 * only when the review's facts pack is that stored pack of this demo (sales_check_copy_facts_check_write), so a
 * `trustedFactsPack` given directly (tests) still needs the stored row to count.
 *
 * Prints nothing itself; returns ids and hashes only (never a key).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ownerRevisionsOf, planCopyAppend, type CopyCandidate, type ShopCopyState } from "@/lib/sales/copy-review/gate";
import { CopyStoreError, loadShopCopyState, recordCopyReview, type RecordedCopyReview } from "@/lib/sales/copy-review/store";
import { CSS_NAME, HTML_NAME, photoUrlPaths } from "@/lib/sales/demo-version/manifest";
import { FactsStoreError, loadCurrentFactsPack } from "@/lib/sales/facts-store";
import { precheckStructureFindings, recordStructureFindings, StructureFindingsError } from "@/lib/sales/structure-findings/store";
import { COPY_FACTS_NAME, COPY_RECORD_NAME, COPY_REVIEW_NAME, priorName, type PackageCopyResult } from "./copy";
import { checkPackageCopy, PACKAGE_FORMAT_COPY, PackageError, type DemoVersionPackage } from "./verify";
import { RIN_PROSPECT_ID } from "./seed-rin";

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
  /** DEV-199d: the copy check as computed by this import */
  copy: PackageCopyResult;
  /** DEV-199e: the stored review linked to the version (null for a v1 package: nothing stored, never sendable) */
  storedCopy: RecordedCopyReview | null;
};

const utf8 = (name: string, b: Uint8Array | undefined): string => {
  try {
    if (!b) throw new Error("missing");
    // the exact bytes: a BOM is kept, so the database re-hashes the same text
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new ImportError("COPY_FILE_UNREADABLE", name);
  }
};

/** The rounds of a v2 package (earlier rounds first), as the texts the store keeps. */
function copyCandidates(pkg: DemoVersionPackage, rounds: number): CopyCandidate[] {
  const c = pkg.copyFiles ?? {};
  const factsPack = utf8(COPY_FACTS_NAME, c[COPY_FACTS_NAME]);
  const out: CopyCandidate[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push({
      review: utf8(priorName(i, "review.json"), c[priorName(i, "review.json")]),
      copyRecord: utf8(priorName(i, "copy.json"), c[priorName(i, "copy.json")]),
      factsPack,
      pageHtml: utf8(priorName(i, "index.html"), c[priorName(i, "index.html")]),
      pageCss: utf8(priorName(i, "style.css"), c[priorName(i, "style.css")]),
    });
  }
  out.push({ review: utf8(COPY_REVIEW_NAME, c[COPY_REVIEW_NAME]), copyRecord: utf8(COPY_RECORD_NAME, c[COPY_RECORD_NAME]), factsPack, pageHtml: utf8(HTML_NAME, pkg.files[HTML_NAME]), pageCss: utf8(CSS_NAME, pkg.files[CSS_NAME]) });
  return out;
}

/**
 * PR #262 M1: stores the rounds of a package whose last review honestly failed (no version is linked). Anything the
 * store refuses (a fail already stored, a broken chain) is left as it is: the import is refused either way.
 */
async function recordFailedCopy(client: SupabaseClient, demoId: string, state: ShopCopyState, pkg: DemoVersionPackage, round: number, factsFromFactsPath: boolean): Promise<void> {
  let plan: { candidate: CopyCandidate; gateBlockers: string[] }[];
  try {
    plan = planStore(state, copyCandidates(pkg, round), photoUrlPaths(pkg.manifest));
  } catch {
    return;
  }
  for (const p of plan) {
    try {
      await recordCopyReview(client, { demoId, versionId: null, candidate: p.candidate, gateBlockers: p.gateBlockers, factsFromFactsPath });
    } catch {
      return;
    }
  }
}

/** Each round must be appendable to the store, in order (the later rounds planned on top of the earlier ones). */
function planStore(state: ShopCopyState, candidates: readonly CopyCandidate[], photoUrls: ReadonlySet<string>): { candidate: CopyCandidate; gateBlockers: string[] }[] {
  const s: ShopCopyState = { ...state, reviews: [...state.reviews] };
  return candidates.map((candidate) => {
    const plan = planCopyAppend(s, candidate, photoUrls);
    if (!plan.ok) throw new ImportError("COPY_NOT_APPENDABLE", plan.codes.slice(0, 20).join(","));
    if (!plan.replay) s.reviews.push(plan.row);
    return { candidate, gateBlockers: plan.gateBlockers };
  });
}

/** DEV-263f: the demo's shop's current stored facts pack (its exact text), which must be a row of this demo. */
async function storedFactsPack(client: SupabaseClient, demoId: string): Promise<string> {
  const d = await client.from("sales_demos").select("prospect_id").eq("id", demoId).maybeSingle();
  const prospectId = (d.data as { prospect_id?: unknown } | null)?.prospect_id;
  if (d.error || typeof prospectId !== "string") throw new ImportError("DEMO_NOT_FOUND");
  let cur;
  try {
    cur = await loadCurrentFactsPack(client, prospectId);
  } catch (e) {
    throw new ImportError("FACTS_STORE_UNAVAILABLE", e instanceof FactsStoreError ? e.code : undefined);
  }
  if (!cur) throw new ImportError("FACTS_STORE_EMPTY");
  if (cur.demo_id !== demoId) throw new ImportError("FACTS_STORE_OTHER_DEMO");
  return cur.facts_pack_text;
}

export async function importPackage(
  pkg: DemoVersionPackage,
  o: {
    client: SupabaseClient;
    store: PackageStore;
    demoId: string;
    workerCommit?: string | null;
    /** DEV-199d: the shop's facts pack from the facts path (never from the package); the package's must be the same bytes */
    trustedFactsPack?: string | Uint8Array | null;
    /**
     * DEV-263f: read the trusted facts pack from the facts store (the prospect's current stored facts pack, which must be
     * a row of this demo). Refused before anything is written when there is none. Not with `trustedFactsPack`.
     */
    factsFromStore?: boolean;
    /**
     * DEV-196q: the version's structure findings (spec §7.5, advice only), computed outside this importer
     * ({source, findings, siblingsCompared}). Everything the database would refuse (shape and size, siblings, an
     * existing different record for this bundle's version) is checked before anything is written; stored after the
     * version is. A refusal after that (a race) says so: the version and its copy review stay, without findings.
     */
    structureFindings?: unknown;
  },
): Promise<ImportResult> {
  if (o.structureFindings !== undefined) {
    try {
      await precheckStructureFindings(o.client, { demoId: o.demoId, bundleSha256: pkg.bundleSha256, raw: o.structureFindings });
    } catch (e) {
      throw new ImportError("STRUCTURE_FINDINGS_INVALID", e instanceof StructureFindingsError ? e.code : undefined);
    }
  }
  if (o.factsFromStore && o.trustedFactsPack != null) throw new ImportError("TRUSTED_FACTS_TWICE");
  const trustedFactsPack = o.factsFromStore ? await storedFactsPack(o.client, o.demoId) : (o.trustedFactsPack ?? null);
  const jobId = manualImportJobId(pkg.bundleSha256);
  // DEV-199e: what the store holds for this shop (read only), for the owner's revise requests and the append checks
  let state: ShopCopyState | null = null;
  if (pkg.format === PACKAGE_FORMAT_COPY) {
    try {
      state = await loadShopCopyState(o.client, o.demoId);
    } catch (e) {
      throw new ImportError("COPY_STORE_UNAVAILABLE", e instanceof CopyStoreError ? e.code : undefined);
    }
  }
  // DEV-199d: the copy, recomputed from the package's bytes, before the database is written (throws PackageError)
  let copy: PackageCopyResult;
  try {
    copy = checkPackageCopy(pkg, { trustedFactsPack, ownerRevisions: state ? ownerRevisionsOf(state) : [] });
  } catch (e) {
    // PR #262 M1: an honest failed review is recorded (no version, terminal for its facts content) before the refusal,
    // so the same facts cannot be resubmitted until a review passes. The import is still refused with the same error.
    if (e instanceof PackageError && e.failedCopyRound !== undefined && state) await recordFailedCopy(o.client, o.demoId, state, pkg, e.failedCopyRound, trustedFactsPack != null);
    throw e;
  }
  const toStore = copy.status === "checked" && state ? planStore(state, copyCandidates(pkg, copy.round), photoUrlPaths(pkg.manifest)) : [];
  if (pkg.images.length > 0) {
    // AI demo pictures belong to the fictional 輪 only: the demo must be that prospect's
    const d = await o.client.from("sales_demos").select("prospect_id").eq("id", o.demoId).maybeSingle();
    if (d.error || !d.data || (d.data as { prospect_id: string }).prospect_id !== RIN_PROSPECT_ID) throw new ImportError("AI_DEMO_NOT_ALLOWED");
  }
  const { data, error } = await o.client.rpc("sales_ingest_demo_version", {
    p_demo_id: o.demoId,
    p_generation_job_id: jobId,
    p_parent_version_id: null,
    p_origin: "manual_import",
    p_worker_commit: o.workerCommit ?? null,
    p_direction_sha256: null,
    p_bundle_sha256: pkg.bundleSha256,
    p_manifest: pkg.manifest,
    p_images: pkg.images,
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
  // DEV-199e: store the rounds in order (the database checks the chain again) and link the last one to the version
  let storedCopy: RecordedCopyReview | null = null;
  for (let i = 0; i < toStore.length; i++) {
    const last = i === toStore.length - 1;
    try {
      storedCopy = await recordCopyReview(o.client, {
        demoId: o.demoId,
        versionId: last ? v.id : null,
        candidate: toStore[i]!.candidate,
        gateBlockers: toStore[i]!.gateBlockers,
        factsFromFactsPath: copy.status === "checked" && copy.facts_from_facts_path,
      });
    } catch (e) {
      throw new ImportError("COPY_STORE_REFUSED", e instanceof CopyStoreError ? e.code : undefined);
    }
  }
  if (o.structureFindings !== undefined) {
    try {
      await recordStructureFindings(o.client, v.id, o.structureFindings);
    } catch (e) {
      // only a race gets here (every database rule was checked first); the import itself is complete — re-run to replay
      throw new ImportError("STRUCTURE_FINDINGS_REFUSED", `${e instanceof StructureFindingsError ? e.code : "unknown"}; version ${v.id} and its copy review were stored without structure findings`);
    }
  }
  return { versionId: v.id, versionNo: v.version_no, demoId: o.demoId, bundleSha256: pkg.bundleSha256, created, files, copy, storedCopy };
}
