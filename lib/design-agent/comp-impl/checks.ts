/**
 * The comp implementation's checks (DEV-082), as pure functions over what the
 * browser measured (page-scripts.ts, render.ts). Each returns { ok, codes } and
 * a few numbers; codes are fixed strings. None of them judges beauty or
 * likeness to the comp: they check that the page keeps to the facts, the
 * disclosure, the spec's measurable layout and the page's own soundness.
 * Likeness is similarity.ts, and it never passes on its own.
 */
import type { DemoView } from "@/lib/sales/demo-content";
import type { Measure } from "../shop-css/page-scripts";
import { CONTRAST_TOLERANCE, INK_RATIO, MIN_FONT_PX, MIN_OPACITY, overprinted, type Ink } from "../shop-css/render-check";
import type { CompMeasure, DomAudit, ProtectedScan } from "./page-scripts";
import { PAGE_ELEMENTS } from "./page-scripts";
import type { PageAsset } from "./page";
import { COMP_ALT_TEXTS, COMP_UI_LABELS, factValues, SALES_UI, type CompSpec } from "./spec";
import { POC_DISCLOSURE, POC_DISCLOSURE_V2 } from "../design-image/prompt";

export type CheckResult = { ok: boolean; codes: string[] } & Record<string, unknown>;
const result = (codes: Iterable<string>, extra: Record<string, unknown> = {}): CheckResult => {
  const list = [...new Set(codes)].sort();
  return { ok: list.length === 0, codes: list, ...extra };
};
const flat = (s: string) => s.replace(/\s+/g, "");
const byLength = (a: string, b: string) => b.length - a.length;
const strip = (text: string, phrases: readonly string[]) => [...phrases].map(flat).filter(Boolean).sort(byLength).reduce((s, p) => s.split(p).join(""), text);
/** Separators a label line may use between allowed parts (the disclosure's ｜, list dots). */
const SEPARATORS = /[｜|・／/、。:：\-–—]/g;

// ---------------------------------------------------------------- tolerances

/** Section boxes: x / w as a share of the page width, y / h as a share of the page height. */
export const GEOMETRY_TOLERANCE = { x: 0.05, w: 0.06, y: 0.06, h: 0.06 } as const;
/** A painted colour counts as a palette colour when every channel is within this many levels. */
export const PALETTE_CHANNEL_TOLERANCE = 10;
/** Type sizes on the desktop page: within this share of the spec's px. */
export const TYPE_SIZE_TOLERANCE = 0.2;
/** Section padding on the desktop page: within this share of the spec's px (or 8 px, whichever is larger). */
export const SPACING_TOLERANCE = 0.3;
/** Image slots: rendered aspect within this share of the spec's; an img drawn with object-fit: fill within IMAGE_DISTORTION of its own. */
export const SLOT_ASPECT_TOLERANCE = 0.1;
export const IMAGE_DISTORTION = 0.02;

// ---------------------------------------------------------------- DOM

export function domProblems(audit: DomAudit): CheckResult {
  const codes: string[] = [];
  if (audit.elements.length > 0) codes.push("DOM_ELEMENT_NOT_ALLOWED");
  if (audit.attributes.length > 0) codes.push("DOM_ATTRIBUTE_NOT_ALLOWED");
  if (audit.links.length !== 1 || audit.links[0]!.rel !== "stylesheet" || audit.links[0]!.href !== "style.css") codes.push("DOM_STYLESHEET_LINK");
  for (const m of audit.metas) {
    if (m.charset !== null && m.charset.toLowerCase() !== "utf-8") codes.push("DOM_META");
    if (m.charset === null && m.name !== "viewport") codes.push("DOM_META");
  }
  return result(codes, { elements: audit.elements.slice(0, 10), attributes: audit.attributes.slice(0, 10), allowed_elements: Object.keys(PAGE_ELEMENTS).length });
}

// ---------------------------------------------------------------- facts

export type FactsInput = { spec: CompSpec; demo: DemoView; disclosure: string };

