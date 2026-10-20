import { componentValues, CssSyntaxError, tokenize, type CV } from "./tokenize";
import { CONTAINER_DISPLAYS, propertySpec, serializeTerms, terms, valueMatches, type Term } from "./values";

// The static guard for a per-shop stylesheet (DEV-072, Stage 3; design note:
// .ai/proposals/stage3-shop-css.md). A stylesheet is accepted only when every
// part of it parses into the small subset below; it is then re-serialized from
// the parsed tree (never returned verbatim). Anything else is a fixed problem
// code, and the caller falls back to the profile renderer's own CSS.
//
//   at-rules    @media with (min-width|max-width: <px|em>) between 320 and 1920px only, not nested
//   selectors   start at the scope root #shop-css; type selectors from a fixed
//               list, the renderer's stable data attributes with fixed values,
//               :first-child … :nth-child(An+B), :not(simple); no pseudo-elements;
//               descendant and child combinators only (no sibling combinators:
//               the notice bar and the footer are the scope root's siblings)
//   properties  an explicit allowlist with value grammars and caps (values.ts)
//   never       url(), @import, @font-face, escapes, comments with "<", !important,
//               custom properties, var() outside the palette and font tokens,
//               attr(), env(), expression(), content text, position fixed/sticky/absolute

export const SHOP_CSS_SCOPE_ID = "shop-css";
/** @media breakpoints must lie within the checked widths (render-check.ts SHOP_CSS_BASE_WIDTHS: 320 … 1920). */
export const SHOP_CSS_MEDIA_RANGE = { min: 320, max: 1920 } as const;
export const SHOP_CSS_LIMITS = { bytes: 24 * 1024, rules: 300, declarations: 1500, declarationsPerRule: 60, selectorsPerRule: 12, compoundsPerSelector: 8, media: 24, breakpoints: 4, valueTerms: 40 } as const;

declare const guarded: unique symbol;
/** A stylesheet that came out of guardShopCss (normalized). */
export type GuardedShopCss = string & { readonly [guarded]: true };

export type GuardResult = { ok: true; css: GuardedShopCss } | { ok: false; problems: string[] };

// ---------------------------------------------------------------- selector vocabulary

/** Elements of the profile renderer's markup a shop stylesheet may select. */
export const SHOP_CSS_ELEMENTS = ["header", "main", "section", "div", "p", "span", "h1", "h2", "ol", "ul", "li", "dl", "dt", "dd"] as const;

/**
 * The renderer's stable attributes and their values (class names are hashed CSS
 * modules, so they are not a contract). data-kind … data-headings and data-fv
 * come with the Stage 1 renderer (DEV-071, PR #83); aria-labelledby, lang and
 * aria-hidden are on today's markup too. Exact values only: no prefix, suffix
 * or substring matches (the classic attribute-selector exfiltration).
 */
export const SHOP_CSS_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  "data-kind": ["about", "menu", "hours", "visit"],
  "data-variant": ["lead", "statement", "side_heading", "numbered", "chips", "columns", "feature_first", "strip", "block", "ledger", "cards", "split", "stacked"],
  "data-ground": ["plain", "surface", "inverted"],
  "data-first-view": ["name_only", "name_lead", "name_hours", "name_menu", "vertical_name"],
  "data-scale": ["quiet", "standard", "dramatic"],
  "data-headings": ["en_ja", "ja_en", "ja_only", "vertical_ja"],
  "data-fv": ["lead", "hours", "menu"],
  "data-key": ["hours", "closedDays", "address", "access", "phone"],
  // DEV-071b: a section with little content (presence only: the value is always "")
  "data-short": [""],
  "aria-labelledby": ["pr-about", "pr-menu", "pr-hours", "pr-visit"],
  lang: ["en"],
  "aria-hidden": ["true"],
};

const SIMPLE_PSEUDO_CLASSES = ["first-child", "last-child", "only-child", "first-of-type", "last-of-type"];
const NTH_PSEUDO_CLASSES = ["nth-child", "nth-of-type", "nth-last-child"];

type Simple = { kind: "type"; name: string } | { kind: "attr"; name: string; value: string } | { kind: "pseudo"; text: string };
type Compound = { root: boolean; parts: Simple[]; pseudoElement: string | null };
type Selector = { compounds: Compound[]; combinators: Array<" " | ">"> };

class Problems {
  readonly set = new Set<string>();
  add(code: string) {
    this.set.add(code);
  }
}

