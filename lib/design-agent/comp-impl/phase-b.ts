import { z } from "zod";
import type { CheckResult } from "./checks";
import { widthRanges } from "./checks";
import { COMP_UI_LABELS } from "./spec";
import { gradientStopProblems } from "./verify";

// DEV-164: the render side of phase B (docs/design/phase-b-design.md §2, §2.9). The page CSS grammar is in page-css.ts,
// behind PageCssOptions; every flag is off unless the spec declares an APPROVED capability (spec.ts pageCssOptionsOf), and
// none is approved. The scripts run inside the checked page like ./layers.ts (plain JavaScript source text, no imports;
// the caller appends its JSON argument).
//
// With every flag off, the one code here that can refuse a page the allowlist accepts is TYPE_ABOVE_ROLE_CAP at 256px: it
// closes the gap the design records (§2.2: html { font-size: 256px } with 16rem text is 4096px). Every other code needs a
// declaration the allowlist refuses without its flag (white-space / keep-all, background-image, opacity < 1).

/** Computed font-size caps (px) per role: display words with display_scale, everything else (design §2.2). */
export const TYPE_ROLE_CAPS = { text: 256, display: 640 } as const;

/**
 * The display words: the shop name and the fixed UI labels (spec.ts COMP_UI_LABELS). An element is a display word only
 * when its whole text is exactly one of them, it holds no other element, and it is not inside a dt, a dd or the
 * disclosure (design §2.2: never a fact value, a disclaimer or an information pair). The set is fixed by code, not by the
 * spec: an author cannot widen it.
 */
export function displayWordsOf(shopName: string): string[] {
  return [...new Set([shopName, ...COMP_UI_LABELS].map((w) => w.replace(/\s+/g, "")).filter(Boolean))];
}

/**
 * One width. Argument: { display (display words, whitespace-free), displayCap (true: display words may reach 640px),
 * words (true: count display words broken across lines) }.
 *
 * - type: every non-blank text node in the body, at its parent's COMPUTED font-size (px; rem, em, % and the root size
 *   resolved): above 256px, or above 640px for a display word with displayCap, is a cap violation.
 * - nowrap: a text node whose parent computes white-space nowrap / pre (text-wrap-mode nowrap) or word-break keep-all
 *   (inherited values count) and is not a display word.
 * - words: a display word's run (between spaces) drawn on more than one line.
 * - grounds: every element with a background-image; it must hold no text (no text node, no aria-label) and its border box
 *   (its paint extent: phase B adds no outset paint, §2.9) must meet no text line box. Each gradient is returned parsed
 *   for the stop rule (verify.ts gradientStopProblems).
 * - translucent: every element with opacity < 1; it must hold no text, and its paint extent (its box and every
 *   descendant's) must meet no text line box.
 */
