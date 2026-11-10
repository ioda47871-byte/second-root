/**
 * DEV-196b (spec §7.3・T1・T2・T3・T12): the server's own safety check of a B方式 artifact (index.html + style.css),
 * the same rules as the Chromium check (Phase 2f prototype-safety: FORBIDDEN_ELEMENTS, URL_ATTRIBUTES, cssProblems,
 * cssUrls, allowedUrl; held in ./rule-core.ts, parity-tested) with the HTML read by parse5 (an HTML-spec tokenizer and tree
 * builder) instead of Chromium, which cannot run on Vercel. The rules are not relaxed; the artifact adds:
 *
 *  - no `style` attribute and no `<style>` element (the CSP has no 'unsafe-inline')
 *  - exactly one `<link rel="stylesheet" href="style.css">`, and no other `<link>`
 *  - `href` is `#fragment` only (phone, address and hours stay plain text)
 *  - `<img src>` / `srcset` only the version's photos (`photos/<name>` as the HTML references them)
 *  - `@import`, `@font-face`, `url()` to anything but a photo or `#id`, `image-set(`, `expression()` refused
 *  - `font-family` only PAGE_FONT_FAMILIES and the generic families (also through `var(--x)`); `font:` shorthand refused
 *  - order / reservation / cart words and `テスト` in visible text or attribute values refused
 *
 * Pure: parse5 and string work only. Every finding is a fixed code (detail is ASCII and short, for logs and tests).
 */
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { allowedUrl, cssProblems, cssUrls, decodeEscapes, FORBIDDEN_ELEMENTS, outsideStringsAndComments, PAGE_FONT_FAMILIES, PAGE_FONT_GENERIC_FAMILIES, PROTOTYPE_STYLESHEET, URL_ATTRIBUTES } from "./rule-core";

export type HtmlSafetyCode =
  | "HTML_FORBIDDEN_ELEMENT"
  | "HTML_STYLE_ELEMENT"
  | "HTML_EVENT_ATTRIBUTE"
  | "HTML_STYLE_ATTRIBUTE"
  | "HTML_META_HTTP_EQUIV"
  | "HTML_LINK_NOT_ALLOWED"
  | "HTML_STYLESHEET_COUNT"
  | "HTML_URL_NOT_ALLOWED"
  | "HTML_ATTRIBUTE_URL"
  | "HTML_SALES_WORD"
  | "HTML_TEST_WORD"
  | "CSS_IMPORT"
  | "CSS_FONT_FACE"
  | "CSS_CODE_EXECUTION"
  | "CSS_URL_NOT_ALLOWED"
  | "CSS_IMAGE_FUNCTION"
  | "CSS_FONT_SHORTHAND"
  | "CSS_FONT_FAMILY_NOT_ALLOWED";

export type HtmlSafetyFinding = { code: HtmlSafetyCode; detail?: string };

export type HtmlSafetyResult = {
  ok: boolean;
  findings: HtmlSafetyFinding[];
  /** every non-empty visible text node, trimmed (for the copy-record check, §7.4) */
  texts: string[];
};

/** B方式 (route-constraints.md): words that would claim an order, a reservation or a cart. */
export const ARTIFACT_SALES_WORDS = /注文|予約|カート/;
export const ARTIFACT_TEST_WORD = /テスト/;
/** meta http-equiv values that are harmless boilerplate (as in prototype-safety). */
const HARMLESS_HTTP_EQUIV = ["content-type", "x-ua-compatible", "content-language"];
/** Attributes whose value a reader sees (the B方式 word rules apply to them). */
const VISIBLE_ATTRIBUTES = ["alt", "title", "aria-label", "placeholder", "aria-description", "content"];

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
const trimAsciiWs = (v: string) => v.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");

/**
 * Checks the artifact's HTML and CSS. `photoUrls` are the version's photos as the page references them
 * (`photos/<name>`, from `photoUrlPaths(manifest)`).
 */
