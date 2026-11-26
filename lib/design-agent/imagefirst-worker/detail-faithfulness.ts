/**
 * DEV-364 PR 4 (docs/design/quality-proof-plan.md §2.4, §6 row 4): the faithfulness record of an implementation against
 * the approved whole-page design AND, where present, the detail comps of its regions. ADVISORY, like the stage-6
 * comparison (impl-compare-approved.ts): `passing` is always false; it approves, repairs and retries nothing.
 *
 *   sr_detail_faithfulness_v1  { schema, advisory: true, passing: false, request_id, synthetic?, approved: { bundle_sha256,
 *     review_sha256, approval_sha256 }, impl_compare_sha256, whole_page: { status, pc / sp: { page scores, differences } },
 *     regions: [{ target, view, box, against_whole_page: { mean_abs_diff, correlation }, detail: { sha256,
 *     against_detail: { mean_abs_diff, correlation } } | null }], measured, not_measured, created_at }
 *
 * The whole page: the stage-6 comparison's own record (its folder: record.json and its PC / SP captures, bound to this
 * approved design by its SHA-256s), carried over as it is. Each region: the box (0..1) cut from the finished site's
 * capture and from the approved picture of its view, and from a detail comp when one is given, each reduced to a small
 * grey grid and compared (mean absolute difference 0..1, Pearson correlation; null where a grid is flat). A detail comp
 * is support only: it is bound here by its SHA-256 alone (its own review / approval comes with its run path, later),
 * and it never replaces the whole page as the reference.
 *
 * Inputs are private (outside the repository, no link); the record is written to an empty private folder (0700 / 0600).
 * Failures throw DetailFaithfulnessStop with a fixed code; the first approval's DESIGN_* codes pass through.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";
import { approvedDesignRun, DesignApprovalStop } from "./design-approval";

export const DETAIL_FAITHFULNESS_SCHEMA = "sr_detail_faithfulness_v1";
export const DETAIL_FAITHFULNESS_CODES = [
  "DETAIL_FAITH_NOT_WHOLE_PAGE",
  "DETAIL_FAITH_IMPL_INVALID",
  "DETAIL_FAITH_IMPL_MISMATCH",
  "DETAIL_FAITH_CAPTURE_MISMATCH",
  "DETAIL_FAITH_REGION_OUTSIDE",
  "DETAIL_FAITH_TOO_MANY_REGIONS",
  "DETAIL_FAITH_IMAGE_INVALID",
  "DETAIL_FAITH_INPUT_UNSAFE",
  "DETAIL_FAITH_IN_REPO",
  "DETAIL_FAITH_OUT_NOT_EMPTY",
] as const;
export class DetailFaithfulnessStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DetailFaithfulnessStop";
  }
}
const stop = (code: (typeof DETAIL_FAITHFULNESS_CODES)[number]): never => {
  throw new DetailFaithfulnessStop(code);
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_IMAGE = 24 * 1024 * 1024;
/** The grey grid every region is reduced to before it is compared. */
export const GRID = 32;
/** At most as many regions as a detail comp request may name. */
export const MAX_REGIONS = 5;

/** A private input file (outside the repository, no link at the last step, regular, within `max`). */
async function readPrivate(path: string, repo: string, max: number): Promise<Buffer> {
  const full = resolve(path);
  const real = await realpath(full).catch(() => null);
  if (real === null) return stop("DETAIL_FAITH_INPUT_UNSAFE");
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (within(real, realRepo) || within(full, resolve(repo))) stop("DETAIL_FAITH_IN_REPO");
  let h;
  try {
    h = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return stop("DETAIL_FAITH_INPUT_UNSAFE");
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > max) stop("DETAIL_FAITH_INPUT_UNSAFE");
    return await h.readFile();
  } finally {
    await h.close();
  }
}

export type Box = { x: number; y: number; w: number; h: number };
const inside = (b: Box) => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9;

