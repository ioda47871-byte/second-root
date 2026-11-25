/**
 * DEV-303 §6.1 change 5 (docs/design/image-first-production-flow.md §1 stage 3, §3.3, §3.4): the design review of a
 * delivered IMAGE_FIRST design run and the owner's approval. Generation success alone never advances a design.
 *
 * The run is the sealed bundle the review inbox holds (~/sr-runs/review-inbox/<id>/, bundle.ts verifyBundleDir): its id
 * and its bundle SHA-256 name it, its parts/pc-*.png and parts/sp-*.png (with their manifest SHA-256s) are the images.
 * The bundle directory is sealed (no other file may be added there), so both records live elsewhere, privately and
 * OUTSIDE the repository: ~/second-root-shops/<shop_id>/design-reviews/<id>.review.json / <id>.approval.json (a real shop)
 * or a private folder of the worker's for a fictional one.
 *
 *   sr_design_review_v1    { schema, request_id, bundle_sha256, images: { pc: [{file, sha256}], sp: [...] },
 *                            axes: { originality, shop_specificity, information_design, japanese, pc_sp_completeness }:
 *                              each { verdict: pass | revise | fail, evidence: [{ image: pc | sp, region, note }] (1..10) },
 *                            reviewer, reviewed_at }
 *                          The independent review (another Claude context): ADVICE ONLY. Its verdicts decide nothing.
 *   sr_design_approval_v1  { schema, request_id, bundle_sha256, approved_images (= the review's images), review_sha256
 *                            (the review file's bytes), page_sha256 (the viewing page the owner looked at), decision:
 *                            approve | revise | reject, decided_at, note? }
 *                          Claude writes it ONLY when the owner says so. It records that statement, bound to exactly
 *                          the review and the page the owner saw; it is NOT the owner's signature.
 *
 * Gate (what later stages depend on, approvedDesignRun): the bundle verifies; the review's images are exactly the
 * bundle's design parts with their SHA-256s; all five axes carry evidence on images that exist; the approval binds this
 * review, this page and these images and is decided at or after the review; the decision is approve; and no axis is
 * `fail` (the simplest safe rule: a `fail` is not overridden by an approval; the owner asks for a new review or a new
 * design instead). page_sha256 is recomputed by re-rendering the page from the review and the run: a change to the page
 * template or its escaping invalidates earlier approvals (fail safe; the owner looks at the new page again).
 *
 * The viewing page (writeDesignReviewPage): static local HTML (no script, no network, no external font; the case-study
 * page's CSP), the images copied next to it, every text escaped, never the approval (so recording the approval does not
 * change the page).
 *
 * Failures throw DesignApprovalStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { escapeHtml, VIEWING_PAGE_CSP } from "../case-study/case-study";
import { BundleStop, verifyBundleDir } from "./bundle";

export const DESIGN_REVIEW_SCHEMA = "sr_design_review_v1";
export const DESIGN_APPROVAL_SCHEMA = "sr_design_approval_v1";
/** The five axes of §3.3, in its order. */
export const DESIGN_AXES = ["originality", "shop_specificity", "information_design", "japanese", "pc_sp_completeness"] as const;
export type DesignAxis = (typeof DESIGN_AXES)[number];
export const RECORD_MAX_BYTES = 64 * 1024;

export const DESIGN_APPROVAL_CODES = [
  "DESIGN_RECORD_MISSING",
  "DESIGN_RECORD_UNSAFE",
  "DESIGN_RECORD_TOO_LARGE",
  "DESIGN_RECORD_IN_REPO",
  "DESIGN_REVIEW_INVALID",
  "DESIGN_REVIEW_TEXT_UNSAFE",
  "DESIGN_REVIEW_AXIS_MISSING",
  "DESIGN_REVIEW_EVIDENCE_MISSING",
  "DESIGN_BUNDLE_INVALID",
  "DESIGN_BUNDLE_NOT_A_DESIGN",
  "DESIGN_RUN_MISMATCH",
  "DESIGN_IMAGES_MISMATCH",
  "DESIGN_APPROVAL_MISSING",
  "DESIGN_APPROVAL_INVALID",
  "DESIGN_APPROVAL_REVIEW_MISMATCH",
  "DESIGN_APPROVAL_PAGE_MISMATCH",
  "DESIGN_APPROVAL_IMAGES_MISMATCH",
  "DESIGN_NOT_APPROVED",
  "DESIGN_REVIEW_HAS_FAIL",
  "DESIGN_PAGE_IN_REPO",
  "DESIGN_PAGE_DIR_NOT_EMPTY",
  "DESIGN_PAGE_DIR_UNSAFE",
  "DESIGN_APPROVAL_BEFORE_REVIEW",
] as const;
export type DesignApprovalCode = (typeof DESIGN_APPROVAL_CODES)[number];
export class DesignApprovalStop extends Error {
  constructor(readonly code: DesignApprovalCode) {
    super(code);
    this.name = "DesignApprovalStop";
  }
}
const stop = (code: DesignApprovalCode): never => {
  throw new DesignApprovalStop(code);
};

