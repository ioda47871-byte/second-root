import "server-only";
/**
 * DEV-263i (Issue #263): 版を取り込む — the owner brings a reviewed v2 demo version package (built offline by
 * package-local.ts, the same package import-local.ts takes) into the hosted database and the private bucket from the
 * admin screen. No archive is accepted (no zip / tar: nothing to unpack, no archive bomb): the browser sends the
 * package directory's files one by one, in three steps, each a same-origin POST by a signed-in sales admin:
 *
 *   begin    package.json only. Everything that needs no file bytes is checked (v2 format, page manifest, bundle hash,
 *            images and rights summary, validator, copy manifest names / roles / sizes, the request size the finalize
 *            needs) and the target demo's facts (the shop's current stored facts pack, which the demo's content must be
 *            derived from). Writes nothing. Answers which page files are already staged.
 *   put      one page file (html / css / webp / jpeg, at most ARTIFACT_LIMITS.fileBytes), its sha256 declared and
 *            recomputed. Staged in the private bucket at `staging/<sha256>` (content-addressed: the same bytes replay;
 *            an existing object with other bytes is refused, never overwritten). A staged object is not a version and
 *            is never served (the artifact routes read only a version's prefix from the database).
 *   finalize package.json again and the copy files (form parts named by the copy manifest's fixed names; any other part
 *            is refused). Every page file is read back from staging by its manifest sha256; then the package goes
 *            through packageFromSource — the same checks, in the same order, as readPackage — and importPackage with the
 *            facts from the facts store (the same as `import-local.ts --facts-from-store`): the copy, facts, rights and
 *            HTML checks all run before anything is written; the ingest replays the same bundle. Only finalize can
 *            create a version, and only with every file present and verified.
 *
 * Both flags first (SALES_DEMO_VERSIONS_ENABLED and SALES_DEMO_QUALITY_REVIEW_ENABLED; off → refused, nothing read or
 * written). The route (app/admin/sales/demos/[prospectId]/import/route.ts) checks the origin and the admin before
 * calling here, then gives the server's service-role client (the ingest RPCs and the private bucket are service-role
 * only). No verdict is taken from the client: the copy result returned is the one importPackage computed.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_VERSIONS_BUCKET, ImportError, importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { assertDemoContentFromFacts } from "@/lib/demo-version-package/facts-content";
import { LocalInputError } from "@/lib/demo-version-package/local-input-error";
import { checkCopyManifestShape, checkPackageImages, memoryPackageSource, PACKAGE_FORMAT_COPY, PackageError, packageFromSource, packageRightsSummary, type PackageMeta } from "@/lib/demo-version-package/verify";
import { QUALITY_REVIEW_DISABLED_TEXT } from "@/lib/sales/demo-version/admin-messages";
import { demoQualityReviewEnabled, type Env } from "@/lib/sales/demo-version/flags";
import { ARTIFACT_LIMITS, bundleSha256, validateManifest, type ArtifactContentType } from "@/lib/sales/demo-version/manifest";
import { factsPackBytes, FactsStoreError, loadCurrentFactsPack } from "@/lib/sales/facts-store";

export const UPLOAD_LIMITS = {
  /** package.json (meta + manifest + images + the package's local record) */
  packageJsonBytes: 512 * 1024,
  /** one page file per put (the database's and the bucket's per-file limit) */
  putBytes: ARTIFACT_LIMITS.fileBytes,
  /** the whole finalize request (package.json + the copy files + the form's framing), under the host's request limit */
  finalizeBytes: 4 * 1024 * 1024,
  /** room left in the finalize request for the multipart framing */
  finalizeFraming: 64 * 1024,
} as const;

export const STAGING_PREFIX = "staging/";
export const stagingKey = (sha256: string) => `${STAGING_PREFIX}${sha256}`;

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGEABLE: readonly ArtifactContentType[] = ["text/html", "text/css", "image/webp", "image/jpeg"];

