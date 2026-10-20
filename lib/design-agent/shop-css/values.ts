import type { CV } from "./tokenize";

// Value grammar of the per-shop CSS guard (DEV-072): an explicit allowlist of
// properties, each with the kinds of value it takes and caps on magnitudes.
// Anything not listed is rejected. Values are re-serialized from the parsed
// terms, never copied from the input.

/** Terms of a value: whitespace dropped, commas and slashes kept as separators. */
export type Term = Exclude<CV, { t: "ws" }>;

export const terms = (items: CV[]): Term[] => items.filter((c): c is Term => c.t !== "ws");

/** Splits terms at top-level commas. */
export function commaGroups(list: Term[]): Term[][] {
  const groups: Term[][] = [[]];
  for (const t of list) {
    if (t.t === ",") groups.push([]);
    else groups[groups.length - 1]!.push(t);
  }
  return groups;
}

// ---------------------------------------------------------------- lengths

/** Rough px for caps (1440px is the widest checked viewport; vw counted at a 2000px screen). */
const PX_PER: Record<string, number> = { px: 1, em: 16, rem: 16, ch: 8, vw: 20 };

type Bound = { px: number; pct: number; negative: boolean };
type LenOptions = { max: number; pctMax?: number; negative?: boolean; units?: readonly string[] };

const MATH = new Set(["calc", "min", "max", "clamp"]);

function lengthBound(t: Term, opts: LenOptions, depth = 0): Bound | null {
  const units = opts.units ?? ["px", "em", "rem", "ch", "vw"];
  if (t.t === "num") return t.v === 0 ? { px: 0, pct: 0, negative: false } : null;
  if (t.t === "dim") return units.includes(t.unit) && PX_PER[t.unit] !== undefined ? { px: Math.abs(t.v) * PX_PER[t.unit]!, pct: 0, negative: t.v < 0 } : null;
  if (t.t === "pct") return opts.pctMax !== undefined ? { px: 0, pct: Math.abs(t.v), negative: t.v < 0 } : null;
  if (t.t === "fn" && MATH.has(t.name) && depth < 3) return mathBound(t, opts, depth + 1);
  return null;
}

/** calc / min / max / clamp: + and - between lengths, * and / by a plain number only. */
function mathBound(fn: Extract<Term, { t: "fn" }>, opts: LenOptions, depth: number): Bound | null {
  const groups = commaGroups(terms(fn.args));
  const want = fn.name === "calc" ? 1 : fn.name === "clamp" ? 3 : null;
  if (want !== null ? groups.length !== want : groups.length < 1 || groups.length > 4) return null;
  let px = 0;
  let pct = 0;
  let negative = false;
  for (const g of groups) {
    const b = sumBound(g, opts, depth);
    if (!b) return null;
    px = Math.max(px, b.px);
    pct = Math.max(pct, b.pct);
    negative ||= b.negative;
  }
  return { px, pct, negative };
}

function sumBound(g: Term[], opts: LenOptions, depth: number): Bound | null {
  if (g.length === 0 || g.length > 15) return null;
  let px = 0;
  let pct = 0;
  let negative = false;
  // product groups separated by + / -
  let i = 0;
  let first = true;
  while (i < g.length) {
    if (!first) {
      const op = g[i];
      if (op?.t !== "delim" || (op.v !== "+" && op.v !== "-")) return null;
      if (op.v === "-") negative = true;
      i++;
    }
    first = false;
    // operand (* or / number)*
    const operand = g[i];
    if (!operand) return null;
    let factor = 1;
    let len: Bound | null = null;
    const take = (t: Term): boolean => {
      if (t.t === "num" && t.v !== 0) {
        if (Math.abs(t.v) > 10) return false;
        factor *= Math.abs(t.v);
        if (t.v < 0) negative = true;
        return true;
      }
      const b = lengthBound(t, opts, depth);
      if (!b || len) return false;
      len = b;
      return true;
    };
    if (!take(operand)) return null;
    i++;
    while (g[i]?.t === "delim" && ((g[i] as { v: string }).v === "*" || (g[i] as { v: string }).v === "/")) {
      const op = (g[i] as { v: string }).v;
      const next = g[i + 1];
      if (!next) return null;
      if (op === "/") {
        if (next.t !== "num" || Math.abs(next.v) < 0.1 || Math.abs(next.v) > 100) return null;
        factor /= Math.abs(next.v);
        if (next.v < 0) negative = true;
      } else if (!take(next)) return null;
      i += 2;
    }
    if (!len) return null; // a bare number has no length
    const b: Bound = len;
    px += b.px * factor;
    pct += b.pct * factor;
    negative ||= b.negative;
  }
  return { px, pct, negative };
}

