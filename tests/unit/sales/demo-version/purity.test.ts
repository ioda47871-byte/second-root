import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DEV-196b is an offline, pure library: no env reads, no network, no DB, no Storage, no file I/O, and not wired into
// any route yet (DEV-196c+ need their own approvals). DEV-196d-1 adds flags.ts (the environment is an argument, never
// read here), admin-messages.ts, compare.ts and view-model.ts under the same rules.
const DIR = "lib/sales/demo-version";
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

describe("demo-version library purity", () => {
  it("has the expected modules", () => {
    expect(files.sort()).toEqual(["admin-messages.ts", "ai-concept-rights.ts", "badge.ts", "bounded-parse.ts", "budget.ts", "compare.ts", "copy-check.ts", "csp.ts", "css-scan.ts", "flags.ts", "html-safety.ts", "lifecycle-input.ts", "manifest.ts", "quality.ts", "review-client.ts", "review-input.ts", "rights.ts", "rule-core.ts", "version-state.ts", "view-model.ts", "view-token.ts"]);
  });

  it.each(files)("%s reads no env, does no I/O and talks to no service", (f) => {
    const src = readFileSync(`${DIR}/${f}`, "utf8");
    expect(src).not.toMatch(/process\.env|\bfetch\s*\(|node:fs|node:https?|node:net|node:child_process|supabase|createClient|from ["']next\//);
  });

  // DEV-196d-3: the owner-approved DEV-196d screens (196d-3 page, 196d-4 compare, 196d-5 review form, 196d-6 lifecycle, 196d-7 Today badge) are the only app code that may use the library. The list is exact:
  // a new importer anywhere else (another page, the share route, the Today card before DEV-196d-7, proxy.ts) fails.
  it("is imported only by the approved DEV-196d admin demo screens (an exact list), never by proxy.ts or other pages", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const importers = [...walk("app"), ...walk("components"), "proxy.ts"].filter((f) => readFileSync(f, "utf8").includes("demo-version")).sort();
    expect(importers).toEqual([
      "app/admin/sales/_actions/demo-versions.ts",
      "app/admin/sales/demos/[prospectId]/compare/page.tsx",
      "app/admin/sales/demos/[prospectId]/layout.tsx",
      "app/admin/sales/demos/[prospectId]/page.tsx",
      "app/admin/sales/page.tsx",
      "components/admin/DemoVersionBadge.tsx",
      "components/admin/TodayCard.tsx",
      "components/admin/demo/CompareTables.tsx",
      "components/admin/demo/FactsPanel.tsx",
      "components/admin/demo/LiveFrame.tsx",
      "components/admin/demo/QualityReviewForm.tsx",
      "components/admin/demo/RenderPane.tsx",
      "components/admin/demo/ReviewHistory.tsx",
      "components/admin/demo/RightsPanel.tsx",
      "components/admin/demo/TokenExpiry.tsx",
      "components/admin/demo/VersionLifecycle.tsx",
      "components/admin/demo/VersionList.tsx",
      "components/admin/demo/VersionNotices.tsx",
    ]);
  });
});