export const PHASE_B_SCRIPT = String.raw`(arg) => {
  const flat = (s) => (s || "").replace(/\s+/g, "");
  const display = new Set(arg.display || []);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const colour = (css) => {
    // the same string after two different sentinels: a colour the canvas parses (any CSS colour, converted to sRGB)
    ctx.fillStyle = "#010203";
    ctx.fillStyle = css;
    const a = ctx.fillStyle;
    ctx.fillStyle = "#040506";
    ctx.fillStyle = css;
    if (ctx.fillStyle !== a) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };
  const meets = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const rectOf = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const isDisplay = (el) => el.children.length === 0 && display.has(flat(el.textContent)) && !el.closest("dt, dd, [data-comp-disclosure]");
  const textInside = (el) => Boolean(flat(el.textContent)) || [el].concat(Array.from(el.querySelectorAll("*"))).some((d) => (d.getAttribute("aria-label") || "").trim() !== "");
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.parentElement && flat(n.data)) texts.push(n);
  const lineRects = (node) => { const r = document.createRange(); r.selectNodeContents(node); return Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5).map(rectOf); };
  const allLines = texts.flatMap(lineRects);
  const snippet = (s) => flat(s).slice(0, 24);

  // type caps and nowrap
  const type = { max: 0, above: 0, list: [] };
  let nowrapNotDisplay = 0;
  const nowrapList = [];
  for (const n of texts) {
    const el = n.parentElement;
    const s = getComputedStyle(el);
    const px = parseFloat(s.fontSize) || 0;
    const disp = isDisplay(el);
    const cap = disp && arg.displayCap ? ${TYPE_ROLE_CAPS.display} : ${TYPE_ROLE_CAPS.text};
    type.max = Math.max(type.max, px);
    if (px > cap + 0.01) {
      type.above += 1;
      if (type.list.length < 8) type.list.push({ px: Math.round(px * 100) / 100, cap, display: disp, text: snippet(n.data) });
    }
    const nowrap = s.textWrapMode === "nowrap" || s.whiteSpace === "nowrap" || s.whiteSpace === "pre" || s.wordBreak === "keep-all";
    if (nowrap && !disp) {
      nowrapNotDisplay += 1;
      if (nowrapList.length < 8) nowrapList.push(snippet(n.data));
    }
  }

  // display words broken inside a run
  const broken = [];
  if (arg.words) {
    for (const n of texts) {
      if (!isDisplay(n.parentElement)) continue;
      const t = n.data;
      const re = /\S+/g;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const tops = [];
        for (let i = m.index; i < m.index + m[0].length; i++) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const b = Array.from(r.getClientRects()).find((x) => x.width > 0.5 && x.height > 0.5);
          if (!b) continue;
          if (!tops.some((y) => Math.abs(y.top - b.top) < Math.min(y.height, b.height) / 2)) tops.push({ top: b.top, height: b.height });
        }
        if (tops.length > 1 && broken.length < 8) broken.push(m[0].slice(0, 24));
      }
    }
  }

  // grounds (background-image) and translucent boxes
  const els = [document.documentElement, document.body].concat(Array.from(document.body.querySelectorAll("*")));
  const grounds = { hasText: 0, underText: 0, list: [] };
  const gradients = [];
  const translucent = { hasText: 0, underText: 0, count: 0 };
  const split = (s) => {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const c of s) {
      if (c === "(") depth += 1;
      if (c === ")") depth -= 1;
      if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const parseGradient = (value, box) => {
    const m = /^(linear|radial)-gradient\((.*)\)$/.exec(value.trim());
    if (!m) return { kind: "unknown", config: null, w: box.width, h: box.height, stops: [] };
    const groups = split(m[2]);
    let config = null;
    if (groups.length > 0 && colour(groups[0]) === null && colour(groups[0].replace(/\s+-?[\d.]+%$/, "")) === null) config = groups.shift();
    const stops = groups.map((g) => {
      const pm = /^(.*\S)\s+(-?[\d.]+)%$/.exec(g);
      const c = colour(pm ? pm[1] : g);
      return { rgb: c ? [c[0], c[1], c[2]] : null, pct: pm ? Number(pm[2]) : null };
    });
    return { kind: m[1], config, w: box.width, h: box.height, stops };
  };
  for (const el of els) {
    const s = getComputedStyle(el);
    if (s.display === "none") continue;
    if (s.backgroundImage && s.backgroundImage !== "none") {
      const box = el.getBoundingClientRect();
      if (textInside(el)) grounds.hasText += 1;
      else if (allLines.some((r) => meets(r, rectOf(box)))) grounds.underText += 1;
      if (grounds.list.length < 8) grounds.list.push(el.tagName.toLowerCase());
      for (const g of split(s.backgroundImage)) if (gradients.length < 40) gradients.push(parseGradient(g, box));
    }
    if (Number(s.opacity) < 1) {
      translucent.count += 1;
      if (textInside(el)) { translucent.hasText += 1; continue; }
      const extent = [el].concat(Array.from(el.querySelectorAll("*"))).map((d) => rectOf(d.getBoundingClientRect())).filter((r) => r.right - r.left > 0 || r.bottom - r.top > 0);
      if (extent.some((x) => allLines.some((r) => meets(r, x)))) translucent.underText += 1;
    }
  }
  return { type, nowrap: { notDisplay: nowrapNotDisplay, list: nowrapList }, broken, grounds, gradients, translucent };
}`;

const Rgb = z.tuple([z.number(), z.number(), z.number()]);
export const PhaseBSchema = z.strictObject({
  type: z.strictObject({ max: z.number(), above: z.number().int().nonnegative(), list: z.array(z.strictObject({ px: z.number(), cap: z.number(), display: z.boolean(), text: z.string().max(24) })).max(8) }),
  nowrap: z.strictObject({ notDisplay: z.number().int().nonnegative(), list: z.array(z.string().max(24)).max(8) }),
  broken: z.array(z.string().max(24)).max(8),
  grounds: z.strictObject({ hasText: z.number().int().nonnegative(), underText: z.number().int().nonnegative(), list: z.array(z.string().max(16)).max(8) }),
  gradients: z.array(z.strictObject({ kind: z.enum(["linear", "radial", "unknown"]), config: z.string().max(200).nullable(), w: z.number(), h: z.number(), stops: z.array(z.strictObject({ rgb: Rgb.nullable(), pct: z.number().nullable() })).max(64) })).max(40),
  translucent: z.strictObject({ hasText: z.number().int().nonnegative(), underText: z.number().int().nonnegative(), count: z.number().int().nonnegative() }),
});
export type PhaseBScan = z.infer<typeof PhaseBSchema>;
export type Gradient = PhaseBScan["gradients"][number];

