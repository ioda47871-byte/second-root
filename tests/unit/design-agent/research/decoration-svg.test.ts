import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkDecorationAssetFile,
  checkDecorationSvg,
  DECORATION_SVG_ELEMENTS,
  DECORATION_SVG_LIMITS,
  decorationReferenceProblems,
  type DecorationAsset,
} from "../../../../lib/design-agent/research/decoration-svg";

// DEV-162 (Issue #193 comment 6601921731, decision 2): N1 research only. The checker is not wired into any lane.

const REPO = resolve(__dirname, "../../../..");
const MODULE = "lib/design-agent/research/decoration-svg.ts";
const NS = `xmlns="http://www.w3.org/2000/svg"`;
const svg = (inner: string, attrs = `width="100" height="100" viewBox="0 0 100 100"`) => `<svg ${NS} ${attrs}>${inner}</svg>`;
const check = (s: string) => checkDecorationSvg(Buffer.from(s, "latin1"));
const codes = (s: string) => check(s).findings.map((f) => f.code);

/** Shapes of the three fidelity pages' inline SVGs (tsugute d1-v3, bicycle d1-v2, sento d1-v2), as standalone files. */
const SEAM = svg(`<path d="M70 0 L 70 70 C 70 84, 60 90, 60 100" fill="none" stroke="#b8923a" stroke-width="2" vector-effect="non-scaling-stroke"/>`, `width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"`);
const spokes = Array.from({ length: 12 }, (_, k) => {
  const a = (k * Math.PI) / 6;
  return `<line x1="1010" y1="640" x2="${(1010 + 560 * Math.cos(a)).toFixed(1)}" y2="${(640 + 560 * Math.sin(a)).toFixed(1)}"/>`;
}).join("");
const WHEEL = svg(
  `<g fill="none" stroke="#1d1d1b"><circle cx="1010" cy="640" r="620" stroke-width="28"/><circle cx="1010" cy="640" r="570" stroke-width="6"/><g stroke-width="3">${spokes}</g><circle cx="1010" cy="640" r="40" fill="#1d1d1b"/></g>`,
  `width="1440" height="1400" viewBox="-110 0 1440 1400"`,
);
const MOUNTAIN = svg(
  `<defs><linearGradient id="mt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f5d7c"/><stop offset="1" stop-color="#2f5d7c" stop-opacity="0.4"/></linearGradient></defs><polygon points="-60,600 273,180 580,600" fill="url(#mt)"/><polygon points="260,600 510,300 780,600" fill="#24475f" opacity="0.8"/>`,
  `width="660" height="600" viewBox="0 0 660 600" preserveAspectRatio="none"`,
);

describe("must pass: the fidelity pages' decorative shapes", () => {
  it.each([
    ["seam line", SEAM, 100, 100],
    ["spokes wheel", WHEEL, 1440, 1400],
    ["mountains with a same-file gradient", MOUNTAIN, 660, 600],
  ])("%s", (_, s, w, h) => {
    const c = check(s);
    expect(c.findings).toEqual([]);
    expect(c.ok).toBe(true);
    expect([c.width, c.height]).toEqual([w, h]);
  });

  it("an XML declaration, whitespace between elements, a radial gradient, groups with transforms", () => {
    const s = `<?xml version="1.0" encoding="UTF-8"?>\n${svg(`\n  <defs>\n    <radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="rgba(255,200,120,0.9)"/><stop offset="100%" stop-color="transparent"/></radialGradient>\n  </defs>\n  <g transform="translate(10, 10) rotate(-4)"><ellipse cx="40" cy="40" rx="30" ry="20" fill="url(#glow)"/><rect x="0" y="0" width="5" height="5" rx="1" fill="#000"/><polyline points="0,0 10,10 20,0" fill="none" stroke="black"/></g>\n`)}\n`;
    expect(check(s).findings).toEqual([]);
  });

  it("the element list is the one in the design doc (and nothing else)", () => {
    expect([...DECORATION_SVG_ELEMENTS].sort()).toEqual(["circle", "defs", "ellipse", "g", "line", "linearGradient", "path", "polygon", "polyline", "radialGradient", "rect", "stop", "svg"]);
  });
});

