/**
 * Issue #293 P1: the hand-off of an APPROVED model comp to the existing implementation comparison.
 *
 * Why an adapter (and not the lane): the implementation lane (impl-lane/handoff.ts) hands off only an Artifact whose
 * intake is `render_pair_complete`, and impl-compare.ts compares only originals that are browser renders at 1440 / 390
 * (a concept image is `not_a_render`). Both rules stay exactly as they are. A model comp is neither: it is a sequence of
 * pictures of free size. So this adapter turns a READY verdict (validate.ts, owner rubric passed) into the comparison's
 * own inputs — one composite per viewport at EXACTLY 1440 / 390 px wide (each part scaled; the scale recorded) and the
 * declared section boxes converted to composite px (box source "declared") — and runs the same pieces impl-compare.ts
 * runs: renderImplementation (JS off, own files only) and compareViewport / viewportDifferences (DEV-131's provisional
 * thresholds, cause codes). REPORT-ONLY: passing is always false; nothing here approves, repairs or retries.
 *
 * DEV-303 §6.1 change 8 (production flow §1 stage 6): the same comparison from an owner-approved REQUEST-MODE run
 * (toApprovedImplInput / compareApprovedDesign). Its design side is the approved whole-page picture per viewport, drawn
 * by the browser at exactly 1440 / 390 px wide; the caller (imagefirst-worker/impl-compare-approved.ts) has gate-checked
 * the approval. Page-level structure only (a whole-page picture is the page drawn smaller), plus what the capture shows
 * (horizontal overflow, requests not served). Still report-only.
 */
import { createHash } from "node:crypto";
import type { Browser } from "playwright";
import { compareViewport, viewportDifferences, type Box, type ViewportCompare } from "../impl-lane/compare";
import { renderImplementation, SECTION_ATTRIBUTES, type Implementation, type SectionAttribute } from "../impl-lane/impl-compare";
import { handoffOf, type ImageFirstVerdict } from "./validate";
import { VIEWPORTS, VIEWPORT_WIDTHS, type ImageFirstViewport } from "./record";

export class ImageFirstStop extends Error {
  constructor(readonly code: "NOT_READY_FOR_IMPLEMENTATION" | "INPUT_WIDTH_MISMATCH" | "INPUT_NOT_ISSUED" | "INPUT_CHANGED") {
    super(code);
    this.name = "ImageFirstStop";
  }
}

export type ImageFirstImplInput = {
  schema: "image_first_impl_input_v0";
  run_id: string;
  record_sha256: string;
  viewports: Record<
    ImageFirstViewport,
    { width: number; height: number; png: Buffer; png_sha256: string; box_source: "declared"; sections: { id: string; box: Box }[]; parts: { index: number; sha256: string; scale: number; y: number; height: number }[] }
  >;
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The inputs this module issued, with the composite SHAs at issue time: a hand-built or edited input is refused. */
const ISSUED = new WeakMap<ImageFirstImplInput, Record<ImageFirstViewport, string>>();

/** The comparison's inputs for a READY verdict; anything else (REJECT, awaiting the owner, a copied object) is refused. */
export function toImplCompareInput(verdict: ImageFirstVerdict): ImageFirstImplInput {
  const h = handoffOf(verdict);
  if (!h) throw new ImageFirstStop("NOT_READY_FOR_IMPLEMENTATION");
  const viewports = {} as ImageFirstImplInput["viewports"];
  for (const v of VIEWPORTS) {
    const c = h.composites[v];
    if (c.width !== VIEWPORT_WIDTHS[v]) throw new ImageFirstStop("INPUT_WIDTH_MISMATCH");
    const png = Buffer.from(c.png);
    viewports[v] = { width: c.width, height: c.height, png, png_sha256: sha256(png), box_source: "declared", sections: c.sections.map((s) => ({ id: s.id, box: { ...s.box } })), parts: c.parts.map((p) => ({ ...p })) };
  }
  const input: ImageFirstImplInput = { schema: "image_first_impl_input_v0", run_id: h.runId, record_sha256: h.recordSha256, viewports };
  ISSUED.set(input, { desktop_1440: viewports.desktop_1440.png_sha256, mobile_390: viewports.mobile_390.png_sha256 });
  return input;
}

export type ImageFirstCompareReport = {
  schema: "image_first_compare_report_v0";
  scope: "offline_report_only";
  advisory: true;
  passing: false;
  status: "compared" | "partial" | "not_compared";
  run_id: string;
  record_sha256: string;
  implementation: { html_sha256: string; css_sha256: string; assets: { path: string; sha256: string }[] };
  viewports: Record<
    ImageFirstViewport,
    {
      design: { composite_sha256: string; width: number; height: number; box_source: "declared" };
      implementation: { state: "rendered" | "render_failed"; detail: string | null; png_sha256: string | null; height: number | null; scroll_width: number | null; blocked_requests: number | null };
      compare: ViewportCompare | null;
      differences: string[];
    }
  >;
  differences: string[];
  notes: string[];
};

const NOTES = [
  "Report only: passing is always false; no gate, no approval, no repair. The owner compares the comp and the page.",
  "The design side is a model comp: parts scaled to 1440 / 390 and stacked; section boxes are declared, not measured.",
  "Thresholds and cause codes are DEV-131's, provisional (Issue #159).",
];

const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .split("\n")[0]!
    .replace(/(?:\/[^\s/:]+)+\/?/g, "<path>")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 160) || "unknown";

