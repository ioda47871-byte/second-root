import { z } from "zod";

// Code that runs inside the checked page (DEV-072), kept as plain JavaScript
// source text for the reason given in ../page-scripts.ts: tsx's keepNames
// would wrap named functions in a __name() helper the page does not have.
// Plain ES2020, no TypeScript syntax, no imports, no closures over Node values.
// Each script is a function expression; the caller appends its JSON argument.

/**
 * Measures a page for the shop-CSS render check. Fact text nodes are the text
 * nodes inside the scope root (#shop-css; on the baseline page, the canvas) that are not aria-hidden and whose
 * text is part of a fact. For each, in document order: whether it is laid out,
 * inside the viewport horizontally, clipped by an ancestor, covered by another
 * element (elementFromPoint, with the line scrolled to the viewport's middle),
 * its opacity product, its effective font size (transform scales included),
 * whether its lines are squeezed, its colour, and its line boxes in page
 * coordinates. Marks each fact's element with data-sr-fact (for the contrast
 * screenshot). Also the notice bar and the footer: their boxes, styles and
 * whether anything covers them.
 */
export const MEASURE_SCRIPT = String.raw`(arg) => {
  const facts = arg.facts.map((f) => f.replace(/\s+/g, ""));
  const scoped = document.getElementById("shop-css");
  const noticeEl = document.querySelector('[role="note"]');
  // the baseline page has no scope root: its canvas is the frame's child that is neither the notice, the footer nor a style
  const root = scoped || (noticeEl && noticeEl.parentElement ? Array.from(noticeEl.parentElement.children).find((c) => c !== noticeEl && c.tagName !== "FOOTER" && c.tagName !== "STYLE") : null);
  const out = { scope: Boolean(scoped && scoped.hasAttribute("data-shop-css")), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, height: document.documentElement.scrollHeight, nodes: [], present: [], notice: null, footer: null, noticeCovered: false, footerCovered: false };
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const pick = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      box: { left: r.left, top: r.top + scrollY, width: r.width, height: r.height },
      style: [s.backgroundColor, s.color, s.fontSize, s.fontWeight, s.lineHeight, s.paddingTop, s.paddingBottom, s.borderBottomWidth, s.position, s.opacity, s.visibility, s.display, s.transform, s.zIndex].join("|"),
    };
  };
  const notice = document.querySelector('[role="note"]');
  const footer = document.querySelector("footer");
  out.notice = pick(notice);
  out.footer = pick(footer);
  const within = (el, x, y) => {
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === el || el.contains(hit)));
  };
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  if (notice) {
    for (const y of [0, maxScroll / 2, maxScroll]) {
      scrollTo(0, y);
      const r = notice.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy > innerHeight) continue;
      for (const x of [r.left + 4, r.left + r.width / 2, r.right - 4]) if (!within(notice, x, cy)) out.noticeCovered = true;
    }
  }
  if (footer) {
    footer.scrollIntoView({ block: "center" });
    const r = footer.getBoundingClientRect();
    for (const y of [r.top + 4, r.top + r.height / 2, r.bottom - 4])
      for (const x of [r.left + 8, r.left + r.width / 2, r.right - 8]) if (y >= 0 && y <= innerHeight && !within(footer, x, y)) out.footerCovered = true;
  }
  scrollTo(0, 0);
  if (!root) return out;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let joined = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.data.replace(/\s+/g, "");
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest('[aria-hidden="true"]')) continue;
    if (!facts.some((f) => f.includes(text))) continue;
    nodes.push(n);
    joined += text;
  }
  out.present = facts.map((f) => joined.includes(f));

  const lineRects = (n) => {
    const range = document.createRange();
    range.selectNodeContents(n);
    return Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
  };
  for (const n of nodes) {
    const el = n.parentElement;
    el.setAttribute("data-sr-fact", "");
    const s = getComputedStyle(el);
    let opacity = 1;
    let scale = 1;
    let hiddenByAncestor = false;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const as = getComputedStyle(a);
      opacity *= Number(as.opacity);
      if (as.visibility !== "visible" || as.display === "none") hiddenByAncestor = true;
      const m = as.transform && as.transform !== "none" ? new DOMMatrixReadOnly(as.transform) : null;
      if (m) scale *= Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    }
    const fontSize = parseFloat(s.fontSize) * scale;
    const rects = lineRects(n);
    const vertical = s.writingMode.startsWith("vertical") || s.writingMode.startsWith("sideways");
    const node = {
      text: n.data.trim().slice(0, 80),
      hidden: rects.length === 0 || hiddenByAncestor,
      offscreen: false,
      clipped: false,
      covered: false,
      opacity,
      fontSize,
      large: fontSize >= 24 || (fontSize >= 18.66 && Number(s.fontWeight) >= 700),
      squeezed: rects.length >= 3 && rects.every((r) => (vertical ? r.height : r.width) < fontSize * 2.5),
      color: rgba(s.color),
      rects: rects.slice(0, 12).map((r) => ({ left: r.left, top: r.top + scrollY, width: r.width, height: r.height })),
    };
    for (const r of rects) {
      if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top + scrollY < -0.5) node.offscreen = true;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const as = getComputedStyle(a);
        if (as.overflowX === "visible" && as.overflowY === "visible" && as.clipPath === "none") continue;
        const b = a.getBoundingClientRect();
        if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) node.clipped = true;
      }
    }
    // hit-testing, each line in the middle of the viewport (the sticky notice is at the top)
    for (let i = 0; i < Math.min(rects.length, 6); i++) {
      const before = lineRects(n)[i];
      if (!before) continue;
      scrollTo(0, Math.max(0, before.top + scrollY - innerHeight / 2));
      const r = lineRects(n)[i];
      if (!r) continue;
      const cy = r.top + r.height / 2;
      const xs = r.width > 8 ? [r.left + 2, r.left + r.width / 2, r.right - 2] : [r.left + r.width / 2];
      for (const x of xs) {
        if (x < 0 || x > innerWidth || cy < 0 || cy > innerHeight) continue;
        const hit = document.elementFromPoint(x, cy);
        if (!hit || hit === el) continue;
        // a transparent decoration over the text (no ground, the point not on its border) does not hide it
        if (hit instanceof HTMLElement && !hit.contains(el)) {
          const hs = getComputedStyle(hit);
          const hb = hit.getBoundingClientRect();
          const inside = x > hb.left + parseFloat(hs.borderLeftWidth) && x < hb.right - parseFloat(hs.borderRightWidth) && cy > hb.top + parseFloat(hs.borderTopWidth) && cy < hb.bottom - parseFloat(hs.borderBottomWidth);
          if (rgba(hs.backgroundColor)[3] === 0 && hs.backgroundImage === "none" && hs.boxShadow === "none" && inside && !hit.innerText.trim()) continue;
        }
        node.covered = true;
      }
    }
    out.nodes.push(node);
  }
  scrollTo(0, 0);
  return out;
}`;

