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
import { join, resolve, sep } from "node:path";

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

/**
 * Checks one SVG file's bytes. Every refusal is a code; the file passes only with none. The width and height (from the
 * root's attributes, px or unitless) are returned for the asset record.
 */
export function checkDecorationSvg(bytes: Uint8Array): SvgCheck {
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
  let root: Record<string, string> | null = null;
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
      const name = tag.slice(1).trim();
      if (stack.pop() !== name) return out("SVG_MALFORMED", `close ${name.slice(0, 20)}`);
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
    const spec = ELEMENTS[name];
    const parent = stack[stack.length - 1];
    elements += 1;
    if (elements > DECORATION_SVG_LIMITS.elements) return out("SVG_TOO_MANY_ELEMENTS");
    if (!spec) f.push({ code: "SVG_ELEMENT_NOT_ALLOWED", detail: name.slice(0, 30) });
    else if (name === "svg" ? stack.length !== 0 || root !== null : !parent || !spec.parents.includes(parent)) f.push({ code: "SVG_ELEMENT_PLACE", detail: `${name} in ${parent ?? "(top)"}` });
    // attributes: name="value" or name='value' only, separated by whitespace, no duplicates
    const attrs: Record<string, string> = {};
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
      if (an in attrs) f.push({ code: "SVG_ATTRIBUTE_DUPLICATE", detail: an });
      attrs[an] = av;
      if (/^on/i.test(an)) f.push({ code: "SVG_EVENT_HANDLER", detail: an });
      else if (an.includes(":") || an === "xmlns" ? !(an === "xmlns" && name === "svg") : false) f.push({ code: an.toLowerCase().includes("href") ? "SVG_HREF" : "SVG_NAMESPACED_ATTRIBUTE", detail: an });
      else if (/href/i.test(an)) f.push({ code: "SVG_HREF", detail: an });
      else if (an === "style") f.push({ code: "SVG_STYLE", detail: "style attribute" });
      else if (!spec || !(an in spec.attrs)) {
        if (spec) f.push({ code: "SVG_ATTRIBUTE_NOT_ALLOWED", detail: `${name}@${an}`.slice(0, 40) });
      } else if (!spec.attrs[an]!(av)) f.push({ code: "SVG_ATTRIBUTE_VALUE", detail: `${name}@${an}`.slice(0, 40) });
      if (/url\(/i.test(av)) {
        const ref = PAINT_REF.exec(av);
        if (!ref || !(an === "fill" || an === "stroke")) f.push({ code: "SVG_URL", detail: `${name}@${an}`.slice(0, 40) });
        else refs.push(ref[1]!);
      }
    }
    if (attrs.id) {
      if (ids.has(attrs.id)) f.push({ code: "SVG_ID_DUPLICATE", detail: attrs.id });
      ids.set(attrs.id, name);
    }
    if (name === "svg" && stack.length === 0 && root === null) root = attrs;
    if (!selfClosing) {
      stack.push(name);
      if (stack.length > DECORATION_SVG_LIMITS.depth) return out("SVG_TOO_DEEP");
    } else if (stack.length === 0) closedRoot = true;
  }
  if (stack.length) f.push({ code: "SVG_MALFORMED", detail: "unclosed element" });
  if (!root) return out("SVG_NO_ROOT");
  if (root.xmlns !== SVG_NS) f.push({ code: "SVG_NAMESPACE" });
  for (const r of refs) if (!/Gradient$/.test(ids.get(r) ?? "")) f.push({ code: "SVG_REF_NOT_A_GRADIENT", detail: r });
  const px = (v: string | undefined) => (v !== undefined && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(v) ? Number(v.replace(/px$/, "")) : null);
  const width = px(root.width);
  const height = px(root.height);
  if (!root.viewBox) f.push({ code: "SVG_NO_VIEWBOX" });
  if (width === null || height === null || width <= 0 || height <= 0 || width > DECORATION_SVG_LIMITS.side || height > DECORATION_SVG_LIMITS.side) f.push({ code: "SVG_SIZE", detail: `${root.width}×${root.height}` });
  return { ok: f.length === 0, findings: f, width, height, elements };
}

