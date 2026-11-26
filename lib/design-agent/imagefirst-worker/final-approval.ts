/**
 * DEV-364 PR 3a (docs/design/quality-proof-plan.md §3.3, §6 row 3a): the SECOND review and approval — of the finished,
 * photo-included site — after the first approval of the whole-page design (design-approval.ts) and the approved
 * materials (materials-approval.ts). It is what a demo is shown with, or what is delivered. Offline: it reads files and
 * renders a private page; it starts nothing.
 *
 *   sr_final_review_v1    the independent review (another Claude context): ADVICE ONLY, its verdicts decide nothing.
 *     { schema, advice_only: true,
 *       design: { bundle_id, bundle_sha256, review_file, approval_file, approval_sha256 }   (the first approval)
 *       photo_slots_sha256                       (the photo-slot spec sr_photo_slots_v1, bound to the same approval)
 *       materials: [{ asset, class: A | B, sha256, provenance_sha256 }]   (every picture of the site; never C)
 *       build: { files: [{ path, sha256, bytes }], commit? }             (index.html, style.css, assets/*: the site)
 *       captures: { pc: { width: 1440, sha256 }, sp: { width: 390, sha256 } }   (the stage-6 comparison's captures)
 *       impl_compare_sha256                      (the sr_impl_compare_v1 record of that comparison; advice)
 *       composition_change: none | minor | major
 *       axes: the owner's criteria, each { verdict: pass | revise | fail, evidence: [{ image: pc | sp, region, note }] }
 *       reviewer, reviewed_at }
 *   sr_final_approval_v1  { schema, not_owner_signature: true, design_approval_sha256, photo_slots_sha256, materials:
 *                            [{ asset, sha256, provenance_sha256 }], build_files_sha256, captures: { pc, sp },
 *                            impl_compare_sha256, review_sha256, page_sha256, decision: approve | revise | reject,
 *                            decided_at (≥ reviewed_at), note? }
 *                          Claude writes it ONLY when the owner has decided. It records that statement, bound to
 *                          exactly what the owner saw; it is NOT the owner's signature (the field says so).
 *
 * The check recomputes every SHA-256 from the files themselves — the first approval through its own gate
 * (approvedDesignRun), the approved materials through theirs (approvedMaterials), the slot spec (its full strict form),
 * each provenance record (its full strict A / B / C form), the site's files, the comparison record and its captures,
 * the review and the page — so any change makes an earlier approval stale (FINAL_*_MISMATCH).
 *
 * Composition (review #373 M2): the owner's page shows the first-approved PC / SP pictures next to the finished
 * captures, with the comparison's numbers and findings per viewport. A major change routes back to the first approval
 * (a new whole-page design and its approval, not a second approval): when the reviewer says so (composition_change
 * major) and, whatever the reviewer says, when the comparison measured it — COMPOSITION_ROUTE_RULE: the comparison did
 * not compare both viewports (status not "compared", or a viewport's code set), or a viewport's page layout fell below
 * the implementation lane's provisional page SSIM threshold (DEV-131, 0.8: the difference code <PC|SP>_PAGE_LAYOUT, or
 * the number itself; a record whose code and number disagree is refused).
 * The page height is NOT used (the first-approved picture is a condensed overview; its height is expected to differ).
 * The gate refuses that route (FINAL_COMPOSITION_CHANGED).
 *
 * Provenance records (one per picture, in a private folder outside the repository, named <picture sha256>.json; the
 * sr_photo_provenance_v1 form, photo-records.ts): A names the material and the materials approval it came from; B the
 * role, source, permission and facts check; C (a customer's upload) is never part of a Second Root approval
 * (FINAL_MATERIAL_CLASS). A B or C record whose picture is one of the approved materials is refused
 * (FINAL_GENERATED_AS_SHOP: the gate's form of the build's CONTENT_GENERATED_AS_SHOP; exact bytes only).
 *
 * Captures (review #373 L1): they are trusted through the comparison's record.json (the record names their SHA-256s and
 * the site's files it drew). This check does not re-capture the site; re-capturing at delivery is a later step.
 * The provenance folder, the comparison folder and its captures must be ours and private (owner, mode 0700 / 0600),
 * outside the repository, never a link.
 *
 * Failures throw FinalApprovalStop with a fixed code (no path, no content). The first approval's DESIGN_* codes and the
 * materials gate's MATERIALS_* codes pass through unchanged.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { escapeHtml, VIEWING_PAGE_CSP } from "../case-study/case-study";
import { approvedDesignRun, DesignApprovalStop, readRecord, RECORD_MAX_BYTES, type ApprovedDesignRun } from "./design-approval";
import { approvedMaterials, MaterialsApprovalStop, type ApprovedDesignRecords, type ApprovedMaterials } from "./materials-approval";
import { PhotoSlots, Provenance } from "./photo-records";

export const FINAL_REVIEW_SCHEMA = "sr_final_review_v1";
export const FINAL_APPROVAL_SCHEMA = "sr_final_approval_v1";
/** The stage-6 comparison record's schema (impl-compare-approved.ts), named here so this module reads it as data only. */
export const IMPL_COMPARE_RECORD_SCHEMA = "sr_impl_compare_v1";
/** The implementation lane's provisional page SSIM threshold (DEV-131), as its difference code names it. */
export const COMPOSITION_ROUTE_RULE = { pageLayoutCode: /^(?:PC|SP)_PAGE_LAYOUT$/, pageSsim: 0.8 } as const;
/** The owner's criteria (2026-11-26) plus facts, rights and labels, in the plan's order (§3.3 `review`). */
export const FINAL_AXES = [
  "colour_harmony",
  "brightness_legibility",
  "subject_crop",
  "unity",
  "pc_sp_composition",
  "shop_character",
  "originality",
  "no_photo_degradation",
  "composition_kept",
  "facts",
  "rights",
  "labels",
] as const;
export type FinalAxis = (typeof FINAL_AXES)[number];

