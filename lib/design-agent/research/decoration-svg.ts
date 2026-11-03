/**
 * DEV-162 (Issue #193 comment 6601921731, decision 2) — RESEARCH ONLY, NOT ENABLED.
 *
 * N1 of docs/design/expressive-allowlist-proposal.md: a decorative SVG (a seam line, spokes, a mountain) that a page
 * would show only through `<img src="assets/<name>.svg">`, never inline, never from CSS. This module is the strict
 * checker such a file would have to pass. Nothing in the production lanes imports it (pinned by
 * tests/unit/design-agent/research/decoration-svg.test.ts); the comp-impl allowlist, its HTML checks and its asset
 * schema are unchanged. Enabling N1 needs phase C (paint order and protected-text checks, DEV-083 V2/V4) to pass first,
 * then a separate PR and the owner's approval (docs/design/n1-decoration-svg.md).
 *
 * The checker is a whole-file allowlist, not a sanitiser: it never rewrites a file, it refuses it.
 * - bytes: ASCII only (no BOM, no other encoding, no control characters but tab / LF / CR), size-capped;
 * - markup: an optional plain XML declaration, then elements only. No DOCTYPE / DTD, no entity or character
 *   reference (`&`), no CDATA, no comment, no processing instruction, no text content;
 * - elements: a fixed list, case-sensitive, no prefix; `svg` only at the root; gradients only in `defs`; `stop` only in a
 *   gradient. No script, style, text, image, use, foreignObject, a, filter, mask, pattern, animation …
 * - attributes: a fixed list per element with a value grammar per attribute. No `style`, no event handler, no `href` or
 *   `xlink:href`, no `xml:*`, no `xmlns:*`; `xmlns` only on the root and only the SVG namespace;
 * - `url(` only as a whole `fill` / `stroke` value `url(#id)` naming a gradient declared in the same file (gradients are
 *   what the glaze and the heat strip need; a fragment reference cannot leave the document, and the browser loads
 *   nothing for an SVG shown through `<img>` anyway — both lines hold);
 * - size: `width`, `height` and `viewBox` required, so the page box and the record agree.
 * checkDecorationSvg is pure; checkDecorationAssetFile reads one file (no symlink, no path out of the page directory).
 * No network, no child process.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";

export const DECORATION_SVG_LIMITS = { bytes: 256 * 1024, elements: 4000, depth: 24, attributes: 24, value: 64 * 1024, side: 4096 } as const;

export type SvgFinding = { code: string; detail?: string };
export type SvgCheck = { ok: boolean; findings: SvgFinding[]; width: number | null; height: number | null; elements: number };

const SVG_NS = "http://www.w3.org/2000/svg";
const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const num = new RegExp(`^${NUM}$`);
const LENGTH = new RegExp(`^${NUM}(?:px|%)?$`);
const length = (v: string) => LENGTH.test(v);
const positive = (v: string) => num.test(v) && Number(v) > 0;
const NAMED = ["none", "black", "white", "transparent", "currentColor"];
const colour = (v: string) =>
  /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ||
  new RegExp(`^rgba?\\(\\s*${NUM}%?\\s*,\\s*${NUM}%?\\s*,\\s*${NUM}%?\\s*(?:,\\s*${NUM}%?\\s*)?\\)$`).test(v) ||
  NAMED.includes(v);
const PAINT_REF = /^url\(#([A-Za-z][A-Za-z0-9_-]{0,40})\)$/;
const paint = (v: string) => colour(v) || PAINT_REF.test(v);
const opacity = (v: string) => num.test(v) && Number(v) >= 0 && Number(v) <= 1;
const list = (v: string) => new RegExp(`^\\s*${NUM}(?:\\s*,?\\s*${NUM})*\\s*$`).test(v);
const pathData = (v: string) => /^[MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]*$/.test(v) && /^\s*[Mm]/.test(v);
const TRANSFORM_FN = new RegExp(`(?:matrix|translate|scale|rotate|skewX|skewY)\\(\\s*${NUM}(?:\\s*,?\\s*${NUM}){0,5}\\s*\\)`, "g");
const transform = (v: string) => v.trim().length > 0 && v.replace(TRANSFORM_FN, "").replace(/[\s,]/g, "") === "";
const oneOf =
  (...w: string[]) =>
  (v: string) =>
    w.includes(v);
const id = (v: string) => /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(v);

type Rule = (v: string) => boolean;
const PRESENTATION: Record<string, Rule> = {
  fill: paint,
  stroke: paint,
  "stroke-width": length,
  "stroke-linecap": oneOf("butt", "round", "square"),
  "stroke-linejoin": oneOf("miter", "round", "bevel"),
  "stroke-miterlimit": positive,
  "stroke-dasharray": (v) => v === "none" || list(v),
  "stroke-dashoffset": length,
  "fill-opacity": opacity,
  "stroke-opacity": opacity,
  opacity,
  "fill-rule": oneOf("nonzero", "evenodd"),
  "vector-effect": oneOf("none", "non-scaling-stroke"),
  "shape-rendering": oneOf("auto", "optimizeSpeed", "crispEdges", "geometricPrecision"),
  transform,
  id,
};
const geometry = (...names: string[]) => Object.fromEntries(names.map((n) => [n, length])) as Record<string, Rule>;
const GRADIENT_COMMON: Record<string, Rule> = { id, gradientUnits: oneOf("userSpaceOnUse", "objectBoundingBox"), gradientTransform: transform, spreadMethod: oneOf("pad", "reflect", "repeat") };

/** Element → its allowed attributes (and their value rules) and where it may stand. */
const ELEMENTS: Record<string, { attrs: Record<string, Rule>; parents: readonly string[] }> = {
  svg: {
    attrs: { xmlns: (v) => v === SVG_NS, viewBox: (v) => new RegExp(`^\\s*${NUM}(?:[\\s,]+${NUM}){3}\\s*$`).test(v), width: length, height: length, preserveAspectRatio: (v) => /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/.test(v), ...PRESENTATION },
    parents: [],
  },
  g: { attrs: PRESENTATION, parents: ["svg", "g"] },
  defs: { attrs: { id }, parents: ["svg"] },
  path: { attrs: { d: pathData, ...PRESENTATION }, parents: ["svg", "g"] },
  line: { attrs: { ...geometry("x1", "y1", "x2", "y2"), ...PRESENTATION }, parents: ["svg", "g"] },
  polyline: { attrs: { points: list, ...PRESENTATION }, parents: ["svg", "g"] },
  polygon: { attrs: { points: list, ...PRESENTATION }, parents: ["svg", "g"] },
  rect: { attrs: { ...geometry("x", "y", "width", "height", "rx", "ry"), ...PRESENTATION }, parents: ["svg", "g"] },
  circle: { attrs: { ...geometry("cx", "cy", "r"), ...PRESENTATION }, parents: ["svg", "g"] },
  ellipse: { attrs: { ...geometry("cx", "cy", "rx", "ry"), ...PRESENTATION }, parents: ["svg", "g"] },
  linearGradient: { attrs: { ...geometry("x1", "y1", "x2", "y2"), ...GRADIENT_COMMON }, parents: ["defs"] },
  radialGradient: { attrs: { ...geometry("cx", "cy", "r", "fx", "fy", "fr"), ...GRADIENT_COMMON }, parents: ["defs"] },
  stop: { attrs: { offset: length, "stop-color": colour, "stop-opacity": opacity }, parents: ["linearGradient", "radialGradient"] },
};
export const DECORATION_SVG_ELEMENTS = Object.keys(ELEMENTS);
/** Own-property lookups only: a name such as `constructor`, `toString` or `__proto__` is just an unknown name. */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);
const VIEWBOX = new RegExp(`^\\s*(${NUM})[\\s,]+(${NUM})[\\s,]+(${NUM})[\\s,]+(${NUM})\\s*$`);

