import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DEV-196b is an offline, pure library: no env reads, no network, no DB, no Storage, no file I/O, and not wired into
// any route yet (DEV-196c+ need their own approvals).
const DIR = "lib/sales/demo-version";
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

describe("demo-version library purity", () => {
  it("has the expected modules", () => {
    expect(files.sort()).toEqual(["ai-concept-rights.ts", "copy-check.ts", "csp.ts", "html-safety.ts", "manifest.ts", "quality.ts", "rights.ts", "rule-core.ts", "version-state.ts", "view-token.ts"]);
  });

  it.each(files)("%s reads no env, does no I/O and talks to no service", (f) => {
    const src = readFileSync(`${DIR}/${f}`, "utf8");
    expect(src).not.toMatch(/process\.env|\bfetch\s*\(|node:fs|node:https?|node:net|node:child_process|supabase|createClient|from ["']next\//);
  });

  it("is not imported by any app route, page or component yet", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const importers = [...walk("app"), ...walk("components"), "proxy.ts"].filter((f) => readFileSync(f, "utf8").includes("demo-version"));
    expect(importers).toEqual([]);
  });
});
