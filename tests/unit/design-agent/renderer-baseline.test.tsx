import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineCases, sha256 } from "./renderer-baseline-cases";

// DEV-071a backwards compatibility: a profile without `layout` (every profile
// saved before Stage 1) renders byte-identical markup to the renderer before
// Stage 1. The hashes were taken from that renderer (commit 3b1c2fb) and are
// never regenerated to make a change pass.

const FILE = join(process.cwd(), "tests/unit/design-agent/__fixtures__/renderer-baseline.json");

describe("profile renderer markup before Stage 1", () => {
  it("is unchanged for every profile without layout", () => {
    const now = Object.fromEntries(baselineCases().map((c) => [c.key, sha256(c.html())]));
    if (process.env.SR_WRITE_RENDERER_BASELINE === "1") writeFileSync(FILE, `${JSON.stringify(now, null, 1)}\n`);
    const before = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
    expect(Object.keys(now).sort()).toEqual(Object.keys(before).sort());
    for (const [key, hash] of Object.entries(before)) expect(now[key], key).toBe(hash);
  });
});
