import { z } from "zod";

// DEV-083 phase A (docs/design/dev-083-expressive-safe-reproduction.md §2, §7): verification only. These scripts run inside
// the checked page like ./page-scripts.ts (plain JavaScript source text, ES2020, no imports, no closures over Node values;
// the caller appends its JSON argument). They add measurements and refusals; they allow nothing new. With the DEV-082
// allowlist (page-css.ts) no stacking context, pseudo-element, vertical writing or overlap capability can exist, so on
// pages the allowlist accepts every rule here must agree with the existing checks — the probes and the Chromium
// comparison in tests/unit/design-agent/comp-impl/phase-a.test.ts are what make the model worth having for phases B–F.

/** The semantic roles of V1 (`data-comp-role`). `content` is the default for anything holding text. */
export const COMP_ROLES = ["content", "decoration", "ground", "media"] as const;
export type CompRole = (typeof COMP_ROLES)[number];

/**
 * V1 roles, V2 paint order, V4 ink-overflow extents and V9 computed writing mode, at the current viewport.
 * Argument: { facts (required facts, whitespace-free), pairs (true: also return every intersecting text / box pair with
 * the model's verdict, for the Chromium comparison), mark (true: mark every non-content element with data-pa-role, on a
 * throwaway page only), declared (true: read data-comp-role — the test path only; the run never sets it, and the DOM
 * allowlist refuses the attribute on a page) }.
 *
 * V1 roles. Every element in the body gets a derived role: content when its subtree holds a text node or an aria-label;
 * else media for an img or a placeholder image slot (data-comp-placeholder); else decoration (a text-free box). A declared
 * data-comp-role only confirms the derived one: an unknown value (ROLE_UNKNOWN), a non-content role over a subtree with
 * text, alt (other than a media img's own) or an aria-label (ROLE_<ROLE>_HAS_TEXT), content on a text-free box, media on
 * anything but an img or a placeholder slot, or an img declared other than media (ROLE_MISMATCH) fail. A text-free box may
 * be declared decoration or ground. ::before / ::after are always decoration; any generated one is counted (`pseudo`: the
 * allowlist refuses them, so a page with one is past the stylesheet check).
 *
 * V2 paint order: CSS 2.1 Appendix E with the CSS Display / Flexbox / Grid amendments. The stacking-context tree (the
 * triggers in `realContext`), and inside each context: its background; negative-z contexts (z, then order-modified tree
 * order); in-flow non-positioned block backgrounds; floats (painted atomically); inline content, where inline-blocks,
 * flex items, grid items and inline replaced elements paint atomically (as if a stacking context) in order-modified
 * document order; the z-index auto / 0 layer (positioned boxes painted atomically, real z 0 contexts such as opacity < 1,
 * in tree order); positive-z contexts; outlines. Positioned descendants and real contexts inside an atomic unit escape to
 * the nearest real context. Every text node is a paint event, and so is every box that paints (background, border, outset
 * shadow; an img's content; an outline ring). A box event after a text event whose extent intersects one of its line
 * boxes (> 0.5 px both ways) covers it, whatever its colour or alpha: PAINT_ORDER_COVER.
 *
 * V4: the ink-overflow extent (border box, outset box-shadows, the outline ring's outer box; the bounding box of any
 * transform) of every non-content element must not intersect a line box of the disclosure or a required fact.
 *
 * V9: dt, dd, the disclosure and every element holding protected text (and their descendants) must have a computed
 * writing-mode of horizontal-tb (PROTECTED_VERTICAL: an inherited vertical mode fails too).
 */