/**
 * Checks one SVG file's bytes. Every refusal is a code; the file passes only with none. The width and height (from the
 * root's attributes, px or unitless) are returned for the asset record.
 */
export function checkDecorationSvg(bytes: Uint8Array): SvgCheck {
  try {
    return checkSvg(bytes);
  } catch {
    // hostile content must be refused, never thrown on
    return { ok: false, findings: [{ code: "SVG_CHECK_ERROR" }], width: null, height: null, elements: 0 };
  }
}

function checkSvg(bytes: Uint8Array): SvgCheck {
  const f: SvgFinding[] = [];
  const out = (code: string, detail?: string): SvgCheck => ({ ok: false, findings: [...f, { code, ...(detail ? { detail } : {}) }], width: null, height: null, elements: 0 });
  if (bytes.length === 0) return out("SVG_EMPTY");
  if (bytes.length > DECORATION_SVG_LIMITS.bytes) return out("SVG_TOO_LARGE");
  // ASCII only: no BOM (UTF-8 or UTF-16), no other encoding, no control characters but tab, LF and CR
  for (const b of bytes) if (b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) return out("SVG_NOT_ASCII", `byte 0x${b.toString(16)}`);
  let s = Buffer.from(bytes).toString("latin1");
  const decl = /^<\?xml version="1\.0"(?: encoding="(?:UTF-8|utf-8)")?(?: standalone="(?:yes|no)")?\?>/.exec(s);
  if (decl) s = s.slice(decl[0].length);
  if (s.includes("<?")) return out("SVG_PROCESSING_INSTRUCTION");
  if (/<!doctype|<!entity|<!element|<!attlist/i.test(s)) return out("SVG_DTD");
  if (s.includes("<![CDATA[") || /<!\[/i.test(s)) return out("SVG_CDATA");
  if (s.includes("<!--")) return out("SVG_COMMENT");
  if (s.includes("<!")) return out("SVG_DECLARATION");
  if (s.includes("&")) return out("SVG_ENTITY");

  const stack: string[] = [];
  const ids = new Map<string, string>();
  const refs: string[] = [];
  let elements = 0;
  let root: Map<string, string> | null = null;
  let closedRoot = false;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const text = s.slice(i, lt < 0 ? s.length : lt);
    if (text.trim()) f.push({ code: "SVG_TEXT_CONTENT", detail: text.trim().slice(0, 20) });
    if (lt < 0) break;
    if (closedRoot) {
      f.push({ code: "SVG_AFTER_ROOT" });
      break;
    }
    const gt = s.indexOf(">", lt);
    if (gt < 0) return out("SVG_MALFORMED", "unclosed tag");
    const tag = s.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("/")) {
      // `</g>` or `</g >`; whitespace right after `</` is not XML
      const close = /^\/([^\s/>]+)\s*$/.exec(tag);
      const name = close?.[1] ?? tag.slice(1);
      if (!close || stack.pop() !== name) return out("SVG_MALFORMED", `close ${name.slice(0, 20)}`);
      if (stack.length === 0) closedRoot = true;
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!m) return out("SVG_MALFORMED", "empty tag");
    const name = m[1]!;
    if (name.includes(":")) {
      f.push({ code: "SVG_ELEMENT_PREFIX", detail: name.slice(0, 30) });
      continue;
    }
    const spec = own(ELEMENTS, name);
    const parent = stack[stack.length - 1];
    elements += 1;
    if (elements > DECORATION_SVG_LIMITS.elements) return out("SVG_TOO_MANY_ELEMENTS");
    if (!spec) f.push({ code: "SVG_ELEMENT_NOT_ALLOWED", detail: name.slice(0, 30) });
    else if (name === "svg" ? stack.length !== 0 || root !== null : !parent || !spec.parents.includes(parent)) f.push({ code: "SVG_ELEMENT_PLACE", detail: `${name} in ${parent ?? "(top)"}` });
    // attributes: name="value" or name='value' only, separated by whitespace, no duplicates
    const attrs = new Map<string, string>();
    const rest = m[2]!;
    const re = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    let pos = 0;
    let count = 0;
    while (pos < rest.length) {
      if (/^\s*$/.test(rest.slice(pos))) break;
      re.lastIndex = pos;
      const a = re.exec(rest);
      if (!a) return out("SVG_MALFORMED", `attributes of ${name.slice(0, 20)}`);
      pos = re.lastIndex;
      const an = a[1]!;
      const av = a[2] ?? a[3] ?? "";
      count += 1;
      if (count > DECORATION_SVG_LIMITS.attributes) return out("SVG_TOO_MANY_ATTRIBUTES", name);
      if (av.length > DECORATION_SVG_LIMITS.value) return out("SVG_VALUE_TOO_LONG", an);
      if (attrs.has(an)) f.push({ code: "SVG_ATTRIBUTE_DUPLICATE", detail: an });
      attrs.set(an, av);
      if (/^on/i.test(an)) f.push({ code: "SVG_EVENT_HANDLER", detail: an });
      else if (an.includes(":") || an === "xmlns" ? !(an === "xmlns" && name === "svg") : false) f.push({ code: an.toLowerCase().includes("href") ? "SVG_HREF" : "SVG_NAMESPACED_ATTRIBUTE", detail: an });
      else if (/href/i.test(an)) f.push({ code: "SVG_HREF", detail: an });
      else if (an === "style") f.push({ code: "SVG_STYLE", detail: "style attribute" });
      else if (spec) {
        const rule = own(spec.attrs, an);
        if (!rule) f.push({ code: "SVG_ATTRIBUTE_NOT_ALLOWED", detail: `${name}@${an}`.slice(0, 40) });
        else if (!rule(av)) f.push({ code: "SVG_ATTRIBUTE_VALUE", detail: `${name}@${an}`.slice(0, 40) });
      }
      if (/url\(/i.test(av)) {
        const ref = PAINT_REF.exec(av);
        if (!ref || !(an === "fill" || an === "stroke")) f.push({ code: "SVG_URL", detail: `${name}@${an}`.slice(0, 40) });
        else refs.push(ref[1]!);
      }
    }
    const idValue = attrs.get("id");
    if (idValue) {
      if (ids.has(idValue)) f.push({ code: "SVG_ID_DUPLICATE", detail: idValue });
      ids.set(idValue, name);
    }
    if (name === "svg" && stack.length === 0 && root === null) root = attrs;
    if (!selfClosing) {
      stack.push(name);
      if (stack.length > DECORATION_SVG_LIMITS.depth) return out("SVG_TOO_DEEP");
    } else if (stack.length === 0) closedRoot = true;
  }
  if (stack.length) f.push({ code: "SVG_MALFORMED", detail: "unclosed element" });
  if (!root) return out("SVG_NO_ROOT");
  if (root.get("xmlns") !== SVG_NS) f.push({ code: "SVG_NAMESPACE" });
  for (const r of refs) if (!/Gradient$/.test(ids.get(r) ?? "")) f.push({ code: "SVG_REF_NOT_A_GRADIENT", detail: r });
  const px = (v: string | undefined) => (v !== undefined && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(v) ? Number(v.replace(/px$/, "")) : null);
  const width = px(root.get("width"));
  const height = px(root.get("height"));
  const viewBox = root.get("viewBox");
  if (!viewBox) f.push({ code: "SVG_NO_VIEWBOX" });
  else {
    // a zero or negative viewBox width or height disables rendering (SVG 2 7.7): refused, not left to the browser
    const vb = VIEWBOX.exec(viewBox);
    if (vb && !(Number(vb[3]) > 0 && Number(vb[4]) > 0)) f.push({ code: "SVG_VIEWBOX", detail: viewBox.slice(0, 40) });
  }
  if (width === null || height === null || width <= 0 || height <= 0 || width > DECORATION_SVG_LIMITS.side || height > DECORATION_SVG_LIMITS.side) f.push({ code: "SVG_SIZE", detail: `${root.get("width")}×${root.get("height")}` });
  return { ok: f.length === 0, findings: f, width, height, elements };
}