/**
 * A lower bound of the gradient line's length (px): exact for a side or an angle, min(w, h) for a corner (the line is never
 * shorter: |w·sin a| + |h·cos a| ≥ min(w, h)), min(w, h) / 2 for a radial gradient (its ray is never shorter). A shorter
 * line only makes the stop rule stricter. null: a direction this does not know (the gradient is not measured).
 */
export function gradientLineLength(g: Pick<Gradient, "kind" | "config" | "w" | "h">): number | null {
  const { w, h } = g;
  if (g.kind === "radial") return g.config === null || /^(circle|ellipse)$/.test(g.config.trim()) ? Math.min(w, h) / 2 : null;
  if (g.kind !== "linear") return null;
  const c = (g.config ?? "to bottom").trim();
  if (c === "to bottom" || c === "to top") return h;
  if (c === "to left" || c === "to right") return w;
  if (/^to (top|bottom) (left|right)$/.test(c) || /^to (left|right) (top|bottom)$/.test(c)) return Math.min(w, h);
  const m = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(c);
  if (!m) return null;
  const deg = Number(m[1]) * ({ deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 } as const)[m[2] as "deg" | "turn" | "rad" | "grad"];
  const a = (deg * Math.PI) / 180;
  return Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
}

/** The stops' positions in px along the line (CSS Images 3 fix-up: first 0 %, last 100 %, never backwards, gaps evenly). */
export function stopPositions(pcts: ReadonlyArray<number | null>, length: number): number[] {
  const p = [...pcts];
  if (p.length === 0) return [];
  if (p[0] === null) p[0] = 0;
  if (p[p.length - 1] === null) p[p.length - 1] = 100;
  let max = -Infinity;
  for (let i = 0; i < p.length; i++) if (p[i] !== null) p[i] = max = Math.max(max, p[i]!);
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== null) continue;
    let j = i;
    while (p[j] === null) j++;
    const a = p[i - 1]!;
    const b = p[j]!;
    for (let k = i; k < j; k++) p[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return p.map((x) => (x! / 100) * length);
}

/** The stop rule of V3b for one parsed gradient (GRADIENT_UNMEASURED when it cannot be measured: fail closed). */
export function gradientProblems(g: Gradient): string[] {
  const length = gradientLineLength(g);
  if (length === null || g.stops.length < 2 || g.stops.some((s) => s.rgb === null)) return ["GRADIENT_UNMEASURED"];
  if (length <= 0) return [];
  const at = stopPositions(g.stops.map((s) => s.pct), length);
  return gradientStopProblems(
    g.stops.map((s, i) => ({ at: at[i]!, rgb: s.rgb! })),
    length,
  );
}

/** The codes of one width's scan. */
export function phaseBCodes(scan: PhaseBScan): string[] {
  const codes = new Set<string>();
  if (scan.type.above > 0) codes.add("TYPE_ABOVE_ROLE_CAP");
  if (scan.nowrap.notDisplay > 0) codes.add("NOWRAP_NOT_DISPLAY");
  if (scan.broken.length > 0) codes.add("DISPLAY_WORD_BROKEN");
  if (scan.grounds.hasText > 0) codes.add("GROUND_HAS_TEXT");
  if (scan.grounds.underText > 0) codes.add("GROUND_UNDER_TEXT");
  if (scan.translucent.hasText > 0) codes.add("TRANSLUCENT_HAS_TEXT");
  if (scan.translucent.underText > 0) codes.add("TRANSLUCENT_UNDER_TEXT");
  for (const g of scan.gradients) for (const c of gradientProblems(g)) codes.add(c);
  return [...codes].sort();
}

/** The 1 px display sweep's result (render.ts displaySweepPass); null when no display capability is on. */
export type DisplaySweep = { failing: Array<{ w: number; codes: string[] }>; targets: number; ms: number; blocked: number };

/**
 * Phase B over every measured width (the checked widths, desktop and phone emulation, and the 32 px sweep) and the 1 px
 * display sweep. A width without a scan is PHASE_B_UNMEASURED (fail closed). Blocking: it goes into run.ts `checks`.
 */
