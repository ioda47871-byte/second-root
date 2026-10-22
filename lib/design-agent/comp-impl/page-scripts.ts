import { z } from "zod";

// Code that runs inside the checked comp page (DEV-082), as plain JavaScript
// source text for the reason in ../page-scripts.ts (tsx's keepNames would wrap
// named functions in a __name() helper the page does not have). Plain ES2020,
// no imports, no closures over Node values. Each is a function expression; the
// caller appends its JSON argument. The page itself runs no script (the
// context has JavaScript off); Playwright's evaluate still works.

/** Elements a comp page may use, and the attributes each may carry (besides the shared ones). */
export const PAGE_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  html: ["lang"],
  head: [],
  meta: ["charset", "name", "content"],
  title: [],
  link: ["rel", "href"],
  body: [],
  header: [],
  nav: [],
  main: [],
  section: [],
  article: [],
  aside: [],
  footer: [],
  div: [],
  span: [],
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  li: [],
  dl: [],
  dt: [],
  dd: [],
  a: ["href"],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  figure: [],
  figcaption: [],
  small: [],
  strong: [],
  em: [],
  br: [],
  hr: [],
  address: [],
};
/** Attributes any element may carry: classes and ids, the harness's data-comp-* hooks, aria-hidden and aria-label (checked as text). */
export const SHARED_ATTRIBUTES = ["class", "id", "aria-hidden", "aria-label", "data-comp-section", "data-comp-type", "data-comp-slot", "data-comp-placeholder", "data-comp-nav", "data-comp-cta", "data-comp-disclosure", "data-comp-container"] as const;

/** Lists every element or attribute outside the allowlist (in the live document). Argument: { elements, shared }. */
export const DOM_AUDIT_SCRIPT = String.raw`(arg) => {
  const out = { elements: [], attributes: [], links: [], metas: [] };
  for (const el of Array.from(document.getElementsByTagName("*"))) {
    const tag = el.tagName.toLowerCase();
    const own = arg.elements[tag];
    if (!own) { out.elements.push(tag.slice(0, 20)); continue; }
    for (const a of Array.from(el.attributes)) {
      if (!own.includes(a.name) && !arg.shared.includes(a.name)) out.attributes.push((tag + "@" + a.name).slice(0, 60));
    }
    if (tag === "link") out.links.push({ rel: el.getAttribute("rel") || "", href: el.getAttribute("href") || "" });
    if (tag === "meta") out.metas.push({ charset: el.getAttribute("charset"), name: el.getAttribute("name") });
  }
  return out;
}`;

export const DomAuditSchema = z.strictObject({
  elements: z.array(z.string().max(20)).max(500),
  attributes: z.array(z.string().max(60)).max(2000),
  links: z.array(z.strictObject({ rel: z.string().max(200), href: z.string().max(2000) })).max(50),
  metas: z.array(z.strictObject({ charset: z.string().max(200).nullable(), name: z.string().max(200).nullable() })).max(50),
});
export type DomAudit = z.infer<typeof DomAuditSchema>;

/**
 * Measures the comp page at one width: every text (text nodes, alt, aria-label,
 * the title) with whether it is displayed, the data-comp-* blocks (sections,
 * type roles, slots, nav, CTA, disclosure, containers), the colours actually
 * painted (text, grounds, borders of displayed elements), the links and the
 * horizontal overflow. Page coordinates. No argument.
 */
