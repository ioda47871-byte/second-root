import { z } from "zod";

// Code that runs inside the checked page (DEV-072), kept as plain JavaScript
// source text for the reason given in ../page-scripts.ts: tsx's keepNames
// would wrap named functions in a __name() helper the page does not have.
// Plain ES2020, no TypeScript syntax, no imports, no closures over Node values.
// Each script is a function expression; the caller appends its JSON argument.

/**
 * Measures a page for the shop-CSS render check. Every text that must stay
 * readable is a node, in document order, of one of four kinds:
 *   fact    text inside the scope root (#shop-css; on the baseline page, the
 *           canvas) that is part of a fact
 *   label   any other text there that is not aria-hidden (headings, row labels,
 *           the folio): a value without its label can change meaning
 *   notice  the text of the notice bar
 *   footer  the text of the footer notice
 * For each: whether it is laid out, inside the viewport horizontally, clipped by
 * an ancestor, covered by another element (elementFromPoint at 15 points of
 * each line, the line scrolled to the viewport's middle; text on text is the
 * overlap check in render-check.ts), its opacity product, its effective font size
 * (transform scales included), whether its lines are squeezed, its colour, its
 * line boxes and the box of each of its visible characters (page coordinates,
 * for the pixel proof). Marks each node's element with data-sr-text (for the
 * screenshot with the text made transparent). Also the boxes and styles of the
 * notice bar and the footer, whether anything covers them, and the number of
 * script elements (there must be none).
 */
