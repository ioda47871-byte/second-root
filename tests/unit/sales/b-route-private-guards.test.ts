import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPrivateOutputDir as checkStageOutput, stagePrototype } from "../../../scripts/sales/demo-version/from-prototype";
import { checkPrivateOutputDir as checkPrepareOutput, prepareBRouteDesignInput } from "../../../scripts/sales/demo-version/prepare-design-input";

// DEV-139 review L2: the file-system guards of the two private B-route staging scripts, on a throwaway tmpdir tree.
// Nothing is written inside the repository: the repo-root probes stop before any write, and the symlinked-parent
// cases use a fake repo root inside the tmpdir.

const REPO = resolve(__dirname, "../../..");
const BASE = join(REPO, "design-library/research/quality-pipeline/poc/bicycle");
const NAME = "架空自転車修理 輪";
const CSS = "html{font-family:serif}body{margin:0}main{max-width:70rem;margin:auto}h1{font-size:4rem}";
const HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${NAME}</title><link rel="stylesheet" href="style.css"></head><body>
<main><section><h1>${NAME}</h1><p>車輪の余白をたどる</p></section></main></body></html>`;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "uncoded";
  }
  return "passed";
};

let tmp = "";
let facts = "";
let directions = "";
let proto = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "broute-guards-"));
  facts = join(tmp, "facts-pack.json");
  directions = join(tmp, "direction-set.json");
  proto = join(tmp, "prototype");
  copyFileSync(join(BASE, "facts-pack.json"), facts);
  copyFileSync(join(BASE, "direction-set.json"), directions);
  mkdirSync(proto);
  writeFileSync(join(proto, "index.html"), HTML);
  writeFileSync(join(proto, "style.css"), CSS);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const stage = (over: Partial<Parameters<typeof stagePrototype>[0]> = {}, hooks: Parameters<typeof stagePrototype>[1] = {}) =>
  stagePrototype({
    factsPath: facts, prototypeDir: proto, directionsPath: directions, directionId: "d1-wheel-hub",
    lane: "quality_research_fictional", outDir: join(tmp, "out"), ...over,
  }, hooks);

describe("from-prototype.ts file-system guards", () => {
  it("stages a private comp on valid inputs (not sendable, owner approval required)", () => {
    const status = stage({ prospectId: "123e4567-e89b-42d3-a456-426614174000" });
    expect(status).toMatchObject({ sendable: false, owner_approval: "required", direction_id: "d1-wheel-hub" });
    for (const f of ["comp/index.html", "comp/style.css", "comp/copy.json", "status.json"]) expect(existsSync(join(tmp, "out", f))).toBe(true);
    expect(statSync(join(tmp, "out")).mode & 0o777).toBe(0o700);
  });

  it("OUTPUT_EXISTS for an existing directory and for a dangling symlink", () => {
    mkdirSync(join(tmp, "out"));
    expect(codeOf(() => stage())).toBe("OUTPUT_EXISTS");
    symlinkSync(join(tmp, "nowhere"), join(tmp, "dangling"));
    expect(codeOf(() => stage({ outDir: join(tmp, "dangling") }))).toBe("OUTPUT_EXISTS");
  });

  it("OUTPUT_IN_REPO inside the repository (stops before writing anything)", () => {
    const probe = join(REPO, `.broute-guard-probe-${process.pid}`);
    expect(codeOf(() => stage({ outDir: probe }))).toBe("OUTPUT_IN_REPO");
    expect(existsSync(probe)).toBe(false);
  });

  it("OUTPUT_IN_REPO also through a symlinked parent (fake repo root in the tmpdir)", () => {
    const fakeRepo = join(tmp, "fake-repo");
    mkdirSync(join(fakeRepo, "sub"), { recursive: true });
    symlinkSync(fakeRepo, join(tmp, "repo-link"));
    expect(codeOf(() => checkStageOutput(join(tmp, "repo-link", "sub", "new"), fakeRepo))).toBe("OUTPUT_IN_REPO");
    expect(codeOf(() => checkStageOutput(join(tmp, "elsewhere-new"), fakeRepo))).toBe("passed");
    expect(codeOf(() => checkStageOutput(join(tmp, "missing-parent", "new"), fakeRepo))).toBe("OUTPUT_PARENT_MISSING");
  });

  it("refuses a symlinked prototype dir, a symlinked page file and a symlinked facts pack", () => {
    symlinkSync(proto, join(tmp, "proto-link"));
    expect(codeOf(() => stage({ prototypeDir: join(tmp, "proto-link") }))).toBe("PROTOTYPE_DIR_UNSAFE");
    const proto2 = join(tmp, "prototype2");
    mkdirSync(proto2);
    symlinkSync(join(proto, "index.html"), join(proto2, "index.html"));
    copyFileSync(join(proto, "style.css"), join(proto2, "style.css"));
    expect(codeOf(() => stage({ prototypeDir: proto2 }))).toBe("INPUT_FILE_INVALID");
    symlinkSync(facts, join(tmp, "facts-link.json"));
    expect(codeOf(() => stage({ factsPath: join(tmp, "facts-link.json") }))).toBe("INPUT_FILE_INVALID");
    expect(existsSync(join(tmp, "out"))).toBe(false);
  });

  it("PRIVATE_SHOP_INPUT_IN_PUBLIC_REPO for a real-shop lane reading inputs from the repository", () => {
    expect(codeOf(() => stage({ lane: "real_shop_proposal", factsPath: join(BASE, "facts-pack.json") }))).toBe("PRIVATE_SHOP_INPUT_IN_PUBLIC_REPO");
  });

  it("DIRECTION_MISMATCH for a direction id the checked set does not hold", () => {
    expect(codeOf(() => stage({ directionId: "d9-not-in-set" }))).toBe("DIRECTION_MISMATCH");
  });

  it("PROSPECT_ID_INVALID for a non-UUID prospect id", () => {
    expect(codeOf(() => stage({ prospectId: "../../etc" }))).toBe("PROSPECT_ID_INVALID");
  });

  it("INPUT_MUTATED when a page file changes between validation and staging, and nothing is written", () => {
    expect(codeOf(() => stage({}, { afterValidation: () => appendFileSync(join(proto, "index.html"), "\n") }))).toBe("INPUT_MUTATED");
    expect(existsSync(join(tmp, "out"))).toBe(false);
  });
});

const prepare = (over: Partial<Parameters<typeof prepareBRouteDesignInput>[0]> = {}, hooks: Parameters<typeof prepareBRouteDesignInput>[1] = {}) =>
  prepareBRouteDesignInput({ factsPath: facts, directionsPath: directions, directionId: "d1-wheel-hub", outDir: join(tmp, "out"), ...over }, hooks);

describe("prepare-design-input.ts file-system guards", () => {
  it("prepares the direction files on valid inputs (no design generated, not sendable)", () => {
    const record = prepare();
    expect(record).toMatchObject({ design_generated: false, sendable: false, prompt_pin_required: true });
    for (const f of ["direction.json", "references.json", "pin.json"]) expect(existsSync(join(tmp, "out", f))).toBe(true);
    expect(JSON.parse(readFileSync(join(tmp, "out", "pin.json"), "utf8")).direction_id).toBe("d1-wheel-hub");
  });

  it("OUTPUT_EXISTS and OUTPUT_IN_REPO (also through a symlinked parent)", () => {
    mkdirSync(join(tmp, "out"));
    expect(codeOf(() => prepare())).toBe("OUTPUT_EXISTS");
    const probe = join(REPO, `.broute-guard-probe-${process.pid}`);
    expect(codeOf(() => prepare({ outDir: probe }))).toBe("OUTPUT_IN_REPO");
    expect(existsSync(probe)).toBe(false);
    const fakeRepo = join(tmp, "fake-repo");
    mkdirSync(fakeRepo);
    symlinkSync(fakeRepo, join(tmp, "repo-link"));
    expect(codeOf(() => checkPrepareOutput(join(tmp, "repo-link", "new"), fakeRepo))).toBe("OUTPUT_IN_REPO");
  });

  it("refuses symlinked inputs", () => {
    symlinkSync(facts, join(tmp, "facts-link.json"));
    expect(codeOf(() => prepare({ factsPath: join(tmp, "facts-link.json") }))).toBe("INPUT_FILE_UNSAFE");
    symlinkSync(directions, join(tmp, "dir-link.json"));
    expect(codeOf(() => prepare({ directionsPath: join(tmp, "dir-link.json") }))).toBe("INPUT_FILE_UNSAFE");
  });

  it("INPUT_MUTATED when the direction set changes before output, and nothing is written", () => {
    expect(codeOf(() => prepare({}, { afterValidation: () => appendFileSync(directions, "\n") }))).toBe("INPUT_MUTATED");
    expect(existsSync(join(tmp, "out"))).toBe(false);
  });
});
