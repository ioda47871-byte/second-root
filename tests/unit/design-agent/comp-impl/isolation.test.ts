import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { REPO } from "./support";

// DEV-082: the comp-to-site PoC stays a local PoC. Only its CLI imports it; the
// web app, the renderer, the worker, the preview and the asset store never do,
// and it never names a model API, an API key or the asset store's writer.

describe("isolation of the comp-to-site PoC", () => {
  it("is imported only by its own CLI", () => {
    const grep = spawnSync("grep", ["-rlE", "--exclude-dir=comp-impl", "design-agent/comp-impl|from \"\\./comp-impl|from \"\\.\\./comp-impl", "lib", "app", "components", "scripts"], { cwd: REPO, encoding: "utf8" });
    expect(grep.stdout.trim().split("\n").filter(Boolean).sort()).toEqual(["scripts/sales-design-worker/comp-impl-poc.ts"]);
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