/**
 * Every visible word is a fact, a verbatim fact excerpt the spec declared, a
 * fixed UI label or the disclosure (the demo templates' allowlist method,
 * tests/unit/sales/demo-templates.test.tsx), counted per text node so a fact
 * is never pieced together from separate nodes; hidden text counts too. Alt,
 * aria-label and the title are text as well (alt from COMP_ALT_TEXTS only).
 * Required facts must be shown verbatim in one displayed text node.
 */
export function factsCheck(m: CompMeasure, input: FactsInput): CheckResult {
  const facts = factValues(input.demo);
  const values = [...facts.values(), ...(input.demo.ward ? [input.demo.ward] : [])];
  const allowed = [...COMP_UI_LABELS, POC_DISCLOSURE_V2, POC_DISCLOSURE];
  const codes: string[] = [];
  const leftovers: string[] = [];
  for (const t of m.texts) {
    if (SALES_UI.test(t.text)) codes.push("FACTS_SALES_WORD");
    const rest = strip(strip(strip(flat(t.text), values), input.spec.fact_phrases), allowed).replace(SEPARATORS, "");
    if (rest) leftovers.push(rest.slice(0, 40));
  }
  if (leftovers.length > 0) codes.push("FACTS_UNKNOWN_TEXT");
  for (const a of m.attrTexts) {
    if (a.kind === "alt" && a.text !== "" && !(COMP_ALT_TEXTS as readonly string[]).includes(a.text)) codes.push("FACTS_ALT_NOT_ALLOWED");
    if (a.kind === "aria" && !(COMP_UI_LABELS as readonly string[]).includes(a.text)) codes.push("FACTS_ARIA_NOT_ALLOWED");
    if (a.kind === "title" && a.text !== input.demo.name && a.text !== `${input.demo.name}｜${POC_DISCLOSURE}`) codes.push("FACTS_TITLE_NOT_ALLOWED");
  }
  const shownFlat = m.texts.filter((t) => t.shown).map((t) => flat(t.text));
  const missing = input.spec.required_facts.filter((key) => {
    const value = facts.get(key);
    return value === undefined || !shownFlat.some((t) => t.includes(flat(value)));
  });
  if (missing.length > 0) codes.push("FACTS_REQUIRED_MISSING");
  return result(codes, { unknown_text_nodes: leftovers.length, missing });
}

// ---------------------------------------------------------------- disclosure

/** The disclosure a page must show: the AI one when any AI concept image is drawn, else the fictional-shop one. */
export function requiredDisclosure(assets: readonly PageAsset[], m: CompMeasure): string {
  const ai = new Set(assets.filter((a) => a.kind === "ai_concept_local").map((a) => a.file));
  return m.imgs.some((i) => ai.has(i.src)) ? POC_DISCLOSURE_V2 : POC_DISCLOSURE;
}

export function disclosureCheck(m: CompMeasure, spec: CompSpec, required: string): CheckResult {
  const codes: string[] = [];
  if (m.disclosures.length !== 1) codes.push("DISCLOSURE_COUNT");
  const d = m.disclosures[0];
  if (d) {
    if (d.text !== required) codes.push("DISCLOSURE_TEXT");
    if (!d.shown) codes.push("DISCLOSURE_HIDDEN");
    if (d.fontSize < MIN_FONT_PX) codes.push("DISCLOSURE_TOO_SMALL");
    if (d.section !== spec.disclosure.section) codes.push("DISCLOSURE_PLACEMENT");
  }
  if (spec.disclosure.text !== required) codes.push("DISCLOSURE_SPEC_MISMATCH");
  return result(codes, { required: required === POC_DISCLOSURE_V2 ? "ai_images" : "fictional_shop" });
}

