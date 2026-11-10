import { readFileSync } from "node:fs";
import { Parser, Tokenizer } from "parse5";
import { describe, expect, it } from "vitest";
import { ARTIFACT_PARSE_LIMITS, boundedParse } from "@/lib/sales/demo-version/bounded-parse";
import { DEFAULT_VALIDATION_BUDGET, OpBudget } from "@/lib/sales/demo-version/budget";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";
import { checkArtifactCss, checkArtifactHtml, trimAsciiWs } from "@/lib/sales/demo-version/html-safety";

// Review of PR #243 at f2caff9, round 3 (C0 H0 M1): the DoS paths. Every probe is refused by a limit (asserted by
// code); the 3 s bound is only a backstop (the fixed paths take milliseconds; before the fix they took 5–62 s).

const PHOTOS = new Set(["photos/hero-desktop.webp"]);
const BOUND_MS = 3000;
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};
const DIVS = "<div>".repeat(60000);

describe("M1.1: the depth limit is enforced by parse5 itself (no scanner to desync from)", () => {
  it.each([
    ["an abruptly closed comment <!-->", `<!-->${DIVS}-->`],
    ["a comment closed by --!>", `<!-- --!>${DIVS}-->`],
    ["a textarea holding <!--", `<textarea><!--</textarea>${DIVS}-->`],
    ["an unquoted value containing a quote", `<p a=x">${DIVS}<p a=x">`],
    ["plain nesting", DIVS],
    ["nested formatting elements", "<b>".repeat(60000)],
    ["nested SVG groups", `<svg>${"<g>".repeat(60000)}</svg>`],
    ["nested template contents", "<template>".repeat(30000)],
    ["nested table cells", "<table><tr><td>".repeat(20000)],
  ])("%s → HTML_TOO_DEEP", (_n, html) => {
    const [r, ms] = timed(() => checkArtifactHtml(html, "body{}", PHOTOS));
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("HTML_TOO_DEEP");
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("counts every element parse5 creates, including reconstructed formatting elements", () => {
    // each <p> closes the previous one and the <b> in it; the text after it reconstructs the <b> (a new element)
    const html = "<p><b>x".repeat(3000);
    const r = boundedParse(html, new OpBudget());
    expect(r).toEqual({ ok: false, code: "HTML_TOO_MANY_ELEMENTS" });
  });

  it("refuses too many distinct attributes in one tag inside the tokenizer", () => {
    const [r, ms] = timed(() => boundedParse(`<p ${Array.from({ length: 40000 }, (_, i) => `a${i}`).join(" ")}>`, new OpBudget()));
    expect(r).toEqual({ ok: false, code: "HTML_TOO_MANY_ATTRIBUTES" });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("parses the research pages unchanged", () => {
    const html = readFileSync("design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9/index.html", "utf8");
    expect(boundedParse(html, new OpBudget()).ok).toBe(true);
  });

  it("relies on parse5 hooks that exist in the pinned version (a rename fails here, not silently)", () => {
    expect(typeof (Parser.prototype as unknown as Record<string, unknown>).onItemPush).toBe("function");
    expect(typeof (Tokenizer.prototype as unknown as Record<string, unknown>)._leaveAttrName).toBe("function");
    expect(JSON.parse(readFileSync("package.json", "utf8")).dependencies.parse5).toBe("8.0.1");
  });
});

describe("M1.2: whitespace runs inside url( and function arguments", () => {
  it("CSS url( + 250k spaces → CSS_TOO_COMPLEX before any regex", () => {
    const css = `a{background:url(${" ".repeat(250000)}`;
    const [r, ms] = timed(() => checkArtifactCss(css, PHOTOS));
    expect(r).toEqual([{ code: "CSS_TOO_COMPLEX" }]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("escaped whitespace counts too (the limit is on the decoded text)", () => {
    expect(checkArtifactCss(`a{background:url(${"\\20".repeat(100)}x)}`, PHOTOS)).toEqual([{ code: "CSS_TOO_COMPLEX" }]);
  });

  it('SVG fill="url( + 120k spaces → refused without the rule core regex', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><svg><rect fill="url(${" ".repeat(120000)}"/></svg></body></html>`;
    const [r, ms] = timed(() => checkArtifactHtml(html, "body{}", PHOTOS));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual({ code: "HTML_ATTRIBUTE_URL", detail: "rect fill: too complex" });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("a long inner whitespace run in a URL attribute is trimmed in linear time", () => {
    const v = "a" + " ".repeat(300000) + "b";
    const [r, ms] = timed(() => trimAsciiWs(v));
    expect(r).toBe(v);
    expect(ms).toBeLessThan(BOUND_MS);
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><a href="#a${" ".repeat(300000)}b">x</a></body></html>`;
    const [h, ms2] = timed(() => checkArtifactHtml(html, "body{}", PHOTOS));
    expect(h.findings.map((f) => f.code)).toContain("HTML_URL_NOT_ALLOWED");
    expect(ms2).toBeLessThan(BOUND_MS);
  });

  it("the scan-first order: a sheet the token scan refuses never reaches the rule core", () => {
    // a bad url token: the scan refuses it, and the rule core's url regex is not run on it
    expect(checkArtifactCss("a{background:url(x y)}", PHOTOS).map((f) => f.code)).toEqual(["CSS_SYNTAX_SUSPICIOUS"]);
  });
});

describe("copy check: long texts never reach the backtracking copy-record signs", () => {
  it('a text of "一" × 200000 is unverified by its length', () => {
    const [r, ms] = timed(() =>
      checkArtifactCopy({
        texts: ["一".repeat(200000)],
        copyRecord: { schema: "comp_copy_v1", shop_id: "s", facts_sha256: "a".repeat(64), lane: "real_shop_proposal", items: [{ id: "name", text: "例示パン店", claim_type: "fact", source_fact_ids: ["F1"], owner_review_needed: false }] },
        shopId: "s",
        factsSha256: "a".repeat(64),
        facts: [{ id: "F1", key: "name", value: "例示パン店" }],
      }),
    );
    expect(r.findings).toContainEqual({ code: "UNVERIFIED_COPY", detail: "1" });
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("the validation budget (finalize-level safety net, counted work — not wall-clock)", () => {
  const page = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title><link rel="stylesheet" href="style.css"></head><body><main><h1>架空の店</h1><p>東京都架空区1-2-3</p></main></body></html>';
  it("stops with VALIDATION_BUDGET_EXCEEDED when the work exceeds the budget", () => {
    expect(checkArtifactHtml(page, "body{color:#000}", PHOTOS, new OpBudget(20)).findings.map((f) => f.code)).toContain("VALIDATION_BUDGET_EXCEEDED");
    expect(checkArtifactCss("a{color:red} b{color:blue}", PHOTOS, new OpBudget(3))).toEqual([{ code: "VALIDATION_BUDGET_EXCEEDED" }]);
  });

  it("a research page uses a small fraction of the default budget", () => {
    const dir = "design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9";
    const budget = new OpBudget();
    const r = checkArtifactHtml(readFileSync(`${dir}/index.html`, "utf8"), readFileSync(`${dir}/style.css`, "utf8"), new Set(), budget);
    expect(r.ok).toBe(true);
    expect(budget.used).toBeLessThan(DEFAULT_VALIDATION_BUDGET / 50);
  });

  it("the largest allowed inputs of ordinary shape stay within the default budget", () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${"<p>あいうえお かきくけこ</p>".repeat(14000)}</body></html>`.slice(0, ARTIFACT_PARSE_LIMITS.htmlChars);
    const css = "p{color:#000;margin:0 auto}\n".repeat(9000);
    const budget = new OpBudget();
    const r = checkArtifactHtml(html, css, PHOTOS, budget);
    expect(r.findings.map((f) => f.code)).not.toContain("VALIDATION_BUDGET_EXCEEDED");
    expect(budget.used).toBeLessThan(DEFAULT_VALIDATION_BUDGET);
  });
});
