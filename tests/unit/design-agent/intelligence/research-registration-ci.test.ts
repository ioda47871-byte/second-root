import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Run the research branch's separate offline validator and negative safety tests.
// These scripts are intentionally NOT imported by the production Design Intelligence adapter.
const root = process.cwd();
const run = (args: string[]) => spawnSync(process.execPath, args, {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 2 * 1024 * 1024,
});
describe("staged 30-case research registration (not approved for generation)", () => {
  it("checks the 30-case manifest and analysis with the offline validator", () => {
    const r = run([resolve(root, "design-library/intelligence/v01/validate.mjs")]);
    expect(r.error).toBeUndefined();
    expect(r.status, [r.stdout, r.stderr].join("\n")).toBe(0);
    expect(r.stdout).toContain("PASS: 30 research success patterns (17 local Web PoCs)");
  });
  it("rejects strict frozen baseline and adversarial research registry mutations", () => {
    const r = run(["--test", resolve(root, "design-library/intelligence/v01/registration-safety.test.mjs")]);
    expect(r.error).toBeUndefined();
    expect(r.status, [r.stdout, r.stderr].join("\n")).toBe(0);
    expect(r.stdout).toMatch(/# pass ([3-9][0-9]|[1-9][0-9]{2,})/);
    expect(r.stdout).toContain("# fail 0");
  });
});
