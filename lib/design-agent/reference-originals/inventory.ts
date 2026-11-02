/**
 * DEV-154 (Issue #193): which success-case pictures exist where. Pure: the caller reads the manifest and hashes the
 * files that are in the repository; this module only classifies.
 *
 * Each recorded picture has a kind, kept apart (Issue #193: original vs derivative vs text only):
 *   original            the adopted picture itself (a full-page PNG, a concept PNG)
 *   registered_preview  a WebP the registration made from an original (CP-001..003 are in the repository as these)
 *   comparison          a side-by-side or before/after sheet made for review, not a design
 *   superseded          an earlier version the adopted one replaced (first concept, the B draft before polishing ...)
 *   rejected            a version the owner rejected or did not prefer (a counter-example)
 *
 * Three states per case, never guessed:
 *   preview_in_repo     a registered preview is in this repository and its SHA-256 equals the recorded one
 *                       (the original PNG itself is not here; the preview is derived from it)
 *   recorded_sha_only   SHA-256s of the case's pictures are recorded, but no bytes are here
 *   metadata_only       no picture's SHA-256 is recorded at all (CP-026..032: "original_binary_unverified")
 *
 * The repository is public, so this lane never asks for an original to be committed (a test fails if one is).
 */

export type ManifestRecord = Record<string, unknown> & { id: string };
export type RepoFile = { path: string; sha256: string };

export type PictureKind = "original" | "registered_preview" | "comparison" | "superseded" | "rejected";

export type OriginalRef = {
  /** The manifest key that records this SHA-256 (e.g. desktop_original_png_sha256). */
  key: string;
  sha256: string;
  kind: PictureKind;
  /** What the key says the picture shows; "other" when the key names neither a view nor a concept. */
  view: "desktop" | "mobile" | "concept" | "other";
  /** The repository path when the bytes are here and match (only registered previews are ever here). */
  in_repo_path: string | null;
};

export type CaseInventory = {
  id: string;
  title: string;
  status: string;
  /** What kind of thing the success is, from the manifest (static concept image vs a Web PoC capture). */
  form: "static_concept_image" | "web_poc_capture" | "unknown";
  state: "preview_in_repo" | "recorded_sha_only" | "metadata_only";
  /** Whether a desktop / mobile picture of the adopted version (original or its preview) is recorded. */
  has_desktop: boolean;
  has_mobile: boolean;
  originals: OriginalRef[];
};

const SHA = /^[0-9a-f]{64}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function formOf(r: ManifestRecord): CaseInventory["form"] {
  const v = `${str(r.view)} ${str(r.source_kind)}`.toLowerCase();
  if (/poc|html/.test(v)) return "web_poc_capture";
  if (/concept|image/.test(v)) return "static_concept_image";
  return "unknown";
}

/**
 * Keys that hold a picture's SHA-256. Archives, HTML (including the offline preview pages of CP-015 / CP-024,
 * `*offline_preview*`), sources and git blobs are not pictures.
 */
export function isPictureKey(key: string): boolean {
  const k = key.toLowerCase();
  if (!k.endsWith("sha256")) return false;
  return !/(archive|zip|html|blob|source|offline_preview)/.test(k);
}

export function kindOf(key: string): PictureKind {
  const k = key.toLowerCase();
  if (/(reject|not_preferred)/.test(k)) return "rejected";
  if (k === "webp_sha256" || /(^|_)webp_sha256$/.test(k)) return "registered_preview";
  if (/(comparison|before_after|visual_reference)/.test(k)) return "comparison";
  if (/(^first_|original_b_|original_reference)/.test(k)) return "superseded";
  return "original";
}

