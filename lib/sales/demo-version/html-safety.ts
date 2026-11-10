/**
 * DEV-196b (spec §7.3・T1・T2・T3・T12): the server's own safety check of a B方式 artifact (index.html + style.css),
 * with the HTML read by parse5 (an HTML-spec tokenizer and tree builder) instead of Chromium, which cannot run on
 * Vercel.
 *
 * What it runs, and how it relates to the Chromium check (Phase 2f prototype-safety):
 *  - the same rule core (FORBIDDEN_ELEMENTS, URL_ATTRIBUTES, cssProblems' first pass on the text as written, cssUrls,
 *    allowedUrl), copied verbatim in ./rule-core.ts and parity-tested;
 *  - INSTEAD of Chromium's second pass over its re-serialised CSS (which the server cannot do), a string-aware CSS
 *    token scan (./css-scan.ts, review round 1 M1) over the stylesheet and every attribute a browser parses as CSS;
 *  - stricter than the Chromium check: element and attribute ALLOWLISTS (the blocklists stay as a second layer),
 *    no `style` attribute / `<style>` element (the CSP has no 'unsafe-inline'), exactly one
 *    `<link rel="stylesheet" href="style.css">`, `href` = `#fragment` only, `<img src>` / `srcset` only the version's
 *    photos, `@import` / `@font-face` / loading at-rules / url() to anything but a photo or `#id` / image functions /
 *    expression() refused, `font-family` only PAGE_FONT_FAMILIES and the generic families (also through `var(--x)`,
 *    also in SVG `font-family`), `font:` shorthand refused, a backslash in an attribute parsed as CSS refused (M2);
 *  - no text from CSS (M3): a non-empty string is allowed only in font-family, grid-template(-areas), font feature
 *    settings and custom properties; `content` / `quotes` / list markers / text-overflow … may not hold a string,
 *    attr() or var(). Visible attribute values (alt, title, aria-label …) are returned in `texts` with the text nodes,
 *    so the word rules and the copy-record check (§7.4) see them;
 *  - order / reservation / cart words and `テスト` refused in every visible text.
 * The CSP (`script-src 'none'`, `img-src` / `style-src` bound to the token path, `sandbox`) stays the backstop.
 *
 * Pure: parse5 and string work only. Every finding is a fixed code (detail is ASCII and short, for logs and tests).
 */
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { cssScanProblems, cssStrings } from "./css-scan";
import { allowedUrl, cssProblems, cssUrls, decodeEscapes, FORBIDDEN_ELEMENTS, outsideStringsAndComments, PAGE_FONT_FAMILIES, PAGE_FONT_GENERIC_FAMILIES, PROTOTYPE_STYLESHEET, URL_ATTRIBUTES } from "./rule-core";

export type HtmlSafetyCode =
  | "HTML_FORBIDDEN_ELEMENT"
  | "HTML_ELEMENT_NOT_ALLOWED"
  | "HTML_ATTRIBUTE_NOT_ALLOWED"
  | "HTML_STYLE_ELEMENT"
  | "HTML_EVENT_ATTRIBUTE"
  | "HTML_STYLE_ATTRIBUTE"
  | "HTML_META_HTTP_EQUIV"
  | "HTML_LINK_NOT_ALLOWED"
  | "HTML_STYLESHEET_COUNT"
  | "HTML_URL_NOT_ALLOWED"
  | "HTML_ATTRIBUTE_URL"
  | "HTML_ATTRIBUTE_ESCAPE"
  | "HTML_SALES_WORD"
  | "HTML_TEST_WORD"
  | "CSS_IMPORT"
  | "CSS_FONT_FACE"
  | "CSS_AT_RULE_NOT_ALLOWED"
  | "CSS_CODE_EXECUTION"
  | "CSS_URL_NOT_ALLOWED"
  | "CSS_IMAGE_FUNCTION"
  | "CSS_SYNTAX_SUSPICIOUS"
  | "CSS_TEXT_IN_CSS"
  | "CSS_FONT_SHORTHAND"
  | "CSS_FONT_FAMILY_NOT_ALLOWED";

export type HtmlSafetyFinding = { code: HtmlSafetyCode; detail?: string };

export type HtmlSafetyResult = {
  ok: boolean;
  findings: HtmlSafetyFinding[];
  /** every non-empty visible text: text nodes and visible attribute values, trimmed (for the copy-record check, §7.4) */
  texts: string[];
};

