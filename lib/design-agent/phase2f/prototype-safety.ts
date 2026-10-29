/**
 * Phase 2f-1: the safety check a Codex HTML/CSS prototype must pass BEFORE it
 * is rendered. It refuses what could run code or reach outside the page; it
 * does NOT apply comp-impl's implementation CSS allowlist or any fixed page
 * structure: a research prototype may use any layout, any CSS property, inline
 * SVG and any visual idea, because over-constraining it would make it generic.
 *
 * Refused:
 * - elements that run code, embed other documents or submit anywhere
 *   (script, iframe, frame, object, embed, applet, form, base, portal, meta refresh,
 *   SVG foreignObject / script / animation of href)
 * - any `on*` event attribute, `javascript:` / `data:` / `vbscript:` URLs
 * - any URL that is not the page's own stylesheet (style.css), one of its declared
 *   assets (assets/<id>.png) or an in-page anchor (#...)
 * - CSS @import, url() to anything but a declared asset, expression(), behavior,
 *   -moz-binding (in style.css, <style> elements and style attributes)
 *
 * The HTML is parsed by Chromium's own parser (DOMParser on a blank page with
 * JavaScript off and every request aborted), not by regular expressions. The
 * renderer then still runs with JavaScript off and the network shut: this check
 * is the first of two independent barriers.
 */
import type { Browser } from "playwright";

export const PROTOTYPE_STYLESHEET = "style.css";
export const ASSET_PATH = /^assets\/A\d{1,2}\.png$/;

export class PrototypeUnsafe extends Error {
  readonly code = "PROTOTYPE_UNSAFE";
  constructor(readonly detail: string) {
    super(`PROTOTYPE_UNSAFE: ${detail.replace(/[^\x20-\x7e]/g, "?").slice(0, 200)}`);
    this.name = "PrototypeUnsafe";
  }
}

const FORBIDDEN_ELEMENTS = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "base", "portal", "foreignobject", "animate", "set", "animatemotion", "animatetransform", "noscript"];
const URL_ATTRIBUTES = ["href", "src", "srcset", "poster", "data", "action", "formaction", "background", "xlink:href", "ping", "cite", "longdesc", "manifest", "icon", "lowsrc", "dynsrc", "codebase", "archive"];

/** url() targets in a CSS text, quoted strings understood (a ")" inside quotes does not end the url). */
export function cssUrls(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"')\s]*))\s*\)/gi)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1").trim());
  }
  return out;
}

/** A url() target a prototype may use: a declared asset, or an in-page reference (#id, e.g. an inline SVG filter). */
const allowedUrl = (target: string, assets: ReadonlySet<string>) => assets.has(target) || /^#[A-Za-z0-9_-]+$/.test(target);

const decodeEscapes = (css: string) =>
  css.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n0-9a-fA-F])/g, (_m, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : (ch ?? ""),
  );

/** The CSS as written with its strings and comments removed (CSS tokenisation: escapes, quotes, newline-ended strings). */
export function outsideStringsAndComments(css: string): string {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") {
      out += css.slice(i, i + 2);
      i++;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? css.length : end + 1;
    } else if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c && css[i] !== "\n"; i++) if (css[i] === "\\") i++;
      out += " ";
    } else out += c;
  }
  return out;
}