export const COMP_MEASURE_SCRIPT = String.raw`() => {
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
    return [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
  };
  const shown = (el) => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === "none" || s.visibility !== "visible" || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height };
  };
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 400);
  // the rotation a text is drawn at: every transform of its chain composed (each may rotate a little; together they add up)
  const angleOf = (el) => {
    let deg = 0;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const t = getComputedStyle(a).transform;
      if (t && t !== "none") {
        const m = new DOMMatrixReadOnly(t);
        deg += (Math.atan2(m.b, m.a) * 180) / Math.PI;
      }
    }
    return Math.round(deg * 100) / 100;
  };
  // rules that fix the height of an element holding text (height / max-height / block sizes other than auto / none),
  // under any media: wrapped text leaves such a box at widths no breakpoint names (third review of PR #96)
  let fixedHeightText = 0;
  const visit = (rules) => {
    for (const r of Array.from(rules)) {
      if (r.cssRules && !r.selectorText) { visit(r.cssRules); continue; }
      if (!r.style || !r.selectorText) continue;
      const fixed = ["height", "max-height", "block-size", "max-block-size"].some((name) => {
        const v = r.style.getPropertyValue(name).trim();
        return v !== "" && v !== "auto" && v !== "none";
      });
      if (!fixed) continue;
      for (const el of Array.from(document.querySelectorAll(r.selectorText))) if ((el.textContent || "").replace(/\s+/g, "")) fixedHeightText += 1;
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { visit(sheet.cssRules); } catch (e) { fixedHeightText += 1000; }
  }
  const out = { fixedHeightText, listMarkers: 0, width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, texts: [], attrTexts: [], sections: [], types: [], colours: [], links: [], nav: [], ctas: [], slots: [], imgs: [], disclosures: [], containers: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = clean(n.data);
    if (!text || !n.parentElement || n.parentElement.closest("style, script")) continue;
    const el = n.parentElement;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    out.texts.push({ text, shown: rects.length > 0 && shown(el), fontSize: parseFloat(getComputedStyle(el).fontSize), angle: angleOf(el) });
  }
  if (clean(document.title)) out.attrTexts.push({ kind: "title", text: clean(document.title) });
  for (const el of Array.from(document.querySelectorAll("[alt]"))) out.attrTexts.push({ kind: "alt", text: clean(el.getAttribute("alt")) });
  for (const el of Array.from(document.querySelectorAll("[aria-label]"))) out.attrTexts.push({ kind: "aria", text: clean(el.getAttribute("aria-label")) });
  for (const el of Array.from(document.querySelectorAll("[data-comp-section]"))) {
    const s = getComputedStyle(el);
    out.sections.push({ id: (el.getAttribute("data-comp-section") || "").slice(0, 40), shown: shown(el), box: box(el), paddingTop: parseFloat(s.paddingTop), paddingBottom: parseFloat(s.paddingBottom) });
  }
  for (const el of Array.from(document.querySelectorAll("[data-comp-type]"))) {
    if (!shown(el)) continue;
    const s = getComputedStyle(el);
    out.types.push({ role: (el.getAttribute("data-comp-type") || "").slice(0, 20), fontSize: parseFloat(s.fontSize), fontWeight: parseFloat(s.fontWeight) || 400 });
  }
  const seen = new Map();
  const addColour = (kind, value) => {
    const c = rgba(value);
    if (c[3] === 0) return;
    const key = kind + ":" + c.join(",");
    seen.set(key, { kind, rgba: c, count: (seen.get(key) ? seen.get(key).count : 0) + 1 });
  };
  for (const el of Array.from(document.body.querySelectorAll("*")).concat([document.body, document.documentElement])) {
    if (el !== document.documentElement && el !== document.body && !shown(el)) continue;
    const s = getComputedStyle(el);
    if (Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.data.trim())) addColour("text", s.color);
    addColour("ground", s.backgroundColor);
    for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(s["border" + side + "Width"]) > 0 && s["border" + side + "Style"] !== "none") addColour("border", s["border" + side + "Color"]);
    if (parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== "none") addColour("border", s.outlineColor);
    if (s.backgroundImage !== "none") addColour("image", "rgb(1, 2, 3)");
  }
  out.colours = Array.from(seen.values()).slice(0, 200);
  // a list marker (the default disc of ul, the numbers of ol) is drawn text outside the DOM
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const st = getComputedStyle(el);
    if (st.display.includes("list-item") && st.listStyleType !== "none" && shown(el)) out.listMarkers += 1;
  }
  for (const a of Array.from(document.querySelectorAll("a"))) {
    const href = a.getAttribute("href");
    let target = false;
    if (href && href.length > 1 && href[0] === "#") {
      try { target = Boolean(document.getElementById(decodeURIComponent(href.slice(1)))); } catch (e) { target = false; }
    }
    out.links.push({ text: clean(a.textContent), href: (href === null ? "" : href).slice(0, 200), hasHref: href !== null, target, shown: shown(a) });
  }
  for (const nav of Array.from(document.querySelectorAll("[data-comp-nav]"))) for (const a of Array.from(nav.querySelectorAll("a"))) out.nav.push({ text: clean(a.textContent), href: (a.getAttribute("href") || "").slice(0, 200) });
  for (const el of Array.from(document.querySelectorAll("[data-comp-cta]"))) out.ctas.push({ tag: el.tagName.toLowerCase(), text: clean(el.textContent), href: (el.getAttribute("href") || "").slice(0, 200), shown: shown(el) });
  for (const el of Array.from(document.querySelectorAll("[data-comp-slot]"))) {
    const s = getComputedStyle(el);
    const section = el.closest("[data-comp-section]");
    out.slots.push({
      id: (el.getAttribute("data-comp-slot") || "").slice(0, 40),
      section: section ? (section.getAttribute("data-comp-section") || "").slice(0, 40) : "",
      tag: el.tagName.toLowerCase(),
      shown: shown(el),
      box: box(el),
      naturalWidth: el.tagName === "IMG" ? el.naturalWidth : 0,
      naturalHeight: el.tagName === "IMG" ? el.naturalHeight : 0,
      complete: el.tagName === "IMG" ? el.complete : true,
      objectFit: s.objectFit,
      placeholder: el.hasAttribute("data-comp-placeholder"),
      src: (el.getAttribute("src") || "").slice(0, 200),
    });
  }
  for (const img of Array.from(document.querySelectorAll("img"))) out.imgs.push({ src: (img.getAttribute("src") || "").slice(0, 200), inSlot: img.hasAttribute("data-comp-slot") });
  for (const el of Array.from(document.querySelectorAll("[data-comp-disclosure]"))) {
    const section = el.closest("[data-comp-section]");
    out.disclosures.push({ text: clean(el.textContent), shown: shown(el), fontSize: parseFloat(getComputedStyle(el).fontSize), section: section ? (section.getAttribute("data-comp-section") || "").slice(0, 40) : "" });
  }
  for (const el of Array.from(document.querySelectorAll("[data-comp-container]"))) if (shown(el)) out.containers.push({ width: el.getBoundingClientRect().width });
  return out;
}`;

