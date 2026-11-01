/**
 * DEV-139 (Issue #177 A): the design-to-implementation comparison, OFFLINE and REPORT-ONLY.
 *
 * Input: an implementation lane (DEV-128: the artifact record and the design's PC / SP originals, never the Codex
 * prototype) and Claude's implementation of it (index.html, style.css and its PNG assets). The implementation is drawn
 * here at PC 1440 and SP 390 under the same conditions as the design originals (deviceScaleFactor 1, JS off, every
 * request outside its own files refused, full page clipped to the width; the 390 width is a plain viewport, as in
 * Phase 2f), its [data-section] boxes are measured, and each viewport is compared with the original by DEV-131's
 * compareViewport (SSIM, colour, edges, section position / order / size), giving its cause codes.
 *
 * What it records instead of guessing:
 * - each input's SHA-256, and for each viewport whether the design original is present. An original that is missing,
 *   is a concept image (not a browser render at that width) or does not match its hash in lane.json is NOT compared:
 *   it is never treated as the original;
 * - where the design's section boxes come from: measured by the Phase 2f runner (html_prototype_screenshot) or declared;
 * - a render that failed, with its first line, never a clean result.
 *
 * What it never does: decide. `passing` is always false, no threshold of its own (DEV-131's provisional ones), no gate,
 * no retry, no repair. It is not imported by the runner, a generator, a worker or the repair loop.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Browser } from "playwright";
import { DesignArtifact } from "../artifact/schema";
import { compareViewport, viewportDifferences, type Box, type RenderSide, type Viewport, type ViewportCompare } from "./compare";

const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = { desktop_1440: { width: 1440, height: 900 }, mobile_390: { width: 390, height: 844 } };
const ORIGIN = "http://impl-lane.invalid";
const MAX_PAGE_HEIGHT = 16000;
const MiB = 1024 * 1024;
/** What is read: the artifact schema's own limits for the record, the originals, a prototype's HTML / CSS and an asset. */
export const IMPL_COMPARE_LIMITS = { laneJson: MiB, artifactJson: MiB, original: { desktop_1440: 24 * MiB, mobile_390: 12 * MiB }, html: 384 * 1024, css: 256 * 1024, asset: 16 * MiB, assets: 32 } as const;

export type Implementation = { html: string; css: string; assets: ReadonlyMap<string, Buffer> };

export type DesignState = "present" | "missing" | "not_a_render" | "file_changed" | "file_unreadable";
export type ViewportReport = {
  design: { state: DesignState; path: string | null; sha256: string | null; rendered_from: string | null; box_source: "measured_by_runner" | "declared" | null };
  implementation: { state: "rendered" | "render_failed" | "not_rendered"; detail: string | null; png_sha256: string | null; height: number | null; scroll_width: number | null; blocked_requests: number | null };
  compare: ViewportCompare | null;
  differences: string[];
};
export type ImplCompareReport = {
  schema: "impl_compare_report_v0";
  scope: "offline_report_only";
  advisory: true;
  passing: false;
  /** compared: both viewports measured; partial: one; not_compared: none (never a clean result). A refused comparison (its code) is not measured. */
  status: "compared" | "partial" | "not_compared";
  lane: { artifact_id: string; artifact_json_sha256: string; lane_json_sha256: string };
  implementation: { html_sha256: string; css_sha256: string; assets: { path: string; sha256: string }[] };
  viewports: Record<Viewport, ViewportReport>;
  /** Cause codes of the compared viewports (DEV-131's vocabulary, PROVISIONAL thresholds). */
  differences: string[];
  notes: string[];
};

export class LaneReadError extends Error {
  constructor(readonly code: "LANE_JSON_INVALID" | "ARTIFACT_UNREADABLE" | "ARTIFACT_CHANGED" | "ARTIFACT_INVALID") {
    super(code);
    this.name = "LaneReadError";
  }
}

const NOTES = [
  "Report only: passing is always false; no gate, no approval, no repair. The owner compares the two pages.",
  "Thresholds and cause codes are DEV-131's, provisional (Issue #159).",
  "A viewport whose original is missing, is a concept image or does not match lane.json is not compared.",
  "Section boxes declared (not measured by the runner) are as reliable as the declaration.",
];

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .split("\n")[0]!
    .replace(/(?:\/[^\s/:]+)+\/?/g, "<path>")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 160) || "unknown";

