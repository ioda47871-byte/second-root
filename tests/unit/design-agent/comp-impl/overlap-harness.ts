import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { pageCssProblems, type PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { groundStructure, GROUND_FLAT_TOLERANCE } from "@/lib/design-agent/comp-impl/verify";
import { mediaSegments } from "@/lib/design-agent/comp-impl/render";
import { REPO, SHOPS, shopFacts, type ShopKey } from "./nowrap-harness";
import { C_PRIME } from "./scale-harness";

// DEV-173 (Issue #193 comment 6628165899): the research harness for phase C (safe overlap, paint order, layers).
// TEST-ONLY PROTOTYPE, NOT ENABLED. Nothing in lib/ changes: this file implements, outside the production checker, the
// render check and the grammar that docs/design/phase-c-design.md proposes (capability `layered_decoration`, flag
// `layeredDecoration`, default OFF, HOLD for the owner's approval), so the tests can show what they catch and what they let
// through on synthetic probes and on the three shops' strict B and C′ pages. The production grammar (page-css.ts) and the
// run (run.ts) never see any of it; APPROVED_CAPABILITIES stays empty.

const POC = join(REPO, "design-library/research/quality-pipeline/poc");

// ---------------------------------------------------------------- the render check (in the page)

/**
 * The text nodes that hold part of a protected string (plain JavaScript; call with the whitespace-free strings). A fact
 * can be split over elements — inline (`<p>電話 000-0000-<span>0712</span></p>`, DEV-175 re-review 4 H1), over flex /
 * grid items, or over blocks (`<p>000-0000-</p><p>0712</p>`, re-review 5 H1) — and a part's own element text neither
 * holds the fact nor is 6+ characters of it. So: ONE pass over the body's text nodes in DOM order joins their text, each
 * original character normalised on its own (NFKD; combining marks, format characters (Cf: zero-width space, soft
 * hyphen …) and whitespace dropped: re-review 5 L1) with the node that owns every output character; each protected string
 * is normalised the same way and every occurrence in the joined text marks its owners. Matching across blocks and
 * dropping marks (が and か both read か) only add protection: the fail-closed direction. Confusable characters fold to one
 * form on both sides (DEV-178, the DEV-175 review's Low): U+2010–2015, U+2212, U+30FC, U+2043 and U+2E3A to "-"; U+FF5E, U+301C,
 * ASCII "~", U+223C, U+2053 and U+3030 to 〜 (the ASCII tilde and the rest added after the DEV-178 Fresh Review),
 * one character to one character, so the owner of each output character stays the node it came from (protection only:
 * a dash that is not the fact's hyphen may now match it). Shared by phase-d-harness.ts.
 */
export const FACT_NODES_JS = String.raw`(protect) => {
  // confusables (DEV-178): hyphen-like dashes, the minus sign and the long-vowel mark read as "-"; the full-width tilde and the
  // wave dash read as 〜. One character to one character, applied to each character before and after NFKD (NFKD turns
  // U+FF5E into "~", so the map must see it first), on the page's text and on the protected strings alike.
  const CONFUSABLE = { "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-", "\u30fc": "-", "\u2043": "-", "\u2e3a": "-", "\uff5e": "\u301c", "\u301c": "\u301c", "~": "\u301c", "\u223c": "\u301c", "\u2053": "\u301c", "\u3030": "\u301c" };
  const fold = (c) => CONFUSABLE[c] || c;
  const norm = (ch) => Array.from(fold(ch).normalize("NFKD")).map(fold).join("").replace(/[\p{M}\p{Cf}\s]/gu, "");
  const normAll = (s) => Array.from(s || "").map(norm).join("");
  // the group a text node is joined in: the whole body (one string in DOM order)
  const groupOf = (n) => document.body;
  const groups = new Map();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.parentElement || n.parentElement.closest("style, script, title")) continue;
    const g = groupOf(n);
    if (!groups.has(g)) groups.set(g, { text: "", owner: [] });
    const G = groups.get(g);
    for (const ch of Array.from(n.data)) {
      const x = norm(ch);
      for (const c of Array.from(x)) { G.text += c; G.owner.push(n); }
    }
  }
  const facts = protect.map(normAll).filter(Boolean);
  const touched = new Set();
  for (const G of groups.values()) {
    // occurrences are found by code unit, owners are kept by code point: a code-unit → code-point index
    const cp = [];
    let k = 0;
    for (const c of Array.from(G.text)) { for (let u = 0; u < c.length; u++) cp.push(k); k += 1; }
    for (const f of facts) {
      const fl = Array.from(f).length;
      for (let i = G.text.indexOf(f); i >= 0; i = G.text.indexOf(f, i + 1)) for (let q = cp[i]; q < cp[i] + fl; q++) touched.add(G.owner[q]);
    }
  }
  return touched;
}`;

/**
 * The phase C check at the current viewport (plain JavaScript, like lib/design-agent/comp-impl/layers.ts; the caller
 * appends its JSON argument). Argument: { protect (whitespace-free strings: required facts and the name), protectSel
 * (elements whose text is protected whatever it says: dt, dd, h1, the disclosure), ordinary ("plate" | "allow": whether
 * ordinary text over a decoration needs a plate), grammar (true: also the role rules of the proposed grammar),
 * glyphs (true: also return every glyph box, for the pixel pass), detail (true: return up to 40 findings) }.
 *
 * Text. Every non-empty text node in the body (aria-hidden ones too: they are drawn) and in inline SVG. Its glyph boxes
 * are its characters' Range rects, cut vertically to 1.3 em about the rect's centre (the Range rect is the font's
 * content area: 1.45 em for Noto Sans CJK, so lines set solid would meet their neighbours without any ink there).
 * Protected: inside protectSel, or the element's whole text holds a protected string, or (6+ characters) is part of one.
 *
 * Painters. Every element that paints: a ground (colour or image), each visible border side, an img, an SVG shape
 * (stroke included), a materialized pseudo-element (MATERIALIZE_SCRIPT: a real span in its place), and other text.
 * Paint that hit-testing does not see is listed apart (`hit: false`): outer box-shadows, outlines, the spread of a
 * filter (blur 3r, drop-shadow offset + 3r; any other filter that moves paint: unbounded), box reflections.
 *
 * V2, paint order. For every glyph box G of text T and every painter P (not T's own element; not an ancestor of T, except
 * an ancestor's outline) whose extent meets G by more than 0.5 px both ways:
 *   - P is other text: TEXT_ON_TEXT (OVERLAP_PROTECTED_TEXT_ON_TEXT when either is protected), whatever the order;
 *   - P paints where hit-testing cannot see it: OVERLAP_ORDER_UNPROVEN (fail closed);
 *   - else document.elementsFromPoint at sample points in G ∩ P (pointer-events forced to auto, so pointer-events: none
 *     hides nothing): P listed above T at any point is OVERLAP_PAINT_ABOVE_TEXT (…_PROTECTED); T missing from a stack
 *     where P is present is OVERLAP_ORDER_UNPROVEN.
 * V4, protected text (G grown by 1 px). P below T at every point still fails (OVERLAP_PROTECTED_ON_DECORATION) unless a
 * plate hides it: an element Q, T or an ancestor of T, with an opaque flat ground whose padding box holds G, inside an
 * atomic box A (Q or an ancestor: positioned, a stacking context, a flex / grid item or an inline-block) that does not
 * contain P and is listed above P at every point where P is present. Ordinary text with ordinary: "plate" needs the same
 * (OVERLAP_TEXT_ON_DECORATION); with "allow" a decoration may sit under it.
 * V4 also: a protected glyph left of 0, right of the viewport or above the page (OVERLAP_PROTECTED_OFFSCREEN); outside the
 * padding box of an ancestor that clips (overflow other than visible) or under any clip-path / mask on an ancestor
 * (OVERLAP_PROTECTED_CLIPPED); a protected text with no glyph box (OVERLAP_PROTECTED_HIDDEN).
 * Grammar (grammar: true). An element placed out of flow or under the flow — position absolute / fixed / sticky, a
 * transform, a z-index below 0 — holds no text (text, aria-label, alt): OVERLAP_LAYER_HAS_TEXT. An element holding text
 * may be position: relative only with zero offsets (a lift for z-index): otherwise the same code. A negative margin moves
 * a block in the flow and is allowed on any element: what it reaches is judged by V2 / V4.
 * A cover that hides a link's middle from hit-testing: OVERLAP_LINK_COVERED.
 */
export const OVERLAP_SCRIPT = String.raw`(arg) => {
  const flat = (s) => (s || "").replace(/\s+/g, "");
  // the names of the top-level functions of a computed value: "drop-shadow(rgba(0, 0, 0, 0.6) 0px 26px 6px) blur(2px)"
  // gives ["drop-shadow", "blur"]; anything that is not a function at depth 0 (url(), a bare word) gives "?"
  const topLevelFns = (v) => {
    const out = [];
    let depth = 0, word = "";
    for (const ch of v) {
      if (ch === "(") { if (depth === 0) out.push(word.trim().toLowerCase() || "?"); depth += 1; word = ""; }
      else if (ch === ")") { depth -= 1; word = ""; }
      else if (depth === 0) { if (/\s/.test(ch)) { if (word.trim()) { out.push("?"); } word = ""; } else word += ch; }
    }
    if (word.trim()) out.push("?");
    return out;
  };
  const canvas = document.createElement("canvas");
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const colours = new Map();
  const rgba = (css) => {
    let c = colours.get(css);
    if (!c) { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0, 0, 0, 0)"; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); c = ctx.getImageData(0, 0, 1, 1).data; colours.set(css, c); }
    return c;
  };
  const st = new Map();
  const cs = (el) => { let s = st.get(el); if (!s) { s = getComputedStyle(el); st.set(el, s); } return s; };
  scrollTo(0, 0);
  // page coordinates at the current scroll (the hit-tests below scroll the window)
  const doc = (r) => ({ left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY });
  const grow = (r, d) => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });
  const cut = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const meets = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const inside = (inner, outer) => inner.left >= outer.left - 0.01 && inner.right <= outer.right + 0.01 && inner.top >= outer.top - 0.01 && inner.bottom <= outer.bottom + 0.01;
  const SVGNS = "http://www.w3.org/2000/svg";
  const isSvg = (el) => el.namespaceURI === SVGNS;
  const codes = {};
  const add = (c, n) => { codes[c] = (codes[c] || 0) + (n || 1); };
  const found = [];
  // page-level findings as instances ("what :: code"), so that two pages compare instance by instance (re-review 3 L4)
  const pageInst = [];
  const desc = (el) => el.tagName.toLowerCase() + (el.getAttribute("class") ? "." + el.getAttribute("class").split(/\s+/).join(".") : "") + ":" + flat(el.textContent).slice(0, 12);
  // per text (index in the returned glyph list): the codes that name it, for comparing with the pixel pass text by text
  const byText = new Map();
  const mark = (t, c) => { if (!byText.has(t)) byText.set(t, new Set()); byText.get(t).add(c); };
  const note = (code, t, p) => { if (arg.detail && found.length < 40) found.push({ code, text: flat(t.el.textContent).slice(0, 16), painter: p ? (p.el.tagName.toLowerCase() + (p.el.getAttribute("class") ? "." + p.el.getAttribute("class").split(/\s+/).join(".") : "") + ":" + p.kind) : "" }); };

  // ------------------------------------------------------------ text and glyph boxes
  // a text node in a protected occurrence split over elements (DEV-175 re-review 4 H1)
  const factNodes = (${FACT_NODES_JS})(arg.protect);
  const protectedEl = (el) => {
    if (el.closest(arg.protectSel)) return true;
    const whole = flat(el.textContent);
    if (!whole) return false;
    return arg.protect.some((f) => f && (whole.includes(f) || (whole.length >= 6 && f.includes(whole))));
  };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!flat(n.data)) continue;
    const el = n.parentElement;
    if (!el || el.closest("style, script, title, defs")) continue;
    const s = cs(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5).map(doc);
    const prot = protectedEl(el) || factNodes.has(n);
    const t = { el, node: n, prot, lines, g: null, fs: parseFloat(s.fontSize) || 16, vertical: s.writingMode !== "horizontal-tb", font: [s.fontStyle, s.fontWeight, s.fontSize, s.fontFamily].join(" ") };
    // canvas measureText draws the default glyph of each character alone: OpenType features (tabular figures,
    // alternates, East Asian forms) and combining marks are drawn otherwise in the page (DEV-173 re-review M1), and a
    // line decoration (underline …) or a list marker is ink outside every glyph (L2). The boxes are then not the ink:
    // GLYPHS_UNMEASURED (fail closed)
    const featured = [s.fontVariantNumeric, s.fontFeatureSettings, s.fontVariantEastAsian, s.fontVariantAlternates, s.fontVariantLigatures, s.fontVariantCaps, s.fontVariantPosition, s.fontVariationSettings].some((v) => v && v !== "normal");
    let deco = false;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const as = cs(a); if (as.textDecorationLine && as.textDecorationLine !== "none") { deco = true; break; } }
    if (featured || deco || /\p{M}/u.test(n.data)) t.unmeasured = true;
    if (!lines.length) { if (prot) { add("OVERLAP_PROTECTED_HIDDEN"); note("OVERLAP_PROTECTED_HIDDEN", t, null); pageInst.push(flat(n.data).slice(0, 24) + " :: OVERLAP_PROTECTED_HIDDEN"); } continue; }
    // text drawn wider than its glyphs: stroke and shadow
    const stroke = parseFloat(s.webkitTextStrokeWidth) || 0;
    let shadow = 0;
    if (s.textShadow && s.textShadow !== "none") for (const part of s.textShadow.split(/,(?![^(]*\))/)) { const nums = (part.replace(/rgba?\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat); shadow = Math.max(shadow, Math.abs(nums[0] || 0) + Math.abs(nums[1] || 0) + 3 * Math.max(0, nums[2] || 0)); }
    t.ink = stroke + shadow;
    texts.push(t);
  }
  // Ink boxes: the character's own ink from canvas measureText in the element's font (actualBoundingBox*, placed on the
  // baseline found from the Range rect's top + the font's ascent), grown by 1 px for antialiasing. They do not depend on
  // line-height or on the font's content area (DEV-173 CI: the Range rect, or a fixed share of the em, overstates the
  // ink under taller CJK metrics and made solid-set lines meet). Vertical text keeps the 1.3 em cut of the Range rect.
  const inks = new Map();
  const inkOf = (font, ch) => {
    const key = font + "\u0000" + ch;
    let m = inks.get(key);
    if (!m) { ctx.font = font; const x = ctx.measureText(ch); m = { l: x.actualBoundingBoxLeft, r: x.actualBoundingBoxRight, a: x.actualBoundingBoxAscent, d: x.actualBoundingBoxDescent, fa: x.fontBoundingBoxAscent }; inks.set(key, m); }
    return m;
  };
  // glyph boxes, computed only for the texts something comes near (and for every text when arg.glyphs)
  const glyphsOf = (t) => {
    if (t.g) return t.g;
    t.g = [];
    const range = document.createRange();
    const half = 0.65 * t.fs;
    const data = t.node.data;
    for (let i = 0; i < data.length && t.g.length < 600; i++) {
      const code = data.charCodeAt(i);
      const end = code >= 0xd800 && code <= 0xdbff && i + 1 < data.length ? i + 2 : i + 1;
      const ch = data.slice(i, end);
      const start = i;
      i = end - 1;
      if (/\s/.test(ch)) continue;
      range.setStart(t.node, start);
      range.setEnd(t.node, end);
      for (const r0 of Array.from(range.getClientRects())) {
        if (r0.width <= 0.5 || r0.height <= 0.5) continue;
        const r = doc(r0);
        if (t.vertical) {
          // a vertical character box shorter than half an em along the column does not hold its glyph (seen: a vertical
          // name in a Latin primary face with a CJK fallback, its last character's Range rect 5 px tall while its ink is
          // drawn a full em below): the text's glyphs are unmeasured, failed closed after the loop
          // legitimately short along the column: ASCII set sideways (its advance is its width) and the small CJK
          // punctuation; not full-width Latin or digits, half-width kana, 〇 or 々 (re-review 3 L5)
          if (r.bottom - r.top < 0.5 * t.fs && !/^[\x21-\x7e]$|^[、。，．・：；！？]$/.test(ch)) t.unmeasured = true;
          const c = (r.left + r.right) / 2;
          t.g.push({ left: Math.max(r.left, c - half), right: Math.min(r.right, c + half), top: r.top, bottom: r.bottom });
          continue;
        }
        const m = inkOf(t.font, ch);
        const base = r.top + m.fa;
        const g = { left: r.left - m.l - 1, right: r.left + m.r + 1, top: base - m.a - 1, bottom: base + m.d + 1 };
        if (g.right - g.left > 0.5 && g.bottom - g.top > 0.5) t.g.push(g);
      }
    }
    return t.g;
  };
  const lineUnion = (t) => t.lines.reduce((u, r) => (u ? { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) } : r), null);

  // ------------------------------------------------------------ painters
  const painters = [];
  const filterSpread = (f) => {
    if (!f || f === "none") return 0;
    let spread = 0;
    const fns = f.match(/[a-z-]+\([^()]*(\([^()]*\)[^()]*)*\)/g) || [];
    for (const fn of fns) {
      const name = fn.slice(0, fn.indexOf("("));
      const nums = (fn.replace(/rgba?\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
      if (name === "blur") spread = Math.max(spread, 3 * (nums[0] || 0));
      else if (name === "drop-shadow") spread = Math.max(spread, Math.abs(nums[0] || 0) + Math.abs(nums[1] || 0) + 3 * Math.max(0, nums[2] || 0));
      else if (!["brightness", "contrast", "grayscale", "sepia", "saturate", "invert", "opacity", "hue-rotate"].includes(name)) spread = 1e5;
    }
    return spread;
  };
  const shadowOut = (s) => {
    if (!s.boxShadow || s.boxShadow === "none") return 0;
    let out = 0;
    for (const part of s.boxShadow.split(/,(?![^(]*\))/)) {
      if (/\binset\b/.test(part)) continue;
      const nums = (part.replace(/rgba?\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
      out = Math.max(out, Math.max(Math.abs(nums[0] || 0), Math.abs(nums[1] || 0)) + Math.max(0, nums[2] || 0) + Math.max(0, nums[3] || 0));
    }
    return out;
  };
  const ring = (o, i) => [{ left: o.left, top: o.top, right: o.right, bottom: i.top }, { left: o.left, top: i.bottom, right: o.right, bottom: o.bottom }, { left: o.left, top: i.top, right: i.left, bottom: i.bottom }, { left: i.right, top: i.top, right: o.right, bottom: i.bottom }].filter((r) => r.right - r.left > 0 && r.bottom - r.top > 0);
  const SHAPES = ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "use", "image"];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (el.closest("defs, style, script, clipPath, mask, pattern, marker, symbol, linearGradient, radialGradient, filter")) continue;
    const s = cs(el);
    if (s.display === "none") continue;
    const r = doc(el.getBoundingClientRect());
    if (r.right - r.left <= 0 && r.bottom - r.top <= 0) continue;
    const visible = s.visibility !== "hidden";
    const add2 = (kind, rects, hit) => { if (rects.length) painters.push({ el, kind, rects, hit }); };
    const spread = filterSpread(s.filter);
    const reflect = s.webkitBoxReflect && s.webkitBoxReflect !== "none";
    const transformed = s.transform && s.transform !== "none";
    if (isSvg(el)) {
      if (!visible || !SHAPES.includes(el.tagName.toLowerCase())) { if (spread > 0 && el.tagName.toLowerCase() === "svg") add2("filter", [grow(r, spread)], false); continue; }
      const paints = (s.fill && s.fill !== "none" && rgba(s.fill === "currentcolor" ? s.color : s.fill.startsWith("url(") ? "#000" : s.fill)[3] > 0) || (s.stroke && s.stroke !== "none" && (parseFloat(s.strokeWidth) || 0) > 0);
      if (!paints) continue;
      let scale = 1;
      try { const b = el.getBBox(); if (b.width > 0) scale = Math.max(scale, (r.right - r.left) / b.width); } catch (e) { scale = 1; }
      const sw = s.stroke && s.stroke !== "none" ? ((parseFloat(s.strokeWidth) || 0) * (s.vectorEffect === "non-scaling-stroke" ? 1 : scale)) / 2 + 1 : 1;
      add2("svg", [grow(r, sw)], true);
      if (spread > 0) add2("filter", [grow(r, sw + spread)], false);
      continue;
    }
    if (!visible) continue;
    const bg = rgba(s.backgroundColor)[3] > 0 || (s.backgroundImage && s.backgroundImage !== "none") || (s.boxShadow && /\binset\b/.test(s.boxShadow));
    if (bg || el.tagName === "IMG" || (s.mixBlendMode && s.mixBlendMode !== "normal") || (s.backdropFilter && s.backdropFilter !== "none")) add2(el.tagName === "IMG" ? "img" : "bg", [r], true);
    const bw = ["Top", "Right", "Bottom", "Left"].map((side) => (parseFloat(s["border" + side + "Width"]) > 0 && !["none", "hidden"].includes(s["border" + side + "Style"]) && rgba(s["border" + side + "Color"])[3] > 0 ? parseFloat(s["border" + side + "Width"]) : 0));
    if (!bg && bw.some((w) => w > 0)) {
      if (transformed) add2("border", [r], true);
      else add2("border", [{ left: r.left, top: r.top, right: r.right, bottom: r.top + bw[0] }, { left: r.right - bw[1], top: r.top, right: r.right, bottom: r.bottom }, { left: r.left, top: r.bottom - bw[2], right: r.right, bottom: r.bottom }, { left: r.left, top: r.top, right: r.left + bw[3], bottom: r.bottom }].filter((x) => x.right - x.left > 0 && x.bottom - x.top > 0), true);
    }
    const so = shadowOut(s);
    if (so > 0) add2("shadow", ring(grow(r, so), r), false);
    const ow = s.outlineStyle !== "none" && rgba(s.outlineColor)[3] > 0 ? parseFloat(s.outlineWidth) || 0 : 0;
    if (ow > 0) { const off = parseFloat(s.outlineOffset) || 0; add2("outline", ring(grow(r, off + ow), grow(r, Math.max(off, -1e6))), false); }
    // the whole box grown by the spread: a drop-shadow of one child falls inside the box too, under another child
    // (DEV-173 CI: tsugute C′'s board shadow under its own caption)
    if (spread > 0) add2("filter", [grow(r, spread)], false);
    if (reflect) add2("filter", [grow(r, 1e5)], false);
  }

  // ------------------------------------------------------------ hit-testing
  const pointerStyle = document.getElementById("ov-pointer");
  if (!pointerStyle) { const p = document.createElement("style"); p.id = "ov-pointer"; p.textContent = "*, *::before, *::after { pointer-events: auto !important; }"; document.head.appendChild(p); }
  const stackAt = (x, y) => {
    // x, y in page coordinates: scroll the point into the viewport
    const vy = y - scrollY;
    if (vy < 2 || vy > innerHeight - 2) scrollTo(0, Math.max(0, y - innerHeight / 2));
    const cx = x - scrollX, cy = y - scrollY;
    if (cx < 0 || cx >= innerWidth || cy < 0 || cy >= innerHeight) return null;
    return document.elementsFromPoint(cx, cy);
  };
  const samples = (I, fine) => {
    const w = I.right - I.left, h = I.bottom - I.top;
    const nx = Math.max(1, Math.min(fine ? 64 : 6, Math.ceil(w / (fine ? 1 : 2)))), ny = Math.max(1, Math.min(fine ? 64 : 6, Math.ceil(h / (fine ? 1 : 2))));
    const out = [];
    for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) out.push([I.left + ((a + 0.5) * w) / nx, I.top + ((b + 0.5) * h) / ny]);
    return out;
  };
  let hitTests = 0;
  const isAtomic = (el) => { const s = cs(el); const ps = el.parentElement ? cs(el.parentElement) : null; return s.position !== "static" || /^inline-(block|flex|grid|table)$/.test(s.display) || Boolean(ps && /(flex|grid)$/.test(ps.display)) || Number(s.opacity) < 1 || (s.transform && s.transform !== "none") || s.isolation === "isolate"; };
  const flatGround = (el) => { const s = cs(el); return rgba(s.backgroundColor)[3] === 255 && (!s.backgroundImage || s.backgroundImage === "none"); };
  const paddingBox = (el) => { const s = cs(el); const r = doc(el.getBoundingClientRect()); return { left: r.left + parseFloat(s.borderLeftWidth), top: r.top + parseFloat(s.borderTopWidth), right: r.right - parseFloat(s.borderRightWidth), bottom: r.bottom - parseFloat(s.borderBottomWidth) }; };
  const plates = (t) => {
    const out = [];
    for (let q = t.el; q && q !== document.body; q = q.parentElement) if (!isSvg(q) && flatGround(q)) out.push(q);
    return out;
  };
  // Paint order is an order of elements, not of points: once P and T are both hit at one point, their order holds
  // wherever both paint. So each pair is decided at the first sample point (over every glyph box it meets) where P is
  // hit; if P is hit nowhere (an SVG shape whose box meets the glyph but whose stroke does not), it is absent.
  // Where a thin or turned painter is drawn, before asking hit-testing (which is the costly call): an SVG shape answers
  // isPointInFill / isPointInStroke (a non-scaling stroke is given its screen width in user units for the question, then
  // put back); a box under a 2D transform answers by the inverse of its matrix. Anything else, or any doubt, is "maybe",
  // and hit-testing decides.
  const presenceOf = (p) => {
    const el = p.el;
    if (p.kind === "svg" && typeof el.isPointInStroke === "function") {
      const s = cs(el);
      const m = el.getScreenCTM();
      if (!m) return Object.assign(() => true, { done: () => {} });
      const scale = Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)) || 1;
      const fill = s.fill && s.fill !== "none";
      const stroke = s.stroke && s.stroke !== "none" && (parseFloat(s.strokeWidth) || 0) > 0;
      const swPx = (parseFloat(s.strokeWidth) || 0) * (s.vectorEffect === "non-scaling-stroke" ? 1 : scale);
      // the screen-width stroke is set once for the pair and put back by done()
      const saved = el.getAttribute("style");
      if (stroke) { el.style.setProperty("vector-effect", "none", "important"); el.style.setProperty("stroke-width", String(swPx / scale + 2 / scale), "important"); }
      const mm = el.getScreenCTM();
      const inv = mm ? mm.inverse() : null;
      const sx0 = scrollX, sy0 = scrollY;
      const test = (x, y) => {
        if (!inv) return true;
        const pt = new DOMPoint(x - sx0, y - sy0).matrixTransform(inv);
        return (fill && el.isPointInFill(pt)) || (stroke && el.isPointInStroke(pt));
      };
      test.done = () => { if (saved === null) el.removeAttribute("style"); else el.setAttribute("style", saved); };
      return test;
    }
    const s = cs(el);
    if (!isSvg(el) && s.transform && s.transform !== "none") {
      const maybe = Object.assign(() => true, { done: () => {} });
      for (let a = el.parentElement; a; a = a.parentElement) { const as = cs(a); if (as.transform && as.transform !== "none") return maybe; }
      let M;
      try { M = new DOMMatrix(s.transform); } catch (e) { return maybe; }
      if (!M.is2D) return maybe;
      const saved = el.getAttribute("style");
      el.style.setProperty("transform", "none", "important");
      const r0 = el.getBoundingClientRect();
      const box = { left: r0.left + scrollX, top: r0.top + scrollY, w: r0.width, h: r0.height };
      if (saved === null) el.removeAttribute("style"); else el.setAttribute("style", saved);
      const o = s.transformOrigin.split(" ").map(parseFloat);
      const inv = M.inverse();
      return Object.assign((x, y) => {
        const q = new DOMPoint(x - box.left - o[0], y - box.top - o[1]).matrixTransform(inv);
        const lx = q.x + o[0], ly = q.y + o[1];
        return lx >= -1 && ly >= -1 && lx <= box.w + 1 && ly <= box.h + 1;
      }, { done: () => {} });
    }
    return Object.assign(() => true, { done: () => {} });
  };
  // Paint order is an order of elements, not of points: once P and T are both hit at one point, their order holds
  // wherever both paint. So each pair is decided at the first sample point (over every glyph box it meets) where P is
  // hit; if P is hit nowhere (an SVG shape whose box meets the glyph but whose stroke does not), it is absent.
  let presenceTests = 0;
  const decide = (t, p, boxes) => {
    const fine = p.kind === "svg" || (cs(p.el).transform && cs(p.el).transform !== "none");
    const present = presenceOf(p);
    try {
    for (const I of boxes) {
      for (const [x, y] of samples(I, fine)) {
        presenceTests += 1;
        if (!present(x, y)) continue;
        const stack = stackAt(x, y);
        hitTests += 1;
        if (!stack) return { v: "unproven", stack: null };
        const ip = stack.indexOf(p.el);
        if (ip < 0) continue;
        const it = stack.indexOf(t.el);
        if (it < 0) return { v: "unproven", stack };
        return { v: ip < it ? "above" : "below", stack };
      }
    }
    } finally { present.done(); }
    return { v: "absent", stack: null };
  };
  // a plate: Q (T or an ancestor) with an opaque flat ground whose padding box holds every glyph box P meets, inside an
  // atomic A (Q or an ancestor of Q) that does not contain P and is hit above P
  const plated = (t, p, glyphs, stack) => {
    for (const q of plates(t)) {
      const box = paddingBox(q);
      if (!glyphs.every((g) => inside(g, box))) continue;
      for (let a = q; a && a !== document.body; a = a.parentElement) {
        if (!isAtomic(a) || a.contains(p.el)) continue;
        const ia = stack.indexOf(a);
        if (ia >= 0 && ia < stack.indexOf(p.el)) return true;
      }
    }
    return false;
  };

  // ------------------------------------------------------------ V2 / V4 per glyph
  let pairs = 0;
  // the cheap prefilters use the line boxes grown by a quarter em (ink can pass the content area: accents, swashes)
  const textPainters = texts.map((t) => ({ el: t.el, kind: "text", near: grow(lineUnion(t), t.ink + 1 + 0.25 * t.fs), t }));
  for (const t of texts) {
    const span = grow(lineUnion(t), (t.prot ? 1 : 0) + 0.25 * t.fs);
    if (t.vertical) glyphsOf(t);
    if (t.unmeasured) { const c = t.prot ? "OVERLAP_PROTECTED_GLYPHS_UNMEASURED" : "OVERLAP_GLYPHS_UNMEASURED"; add(c); note(c, t, null); mark(t, c); }
    const ancestors = new Set();
    for (let a = t.el.parentElement; a; a = a.parentElement) ancestors.add(a);
    const done = new Set();
    // text on text
    for (const u of textPainters) {
      // other text nodes, also under the same element (DEV-173 Fresh Review M1: an inline-block with a negative margin
      // lets a later run of the same paragraph print over an earlier one)
      if (u.t === t || u.t.node === t.node) continue;
      if (!meets(u.near, span)) continue;
      // ink against ink, without the 1 px antialias growth on either side: two runs of one line set next to each other
      // (a <wbr> splits a text node) touch at their advance edges and must not count
      const ug = glyphsOf(u.t).map((g) => grow(g, u.t.ink - 1));
      const hit = glyphsOf(t).some((g0) => { const g = grow(g0, -1); return ug.some((x) => meets(x, g)); });
      if (!hit) continue;
      const key = "t:" + texts.indexOf(u.t);
      if (done.has(key)) continue;
      done.add(key);
      // count each overlapping pair once (from the protected side if there is one)
      if (!t.prot && u.t.prot) continue;
      if (t.prot === u.t.prot && texts.indexOf(u.t) < texts.indexOf(t)) continue;
      const code = t.prot || u.t.prot ? "OVERLAP_PROTECTED_TEXT_ON_TEXT" : "OVERLAP_TEXT_ON_TEXT";
      add(code); note(code, t, u); mark(t, code); mark(u.t, code);
    }
    // DEV-173 Fresh Review M2: an ancestor's border, background image or inset shadow is not "the text's own flat ground":
    // a text pulled over its container's border (a negative margin) has the border run under its glyphs
    const ancestorUnder = (p) => p.kind === "border" || p.kind === "filter" || (p.kind === "bg" && ((cs(p.el).backgroundImage || "none") !== "none" || /\binset\b/.test(cs(p.el).boxShadow || "")));
    // a filter on the text's own element or an ancestor that is not only drop-shadow changes the text's own pixels (blur,
    // opacity(), brightness() …): the text is not drawn as measured (re-review 3 L1)
    // body, html and SVG ancestors too (re-review 4 L1-b); only the top-level function names count, so the rgba() inside
    // a computed drop-shadow(rgba(…) …) is not read as a filter of its own (L1-a)
    for (const a of [t.el].concat(Array.from(ancestors))) {
      const f = cs(a).filter;
      if (f && f !== "none" && topLevelFns(f).some((fn) => fn !== "drop-shadow")) { const c = t.prot ? "OVERLAP_PROTECTED_TEXT_FILTERED" : "OVERLAP_TEXT_FILTERED"; add(c); note(c, t, null); mark(t, c); break; }
    }
    for (const p of painters) {
      // the text's own element: its ground and borders are below its text by definition; but a filter on it draws one
      // painting child's shadow under the text (re-review 3 M1) — fail closed when the element has painting children
      if (p.el === t.el && !(p.kind === "filter" && painters.some((q) => q.el !== t.el && q.kind !== "filter" && q.kind !== "text" && t.el.contains(q.el)))) continue;
      const anc = ancestors.has(p.el);
      if (anc && p.kind !== "outline" && !(ancestorUnder(p) && (t.prot || arg.ordinary === "plate"))) continue;
      if (!p.rects.some((x) => meets(x, span))) continue;
      pairs += 1;
      const met = [];
      const boxes = [];
      for (const g0 of glyphsOf(t)) {
        const G = t.prot ? grow(g0, 1) : g0;
        let hitG = false;
        for (const x of p.rects) if (meets(x, G)) { boxes.push(cut(x, G)); hitG = true; }
        if (hitG) met.push(G);
      }
      if (!met.length) continue;
      let worst = null;
      if (!p.hit) worst = "unproven";
      else if (anc) {
        // below by definition (an ancestor paints its ground and borders before its content); passes only on a plate
        // that is a descendant of the ancestor (painted after it in tree order) and holds every glyph box it meets
        const descendantPlate = plates(t).some((q) => q !== p.el && p.el.contains(q) && met.every((g) => inside(g, paddingBox(q))));
        if (!descendantPlate) worst = "under";
      } else {
        const d = decide(t, p, boxes);
        if (d.v === "above" || d.v === "unproven") worst = d.v;
        else if (d.v === "below" && (t.prot || arg.ordinary === "plate") && !plated(t, p, met, d.stack)) worst = "under";
      }
      if (!worst) continue;
      const code = worst === "above" ? (t.prot ? "OVERLAP_PAINT_ABOVE_PROTECTED" : "OVERLAP_PAINT_ABOVE_TEXT") : worst === "unproven" ? (t.prot ? "OVERLAP_PROTECTED_ORDER_UNPROVEN" : "OVERLAP_ORDER_UNPROVEN") : t.prot ? "OVERLAP_PROTECTED_ON_DECORATION" : "OVERLAP_TEXT_ON_DECORATION";
      add(code); note(code, t, p); mark(t, code);
    }
    // V4: clipping and placement of protected glyphs; clipping of ordinary text too (DEV-173 Fresh Review L3: the proposed
    // grammar admits overflow: hidden / clip on any element)
    {
      const W = arg.vw || document.documentElement.clientWidth;
      // line boxes first (cheap); glyph boxes only where a line box fails
      const off = (g) => g.left < -0.5 || g.right > W + 0.5 || g.top < -0.5;
      if (t.prot && t.lines.some(off) && glyphsOf(t).some(off)) { add("OVERLAP_PROTECTED_OFFSCREEN"); note("OVERLAP_PROTECTED_OFFSCREEN", t, null); mark(t, "OVERLAP_PROTECTED_OFFSCREEN"); }
      let clipped = false;
      for (const a of ancestors) {
        if (a === document.documentElement || a === document.body) continue;
        const s = cs(a);
        if ((s.clipPath && s.clipPath !== "none") || (s.maskImage && s.maskImage !== "none") || (s.webkitMaskImage && s.webkitMaskImage !== "none")) { clipped = true; break; }
        if (s.overflowX !== "visible" || s.overflowY !== "visible" || /paint|strict|content/.test(s.contain || "")) {
          const box = paddingBox(a);
          if (t.lines.some((g) => !inside(g, box)) && glyphsOf(t).some((g) => !inside(g, box))) { clipped = true; break; }
        }
      }
      if (clipped) { const c = t.prot ? "OVERLAP_PROTECTED_CLIPPED" : "OVERLAP_TEXT_CLIPPED"; add(c); note(c, t, null); mark(t, c); }
    }
  }

  // list markers are drawn text the walker does not see (DEV-173 re-review L2): any visible marker fails closed
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const s = cs(el);
    if (s.display === "list-item" && s.visibility !== "hidden" && (s.listStyleType !== "none" || (s.listStyleImage && s.listStyleImage !== "none"))) { add("OVERLAP_MARKER_UNMEASURED"); pageInst.push(desc(el) + " :: OVERLAP_MARKER_UNMEASURED"); }
  }

  // ------------------------------------------------------------ the grammar's roles
  if (arg.grammar) {
    const textInside = (el) => Boolean(flat(el.textContent)) || [el].concat(Array.from(el.querySelectorAll("*"))).some((d) => (d.getAttribute("aria-label") || "").trim() || (d.getAttribute("alt") || "").trim());
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (isSvg(el) || el.hasAttribute("data-ov-pseudo")) continue;
      const s = cs(el);
      // a negative margin moves a block in the flow (and its text with it): allowed on content; V2 / V4 judge what it reaches
      const layer = ["absolute", "fixed", "sticky"].includes(s.position) || (s.transform && s.transform !== "none") || (s.zIndex !== "auto" && parseInt(s.zIndex, 10) < 0);
      const moved = s.position === "relative" && ["top", "right", "bottom", "left"].some((k) => s[k] !== "auto" && parseFloat(s[k]) !== 0);
      if ((layer || moved) && textInside(el)) { add("OVERLAP_LAYER_HAS_TEXT"); pageInst.push(desc(el) + " :: OVERLAP_LAYER_HAS_TEXT"); if (arg.detail && found.length < 40) found.push({ code: "OVERLAP_LAYER_HAS_TEXT", text: flat(el.textContent).slice(0, 16), painter: el.tagName.toLowerCase() + "." + (el.getAttribute("class") || "") }); }
    }
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const stack = stackAt(r.left + scrollX + r.width / 2, r.top + scrollY + r.height / 2);
      if (stack && stack[0] !== a && !a.contains(stack[0])) { add("OVERLAP_LINK_COVERED"); pageInst.push(desc(a) + " :: OVERLAP_LINK_COVERED"); }
    }
  }
  scrollTo(0, 0);
  // every finding per text instance (text and code), for comparing two pages text by text (DEV-173 re-review L1)
  const perText = [];
  texts.forEach((t) => { for (const c of byText.get(t) || []) perText.push(flat(t.node.data).slice(0, 24) + " :: " + c); });
  const out = { perText: perText.sort(), pageInst: pageInst.sort(), codes, texts: texts.length, protectedTexts: texts.filter((t) => t.prot).length, painters: painters.length, pairs, hitTests, presenceTests };
  if (arg.detail) out.found = found;
  if (arg.glyphs) texts.forEach((t, i) => t.el.setAttribute("data-ov-t", ((t.el.getAttribute("data-ov-t") || "") + " " + i).trim()));
  if (arg.glyphs) out.glyphs = texts.map((t) => ({ prot: t.prot, text: flat(t.node.data).slice(0, 16), rects: glyphsOf(t), codes: Array.from(byText.get(t) || []).sort() }));
  return out;
}`;

/**
 * Replaces every generated ::before / ::after by a real span carrying its computed style (content: a string becomes the
 * span's text; "" an empty span), and hides the pseudo-element itself. On a throwaway page only. The pseudo-element then
 * has a box, a hit-test target and a place in the paint order like any element. Calling it again first undoes the last
 * call (the media rules may differ at the next width). Returns the number materialized and the number it could not
 * (content other than a string: counters, attr(), url(): returned as `unknown`, which the check fails).
 */
export const MATERIALIZE_SCRIPT = String.raw`() => {
  for (const n of Array.from(document.querySelectorAll("[data-ov-pseudo]"))) n.remove();
  for (const e of Array.from(document.querySelectorAll("[data-ov-host]"))) e.removeAttribute("data-ov-host");
  const old = document.getElementById("ov-hide");
  if (old) old.remove();
  const found = [];
  let unknown = 0;
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (el.namespaceURI === "http://www.w3.org/2000/svg") continue;
    for (const p of ["::before", "::after"]) {
      const s = getComputedStyle(el, p);
      const c = s.content;
      if (!c || c === "none" || c === "normal" || s.display === "none") continue;
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(c);
      if (!m) { unknown += 1; continue; }
      const props = {};
      for (let i = 0; i < s.length; i++) { const k = s[i]; if (k === "content" || k.startsWith("--")) continue; props[k] = s.getPropertyValue(k); }
      found.push({ el, p, props, text: m[1] });
    }
  }
  const hide = document.createElement("style");
  hide.id = "ov-hide";
  hide.textContent = '[data-ov-host~="b"]::before, [data-ov-host~="a"]::after { content: none !important; }';
  document.head.appendChild(hide);
  for (const f of found) {
    const span = document.createElement("span");
    span.setAttribute("data-ov-pseudo", f.p);
    span.setAttribute("aria-hidden", "true");
    let css = "";
    for (const k in f.props) css += k + ":" + f.props[k] + " !important;";
    span.style.cssText = css;
    if (f.text) span.textContent = f.text;
    f.el.setAttribute("data-ov-host", ((f.el.getAttribute("data-ov-host") || "") + " " + (f.p === "::before" ? "b" : "a")).trim());
    if (f.p === "::before") f.el.insertBefore(span, f.el.firstChild);
    else f.el.appendChild(span);
  }
  return { materialized: found.length, unknown };
}`;

/** Undoes MATERIALIZE_SCRIPT (the pseudo-elements are drawn again by the page's own stylesheet). */
export const UNMATERIALIZE = `(() => { for (const n of Array.from(document.querySelectorAll("[data-ov-pseudo]"))) n.remove(); for (const e of Array.from(document.querySelectorAll("[data-ov-host]"))) e.removeAttribute("data-ov-host"); document.getElementById("ov-hide")?.remove(); })()`;

export type OverlapPlan = {
  protect: readonly string[];
  protectSel?: string;
  ordinary?: "plate" | "allow";
  grammar?: boolean;
};
export type OverlapScan = {
  perText: string[];
  pageInst: string[];
  codes: Record<string, number>;
  texts: number;
  protectedTexts: number;
  painters: number;
  pairs: number;
  hitTests: number;
  presenceTests: number;
  materialized: number;
  found?: Array<{ code: string; text: string; painter: string }>;
  glyphs?: Array<{ prot: boolean; text: string; rects: Array<{ left: number; top: number; right: number; bottom: number }>; codes: string[] }>;
};
export const PROTECT_SEL = "dt, dd, h1, [data-comp-disclosure], .fictional";

/** The phase C scan of a page at its current viewport: materializes pseudo-elements, then runs OVERLAP_SCRIPT. */
export async function overlapScan(page: Page, plan: OverlapPlan, o: { detail?: boolean; glyphs?: boolean; vw?: number } = {}): Promise<OverlapScan> {
  const m = (await page.evaluate(`(${MATERIALIZE_SCRIPT})()`)) as { materialized: number; unknown: number };
  const arg = { protect: plan.protect.map((s) => s.replace(/\s+/g, "")), protectSel: plan.protectSel ?? PROTECT_SEL, ordinary: plan.ordinary ?? "plate", grammar: plan.grammar === true, detail: o.detail === true, glyphs: o.glyphs === true, vw: o.vw ?? 0 };
  const r = (await page.evaluate(`(${OVERLAP_SCRIPT})(${JSON.stringify(arg)})`)) as Omit<OverlapScan, "materialized">;
  if (m.unknown > 0) r.codes.OVERLAP_PSEUDO_UNPROVEN = m.unknown;
  return { ...r, materialized: m.materialized };
}

/**
 * The findings of a scan as instances: every "text :: code" pair, plus the page-level codes that name no text
 * (markers, pseudo-elements, links, layer roles). Two pages are compared with this, not with code names only.
 */
export const instanceCodes = (s: Pick<OverlapScan, "codes" | "perText" | "pageInst">): string[] => {
  const named = new Set([...s.perText, ...s.pageInst].map((x) => x.split(" :: ")[1]));
  // a code that no instance names (OVERLAP_PSEUDO_UNPROVEN, counted in TS) is kept with its count
  return [...s.perText, ...s.pageInst, ...Object.keys(s.codes).filter((c) => !named.has(c)).map((c) => `(page ×${s.codes[c]}) :: ${c}`)].sort();
};

/** The codes of a scan, sorted. */
export const overlapCodes = (s: Pick<OverlapScan, "codes">): string[] => Object.keys(s.codes).sort();

// ---------------------------------------------------------------- the pixel pass (checked widths only)

const TEXT_INK = (c: string) =>
  `[data-ov-text] { color: ${c} !important; -webkit-text-fill-color: ${c} !important; fill: ${c} !important; -webkit-text-stroke-width: 0 !important; text-shadow: none !important; }`;
const STRIP =
  "*::before, *::after { visibility: hidden !important; } * { background: none !important; border-color: transparent !important; box-shadow: none !important; outline-color: transparent !important; backdrop-filter: none !important; mix-blend-mode: normal !important; } img, svg :not(text):not(tspan) { visibility: hidden !important; }";
const PROT_HIDDEN = "[data-ov-prot] { color: transparent !important; -webkit-text-fill-color: transparent !important; fill: transparent !important; -webkit-text-stroke-width: 0 !important; text-shadow: none !important; }";

type Raw = { data: Buffer; width: number; height: number };
async function shot(page: Page, css: string): Promise<Raw> {
  await page.evaluate(`(() => { const s = document.getElementById("ov-shot") || Object.assign(document.createElement("style"), { id: "ov-shot" }); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
  const png = await page.screenshot({ fullPage: true, animations: "disabled" });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The least share of a glyph pixel's ink that must reach the screen (3 channels, rounding ≤ ~1.6% at half coverage). */
export const PIXEL_TRANSMITTANCE_MIN = 0.97;

/**
 * disagreements: texts the pixel pass sees covered (2+ pixels under PIXEL_TRANSMITTANCE_MIN) for which the geometric check
 * names that same text with no code that could mean a cover (paint above, order unproven, text on text). Must be empty.
 */
export type PixelResult = { codes: Record<string, number>; glyphs: number; inkPixels: number; coveredPixels: number; worstTransmittance: number; worstGroundDev: number; ms: number; coveredTexts: string[]; unconfirmed: string[]; disagreements: string[]; lowest: Array<{ text: string; min: number; bad: number }>; inkOutside: number; inkOutsideSpots: string[] };

/**
 * The pixel pass at the current viewport (the page as opened; JavaScript is off, page.evaluate still runs):
 *  - ink transmittance: every text drawn black (A1) and white (A2), on the page as it is and on a reference (R1, R2) where
 *    nothing but text paints. Compositing is linear, so on any ground the difference A1 − A2 is the ink's coverage times
 *    whatever is painted above it lets through, and R1 − R2 is the coverage alone. Inside each glyph box, at every pixel
 *    the ink covers at least half (R1 − R2 ≥ 128), the ratio must be ≥ PIXEL_TRANSMITTANCE_MIN (0.97): PIXEL_COVER_PROTECTED / PIXEL_COVER_TEXT
 *    (2 pixels or more). Text on text is not seen here (both texts change together): the geometric check owns it.
 *  - V4 / V3b on protected text: the page with protected text transparent; inside each protected glyph box grown by 1 px the
 *    ground must be flat (lib verify.ts groundStructure, max channel deviation ≤ GROUND_FLAT_TOLERANCE):
 *    PIXEL_PROTECTED_GROUND_NOT_FLAT.
 * Five full-page screenshots.
 */
export async function pixelPass(page: Page, plan: OverlapPlan): Promise<PixelResult> {
  const t0 = Date.now();
  const scan = await overlapScan(page, plan, { glyphs: true });
  // the shots are taken of the real pseudo-elements (a materialized span carries its style inline and !important)
  await page.evaluate(UNMATERIALIZE);
  await page.evaluate(`((sel, protect) => {
    const flat = (s) => (s || "").replace(/\\s+/g, "");
    const factNodes = (${FACT_NODES_JS})(protect);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!flat(n.data) || !n.parentElement) continue;
      const el = n.parentElement;
      el.setAttribute("data-ov-text", "");
      const whole = flat(el.textContent);
      if (el.closest(sel) || factNodes.has(n) || protect.some((f) => whole.includes(f) || (whole.length >= 6 && f.includes(whole)))) el.setAttribute("data-ov-prot", "");
    }
  })(${JSON.stringify(plan.protectSel ?? PROTECT_SEL)}, ${JSON.stringify(plan.protect.map((s) => s.replace(/\s+/g, "")))})`);
  const a1 = await shot(page, TEXT_INK("#000"));
  const a2 = await shot(page, TEXT_INK("#fff"));
  const r1 = await shot(page, `${TEXT_INK("#000")} ${STRIP}`);
  const r2 = await shot(page, `${TEXT_INK("#fff")} ${STRIP}`);
  const h = await shot(page, PROT_HIDDEN);
  await page.evaluate(`document.getElementById("ov-shot")?.remove()`);
  const codes: Record<string, number> = {};
  let ink = 0;
  let covered = 0;
  let worst = 1;
  let worstDev = 0;
  const same = [a2, r1, r2, h].every((x) => x.width === a1.width && x.height === a1.height);
  if (!same) return { codes: { PIXEL_UNMEASURED: 1 }, glyphs: 0, inkPixels: 0, coveredPixels: 0, worstTransmittance: 0, worstGroundDev: 0, ms: Date.now() - t0, coveredTexts: [], unconfirmed: [], disagreements: [], lowest: [], inkOutside: 0, inkOutsideSpots: [] };
  const coveredTexts: string[] = [];
  const unconfirmed: string[] = [];
  const unconfirmedIdx: number[] = [];
  const confirmedIdx: number[] = [];
  const lowest: Array<{ text: string; min: number; bad: number }> = [];
  const disagreements: string[] = [];
  const W = a1.width;
  const H = a1.height;
  const candidates: number[] = [];
  for (const [ti, t] of (scan.glyphs ?? []).entries()) {
    let bad = 0;
    let tmin = 1;
    for (const g of t.rects) {
      const x0 = Math.max(0, Math.floor(g.left)), x1 = Math.min(W, Math.ceil(g.right)), y0 = Math.max(0, Math.floor(g.top)), y1 = Math.min(H, Math.ceil(g.bottom));
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 3;
          let dRef = 0;
          let dPage = 0;
          for (let c = 0; c < 3; c++) {
            dRef += r2.data[i + c]! - r1.data[i + c]!;
            dPage += a2.data[i + c]! - a1.data[i + c]!;
          }
          if (dRef < 3 * 128) continue;
          ink += 1;
          const tr = dPage / dRef;
          if (tr < worst) worst = tr;
          if (tr < tmin) tmin = tr;
          if (tr < PIXEL_TRANSMITTANCE_MIN) bad += 1;
        }
    }
    covered += bad;
    lowest.push({ text: t.text, min: tmin, bad });
    if (bad >= 2) candidates.push(ti);
    if (t.prot && t.rects.length) {
      // groundStructure grows each box by 1 px itself (V3b's convention)
      const boxes = t.rects.map((g) => ({ left: g.left, top: g.top, width: g.right - g.left, height: g.bottom - g.top }));
      const gs = groundStructure({ width: W, height: H, channels: 3, data: h.data }, boxes);
      if (gs.maxDev > worstDev) worstDev = gs.maxDev;
      if (gs.maxDev > GROUND_FLAT_TOLERANCE) codes.PIXEL_PROTECTED_GROUND_NOT_FLAT = (codes.PIXEL_PROTECTED_GROUND_NOT_FLAT ?? 0) + 1;
    }
  }
  // Confirmation in isolation (DEV-173 CI): every text recoloured at once means a glyph box can also hold another
  // text's ink (a vertical word whose own boxes missed it), and that ink's cover is then blamed on this text. Each
  // candidate is measured again with only its own element recoloured (the others keep their colours, so they cancel in
  // the difference), on a clip around its glyph boxes. Only a confirmed cover counts.
  for (const ti of candidates) {
    const t = scan.glyphs![ti]!;
    const u = t.rects.reduce((a, g) => ({ left: Math.min(a.left, g.left), top: Math.min(a.top, g.top), right: Math.max(a.right, g.right), bottom: Math.max(a.bottom, g.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const clip = { x: Math.max(0, Math.floor(u.left) - 2), y: Math.max(0, Math.floor(u.top) - 2), width: 0, height: 0 };
    clip.width = Math.min(W, Math.ceil(u.right) + 2) - clip.x;
    clip.height = Math.min(H, Math.ceil(u.bottom) + 2) - clip.y;
    if (clip.width < 1 || clip.height < 1) continue;
    const ink1 = (c: string) => `[data-ov-t~="${ti}"] { color: ${c} !important; -webkit-text-fill-color: ${c} !important; fill: ${c} !important; -webkit-text-stroke-width: 0 !important; text-shadow: none !important; }`;
    const iso = async (css: string) => {
      await page.evaluate(`(() => { const s = document.getElementById("ov-shot") || Object.assign(document.createElement("style"), { id: "ov-shot" }); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
      const png = await page.screenshot({ fullPage: true, clip, animations: "disabled" });
      return (await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    };
    const p1 = await iso(ink1("#000"));
    const p2 = await iso(ink1("#fff"));
    const q1 = await iso(`${ink1("#000")} ${STRIP}`);
    const q2 = await iso(`${ink1("#fff")} ${STRIP}`);
    let bad = 0;
    for (const g of t.rects)
      for (let y = Math.max(clip.y, Math.floor(g.top)); y < Math.min(clip.y + clip.height, Math.ceil(g.bottom)); y++)
        for (let x = Math.max(clip.x, Math.floor(g.left)); x < Math.min(clip.x + clip.width, Math.ceil(g.right)); x++) {
          const i = ((y - clip.y) * clip.width + (x - clip.x)) * 3;
          const dRef = q2[i]! - q1[i]! + q2[i + 1]! - q1[i + 1]! + q2[i + 2]! - q1[i + 2]!;
          if (dRef < 3 * 128) continue;
          const dPage = p2[i]! - p1[i]! + p2[i + 1]! - p1[i + 1]! + p2[i + 2]! - p1[i + 2]!;
          if (dPage / dRef < PIXEL_TRANSMITTANCE_MIN) bad += 1;
        }
    if (bad < 2) { unconfirmedIdx.push(ti); unconfirmed.push(t.text); continue; }
    confirmedIdx.push(ti);
    codes[t.prot ? "PIXEL_COVER_PROTECTED" : "PIXEL_COVER_TEXT"] = (codes[t.prot ? "PIXEL_COVER_PROTECTED" : "PIXEL_COVER_TEXT"] ?? 0) + 1;
    coveredTexts.push(t.text);
    if (!t.codes.some((c) => /PAINT_ABOVE|ORDER_UNPROVEN|TEXT_ON_TEXT|GLYPHS_UNMEASURED/.test(c))) disagreements.push(`${t.text} [${t.codes.join(",")}]`);
  }
  await page.evaluate(`document.getElementById("ov-shot")?.remove()`);

  // A candidate the isolated measurement does not confirm saw a cover on ink that is not its own: another text's ink
  // inside its boxes. That is explained only if a confirmed text's boxes meet its boxes (the cover is reported there);
  // otherwise the covered ink belongs to a text whose boxes do not hold it, and nothing names the cover:
  // PIXEL_COVER_UNATTRIBUTED (fail closed, re-review 3 L2)
  const meet = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
  for (const ti of unconfirmedIdx) {
    const t = scan.glyphs![ti]!;
    const explained = confirmedIdx.some((ci) => scan.glyphs![ci]!.rects.some((r) => t.rects.some((g) => meet(r, g))));
    if (!explained) { codes.PIXEL_COVER_UNATTRIBUTED = (codes.PIXEL_COVER_UNATTRIBUTED ?? 0) + 1; disagreements.push(`${t.text} [unattributed cover]`); }
  }

  // The glyph boxes must hold the ink the page actually draws (DEV-173 CI: if they do not, every check above looks in
  // the wrong place). Every pixel the reference shows as text ink (≥ half coverage) must lie inside some glyph box
  // grown by 1 px; ink outside is PIXEL_INK_OUTSIDE_GLYPHS (fail closed), with the first spots for the report.
  const mask = new Uint8Array(W * H);
  for (const t of scan.glyphs ?? [])
    for (const g of t.rects)
      for (let y = Math.max(0, Math.floor(g.top) - 1); y < Math.min(H, Math.ceil(g.bottom) + 1); y++) mask.fill(1, y * W + Math.max(0, Math.floor(g.left) - 1), y * W + Math.min(W, Math.ceil(g.right) + 1));
  let outside = 0;
  const spots: string[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (mask[k]) continue;
      const i = k * 3;
      const dRef = r2.data[i]! - r1.data[i]! + r2.data[i + 1]! - r1.data[i + 1]! + r2.data[i + 2]! - r1.data[i + 2]!;
      if (dRef < 3 * 128) continue;
      outside += 1;
      if (spots.length < 24 && !spots.some((sp) => { const [sx, sy] = sp.split(",").map(Number); return Math.abs(sx! - x) < 40 && Math.abs(sy! - y) < 40; })) spots.push(`${x},${y}`);
    }
  if (outside >= 4) codes.PIXEL_INK_OUTSIDE_GLYPHS = outside;
  return { codes, inkOutside: outside, inkOutsideSpots: spots, glyphs: (scan.glyphs ?? []).reduce((n, t) => n + t.rects.length, 0), inkPixels: ink, coveredPixels: covered, worstTransmittance: worst, worstGroundDev: worstDev, ms: Date.now() - t0, coveredTexts, unconfirmed, disagreements, lowest: lowest.sort((a, b) => a.min - b.min).slice(0, 8) };
}

/**
 * Test-only: the same page with every family the shop pages name drawn from IPAGothic (src: local("IPAGothic"), a face
 * both this container and CI's Playwright fonts have). The text geometry is then the same on both machines, so a bound
 * on the strict pages' codes can be asserted that no installed-font difference moves (DEV-173 CI). Raw CSS (@font-face
 * is refused by the allowlist): for measuring only.
 */
export function withPinnedFonts(page: CompPage): CompPage {
  const faces = ["Noto Sans CJK JP", "IPAMincho", "IPA明朝", "IPAPMincho", "IPAGothic"].map((f) => `@font-face { font-family: "${f}"; src: local("IPAGothic"); }`).join("\n");
  return { ...page, css: `${faces}\n${page.css}` };
}

// ---------------------------------------------------------------- the 1px sweep

export type OverlapSweep = { failing: Array<{ w: number; codes: string[] }>; measured: number; ms: number; mode: "real" | "stepped" };
export type Opener = (b: Browser, p: CompPage, w: number) => Promise<{ page: Page; close: () => Promise<void> }>;

const STEP_ROOT = (w: number | null) =>
  w === null
    ? `document.documentElement.removeAttribute("style")`
    : `(() => { const h = document.documentElement.style; h.setProperty("width", "${w}px", "important"); h.setProperty("min-width", "0", "important"); h.setProperty("max-width", "none", "important"); h.setProperty("margin-left", "0", "important"); h.setProperty("margin-right", "0", "important"); })()`;

/**
 * The phase C scan at every integer width of [from, to]. One desktop context, height 900.
 * - "real": the viewport is resized at every width (any page; the C′ pages size in vw, so only this mode is valid for them).
 * - "stepped": for allowlisted pages (no viewport units, html without a box of its own, as lib render.ts protectedGeometryPass
 *   requires): the viewport is set to the end of each @media segment (lib render.ts mediaSegments) and the root's width
 *   stands in for the viewport inside it. The tests show both modes give the same codes on the shops' layer pages.
 */
export async function overlapSweep(browser: Browser, compPage: CompPage, plan: OverlapPlan, from: number, to: number, open: Opener, mode: "real" | "stepped" = "real"): Promise<OverlapSweep> {
  const t0 = Date.now();
  const o = await open(browser, compPage, to);
  const failing: Array<{ w: number; codes: string[] }> = [];
  let measured = 0;
  const one = async (w: number, vw?: number) => {
    const s = await overlapScan(o.page, plan, vw ? { vw } : {});
    measured += 1;
    const c = instanceCodes(s);
    if (c.length) failing.push({ w, codes: c });
  };
  try {
    if (mode === "real")
      for (let w = from; w <= to; w++) {
        await o.page.setViewportSize({ width: w, height: 900 });
        await one(w);
      }
    else
      for (const [a, b] of mediaSegments(compPage.css, from, to)) {
        await o.page.setViewportSize({ width: b, height: 900 });
        for (let w = a; w <= b; w++) {
          await o.page.evaluate(STEP_ROOT(w));
          await one(w, w);
        }
        await o.page.evaluate(STEP_ROOT(null));
      }
  } finally {
    await o.close();
  }
  return { failing, measured, ms: Date.now() - t0, mode };
}

/** Width ranges per code name from a sweep (instances folded by their code): { CODE: "320–340, 401" }. */
export function sweepRanges(s: OverlapSweep): Record<string, string> {
  const by = new Map<string, number[]>();
  for (const f of s.failing) for (const c of new Set(f.codes.map((x) => x.split(" :: ").pop()!))) by.set(c, [...(by.get(c) ?? []), f.w]);
  const out: Record<string, string> = {};
  for (const [c, ws] of [...by].sort()) {
    const parts: string[] = [];
    let a = ws[0]!;
    let b = a;
    for (const w of ws.slice(1)) {
      if (w === b + 1) b = w;
      else {
        parts.push(a === b ? `${a}` : `${a}–${b}`);
        a = b = w;
      }
    }
    parts.push(a === b ? `${a}` : `${a}–${b}`);
    out[c] = parts.join(", ");
  }
  return out;
}

// ---------------------------------------------------------------- the proposed grammar (prototype, wraps the production one)

export type LayeredCssOptions = PageCssOptions & { layeredDecoration?: boolean };
const LEN = /^-?(\d+(\.\d+)?|\.\d+)(px|rem|%)$/;
const lenIn = (v: string, maxPx: number) => {
  if (v === "0") return true;
  const m = LEN.exec(v);
  if (!m) return false;
  const n = Math.abs(parseFloat(v));
  return m[3] === "px" ? n <= maxPx : m[3] === "rem" ? n <= maxPx / 16 : n <= 100;
};
const ANGLE = /^-?(\d+(\.\d+)?|\.\d+)deg$/;
/** One declaration of the proposed `layered_decoration` grammar (docs/design/phase-c-design.md §4). */
export function layeredDecl(prop: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  const parts = v.split(/\s+/);
  switch (prop) {
    case "position":
      return v === "static" || v === "relative" || v === "absolute";
    case "top":
    case "right":
    case "bottom":
    case "left":
      return v === "auto" || lenIn(v, 2400);
    case "inset":
      return parts.length >= 1 && parts.length <= 4 && parts.every((p) => p === "auto" || lenIn(p, 2400));
    case "z-index":
      return v === "auto" || /^-?\d$/.test(v) && Number(v) >= -1 && Number(v) <= 9;
    case "isolation":
      return v === "isolate" || v === "auto";
    case "transform": {
      if (v === "none") return true;
      const fns = v.match(/[a-z]+\([^()]*\)/g) ?? [];
      if (fns.join(" ") !== v.replace(/\)\s+/g, ") ").trim() || fns.length > 3) return false;
      return fns.every((f) => {
        const name = f.slice(0, f.indexOf("("));
        const args = f.slice(f.indexOf("(") + 1, -1).split(",").map((x) => x.trim());
        if (name === "rotate") return args.length === 1 && ANGLE.test(args[0]!) && Math.abs(parseFloat(args[0]!)) <= 45;
        if (name === "translate") return args.length >= 1 && args.length <= 2 && args.every((a) => lenIn(a, 2400));
        if (name === "translatex" || name === "translatey") return args.length === 1 && lenIn(args[0]!, 2400);
        return false;
      });
    }
    case "transform-origin":
      return parts.length <= 2 && parts.every((p) => ["center", "top", "bottom", "left", "right"].includes(p) || lenIn(p, 2400));
    case "margin":
    case "margin-top":
    case "margin-right":
    case "margin-bottom":
    case "margin-left":
      return parts.length <= (prop === "margin" ? 4 : 1) && parts.every((p) => p === "auto" || lenIn(p, 400));
    case "overflow":
    case "overflow-x":
    case "overflow-y":
      return ["visible", "hidden", "clip"].includes(v);
    default:
      return false;
  }
}

