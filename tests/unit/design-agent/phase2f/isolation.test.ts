import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { answer, BRIEF, GENERATION, workspace } from "./fixtures";

// Phase 2f-1: the runner reaches Codex and the image tool only through ports given by its caller.
// In 2f-1 nothing here can call Codex, a model, the network or a process; only its offline CLI imports it.

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/phase2f";
const CLI = "scripts/design-artifact/phase2f.ts";
/** The Phase 2f-2 design step (DEV-116): the one other file allowed to import from phase2f, and only the prompt. */
const DESIGN_STEP = "scripts/design-artifact/phase2f-design.ts";
/** The Phase 2f-2 offline steps (DEV-117): pre-render, packaging from recorded steps, the comparison sheet. */
const STEPS = "scripts/design-artifact/phase2f-steps.ts";
/** DEV-150 (Issue #180, owner-approved exact paths): the image step's DOM safety check of a page, and the three-method offline steps. */
const IMAGE_STEP = "scripts/design-artifact/phase2f-image.ts";
const TM_STEPS = "scripts/design-artifact/three-methods-steps.ts";
const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();

function specifiers(source: string): string[] {
  const out: string[] = [];
  // "@import" inside a CSS rule string is not a module import
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

const ALLOWED: Record<string, string[]> = {
  [`${LIB}/prototype-safety.ts`]: ["playwright"],
  [`${LIB}/render-prototype.ts`]: ["playwright", "../comp-impl/page", "../comp-impl/render", "./mobile-quality"],
  // DEV-134: the phone checks (report-only) reuse the shop-CSS render check's text measure, unchanged
  [`${LIB}/mobile-quality.ts`]: ["playwright", "../shop-css/render-check", "../shop-css/page-scripts"],
  [`${LIB}/decode-check.ts`]: ["../worker/png-paint"],
  // DEV-150: the three-method study's tm0 prompt is the lane's own text (imported, never copied): its brief and builder
  [`${LIB}/prompt.ts`]: ["node:crypto", "zod", "../artifact/schema", "../profile", "../three-methods/brief", "../three-methods/visual-first", "./open-direction", "./research-section"],
  // DEV-124: the open direction and the success-case reference manifest (pure), and the reference sheet (Chromium)
  [`${LIB}/open-direction.ts`]: ["zod", "./research-section"],
  [`${LIB}/reference-sheet.ts`]: ["node:crypto", "playwright", "./open-direction"],
  // DEV-122: the owner-approved research section of the B v1.1 prompt (pure)
  [`${LIB}/research-section.ts`]: ["node:crypto", "zod"],
  [`${LIB}/runner.ts`]: ["node:crypto", "node:fs/promises", "node:path", "node:zlib", "playwright", "../artifact/intake", "../artifact/schema", "./decode-check", "./prompt", "./prototype-safety", "./render-prototype"],
  [`${LIB}/compare-sheet.ts`]: ["../artifact/intake", "./runner"],
  // DEV-121: the comparison baseline record checker (pure)
  [`${LIB}/baseline.ts`]: ["zod", "../artifact/schema"],
  [CLI]: ["node:fs/promises", "node:path", "playwright", "zod", "../../lib/design-agent/artifact/schema", "../../lib/design-agent/phase2f/prompt", "../../lib/design-agent/phase2f/runner"],
};

describe("isolation of the Phase 2f runner", () => {
  it("has exactly the expected files", () => {
    expect(git(["ls-files", "--cached", "--others", "--exclude-standard", "--", LIB, CLI]).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only what it needs", (file, allowed) => {
    expect(specifiers(readFileSync(resolve(REPO, file), "utf8")).filter((s) => !allowed.includes(s))).toEqual([]);
  });

  it("never reaches Codex, a model, the network or a process (Codex is a port given by the caller)", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      expect(source, file).not.toMatch(/from\s*["'][^"']*\/codex["']|runCodexJson|prepareCodexSandbox|\bfetch\(|node:https?|child_process|anthropic|openai|spawn\(|execFile/);
    }
  });

  it("writes only in the runner, and only new files (never overwrites)", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      if (file.endsWith("runner.ts")) {
        const writes = source.split("\n").filter((l) => l.includes("writeFile("));
        expect(writes.length).toBeGreaterThan(0);
        for (const l of writes) expect(l, file).toMatch(/flag: "wx"/);
        expect(source).not.toMatch(/\b(rm|rmdir|unlink|rename|copyFile|appendFile|truncate)\(/);
      } else {
        expect(source, file).not.toMatch(/\b(writeFile|appendFile|mkdir|rm|rmdir|unlink|rename|copyFile|truncate)\(/);
      }
    }
  });

  it("is imported only by its offline CLI, and by the Phase 2f-2 design step for its prompt only (DEV-116, owner-approved exact path)", () => {
    // the design step's own modules (phase2f-live) never import the runner
    expect(git(["grep", "--untracked", "-lE", "design-agent/phase2f([\"'`/]|$)|[\"'`]\\.{1,2}/phase2f[\"'`/]", "--", "lib", "app", "components", "scripts", `:!${LIB}`])).toEqual([CLI, DESIGN_STEP, STEPS, IMAGE_STEP, TM_STEPS].sort());
    const source = readFileSync(resolve(REPO, DESIGN_STEP), "utf8");
    const fromPhase2f = [...source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']([^"']*\/phase2f\/[^"']*)["']/g)].map((m) => [m[3], m[2]!.split(",").map((n) => n.trim()).filter(Boolean).sort()]);
    // DEV-122: plus the prompt-version check (pure; no file access)
    // DEV-124: plus the reference sheets of the v2 prompt (checked bytes, drawn by Chromium before the approval is used)
    expect(fromPhase2f).toEqual([
      ["../../lib/design-agent/phase2f/prompt", ["DesignBrief", "buildDesignPrompt", "codexDesignJsonSchema", "promptVariantOf", "type PromptVariant"]],
      ["../../lib/design-agent/phase2f/reference-sheet", ["ReferenceStop", "referenceSheet"]],
    ]);
    expect(specifiers(source).filter((s) => s.includes("/phase2f/"))).toEqual(["../../lib/design-agent/phase2f/prompt", "../../lib/design-agent/phase2f/reference-sheet"]);
  });

  it("the offline steps CLI (DEV-117, owner-approved exact path) takes only these names from phase2f", () => {
    const source = readFileSync(resolve(REPO, STEPS), "utf8");
    const fromPhase2f = [...source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']([^"']*\/phase2f\/[^"']*)["']/g)].map((m) => [m[3], m[2]!.split(",").map((n) => n.trim()).filter(Boolean).sort()]);
    expect(fromPhase2f).toEqual([
      ["../../lib/design-agent/phase2f/compare-sheet", ["sheetEntry", "sheetMarkdown", "type SheetCall", "type SheetEntry"]],
      // DEV-122: plus the prompt-version check, so packaging rebuilds the same prompt the design step used
      ["../../lib/design-agent/phase2f/prompt", ["DesignBrief", "promptVariantOf"]],
      ["../../lib/design-agent/phase2f/runner", ["PortStop", "packageConceptRun", "prerenderRoute", "runPrototypeRoute", "type AssetPort", "type DesignPort", "type RunResult"]],
    ]);
  });
});

describe("DEV-150: the two new importers take only these names from phase2f (owner-approved exact paths)", () => {
  const fromPhase2f = (file: string) => {
    const source = readFileSync(resolve(REPO, file), "utf8");
    return [...source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']([^"']*\/phase2f\/[^"']*)["']/g)].map((m) => [m[3], m[2]!.split(",").map((n) => n.trim()).filter(Boolean).sort()]);
  };
  it("the image step: the DOM safety check of a page only", () => {
    expect(fromPhase2f(IMAGE_STEP)).toEqual([["../../lib/design-agent/phase2f/prototype-safety", ["PrototypeUnsafe", "checkPrototype"]]]);
  });
  it("the three-method offline steps: the DOM safety check, the render and the placeholder picture only (never the prompt or the runner's run)", () => {
    expect(fromPhase2f(TM_STEPS)).toEqual([
      ["../../lib/design-agent/phase2f/prototype-safety", ["PrototypeUnsafe", "checkPrototype"]],
      ["../../lib/design-agent/phase2f/render-prototype", ["RenderError", "renderPrototype"]],
      ["../../lib/design-agent/phase2f/runner", ["placeholderPng"]],
    ]);
  });
});

describe("offline CLI", () => {
  const ws = workspace();
  afterAll(() => rmSync(ws.base, { recursive: true, force: true }));
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, CLI), ...args], { encoding: "utf8", env: process.env });
  const plan = (name: string, body: object) => {
    const dir = join(ws.base, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "brief.json"), JSON.stringify(BRIEF));
    writeFileSync(join(dir, "facts.json"), readFileSync(ws.factsPath));
    const p = join(dir, "plan.json");
    writeFileSync(p, JSON.stringify({ schema: "phase2f_offline_plan_v1", facts: "facts.json", shop: { shop_id: "fictional-wagashi", display_name: "架空菓庵" }, out: "pkg", generation: GENERATION, brief: "brief.json", ...body }));
    return { p, dir };
  };

  it("runs a recorded route B answer to a checked package, and stops an unsafe one with exit 2", () => {
    const ok = plan("ok", { route: "B_html_prototype", artifact_id: "DA-20261029-cli001", answer: "answer.json" });
    writeFileSync(join(ok.dir, "answer.json"), JSON.stringify(answer()));
    const r = cli(["--plan", ok.p]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.mode).toBe("offline_recorded_inputs");
    expect(out.record.verification_state).toBe("render_pair_complete");

    const bad = plan("bad", { route: "B_html_prototype", artifact_id: "DA-20261029-cli002", answer: "answer.json" });
    writeFileSync(join(bad.dir, "answer.json"), JSON.stringify(answer({ css: "@import url(x.css);" })));
    const s = cli(["--plan", bad.p]);
    expect(s.status).toBe(2);
    expect(JSON.parse(s.stdout)).toMatchObject({ status: "stopped", code: "PROTOTYPE_UNSAFE" });

    for (const args of [[], ["--plan"], ["--plan", ok.p, "--codex"], ["--plan=x"]]) expect(cli(args).status, args.join(" ")).toBe(2);
  }, 90_000);
});