/** A PNG's region (or the whole picture) as a GRID × GRID grey grid (0..1). */
async function grid(png: Buffer, box: Box | null): Promise<number[]> {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return stop("DETAIL_FAITH_IMAGE_INVALID");
  try {
    let img = sharp(png);
    if (box) {
      const m = await sharp(png).metadata();
      const W = m.width ?? 0;
      const H = m.height ?? 0;
      const left = Math.min(W - 1, Math.max(0, Math.floor(box.x * W)));
      const top = Math.min(H - 1, Math.max(0, Math.floor(box.y * H)));
      const width = Math.max(1, Math.min(W - left, Math.round(box.w * W)));
      const height = Math.max(1, Math.min(H - top, Math.round(box.h * H)));
      img = img.extract({ left, top, width, height });
    }
    const raw = await img.removeAlpha().greyscale().resize(GRID, GRID, { fit: "fill" }).raw().toBuffer();
    return [...raw].map((v) => v / 255);
  } catch {
    return stop("DETAIL_FAITH_IMAGE_INVALID");
  }
}

/** Mean absolute difference (0..1) and Pearson correlation (null when either grid is flat). */
export function compareGrids(a: readonly number[], b: readonly number[]): { mean_abs_diff: number; correlation: number | null } {
  const n = a.length;
  const mad = a.reduce((s, x, i) => s + Math.abs(x - b[i]!), 0) / n;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { mean_abs_diff: round(mad), correlation: saa < 1e-9 || sbb < 1e-9 ? null : round(sab / Math.sqrt(saa * sbb)) };
}

export type DetailRegionInput = { target: "hero" | "products" | "shop_info"; view: "pc" | "sp"; box: Box; detailPath?: string };
export type DetailFaithfulnessRecord = {
  schema: typeof DETAIL_FAITHFULNESS_SCHEMA;
  advisory: true;
  passing: false;
  request_id: string;
  synthetic?: true;
  approved: { bundle_sha256: string; review_sha256: string; approval_sha256: string };
  impl_compare_sha256: string;
  whole_page: { status: string; pc: { page: unknown; differences: string[] }; sp: { page: unknown; differences: string[] } };
  regions: { target: string; view: "pc" | "sp"; box: Box; against_whole_page: ReturnType<typeof compareGrids>; detail: { sha256: string; against_detail: ReturnType<typeof compareGrids> } | null }[];
  measured: string[];
  not_measured: string[];
  created_at: string;
};

const MEASURED = [
  "the whole page: the stage-6 comparison's page scores and differences per viewport (carried over)",
  `each region of the finished site's capture against the same region of the approved picture, and against its detail comp when given (a ${GRID}×${GRID} grey grid: mean absolute difference and correlation)`,
];
const NOT_MEASURED = [
  "exact positions: a region is placed by the same fractions on the capture as on the approved picture, which is the page drawn smaller (a long page's regions may sit lower or higher on the capture)",
  "text, Japanese wording and colour per element (the reviewers and the owner)",
  "whether a detail comp itself is faithful to the approved design (its own review, with its run path, later)",
];

/**
 * The faithfulness record (see the header): the approved whole page (its gate), the stage-6 comparison of that design
 * (record.json and captures in implCompareDir), 1..MAX_REGIONS regions with optional detail comps. Writes
 * <outDir>/record.json (empty private folder outside the repository). Advisory only.
 */