/** The An+B of :nth-child(), read from the source (it tokenizes oddly: "2n+1" is a dimension and a number). */
function anPlusB(source: string, block: Extract<CV, { t: "fn" }>): string | null {
  const text = source.slice(block.s, block.e).replace(/^[a-z-]+\(/i, "").replace(/\)$/, "").replace(/\s+/g, "").toLowerCase();
  if (text === "odd" || text === "even") return text;
  const m = /^([+-]?\d{0,2})?n([+-]\d{1,2})?$/.exec(text) ?? null;
  if (m) {
    const a = m[1] === undefined || m[1] === "" || m[1] === "+" ? "" : m[1] === "-" ? "-" : String(Number(m[1]));
    const b = m[2] ? (Number(m[2]) >= 0 ? `+${Number(m[2])}` : String(Number(m[2]))) : "";
    return `${a}n${b}`;
  }
  return /^\+?\d{1,2}$/.test(text) ? String(Number(text)) : null;
}

/** Parses one selector of a rule's prelude (already split at commas). */
function parseSelector(source: string, items: CV[], p: Problems): Selector | null {
  // trim whitespace
  let list = items;
  while (list[0]?.t === "ws") list = list.slice(1);
  while (list[list.length - 1]?.t === "ws") list = list.slice(0, -1);
  if (list.length === 0) {
    p.add("selector_syntax");
    return null;
  }
  const compounds: Compound[] = [];
  const combinators: Array<" " | ">"> = [];
  let current: Compound | null = null;
  let pendingCombinator: " " | ">" | null = null;
  const fail = (code: string) => {
    p.add(code);
    return null;
  };

  const startCompound = (): Compound | null => {
    if (current) return current;
    if (compounds.length > 0 && pendingCombinator === null) return null;
    if (compounds.length > 0) combinators.push(pendingCombinator!);
    pendingCombinator = null;
    current = { root: false, parts: [], pseudoElement: null };
    compounds.push(current);
    return current;
  };

  for (let i = 0; i < list.length; i++) {
    const cv = list[i]!;
    if (cv.t === "ws") {
      if (current) {
        current = null;
        pendingCombinator = " ";
      }
      continue;
    }
    if (cv.t === "delim" && cv.v === ">") {
      if (compounds.length === 0 || (pendingCombinator === ">" && !current)) return fail("selector_syntax");
      current = null;
      pendingCombinator = ">";
      continue;
    }
    if (cv.t === "delim" && (cv.v === "+" || cv.v === "~")) return fail("selector_combinator");
    if (cv.t === "dim" || cv.t === "num") return fail("selector_syntax");
    const c = startCompound();
    if (!c) return fail("selector_syntax");
    if (c.pseudoElement !== null) return fail("selector_pseudo");

    if (cv.t === "hash") {
      // the scope root, exactly once, at the very start
      if (cv.v !== SHOP_CSS_SCOPE_ID || compounds.length !== 1 || c.parts.length > 0 || c.root) return fail("selector_forbidden");
      c.root = true;
      continue;
    }
    if (compounds.length === 1 && !c.root) return fail("selector_scope");
    if (cv.t === "ident") {
      const name = cv.v.toLowerCase();
      if (c.parts.length > 0 || c.root) return fail("selector_syntax");
      if (!(SHOP_CSS_ELEMENTS as readonly string[]).includes(name)) return fail("selector_element");
      c.parts.push({ kind: "type", name });
      continue;
    }
    // no universal selector: every compound names one of the allowed elements (so * and :not() never reach a, img, svg, figure)
    if (cv.t === "delim" && cv.v === "*") return fail("selector_element");
    if (cv.t === "block" && cv.open === "[") {
      const attr = parseAttribute(cv.items);
      if (!attr) return fail("selector_attribute");
      c.parts.push(attr);
      continue;
    }
    if (cv.t === ":") {
      const next = list[i + 1];
      // no pseudo-elements at all (re-review 3: a ::after painted over its own element's text, where
      // hit-testing cannot see it); decoration is borders, grounds and inset shadows of real elements
      if (next?.t === ":") return fail("selector_pseudo");
      if (c.root) return fail("selector_pseudo");
      const pseudo = parsePseudoClass(source, next, p, false);
      if (!pseudo) return fail("selector_pseudo");
      c.parts.push(pseudo);
      i += 1;
      continue;
    }
    return fail("selector_forbidden");
  }
  if (!current && pendingCombinator === ">") return fail("selector_syntax");
  if (compounds.length === 0 || !compounds[0]!.root) return fail("selector_scope");
  if (compounds.length > SHOP_CSS_LIMITS.compoundsPerSelector) return fail("selector_too_long");
  if (compounds.slice(1).some((c) => c.parts[0]?.kind !== "type")) return fail("selector_element");
  // a pseudo-element only on the last compound
  if (compounds.slice(0, -1).some((c) => c.pseudoElement !== null)) return fail("selector_pseudo");
  return { compounds, combinators };
}