/** What a page would record for each decorative SVG (the research shape of an `assets.json` entry; not the comp-impl schema). */
export type DecorationAsset = { id: string; file: string; sha256: string; bytes: number; width: number; height: number; kind: "decoration_svg"; role: "decoration" };
export const DECORATION_FILE = /^assets\/[a-z0-9][a-z0-9-]{0,60}\.svg$/;
export const DECORATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------------------------------------------
// The page side. A small HTML tokenizer (tags and attributes as a browser splits them: double-quoted, single-quoted
// and unquoted values, ASCII case-insensitive names, `/` as a separator, the first of duplicate attributes wins),
// then one strict policy over every attribute value, every `style` attribute, every `<style>` and the page CSS.
// The production htmlSourceProblems already refuses many of these inputs (`<svg`, `<object>`, `style`, `data:`,
// `https:` …), but this checker does not lean on that: it refuses them itself.
// ---------------------------------------------------------------------------------------------------------------

const HTML_WS = /[\t\n\f\r ]/;
const asciiLower = (v: string) => v.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** Elements whose content is not markup (the tokenizer skips to their end tag). `noscript` is markup: the page renders with JS off. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const EMBEDDING = new Set(["object", "embed", "iframe", "frame", "frameset", "portal", "fencedframe", "applet"]);
/** Attributes whose value is a URL (or a list of them): a scheme at the start of any candidate is an absolute URL. */
const URL_ATTRS = new Set(["src", "href", "srcset", "imagesrcset", "data", "poster", "background", "action", "formaction", "cite", "longdesc", "lowsrc", "dynsrc", "codebase", "classid", "archive", "usemap", "manifest", "icon", "ping", "profile", "itemtype", "xlink:href", "content"]);
const NAMED_REFS: ReadonlyMap<string, string> = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["sol", "/"], ["bsol", "\\"], ["period", "."], ["colon", ":"], ["lpar", "("], ["rpar", ")"],
  ["num", "#"], ["percnt", "%"], ["quest", "?"], ["equals", "="], ["comma", ","], ["semi", ";"], ["tab", "\t"], ["newline", "\n"], ["nbsp", "\u00a0"],
]); // prettier-ignore
const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd");

