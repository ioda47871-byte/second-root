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
 * checkDecorationPage (the page that shows the files) is an element and attribute allowlist, pure; its second line, a
 * Chromium render with request logging, is decoration-page-browser.ts. No network, no child process in this module.
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
/**
 * DEV-165 (owner, 2026-11-04): `skewX` / `skewY` are refused by default — none of the three shops needs them. They are
 * no longer in the value grammar, and a transform that names one is reported as SVG_TRANSFORM_SKEW (any case). A
 * `matrix()`, or a transform list or chain of nested `transform`s whose composed linear part shears (its columns are
 * not orthogonal), is SVG_TRANSFORM_SHEAR: the same slant without the name. Argument counts follow SVG: matrix 6,
 * translate and scale 1–2, rotate 1 or 3.
 *
 * The root's own viewBox mapping is part of that product when it is non-uniform: with `preserveAspectRatio="none"` and
 * a `width`/`height` aspect other than the viewBox's, the file stretches its content per axis, and a `rotate()` inside
 * becomes a slant. That scale is composed before every child transform (Fresh Review L1). A product (or any step of a
 * list) that leaves the finite numbers, e.g. `scale(1e200 1) rotate(30)` overflowing, is SVG_TRANSFORM_RANGE: refused,
 * never judged on Infinity or NaN (Fresh Review L2). The shear test compares unit columns, so a huge or tiny scale
 * neither hides nor fakes a shear.
 */
const TRANSFORM_FN = new RegExp(`(matrix|translate|scale|rotate)\\(\\s*(${NUM}(?:\\s*,?\\s*${NUM}){0,5})\\s*\\)`, "g");
const TRANSFORM_ARGS: Record<string, readonly number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3] };
const SKEW = /skew[xy]?\s*\(/i;
const transform = (v: string) => v.trim().length > 0 && v.replace(TRANSFORM_FN, "").replace(/[\s,]/g, "") === "" && transformList(v) !== null;
/** The 2×2 linear part [a, b, c, d] (columns (a, b) and (c, d)) of a transform list, or null when an argument count is wrong. */
type Linear = readonly [number, number, number, number];
const IDENTITY: Linear = [1, 0, 0, 1];
const times = (m: Linear, n: Linear): Linear => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3]];
const NON_FINITE: Linear = [NaN, NaN, NaN, NaN];
const finiteLinear = (m: Linear) => m.every((x) => Number.isFinite(x));
/** The product, or NON_FINITE as soon as any step leaves the finite numbers (NaN then stays through `times`). */
function transformList(v: string): Linear | null {
  let m = IDENTITY;
  for (const t of v.matchAll(TRANSFORM_FN)) {
    const fn = t[1]!;
    const a = t[2]!.split(/\s*,\s*|\s+/).filter(Boolean).map(Number);
    if (!TRANSFORM_ARGS[fn]!.includes(a.length) || a.some((x) => !Number.isFinite(x))) return null;
    let n: Linear = IDENTITY;
    if (fn === "matrix") n = [a[0]!, a[1]!, a[2]!, a[3]!];
    else if (fn === "scale") n = [a[0]!, 0, 0, a[1] ?? a[0]!];
    else if (fn === "rotate") {
      const r = (a[0]! * Math.PI) / 180;
      n = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r)];
    }
    m = times(m, n);
    if (!finiteLinear(m)) m = NON_FINITE;
  }
  return m;
}
/**
 * What a composed linear part says: SVG_TRANSFORM_RANGE when it (or a column length) is not finite, SVG_TRANSFORM_SHEAR
 * when its columns are not orthogonal (rotation, mirroring and per-axis scale alone keep them so), else null. The columns
 * are compared as unit vectors (|cos| of the angle between them > 1e-9). A zero column (scale(0)) does not shear.
 */
