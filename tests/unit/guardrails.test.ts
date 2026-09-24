import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Static guardrails from docs/SECURITY.md that can be enforced before the
// Sales Agent code exists, so later tasks cannot quietly regress them.

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const sourceFiles = trackedFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !f.startsWith("tests/"));

// Directories where Claude-collected text will be rendered or handled.
const SALES_AGENT_DIRS = ["app/admin/", "app/demo/", "app/api/internal/", "lib/sales/", "lib/supabase/"];

describe("guardrails", () => {
  it("only imports Resend from the contact form route (no cold sales email via Resend)", () => {
    const importers = sourceFiles.filter((f) => /from\s+["']resend["']|require\(\s*["']resend["']\s*\)/.test(readFileSync(f, "utf8")));
    expect(importers).toEqual(["app/api/contact/route.ts"]);
  });

  it("never uses dangerouslySetInnerHTML in Sales Agent code", () => {
    const offenders = sourceFiles
      .filter((f) => SALES_AGENT_DIRS.some((d) => f.startsWith(d)))
      .filter((f) => readFileSync(f, "utf8").includes("dangerouslySetInnerHTML"));
    expect(offenders).toEqual([]);
  });

  it("does not track env files other than the example", () => {
    const envFiles = trackedFiles.filter((f) => /(^|\/)\.env/.test(f));
    expect(envFiles).toEqual([".env.local.example"]);
  });
});