export const LAYER_SCRIPT = String.raw`(arg) => {
  const flat = (s) => (s || "").replace(/\s+/g, "");
  const ROLES = ["content", "decoration", "ground", "media"];
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const alpha = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  };
  const all = Array.from(document.querySelectorAll("*"));
  const index = new Map(all.map((e, i) => [e, i]));
  const styles = new Map();
  const st = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const NOT_BOXES = ["HEAD", "META", "TITLE", "LINK", "STYLE", "SCRIPT", "BR"];
  const body = Array.from(document.body.querySelectorAll("*")).filter((el) => !NOT_BOXES.includes(el.tagName));
  const rectOf = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const meets = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const textRects = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5).map(rectOf);
  };

  // ------------------------------------------------------------ V1 roles
  const ownTextOf = (el) => flat(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.data).join(""));
  const textInside = (el) => {
    if (flat(el.textContent)) return true;
    for (const d of [el].concat(Array.from(el.querySelectorAll("*")))) {
      if ((d.getAttribute("aria-label") || "").trim()) return true;
    }
    return false;
  };
  const altInside = (el, ownImgAlt) => [el].concat(Array.from(el.querySelectorAll("*"))).some((d) => (d !== el || !ownImgAlt) && (d.getAttribute("alt") || "").trim() !== "");
  const isMediaBox = (el) => el.tagName === "IMG" || (el.hasAttribute("data-comp-placeholder") && el.hasAttribute("data-comp-slot"));
  const roles = { declared: 0, unknown: 0, mismatch: 0, hasText: { decoration: 0, ground: 0, media: 0 }, counts: { content: 0, decoration: 0, ground: 0, media: 0 } };
  const role = new Map();
  for (const el of body) {
    const text = textInside(el);
    const derived = text ? "content" : isMediaBox(el) ? "media" : "decoration";
    let eff = derived;
    // declared roles are read only on the test path (arg.declared): pages may not carry data-comp-role (the DOM
    // allowlist refuses it until phase B is approved), so in the run every role is derived from the DOM
    if (arg.declared && el.hasAttribute("data-comp-role")) {
      roles.declared += 1;
      const d = el.getAttribute("data-comp-role");
      if (!ROLES.includes(d)) roles.unknown += 1;
      else if (d !== "content" && (text || altInside(el, d === "media" && el.tagName === "IMG"))) roles.hasText[d] += 1;
      else if (d === "content" && derived !== "content") roles.mismatch += 1;
      else if (d === "media" && !isMediaBox(el)) roles.mismatch += 1;
      else if (el.tagName === "IMG" && d !== "media") roles.mismatch += 1;
      else eff = d;
    }
    role.set(el, eff);
    roles.counts[eff] += 1;
    // mark: only on a throwaway page (the V3 layered reference hides decoration by this mark)
    if (arg.mark && eff !== "content") el.setAttribute("data-pa-role", eff);
  }
  let pseudo = 0;
  for (const el of all) for (const p of ["::before", "::after"]) {
    const c = getComputedStyle(el, p).content;
    if (c && c !== "none" && c !== "normal") pseudo += 1;
  }

  // ------------------------------------------------------------ protected text
  const protectedOwner = (el) => {
    if (el.closest("[data-comp-disclosure]")) return "DISCLOSURE";
    const own = ownTextOf(el);
    return arg.facts.some((f) => f && own.includes(f)) ? "FACT" : null;
  };

  // ------------------------------------------------------------ V2 paint order
  const FLEXGRID = /(^|-)(flex|grid)$/;
  const parentStyle = (el) => (el.parentElement ? st(el.parentElement) : null);
  const positioned = (s) => s.position !== "static";
  const flexItem = (el, s) => { const ps = parentStyle(el); return Boolean(ps && FLEXGRID.test(ps.display) && s.position !== "absolute" && s.position !== "fixed"); };
  const zOf = (el, s) => (s.zIndex !== "auto" && (positioned(s) || flexItem(el, s)) ? parseInt(s.zIndex, 10) || 0 : 0);
  const STACKING_WILL_CHANGE = /(^|,\s*)(opacity|transform|translate|rotate|scale|filter|backdrop-filter|perspective|clip-path|mask|mask-image|isolation|mix-blend-mode|contain|position|z-index)(\s*,|$)/;
  const realContext = (el, s) => {
    if (el === document.documentElement) return true;
    const zSet = s.zIndex !== "auto" && (positioned(s) || flexItem(el, s));
    const contain = s.contain || "none";
    const mask = s.maskImage || s.webkitMaskImage || "none";
    return zSet || s.position === "fixed" || s.position === "sticky" || Number(s.opacity) < 1 || (s.transform && s.transform !== "none") || (s.translate && s.translate !== "none") || (s.rotate && s.rotate !== "none") || (s.scale && s.scale !== "none") || (s.perspective && s.perspective !== "none") || (s.filter && s.filter !== "none") || (s.backdropFilter && s.backdropFilter !== "none") || s.isolation === "isolate" || (s.mixBlendMode && s.mixBlendMode !== "normal") || (s.clipPath && s.clipPath !== "none") || mask !== "none" || (s.webkitMaskBoxImageSource && s.webkitMaskBoxImageSource !== "none") || /paint|layout|strict|content/.test(contain) || (s.containerType && /size/.test(s.containerType)) || STACKING_WILL_CHANGE.test(s.willChange || "auto")
      // fail closed: any non-initial value of a property that can create a context, listed or not above
      || (s.willChange && s.willChange !== "auto") || contain !== "none" || (s.contentVisibility && s.contentVisibility !== "visible") || (s.webkitBoxReflect && s.webkitBoxReflect !== "none") || (s.viewTransitionName && s.viewTransitionName !== "none") || (s.offsetPath && s.offsetPath !== "none") || (s.maskBorderSource && s.maskBorderSource !== "none") || (s.containerType && s.containerType !== "normal");
  };
  const blockLevel = (s) => /^(block|list-item|flex|grid|table|flow-root)/.test(s.display);
  const atomic = (el, s) => /^inline-(block|flex|grid|table)$/.test(s.display) || flexItem(el, s) || (el.tagName === "IMG" && !blockLevel(s));
  // order-modified document order: the children of a flex or grid container by their order property (stable)
  const kids = (el) => {
    const list = Array.from(el.children).filter((c) => !NOT_BOXES.includes(c.tagName));
    if (!FLEXGRID.test(st(el).display)) return list;
    return list.map((c, i) => ({ c, i, o: flexItem(c, st(c)) ? parseInt(st(c).order, 10) || 0 : 0 })).sort((a, b) => a.o - b.o || a.i - b.i).map((x) => x.c);
  };
  const treeOrder = new Map();
  const number = (el) => { treeOrder.set(el, treeOrder.size); for (const c of kids(el)) number(c); };
  number(document.documentElement);
  let stacking = 0;
  const build = (el, real, outer) => {
    const u = { el, real, neg: [], zero: [], pos: [], blocks: [], floats: [], content: [], outlines: [] };
    const C = real ? u : outer;
    if (el.tagName === "IMG") u.content.push({ k: "replaced", el });
    u.outlines.push({ k: "outline", el });
    nodes(el, u, C);
    return u;
  };
  const nodes = (el, u, C) => {
    const order = kids(el);
    const texts = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && flat(n.data));
    // text nodes keep their place among the element children (order-modified order applies to items, not text)
    if (!FLEXGRID.test(st(el).display)) {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3) { if (flat(n.data)) u.content.push({ k: "text", el, node: n }); }
        else if (n.nodeType === 1 && !NOT_BOXES.includes(n.tagName)) walk(n, u, C);
      }
    } else {
      for (const n of texts) u.content.push({ k: "text", el, node: n });
      for (const c of order) walk(c, u, C);
    }
  };
  const walk = (el, u, C) => {
    const s = st(el);
    if (s.display === "none") return;
    if (s.display === "contents") { nodes(el, u, C); return; }
    const real = realContext(el, s);
    if (real) stacking += 1;
    if (real || positioned(s)) {
      const sub = build(el, real, C);
      const z = real ? zOf(el, s) : 0;
      (z < 0 ? C.neg : z > 0 ? C.pos : C.zero).push({ u: sub, z, t: treeOrder.get(el) });
      return;
    }
    if (s.float !== "none") { u.floats.push(build(el, false, C)); return; }
    if (atomic(el, s)) { u.content.push({ u: build(el, false, C) }); return; }
    (blockLevel(s) ? u.blocks : u.content).push({ k: "bg", el });
    if (el.tagName === "IMG") u.content.push({ k: "replaced", el });
    u.outlines.push({ k: "outline", el });
    nodes(el, u, C);
  };
  const events = [];
  const emit = (u) => {
    events.push({ k: "bg", el: u.el });
    const byZ = (a, b) => a.z - b.z || a.t - b.t;
    if (u.real) for (const e of u.neg.slice().sort(byZ)) emit(e.u);
    for (const b of u.blocks) events.push(b);
    for (const f of u.floats) emit(f);
    for (const c of u.content) if (c.u) emit(c.u); else events.push(c);
    if (u.real) {
      for (const e of u.zero.slice().sort((a, b) => a.t - b.t)) emit(e.u);
      for (const e of u.pos.slice().sort(byZ)) emit(e.u);
    }
    for (const o of u.outlines) events.push(o);
  };
  emit(build(document.documentElement, true, null));

  // extents: what a box event can paint over
  const shadowOut = (s) => {
    if (!s.boxShadow || s.boxShadow === "none") return -1;
    let out = -1;
    for (const part of s.boxShadow.split(/,(?![^(]*\))/)) {
      if (/\binset\b/.test(part)) continue;
      const nums = (part.replace(/rgba?\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
      out = Math.max(out, Math.max(Math.abs(nums[0] || 0), Math.abs(nums[1] || 0)) + Math.max(0, nums[2] || 0) + Math.max(0, nums[3] || 0));
    }
    return out;
  };
  const grow = (r, d) => ({ left: r.left - d, top: r.top - d, right: r.right + d, bottom: r.bottom + d });
  // fail closed: a box paints when any paint-affecting property is off its inert initial value — grounds, borders,
  // every box-shadow (an inset one paints over the whole border box), border images, column rules, scrollbars
  const bgPaints = (s) =>
    alpha(s.backgroundColor) > 0 ||
    (s.backgroundImage && s.backgroundImage !== "none") ||
    ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none" && s["border" + side + "Style"] !== "hidden" && alpha(s["border" + side + "Color"]) > 0) ||
    (s.boxShadow && s.boxShadow !== "none") ||
    (s.borderImageSource && s.borderImageSource !== "none") ||
    (s.columnRuleStyle && s.columnRuleStyle !== "none" && parseFloat(s.columnRuleWidth) > 0) ||
    ["scroll", "auto"].includes(s.overflowX) || ["scroll", "auto"].includes(s.overflowY);
  // paint whose extent the model does not compute (filters, reflections, masks): treated as covering everything after it
  const unboundedPaint = (s) => (s.filter && s.filter !== "none") || (s.backdropFilter && s.backdropFilter !== "none") || (s.webkitBoxReflect && s.webkitBoxReflect !== "none");
  const extents = (e) => {
    const s = st(e.el);
    const r = rectOf(e.el.getBoundingClientRect());
    if (r.right - r.left <= 0 && r.bottom - r.top <= 0) return [];
    if (e.k === "replaced") return [r];
    if (e.k === "outline") {
      const w = parseFloat(s.outlineWidth) || 0;
      if (s.outlineStyle === "none" || w <= 0 || alpha(s.outlineColor) === 0) return [];
      const off = parseFloat(s.outlineOffset) || 0;
      const o = grow(r, off + w);
      const i = grow(r, off);
      return [{ left: o.left, top: o.top, right: o.right, bottom: i.top }, { left: o.left, top: i.bottom, right: o.right, bottom: o.bottom }, { left: o.left, top: i.top, right: i.left, bottom: i.bottom }, { left: i.right, top: i.top, right: o.right, bottom: i.bottom }];
    }
    if (unboundedPaint(s)) return [grow(r, 1e6)];
    const sh = shadowOut(s);
    if (!bgPaints(s)) return [];
    return [sh > 0 ? grow(r, sh) : r];
  };
  const textEvents = [];
  const boxEvents = [];
  events.forEach((e, i) => {
    if (e.k === "text") {
      const rects = textRects(e.node);
      if (rects.length) textEvents.push({ i, el: e.el, rects, prot: protectedOwner(e.el) });
    } else if (e.el !== document.documentElement && e.el !== document.body) {
      const ext = extents(e);
      if (ext.length) boxEvents.push({ i, el: e.el, k: e.k, ext });
    }
  });
  const covers = [];
  const pairs = [];
  let coverCount = 0;
  for (const t of textEvents) {
    for (const b of boxEvents) {
      if (b.el === t.el) continue;
      let hit = null;
      for (const r of t.rects) for (const x of b.ext) if (!hit && meets(r, x)) hit = { left: Math.max(r.left, x.left), top: Math.max(r.top, x.top), right: Math.min(r.right, x.right), bottom: Math.min(r.bottom, x.bottom) };
      if (!hit) continue;
      const after = b.i > t.i;
      if (after) {
        coverCount += 1;
        if (covers.length < 40) covers.push({ text: index.get(t.el), box: index.get(b.el), kind: b.k, protected: t.prot !== null, text_snippet: flat(t.el.textContent).slice(0, 24) });
      }
      if (arg.pairs && pairs.length < 400) pairs.push({ text: index.get(t.el), node: Array.from(t.el.childNodes).indexOf(events[t.i].node), box: index.get(b.el), kind: b.k, after, rect: hit });
    }
  }

  // ------------------------------------------------------------ V4 non-content extents over protected text
  const protectedRects = textEvents.filter((t) => t.prot !== null);
  const v4 = { DISCLOSURE: 0, FACT: 0 };
  for (const el of body) {
    if (role.get(el) === "content") continue;
    const s = st(el);
    if (s.display === "none") continue;
    let r = rectOf(el.getBoundingClientRect());
    const sh = shadowOut(s);
    if (sh > 0) r = grow(r, sh);
    if (unboundedPaint(s)) r = grow(r, 1e6);
    const ow = s.outlineStyle !== "none" ? (parseFloat(s.outlineWidth) || 0) + Math.max(0, parseFloat(s.outlineOffset) || 0) : 0;
    if (ow > 0) r = grow(r, ow);
    for (const t of protectedRects) if (t.rects.some((x) => meets(x, r))) v4[t.prot] += 1;
  }

  // ------------------------------------------------------------ V9 computed writing mode
  const vertical = new Set();
  const protectedEls = Array.from(document.querySelectorAll("dt, dd, [data-comp-disclosure]")).concat(textEvents.filter((t) => t.prot !== null).map((t) => t.el));
  for (const el of protectedEls) for (const d of [el].concat(Array.from(el.querySelectorAll("*")))) if (st(d).writingMode !== "horizontal-tb") vertical.add(d);

  return {
    roles,
    pseudo,
    stacking: stacking,
    events: events.length,
    texts: textEvents.length,
    boxes: boxEvents.length,
    covers: { count: coverCount, list: covers },
    nonContentOverlap: { disclosure: v4.DISCLOSURE, fact: v4.FACT },
    protectedVertical: vertical.size,
    ...(arg.pairs ? { pairs } : {}),
  };
}`;