/**
 * The stylesheet check with the proposed grammar (TEST-ONLY prototype): with layeredDecoration, every declaration
 * layeredDecl admits is taken out, and the rest goes to the production pageCssProblems with the other flags. Without
 * it, this is exactly pageCssProblems. (The real patch would add the same items to PAGE_PROPS behind the flag; the
 * design doc gives it. The split here is a plain scan of `prop: value;` pairs, enough for the hand-written research CSS.)
 */
export function layeredCssProblems(css: string, opts: LayeredCssOptions = {}): string[] {
  const { layeredDecoration, ...rest } = opts;
  if (!layeredDecoration) return pageCssProblems(css, rest);
  const kept = css.replace(/([{;]\s*)([-a-z]+)\s*:\s*([^;{}]*?)\s*(?=;|})/g, (all, lead: string, prop: string, value: string) => (layeredDecl(prop, value) ? lead : all));
  return pageCssProblems(kept.replace(/;\s*;/g, ";").replace(/{\s*;/g, "{"), rest);
}

// ---------------------------------------------------------------- the three shops

/** The plan for a shop: its facts and its name protected; ordinary text needs a plate over decoration. */
export function shopPlan(shop: ShopKey, o: Partial<OverlapPlan> = {}): OverlapPlan {
  const { name, facts } = shopFacts(shop);
  return { protect: [name, ...Object.values(facts).filter((v) => v.length >= 2 && !/^[a-z_]+$/.test(v))], ordinary: "plate", ...o };
}

const files = (dir: string) => {
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "assets")).filter((f) => f.endsWith(".png"));
  } catch {
    names = [];
  }
  return new Map(names.map((f) => [`assets/${f}`, readFileSync(join(dir, "assets", f))]));
};

