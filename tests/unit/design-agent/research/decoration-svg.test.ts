import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECORATION_PAGE_ORIGIN, launchDecorationBrowser, verifyDecorationPageInBrowser } from "../../../../lib/design-agent/research/decoration-page-browser";
import {
  checkDecorationAssetFile,
  checkDecorationPage,
  checkDecorationSvg,
  DECORATION_PAGE_ELEMENTS,
  DECORATION_PAGE_GLOBAL_ATTRIBUTES,
  DECORATION_SVG_ELEMENTS,
  DECORATION_SVG_LIMITS,
  decorationReferenceProblems,
  type DecorationAsset,
  type DecorationAssetRef,
} from "../../../../lib/design-agent/research/decoration-svg";
import { MOUNTAIN, SEAM, WHEEL } from "../../../../lib/design-agent/research/decoration-fixtures";

// DEV-162 (Issue #193 comment 6601921731, decision 2): N1 research only. The checker is not wired into any lane.

const REPO = resolve(__dirname, "../../../..");
const MODULE = "lib/design-agent/research/decoration-svg.ts";
const BROWSER_MODULE = "lib/design-agent/research/decoration-page-browser.ts";
const FIXTURES_MODULE = "lib/design-agent/research/decoration-fixtures.ts";
/** DEV-165: the phase C layer harness imports comp-impl, so it is test support, not a lib/ module (comp-impl isolation). */
const LAYERS_MODULE = "tests/support/decoration-layers.ts";
const PROBE_SCRIPT = "scripts/design-artifact/n1-browser-probe.ts";
const NS = `xmlns="http://www.w3.org/2000/svg"`;
const svg = (inner: string, attrs = `width="100" height="100" viewBox="0 0 100 100"`) => `<svg ${NS} ${attrs}>${inner}</svg>`;
const check = (s: string) => checkDecorationSvg(Buffer.from(s, "latin1"));
const codes = (s: string) => check(s).findings.map((f) => f.code);