/** A regular file, never through a link, at most `max` bytes (checked on the open handle); else null. */
export async function readNoFollow(path: string, max: number): Promise<Buffer | null> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return bytesRead === st.size ? buf : null;
  } finally {
    await fh.close();
  }
}

type LaneFile = { path: string; role: string; sha256: string };

/** Inside (or equal to) the directory; only ".." itself or "../…" leaves it. */
export const insideDir = (dir: string, path: string) => {
  const r = relative(dir, path);
  return r === "" || !(r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r));
};

/** A file of `dir` read without following a link anywhere on its path (the real path must stay inside the real `dir`). */
export async function readInside(dir: string, rel: string, max: number): Promise<Buffer | null> {
  const root = await realpath(dir).catch(() => null);
  const real = await realpath(join(dir, rel)).catch(() => null);
  if (!root || !real || real !== join(root, rel) || !insideDir(root, real)) return null;
  return readNoFollow(real, max);
}
type DesignSide = { state: DesignState; side: RenderSide | null; meta: ViewportReport["design"] };

/** Reads the lane: lane.json, the artifact record it names (hash checked) and each viewport's original. */
export async function readLane(laneDir: string): Promise<{ artifactId: string; artifactSha: string; laneSha: string; sectionIds: string[]; design: Record<Viewport, DesignSide> }> {
  const laneBytes = await readInside(laneDir, "lane.json", IMPL_COMPARE_LIMITS.laneJson);
  if (!laneBytes) throw new LaneReadError("LANE_JSON_INVALID");
  let lane: { schema?: unknown; artifact_json_sha256?: unknown; files?: unknown };
  try {
    lane = JSON.parse(laneBytes.toString("utf8")) as typeof lane;
  } catch {
    throw new LaneReadError("LANE_JSON_INVALID");
  }
  const files = Array.isArray(lane.files) ? (lane.files as LaneFile[]).filter((f) => f && typeof f.path === "string" && typeof f.role === "string" && typeof f.sha256 === "string") : [];
  if (lane.schema !== "implementation_lane_v1" || typeof lane.artifact_json_sha256 !== "string" || !Array.isArray(lane.files) || files.length !== lane.files.length) throw new LaneReadError("LANE_JSON_INVALID");
  const artifactBytes = await readInside(laneDir, "artifact.json", IMPL_COMPARE_LIMITS.artifactJson);
  if (!artifactBytes) throw new LaneReadError("ARTIFACT_UNREADABLE");
  const artifactSha = sha256(artifactBytes);
  // the record is the one the lane was built from
  if (artifactSha !== lane.artifact_json_sha256 || !files.some((f) => f.path === "artifact.json" && f.role === "artifact" && f.sha256 === artifactSha)) throw new LaneReadError("ARTIFACT_CHANGED");
  let parsed;
  try {
    parsed = DesignArtifact.safeParse(JSON.parse(artifactBytes.toString("utf8")));
  } catch {
    throw new LaneReadError("ARTIFACT_INVALID");
  }
  if (!parsed.success) throw new LaneReadError("ARTIFACT_INVALID");
  const a = parsed.data;
  const spec = a.declared.structure_spec;
  const design = {} as Record<Viewport, DesignSide>;
  for (const v of ["desktop_1440", "mobile_390"] as const) {
    const o = a.observed.originals[v];
    const none = (state: DesignState, extra: Partial<ViewportReport["design"]> = {}): DesignSide => ({ state, side: null, meta: { state, path: null, sha256: null, rendered_from: null, box_source: null, ...extra } });
    if (o.state !== "present") {
      design[v] = none("missing");
      continue;
    }
    // a concept image is a picture of an idea, not the page at this width: never the original to compare with
    if (o.kind !== "viewport_render") {
      design[v] = none("not_a_render", { path: o.path, rendered_from: o.rendered_from });
      continue;
    }
    const listed = files.find((f) => f.path === o.path && f.role === "original");
    if (!listed) {
      design[v] = none("missing", { path: o.path, rendered_from: o.rendered_from });
      continue;
    }
    const png = await readInside(laneDir, o.path, IMPL_COMPARE_LIMITS.original[v]);
    if (!png) {
      design[v] = none("file_unreadable", { path: o.path, rendered_from: o.rendered_from });
      continue;
    }
    if (sha256(png) !== listed.sha256) {
      design[v] = none("file_changed", { path: o.path, sha256: sha256(png), rendered_from: o.rendered_from });
      continue;
    }
    const sections = spec.sections.map((s) => {
      const b = s.boxes[v];
      return { id: s.id, box: b.w > 0 && b.h > 0 ? { ...b } : null };
    });
    design[v] = {
      state: "present",
      side: { png, sections },
      meta: { state: "present", path: o.path, sha256: listed.sha256, rendered_from: o.rendered_from, box_source: o.rendered_from === "html_prototype_screenshot" ? "measured_by_runner" : "declared" },
    };
  }
  return { artifactId: a.artifact_id, artifactSha, laneSha: sha256(laneBytes), sectionIds: spec.sections.map((s) => s.id), design };
}