const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const UTC = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((s) => Number.isFinite(Date.parse(s)), "utc_invalid");
/** One plain line: no control character, markup or link (the page escapes every text anyway). */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u2028\u2029]|[<>`]|https?:|ftp:|:\/\/|www\./i;
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0 && s === s.trim() && !UNSAFE_TEXT.test(s), "design_text_unsafe");
const REQUEST_ID = z.string().regex(/^req-[a-z0-9][a-z0-9-]{2,58}$/);
const ImageRef = z.strictObject({ file: z.string().regex(/^parts\/(?:pc|sp)-[a-z0-9-]{1,36}\.png$/), sha256: SHA });
const Images = z.strictObject({ pc: z.array(ImageRef).min(1).max(6), sp: z.array(ImageRef).min(1).max(6) });
export type DesignImages = z.infer<typeof Images>;
const Evidence = z.strictObject({ image: z.enum(["pc", "sp"]), region: Text(80), note: Text(300) });
const Axis = z.strictObject({ verdict: z.enum(["pass", "revise", "fail"]), evidence: z.array(Evidence).max(10) });

export const DesignReview = z.strictObject({
  schema: z.literal(DESIGN_REVIEW_SCHEMA),
  request_id: REQUEST_ID,
  bundle_sha256: SHA,
  images: Images,
  // every axis is checked by name so a missing one is named (DESIGN_REVIEW_AXIS_MISSING), never a generic schema error
  axes: z.record(z.string(), z.unknown()),
  reviewer: Text(60),
  reviewed_at: UTC,
});
export type DesignReview = Omit<z.infer<typeof DesignReview>, "axes"> & { axes: Record<DesignAxis, z.infer<typeof Axis>> };

export const DesignApproval = z.strictObject({
  schema: z.literal(DESIGN_APPROVAL_SCHEMA),
  request_id: REQUEST_ID,
  bundle_sha256: SHA,
  approved_images: Images,
  review_sha256: SHA,
  page_sha256: SHA,
  decision: z.enum(["approve", "revise", "reject"]),
  decided_at: UTC,
  note: Text(400).optional(),
});
export type DesignApproval = z.infer<typeof DesignApproval>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A private record: outside the repository (links resolved), a regular file, no link at the last step, small. */
export async function readRecord(path: string, repo: string): Promise<Buffer> {
  const full = resolve(path);
  const real = await realpath(full).catch(() => null);
  if (real === null) return stop("DESIGN_RECORD_MISSING");
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (within(real, realRepo) || within(full, resolve(repo))) stop("DESIGN_RECORD_IN_REPO");
  let h;
  try {
    h = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return stop("DESIGN_RECORD_UNSAFE");
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1) stop("DESIGN_RECORD_UNSAFE");
    if (st.size > RECORD_MAX_BYTES) stop("DESIGN_RECORD_TOO_LARGE");
    const bytes = await h.readFile();
    if (bytes.length > RECORD_MAX_BYTES) stop("DESIGN_RECORD_TOO_LARGE");
    return bytes;
  } finally {
    await h.close();
  }
}

const parseJson = (b: Buffer, code: DesignApprovalCode): unknown => {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return stop(code);
  }
};

/** The review's bytes: schema, all five axes (by name), each with evidence on an image the review lists. */
export function parseDesignReview(bytes: Buffer): DesignReview {
  if (bytes.length > RECORD_MAX_BYTES) stop("DESIGN_RECORD_TOO_LARGE");
  const r = DesignReview.safeParse(parseJson(bytes, "DESIGN_REVIEW_INVALID"));
  if (!r.success) return stop(r.error.issues.some((i) => i.message === "design_text_unsafe") ? "DESIGN_REVIEW_TEXT_UNSAFE" : "DESIGN_REVIEW_INVALID");
  const keys = Object.keys(r.data.axes);
  if (DESIGN_AXES.some((a) => !keys.includes(a))) stop("DESIGN_REVIEW_AXIS_MISSING");
  if (keys.some((k) => !(DESIGN_AXES as readonly string[]).includes(k))) stop("DESIGN_REVIEW_INVALID");
  const axes = {} as Record<DesignAxis, z.infer<typeof Axis>>;
  for (const a of DESIGN_AXES) {
    const p = Axis.safeParse(r.data.axes[a]);
    if (!p.success) return stop(p.error.issues.some((i) => i.message === "design_text_unsafe") ? "DESIGN_REVIEW_TEXT_UNSAFE" : "DESIGN_REVIEW_INVALID");
    if (p.data.evidence.length === 0) stop("DESIGN_REVIEW_EVIDENCE_MISSING");
    axes[a] = p.data;
  }
  return { ...r.data, axes };
}

/** The approval's bytes: schema only (the binding is checked by checkDesignApproval). */
export function parseDesignApproval(bytes: Buffer): DesignApproval {
  if (bytes.length > RECORD_MAX_BYTES) stop("DESIGN_RECORD_TOO_LARGE");
  const r = DesignApproval.safeParse(parseJson(bytes, "DESIGN_APPROVAL_INVALID"));
  return r.success ? r.data : stop("DESIGN_APPROVAL_INVALID");
}

/** One design image of the delivered run, its bytes as the bundle verified them. */
export type RunImage = { file: string; sha256: string; bytes: Buffer };
export type DeliveredRun = { request_id: string; bundle_sha256: string; images: { pc: RunImage[]; sp: RunImage[] } };

/** The delivered design run: the sealed bundle verifies, it is a design (not image materials), its PC / SP parts. */
export async function readDeliveredRun(bundleDir: string): Promise<DeliveredRun> {
  let v;
  try {
    v = await verifyBundleDir(bundleDir);
  } catch (error) {
    if (error instanceof BundleStop) return stop("DESIGN_BUNDLE_INVALID");
    throw error;
  }
  if (v.manifest.image_material === true) stop("DESIGN_BUNDLE_NOT_A_DESIGN");
  const parts = v.manifest.files.filter((f) => f.role === "part");
  const of = (view: "pc" | "sp") =>
    parts
      .filter((f) => f.path.startsWith(`parts/${view}-`))
      .map((f) => ({ file: f.path, sha256: f.sha256, bytes: v.entries.find((e) => e.path === f.path)!.bytes }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const images = { pc: of("pc"), sp: of("sp") };
  if (images.pc.length === 0 || images.sp.length === 0 || images.pc.length + images.sp.length !== parts.length) stop("DESIGN_BUNDLE_NOT_A_DESIGN");
  return { request_id: v.manifest.bundle_id, bundle_sha256: v.bundle_sha256, images };
}

const sameImages = (a: DesignImages, run: DeliveredRun["images"]) =>
  (["pc", "sp"] as const).every((v) => a[v].length === run[v].length && a[v].every((x, n) => x.file === run[v][n]!.file && x.sha256 === run[v][n]!.sha256));

// ---- the owner's viewing page --------------------------------------------------------------------------------------

const AXIS_LABEL: Record<DesignAxis, string> = { originality: "独自性", shop_specificity: "店舗固有性", information_design: "情報設計", japanese: "日本語", pc_sp_completeness: "PC/SP の完成度" };
const VERDICT_LABEL = { pass: "合格", revise: "要修正", fail: "不合格" } as const;
/** The copied image names: images/<pc|sp>-<n>.png (nothing from the original name). */
export const pageImageName = (view: "pc" | "sp", n: number) => `images/${view}-${n + 1}.png`;

/** The page's HTML (pure): the run, the images, the five axes with their evidence; every text escaped; no approval. */
export function renderDesignReviewPage(review: DesignReview, run: DeliveredRun): string {
  const e = escapeHtml;
  const figures = (["pc", "sp"] as const)
    .map((view) => run.images[view].map((img, n) => `<figure><img src="${e(pageImageName(view, n))}" alt="${e(`${view.toUpperCase()} ${n + 1}`)}" loading="lazy"><figcaption>${e(img.file)}<br><code>${e(img.sha256)}</code></figcaption></figure>`).join(""))
    .join("");
  const axes = DESIGN_AXES.map((a) => {
    const x = review.axes[a];
    const rows = x.evidence.map((ev) => `<li><strong>${e(ev.image.toUpperCase())}</strong> ${e(ev.region)}: ${e(ev.note)}</li>`).join("");
    return `<section class="axis"><h2>${e(AXIS_LABEL[a])} <span class="v ${e(x.verdict)}">${e(VERDICT_LABEL[x.verdict])}</span></h2><ul>${rows}</ul></section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEWING_PAGE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${e(review.request_id)} デザイン審査</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1b; --bg: #fbfaf7; --muted: #6a6862; --line: #d9d6cf; --pass: #1f6b3a; --revise: #8a5a00; --fail: #9a3412; }
@media (prefers-color-scheme: dark) { :root { --fg: #ecebe7; --bg: #171716; --muted: #a3a19b; --line: #3a3936; --pass: #6fcf97; --revise: #f2c94c; --fail: #f4a261; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; line-height: 1.7; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 8px; }
h2 { font-size: 1.1rem; border-top: 1px solid var(--line); padding-top: 20px; }
.figs { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 0; flex: 1 1 320px; max-width: 100%; }
figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
figcaption { font-size: 0.8rem; color: var(--muted); word-break: break-all; }
.v { font-size: 0.85rem; font-weight: normal; margin-left: 8px; }
.pass { color: var(--pass); } .revise { color: var(--revise); } .fail { color: var(--fail); }
code { font-size: 0.75rem; }
</style>
</head>
<body>
<main>
<h1>${e(review.request_id)} — デザイン審査（非公開・ローカル）</h1>
<p>bundle SHA-256: <code>${e(run.bundle_sha256)}</code>。審査: ${e(review.reviewer)}（${e(review.reviewed_at)}）。審査は助言で、判定はオーナーが下す。生成の成功だけでは次の段へ進まない。</p>
<p>オーナーが承認・要修正・却下を決めたら、Claude がその旨を承認の記録に書く（このページの index.html の SHA-256 を page_sha256 に、審査の記録の SHA-256 を review_sha256 に）。これはオーナー本人の署名ではない。</p>
<div class="figs">${figures}</div>
${axes}
</main>
</body>
</html>
`;
}
export const designReviewPageSha256 = (review: DesignReview, run: DeliveredRun) => sha256(renderDesignReviewPage(review, run));

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
 * Writes <outDir>/index.html and <outDir>/images/ (the bundle's verified image bytes). The directory must be outside the
 * repository (links resolved) and empty or absent (created 0700; files 0600, never overwritten).
 */
export async function writeDesignReviewPage(review: DesignReview, run: DeliveredRun, o: { outDir: string; repo: string }): Promise<{ page: string; page_sha256: string }> {
  const out = resolve(o.outDir);
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  const inRepo = (p: string | null) => p === null || within(p, realRepo) || within(p, resolve(o.repo));
  if (inRepo(out) || inRepo(await realPlace(out))) stop("DESIGN_PAGE_IN_REPO");
  const existing = await lstat(out).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(out)).length > 0)) stop("DESIGN_PAGE_DIR_NOT_EMPTY");
  // review L2: an existing (empty) directory is ours and private, as one this call creates (0700)
  if (existing && (existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0)) stop("DESIGN_PAGE_DIR_UNSAFE");
  await mkdir(join(out, "images"), { recursive: true, mode: 0o700 });
  if (inRepo(await realpath(out).catch(() => null))) stop("DESIGN_PAGE_IN_REPO");
  // and images/ is a real directory of ours (never a link planted in between)
  const images = await lstat(join(out, "images")).catch(() => null);
  if (!images || !images.isDirectory() || images.isSymbolicLink() || images.uid !== process.getuid?.()) stop("DESIGN_PAGE_DIR_UNSAFE");
  const write = async (rel: string, bytes: Buffer | string) => {
    const h = await open(join(out, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(bytes);
    } finally {
      await h.close();
    }
  };
  for (const view of ["pc", "sp"] as const) for (const [n, img] of run.images[view].entries()) await write(pageImageName(view, n), img.bytes);
  const html = renderDesignReviewPage(review, run);
  await write("index.html", html);
  return { page: join(out, "index.html"), page_sha256: sha256(html) };
}

// ---- the check and the gate ---------------------------------------------------------------------------------------

export type DesignApprovalCheck = {
  request_id: string;
  bundle_sha256: string;
  review_sha256: string;
  page_sha256: string;
  verdicts: Record<DesignAxis, "pass" | "revise" | "fail">;
  approval: { sha256: string; decision: DesignApproval["decision"] } | null;
};

/**
 * The review (and, in gate mode, the approval) against the delivered run. Draft: the review alone (what the owner is
 * about to see). Gate: also the approval, bound to this review's bytes, this page and these images, with decision
 * approve and no axis `fail`. Throws DesignApprovalStop.
 */
export async function checkDesignApproval(o: { bundleDir: string; reviewPath: string; approvalPath?: string; repo: string; mode: "draft" | "gate" }): Promise<DesignApprovalCheck & { run: DeliveredRun; review: DesignReview }> {
  const reviewBytes = await readRecord(o.reviewPath, o.repo);
  const review = parseDesignReview(reviewBytes);
  const run = await readDeliveredRun(o.bundleDir);
  if (review.request_id !== run.request_id || review.bundle_sha256 !== run.bundle_sha256) stop("DESIGN_RUN_MISMATCH");
  if (!sameImages(review.images, run.images)) stop("DESIGN_IMAGES_MISMATCH");
  const reviewSha = sha256(reviewBytes);
  const pageSha = designReviewPageSha256(review, run);
  const verdicts = Object.fromEntries(DESIGN_AXES.map((a) => [a, review.axes[a].verdict])) as DesignApprovalCheck["verdicts"];
  const base = { request_id: run.request_id, bundle_sha256: run.bundle_sha256, review_sha256: reviewSha, page_sha256: pageSha, verdicts, run, review };
  if (o.mode === "draft" && !o.approvalPath) return { ...base, approval: null };
  if (!o.approvalPath) return stop("DESIGN_APPROVAL_MISSING");
  const approvalBytes = await readRecord(o.approvalPath, o.repo);
  const a = parseDesignApproval(approvalBytes);
  if (a.request_id !== run.request_id || a.bundle_sha256 !== run.bundle_sha256) stop("DESIGN_RUN_MISMATCH");
  if (a.review_sha256 !== reviewSha) stop("DESIGN_APPROVAL_REVIEW_MISMATCH");
  if (a.page_sha256 !== pageSha) stop("DESIGN_APPROVAL_PAGE_MISMATCH");
  // review L5: a decision is made after the review it decides on
  if (Date.parse(a.decided_at) < Date.parse(review.reviewed_at)) stop("DESIGN_APPROVAL_BEFORE_REVIEW");
  if (!sameImages(a.approved_images, run.images)) stop("DESIGN_APPROVAL_IMAGES_MISMATCH");
  const approval = { sha256: sha256(approvalBytes), decision: a.decision };
  if (o.mode === "gate") {
    if (a.decision !== "approve") stop("DESIGN_NOT_APPROVED");
    if (DESIGN_AXES.some((x) => review.axes[x].verdict === "fail")) stop("DESIGN_REVIEW_HAS_FAIL");
  }
  return { ...base, approval };
}

/** What a later stage (change 6: materials after approval) receives: the approved run, its images and the records' SHA-256s. */
export type ApprovedDesignRun = { request_id: string; bundle_sha256: string; review_sha256: string; approval_sha256: string; page_sha256: string; images: { pc: RunImage[]; sp: RunImage[] } };

/** The approved design run, or a DesignApprovalStop: the gate check above (decision approve, no axis fail). */
export async function approvedDesignRun(o: { bundleDir: string; reviewPath: string; approvalPath: string; repo: string }): Promise<ApprovedDesignRun> {
  const c = await checkDesignApproval({ ...o, mode: "gate" });
  return { request_id: c.request_id, bundle_sha256: c.bundle_sha256, review_sha256: c.review_sha256, approval_sha256: c.approval!.sha256, page_sha256: c.page_sha256, images: c.run.images };
}