export function checkArtifactHtml(html: string, css: string, photoUrls: ReadonlySet<string>): HtmlSafetyResult {
  const findings: HtmlSafetyFinding[] = [];
  const add = (code: HtmlSafetyCode, detail?: string) => findings.push(detail === undefined ? { code } : { code, detail: ascii(detail) });
  const texts: string[] = [];
  let stylesheets = 0;

  const doc = parse(html);
  // iterative walk (a deeply nested page must not overflow the stack); <template> content is walked too
  const stack: Node[] = [doc];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeName === "#text") {
      const t = (node as DefaultTreeAdapterTypes.TextNode).value.trim();
      if (t) texts.push(t);
      continue;
    }
    if ("tagName" in node) {
      const el = node as Element;
      checkElement(el, photoUrls, add, () => stylesheets++);
      if (el.tagName === "template") stack.push(...[...(el as DefaultTreeAdapterTypes.Template).content.childNodes].reverse());
    }
    if ("childNodes" in node) stack.push(...[...(node as DefaultTreeAdapterTypes.ParentNode).childNodes].reverse());
  }
  if (stylesheets !== 1) add("HTML_STYLESHEET_COUNT", String(stylesheets));
  for (const t of texts) {
    if (ARTIFACT_SALES_WORDS.test(t)) add("HTML_SALES_WORD");
    if (ARTIFACT_TEST_WORD.test(t)) add("HTML_TEST_WORD");
  }
  for (const f of checkArtifactCss(css, photoUrls)) findings.push(f);
  return { ok: findings.length === 0, findings: dedupe(findings), texts };
}