/** Draws the implementation at 1440 and 390 and compares each with the comp composite. `browser` null: render_failed (never clean). */
export async function compareImageFirst(browser: Browser | null, input: ImageFirstImplInput, impl: Implementation, launchError?: unknown, opts: { sectionAttribute?: SectionAttribute } = {}): Promise<ImageFirstCompareReport> {
  if (opts.sectionAttribute !== undefined && !(SECTION_ATTRIBUTES as readonly string[]).includes(opts.sectionAttribute)) throw new Error("unknown section attribute");
  const issued = ISSUED.get(input);
  if (!issued) throw new ImageFirstStop("INPUT_NOT_ISSUED");
  const designs = {} as Record<ImageFirstViewport, Buffer>;
  for (const v of VIEWPORTS) {
    const d = input.viewports[v];
    if (d.width !== VIEWPORT_WIDTHS[v]) throw new ImageFirstStop("INPUT_WIDTH_MISMATCH");
    // the bytes compared are a private copy whose SHA is recomputed and must equal the SHA at issue time
    const png = Buffer.from(d.png);
    if (sha256(png) !== issued[v] || d.png_sha256 !== issued[v]) throw new ImageFirstStop("INPUT_CHANGED");
    designs[v] = png;
  }
  const viewports = {} as ImageFirstCompareReport["viewports"];
  for (const v of VIEWPORTS) {
    const d = input.viewports[v];
    const design = { composite_sha256: issued[v], width: d.width, height: d.height, box_source: "declared" as const };
    const failed = (detail: string) => ({ design, implementation: { state: "render_failed" as const, detail, png_sha256: null, height: null, scroll_width: null, blocked_requests: null }, compare: null, differences: [] });
    if (!browser) {
      viewports[v] = failed(`BROWSER_LAUNCH_FAILED: ${firstLine(launchError)}`.slice(0, 160));
      continue;
    }
    try {
      const r = await renderImplementation(browser, impl, v, d.sections.map((s) => s.id), opts);
      const compare = compareViewport(v, { png: designs[v], sections: d.sections.map((s) => ({ id: s.id, box: { ...s.box } })) }, r);
      viewports[v] = { design, implementation: { state: "rendered", detail: null, png_sha256: sha256(r.png), height: r.scrollHeight, scroll_width: r.scrollWidth, blocked_requests: r.blocked }, compare, differences: viewportDifferences(compare) };
    } catch (e) {
      viewports[v] = failed(firstLine(e));
    }
  }
  const compared = VIEWPORTS.filter((v) => viewports[v].compare !== null && viewports[v].compare!.code === null).length;
  return {
    schema: "image_first_compare_report_v0",
    scope: "offline_report_only",
    advisory: true,
    passing: false,
    status: compared === 2 ? "compared" : compared === 1 ? "partial" : "not_compared",
    run_id: input.run_id,
    record_sha256: input.record_sha256,
    implementation: { html_sha256: sha256(impl.html), css_sha256: sha256(impl.css), assets: [...impl.assets].map(([path, b]) => ({ path, sha256: sha256(b) })).sort((x, y) => x.path.localeCompare(y.path)) },
    viewports,
    differences: [...viewports.desktop_1440.differences, ...viewports.mobile_390.differences],
    notes: NOTES,
  };
}