/**
 * The design's section boxes, measured exactly as the Phase 2f runner measured the design's own (render-prototype.ts;
 * copied, since the implementation lane does not import phase2f): the first element carrying the id; hidden
 * (display: none / visibility: hidden) is 0×0; a 0-size root (display: contents, all content positioned) is measured
 * by what it paints, unless it clips. Plus how many elements carry each id: two would hide one section behind its twin.
 */
const MEASURE = (ids: readonly string[]) => `(() => {
  const ids = ${JSON.stringify(ids)};
  const out = {};
  const count = {};
  for (const id of ids) {
    count[id] = document.querySelectorAll('[data-section="' + CSS.escape(id) + '"]').length;
    const el = document.querySelector('[data-section="' + CSS.escape(id) + '"]');
    if (!el) { out[id] = null; continue; }
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") { out[id] = { x: 0, y: 0, w: 0, h: 0 }; continue; }
    let r = el.getBoundingClientRect();
    let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible" || /paint|strict|content/.test(cs.contain) || cs.clipPath !== "none";
    if ((r.width === 0 || r.height === 0) && clips && cs.display !== "contents") { out[id] = { x: 0, y: 0, w: 0, h: 0 }; continue; }
    if (r.width === 0 || r.height === 0) {
      box = null;
      const add = (dr) => {
        if (dr.width === 0 || dr.height === 0) return;
        box = box ? { l: Math.min(box.l, dr.left), t: Math.min(box.t, dr.top), r: Math.max(box.r, dr.right), b: Math.max(box.b, dr.bottom) } : { l: dr.left, t: dr.top, r: dr.right, b: dr.bottom };
      };
      for (const d of el.querySelectorAll("*")) {
        const dcs = getComputedStyle(d);
        if (dcs.display === "none" || dcs.visibility === "hidden") continue;
        add(d.getBoundingClientRect());
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (!t.textContent || !t.textContent.trim()) continue;
        const pcs = t.parentElement ? getComputedStyle(t.parentElement) : null;
        if (pcs && (pcs.display === "none" || pcs.visibility === "hidden")) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const cr of range.getClientRects()) add(cr);
      }
      if (!box) { out[id] = { x: 0, y: 0, w: 0, h: 0 }; continue; }
    }
    out[id] = { x: box.l + scrollX, y: box.t + scrollY, w: box.r - box.l, h: box.b - box.t };
  }
  return { sections: out, count, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth };
})()`;

export type ImplRender = RenderSide & { blocked: number; scrollHeight: number; scrollWidth: number };

