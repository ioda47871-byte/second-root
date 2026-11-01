import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { CORPUS, FACTS, NAME } from "./mobile-quality-corpus";

// DEV-140 (Issue #177 B): the SP checks (DEV-134) against a labelled corpus of fictional phone pages. The checks are
// report-only; this records where they agree with a person reading the page, and fixes the known disagreements so a
// change in either direction shows up here (and in docs/design/phase2f-mobile-quality.md).

/** Disagreements kept on purpose, each with its reason (false positive: reported but not a problem; false negative: missed). */
const KNOWN: Record<string, { fp?: string[]; fn?: string[]; why: string }> = {
  deco_type_not_marked: {
    fp: ["SP_TEXT_CLIPPED", "SP_TEXT_OFFSCREEN"],
    why: "a bleeding decorative word is text to the checks; marking it aria-hidden (as big_decorative_type does) is the way to say it is decoration",
  },
  drawer_translated: { fp: ["SP_TEXT_OFFSCREEN"], why: "a drawer pushed off the right edge cannot be told from a row pushed out by mistake (DEV-134 limit)" },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser.close();
});
const doc = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;

describe("SP checks against the labelled corpus", () => {
  it("has distinct cases, both intentional designs and real problems, and every known disagreement names a case", () => {
    expect(new Set(CORPUS.map((c) => c.id)).size).toBe(CORPUS.length);
    expect(CORPUS.filter((c) => c.expected.length === 0).length).toBeGreaterThanOrEqual(8);
    expect(CORPUS.filter((c) => c.expected.length > 0).length).toBeGreaterThanOrEqual(8);
    for (const id of Object.keys(KNOWN)) expect(CORPUS.some((c) => c.id === id), id).toBe(true);
  });

  for (const c of CORPUS) {
    it(`${c.id}: ${c.intent}`, async () => {
      const r = await renderPrototype(browser, { html: doc(c.body), css: c.css }, new Map(), [], { facts: FACTS, shopName: NAME });
      const got = r.mobile_390.mobileQuality!.findings;
      const fp = got.filter((f) => !c.expected.includes(f)).sort();
      const fn = c.expected.filter((f) => !got.includes(f)).sort();
      // exactly the labelled findings, apart from the known disagreements (which must still be exactly as recorded)
      expect({ fp, fn }).toEqual({ fp: [...(KNOWN[c.id]?.fp ?? [])].sort(), fn: [...(KNOWN[c.id]?.fn ?? [])].sort() });
    }, 60_000);
  }
});