describe("must fail: every refused thing, one probe each", () => {
  const ref = `<rect width="1" height="1"/>`;
  it.each([
    // markup the checker never parses
    ["DOCTYPE", `<!DOCTYPE svg>${svg(ref)}`, "SVG_DTD"],
    ["billion laughs", `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>${svg(`<g id="x">&b;</g>`)}`, "SVG_DTD"],
    ["entity reference", svg(`<g id="&amp;"/>`), "SVG_ENTITY"],
    ["character reference hiding a colon", svg(`<g fill="url&#40;#x)"/>`), "SVG_ENTITY"],
    ["CDATA-hidden script", svg(`<script><![CDATA[alert(1)]]></script>`), "SVG_CDATA"],
    ["CDATA alone", svg(`<g><![CDATA[x]]></g>`), "SVG_CDATA"],
    ["comment", svg(`<!-- note -->${ref}`), "SVG_COMMENT"],
    ["processing instruction", svg(`<?xml-stylesheet href="http://x/a.css"?>${ref}`), "SVG_PROCESSING_INSTRUCTION"],
    ["stylesheet PI before the root", `<?xml-stylesheet type="text/css" href="a.css"?>${svg(ref)}`, "SVG_PROCESSING_INSTRUCTION"],
    ["XML declaration with another encoding", `<?xml version="1.0" encoding="UTF-16"?>${svg(ref)}`, "SVG_PROCESSING_INSTRUCTION"],
    // elements
    ["script", svg(`<script>alert(1)</script>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["SCRIPT (case)", svg(`<SCRIPT>alert(1)</SCRIPT>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["Svg root (case)", `<Svg ${NS} width="1" height="1" viewBox="0 0 1 1"></Svg>`, "SVG_ELEMENT_NOT_ALLOWED"],
    ["style element", svg(`<style>@import url(http://x/a.css);</style>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["text", svg(`<text x="0" y="10">hi</text>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["tspan", svg(`<tspan/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["textPath", svg(`<textPath/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["foreignObject", svg(`<foreignObject width="10" height="10"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["image", svg(`<image width="10" height="10"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["use", svg(`<use/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["a", svg(`<a>${ref}</a>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["filter", svg(`<filter id="f"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["mask", svg(`<mask id="m"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["pattern", svg(`<pattern id="p"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["clipPath", svg(`<clipPath id="c"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["symbol", svg(`<symbol id="s"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["marker", svg(`<marker id="m"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["animate", svg(`<animate attributeName="x"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["animateTransform", svg(`<animateTransform/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["set", svg(`<set attributeName="fill" to="red"/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["title (text, refused by decision)", svg(`<title>t</title>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["desc", svg(`<desc>d</desc>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["metadata", svg(`<metadata/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["switch", svg(`<switch/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["iframe (HTML in SVG)", svg(`<iframe/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["prefixed element (svg:script)", svg(`<svg:script/>`), "SVG_ELEMENT_PREFIX"],
    ["html-namespaced element", svg(`<h:div/>`), "SVG_ELEMENT_PREFIX"],
    ["nested svg", svg(`<svg ${NS} width="1" height="1" viewBox="0 0 1 1"/>`), "SVG_ELEMENT_PLACE"],
    ["gradient outside defs", svg(`<linearGradient id="g"/>`), "SVG_ELEMENT_PLACE"],
    ["stop outside a gradient", svg(`<g><stop offset="0"/></g>`), "SVG_ELEMENT_PLACE"],
    ["shape inside defs", svg(`<defs>${ref}</defs>`), "SVG_ELEMENT_PLACE"],
    ["text content in a group", svg(`<g>hello</g>`), "SVG_TEXT_CONTENT"],
    ["element after the root", `${svg(ref)}<g/>`, "SVG_AFTER_ROOT"],
    // attributes
    ["onload", svg(ref).replace("<svg ", `<svg onload="alert(1)" `), "SVG_EVENT_HANDLER"],
    ["ONCLICK (case)", svg(`<rect width="1" height="1" ONCLICK="x()"/>`), "SVG_EVENT_HANDLER"],
    ["onbegin", svg(`<g onbegin="x()"/>`), "SVG_EVENT_HANDLER"],
    ["href", svg(`<g href="http://x/"/>`), "SVG_HREF"],
    ["xlink:href", svg(`<g xlink:href="http://x/"/>`), "SVG_HREF"],
    ["xlink namespace declared", svg(ref, `width="1" height="1" viewBox="0 0 1 1" xmlns:xlink="http://www.w3.org/1999/xlink"`), "SVG_NAMESPACED_ATTRIBUTE"],
    ["xlink aliased to another prefix", svg(`<g q:href="data:image/png;base64,AA"/>`, `width="1" height="1" viewBox="0 0 1 1" xmlns:q="http://www.w3.org/1999/xlink"`), "SVG_HREF"],
    ["gradient href (SVG 2 inheritance)", svg(`<defs><linearGradient id="a"/><linearGradient id="b" href="#a"/></defs>`), "SVG_HREF"],
    ["xml:base", svg(ref, `width="1" height="1" viewBox="0 0 1 1" xml:base="http://x/"`), "SVG_NAMESPACED_ATTRIBUTE"],
    ["xml:space", svg(`<g xml:space="preserve"/>`), "SVG_NAMESPACED_ATTRIBUTE"],
    ["xmlns on a child (namespace switch)", svg(`<g xmlns="http://www.w3.org/1999/xhtml"/>`), "SVG_NAMESPACED_ATTRIBUTE"],
    ["root in another namespace", `<svg xmlns="http://www.w3.org/1999/xhtml" width="1" height="1" viewBox="0 0 1 1"></svg>`, "SVG_ATTRIBUTE_VALUE"],
    ["root without a namespace", `<svg width="1" height="1" viewBox="0 0 1 1"></svg>`, "SVG_NAMESPACE"],
    ["style attribute", svg(`<rect width="1" height="1" style="fill:red"/>`), "SVG_STYLE"],
    ["style attribute with url()", svg(`<rect width="1" height="1" style="fill:url(http://x/a.svg#p)"/>`), "SVG_STYLE"],
    ["class (needs page CSS)", svg(`<rect class="tire" width="1" height="1"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["mask attribute", svg(`<rect width="1" height="1" mask="url(#m)"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["filter attribute", svg(`<rect width="1" height="1" filter="url(#f)"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["clip-path attribute", svg(`<rect width="1" height="1" clip-path="url(#c)"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["marker-start attribute", svg(`<path d="M0 0" marker-start="url(#m)"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["duplicate attribute", svg(`<rect width="1" width="2" height="1"/>`), "SVG_ATTRIBUTE_DUPLICATE"],
    ["unquoted attribute", svg(`<rect width=1 height="1"/>`), "SVG_MALFORMED"],
    // url( and data:
    ["fill url to another file", svg(`<rect width="1" height="1" fill="url(other.svg#g)"/>`), "SVG_ATTRIBUTE_VALUE"],
    ["fill url to http", svg(`<rect width="1" height="1" fill="url(http://x/a.svg#g)"/>`), "SVG_URL"],
    ["fill url quoted", svg(`<rect width="1" height="1" fill="url('#g')"/>`), "SVG_URL"],
    ["fill url with a fallback colour", svg(`<defs><linearGradient id="g"/></defs><rect width="1" height="1" fill="url(#g) red"/>`), "SVG_URL"],
    ["URL( upper case", svg(`<rect width="1" height="1" fill="URL(#g)"/>`), "SVG_URL"],
    ["url to an id that is not a gradient", svg(`<g id="g"/><rect width="1" height="1" fill="url(#g)"/>`), "SVG_REF_NOT_A_GRADIENT"],
    ["url to an id that does not exist", svg(`<rect width="1" height="1" fill="url(#none)"/>`), "SVG_REF_NOT_A_GRADIENT"],
    ["url in stop-color", svg(`<defs><linearGradient id="g"><stop offset="0" stop-color="url(#g)"/></linearGradient></defs>`), "SVG_URL"],
    ["data: in a value", svg(`<rect width="1" height="1" fill="data:image/svg+xml,x"/>`), "SVG_ATTRIBUTE_VALUE"],
    ["javascript: in an id", svg(`<g id="javascript:x"/>`), "SVG_ATTRIBUTE_VALUE"],
    ["duplicate id", svg(`<defs><linearGradient id="g"/><radialGradient id="g"/></defs>`), "SVG_ID_DUPLICATE"],
    ["path data with a letter outside the grammar", svg(`<path d="M0 0 X 1"/>`), "SVG_ATTRIBUTE_VALUE"],
    ["transform with a url", svg(`<g transform="url(#x)"/>`), "SVG_ATTRIBUTE_VALUE"],
    // encoding
    ["UTF-8 BOM", `﻿${svg(ref)}`, "SVG_NOT_ASCII"],
    ["UTF-16 LE BOM", `\xff\xfe${svg(ref)}`, "SVG_NOT_ASCII"],
    ["non-ASCII (fullwidth less-than)", svg(`<g id="a＜b"/>`), "SVG_NOT_ASCII"],
    ["NUL byte", svg(`<g\0 id="a"/>`), "SVG_NOT_ASCII"],
    ["vertical tab", svg(`<g\v id="a"/>`), "SVG_NOT_ASCII"],
    // structure and size
    ["no root", `<g/>`, "SVG_ELEMENT_PLACE"],
    ["unclosed element", `<svg ${NS} width="1" height="1" viewBox="0 0 1 1"><g>`, "SVG_MALFORMED"],
    ["mismatched close", svg(`<g></rect>`), "SVG_MALFORMED"],
    ["unclosed tag", `<svg ${NS} width="1" height="1" viewBox="0 0 1 1"`, "SVG_MALFORMED"],
    ["no viewBox", svg(ref, `width="1" height="1"`), "SVG_NO_VIEWBOX"],
    ["no width", svg(ref, `height="1" viewBox="0 0 1 1"`), "SVG_SIZE"],
    ["percent width", svg(ref, `width="100%" height="1" viewBox="0 0 1 1"`), "SVG_SIZE"],
    ["side over the cap", svg(ref, `width="5000" height="1" viewBox="0 0 1 1"`), "SVG_SIZE"],
    ["too deep", svg(`${"<g>".repeat(DECORATION_SVG_LIMITS.depth + 1)}${"</g>".repeat(DECORATION_SVG_LIMITS.depth + 1)}`), "SVG_TOO_DEEP"],
    ["too many elements", svg(`<g>${ref.repeat(DECORATION_SVG_LIMITS.elements + 1)}</g>`), "SVG_TOO_MANY_ELEMENTS"],
    ["too many attributes", svg(`<g ${Array.from({ length: 30 }, (_, k) => `a${k}="1"`).join(" ")}/>`), "SVG_TOO_MANY_ATTRIBUTES"],
    ["oversize file", svg(`<path d="M0 0${" L1 1".repeat(60000)}"/>`), "SVG_TOO_LARGE"],
  ])("%s", (_, s, code) => {
    const c = check(s);
    expect(c.ok).toBe(false);
    expect(c.findings.map((f) => f.code)).toContain(code);
  });

  it("an empty file", () => expect(checkDecorationSvg(new Uint8Array()).findings.map((f) => f.code)).toEqual(["SVG_EMPTY"]));
  it("a UTF-16 encoded file (as bytes)", () => expect(checkDecorationSvg(Buffer.from(`﻿${SEAM}`, "utf16le")).ok).toBe(false));
  it("a passing file stops passing with any single refused element spliced in", () => {
    for (const bad of ["script", "style", "text", "image", "use", "foreignObject", "a", "filter", "animate", "set", "title"]) expect(codes(SEAM.replace("</svg>", `<${bad}/></svg>`))).toContain("SVG_ELEMENT_NOT_ALLOWED");
  });
});

describe("the asset file: name, symlink, traversal, hash, size, dimensions", () => {
  let dir: string;
  let outside: string;
  const asset = (file: string, body: string, over: Partial<DecorationAsset> = {}): DecorationAsset => ({
    id: "seam",
    file,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body),
    width: 100,
    height: 100,
    kind: "decoration_svg",
    role: "decoration",
    ...over,
  });
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "dev162-"));
    dir = join(base, "page");
    outside = join(base, "outside");
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(dir, "assets/seam.svg"), SEAM);
    writeFileSync(join(outside, "x.svg"), SEAM);
    symlinkSync(join(outside, "x.svg"), join(dir, "assets/link.svg"));
    symlinkSync(outside, join(dir, "assets/dir"));
    writeFileSync(join(dir, "assets/bad.svg"), svg(`<script/>`));
  });
  afterAll(() => rmSync(resolve(dir, ".."), { recursive: true, force: true }));

  it("a recorded file passes", () => expect(checkDecorationAssetFile(dir, asset("assets/seam.svg", SEAM))).toEqual([]));
  it("a symlink to a file outside", () => expect(checkDecorationAssetFile(dir, asset("assets/link.svg", SEAM))).toContain("ASSET_SYMLINK"));
  it("a nested path (even through a symlinked directory) is not a recorded name", () => expect(checkDecorationAssetFile(dir, asset("assets/dir/x.svg", SEAM))).toContain("ASSET_FILE_NAME"));
  it("an assets directory that is itself a symlink to outside", () => {
    const page2 = join(resolve(dir, ".."), "page2");
    mkdirSync(page2);
    symlinkSync(outside, join(page2, "assets"));
    expect(checkDecorationAssetFile(page2, asset("assets/x.svg", SEAM))).toContain("ASSET_SYMLINK");
  });
  it.each(["../outside/x.svg", "assets/../../outside/x.svg", "/etc/passwd", "assets/seam.SVG", "assets/a b.svg", "assets/%2e%2e.svg", "assets\\seam.svg", "seam.svg"])("a bad name %s", (file) =>
    expect(checkDecorationAssetFile(dir, asset(file, SEAM))).toContain("ASSET_FILE_NAME"),
  );
  it("a wrong hash", () => expect(checkDecorationAssetFile(dir, asset("assets/seam.svg", SEAM, { sha256: "0".repeat(64) }))).toContain("ASSET_SHA256"));
  it("a wrong size", () => expect(checkDecorationAssetFile(dir, asset("assets/seam.svg", SEAM, { bytes: 1 }))).toContain("ASSET_BYTES"));
  it("wrong dimensions", () => expect(checkDecorationAssetFile(dir, asset("assets/seam.svg", SEAM, { width: 200 }))).toContain("ASSET_DIMENSIONS"));
  it("a recorded file that fails the checker", () => expect(checkDecorationAssetFile(dir, asset("assets/bad.svg", svg(`<script/>`)))).toContain("SVG_ELEMENT_NOT_ALLOWED"));
  it("a missing file", () => expect(checkDecorationAssetFile(dir, asset("assets/none.svg", SEAM))).toContain("ASSET_MISSING"));
  it("another kind or role", () => expect(checkDecorationAssetFile(dir, asset("assets/seam.svg", SEAM, { role: "content" as "decoration" }))).toContain("ASSET_KIND"));
});

describe("the page side: only <img> of a recorded asset", () => {
  const A: DecorationAsset[] = [{ id: "seam", file: "assets/seam.svg", sha256: "0".repeat(64), bytes: 1, width: 100, height: 100, kind: "decoration_svg", role: "decoration" }];
  const ok = `<div data-comp-role="decoration"><img src="assets/seam.svg" alt="" aria-hidden="true"></div>`;
  it("a decorative img passes", () => expect(decorationReferenceProblems(ok, "", A)).toEqual([]));
  it.each([
    ["inline svg", `${ok}<svg></svg>`, "", "INLINE_SVG"],
    ["object", `${ok}<object data="assets/seam.svg"></object>`, "", "SVG_EMBEDDED_NOT_IMG"],
    ["embed", `${ok}<embed src="assets/seam.svg">`, "", "SVG_EMBEDDED_NOT_IMG"],
    ["iframe", `${ok}<iframe src="assets/seam.svg"></iframe>`, "", "SVG_EMBEDDED_NOT_IMG"],
    ["CSS reference", ok, `.x{background:url(assets/seam.svg)}`, "SVG_FROM_CSS"],
    ["unrecorded svg", `${ok}<img src="assets/other.svg" alt="" aria-hidden="true">`, "", "SVG_NOT_RECORDED"],
    ["external svg", `${ok}<img src="https://x/a.svg" alt="" aria-hidden="true">`, "", "SVG_NOT_RECORDED"],
    ["srcset", `${ok}<img src="assets/seam.svg" srcset="assets/b.svg 2x" alt="" aria-hidden="true">`, "", "SVG_NOT_RECORDED"],
    ["img with alt text", `<img src="assets/seam.svg" alt="seam" aria-hidden="true">`, "", "SVG_IMG_NOT_DECORATIVE"],
    ["img without aria-hidden", `<img src="assets/seam.svg" alt="">`, "", "SVG_IMG_NOT_DECORATIVE"],
    ["recorded but unused", `<p>x</p>`, "", "SVG_RECORDED_NOT_USED"],
  ])("%s", (_, html, css, code) => expect(decorationReferenceProblems(html, css, A)).toContain(code));
});

describe("browser probe: <img>-loaded SVG in Chromium, JS off, network blocked", () => {
  let browser: Browser;
  let dir: string;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    dir = mkdtempSync(join(tmpdir(), "dev162-render-"));
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function render(name: string, body: string, w: number, h: number) {
    writeFileSync(join(dir, `${name}.svg`), body);
    writeFileSync(join(dir, `${name}.html`), `<!doctype html><html><body style="margin:0;background:#fff"><img src="${name}.svg" alt="" aria-hidden="true" style="position:absolute;left:40px;top:40px;width:${w}px;height:${h}px;display:block"></body></html>`);
    const ctx = await browser.newContext({ viewport: { width: w + 80, height: h + 80 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
    const requests: string[] = [];
    const refused: string[] = [];
    try {
      const page = await ctx.newPage();
      await page.route("**/*", (route) => {
        const url = route.request().url();
        requests.push(url);
        if (!url.startsWith(`file://${dir}/`)) {
          refused.push(url);
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(`file://${dir}/${name}.html`, { waitUntil: "load" });
      await page.waitForTimeout(300);
      const png = await page.screenshot({ fullPage: false });
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      let inkOutside = 0;
      let inkInside = 0;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          const o = (y * info.width + x) * info.channels;
          const ink = data[o]! < 250 || data[o + 1]! < 250 || data[o + 2]! < 250;
          if (!ink) continue;
          if (x >= 40 && x < 40 + w && y >= 40 && y < 40 + h) inkInside++;
          else inkOutside++;
        }
      return { requests, refused, inkOutside, inkInside };
    } finally {
      await ctx.close();
    }
  }

  it.each([
    ["seam", SEAM, 100, 300],
    ["wheel", WHEEL, 360, 350],
    // the polygons reach x=-60 and x=780 in a 660-wide viewBox: what lies outside is clipped by the img box
    ["mountain", MOUNTAIN, 330, 300],
  ])("%s: draws inside its box only, loads only itself", async (name, body, w, h) => {
    const r = await render(name, body, w, h);
    expect(r.inkInside).toBeGreaterThan(0);
    expect(r.inkOutside).toBe(0);
    expect(r.refused).toEqual([]);
    expect(r.requests.map((u) => u.slice(`file://${dir}/`.length)).sort()).toEqual([`${name}.html`, `${name}.svg`]);
  }, 30_000);

  it("a hostile SVG (the checker refuses it) still reaches nothing and runs nothing through <img>", async () => {
    const hostile = `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100" viewBox="0 0 100 100" onload="document.title='x'">
<style>@import url(http://example.invalid/a.css); rect { fill: url(http://example.invalid/p.svg#p); }</style>
<image href="http://example.invalid/i.png" width="10" height="10"/><image xlink:href="https://example.invalid/j.png" width="10" height="10"/>
<use href="http://example.invalid/u.svg#u"/><script>fetch("http://example.invalid/s")</script>
<foreignObject width="100" height="100"><img xmlns="http://www.w3.org/1999/xhtml" src="http://example.invalid/f.png"/></foreignObject>
<rect width="100" height="100"/></svg>`;
    expect(check(hostile).ok).toBe(false);
    const r = await render("hostile", hostile, 100, 100);
    // the browser's image mode loads nothing for the SVG: nothing reaches the route, so nothing needed refusing
    expect(r.refused).toEqual([]);
    expect(r.requests.map((u) => u.slice(`file://${dir}/`.length)).sort()).toEqual(["hostile.html", "hostile.svg"]);
    expect(r.inkOutside).toBe(0);
  }, 30_000);
});

describe("isolation: research only, imported by nothing in a lane", () => {
  const specifiers = (source: string) => [...source.matchAll(/(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
  it("the checker imports only node:crypto, node:fs and node:path", () => {
    expect(specifiers(readFileSync(resolve(REPO, MODULE), "utf8")).sort()).toEqual(["node:crypto", "node:fs", "node:path"]);
  });
  it("no network, process or model code in the checker", () => {
    expect(readFileSync(resolve(REPO, MODULE), "utf8")).not.toMatch(/\brequire\s*[([]|import\s*\(|node:(https?|net|tls|child_process|worker_threads|vm)|\/worker\/|anthropic|openai|\bspawn\(|execFile|process\.binding|\bfetch\(|codex|\beval\(|new Function/i);
  });
  it("nothing outside tests imports it (lib, app, components, scripts)", () => {
    const r = spawnSync("git", ["grep", "-l", "-E", "research/decoration-svg", "--", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([]);
  });
  it("the research directory holds only the checker", () => {
    const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "lib/design-agent/research"], { cwd: REPO, encoding: "utf8" });
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([MODULE]);
  });
});
