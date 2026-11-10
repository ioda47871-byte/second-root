import { describe, expect, it } from "vitest";
import { ARTIFACT_PARSE_LIMITS, boundedParse } from "@/lib/sales/demo-version/bounded-parse";
import { OpBudget } from "@/lib/sales/demo-version/budget";
import { ARTIFACT_INPUT_LIMITS, checkArtifactCss, checkArtifactHtml, cssComplexityProblem } from "@/lib/sales/demo-version/html-safety";

/** The parse limit a page hits inside parse5, or null (round 3 replaced the round-2 pre-scanner with this). */
const htmlShapeProblem = (html: string) => {
  const r = boundedParse(html, new OpBudget());
  return r.ok ? null : r.code;
};
import { hasImageMetadata } from "@/lib/sales/demo-version/manifest";
import { jpeg } from "./fixtures";

// Re-review of PR #243 at 3ee4134 (C0 H0 M1 L2). Slow inputs are refused by a LIMIT (a fixed code, the slow path
// never runs), so these tests assert the code; the time bound is a generous backstop (the fixed path takes
// milliseconds; before the fix the same inputs took 20–35 s).

const PHOTOS = new Set(["photos/hero-desktop.webp"]);
const BOUND_MS = 3000;
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};
const page = (body: string) => `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;

describe("M1: slow inputs are refused by a limit before the slow path", () => {
  it('a stylesheet of "url(" × 64000 (256 KB) → CSS_TOO_COMPLEX', () => {
    const css = "url(".repeat(64000);
    expect(cssComplexityProblem(css)).toBe("CSS_TOO_COMPLEX");
    const [r, ms] = timed(() => checkArtifactCss(css, PHOTOS));
    expect(r).toEqual([{ code: "CSS_TOO_COMPLEX" }]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("escaped url( counts too (the limit is on the decoded text)", () => {
    expect(cssComplexityProblem("u\\72l(".repeat(ARTIFACT_INPUT_LIMITS.cssUrls + 1))).toBe("CSS_TOO_COMPLEX");
    expect(cssComplexityProblem("a{background:url(x)}".repeat(ARTIFACT_INPUT_LIMITS.cssUrls))).toBeNull();
  });

  it("a stylesheet of unclosed \"/* a\" × 64000 → CSS_TOO_COMPLEX", () => {
    const css = "/* a".repeat(64000);
    const [r, ms] = timed(() => checkArtifactCss(css, PHOTOS));
    expect(r).toEqual([{ code: "CSS_TOO_COMPLEX" }]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("an oversized stylesheet → CSS_TOO_LARGE", () => {
    expect(checkArtifactCss("a".repeat(ARTIFACT_INPUT_LIMITS.cssChars + 1), PHOTOS)).toEqual([{ code: "CSS_TOO_LARGE" }]);
  });

  it('an SVG attribute of "url(" × 60000 → refused without the quadratic regex', () => {
    const html = page(`<svg><rect fill="${"url(".repeat(60000)}"/></svg>`);
    const [r, ms] = timed(() => checkArtifactHtml(html, "body{}", PHOTOS));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual({ code: "HTML_ATTRIBUTE_URL", detail: "rect fill: too complex" });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('"<div>" × 76000 (380 KB) → HTML_TOO_DEEP before parse5 runs', () => {
    const html = "<div>".repeat(76000);
    expect(htmlShapeProblem(html)).toBe("HTML_TOO_DEEP");
    const [r, ms] = timed(() => checkArtifactHtml(html, "body{}", PHOTOS));
    expect(r.findings.map((f) => f.code)).toEqual(["HTML_TOO_DEEP"]);
    expect(r.texts).toEqual([]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("<div/> still opens a level (as the HTML parser does); <rect/> in SVG and void elements do not", () => {
    expect(htmlShapeProblem("<div/>".repeat(ARTIFACT_PARSE_LIMITS.depth + 1))).toBe("HTML_TOO_DEEP");
    expect(htmlShapeProblem(`<svg>${"<rect/>".repeat(2000)}</svg>`)).toBeNull();
    expect(htmlShapeProblem("<br>".repeat(5000))).toBeNull();
    expect(htmlShapeProblem("<i>".repeat(ARTIFACT_PARSE_LIMITS.depth + 1))).toBe("HTML_TOO_DEEP");
  });

  it("depth at the limit passes the pre-scan; closed siblings never accumulate", () => {
    // html, body and the divs share the stack: depth - 2 divs fit, one more does not
    expect(htmlShapeProblem("<div>".repeat(ARTIFACT_PARSE_LIMITS.depth - 2))).toBeNull();
    expect(htmlShapeProblem("<div>".repeat(ARTIFACT_PARSE_LIMITS.depth - 1))).toBe("HTML_TOO_DEEP");
    expect(htmlShapeProblem("<p>x</p>".repeat(7000))).toBeNull();
  });

  it("too many elements → HTML_TOO_MANY_ELEMENTS; too large → HTML_TOO_LARGE", () => {
    expect(htmlShapeProblem("<br>".repeat(ARTIFACT_PARSE_LIMITS.elements + 1))).toBe("HTML_TOO_MANY_ELEMENTS");
    expect(htmlShapeProblem("a".repeat(ARTIFACT_PARSE_LIMITS.htmlChars + 1))).toBe("HTML_TOO_LARGE");
  });

  it("a tag with 40000 attributes → HTML_TOO_MANY_ATTRIBUTES before parse5 (its duplicate check is quadratic)", () => {
    const html = page(`<p ${Array.from({ length: 40000 }, (_, i) => `a${i}`).join(" ")}>x</p>`);
    const [r, ms] = timed(() => checkArtifactHtml(html, "body{}", PHOTOS));
    expect(r.findings.map((f) => f.code)).toEqual(["HTML_TOO_MANY_ATTRIBUTES"]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("counts attributes outside quoted values only (a long SVG path or alt text is one attribute)", () => {
    expect(htmlShapeProblem(`<svg><path d="${"M 0 0 L 1 1 ".repeat(2000)}"/></svg><img alt="a b > c d e">`)).toBeNull();
    expect(htmlShapeProblem(`<p ${Array.from({ length: ARTIFACT_PARSE_LIMITS.attributesPerTag + 1 }, (_, i) => `x${i}`).join(" ")}>`)).toBe("HTML_TOO_MANY_ATTRIBUTES");
  });

  it("comments and stray < do not confuse the scan", () => {
    expect(htmlShapeProblem("<!-- <div><div> -->a < b <p>x</p>")).toBeNull();
    const [r, ms] = timed(() => htmlShapeProblem("<a".repeat(120000)));
    expect(r).toBeNull();
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("a long chain of repeated custom-property definitions stays fast (memoised)", () => {
    const defs = Array.from({ length: 3 }, (_, d) => `:root{${`--v${d}:var(--v${d + 1});`.repeat(1000)}}`).join("") + ":root{--v3:serif}";
    const [r, ms] = timed(() => checkArtifactCss(`${defs} p{font-family:var(--v0)}`, PHOTOS));
    expect(r).toEqual([]);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("L1: no bytes after the JPEG EOI", () => {
  it("refuses trailing bytes, accepts a clean end", () => {
    const clean = jpeg(10, 10, { scan: true });
    expect(hasImageMetadata(clean)).toBe(false);
    expect(hasImageMetadata(new Uint8Array([...clean, 0x00]))).toBe(true);
    expect(hasImageMetadata(new Uint8Array([...clean, ...Buffer.from("PK\x03\x04appended", "latin1")]))).toBe(true);
  });
});