// ---------------------------------------------------------------- sections

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Desktop: the sections in the spec's order, each box within GEOMETRY_TOLERANCE of the spec's. */
export function geometryCheck(m: CompMeasure, spec: CompSpec): CheckResult {
  const codes: string[] = [];
  const shown = m.sections.filter((s) => s.shown);
  const ids = shown.map((s) => s.id);
  if (new Set(ids).size !== ids.length) codes.push("SECTION_REPEAT");
  const order = [...shown].sort((a, b) => a.box.top - b.box.top).map((s) => s.id);
  if (order.join("|") !== spec.sections.map((s) => s.id).join("|")) codes.push("SECTION_ORDER");
  let worst = 0;
  const off: string[] = [];
  for (const want of spec.sections) {
    const got = shown.find((s) => s.id === want.id);
    if (!got) {
      codes.push("SECTION_MISSING");
      continue;
    }
    const d = {
      x: Math.abs(got.box.left / m.width - want.box.x),
      w: Math.abs(got.box.width / m.width - want.box.w),
      y: Math.abs(got.box.top / m.height - want.box.y),
      h: Math.abs(got.box.height / m.height - want.box.h),
    };
    worst = Math.max(worst, d.x, d.w, d.y, d.h);
    if (d.x > GEOMETRY_TOLERANCE.x || d.w > GEOMETRY_TOLERANCE.w || d.y > GEOMETRY_TOLERANCE.y || d.h > GEOMETRY_TOLERANCE.h) off.push(want.id);
  }
  if (off.length > 0) codes.push("SECTION_GEOMETRY");
  return result(codes, { worst_delta: round3(worst), off, page_aspect_h_per_w: round3(m.height / m.width), comp_aspect_h_per_w: round3(spec.artboard.height_px / spec.artboard.width_px) });
}

/** Mobile: the spec's mobile order, every section shown. */
export function mobileOrderCheck(m: CompMeasure, spec: CompSpec): CheckResult {
  const shown = m.sections.filter((s) => s.shown);
  const order = [...shown].sort((a, b) => a.box.top - b.box.top).map((s) => s.id);
  return result(order.join("|") === spec.mobile.order.join("|") ? [] : ["MOBILE_ORDER"]);
}

// ---------------------------------------------------------------- palette, type, spacing

const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

export function paletteCheck(m: CompMeasure, spec: CompSpec): CheckResult {
  const palette = spec.palette.map((p) => hexRgb(p.hex));
  const near = (c: readonly number[]) => palette.some((p) => p.every((v, i) => Math.abs(v - c[i]!) <= PALETTE_CHANNEL_TOLERANCE));
  const painted = m.colours.filter((c) => c.kind !== "image");
  const outside = painted.filter((c) => !near(c.rgba));
  const codes = outside.length > 0 ? ["PALETTE_OUTSIDE"] : [];
  const used = new Set(spec.palette.filter((p) => painted.some((c) => hexRgb(p.hex).every((v, i) => Math.abs(v - c.rgba[i]!) <= PALETTE_CHANNEL_TOLERANCE))).map((p) => p.hex));
  return result(codes, {
    colours: painted.length,
    outside: outside.slice(0, 8).map((c) => ({ kind: c.kind, rgb: c.rgba.slice(0, 3) })),
    palette_used: used.size,
    palette_size: spec.palette.length,
    background_images: m.colours.filter((c) => c.kind === "image").length,
  });
}

const ROLE_KEYS = { display: "display_px", heading: "heading_px", caption: "caption_px", body: "body_px", label: "label_px" } as const;
type Role = keyof typeof ROLE_KEYS;

/** Type: every role the spec names is used; the order display > heading > body holds; desktop sizes near the spec. */
export function typeCheck(m: CompMeasure, spec: CompSpec, o: { desktop: boolean }): CheckResult {
  const codes: string[] = [];
  const max: Partial<Record<Role, number>> = {};
  for (const t of m.types) {
    if (!(t.role in ROLE_KEYS)) {
      codes.push("TYPE_ROLE_UNKNOWN");
      continue;
    }
    const role = t.role as Role;
    max[role] = Math.max(max[role] ?? 0, t.fontSize);
    if (t.fontSize < MIN_FONT_PX) codes.push("TYPE_TOO_SMALL");
  }
  for (const role of ["display", "heading", "body"] as const) if (max[role] === undefined) codes.push("TYPE_ROLE_MISSING");
  if (max.display !== undefined && max.heading !== undefined && !(max.display > max.heading)) codes.push("TYPE_HIERARCHY");
  if (max.heading !== undefined && max.body !== undefined && !(max.heading > max.body)) codes.push("TYPE_HIERARCHY");
  const off: string[] = [];
  if (o.desktop) {
    for (const [role, key] of Object.entries(ROLE_KEYS) as Array<[Role, (typeof ROLE_KEYS)[Role]]>) {
      const got = max[role];
      if (got === undefined) continue;
      if (Math.abs(got - spec.type_scale[key]) > spec.type_scale[key] * TYPE_SIZE_TOLERANCE) off.push(role);
    }
    if (off.length > 0) codes.push("TYPE_SIZE");
  }
  for (const t of m.texts) if (t.shown && t.fontSize < MIN_FONT_PX) codes.push("TEXT_TOO_SMALL");
  return result(codes, { sizes: max, off });
}

