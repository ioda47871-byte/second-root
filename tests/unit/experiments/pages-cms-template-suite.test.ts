import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportDelivery } from "@/experiments/pages-cms/export-delivery";
import { writeSyntheticDesign } from "./synthetic-design";

// PR #396 review M1: the delivered repository's OWN test suite (delivery-template/tests/template.test.mjs, node --test)
// must pass on every shape of export — the default (Pages CMS) and the opted-in Sveltia one. It runs here with Second
// Root's installed sharp / tsx / zod (the delivery repository pins its own; the suite needs no network) against synthetic
// design pictures. Slow (each run builds synthetic 12 MP and 48 MP photos).

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-suite-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const REPO = join(__dirname, "../../..");
// the node_modules folder that holds the suite's dependencies (one folder in CI; here the checkout's)
const NODE_MODULES = dirname(dirname(createRequire(join(REPO, "package.json")).resolve("zod")));

function runSuite(sveltia?: { repo: string; branch: string }) {
  const base = tmp();
  const design = join(base, "design");
  writeSyntheticDesign(design);
  const out = join(base, "repo");
  return exportDelivery({ outDir: out, designDir: design, testOnlyDesignRecordDir: design, ...(sveltia ? { sveltia } : {}) }).then(() => {
    symlinkSync(NODE_MODULES, join(out, "node_modules"), "dir");
    const r = spawnSync(process.execPath, ["--test", "tests/template.test.mjs"], { cwd: out, encoding: "utf8", timeout: 400_000, maxBuffer: 16 * 1024 * 1024 });
    const pass = Number(/# pass (\d+)/.exec(r.stdout)?.[1] ?? -1);
    const fail = Number(/# fail (\d+)/.exec(r.stdout)?.[1] ?? -1);
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
    return { status: r.status, pass, fail, failed };
  });
}

describe("the delivery repository's own tests pass on every export", () => {
  it("the dependencies the suite needs resolve from the checkout (sharp, tsx, zod)", () => {
    const req = createRequire(join(NODE_MODULES, "x.js"));
    for (const m of ["sharp", "tsx/esm/api", "zod"]) expect(() => req.resolve(m), m).not.toThrow();
  });

  it("the default export (Pages CMS only)", async () => {
    expect(await runSuite()).toEqual({ status: 0, pass: 8, fail: 0, failed: [] });
  }, 420_000);

  it("the opted-in export (Pages CMS and the Sveltia admin page)", async () => {
    expect(await runSuite({ repo: "sr-cms-trial/sr-cms-trial-autocare", branch: "main" })).toEqual({ status: 0, pass: 8, fail: 0, failed: [] });
  }, 420_000);
});