function checkElement(el: Element, photoUrls: ReadonlySet<string>, add: (c: HtmlSafetyCode, d?: string) => void, countStylesheet: () => void) {
  const tag = el.tagName.toLowerCase();
  if (FORBIDDEN_ELEMENTS.includes(tag)) add("HTML_FORBIDDEN_ELEMENT", tag);
  if (tag === "style") add("HTML_STYLE_ELEMENT");
  const attrs = el.attrs.map((a) => ({ name: (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase(), value: a.value }));
  const get = (n: string) => attrs.find((a) => a.name === n)?.value;
  if (tag === "link") {
    const rel = trimAsciiWs(get("rel") ?? "").toLowerCase();
    const href = trimAsciiWs(get("href") ?? "");
    const extra = attrs.filter((a) => !["rel", "href", "type", "media"].includes(a.name));
    if (rel === "stylesheet" && href === PROTOTYPE_STYLESHEET && extra.length === 0 && (get("media") ?? "all").trim().toLowerCase() === "all") countStylesheet();
    else add("HTML_LINK_NOT_ALLOWED", `${rel} ${href}`);
  }
  if (tag === "meta") {
    const eq = get("http-equiv");
    if (eq !== undefined && !HARMLESS_HTTP_EQUIV.includes(eq.trim().toLowerCase())) add("HTML_META_HTTP_EQUIV", eq);
  }
  for (const a of attrs) {
    if (a.name.startsWith("on")) add("HTML_EVENT_ATTRIBUTE", a.name);
    if (a.name === "style") add("HTML_STYLE_ATTRIBUTE");
    if (VISIBLE_ATTRIBUTES.includes(a.name) && !(tag === "meta" && a.name === "content" && get("http-equiv") !== undefined)) {
      if (ARTIFACT_SALES_WORDS.test(a.value)) add("HTML_SALES_WORD", a.name);
      if (ARTIFACT_TEST_WORD.test(a.value)) add("HTML_TEST_WORD", a.name);
    }
    // any attribute holding a url() (SVG fill, mask, filter, clip-path …) follows the CSS url rule
    if (a.name !== "style" && /url\s*\(/i.test(a.value)) {
      if (a.value.includes("\\")) add("HTML_ATTRIBUTE_URL", `${tag} ${a.name}: escaped`);
      else for (const t of cssUrls(a.value)) if (!allowedUrl(t, photoUrls)) add("HTML_ATTRIBUTE_URL", `${tag} ${a.name}: ${t}`);
    }
    if (URL_ATTRIBUTES.includes(a.name) && !(tag === "link" && a.name === "href")) {
      const values = a.name === "srcset" ? a.value.split(",").map((s) => trimAsciiWs(s).split(/[\t\n\f\r ]+/)[0] ?? "") : [trimAsciiWs(a.value)];
      for (const v of values) {
        if ((a.name === "href" || a.name === "xlink:href") && /^#\S*$/u.test(v)) continue;
        if ((tag === "img" && (a.name === "src" || a.name === "srcset")) || (tag === "source" && a.name === "srcset")) {
          if (photoUrls.has(v)) continue;
        }
        add("HTML_URL_NOT_ALLOWED", `${tag} ${a.name}: ${v}`);
      }
    }
  }
}

/** The CSS rules: prototype-safety's cssProblems (photos as the declared assets) plus the artifact's own. */
export function checkArtifactCss(css: string, photoUrls: ReadonlySet<string>): HtmlSafetyFinding[] {
  const out: HtmlSafetyFinding[] = [];
  for (const p of cssProblems(css, photoUrls)) {
    const code: HtmlSafetyCode = p === "css @import" ? "CSS_IMPORT" : p === "css code execution" ? "CSS_CODE_EXECUTION" : p.startsWith("css url") ? "CSS_URL_NOT_ALLOWED" : "CSS_IMAGE_FUNCTION";
    out.push({ code, detail: ascii(p) });
  }
  if (/@font-face/i.test(decodeEscapes(outsideStringsAndComments(css)))) out.push({ code: "CSS_FONT_FACE" });
  out.push(...fontProblems(css));
  return out;
}

/** Declarations of a stylesheet (property lower-cased and unescaped, value unescaped), split outside strings and comments. */
export function cssDeclarations(css: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = [];
  let buf = "";
  let depth = 0;
  const flush = () => {
    const i = buf.indexOf(":");
    if (i > 0) {
      const prop = decodeEscapes(buf.slice(0, i)).trim();
      // a selector ends in "{", so what is left of a ":" before a ";" / "}" is a declaration (pseudo-classes end in "{")
      if (/^-{0,2}[A-Za-z_][A-Za-z0-9_-]*$/.test(prop)) out.push({ prop: prop.startsWith("--") ? prop : prop.toLowerCase(), value: decodeEscapes(buf.slice(i + 1)).trim() });
    }
    buf = "";
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") {
      buf += css.slice(i, i + 2);
      i++;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      buf += " ";
    } else if (c === '"' || c === "'") {
      const start = i;
      for (i++; i < css.length && css[i] !== c && css[i] !== "\n"; i++) if (css[i] === "\\") i++;
      buf += css.slice(start, i + 1);
    } else if (c === "(") {
      depth++;
      buf += c;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      buf += c;
    } else if (depth === 0 && (c === ";" || c === "{" || c === "}")) {
      if (c === "{") buf = "";
      else flush();
    } else buf += c;
  }
  flush();
  return out;
}

const CSS_WIDE = ["inherit", "initial", "unset", "revert", "revert-layer"];

/** Each comma-separated family of a font list is allowed (quoted names and unquoted idents both checked). */
export function isAllowedFontList(value: string): boolean {
  const v = value.replace(/!\s*important\s*$/i, "").trim();
  if (CSS_WIDE.includes(v.toLowerCase())) return true;
  const items: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const c of v) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      items.push(cur);
      cur = "";
    } else cur += c;
  }
  if (q) return false;
  items.push(cur);
  return items.every((raw) => {
    const item = raw.trim();
    const quoted = /^(["'])(.*)\1$/.exec(item);
    if (quoted) return (PAGE_FONT_FAMILIES as readonly string[]).includes(quoted[2]!);
    if (!/^[A-Za-z][A-Za-z0-9-]*( [A-Za-z0-9][A-Za-z0-9-]*)*$/.test(item)) return false;
    return PAGE_FONT_GENERIC_FAMILIES.includes(item.toLowerCase()) || (PAGE_FONT_FAMILIES as readonly string[]).includes(item);
  });
}

function fontProblems(css: string): HtmlSafetyFinding[] {
  const out: HtmlSafetyFinding[] = [];
  const decls = cssDeclarations(css);
  const custom = new Map<string, string[]>();
  for (const d of decls) if (d.prop.startsWith("--")) custom.set(d.prop, [...(custom.get(d.prop) ?? []), d.value]);
  // a font list, or var(--x) whose every definition is (through at most 4 levels of var())
  const ok = (value: string, depth: number): boolean => {
    const v = value.replace(/!\s*important\s*$/i, "").trim();
    const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(v);
    if (m) {
      const defs = custom.get(m[1]!);
      return depth < 4 && defs !== undefined && defs.every((d) => ok(d, depth + 1));
    }
    return !/var\(/i.test(v) && isAllowedFontList(v);
  };
  for (const d of decls) {
    if (d.prop === "font") out.push({ code: "CSS_FONT_SHORTHAND" });
    if (d.prop === "font-family" && !ok(d.value, 0)) out.push({ code: "CSS_FONT_FAMILY_NOT_ALLOWED", detail: ascii(d.value) });
  }
  return out;
}

function dedupe(f: HtmlSafetyFinding[]): HtmlSafetyFinding[] {
  const seen = new Set<string>();
  return f.filter((x) => {
    const k = `${x.code}|${x.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