export class UploadError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Why a step was refused, in the owner's words (the code is shown beside it). */
export const UPLOAD_REFUSAL_LABEL: Readonly<Record<string, string>> = {
  FEATURE_DISABLED: QUALITY_REVIEW_DISABLED_TEXT,
  INVALID_INPUT: "入力の形が正しくありません。",
  BODY_TOO_LARGE: "送ったデータが大きすぎます。",
  PACKAGE_UNREADABLE: "package.json を読めません。",
  PACKAGE_FORMAT: "包みの形式が違います。",
  PACKAGE_NOT_REVIEWED: "文章の監査が入った包み (v2) だけを取り込めます。",
  MANIFEST_INVALID: "包みの manifest が正しくありません。",
  BUNDLE_MISMATCH: "包みの bundle の hash が合いません。",
  VALIDATOR_NOT_OK: "包みの検査の結果が ok ではありません。",
  IMAGES_INVALID: "包みの画像の記録が manifest と合いません。",
  RIGHTS_SUMMARY_MISMATCH: "包みの権利の要約が画像の記録と合いません。",
  COPY_INVALID: "包みの文章 (copy) の検査に通りません。",
  COPY_TOO_LARGE_FOR_UPLOAD: "文章のファイルの合計が、画面から送れる大きさを超えています。",
  COPY_PART_NOT_IN_MANIFEST: "包みの copy manifest に無いファイルが送られました。",
  FILE_NOT_STAGED: "まだ送られていない頁のファイルがあります。もう一度取り込んでください。",
  FILE_MISSING: "頁のファイルが足りません。",
  FILE_NOT_IN_MANIFEST: "manifest に無い頁のファイルがあります。",
  FILE_CHECK_FAILED: "頁のファイルの検査に通りません。",
  HTML_CHECK_FAILED: "頁の HTML / CSS の安全の検査に通りません。",
  CONTENT_TYPE_NOT_ALLOWED: "この種類のファイルは送れません (HTML・CSS・WebP・JPEG だけ)。",
  FILE_TOO_LARGE: "ファイルが大きすぎます。",
  FILE_FORMAT_MISMATCH: "ファイルの中身が種類と合いません。",
  HASH_MISMATCH: "ファイルの sha256 が合いません。",
  STAGED_OBJECT_DIFFERS: "同じ名前の一時ファイルが別の中身です。取り込めません。",
  STAGING_FAILED: "一時ファイルを置けませんでした。もう一度試してください。",
  DEMO_NOT_FOUND: "この候補のデモがありません。",
  FACTS_STORE_EMPTY: "店舗の事実がまだ登録されていません。先に「店舗の事実の登録」をしてください。",
  FACTS_STORE_OTHER_DEMO: "登録された事実が、このデモのものではありません。",
  FACTS_STORE_UNAVAILABLE: "店舗の事実の保存先を読めません。",
  TRUSTED_FACTS_SHA_MISMATCH: "このデモの事実が、登録した facts pack から作られていません。",
  TRUSTED_FACTS_CONTENT_MISMATCH: "このデモの事実の内容が、登録した facts pack と一致しません。",
  COPY_NOT_APPENDABLE: "文章の監査が、保存済みの監査に続けられません。",
  COPY_STORE_UNAVAILABLE: "文章の監査の保存先を読めません。",
  COPY_STORE_REFUSED: "文章の監査の保存が拒否されました。",
  INGEST_REFUSED: "DB が版の登録を拒否しました。",
  AI_DEMO_NOT_ALLOWED: "AI の写真を含む包みは、このデモには取り込めません。",
  UPLOAD_FAILED: "版のファイルを保存できませんでした。もう一度取り込むと続きから入ります。",
  UPLOAD_NOT_VERIFIED: "保存した版のファイルを確かめられませんでした。もう一度取り込んでください。",
  STORED_OBJECT_DIFFERS: "保存済みの版のファイルが別の中身です。",
  VERSION_ROW_MISMATCH: "版の行が合いません。",
};

export const uploadRefusal = (code: string) => UPLOAD_REFUSAL_LABEL[code] ?? `取り込めません（${code}）。`;

/** The private bucket as the staging needs it (download / upload without overwrite / exists). */
export interface StagingStore extends PackageStore {
  exists(key: string): Promise<boolean>;
}