/** Desktop spacing: inner sections' vertical padding near the spec, content containers no wider than its max width. */
export function spacingCheck(m: CompMeasure, spec: CompSpec): CheckResult {
  const codes: string[] = [];
  const inner = new Set(spec.sections.filter((s) => s.role !== "header" && s.role !== "footer").map((s) => s.id));
  const want = spec.spacing.section_padding_px;
  const tol = Math.max(8, want * SPACING_TOLERANCE);
  const off = m.sections.filter((s) => s.shown && inner.has(s.id) && (Math.abs(s.paddingTop - want) > tol || Math.abs(s.paddingBottom - want) > tol)).map((s) => s.id);
  if (off.length > 0) codes.push("SPACING_SECTION_PADDING");
  if (m.containers.length === 0) codes.push("SPACING_NO_CONTAINER");
  if (m.containers.some((c) => c.width > spec.spacing.content_max_width_px + 1)) codes.push("SPACING_CONTAINER_WIDTH");
  return result(codes, { off });
}

// ---------------------------------------------------------------- links

/** Nav and CTA as the spec says; every link an in-page anchor to an existing element (no dead or external link). */
export function linksCheck(m: CompMeasure, spec: CompSpec): CheckResult {
  const codes: string[] = [];
  for (const l of m.links) {
    if (!l.hasHref || !l.href.startsWith("#") || l.href.length < 2) codes.push("LINK_NOT_ANCHOR");
    else if (!l.target) codes.push("LINK_DEAD");
  }
  const want = spec.nav.items.map((n) => `${n.label}#${n.target}`).join("|");
  if (m.nav.map((n) => `${n.text}${n.href}`).join("|") !== want) codes.push("NAV_MISMATCH");
  if (spec.cta) {
    const cta = m.ctas[0];
    if (m.ctas.length !== 1 || !cta) codes.push("CTA_COUNT");
    else {
      if (cta.tag !== "a" || cta.text !== spec.cta.label || cta.href !== `#${spec.cta.target}`) codes.push("CTA_MISMATCH");
      if (!cta.shown) codes.push("CTA_HIDDEN");
    }
  } else if (m.ctas.length > 0) codes.push("CTA_COUNT");
  return result(codes, { links: m.links.length });
}

// ---------------------------------------------------------------- images

/**
 * Every spec slot filled once, inside its section, at about the spec's aspect;
 * an img loaded and not stretched (object-fit fill keeps its own aspect); an AI
 * slot holds a reviewed AI concept asset; a placeholder slot a flat placeholder;
 * every img sits in a slot and comes from the page's asset list.
 */