const Box = z.strictObject({ left: z.number(), top: z.number(), width: z.number(), height: z.number() });
export const CompMeasureSchema = z.strictObject({
  fixedHeightText: z.number().int().nonnegative(),
  listMarkers: z.number().int().nonnegative(),
  width: z.number(),
  height: z.number(),
  overflow: z.number(),
  texts: z.array(z.strictObject({ text: z.string().max(400), shown: z.boolean(), fontSize: z.number(), angle: z.number() })).max(2000),
  attrTexts: z.array(z.strictObject({ kind: z.enum(["title", "alt", "aria"]), text: z.string().max(400) })).max(200),
  sections: z.array(z.strictObject({ id: z.string().max(40), shown: z.boolean(), box: Box, paddingTop: z.number(), paddingBottom: z.number() })).max(50),
  types: z.array(z.strictObject({ role: z.string().max(20), fontSize: z.number(), fontWeight: z.number() })).max(500),
  colours: z.array(z.strictObject({ kind: z.enum(["text", "ground", "border", "image"]), rgba: z.tuple([z.number(), z.number(), z.number(), z.number()]), count: z.number() })).max(200),
  links: z.array(z.strictObject({ text: z.string().max(400), href: z.string().max(200), hasHref: z.boolean(), target: z.boolean(), shown: z.boolean() })).max(200),
  nav: z.array(z.strictObject({ text: z.string().max(400), href: z.string().max(200) })).max(50),
  ctas: z.array(z.strictObject({ tag: z.string().max(20), text: z.string().max(400), href: z.string().max(200), shown: z.boolean() })).max(20),
  slots: z
    .array(
      z.strictObject({
        id: z.string().max(40),
        section: z.string().max(40),
        tag: z.string().max(20),
        shown: z.boolean(),
        box: Box,
        naturalWidth: z.number(),
        naturalHeight: z.number(),
        complete: z.boolean(),
        objectFit: z.string().max(20),
        placeholder: z.boolean(),
        src: z.string().max(200),
      }),
    )
    .max(20),
  imgs: z.array(z.strictObject({ src: z.string().max(200), inSlot: z.boolean() })).max(50),
  disclosures: z.array(z.strictObject({ text: z.string().max(400), shown: z.boolean(), fontSize: z.number(), section: z.string().max(40) })).max(10),
  containers: z.array(z.strictObject({ width: z.number() })).max(50),
});
export type CompMeasure = z.infer<typeof CompMeasureSchema>;

