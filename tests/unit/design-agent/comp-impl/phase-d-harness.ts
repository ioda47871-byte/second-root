import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import sharp from "sharp";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { pageCssProblems, type PageCssOptions } from "@/lib/design-agent/comp-impl/page-css";
import { REPO, SHOPS, shopFacts, type ShopKey } from "./nowrap-harness";
import { overlapPage, PROTECT_SEL } from "./overlap-harness";

// DEV-175 (Issue #193 comment 6628165899): the research harness for phase D — vertical writing, small rotation and
// outlined type, each a separate capability. TEST-ONLY PROTOTYPE, NOT ENABLED. Nothing in lib/ changes: this file
// implements, outside the production checker, the grammar and the render checks that docs/design/phase-d-design.md
// proposes (capabilities `vertical_text`, `small_rotation`, `outlined_type`; flags `verticalText`, `smallRotation`,
// `outlinedType`; default OFF; HOLD for the owner's approval). The production grammar (page-css.ts) and the run
// (run.ts) never see any of it; APPROVED_CAPABILITIES stays empty.

const POC = join(REPO, "design-library/research/quality-pipeline/poc");

/** The proposed bounds (docs/design/phase-d-design.md §2–§4). One table, so the doc, the grammar and the render agree. */
export const PHASE_D_LIMITS = {
  /** small_rotation: |angle| of one rotate() and of the sum along the ancestors. */
  rotateDeg: 8,
  /** small_rotation: how far a rotated box may reach past its unrotated box (any side). */
  rotateReachPx: 24,
  /** outlined_type: stroke width in px (grammar) and per em of the text (render: an inherited stroke on small text). */
  strokePxMin: 0.5,
  strokePxMax: 3,
  strokeEmMax: 0.06,
  /** outlined_type: a hollow word (fill alpha 0) needs at least this stroke. */
  hollowStrokeMinPx: 1.5,
  /** outlined_type: WCAG contrast of the ink against the ground under it, measured from pixels (large text). */
  contrastMin: 3,
  /** a "word": decorative / display text that a rotation or a stroke may touch. */
  wordChars: 12,
  wordMinPx: 24,
  /** vertical_text: the longest vertical text and its least size. */
  verticalChars: 16,
  verticalMinPx: 20,
  /** vertical_text: characters a text-combine-upright span may hold (tate-chu-yoko). */
  combineChars: 2,
} as const;

// ---------------------------------------------------------------- the proposed grammar (prototype, wraps the production one)

export type PhaseDOptions = PageCssOptions & { verticalText?: boolean; smallRotation?: boolean; outlinedType?: boolean };

const num = (s: string) => (/^[-+]?(\d+(\.\d+)?|\.\d+)$/.test(s) ? Number(s) : NaN);
/** An opaque colour only: #rgb / #rrggbb, white / black, rgb() with three channels and no alpha. */
const OPAQUE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|white|black|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgb\(\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s*\))$/i;
const strokeWidth = (v: string) => {
  const m = /^(\d+(\.\d+)?|\.\d+)px$/.exec(v);
  return m !== null && Number(m[1]) >= PHASE_D_LIMITS.strokePxMin && Number(m[1]) <= PHASE_D_LIMITS.strokePxMax;
};
const ORIGIN_WORD = /^(center|top|bottom|left|right)$/;
const originItem = (v: string) => ORIGIN_WORD.test(v) || (/^(\d+(\.\d+)?|\.\d+)%$/.test(v) && Number(v.slice(0, -1)) <= 100) || v === "0";

/**
 * One declaration the enabled phase D flags admit (lower-case, trimmed). Each flag admits its own list only:
 * - verticalText: writing-mode horizontal-tb | vertical-rl; text-orientation mixed | upright; text-combine-upright none | all.
 * - smallRotation: transform none | one rotate(<deg>) with |deg| ≤ 8; transform-origin of 1–2 side words / percentages.
 * - outlinedType: -webkit-text-stroke-width 0.5–3px; -webkit-text-stroke-color an opaque colour; -webkit-text-stroke both;
 *   paint-order normal | stroke | stroke fill.
 * Never: vertical-lr, sideways*, text-combine-upright digits, the rotate / scale / translate properties, any other
 * transform function or unit, -webkit-text-fill-color, text-shadow, a translucent stroke colour, var(), calc().
 */
export function phaseDDecl(prop: string, value: string, opts: PhaseDOptions): boolean {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (opts.verticalText === true) {
    if (prop === "writing-mode") return v === "horizontal-tb" || v === "vertical-rl";
    if (prop === "text-orientation") return v === "mixed" || v === "upright";
    if (prop === "text-combine-upright") return v === "none" || v === "all";
  }
  if (opts.smallRotation === true) {
    if (prop === "transform") {
      if (v === "none") return true;
      const m = /^rotate\(\s*([^()]*?)\s*\)$/.exec(v);
      if (!m) return false;
      const a = /^([-+]?(\d+(\.\d+)?|\.\d+))deg$/.exec(m[1]!);
      return (a !== null && Math.abs(Number(a[1])) <= PHASE_D_LIMITS.rotateDeg) || num(m[1]!) === 0;
    }
    if (prop === "transform-origin") {
      const parts = v.split(" ");
      return parts.length >= 1 && parts.length <= 2 && parts.every(originItem);
    }
  }
  if (opts.outlinedType === true) {
    if (prop === "-webkit-text-stroke-width") return strokeWidth(v);
    if (prop === "-webkit-text-stroke-color") return OPAQUE.test(v);
    if (prop === "-webkit-text-stroke") {
      const m = /^(\S+) (.+)$/.exec(v);
      return m !== null && ((strokeWidth(m[1]!) && OPAQUE.test(m[2]!)) || (OPAQUE.test(m[1]!) && strokeWidth(m[2]!)));
    }
    if (prop === "paint-order") return v === "normal" || v === "stroke" || v === "stroke fill";
  }
  return false;
}