/** B方式 (route-constraints.md): words that would claim an order, a reservation or a cart. */
export const ARTIFACT_SALES_WORDS = /注文|予約|カート/;
export const ARTIFACT_TEST_WORD = /テスト/;
/** meta http-equiv values that are harmless boilerplate (as in prototype-safety). */
const HARMLESS_HTTP_EQUIV = ["content-type", "x-ua-compatible", "content-language"];
/** Attribute values a reader sees or hears: they join `texts` (word rules and the copy-record check). */
export const VISIBLE_TEXT_ATTRIBUTES = ["alt", "title", "aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "aria-placeholder", "placeholder"];
/** URL attributes beyond the rule core's list (review round 1 L1). */
export const ARTIFACT_EXTRA_URL_ATTRIBUTES = ["attributionsrc", "itemtype", "itemid", "imagesrcset", "profile", "classid", "usemap", "xml:base"];

/** Elements an artifact may contain (lower-case, as compared). Anything else is refused (L1: an allowlist). */
export const ALLOWED_ELEMENTS = new Set([
  // document
  "html", "head", "body", "meta", "title", "link",
  // structure and text
  "main", "header", "footer", "nav", "section", "article", "aside", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "ul", "ol", "li", "dl", "dt", "dd", "figure", "figcaption", "picture", "source", "img", "br", "wbr", "hr",
  "i", "b", "em", "strong", "small", "s", "u", "mark", "time", "address", "blockquote", "q", "sup", "sub",
  "ruby", "rt", "rp", "abbr", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
  // inline SVG (shapes, text, paint servers, clipping, filters without feImage)
  "svg", "g", "defs", "symbol", "use", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "clippath", "mask", "lineargradient", "radialgradient", "stop", "pattern", "marker", "filter",
  "fegaussianblur", "fecolormatrix", "feoffset", "feblend", "feflood", "fecomposite", "femerge", "femergenode",
  "feturbulence", "fedisplacementmap", "femorphology", "fecomponenttransfer", "fefunca", "fefuncr", "fefuncg", "fefuncb",
]);

const GLOBAL_ATTRIBUTES = new Set(["class", "id", "lang", "dir", "title", "hidden", "role", "translate", "tabindex"]);
const ELEMENT_ATTRIBUTES: Record<string, readonly string[]> = {
  html: ["xmlns"],
  meta: ["charset", "name", "content", "http-equiv"],
  link: ["rel", "href", "type", "media"],
  img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"],
  source: ["srcset", "media", "sizes", "type", "width", "height"],
  a: ["href"],
  time: ["datetime"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
  col: ["span"],
  colgroup: ["span"],
};
/** SVG attributes (lower-case) allowed on any SVG element. The ones a browser parses as CSS are CSS_ATTRIBUTES. */
const SVG_ATTRIBUTES = new Set([
  "xmlns", "xmlns:xlink", "viewbox", "preserveaspectratio", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry",
  "d", "points", "transform", "offset", "gradientunits", "gradienttransform", "spreadmethod", "fx", "fy", "fr", "patternunits",
  "patterncontentunits", "patterntransform", "clippathunits", "maskunits", "maskcontentunits", "markerwidth", "markerheight", "refx",
  "refy", "orient", "markerunits", "dx", "dy", "rotate", "textlength", "lengthadjust", "href", "xlink:href", "pathlength",
  "filterunits", "primitiveunits", "in", "in2", "result", "stddeviation", "type", "values", "mode", "operator", "k1", "k2", "k3", "k4",
  "basefrequency", "numoctaves", "seed", "stitchtiles", "scale", "xchannelselector", "ychannelselector", "radius", "tablevalues",
  "slope", "intercept", "amplitude", "exponent", "focusable",
]);
/** SVG presentation attributes: a browser parses their value as CSS (M2: no backslash, the CSS scan runs on them). */
export const CSS_ATTRIBUTES = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "stroke-miterlimit", "opacity", "clip-path", "clip-rule", "mask", "filter", "stop-color", "stop-opacity", "text-anchor",
  "dominant-baseline", "alignment-baseline", "baseline-shift", "font-size", "font-weight", "font-style", "font-family", "letter-spacing",
  "word-spacing", "marker-start", "marker-mid", "marker-end", "vector-effect", "paint-order", "visibility", "display", "overflow",
  "flood-color", "flood-opacity", "lighting-color", "color", "color-interpolation", "color-interpolation-filters", "writing-mode",
  "text-decoration", "shape-rendering", "image-rendering", "text-rendering", "mix-blend-mode", "isolation", "transform-origin",
]);
const SVG_ELEMENTS = new Set([...ALLOWED_ELEMENTS].filter((e) => ["svg", "g", "defs", "symbol", "use", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "clippath", "mask", "lineargradient", "radialgradient", "stop", "pattern", "marker", "filter"].includes(e) || e.startsWith("fe")));