/** CSS problems in one stylesheet text: forbidden at-rules or functions, and url() to anything but a declared asset or #id. */
export function cssProblems(css: string, assets: ReadonlySet<string>, o: { canonical?: boolean } = {}): string[] {
  const out: string[] = [];
  // Chromium's re-serialised text has no comments and no escapes left: read it as is (a "/*" inside a string stays text)
  if (o.canonical) {
    if (/@import/i.test(css)) out.push("css @import");
    if (/expression\s*\(|behavior\s*:|-moz-binding|javascript:/i.test(css)) out.push("css code execution");
    for (const target of cssUrls(css)) if (!allowedUrl(target, assets)) out.push(`css url: ${target.slice(0, 80)}`);
    if (/image-set\(|image\(|src\(/i.test(css)) out.push("css image function other than url()");
    return out;
  }
  // escapes are decoded first (so "u\\72l(" cannot hide a url() and "\\201C" in content stays allowed), then comments dropped
  const decoded = decodeEscapes(css);
  const flat = decoded.replace(/\/\*[\s\S]*?\*\//g, " ");
  // @import is looked for in the CSS outside strings and comments, tokenised as written (so a "/*" inside a string
  // cannot hide it and a comment that mentions it does not count); Chromium's re-serialisation drops @import,
  // so this check is the one that sees it
  if (/@import/i.test(decodeEscapes(outsideStringsAndComments(css)))) out.push("css @import");
  if (/expression\s*\(|behavior\s*:|-moz-binding|javascript:/i.test(flat)) out.push("css code execution");
  for (const target of cssUrls(flat)) if (!allowedUrl(target, assets)) out.push(`css url: ${target.slice(0, 80)}`);
  if (/image-set\(|image\(|src\(/i.test(flat)) out.push("css image function other than url()");
  return out;
}

type Parsed = {
  elements: string[];
  attributes: { el: string; name: string; value: string }[];
  styles: string[];
  images: { src: string; alt: string }[];
  /** Every stylesheet text (style.css, <style> blocks, style attributes) as Chromium parsed and re-serialised it; null if it could not. */
  canonical: (string | null)[];
};

/** Parses the HTML with Chromium's parser on a blank page (JS off, every request aborted) and lists what the check needs. */
async function parseHtml(browser: Browser, html: string, css: string): Promise<Parsed> {
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const script = `((html, css) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const elements = [], attributes = [], styles = [], images = [], canonical = [];
      // Chromium's own CSS parser: comments, escapes and strings resolved exactly as the renderer would
      const canon = (text) => { try { const sh = new CSSStyleSheet(); sh.replaceSync(text); return [...sh.cssRules].map((r) => r.cssText).join("\\n"); } catch (e) { return null; } };
      canonical.push(canon(css));
      const walk = (root) => {
        for (const el of root.querySelectorAll("*")) {
          elements.push(el.localName.toLowerCase());
          for (const a of el.attributes) attributes.push({ el: el.localName.toLowerCase(), name: a.name.toLowerCase(), value: a.value });
          if (el.localName.toLowerCase() === "style") { styles.push(el.textContent || ""); canonical.push(canon(el.textContent || "")); }
          if (el.hasAttribute("style")) canonical.push(el.style ? el.style.cssText : null);
          if (el.localName.toLowerCase() === "img") images.push({ src: (el.getAttribute("src") || "").trim(), alt: (el.getAttribute("alt") || "").trim() });
          if (el.localName.toLowerCase() === "template" && el.content) walk(el.content);
        }
      };
      walk(doc);
      return { elements, attributes, styles, images, canonical };
    })(${JSON.stringify(html)}, ${JSON.stringify(css)})`;
    return (await page.evaluate(script)) as Parsed;
  } finally {
    await context.close();
  }
}

/**
 * Throws PrototypeUnsafe on the first problem. Otherwise returns, for each declared asset shown by an <img>, its alt
 * text (route C uses it as the image request; Codex wrote it, the facts stay the source of truth).
 */
export async function checkPrototype(browser: Browser, proto: { html: string; css: string }, assetPaths: readonly string[]): Promise<{ alts: Record<string, string> }> {
  const assets = new Set(assetPaths);
  for (const p of assets) if (!ASSET_PATH.test(p)) throw new PrototypeUnsafe(`asset path: ${p}`);
  const parsed = await parseHtml(browser, proto.html, proto.css);
  for (const el of parsed.elements) if (FORBIDDEN_ELEMENTS.includes(el)) throw new PrototypeUnsafe(`element <${el}>`);
  for (const a of parsed.attributes) {
    if (a.name.startsWith("on")) throw new PrototypeUnsafe(`event attribute ${a.name}`);
    // harmless boilerplate is fine; refresh, cookies and anything else are not
    if (a.el === "meta" && a.name === "http-equiv" && !["content-type", "x-ua-compatible", "content-language"].includes(a.value.trim().toLowerCase())) throw new PrototypeUnsafe(`meta http-equiv ${a.value.slice(0, 40)}`);
    // any attribute holding a url() (SVG fill, mask, filter, clip-path, marker ...) follows the CSS url rule
    if (a.name !== "style" && /url\s*\(/i.test(a.value)) {
      if (a.value.includes("\\")) throw new PrototypeUnsafe(`${a.el} ${a.name}: escaped url`);
      for (const t of cssUrls(a.value)) if (!allowedUrl(t, assets)) throw new PrototypeUnsafe(`${a.el} ${a.name}: url ${t.slice(0, 80)}`);
    }
    if (a.name === "style") {
      const p = cssProblems(a.value, assets);
      if (p.length) throw new PrototypeUnsafe(`style attribute: ${p[0]}`);
    }
    if (URL_ATTRIBUTES.includes(a.name)) {
      const values = a.name === "srcset" ? a.value.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "") : [a.value.trim()];
      for (const v of values) {
        if (v.startsWith("#") && /^#[A-Za-z0-9_-]*$/.test(v)) continue;
        if (a.el === "link" && v === PROTOTYPE_STYLESHEET) continue;
        if ((a.name === "src" || a.name === "srcset" || a.name === "href" || a.name === "xlink:href") && assets.has(v)) continue;
        throw new PrototypeUnsafe(`${a.el} ${a.name}: ${v.slice(0, 80)}`);
      }
    }
  }
  for (const a of parsed.attributes) {
    if (a.el === "link" && a.name === "rel" && a.value.trim().toLowerCase() !== "stylesheet") throw new PrototypeUnsafe(`link rel ${a.value}`);
  }
  for (const css of [...parsed.styles, proto.css]) {
    const p = cssProblems(css, assets);
    if (p.length) throw new PrototypeUnsafe(p[0]!);
  }
  // the same rules on Chromium's own reading of every stylesheet (catches comment, string and escape tricks)
  for (const css of parsed.canonical) {
    if (css === null) throw new PrototypeUnsafe("css not parseable");
    const p = cssProblems(css, assets, { canonical: true });
    if (p.length) throw new PrototypeUnsafe(p[0]!);
  }
  const alts: Record<string, string> = {};
  for (const img of parsed.images) if (assets.has(img.src) && img.alt && !(img.src in alts)) alts[img.src] = img.alt.slice(0, 400);
  return { alts };
}