export async function checkDetailFaithfulness(o: {
  design: { bundleDir: string; reviewPath: string; approvalPath: string };
  implCompareDir: string;
  regions: readonly DetailRegionInput[];
  outDir: string;
  repo: string;
  now?: () => number;
}): Promise<{ record: DetailFaithfulnessRecord; record_sha256: string; path: string }> {
  let design;
  try {
    design = await approvedDesignRun({ ...o.design, repo: o.repo });
  } catch (error) {
    if (error instanceof DesignApprovalStop) throw new DetailFaithfulnessStop(error.code);
    throw error;
  }
  if (design.images.pc.length !== 1 || design.images.sp.length !== 1) stop("DETAIL_FAITH_NOT_WHOLE_PAGE");
  if (o.regions.length < 1 || o.regions.length > MAX_REGIONS) stop("DETAIL_FAITH_TOO_MANY_REGIONS");
  if (o.regions.some((r) => !inside(r.box))) stop("DETAIL_FAITH_REGION_OUTSIDE");
  // the stage-6 comparison of THIS approved design, and its captures
  const implBytes = await readPrivate(join(o.implCompareDir, "record.json"), o.repo, 1024 * 1024);
  let impl: {
    schema?: unknown;
    request_id?: unknown;
    status?: unknown;
    approved?: { bundle_sha256?: unknown; review_sha256?: unknown; approval_sha256?: unknown };
    viewports?: Record<"desktop_1440" | "mobile_390", { capture?: { sha256?: unknown }; page?: unknown; differences?: unknown }>;
  };
  try {
    impl = JSON.parse(implBytes.toString("utf8")) as typeof impl;
  } catch {
    return stop("DETAIL_FAITH_IMPL_INVALID");
  }
  const vp = impl.viewports;
  if (impl.schema !== "sr_impl_compare_v1" || typeof impl.status !== "string" || !vp?.desktop_1440 || !vp.mobile_390) return stop("DETAIL_FAITH_IMPL_INVALID");
  if (impl.request_id !== design.request_id || impl.approved?.bundle_sha256 !== design.bundle_sha256 || impl.approved.review_sha256 !== design.review_sha256 || impl.approved.approval_sha256 !== design.approval_sha256) stop("DETAIL_FAITH_IMPL_MISMATCH");
  const captureOf = async (tag: "pc" | "sp", want: unknown) => {
    const b = await readPrivate(join(o.implCompareDir, "images", `${tag}-capture.png`), o.repo, MAX_IMAGE);
    if (sha256(b) !== want) stop("DETAIL_FAITH_CAPTURE_MISMATCH");
    return b;
  };
  const captures = { pc: await captureOf("pc", vp.desktop_1440.capture?.sha256), sp: await captureOf("sp", vp.mobile_390.capture?.sha256) };
  const approvedPic = { pc: design.images.pc[0]!.bytes, sp: design.images.sp[0]!.bytes };
  const regions: DetailFaithfulnessRecord["regions"] = [];
  for (const r of o.regions) {
    const site = await grid(captures[r.view], r.box);
    const against_whole_page = compareGrids(site, await grid(approvedPic[r.view], r.box));
    let detail: DetailFaithfulnessRecord["regions"][number]["detail"] = null;
    if (r.detailPath) {
      const bytes = await readPrivate(r.detailPath, o.repo, MAX_IMAGE);
      detail = { sha256: sha256(bytes), against_detail: compareGrids(site, await grid(bytes, null)) };
    }
    regions.push({ target: r.target, view: r.view, box: r.box, against_whole_page, detail });
  }
  const diffs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const record: DetailFaithfulnessRecord = {
    schema: DETAIL_FAITHFULNESS_SCHEMA,
    advisory: true,
    passing: false,
    request_id: design.request_id,
    ...(design.synthetic ? { synthetic: true as const } : {}),
    approved: { bundle_sha256: design.bundle_sha256, review_sha256: design.review_sha256, approval_sha256: design.approval_sha256 },
    impl_compare_sha256: sha256(implBytes),
    whole_page: { status: impl.status as string, pc: { page: vp.desktop_1440.page ?? null, differences: diffs(vp.desktop_1440.differences) }, sp: { page: vp.mobile_390.page ?? null, differences: diffs(vp.mobile_390.differences) } },
    regions,
    measured: MEASURED,
    not_measured: NOT_MEASURED,
    created_at: new Date((o.now ?? Date.now)()).toISOString(),
  };
  // the output: an empty private folder outside the repository
  const out = resolve(o.outDir);
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  if (within(out, resolve(o.repo)) || within((await realpath(join(out, "..")).catch(() => out)) as string, realRepo)) stop("DETAIL_FAITH_IN_REPO");
  const existing = await lstat(out).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(out)).length > 0)) stop("DETAIL_FAITH_OUT_NOT_EMPTY");
  await mkdir(out, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const h = await open(join(out, "record.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(text);
  } finally {
    await h.close();
  }
  return { record, record_sha256: sha256(text), path: join(out, "record.json") };
}