function parseAttribute(items: CV[]): Simple | null {
  const list = items.filter((c) => c.t !== "ws");
  // [name="value"] or [name=value]; no other matcher, no case flag
  if (list.length !== 3) return null;
  const [name, eq, value] = list as [CV, CV, CV];
  if (name.t !== "ident" || eq.t !== "delim" || eq.v !== "=") return null;
  const v = value.t === "string" || value.t === "ident" ? value.v : null;
  const attrName = name.v.toLowerCase();
  const allowed = SHOP_CSS_ATTRIBUTES[attrName];
  if (v === null || !allowed || !allowed.includes(v)) return null;
  return { kind: "attr", name: attrName, value: v };
}

function parsePseudoClass(source: string, next: CV | undefined, p: Problems, nested: boolean): Simple | null {
  if (next?.t === "ident") {
    const name = next.v.toLowerCase();
    return SIMPLE_PSEUDO_CLASSES.includes(name) ? { kind: "pseudo", text: `:${name}` } : null;
  }
  if (next?.t !== "fn") return null;
  if (NTH_PSEUDO_CLASSES.includes(next.name)) {
    const ab = anPlusB(source, next);
    return ab ? { kind: "pseudo", text: `:${next.name}(${ab})` } : null;
  }
  if (next.name === "not" && !nested) {
    const inner = next.args.filter((c) => c.t !== "ws");
    let simple: Simple | null = null;
    if (inner.length === 1 && inner[0]!.t === "ident" && (SHOP_CSS_ELEMENTS as readonly string[]).includes(inner[0]!.v.toLowerCase())) simple = { kind: "type", name: inner[0]!.v.toLowerCase() };
    else if (inner.length === 1 && inner[0]!.t === "block" && inner[0]!.open === "[") simple = parseAttribute(inner[0]!.items);
    else if (inner.length === 2 && inner[0]!.t === ":") simple = parsePseudoClass(source, inner[1], p, true);
    if (!simple) return null;
    return { kind: "pseudo", text: `:not(${serializeSimple(simple)})` };
  }
  return null;
}

const serializeSimple = (s: Simple): string => (s.kind === "type" ? s.name : s.kind === "attr" ? `[${s.name}="${s.value}"]` : s.text);

function serializeSelector(sel: Selector): string {
  return sel.compounds
    .map((c, i) => {
      const text = (c.root ? `#${SHOP_CSS_SCOPE_ID}` : "") + c.parts.map(serializeSimple).join("") + (c.pseudoElement ? `::${c.pseudoElement}` : "");
      return i === 0 ? text : `${sel.combinators[i - 1] === ">" ? " > " : " "}${text}`;
    })
    .join("");
}

// ---------------------------------------------------------------- rules

type Rule = { selectors: string[]; declarations: string[] };
type Block = { media: string | null; rules: Rule[] };

function splitAt(items: CV[], sep: ";" | ","): CV[][] {
  const out: CV[][] = [[]];
  for (const c of items) {
    if (c.t === sep) out.push([]);
    else out[out.length - 1]!.push(c);
  }
  return out;
}

/**
 * Elements of the renderer that never hold text directly (only other
 * elements; tests/unit/design-agent/shop-css/stage1.test.tsx checks it on the
 * markup). Only they may become grid or flex containers: then every grid or
 * flex item is a real element whose box the render check can measure, never an
 * anonymous box around loose text.
 */
export const TEXT_FREE_ELEMENTS = ["header", "main", "section", "div", "ol", "ul", "dl"] as const;

