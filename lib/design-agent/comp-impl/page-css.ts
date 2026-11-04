/**
 * The page stylesheet's allowlist (DEV-082, re-review of PR #96): the same
 * model as the Stage 3 shop-css guard (shop-css/guard.ts) — everything not
 * listed is refused — for a whole standalone page instead of the renderer's
 * scope. The value grammar is the guard's own (shop-css/values.ts:
 * ELEMENT_PROPS, valueMatches, isLength, isColor), with a few changes for a
 * page (below); the selectors and @media rules are this module's.
 *
 *   selectors   type selectors of the page's allowed elements, `*`, `.class`,
 *               `#id`; :first-child :last-child :only-child :first-of-type
 *               :last-of-type :nth-child(An+B) :nth-of-type(An+B); descendant
 *               and child combinators. No attribute selector, no state
 *               pseudo-class (:hover …: never in a screenshot), NO
 *               pseudo-element at all (::first-letter, ::first-line,
 *               ::marker, ::selection, ::before, ::after …).
 *   @media      only `(min-width: Npx)` / `(max-width: Npx)`, optionally
 *               joined by `and`, N in 320 … 1920; no media type, no other
 *               feature (scripting, prefers-*, print …), not nested.
 *   properties  the guard's table (layout, flex, grid, spacing, colours,
 *               borders, radius, typography basics; position static /
 *               relative without offsets — narrowed below to static, no
 *               transform, opacity 1; box-shadow inset only; list-style none only;
 *               font-size ≥ 12px) minus `order` and the reversing flex
 *               directions, with letter-spacing ≥ 0, text-decoration none /
 *               underline only (default thickness: no style, colour or
 *               thickness property), `background` as a plain colour,
 *               object-fit / object-position for images, and font-family
 *               names from a fixed list of text faces, grid placement by span
 *               only (visual order = source order), text-indent ≤ 2em / 32px;
 *               third review: no viewport or container unit (vw, vh, cq* …),
 *               grid rows sized by content only, grid-auto-flow row only,
 *               float none only, no wrapping column flex in one rule,
 *               text-transform none and font-variant-caps normal only;
 *               fourth review: position static only, no z-index, opacity 1
 *               only, no transform at all, horizontal writing only, no
 *               multi-column layout (no stacking context can exist).
 *               Not listed, so refused: filter,
 *               backdrop-filter, mix-blend-mode, text-shadow,
 *               -webkit-text-stroke, -webkit-text-fill-color, unicode-bidi,
 *               direction, content, counters, zoom, clip-path, mask,
 *               visibility, display: none / list-item, overflow, offsets …
 *   never       !important, custom properties, vendor-prefixed properties
 *               (and the tokenizer's own refusals: escapes, `<`, non-ASCII,
 *               url()).
 */
import { componentValues, CssSyntaxError, tokenize, type CV } from "../shop-css/tokenize";
import { commaGroups, ELEMENT_PROPS, isColor, terms, valueMatches, type Term } from "../shop-css/values";
import { PAGE_ELEMENTS } from "./page-scripts";

type Spec = NonNullable<(typeof ELEMENT_PROPS)[string]>;

export const PAGE_CSS_MEDIA_RANGE = { min: 320, max: 1920 } as const;
export const PAGE_CSS_LIMITS = { rules: 400, declarationsPerRule: 60, selectorsPerRule: 12, compoundsPerSelector: 6, media: 12 } as const;

/** Elements a selector may name (the page's allowed body elements, html and body). */
export const PAGE_CSS_ELEMENTS = Object.keys(PAGE_ELEMENTS).filter((e) => !["head", "meta", "title", "link"].includes(e));
const STRUCTURAL = ["first-child", "last-child", "only-child", "first-of-type", "last-of-type"];
const NTH = ["nth-child", "nth-of-type"];

const kw =
  (...words: string[]) =>
  (t: Term) =>
    t.t === "ident" && words.includes(t.v.toLowerCase());
const one = (...items: Array<(t: Term) => boolean>): Spec => ({ items, max: 1 });

/**
 * Font families a page may name: Japanese and Latin text faces commonly installed (or the generic families). A
 * name not installed falls back along the list; a name not on this list is refused.
 */