/**
 * The structural fingerprint of an HTML document (anti-template guard): parsed
 * with DOMParser (nothing is rendered, no CSS), text ignored. Features: every
 * element's path of the last three tag aliases, and each element's alias with
 * its child-count bucket (a multiset); blocks: the page's top-level blocks
 * (through main and wrapper divs) as tag-alias trees two levels deep.
 * Argument: the HTML source.
 */
export const FINGERPRINT_SCRIPT = String.raw`(html) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const skip = ["script", "style", "svg", "template", "noscript", "link", "meta"];
  const alias = (el) => {
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) return "h";
    if (["section", "article", "aside"].includes(t)) return "section";
    if (["span", "small", "strong", "em", "b", "i", "time", "br"].includes(t)) return "inline";
    if (["figure", "picture"].includes(t)) return "figure";
    return t;
  };
  const kids = (el) => Array.from(el.children).filter((c) => !skip.includes(c.tagName.toLowerCase()));
  const features = {};
  const add = (k) => { features[k] = (features[k] || 0) + 1; };
  const bucket = (n) => (n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : n <= 6 ? "4-6" : "7+");
  const walk = (el, path) => {
    const a = alias(el);
    const p = path.concat([a]).slice(-3);
    add("p:" + p.join(">"));
    add("c:" + a + ":" + bucket(kids(el).length));
    for (const c of kids(el)) walk(c, p);
  };
  for (const c of kids(doc.body)) walk(c, ["body"]);
  const blockish = ["section", "header", "footer", "nav", "div", "main"];
  const sig = (el, depth) => (depth === 0 || kids(el).length === 0 ? alias(el) : alias(el) + "(" + kids(el).map((c) => sig(c, depth - 1)).join(",") + ")");
  const blocks = [];
  const top = (el) => {
    for (const c of kids(el)) {
      const k = kids(c);
      if (["main", "div"].includes(alias(c)) && k.length >= 2 && k.every((x) => blockish.includes(alias(x)))) top(c);
      else blocks.push(sig(c, 2).slice(0, 400));
    }
  };
  top(doc.body);
  return { features, blocks: blocks.slice(0, 60) };
}`;

export const FingerprintSchema = z.strictObject({ features: z.record(z.string().max(200), z.number().int().nonnegative()), blocks: z.array(z.string().max(400)).max(60) });
export type Fingerprint = z.infer<typeof FingerprintSchema>;

/**
 * Protected text (review of PR #96): the disclosure and the required facts.
 * Runs after the shop-CSS MEASURE_SCRIPT (it reads the data-sr-i marks that
 * script leaves on every measured element). Returns, for every measured
 * element inside [data-comp-disclosure] or whose own text holds a required
 * fact: its owner index, which facts it holds, the zoom product of its chain
 * (font sizes in MEASURE_SCRIPT include transforms but not zoom), the colour's
 * alpha, whether -webkit-text-fill-color differs from color, and whether a
 * clip-path, mask, filter, blend mode or clip rect sits on it or an ancestor.
 * Also counts elements that carry aria-hidden over text (forbidden: such text
 * is skipped by every text measurement) and the disclosure's text nodes that
 * were not measured. Argument: { facts } (whitespace-free fact strings).
 */