/** Properties whose non-empty strings are names or layout, never drawn as text (M3). */
const STRING_PROPERTIES = new Set(["font-family", "grid-template-areas", "grid-template", "grid", "font-feature-settings", "font-variation-settings", "font-language-override"]);
/** Properties that draw text: no string, no attr(), no var() (a custom property could carry a string). */
const TEXT_PROPERTIES = new Set(["content", "quotes", "list-style", "list-style-type", "text-overflow", "text-emphasis", "text-emphasis-style", "hyphenate-character", "-webkit-hyphenate-character", "string-set", "counter-reset", "counter-set", "counter-increment"]);

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
const trimAsciiWs = (v: string) => v.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");

/**
 * Checks the artifact's HTML and CSS. `photoUrls` are the version's photos as the page references them
 * (`photos/<name>`, from `photoUrlPaths(manifest)`).
 */
export function checkArtifactHtml(html: string, css: string, photoUrls: ReadonlySet<string>): HtmlSafetyResult {
  const findings: HtmlSafetyFinding[] = [];
  const add = (code: HtmlSafetyCode, detail?: string) => findings.push(detail === undefined ? { code } : { code, detail: ascii(detail) });
  const texts: string[] = [];
  let stylesheets = 0;

  const doc = parse(html);
  // iterative walk (a deeply nested page must not overflow the stack); <template> content is walked too
  const stack: Node[] = [doc];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeName === "#text") {
      const t = (node as DefaultTreeAdapterTypes.TextNode).value.trim();
      if (t) texts.push(t);
      continue;
    }
    if ("tagName" in node) {
      const el = node as Element;
      checkElement(el, photoUrls, add, () => stylesheets++, texts);
      if (el.tagName === "template") stack.push(...[...(el as DefaultTreeAdapterTypes.Template).content.childNodes].reverse());
    }
    if ("childNodes" in node) stack.push(...[...(node as DefaultTreeAdapterTypes.ParentNode).childNodes].reverse());
  }
  if (stylesheets !== 1) add("HTML_STYLESHEET_COUNT", String(stylesheets));
  for (const t of texts) {
    if (ARTIFACT_SALES_WORDS.test(t)) add("HTML_SALES_WORD");
    if (ARTIFACT_TEST_WORD.test(t)) add("HTML_TEST_WORD");
  }
  for (const f of checkArtifactCss(css, photoUrls)) findings.push(f);
  return { ok: findings.length === 0, findings: dedupe(findings), texts };
}

function attributeAllowed(tag: string, name: string): boolean {
  if (GLOBAL_ATTRIBUTES.has(name) || /^aria-[a-z]+$/.test(name) || /^data-[a-z0-9_.-]+$/.test(name)) return true;
  if ((ELEMENT_ATTRIBUTES[tag] ?? []).includes(name)) return true;
  return SVG_ELEMENTS.has(tag) && (SVG_ATTRIBUTES.has(name) || CSS_ATTRIBUTES.has(name));
}