export const PAGE_FONT_FAMILIES = [
  "Noto Sans JP", "Noto Serif JP", "Noto Sans CJK JP", "Noto Serif CJK JP", "IPAGothic", "IPAPGothic", "IPAMincho", "IPAPMincho",
  "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Hiragino Mincho ProN", "Yu Gothic", "YuGothic", "Yu Mincho", "YuMincho", "Meiryo",
  "BIZ UDPGothic", "BIZ UDPMincho", "Zen Kaku Gothic New", "Zen Old Mincho", "Shippori Mincho",
  "Inter", "DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif", "Helvetica Neue", "Helvetica", "Arial", "Georgia", "Times New Roman",
] as const;
const GENERIC = ["serif", "sans-serif", "system-ui", "ui-serif", "ui-sans-serif"];
const fontFamilyItem = (t: Term): boolean => {
  if (t.t === "string") return (PAGE_FONT_FAMILIES as readonly string[]).includes(t.v);
  if (t.t === "ident") return GENERIC.includes(t.v.toLowerCase()) || (PAGE_FONT_FAMILIES as readonly string[]).includes(t.v);
  return false;
};

/** Viewport and container units: they make text wrap at widths no breakpoint names, so the checked widths would miss them. */
export const VIEWPORT_UNITS = new Set(["vw", "vh", "vi", "vb", "vmin", "vmax", "svw", "svh", "svi", "svb", "svmin", "svmax", "lvw", "lvh", "lvi", "lvb", "lvmin", "lvmax", "dvw", "dvh", "dvi", "dvb", "dvmin", "dvmax", "cqw", "cqh", "cqi", "cqb", "cqmin", "cqmax"]);
const usesViewportUnit = (list: readonly CV[]): boolean =>
  list.some((c) => (c.t === "dim" && VIEWPORT_UNITS.has(c.unit)) || (c.t === "fn" && usesViewportUnit(c.args)) || (c.t === "block" && usesViewportUnit(c.items)));

/** A grid row sized by content: auto, min-content, max-content, Nfr, minmax(<length>|auto, auto|max-content|Nfr), repeat(n, those). */
function contentTrack(t: Term, depth = 0): boolean {
  if (kw("auto", "min-content", "max-content")(t)) return true;
  if (t.t === "dim" && t.unit === "fr") return t.v > 0 && t.v <= 24;
  if (t.t !== "fn" || depth > 1) return false;
  const args = terms(t.args);
  const groups: Term[][] = [[]];
  for (const a of args) {
    if (a.t === ",") groups.push([]);
    else groups[groups.length - 1]!.push(a);
  }
  if (t.name === "minmax") {
    if (groups.length !== 2 || groups.some((g) => g.length !== 1)) return false;
    const [min, max] = [groups[0]![0]!, groups[1]![0]!];
    const minOk = kw("auto", "min-content")(min) || (min.t === "num" && min.v === 0) || (min.t === "dim" && ["px", "rem", "em"].includes(min.unit) && min.v >= 0 && min.v <= 2400);
    return minOk && (kw("auto", "max-content")(max) || (max.t === "dim" && max.unit === "fr" && max.v > 0 && max.v <= 24));
  }
  if (t.name === "repeat") return groups.length === 2 && groups[0]!.length === 1 && groups[0]![0]!.t === "num" && Number.isInteger(groups[0]![0]!.v) && groups[0]![0]!.v >= 1 && groups[0]![0]!.v <= 12 && groups[1]!.every((x) => contentTrack(x, depth + 1));
  return false;
}

