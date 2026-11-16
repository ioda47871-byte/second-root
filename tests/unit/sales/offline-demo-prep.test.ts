import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// Run the dependency-free Node contract tests as part of the existing Vitest unit suite.
it("offline B-route adapter keeps inputs immutable and stops on any unapproved gate", () => {
  const script = resolve(process.cwd(), "tests/node/sales-demo-prep.test.mjs");
  const result = spawnSync(process.execPath, ["--test", script], { encoding: "utf8", timeout: 15_000 });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