/** HTML character references: numeric ones and a small named table; a `;`-terminated name outside the table is reported. */
function decodeHtml(v: string): { text: string; unknown: boolean } {
  let unknown = false;
  const text = v.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (m, ref: string) => {
    if (ref.startsWith("#")) return codePoint(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10));
    const named = NAMED_REFS.get(ref.toLowerCase());
    if (named !== undefined) return named;
    if (m.endsWith(";")) unknown = true;
    return m;
  });
  return { text, unknown };
}

/** CSS escapes: `\67` (1–6 hex digits and one optional white space) and `\x` for any other character. */
const unescapeCss = (v: string) =>
  v.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_m, hex: string | undefined, ch: string | undefined) => (hex ? codePoint(parseInt(hex, 16)) : ch === "\n" ? "" : (ch ?? "")));

/** Leading C0 controls and spaces, which a URL parser strips. */
const trimC0 = (v: string) => {
  let k = 0;
  while (k < v.length && v.charCodeAt(k) <= 0x20) k++;
  return v.slice(k);
};
/**
 * A URL as a browser would resolve it, for matching: tab / LF / CR / FF removed, leading C0 and spaces trimmed, one level
 * of %XX decoded, `\` as `/`, lower case.
 */
const normaliseUrlText = (v: string) =>
  asciiLower(trimC0(v.replace(/[\t\n\r\f]/g, "").replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\/g, "/")));