/** The page's property table: the guard's, with the changes listed in the header. */
export const PAGE_PROPS: Readonly<Record<string, Spec>> = (() => {
  const props: Record<string, Spec> = { ...ELEMENT_PROPS };
  delete props.order; // visual order apart from source order
  delete props["text-decoration-style"]; // wavy / double lines
  props["flex-direction"] = one(kw("row", "column"));
  props["flex-wrap"] = one(kw("nowrap", "wrap"));
  props["flex-flow"] = { items: [kw("row", "column", "nowrap", "wrap")], max: 2 };
  props["letter-spacing"] = one(kw("normal"), (t) => (t.t === "num" ? t.v === 0 : t.t === "dim" && ((t.unit === "em" && t.v >= 0 && t.v <= 0.5) || (t.unit === "px" && t.v >= 0 && t.v <= 8))));
  props["text-decoration"] = one(kw("none", "underline"));
  props["text-decoration-line"] = one(kw("none", "underline"));
  props.background = ELEMENT_PROPS["background-color"]!;
  // third review of PR #96: allowed properties combined to move labels, wrap text where no width is sampled, or redraw facts
  props["grid-auto-flow"] = one(kw("row")); // column flow fills down then across: labels beside other values
  props.float = one(kw("none"));
  props["text-transform"] = one(kw("none")); // changes how Latin facts are drawn
  props["font-variant-caps"] = one(kw("normal"));
  // fourth review of PR #96: no stacking or painting-order changes at all, so no box can be lifted over text
  props.position = one(kw("static"));
  delete props["z-index"];
  props.opacity = one((t) => t.t === "num" && t.v === 1);
  delete props.transform; // also drops the small rotation (a transform makes a stacking context)
  delete props["transform-origin"];
  // horizontal writing only (in vertical writing, width becomes the block size: a box shorter than its text)
  props["writing-mode"] = one(kw("horizontal-tb"));
  delete props["text-orientation"];
  // no multi-column layout (a dl split into columns pairs labels with other values)
  delete props["column-count"];
  delete props["column-width"];
  delete props["column-rule"];
  // rows sized by their content only: a fixed row height lets wrapped text leave its box and be painted over
  props["grid-template-rows"] = { items: [contentTrack, kw("none")], max: 12 };
  props["grid-auto-rows"] = { items: [contentTrack], max: 12 };
  // grid items follow the source order: span only, no line numbers, no dense packing (a line number put a label
  // beside another value in the review sweep); the visual order of labels and values is the HTML's
  const spanOnly: Spec = { items: [() => true], max: 2, whole: (list) => (list.length === 1 && kw("auto")(list[0]!)) || (list.length === 2 && kw("span")(list[0]!) && list[1]!.t === "num" && Number.isInteger(list[1]!.v) && list[1]!.v >= 1 && list[1]!.v <= 12) };
  for (const name of ["grid-column", "grid-row", "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end"]) props[name] = spanOnly;
  // (grid-auto-flow: row only, above)
  props["text-indent"] = one((t) => (t.t === "num" && t.v === 0) || (t.t === "dim" && ((t.unit === "em" && t.v >= 0 && t.v <= 2) || (t.unit === "px" && t.v >= 0 && t.v <= 32))));
  props["object-fit"] = one(kw("cover", "contain", "fill", "none", "scale-down"));
  props["object-position"] = { items: [kw("center", "top", "bottom", "left", "right"), (t) => t.t === "pct" && t.v >= 0 && t.v <= 100], max: 2 };
  // known text families only (a symbol font could draw a fact's digits as other glyphs, and the ink proof,
  // drawn in the same face, would not see it), as strings or words; the generic families as words
  props["font-family"] = { items: [fontFamilyItem], max: 1, commas: 8 };
  return props;
})();

/** The px of a (min-width|max-width: Npx) feature, or null. */
function mediaFeature(block: Extract<CV, { t: "block" }>): number | null {
  if (block.open !== "(") return null;
  const list = terms(block.items);
  if (list.length !== 3) return null;
  const [name, colon, value] = list as [Term, Term, Term];
  if (name.t !== "ident" || !["min-width", "max-width"].includes(name.v.toLowerCase()) || colon.t !== ":") return null;
  if (value.t !== "dim" || value.unit !== "px" || value.v < PAGE_CSS_MEDIA_RANGE.min || value.v > PAGE_CSS_MEDIA_RANGE.max) return null;
  return value.v;
}

