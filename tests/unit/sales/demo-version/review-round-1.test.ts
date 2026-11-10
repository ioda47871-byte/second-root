import { describe, expect, it } from "vitest";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";
import { ARTIFACT_PERMISSIONS_POLICY } from "@/lib/sales/demo-version/csp";
import { cssTokens } from "@/lib/sales/demo-version/css-scan";
import { checkArtifactCss, checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";
import { hasImageMetadata } from "@/lib/sales/demo-version/manifest";
import { cssProblems as coreCssProblems } from "@/lib/sales/demo-version/rule-core";
import { signViewToken, verifyViewToken } from "@/lib/sales/demo-version/view-token";
import { DEMO_ID, jpeg, KEY, segment, VERSION_ID, webp, webpChunks } from "./fixtures";

// Independent security review of PR #243, round 1 (C0 H0 M3 L4): one regression test per probe. Each of these
// passed before the fix.

const PHOTOS = new Set(["photos/hero-desktop.webp"]);
const page = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
const cssCodes = (css: string) => checkArtifactCss(css, PHOTOS).map((f) => f.code);
const htmlCodes = (body: string, css = "body{color:#000}") => checkArtifactHtml(page(body), css, PHOTOS).findings.map((f) => f.code);

describe("M1: outside url() hidden from the comment-stripping first pass", () => {
  const PROBES: Array<[string, string]> = [
    ["(a) a comment marker inside a string", 'a{content:"/*"} b{background:url(https://evil.example/x)} c{content:"*/"}'],
    ["(b) escaped comment markers are identifier characters", "a{x:\\2f\\2a} b{background:url(https://evil.example/x)} c{y:\\2a\\2f}"],
    ["(c) backslash-newline inside a quoted url", "b{background:url('https://e\\\nx')}"],
  ];
  it.each(PROBES)("%s is refused", (_n, css) => {
    expect(cssCodes(css)).toContain("CSS_URL_NOT_ALLOWED");
    expect(checkArtifactHtml(page("<p>x</p>"), css, PHOTOS).ok).toBe(false);
  });
  it.each(PROBES)("%s: the copied first pass alone does not see it (why the token scan exists)", (_n, css) => {
    expect(coreCssProblems(css, PHOTOS).filter((p) => p.startsWith("css url"))).toEqual([]);
  });

  it("tokenises like CSS: strings, continuations, escaped idents and url tokens", () => {
    expect(cssTokens("'a\\\nb'")).toEqual([{ t: "string", v: "ab" }]);
    expect(cssTokens("u\\72l(x.png)")).toEqual([{ t: "url", v: "x.png" }]);
    expect(cssTokens('"a\nb"')[0]).toEqual({ t: "bad", v: "string" });
    expect(cssTokens("url(a b)")).toEqual([{ t: "bad", v: "url" }]);
  });

  it("refuses bad strings, bad urls and a stray backslash-newline (fail closed)", () => {
    expect(cssCodes('a{x:"a\nb"}')).toContain("CSS_SYNTAX_SUSPICIOUS");
    expect(cssCodes("a{background:url(a b)}")).toContain("CSS_SYNTAX_SUSPICIOUS");
    expect(cssCodes("a{x:\\\ny}")).toContain("CSS_SYNTAX_SUSPICIOUS");
  });

  it("still allows a declared photo and #id through the scan", () => {
    expect(cssCodes('a{background:url(photos/hero-desktop.webp)} b{background:url("photos/hero-desktop.webp")} c{filter:url(#f)}')).toEqual([]);
  });

  it("refuses loading at-rules and image functions found only by the scan", () => {
    expect(cssCodes("@namespace svg url(https://evil.example/ns);")).toEqual(expect.arrayContaining(["CSS_AT_RULE_NOT_ALLOWED"]));
    expect(cssCodes("@counter-style x { symbols: a; }")).toContain("CSS_AT_RULE_NOT_ALLOWED");
    expect(cssCodes("a{background:cross-fade(url(photos/hero-desktop.webp), red)}")).toContain("CSS_IMAGE_FUNCTION");
  });
});

describe("M2: URLs hidden with CSS escapes in SVG presentation attributes", () => {
  it.each([
    ['<svg><rect fill="\\75 rl(https://evil.example/x)"/></svg>'],
    ['<svg><rect filter="u\\72l(https://evil.example/x)"/></svg>'],
    ['<svg><g mask="\\75\\72\\6c(https://evil.example/x)"></g></svg>'],
  ])("%s is refused", (body) => {
    const codes = htmlCodes(body);
    expect(codes).toContain("HTML_ATTRIBUTE_ESCAPE");
    expect(codes).toContain("HTML_ATTRIBUTE_URL");
  });

  it("refuses an SVG font-family attribute outside the allowlist", () => {
    expect(htmlCodes('<svg><text font-family="Evil Font">x</text></svg>')).toContain("CSS_FONT_FAMILY_NOT_ALLOWED");
    expect(htmlCodes('<svg><text font-family="IPAMincho, serif">x</text></svg>')).toEqual([]);
  });
});

describe("M3: visible text outside the text nodes", () => {
  it("refuses text drawn by CSS content", () => {
    const css = '.x::before{content:"ご予約・カート テスト"}';
    const r = checkArtifactHtml(page('<p class="x">a</p>'), css, PHOTOS);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("CSS_TEXT_IN_CSS");
  });

  it.each([
    [".x::after{content:attr(data-note)}"],
    [':root{--t:"予約"} .x::before{content:var(--t)}'],
    ['ul{list-style-type:"★"}'],
    ['q{quotes:"予約" "x"}'],
    ['p{text-overflow:"創業100年"}'],
  ])("refuses %s", (css) => {
    expect(cssCodes(css)).toContain("CSS_TEXT_IN_CSS");
  });

  it("keeps empty content, font names, grid areas and custom properties", () => {
    expect(cssCodes(':root{--f:"IPAMincho", serif} .x::before{content:""} .g{grid-template-areas:"a b" "c d"} p{font-family:var(--f)}')).toEqual([]);
  });

  it("sends visible attribute values into texts, so the word rules and the copy check see them", () => {
    const r = checkArtifactHtml(page('<img src="photos/hero-desktop.webp" alt="創業1890年"><span title="予約受付中" aria-label="店名">x</span>'), "body{}", PHOTOS);
    expect(r.texts).toEqual(expect.arrayContaining(["創業1890年", "予約受付中", "店名"]));
    expect(r.findings.map((f) => f.code)).toContain("HTML_SALES_WORD");
    const copy = checkArtifactCopy({
      texts: checkArtifactHtml(page('<img src="photos/hero-desktop.webp" alt="創業1890年"><h1>例示パン店</h1>'), "body{}", PHOTOS).texts,
      copyRecord: { schema: "comp_copy_v1", shop_id: "s", facts_sha256: "a".repeat(64), lane: "real_shop_proposal", items: [{ id: "name", text: "例示パン店", claim_type: "fact", source_fact_ids: ["F1"], owner_review_needed: false }] },
      shopId: "s",
      factsSha256: "a".repeat(64),
      facts: [{ id: "F1", key: "name", value: "例示パン店" }],
    });
    expect(copy.findings).toContainEqual({ code: "UNVERIFIED_COPY", detail: "2" }); // alt text + the <title>
  });
});

describe("L1: allowlists, attributionsrc, permissions", () => {
  it.each([["<input value=\"予約\">"], ["<button>x</button>"], ["<video></video>"], ["<svg><filter><feImage href=\"#a\"/></filter></svg>"], ["<marquee>x</marquee>"], ["<custom-el>x</custom-el>"]])("refuses the element in %s", (body) => {
    expect(htmlCodes(body)).toContain("HTML_ELEMENT_NOT_ALLOWED");
  });
  it("refuses attributionsrc and unknown attributes", () => {
    expect(htmlCodes('<img src="photos/hero-desktop.webp" attributionsrc="https://evil.example/r">')).toEqual(expect.arrayContaining(["HTML_URL_NOT_ALLOWED", "HTML_ATTRIBUTE_NOT_ALLOWED"]));
    expect(htmlCodes('<a href="#x" attributionsrc>x</a>')).toContain("HTML_ATTRIBUTE_NOT_ALLOWED");
    expect(htmlCodes('<p popover="auto">x</p>')).toContain("HTML_ATTRIBUTE_NOT_ALLOWED");
  });
  it("turns off attribution reporting and topics", () => {
    expect(ARTIFACT_PERMISSIONS_POLICY).toContain("attribution-reporting=()");
    expect(ARTIFACT_PERMISSIONS_POLICY).toContain("browsing-topics=()");
  });
});

describe("L2: signer clock skew on the lifetime cap only", () => {
  const NOW = new Date("2026-11-10T03:00:00Z");
  const ahead = (s: number) => signViewToken({ scope: "a", versionId: VERSION_ID, demoId: DEMO_ID, now: new Date(NOW.getTime() + s * 1000), key: KEY });
  it("accepts a fresh token from a signer up to 5 s ahead, refuses beyond", () => {
    expect(verifyViewToken({ token: ahead(1), pathScope: "a", now: NOW, key: KEY }).ok).toBe(true);
    expect(verifyViewToken({ token: ahead(5), pathScope: "a", now: NOW, key: KEY }).ok).toBe(true);
    expect(verifyViewToken({ token: ahead(6), pathScope: "a", now: NOW, key: KEY })).toEqual({ ok: false, reason: "TOKEN_LIFETIME_TOO_LONG" });
  });
  it("keeps expiry strict", () => {
    const t = signViewToken({ scope: "a", versionId: VERSION_ID, demoId: DEMO_ID, now: NOW, key: KEY });
    expect(verifyViewToken({ token: t, pathScope: "a", now: new Date(NOW.getTime() + 900_000), key: KEY })).toEqual({ ok: false, reason: "TOKEN_EXPIRED" });
  });
});

describe("L3: image metadata is an allowlist of decoding segments", () => {
  it.each([
    ["APP13 (IPTC)", segment(0xed, "Photoshop 3.0\0")],
    ["COM", segment(0xfe, "taken at the shop")],
    ["APP2 (ICC)", segment(0xe2, "ICC_PROFILE\0")],
    ["APP0 that is not JFIF", segment(0xe0, "JFXX\0\x10")],
    ["APP15", segment(0xef, "x")],
  ])("refuses a JPEG with %s", (_n, seg) => {
    expect(hasImageMetadata(jpeg(10, 10, { segments: [seg] }))).toBe(true);
  });
  it("refuses a COM between scans", () => {
    const b = jpeg(10, 10, { scan: true });
    const withCom = new Uint8Array([...b.subarray(0, b.length - 2), ...segment(0xfe, "x"), 0xff, 0xd9]);
    expect(hasImageMetadata(withCom)).toBe(true);
  });
  it("accepts JFIF, Adobe, DQT, DHT and a scan with stuffing and restarts", () => {
    const jfif = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const adobe = segment(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 1]);
    expect(hasImageMetadata(jpeg(10, 10, { segments: [jfif, adobe, segment(0xdb, [0, ...new Array(64).fill(1)]), segment(0xc4, [0, ...new Array(16).fill(0)])], scan: true }))).toBe(false);
  });
  it.each([
    ["an ICCP chunk", webpChunks([["VP8X", [0, 0, 0, 0, 9, 0, 0, 9, 0, 0]], ["ICCP", [1, 2]], ["VP8L", [0x2f, 0, 0, 0, 0]]])],
    ["an unknown chunk", webpChunks([["VP8L", [0x2f, 0, 0, 0, 0]], ["ABCD", [1]]])],
    ["the ICC flag", webp(10, 10, 0x20)],
    ["the animation flag", webp(10, 10, 0x02)],
    ["a chunk longer than the file", new Uint8Array([...webp(10, 10).subarray(0, 16), 0xff, 0xff, 0, 0])],
  ])("refuses a WebP with %s", (_n, b) => {
    expect(hasImageMetadata(b)).toBe(true);
  });
  it("accepts a WebP with only VP8X (alpha) + ALPH + VP8L", () => {
    expect(hasImageMetadata(webpChunks([["VP8X", [0x10, 0, 0, 0, 9, 0, 0, 9, 0, 0]], ["ALPH", [0]], ["VP8L", [0x2f, 0, 0, 0, 0]]]))).toBe(false);
  });
});
