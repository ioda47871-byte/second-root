import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkArtifactCss, checkArtifactHtml, cssDeclarations, isAllowedFontList } from "@/lib/sales/demo-version/html-safety";

const POC = "design-library/research/quality-pipeline/poc";
const pages = (shop: string) => {
  const root = `${POC}/${shop}/fidelity`;
  return [root, ...readdirSync(root).map((d) => `${root}/${d}`)].filter((d) => existsSync(`${d}/index.html`) && existsSync(`${d}/style.css`));
};
const read = (dir: string) => [readFileSync(`${dir}/index.html`, "utf8"), readFileSync(`${dir}/style.css`, "utf8")] as const;

const PHOTOS = new Set(["photos/hero-desktop.webp", "photos/hero-mobile.jpg"]);
const CSS = "body { font-family: \"Noto Sans JP\", sans-serif; }";
const page = (body: string, head = '<link rel="stylesheet" href="style.css">') => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title>${head}</head><body>${body}</body></html>`;
const codes = (html: string, css = CSS) => checkArtifactHtml(html, css, PHOTOS).findings.map((f) => f.code);

describe("research fidelity pages (T2: the corpus that must pass)", () => {
  const corpus = [...pages("bicycle"), ...pages("sento")];
  it("has the pages", () => expect(corpus.length).toBeGreaterThanOrEqual(20));
  it.each(corpus)("%s passes", (dir) => {
    const [html, css] = read(dir);
    const r = checkArtifactHtml(html, css, new Set());
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.texts.length).toBeGreaterThan(5);
  });

  // つぐ手 names "IPA明朝", which is not on PAGE_FONT_FAMILIES: the allowlist is not widened here (open question)
  it.each(pages("tsugute"))("%s fails only on the font allowlist", (dir) => {
    const [html, css] = read(dir);
    expect(new Set(checkArtifactHtml(html, css, new Set()).findings.map((f) => f.code))).toEqual(new Set(["CSS_FONT_FAMILY_NOT_ALLOWED"]));
  });
});

describe("a clean artifact", () => {
  it("passes with photos, fragments and inline SVG", () => {
    const html = page(
      '<nav><a href="#visit">道順</a></nav><picture><source media="(max-width:600px)" srcset="photos/hero-mobile.jpg"><img src="photos/hero-desktop.webp" alt="店内の光"></picture>' +
        '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg><section id="visit"><p>東京都架空区1-2-3</p></section>',
    );
    const css = ':root { --gothic: "Noto Sans CJK JP", "IPAGothic", sans-serif; } body { font-family: var(--gothic); background: url(photos/hero-desktop.webp); } .x { font-family: inherit; }';
    const r = checkArtifactHtml(html, css, PHOTOS);
    expect(r.findings).toEqual([]);
    expect(r.texts).toContain("東京都架空区1-2-3");
  });
});

describe("XSS / exfiltration corpus (T1・T2・T3: every one is refused)", () => {
  const CORPUS: Array<[string, string, string]> = [
    ["script", page("<script>alert(1)</script>"), "HTML_FORBIDDEN_ELEMENT"],
    ["script in template", page("<template><script>alert(1)</script></template>"), "HTML_FORBIDDEN_ELEMENT"],
    ["script in svg", page("<svg><script>alert(1)</script></svg>"), "HTML_FORBIDDEN_ELEMENT"],
    ["noscript", page("<noscript><p>x</p></noscript>"), "HTML_FORBIDDEN_ELEMENT"],
    ["iframe", page('<iframe src="https://evil.example"></iframe>'), "HTML_FORBIDDEN_ELEMENT"],
    ["object", page('<object data="x.swf"></object>'), "HTML_FORBIDDEN_ELEMENT"],
    ["embed", page('<embed src="x">'), "HTML_FORBIDDEN_ELEMENT"],
    ["form", page('<form action="https://evil.example"><input name="a"></form>'), "HTML_FORBIDDEN_ELEMENT"],
    ["base", page("", '<base href="https://evil.example/"><link rel="stylesheet" href="style.css">'), "HTML_FORBIDDEN_ELEMENT"],
    ["foreignObject", page("<svg><foreignObject><p>x</p></foreignObject></svg>"), "HTML_FORBIDDEN_ELEMENT"],
    ["svg animate href", page('<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>'), "HTML_FORBIDDEN_ELEMENT"],
    ["svg set", page('<svg><set attributeName="href" to="x"/></svg>'), "HTML_FORBIDDEN_ELEMENT"],
    ["onerror", page('<img src="photos/hero-desktop.webp" onerror="alert(1)">'), "HTML_EVENT_ATTRIBUTE"],
    ["onload on body", '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body onload="alert(1)"></body></html>', "HTML_EVENT_ATTRIBUTE"],
    ["svg onbegin", page('<svg><rect onbegin="alert(1)"/></svg>'), "HTML_EVENT_ATTRIBUTE"],
    ["uppercase ONCLICK", page('<p ONCLICK="alert(1)">x</p>'), "HTML_EVENT_ATTRIBUTE"],
    ["javascript href", page('<a href="javascript:alert(1)">x</a>'), "HTML_URL_NOT_ALLOWED"],
    ["entity-encoded javascript href", page('<a href="&#106;avascript:alert(1)">x</a>'), "HTML_URL_NOT_ALLOWED"],
    ["tab in javascript href", page('<a href="java\tscript:alert(1)">x</a>'), "HTML_URL_NOT_ALLOWED"],
    ["xlink javascript", page('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'), "HTML_URL_NOT_ALLOWED"],
    ["external link", page('<a href="https://evil.example/">x</a>'), "HTML_URL_NOT_ALLOWED"],
    ["tel link", page('<a href="tel:0000000000">電話</a>'), "HTML_URL_NOT_ALLOWED"],
    ["protocol-relative img", page('<img src="//evil.example/p.gif">'), "HTML_URL_NOT_ALLOWED"],
    ["data img", page('<img src="data:image/svg+xml,<svg onload=alert(1)>">'), "HTML_URL_NOT_ALLOWED"],
    ["undeclared photo", page('<img src="photos/other-mobile.webp">'), "HTML_URL_NOT_ALLOWED"],
    ["srcset external", page('<img src="photos/hero-desktop.webp" srcset="photos/hero-desktop.webp 1x, https://evil.example/a.webp 2x">'), "HTML_URL_NOT_ALLOWED"],
    ["video poster", page('<video poster="https://evil.example/p.jpg"></video>'), "HTML_URL_NOT_ALLOWED"],
    ["ping", page('<a href="#x" ping="https://evil.example/">x</a>'), "HTML_URL_NOT_ALLOWED"],
    ["svg image href", page('<svg><image href="https://evil.example/a.png"/></svg>'), "HTML_URL_NOT_ALLOWED"],
    ["U+3000 before fragment", page('<a href="　#x">x</a>'), "HTML_URL_NOT_ALLOWED"],
    ["meta refresh", page("", '<meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="style.css">'), "HTML_META_HTTP_EQUIV"],
    ["meta set-cookie", page("", '<meta http-equiv="set-cookie" content="a=b"><link rel="stylesheet" href="style.css">'), "HTML_META_HTTP_EQUIV"],
    ["style attribute", page('<p style="color:red">x</p>'), "HTML_STYLE_ATTRIBUTE"],
    ["style element", page("<style>body{}</style>"), "HTML_STYLE_ELEMENT"],
    ["svg style element", page("<svg><style>rect{}</style></svg>"), "HTML_STYLE_ELEMENT"],
    ["preload link", page("", '<link rel="stylesheet" href="style.css"><link rel="preload" href="https://evil.example/x">'), "HTML_LINK_NOT_ALLOWED"],
    ["external stylesheet", page("", '<link rel="stylesheet" href="https://evil.example/s.css">'), "HTML_LINK_NOT_ALLOWED"],
    ["two stylesheets", page("", '<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="style.css">'), "HTML_STYLESHEET_COUNT"],
    ["no stylesheet", page("<p>x</p>", ""), "HTML_STYLESHEET_COUNT"],
    ["svg attribute url", page('<svg><rect fill="url(https://evil.example/a#b)"/></svg>'), "HTML_ATTRIBUTE_URL"],
    ["escaped attribute url", page('<svg><rect fill="url(\\68ttps://evil.example)"/></svg>'), "HTML_ATTRIBUTE_URL"],
    ["order word", page("<p>ご注文はこちら</p>"), "HTML_SALES_WORD"],
    ["reservation word in alt", page('<img src="photos/hero-desktop.webp" alt="予約">'), "HTML_SALES_WORD"],
    ["cart word", page("<p>カートに入れる</p>"), "HTML_SALES_WORD"],
    ["test word", page("<h1>テスト店</h1>"), "HTML_TEST_WORD"],
  ];
  it.each(CORPUS)("%s", (_name, html, code) => {
    const r = checkArtifactHtml(html, CSS, PHOTOS);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain(code);
  });

  const CSS_CORPUS: Array<[string, string, string]> = [
    ["@import", '@import url("https://evil.example/a.css");', "CSS_IMPORT"],
    ["escaped @import", "@\\69mport 'https://evil.example/a.css';", "CSS_IMPORT"],
    ["@font-face", '@font-face { font-family: "X"; src: local("Arial"); }', "CSS_FONT_FACE"],
    ["escaped @font-face", "@font-fac\\65 { font-family: X; }", "CSS_FONT_FACE"],
    ["external url()", "body { background: url(https://evil.example/t.gif); }", "CSS_URL_NOT_ALLOWED"],
    ["escaped url()", "body { background: u\\72l(https://evil.example/t.gif); }", "CSS_URL_NOT_ALLOWED"],
    ["data url()", 'body { background: url("data:image/png;base64,AAAA"); }', "CSS_URL_NOT_ALLOWED"],
    ["undeclared photo url()", "body { background: url(photos/x-mobile.webp); }", "CSS_URL_NOT_ALLOWED"],
    ["image-set", 'body { background: image-set("photos/hero-desktop.webp" 1x); }', "CSS_IMAGE_FUNCTION"],
    ["expression", "body { width: expression(alert(1)); }", "CSS_CODE_EXECUTION"],
    ["-moz-binding", "body { -moz-binding: x; }", "CSS_CODE_EXECUTION"],
    ["font not on the list", 'body { font-family: "Comic Sans MS", sans-serif; }', "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["unquoted font not on the list", "body { font-family: Papyrus; }", "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["monospace", "body { font-family: monospace; }", "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["var to a bad list", ':root { --f: "Evil Font"; } body { font-family: var(--f); }', "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["var redefined badly", ':root { --f: serif; } .x { --f: "Evil"; } body { font-family: var(--f); }', "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["undefined var", "body { font-family: var(--nope); }", "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["var with fallback", 'body { font-family: var(--nope, "Evil"); }', "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["escaped font name", 'body { font-family: "Ev\\69l"; }', "CSS_FONT_FAMILY_NOT_ALLOWED"],
    ["font shorthand", "body { font: 16px Papyrus; }", "CSS_FONT_SHORTHAND"],
  ];
  it.each(CSS_CORPUS)("css: %s", (_name, css, code) => {
    expect(codes(page("<p>x</p>"), css)).toContain(code);
    expect(checkArtifactCss(css, PHOTOS).map((f) => f.code)).toContain(code);
  });
});

describe("CSS helpers", () => {
  it("splits declarations outside strings and comments", () => {
    expect(cssDeclarations('a:hover { content: "a;b}"; /* font: x; */ color: red } @media (max-width: 600px) { .b { --x: "Noto Sans JP", serif } }')).toEqual([
      { prop: "content", value: '"a;b}"' },
      { prop: "color", value: "red" },
      { prop: "--x", value: '"Noto Sans JP", serif' },
    ]);
  });
  it("reads font lists", () => {
    expect(isAllowedFontList('"Noto Serif JP", "IPAMincho", serif')).toBe(true);
    expect(isAllowedFontList("Noto Sans JP, sans-serif !important")).toBe(true);
    expect(isAllowedFontList("inherit")).toBe(true);
    expect(isAllowedFontList('"Noto Sans JP')).toBe(false);
    expect(isAllowedFontList("Noto Sans JP, cursive")).toBe(false);
  });
});
