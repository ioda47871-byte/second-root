/**
 * Phase 2b (DEV-125): measuring a rendered page for the structure descriptor (descriptor.ts).
 *
 * The page is drawn by Chromium with JavaScript off and every request aborted (the HTML and CSS are given inline;
 * an image a page refers to simply does not load, its box still counts). Only geometry and computed styles are read:
 * the boxes of the sections (elements marked data-section, else the body's top-level blocks), their direct blocks,
 * where pictures and drawings sit, the navigation, and the writing mode of the text.
 *
 * The aspects that geometry can tell (navigation, section layouts, transitions, text direction, imagery, and the two
 * generic skeleton signs of hero and flow) are measured; the others come only from a declaration (the design's own
 * direction). A measured value always wins over a declared one.
 */
import { crc32, deflateSync } from "node:zlib";
import type { Browser } from "playwright";
import { GENERIC, type StructureDescriptor, type VOCABULARY } from "./descriptor";

type Box = { x: number; y: number; w: number; h: number };
type Block = { box: Box; mediaArea: number; svgArea: number; chars: number; centred: boolean; links: number };
type Section = { box: Box; bg: string; ownMedia: boolean; borders: { top: number; bottom: number }; chars: number; verticalChars: number; blocks: Block[] };
export type PageMeasure = {
  viewport: { width: number; height: number };
  sections: Section[];
  nav: { box: Box; links: number } | null;
  media: { box: Box; svg: boolean }[];
  chars: number;
  verticalChars: number;
  /** Requests the page made that were not its own page, stylesheet or pictures (refused; reported, never followed). */
  blocked: number;
};

export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

const MEASURE = `(() => {
  // the page's own elements may shadow document / element methods by name (DOM clobbering): call the prototypes
  const qsa = (root, sel) => (root === document ? Document.prototype.querySelectorAll : Element.prototype.querySelectorAll).call(root, sel);
  const kidsOf = (el) => [...Object.getOwnPropertyDescriptor(Element.prototype, "children").get.call(el)];
  const body = Object.getOwnPropertyDescriptor(Document.prototype, "body").get.call(document);
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
  const area = (b) => b.w * b.h;
  const isMediaEl = (el) => ["img", "svg", "picture", "video", "canvas"].includes(el.localName) || /url\\(/.test(getComputedStyle(el).backgroundImage);
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("").length;
  const vertical = (el) => /^vertical|^sideways/.test(getComputedStyle(el).writingMode);
  let chars = 0, verticalChars = 0;
  for (const el of qsa(body, "*")) { if (!visible(el)) continue; const n = ownText(el); chars += n; if (vertical(el)) verticalChars += n; }
  const media = [];
  for (const el of qsa(body, "*")) {
    if (!visible(el) || !isMediaEl(el) || el.closest("svg") !== el && el.closest("svg")) continue;
    media.push({ box: box(el), svg: el.localName === "svg" });
  }
  let roots = [...qsa(document, "[data-section]")].filter((el) => !el.parentElement.closest("[data-section]") && visible(el));
  if (!roots.length) roots = kidsOf(body).filter((el) => visible(el) && el.getBoundingClientRect().height > 40);
  const blockOf = (el) => {
    const b = box(el);
    let mediaArea = 0, svgArea = 0;
    for (const m of [el, ...qsa(el, "*")]) {
      if (!visible(m) || !isMediaEl(m)) continue;
      const mb = box(m);
      mediaArea += area(mb);
      if (m.localName === "svg") svgArea += area(mb);
      if (m.localName === "svg") break;
    }
    let c = 0; for (const t of [el, ...qsa(el, "*")]) if (visible(t)) c += ownText(t);
    const s = getComputedStyle(el);
    return { box: b, mediaArea: Math.min(mediaArea, area(b)), svgArea: Math.min(svgArea, area(b)), chars: c, centred: s.textAlign === "center", links: qsa(el, "a, button").length };
  };
  const sections = roots.map((root) => {
    let parent = root;
    // descend through single wrappers that fill the section
    for (let i = 0; i < 3; i++) {
      const kids = kidsOf(parent).filter(visible);
      if (kids.length !== 1) break;
      const kb = box(kids[0]), pb = box(parent);
      if (kb.w * kb.h < 0.6 * pb.w * pb.h) break;
      parent = kids[0];
    }
    const sb = box(root);
    const big = (el) => visible(el) && area(box(el)) >= 0.02 * area(sb);
    let els = kidsOf(parent).filter(big);
    // a heading over a container that holds the section's real layout (cards, two columns): look inside the container
    const main = els.reduce((m, el) => (!m || area(box(el)) > area(box(m)) ? el : m), null);
    if (main && area(box(main)) >= 0.5 * area(sb) && kidsOf(main).filter(big).length >= 2) els = [...els.filter((el) => el !== main), ...kidsOf(main).filter(big)];
    const blocks = els.map(blockOf);
    let c = 0, v = 0; for (const t of [root, ...qsa(root, "*")]) { if (!visible(t)) continue; const n = ownText(t); c += n; if (vertical(t)) v += n; }
    const st = getComputedStyle(root);
    return { box: sb, bg: st.backgroundColor, ownMedia: /url\\(/.test(st.backgroundImage), borders: { top: parseFloat(st.borderTopWidth) || 0, bottom: parseFloat(st.borderBottomWidth) || 0 }, chars: c, verticalChars: v, blocks };
  });
  let nav = null;
  for (const el of qsa(document, "nav, [role=navigation], header")) {
    if (!visible(el)) continue;
    const links = qsa(el, "a").length;
    if (el.localName === "header" && links < 3) continue;
    nav = { box: box(el), links }; break;
  }
  return { viewport: { width: innerWidth, height: innerHeight }, sections, nav, media, chars, verticalChars, blocked: 0 };
})()`;