export function imagesCheck(m: CompMeasure, spec: CompSpec, assets: readonly PageAsset[]): CheckResult {
  const codes: string[] = [];
  const files = new Map(assets.map((a) => [a.file, a]));
  for (const img of m.imgs) {
    if (!img.inSlot) codes.push("IMAGE_OUTSIDE_SLOT");
    if (!files.has(img.src)) codes.push("IMAGE_NOT_LISTED");
  }
  const ids = m.slots.map((s) => s.id);
  if (new Set(ids).size !== ids.length) codes.push("SLOT_REPEAT");
  for (const s of m.slots) if (!spec.image_slots.some((w) => w.id === s.id)) codes.push("SLOT_UNKNOWN");
  for (const want of spec.image_slots) {
    const got = m.slots.find((s) => s.id === want.id);
    if (!got || !got.shown || got.box.width < 1 || got.box.height < 1) {
      codes.push("SLOT_EMPTY");
      continue;
    }
    if (got.section !== want.section) codes.push("SLOT_PLACEMENT");
    const aspect = got.box.width / got.box.height;
    if (Math.abs(aspect - want.aspect_w_per_h) > want.aspect_w_per_h * SLOT_ASPECT_TOLERANCE) codes.push("SLOT_ASPECT");
    if (got.tag === "img") {
      if (!got.complete || got.naturalWidth === 0 || got.naturalHeight === 0) codes.push("IMAGE_NOT_LOADED");
      else if (got.objectFit === "fill" && Math.abs(aspect / (got.naturalWidth / got.naturalHeight) - 1) > IMAGE_DISTORTION) codes.push("IMAGE_DISTORTED");
      const asset = files.get(got.src);
      if (want.kind === "ai_concept" && asset?.kind !== "ai_concept_local") codes.push("SLOT_KIND");
      if (want.kind === "placeholder" && asset?.kind !== "placeholder") codes.push("SLOT_KIND");
    } else {
      if (!got.placeholder || want.kind !== "placeholder") codes.push("SLOT_KIND");
    }
  }
  return result(codes, { slots: spec.image_slots.length, images: m.imgs.length });
}

// ---------------------------------------------------------------- overflow, text soundness

export function overflowCheck(byWidth: ReadonlyArray<{ width: number; overflow: number }>): CheckResult {
  const over = byWidth.filter((w) => w.overflow > 0).map((w) => w.width);
  return result(over.length > 0 ? ["OVERFLOW_HORIZONTAL"] : [], { widths: byWidth.map((w) => w.width), overflowing: over });
}

/**
 * Text soundness from the shop-CSS render check's own measurement
 * (shop-css/page-scripts.ts MEASURE_SCRIPT, with the whole body as its scope)
 * and its text-on-text test (overprinted): no displayed text clipped by an
 * ancestor, off the page, covered by another element, out of its own box,
 * smaller than MIN_FONT_PX, faded or squeezed; no text printed over other text.
 * Hidden labels are allowed (a nav collapsed on a phone); hidden facts are not.
 */
export function textCheck(measure: Measure): CheckResult {
  const nodes = measure.nodes.filter((n) => n.kind === "fact" || n.kind === "label");
  const scoped: Measure = { ...measure, nodes };
  const over = overprinted(scoped);
  const codes: string[] = [];
  let bad = 0;
  nodes.forEach((n, i) => {
    if (n.hidden) {
      if (n.kind === "fact") codes.push("TEXT_FACT_HIDDEN");
      return;
    }
    const problems = [n.clipped && "TEXT_CLIPPED", n.offscreen && "TEXT_OFFSCREEN", n.covered && "TEXT_COVERED", n.overflow && "TEXT_OUT_OF_BOX", n.fontSize < MIN_FONT_PX && "TEXT_TOO_SMALL", n.opacity < MIN_OPACITY && "TEXT_FADED", n.squeezed && "TEXT_SQUEEZED", over[i] && "TEXT_OVERLAP"].filter(
      (x): x is string => typeof x === "string",
    );
    if (problems.length > 0) bad += 1;
    codes.push(...problems);
  });
  if (measure.scripts > 0) codes.push("PAGE_HAS_SCRIPT");
  return result(codes, { nodes: nodes.length, nodes_with_problems: bad });
}

// ---------------------------------------------------------------- protected text (disclosure, required facts)

export type LegibilityInput = {
  measure: Measure;
  scan: ProtectedScan;
  lowContrast: ReadonlyMap<number, number>;
  ink: ReadonlyMap<number, Ink>;
  inkExcess: ReadonlyMap<number, number>;
};

/** Protected text may carry at most this much more ink than the same glyphs alone (antialiasing differs a little; a bar, a shadow or overprint adds far more). */
export const INK_EXCESS_MAX = 1.15;