export const MEASURE_SCRIPT = String.raw`(arg) => {
  const facts = arg.facts.map((f) => f.replace(/\s+/g, ""));
  const scoped = document.getElementById("shop-css");
  const notice = document.querySelector('[role="note"]');
  const footer = document.querySelector("footer");
  // the baseline page has no scope root: its canvas is the frame's child that is neither the notice, the footer nor a style
  const root = scoped || (notice && notice.parentElement ? Array.from(notice.parentElement.children).find((c) => c !== notice && c.tagName !== "FOOTER" && c.tagName !== "STYLE") : null);
  const out = { scope: Boolean(scoped && scoped.hasAttribute("data-shop-css")), scripts: document.querySelectorAll("script").length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, height: document.documentElement.scrollHeight, nodes: [], present: [], notice: null, footer: null, noticeCovered: false, footerCovered: false };
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
  // anything an element paints itself: a ground, an image, a shadow, a border or an outline
  const painted = (s) =>
    rgba(s.backgroundColor)[3] > 0 ||
    s.backgroundImage !== "none" ||
    s.boxShadow !== "none" ||
    ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none" && rgba(s["border" + side + "Color"])[3] > 0) ||
    (parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== "none" && rgba(s.outlineColor)[3] > 0);
  const pick = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      box: { left: r.left, top: r.top + scrollY, width: r.width, height: r.height },
      style: [s.backgroundColor, s.color, s.fontSize, s.fontWeight, s.lineHeight, s.paddingTop, s.paddingBottom, s.borderBottomWidth, s.position, s.opacity, s.visibility, s.display, s.transform, s.zIndex].join("|"),
    };
  };
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

  const collect = (container, kind) => {
    const list = [];
    if (!container) return list;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.data.replace(/\s+/g, "");
      if (!text) continue;
      const el = n.parentElement;
      if (!el || el.closest('[aria-hidden="true"]') || el.closest("style, script")) continue;
      if (kind === "scope") list.push({ n, kind: facts.some((f) => f.includes(text)) ? "fact" : "label" });
      else list.push({ n, kind });
    }
    return list;
  };
  const items = [...collect(notice, "notice"), ...collect(root, "scope"), ...collect(footer, "footer")];
  const joined = items.filter((i) => i.kind === "fact").map((i) => i.n.data.replace(/\s+/g, "")).join("");
  out.present = facts.map((f) => joined.includes(f));

  const lineRects = (n) => {
    const range = document.createRange();
    range.selectNodeContents(n);
    return Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
  };
  const charRects = (n) => {
    const boxes = [];
    const range = document.createRange();
    const data = n.data;
    for (let i = 0; i < data.length && boxes.length < 240; i++) {
      const code = data.charCodeAt(i);
      const end = code >= 0xd800 && code <= 0xdbff && i + 1 < data.length ? i + 2 : i + 1;
      const ch = data.slice(i, end);
      const start = i;
      i = end - 1;
      if (/\s/.test(ch)) continue;
      range.setStart(n, start);
      range.setEnd(n, end);
      for (const r of Array.from(range.getClientRects())) if (r.width > 0.5 && r.height > 0.5) boxes.push({ left: r.left, top: r.top + scrollY, width: r.width, height: r.height });
    }
    return boxes;
  };
  // mark every measured element first: hit-testing below needs to know them all
  for (const item of items) item.n.parentElement.setAttribute("data-sr-text", "");
  for (const item of items) {
    const n = item.n;
    const el = n.parentElement;
    el.setAttribute("data-sr-text", "");
    if (!el.hasAttribute("data-sr-i")) el.setAttribute("data-sr-i", String(out.nodes.length));
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
      kind: item.kind,
      owner: Number(el.getAttribute("data-sr-i")),
      text: n.data.trim().slice(0, 80),
      hidden: rects.length === 0 || hiddenByAncestor,
      offscreen: false,
      clipped: false,
      covered: false,
      opacity,
      fontSize,
      vertical,
      squeezed: rects.length >= 3 && rects.every((r) => (vertical ? r.height : r.width) < fontSize * 2.5),
      color: rgba(s.color),
      rects: rects.slice(0, 12).map((r) => ({ left: r.left, top: r.top + scrollY, width: r.width, height: r.height })),
      chars: charRects(n),
      overflow: false,
    };
    // the text must stay inside its own box: the nearest element around it that is a box of its own
    // (not inline): a block, a grid or flex item (re-review 3: nowrap text spilled out of its grid track)
    // loose text in a grid or flex container sits in an anonymous item whose box (a track) cannot be
    // measured: it counts as out of its box (the guard allows grid / flex only on text-free elements)
    if (/(^|-)(grid|flex)$/.test(s.display)) node.overflow = true;
    let box = el;
    while (box.parentElement && ["inline", "contents"].includes(getComputedStyle(box).display)) box = box.parentElement;
    const bb = box.getBoundingClientRect();
    // the glyph's core across the line (a fallback face's ascent and descent may reach past a tight
    // line box with nothing drawn there; the same core as the overlap check), its full advance along it
    for (const c of node.chars) {
      const dx = vertical ? c.width * 0.2 : 0;
      const dy = vertical ? 0 : c.height * 0.2;
      const top = c.top - scrollY + dy;
      if (c.left + dx < bb.left - 1 || c.left + c.width - dx > bb.right + 1 || top < bb.top - 1 || top + c.height - 2 * dy > bb.bottom + 1) node.overflow = true;
    }
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
      if (item.kind !== "notice") scrollTo(0, Math.max(0, before.top + scrollY - innerHeight / 2));
      const r = lineRects(n)[i];
      if (!r) continue;
      // 30 %, 50 % and 70 % of the line's height (inside the glyphs' core: tight leading only overlaps
      // the empty ascender / descender space), five points across (a cover over part of a line is still a cover)
      const xs = r.width > 8 ? [r.left + 2, r.left + r.width * 0.25, r.left + r.width / 2, r.left + r.width * 0.75, r.right - 2] : [r.left + r.width / 2];
      for (const [x, cy] of xs.flatMap((x) => [0.3, 0.5, 0.7].map((f) => [x, r.top + r.height * f]))) {
        if (x < 0 || x > innerWidth || cy < 0 || cy > innerHeight) continue;
        const hit = document.elementFromPoint(x, cy);
        if (!hit || hit === el) continue;
        // another measured text with no ground of its own (tight leading: its line box reaches into this
        // one): text on text is the overlap check's (render-check.ts), a ground over text is a cover here
        if (hit instanceof HTMLElement && hit.hasAttribute("data-sr-text") && !hit.contains(el) && !painted(getComputedStyle(hit)) && !painted(getComputedStyle(hit, "::before")) && !painted(getComputedStyle(hit, "::after"))) continue;
        // a transparent decoration over the text (no ground of its own nor of its ::before / ::after,
        // the point not on its border, no text) does not hide it; the pixel proof checks the rest
        if (hit instanceof HTMLElement && !hit.contains(el)) {
          const hs = getComputedStyle(hit);
          const hb = hit.getBoundingClientRect();
          const inside = x > hb.left + parseFloat(hs.borderLeftWidth) && x < hb.right - parseFloat(hs.borderRightWidth) && cy > hb.top + parseFloat(hs.borderTopWidth) && cy < hb.bottom - parseFloat(hs.borderBottomWidth);
          if (!painted(hs) && !painted(getComputedStyle(hit, "::before")) && !painted(getComputedStyle(hit, "::after")) && inside && !hit.innerText.trim()) continue;
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

export const TEXT_KINDS = ["fact", "label", "notice", "footer"] as const;

export const MeasureSchema = z.strictObject({
  scope: z.boolean(),
  scripts: z.number().int().nonnegative(),
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
        kind: z.enum(TEXT_KINDS),
        /** The index of the first node of the same element (the element the reference styles). */
        owner: z.number().int().nonnegative(),
        text: z.string().max(200),
        hidden: z.boolean(),
        offscreen: z.boolean(),
        clipped: z.boolean(),
        covered: z.boolean(),
        opacity: z.number(),
        fontSize: z.number(),
        vertical: z.boolean(),
        squeezed: z.boolean(),
        /** A character lies outside the node's own box (block, grid or flex item). */
        overflow: z.boolean(),
        color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        rects: z.array(Box).max(12),
        chars: z.array(Box).max(480),
      }),
    )
    .max(2000),
});
export type Measure = z.infer<typeof MeasureSchema>;

/** Makes the measured text and its decoration lines transparent (and nothing else), so a screenshot shows the ground actually painted under it. */
export const HIDE_TEXT_CSS = "[data-sr-text], [data-sr-text] * { -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }";

/**
 * The reference picture for the pixel proof: the same layout (nothing here
 * changes a box), with every paint other than the measured text taken away —
 * no ground, border, shadow, outline or decoration line, no pseudo-element, no
 * image or SVG, every other text transparent. REFERENCE_SCRIPT then gives each
 * element with measured text its own text colour (currentcolor) and, as an opaque ground,
 * the colour actually painted under it on the page: the text is rasterized
 * exactly as on the page (same face, synthesis, size, transform, colour and
 * ground, so the same antialiasing, LCD or greyscale), only nothing covers it.
 */
export const CLEAN_CSS = "html, body { background: #fff !important; } *, *::before, *::after { background: none !important; background-color: transparent !important; box-shadow: none !important; border-color: transparent !important; outline-color: transparent !important; text-decoration-color: transparent !important; text-shadow: none !important; column-rule-color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; } *::before, *::after, svg, img, video, canvas, iframe { visibility: hidden !important; }";

/** Sets, per measured element (data-sr-i), an inline ground and text colour that win over CLEAN_CSS. */
export const REFERENCE_SCRIPT = String.raw`(list) => {
  for (const r of list) {
    const el = document.querySelector('[data-sr-i="' + r.i + '"]');
    if (!el) continue;
    if (r.bg !== null) {
      el.style.setProperty("background-color", r.bg, "important");
      el.style.setProperty("background-image", "none", "important");
    }
    el.style.setProperty("-webkit-text-fill-color", r.fill, "important");
  }
  return true;
}`;

/** For hit-testing: decorations that opt out of pointer events still count as covering text. */
export const HIT_TEST_CSS = "body * { pointer-events: auto !important; }";

/** Every animation and transition at its end state (motion is not part of the check). */
export const FREEZE_MOTION_CSS = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }";

/**
 * The page's container-query switches (DEV-071b: the split visit's rows switch
 * at 26em of their own width). For every container (container-type other than
 * normal) and every width condition of a @container rule, how far the
 * container's inline size is from the condition's length, in px (positive:
 * wider). A shop stylesheet cannot write @container or container-type, but it
 * can change the width a container gets, and so the viewport width where a
 * switch happens; the render check finds those widths from these distances.
 */
export const CONTAINER_SCRIPT = String.raw`() => {
  const lengths = [];
  const visit = (rules) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === 12 || rule.type === 4) {
        visit(rule.cssRules);
        continue;
      }
      if (rule.constructor && rule.constructor.name === "CSSContainerRule") {
        for (const m of String(rule.conditionText || "").matchAll(/(?:min|max)-width\s*:\s*([0-9.]+)(px|em|rem)/g)) lengths.push({ v: Number(m[1]), unit: m[2] });
        visit(rule.cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch (e) {
      // a sheet that cannot be read has no container rules of ours
    }
  }
  const out = [];
  if (lengths.length === 0) return out;
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const s = getComputedStyle(el);
    if (!s.containerType || s.containerType === "normal") continue;
    const vertical = s.writingMode.startsWith("vertical");
    const r = el.getBoundingClientRect();
    const inline = (vertical ? r.height : r.width) - parseFloat(vertical ? s.paddingTop : s.paddingLeft) - parseFloat(vertical ? s.paddingBottom : s.paddingRight) - parseFloat(vertical ? s.borderTopWidth : s.borderLeftWidth) - parseFloat(vertical ? s.borderBottomWidth : s.borderRightWidth);
    const em = parseFloat(s.fontSize) || 16;
    for (const l of lengths) out.push(inline - l.v * (l.unit === "px" ? 1 : l.unit === "rem" ? root : em));
  }
  return out;
}`;