/** A media prelude: feature (and feature)*, nothing else. */
function mediaOk(prelude: CV[]): boolean {
  const list = prelude.filter((c) => c.t !== "ws");
  if (list.length === 0 || list.length % 2 === 0) return false;
  return list.every((c, i) => (i % 2 === 0 ? c.t === "block" && mediaFeature(c) !== null : c.t === "ident" && c.v.toLowerCase() === "and"));
}

const AN_PLUS_B = /^(odd|even|[+-]?\d{0,2}n([+-]\d{1,2})?|[+-]?\d{1,2})$/;

/** One selector list (the prelude of a style rule); problem codes. */
function selectorProblems(css: string, prelude: CV[]): string[] {
  const p = new Set<string>();
  const groups: CV[][] = [[]];
  for (const c of prelude) {
    if (c.t === ",") groups.push([]);
    else groups[groups.length - 1]!.push(c);
  }
  if (groups.length > PAGE_CSS_LIMITS.selectorsPerRule) p.add("CSS_SELECTOR");
  for (const g of groups) {
    // normalize: whitespace and ">" between compounds become one combinator; none may lead, trail or repeat
    type Comb = { t: "comb"; child: boolean };
    const seq: Array<CV | Comb> = [];
    let bad = false;
    for (const c of g) {
      const last = seq[seq.length - 1];
      if (c.t === "ws") {
        if (seq.length > 0 && last?.t !== "comb") seq.push({ t: "comb", child: false });
      } else if (c.t === "delim" && c.v === ">") {
        if (seq.length === 0) bad = true;
        else if (last?.t === "comb") {
          if (last.child) bad = true;
          last.child = true;
        } else seq.push({ t: "comb", child: true });
      } else seq.push(c);
    }
    const tail = seq[seq.length - 1];
    if (tail?.t === "comb") {
      if (tail.child) bad = true;
      seq.pop();
    }
    if (bad || seq.length === 0) {
      p.add("CSS_SELECTOR");
      continue;
    }
    let compounds = 1;
    let parts = 0;
    for (let i = 0; i < seq.length; i++) {
      const c = seq[i]!;
      if (c.t === "comb") {
        if (parts === 0) p.add("CSS_SELECTOR");
        compounds += 1;
        parts = 0;
        continue;
      }
      if (c.t === "ident") {
        if (parts > 0 || !PAGE_CSS_ELEMENTS.includes(c.v.toLowerCase())) p.add("CSS_SELECTOR");
        parts += 1;
      } else if (c.t === "delim" && c.v === "*") {
        if (parts > 0) p.add("CSS_SELECTOR");
        parts += 1;
      } else if (c.t === "delim" && c.v === ".") {
        const name = seq[i + 1];
        if (name?.t !== "ident" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name.v)) p.add("CSS_SELECTOR");
        i += 1;
        parts += 1;
      } else if (c.t === "hash") {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(c.v)) p.add("CSS_SELECTOR");
        parts += 1;
      } else if (c.t === ":") {
        const next = seq[i + 1];
        if (next?.t === ":") {
          p.add("CSS_PSEUDO_ELEMENT");
          i += 2;
          continue;
        }
        if (next?.t === "ident" && STRUCTURAL.includes(next.v.toLowerCase())) {
          i += 1;
          parts += 1;
        } else if (next?.t === "fn" && NTH.includes(next.name)) {
          const arg = css.slice(next.s, next.e).replace(/^[a-z-]+\(/i, "").replace(/\)$/, "").replace(/\s+/g, "").toLowerCase();
          if (!AN_PLUS_B.test(arg)) p.add("CSS_SELECTOR");
          i += 1;
          parts += 1;
        } else {
          // :hover, :focus, :not(), :has(), :root …; legacy one-colon pseudo-elements (:before, :first-letter …)
          p.add(next?.t === "ident" && ["before", "after", "first-letter", "first-line", "marker", "selection", "placeholder", "backdrop"].includes(next.v.toLowerCase()) ? "CSS_PSEUDO_ELEMENT" : "CSS_SELECTOR");
          i += 1;
        }
      } else {
        // attribute selectors, sibling combinators (+ ~), strings, functions …
        p.add("CSS_SELECTOR");
      }
    }
    if (parts === 0) p.add("CSS_SELECTOR");
    if (compounds > PAGE_CSS_LIMITS.compoundsPerSelector) p.add("CSS_SELECTOR");
  }
  return [...p];
}

