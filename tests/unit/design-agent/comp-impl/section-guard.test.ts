import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCompImpl, type RunResult } from "@/lib/design-agent/comp-impl/run";
import { buildSyntheticBundle } from "@/lib/design-agent/comp-impl/synthetic";
import { FACTS_SOURCE, FIXTURE, launch, privateTemp, removeDir, REPO } from "./support";
import { join } from "node:path";

// DEV-097 review Low-1: the per-section report can never stop or fail a run. sectionComparison is made to throw for
// this file only; the synthetic run must still finish with the same verdict, the error reported as a code.

vi.mock("@/lib/design-agent/comp-impl/similarity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/design-agent/comp-impl/similarity")>();
  return {
    ...actual,
    sectionComparison: () => {
      throw new Error("forced by the test");
    },
  };
});

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let browser: Browser;
let bundle: string;
let result: RunResult;
beforeAll(async () => {
  browser = await launch();
  bundle = await privateTemp("bundle-");
  await buildSyntheticBundle(browser, REPO, bundle);
  result = await runCompImpl({ bundleDir: bundle, pageDir: join(FIXTURE, "page"), repoDir: REPO, factsSourcePath: FACTS_SOURCE, browser });
});
afterAll(async () => {
  await browser?.close();
  if (bundle) await removeDir(bundle);
});

describe("a throwing section comparison", () => {
  it("is reported as SECTION_COMPARE_ERROR; failed and mechanical_ok are unaffected", () => {
    const r = result.report;
    expect(r.similarity.sections).toMatchObject({ code: "SECTION_COMPARE_ERROR", items: [], passing: false, viewport: "desktop_1440" });
    expect(r.failed).toEqual([]);
    expect(r.mechanical_ok).toBe(true);
    expect(r.similarity).toMatchObject({ status: "synthetic_only", passing: false, code: null });
    expect(r.similarity.ssim).toBeGreaterThan(0.5);
  });
});