function checkElement(el: Element, photoUrls: ReadonlySet<string>, add: (c: HtmlSafetyCode, d?: string) => void, countStylesheet: () => void, texts: string[]) {
  const tag = el.tagName.toLowerCase();
  if (FORBIDDEN_ELEMENTS.includes(tag)) add("HTML_FORBIDDEN_ELEMENT", tag);
  else if (tag === "style") add("HTML_STYLE_ELEMENT");
  else if (!ALLOWED_ELEMENTS.has(tag)) add("HTML_ELEMENT_NOT_ALLOWED", tag);
  const attrs = el.attrs.map((a) => ({ name: (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase(), value: a.value }));
  const get = (n: string) => attrs.find((a) => a.name === n)?.value;
  if (tag === "link") {
    const rel = trimAsciiWs(get("rel") ?? "").toLowerCase();
    const href = trimAsciiWs(get("href") ?? "");
    const extra = attrs.filter((a) => !["rel", "href", "type", "media"].includes(a.name));
    if (rel === "stylesheet" && href === PROTOTYPE_STYLESHEET && extra.length === 0 && (get("media") ?? "all").trim().toLowerCase() === "all") countStylesheet();
    else add("HTML_LINK_NOT_ALLOWED", `${rel} ${href}`);
  }
  if (tag === "meta") {
    const eq = get("http-equiv");
    if (eq !== undefined && !HARMLESS_HTTP_EQUIV.includes(eq.trim().toLowerCase())) add("HTML_META_HTTP_EQUIV", eq);
    const content = get("content");
    if (content !== undefined && (ARTIFACT_SALES_WORDS.test(content) || ARTIFACT_TEST_WORD.test(content))) add(ARTIFACT_SALES_WORDS.test(content) ? "HTML_SALES_WORD" : "HTML_TEST_WORD", "meta content");
  }
  for (const a of attrs) {
    if (a.name.startsWith("on")) add("HTML_EVENT_ATTRIBUTE", a.name);
    else if (a.name === "style") add("HTML_STYLE_ATTRIBUTE");
    else if (!attributeAllowed(tag, a.name)) add("HTML_ATTRIBUTE_NOT_ALLOWED", `${tag} ${a.name}`);
    if (VISIBLE_TEXT_ATTRIBUTES.includes(a.name) && a.value.trim()) texts.push(a.value.trim());
    // an attribute a browser parses as CSS: no escape at all (M2), and the CSS token scan on its value
    if (CSS_ATTRIBUTES.has(a.name) && SVG_ELEMENTS.has(tag)) {
      if (a.value.includes("\\")) add("HTML_ATTRIBUTE_ESCAPE", `${tag} ${a.name}`);
      for (const p of cssScanProblems(a.value, (t) => allowedUrl(t, photoUrls))) add(p.code === "CSS_URL_NOT_ALLOWED" ? "HTML_ATTRIBUTE_URL" : p.code, `${tag} ${a.name}: ${p.detail ?? ""}`);
      if (a.name === "font-family" && !isAllowedFontList(a.value)) add("CSS_FONT_FAMILY_NOT_ALLOWED", `${tag} font-family`);
    }
    // any attribute holding a url() — escapes decoded first, so "\75 rl(" counts — follows the CSS url rule
    const decoded = decodeEscapes(a.value);
    if (a.name !== "style" && /url\s*\(/i.test(decoded)) {
      if (a.value.includes("\\")) add("HTML_ATTRIBUTE_URL", `${tag} ${a.name}: escaped`);
      for (const t of cssUrls(decoded)) if (!allowedUrl(t, photoUrls)) add("HTML_ATTRIBUTE_URL", `${tag} ${a.name}: ${t}`);
    }
    if ((URL_ATTRIBUTES.includes(a.name) || ARTIFACT_EXTRA_URL_ATTRIBUTES.includes(a.name)) && !(tag === "link" && a.name === "href")) {
      const values = a.name === "srcset" ? a.value.split(",").map((s) => trimAsciiWs(s).split(/[\t\n\f\r ]+/)[0] ?? "") : [trimAsciiWs(a.value)];
      for (const v of values) {
        if ((a.name === "href" || a.name === "xlink:href") && /^#\S*$/u.test(v)) continue;
        if ((tag === "img" && (a.name === "src" || a.name === "srcset")) || (tag === "source" && a.name === "srcset")) {
          if (photoUrls.has(v)) continue;
        }
        add("HTML_URL_NOT_ALLOWED", `${tag} ${a.name}: ${v}`);
      }
    }
  }
}

/**
 * The CSS rules: the rule core's first pass (photos as the declared assets), the token scan in place of Chromium's
 * second pass, @font-face, fonts, and no text drawn from CSS.
 */
export function checkArtifactCss(css: string, photoUrls: ReadonlySet<string>): HtmlSafetyFinding[] {
  const out: HtmlSafetyFinding[] = [];
  for (const p of cssProblems(css, photoUrls)) {
    const code: HtmlSafetyCode = p === "css @import" ? "CSS_IMPORT" : p === "css code execution" ? "CSS_CODE_EXECUTION" : p.startsWith("css url") ? "CSS_URL_NOT_ALLOWED" : "CSS_IMAGE_FUNCTION";
    out.push({ code, detail: ascii(p) });
  }
  for (const p of cssScanProblems(css, (t) => allowedUrl(t, photoUrls))) out.push(p.detail === undefined ? { code: p.code } : { code: p.code, detail: ascii(p.detail) });
  if (/@font-face/i.test(decodeEscapes(outsideStringsAndComments(css)))) out.push({ code: "CSS_FONT_FACE" });
  const decls = cssDeclarations(css);
  out.push(...fontProblems(decls));
  out.push(...textProblems(decls));
  return dedupe(out);
}

/**
 * Declarations of a stylesheet: property lower-cased and unescaped, `value` unescaped, `raw` as written. Split outside
 * strings and comments; an escaped character (`\2f`, `\;`) never splits or opens a comment.
 */
export function cssDeclarations(css: string): Array<{ prop: string; value: string; raw: string }> {
  const out: Array<{ prop: string; value: string; raw: string }> = [];
  let buf = "";
  let depth = 0;
  const flush = () => {
    const i = buf.indexOf(":");
    if (i > 0) {
      const prop = decodeEscapes(buf.slice(0, i)).trim();
      // a selector ends in "{", so what is left of a ":" before a ";" / "}" is a declaration (pseudo-classes end in "{")
      if (/^-{0,2}[A-Za-z_][A-Za-z0-9_-]*$/.test(prop)) out.push({ prop: prop.startsWith("--") ? prop : prop.toLowerCase(), value: decodeEscapes(buf.slice(i + 1)).trim(), raw: buf.slice(i + 1).trim() });
    }
    buf = "";
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") {
      buf += css.slice(i, i + 2);
      i++;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      buf += " ";
    } else if (c === '"' || c === "'") {
      const start = i;
      for (i++; i < css.length && css[i] !== c && css[i] !== "\n"; i++) if (css[i] === "\\") i++;
      buf += css.slice(start, i + 1);
    } else if (c === "(") {
      depth++;
      buf += c;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      buf += c;
    } else if (depth === 0 && (c === ";" || c === "{" || c === "}")) {
      if (c === "{") buf = "";
      else flush();
    } else buf += c;
  }
  flush();
  return out;
}

const CSS_WIDE = ["inherit", "initial", "unset", "revert", "revert-layer"];

/** Each comma-separated family of a font list is allowed (quoted names and unquoted idents both checked). */
export function isAllowedFontList(value: string): boolean {
  const v = value.replace(/!\s*important\s*$/i, "").trim();
  if (CSS_WIDE.includes(v.toLowerCase())) return true;
  const items: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const c of v) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      items.push(cur);
      cur = "";
    } else cur += c;
  }
  if (q) return false;
  items.push(cur);
  return items.every((raw) => {
    const item = raw.trim();
    const quoted = /^(["'])(.*)\1$/.exec(item);
    if (quoted) return (PAGE_FONT_FAMILIES as readonly string[]).includes(quoted[2]!);
    if (!/^[A-Za-z][A-Za-z0-9-]*( [A-Za-z0-9][A-Za-z0-9-]*)*$/.test(item)) return false;
    return PAGE_FONT_GENERIC_FAMILIES.includes(item.toLowerCase()) || (PAGE_FONT_FAMILIES as readonly string[]).includes(item);
  });
}

function fontProblems(decls: ReturnType<typeof cssDeclarations>): HtmlSafetyFinding[] {
  const out: HtmlSafetyFinding[] = [];
  const custom = new Map<string, string[]>();
  for (const d of decls) if (d.prop.startsWith("--")) custom.set(d.prop, [...(custom.get(d.prop) ?? []), d.value]);
  // a font list, or var(--x) whose every definition is (through at most 4 levels of var())
  const ok = (value: string, depth: number): boolean => {
    const v = value.replace(/!\s*important\s*$/i, "").trim();
    const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(v);
    if (m) {
      const defs = custom.get(m[1]!);
      return depth < 4 && defs !== undefined && defs.every((d) => ok(d, depth + 1));
    }
    return !/var\(/i.test(v) && isAllowedFontList(v);
  };
  for (const d of decls) {
    if (d.prop === "font") out.push({ code: "CSS_FONT_SHORTHAND" });
    if (d.prop === "font-family" && !ok(d.value, 0)) out.push({ code: "CSS_FONT_FAMILY_NOT_ALLOWED", detail: ascii(d.value) });
  }
  return out;
}

/** M3: CSS draws no text. Non-empty strings only where they are names or layout; text properties hold no string, attr() or var(). */
function textProblems(decls: ReturnType<typeof cssDeclarations>): HtmlSafetyFinding[] {
  const out: HtmlSafetyFinding[] = [];
  for (const d of decls) {
    const custom = d.prop.startsWith("--");
    if (!custom && !STRING_PROPERTIES.has(d.prop) && cssStrings(d.raw).length) out.push({ code: "CSS_TEXT_IN_CSS", detail: d.prop });
    if (TEXT_PROPERTIES.has(d.prop) && /attr\s*\(|var\s*\(/i.test(d.value)) out.push({ code: "CSS_TEXT_IN_CSS", detail: d.prop });
  }
  return out;
}

function dedupe(f: HtmlSafetyFinding[]): HtmlSafetyFinding[] {
  const seen = new Set<string>();
  return f.filter((x) => {
    const k = `${x.code}|${x.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