/**
 * What an approved, declared capability adds to the allowlist (DEV-102; phase B: DEV-164, docs/design/phase-b-design.md).
 * Default: nothing. One key per capability; run.ts sets a key only through spec.ts pageCssOptionsOf (declared AND in
 * APPROVED_CAPABILITIES — today never for a phase-B one).
 */
export type PageCssOptions = { verticalName?: boolean; displayScale?: boolean; displayNowrap?: boolean; colourSyntax?: boolean; gradientGround?: boolean; translucentDecoration?: boolean };
/**
 * vertical_name (DEV-102): writing-mode may also be vertical-rl. Only the shop name may then be vertical; that, the
 * glyph order and overlap, and horizontal facts are checked in the render (layers.ts V9 and the vertical scan).
 */
const VERTICAL_WRITING_MODE: Spec = one(kw("horizontal-tb", "vertical-rl"));

// ---------------------------------------------------------------- phase B (DEV-164): behind PageCssOptions, all off

/** Phase B limits (docs/design/phase-b-design.md §2). The render-side caps are in phase-b.ts (same numbers). */
export const PHASE_B_CSS_LIMITS = { displayFontPx: 640, displayFontRem: 40, gradientStops: 8, opacityMin: 0.1 } as const;

/** CSS named colours (CSS Color 4) beyond the guard's own (transparent, currentcolor, white, black). */
export const NAMED_COLOURS = new Set(
  ("aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral " +
    "cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange " +
    "darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey " +
    "dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred " +
    "indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey " +
    "lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon " +
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue " +
    "mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna " +
    "silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat whitesmoke yellow yellowgreen").split(" "),
);

const numIn = (t: Term | undefined, min: number, max: number) => t?.t === "num" && t.v >= min && t.v <= max;
const pctIn = (t: Term | undefined, min: number, max: number) => t?.t === "pct" && t.v >= min && t.v <= max;
const hue = (t: Term | undefined) => numIn(t, -360, 360) || (t?.t === "dim" && ((t.unit === "deg" && Math.abs(t.v) <= 360) || (t.unit === "turn" && Math.abs(t.v) <= 1)));
const alphaValue = (t: Term | undefined) => numIn(t, 0, 1) || pctIn(t, 0, 100);

/**
 * The channels of a colour function: space separated with an optional `/ alpha`, or (hsl / hsla only) the legacy comma
 * form. Every channel a plain number, percentage or angle: no calc(), no `none`, no relative colour (`from`), no var().
 */
function colourChannels(fn: Extract<Term, { t: "fn" }>, legacyCommas: boolean): Term[] | null {
  const list = terms(fn.args);
  const commas = list.filter((x) => x.t === ",").length;
  if (commas > 0) {
    if (!legacyCommas || list.some((x) => x.t === "delim")) return null;
    if (list.some((x, i) => (i % 2 === 1) !== (x.t === ","))) return null;
    const parts = list.filter((x) => x.t !== ",");
    return parts.length === 3 || parts.length === 4 ? parts : null;
  }
  const slash = list.findIndex((x) => x.t === "delim" && x.v === "/");
  if (slash < 0) return list.length === 3 && list.every((x) => x.t !== "delim") ? list : null;
  if (slash !== 3 || list.length !== 5 || list.filter((x) => x.t === "delim").length !== 1) return null;
  return [list[0]!, list[1]!, list[2]!, list[4]!];
}

