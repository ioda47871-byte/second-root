/**
 * DEV-199a (Issue #258, spec PR #257, review rule L5): the words a page shows, by section and role, read from the
 * page's own DOM — never from fields a model declared.
 *
 *   section   the nearest ancestor with `data-comp-section` (comp lane) or `data-section` (Phase 2f). Text outside
 *             every section belongs to the pseudo section `_page` (e.g. a quick-info bar above the hero).
 *   role      `heading` for text inside h1–h6, `label` for dt / th, `decoration` for text under aria-hidden="true"
 *             (ghost words drawn as ornament; still visible, so the copy-record check still sees them), `body` for
 *             everything else.
 *   entry     one text block: the innermost block element's text, its inline children joined (spans, <wbr>, <br>
 *             join without a space), whitespace collapsed. Its position is (section index, entry index) in reading
 *             order of the source.
 *
 * Skipped from the sections: <head>, script / style / template / noscript, and SVG (the research comps' SVGs are
 * aria-hidden art). The <title> and the attribute values a reader sees or hears (VISIBLE_TEXT_ATTRIBUTES, the same list
 * the server's HTML check uses) are returned apart as `otherTexts`, so the copy-record check sees them too.
 *
 * Pure: parse5 only. Bounded: a page larger than MAX_PAGE_CHARS is refused rather than parsed.
 */
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { VISIBLE_TEXT_ATTRIBUTES } from "@/lib/sales/demo-version/html-safety";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export type EntryRole = "heading" | "body" | "label" | "decoration";
export type PageEntry = { role: EntryRole; text: string; position: { section: number; entry: number } };
export type PageSection = { section_id: string; index: number; entries: PageEntry[] };
export type PageText = { sections: PageSection[]; otherTexts: string[] };

export const MAX_PAGE_CHARS = 2_000_000;
export const OUTSIDE_SECTIONS = "_page";

const SKIP = new Set(["head", "script", "style", "template", "noscript", "svg", "math"]);
const BLOCKS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "dt", "dd", "li", "figcaption", "caption", "th", "td", "blockquote", "address", "summary", "legend"]);
const HEADINGS = /^h[1-6]$/;

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const isElement = (n: Node): n is Element => "tagName" in n;

export class PageTextError extends Error {}

/** The page's sections in source order, each with its text entries, and the page's other visible texts. */
export function pageText(html: string): PageText {
  if (html.length > MAX_PAGE_CHARS) throw new PageTextError("PAGE_TOO_LARGE");
  const doc = parse(html);
  const sections: PageSection[] = [];
  const otherTexts: string[] = [];
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const visit = (n: Node) => {
    if (!isElement(n)) return;
    if (n.tagName === "title") {
      const t = collapse(n.childNodes.map((c) => (c.nodeName === "#text" ? (c as DefaultTreeAdapterTypes.TextNode).value : "")).join(""));
      if (t) otherTexts.push(t);
    }
    for (const a of n.attrs) if (VISIBLE_TEXT_ATTRIBUTES.includes(a.name) && collapse(a.value)) otherTexts.push(collapse(a.value));
    const kids = n.tagName === "template" ? (n as DefaultTreeAdapterTypes.Template).content.childNodes : n.childNodes;
    for (const c of kids) visit(c);
  };
  for (const c of doc.childNodes) visit(c);
  const byId = new Map<string, PageSection>();
  const sectionFor = (id: string) => {
    let s = byId.get(id);
    if (!s) {
      s = { section_id: id, index: sections.length, entries: [] };
      sections.push(s);
      byId.set(id, s);
    }
    return s;
  };
  type Ctx = { section: string; heading: boolean; label: boolean; hidden: boolean };
  const push = (ctx: Ctx, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    const s = sectionFor(ctx.section);
    const role: EntryRole = ctx.hidden ? "decoration" : ctx.heading ? "heading" : ctx.label ? "label" : "body";
    s.entries.push({ role, text: t, position: { section: s.index, entry: s.entries.length } });
  };
  // text of a block: every descendant text node, joined as drawn (inline elements add nothing)
  const textOf = (n: Node): string => {
    if (n.nodeName === "#text") return (n as DefaultTreeAdapterTypes.TextNode).value;
    if (!isElement(n) || SKIP.has(n.tagName)) return "";
    return n.childNodes.map(textOf).join("");
  };
  const hasBlock = (n: Node): boolean => isElement(n) && !SKIP.has(n.tagName) && n.childNodes.some((c) => isElement(c) && (BLOCKS.has(c.tagName) || hasBlock(c)));
  const walk = (n: Node, ctx: Ctx) => {
    if (!isElement(n)) {
      if (n.nodeName === "#text") push(ctx, (n as DefaultTreeAdapterTypes.TextNode).value);
      return;
    }
    if (SKIP.has(n.tagName)) return;
    const sec = attr(n, "data-comp-section") ?? attr(n, "data-section");
    const next: Ctx = {
      section: sec && sec.trim() ? sec.trim() : ctx.section,
      heading: ctx.heading || HEADINGS.test(n.tagName),
      label: ctx.label || n.tagName === "dt" || n.tagName === "th",
      hidden: ctx.hidden || attr(n, "aria-hidden") === "true" || attr(n, "hidden") !== undefined,
    };
    if (BLOCKS.has(n.tagName) && !hasBlock(n)) {
      push(next, textOf(n));
      return;
    }
    for (const c of n.childNodes) walk(c, next);
  };
  const html_ = doc.childNodes.find((c) => isElement(c) && c.tagName === "html");
  const body = html_ && isElement(html_) ? html_.childNodes.find((c) => isElement(c) && c.tagName === "body") : undefined;
  if (body) walk(body, { section: OUTSIDE_SECTIONS, heading: false, label: false, hidden: false });
  return { sections, otherTexts };
}
