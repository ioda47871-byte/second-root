/**
 * Phase 2f-1: renders a checked Codex prototype at PC 1440 and SP 390 with
 * deviceScaleFactor 1 (CSS px = PNG px), reusing comp-impl's safe page opener
 * (network shut except the page's own files, JavaScript off, service workers
 * blocked) and its height cap (16000). This is the ONLY file outside comp-impl
 * allowed to import it (comp-impl isolation test); nothing else of comp-impl is
 * used: no implementation CSS allowlist, no fixed structure, no comp spec.
 *
 * The full-page capture is clipped to the viewport width, so a page that
 * overflows sideways still yields a 1440 / 390 wide picture; the overflow
 * itself is reported (scrollWidth) for the caller to record, never hidden.
 *
 * It also measures, in the rendered page, the box of every section the design
 * declares (`data-section="<id>"`), so the artifact's geometry comes from the
 * render instead of Codex's estimate.
 */
import type { Browser } from "playwright";
import type { PageAsset } from "../comp-impl/page";
import { MAX_PAGE_HEIGHT, openCompPage, type Viewport } from "../comp-impl/render";

/**
 * Both widths are plain viewports at deviceScaleFactor 1 (CSS px = PNG px). The 390 one does not use the mobile
 * emulation: with it, a page without a viewport meta tag is laid out 980 px wide, so a prototype that forgot the tag
 * would be refused for nothing. Media queries still see 390 px.
 */
export const RENDER_VIEWPORTS = {
  desktop_1440: { width: 1440, height: 900, scale: 1, mobile: false },
  mobile_390: { width: 390, height: 844, scale: 1, mobile: false },
} as const satisfies Record<string, Viewport>;
export type RenderKey = keyof typeof RENDER_VIEWPORTS;

export type MeasuredBox = { x: number; y: number; w: number; h: number };
export type RenderedViewport = {
  png: Buffer;
  /** Requests the page tried that were not its own files (any is a safety stop for the caller). */
  blocked: number;
  /** Full document height and width in CSS px. */
  scrollHeight: number;
  scrollWidth: number;
  /** Section id → its box in CSS px (page coordinates); absent when no element carries the marker. */
  sections: Record<string, MeasuredBox | null>;
};

export class RenderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RenderError";
  }
}

const MEASURE = (ids: readonly string[]) => `((ids) => {
  const out = {};
  for (const id of ids) {
    const el = document.querySelector('[data-section="' + CSS.escape(id) + '"]');
    if (!el) { out[id] = null; continue; }
    const r = el.getBoundingClientRect();
    const shown = getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
    out[id] = shown ? { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
  }
  return { sections: out, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth };
})(${JSON.stringify(ids)})`;

/** Renders one viewport; the page serves only index.html, style.css and the given assets. */
async function renderAt(browser: Browser, proto: { html: string; css: string }, assets: ReadonlyMap<string, Buffer>, key: RenderKey, sectionIds: readonly string[]): Promise<RenderedViewport> {
  const page: Parameters<typeof openCompPage>[1] = {
    dir: "",
    html: proto.html,
    css: proto.css,
    assets: [] as PageAsset[],
    files: new Map(assets),
    htmlSha256: "",
    cssSha256: "",
  };
  let opened;
  try {
    opened = await openCompPage(browser, page, RENDER_VIEWPORTS[key]);
  } catch {
    throw new RenderError("RENDER_FAILED");
  }
  try {
    const m = (await opened.page.evaluate(MEASURE(sectionIds))) as { sections: Record<string, MeasuredBox | null>; scrollHeight: number; scrollWidth: number };
    const width = RENDER_VIEWPORTS[key].width;
    const height = Math.max(m.scrollHeight, RENDER_VIEWPORTS[key].height);
    if (!(height > 0 && height <= MAX_PAGE_HEIGHT)) throw new RenderError("RENDER_PAGE_TOO_TALL");
    let png: Buffer;
    try {
      png = await opened.page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height }, animations: "disabled", caret: "hide" });
    } catch {
      throw new RenderError("RENDER_FAILED");
    }
    return { png, blocked: opened.blocked(), scrollHeight: m.scrollHeight, scrollWidth: m.scrollWidth, sections: m.sections };
  } finally {
    await opened.context.close();
  }
}

/** Renders PC 1440 and SP 390. The prototype must link its CSS as style.css; assets are served at assets/<id>.png. */
export async function renderPrototype(browser: Browser, proto: { html: string; css: string }, assets: ReadonlyMap<string, Buffer>, sectionIds: readonly string[]) {
  return {
    desktop_1440: await renderAt(browser, proto, assets, "desktop_1440", sectionIds),
    mobile_390: await renderAt(browser, proto, assets, "mobile_390", sectionIds),
  };
}