export function isLength(t: Term, opts: LenOptions): boolean {
  const b = lengthBound(t, opts);
  if (!b) return false;
  if (b.negative && !opts.negative) return false;
  if (b.px > opts.max) return false;
  if (b.pct > (opts.pctMax ?? 0)) return false;
  return true;
}

// ---------------------------------------------------------------- colours and fonts

/** The profile renderer's palette tokens (ProfileRenderer tokens()). */
export const PALETTE_VARS = ["--p-bg", "--p-surface", "--p-text", "--p-primary", "--p-secondary", "--p-accent"] as const;
/** Font stacks the app already defines (next/font, self-hosted; no font is ever fetched from elsewhere). */
export const FONT_VARS = ["--font-display", "--font-body", "--font-editorial", "--font-grotesk", "--font-ja-editorial", "--font-ja-condensed", "--font-ja-light", "--serif", "--sans", "--display"] as const;
const GENERIC_FAMILIES = ["serif", "sans-serif", "monospace", "system-ui"];

const varName = (t: Term, allowed: readonly string[]): string | null => {
  if (t.t !== "fn" || t.name !== "var") return null;
  const args = terms(t.args);
  // no fallback: var(--x, anything) could carry any value past the checks
  if (args.length !== 1 || args[0]!.t !== "ident") return null;
  const name = args[0]!.v;
  return allowed.includes(name) ? name : null;
};

const num = (t: Term | undefined, min: number, max: number) => t?.t === "num" && t.v >= min && t.v <= max;
const pctIn = (t: Term | undefined, min: number, max: number) => t?.t === "pct" && t.v >= min && t.v <= max;