function transformProblem(m: Linear): "SVG_TRANSFORM_RANGE" | "SVG_TRANSFORM_SHEAR" | null {
  if (!finiteLinear(m)) return "SVG_TRANSFORM_RANGE";
  const p = Math.hypot(m[0], m[1]);
  const q = Math.hypot(m[2], m[3]);
  if (!Number.isFinite(p) || !Number.isFinite(q)) return "SVG_TRANSFORM_RANGE";
  if (p === 0 || q === 0) return null;
  return Math.abs((m[0] / p) * (m[2] / q) + (m[1] / p) * (m[3] / q)) > 1e-9 ? "SVG_TRANSFORM_SHEAR" : null;
}
/**
 * The root's viewBox mapping when it is non-uniform (`preserveAspectRatio="none"`, width/height aspect ≠ viewBox aspect):
 * scale(width / vbWidth, height / vbHeight). Identity otherwise, or when a value does not parse (other findings refuse it).
 */
function rootViewBoxScale(attrs: ReadonlyMap<string, string>): Linear {
  if (attrs.get("preserveAspectRatio") !== "none") return IDENTITY;
  const vb = VIEWBOX.exec(attrs.get("viewBox") ?? "");
  const w = pxValue(attrs.get("width"));
  const h = pxValue(attrs.get("height"));
  if (!vb || w === null || h === null) return IDENTITY;
  const vw = Number(vb[3]);
  const vh = Number(vb[4]);
  if (!(w > 0 && h > 0 && vw > 0 && vh > 0)) return IDENTITY;
  return [w / vw, 0, 0, h / vh];
}
const pxValue = (v: string | undefined) => (v !== undefined && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(v) ? Number(v.replace(/px$/, "")) : null);
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
  /** The composed linear part of every open element's `transform` chain, parallel to `stack`. */
  const linear: Linear[] = [];
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
      linear.pop();
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
      if ((an === "transform" || an === "gradientTransform") && SKEW.test(av)) f.push({ code: "SVG_TRANSFORM_SKEW", detail: `${name}@${an}`.slice(0, 40) });
      if (/url\(/i.test(av)) {
        const ref = PAINT_REF.exec(av);
        if (!ref || !(an === "fill" || an === "stroke")) f.push({ code: "SVG_URL", detail: `${name}@${an}`.slice(0, 40) });
        else refs.push(ref[1]!);
      }
    }
    // a shear without the skew name: the element's own transform composed with every enclosing one (gradientTransform alone)
    // (the root's non-uniform viewBox scale is already in the parent's product: see rootViewBoxScale below)
    const ownTransform = attrs.get("transform");
    const here = ownTransform !== undefined ? times(linear[linear.length - 1] ?? IDENTITY, transformList(ownTransform) ?? IDENTITY) : (linear[linear.length - 1] ?? IDENTITY);
    const ownProblem = ownTransform !== undefined ? transformProblem(here) : null;
    if (ownProblem) f.push({ code: ownProblem, detail: `${name}@transform` });
    const gradientOwn = attrs.get("gradientTransform");
    const gradientProblem = gradientOwn !== undefined ? transformProblem(transformList(gradientOwn) ?? IDENTITY) : null;
    if (gradientProblem) f.push({ code: gradientProblem, detail: `${name}@gradientTransform` });
    const isRoot = name === "svg" && stack.length === 0 && root === null;
    const idValue = attrs.get("id");
    if (idValue) {
      if (ids.has(idValue)) f.push({ code: "SVG_ID_DUPLICATE", detail: idValue });
      ids.set(idValue, name);
    }
    if (isRoot) root = attrs;
    if (!selfClosing) {
      stack.push(name);
      // the root's children live in its viewBox space: a non-uniform viewBox scale comes before their transforms (L1)
      linear.push(isRoot ? times(here, rootViewBoxScale(attrs)) : here);
      if (stack.length > DECORATION_SVG_LIMITS.depth) return out("SVG_TOO_DEEP");
    } else if (stack.length === 0) closedRoot = true;
  }
  if (stack.length) f.push({ code: "SVG_MALFORMED", detail: "unclosed element" });
  if (!root) return out("SVG_NO_ROOT");
  if (root.get("xmlns") !== SVG_NS) f.push({ code: "SVG_NAMESPACE" });
  for (const r of refs) if (!/Gradient$/.test(ids.get(r) ?? "")) f.push({ code: "SVG_REF_NOT_A_GRADIENT", detail: r });
  const width = pxValue(root.get("width"));
  const height = pxValue(root.get("height"));
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