const Rect = z.strictObject({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });
export const LayerSchema = z.strictObject({
  roles: z.strictObject({
    declared: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    mismatch: z.number().int().nonnegative(),
    hasText: z.strictObject({ decoration: z.number().int().nonnegative(), ground: z.number().int().nonnegative(), media: z.number().int().nonnegative() }),
    counts: z.strictObject({ content: z.number().int().nonnegative(), decoration: z.number().int().nonnegative(), ground: z.number().int().nonnegative(), media: z.number().int().nonnegative() }),
  }),
  pseudo: z.number().int().nonnegative(),
  stacking: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  texts: z.number().int().nonnegative(),
  boxes: z.number().int().nonnegative(),
  covers: z.strictObject({
    count: z.number().int().nonnegative(),
    list: z.array(z.strictObject({ text: z.number().int(), box: z.number().int(), kind: z.enum(["bg", "replaced", "outline"]), protected: z.boolean(), text_snippet: z.string().max(24) })).max(40),
  }),
  nonContentOverlap: z.strictObject({ disclosure: z.number().int().nonnegative(), fact: z.number().int().nonnegative() }),
  protectedVertical: z.number().int().nonnegative(),
  pairs: z.array(z.strictObject({ text: z.number().int(), node: z.number().int(), box: z.number().int(), kind: z.enum(["bg", "replaced", "outline"]), after: z.boolean(), rect: Rect })).max(400).optional(),
});
export type LayerScan = z.infer<typeof LayerSchema>;

