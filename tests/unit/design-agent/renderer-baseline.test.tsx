import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineCases, sha256 } from "./renderer-baseline-cases";

// DEV-071a backwards compatibility: a profile without `layout` (every profile
// saved before Stage 1) renders byte-identical markup to the renderer before
// Stage 1. The hashes are never regenerated from the Stage 1 code to make a
// change pass. To re-pin them after develop changes the renderer:
//   1. git worktree add <tmp> origin/develop   (a tree WITHOUT the Stage 1 renderer)
//   2. copy renderer-baseline-cases.tsx and this file into <tmp>/tests/unit/design-agent/
//   3. in <tmp>: SR_WRITE_RENDERER_BASELINE=<commit of origin/develop> npx vitest run tests/unit/design-agent/renderer-baseline.test.tsx
//   4. copy <tmp>/tests/unit/design-agent/__fixtures__/renderer-baseline.json back; the
//      fixture records that commit as its source.

const FILE = join(process.cwd(), "tests/unit/design-agent/__fixtures__/renderer-baseline.json");

type Baseline = { source: string; hashes: Record<string, string> };

describe("profile renderer markup before Stage 1", () => {
  it("is unchanged for every profile without layout", () => {
    const now = Object.fromEntries(baselineCases().map((c) => [c.key, sha256(c.html())]));
    const source = process.env.SR_WRITE_RENDERER_BASELINE;
    if (source) writeFileSync(FILE, `${JSON.stringify({ source, hashes: now } satisfies Baseline, null, 1)}\n`);
    const before = JSON.parse(readFileSync(FILE, "utf8")) as Baseline;
    expect(before.source).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Object.keys(now).sort()).toEqual(Object.keys(before.hashes).sort());
    for (const [key, hash] of Object.entries(before.hashes)) expect(now[key], key).toBe(hash);
  });
});
