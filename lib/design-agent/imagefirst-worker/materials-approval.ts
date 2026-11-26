/**
 * DEV-303 §6.1 change 7 (docs/design/image-first-production-flow.md §1 stage 4 → 5): the review of a delivered image
 * materials run and the owner's approval of its materials. Stage 5 (the implementation) may use only the materials this
 * gate returns, checked by SHA-256 (materials-impl-check.ts).
 *
 * The run is the sealed materials bundle the review inbox holds (bundle.ts verifyBundleDir: image_material, its
 * parts/photo-N.png with their SHA-256s). Its bundled receipt names the approved design it was made for
 * (approved_design: the design run's id and bundle / review / approval SHA-256s, §6.1 change 6); that design must pass
 * its own gate again here (design-approval.ts approvedDesignRun) and be exactly the one the receipt names, for the same
 * shop. Both records live privately OUTSIDE the repository, next to the design's:
 * ~/second-root-shops/<shop_id>/design-reviews/<materials id>.materials-review.json / .materials-approval.json.
 *
 *   sr_materials_review_v1    { schema, request_id, bundle_sha256, materials: [{ id, file, sha256, verdict: pass |
 *                               revise | fail, note }] (every picture of the bundle, in its order), reviewer, reviewed_at }
 *                             The independent review (another Claude context): ADVICE ONLY.
 *   sr_materials_approval_v1  { schema, request_id, bundle_sha256, review_sha256 (the review file's bytes),
 *                               page_sha256 (the viewing page the owner looked at), approved_materials: [{ file, sha256 }]
 *                               (1..6, reviewed ones, in the review's order), decision: approve | revise | reject,
 *                               decided_at (≥ reviewed_at), note? }
 *                             Claude writes it ONLY when the owner says so. It records that statement, bound to exactly
 *                             this review, this page and these pictures; it is NOT the owner's signature.
 *
 * The viewing page (writeMaterialsReviewPage, owner-approved 2026-11-26): static local HTML, the design review page's
 * pattern (no script, no network, no external font; the case-study page's CSP), each generated picture copied next to
 * it from the verified bundle with the review's verdict and note, every text escaped, never the approval.
 * page_sha256 is recomputed by re-rendering the page from the review and the run, so a changed review or page template
 * invalidates earlier approvals (fail safe: the owner looks at the new page again).
 *
 * Gate (approvedMaterials): the design passes its gate and is the receipt's approved_design (same shop); the materials
 * bundle verifies; the review lists exactly its pictures with their SHA-256s; the approval binds this review, is decided
 * at or after it, approves only reviewed pictures, and the decision is approve. A picture whose verdict is `fail` cannot
 * be approved (MATERIALS_APPROVAL_HAS_FAIL; the owner asks for a new review or new materials instead); a `revise` one
 * can, as the owner decides. Pictures the approval leaves out are not usable.
 *
 * Failures throw MaterialsApprovalStop with a fixed code (no path, no content). The design gate's DESIGN_* codes pass
 * through unchanged; a materials record's reading problem is MATERIALS_RECORD_*.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { escapeHtml, VIEWING_PAGE_CSP } from "../case-study/case-study";
import { BundleStop, verifyBundleDir } from "./bundle";
import { approvedDesignRun, DesignApprovalStop, readRecord, RECORD_MAX_BYTES, type ApprovedDesignRun } from "./design-approval";

export const MATERIALS_REVIEW_SCHEMA = "sr_materials_review_v1";
export const MATERIALS_APPROVAL_SCHEMA = "sr_materials_approval_v1";

export const MATERIALS_APPROVAL_CODES = [
  "MATERIALS_RECORD_MISSING",
  "MATERIALS_RECORD_UNSAFE",
  "MATERIALS_RECORD_TOO_LARGE",
  "MATERIALS_RECORD_IN_REPO",
  "MATERIALS_REVIEW_INVALID",
  "MATERIALS_REVIEW_TEXT_UNSAFE",
  "MATERIALS_BUNDLE_INVALID",
  "MATERIALS_BUNDLE_NOT_MATERIALS",
  "MATERIALS_DESIGN_MISMATCH",
  "MATERIALS_RUN_MISMATCH",
  "MATERIALS_REVIEW_MATERIALS_MISMATCH",
  "MATERIALS_APPROVAL_MISSING",
  "MATERIALS_APPROVAL_INVALID",
  "MATERIALS_APPROVAL_REVIEW_MISMATCH",
  "MATERIALS_APPROVAL_PAGE_MISMATCH",
  "MATERIALS_PAGE_IN_REPO",
  "MATERIALS_PAGE_DIR_NOT_EMPTY",
  "MATERIALS_PAGE_DIR_UNSAFE",
  "MATERIALS_APPROVAL_BEFORE_REVIEW",
  "MATERIALS_APPROVAL_MATERIALS_MISMATCH",
  "MATERIALS_NOT_APPROVED",
  "MATERIALS_APPROVAL_HAS_FAIL",
  "MATERIALS_DESIGN_SYNTHETIC",
] as const;
export type MaterialsApprovalCode = (typeof MATERIALS_APPROVAL_CODES)[number];
export class MaterialsApprovalStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MaterialsApprovalStop";
  }
}
const stop = (code: MaterialsApprovalCode): never => {
  throw new MaterialsApprovalStop(code);
};

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const UTC = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((s) => Number.isFinite(Date.parse(s)), "utc_invalid");
/** One plain line: no control character, markup or link (the same rule as the design records). */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u2028\u2029]|[<>`]|https?:|ftp:|:\/\/|www\./i;
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0 && s === s.trim() && !UNSAFE_TEXT.test(s), "materials_text_unsafe");
const REQUEST_ID = z.string().regex(/^req-[a-z0-9][a-z0-9-]{2,58}$/);
const PHOTO_FILE = z.string().regex(/^parts\/photo-[1-6]\.png$/);
/** The material's id as the materials list names it (the request schema's material id rule, restated). */
const MATERIAL_ID = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

export const MaterialsReview = z.strictObject({
  schema: z.literal(MATERIALS_REVIEW_SCHEMA),
  request_id: REQUEST_ID,
  bundle_sha256: SHA,
  materials: z.array(z.strictObject({ id: MATERIAL_ID, file: PHOTO_FILE, sha256: SHA, verdict: z.enum(["pass", "revise", "fail"]), note: Text(300) })).min(1).max(6),
  reviewer: Text(60),
  reviewed_at: UTC,
});
export type MaterialsReview = z.infer<typeof MaterialsReview>;

export const MaterialsApproval = z.strictObject({
  schema: z.literal(MATERIALS_APPROVAL_SCHEMA),
  request_id: REQUEST_ID,
  bundle_sha256: SHA,
  review_sha256: SHA,
  page_sha256: SHA,
  approved_materials: z.array(z.strictObject({ file: PHOTO_FILE, sha256: SHA })).min(1).max(6),
  decision: z.enum(["approve", "revise", "reject"]),
  decided_at: UTC,
  note: Text(400).optional(),
});
export type MaterialsApproval = z.infer<typeof MaterialsApproval>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const parseJson = (b: Buffer, code: MaterialsApprovalCode): unknown => {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return stop(code);
  }
};

/** A materials record (outside the repository, no link, small); the design module's reader, with MATERIALS_RECORD_* codes. */
async function readMaterialsRecord(path: string, repo: string): Promise<Buffer> {
  try {
    return await readRecord(path, repo);
  } catch (error) {
    if (error instanceof DesignApprovalStop && error.code.startsWith("DESIGN_RECORD_")) return stop(error.code.replace("DESIGN_", "MATERIALS_") as MaterialsApprovalCode);
    throw error;
  }
}

export function parseMaterialsReview(bytes: Buffer): MaterialsReview {
  if (bytes.length > RECORD_MAX_BYTES) stop("MATERIALS_RECORD_TOO_LARGE");
  const r = MaterialsReview.safeParse(parseJson(bytes, "MATERIALS_REVIEW_INVALID"));
  if (!r.success) return stop(r.error.issues.some((i) => i.message === "materials_text_unsafe") ? "MATERIALS_REVIEW_TEXT_UNSAFE" : "MATERIALS_REVIEW_INVALID");
  if (new Set(r.data.materials.map((m) => m.id)).size !== r.data.materials.length) stop("MATERIALS_REVIEW_INVALID");
  return r.data;
}

export function parseMaterialsApproval(bytes: Buffer): MaterialsApproval {
  if (bytes.length > RECORD_MAX_BYTES) stop("MATERIALS_RECORD_TOO_LARGE");
  const r = MaterialsApproval.safeParse(parseJson(bytes, "MATERIALS_APPROVAL_INVALID"));
  return r.success ? r.data : stop("MATERIALS_APPROVAL_INVALID");
}

/** One picture of the delivered materials run, its bytes as the bundle verified them. */
export type MaterialPicture = { file: string; sha256: string; bytes: Buffer };
export type DeliveredMaterials = {
  request_id: string;
  bundle_sha256: string;
  shop: string;
  kind: "real_shop" | "fictional" | null;
  approved_design: { bundle_id: string; bundle_sha256: string; review_sha256: string; approval_sha256: string };
  materials_sha256: string;
  pictures: MaterialPicture[];
  /** DEV-303: only when the materials bundle itself is a synthetic one (bundle.ts, fictional request runs only). */
  synthetic?: true;
};

/** The delivered materials run: the sealed bundle verifies, it is image materials, its receipt names its approved design. */
export async function readDeliveredMaterials(bundleDir: string): Promise<DeliveredMaterials> {
  let v;
  try {
    v = await verifyBundleDir(bundleDir);
  } catch (error) {
    if (error instanceof BundleStop) return stop("MATERIALS_BUNDLE_INVALID");
    throw error;
  }
  if (v.manifest.image_material !== true || !v.manifest.photos) return stop("MATERIALS_BUNDLE_NOT_MATERIALS");
  // the bundled receipt was checked when the bundle was sealed and is covered by the manifest (receipt_sha256)
  const receipt = JSON.parse(v.entries.find((e) => e.path === "receipt.json")!.bytes.toString("utf8")) as { approved_design?: DeliveredMaterials["approved_design"]; materials_sha256?: string };
  const a = receipt.approved_design;
  if (!a || typeof receipt.materials_sha256 !== "string") return stop("MATERIALS_BUNDLE_NOT_MATERIALS");
  const pictures = v.manifest.photos.map((p) => ({ file: p.file, sha256: p.sha256, bytes: v.entries.find((e) => e.path === p.file)!.bytes }));
  return {
    request_id: v.manifest.bundle_id,
    bundle_sha256: v.bundle_sha256,
    shop: v.manifest.shop,
    kind: v.manifest.kind ?? null,
    approved_design: { bundle_id: a.bundle_id, bundle_sha256: a.bundle_sha256, review_sha256: a.review_sha256, approval_sha256: a.approval_sha256 },
    materials_sha256: receipt.materials_sha256,
    pictures,
    ...(v.manifest.synthetic === true ? { synthetic: true as const } : {}),
  };
}

// ---- the owner's viewing page --------------------------------------------------------------------------------------

const VERDICT_LABEL = { pass: "合格", revise: "要修正", fail: "不合格" } as const;
/** The copied picture names: images/material-<n>.png (nothing from the original name). */
export const materialPageImageName = (n: number) => `images/material-${n + 1}.png`;

/** The page's HTML (pure): each generated picture with the review's verdict and note; every text escaped; no approval. */
export function renderMaterialsReviewPage(review: MaterialsReview, run: DeliveredMaterials): string {
  const e = escapeHtml;
  const items = review.materials
    .map(
      (m, n) =>
        `<figure><img src="${e(materialPageImageName(n))}" alt="${e(m.id)}" loading="lazy"><figcaption><strong>${e(m.id)}</strong> <span class="v ${e(m.verdict)}">${e(VERDICT_LABEL[m.verdict])}</span><br>${e(m.note)}<br>${e(m.file)}<br><code>${e(m.sha256)}</code></figcaption></figure>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEWING_PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${e(review.request_id)} 素材の審査</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1b; --bg: #fbfaf7; --muted: #6a6862; --line: #d9d6cf; --pass: #1f6b3a; --revise: #8a5a00; --fail: #9a3412; }
@media (prefers-color-scheme: dark) { :root { --fg: #ecebe7; --bg: #171716; --muted: #a3a19b; --line: #3a3936; --pass: #6fcf97; --revise: #f2c94c; --fail: #f4a261; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; line-height: 1.7; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 8px; }
.figs { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 0; flex: 1 1 300px; max-width: 100%; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
figcaption { font-size: 0.85rem; word-break: break-all; }
.v { font-size: 0.85rem; margin-left: 8px; }
.pass { color: var(--pass); } .revise { color: var(--revise); } .fail { color: var(--fail); }
code { font-size: 0.75rem; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${e(review.request_id)} — 素材の審査（非公開・ローカル）</h1>
<p>bundle SHA-256: <code>${e(run.bundle_sha256)}</code>。承認したデザイン: ${e(run.approved_design.bundle_id)}。審査: ${e(review.reviewer)}（${e(review.reviewed_at)}）。審査は助言で、判定はオーナーが下す。生成の成功だけでは素材を使えない。</p>
<p>素材は営業提案用のイメージ素材で、店の写真ではない。頁に置くときは枠ごとに「イメージ」と表示し、差し替えられる枠に置く（MVP_SPEC §7.1）。不合格の素材は承認できない。</p>
<p>オーナーが承認・要修正・却下と、使ってよい素材を決めたら、Claude がその旨を承認の記録に書く（このページの index.html の SHA-256 を page_sha256 に、審査の記録の SHA-256 を review_sha256 に）。これはオーナー本人の署名ではない。</p>
<div class="figs">${items}</div>
</main>
</body>
</html>
`;
}
export const materialsReviewPageSha256 = (review: MaterialsReview, run: DeliveredMaterials) => sha256(renderMaterialsReviewPage(review, run));

const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
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
 * Writes <outDir>/index.html and <outDir>/images/ (the bundle's verified picture bytes), as the design review page
 * does: outside the repository (links resolved), empty or absent, ours and private (0700; files 0600, never overwritten).
 */
export async function writeMaterialsReviewPage(review: MaterialsReview, run: DeliveredMaterials, o: { outDir: string; repo: string }): Promise<{ page: string; page_sha256: string }> {
  const out = resolve(o.outDir);
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  const inRepo = (p: string | null) => p === null || within(p, realRepo) || within(p, resolve(o.repo));
  if (inRepo(out) || inRepo(await realPlace(out))) stop("MATERIALS_PAGE_IN_REPO");
  const existing = await lstat(out).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(out)).length > 0)) stop("MATERIALS_PAGE_DIR_NOT_EMPTY");
  if (existing && (existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0)) stop("MATERIALS_PAGE_DIR_UNSAFE");
  await mkdir(join(out, "images"), { recursive: true, mode: 0o700 });
  if (inRepo(await realpath(out).catch(() => null))) stop("MATERIALS_PAGE_IN_REPO");
  const images = await lstat(join(out, "images")).catch(() => null);
  if (!images || !images.isDirectory() || images.isSymbolicLink() || images.uid !== process.getuid?.()) stop("MATERIALS_PAGE_DIR_UNSAFE");
  const write = async (rel: string, bytes: Buffer | string) => {
    const h = await open(join(out, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(bytes);
    } finally {
      await h.close();
    }
  };
  // the pictures in the review's order (= the bundle's, checked by checkMaterialsApproval)
  for (const [n, m] of review.materials.entries()) await write(materialPageImageName(n), run.pictures.find((p) => p.file === m.file && p.sha256 === m.sha256)!.bytes);
  const html = renderMaterialsReviewPage(review, run);
  await write("index.html", html);
  return { page: join(out, "index.html"), page_sha256: sha256(html) };
}

// ---- the check and the gate ---------------------------------------------------------------------------------------

export type MaterialsApprovalCheck = {
  request_id: string;
  bundle_sha256: string;
  review_sha256: string;
  page_sha256: string;
  verdicts: { id: string; file: string; verdict: "pass" | "revise" | "fail" }[];
  approval: { sha256: string; decision: MaterialsApproval["decision"] } | null;
  /**
   * DEV-303 (PR #362 review Low 4): the approved design (or the materials run) is a synthetic rehearsal bundle. A draft
   * says so; the gate refuses it (MATERIALS_DESIGN_SYNTHETIC), so nothing synthetic ever reaches stage 5 as approved.
   */
  synthetic?: true;
};

/** The design records of the approved design the materials were made for. */
export type ApprovedDesignRecords = { bundleDir: string; reviewPath: string; approvalPath: string };

/**
 * The review (and, in gate mode, the approval) against the delivered materials run, which must belong to the approved
 * design given (passing its own gate). Draft: the review alone. Gate: also the approval. Throws MaterialsApprovalStop
 * (or DesignApprovalStop's codes for the design, as MaterialsApprovalStop).
 */
export async function checkMaterialsApproval(o: {
  design: ApprovedDesignRecords;
  bundleDir: string;
  reviewPath: string;
  approvalPath?: string;
  repo: string;
  mode: "draft" | "gate";
}): Promise<MaterialsApprovalCheck & { design: ApprovedDesignRun; run: DeliveredMaterials; review: MaterialsReview; approved: MaterialsApproval | null }> {
  let design: ApprovedDesignRun;
  try {
    design = await approvedDesignRun({ ...o.design, repo: o.repo });
  } catch (error) {
    if (error instanceof DesignApprovalStop) throw new MaterialsApprovalStop(error.code);
    throw error;
  }
  const run = await readDeliveredMaterials(o.bundleDir);
  const a = run.approved_design;
  if (a.bundle_id !== design.request_id || a.bundle_sha256 !== design.bundle_sha256 || a.review_sha256 !== design.review_sha256 || a.approval_sha256 !== design.approval_sha256) stop("MATERIALS_DESIGN_MISMATCH");
  if (run.shop !== design.shop || run.kind !== design.kind) stop("MATERIALS_DESIGN_MISMATCH");
  const reviewBytes = await readMaterialsRecord(o.reviewPath, o.repo);
  const review = parseMaterialsReview(reviewBytes);
  if (review.request_id !== run.request_id || review.bundle_sha256 !== run.bundle_sha256) stop("MATERIALS_RUN_MISMATCH");
  if (review.materials.length !== run.pictures.length || review.materials.some((m, n) => m.file !== run.pictures[n]!.file || m.sha256 !== run.pictures[n]!.sha256)) stop("MATERIALS_REVIEW_MATERIALS_MISMATCH");
  const reviewSha = sha256(reviewBytes);
  const verdicts = review.materials.map((m) => ({ id: m.id, file: m.file, verdict: m.verdict }));
  const pageSha = materialsReviewPageSha256(review, run);
  // DEV-303 (PR #362 review Low 4): a synthetic design (or materials run) is carried through and refused by the gate below
  const synthetic = design.synthetic === true || run.synthetic === true;
  const base = { request_id: run.request_id, bundle_sha256: run.bundle_sha256, review_sha256: reviewSha, page_sha256: pageSha, verdicts, ...(synthetic ? { synthetic: true as const } : {}), design, run, review };
  if (o.mode === "draft" && !o.approvalPath) return { ...base, approval: null, approved: null };
  if (!o.approvalPath) return stop("MATERIALS_APPROVAL_MISSING");
  const approvalBytes = await readMaterialsRecord(o.approvalPath, o.repo);
  const ap = parseMaterialsApproval(approvalBytes);
  if (ap.request_id !== run.request_id || ap.bundle_sha256 !== run.bundle_sha256) stop("MATERIALS_RUN_MISMATCH");
  if (ap.review_sha256 !== reviewSha) stop("MATERIALS_APPROVAL_REVIEW_MISMATCH");
  if (ap.page_sha256 !== pageSha) stop("MATERIALS_APPROVAL_PAGE_MISMATCH");
  if (Date.parse(ap.decided_at) < Date.parse(review.reviewed_at)) stop("MATERIALS_APPROVAL_BEFORE_REVIEW");
  // only reviewed pictures, each once, in the review's order
  const order = ap.approved_materials.map((x) => review.materials.findIndex((m) => m.file === x.file && m.sha256 === x.sha256));
  if (order.some((i) => i < 0) || order.some((i, n) => n > 0 && i <= order[n - 1]!)) stop("MATERIALS_APPROVAL_MATERIALS_MISMATCH");
  const approval = { sha256: sha256(approvalBytes), decision: ap.decision };
  if (o.mode === "gate") {
    if (synthetic) stop("MATERIALS_DESIGN_SYNTHETIC");
    if (ap.decision !== "approve") stop("MATERIALS_NOT_APPROVED");
    if (order.some((i) => review.materials[i]!.verdict === "fail")) stop("MATERIALS_APPROVAL_HAS_FAIL");
  }
  return { ...base, approval, approved: ap };
}

/** What stage 5 receives: the approved pictures (bytes and SHA-256s) and the records that bind them. */
export type ApprovedMaterials = {
  request_id: string;
  bundle_sha256: string;
  shop: string;
  kind: "real_shop" | "fictional" | null;
  design: { request_id: string; bundle_sha256: string; review_sha256: string; approval_sha256: string };
  review_sha256: string;
  page_sha256: string;
  approval_sha256: string;
  materials: (MaterialPicture & { id: string })[];
};

/** The approved materials, or a MaterialsApprovalStop: the gate check above. */
export async function approvedMaterials(o: { design: ApprovedDesignRecords; bundleDir: string; reviewPath: string; approvalPath: string; repo: string }): Promise<ApprovedMaterials> {
  const c = await checkMaterialsApproval({ ...o, mode: "gate" });
  const materials = c.approved!.approved_materials.map((x) => {
    const pic = c.run.pictures.find((p) => p.file === x.file)!;
    return { id: c.review.materials.find((m) => m.file === x.file)!.id, ...pic };
  });
  return {
    request_id: c.request_id,
    bundle_sha256: c.bundle_sha256,
    shop: c.run.shop,
    kind: c.run.kind,
    design: { request_id: c.design.request_id, bundle_sha256: c.design.bundle_sha256, review_sha256: c.design.review_sha256, approval_sha256: c.design.approval_sha256 },
    review_sha256: c.review_sha256,
    page_sha256: c.page_sha256,
    approval_sha256: c.approval!.sha256,
    materials,
  };
}