/**
 * The disclosure and every required fact must be really readable at this
 * width (review of PR #96: transparent colour or fill, the ground's colour,
 * zoom, clip-path, aria-hidden with off-screen placement, scale + opacity all
 * passed before). For each element that holds protected text, every measured
 * node of it must be shown and free of every TEXT_* problem, its size times
 * the zoom chain at least MIN_FONT_PX, its opacity product at least
 * MIN_OPACITY, its colour fully opaque with no different text fill, no
 * clip-path / mask / filter / blend / clip on its chain, at most
 * CONTRAST_TOLERANCE of its ground below 4.5:1 (lowContrastShare) and its ink
 * kept (inkOf, INK_RATIO). aria-hidden over any text is refused outright: such
 * text is skipped by every measurement.
 */
export function legibilityCheck(l: LegibilityInput, o: { required: readonly string[]; disclosure: string }): CheckResult {
  const codes: string[] = [];
  if (l.scan.ariaHiddenText > 0) codes.push("TEXT_ARIA_HIDDEN");
  if (l.scan.unmeasuredDisclosure > 0) codes.push("DISCLOSURE_NOT_MEASURED");
  const nodes = l.measure.nodes;
  const scoped = nodes.map((n) => (n.kind === "fact" || n.kind === "label" ? n : { ...n, hidden: true, chars: [] }));
  const over = overprinted({ ...l.measure, nodes: scoped });
  const ownerProblems = new Map<number, string[]>();
  for (const owner of l.scan.owners) {
    const p = new Set<string>();
    const mine = nodes.map((n, i) => ({ n, i })).filter(({ n }) => (n.kind === "fact" || n.kind === "label") && n.owner === owner.owner);
    if (mine.length === 0) p.add("NOT_MEASURED");
    for (const { n, i } of mine) {
      if (n.hidden) p.add("HIDDEN");
      if (n.clipped) p.add("CLIPPED");
      if (n.offscreen) p.add("OFFSCREEN");
      if (n.covered) p.add("COVERED");
      if (n.overflow) p.add("OUT_OF_BOX");
      if (n.squeezed) p.add("SQUEEZED");
      if (over[i]) p.add("OVERLAP");
      if (n.fontSize * owner.zoom < MIN_FONT_PX) p.add("TOO_SMALL");
      if (n.opacity < MIN_OPACITY) p.add("FADED");
      if ((l.lowContrast.get(i) ?? 1) > CONTRAST_TOLERANCE) p.add("LOW_CONTRAST");
      const ink = l.ink.get(i);
      if (!ink || ink.missing > 0 || ink.ratio < INK_RATIO) p.add("NO_INK");
      if ((l.inkExcess.get(i) ?? Number.POSITIVE_INFINITY) > INK_EXCESS_MAX) p.add("INK_EXCESS");
    }
    if (owner.colourAlpha < 255) p.add("COLOUR_ALPHA");
    if (owner.fillDiffers) p.add("TEXT_FILL");
    if (owner.effects) p.add("EFFECT");
    ownerProblems.set(owner.owner, [...p]);
    for (const code of p) codes.push(`${owner.disclosure ? "DISCLOSURE" : "FACT"}_${code}`);
  }
  // the disclosure: its measured, clean text is exactly the required line
  const disclosureOwners = l.scan.owners.filter((x) => x.disclosure);
  const disclosureText = disclosureOwners.flatMap((x) => nodes.filter((n) => (n.kind === "fact" || n.kind === "label") && n.owner === x.owner && !n.hidden).map((n) => n.text)).join("").replace(/\s+/g, "");
  if (l.scan.disclosures !== 1 || disclosureOwners.length === 0 || disclosureText !== o.disclosure.replace(/\s+/g, "")) codes.push("DISCLOSURE_NOT_LEGIBLE");
  // every required fact: in at least one element whose text is clean
  const unreadable = o.required.filter((_f, r) => !l.scan.owners.some((x) => x.facts.includes(r) && (ownerProblems.get(x.owner) ?? ["?"]).length === 0));
  if (unreadable.length > 0) codes.push("FACTS_REQUIRED_NOT_LEGIBLE");
  return result(codes, { protected_elements: l.scan.owners.length, unreadable_facts: unreadable.length });
}