/** Every reading of a value the checker matches against: raw, entity-decoded, CSS-unescaped and both, each normalised. */
function readings(v: string): { all: string[]; unknownEntity: boolean } {
  const d = decodeHtml(v);
  const all = [...new Set([v, d.text, unescapeCss(v), unescapeCss(d.text)].map(normaliseUrlText))];
  return { all, unknownEntity: d.unknown };
}

const DATA_URL = /(?:^|[^a-z0-9+.-])data:/;
const ABSOLUTE_URL = /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/|^\/\//;
const SCHEME = /^[a-z][a-z0-9+.-]*:/;
const CSS_LOADS = /url\s*\(|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|element\s*\(|@import|\bsrc\s*\(/;

type Matcher = (normalised: string) => boolean;
/**
 * Anything containing `.svg` or an SVG media type, or a recorded file with or without its `.svg` (`assets/seam`), also
 * after dot segments are resolved (`./assets/x/../seam`).
 */
function svgMatcher(files: readonly string[]): Matcher {
  const stems = files.map((f) => new RegExp(`(?:^|[^a-z0-9-])${f.replace(/\.svg$/, "").replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}(?![a-z0-9-])`));
  const one = (v: string) => v.includes(".svg") || v.includes("svg+xml") || v.includes("image/svg") || stems.some((re) => re.test(v));
  return (v) => one(v) || one(posix.normalize(v));
}

function cssProblemsInto(css: string, refersToSvg: Matcher, p: Set<string>) {
  for (const v of readings(css).all.flatMap((r) => [r, r.replace(/\/\*[\s\S]*?\*\//g, "")])) {
    if (CSS_LOADS.test(v)) p.add("CSS_URL");
    if (refersToSvg(v)) p.add("SVG_FROM_CSS");
  }
}

type Tag = { name: string; attrs: Map<string, string>; duplicate: boolean; end: number };
/** One tag from just after `<` (or `</`); null when the input ends inside it. */
function readTag(html: string, start: number): Tag | null {
  const n = html.length;
  let j = start;
  while (j < n && !HTML_WS.test(html[j]!) && html[j] !== "/" && html[j] !== ">") j++;
  const name = asciiLower(html.slice(start, j));
  const attrs = new Map<string, string>();
  let duplicate = false;
  for (;;) {
    while (j < n && (HTML_WS.test(html[j]!) || html[j] === "/")) j++;
    if (j >= n) return null;
    if (html[j] === ">") return { name, attrs, duplicate, end: j + 1 };
    const a0 = j++; // the first character of a name may be `=`
    while (j < n && !HTML_WS.test(html[j]!) && !"/>=".includes(html[j]!)) j++;
    const an = asciiLower(html.slice(a0, j));
    while (j < n && HTML_WS.test(html[j]!)) j++;
    let av = "";
    if (html[j] === "=") {
      j++;
      while (j < n && HTML_WS.test(html[j]!)) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close < 0) return null;
        av = html.slice(j + 1, close);
        j = close + 1;
      } else {
        const v0 = j;
        while (j < n && !HTML_WS.test(html[j]!) && html[j] !== ">") j++;
        av = html.slice(v0, j);
      }
    }
    if (attrs.has(an)) duplicate = true;
    else attrs.set(an, av);
  }
}

/** The recorded list itself: file names, ids, and no id or file recorded twice. */
function assetListProblemsInto(assets: readonly DecorationAsset[], p: Set<string>) {
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const a of assets) {
    const file = typeof a?.file === "string" ? a.file : "";
    const id = typeof a?.id === "string" ? a.id : "";
    if (!DECORATION_FILE.test(file)) p.add("SVG_FILE_NAME");
    if (!DECORATION_ID.test(id)) p.add("ASSET_ID");
    if (ids.has(id)) p.add("ASSET_ID_DUPLICATE");
    if (files.has(file)) p.add("ASSET_FILE_DUPLICATE");
    ids.add(id);
    files.add(file);
  }
}

/**
 * The page side. The only SVG reference allowed anywhere is `<img src="<recorded file>">` with the value exactly the
 * recorded path, carrying `alt=""`, `aria-hidden="true"` and `referrerpolicy="no-referrer"` as parsed attributes.
 * Refused: `<svg` in any form; `<object>` / `<embed>` / `<iframe>` / frames; any other element or attribute whose
 * value (after HTML entities, CSS escapes and %XX) names a recorded file (with or without `.svg`), anything with
 * `.svg` or an SVG media type; any `data:` URL; any absolute or protocol-relative URL; any `url(` / `image-set(` /
 * `@import` in a `style` attribute, a `<style>` or the page CSS; an unknown `;`-terminated character reference; a
 * duplicate attribute; a tag or comment the input ends inside; and a recorded asset that is unused, badly named,
 * badly identified or recorded twice. A scan of the source text (the production lane would check the live DOM too).
 */
export function decorationReferenceProblems(html: string, css: string, assets: readonly DecorationAsset[]): string[] {
  const p = new Set<string>();
  assetListProblemsInto(assets, p);
  const files = new Set(assets.map((a) => (typeof a?.file === "string" ? a.file : "")).filter((f) => DECORATION_FILE.test(f)));
  const refersToSvg = svgMatcher([...files]);
  const used = new Set<string>();
  if (/<\/?svg/i.test(html)) p.add("INLINE_SVG"); // anywhere, comments and raw text included
  cssProblemsInto(css, refersToSvg, p);

  const onTag = (t: Tag) => {
    if (t.duplicate) p.add("PAGE_ATTRIBUTE_DUPLICATE");
    if (t.name === "svg") p.add("INLINE_SVG");
    if (EMBEDDING.has(t.name)) p.add("SVG_EMBEDDED_NOT_IMG");
    for (const [an, av] of t.attrs) {
      const r = readings(av);
      if (r.unknownEntity) p.add("PAGE_ENTITY");
      if (an === "style") cssProblemsInto(decodeHtml(av).text, refersToSvg, p);
      if (r.all.some((v) => DATA_URL.test(v))) p.add("PAGE_DATA_URL");
      const candidates = (v: string) => (an === "srcset" || an === "imagesrcset" || an === "ping" || an === "archive" ? v.split(/[,\s]+/).map(trimC0) : [v]);
      if (r.all.some((v) => ABSOLUTE_URL.test(v) || (URL_ATTRS.has(an) && candidates(v).some((c) => SCHEME.test(c))))) p.add("PAGE_ABSOLUTE_URL");
      if (t.name === "img" && an === "src" && files.has(av)) {
        used.add(av);
        continue;
      }
      if (r.all.some(refersToSvg)) p.add(t.name === "img" && an === "src" ? "SVG_NOT_RECORDED" : "SVG_REFERENCE_NOT_IMG");
    }
    if (t.name === "img" && files.has(t.attrs.get("src") ?? "")) {
      if (t.attrs.get("alt") !== "" || t.attrs.get("aria-hidden") !== "true") p.add("SVG_IMG_NOT_DECORATIVE");
      if (t.attrs.get("referrerpolicy") !== "no-referrer") p.add("SVG_IMG_REFERRER");
    }
  };

  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;
    if (html.startsWith("!--", i)) {
      // `<!-->` and `<!--->` end at once; otherwise the first `-->` or `--!>`
      if (html.startsWith(">", i + 3)) i += 4;
      else if (html.startsWith("->", i + 3)) i += 5;
      else {
        const ends = [html.indexOf("-->", i + 3), html.indexOf("--!>", i + 3)].filter((x) => x >= 0);
        if (!ends.length) {
          p.add("PAGE_MALFORMED");
          break;
        }
        const e = Math.min(...ends);
        i = e + (html.startsWith("-->", e) ? 3 : 4);
      }
      continue;
    }
    const c = html[i] ?? "";
    const closing = c === "/" && /[A-Za-z]/.test(html[i + 1] ?? "");
    if (!/[A-Za-z]/.test(c) && !closing) {
      if (c === "!" || c === "?" || c === "/") {
        // a bogus comment runs to the next `>`
        const e = html.indexOf(">", i);
        if (e < 0) {
          p.add("PAGE_MALFORMED");
          break;
        }
        i = e + 1;
      }
      continue;
    }
    const t = readTag(html, closing ? i + 1 : i);
    if (!t) {
      p.add("PAGE_MALFORMED");
      break;
    }
    i = t.end;
    if (closing) continue;
    onTag(t);
    if (RAW_TEXT.has(t.name)) {
      const close = t.name === "plaintext" ? null : new RegExp(`</${t.name}(?=[\\t\\n\\f\\r />])`, "i").exec(html.slice(i));
      const content = close ? html.slice(i, i + close.index) : html.slice(i);
      if (!close && t.name !== "plaintext") p.add("PAGE_MALFORMED");
      if (t.name === "style") cssProblemsInto(content, refersToSvg, p);
      else if (readings(content).all.some(refersToSvg)) p.add("SVG_REFERENCE_NOT_IMG");
      i = close ? i + close.index : n;
    }
  }
  for (const f of files) if (!used.has(f)) p.add("SVG_RECORDED_NOT_USED");
  return [...p].sort();
}

/**
 * The file side of one recorded asset, inside the page directory `dir`: the id and name have their forms, the file and
 * every directory on the way are real (no symlink), the file has one link only (no hardlink), it stays inside `dir`,
 * and its bytes, sha256, size and dimensions are the ones recorded and pass checkDecorationSvg. Never throws: anything
 * unexpected is the code ASSET_CHECK_ERROR. (Between the lstat checks and the read a file could be swapped; the sha256
 * of the bytes actually read pins the content, so a swap can only make the check fail.)
 */
export function checkDecorationAssetFile(dir: string, asset: DecorationAsset): string[] {
  const p: string[] = [];
  try {
    return checkAssetFile(dir, asset, p);
  } catch {
    return [...new Set([...p, "ASSET_CHECK_ERROR"])];
  }
}

function checkAssetFile(dir: string, asset: DecorationAsset, p: string[]): string[] {
  if (asset?.kind !== "decoration_svg" || asset?.role !== "decoration") p.push("ASSET_KIND");
  if (typeof asset?.id !== "string" || !DECORATION_ID.test(asset.id)) p.push("ASSET_ID");
  if (typeof asset?.file !== "string" || !DECORATION_FILE.test(asset.file) || asset.file.split("/").includes("..")) return [...p, "ASSET_FILE_NAME"];
  const root = resolve(dir);
  const full = join(root, asset.file);
  if (!full.startsWith(root + sep)) return [...p, "ASSET_OUTSIDE"];
  let at = root;
  for (const part of asset.file.split("/")) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return [...p, "ASSET_MISSING"];
    }
    if (st.isSymbolicLink()) return [...p, "ASSET_SYMLINK"];
  }
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return [...p, "ASSET_MISSING"];
  }
  if (real !== join(realpathSync(root), asset.file)) return [...p, "ASSET_OUTSIDE"];
  const st = lstatSync(full);
  if (!st.isFile()) return [...p, "ASSET_NOT_A_FILE"];
  // a second name for the same inode (a hardlink) could sit outside the page directory and change with it
  if (st.nlink > 1) return [...p, "ASSET_HARDLINK"];
  if (st.size > DECORATION_SVG_LIMITS.bytes) return [...p, "ASSET_TOO_LARGE"];
  const bytes = readFileSync(full);
  if (bytes.length !== asset.bytes) p.push("ASSET_BYTES");
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) p.push("ASSET_SHA256");
  const c = checkDecorationSvg(bytes);
  if (!c.ok) p.push(...c.findings.map((x) => x.code));
  else if (c.width !== asset.width || c.height !== asset.height) p.push("ASSET_DIMENSIONS");
  return [...new Set(p)];
}
