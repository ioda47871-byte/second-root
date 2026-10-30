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
import type { Browser } from "playwright";
import { GENERIC, type StructureDescriptor, type VOCABULARY } from "./descriptor";

type Box = { x: number; y: number; w: number; h: number };
type Block = { box: Box; mediaArea: number; svgArea: number; chars: number; centred: boolean; links: number };
type Section = { box: Box; bg: string; borders: { top: number; bottom: number }; chars: number; verticalChars: number; blocks: Block[] };
export type PageMeasure = {
  viewport: { width: number; height: number };
  sections: Section[];
  nav: { box: Box; links: number } | null;
  media: { box: Box; svg: boolean }[];
  chars: number;
  verticalChars: number;
};

export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;

const MEASURE = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
  const area = (b) => b.w * b.h;
  const isMediaEl = (el) => ["img", "svg", "picture", "video", "canvas"].includes(el.localName) || /url\\(/.test(getComputedStyle(el).backgroundImage);
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("").length;
  const vertical = (el) => /^vertical|^sideways/.test(getComputedStyle(el).writingMode);
  let chars = 0, verticalChars = 0;
  for (const el of document.body.querySelectorAll("*")) { if (!visible(el)) continue; const n = ownText(el); chars += n; if (vertical(el)) verticalChars += n; }
  const media = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el) || !isMediaEl(el) || el.closest("svg") !== el && el.closest("svg")) continue;
    media.push({ box: box(el), svg: el.localName === "svg" });
  }
  let roots = [...document.querySelectorAll("[data-section]")].filter((el) => !el.parentElement.closest("[data-section]") && visible(el));
  if (!roots.length) roots = [...document.body.children].filter((el) => visible(el) && el.getBoundingClientRect().height > 40);
  const blockOf = (el) => {
    const b = box(el);
    let mediaArea = 0, svgArea = 0;
    for (const m of [el, ...el.querySelectorAll("*")]) {
      if (!visible(m) || !isMediaEl(m)) continue;
      const mb = box(m);
      mediaArea += area(mb);
      if (m.localName === "svg") svgArea += area(mb);
      if (m.localName === "svg") break;
    }
    let c = 0; for (const t of [el, ...el.querySelectorAll("*")]) if (visible(t)) c += ownText(t);
    const s = getComputedStyle(el);
    return { box: b, mediaArea: Math.min(mediaArea, area(b)), svgArea: Math.min(svgArea, area(b)), chars: c, centred: s.textAlign === "center", links: el.querySelectorAll("a, button").length };
  };
  const sections = roots.map((root) => {
    let parent = root;
    // descend through single wrappers that fill the section
    for (let i = 0; i < 3; i++) {
      const kids = [...parent.children].filter(visible);
      if (kids.length !== 1) break;
      const kb = box(kids[0]), pb = box(parent);
      if (kb.w * kb.h < 0.6 * pb.w * pb.h) break;
      parent = kids[0];
    }
    const sb = box(root);
    const blocks = [...parent.children].filter((el) => visible(el) && area(box(el)) >= 0.02 * area(sb)).map(blockOf);
    let c = 0, v = 0; for (const t of [root, ...root.querySelectorAll("*")]) { if (!visible(t)) continue; const n = ownText(t); c += n; if (vertical(t)) v += n; }
    const st = getComputedStyle(root);
    return { box: sb, bg: st.backgroundColor, borders: { top: parseFloat(st.borderTopWidth) || 0, bottom: parseFloat(st.borderBottomWidth) || 0 }, chars: c, verticalChars: v, blocks };
  });
  let nav = null;
  for (const el of document.querySelectorAll("nav, [role=navigation], header")) {
    if (!visible(el)) continue;
    const links = el.querySelectorAll("a").length;
    if (el.localName === "header" && links < 3) continue;
    nav = { box: box(el), links }; break;
  }
  return { viewport: { width: innerWidth, height: innerHeight }, sections, nav, media, chars, verticalChars };
})()`;

/** Draws the page at one viewport (JS off, no network) and reads its geometry. */
export async function measurePage(browser: Browser, page: { html: string; css: string }, viewport: { width: number; height: number }): Promise<PageMeasure> {
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport, deviceScaleFactor: 1 });
  try {
    await context.route("**/*", (route) => route.abort());
    const p = await context.newPage();
    // the stylesheet link is replaced by the CSS inline; nothing is fetched
    const html = page.html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "");
    const withCss = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `<style>${page.css.replace(/<\/style/gi, "<\\/style")}</style></head>`) : `<style>${page.css}</style>${html}`;
    await p.setContent(withCss, { waitUntil: "load" });
    return (await p.evaluate(MEASURE)) as PageMeasure;
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
  if (media >= 0.6 * sa && svg < 0.3 * sa) return "full_bleed_media";
  if (svg >= 0.3 * sa) return "diagram";
  const bs = s.blocks;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (overlap(bs[i]!.box, bs[j]!.box) >= 0.15 * Math.min(area(bs[i]!.box), area(bs[j]!.box))) return "overlap_collage";
  if (s.chars > 0 && s.verticalChars / s.chars >= 0.5) return "vertical_text";
  const m = bs.filter(isMedia);
  const t = bs.filter(isText);
  if (m.length === 1 && t.length === 1 && bs.length <= 3) {
    const [a, b] = [m[0]!.box, t[0]!.box];
    const xDisjoint = a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1;
    const yShared = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5 * Math.min(a.h, b.h);
    if (xDisjoint && yShared) return "split_copy_media";
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
