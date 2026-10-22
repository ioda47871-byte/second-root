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
 *               relative without offsets; transform: a small rotation only;
 *               opacity ≥ 0.85; box-shadow inset only; list-style none only;
 *               font-size ≥ 12px) minus `order` and the reversing flex
 *               directions, with letter-spacing ≥ 0, text-decoration none /
 *               underline only (default thickness: no style, colour or
 *               thickness property), `background` as a plain colour,
 *               object-fit / object-position for images, and font-family
 *               names from a fixed list of text faces, grid placement by span
 *               only (visual order = source order), text-indent ≤ 2em / 32px.
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
import { ELEMENT_PROPS, terms, valueMatches, type Term } from "../shop-css/values";
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
  // grid items follow the source order: span only, no line numbers, no dense packing (a line number put a label
  // beside another value in the review sweep); the visual order of labels and values is the HTML's
  const spanOnly: Spec = { items: [() => true], max: 2, whole: (list) => (list.length === 1 && kw("auto")(list[0]!)) || (list.length === 2 && kw("span")(list[0]!) && list[1]!.t === "num" && Number.isInteger(list[1]!.v) && list[1]!.v >= 1 && list[1]!.v <= 12) };
  for (const name of ["grid-column", "grid-row", "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end"]) props[name] = spanOnly;
  props["grid-auto-flow"] = one(kw("row", "column"));
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

/** The declarations of one style rule's block; problem codes. */
function declarationProblems(items: CV[]): string[] {
  const p = new Set<string>();
  const segments: CV[][] = [[]];
  for (const c of items) {
    if (c.t === ";") segments.push([]);
    else segments[segments.length - 1]!.push(c);
  }
  let count = 0;
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
    const spec = PAGE_PROPS[prop];
    if (!spec) {
      p.add("CSS_PROPERTY");
      continue;
    }
    if (value.length === 0 || !valueMatches(spec, value)) p.add("CSS_VALUE");
  }
  if (count > PAGE_CSS_LIMITS.declarationsPerRule) p.add("CSS_DECLARATION");
  return [...p];
}

/** Checks a page stylesheet against the allowlist; problem codes (empty: accepted). */
export function pageCssProblems(css: string): string[] {
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
          for (const code of declarationProblems(c.items)) p.add(code);
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