/**
 * DEV-165 (owner decision, Issue #193 comment 6623100651): every decorative SVG needs the OWNER's visual review of that
 * exact file, because no automated check can tell that a path does not draw letters. The review is bound to the bytes:
 * `asset_sha256` must equal the sha256 of the file as read, so any byte change voids it.
 *
 * This record is written by the owner only. Claude (or any agent, worker or script) never writes, fills, copies or
 * "renews" it — not even with the owner's words from a chat. The checker cannot tell who wrote it; `reviewed_by: "owner"`
 * is a claim, and keeping agents from making that claim is a rule (docs/design/n1-decoration-svg.md §2.11), pinned by a
 * test that no tracked file outside the tests holds such a record. Approving an asset is an owner action.
 */
export type OwnerVisualReview = { reviewed_by: "owner"; reviewed_at: string; asset_sha256: string; decision: "approved" | "rejected"; note: string };
export const OWNER_REVIEW_KEYS = ["asset_sha256", "decision", "note", "reviewed_at", "reviewed_by"] as const;
export const OWNER_REVIEW_NOTE_MAX = 500;

/** What a page would record for each decorative SVG (the research shape of an `assets.json` entry; not the comp-impl schema). */
export type DecorationAsset = { id: string; file: string; sha256: string; bytes: number; width: number; height: number; kind: "decoration_svg"; role: "decoration"; owner_visual_review: OwnerVisualReview };
/** What the page side reads of a record: the id and the file. */
export type DecorationAssetRef = Pick<DecorationAsset, "id" | "file">;
export const DECORATION_FILE = /^assets\/[a-z0-9][a-z0-9-]{0,60}\.svg$/;
export const DECORATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------------------------------------------
// The page side: an ALLOWLIST, not a list of known-bad inputs. A small HTML tokenizer splits tags and attributes as a
// browser does (double-quoted, single-quoted and unquoted values, ASCII case-insensitive names, `/` as a separator),
// then every element name and every attribute (per element, with a value grammar) must be on a short fixed list of
// plain HTML content elements. Every element that changes how the rest of the input is parsed (foreign content: `svg`,
// `math`; raw text: `script`, `style`, `textarea`, `xmp`, `noembed`, `noframes`, `iframe`, `plaintext`; `noscript`,
// which is raw text with JS on and markup with JS off; `template`) and every element or attribute that loads or
// redirects anything (`base`, `link`, `picture` / `source`, `srcset`, `object`, `embed`, `video`, `audio`, `image`,
// `input`, `form` …) is off the list, so it is refused by name. The one raw-text element left is `title`, allowed only
// inside `head`. Comments and declarations other than a leading `<!doctype html>` are refused, so the tokenizer never
// has to agree with a browser on where a comment ends. The browser verification in decoration-page-browser.ts is the
// second line.
// ---------------------------------------------------------------------------------------------------------------

const HTML_WS = /[\t\n\f\r ]/;
const asciiLower = (v: string) => v.replace(/[A-Z]/g, (c) => c.toLowerCase());
const NAMED_REFS: ReadonlyMap<string, string> = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["sol", "/"], ["bsol", "\\"], ["period", "."], ["colon", ":"], ["lpar", "("], ["rpar", ")"],
  ["num", "#"], ["percnt", "%"], ["quest", "?"], ["equals", "="], ["comma", ","], ["semi", ";"], ["tab", "\t"], ["newline", "\n"], ["nbsp", " "],
]); // prettier-ignore
const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�");

/** HTML character references (numeric and a small named table): used only for extra readings of the page CSS. */
const decodeHtml = (v: string) =>
  v.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (m, ref: string) => {
    if (ref.startsWith("#")) return codePoint(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10));
    return NAMED_REFS.get(ref.toLowerCase()) ?? m;
  });

/** CSS escapes: `\67` (1–6 hex digits and one optional white space) and `\x` for any other character. */
const unescapeCss = (v: string) =>
  v.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_m, hex: string | undefined, ch: string | undefined) => (hex ? codePoint(parseInt(hex, 16)) : ch === "\n" ? "" : (ch ?? "")));