export const FINAL_APPROVAL_CODES = [
  "FINAL_RECORD_MISSING",
  "FINAL_RECORD_UNSAFE",
  "FINAL_RECORD_TOO_LARGE",
  "FINAL_RECORD_IN_REPO",
  "FINAL_FOLDER_UNSAFE",
  "FINAL_REVIEW_INVALID",
  "FINAL_REVIEW_TEXT_UNSAFE",
  "FINAL_REVIEW_AXIS_MISSING",
  "FINAL_REVIEW_EVIDENCE_MISSING",
  "FINAL_DESIGN_MISMATCH",
  "FINAL_DESIGN_SYNTHETIC",
  "FINAL_SLOTS_INVALID",
  "FINAL_SLOTS_MISMATCH",
  "FINAL_MATERIAL_CLASS",
  "FINAL_MATERIALS_MISMATCH",
  "FINAL_PROVENANCE_MISSING",
  "FINAL_PROVENANCE_INVALID",
  "FINAL_PROVENANCE_MISMATCH",
  "FINAL_GENERATED_AS_SHOP",
  "FINAL_MATERIALS_RECORDS_MISSING",
  "FINAL_MATERIAL_NOT_APPROVED",
  "FINAL_SITE_MISSING",
  "FINAL_SITE_IN_REPO",
  "FINAL_SITE_UNSAFE",
  "FINAL_SITE_INVALID",
  "FINAL_SITE_TOO_LARGE",
  "FINAL_BUILD_MISMATCH",
  "FINAL_IMPL_COMPARE_INVALID",
  "FINAL_IMPL_COMPARE_MISMATCH",
  "FINAL_CAPTURE_MISMATCH",
  "FINAL_APPROVAL_MISSING",
  "FINAL_APPROVAL_INVALID",
  "FINAL_APPROVAL_DESIGN_MISMATCH",
  "FINAL_APPROVAL_SLOTS_MISMATCH",
  "FINAL_APPROVAL_MATERIALS_MISMATCH",
  "FINAL_APPROVAL_BUILD_MISMATCH",
  "FINAL_APPROVAL_CAPTURE_MISMATCH",
  "FINAL_APPROVAL_IMPL_COMPARE_MISMATCH",
  "FINAL_APPROVAL_REVIEW_MISMATCH",
  "FINAL_APPROVAL_PAGE_MISMATCH",
  "FINAL_APPROVAL_BEFORE_REVIEW",
  "FINAL_NOT_APPROVED",
  "FINAL_REVIEW_HAS_FAIL",
  "FINAL_COMPOSITION_CHANGED",
  "FINAL_PAGE_IN_REPO",
  "FINAL_PAGE_DIR_NOT_EMPTY",
  "FINAL_PAGE_DIR_UNSAFE",
] as const;
export type FinalApprovalCode = (typeof FINAL_APPROVAL_CODES)[number];
export class FinalApprovalStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FinalApprovalStop";
  }
}
const stop = (code: FinalApprovalCode): never => {
  throw new FinalApprovalStop(code);
};

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const UTC = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((s) => Number.isFinite(Date.parse(s)), "utc_invalid");
/** One plain line: no control character, line or paragraph separator, markup or link (the design records' rule). */
const SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
const UNSAFE_TEXT = /[\x00-\x1f\x7f]|[<>`]|https?:|ftp:|:\/\/|www\./i;
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0 && s === s.trim() && !UNSAFE_TEXT.test(s) && !SEPARATORS.some((c) => s.includes(c)), "final_text_unsafe");
const REQUEST_ID = z.string().regex(/^req-[a-z0-9][a-z0-9-]{2,58}$/);
const RECORD_NAME = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\.json$/);
const ASSET = z.string().regex(/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$/);
const SITE_FILE = z.union([z.literal("index.html"), z.literal("style.css"), ASSET]);
const DesignRef = z.strictObject({ bundle_id: REQUEST_ID, bundle_sha256: SHA, review_file: RECORD_NAME, approval_file: RECORD_NAME, approval_sha256: SHA });
const Evidence = z.strictObject({ image: z.enum(["pc", "sp"]), region: Text(80), note: Text(300) });
const Axis = z.strictObject({ verdict: z.enum(["pass", "revise", "fail"]), evidence: z.array(Evidence).max(10) });
const Captures = z.strictObject({ pc: z.strictObject({ width: z.literal(1440), sha256: SHA }), sp: z.strictObject({ width: z.literal(390), sha256: SHA }) });

export const FinalReview = z.strictObject({
  schema: z.literal(FINAL_REVIEW_SCHEMA),
  advice_only: z.literal(true),
  design: DesignRef,
  photo_slots_sha256: SHA,
  // every picture of the site, once; a class is A or B (C, a customer's upload, never belongs to this approval)
  materials: z.array(z.strictObject({ asset: ASSET, class: z.string(), sha256: SHA, provenance_sha256: SHA })).max(32),
  build: z.strictObject({ files: z.array(z.strictObject({ path: SITE_FILE, sha256: SHA, bytes: z.number().int().nonnegative() })).min(2).max(34), commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional() }),
  captures: Captures,
  impl_compare_sha256: SHA,
  composition_change: z.enum(["none", "minor", "major"]),
  // every axis is checked by name so a missing one is named (FINAL_REVIEW_AXIS_MISSING)
  axes: z.record(z.string(), z.unknown()),
  reviewer: Text(60),
  reviewed_at: UTC,
});
export type FinalReview = Omit<z.infer<typeof FinalReview>, "axes" | "materials"> & { axes: Record<FinalAxis, z.infer<typeof Axis>>; materials: { asset: string; class: "A" | "B"; sha256: string; provenance_sha256: string }[] };

export const FinalApproval = z.strictObject({
  schema: z.literal(FINAL_APPROVAL_SCHEMA),
  not_owner_signature: z.literal(true),
  design_approval_sha256: SHA,
  photo_slots_sha256: SHA,
  materials: z.array(z.strictObject({ asset: ASSET, sha256: SHA, provenance_sha256: SHA })).max(32),
  build_files_sha256: SHA,
  captures: z.strictObject({ pc: SHA, sp: SHA }),
  impl_compare_sha256: SHA,
  review_sha256: SHA,
  page_sha256: SHA,
  decision: z.enum(["approve", "revise", "reject"]),
  decided_at: UTC,
  note: Text(400).optional(),
});
export type FinalApproval = z.infer<typeof FinalApproval>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const parseJson = (b: Buffer, code: FinalApprovalCode): unknown => {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return stop(code);
  }
};
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** The SHA-256 of a site's file list (path, sha256, bytes; in the reader's order): what the approval binds. */
export const buildFilesSha256 = (files: readonly { path: string; sha256: string; bytes: number }[]) => sha256(JSON.stringify(files.map((f) => [f.path, f.sha256, f.bytes])));

/** A private final record (outside the repository, no link, small): the design module's reader with FINAL_RECORD_* codes. */
async function readFinalRecord(path: string, repo: string): Promise<Buffer> {
  try {
    return await readRecord(path, repo);
  } catch (error) {
    if (error instanceof DesignApprovalStop && error.code.startsWith("DESIGN_RECORD_")) return stop(error.code.replace("DESIGN_", "FINAL_") as FinalApprovalCode);
    throw error;
  }
}

export function parseFinalReview(bytes: Buffer): FinalReview {
  if (bytes.length > RECORD_MAX_BYTES) stop("FINAL_RECORD_TOO_LARGE");
  const r = FinalReview.safeParse(parseJson(bytes, "FINAL_REVIEW_INVALID"));
  if (!r.success) return stop(r.error.issues.some((i) => i.message === "final_text_unsafe") ? "FINAL_REVIEW_TEXT_UNSAFE" : "FINAL_REVIEW_INVALID");
  if (r.data.materials.some((m) => m.class !== "A" && m.class !== "B")) stop("FINAL_MATERIAL_CLASS");
  if (new Set(r.data.materials.map((m) => m.asset)).size !== r.data.materials.length) stop("FINAL_REVIEW_INVALID");
  const keys = Object.keys(r.data.axes);
  if (FINAL_AXES.some((a) => !keys.includes(a))) stop("FINAL_REVIEW_AXIS_MISSING");
  if (keys.some((k) => !(FINAL_AXES as readonly string[]).includes(k))) stop("FINAL_REVIEW_INVALID");
  const axes = {} as Record<FinalAxis, z.infer<typeof Axis>>;
  for (const a of FINAL_AXES) {
    const p = Axis.safeParse(r.data.axes[a]);
    if (!p.success) return stop(p.error.issues.some((i) => i.message === "final_text_unsafe") ? "FINAL_REVIEW_TEXT_UNSAFE" : "FINAL_REVIEW_INVALID");
    if (p.data.evidence.length === 0) stop("FINAL_REVIEW_EVIDENCE_MISSING");
    axes[a] = p.data;
  }
  return { ...r.data, materials: r.data.materials as FinalReview["materials"], axes };
}

export function parseFinalApproval(bytes: Buffer): FinalApproval {
  if (bytes.length > RECORD_MAX_BYTES) stop("FINAL_RECORD_TOO_LARGE");
  const r = FinalApproval.safeParse(parseJson(bytes, "FINAL_APPROVAL_INVALID"));
  return r.success ? r.data : stop("FINAL_APPROVAL_INVALID");
}

// ---- files -----------------------------------------------------------------------------------------------------------

/** Opens a regular file without following a link; null when it is missing. */
async function readNoFollow(path: string, max: number, unsafe: FinalApprovalCode, big: FinalApprovalCode, privateFile = false): Promise<Buffer | null> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    return stop(unsafe);
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1) stop(unsafe);
    if (privateFile && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)) stop(unsafe);
    if (st.size > max) stop(big);
    const b = await h.readFile();
    if (b.length > max) stop(big);
    return b;
  } finally {
    await h.close();
  }
}

/** A folder of ours: outside the repository (links resolved), a real directory (no link), owned by us, mode 0700. */
async function privateFolder(dir: string, repo: string, inRepo: FinalApprovalCode): Promise<string> {
  const full = resolve(dir);
  const real = await realpath(full).catch(() => null);
  if (real === null) return stop("FINAL_FOLDER_UNSAFE");
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (within(real, realRepo) || within(full, resolve(repo))) stop(inRepo);
  const st = await lstat(full);
  if (real !== full || !st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) stop("FINAL_FOLDER_UNSAFE");
  return full;
}

/** The site limits and file rules of the stage-6 comparison (impl-compare-approved.ts readSite), restated. */
const SITE_LIMITS = { html: 384 * 1024, css: 256 * 1024, asset: 16 * 1024 * 1024, assets: 32, total: 64 * 1024 * 1024 } as const;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
type Site = { files: { path: string; sha256: string; bytes: number }[]; assets: Map<string, Buffer> };

/** The finished site: outside the repository, real, index.html + style.css + assets/*.png (the comparison's listing). */
async function readSiteFiles(siteDir: string, repo: string): Promise<Site> {
  const dir = resolve(siteDir);
  const real = await realpath(dir).catch(() => null);
  if (real === null) return stop("FINAL_SITE_MISSING");
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (within(real, realRepo) || within(dir, resolve(repo))) stop("FINAL_SITE_IN_REPO");
  const st = await lstat(dir);
  if (real !== dir || !st.isDirectory()) stop("FINAL_SITE_UNSAFE");
  const html = await readNoFollow(join(dir, "index.html"), SITE_LIMITS.html, "FINAL_SITE_UNSAFE", "FINAL_SITE_TOO_LARGE");
  const css = await readNoFollow(join(dir, "style.css"), SITE_LIMITS.css, "FINAL_SITE_UNSAFE", "FINAL_SITE_TOO_LARGE");
  if (!html || !css) return stop("FINAL_SITE_INVALID");
  let total = html.length + css.length;
  const files = [
    { path: "index.html", sha256: sha256(html), bytes: html.length },
    { path: "style.css", sha256: sha256(css), bytes: css.length },
  ];
  const assets = new Map<string, Buffer>();
  const ad = await lstat(join(dir, "assets")).catch(() => null);
  if (ad) {
    if (!ad.isDirectory() || ad.isSymbolicLink()) stop("FINAL_SITE_UNSAFE");
    const names = (await readdir(join(dir, "assets"))).sort();
    if (names.length > SITE_LIMITS.assets) stop("FINAL_SITE_TOO_LARGE");
    for (const name of names) {
      if (!ASSET_NAME.test(name)) stop("FINAL_SITE_INVALID");
      const b = await readNoFollow(join(dir, "assets", name), SITE_LIMITS.asset, "FINAL_SITE_UNSAFE", "FINAL_SITE_TOO_LARGE");
      if (!b || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return stop("FINAL_SITE_INVALID");
      total += b.length;
      if (total > SITE_LIMITS.total) stop("FINAL_SITE_TOO_LARGE");
      assets.set(`assets/${name}`, b);
      files.push({ path: `assets/${name}`, sha256: sha256(b), bytes: b.length });
    }
  }
  return { files, assets };
}

// ---- what the review must match -------------------------------------------------------------------------------------

const PageScores = z.object({ ssim: z.number(), colour_blocks: z.number(), edges_iou: z.number(), height_ratio: z.number() });
const ViewportRecord = z.object({
  design: z.object({ source_file: z.string(), source_sha256: SHA }),
  capture: z.object({ sha256: SHA, height: z.number(), scroll_width: z.number(), blocked_requests: z.number() }),
  page: PageScores.nullable(),
  code: z.string().nullable(),
  differences: z.array(z.string()),
  findings: z.array(z.string()),
});
const ImplRecord = z.object({
  schema: z.literal(IMPL_COMPARE_RECORD_SCHEMA),
  advisory: z.literal(true),
  status: z.string(),
  request_id: REQUEST_ID,
  synthetic: z.literal(true).optional(),
  approved: z.object({ bundle_sha256: SHA, review_sha256: SHA, approval_sha256: SHA }),
  site: z.object({ files: z.array(z.object({ path: z.string(), sha256: SHA, bytes: z.number() })) }),
  viewports: z.object({ desktop_1440: ViewportRecord, mobile_390: ViewportRecord }),
  differences: z.array(z.string()),
  findings: z.array(z.string()),
});
export type ImplRecordView = z.infer<typeof ImplRecord>;

/** What the check reads besides the two final records. Every path is private (outside the repository). */
export type FinalInputs = {
  /** The first approval's records (design-approval.ts). */
  design: ApprovedDesignRecords;
  /**
   * The approved materials' records (materials-approval.ts), or the explicit statement that the first-approved design
   * has no approved materials (`{ none: true }`). #373 re-review Low 1: never simply left out, so the check that no
   * approved material is shown as B or C (FINAL_GENERATED_AS_SHOP) cannot be skipped by omission. The CLI always asks
   * for the records; `none` is for a caller that knows the design has no materials stage (an A picture then stops).
   */
  materials: { bundleDir: string; reviewPath: string; approvalPath: string } | { none: true };
  /** The photo-slot spec file. */
  slotsPath: string;
  /** The private provenance folder: <picture sha256>.json per picture. */
  provenanceDir: string;
  /** The finished site in the implementation-lane shape (index.html, style.css, assets/*.png). */
  siteDir: string;
  /** The stage-6 comparison's output folder (record.json, images/pc-capture.png, images/sp-capture.png). */
  implCompareDir: string;
};

export type FinalEvidence = {
  design: ApprovedDesignRun;
  approvedMaterials: ApprovedMaterials | null;
  slots_sha256: string;
  site: Site;
  build_files_sha256: string;
  impl: ImplRecordView;
  impl_compare_sha256: string;
  captures: { pc: { sha256: string; bytes: Buffer }; sp: { sha256: string; bytes: Buffer } };
  provenance: Map<string, string>;
  /** COMPOSITION_ROUTE_RULE's verdict from the comparison (null: within it) — whatever the reviewer declares. */
  measured_change: string[] | null;
};

const passThrough = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (error) {
    if (error instanceof DesignApprovalStop || error instanceof MaterialsApprovalStop) throw new FinalApprovalStop(error.code);
    throw error;
  }
};

/**
 * COMPOSITION_ROUTE_RULE applied to the comparison record: the reasons it routes back to the first approval. #373
 * re-review Low 2: the numbers count as well as the codes — a viewport whose page SSIM is under the threshold routes back
 * (as <PC|SP>_PAGE_LAYOUT) even when its difference code is missing.
 */
export function measuredCompositionChange(impl: ImplRecordView): string[] | null {
  const reasons: string[] = [];
  if (impl.status !== "compared") reasons.push(`STATUS_${impl.status.toUpperCase()}`);
  for (const [tag, v] of [["PC", impl.viewports.desktop_1440], ["SP", impl.viewports.mobile_390]] as const) {
    if (v.code) reasons.push(`${tag}_${v.code}`);
    if (v.page === null) reasons.push(`${tag}_NOT_MEASURED`);
    else if (!(v.page.ssim >= COMPOSITION_ROUTE_RULE.pageSsim)) reasons.push(`${tag}_PAGE_LAYOUT`);
    for (const d of v.differences) if (COMPOSITION_ROUTE_RULE.pageLayoutCode.test(d)) reasons.push(d);
  }
  return reasons.length ? [...new Set(reasons)] : null;
}

/**
 * #373 re-review Low 2: the comparison record must agree with itself — a viewport's PAGE_LAYOUT code exactly when its
 * page SSIM is under the threshold, and the record's differences / findings the two viewports' in order. A record whose
 * codes and numbers disagree was not written by the comparison as it is (FINAL_IMPL_COMPARE_INVALID).
 */
export function implRecordConsistent(impl: ImplRecordView): boolean {
  const vps = [["PC", impl.viewports.desktop_1440], ["SP", impl.viewports.mobile_390]] as const;
  for (const [tag, v] of vps) {
    if (v.page === null) continue;
    const coded = v.differences.includes(`${tag}_PAGE_LAYOUT`);
    if (!Number.isFinite(v.page.ssim) || coded !== v.page.ssim < COMPOSITION_ROUTE_RULE.pageSsim) return false;
  }
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, n) => x === b[n]);
  return same(impl.differences, [...vps[0][1].differences, ...vps[1][1].differences]) && same(impl.findings, [...vps[0][1].findings, ...vps[1][1].findings]);
}

/** Reads and recomputes everything the review must match (see the header). */
async function gatherEvidence(i: FinalInputs, repo: string): Promise<FinalEvidence> {
  const design = await passThrough(() => approvedDesignRun({ ...i.design, repo }));
  const m = i.materials;
  const approved = "none" in m ? null : await passThrough(() => approvedMaterials({ design: i.design, bundleDir: m.bundleDir, reviewPath: m.reviewPath, approvalPath: m.approvalPath, repo }));
  // the slot spec in its full strict form, bound to this first approval
  const slotsBytes = await readFinalRecord(i.slotsPath, repo);
  const slots = PhotoSlots.safeParse(parseJson(slotsBytes, "FINAL_SLOTS_INVALID"));
  if (!slots.success) return stop("FINAL_SLOTS_INVALID");
  const sa = slots.data.approved_design;
  if (sa.bundle_id !== design.request_id || sa.bundle_sha256 !== design.bundle_sha256 || sa.approval_sha256 !== design.approval_sha256 || sa.review_file !== basename(i.design.reviewPath) || sa.approval_file !== basename(i.design.approvalPath))
    stop("FINAL_SLOTS_MISMATCH");
  const site = await readSiteFiles(i.siteDir, repo);
  // the comparison: its folder is ours; its record names this design, this site and its captures
  const implDir = await privateFolder(i.implCompareDir, repo, "FINAL_RECORD_IN_REPO");
  const implBytes = await readNoFollow(join(implDir, "record.json"), RECORD_MAX_BYTES, "FINAL_IMPL_COMPARE_INVALID", "FINAL_RECORD_TOO_LARGE", true);
  if (!implBytes) return stop("FINAL_IMPL_COMPARE_INVALID");
  const parsed = ImplRecord.safeParse(parseJson(implBytes, "FINAL_IMPL_COMPARE_INVALID"));
  if (!parsed.success) return stop("FINAL_IMPL_COMPARE_INVALID");
  const impl = parsed.data;
  if (!implRecordConsistent(impl)) stop("FINAL_IMPL_COMPARE_INVALID");
  if (impl.request_id !== design.request_id || impl.approved.bundle_sha256 !== design.bundle_sha256 || impl.approved.review_sha256 !== design.review_sha256 || impl.approved.approval_sha256 !== design.approval_sha256) stop("FINAL_IMPL_COMPARE_MISMATCH");
  if (impl.viewports.desktop_1440.design.source_sha256 !== design.images.pc[0]?.sha256 || impl.viewports.mobile_390.design.source_sha256 !== design.images.sp[0]?.sha256) stop("FINAL_IMPL_COMPARE_MISMATCH");
  if (buildFilesSha256(impl.site.files) !== buildFilesSha256(site.files)) stop("FINAL_IMPL_COMPARE_MISMATCH");
  const imagesDir = await privateFolder(join(implDir, "images"), repo, "FINAL_RECORD_IN_REPO");
  const capture = async (tag: "pc" | "sp", want: string) => {
    const b = await readNoFollow(join(imagesDir, `${tag}-capture.png`), SITE_LIMITS.asset, "FINAL_RECORD_UNSAFE", "FINAL_RECORD_TOO_LARGE", true);
    if (!b || sha256(b) !== want) return stop("FINAL_CAPTURE_MISMATCH");
    return { sha256: want, bytes: b };
  };
  const captures = { pc: await capture("pc", impl.viewports.desktop_1440.capture.sha256), sp: await capture("sp", impl.viewports.mobile_390.capture.sha256) };
  // the provenance record of every picture the site shows (strict A / B / C; C refused; a generated one never as B / C)
  const provDir = await privateFolder(i.provenanceDir, repo, "FINAL_RECORD_IN_REPO");
  const approvedShas = new Set(approved?.materials.map((m) => m.sha256) ?? []);
  const provenance = new Map<string, string>();
  for (const [asset, bytes] of site.assets) {
    const pic = sha256(bytes);
    const recBytes = await readFinalRecord(join(provDir, `${pic}.json`), repo).catch((e: unknown) => {
      if (e instanceof FinalApprovalStop && e.code === "FINAL_RECORD_MISSING") throw new FinalApprovalStop("FINAL_PROVENANCE_MISSING");
      throw e;
    });
    const p = Provenance.safeParse(parseJson(recBytes, "FINAL_PROVENANCE_INVALID"));
    if (!p.success || p.data.sha256 !== pic) return stop("FINAL_PROVENANCE_INVALID");
    if (p.data.class !== "A" && approvedShas.has(pic)) stop("FINAL_GENERATED_AS_SHOP");
    if (p.data.class === "C") stop("FINAL_MATERIAL_CLASS");
    if (p.data.class === "A") {
      if (!approved) return stop("FINAL_MATERIALS_RECORDS_MISSING");
      const a = p.data;
      if (a.materials_approval_sha256 !== approved.approval_sha256 || !approved.materials.some((m) => m.sha256 === pic && m.id === a.material_id)) stop("FINAL_MATERIAL_NOT_APPROVED");
    }
    provenance.set(asset, `${p.data.class}:${sha256(recBytes)}`);
  }
  return { design, approvedMaterials: approved, slots_sha256: sha256(slotsBytes), site, build_files_sha256: buildFilesSha256(site.files), impl, impl_compare_sha256: sha256(implBytes), captures, provenance, measured_change: measuredCompositionChange(impl) };
}

/** The review against the recomputed evidence: every binding, in the order a reader would look. */
function matchReview(review: FinalReview, ev: FinalEvidence, i: FinalInputs): void {
  const d = review.design;
  if (d.bundle_id !== ev.design.request_id || d.bundle_sha256 !== ev.design.bundle_sha256 || d.approval_sha256 !== ev.design.approval_sha256 || d.review_file !== basename(i.design.reviewPath) || d.approval_file !== basename(i.design.approvalPath)) stop("FINAL_DESIGN_MISMATCH");
  if (review.photo_slots_sha256 !== ev.slots_sha256) stop("FINAL_SLOTS_MISMATCH");
  if (buildFilesSha256(review.build.files) !== ev.build_files_sha256) stop("FINAL_BUILD_MISMATCH");
  if (review.materials.length !== ev.site.assets.size || review.materials.some((m) => !ev.site.assets.has(m.asset) || sha256(ev.site.assets.get(m.asset)!) !== m.sha256)) stop("FINAL_MATERIALS_MISMATCH");
  for (const m of review.materials) if (ev.provenance.get(m.asset) !== `${m.class}:${m.provenance_sha256}`) stop("FINAL_PROVENANCE_MISMATCH");
  if (review.impl_compare_sha256 !== ev.impl_compare_sha256) stop("FINAL_IMPL_COMPARE_MISMATCH");
  if (review.captures.pc.sha256 !== ev.captures.pc.sha256 || review.captures.sp.sha256 !== ev.captures.sp.sha256) stop("FINAL_CAPTURE_MISMATCH");
}

// ---- the owner's viewing page --------------------------------------------------------------------------------------

const AXIS_LABEL: Record<FinalAxis, string> = {
  colour_harmony: "写真と背景の色の調和",
  brightness_legibility: "明るさと文字の読みやすさ",
  subject_crop: "主役の位置と切り取り",
  unity: "写真・余白・文字・装飾の一体感",
  pc_sp_composition: "PC/SP の構図",
  shop_character: "店らしさ",
  originality: "成功例と比べた独自性",
  no_photo_degradation: "写真で元のデザインが劣化していないか",
  composition_kept: "承認した構図の維持",
  facts: "事実",
  rights: "権利（出自 A/B）",
  labels: "表示（イメージの表示など）",
};
const VERDICT_LABEL = { pass: "合格", revise: "要修正", fail: "不合格" } as const;
const CHANGE_LABEL = { none: "変更なし", minor: "小さい変更", major: "大きい変更（第 1 承認へ戻る）" } as const;
/** The copied picture names: the first-approved design, the captures, the site's pictures (nothing from original names). */
export const finalPageImageName = (what: "pc" | "sp" | "design-pc" | "design-sp" | number) => (typeof what === "number" ? `images/material-${what + 1}.png` : what.startsWith("design-") ? `images/${what}.png` : `images/${what}-capture.png`);

/** The page's HTML (pure): the first-approved design next to the captures with the comparison's numbers, every picture, the axes; no approval. */
export function renderFinalReviewPage(review: FinalReview, ev: FinalEvidence): string {
  const e = escapeHtml;
  const num = (n: number) => e(n.toFixed(3));
  const viewport = (v: "pc" | "sp") => {
    const r = v === "pc" ? ev.impl.viewports.desktop_1440 : ev.impl.viewports.mobile_390;
    const label = v === "pc" ? "PC 1440" : "SP 390";
    const scores = r.page ? `<dt>レイアウト（grid SSIM）</dt><dd>${num(r.page.ssim)}（基準 ${COMPOSITION_ROUTE_RULE.pageSsim} 以上）</dd><dt>色の塊</dt><dd>${num(r.page.colour_blocks)}</dd><dt>輪郭の重なり（edge IoU）</dt><dd>${num(r.page.edges_iou)}</dd><dt>高さの比</dt><dd>${num(r.page.height_ratio)}（承認画像は縮めた全体図なので違ってよい）</dd>` : "<dt>測定</dt><dd>測れていない</dd>";
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `<code>${e(x)}</code>`).join(" ") : "なし");
    return `<section class="vp"><h3>${label}</h3><div class="pair"><figure><img src="${e(finalPageImageName(`design-${v}`))}" alt="${e(`${label} 第 1 承認`)}" loading="lazy"><figcaption>第 1 承認のデザイン<br><code>${e(r.design.source_sha256)}</code></figcaption></figure><figure><img src="${e(finalPageImageName(v))}" alt="${e(`${label} 完成`)}" loading="lazy"><figcaption>完成したサイト<br><code>${e(review.captures[v].sha256)}</code></figcaption></figure></div><dl>${scores}<dt>差</dt><dd>${list(r.differences)}</dd><dt>所見</dt><dd>${list(r.findings)}</dd>${r.code ? `<dt>比較できなかった理由</dt><dd><code>${e(r.code)}</code></dd>` : ""}</dl></section>`;
  };
  const mats = review.materials
    .map((m, n) => `<figure class="mat"><img src="${e(finalPageImageName(n))}" alt="${e(m.asset)}" loading="lazy"><figcaption><strong>${e(m.class)}</strong> ${m.class === "A" ? "生成素材（イメージ）" : "店が提供した写真"}<br>${e(m.asset)}<br><code>${e(m.sha256)}</code><br>出自の記録 <code>${e(m.provenance_sha256)}</code></figcaption></figure>`)
    .join("");
  const axes = FINAL_AXES.map((a) => {
    const x = review.axes[a];
    const rows = x.evidence.map((ev2) => `<li><strong>${e(ev2.image.toUpperCase())}</strong> ${e(ev2.region)}: ${e(ev2.note)}</li>`).join("");
    return `<section class="axis"><h2>${e(AXIS_LABEL[a])} <span class="v ${e(x.verdict)}">${e(VERDICT_LABEL[x.verdict])}</span></h2><ul>${rows}</ul></section>`;
  }).join("\n");
  const measured = ev.measured_change
    ? `<p class="route"><strong>比較の測定では構図が大きく変わっている（${ev.measured_change.map((x) => `<code>${e(x)}</code>`).join(" ")}）。審査の申告にかかわらず、第 2 承認ではなく第 1 承認へ戻る。</strong></p>`
    : `<p>比較の測定は基準の中（両方の画面で比較でき、レイアウトの SSIM が ${COMPOSITION_ROUTE_RULE.pageSsim} 以上）。構図が保たれているかは、下の 2 枚を見比べてオーナーが判断する。</p>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEWING_PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${e(review.design.bundle_id)} 写真入りの第 2 審査</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1b; --bg: #fbfaf7; --muted: #6a6862; --line: #d9d6cf; --pass: #1f6b3a; --revise: #8a5a00; --fail: #9a3412; }
@media (prefers-color-scheme: dark) { :root { --fg: #ecebe7; --bg: #171716; --muted: #a3a19b; --line: #3a3936; --pass: #6fcf97; --revise: #f2c94c; --fail: #f4a261; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; line-height: 1.7; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 8px; }
h2 { font-size: 1.1rem; border-top: 1px solid var(--line); padding-top: 20px; }
h3 { font-size: 1rem; }
.figs, .pair { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 0; flex: 1 1 320px; max-width: 100%; }
.pair figure { flex: 1 1 260px; }
figure.mat { flex: 1 1 200px; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
figcaption { font-size: 0.8rem; color: var(--muted); word-break: break-all; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 0.85rem; word-break: break-all; }
.route { border: 2px dashed var(--fail); padding: 8px 12px; }
.v { font-size: 0.85rem; font-weight: normal; margin-left: 8px; }
.pass { color: var(--pass); } .revise { color: var(--revise); } .fail { color: var(--fail); }
code { font-size: 0.75rem; }
</style>
</head>
<body>
<main>
<h1>${e(review.design.bundle_id)} — 写真入りの第 2 審査（非公開・ローカル）</h1>
<p>審査: ${e(review.reviewer)}（${e(review.reviewed_at)}）。審査は助言で、判定はオーナーが下す。審査の申告する構図の変更: ${e(CHANGE_LABEL[review.composition_change])}。大きい変更は第 2 承認ではなく、第 1 承認（新しい全体のデザインとその承認）へ戻る。</p>
<p>オーナーが承認・要修正・却下を決めたら、Claude がその旨を第 2 承認の記録に書く（このページの index.html の SHA-256 を page_sha256 に、審査の記録の SHA-256 を review_sha256 に）。これはオーナー本人の署名ではない。下のどの SHA-256 が変わっても、古い承認は使わない。</p>
${ev.design.synthetic ? `<p class="route"><strong>合成（リハーサル）の第 1 承認: 承認しても本当の承認にはならない。</strong></p>\n` : ""}<dl>
<dt>第 1 承認</dt><dd>${e(review.design.bundle_id)} / bundle <code>${e(review.design.bundle_sha256)}</code> / 承認 <code>${e(review.design.approval_sha256)}</code></dd>
<dt>写真枠の指定</dt><dd><code>${e(review.photo_slots_sha256)}</code></dd>
<dt>サイト</dt><dd>${review.build.files.length} 件のファイル / 一覧 <code>${e(buildFilesSha256(review.build.files))}</code>${review.build.commit ? ` / commit <code>${e(review.build.commit)}</code>` : ""}</dd>
<dt>実装の比較（助言）</dt><dd><code>${e(review.impl_compare_sha256)}</code>（状態 ${e(ev.impl.status)}）。画面は比較の記録が名指す画像で、ここで撮り直してはいない。</dd>
</dl>
<h2>構図: 第 1 承認のデザインと完成したサイト</h2>
${measured}
${viewport("pc")}
${viewport("sp")}
<h2>写真（出自 A・B）</h2>
<div class="figs">${mats}</div>
${axes}
</main>
</body>
</html>
`;
}
export const finalReviewPageSha256 = (review: FinalReview, ev: FinalEvidence) => sha256(renderFinalReviewPage(review, ev));

/** The nearest existing ancestor's real path joined with the rest (a link above is resolved). */
async function realPlace(path: string): Promise<string | null> {
  const rest: string[] = [];
  let anc = resolve(path);
  while (!(await lstat(anc).then(() => true, () => false))) {
    const up = dirname(anc);
    if (up === anc) return null;
    rest.unshift(basename(anc));
    anc = up;
  }
  const real = await realpath(anc).catch(() => null);
  return real === null ? null : join(real, ...rest);
}

/**
 * Writes <outDir>/index.html and <outDir>/images/ (the first-approved pictures, the verified captures and pictures), as
 * the design review page does: outside the repository (links resolved), empty or absent, ours and private (0700; files
 * 0600, never overwritten).
 */
export async function writeFinalReviewPage(review: FinalReview, ev: FinalEvidence, o: { outDir: string; repo: string }): Promise<{ page: string; page_sha256: string }> {
  const out = resolve(o.outDir);
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  const inRepo = (p: string | null) => p === null || within(p, realRepo) || within(p, resolve(o.repo));
  if (inRepo(out) || inRepo(await realPlace(out))) stop("FINAL_PAGE_IN_REPO");
  const existing = await lstat(out).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(out)).length > 0)) stop("FINAL_PAGE_DIR_NOT_EMPTY");
  if (existing && (existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0)) stop("FINAL_PAGE_DIR_UNSAFE");
  await mkdir(join(out, "images"), { recursive: true, mode: 0o700 });
  if (inRepo(await realpath(out).catch(() => null))) stop("FINAL_PAGE_IN_REPO");
  const images = await lstat(join(out, "images")).catch(() => null);
  if (!images || !images.isDirectory() || images.isSymbolicLink() || images.uid !== process.getuid?.()) stop("FINAL_PAGE_DIR_UNSAFE");
  const write = async (rel: string, bytes: Buffer | string) => {
    const h = await open(join(out, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(bytes);
    } finally {
      await h.close();
    }
  };
  await write(finalPageImageName("design-pc"), ev.design.images.pc[0]!.bytes);
  await write(finalPageImageName("design-sp"), ev.design.images.sp[0]!.bytes);
  await write(finalPageImageName("pc"), ev.captures.pc.bytes);
  await write(finalPageImageName("sp"), ev.captures.sp.bytes);
  for (const [n, m] of review.materials.entries()) await write(finalPageImageName(n), ev.site.assets.get(m.asset)!);
  const html = renderFinalReviewPage(review, ev);
  await write("index.html", html);
  return { page: join(out, "index.html"), page_sha256: sha256(html) };
}

// ---- the check and the gate ---------------------------------------------------------------------------------------

export type FinalApprovalCheck = {
  design: { request_id: string; bundle_sha256: string; approval_sha256: string };
  review_sha256: string;
  page_sha256: string;
  build_files_sha256: string;
  verdicts: Record<FinalAxis, "pass" | "revise" | "fail">;
  composition_change: FinalReview["composition_change"];
  /** The comparison's own verdict under COMPOSITION_ROUTE_RULE (null: within it). */
  measured_change: string[] | null;
  /** A major composition change (declared or measured): the next step is a new first approval, not this one. */
  route: "second_approval" | "first_approval";
  approval: { sha256: string; decision: FinalApproval["decision"] } | null;
  synthetic?: true;
};

/**
 * The review (and, in gate mode, the approval) against everything it names, recomputed from the files. Draft: the
 * review alone (what the owner is about to see). Gate: also the approval, bound to every SHA-256, decision approve, no
 * axis `fail`, no major composition change (declared or measured), not synthetic. Throws FinalApprovalStop.
 */
export async function checkFinalApproval(o: FinalInputs & { reviewPath: string; approvalPath?: string; repo: string; mode: "draft" | "gate" }): Promise<FinalApprovalCheck & { review: FinalReview; evidence: FinalEvidence }> {
  const ev = await gatherEvidence(o, o.repo);
  const reviewBytes = await readFinalRecord(o.reviewPath, o.repo);
  const review = parseFinalReview(reviewBytes);
  matchReview(review, ev, o);
  const reviewSha = sha256(reviewBytes);
  const pageSha = finalReviewPageSha256(review, ev);
  const verdicts = Object.fromEntries(FINAL_AXES.map((a) => [a, review.axes[a].verdict])) as FinalApprovalCheck["verdicts"];
  const route = review.composition_change === "major" || ev.measured_change !== null ? ("first_approval" as const) : ("second_approval" as const);
  const base = {
    design: { request_id: ev.design.request_id, bundle_sha256: ev.design.bundle_sha256, approval_sha256: ev.design.approval_sha256 },
    review_sha256: reviewSha,
    page_sha256: pageSha,
    build_files_sha256: ev.build_files_sha256,
    verdicts,
    composition_change: review.composition_change,
    measured_change: ev.measured_change,
    route,
    ...(ev.design.synthetic ? { synthetic: true as const } : {}),
    review,
    evidence: ev,
  };
  if (o.mode === "draft" && !o.approvalPath) return { ...base, approval: null };
  if (!o.approvalPath) return stop("FINAL_APPROVAL_MISSING");
  const approvalBytes = await readFinalRecord(o.approvalPath, o.repo);
  const a = parseFinalApproval(approvalBytes);
  if (a.design_approval_sha256 !== ev.design.approval_sha256) stop("FINAL_APPROVAL_DESIGN_MISMATCH");
  if (a.photo_slots_sha256 !== ev.slots_sha256) stop("FINAL_APPROVAL_SLOTS_MISMATCH");
  if (a.build_files_sha256 !== ev.build_files_sha256) stop("FINAL_APPROVAL_BUILD_MISMATCH");
  if (a.materials.length !== review.materials.length || a.materials.some((m, n) => m.asset !== review.materials[n]!.asset || m.sha256 !== review.materials[n]!.sha256 || m.provenance_sha256 !== review.materials[n]!.provenance_sha256)) stop("FINAL_APPROVAL_MATERIALS_MISMATCH");
  if (a.captures.pc !== ev.captures.pc.sha256 || a.captures.sp !== ev.captures.sp.sha256) stop("FINAL_APPROVAL_CAPTURE_MISMATCH");
  if (a.impl_compare_sha256 !== ev.impl_compare_sha256) stop("FINAL_APPROVAL_IMPL_COMPARE_MISMATCH");
  if (a.review_sha256 !== reviewSha) stop("FINAL_APPROVAL_REVIEW_MISMATCH");
  if (a.page_sha256 !== pageSha) stop("FINAL_APPROVAL_PAGE_MISMATCH");
  if (Date.parse(a.decided_at) < Date.parse(review.reviewed_at)) stop("FINAL_APPROVAL_BEFORE_REVIEW");
  const approval = { sha256: sha256(approvalBytes), decision: a.decision };
  if (o.mode === "gate") {
    if (ev.design.synthetic) stop("FINAL_DESIGN_SYNTHETIC");
    if (route === "first_approval") stop("FINAL_COMPOSITION_CHANGED");
    if (a.decision !== "approve") stop("FINAL_NOT_APPROVED");
    if (FINAL_AXES.some((x) => review.axes[x].verdict === "fail")) stop("FINAL_REVIEW_HAS_FAIL");
  }
  return { ...base, approval };
}

/** What a demo or a delivery receives: the approved site's file list and every SHA-256 that binds it. */
export type ApprovedFinal = {
  design: { request_id: string; bundle_sha256: string; approval_sha256: string };
  build_files_sha256: string;
  files: { path: string; sha256: string; bytes: number }[];
  review_sha256: string;
  page_sha256: string;
  approval_sha256: string;
};

/** The approved finished site, or a FinalApprovalStop: the gate check above. */
export async function approvedFinal(o: FinalInputs & { reviewPath: string; approvalPath: string; repo: string }): Promise<ApprovedFinal> {
  const c = await checkFinalApproval({ ...o, mode: "gate" });
  return { design: c.design, build_files_sha256: c.build_files_sha256, files: c.evidence.site.files, review_sha256: c.review_sha256, page_sha256: c.page_sha256, approval_sha256: c.approval!.sha256 };
}
