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
  /**
   * Where each asset really shows in the rendered page (as <img> or a CSS background): the sections that contain it
   * and whether it is visible within the first screen. Measured, not taken from Codex's declaration.
   */
  assets: Record<string, { sections: string[]; outsideSections: boolean; firstScreen: boolean; shown: boolean }>;
};

export class RenderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RenderError";
  }
}

const MEASURE = (ids: readonly string[], assetPaths: readonly string[]) => `((ids, assetPaths) => {
  const out = {};
  const assets = {};
  for (const p of assetPaths) assets[p] = { sections: [], outsideSections: false, firstScreen: false, shown: false };
  // every way an asset can be painted: <img src>, SVG <image href>, and the image properties of the element and its ::before / ::after
  const IMAGE_PROPS = ["backgroundImage", "maskImage", "webkitMaskImage", "borderImageSource", "listStyleImage", "content"];
  const uses = (el, cs, p) => {
    if (el.localName === "img" && (el.getAttribute("src") || "").trim() === p) return true;
    if (el.localName === "image" && ((el.getAttribute("href") || el.getAttribute("xlink:href") || "").trim() === p)) return true;
    const paints = (pseudo) => { const c = getComputedStyle(el, pseudo).content; return c !== "none" && c !== "normal"; };
    // a ::before / ::after with no content is not generated at all, so its image is never painted
    const styles = [cs, ...["::before", "::after"].filter(paints).map((ps) => getComputedStyle(el, ps))];
    for (const style of styles)
      for (const prop of IMAGE_PROPS) if (String(style[prop] || "").includes("/" + p + '"')) return true;
    return false;
  };
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    for (const p of assetPaths) {
      if (!uses(el, cs, p)) continue;
      const r = el.getBoundingClientRect();
      const visible = cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
      const host = el.closest("[data-section]");
      const a = assets[p];
      if (host) { const id = host.getAttribute("data-section"); if (!a.sections.includes(id)) a.sections.push(id); } else a.outsideSections = true;
      if (visible) {
        a.shown = true;
        // in the first screen: at least half of the picture, or of the first screen, is covered by it
        // (measured on the painting element's box: a picture taller than the screen that fills it counts)
        const top = r.top + scrollY, bottom = top + r.height;
        const overlap = Math.max(0, Math.min(bottom, innerHeight) - Math.max(top, 0));
        if (overlap > 0 && overlap >= Math.min(r.height, innerHeight) / 2) a.firstScreen = true;
      }
    }
  }
  for (const id of ids) {
    const el = document.querySelector('[data-section="' + CSS.escape(id) + '"]');
    if (!el) { out[id] = null; continue; }
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") { out[id] = { x: 0, y: 0, w: 0, h: 0 }; continue; }
    let r = el.getBoundingClientRect();
    let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    // a root that measures 0 (all content absolutely positioned, display: contents ...) is measured by what it paints;
    // a 0-size root that clips its content (overflow, paint containment, clip-path) paints nothing and stays hidden
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
      // text that overflows a zero-size box (e.g. vertical text in a 0-height container) is still painted: measure the glyphs
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
  return { sections: out, assets, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth };
})(${JSON.stringify(ids)}, ${JSON.stringify(assetPaths)})`;

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
    const m = (await opened.page.evaluate(MEASURE(sectionIds, [...assets.keys()]))) as Pick<RenderedViewport, "sections" | "assets" | "scrollHeight" | "scrollWidth">;
    const width = RENDER_VIEWPORTS[key].width;
    const height = Math.max(m.scrollHeight, RENDER_VIEWPORTS[key].height);
    if (!(height > 0 && height <= MAX_PAGE_HEIGHT)) throw new RenderError("RENDER_PAGE_TOO_TALL");
    let png: Buffer;
    try {
      png = await opened.page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height }, animations: "disabled", caret: "hide" });
    } catch {
      throw new RenderError("RENDER_FAILED");
    }
    return { png, blocked: opened.blocked(), scrollHeight: m.scrollHeight, scrollWidth: m.scrollWidth, sections: m.sections, assets: m.assets };
  } finally {
    await opened.context.close();
  }
}

/** Renders PC 1440 and SP 390. The prototype must link its CSS as style.css; assets are served at assets/<id>.png. */
export type RenderPrototype = typeof renderPrototype;
export async function renderPrototype(browser: Browser, proto: { html: string; css: string }, assets: ReadonlyMap<string, Buffer>, sectionIds: readonly string[]) {
  return {
    desktop_1440: await renderAt(browser, proto, assets, "desktop_1440", sectionIds),
    mobile_390: await renderAt(browser, proto, assets, "mobile_390", sectionIds),
  };
}