export function supabaseStagingStore(client: SupabaseClient, base: PackageStore): StagingStore {
  const bucket = client.storage.from(DEMO_VERSIONS_BUCKET);
  return {
    ...base,
    async exists(key) {
      const { data, error } = await bucket.exists(key);
      return !error && data === true;
    },
  };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Reads at most `max` bytes of a request body; refuses (BODY_TOO_LARGE) as soon as the declared length or the bytes
 * read go over, without reading the rest.
 */
export async function readBoundedBody(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > max)) throw new UploadError("BODY_TOO_LARGE");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new UploadError("BODY_TOO_LARGE");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * The request comes from this app's own page: an Origin header whose host is the request's host (X-Forwarded-Host
 * first, as Next's own server-action check), and Sec-Fetch-Site, when sent, `same-origin`. No Origin → refused.
 */
export function sameOriginRequest(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.host;
  } catch {
    return false;
  }
  const expected = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim();
  if (!expected || expected.toLowerCase() !== host.toLowerCase()) return false;
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

/** The page file's bytes look like its type (the full checks run again on finalize). */
function sniff(contentType: ArtifactContentType, b: Uint8Array): boolean {
  if (contentType === "image/webp") return b.byteLength >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if (contentType === "image/jpeg") return b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const max = contentType === "text/html" ? ARTIFACT_LIMITS.htmlBytes : ARTIFACT_LIMITS.cssBytes;
  if (b.byteLength > max || b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

function assertEnabled(env: Env): void {
  if (!demoQualityReviewEnabled(env)) throw new UploadError("FEATURE_DISABLED");
}

/** package.json's text → its parsed value (bounded). */
export function parsePackageJson(text: string): unknown {
  if (Buffer.byteLength(text) > UPLOAD_LIMITS.packageJsonBytes) throw new UploadError("BODY_TOO_LARGE");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UploadError("PACKAGE_UNREADABLE");
  }
}

export type UploadPlan = {
  bundleSha256: string;
  pageFiles: { name: string; sha256: string; bytes: number; contentType: ArtifactContentType }[];
  copyFiles: { name: string; bytes: number }[];
};

/**
 * Everything about a package that needs no file bytes (the checks of packageFromSource that do not read a file, in
 * its order). Only a v2 package (with its copy and review) can be uploaded: a v1 package would only ever be
 * copy_unreviewed. Throws UploadError / PackageError.
 */
export function planUpload(raw: unknown, packageJsonBytes: number): UploadPlan {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new UploadError("PACKAGE_UNREADABLE");
  const meta = raw as PackageMeta;
  if (meta.format !== PACKAGE_FORMAT_COPY) throw new UploadError(typeof meta.format === "string" && meta.format.startsWith("sales_demo_version_package_") ? "PACKAGE_NOT_REVIEWED" : "PACKAGE_FORMAT");
  const m = validateManifest(meta.manifest);
  if (!m.ok) throw new PackageError("MANIFEST_INVALID", m.codes);
  if (bundleSha256(m.manifest) !== meta.bundleSha256) throw new PackageError("BUNDLE_MISMATCH");
  if (meta.validatorResult?.ok !== true) throw new PackageError("VALIDATOR_NOT_OK");
  const images = checkPackageImages(m.manifest, meta.images ?? []);
  if (JSON.stringify(meta.rightsSummary) !== JSON.stringify(packageRightsSummary(images))) throw new PackageError("RIGHTS_SUMMARY_MISMATCH");
  const cm = checkCopyManifestShape(meta.copy);
  const copyTotal = cm.files.reduce((n, f) => n + f.bytes, 0);
  if (packageJsonBytes + copyTotal > UPLOAD_LIMITS.finalizeBytes - UPLOAD_LIMITS.finalizeFraming) throw new UploadError("COPY_TOO_LARGE_FOR_UPLOAD");
  return {
    bundleSha256: meta.bundleSha256,
    pageFiles: m.manifest.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes, contentType: f.content_type })),
    copyFiles: cm.files.map((f) => ({ name: f.name, bytes: f.bytes })),
  };
}

/**
 * The target demo, whose facts come only from the facts store: the shop's current stored facts pack must be a row of
 * this demo and the demo's content must be derived from its exact bytes (the same as import-local --facts-from-store).
 */
export async function demoForUpload(client: SupabaseClient, prospectId: string): Promise<{ demoId: string }> {
  if (!UUID.test(prospectId)) throw new UploadError("INVALID_INPUT");
  const d = await client.from("sales_demos").select("id, content").eq("prospect_id", prospectId).maybeSingle();
  const row = d.data as { id?: unknown; content?: unknown } | null;
  if (d.error || typeof row?.id !== "string") throw new UploadError("DEMO_NOT_FOUND");
  let cur;
  try {
    cur = await loadCurrentFactsPack(client, prospectId);
  } catch {
    throw new UploadError("FACTS_STORE_UNAVAILABLE");
  }
  if (!cur) throw new UploadError("FACTS_STORE_EMPTY");
  if (cur.demo_id !== row.id) throw new UploadError("FACTS_STORE_OTHER_DEMO");
  assertDemoContentFromFacts(row.content, factsPackBytes(cur.facts_pack_text));
  return { demoId: row.id };
}

export type BeginResult = { bundleSha256: string; demoId: string; pageFiles: (UploadPlan["pageFiles"][number] & { staged: boolean })[]; copyFiles: UploadPlan["copyFiles"] };