/**
 * The page CSS check with the proposed phase D flags (prototype): with no phase D flag, exactly pageCssProblems. With a
 * flag, every `prop: value` the flag admits (phaseDDecl) is taken out and the rest goes to the production check with the
 * other options (the same wrapper as overlap-harness.ts layeredCssProblems; the real patch would add the items to
 * PAGE_PROPS behind the flags). A plain scan of `prop: value` pairs, enough for the hand-written research CSS.
 */
export function phaseDCssProblems(css: string, opts: PhaseDOptions = {}): string[] {
  const { verticalText, smallRotation, outlinedType, ...rest } = opts;
  const flags = { verticalText, smallRotation, outlinedType };
  if (!verticalText && !smallRotation && !outlinedType) return pageCssProblems(css, rest);
  const kept = css.replace(/([{;]\s*)(-?[-a-z]+)\s*:\s*([^;{}]*?)\s*(?=;|})/g, (all, lead: string, prop: string, value: string) => (phaseDDecl(prop.toLowerCase(), value, flags) ? lead : all));
  return pageCssProblems(kept.replace(/;\s*;/g, ";").replace(/{\s*;/g, "{"), rest);
}

// ---------------------------------------------------------------- the render check (in the page)

/**
 * The phase D check at the current viewport (plain JavaScript; the caller appends its JSON argument). Argument:
 * { protect (whitespace-free strings: facts and the name), protectSel, names (whitespace-free shop names; with h1, the
 * name role), features { vertical, rotation, outline }, limits (PHASE_D_LIMITS) }.
 *
 * Text elements: elements with a non-empty text node of their own, drawn (a client rect). Protected: as phase C
 * (inside protectSel, or the whole text holds a protected string, or 6+ characters of one). A "word": not protected,
 * ≤ wordChars characters in its feature root, font-size ≥ wordMinPx.
 *
 * vertical_text — every element whose computed writing-mode is not horizontal-tb; a vertical ROOT has a horizontal parent.
 *   not enabled → PHASE_D_VERTICAL_NOT_ENABLED. The root is html / body, is inline, or holds any element but a
 *   text-combine-upright: all leaf span (a vertical container lays blocks out as right-to-left columns) →
 *   PHASE_D_VERTICAL_CONTAINER; a non-root vertical element that is not such a span → the same. vertical-lr / sideways-*
 *   → PHASE_D_VERTICAL_MODE. Protected text but the name → PHASE_D_PROTECTED_VERTICAL. More than verticalChars →
 *   PHASE_D_VERTICAL_LONG_TEXT; under verticalMinPx → PHASE_D_VERTICAL_SMALL. Latin letters drawn sideways (mixed) →
 *   PHASE_D_VERTICAL_SIDEWAYS; two or more digits in a row not combined → PHASE_D_VERTICAL_DIGITS; a combine span of
 *   more than combineChars or of anything but ASCII letters / digits → PHASE_D_COMBINE_TEXT. Glyphs (a combine span is
 *   one glyph): a character with no box, or not down the column then the next column to the left →
 *   PHASE_D_VERTICAL_ORDER; two glyph boxes meeting by > 1px, or an advance < 0.4 em → PHASE_D_VERTICAL_GLYPH_OVERLAP;
 *   a glyph outside the root's box or the root's scroll size past its client size → PHASE_D_VERTICAL_OVERFLOW.
 *   Reading order: for two text elements next to each other in DOM order, one of them a vertical root, the later one
 *   must not lie both higher and wholly to the right of the earlier one (it would be read first in horizontal AND in
 *   vertical-rl reading) → PHASE_D_READING_ORDER — only when the vertical writing creates it: the pair is measured again
 *   with the roots set horizontal, and an inversion already there (a zigzag layout; V9, not phase D) is not counted.
 * small_rotation — every element with a computed transform (or a rotate / scale / translate property).
 *   not enabled → PHASE_D_ROTATION_NOT_ENABLED. Not a pure rotation matrix, or the individual properties →
 *   PHASE_D_ROTATION_UNMEASURED (fail closed). |angle| or the sum along the ancestors > rotateDeg →
 *   PHASE_D_ROTATION_ANGLE. Any protected text inside (the name too) → PHASE_D_PROTECTED_ROTATED; other text that is not a
 *   word → PHASE_D_ROTATED_TEXT. The rotated box reaches past its unrotated box (measured with the transform taken off)
 *   by > rotateReachPx → PHASE_D_ROTATION_REACH. Past the viewport's left / right where the unrotated box was inside →
 *   PHASE_D_ROTATED_OFFSCREEN (a box the layout already puts past the edge is the layout's overflow); rotated
 *   text past a clipping ancestor's padding box → PHASE_D_ROTATED_CLIPPED.
 * outlined_type — every text element with a computed -webkit-text-stroke-width > 0 (it inherits).
 *   not enabled → PHASE_D_OUTLINE_NOT_ENABLED. Protected → PHASE_D_PROTECTED_STROKED; not a word →
 *   PHASE_D_STROKE_ON_TEXT; width > strokeEmMax em → PHASE_D_STROKE_TOO_THICK; stroke colour or fill not opaque and not
 *   fully transparent → PHASE_D_OUTLINE_TRANSLUCENT; hollow (fill alpha 0) with a stroke under hollowStrokeMinPx →
 *   PHASE_D_OUTLINE_HOLLOW_THIN. Any text-shadow → PHASE_D_TEXT_SHADOW.
 * Whole page: scroll width past the client width → PHASE_D_HORIZONTAL_SCROLL.
 *
 * Ink targets: rotated words and outlined words are returned as targets (data-pd-id) with their extent (their own
 * glyph boxes as the page reports them — under a transform, the bounding box of each rotated glyph box — grown by the
 * stroke and 1px) and `near`: whether that extent meets another text's glyph boxes. Pixels decide those (phaseDPixels);
 * without pixels a near target is PHASE_D_INK_UNPROVEN (fail closed).
 */
export const PHASE_D_SCRIPT = String.raw`(arg) => {
  const L = arg.limits, F = arg.features;
  const flat = (s) => (s || "").replace(/\s+/g, "");
  const st = (el) => getComputedStyle(el);
  const codes = {}, found = [];
  const add = (code, el, note) => {
    codes[code] = (codes[code] || 0) + 1;
    if (found.length < 80) found.push({ code, text: (flat(el.textContent).slice(0, 24) || el.tagName.toLowerCase()), note: note === undefined ? null : note });
  };
  const all = [document.documentElement, document.body].concat(Array.from(document.body.querySelectorAll("*")));
  const ownNodes = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3 && flat(n.data) !== "");
  const charRects = (n) => {
    const out = [];
    for (let i = 0; i < n.data.length; i++) {
      if (/\s/.test(n.data[i])) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      out.push(Array.from(r.getClientRects()).find((x) => x.width > 0.5 && x.height > 0.5) || null);
    }
    return out;
  };
  const textEls = all.filter((el) => ownNodes(el).length > 0 && el.getClientRects().length > 0);
  const isProt = (el) => {
    if (el.closest(arg.protectSel)) return true;
    const w = flat(el.textContent);
    return w.length > 0 && arg.protect.some((f) => w.includes(f) || (w.length >= 6 && f.includes(w)));
  };
  const isName = (el) => el.matches("h1") || arg.names.includes(flat(el.textContent));
  const fs = (el) => parseFloat(st(el).fontSize) || 16;
  const textsIn = (root) => textEls.filter((t) => root === t || root.contains(t));
  const isWord = (root) => {
    const ts = textsIn(root);
    return ts.length > 0 && !ts.some(isProt) && flat(root.textContent).length <= L.wordChars && ts.every((t) => fs(t) >= L.wordMinPx);
  };
  const union = (rs) => rs.reduce((u, r) => (u ? { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }), null);
  const meets = (a, b, m) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > m && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > m;
  const grow = (r, d) => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });
  const ownRects = (el) => ownNodes(el).flatMap(charRects).filter(Boolean);
  const vw = document.documentElement.clientWidth;

  // ------------------------------------------------------------ vertical_text
  // Order, overlap and overflow of vertical text, and the reading order, are judged on the unrotated layout: a rotation
  // (≤ rotateDeg) is rigid, and the Range rects of rotated glyphs are their bounding boxes, which overlap and slip. Every
  // transform is taken off for this part and put back after it.
  const undo = [];
  for (const el of all) if (st(el).transform !== "none") { undo.push([el, el.style.getPropertyValue("transform"), el.style.getPropertyPriority("transform")]); el.style.setProperty("transform", "none", "important"); }
  const vert = (el) => st(el).writingMode !== "horizontal-tb";
  const combine = (el) => el.tagName === "SPAN" && el.children.length === 0 && st(el).textCombineUpright === "all";
  const vRoots = [];
  for (const el of all) {
    if (!vert(el)) continue;
    const root = el === document.documentElement || !vert(el.parentElement);
    if (!root) {
      if (!combine(el)) add("PHASE_D_VERTICAL_CONTAINER", el, "a vertical descendant that is not a combine span");
      continue;
    }
    if (!F.vertical) { add("PHASE_D_VERTICAL_NOT_ENABLED", el); continue; }
    if (textsIn(el).some(isProt) && !isName(el)) add("PHASE_D_PROTECTED_VERTICAL", el);
    if (el === document.documentElement || el === document.body || st(el).display.startsWith("inline") && st(el).display !== "inline-block") { add("PHASE_D_VERTICAL_CONTAINER", el, "root / inline"); continue; }
    if (Array.from(el.children).some((c) => !combine(c))) { add("PHASE_D_VERTICAL_CONTAINER", el, "holds elements"); continue; }
    vRoots.push(el);
    if (st(el).writingMode !== "vertical-rl") add("PHASE_D_VERTICAL_MODE", el, st(el).writingMode);
    const text = flat(el.textContent);
    if (text.length > L.verticalChars) add("PHASE_D_VERTICAL_LONG_TEXT", el, text.length);
    if (fs(el) < L.verticalMinPx) add("PHASE_D_VERTICAL_SMALL", el, fs(el));
    const own = ownNodes(el).map((n) => n.data).join("");
    if (/[A-Za-z]/.test(own) && st(el).textOrientation !== "upright") add("PHASE_D_VERTICAL_SIDEWAYS", el);
    if (/[0-9０-９]{2,}/.test(own)) add("PHASE_D_VERTICAL_DIGITS", el);
    for (const c of el.children) if (flat(c.textContent).length > L.combineChars || !/^[0-9A-Za-z]+$/.test(flat(c.textContent))) add("PHASE_D_COMBINE_TEXT", c);
    // glyphs in DOM order; a combine span is one glyph
    const glyphs = [];
    let missing = 0;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) for (const r of charRects(n)) { if (r) glyphs.push(r); else missing += 1; }
      else if (n.nodeType === 1) { const r = n.getBoundingClientRect(); if (r.width > 0.5 && r.height > 0.5) glyphs.push(r); else missing += 1; }
    }
    let disorder = missing, overlap = 0;
    const em = fs(el);
    for (const r of glyphs) if (r.height < 0.4 * em) overlap += 1;
    for (let a = 0; a < glyphs.length; a++) for (let b = a + 1; b < glyphs.length; b++) if (meets(glyphs[a], glyphs[b], 1)) overlap += 1;
    for (let a = 1; a < glyphs.length; a++) {
      const P = glyphs[a - 1], C = glyphs[a];
      const same = Math.abs((P.left + P.right) / 2 - (C.left + C.right) / 2) < Math.max(P.width, C.width) / 2;
      if (same ? C.top < P.bottom - 1 : C.right > P.left + 1) disorder += 1;
    }
    if (disorder) add("PHASE_D_VERTICAL_ORDER", el, disorder);
    if (overlap) add("PHASE_D_VERTICAL_GLYPH_OVERLAP", el, overlap);
    const box = el.getBoundingClientRect();
    const out = glyphs.filter((g) => g.left < box.left - 1 || g.right > box.right + 1 || g.top < box.top - 1 || g.bottom > box.bottom + 1).length;
    if (out || el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) add("PHASE_D_VERTICAL_OVERFLOW", el, out);
  }
  // reading order: neighbours in DOM order (text elements outside vertical roots' insides, each by its own glyph boxes,
  // a combine span by its box). Only an inversion the vertical writing creates is phase D's: the same pair is measured
  // again with the roots set horizontal, and an inversion that the horizontal layout already has (a zigzag layout,
  // V9's matter) is not counted here.
  const inverted = () => {
    const readers = textEls.filter((t) => !vRoots.some((v) => v !== t && v.contains(t))).map((t) => ({ el: t, r: union(ownRects(t).concat(Array.from(t.children).flatMap((c) => Array.from(c.getClientRects())))) })).filter((x) => x.r);
    const out = new Map();
    for (let i = 1; i < readers.length; i++) {
      const A = readers[i - 1], B = readers[i];
      if (!vRoots.includes(A.el) && !vRoots.includes(B.el)) continue;
      if (B.r.top < A.r.top - 4 && B.r.left >= A.r.right - 4) out.set(A.el, B.el);
    }
    return out;
  };
  const vInv = inverted();
  if (vInv.size) {
    const keepWm = vRoots.map((el) => [el, el.style.getPropertyValue("writing-mode"), el.style.getPropertyPriority("writing-mode")]);
    for (const el of vRoots) el.style.setProperty("writing-mode", "horizontal-tb", "important");
    const hInv = inverted();
    for (const [el, v, p] of keepWm) { if (v) el.style.setProperty("writing-mode", v, p); else el.style.removeProperty("writing-mode"); }
    for (const [A, B] of vInv) if (hInv.get(A) !== B) add("PHASE_D_READING_ORDER", vRoots.includes(A) ? A : B, flat(A.textContent).slice(0, 12) + " -> " + flat(B.textContent).slice(0, 12));
  }
  for (const [el, v, p] of undo) { if (v) el.style.setProperty("transform", v, p); else el.style.removeProperty("transform"); }

  // ------------------------------------------------------------ small_rotation
  const transformed = (el) => { const s = st(el); return (s.transform && s.transform !== "none") || (s.rotate && s.rotate !== "none") || (s.scale && s.scale !== "none") || (s.translate && s.translate !== "none"); };
  const angleOf = (el) => {
    const s = st(el);
    if ((s.rotate && s.rotate !== "none") || (s.scale && s.scale !== "none") || (s.translate && s.translate !== "none")) return NaN;
    if (!s.transform || s.transform === "none") return 0;
    const m = /^matrix\(([^)]+)\)$/.exec(s.transform);
    if (!m) return NaN;
    const [a, b, c, d, e, f] = m[1].split(",").map(Number);
    if (Math.abs(a - d) > 1e-4 || Math.abs(b + c) > 1e-4 || Math.abs(a * a + b * b - 1) > 1e-3 || Math.abs(e) > 1e-3 || Math.abs(f) > 1e-3) return NaN;
    return (Math.atan2(b, a) * 180) / Math.PI;
  };
  const targets = [];
  const rotatedRoots = [];
  for (const el of all) {
    if (!transformed(el)) continue;
    if (!F.rotation) { add("PHASE_D_ROTATION_NOT_ENABLED", el); continue; }
    const a = angleOf(el);
    if (Number.isNaN(a)) { add("PHASE_D_ROTATION_UNMEASURED", el, st(el).transform); continue; }
    let sum = 0;
    for (let p = el; p; p = p.parentElement) { const x = angleOf(p); sum += Number.isNaN(x) ? 1e9 : x; }
    if (Math.abs(a) > L.rotateDeg + 1e-6 || Math.abs(sum) > L.rotateDeg + 1e-6) add("PHASE_D_ROTATION_ANGLE", el, Math.round(sum * 100) / 100);
    const ts = textsIn(el);
    if (ts.some(isProt)) add("PHASE_D_PROTECTED_ROTATED", el);
    else if (ts.length && !isWord(el)) add("PHASE_D_ROTATED_TEXT", el);
    const r = el.getBoundingClientRect();
    const keep = el.style.getPropertyValue("transform"), prio = el.style.getPropertyPriority("transform");
    el.style.setProperty("transform", "none", "important");
    const r0 = el.getBoundingClientRect();
    el.style.setProperty("transform", keep, prio);
    if (!keep) el.style.removeProperty("transform");
    const reach = Math.max(r0.left - r.left, r.right - r0.right, r0.top - r.top, r.bottom - r0.bottom);
    if (reach > L.rotateReachPx) add("PHASE_D_ROTATION_REACH", el, Math.round(reach));
    // past an edge the unrotated box was inside (a box the layout already puts past the edge is the layout's overflow:
    // PHASE_D_HORIZONTAL_SCROLL, and the strict page's own)
    if ((r.left < -0.5 && r0.left >= -0.5) || (r.right > vw + 0.5 && r0.right <= vw + 0.5)) add("PHASE_D_ROTATED_OFFSCREEN", el);
    if (ts.length) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = st(p);
        if (s.overflowX === "visible" && s.overflowY === "visible") continue;
        const b = p.getBoundingClientRect();
        const pad = { left: b.left + p.clientLeft, top: b.top + p.clientTop, right: b.left + p.clientLeft + p.clientWidth, bottom: b.top + p.clientTop + p.clientHeight };
        if (r.left < pad.left - 0.5 || r.right > pad.right + 0.5 || r.top < pad.top - 0.5 || r.bottom > pad.bottom + 0.5) { add("PHASE_D_ROTATED_CLIPPED", el); break; }
      }
      if (!ts.some(isProt) && isWord(el)) rotatedRoots.push(el);
    }
  }

  // ------------------------------------------------------------ outlined_type
  const rgba = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return null; const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return { a: p.length > 3 ? p[3] : 1 }; };
  const stroked = [];
  for (const el of textEls) {
    const s = st(el);
    if (s.textShadow && s.textShadow !== "none") add("PHASE_D_TEXT_SHADOW", el);
    const sw = parseFloat(s.webkitTextStrokeWidth) || 0;
    if (sw <= 0) continue;
    if (!F.outline) { add("PHASE_D_OUTLINE_NOT_ENABLED", el); continue; }
    if (isProt(el)) { add("PHASE_D_PROTECTED_STROKED", el); continue; }
    if (!isWord(el)) { add("PHASE_D_STROKE_ON_TEXT", el); continue; }
    if (sw > L.strokeEmMax * fs(el) + 1e-6) add("PHASE_D_STROKE_TOO_THICK", el, sw);
    const sc = rgba(s.webkitTextStrokeColor), fc = rgba(s.webkitTextFillColor || s.color);
    if (!sc || !fc || sc.a < 1 || (fc.a > 0 && fc.a < 1)) add("PHASE_D_OUTLINE_TRANSLUCENT", el);
    else if (fc.a === 0 && sw < L.hollowStrokeMinPx) add("PHASE_D_OUTLINE_HOLLOW_THIN", el, sw);
    stroked.push({ el, sw });
  }

  // ------------------------------------------------------------ ink targets (pixels decide; fail closed without)
  let id = 0;
  const pushTarget = (el, kind, sw) => {
    const ext = union(textsIn(el).flatMap(ownRects).concat(kind === "rotated" ? Array.from(el.getClientRects()) : []));
    if (!ext) return;
    const g = grow(ext, sw / 2 + 1);
    const near = textEls.some((t) => !(el === t || el.contains(t)) && ownRects(t).some((r) => meets(r, g, 0.5)));
    el.setAttribute("data-pd-id", String(id));
    targets.push({ id: id++, kind, text: flat(el.textContent).slice(0, 24), near, rect: { left: g.left + scrollX, top: g.top + scrollY, right: g.right + scrollX, bottom: g.bottom + scrollY } });
  };
  for (const el of rotatedRoots) pushTarget(el, "rotated", parseFloat(st(el).webkitTextStrokeWidth) || 0);
  for (const s of stroked) if (!s.el.hasAttribute("data-pd-id") && !rotatedRoots.some((r) => r.contains(s.el))) pushTarget(s.el, "outline", s.sw);
  for (const t of textEls) t.setAttribute("data-pd-text", "");

  const sw = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (sw > 0) add("PHASE_D_HORIZONTAL_SCROLL", document.body, sw);
  return { codes, found, targets, vertical: vRoots.length, texts: textEls.length };
}`;

export type PhaseDFeatures = { vertical?: boolean; rotation?: boolean; outline?: boolean };
export type PhaseDPlan = { protect: readonly string[]; names: readonly string[]; protectSel?: string; features: PhaseDFeatures };
export type InkTarget = { id: number; kind: "rotated" | "outline"; text: string; near: boolean; rect: { left: number; top: number; right: number; bottom: number } };
export type PhaseDScan = { codes: Record<string, number>; found: Array<{ code: string; text: string; note: unknown }>; targets: InkTarget[]; vertical: number; texts: number };

/** The phase D geometric scan at the current viewport. */
export async function phaseDScan(page: Page, plan: PhaseDPlan): Promise<PhaseDScan> {
  const flat = (s: string) => s.replace(/\s+/g, "");
  const arg = { protect: plan.protect.map(flat), names: plan.names.map(flat), protectSel: plan.protectSel ?? PROTECT_SEL, features: { vertical: plan.features.vertical === true, rotation: plan.features.rotation === true, outline: plan.features.outline === true }, limits: PHASE_D_LIMITS };
  return (await page.evaluate(`(${PHASE_D_SCRIPT})(${JSON.stringify(arg)})`)) as PhaseDScan;
}

/** Instances "text :: code" of a scan (geometry only: a near ink target is PHASE_D_INK_UNPROVEN, fail closed). */
export function geometryInstances(s: PhaseDScan): string[] {
  const out = s.found.map((f) => `${f.text} :: ${f.code}`);
  for (const t of s.targets) if (t.near) out.push(`${t.text} :: PHASE_D_INK_UNPROVEN`);
  return [...new Set(out)].sort();
}

// ---------------------------------------------------------------- the pixel pass (ink of rotated and outlined words)

type Raw = { data: Buffer; width: number; height: number };
const HIDE = "color: transparent !important; -webkit-text-fill-color: transparent !important; -webkit-text-stroke-color: transparent !important; text-shadow: none !important;";

/** WCAG relative luminance of an sRGB pixel. */
function lum(r: number, g: number, b: number): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
export const contrastOf = (a: [number, number, number], b: [number, number, number]): number => {
  const x = lum(...a);
  const y = lum(...b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The difference (max channel) above which a pixel counts as a text's ink. */
export const INK_DIFF_MIN = 24;

export type InkResult = { id: number; kind: InkTarget["kind"]; text: string; inkPixels: number; contrast: number; onText: number; inkBox: { left: number; top: number; right: number; bottom: number } | null; codes: string[] };

/**
 * The pixel pass over the scan's ink targets (call right after phaseDScan, on the same page). For each target, three
 * clipped screenshots of its extent (+12px): X — only the target's text drawn; G — no text drawn; O — every text but the
 * target drawn. Grounds, images and boxes stay as they are. The target's ink is where X differs from G (max channel ≥
 * INK_DIFF_MIN), the other texts' ink where O differs from G. Font-independent: it measures what this machine draws.
 *  - outline targets: the contrast reached by the best quarter of the ink pixels, X against G (the stroke and fill over
 *    the very ground under them, gradients included) < contrastMin → PHASE_D_OUTLINE_LOW_CONTRAST; fewer than 20 ink
 *    pixels → PHASE_D_OUTLINE_INVISIBLE.
 *  - every target: 3+ pixels where the target's ink (grown 1px) meets another text's ink → PHASE_D_INK_ON_TEXT.
 */
export async function phaseDPixels(page: Page, scan: PhaseDScan): Promise<InkResult[]> {
  const out: InkResult[] = [];
  const size = (await page.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")) as [number, number];
  for (const t of scan.targets) {
    const x0 = Math.max(0, Math.floor(t.rect.left - 12));
    const y0 = Math.max(0, Math.floor(t.rect.top - 12));
    const x1 = Math.min(size[0], Math.ceil(t.rect.right + 12));
    const y1 = Math.min(size[1], Math.ceil(t.rect.bottom + 12));
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      out.push({ id: t.id, kind: t.kind, text: t.text, inkPixels: 0, contrast: 0, onText: 0, inkBox: null, codes: ["PHASE_D_INK_UNMEASURED"] });
      continue;
    }
    const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const shot = async (mode: "X" | "G" | "O"): Promise<Raw> => {
      const sel = `[data-pd-id="${t.id}"], [data-pd-id="${t.id}"] *`;
      // the kept text's colours are pinned inline (an inline !important beats the hiding rule and its inheritance)
      await page.evaluate(`((sel, mode, hide) => {
        const keep = new Set(Array.from(document.querySelectorAll(sel)));
        for (const el of document.querySelectorAll("[data-pd-text]")) {
          if (!el.hasAttribute("data-pd-orig")) {
            const s = getComputedStyle(el);
            el.setAttribute("data-pd-orig", JSON.stringify([el.getAttribute("style"), s.color, s.webkitTextFillColor, s.webkitTextStrokeColor]));
          }
          const [style, c, f, k] = JSON.parse(el.getAttribute("data-pd-orig"));
          if (style === null) el.removeAttribute("style"); else el.setAttribute("style", style);
          const show = mode === "X" ? keep.has(el) : mode === "O" ? !keep.has(el) : false;
          if (show) { el.style.setProperty("color", c, "important"); el.style.setProperty("-webkit-text-fill-color", f, "important"); el.style.setProperty("-webkit-text-stroke-color", k, "important"); }
          else for (const d of hide.split(";").map((x) => x.trim()).filter(Boolean)) { const [p, v] = d.split(":"); el.style.setProperty(p.trim(), v.replace("!important", "").trim(), "important"); }
        }
      })(${JSON.stringify(sel)}, ${JSON.stringify(mode)}, ${JSON.stringify(HIDE)})`);
      const png = await page.screenshot({ clip, fullPage: true, animations: "disabled" });
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    };
    const X = await shot("X");
    const G = await shot("G");
    const O = await shot("O");
    const n = X.width * X.height;
    const diff = (A: Raw, i: number) => Math.max(Math.abs(A.data[i * 3]! - G.data[i * 3]!), Math.abs(A.data[i * 3 + 1]! - G.data[i * 3 + 1]!), Math.abs(A.data[i * 3 + 2]! - G.data[i * 3 + 2]!));
    const ink = new Uint8Array(n);
    const other = new Uint8Array(n);
    const cs: number[] = [];
    let box: InkResult["inkBox"] = null;
    for (let i = 0; i < n; i++) {
      if (diff(X, i) >= INK_DIFF_MIN) {
        ink[i] = 1;
        cs.push(contrastOf([X.data[i * 3]!, X.data[i * 3 + 1]!, X.data[i * 3 + 2]!], [G.data[i * 3]!, G.data[i * 3 + 1]!, G.data[i * 3 + 2]!]));
        const x = (i % X.width) + x0;
        const y = Math.floor(i / X.width) + y0;
        box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x + 1), bottom: Math.max(box.bottom, y + 1) } : { left: x, top: y, right: x + 1, bottom: y + 1 };
      }
      if (diff(O, i) >= INK_DIFF_MIN) other[i] = 1;
    }
    let onText = 0;
    for (let i = 0; i < n; i++) {
      if (!other[i]) continue;
      const x = i % X.width;
      const y = Math.floor(i / X.width);
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++)
        for (let dx = -1; dx <= 1 && !hit; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < X.width && yy < X.height && ink[yy * X.width + xx]) hit = true;
        }
      if (hit) onText += 1;
    }
    cs.sort((a, b) => b - a);
    const contrast = cs.length ? cs[Math.floor(cs.length / 4)]! : 0;
    const codes: string[] = [];
    if (t.kind === "outline") {
      if (cs.length < 20) codes.push("PHASE_D_OUTLINE_INVISIBLE");
      else if (contrast < PHASE_D_LIMITS.contrastMin) codes.push("PHASE_D_OUTLINE_LOW_CONTRAST");
    }
    if (onText >= 3) codes.push("PHASE_D_INK_ON_TEXT");
    out.push({ id: t.id, kind: t.kind, text: t.text, inkPixels: cs.length, contrast: Math.round(contrast * 100) / 100, onText, inkBox: box, codes });
  }
  // put every text's own style back
  await page.evaluate(`(() => { for (const el of document.querySelectorAll("[data-pd-orig]")) { const [style] = JSON.parse(el.getAttribute("data-pd-orig")); if (style === null) el.removeAttribute("style"); else el.setAttribute("style", style); el.removeAttribute("data-pd-orig"); } })()`);
  return out;
}