/** Draws the implementation at one width: its own files only (index.html, style.css, assets/*), JS off. */
export async function renderImplementation(browser: Browser, impl: Implementation, v: Viewport, sectionIds: readonly string[]): Promise<ImplRender> {
  const size = VIEWPORT_SIZES[v];
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, reducedMotion: "reduce", javaScriptEnabled: false, serviceWorkers: "block" });
  let blocked = 0;
  try {
    await context.route("**/*", async (route) => {
      let url: URL;
      try {
        url = new URL(route.request().url());
      } catch {
        blocked += 1;
        return route.abort();
      }
      if (url.origin !== ORIGIN || url.search !== "" || url.hash !== "") {
        blocked += 1;
        return route.abort();
      }
      const path = url.pathname.replace(/^\//, "");
      if (path === "index.html") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: impl.html });
      if (path === "style.css") return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: impl.css });
      const file = impl.assets.get(path);
      if (file) return route.fulfill({ status: 200, contentType: "image/png", body: file });
      blocked += 1;
      return route.fulfill({ status: 404, body: "" });
    });
    const page = await context.newPage();
    const res = await page.goto(`${ORIGIN}/index.html`, { waitUntil: "load" });
    if (res?.status() !== 200) throw new Error("the page did not load");
    await page.evaluate("document.fonts.ready.then(() => true)");
    const m = (await page.evaluate(MEASURE(sectionIds))) as { sections: Record<string, Box | null>; count: Record<string, number>; scrollHeight: number; scrollWidth: number };
    const height = Math.max(m.scrollHeight, size.height);
    if (!(height > 0 && height <= MAX_PAGE_HEIGHT)) throw new Error(`page too tall (${height} px)`);
    const png = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: size.width, height }, animations: "disabled", caret: "hide" });
    // a twin is listed again, so the comparison refuses the viewport (DUPLICATE_SECTION_ID) instead of measuring one of them
    const sections = sectionIds.flatMap((id) => Array.from({ length: Math.max(1, m.count[id] ?? 0) }, () => ({ id, box: m.sections[id] ?? null })));
    return { png, sections, blocked, scrollHeight: m.scrollHeight, scrollWidth: m.scrollWidth };
  } finally {
    await context.close();
  }
}

/**
 * Compares the implementation with the lane's design at both widths. `browser` is null when it could not be started:
 * the report then says so (render_failed), never a clean result. Throws LaneReadError for an unusable lane.
 */
export async function compareImplementation(browser: Browser | null, laneDir: string, impl: Implementation, launchError?: unknown): Promise<ImplCompareReport> {
  const lane = await readLane(laneDir);
  const viewports = {} as Record<Viewport, ViewportReport>;
  for (const v of ["desktop_1440", "mobile_390"] as const) {
    const d = lane.design[v];
    const notRendered = { state: "not_rendered" as const, detail: null, png_sha256: null, height: null, scroll_width: null, blocked_requests: null };
    if (!d.side) {
      viewports[v] = { design: d.meta, implementation: notRendered, compare: null, differences: [] };
      continue;
    }
    if (!browser) {
      viewports[v] = { design: d.meta, implementation: { ...notRendered, state: "render_failed", detail: `BROWSER_LAUNCH_FAILED: ${firstLine(launchError)}`.slice(0, 160) }, compare: null, differences: [] };
      continue;
    }
    let r: ImplRender;
    try {
      r = await renderImplementation(browser, impl, v, lane.sectionIds);
    } catch (e) {
      viewports[v] = { design: d.meta, implementation: { ...notRendered, state: "render_failed", detail: firstLine(e) }, compare: null, differences: [] };
      continue;
    }
    const compare = compareViewport(v, d.side, r);
    viewports[v] = {
      design: d.meta,
      implementation: { state: "rendered", detail: null, png_sha256: sha256(r.png), height: r.scrollHeight, scroll_width: r.scrollWidth, blocked_requests: r.blocked },
      compare,
      differences: viewportDifferences(compare),
    };
  }
  // a viewport the comparison refused (DECODE_FAILED, WIDTH_MISMATCH, DUPLICATE_SECTION_ID) measured nothing: not compared
  const compared = (["desktop_1440", "mobile_390"] as const).filter((v) => viewports[v].compare !== null && viewports[v].compare!.code === null).length;
  return {
    schema: "impl_compare_report_v0",
    scope: "offline_report_only",
    advisory: true,
    passing: false,
    status: compared === 2 ? "compared" : compared === 1 ? "partial" : "not_compared",
    lane: { artifact_id: lane.artifactId, artifact_json_sha256: lane.artifactSha, lane_json_sha256: lane.laneSha },
    implementation: { html_sha256: sha256(impl.html), css_sha256: sha256(impl.css), assets: [...impl.assets].map(([path, b]) => ({ path, sha256: sha256(b) })).sort((x, y) => x.path.localeCompare(y.path)) },
    viewports,
    differences: [...viewports.desktop_1440.differences, ...viewports.mobile_390.differences],
    notes: NOTES,
  };
}
