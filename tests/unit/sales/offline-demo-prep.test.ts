import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// Run the Node contract tests (control logic, every stop code, and the real comp-copy / comp-lane --check-review /
// package-local CLIs on staged copies of committed fictional comps; no network) as part of the Vitest unit suite.
it("offline B-route adapter keeps inputs immutable and stops on any unapproved gate", { timeout: 150_000 }, () => {
  const script = resolve(process.cwd(), "tests/node/sales-demo-prep.test.mjs");
  const result = spawnSync(process.execPath, ["--test", script], { encoding: "utf8", timeout: 140_000 });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