/** A tiny grey PNG of 4:3, served for every picture the page asks for when its bytes are not given (keeps its proportions). */
function placeholderPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(3, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const raw = Buffer.alloc(3 * (1 + 4), 0x99);
  for (let r = 0; r < 3; r++) raw[r * 5] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The page is served from this closed origin; nothing else is ever reached. */
const ORIGIN = "http://structure.invalid";

/**
 * Draws the page at one viewport (JS off) and reads its geometry. The page, its stylesheet and its pictures are served
 * from a closed origin by the test harness itself (pictures as given, else as a 4:3 placeholder, so an image sized by
 * its own proportions keeps a real box); every other request is refused and counted.
 */
export async function measurePage(browser: Browser, page: { html: string; css: string; assets?: Record<string, Buffer> }, viewport: { width: number; height: number }): Promise<PageMeasure> {
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport, deviceScaleFactor: 1 });
  let blocked = 0;
  try {
    const placeholder = placeholderPng();
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return (blocked++, route.abort());
      const path = url.pathname;
      // a page that links no stylesheet still gets its CSS, as a link (the CSS text never enters the HTML)
      if (path === "/" || path === "/index.html") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: /<link\b[^>]*stylesheet/i.test(page.html) ? page.html : `<link rel="stylesheet" href="/style.css">${page.html}` });
      if (path.endsWith(".css")) return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: page.css });
      if (/\.(png|jpe?g|webp|gif|avif)$/i.test(path)) return route.fulfill({ status: 200, contentType: "image/png", body: page.assets?.[path.slice(1)] ?? placeholder });
      blocked++;
      return route.abort();
    });
    const p = await context.newPage();
    await p.goto(`${ORIGIN}/index.html`, { waitUntil: "load" });
    return { ...((await p.evaluate(MEASURE)) as PageMeasure), blocked };
  } finally {
    await context.close();
  }
}

const area = (b: Box) => b.w * b.h;
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const isMedia = (b: Block) => b.mediaArea >= 0.5 * area(b.box);
const isText = (b: Block) => !isMedia(b) && b.chars > 0;

