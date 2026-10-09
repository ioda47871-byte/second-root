import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PAGE_INFO_SCRIPT } from "@/lib/design-agent/page-scripts";

// DEV-029 regression: the photo PoC's worker died with
// `page.evaluate: ReferenceError: __name is not defined`. The worker runs under
// tsx (esbuild keepNames), which wraps named functions in a __name() helper the
// page does not have; Vitest's transform does not, so every in-process test
// passed. This runs the real page callbacks (capturePage, mediaRects,
// hideAccountChrome) compiled by tsx, in real Chromium, in a child process.
// Before the fix it printed exactly that ReferenceError.

vi.setConfig({ testTimeout: 120_000 });

describe("page callbacks under tsx (keepNames), as the worker runs them", () => {
  it("run in real Chromium without __name and return the page's photos", () => {
    const run = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), [join(process.cwd(), "tests/support/page-callbacks-tsx.ts")], {
      encoding: "utf8",
      env: process.env,
      timeout: 110_000,
    });
    const line = run.stdout.trim().split("\n").at(-1) ?? "";
    expect(line, run.stderr).not.toContain("__name");
    const out = JSON.parse(line) as { ok: boolean; sections: number; placed: Array<{ assetId: string; role: string; visible: boolean; labelled: boolean; overlapsText: boolean }>; rects: number };
    expect(out.ok).toBe(true);
    expect(run.status).toBe(0);
    // the photo section below the mobile cap got its own crop; both photos were found, labelled as marked
    expect(out.sections).toBe(1);
    expect(out.placed.map((p) => [p.role, p.visible, p.labelled, p.overlapsText])).toEqual([
      ["hero", true, true, false],
      ["visit", true, false, false],
    ]);
    expect(out.rects).toBe(2);
  });

  it("keeps the page-side code as source text, which no transform rewrites", () => {
    expect(typeof PAGE_INFO_SCRIPT).toBe("string");
    expect(PAGE_INFO_SCRIPT).not.toContain("__name");
    // plain JavaScript: it must parse as an expression without TypeScript
    expect(() => new Function(`return ${PAGE_INFO_SCRIPT.replace(/\bdocument\b/g, "undefined")};`)).not.toThrow(SyntaxError);
  });
});