/**
 * The page variants.
 * - strict: the strict B page as merged (DEV-170's table).
 * - layer: the strict B page plus decoration layers written in the proposed grammar only (layeredDecl), on text-free
 *   elements added with aria-hidden (the allowlist's div), and lifts (position: relative; z-index) on text blocks:
 *   tsugute: a gold crack drawn over each board's image, the seam crossing the three bands of 線の断面;
 *   bicycle: four spokes reaching from the hero down into the spokes section, under the stations (SP: one spoke down the
 *     left edge of the stations), and the pump gauge hanging over the lesson section's top edge;
 *   sento: a thermometer tube down the whole page in the left gutter, the noren hanging over the wall / night edge, and
 *     the tub board rising over the hot section's foot (a negative margin on a block that holds a caption).
 * - cprime: the C′ page (raw research HTML, outside the allowlist on purpose: measured only).
 */
export const OVERLAP_VARIANTS = ["strict", "layer", "cprime"] as const;
export type OverlapVariant = (typeof OVERLAP_VARIANTS)[number];

export const LAYER_CSS: Record<ShopKey, string> = {
  tsugute: [
    ".board { position: relative; }",
    ".crack { position: absolute; z-index: 1; top: 8%; left: 46%; width: 4px; height: 40%; background: #c79a45; transform: rotate(16deg); }",
    ".crack-2 { position: absolute; z-index: 1; top: 30%; left: 50%; width: 3px; height: 26%; background: #d8b35e; transform: rotate(-38deg); }",
    ".section-cut { position: relative; isolation: isolate; }",
    ".cut p { display: inline-block; position: relative; z-index: 2; }",
    ".cut-kin p { background: #c79a45; } .cut-urushi p { background: #4a2219; } .cut-utsuwa p { background: #3a332b; }",
    ".cut-seam { position: absolute; z-index: 1; top: -40px; bottom: 0; left: 72%; width: 4px; background: #d8b35e; }",
    "@media (max-width: 600px) { .cut-seam { left: 82%; } }",
  ].join("\n"),
  bicycle: [
    ".spokes { position: relative; isolation: isolate; overflow-x: clip; }",
    ".spokes-h, .stations, .ghost-turn { position: relative; z-index: 2; }",
    ".spoke { position: absolute; z-index: 1; top: -200px; height: 280px; width: 4px; background: #f2c230; transform-origin: top center; }",
    "@media (min-width: 1360px) { .spoke { height: 520px; } }",
    ".spoke-1 { right: 36%; transform: rotate(-4deg); }",
    ".spoke-2 { right: 31%; transform: rotate(-12deg); }",
    ".spoke-3 { right: 26%; transform: rotate(-20deg); }",
    ".spoke-4 { right: 21%; transform: rotate(-28deg); }",
    ".lesson { position: relative; }",
    ".lesson-grid > div:first-child { position: relative; z-index: 2; }",
    ".gauge { position: relative; z-index: 1; margin-top: -180px; margin-bottom: 40px; }",
    "@media (max-width: 600px) { .spoke { height: 0; } .spoke-1 { top: 300px; bottom: 40px; left: 6px; right: auto; height: auto; width: 3px; transform: none; } .gauge { margin-top: 0; } }",
  ].join("\n"),
  sento: [
    ".page { position: relative; isolation: isolate; }",
    ".tube { position: absolute; z-index: 1; top: 0; bottom: 0; left: 38px; width: 10px; background: #f6f1e7; }",
    ".in { position: relative; z-index: 2; }",
    ".night { position: relative; }",
    ".noren { position: absolute; z-index: 3; right: 110px; top: -40px; width: 300px; height: 200px; background: #8e2f1c; border-top: 12px solid #3a2a1f; }",
    ".noren-slit { position: absolute; top: 0; bottom: 0; width: 6px; background: #2a1f18; }",
    ".noren-slit-1 { left: 25%; } .noren-slit-2 { left: 50%; } .noren-slit-3 { left: 75%; }",
    "@media (max-width: 900px) { .noren { height: 96px; } }",
    ".warm .tub { position: relative; z-index: 3; margin-top: -150px; }",
    "@media (max-width: 600px) { .tube { left: 9px; width: 6px; } .noren { right: 16px; top: -24px; width: 140px; height: 60px; border-top-width: 8px; } .noren-slit { width: 4px; } .warm .tub { margin-top: -60px; } }",
  ].join("\n"),
};

