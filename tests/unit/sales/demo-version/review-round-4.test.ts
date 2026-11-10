import { describe, expect, it } from "vitest";
import { OpBudget } from "@/lib/sales/demo-version/budget";
import { checkArtifactCss, checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";

// Review of PR #243 at b9d8955, round 4 (one Medium): a spread copy per custom-property redefinition made
// `a{` + `--x:1;` × 42000 take 7.1 s on 0.43M budget units. The 3 s bound is a backstop; the fixed path takes ms.

const PHOTOS = new Set(["photos/hero-desktop.webp"]);
const BOUND_MS = 3000;
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};

describe("M: per-declaration work is linear and charged to the budget", () => {
  it('"a{" + "--x:1;" × 42000 (252 KB) completes in linear time', () => {
    const css = "a{" + "--x:1;".repeat(42000);
    const [r, ms] = timed(() => checkArtifactCss(css, PHOTOS));
    expect(r).toEqual([]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("the same redefinitions referenced from font-family stay linear (each definition visited once)", () => {
    const css = "a{" + '--x:"IPAMincho", serif;'.repeat(10000) + "} p{font-family:var(--x)}";
    const [r, ms] = timed(() => checkArtifactCss(css, PHOTOS));
    expect(r).toEqual([]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("charges each custom-property definition, so a budget sized below the declarations trips", () => {
    const css = "a{" + "--x:1;".repeat(42000);
    const budget = new OpBudget();
    checkArtifactCss(css, PHOTOS, budget);
    // the token scan alone charges ~1 unit per token; the declaration passes add at least one unit per definition
    const scanOnly = new OpBudget();
    checkArtifactCss("a{" + "x:1;".repeat(42000), PHOTOS, scanOnly);
    expect(budget.used - scanOnly.used).toBeGreaterThanOrEqual(42000);
    expect(checkArtifactCss(css, PHOTOS, new OpBudget(budget.used - 1))).toEqual([{ code: "VALIDATION_BUDGET_EXCEEDED" }]);
  });

  it("an element with a huge number of child nodes is walked without spreading them into one call", () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p>${"<!---->x".repeat(40000)}</p></body></html>`;
    const [r, ms] = timed(() => checkArtifactHtml(html, "body{}", PHOTOS));
    expect(r.findings).toEqual([]);
    expect(r.texts.length).toBe(40000);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});