export function phaseBCheck(widths: ReadonlyArray<{ width: number; phaseB?: PhaseBScan }>, sweep: DisplaySweep | null = null): CheckResult {
  const failing = widths.map((w) => ({ width: w.width, codes: w.phaseB ? phaseBCodes(w.phaseB) : ["PHASE_B_UNMEASURED"] })).filter((w) => w.codes.length > 0);
  const codes = [...failing.flatMap((w) => w.codes), ...(sweep?.failing.flatMap((f) => f.codes) ?? [])];
  const list = [...new Set(codes)].sort();
  const above = widths.flatMap((w) => w.phaseB?.type.list ?? []).slice(0, 8);
  return {
    ok: list.length === 0,
    codes: list,
    widths: widths.length,
    failing_widths: failing.map((w) => w.width),
    max_font_px: Math.max(0, ...widths.map((w) => w.phaseB?.type.max ?? 0)),
    above_cap: above,
    display_sweep: sweep ? { targets: sweep.targets, ms: sweep.ms, failing: widthRanges(sweep.failing.map((f) => f.w)) } : null,
  };
}

/**
 * The 1 px display sweep (design §2.8: display_nowrap and display_scale): at every width in [from, to] (the root's width
 * stepped like GEOMETRY_SCRIPT when `step`, else the caller resized the viewport), every display word's line boxes must stay
 * inside its box (the nearest non-inline ancestor) and the page, the box must not scroll (DISPLAY_OUT_OF_BOX,
 * DISPLAY_OFFSCREEN), and no run of it may break across lines (DISPLAY_WORD_BROKEN).
 * Argument: { display, from, to, step }.
 */
export const DISPLAY_SWEEP_SCRIPT = String.raw`(arg) => {
  const flat = (s) => (s || "").replace(/\s+/g, "");
  const display = new Set(arg.display || []);
  const targets = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !flat(n.data) || el.children.length !== 0 || !display.has(flat(el.textContent)) || el.closest("dt, dd, [data-comp-disclosure]")) continue;
    let box = el;
    while (box.parentElement && ["inline", "contents"].includes(getComputedStyle(box).display)) box = box.parentElement;
    targets.push({ n, el, box });
  }
  const html = document.documentElement;
  const saved = html.getAttribute("style");
  const step = arg.step !== false;
  if (step) {
    html.style.setProperty("min-width", "0", "important");
    html.style.setProperty("max-width", "none", "important");
    html.style.setProperty("margin-left", "0", "important");
    html.style.setProperty("margin-right", "0", "important");
  }
  const lines = (node) => { const r = document.createRange(); r.selectNodeContents(node); return Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5); };
  const brokenRun = (n) => {
    const re = /\S+/g;
    for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
      const tops = [];
      for (let i = m.index; i < m.index + m[0].length; i++) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const b = Array.from(r.getClientRects()).find((x) => x.width > 0.5 && x.height > 0.5);
        if (!b) continue;
        if (!tops.some((y) => Math.abs(y.top - b.top) < Math.min(y.height, b.height) / 2)) tops.push({ top: b.top, height: b.height });
      }
      if (tops.length > 1) return true;
    }
    return false;
  };
  const out = [];
  for (let w = arg.from; w <= arg.to; w++) {
    if (step) html.style.setProperty("width", w + "px", "important");
    const codes = new Set();
    for (const t of targets) {
      const bb = t.box.getBoundingClientRect();
      if (t.box.scrollWidth > t.box.clientWidth + 1 || t.box.scrollHeight > t.box.clientHeight + 1) codes.add("DISPLAY_OUT_OF_BOX");
      for (const r of lines(t.n)) {
        if (r.left < bb.left - 1 || r.right > bb.right + 1 || r.top < bb.top - 1 || r.bottom > bb.bottom + 1) codes.add("DISPLAY_OUT_OF_BOX");
        if (r.left < -0.5 || r.right > w + 0.5) codes.add("DISPLAY_OFFSCREEN");
      }
      if (brokenRun(t.n)) codes.add("DISPLAY_WORD_BROKEN");
    }
    if (codes.size) out.push({ w, codes: Array.from(codes).sort() });
  }
  if (step) {
    if (saved === null) html.removeAttribute("style");
    else html.setAttribute("style", saved);
  }
  return { targets: targets.length, failing: out };
}`;
export const DisplaySweepSchema = z.strictObject({
  targets: z.number().int().nonnegative(),
  failing: z.array(z.strictObject({ w: z.number().int(), codes: z.array(z.string().max(40)).max(8) })).max(2000),
});