function layerHtml(shop: ShopKey, html: string): string {
  if (shop === "tsugute")
    return html
      .replace(/(<div class="r board">|<div class="l board">)(<img [^>]*>)/g, '$1<div class="crack" aria-hidden="true"></div><div class="crack-2" aria-hidden="true"></div>$2')
      .replace('<div class="section-cut">', '<div class="section-cut"><div class="cut-seam" aria-hidden="true"></div>');
  if (shop === "bicycle")
    return html.replace(
      '<section class="spokes" data-comp-section="spokes">',
      '<section class="spokes" data-comp-section="spokes"><div class="spoke spoke-1" aria-hidden="true"></div><div class="spoke spoke-2" aria-hidden="true"></div><div class="spoke spoke-3" aria-hidden="true"></div><div class="spoke spoke-4" aria-hidden="true"></div>',
    );
  return html
    .replace('<main class="page">', '<main class="page"><div class="tube" aria-hidden="true"></div>')
    .replace(
      '<section class="night" data-comp-section="night">',
      '<section class="night" data-comp-section="night"><div class="noren" aria-hidden="true"><div class="noren-slit noren-slit-1"></div><div class="noren-slit noren-slit-2"></div><div class="noren-slit noren-slit-3"></div></div>',
    );
}

/** A page of a shop in a variant (the viewport meta added to the strict pages, as nowrap-harness.ts strictPage does). */
export function overlapPage(shop: ShopKey, v: OverlapVariant): CompPage {
  if (v === "cprime") {
    const dir = join(POC, C_PRIME[shop]);
    return { dir, html: readFileSync(join(dir, "index.html"), "utf8"), css: readFileSync(join(dir, "style.css"), "utf8"), assets: [], files: files(dir), htmlSha256: "", cssSha256: "" };
  }
  const dir = join(POC, SHOPS[shop].strict);
  let html = readFileSync(join(dir, "index.html"), "utf8").replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  let css = readFileSync(join(dir, "style.css"), "utf8");
  if (v === "layer") {
    html = layerHtml(shop, html);
    css = `${css}\n${LAYER_CSS[shop]}\n`;
  }
  return { dir, html, css, assets: [], files: files(dir), htmlSha256: "", cssSha256: "" };
}