function parseDeclarations(items: CV[], containers: boolean, p: Problems): string[] {
  const out: string[] = [];
  for (const segment of splitAt(items, ";")) {
    const list = segment.filter((c) => c.t !== "ws");
    if (list.length === 0) continue;
    if (segment.some((c) => c.t === "block" && c.open === "{")) {
      p.add("nesting");
      continue;
    }
    const [name, colon, ...rest] = list;
    if (name?.t !== "ident" || colon?.t !== ":") {
      p.add("declaration_syntax");
      continue;
    }
    const prop = name.v.toLowerCase();
    if (prop.startsWith("--")) {
      p.add("custom_property");
      continue;
    }
    if (rest.some((c) => c.t === "delim" && c.v === "!")) {
      p.add(rest.some((c) => c.t === "ident" && c.v.toLowerCase() === "important") ? "important" : "value_forbidden");
      continue;
    }
    const spec = propertySpec(prop);
    if (!spec) {
      p.add("property_forbidden");
      continue;
    }
    // the value's own whitespace is dropped; fn args are checked inside the specs
    const valueTerms = terms(segment.slice(segment.indexOf(colon) + 1));
    if (valueTerms.length === 0 || valueTerms.length > SHOP_CSS_LIMITS.valueTerms) {
      p.add(`value_forbidden:${prop}`);
      continue;
    }
    const bad = valueTerms.find((t) => t.t === "fn" && !["var", "rgb", "rgba", "color-mix", "calc", "min", "max", "clamp", "minmax", "repeat", "fit-content", "rotate", "scale", "scalex", "scaley"].includes(t.name));
    if (bad) {
      p.add("function_forbidden");
      continue;
    }
    if (!valueMatches(spec, valueTerms as Term[])) {
      p.add(`value_forbidden:${prop}`);
      continue;
    }
    if (prop === "display" && !containers && valueTerms.some((t) => t.t === "ident" && (CONTAINER_DISPLAYS as readonly string[]).includes(t.v.toLowerCase()))) {
      p.add("display_on_text");
      continue;
    }
    out.push(`${prop}: ${serializeTerms(valueTerms as Term[])}`);
  }
  return out;
}

function parseRule(source: string, prelude: CV[], body: CV[], p: Problems, counts: Counts): Rule | null {
  const before = p.set.size;
  const selectorItems = splitAt(prelude, ",");
  if (selectorItems.length > SHOP_CSS_LIMITS.selectorsPerRule) p.add("too_many_selectors");
  const selectors = selectorItems.map((s) => parseSelector(source, s, p));
  if (selectors.some((s) => s === null)) return null;
  // grid / flex only when every subject is an element that holds no text of its own (or the scope root)
  const containers = selectors.every((s) => {
    const subject = s!.compounds[s!.compounds.length - 1]!;
    if (subject.root) return true;
    const type = subject.parts[0];
    return type?.kind === "type" && (TEXT_FREE_ELEMENTS as readonly string[]).includes(type.name);
  });
  const declarations = parseDeclarations(body, containers, p);
  counts.rules += 1;
  counts.declarations += declarations.length;
  if (declarations.length > SHOP_CSS_LIMITS.declarationsPerRule) p.add("too_many_declarations");
  if (p.set.size > before) return null;
  return { selectors: selectors.map((s) => serializeSelector(s!)), declarations };
}

/** @media (min-width: 720px) and (max-width: 1199.98px) */
function parseMedia(prelude: CV[]): string | null {
  const list = prelude.filter((c) => c.t !== "ws");
  if (list.length === 0 || list.length % 2 === 0 || list.length > 3) return null;
  const parts: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (i % 2 === 1) {
      if (c.t !== "ident" || c.v.toLowerCase() !== "and") return null;
      continue;
    }
    if (c.t !== "block" || c.open !== "(") return null;
    const inner = c.items.filter((x) => x.t !== "ws");
    if (inner.length !== 3) return null;
    const [feature, colon, value] = inner as [CV, CV, CV];
    if (feature.t !== "ident" || !["min-width", "max-width"].includes(feature.v.toLowerCase()) || colon.t !== ":") return null;
    // only inside the widths the render check covers (320–1920px; em at 16px): a band outside them is never checked
    const px = value.t === "dim" && (value.unit === "px" || value.unit === "em") ? value.v * (value.unit === "em" ? 16 : 1) : -1;
    if (px < SHOP_CSS_MEDIA_RANGE.min || px > SHOP_CSS_MEDIA_RANGE.max || value.t !== "dim") return null;
    parts.push(`(${feature.v.toLowerCase()}: ${value.raw.replace(/^\+/, "")}${value.unit})`);
  }
  return parts.join(" and ");
}

type Counts = { rules: number; declarations: number; media: number };

