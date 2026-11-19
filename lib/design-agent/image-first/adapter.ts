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
 */
import { createHash } from "node:crypto";
import type { Browser } from "playwright";
import { compareViewport, viewportDifferences, type Box, type ViewportCompare } from "../impl-lane/compare";
import { renderImplementation, SECTION_ATTRIBUTES, type Implementation, type SectionAttribute } from "../impl-lane/impl-compare";
import { handoffOf, type ImageFirstVerdict } from "./validate";
import { VIEWPORTS, VIEWPORT_WIDTHS, type ImageFirstViewport } from "./record";

export class ImageFirstStop extends Error {
  constructor(readonly code: "NOT_READY_FOR_IMPLEMENTATION" | "INPUT_WIDTH_MISMATCH") {
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

/** The comparison's inputs for a READY verdict; anything else (REJECT, awaiting the owner, a copied object) is refused. */
export function toImplCompareInput(verdict: ImageFirstVerdict): ImageFirstImplInput {
  const h = handoffOf(verdict);
  if (!h) throw new ImageFirstStop("NOT_READY_FOR_IMPLEMENTATION");
  const viewports = {} as ImageFirstImplInput["viewports"];
  for (const v of VIEWPORTS) {
    const c = h.composites[v];
    if (c.width !== VIEWPORT_WIDTHS[v]) throw new ImageFirstStop("INPUT_WIDTH_MISMATCH");
    viewports[v] = { width: c.width, height: c.height, png: c.png, png_sha256: sha256(c.png), box_source: "declared", sections: c.sections.map((s) => ({ id: s.id, box: { ...s.box } })), parts: c.parts.map((p) => ({ ...p })) };
  }
  return { schema: "image_first_impl_input_v0", run_id: h.runId, record_sha256: h.recordSha256, viewports };
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
  const viewports = {} as ImageFirstCompareReport["viewports"];
  for (const v of VIEWPORTS) {
    const d = input.viewports[v];
    if (d.width !== VIEWPORT_WIDTHS[v]) throw new ImageFirstStop("INPUT_WIDTH_MISMATCH");
    const design = { composite_sha256: d.png_sha256, width: d.width, height: d.height, box_source: "declared" as const };
    const failed = (detail: string) => ({ design, implementation: { state: "render_failed" as const, detail, png_sha256: null, height: null, scroll_width: null, blocked_requests: null }, compare: null, differences: [] });
    if (!browser) {
      viewports[v] = failed(`BROWSER_LAUNCH_FAILED: ${firstLine(launchError)}`.slice(0, 160));
      continue;
    }
    try {
      const r = await renderImplementation(browser, impl, v, d.sections.map((s) => s.id), opts);
      const compare = compareViewport(v, { png: d.png, sections: d.sections.map((s) => ({ id: s.id, box: { ...s.box } })) }, r);
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