// Shapes of the three fidelity pages' inline SVGs (tsugute d1-v3, bicycle d1-v2, sento d1-v2), as standalone files:
// SEAM, WHEEL, MOUNTAIN from decoration-fixtures.ts (DEV-165 moved them there for the cross-browser probe).

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
    ["whitespace after </ (close-tag name not trimmed)", svg(`<g></ g>`), "SVG_MALFORMED"],
    ["zero viewBox width", svg(ref, `width="1" height="1" viewBox="0 0 0 1"`), "SVG_VIEWBOX"],
    ["zero viewBox height", svg(ref, `width="1" height="1" viewBox="0 0 1 0"`), "SVG_VIEWBOX"],
    ["negative viewBox width", svg(ref, `width="1" height="1" viewBox="0 0 -1 1"`), "SVG_VIEWBOX"],
    ["negative viewBox height", svg(ref, `width="1" height="1" viewBox="0,0,1,-5"`), "SVG_VIEWBOX"],
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

  it("`</g >` (whitespace before >) is still a close tag", () => expect(check(svg(`<g></g >`)).findings).toEqual([]));

  it.each([
    ["element constructor", svg(`<constructor/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["element toString in a group", svg(`<g><toString/></g>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["element __proto__", svg(`<__proto__/>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["element hasOwnProperty", svg(`<hasOwnProperty></hasOwnProperty>`), "SVG_ELEMENT_NOT_ALLOWED"],
    ["attribute __proto__", svg(`<path d="M0 0" __proto__="x"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["attribute constructor", svg(`<path d="M0 0" constructor="x"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["attribute toString", svg(`<rect width="1" height="1" toString="x"/>`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["attribute valueOf on the root", svg(`<g/>`, `width="1" height="1" viewBox="0 0 1 1" valueOf="1"`), "SVG_ATTRIBUTE_NOT_ALLOWED"],
    ["__proto__ twice", svg(`<path d="M0 0" __proto__="x" __proto__="y"/>`), "SVG_ATTRIBUTE_DUPLICATE"],
  ])("a prototype name is refused, not thrown on: %s", (_, s, code) => {
    let c: ReturnType<typeof check> | undefined;
    expect(() => (c = check(s))).not.toThrow();
    expect(c!.ok).toBe(false);
    expect(c!.findings.map((x) => x.code)).toContain(code);
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
  /** TEST FIXTURE - not an owner review (DEV-165): the file checks below need an approved review bound to the bytes. */
  const asset = (file: string, body: string, over: Partial<DecorationAsset> = {}): DecorationAsset => ({
    id: "seam",
    file,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body),
    width: 100,
    height: 100,
    kind: "decoration_svg",
    role: "decoration",
    owner_visual_review: { reviewed_by: "owner", reviewed_at: "2026-11-01", asset_sha256: createHash("sha256").update(body).digest("hex"), decision: "approved", note: "TEST FIXTURE - not an owner review" },
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
  it.each(["", "Seam", "seam_1", "-seam", "a".repeat(65), "__proto__", "seam/1", "seam.svg"])("a bad id %j", (id) =>
    expect(checkDecorationAssetFile(dir, asset("assets/seam.svg", SEAM, { id }))).toContain("ASSET_ID"),
  );
  it("a hardlink (a second name for the same file) is refused", () => {
    writeFileSync(join(dir, "assets/twin.svg"), SEAM);
    linkSync(join(dir, "assets/twin.svg"), join(outside, "twin.svg"));
    expect(checkDecorationAssetFile(dir, asset("assets/twin.svg", SEAM))).toContain("ASSET_HARDLINK");
  });
  it.each([
    ["no fields", {}],
    ["a numeric file", { file: 7 }],
    ["an object file", { file: { toString: () => "assets/seam.svg" } }],
    ["null id", { id: null, file: "assets/seam.svg" }],
    ["a prototype-named id", { id: "constructor", file: "assets/seam.svg" }],
  ])("hostile record fields are refused, never thrown on: %s", (_, rec) => {
    let r: string[] = [];
    expect(() => (r = checkDecorationAssetFile(dir, rec as unknown as DecorationAsset))).not.toThrow();
    expect(r.length).toBeGreaterThan(0);
  });
  it("a hostile page directory is refused, never thrown on", () => {
    let r: string[] = [];
    expect(() => (r = checkDecorationAssetFile("\0bad", asset("assets/seam.svg", SEAM)))).not.toThrow();
    expect(r.length).toBeGreaterThan(0);
  });
  it.each([
    ["prototype element", svg(`<constructor/>`)],
    ["prototype attribute", svg(`<path d="M0 0" __proto__="x"/>`)],
  ])("a recorded file with hostile content returns codes: %s", (_, body) => {
    writeFileSync(join(dir, "assets/hostile.svg"), body);
    let r: string[] = [];
    expect(() => (r = checkDecorationAssetFile(dir, { ...asset("assets/hostile.svg", body), id: "hostile" }))).not.toThrow();
    expect(r.some((x) => x.startsWith("SVG_"))).toBe(true);
  });
});

describe("the page side: an element and attribute allowlist, img only for a recorded asset", () => {
  const rec = (id: string, file: string): DecorationAssetRef => ({ id, file });
  const A: DecorationAssetRef[] = [rec("seam", "assets/seam.svg")];
  const IMG = `<img src="assets/seam.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer">`;
  const ok = `<div data-comp-role="decoration">${IMG}</div>`;
  const problems = (html: string, css = "", assets = A) => decorationReferenceProblems(html, css, assets);

  it("the allowlist is the one in the design doc (and nothing else)", () => {
    expect(Object.keys(DECORATION_PAGE_ELEMENTS).sort()).toEqual(
      ["a", "address", "article", "aside", "b", "blockquote", "body", "br", "dd", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "i", "img", "li", "main", "meta", "nav", "ol", "p", "section", "small", "span", "strong", "time", "title", "ul"].sort(),
    );
    expect([...DECORATION_PAGE_ELEMENTS.img!].sort()).toEqual(["alt", "decoding", "height", "loading", "referrerpolicy", "src", "width"]);
    expect(DECORATION_PAGE_ELEMENTS.a).toEqual(["href"]);
    expect(DECORATION_PAGE_ELEMENTS.meta).toEqual(["charset"]);
    expect([...DECORATION_PAGE_GLOBAL_ATTRIBUTES].sort()).toEqual(
      ["aria-hidden", "aria-label", "class", "data-comp-container", "data-comp-cta", "data-comp-disclosure", "data-comp-nav", "data-comp-placeholder", "data-comp-role", "data-comp-section", "data-comp-slot", "data-comp-type", "id", "lang"].sort(),
    );
  });

  it.each([
    ["a decorative img", ok],
    ["a whole document", `<!DOCTYPE html>\n<html lang="ja"><head><meta charset="UTF-8"><title>店 &amp; 器</title></head><body><header id="top"><h1 class="t big">x</h1></header><main>${ok}<p>本文<br><strong>a</strong></p><a href="#top" aria-label="上へ">top</a></main></body></html>`],
    ["upper-case tag and attribute names, single quotes, unquoted", `<IMG SRC='assets/seam.svg' ALT="" Aria-Hidden=true REFERRERPOLICY=no-referrer>`],
    ["`/` as the attribute separator", `<img/src="assets/seam.svg"/alt=""/aria-hidden="true"/referrerpolicy="no-referrer"/>`],
    ["`<svg` text that is only an escaped entity in text", `${ok}<p>&lt;svg is not a tag</p>`],
    ["a `<` that starts no tag", `${ok}<p>1 < 2</p>`],
  ])("passes: %s", (_, html) => expect(problems(html)).toEqual([]));

  it("a quoted `>` inside a refused value does not end the tag (one tag, read whole)", () =>
    expect(problems(`<img class=">" src="assets/seam.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer">`)).toEqual(["PAGE_ATTRIBUTE_VALUE", "SVG_RECORDED_NOT_USED"]));

  /** Fresh Review round 2: every one of these made the round-1 checker return [] while Chromium loaded another file. */
  const ROUND2: [string, string, string][] = [
    ...["title", "style", "textarea", "xmp", "noembed"].map((e): [string, string, string] => [`H-1 math + ${e}`, `${ok}<math><${e}><img src="//evil.example/x"></${e}></math>`, "PAGE_ELEMENT_NOT_ALLOWED"]),
    ["H-2 noscript + title", `${ok}<noscript><title></noscript><img src="//evil.example/x"></title>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ["H-2 noscript + comment", `${ok}<noscript><!--</noscript><img src="//evil.example/x">--></noscript>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ["H-3 img srcset with a protocol-relative second candidate", `<img src="assets/seam.svg" srcset="a.png 0.1x, //evil.example/x 1x" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["H-3 picture/source srcset", `${ok}<picture><source srcset="a.png 0.1x, //evil.example/x 1x">${IMG}</picture>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ["H-3 backslash protocol-relative src", `${ok}<img src="\\\\evil.example/x" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "SVG_NOT_RECORDED"],
    ["H-4 base, absolute", `<base href="//evil.example/">${ok}`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ["H-4 base, relative", `<base href="/x/">${ok}`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ["M-1 link stylesheet", `<link rel="stylesheet" href="other.css">${ok}`, "PAGE_ELEMENT_NOT_ALLOWED"],
  ];
  it.each(ROUND2)("round 2, refused statically: %s", (_, html, code) => {
    const p = problems(html);
    expect(p).toContain(code);
    expect(p.length).toBeGreaterThan(0);
  });

  it.each([
    // inline svg and foreign content in any form
    ["inline svg", `${ok}<svg></svg>`, "INLINE_SVG"],
    ["inline svg is off the list", `${ok}<svg></svg>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ["<svg/>", `${ok}<svg/>`, "INLINE_SVG"],
    ['<svg/class="x">', `${ok}<svg/class="x"></svg>`, "INLINE_SVG"],
    ["<SVG> upper case", `${ok}<SVG></SVG>`, "INLINE_SVG"],
    ["<math>", `${ok}<math></math>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    // comments and declarations: none is allowed, so no agreement on where one ends is needed
    ["a comment", `<!-- note -->${ok}`, "PAGE_COMMENT"],
    ["<svg inside a comment", `${ok}<!-- <svg> -->`, "PAGE_COMMENT"],
    ["an abrupt comment", `<!-->${ok}`, "PAGE_COMMENT"],
    ["a bogus comment", `<!x>${ok}`, "PAGE_DECLARATION"],
    ["a processing instruction", `<?x y?>${ok}`, "PAGE_DECLARATION"],
    ["a bogus end tag", `</ x>${ok}`, "PAGE_DECLARATION"],
    ["a doctype not at the start", `${ok}<!doctype html>`, "PAGE_DECLARATION"],
    ["CDATA", `${ok}<![CDATA[x]]>`, "PAGE_DECLARATION"],
    // elements off the list, refused by name
    ...["object", "embed", "iframe", "frame", "frameset", "script", "style", "noscript", "template", "textarea", "xmp", "noembed", "noframes", "plaintext", "base", "link", "picture", "source", "video", "audio", "track", "canvas", "image", "input", "form", "button", "select", "option", "table", "td", "map", "area", "portal", "fencedframe", "applet", "marquee", "dialog", "slot", "x-shop", "meta2"].map(
      (e): [string, string, string] => [`<${e}>`, `${ok}<${e}></${e}>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ),
    ["an end tag off the list alone", `${ok}</noscript>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    ["an end tag with attributes", `${ok}<p>x</p class="y">`, "PAGE_MALFORMED"],
    ["a prototype-named element", `${ok}<constructor></constructor>`, "PAGE_ELEMENT_NOT_ALLOWED"],
    // title: the one raw-text element, head only
    ["title in body", `<html><head></head><body><title>x</title>${ok}</body></html>`, "PAGE_ELEMENT_PLACE"],
    ["title with no head", `<title>x</title>${ok}`, "PAGE_ELEMENT_PLACE"],
    ["title after head content closed head", `<head><p>x</p><title>t</title></head>${ok}`, "PAGE_ELEMENT_PLACE"],
    ["title after head text", `<head>text<title>t</title></head>${ok}`, "PAGE_ELEMENT_PLACE"],
    ["title holding markup", `<head><title><img src="x"></title></head>${ok}`, "PAGE_TITLE_CONTENT"],
    ["title never closed", `<head><title>x`, "PAGE_MALFORMED"],
    ["a second head", `<head></head><head></head>${ok}`, "PAGE_ELEMENT_PLACE"],
    ["a head after body content (a browser ignores it)", `<p>x</p><head><title>t</title></head>${ok}`, "PAGE_ELEMENT_PLACE"],
    ["a head after body text", `x<head><title>t</title></head>${ok}`, "PAGE_ELEMENT_PLACE"],
    // attributes off the list or out of grammar
    ["style attribute", `${ok}<div style="color:red"></div>`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["event handler", `${ok}<div onclick="x()"></div>`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["body background", `<body background="evil.png">${ok}</body>`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["html manifest", `<html manifest="x.appcache">${ok}</html>`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["meta http-equiv refresh", `<meta http-equiv="refresh" content="0;url=//evil.example/">${ok}`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["meta with another charset", `<meta charset="iso-2022-jp">${ok}`, "PAGE_ATTRIBUTE_VALUE"],
    ["meta with a global attribute", `<meta charset="utf-8" class="x">${ok}`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["a ping", `${ok}<a href="#x" ping="//evil.example/">x</a>`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["a href to another page", `${ok}<a href="menu.html#top">menu</a>`, "PAGE_ATTRIBUTE_VALUE"],
    ["a href to the recorded asset", `${ok}<a href="assets/seam.svg">x</a>`, "PAGE_ATTRIBUTE_VALUE"],
    ["a href absolute", `${ok}<a href="https://evil.example/">x</a>`, "PAGE_ATTRIBUTE_VALUE"],
    ["a href javascript:", `${ok}<a href="javascript:void 0">x</a>`, "PAGE_ATTRIBUTE_VALUE"],
    ["a href data:", `${ok}<a href="data:text/html,x">x</a>`, "PAGE_ATTRIBUTE_VALUE"],
    ["img sizes", `<img src="assets/seam.svg" sizes="10px" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["img crossorigin", `<img src="assets/seam.svg" crossorigin alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["img usemap", `<img src="assets/seam.svg" usemap="#m" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["img lowsrc", `<img src="assets/seam.svg" lowsrc="//evil.example/x" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["a prototype-named attribute", `${ok}<p __proto__="x" constructor="y">x</p>`, "PAGE_ATTRIBUTE_NOT_ALLOWED"],
    ["any `&` in a value", `${ok}<p class="a&amp;b">x</p>`, "PAGE_ENTITY"],
    ["entity-hidden extension", `${ok}<img src="evil&#46;svg">`, "PAGE_ENTITY"],
    ["unknown named entity", `${ok}<img src="evil&foo;x">`, "PAGE_ENTITY"],
    ["a NUL", `${ok}<p>\0</p>`, "PAGE_CONTROL_CHAR"],
    ["a C1 control", `${ok}<p>\u0085</p>`, "PAGE_CONTROL_CHAR"],
    // img src: a recorded file, exactly
    ["unrecorded svg", `${ok}<img src="assets/other.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "SVG_NOT_RECORDED"],
    ["a raster image (only recorded assets load)", `${ok}<img src="assets/photo.webp" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "SVG_NOT_RECORDED"],
    ["external svg", `${ok}<img src="https://x/a.svg" alt="" aria-hidden="true">`, "SVG_NOT_RECORDED"],
    ["single-quoted external src", `${ok}<img src='https://evil.example/a.svg'>`, "SVG_NOT_RECORDED"],
    ["unquoted src", `${ok}<img src=evil.svg>`, "SVG_NOT_RECORDED"],
    ["protocol-relative src", `${ok}<img src="//evil.example/a">`, "SVG_NOT_RECORDED"],
    ["data: svg in img src", `${ok}<img src="data:image/svg+xml;base64,PHN2Zz4=">`, "SVG_NOT_RECORDED"],
    ["extensionless recorded path in img src", `${ok}<img src="assets/seam" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "SVG_NOT_RECORDED"],
    ["recorded path through a dot segment", `${ok}<img src="./assets/x/../seam.svg">`, "SVG_NOT_RECORDED"],
    ["recorded path with a leading space", `${ok}<img src=" assets/seam.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "SVG_NOT_RECORDED"],
    ["percent-hidden extension", `${ok}<img src="evil%2esvg">`, "SVG_NOT_RECORDED"],
    ["img without src", `${ok}<img alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "SVG_NOT_RECORDED"],
    // CSS
    ["CSS reference", ok, "SVG_FROM_CSS", `.x{background:url(assets/seam.svg)}`],
    ["CSS url() of anything", ok, "CSS_URL", `.x{background:url(a.webp)}`],
    ["CSS escape hiding the extension", ok, "SVG_FROM_CSS", String.raw`.x{background:url(evil.sv\67)}`],
    ["CSS escape hiding url(", ok, "CSS_URL", String.raw`.x{background:\75rl(a.webp)}`],
    ["CSS comment splitting url(", ok, "CSS_URL", `.x{background:ur/**/l(a.webp)}`],
    ["CSS image-set", ok, "CSS_URL", `.x{background:image-set("a.webp" 1x)}`],
    ["CSS @import", ok, "CSS_URL", `@import "a.css";`],
    // decorative markers read from parsed attributes
    ["img with alt text", `<img src="assets/seam.svg" alt="seam" aria-hidden="true" referrerpolicy="no-referrer">`, "SVG_IMG_NOT_DECORATIVE"],
    ["img without aria-hidden", `<img src="assets/seam.svg" alt="" referrerpolicy="no-referrer">`, "SVG_IMG_NOT_DECORATIVE"],
    ["markers only inside another attribute's value", `<img class=' aria-hidden="true" alt=""' src="assets/seam.svg" referrerpolicy="no-referrer">`, "SVG_IMG_NOT_DECORATIVE"],
    ["img without referrerpolicy", `<img src="assets/seam.svg" alt="" aria-hidden="true">`, "SVG_IMG_REFERRER"],
    ["img with another referrerpolicy", `<img src="assets/seam.svg" alt="" aria-hidden="true" referrerpolicy="origin">`, "SVG_IMG_REFERRER"],
    ["duplicate attribute (the first wins in a browser)", `<img src="assets/seam.svg" alt="" alt="x" aria-hidden="true" referrerpolicy="no-referrer">`, "PAGE_ATTRIBUTE_DUPLICATE"],
    // structure and the record
    ["recorded but unused", `<p>x</p>`, "SVG_RECORDED_NOT_USED"],
    ["a tag the input ends inside", `${ok}<img src="x`, "PAGE_MALFORMED"],
    ["a comment the input ends inside", `${ok}<!-- x`, "PAGE_MALFORMED"],
  ])("%s", (_, html, code, css = "") => expect(problems(html, css)).toContain(code));

  it("L-2: a recorded file counts as used only through a clean decorative img", () => {
    expect(checkDecorationPage(ok, "", A).used).toEqual(["assets/seam.svg"]);
    const withSrcset = checkDecorationPage(`<img src="assets/seam.svg" srcset="other.png 1x" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, "", A);
    expect(withSrcset.used).toEqual([]);
    expect(withSrcset.problems).toEqual(["PAGE_ATTRIBUTE_NOT_ALLOWED", "SVG_RECORDED_NOT_USED"]);
    const inPicture = checkDecorationPage(`<picture><source srcset="other.png">${IMG}</picture>`, "", A);
    expect(inPicture.problems).toContain("PAGE_ELEMENT_NOT_ALLOWED");
    const twoAssets = [...A, rec("wheel", "assets/wheel.svg")];
    expect(checkDecorationPage(`${ok}<img src="assets/wheel.svg" alt="" aria-hidden="true">`, "", twoAssets).problems).toEqual(["SVG_IMG_REFERRER", "SVG_RECORDED_NOT_USED"]);
  });

  it.each([
    ["a bad id", [rec("Seam", "assets/seam.svg")], "ASSET_ID"],
    ["a prototype-named id", [rec("__proto__", "assets/seam.svg")], "ASSET_ID"],
    ["the same id twice", [rec("seam", "assets/seam.svg"), rec("seam", "assets/seam-2.svg")], "ASSET_ID_DUPLICATE"],
    ["the same file twice", [rec("seam", "assets/seam.svg"), rec("seam-b", "assets/seam.svg")], "ASSET_FILE_DUPLICATE"],
    ["a bad file name", [rec("seam", "assets/../seam.svg")], "SVG_FILE_NAME"],
  ])("the record: %s", (_, assets, code) => expect(problems(ok, "", assets)).toContain(code));

  it("a hostile record or input never throws", () => {
    expect(() => problems(ok, "", [{} as DecorationAssetRef, { id: 1, file: null } as unknown as DecorationAssetRef])).not.toThrow();
    expect(() => problems(null as unknown as string, undefined as unknown as string)).not.toThrow();
  });

  describe("browser verification: Chromium, JS on and off, every request logged", () => {
    let browser: Browser;
    let dir: string;
    beforeAll(async () => {
      browser = await launchDecorationBrowser();
      dir = mkdtempSync(join(tmpdir(), "dev162-page-"));
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "assets/seam.svg"), SEAM);
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
      rmSync(dir, { recursive: true, force: true });
    }, 60_000);
    const verify = (html: string, css = "") => verifyDecorationPageInBrowser(browser, dir, html, css, A);
    const page = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
    const evil = (u: string) => u.startsWith("http://evil.example/");

    it("a clean page passes both lines, and loads only itself and its recorded asset", async () => {
      const html = page(`<main>${ok}<p>x</p></main>`);
      expect(problems(html)).toEqual([]);
      const r = await verify(html);
      expect(r.problems).toEqual([]);
      for (const run of r.runs) {
        expect(run.unexpected).toEqual([]);
        expect(run.decorative).toEqual([`${DECORATION_PAGE_ORIGIN}/page/assets/seam.svg`]);
        expect([...new Set(run.requests)].sort()).toEqual([`${DECORATION_PAGE_ORIGIN}/page/assets/seam.svg`, `${DECORATION_PAGE_ORIGIN}/page/index.html`]);
      }
    }, 60_000);

    it("page CSS that loads something is caught by the browser too", async () => {
      const r = await verify(page(ok), `body{background:url(other.png)}`);
      expect(r.problems).toContain("PAGE_UNEXPECTED_REQUEST");
    }, 60_000);

    // the round-2 inputs really make Chromium request another file: the static refusal is not about a harmless string
    it.each([
      ["H-1 math + title", `${ok}<math><title><img src="//evil.example/x"></title></math>`, [true, false]],
      ["H-2 noscript + title (JS on)", `${ok}<noscript><title></noscript><img src="//evil.example/x"></title>`, [true]],
      ["H-3 img srcset", `<img src="assets/seam.svg" srcset="assets/seam.svg 0.1x, //evil.example/x 1x" alt="" aria-hidden="true" referrerpolicy="no-referrer">`, [true, false]],
      ["H-4 base", `<base href="//evil.example/">${ok}`, [true, false]],
    ] as [string, string, boolean[]][])("%s: refused statically, and the browser requests evil.example", async (_, body, jsRuns) => {
      const html = page(body);
      expect(problems(html).length).toBeGreaterThan(0);
      const r = await verify(html);
      expect(r.problems).toContain("PAGE_UNEXPECTED_REQUEST");
      for (const run of r.runs) if (jsRuns.includes(run.javaScript)) expect(run.unexpected.some(evil)).toBe(true);
    }, 60_000);

    it("M-1 link stylesheet: refused statically, and the browser requests the other file", async () => {
      const html = page(`<link rel="stylesheet" href="other.css">${ok}`);
      expect(problems(html)).toContain("PAGE_ELEMENT_NOT_ALLOWED");
      const r = await verify(html);
      expect(r.problems).toContain("PAGE_UNEXPECTED_REQUEST");
      for (const run of r.runs) expect(run.unexpected).toContain(`${DECORATION_PAGE_ORIGIN}/page/other.css`);
    }, 60_000);

    it("the DOM cross-check catches an img the network never sees (data:) and foreign elements", async () => {
      const r = await verify(page(`${ok}<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" aria-hidden="true" referrerpolicy="no-referrer"><svg></svg>`));
      expect(r.problems).toEqual(expect.arrayContaining(["PAGE_DOM_ELEMENT_NOT_ALLOWED", "PAGE_UNEXPECTED_IMG"]));
    }, 60_000);
  });
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
  }, 60_000);

  async function render(name: string, body: string, w: number, h: number) {
    writeFileSync(join(dir, `${name}.svg`), body);
    writeFileSync(join(dir, `${name}.html`), `<!doctype html><html><body style="margin:0;background:#fff"><img src="${name}.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer" style="position:absolute;left:40px;top:40px;width:${w}px;height:${h}px;display:block"></body></html>`);
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
  it("the browser verification imports only node:fs, node:path, playwright and the checker", () => {
    expect(specifiers(readFileSync(resolve(REPO, BROWSER_MODULE), "utf8")).sort()).toEqual(["./decoration-svg", "node:fs", "node:path", "playwright"]);
  });
  it("the fixtures import nothing; the layer harness imports only playwright types, comp-impl and the checker; the probe only node, playwright, sharp and research", () => {
    expect(specifiers(readFileSync(resolve(REPO, FIXTURES_MODULE), "utf8"))).toEqual([]);
    expect(specifiers(readFileSync(resolve(REPO, LAYERS_MODULE), "utf8")).sort()).toEqual(["../../lib/design-agent/comp-impl/layers", "../../lib/design-agent/comp-impl/page-css", "../../lib/design-agent/comp-impl/page-scripts", "../../lib/design-agent/comp-impl/render", "../../lib/design-agent/comp-impl/verify", "../../lib/design-agent/research/decoration-svg", "playwright"]);
    expect(specifiers(readFileSync(resolve(REPO, PROBE_SCRIPT), "utf8")).sort()).toEqual(["../../lib/design-agent/research/decoration-fixtures", "../../lib/design-agent/research/decoration-svg", "node:fs", "node:path", "playwright", "sharp"]);
  });
  // the fixtures hold hostile SVG text by design (a `fetch(` inside an SVG string); they import and run nothing
  it.each([MODULE, BROWSER_MODULE, LAYERS_MODULE, PROBE_SCRIPT])("no network, process or model code in %s", (file) => {
    expect(readFileSync(resolve(REPO, file), "utf8")).not.toMatch(/\brequire\s*[([]|import\s*\(|node:(https?|net|tls|child_process|worker_threads|vm)|\/worker\/|anthropic|openai|\bspawn\(|execFile|process\.binding|\bfetch\(|codex|\beval\(|new Function/i);
  });
  it("nothing outside tests imports them (lib, app, components, scripts) but the research probe script, which nothing imports", () => {
    const RESEARCH = [MODULE, BROWSER_MODULE, FIXTURES_MODULE];
    const r = spawnSync("git", ["grep", "-l", "-E", "research/decoration-(svg|page-browser|fixtures|layers)", "--", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    // the modules' own headers name their test, so git grep finds at least those files: status 0, never a vacuous empty
    // stdout from a git that failed (status 1 = no match at all, 128 = error)
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const hits = r.stdout.split("\n").filter(Boolean);
    expect(hits).toContain(MODULE);
    expect(hits).toContain(PROBE_SCRIPT);
    expect(hits.filter((h) => !RESEARCH.includes(h) && h !== PROBE_SCRIPT)).toEqual([]);
    const other = spawnSync("git", ["grep", "-l", "-E", "decoration-(page-browser|fixtures|layers)", "--", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    expect(other.status).toBe(0);
    expect(other.stdout.split("\n").filter(Boolean).filter((h) => !RESEARCH.includes(h) && h !== PROBE_SCRIPT)).toEqual([]);
    // the probe is a research CLI: no lane, script or page imports it (its own header names it, and so does the fixtures'
    // header; the research modules' imports are pinned exactly above)
    const probe = spawnSync("git", ["grep", "-l", "-E", "n1-browser-probe", "--", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    const probeHits = probe.stdout.split("\n").filter(Boolean);
    expect(probeHits).toContain(PROBE_SCRIPT);
    expect(probeHits.filter((h) => !RESEARCH.includes(h) && h !== PROBE_SCRIPT)).toEqual([]);
  });
  it("the research directory holds only the checker, its browser verification and the fixtures (the layer harness is test support)", () => {
    const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "lib/design-agent/research"], { cwd: REPO, encoding: "utf8" });
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual([BROWSER_MODULE, FIXTURES_MODULE, MODULE].sort());
  });
  it("the layer harness (it imports comp-impl) stays in tests/: no lib, app, components or scripts file names it, and only the N1 research test imports it", () => {
    const outside = spawnSync("git", ["grep", "-l", "-E", "decoration-layers", "--", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    expect(outside.error).toBeUndefined();
    expect(outside.status).toBe(1); // 1 = no match (0 would be a hit, 128 an error)
    const users = spawnSync("git", ["grep", "-l", "-E", "support/decoration-layers\"", "--", "tests"], { cwd: REPO, encoding: "utf8" });
    expect(users.status).toBe(0);
    expect(users.stdout.split("\n").filter(Boolean)).toEqual(["tests/unit/design-agent/research/decoration-n1-verification.test.ts"]);
  });
});
