import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_FONT_FAMILIES as SRC_FONTS } from "@/lib/design-agent/comp-impl/page-css";
import { cssProblems as srcCssProblems, cssUrls as srcCssUrls, outsideStringsAndComments as srcOutside, PROTOTYPE_STYLESHEET as SRC_STYLESHEET } from "@/lib/design-agent/phase2f/prototype-safety";
import * as core from "@/lib/sales/demo-version/rule-core";

// rule-core.ts is a verbatim copy of the B方式 rules (the source directories are behind owner-approved import
// boundaries). This test fails the moment the copy and its source disagree.

const SAFETY = readFileSync("lib/design-agent/phase2f/prototype-safety.ts", "utf8");
const PAGE_CSS = readFileSync("lib/design-agent/comp-impl/page-css.ts", "utf8");
const CORE = readFileSync("lib/sales/demo-version/rule-core.ts", "utf8");

/** The source text of a top-level declaration (from its first line up to the next blank line). */
const decl = (src: string, start: RegExp) => {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => start.test(l));
  expect(i, String(start)).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  // up to a blank line or the next top-level declaration / doc comment
  for (let j = i; j < lines.length && lines[j]!.trim() !== "" && (j === i || !/^(\/\*\*|const |export |function |type )/.test(lines[j]!)); j++) out.push(lines[j]!);
  return out.join("\n").replace(/^export /, "");
};

describe("rule-core parity with its sources", () => {
  it.each([
    [/^const FORBIDDEN_ELEMENTS = /, /^export const FORBIDDEN_ELEMENTS = /],
    [/^const URL_ATTRIBUTES = /, /^export const URL_ATTRIBUTES = /],
    [/^const allowedUrl = /, /^export const allowedUrl = /],
    [/^const decodeEscapes = /, /^export const decodeEscapes = /],
    [/^export function cssUrls\(/, /^export function cssUrls\(/],
    [/^export function outsideStringsAndComments\(/, /^export function outsideStringsAndComments\(/],
  ])("prototype-safety %s is copied verbatim", (src, copy) => {
    expect(decl(CORE, copy)).toBe(decl(SAFETY, src));
  });

  it("the stylesheet name, the font list and the generic families match page-css", () => {
    expect(core.PROTOTYPE_STYLESHEET).toBe(SRC_STYLESHEET);
    expect([...core.PAGE_FONT_FAMILIES]).toEqual([...SRC_FONTS]);
    const generic = /^const GENERIC = (\[[^\]]*\]);$/m.exec(PAGE_CSS);
    expect(generic).not.toBeNull();
    expect(core.PAGE_FONT_GENERIC_FAMILIES).toEqual(JSON.parse(generic![1]!));
  });

  // review round 1 L4: the body of cssProblems' non-canonical branch (the first pass on the text as written) is the
  // same source text. The server intentionally DIVERGES only by ADDING checks outside rule-core (css-scan.ts, the
  // allowlists and the no-text rule in html-safety.ts, in place of Chromium's second pass): the shared first pass
  // itself must stay identical, so it is compared as text here and as behaviour below.
  it("cssProblems' first pass is copied verbatim (source text, comments aside)", () => {
    const body = (src: string) => {
      const lines = src.split("\n");
      const start = lines.findIndex((l) => l.trim() === "const decoded = decodeEscapes(css);");
      expect(start).toBeGreaterThan(0);
      const out: string[] = [];
      for (let j = start; lines[j]!.trim() !== "return out;"; j++) if (!lines[j]!.trim().startsWith("//")) out.push(lines[j]!.trim());
      return out;
    };
    expect(body(CORE)).toEqual(body(SAFETY));
    expect(body(CORE)).toHaveLength(6);
  });

  // the non-canonical branch of cssProblems, and the helpers, behave identically on a CSS corpus
  const POC = "design-library/research/quality-pipeline/poc";
  const research = readdirSync(POC).flatMap((shop) => {
    const root = `${POC}/${shop}/fidelity`;
    if (!existsSync(root)) return [];
    return [root, ...readdirSync(root).map((d) => `${root}/${d}`)].filter((d) => existsSync(`${d}/style.css`)).map((d) => readFileSync(`${d}/style.css`, "utf8"));
  });
  const hostile = [
    '@import url("https://evil.example/a.css");',
    "@\\69mport 'x';",
    "/* @import */ a { content: '/* @import */' }",
    "body { background: url(https://evil.example/t.gif) }",
    "body { background: u\\72l(https://evil.example/t.gif) }",
    'body { background: url("assets/A1.png") url(#f) url(  "a\\)b" ) }',
    "body { width: expression(alert(1)); -moz-binding: x; behavior: url(x.htc) }",
    "body { scroll-behavior: smooth }",
    'body { background: image-set("a.png" 1x) }',
    "a { content: '\\201C' }",
  ];
  const assets = new Set(["assets/A1.png", "photos/hero-mobile.webp"]);
  it.each([...research.map((c, i) => [`research ${i}`, c] as const), ...hostile.map((c, i) => [`hostile ${i}`, c] as const)])("%s: same cssProblems / cssUrls / outsideStringsAndComments", (_n, css) => {
    expect(core.cssProblems(css, assets)).toEqual(srcCssProblems(css, assets));
    expect(core.cssUrls(css)).toEqual(srcCssUrls(css));
    expect(core.outsideStringsAndComments(css)).toEqual(srcOutside(css));
  });
});