export const PROTECTED_SCRIPT = String.raw`(arg) => {
  const flat = (s) => (s || "").replace(/\s+/g, "");
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
    return [d[0], d[1], d[2], d[3]];
  };
  const out = { ariaHiddenText: 0, unmeasuredDisclosure: 0, disclosures: document.querySelectorAll("[data-comp-disclosure]").length, owners: [] };
  for (const el of Array.from(document.querySelectorAll("[aria-hidden]"))) {
    if (el.getAttribute("aria-hidden") !== "false" && flat(el.textContent)) out.ariaHiddenText += 1;
  }
  for (const d of Array.from(document.querySelectorAll("[data-comp-disclosure]"))) {
    const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (flat(n.data) && !(n.parentElement && n.parentElement.hasAttribute("data-sr-i"))) out.unmeasuredDisclosure += 1;
  }
  for (const el of Array.from(document.querySelectorAll("[data-sr-i]"))) {
    const own = flat(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.data).join(""));
    const disclosure = Boolean(el.closest("[data-comp-disclosure]"));
    const facts = [];
    arg.facts.forEach((f, i) => { if (own.includes(f)) facts.push(i); });
    if (!disclosure && facts.length === 0) continue;
    let zoom = 1;
    let effects = false;
    let decorated = false;
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      const z = parseFloat(s.zoom);
      if (Number.isFinite(z) && z > 0) zoom *= z;
      // decoration lines are drawn by the element that declares them, over all its text (they propagate)
      if ((s.textDecorationLine || "none") !== "none") decorated = true;
      const mask = s.maskImage || s.webkitMaskImage || "none";
      if (s.clipPath !== "none" || mask !== "none" || s.filter !== "none" || s.mixBlendMode !== "normal" || (s.clip && s.clip !== "auto" && (s.position === "absolute" || s.position === "fixed"))) effects = true;
    }
    const s = getComputedStyle(el);
    const colour = rgba(s.color);
    const fill = rgba(s.webkitTextFillColor || s.color);
    out.owners.push({ owner: Number(el.getAttribute("data-sr-i")), disclosure, facts, zoom, colourAlpha: colour[3], fillDiffers: fill.join(",") !== colour.join(","), effects, decorated });
  }
  return out;
}`;

export const ProtectedSchema = z.strictObject({
  ariaHiddenText: z.number().int().nonnegative(),
  unmeasuredDisclosure: z.number().int().nonnegative(),
  disclosures: z.number().int().nonnegative(),
  owners: z
    .array(z.strictObject({ owner: z.number().int().nonnegative(), disclosure: z.boolean(), facts: z.array(z.number().int().nonnegative()).max(40), zoom: z.number(), colourAlpha: z.number(), fillDiffers: z.boolean(), effects: z.boolean(), decorated: z.boolean() }))
    .max(500),
});
export type ProtectedScan = z.infer<typeof ProtectedSchema>;


/**
 * Label and value pairs (third review of PR #96): every info label (営業時間,
 * 定休日 …) must be the text of a dt inside a dl, every dt must be followed by
 * a dd before the next dt, and the dt / dd of each dl must keep their DOM order
 * in reading order (by line, then left to right; in vertical writing, by
 * column right to left, then top to bottom) — so no layout can set a label
 * beside another value. Argument: { labels } (the info labels).
 */
export const PAIRS_SCRIPT = String.raw`(arg) => {
  const flat = (s) => (s || "").replace(/\s+/g, "");
  const out = { outside: 0, dtWithoutDd: 0, misordered: 0, pairs: 0 };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!arg.labels.includes(flat(n.data))) continue;
    const el = n.parentElement;
    if (!el || el.tagName !== "DT" || !el.closest("dl")) out.outside += 1;
  }
  for (const dl of Array.from(document.querySelectorAll("dl"))) {
    const items = Array.from(dl.querySelectorAll("dt, dd"));
    items.forEach((el, i) => {
      if (el.tagName !== "DT") return;
      const next = items[i + 1];
      if (!next || next.tagName !== "DD") out.dtWithoutDd += 1;
      else out.pairs += 1;
    });
    const first = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = Array.from(range.getClientRects()).find((x) => x.width > 0.5 && x.height > 0.5);
      return r ? { left: r.left, right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY, vertical: getComputedStyle(el).writingMode.startsWith("vertical") } : null;
    };
    const boxes = items.map(first).filter(Boolean);
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1];
      const b = boxes[i];
      if (a.vertical || b.vertical) {
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const same = overlap > 0.5 * Math.min(a.right - a.left, b.right - b.left);
        if (same ? b.top < a.top - 1 : b.right > a.left + 0.5 * (a.right - a.left)) out.misordered += 1;
      } else {
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const same = overlap > 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top);
        if (same ? b.left < a.left - 1 : b.top < a.top + 0.5 * (a.bottom - a.top)) out.misordered += 1;
      }
    }
  }
  return out;
}`;

export const PairsSchema = z.strictObject({ outside: z.number().int().nonnegative(), dtWithoutDd: z.number().int().nonnegative(), misordered: z.number().int().nonnegative(), pairs: z.number().int().nonnegative() });
export type Pairs = z.infer<typeof PairsSchema>;