/** What a page would record for each decorative SVG (the research shape of an `assets.json` entry; not the comp-impl schema). */
export type DecorationAsset = { id: string; file: string; sha256: string; bytes: number; width: number; height: number; kind: "decoration_svg"; role: "decoration" };
export const DECORATION_FILE = /^assets\/[a-z0-9][a-z0-9-]{0,60}\.svg$/;

/**
 * The page side: a decorative SVG may appear only as `<img src="assets/<name>.svg">` naming a recorded asset, never in
 * CSS (no `url()` exists there anyway), never as `<object>` / `<embed>` / `<iframe>` / inline `<svg>`, and each recorded
 * asset is referenced. A scan of the source text (the production lane would check the live DOM as well).
 */
export function decorationReferenceProblems(html: string, css: string, assets: readonly DecorationAsset[]): string[] {
  const p = new Set<string>();
  const files = new Set(assets.map((a) => a.file));
  if (/<svg[\s>]/i.test(html)) p.add("INLINE_SVG");
  if (/<(object|embed|iframe)\b/i.test(html)) p.add("SVG_EMBEDDED_NOT_IMG");
  if (/\.svg\b/i.test(css)) p.add("SVG_FROM_CSS");
  const used = new Set<string>();
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const src = /\ssrc\s*=\s*"([^"]*)"/i.exec(m[1]!)?.[1];
    if (!src || !/\.svg$/i.test(src)) continue;
    if (!files.has(src)) p.add("SVG_NOT_RECORDED");
    if (!/\saria-hidden\s*=\s*"true"/i.test(m[1]!) || !/\salt\s*=\s*""/i.test(m[1]!)) p.add("SVG_IMG_NOT_DECORATIVE");
    used.add(src);
  }
  for (const m of html.matchAll(/\b(?:src|href|srcset|data)\s*=\s*"([^"]*\.svg[^"]*)"/gi)) if (!files.has(m[1]!)) p.add("SVG_NOT_RECORDED");
  for (const a of assets) {
    if (!DECORATION_FILE.test(a.file) || a.file.split("/").includes("..")) p.add("SVG_FILE_NAME");
    if (!used.has(a.file)) p.add("SVG_RECORDED_NOT_USED");
  }
  return [...p].sort();
}

/**
 * The file side of one recorded asset, inside the page directory `dir`: the name is `assets/<name>.svg`, the file and
 * every directory on the way are real (no symlink), it stays inside `dir`, and its bytes, sha256, size and dimensions
 * are the ones recorded and pass checkDecorationSvg.
 */
export function checkDecorationAssetFile(dir: string, asset: DecorationAsset): string[] {
  const p: string[] = [];
  if (asset.kind !== "decoration_svg" || asset.role !== "decoration") p.push("ASSET_KIND");
  if (!DECORATION_FILE.test(asset.file) || asset.file.split("/").includes("..")) return [...p, "ASSET_FILE_NAME"];
  const root = resolve(dir);
  const full = join(root, asset.file);
  if (!(full.startsWith(root + sep))) return [...p, "ASSET_OUTSIDE"];
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
  if (st.size > DECORATION_SVG_LIMITS.bytes) return [...p, "ASSET_TOO_LARGE"];
  const bytes = readFileSync(full);
  if (bytes.length !== asset.bytes) p.push("ASSET_BYTES");
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) p.push("ASSET_SHA256");
  const c = checkDecorationSvg(bytes);
  if (!c.ok) p.push(...c.findings.map((x) => x.code));
  else if (c.width !== asset.width || c.height !== asset.height) p.push("ASSET_DIMENSIONS");
  return [...new Set(p)];
}