// ---------------------------------------------------------------- inventory of the C′ pages (static)

/** The overlap / layering categories counted in a C′ stylesheet and page (docs/design/phase-c-design.md §1). */
export const INVENTORY_CATEGORIES = [
  "position_absolute",
  "position_relative",
  "offsets",
  "z_index_positive",
  "z_index_negative",
  "negative_margin",
  "transform",
  "pseudo_element_rules",
  "pointer_events",
  "overflow_clip",
  "clip_path",
  "filter",
  "opacity",
  "box_shadow_outer",
  "outline",
  "text_stroke",
  "mix_blend_isolation",
  "viewport_units_in_placement",
  "inline_svg",
  "aria_hidden_text",
] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

/** Counts declarations (CSS) and elements (HTML) of a C′ page by category. Static and approximate by design: a plain scan. */
export function inventory(shop: ShopKey): Record<InventoryCategory, number> {
  const p = overlapPage(shop, "cprime");
  const css = p.css.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = [...css.matchAll(/([-a-z]+)\s*:\s*([^;{}]+)/g)].map((m) => ({ prop: m[1]!, value: m[2]!.trim() }));
  const count = (f: (d: { prop: string; value: string }) => boolean) => decls.filter(f).length;
  const out = Object.fromEntries(INVENTORY_CATEGORIES.map((c) => [c, 0])) as Record<InventoryCategory, number>;
  out.position_absolute = count((d) => d.prop === "position" && /absolute|fixed|sticky/.test(d.value));
  out.position_relative = count((d) => d.prop === "position" && d.value === "relative");
  out.offsets = count((d) => ["top", "right", "bottom", "left", "inset"].includes(d.prop));
  out.z_index_positive = count((d) => d.prop === "z-index" && Number(d.value) > 0);
  out.z_index_negative = count((d) => d.prop === "z-index" && Number(d.value) < 0);
  out.negative_margin = count((d) => /^margin/.test(d.prop) && /(^|\s)-\d|calc\([^)]*-\s*\d/.test(d.value) && /(^|\s)-/.test(d.value));
  out.transform = count((d) => ["transform", "rotate", "translate", "scale"].includes(d.prop) && d.value !== "none");
  out.pseudo_element_rules = (css.match(/::(before|after)[^{]*\{/g) ?? []).length;
  out.pointer_events = count((d) => d.prop === "pointer-events");
  out.overflow_clip = count((d) => /^overflow(-x|-y)?$/.test(d.prop) && /hidden|clip/.test(d.value));
  out.clip_path = count((d) => d.prop === "clip-path" || /^(-webkit-)?mask/.test(d.prop));
  out.filter = count((d) => d.prop === "filter" || d.prop === "backdrop-filter");
  out.opacity = count((d) => d.prop === "opacity" && Number(d.value) < 1);
  out.box_shadow_outer = count((d) => d.prop === "box-shadow" && d.value !== "none" && d.value.split(/,(?![^(]*\))/).some((x) => !/\binset\b/.test(x)));
  out.outline = count((d) => d.prop === "outline" || d.prop === "outline-offset");
  out.text_stroke = count((d) => d.prop === "-webkit-text-stroke");
  out.mix_blend_isolation = count((d) => d.prop === "mix-blend-mode" || d.prop === "isolation");
  out.viewport_units_in_placement = count((d) => ["top", "right", "bottom", "left", "inset", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "transform"].includes(d.prop) && /\d(vw|vh)/.test(d.value));
  out.inline_svg = (p.html.match(/<svg\b/g) ?? []).length;
  out.aria_hidden_text = (p.html.match(/<(p|span|h\d)\b[^>]*aria-hidden="true"[^>]*>[^<\s][^<]*</g) ?? []).length;
  return out;
}