export async function beginUpload(o: { env: Env; client: SupabaseClient; store: StagingStore; prospectId: string; packageJson: string }): Promise<BeginResult> {
  assertEnabled(o.env);
  const plan = planUpload(parsePackageJson(o.packageJson), Buffer.byteLength(o.packageJson));
  const { demoId } = await demoForUpload(o.client, o.prospectId);
  const pageFiles = [];
  for (const f of plan.pageFiles) pageFiles.push({ ...f, staged: await o.store.exists(stagingKey(f.sha256)) });
  return { bundleSha256: plan.bundleSha256, demoId, pageFiles, copyFiles: plan.copyFiles };
}

export type StageResult = { sha256: string; bytes: number; replayed: boolean };

/** One page file into staging. The declared sha256 must be the bytes' own; the same bytes replay. */
export async function stageFile(o: { env: Env; store: StagingStore; contentType: string; expectedSha256: string; bytes: Uint8Array }): Promise<StageResult> {
  assertEnabled(o.env);
  if (!SHA256.test(o.expectedSha256)) throw new UploadError("INVALID_INPUT");
  const ct = o.contentType.split(";")[0]!.trim().toLowerCase() as ArtifactContentType;
  if (!STAGEABLE.includes(ct)) throw new UploadError("CONTENT_TYPE_NOT_ALLOWED");
  if (o.bytes.byteLength === 0 || o.bytes.byteLength > UPLOAD_LIMITS.putBytes) throw new UploadError("FILE_TOO_LARGE");
  const sha = sha256(o.bytes);
  if (sha !== o.expectedSha256) throw new UploadError("HASH_MISMATCH");
  if (!sniff(ct, o.bytes)) throw new UploadError("FILE_FORMAT_MISMATCH");
  const key = stagingKey(sha);
  const same = (b: Uint8Array | null) => b !== null && b.byteLength === o.bytes.byteLength && sha256(b) === sha;
  const before = await o.store.download(key);
  if (before) {
    if (!same(before)) throw new UploadError("STAGED_OBJECT_DIFFERS");
    return { sha256: sha, bytes: o.bytes.byteLength, replayed: true };
  }
  try {
    await o.store.upload(key, o.bytes, ct);
  } catch {
    // a concurrent put of the same bytes is a replay; anything else is a failure (nothing was overwritten)
    if (same(await o.store.download(key))) return { sha256: sha, bytes: o.bytes.byteLength, replayed: true };
    throw new UploadError("STAGING_FAILED");
  }
  if (!same(await o.store.download(key))) throw new UploadError("STAGING_FAILED");
  return { sha256: sha, bytes: o.bytes.byteLength, replayed: false };
}

export type FinalizeResult = { versionId: string; versionNo: number; created: boolean; bundleSha256: string; copyStatus: string; files: number };

/** The only step that can create a version: every file present and verified, then importPackage (facts from the store). */
export async function finalizeUpload(o: { env: Env; client: SupabaseClient; store: StagingStore; prospectId: string; packageJson: string; copyFiles: ReadonlyMap<string, Uint8Array> }): Promise<FinalizeResult> {
  assertEnabled(o.env);
  const raw = parsePackageJson(o.packageJson);
  const plan = planUpload(raw, Buffer.byteLength(o.packageJson));
  const expected = new Set(plan.copyFiles.map((f) => f.name));
  for (const name of o.copyFiles.keys()) if (!expected.has(name)) throw new UploadError("COPY_PART_NOT_IN_MANIFEST", name.slice(0, 80));
  const { demoId } = await demoForUpload(o.client, o.prospectId);
  const pageFiles: Record<string, Uint8Array> = {};
  for (const f of plan.pageFiles) {
    const bytes = await o.store.download(stagingKey(f.sha256));
    if (!bytes) throw new UploadError("FILE_NOT_STAGED", f.name);
    pageFiles[f.name] = bytes;
  }
  // the same checks, in the same order, as readPackage (re-hash every file, the copy and its review, rights, HTML)
  const pkg = packageFromSource(raw, memoryPackageSource(pageFiles, Object.fromEntries(o.copyFiles)));
  const workerCommit = /^[0-9a-f]{7,40}$/.test(pkg.validatorResult.validator_commit ?? "") ? pkg.validatorResult.validator_commit : null;
  const r = await importPackage(pkg, { client: o.client, store: o.store, demoId, factsFromStore: true, workerCommit });
  return { versionId: r.versionId, versionNo: r.versionNo, created: r.created, bundleSha256: r.bundleSha256, copyStatus: r.copy.status, files: r.files.length };
}

/** Any refusal of the three steps → a fixed code (never a stack, a key or a database message). */
export function uploadErrorCode(e: unknown): string | null {
  if (e instanceof UploadError || e instanceof PackageError || e instanceof ImportError || e instanceof LocalInputError || e instanceof FactsStoreError) return e.code;
  return null;
}