/** colour_syntax (design §2.3): hsl() / hsla(), oklch(), oklab() and the CSS named colours. Never color-mix(), light-dark(), relative colours. */
export function isPhaseBColour(t: Term): boolean {
  if (t.t === "ident") return NAMED_COLOURS.has(t.v.toLowerCase());
  if (t.t !== "fn") return false;
  const c = colourChannels(t, t.name === "hsl" || t.name === "hsla");
  if (!c) return false;
  const alpha = c.length === 3 || alphaValue(c[3]);
  if (t.name === "hsl" || t.name === "hsla") return alpha && hue(c[0]) && pctIn(c[1], 0, 100) && pctIn(c[2], 0, 100);
  if (t.name === "oklch") return alpha && (numIn(c[0], 0, 1) || pctIn(c[0], 0, 100)) && (numIn(c[1], 0, 0.5) || pctIn(c[1], 0, 100)) && hue(c[2]);
  if (t.name === "oklab") return alpha && (numIn(c[0], 0, 1) || pctIn(c[0], 0, 100)) && [c[1], c[2]].every((x) => numIn(x, -0.5, 0.5) || pctIn(x, -100, 100));
  return false;
}
/** The term a phase-B colour is checked as: any hex colour (only colour items take a hash term). */
const HEX_STAND_IN: Term = { t: "hash", v: "000000", s: 0, e: 0 };

/** display_scale (design §2.2): plain px up to 640, rem up to 40 (640px at the 16px root). No calc(), clamp() or max() past 256px. */
const DISPLAY_FONT_SIZE: Spec = one(
  (t) => valueMatches(PAGE_PROPS["font-size"]!, [t]),
  (t) => t.t === "dim" && ((t.unit === "px" && t.v >= 12 && t.v <= PHASE_B_CSS_LIMITS.displayFontPx) || (t.unit === "rem" && t.v >= 0.75 && t.v <= PHASE_B_CSS_LIMITS.displayFontRem)),
);
/** display_nowrap (design §2.8): nowrap and keep-all (the render allows them on display words only). */
const DISPLAY_WHITE_SPACE: Spec = one(kw("normal", "nowrap"));
const DISPLAY_WORD_BREAK: Spec = one((t) => valueMatches(PAGE_PROPS["word-break"]!, [t]), kw("keep-all"));
/** translucent_decoration (design §2.5): opacity 0.1 … 1 (the render allows < 1 on text-free boxes that meet no text only). */
const TRANSLUCENT_OPACITY: Spec = one((t) => t.t === "num" && t.v >= PHASE_B_CSS_LIMITS.opacityMin && t.v <= 1);

const isOne = (t: Term | undefined) => (t?.t === "num" && t.v === 1) || (t?.t === "pct" && t.v === 100);
/**
 * A gradient stop's colour must be opaque (Fresh Review round 2, M1: the stop rule compares RGB only, so a change of alpha
 * alone, e.g. #000 to transparent, was never judged). Fail closed: a hex colour of 3 / 6 digits, or 4 / 8 digits whose
 * alpha is f / ff; white and black (never transparent or currentcolor, which takes the element's colour); rgb() / rgba()
 * with no alpha or an alpha of 1 / 100%; with colour_syntax, a named colour, and hsl() / hsla() / oklch() / oklab() with
 * no alpha or an alpha of 1 / 100%. No color-mix() (its percentages can leave alpha below 1) and no var().
 */
function opaqueStopColour(t: Term, colourSyntax: boolean): boolean {
  if (t.t === "hash") return /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t.v) || /^([0-9a-f]{3}f|[0-9a-f]{6}ff)$/i.test(t.v);
  if (t.t === "ident" && ["white", "black"].includes(t.v.toLowerCase())) return true;
  if (t.t === "fn" && (t.name === "rgb" || t.name === "rgba")) {
    if (!isColor(t)) return false;
    const parts = terms(t.args).filter((x) => x.t !== "," && !(x.t === "delim" && x.v === "/"));
    return parts.length === 3 || isOne(parts[3]);
  }
  if (!colourSyntax || !isPhaseBColour(t)) return false;
  if (t.t === "ident") return true; // NAMED_COLOURS holds no transparent colour
  if (t.t !== "fn") return false;
  const c = colourChannels(t, t.name === "hsl" || t.name === "hsla");
  return c !== null && (c.length === 3 || isOne(c[3]));
}

/**
 * gradient_ground (design §2.4): one linear-gradient() or radial-gradient(), 2 … 8 stops, each an OPAQUE colour
 * (opaqueStopColour: no alpha below 1, no var(), no color-mix()) with at
 * most one percentage position. A linear direction is `to <side> [<side>]` or an angle; a radial shape `circle` or
 * `ellipse` only (no size, no `at`). Nothing else is a function here: repeating-*, conic-gradient(), image-set(),
 * -webkit-image-set(), cross-fade(), element(), paint() … are refused, and url() never gets past the tokenizer.
 */