/** Leading C0 controls and spaces, which a URL parser strips. */
const trimC0 = (v: string) => {
  let k = 0;
  while (k < v.length && v.charCodeAt(k) <= 0x20) k++;
  return v.slice(k);
};
/** Text as a browser would read it for matching: tab / LF / CR / FF removed, leading C0 trimmed, %XX decoded once, `\` as `/`, lower case. */
const normaliseUrlText = (v: string) =>
  asciiLower(trimC0(v.replace(/[\t\n\r\f]/g, "").replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\/g, "/")));
/** Every reading of the CSS the checker matches against: raw, entity-decoded, CSS-unescaped and both, each normalised. */
const cssReadings = (v: string) => [...new Set([v, decodeHtml(v), unescapeCss(v), unescapeCss(decodeHtml(v))].map(normaliseUrlText))];

const CSS_LOADS = /url\s*\(|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|element\s*\(|@import|\bsrc\s*\(/;

/** Anything containing `.svg` or an SVG media type, or a recorded file with or without its `.svg`, also after dot segments. */
function svgMatcher(files: readonly string[]): (v: string) => boolean {
  const stems = files.map((f) => new RegExp(`(?:^|[^a-z0-9-])${f.replace(/\.svg$/, "").replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}(?![a-z0-9-])`));
  const one = (v: string) => v.includes(".svg") || v.includes("svg+xml") || v.includes("image/svg") || stems.some((re) => re.test(v));
  return (v) => one(v) || one(posix.normalize(v));
}

/** The page CSS (the production lane's page-css allowlist also refuses `url(`; this checker does not lean on it). */
function cssProblemsInto(css: string, refersToSvg: (v: string) => boolean, p: Set<string>) {
  for (const v of cssReadings(css).flatMap((r) => [r, r.replace(/\/\*[\s\S]*?\*\//g, "")])) {
    if (CSS_LOADS.test(v)) p.add("CSS_URL");
    if (refersToSvg(v)) p.add("SVG_FROM_CSS");
  }
}

type AttrRule = (v: string) => boolean;
const token = (max: number) => (v: string) => new RegExp(`^[A-Za-z0-9 _.-]{0,${max}}$`).test(v);
const plainText = (v: string) => v.length <= 200 && !/[<>"'`=]/.test(v);
/** Attributes any allowed element (but `meta`) may carry. None of them loads, redirects, styles or scripts anything. */
const GLOBAL_PAGE_ATTRIBUTES: Record<string, AttrRule> = {
  class: (v) => /^[A-Za-z0-9_\- \t\n]{0,400}$/.test(v),
  id: (v) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v),
  lang: (v) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(v),
  "aria-label": plainText,
  "aria-hidden": (v) => v === "true" || v === "false",
  ...Object.fromEntries(
    ["data-comp-role", "data-comp-section", "data-comp-type", "data-comp-slot", "data-comp-placeholder", "data-comp-nav", "data-comp-cta", "data-comp-disclosure", "data-comp-container"].map((a) => [a, token(64)]),
  ),
};
const plain = { attrs: {}, globals: true } as const;
/**
 * Element → its own attributes (with value rules) and whether the global ones apply. Plain content and structure
 * elements only, close to the production DOM allowlist (comp-impl/page-scripts.ts PAGE_ELEMENTS) minus `link` (a page
 * here loads nothing but its recorded assets) plus a few inert inline and block elements. `img` must be a recorded
 * decorative asset (checked below); `a` may only point inside the page (`#id`).
 */
const PAGE_ELEMENTS: Record<string, { attrs: Record<string, AttrRule>; globals: boolean }> = {
  html: plain,
  head: plain,
  meta: { attrs: { charset: (v) => asciiLower(v) === "utf-8" }, globals: false },
  title: plain,
  body: plain,
  ...Object.fromEntries(
    ["header", "main", "footer", "nav", "section", "article", "aside", "div", "p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "figure", "figcaption", "br", "hr", "strong", "em", "small", "b", "i", "time", "address", "blockquote"].map((e) => [e, plain]),
  ),
  a: { attrs: { href: (v) => /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v) || v === "#" }, globals: true },
  img: {
    attrs: {
      src: (v) => DECORATION_FILE.test(v),
      alt: (v) => v === "",
      referrerpolicy: (v) => v === "no-referrer",
      width: (v) => /^[1-9]\d{0,3}$/.test(v),
      height: (v) => /^[1-9]\d{0,3}$/.test(v),
      loading: (v) => v === "eager" || v === "lazy",
      decoding: (v) => v === "sync" || v === "async" || v === "auto",
    },
    globals: true,
  },
};
export const DECORATION_PAGE_ELEMENTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(Object.entries(PAGE_ELEMENTS).map(([e, s]) => [e, Object.keys(s.attrs)]));
export const DECORATION_PAGE_GLOBAL_ATTRIBUTES: readonly string[] = Object.keys(GLOBAL_PAGE_ATTRIBUTES);
/** The elements a browser may put in `head` without closing it, of those on the list. */
const HEAD_CONTENT = new Set(["meta", "title"]);

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
function assetListProblemsInto(assets: readonly DecorationAssetRef[], p: Set<string>) {
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

export type DecorationPageCheck = { problems: string[]; used: string[] };

/**
 * The page side, as an allowlist. A page passes only when:
 * - its characters are free of NUL and C0 / C1 controls but tab, LF, FF and CR;
 * - it holds no comment and no `<!…>` / `<?…>` / `</…` other than tags, but one leading `<!doctype html>`;
 * - every start and end tag names an element on DECORATION_PAGE_ELEMENTS (`PAGE_ELEMENT_NOT_ALLOWED`; `svg` also gives
 *   `INLINE_SVG`), end tags carry no attributes, and `title` stands only in `head` (`PAGE_ELEMENT_PLACE`) and holds no `<`;
 * - every attribute is its element's own or (but on `meta`) a global one (`PAGE_ATTRIBUTE_NOT_ALLOWED`), its value has no
 *   `&` (`PAGE_ENTITY`, so no character reference can hide anything) and fits the attribute's grammar
 *   (`PAGE_ATTRIBUTE_VALUE`), and no attribute is given twice (`PAGE_ATTRIBUTE_DUPLICATE`);
 * - every `img` has `src` equal to a recorded file (`SVG_NOT_RECORDED`) and is decorative: `alt=""`, `aria-hidden="true"`,
 *   `referrerpolicy="no-referrer"` (`SVG_IMG_NOT_DECORATIVE`, `SVG_IMG_REFERRER`);
 * - the page CSS loads nothing (`CSS_URL`, `SVG_FROM_CSS`);
 * - the record is well formed and every recorded asset is used by a clean decorative `img` (`SVG_RECORDED_NOT_USED`).
 * `used` lists the recorded files that a clean `img` (no refused attribute, nothing else wrong with the tag) loads.
 */
export function checkDecorationPage(html: string, css: string, assets: readonly DecorationAssetRef[]): DecorationPageCheck {
  const p = new Set<string>();
  const used = new Set<string>();
  try {
    pageInto(String(html), String(css), assets, p, used);
  } catch {
    p.add("PAGE_CHECK_ERROR");
  }
  return { problems: [...p].sort(), used: [...used].sort() };
}

/** checkDecorationPage's problem codes only. */
export function decorationReferenceProblems(html: string, css: string, assets: readonly DecorationAssetRef[]): string[] {
  return checkDecorationPage(html, css, assets).problems;
}

function pageInto(html: string, css: string, assets: readonly DecorationAssetRef[], p: Set<string>, used: Set<string>) {
  assetListProblemsInto(assets, p);
  const files = new Set(assets.map((a) => (typeof a?.file === "string" ? a.file : "")).filter((f) => DECORATION_FILE.test(f)));
  cssProblemsInto(css, svgMatcher([...files]), p);
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/.test(html)) p.add("PAGE_CONTROL_CHAR");
  if (/<\/?svg/i.test(html)) p.add("INLINE_SVG"); // anywhere, text included

  // where `title` may stand: after `<head>`, before anything that closes it (a browser closes `head` implicitly); a
  // `<head>` after body content is too late (a browser ignores it)
  let head: "before" | "in" | "after" = "before";
  const n = html.length;
  const doctype = /^[\t\n\f\r ]*<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/i.exec(html);
  let i = doctype ? doctype[0].length : 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (head !== "after" && html.slice(i, lt < 0 ? n : lt).trim()) head = "after";
    if (lt < 0) break;
    i = lt + 1;
    const c = html[i] ?? "";
    const closing = c === "/" && /[A-Za-z]/.test(html[i + 1] ?? "");
    if (c === "!" || c === "?" || (c === "/" && !closing)) {
      // a comment, a declaration, a processing instruction or a bogus end tag: none is allowed (no agreement on where it ends is needed)
      p.add(html.startsWith("!--", i) ? "PAGE_COMMENT" : "PAGE_DECLARATION");
      const e = html.indexOf(">", i);
      if (e < 0) {
        p.add("PAGE_MALFORMED");
        break;
      }
      i = e + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(c) && !closing) continue; // `<` as text
    const t = readTag(html, closing ? i + 1 : i);
    if (!t) {
      p.add("PAGE_MALFORMED");
      break;
    }
    i = t.end;
    const spec = Object.hasOwn(PAGE_ELEMENTS, t.name) ? PAGE_ELEMENTS[t.name] : undefined;
    if (!spec) {
      p.add("PAGE_ELEMENT_NOT_ALLOWED");
      if (t.name === "svg") p.add("INLINE_SVG");
    }
    if (closing) {
      if (t.attrs.size) p.add("PAGE_MALFORMED");
      if (t.name === "head" && head === "in") head = "after";
      continue;
    }
    if (t.name === "head") {
      if (head === "before") head = "in";
      else p.add("PAGE_ELEMENT_PLACE");
    } else if (head !== "after" && t.name !== "html" && !HEAD_CONTENT.has(t.name)) head = "after";

    let tagClean = !!spec && !t.duplicate;
    if (t.duplicate) p.add("PAGE_ATTRIBUTE_DUPLICATE");
    for (const [an, av] of t.attrs) {
      const rule = spec ? (Object.hasOwn(spec.attrs, an) ? spec.attrs[an] : spec.globals && Object.hasOwn(GLOBAL_PAGE_ATTRIBUTES, an) ? GLOBAL_PAGE_ATTRIBUTES[an] : undefined) : undefined;
      if (spec && !rule) {
        p.add("PAGE_ATTRIBUTE_NOT_ALLOWED");
        tagClean = false;
      }
      if (av.includes("&")) {
        p.add("PAGE_ENTITY");
        tagClean = false;
      } else if (rule && !rule(av)) {
        p.add(t.name === "img" && an === "src" ? "SVG_NOT_RECORDED" : "PAGE_ATTRIBUTE_VALUE");
        tagClean = false;
      }
    }
    if (t.name === "img") {
      const src = t.attrs.get("src");
      if (src === undefined || !files.has(src)) {
        p.add("SVG_NOT_RECORDED");
        tagClean = false;
      }
      if (t.attrs.get("alt") !== "" || t.attrs.get("aria-hidden") !== "true") {
        p.add("SVG_IMG_NOT_DECORATIVE");
        tagClean = false;
      }
      if (t.attrs.get("referrerpolicy") !== "no-referrer") {
        p.add("SVG_IMG_REFERRER");
        tagClean = false;
      }
      if (tagClean && src !== undefined) used.add(src);
    }

    if (t.name === "title") {
      // the one raw-text (RCDATA) element on the list: allowed only in head, its text runs to `</title`
      if (head !== "in") p.add("PAGE_ELEMENT_PLACE");
      const close = /<\/title(?=[\t\n\f\r />])/i.exec(html.slice(i));
      if (!close) {
        p.add("PAGE_MALFORMED");
        break;
      }
      if (html.slice(i, i + close.index).includes("<")) p.add("PAGE_TITLE_CONTENT");
      i += close.index;
    }
  }
  for (const f of files) if (!used.has(f)) p.add("SVG_RECORDED_NOT_USED");
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2})))?$/;
/** A real calendar date (and time), not after `now` (one day of slack for time zones). */
function reviewDateOk(v: unknown, now: Date): boolean {
  if (typeof v !== "string") return false;
  const m = ISO_DAY.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || y < 2026) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59 || Number(m[7] ?? 0) > 23 || Number(m[8] ?? 0) > 59)) return false;
  const at = Date.parse(m[4] === undefined ? `${v}T00:00:00Z` : v);
  return Number.isFinite(at) && at <= now.getTime() + 24 * 3600 * 1000;
}

