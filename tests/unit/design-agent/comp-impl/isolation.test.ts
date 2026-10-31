import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./support";

// DEV-082: the comp-to-site PoC stays a local PoC. Only its CLI imports it; the
// web app, the renderer, the worker, the preview and the asset store never do,
// and it never names a model API, an API key or the asset store's writer.
//
// Phase 2f-1 (owner-approved): exactly ONE other file may import it, to reuse the
// safe page opener (network shut, JS off) and the page height cap for Codex
// prototypes. Nothing else of comp-impl is reachable from it (no implementation
// CSS allowlist, no comp spec).
/** DEV-131 (Issue #159, Phase 2e research): the implementation lane compares renders with the comp similarity primitives. */
const IMPL_LANE_COMPARE = "lib/design-agent/impl-lane/compare.ts";
const PHASE2F_RENDER = "lib/design-agent/phase2f/render-prototype.ts";

describe("isolation of the comp-to-site PoC", () => {
  it("is imported only by its own CLI", () => {
    const grep = spawnSync("grep", ["-rlE", "--exclude-dir=comp-impl", "design-agent/comp-impl|from \"\\./comp-impl|from \"\\.\\./comp-impl", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    expect(grep.stdout.trim().split("\n").filter(Boolean).sort()).toEqual([IMPL_LANE_COMPARE, PHASE2F_RENDER, "scripts/sales-design-worker/comp-impl-poc.ts"].sort());
  });

  it("DEV-131: the implementation lane's comparison imports only the pure similarity functions", () => {
    const source = readFileSync(resolve(REPO, IMPL_LANE_COMPARE), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)].filter((m) => m[3]!.includes("comp-impl"));
    expect(imports.map((m) => [m[3], m[2]!.split(",").map((s) => s.trim()).filter(Boolean).sort()])).toEqual([
      ["../comp-impl/similarity", ["GRID_WIDTH", "colourBlocks", "compareCrops", "cropStats", "deltaE", "edgesIou", "gridOf", "pixelRect", "resample", "rgbToLab", "sectionGrid", "ssim"]],
    ]);
    expect([...source.matchAll(/["'`]([^"'`]*comp-impl[^"'`]*)["'`]/g)].map((m) => m[1])).toEqual(["../comp-impl/similarity"]);
    expect(source).not.toMatch(/import\s*\(|require\s*\(|export\s*\*|export\s*\{[^}]*\}\s*from/);
  });

  it("the one Phase 2f exception imports only the page opener, the height cap and two types", () => {
    // comments removed: only code counts
    const source = readFileSync(resolve(REPO, PHASE2F_RENDER), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)].filter((m) => m[3]!.includes("comp-impl"));
    expect(imports.map((m) => [m[3], m[2]!.split(",").map((s) => s.trim()).filter(Boolean).sort()])).toEqual([
      ["../comp-impl/page", ["PageAsset"]],
      ["../comp-impl/render", ["MAX_PAGE_HEIGHT", "openCompPage", "type Viewport"]],
    ]);
    // no other way in: every module path naming comp-impl is one of the two above; no dynamic import, require or re-export
    expect([...source.matchAll(/["'`]([^"'`]*comp-impl[^"'`]*)["'`]/g)].map((m) => m[1]).sort()).toEqual(["../comp-impl/page", "../comp-impl/render"]);
    expect(source).not.toMatch(/import\s*\(|require\s*\(|export\s*\*|export\s*\{[^}]*\}\s*from/);
  });

  it("never calls a model, Codex, the network or the asset store's intake", () => {
    const grep = spawnSync(
      "grep",
      ["-rlE", "anthropic|openai|OPENAI|ANTHROPIC|\\bfetch\\(|node:https?|from \"\\.\\./codex\"|runCodexJson|intakeAsset|from \"\\.\\./assets/intake|child_process", "lib/design-agent/comp-impl", "scripts/sales-design-worker/comp-impl-poc.ts"],
      { cwd: REPO, encoding: "utf8" },
    );
    expect(grep.stdout.trim()).toBe("");
  });
});