type Layout = (typeof VOCABULARY.section_layout)[number];
export function sectionLayout(s: Section): Layout {
  const sa = area(s.box);
  const media = s.blocks.reduce((n, b) => n + b.mediaArea, 0);
  const svg = s.blocks.reduce((n, b) => n + b.svgArea, 0);
  if ((s.ownMedia || media >= 0.6 * sa) && svg < 0.3 * sa) return "full_bleed_media";
  if (svg >= 0.3 * sa) return "diagram";
  const bs = s.blocks;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (overlap(bs[i]!.box, bs[j]!.box) >= 0.15 * Math.min(area(bs[i]!.box), area(bs[j]!.box))) return "overlap_collage";
  if (s.chars > 0 && s.verticalChars / s.chars >= 0.5) return "vertical_text";
  const m = bs.filter(isMedia);
  const t = bs.filter(isText);
  // one picture with text beside it is a split, whatever headings sit above them
  if (m.length === 1) {
    const a = m[0]!.box;
    const beside = t.some(({ box: b }) => {
      const xDisjoint = a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1;
      const yShared = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5 * Math.min(a.h, b.h);
      return xDisjoint && yShared;
    });
    if (beside) return "split_copy_media";
  }
  const rows = new Map<number, Block[]>();
  for (const b of bs) rows.set(Math.round(b.box.y / 20), [...(rows.get(Math.round(b.box.y / 20)) ?? []), b]);
  for (const row of rows.values()) if (row.length >= 3 && row.every((b) => Math.abs(b.box.w - row[0]!.box.w) <= 0.15 * row[0]!.box.w)) return "grid_cards";
  return "single_column_text";
}

/** The measured aspects of one viewport, with the declared ones (hero, flow, reading path) where geometry cannot tell. */
export function describe(m: PageMeasure, declared: { hero?: (typeof VOCABULARY.hero)[number]; flow?: (typeof VOCABULARY.flow)[number]; reading_path?: (typeof VOCABULARY.reading_path)[number] } = {}): StructureDescriptor {
  const vw = m.viewport.width;
  const vh = m.viewport.height;
  const layouts = m.sections.map(sectionLayout);
  const transitions = m.sections.slice(1).map((b, i) => {
    const a = m.sections[i]!;
    const gap = b.box.y - (a.box.y + a.box.h);
    if (gap < -8) return "overlap" as const;
    // the same ground with no rule between them reads as one surface; a rule or a change of ground is a cut
    if (Math.abs(gap) <= 2 && a.bg === b.bg && a.borders.bottom === 0 && b.borders.top === 0) return "continuous" as const;
    return "hard_cut" as const;
  });
  const nav = !m.nav ? "none" : m.nav.box.y < 150 && m.nav.box.w >= 0.6 * vw ? "top_bar" : m.nav.box.x < 0.25 * vw && m.nav.box.h >= 0.5 * vh ? "side_index" : "inline";
  const vshare = m.chars ? m.verticalChars / m.chars : 0;
  const big = m.media.filter((x) => area(x.box) >= 0.08 * vw * vh);
  const photos = big.filter((x) => !x.svg);
  const imagery = big.length === 0 ? "none" : photos.length === 0 ? "drawn" : layouts.includes("overlap_collage") && photos.length >= 2 ? "collage" : photos.length === 1 ? "single_lead" : "sequence";
  // the two generic skeleton signs geometry can see: a split or centred-headline hero, and full-width bands cut hard
  const first = m.sections[0];
  const centred = first && first.blocks.length === 1 && first.blocks[0]!.centred && first.blocks[0]!.links >= 1 && !isMedia(first.blocks[0]!);
  const measuredHero = layouts[0] === "split_copy_media" ? "split_copy_media" : centred ? "centered_headline" : null;
  const bands = m.sections.length >= 4 && !transitions.includes("overlap") && m.sections.every((s) => s.box.w >= 0.95 * vw);
  const measuredFlow = bands && layouts.some((l) => GENERIC.section_layout.has(l)) ? "stacked_bands" : null;
  const pick = <T extends string>(measured: T | null, d: T | undefined) => (measured ? { value: measured, source: "measured" as const } : d ? { value: d, source: "declared" as const } : null);
  return {
    schema: "structure_descriptor_v0",
    hero: pick(measuredHero, declared.hero),
    flow: pick(measuredFlow, declared.flow),
    navigation: { value: nav, source: "measured" },
    reading_path: declared.reading_path ? { value: declared.reading_path, source: "declared" } : null,
    section_layouts: m.sections.length ? { value: layouts, source: "measured" } : null,
    transitions: m.sections.length > 1 ? { value: transitions, source: "measured" } : null,
    text_direction: m.chars ? { value: vshare >= 0.6 ? "vertical" : vshare >= 0.1 ? "mixed" : "horizontal", source: "measured" } : null,
    imagery: { value: imagery, source: "measured" },
  };
}