/** Instances of a scan with its pixel pass: geometry codes, and for each ink target what the pixels found. */
export function fullInstances(s: PhaseDScan, px: InkResult[]): string[] {
  const out = s.found.map((f) => `${f.text} :: ${f.code}`);
  for (const r of px) for (const c of r.codes) out.push(`${r.text} :: ${c}`);
  return [...new Set(out)].sort();
}

/** The code names of a list of instances, sorted and unique. */
export const codeNames = (instances: readonly string[]): string[] => [...new Set(instances.map((x) => x.split(" :: ").pop()!))].sort();

// ---------------------------------------------------------------- the 1px sweep (geometry)

export type PhaseDSweep = { failing: Array<{ w: number; codes: string[] }>; measured: number; ms: number };

/** The geometric scan at every integer width of [from, to] (the viewport resized each time; one desktop context, height 900). */
export async function phaseDSweep(page: Page, plan: PhaseDPlan, from: number, to: number): Promise<PhaseDSweep> {
  const t0 = Date.now();
  const failing: PhaseDSweep["failing"] = [];
  let measured = 0;
  for (let w = from; w <= to; w++) {
    await page.setViewportSize({ width: w, height: 900 });
    const c = geometryInstances(await phaseDScan(page, plan));
    measured += 1;
    if (c.length) failing.push({ w, codes: c });
  }
  return { failing, measured, ms: Date.now() - t0 };
}