/**
 * V6 layout-change detection (phase A: measured, and used only where it is shown to give the same findings). For each
 * width from `from` to `to` (the same stepping as GEOMETRY_SCRIPT: the root's width stands in for the viewport when
 * `step`, else the caller resized the viewport to `from` = `to`), a signature of everything GEOMETRY_SCRIPT reads for
 * the protected text:
 *   - per target element: whether it has line boxes; its box's scroll overflow (both axes); per line box: the rect
 *     relative to its own box (¼ px), how far it is past either page edge, whether it meets an img;
 *   - per line box: every other element (not the target, its ancestors or descendants) whose border box or own text
 *     comes within 2 px of the line, with that element's rect relative to the line (¼ px).
 * Widths with equal signatures have, line by line, the same geometry around every protected line; GEOMETRY_SCRIPT then
 * runs only where the signature changes (and at both neighbours). Returns a short hash per width.
 * Argument: { facts, from, to, step }.
 */
export const LAYOUT_HASH_SCRIPT = String.raw`(arg) => {
  const flat = (s) => (s || "").replace(/\s+/g, "");
  const q = (n) => Math.round(n * 4);
  const targets = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !flat(n.data)) continue;
    const own = flat(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.data).join(""));
    const disclosure = Boolean(el.closest("[data-comp-disclosure]"));
    if (!disclosure && !arg.facts.some((f) => own.includes(f))) continue;
    seen.add(el);
    let box = el;
    while (box.parentElement && ["inline", "contents"].includes(getComputedStyle(box).display)) box = box.parentElement;
    targets.push({ el, box });
  }
  const others = Array.from(document.body.querySelectorAll("*")).filter((e) => !["BR", "STYLE", "SCRIPT"].includes(e.tagName));
  const ownTextNodes = new Map(others.map((e) => [e, Array.from(e.childNodes).filter((c) => c.nodeType === 3 && flat(c.data))]));
  const html = document.documentElement;
  const saved = html.getAttribute("style");
  const step = arg.step !== false;
  if (step) {
    html.style.setProperty("min-width", "0", "important");
    html.style.setProperty("max-width", "none", "important");
    html.style.setProperty("margin-left", "0", "important");
    html.style.setProperty("margin-right", "0", "important");
  }
  const rectsOf = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
  };
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };
  const out = [];
  for (let w = arg.from; w <= arg.to; w++) {
    if (step) html.style.setProperty("width", w + "px", "important");
    const sig = [];
    const imgs = Array.from(document.images).map((i) => i.getBoundingClientRect());
    const boxes = others.map((e) => {
      const list = [e.getBoundingClientRect()];
      for (const t of ownTextNodes.get(e)) for (const r of rectsOf(t)) list.push(r);
      return list;
    });
    targets.forEach((t, ti) => {
      const lines = rectsOf(t.el);
      const bb = t.box.getBoundingClientRect();
      sig.push("t" + ti + ":" + lines.length + ":" + (t.box.scrollWidth > t.box.clientWidth + 1 ? 1 : 0) + (t.box.scrollHeight > t.box.clientHeight + 1 ? 1 : 0));
      for (const r of lines) {
        const img = imgs.some((ir) => Math.min(r.right, ir.right) - Math.max(r.left, ir.left) > 0.5 && Math.min(r.bottom, ir.bottom) - Math.max(r.top, ir.top) > 0.5) ? 1 : 0;
        sig.push([q(r.left - bb.left), q(r.top - bb.top), q(r.width), q(r.height), q(Math.min(0, r.left)), q(Math.min(0, w - r.right)), img].join(","));
        others.forEach((e, ei) => {
          if (e === t.el || e.contains(t.el) || t.el.contains(e)) return;
          for (const b of boxes[ei]) {
            if (Math.min(r.right + 2, b.right) - Math.max(r.left - 2, b.left) > 0 && Math.min(r.bottom + 2, b.bottom) - Math.max(r.top - 2, b.top) > 0) {
              sig.push("n" + ei + ":" + [q(b.left - r.left), q(b.top - r.top), q(b.right - r.left), q(b.bottom - r.top)].join(","));
            }
          }
        });
      }
    });
    out.push({ w, h: fnv(sig.join("|")) });
  }
  if (step) {
    if (saved === null) html.removeAttribute("style");
    else html.setAttribute("style", saved);
  }
  return { targets: targets.length, widths: out };
}`;