function viewOf(key: string, form: CaseInventory["form"]): OriginalRef["view"] {
  const k = key.toLowerCase();
  // the generic keys of CP-001..003 name no view: a Web PoC's is its desktop capture, a static concept's is the concept
  if (k === "webp_sha256" || k === "original_png_sha256") return form === "web_poc_capture" ? "desktop" : "concept";
  if (/(^|_)(desktop|pc|1440)(_|$)/.test(k)) return "desktop";
  if (/(^|_)(mobile|sp|390)(_|$)/.test(k)) return "mobile";
  if (/(concept|hero|design|direction|reference|approved_v|selected|first_|polished|original_b|visual)/.test(k)) return "concept";
  return "other";
}

export function inventoryCase(r: ManifestRecord, files: readonly RepoFile[]): CaseInventory {
  const byPath = new Map(files.map((f) => [f.path, f.sha256]));
  const previewPaths: Record<string, string> = {};
  if (str(r.preview)) previewPaths.webp_sha256 = `design-library/success-cases/${str(r.preview)}`;
  if (str(r.mobile_preview)) previewPaths.mobile_webp_sha256 = `design-library/success-cases/${str(r.mobile_preview)}`;
  const form = formOf(r);
  const originals: OriginalRef[] = [];
  for (const [key, value] of Object.entries(r)) {
    if (!isPictureKey(key) || typeof value !== "string" || !SHA.test(value)) continue;
    const path = previewPaths[key] ?? null;
    const inRepo = path !== null && byPath.get(path) === value ? path : null;
    // the in-repo previews name no view in their key; their paths do. A Web PoC's `preview_webp` is its desktop preview
    // (CP-007 / CP-009 `*_desktop_preview.webp`).
    const view = key === "mobile_webp_sha256" ? "mobile" : key === "preview_webp_sha256" && form === "web_poc_capture" ? "desktop" : viewOf(key, form);
    originals.push({ key, sha256: value, kind: kindOf(key), view, in_repo_path: inRepo });
  }
  originals.sort((a, b) => a.key.localeCompare(b.key));
  const adopted = originals.filter((o) => o.kind === "original" || o.kind === "registered_preview");
  const state: CaseInventory["state"] = adopted.some((o) => o.in_repo_path) ? "preview_in_repo" : originals.length ? "recorded_sha_only" : "metadata_only";
  return {
    id: r.id,
    title: str(r.title),
    status: str(r.status),
    form,
    state,
    has_desktop: adopted.some((o) => o.view === "desktop"),
    has_mobile: adopted.some((o) => o.view === "mobile"),
    originals,
  };
}

export type Inventory = {
  schema: "success_originals_inventory_v1";
  manifest_sha256: string;
  counts: { cases: number; preview_in_repo: number; recorded_sha_only: number; metadata_only: number; with_desktop_and_mobile: number; originals_in_repo: number };
  repo_files: RepoFile[];
  cases: CaseInventory[];
  note: string;
};

export function buildInventory(o: { manifestSha256: string; records: readonly ManifestRecord[]; files: readonly RepoFile[] }): Inventory {
  const cases = o.records.map((r) => inventoryCase(r, o.files)).sort((a, b) => a.id.localeCompare(b.id));
  const n = (s: CaseInventory["state"]) => cases.filter((c) => c.state === s).length;
  return {
    schema: "success_originals_inventory_v1",
    manifest_sha256: o.manifestSha256,
    counts: {
      cases: cases.length,
      preview_in_repo: n("preview_in_repo"),
      recorded_sha_only: n("recorded_sha_only"),
      metadata_only: n("metadata_only"),
      with_desktop_and_mobile: cases.filter((c) => c.has_desktop && c.has_mobile).length,
      originals_in_repo: cases.flatMap((c) => c.originals).filter((x) => x.kind !== "registered_preview" && x.in_repo_path).length,
    },
    repo_files: [...o.files].sort((a, b) => a.path.localeCompare(b.path)),
    cases,
    note: "Derived from design-library/success-cases/manifest.json and the image files in this repository. The in-repo files are registered WebP previews derived from the original PNGs, not the originals. A recorded SHA-256 is not the picture: the bytes must be supplied and checked before any analysis cites them. The repository is public: originals are not committed.",
  };
}