/** Width ranges per code name of a sweep: { CODE: "320–340, 401" }. */
export function phaseDRanges(s: PhaseDSweep): Record<string, string> {
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

// ---------------------------------------------------------------- the three shops

export const PHASE_D_FEATURES = ["vertical", "rotation", "outline"] as const;
export type PhaseDFeature = (typeof PHASE_D_FEATURES)[number];
export const FEATURE_FLAG: Record<PhaseDFeature, keyof PhaseDOptions> = { vertical: "verticalText", rotation: "smallRotation", outline: "outlinedType" };

/** The plan for a shop: its facts and its name protected, the names (full and the h1's), one feature or all. */
export function shopPlanD(shop: ShopKey, features: PhaseDFeatures): PhaseDPlan {
  const { name, facts } = shopFacts(shop);
  return { protect: [name, ...Object.values(facts).filter((v) => v.length >= 2 && !/^[a-z_]+$/.test(v))], names: [name], features };
}

/**
 * Per shop and feature, CSS appended to the strict B page, written in the proposed grammar of that feature only (plus
 * the production allowlist). Decorative words and the name are the targets; facts are never touched.
 * - vertical (with a face both machines have for vertical CJK: VERTICAL_FACES): tsugute the section heading 線は、壊れ方をなぞる。 and the three big words 割れ・欠け・ひび; bicycle the
 *   big word まわる; sento the name ゆげ湯 (vertical_name's role) and the big words 熱い・冷たい.
 * - rotation: the board images (text-free) and one big word per shop, a few degrees (at 600 and below the images take
 *   0.8°: wider there, their corners reached the caption 8px below — phase C's check stopped it; bicycle's まわる 1.5°:
 *   at 256px a 3° turn swings its end past the reach bound).
 * - outline: a stroke on big words — opaque fill (tsugute 割れ…, bicycle まわる) and hollow (sento ぬるい, as C′ draws it).
 */
/**
 * The vertical words' faces: the shop's 明朝 first, then IPAGothic, a CJK face with vertical metrics that this container
 * and CI both have. With the shops' own `"IPAMincho", serif`, a machine without IPAMincho (CI) resolves serif to a Latin
 * face and draws the vertical CJK glyphs piled up at the foot of the column — the check stops that
 * (PHASE_D_VERTICAL_GLYPH_OVERLAP / _OVERFLOW; docs/design/phase-d-design.md §2.4).
 */
export const VERTICAL_FACES = '"IPAMincho", "IPAGothic", serif';

export const PHASE_D_CSS: Record<ShopKey, Record<PhaseDFeature, string>> = {
  tsugute: {
    vertical: [`.damage-h, .kanji { writing-mode: vertical-rl; font-family: ${VERTICAL_FACES}; }`].join("\n"),
    rotation: [
      ".shard-ware .board img { transform: rotate(-2.4deg); }",
      ".shard-kake .board img { transform: rotate(2.6deg); }",
      ".kanji { width: max-content; max-width: 100%; transform: rotate(-4deg); }",
      // at 600 and below the image is wider than its caption's 8px gap allows at 2.4° (phase C: the corner over the caption)
      "@media (max-width: 600px) { .shard-ware .board img { transform: rotate(-0.8deg); } .shard-kake .board img { transform: rotate(0.8deg); } }",
      // the 1px sweep found 欠け's turned corner past the right edge in a tablet band no checked width hits: no turn below 1024
      "@media (max-width: 1023px) { .kanji { transform: none; } }",
    ].join("\n"),
    outline: [".kanji { -webkit-text-stroke: 2px #b88a35; paint-order: stroke fill; }", "@media (max-width: 600px) { .kanji { -webkit-text-stroke-width: 1px; } }"].join("\n"),
  },
  bicycle: {
    vertical: [`.ghost-turn { writing-mode: vertical-rl; font-family: "IPAGothic", sans-serif; }`].join("\n"),
    rotation: [".st-a .pic img { transform: rotate(-3deg); }", ".st-c .pic img { transform: rotate(2deg); }", ".ghost-turn { width: max-content; max-width: 100%; transform: rotate(-1.5deg); transform-origin: left top; }", "@media (max-width: 600px) { .st-a .pic img { transform: rotate(-0.8deg); } .st-c .pic img { transform: rotate(0.8deg); } }"].join("\n"),
    outline: [".ghost-turn { -webkit-text-stroke: 3px #f2c230; paint-order: stroke fill; }"].join("\n"),
  },
  sento: {
    vertical: [`.name, .giant-hot, .giant-cold { writing-mode: vertical-rl; font-family: ${VERTICAL_FACES}; }`].join("\n"),
    rotation: [
      ".giant-warm { width: max-content; max-width: 100%; margin-top: 56px; transform: rotate(-3deg); }",
      // the 1px sweep found the turned photos past the right edge in two narrow bands (the tub 870–878, the small board
      // 1290–1294 here) that no checked width hits: they turn at 1300 and above, and 0.8° at 600 and below
      "@media (min-width: 1300px) { .board img { transform: rotate(-2deg); } }",
      "@media (max-width: 600px) { .board img { transform: rotate(-0.8deg); } }",
    ].join("\n"),
    outline: [".giant-warm { color: transparent; -webkit-text-stroke: 3px #3a1a0c; }", "@media (max-width: 600px) { .giant-warm { -webkit-text-stroke-width: 2px; } }"].join("\n"),
  },
};

const files = (dir: string) => new Map(readdirSync(join(dir, "assets")).filter((f) => f.endsWith(".png")).map((f) => [`assets/${f}`, readFileSync(join(dir, "assets", f))]));

/** The strict B page of a shop (viewport meta added, as nowrap-harness.ts strictPage does), with a phase D feature's CSS or none. */
export function phaseDPage(shop: ShopKey, feature: PhaseDFeature | "strict"): CompPage {
  const dir = join(POC, SHOPS[shop].strict);
  const html = readFileSync(join(dir, "index.html"), "utf8").replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  const base = readFileSync(join(dir, "style.css"), "utf8");
  const css = feature === "strict" ? base : `${base}\n${PHASE_D_CSS[shop][feature]}\n`;
  return { dir, html, css, assets: [], files: files(dir), htmlSha256: "", cssSha256: "" };
}

/** The C′ page of a shop (raw research HTML and CSS, outside the allowlist on purpose: measured only). */
export const cPrimePageD = (shop: ShopKey): CompPage => overlapPage(shop, "cprime");
