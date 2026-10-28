import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-112: the Design Intelligence adapter is read-only research tooling. Only
// its own CLI imports it; it never reaches the sales code, the worker, the
// pipeline, Codex, a model API, the network, the asset store or the comp→site
// and design-image PoCs, and it never writes files or spawns processes.

const REPO = resolve(__dirname, "../../../..");
const grep = (args: string[]) => spawnSync("grep", args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();

describe("isolation of the Design Intelligence adapter", () => {
  it("is imported only by its own CLI", () => {
    expect(grep(["-rlE", "--exclude-dir=intelligence", "design-agent/intelligence|[\"']\\./intelligence|[\"']\\.\\./intelligence", "lib", "app", "components", "scripts"])).toEqual([
      "scripts/design-intelligence/brief.ts",
    ]);
  });

  it("never imports the sales code, the worker, the pipeline, Codex, the PoCs or the asset store", () => {
    expect(
      grep([
        "-rlE",
        "(from|import|require)\\s*\\(?\\s*[\"'](@/|(\\.\\./)+)(lib/)?(sales|admin|supabase|instagram)|design-agent/(worker|pipeline|codex|bridge|assets|design-image|comp-impl|shop-css|preview|sandbox|bounded-process|review|prompts)|(from|import|require)\\s*\\(?\\s*[\"']\\.\\./(worker|pipeline|codex|bridge|assets|design-image|comp-impl|shop-css|preview|sandbox|bounded-process|review|prompts)|components/|app/",
        "lib/design-agent/intelligence",
        "scripts/design-intelligence",
      ]),
    ).toEqual([]);
  });

  it("never calls a model or the network, never writes or spawns", () => {
    expect(
      grep([
        "-rlE",
        "anthropic|openai|OPENAI|ANTHROPIC|\\bfetch\\(|node:https?|node:net|child_process|writeFile|appendFile|mkdir|rm\\(|unlink|createWriteStream",
        "lib/design-agent/intelligence",
        "scripts/design-intelligence",
      ]),
    ).toEqual([]);
  });
});