/**
 * The owner's visual review of one asset (DEV-165). `actualSha256` is the sha256 of the bytes as read (null when the file
 * could not be read: the review then cannot be bound and is OWNER_REVIEW_SHA256). Codes:
 * OWNER_REVIEW_MISSING (no review object), OWNER_REVIEW_SHAPE (keys other than exactly the five), OWNER_REVIEW_REVIEWER
 * (reviewed_by is not "owner"), OWNER_REVIEW_DATE (not an ISO date, not a real day, before 2026 or in the future),
 * OWNER_REVIEW_SHA256 (not 64 lower-case hex, or not the file's own sha256), OWNER_REVIEW_DECISION (neither approved nor
 * rejected), OWNER_REVIEW_REJECTED (the owner refused it), OWNER_REVIEW_NOTE (not a string, or over 500 characters).
 * Never throws.
 */
export function ownerReviewProblems(review: unknown, actualSha256: string | null, now: Date = new Date()): string[] {
  try {
    if (typeof review !== "object" || review === null || Array.isArray(review)) return ["OWNER_REVIEW_MISSING"];
    const r = review as Record<string, unknown>;
    const p: string[] = [];
    const keys = Object.keys(r).sort();
    if (keys.length !== OWNER_REVIEW_KEYS.length || keys.some((k, i) => k !== OWNER_REVIEW_KEYS[i])) p.push("OWNER_REVIEW_SHAPE");
    if (r.reviewed_by !== "owner") p.push("OWNER_REVIEW_REVIEWER");
    if (!reviewDateOk(r.reviewed_at, now)) p.push("OWNER_REVIEW_DATE");
    if (typeof r.asset_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.asset_sha256) || actualSha256 === null || r.asset_sha256 !== actualSha256) p.push("OWNER_REVIEW_SHA256");
    if (r.decision === "rejected") p.push("OWNER_REVIEW_REJECTED");
    else if (r.decision !== "approved") p.push("OWNER_REVIEW_DECISION");
    if (typeof r.note !== "string" || r.note.length > OWNER_REVIEW_NOTE_MAX) p.push("OWNER_REVIEW_NOTE");
    return p;
  } catch {
    return ["OWNER_REVIEW_MISSING"];
  }
}