/** A list of rules; at top level @media blocks (one level), inside @media none. Source order is kept. */
function parseRules(source: string, items: CV[], p: Problems, inMedia: boolean, counts: Counts, out: Block[]): void {
  const push = (rule: Rule, media: string | null) => {
    const last = out[out.length - 1];
    if (last && last.media === media && (media === null || inMedia)) last.rules.push(rule);
    else out.push({ media, rules: [rule] });
  };
  let prelude: CV[] = [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i]!;
    if (c.t === "at") {
      if (prelude.some((x) => x.t !== "ws")) p.add("syntax");
      // the whole at-rule: its prelude up to a {} block or a ;
      let j = i + 1;
      const atPrelude: CV[] = [];
      while (j < items.length && items[j]!.t !== ";" && !(items[j]!.t === "block" && (items[j] as { open: string }).open === "{")) atPrelude.push(items[j++]!);
      const block = items[j];
      i = j;
      prelude = [];
      if (c.v !== "media") {
        p.add(c.v === "import" ? "at_import" : c.v === "font-face" ? "at_font_face" : c.v === "charset" ? "at_charset" : "at_rule_forbidden");
        continue;
      }
      if (inMedia) {
        p.add("nesting");
        continue;
      }
      if (block?.t !== "block") {
        p.add("media_syntax");
        continue;
      }
      const query = parseMedia(atPrelude);
      if (query === null) {
        p.add("media_query");
        continue;
      }
      counts.media += 1;
      const inner: Block[] = [];
      parseRules(source, block.items, p, true, counts, inner);
      out.push({ media: query, rules: inner.flatMap((b) => b.rules) });
      continue;
    }
    if (c.t === "block" && c.open === "{") {
      const rule = parseRule(source, prelude, c.items, p, counts);
      if (rule) push(rule, inMedia ? "inner" : null);
      prelude = [];
      continue;
    }
    if (c.t === ";") {
      p.add("syntax");
      prelude = [];
      continue;
    }
    prelude.push(c);
  }
  if (prelude.some((x) => x.t !== "ws")) p.add("syntax");
}

function serialize(blocks: Block[]): string {
  const rule = (r: Rule, indent: string) => `${indent}${r.selectors.join(`,\n${indent}`)} {${r.declarations.map((d) => `\n${indent}  ${d};`).join("")}\n${indent}}`;
  return blocks
    .filter((b) => b.rules.length > 0)
    .map((b) => (b.media ? `@media ${b.media} {\n${b.rules.map((r) => rule(r, "  ")).join("\n")}\n}` : b.rules.map((r) => rule(r, "")).join("\n")))
    .join("\n");
}

/**
 * The widths (CSS px; em counted at 16px) where a guarded stylesheet's @media
 * conditions switch. The render check looks at each side of every one.
 */
export function mediaBreakpointsPx(css: string): number[] {
  const out = new Set<number>();
  for (const m of css.matchAll(/^@media (.*) \{$/gm)) for (const c of m[1]!.matchAll(/\((?:min|max)-width: ([0-9.]+)(px|em)\)/g)) out.add(Number(c[1]) * (c[2] === "em" ? 16 : 1));
  return [...out].sort((a, b) => a - b);
}

/**
 * Checks a per-shop stylesheet and returns it normalized, or the fixed codes
 * of everything wrong with it. Never throws.
 */
export function guardShopCss(css: string): GuardResult {
  try {
    if (typeof css !== "string") return { ok: false, problems: ["not_text"] };
    if (new TextEncoder().encode(css).length > SHOP_CSS_LIMITS.bytes) return { ok: false, problems: ["too_large"] };
    const items = componentValues(tokenize(css));
    const p = new Problems();
    const counts: Counts = { rules: 0, declarations: 0, media: 0 };
    const blocks: Block[] = [];
    parseRules(css, items, p, false, counts, blocks);
    if (counts.rules > SHOP_CSS_LIMITS.rules) p.add("too_many_rules");
    if (counts.declarations > SHOP_CSS_LIMITS.declarations) p.add("too_many_declarations");
    if (counts.media > SHOP_CSS_LIMITS.media) p.add("too_many_media");
    if (mediaBreakpointsPx(serialize(blocks)).length > SHOP_CSS_LIMITS.breakpoints) p.add("too_many_breakpoints");
    if (p.set.size > 0) return { ok: false, problems: [...p.set].sort() };
    const out = serialize(blocks);
    if (out.length === 0) return { ok: false, problems: ["empty"] };
    return { ok: true, css: out as GuardedShopCss };
  } catch (e) {
    if (e instanceof CssSyntaxError) return { ok: false, problems: [e.code] };
    return { ok: false, problems: ["guard_error"] };
  }
}

/** True when css is exactly what the guard emits for it (a stored, already normalized stylesheet). */
export function isGuardedShopCss(css: unknown): css is GuardedShopCss {
  if (typeof css !== "string") return false;
  const again = guardShopCss(css);
  return again.ok && again.css === css;
}