function gradientItem(colourSyntax: boolean) {
  const colour = (t: Term) => (isColor(t) && !(t.t === "fn" && t.name === "var")) || (colourSyntax && isPhaseBColour(t));
  const stopColour = (t: Term) => colour(t) && opaqueStopColour(t, colourSyntax);
  return (t: Term): boolean => {
    if (t.t !== "fn" || (t.name !== "linear-gradient" && t.name !== "radial-gradient")) return false;
    const groups = commaGroups(terms(t.args));
    if (groups.some((g) => g.length === 0)) return false;
    let stops = groups;
    const first = groups[0]!;
    if (!colour(first[0]!)) {
      const sides = ["top", "bottom", "left", "right"];
      const ok =
        t.name === "linear-gradient"
          ? (first.length === 1 && first[0]!.t === "dim" && ((first[0]!.unit === "deg" && Math.abs(first[0]!.v) <= 360) || (first[0]!.unit === "turn" && Math.abs(first[0]!.v) <= 1))) ||
            (first.length >= 2 && first.length <= 3 && kw("to")(first[0]!) && first.slice(1).every((x) => kw(...sides)(x)) && (first.length === 2 || !(kw("top", "bottom")(first[1]!) && kw("top", "bottom")(first[2]!)) && !(kw("left", "right")(first[1]!) && kw("left", "right")(first[2]!))))
          : first.length === 1 && kw("circle", "ellipse")(first[0]!);
      if (!ok) return false;
      stops = groups.slice(1);
    }
    if (stops.length < 2 || stops.length > PHASE_B_CSS_LIMITS.gradientStops) return false;
    return stops.every((g) => stopColour(g[0]!) && (g.length === 1 || (g.length === 2 && pctIn(g[1], 0, 100))));
  };
}

/** The value grammar of a property under the given options (the base table when no option applies). */
function propertySpecFor(prop: string, opts: PageCssOptions): Spec | undefined {
  if (prop === "writing-mode" && opts.verticalName === true) return VERTICAL_WRITING_MODE;
  if (prop === "font-size" && opts.displayScale === true) return DISPLAY_FONT_SIZE;
  if (prop === "white-space" && opts.displayNowrap === true) return DISPLAY_WHITE_SPACE;
  if (prop === "word-break" && opts.displayNowrap === true) return DISPLAY_WORD_BREAK;
  if (prop === "opacity" && opts.translucentDecoration === true) return TRANSLUCENT_OPACITY;
  if ((prop === "background" || prop === "background-image") && opts.gradientGround === true) {
    const gradient = gradientItem(opts.colourSyntax === true);
    return prop === "background" ? one((t) => valueMatches(PAGE_PROPS.background!, [t]), gradient) : one(kw("none"), gradient);
  }
  return PAGE_PROPS[prop];
}