/**
 * The file side of one recorded asset, inside the page directory `dir`: the id and name have their forms, the file and
 * every directory on the way are real (no symlink), the file has one link only (no hardlink), it stays inside `dir`,
 * and its bytes, sha256, size and dimensions are the ones recorded and pass checkDecorationSvg. Never throws: anything
 * unexpected is the code ASSET_CHECK_ERROR. (Between the lstat checks and the read a file could be swapped; the sha256
 * of the bytes actually read pins the content, so a swap can only make the check fail.)
 * DEV-165: the owner's visual review must be present, approved and bound to the sha256 of the bytes read
 * (ownerReviewProblems); when the file is not read the review cannot be bound, so a refused file also carries
 * OWNER_REVIEW_SHA256. A file passes only with an approved review of exactly its bytes.
 */
export function checkDecorationAssetFile(dir: string, asset: DecorationAsset, now: Date = new Date()): string[] {
  const p: string[] = [];
  const read: { sha256: string | null } = { sha256: null };
  let file: string[];
  try {
    file = checkAssetFile(dir, asset, p, read);
  } catch {
    file = [...p, "ASSET_CHECK_ERROR"];
  }
  let review: unknown;
  try {
    review = asset?.owner_visual_review;
  } catch {
    review = undefined;
  }
  return [...new Set([...file, ...ownerReviewProblems(review, read.sha256, now)])];
}

function checkAssetFile(dir: string, asset: DecorationAsset, p: string[], read: { sha256: string | null }): string[] {
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
  read.sha256 = createHash("sha256").update(bytes).digest("hex");
  if (read.sha256 !== asset.sha256) p.push("ASSET_SHA256");
  const c = checkDecorationSvg(bytes);
  if (!c.ok) p.push(...c.findings.map((x) => x.code));
  else if (c.width !== asset.width || c.height !== asset.height) p.push("ASSET_DIMENSIONS");
  return [...new Set(p)];
}