export function isColor(t: Term): boolean {
  if (t.t === "hash") return /^([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t.v);
  if (t.t === "ident") return ["transparent", "currentcolor", "white", "black"].includes(t.v.toLowerCase());
  if (t.t !== "fn") return false;
  if (t.name === "var") return varName(t, PALETTE_VARS) !== null;
  if (t.name === "rgb" || t.name === "rgba") {
    const list = terms(t.args);
    const commas = list.filter((x) => x.t === ",").length;
    const parts = list.filter((x) => x.t !== "," && !(x.t === "delim" && x.v === "/"));
    const slash = list.filter((x) => x.t === "delim" && x.v === "/").length;
    if (commas > 0 && slash > 0) return false;
    if (commas > 0 && commas !== parts.length - 1) return false;
    if (slash > 1 || (slash === 1 && parts.length !== 4)) return false;
    if (commas > 0 && list.some((x, i) => (i % 2 === 1) !== (x.t === ","))) return false;
    if (commas === 0 && slash === 1 && !(list[3]?.t === "delim")) return false;
    if (parts.length !== 3 && parts.length !== 4) return false;
    const channel = (x: Term) => num(x, 0, 255) || pctIn(x, 0, 100);
    if (!parts.slice(0, 3).every(channel)) return false;
    return parts.length === 3 || num(parts[3], 0, 1) || pctIn(parts[3], 0, 100);
  }
  if (t.name === "color-mix") {
    const groups = commaGroups(terms(t.args));
    if (groups.length !== 3) return false;
    const [space, a, b] = groups as [Term[], Term[], Term[]];
    if (space.length !== 2 || space[0]!.t !== "ident" || space[0]!.v.toLowerCase() !== "in" || space[1]!.t !== "ident" || !["srgb", "oklab"].includes(space[1]!.v.toLowerCase())) return false;
    const stop = (g: Term[]) => g.length >= 1 && g.length <= 2 && isColor(g[0]!) && (g.length === 1 || pctIn(g[1], 0, 100));
    return stop(a) && stop(b);
  }
  return false;
}

const isFontFamilyItem = (t: Term) => varName(t, FONT_VARS) !== null || (t.t === "ident" && GENERIC_FAMILIES.includes(t.v.toLowerCase()));

// ---------------------------------------------------------------- gradients

const GRADIENTS = new Set(["linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient"]);
const SIDES = ["top", "bottom", "left", "right"];
const RADIAL_WORDS = ["circle", "ellipse", "closest-side", "closest-corner", "farthest-side", "farthest-corner", "at", "center", ...SIDES];
const STOP_LEN: LenOptions = { max: 2400, pctMax: 100 };

const isAngle = (t: Term | undefined, max = 360) => t?.t === "dim" && ((t.unit === "deg" && Math.abs(t.v) <= max) || (t.unit === "turn" && Math.abs(t.v) <= max / 360));

export function isGradient(t: Term): boolean {
  if (t.t !== "fn" || !GRADIENTS.has(t.name)) return false;
  const groups = commaGroups(terms(t.args));
  if (groups.length < 2 || groups.length > 12) return false;
  let stops = groups;
  const head = groups[0]!;
  const linear = t.name.endsWith("linear-gradient");
  if (linear) {
    if (head.length === 1 && isAngle(head[0])) stops = groups.slice(1);
    else if (head[0]?.t === "ident" && head[0].v.toLowerCase() === "to") {
      const sides = head.slice(1);
      if (sides.length < 1 || sides.length > 2 || !sides.every((s) => s.t === "ident" && SIDES.includes(s.v.toLowerCase()))) return false;
      stops = groups.slice(1);
    }
  } else if (head.length > 0 && head.every((x) => (x.t === "ident" && RADIAL_WORDS.includes(x.v.toLowerCase())) || isLength(x, STOP_LEN))) {
    if (head.length > 6) return false;
    stops = groups.slice(1);
  }
  if (stops.length < 2) return false;
  return stops.every((g) => g.length >= 1 && g.length <= 3 && isColor(g[0]!) && g.slice(1).every((x) => isLength(x, STOP_LEN)));
}

// ---------------------------------------------------------------- the property table

type Item = (t: Term) => boolean;
type Spec = {
  /** Each space-separated term must match one of these. */
  items: Item[];
  /** Number of terms (per comma group when commas > 1). */
  min?: number;
  max: number;
  /** Comma-separated groups allowed (at most this many). */
  commas?: number;
  /** A single slash allowed between terms (border-radius, grid-area, aspect-ratio). */
  slash?: boolean;
  /** A check of each whole comma group (box-shadow). */
  groups?: (g: Term[]) => boolean;
  /** A check of the whole value's terms (transform). */
  whole?: (list: Term[]) => boolean;
};

const kw =
  (...words: string[]): Item =>
  (t) =>
    t.t === "ident" && words.includes(t.v.toLowerCase());
const len =
  (opts: LenOptions): Item =>
  (t) =>
    isLength(t, opts);
const int =
  (min: number, max: number): Item =>
  (t) =>
    t.t === "num" && Number.isInteger(t.v) && t.v >= min && t.v <= max && !t.raw.includes(".");
const number =
  (min: number, max: number): Item =>
  (t) =>
    num(t, min, max);

const SIZE: LenOptions = { max: 2400, pctMax: 100 };
const SPACE: LenOptions = { max: 400, pctMax: 50 };
const BORDER: LenOptions = { max: 16, units: ["px", "em", "rem"] };
const RADIUS: LenOptions = { max: 999, pctMax: 50 };
const TRACK: LenOptions = { max: 2400, pctMax: 100, units: ["px", "em", "rem", "ch", "vw"] };

const color: Item = isColor;
const borderStyle = kw("none", "solid", "double", "dotted", "dashed", "groove", "ridge");
const sizeKw = kw("auto", "min-content", "max-content", "fit-content");
const one = (...items: Item[]): Spec => ({ items, max: 1 });

/** Grid track lists: lengths, fr, keywords, repeat(), minmax(), fit-content(). */
/**
 * A track that holds content is at least MIN_TRACK_PX wide (a 0px track lets its
 * text spill over the next one: re-review 2, High 1). Only the minimum of
 * minmax() may be smaller (minmax(0, 1fr) is the usual way to let a track shrink).
 */
const MIN_TRACK_PX = 24;
const sizedTrack = (t: Term) => isLength(t, TRACK) && lengthFloorPx(t) >= MIN_TRACK_PX;

function isTrack(t: Term, depth = 0): boolean {
  if (t.t === "dim" && t.unit === "fr") return t.v > 0 && t.v <= 24;
  if (kw("auto", "min-content", "max-content")(t)) return true;
  if (sizedTrack(t)) return true;
  if (t.t !== "fn" || depth > 1) return false;
  const groups = commaGroups(terms(t.args));
  if (t.name === "minmax") {
    if (groups.length !== 2 || !groups.every((g) => g.length === 1 && g[0]!.t !== "fn")) return false;
    const [min, max] = [groups[0]![0]!, groups[1]![0]!];
    return (isLength(min, TRACK) || kw("auto", "min-content", "max-content")(min)) && isTrack(max, depth + 1);
  }
  if (t.name === "fit-content") return groups.length === 1 && groups[0]!.length === 1 && sizedTrack(groups[0]![0]!);
  if (t.name === "repeat") {
    if (groups.length !== 2 || groups[0]!.length !== 1) return false;
    const count = groups[0]![0]!;
    if (!(int(1, 12)(count) || kw("auto-fit", "auto-fill")(count))) return false;
    return groups[1]!.length >= 1 && groups[1]!.length <= 6 && groups[1]!.every((x) => isTrack(x, depth + 1));
  }
  return false;
}

/** The smallest a plain length can be in px (vw at a 320px screen, % unknown: 0); math functions count as 0. */
function lengthFloorPx(t: Term): number {
  if (t.t === "dim") return t.unit === "vw" ? t.v * 3.2 : t.v * (PX_PER[t.unit] ?? 0);
  if (t.t === "pct") return t.v > 0 ? MIN_TRACK_PX : 0;
  return 0;
}
const tracks: Spec = { items: [(t) => isTrack(t), kw("none")], max: 12 };

const gridLine: Spec = { items: [int(-12, 12), kw("auto", "span")], max: 4, slash: true };

/** transform: one small rotation; nothing that can move, stretch, hide or throw text away. */
function isTransformFn(t: Term): boolean {
  if (t.t !== "fn") return false;
  const groups = commaGroups(terms(t.args));
  const single = groups.every((g) => g.length === 1) ? groups.map((g) => g[0]!) : null;
  if (!single) return false;
  switch (t.name) {
    case "rotate":
      return single.length === 1 && isAngle(single[0], 8);
    // no translate: like an offset, it can move a value next to another label; no scale: a
    // neighbour stretched with scaleY(2) covered the top of the values (re-review High 1)
    default:
      return false;
  }
}

const textDecorationLine = kw("none", "underline", "overline"); // no line-through: a struck-out fact reads as withdrawn

/** A font size at least 12px on every screen: px ≥ 12 or rem ≥ 0.75 (no % or em: they compound when nested). */
const FONT_FLOOR = (t: Term | undefined) => t?.t === "dim" && ((t.unit === "px" && t.v >= 12 && t.v <= 256) || (t.unit === "rem" && t.v >= 0.75 && t.v <= 16));
/** The preferred value of clamp(): px, rem, vw or calc() of them (the floor of clamp() keeps it ≥ 12px). */
const FONT_FLUID = (t: Term) => isLength(t, { max: 256, units: ["px", "rem", "vw"] });
function isFontSize(t: Term): boolean {
  if (FONT_FLOOR(t)) return true;
  if (t.t !== "fn") return false;
  const groups = commaGroups(terms(t.args));
  if (!groups.every((g) => g.length >= 1)) return false;
  if (t.name === "clamp") return groups.length === 3 && groups.every((g) => g.length === 1) && FONT_FLOOR(groups[0]![0]) && FONT_FLUID(groups[1]![0]!) && FONT_FLOOR(groups[2]![0]);
  // max(12px, 2vw): one argument is the floor
  if (t.name === "max") return groups.length >= 2 && groups.length <= 3 && groups.every((g) => g.length === 1 && FONT_FLUID(g[0]!)) && groups.some((g) => FONT_FLOOR(g[0]));
  return false;
}

/** box-shadow: inset only (painted under the element's own content, never over a neighbour). */
function isInsetShadow(g: Term[]): boolean {
  if (g.length === 1 && kw("none")(g[0]!)) return true;
  const inset = g.filter((t) => kw("inset")(t)).length;
  const colours = g.filter((t) => isColor(t)).length;
  const lengths = g.filter((t) => isLength(t, { max: 16, units: ["px"], negative: true }));
  return inset === 1 && colours <= 1 && lengths.length >= 2 && lengths.length <= 4 && inset + colours + lengths.length === g.length;
}

const PROPS_BASE: Record<string, Spec> = {
  // layout
  // no list-item (its marker is text), none or contents (they hide)
  display: one(kw("block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "flow-root")),
  "box-sizing": one(kw("border-box", "content-box")),
  position: one(kw("static", "relative")),
  // no top / right / bottom / left / inset: an offset can move a value next to another label
  "z-index": one(int(0, 5), kw("auto")),
  float: one(kw("none", "left", "right", "inline-start", "inline-end")),
  clear: one(kw("none", "left", "right", "both", "inline-start", "inline-end")),
  width: one(len(SIZE), sizeKw),
  height: one(len(SIZE), sizeKw),
  "min-width": one(len(SIZE), sizeKw),
  "min-height": one(len(SIZE), sizeKw),
  "max-width": one(len(SIZE), sizeKw, kw("none")),
  "max-height": one(len(SIZE), sizeKw, kw("none")),
  "inline-size": one(len(SIZE), sizeKw),
  "block-size": one(len(SIZE), sizeKw),
  "min-inline-size": one(len(SIZE), sizeKw),
  "min-block-size": one(len(SIZE), sizeKw),
  "max-inline-size": one(len(SIZE), sizeKw, kw("none")),
  "max-block-size": one(len(SIZE), sizeKw, kw("none")),
  "aspect-ratio": { items: [number(0.1, 20), kw("auto")], max: 3, slash: true },
  margin: { items: [len(SPACE), kw("auto")], max: 4 },
  padding: { items: [len(SPACE)], max: 4 },
  gap: { items: [len(SPACE)], max: 2 },
  "row-gap": one(len(SPACE)),
  "column-gap": one(len(SPACE)),
  // flex
  flex: { items: [number(0, 12), len(SIZE), kw("auto", "none", "content")], max: 3 },
  "flex-direction": one(kw("row", "row-reverse", "column", "column-reverse")),
  "flex-wrap": one(kw("nowrap", "wrap", "wrap-reverse")),
  "flex-flow": { items: [kw("row", "row-reverse", "column", "column-reverse", "nowrap", "wrap", "wrap-reverse")], max: 2 },
  "flex-grow": one(number(0, 12)),
  "flex-shrink": one(number(0, 12)),
  "flex-basis": one(len(SIZE), kw("auto", "content")),
  order: one(int(-10, 10)),
  // grid
  "grid-template-columns": tracks,
  "grid-template-rows": tracks,
  "grid-auto-columns": tracks,
  "grid-auto-rows": tracks,
  "grid-auto-flow": { items: [kw("row", "column", "dense")], max: 2 },
  "grid-column": gridLine,
  "grid-row": gridLine,
  "grid-column-start": { items: [int(-12, 12), kw("auto", "span")], max: 2 },
  "grid-column-end": { items: [int(-12, 12), kw("auto", "span")], max: 2 },
  "grid-row-start": { items: [int(-12, 12), kw("auto", "span")], max: 2 },
  "grid-row-end": { items: [int(-12, 12), kw("auto", "span")], max: 2 },
  // alignment
  "align-items": { items: [kw("normal", "stretch", "start", "end", "center", "baseline", "flex-start", "flex-end", "first", "last")], max: 2 },
  "align-content": one(kw("normal", "stretch", "start", "end", "center", "flex-start", "flex-end", "space-between", "space-around", "space-evenly")),
  "align-self": { items: [kw("auto", "normal", "stretch", "start", "end", "center", "baseline", "flex-start", "flex-end", "first", "last")], max: 2 },
  "justify-items": one(kw("normal", "stretch", "start", "end", "center", "left", "right")),
  "justify-content": one(kw("normal", "start", "end", "center", "flex-start", "flex-end", "left", "right", "space-between", "space-around", "space-evenly", "stretch")),
  "justify-self": one(kw("auto", "normal", "stretch", "start", "end", "center", "left", "right")),
  "place-items": { items: [kw("normal", "stretch", "start", "end", "center", "baseline")], max: 2 },
  "place-content": { items: [kw("normal", "stretch", "start", "end", "center", "space-between", "space-around", "space-evenly")], max: 2 },
  "place-self": { items: [kw("auto", "normal", "stretch", "start", "end", "center")], max: 2 },
  "vertical-align": one(kw("baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super")),
  // columns
  "column-count": one(int(1, 4), kw("auto")),
  "column-width": one(len(SIZE), kw("auto")),
  "column-rule": { items: [len(BORDER), borderStyle, color], max: 3 },
  // typography
  "font-family": { items: [isFontFamilyItem], max: 1, commas: 6 },
  "font-size": one(isFontSize),
  "font-weight": one(kw("normal", "bold", "lighter", "bolder"), (t) => t.t === "num" && t.v >= 100 && t.v <= 900),
  "font-style": one(kw("normal", "italic")),
  "font-variant-numeric": { items: [kw("normal", "lining-nums", "oldstyle-nums", "proportional-nums", "tabular-nums")], max: 2 },
  "font-variant-caps": one(kw("normal", "small-caps", "all-small-caps")),
  "font-kerning": one(kw("auto", "normal", "none")),
  "line-height": one(kw("normal"), number(1, 3)),
  "letter-spacing": one(kw("normal"), (t) => t.t === "num" ? t.v === 0 : t.t === "dim" && ((t.unit === "em" && t.v >= -0.05 && t.v <= 0.5) || (t.unit === "px" && t.v >= -1 && t.v <= 8))),
  "word-spacing": one(kw("normal"), (t) => t.t === "num" ? t.v === 0 : t.t === "dim" && ((t.unit === "em" && t.v >= 0 && t.v <= 1) || (t.unit === "px" && t.v >= 0 && t.v <= 16))),
  "text-transform": one(kw("none", "uppercase", "lowercase", "capitalize")),
  "text-align": one(kw("left", "right", "center", "start", "end", "justify")),
  "text-indent": one(len({ max: 200, pctMax: 20 })),
  "writing-mode": one(kw("horizontal-tb", "vertical-rl", "vertical-lr")),
  // no sideways: it turns Japanese on its side
  "text-orientation": one(kw("mixed", "upright")),
  "text-wrap": one(kw("wrap", "balance", "pretty", "stable")),
  "white-space": one(kw("normal", "nowrap")),
  "word-break": one(kw("normal", "keep-all", "break-all", "auto-phrase")),
  "overflow-wrap": one(kw("normal", "anywhere", "break-word")),
  "line-break": one(kw("auto", "loose", "normal", "strict", "anywhere")),
  // hyphens: auto would insert hyphen glyphs into facts
  hyphens: one(kw("none", "manual")),
  // markers are text: only none
  "list-style-type": one(kw("none")),
  "list-style": one(kw("none")),
  // decoration lines in the text's own colour, thin, at the default offset (no line over a neighbouring line)
  "text-decoration": { items: [textDecorationLine, kw("solid", "double", "dotted", "dashed", "wavy")], max: 3 },
  "text-decoration-line": { items: [textDecorationLine], max: 2 },
  "text-decoration-style": one(kw("solid", "double", "dotted", "dashed", "wavy")),
  // colour and ground
  color: one(color),
  "background-color": one(color),
  "background-image": { items: [isGradient, kw("none")], max: 1, commas: 4 },
  "background-size": { items: [len(SIZE), kw("auto", "cover", "contain")], max: 2, commas: 4 },
  "background-position": { items: [len({ max: 2400, pctMax: 100, negative: true }), kw("center", ...SIDES)], max: 4, commas: 4 },
  "background-repeat": { items: [kw("repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round")], max: 2, commas: 4 },
  "background-clip": one(kw("border-box", "padding-box", "content-box")),
  "background-origin": one(kw("border-box", "padding-box", "content-box")),
  opacity: one(number(0.85, 1)),
  // borders and shadows (no outline: it paints over neighbours; shadows inset only)
  "border-radius": { items: [len(RADIUS)], max: 8, slash: true },
  "box-shadow": { items: [() => true], max: 6, commas: 3, groups: isInsetShadow },
  // transforms: one small rotation and / or scale about the element's own box
  transform: one(kw("none"), isTransformFn),
  "transform-origin": { items: [kw("center", ...SIDES), (t) => t.t === "pct" && t.v >= 0 && t.v <= 100], max: 2 },
};

for (const side of ["top", "right", "bottom", "left"]) {
  PROPS_BASE[`margin-${side}`] = one(len(SPACE), kw("auto"));
  PROPS_BASE[`padding-${side}`] = one(len(SPACE));
  PROPS_BASE[`border-${side}`] = { items: [len(BORDER), borderStyle, color], max: 3 };
  PROPS_BASE[`border-${side}-width`] = one(len(BORDER));
  PROPS_BASE[`border-${side}-style`] = one(borderStyle);
  PROPS_BASE[`border-${side}-color`] = one(color);
}
for (const axis of ["inline", "block"]) {
  PROPS_BASE[`margin-${axis}`] = { items: [len(SPACE), kw("auto")], max: 2 };
  PROPS_BASE[`padding-${axis}`] = { items: [len(SPACE)], max: 2 };
  PROPS_BASE[`border-${axis}`] = { items: [len(BORDER), borderStyle, color], max: 3 };
  for (const end of ["start", "end"]) {
    PROPS_BASE[`margin-${axis}-${end}`] = one(len(SPACE), kw("auto"));
    PROPS_BASE[`padding-${axis}-${end}`] = one(len(SPACE));
    PROPS_BASE[`border-${axis}-${end}`] = { items: [len(BORDER), borderStyle, color], max: 3 };
  }
}
for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) PROPS_BASE[`border-${corner}-radius`] = { items: [len(RADIUS)], max: 2 };
PROPS_BASE.border = { items: [len(BORDER), borderStyle, color], max: 3 };
PROPS_BASE["border-width"] = { items: [len(BORDER)], max: 4 };
PROPS_BASE["border-style"] = { items: [borderStyle], max: 4 };
PROPS_BASE["border-color"] = { items: [color], max: 4 };

/** Properties on elements. */
export const ELEMENT_PROPS: Readonly<Record<string, Spec>> = PROPS_BASE;

/**
 * Properties on ::before / ::after: in-flow decoration only (no text, no
 * offset, no placement, no stacking), so a pseudo-element can never sit over
 * the text of its own element, where hit-testing cannot see it.
 */
export const PSEUDO_PROPS: Readonly<Record<string, Spec>> = Object.fromEntries(
  Object.entries(PROPS_BASE).filter(
    ([name]) =>
      /^(width|height|min-width|min-height|max-width|max-height|inline-size|block-size|aspect-ratio|vertical-align|background-color|background-image|background-size|background-position|background-repeat|border-radius)$/.test(name) ||
      /^(margin|padding|border)(-|$)/.test(name),
  ),
);
const PSEUDO_EXTRA: Record<string, Spec> = {
  display: one(kw("none", "block", "inline", "inline-block")),
  // no text: only none, normal or the empty string
  content: one(kw("none", "normal"), (t) => t.t === "string" && t.v === ""),
};

export function propertySpec(name: string, pseudo: boolean): Spec | null {
  if (pseudo) return PSEUDO_EXTRA[name] ?? PSEUDO_PROPS[name] ?? null;
  return ELEMENT_PROPS[name] ?? null;
}

/** Checks a declaration's terms against its spec. */
export function valueMatches(spec: Spec, list: Term[]): boolean {
  const groups = commaGroups(list);
  if (groups.length > (spec.commas ?? 1)) return false;
  for (const g of groups) {
    let slashes = 0;
    const items: Term[] = [];
    for (const t of g) {
      if (t.t === "delim" && t.v === "/") {
        if (!spec.slash || items.length === 0) return false;
        slashes++;
        continue;
      }
      items.push(t);
    }
    if (slashes > 1) return false;
    if (g.length > 0 && g[g.length - 1]!.t === "delim") return false;
    if (items.length < (spec.min ?? 1) || items.length > spec.max) return false;
    if (!items.every((t) => spec.items.some((p) => p(t)))) return false;
    if (spec.groups && !spec.groups(g)) return false;
    if (spec.whole && !spec.whole(g)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- serialization

function serializeNumber(raw: string): string {
  // raw already matched [+-]?digits(.digits)? — drop a leading "+" and keep the rest
  return raw.startsWith("+") ? raw.slice(1) : raw;
}

export function serializeTerm(t: Term): string {
  switch (t.t) {
    case "ident":
      return t.v.startsWith("--") ? t.v : t.v.toLowerCase();
    case "num":
      return serializeNumber(t.raw);
    case "pct":
      return `${serializeNumber(t.raw)}%`;
    case "dim":
      return `${serializeNumber(t.raw)}${t.unit}`;
    case "hash":
      return `#${t.v.toLowerCase()}`;
    case "string":
      // only the empty string is ever allowed through
      return '""';
    case "delim":
      return t.v;
    case ",":
      return ",";
    case "fn":
      return `${t.name}(${serializeTerms(terms(t.args))})`;
    default:
      throw new Error(`unserializable ${t.t}`);
  }
}

export function serializeTerms(list: Term[]): string {
  let out = "";
  list.forEach((t, i) => {
    if (t.t === ",") {
      out += ", ";
      return;
    }
    if (i > 0 && list[i - 1]!.t !== ",") out += " ";
    out += serializeTerm(t);
  });
  return out;
}