const Box = z.strictObject({ left: z.number(), top: z.number(), width: z.number(), height: z.number() });
const FramePart = z.strictObject({ box: Box, style: z.string().max(2000) }).nullable();

export const MeasureSchema = z.strictObject({
  scope: z.boolean(),
  overflow: z.number(),
  height: z.number().nonnegative(),
  present: z.array(z.boolean()).max(200),
  notice: FramePart,
  footer: FramePart,
  noticeCovered: z.boolean(),
  footerCovered: z.boolean(),
  nodes: z
    .array(
      z.strictObject({
        text: z.string().max(200),
        hidden: z.boolean(),
        offscreen: z.boolean(),
        clipped: z.boolean(),
        covered: z.boolean(),
        opacity: z.number(),
        fontSize: z.number(),
        large: z.boolean(),
        squeezed: z.boolean(),
        color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        rects: z.array(Box).max(12),
      }),
    )
    .max(2000),
});
export type Measure = z.infer<typeof MeasureSchema>;

/** Makes the fact text transparent (and nothing else), so a screenshot shows the ground actually painted under it. */
export const HIDE_FACT_TEXT_CSS = "[data-sr-fact], [data-sr-fact] * { -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }";

/** For hit-testing: decorations that opt out of pointer events still count as covering text. */
export const HIT_TEST_CSS = "body * { pointer-events: auto !important; }";

/** Every animation and transition at its end state (motion is not part of the check). */
export const FREEZE_MOTION_CSS = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }";