/** The declarations of one style rule's block; problem codes. */
function declarationProblems(items: CV[], opts: PageCssOptions): string[] {
  const p = new Set<string>();
  const segments: CV[][] = [[]];
  for (const c of items) {
    if (c.t === ";") segments.push([]);
    else segments[segments.length - 1]!.push(c);
  }
  let count = 0;
  let column = false;
  let wrap = false;
  for (const seg of segments) {
    const list = seg.filter((c) => c.t !== "ws");
    if (list.length === 0) continue;
    count += 1;
    const [name, colon] = list;
    if (name?.t !== "ident" || colon?.t !== ":") {
      p.add("CSS_DECLARATION");
      continue;
    }
    const prop = name.v.toLowerCase();
    let value = terms(seg.slice(seg.indexOf(colon) + 1));
    const bang = value.findIndex((t) => t.t === "delim" && t.v === "!");
    if (bang >= 0) {
      p.add("CSS_IMPORTANT");
      value = value.slice(0, bang);
    }
    const spec = propertySpecFor(prop, opts);
    if (!spec) {
      p.add("CSS_PROPERTY");
      continue;
    }
    if (usesViewportUnit(value)) p.add("CSS_VIEWPORT_UNIT");
    // colour_syntax: an hsl() / oklch() / oklab() / named colour stands in for a hex colour where the grammar takes one
    const matches = valueMatches(spec, value) || (opts.colourSyntax === true && value.some(isPhaseBColour) && valueMatches(spec, value.map((t) => (isPhaseBColour(t) ? HEX_STAND_IN : t))));
    if (value.length === 0 || !matches) p.add("CSS_VALUE");
    if (prop === "flex-direction" || prop === "flex-flow") if (value.some((t) => kw("column")(t))) column = true;
    if (prop === "flex-wrap" || prop === "flex-flow") if (value.some((t) => kw("wrap")(t))) wrap = true;
  }
  if (count > PAGE_CSS_LIMITS.declarationsPerRule) p.add("CSS_DECLARATION");
  // a wrapping column flex fills down then across (labels beside other values); the render check catches it across rules
  if (column && wrap) p.add("CSS_FLEX_COLUMN_WRAP");
  return [...p];
}

/** Checks a page stylesheet against the allowlist; problem codes (empty: accepted). */
export function pageCssProblems(css: string, opts: PageCssOptions = {}): string[] {
  let values: CV[];
  try {
    values = componentValues(tokenize(css));
  } catch (error) {
    if (error instanceof CssSyntaxError) return [`CSS_SYNTAX_${error.code.toUpperCase()}`];
    return ["CSS_SYNTAX"];
  }
  const p = new Set<string>();
  let rules = 0;
  let media = 0;
  /** A list of rules (top level, or inside one @media). */
  const ruleList = (list: CV[], nested: boolean) => {
    let prelude: CV[] = [];
    for (const c of list) {
      if (c.t === "block" && c.open === "{") {
        const at = prelude.find((x) => x.t !== "ws");
        if (at?.t === "at") {
          if (at.v !== "media" || nested) p.add(nested ? "CSS_MEDIA_NESTED" : "CSS_AT_RULE");
          else if (!mediaOk(prelude.slice(prelude.indexOf(at) + 1))) p.add("CSS_MEDIA");
          else {
            media += 1;
            ruleList(c.items, true);
          }
        } else {
          rules += 1;
          for (const code of selectorProblems(css, prelude)) p.add(code);
          if (c.items.some((x) => x.t === "block" && x.open === "{")) p.add("CSS_NESTING");
          for (const code of declarationProblems(c.items, opts)) p.add(code);
        }
        prelude = [];
      } else if (c.t === ";") {
        // a statement without a block: @import, @charset, @namespace, stray semicolons
        p.add(prelude.some((x) => x.t === "at") ? "CSS_AT_RULE" : "CSS_STRUCTURE");
        prelude = [];
      } else prelude.push(c);
    }
    if (prelude.some((x) => x.t !== "ws")) p.add(prelude.some((x) => x.t === "at") ? "CSS_AT_RULE" : "CSS_STRUCTURE");
  };
  ruleList(values, false);
  if (rules > PAGE_CSS_LIMITS.rules || media > PAGE_CSS_LIMITS.media) p.add("CSS_LIMITS");
  return [...p].sort();
}

/** The px of every accepted @media width feature (for the widths to check: render-check.ts checkWidths). */
export function pageBreakpointsPx(css: string): number[] {
  let values: CV[];
  try {
    values = componentValues(tokenize(css));
  } catch {
    return [];
  }
  const out = new Set<number>();
  let prelude: CV[] = [];
  for (const c of values) {
    if (c.t === "block" && c.open === "{") {
      const at = prelude.find((x) => x.t !== "ws");
      const rest = at ? prelude.slice(prelude.indexOf(at) + 1) : [];
      if (at?.t === "at" && at.v === "media" && mediaOk(rest)) for (const f of rest) if (f.t === "block") out.add(mediaFeature(f)!);
      prelude = [];
    } else if (c.t === ";") prelude = [];
    else prelude.push(c);
  }
  return [...out].sort((a, b) => a - b);
}