export const LayoutHashSchema = z.strictObject({ targets: z.number().int().nonnegative(), widths: z.array(z.strictObject({ w: z.number().int(), h: z.string().max(16) })).max(2000) });
export type LayoutHashRun = z.infer<typeof LayoutHashSchema>;

/**
 * V10's metric perturbation (phase A: the harness only; it gates nothing until an overlap capability is approved).
 * Argument: { kind: "wide_font" | "tracking_plus" | "tracking_minus", face } — the widest installed text face for
 * wide_font (WIDEST_FACE_SCRIPT), set on every element; ±0.05 em added to every element's computed letter-spacing.
 * Inline styles on a throwaway page.
 */
export const PERTURB_SCRIPT = String.raw`(arg) => {
  const els = [document.documentElement].concat(Array.from(document.documentElement.querySelectorAll("*")));
  const computed = els.map((el) => getComputedStyle(el));
  const plan = els.map((el, i) => ({ el, ls: parseFloat(computed[i].letterSpacing) || 0, fs: parseFloat(computed[i].fontSize) || 16 }));
  for (const p of plan) {
    if (arg.kind === "wide_font") p.el.style.setProperty("font-family", JSON.stringify(arg.face), "important");
    else p.el.style.setProperty("letter-spacing", (p.ls + (arg.kind === "tracking_plus" ? 0.05 : -0.05) * p.fs) + "px", "important");
  }
  return els.length;
}`;

/** The widest installed face of a list (a CJK sample measured in each; a face not installed measures as the fallback). Argument: { faces }. */
export const WIDEST_FACE_SCRIPT = String.raw`(arg) => {
  const c = document.createElement("canvas").getContext("2d");
  const sample = "架空菓庵の営業時間は九時から十八時まで052-000-0731 ABCabc";
  const width = (f) => { c.font = "20px " + f; return c.measureText(sample).width; };
  const fallbacks = [width("monospace"), width("serif"), width("sans-serif")];
  let best = null;
  for (const face of arg.faces) {
    const quoted = JSON.stringify(face);
    const ws = ["monospace", "serif", "sans-serif"].map((g) => width(quoted + ", " + g));
    // installed: the face changes the width against at least one generic fallback
    if (!ws.some((w, i) => Math.abs(w - fallbacks[i]) > 0.01)) continue;
    if (!best || ws[2] > best.w) best = { face, w: ws[2] };
  }
  return best ? best.face : null;
}`;