// ---- DEV-303 §6.1 change 8: an owner-approved request-mode run (stage 6) ----------------------------------------------

/**
 * One owner-approved whole-page design picture of a request-mode run (imagefirst-worker/design-approval.ts
 * approvedDesignRun: the bundle verified, the review and approval gate-checked). The caller hands its verified bytes.
 */
export type ApprovedDesignPicture = { file: string; sha256: string; bytes: Buffer };
export type ApprovedDesignForCompare = { request_id: string; bundle_sha256: string; review_sha256: string; approval_sha256: string; pictures: Record<ImageFirstViewport, ApprovedDesignPicture> };
export type ApprovedImplInput = {
  schema: "image_first_approved_impl_input_v0";
  request_id: string;
  bundle_sha256: string;
  review_sha256: string;
  approval_sha256: string;
  /** Per viewport: the approved picture (its SHA-256 as approved) drawn at exactly 1440 / 390 px wide by the browser. */
  viewports: Record<ImageFirstViewport, { source_file: string; source_sha256: string; width: number; height: number; png: Buffer; png_sha256: string }>;
};
const APPROVED_ISSUED = new WeakMap<ApprovedImplInput, Record<ImageFirstViewport, string>>();
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The comparison's design side for an approved whole-page run: each approved picture (bytes = its approved SHA-256, a
 * PNG) drawn by the browser at exactly the viewport width (its aspect kept; JS off; nothing loads but the picture
 * itself, inlined). A whole-page picture is the page drawn smaller in one frame (production flow §3.2), so only
 * page-level structure compares (no declared section boxes). Throws ImageFirstStop on bytes that are not the approved ones.
 */
