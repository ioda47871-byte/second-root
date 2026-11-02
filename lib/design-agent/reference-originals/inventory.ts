/**
 * DEV-154 (Issue #193): which success-case originals exist where. Pure: the caller reads the manifest and hashes the
 * files that are in the repository; this module only classifies.
 *
 * Three states per case, never guessed:
 *   in_repo            an image file is in this repository and its SHA-256 equals the one the manifest records
 *   recorded_sha_only  the manifest records the SHA-256 of an original, but the bytes are not here
 *                      (kept in the owner's ChatGPT archive; they can be checked against the SHA when supplied)
 *   metadata_only      no original's SHA-256 is recorded at all (CP-026..032: "original_binary_unverified")
 *
 * The repository is public, so this lane never asks for an original to be committed: an original supplied later is
 * checked against the recorded SHA and only derived records (SHA, size, measured features, a written analysis) are kept.
 */

export type ManifestRecord = Record<string, unknown> & { id: string };
export type RepoFile = { path: string; sha256: string };

export type OriginalRef = {
  /** The manifest key that records this SHA-256 (e.g. desktop_original_png_sha256). */
  key: string;
  sha256: string;
  /** What the key says the picture is; "other" when the key names neither a view nor a concept. */
  view: "desktop" | "mobile" | "concept" | "other";
  /** A rejected or superseded version, kept as a counter-example (never a success reference). */
  rejected: boolean;
  /** The repository path when the bytes are here and match. */
  in_repo_path: string | null;
};

export type CaseInventory = {
  id: string;
  title: string;
  status: string;
  /** What kind of thing the success is, from the manifest (static concept image vs a Web PoC capture). */
  form: "static_concept_image" | "web_poc_capture" | "unknown";
  state: "in_repo" | "recorded_sha_only" | "metadata_only";
  has_desktop: boolean;
  has_mobile: boolean;
  originals: OriginalRef[];
};

const SHA = /^[0-9a-f]{64}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function viewOf(key: string, form: CaseInventory["form"]): OriginalRef["view"] {
  const k = key.toLowerCase();
  // the generic keys of CP-001..003 name no view: a Web PoC's is its desktop capture, a static concept's is the concept
  if (k === "webp_sha256" || k === "original_png_sha256") return form === "web_poc_capture" ? "desktop" : "concept";
  if (/(^|_)(desktop|pc|1440)(_|$)/.test(k)) return "desktop";
  if (/(^|_)(mobile|sp|390)(_|$)/.test(k)) return "mobile";
  if (/(concept|hero|design|direction|reference|approved_v|selected|first_|polished|original_b|visual)/.test(k)) return "concept";
  return "other";
}

function formOf(r: ManifestRecord): CaseInventory["form"] {
  const v = `${str(r.view)} ${str(r.source_kind)}`.toLowerCase();
  if (/poc|html/.test(v)) return "web_poc_capture";
  if (/concept|image/.test(v)) return "static_concept_image";
  return "unknown";
}

/** Keys that hold a picture's SHA-256 (archives, HTML sources and notes are not pictures). */
function isPictureKey(key: string): boolean {
  const k = key.toLowerCase();
  if (!k.endsWith("sha256")) return false;
  return !/(archive|zip|html|blob|source|note)/.test(k);
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
    // the in-repo previews are views of the page; their manifest keys do not name the view, the paths do
    const view = key === "mobile_webp_sha256" ? "mobile" : viewOf(key, form);
    originals.push({ key, sha256: value, view, rejected: /(reject|not_preferred)/.test(key), in_repo_path: inRepo });
  }
  originals.sort((a, b) => a.key.localeCompare(b.key));
  const usable = originals.filter((o) => !o.rejected);
  const state: CaseInventory["state"] = usable.some((o) => o.in_repo_path) ? "in_repo" : usable.length ? "recorded_sha_only" : "metadata_only";
  return {
    id: r.id,
    title: str(r.title),
    status: str(r.status),
    form,
    state,
    has_desktop: usable.some((o) => o.view === "desktop"),
    has_mobile: usable.some((o) => o.view === "mobile"),
    originals,
  };
}

export type Inventory = {
  schema: "success_originals_inventory_v0";
  manifest_sha256: string;
  counts: { cases: number; in_repo: number; recorded_sha_only: number; metadata_only: number; with_desktop_and_mobile: number };
  repo_files: RepoFile[];
  cases: CaseInventory[];
  note: string;
};

export function buildInventory(o: { manifestSha256: string; records: readonly ManifestRecord[]; files: readonly RepoFile[] }): Inventory {
  const cases = o.records.map((r) => inventoryCase(r, o.files)).sort((a, b) => a.id.localeCompare(b.id));
  const n = (s: CaseInventory["state"]) => cases.filter((c) => c.state === s).length;
  return {
    schema: "success_originals_inventory_v0",
    manifest_sha256: o.manifestSha256,
    counts: {
      cases: cases.length,
      in_repo: n("in_repo"),
      recorded_sha_only: n("recorded_sha_only"),
      metadata_only: n("metadata_only"),
      with_desktop_and_mobile: cases.filter((c) => c.has_desktop && c.has_mobile).length,
    },
    repo_files: [...o.files].sort((a, b) => a.path.localeCompare(b.path)),
    cases,
    note: "Derived from design-library/success-cases/manifest.json and the image files in this repository. A recorded SHA-256 is not the image: the bytes must be supplied and checked before any analysis cites them. The repository is public: originals are not committed.",
  };
}