export async function toApprovedImplInput(browser: Browser, approved: ApprovedDesignForCompare): Promise<ApprovedImplInput> {
  const viewports = {} as ApprovedImplInput["viewports"];
  for (const v of VIEWPORTS) {
    const p = approved.pictures[v];
    const bytes = Buffer.from(p.bytes);
    if (sha256(bytes) !== p.sha256 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new ImageFirstStop("INPUT_CHANGED");
    const width = VIEWPORT_WIDTHS[v];
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block", reducedMotion: "reduce" });
    try {
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}img{display:block;width:${width}px;height:auto}</style></head><body><img alt="" src="data:image/png;base64,${bytes.toString("base64")}"></body></html>`, { waitUntil: "load" });
      const height = (await page.evaluate("Math.ceil(document.images[0].getBoundingClientRect().height)")) as number;
      if (!(height > 0 && height <= 16000)) throw new ImageFirstStop("INPUT_WIDTH_MISMATCH");
      const png = await page.screenshot({ clip: { x: 0, y: 0, width, height }, fullPage: true, animations: "disabled", caret: "hide" });
      viewports[v] = { source_file: p.file, source_sha256: p.sha256, width, height, png, png_sha256: sha256(png) };
    } finally {
      await context.close();
    }
  }
  const input: ApprovedImplInput = { schema: "image_first_approved_impl_input_v0", request_id: approved.request_id, bundle_sha256: approved.bundle_sha256, review_sha256: approved.review_sha256, approval_sha256: approved.approval_sha256, viewports };
  APPROVED_ISSUED.set(input, { desktop_1440: viewports.desktop_1440.png_sha256, mobile_390: viewports.mobile_390.png_sha256 });
  return input;
}

export type ApprovedCompareReport = {
  schema: "image_first_approved_compare_v0";
  scope: "offline_report_only";
  advisory: true;
  passing: false;
  status: "compared" | "partial" | "not_compared";
  request_id: string;
  bundle_sha256: string;
  review_sha256: string;
  approval_sha256: string;
  implementation: { html_sha256: string; css_sha256: string; assets: { path: string; sha256: string }[] };
  viewports: Record<
    ImageFirstViewport,
    {
      design: { source_file: string; source_sha256: string; scaled_sha256: string; width: number; height: number };
      implementation: { state: "rendered" | "render_failed"; detail: string | null; png: Buffer | null; png_sha256: string | null; height: number | null; scroll_width: number | null; blocked_requests: number | null };
      compare: ViewportCompare | null;
      differences: string[];
      /** What the capture itself shows: a page wider than the viewport, requests the page made that were not served (a missing picture or file). */
      findings: string[];
    }
  >;
  differences: string[];
  findings: string[];
  notes: string[];
};

const APPROVED_NOTES = [
  "Report only: passing is always false; no gate, no approval, no repair. The owner compares the approved design and the page.",
  "The design side is the owner-approved whole-page picture of each viewport, drawn at 1440 / 390 px wide. It is the whole page drawn smaller in one frame, so only page-level structure is measured: grid SSIM (layout), colour blocks, edge IoU (density) and the height ratio. The height ratio and PAGE_HEIGHT are expected to differ (the picture is a condensed overview); no section boxes are declared, so section order, position, colour and size per section are not measured.",
  "Thresholds and cause codes are DEV-131's, provisional (Issue #159).",
];
const PREFIXES: Record<ImageFirstViewport, string> = { desktop_1440: "PC", mobile_390: "SP" };

/**
 * Draws the implementation at 1440 and 390 (renderImplementation: its own files only, JS off, network blocked) and
 * compares each capture with the approved picture at page level. `browser` null: render_failed (never clean).
 */
export async function compareApprovedDesign(browser: Browser | null, input: ApprovedImplInput, impl: Implementation, launchError?: unknown): Promise<ApprovedCompareReport> {
  const issued = APPROVED_ISSUED.get(input);
  if (!issued) throw new ImageFirstStop("INPUT_NOT_ISSUED");
  const viewports = {} as ApprovedCompareReport["viewports"];
  for (const v of VIEWPORTS) {
    const d = input.viewports[v];
    const png = Buffer.from(d.png);
    if (d.width !== VIEWPORT_WIDTHS[v]) throw new ImageFirstStop("INPUT_WIDTH_MISMATCH");
    if (sha256(png) !== issued[v] || d.png_sha256 !== issued[v]) throw new ImageFirstStop("INPUT_CHANGED");
    const design = { source_file: d.source_file, source_sha256: d.source_sha256, scaled_sha256: issued[v], width: d.width, height: d.height };
    const failed = (detail: string) => ({ design, implementation: { state: "render_failed" as const, detail, png: null, png_sha256: null, height: null, scroll_width: null, blocked_requests: null }, compare: null, differences: [], findings: [] });
    if (!browser) {
      viewports[v] = failed(`BROWSER_LAUNCH_FAILED: ${firstLine(launchError)}`.slice(0, 160));
      continue;
    }
    try {
      const r = await renderImplementation(browser, impl, v, []);
      const compare = compareViewport(v, { png, sections: [] }, r);
      const findings = [...(r.scrollWidth > VIEWPORT_WIDTHS[v] ? [`${PREFIXES[v]}_HORIZONTAL_OVERFLOW`] : []), ...(r.blocked > 0 ? [`${PREFIXES[v]}_UNSERVED_REQUESTS`] : [])];
      viewports[v] = { design, implementation: { state: "rendered", detail: null, png: r.png, png_sha256: sha256(r.png), height: r.scrollHeight, scroll_width: r.scrollWidth, blocked_requests: r.blocked }, compare, differences: viewportDifferences(compare), findings };
    } catch (e) {
      viewports[v] = failed(firstLine(e));
    }
  }
  const compared = VIEWPORTS.filter((v) => viewports[v].compare !== null && viewports[v].compare!.code === null).length;
  return {
    schema: "image_first_approved_compare_v0",
    scope: "offline_report_only",
    advisory: true,
    passing: false,
    status: compared === 2 ? "compared" : compared === 1 ? "partial" : "not_compared",
    request_id: input.request_id,
    bundle_sha256: input.bundle_sha256,
    review_sha256: input.review_sha256,
    approval_sha256: input.approval_sha256,
    implementation: { html_sha256: sha256(impl.html), css_sha256: sha256(impl.css), assets: [...impl.assets].map(([path, b]) => ({ path, sha256: sha256(b) })).sort((x, y) => x.path.localeCompare(y.path)) },
    viewports,
    differences: [...viewports.desktop_1440.differences, ...viewports.mobile_390.differences],
    findings: [...viewports.desktop_1440.findings, ...viewports.mobile_390.findings],
    notes: APPROVED_NOTES,
  };
}
