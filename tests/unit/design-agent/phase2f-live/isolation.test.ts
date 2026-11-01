import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 2f-2 (DEV-116, DEV-117): the real-call steps. The modules start no process and open no connection: Codex and
// the image tool are reached only through the functions the two real-call CLIs pass in. The offline steps CLI never
// reaches Codex, the image tool or the sandbox. Only the image CLI touches the image PoC's code, and only its common
// image call and prompt builder. Nothing else imports any of it. DEV-150 (Issue #180, owner-approved exact paths): the
// three-method pilot's direction step (the design step's guards, the lane's direction prompt and check) and its offline
// steps CLI (no Codex, no image tool, no sandbox, no process).

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/phase2f-live";
const DESIGN_CLI = "scripts/design-artifact/phase2f-design.ts";
const IMAGE_CLI = "scripts/design-artifact/phase2f-image.ts";
const STEPS_CLI = "scripts/design-artifact/phase2f-steps.ts";
const CLI_SHARED = "scripts/design-artifact/phase2f-live-cli.ts";
/** DEV-150 (Issue #180, owner-approved exact paths): the three-method pilot's direction step and its offline steps. */
const DIRECTION_CLI = "scripts/design-artifact/phase2f-direction.ts";
const TM_STEPS_CLI = "scripts/design-artifact/three-methods-steps.ts";
const CLIS = [DESIGN_CLI, IMAGE_CLI, STEPS_CLI, CLI_SHARED, DIRECTION_CLI, TM_STEPS_CLI];
const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}
const named = (source: string, from: string) =>
  [...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].filter((m) => m[2] === from).flatMap((m) => m[1]!.split(",").map((s) => s.trim()).filter(Boolean)).sort();

const L = "../../lib/design-agent";
const ALLOWED: Record<string, string[]> = {
  [`${LIB}/ledger.ts`]: ["node:fs", "node:fs/promises", "node:path"],
  [`${LIB}/steps.ts`]: ["node:crypto", "node:fs", "node:fs/promises", "node:path", "./ledger"],
  [`${LIB}/design-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../codex", "./ledger", "./steps"],
  // DEV-150: plus the three-method lane's page requests (pure), for a page's picture (route claude_page)
  [`${LIB}/image-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../three-methods/page-assets", "../codex", "./ledger", "./steps"],
  // DEV-150: one DIRECTION_FIRST call; the answer checked by the three-method lane (pure)
  [`${LIB}/direction-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../three-methods/direction", "../codex", "./ledger", "./steps"],
  [CLI_SHARED]: ["node:fs/promises", "node:os", "node:path", `${L}/bounded-process`, `${L}/codex`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`, `${L}/protected-paths`, `${L}/sandbox`, `${L}/worker/env`],
  // DEV-124: node:os, playwright and the reference sheet make the v2 reference images before the approval is used
  // DEV-150: node:crypto for the SHA-256 of the tm0 brief that --print-pin shows
  [DESIGN_CLI]: ["node:crypto", "node:fs/promises", "node:os", "node:path", "playwright", `${L}/artifact/schema`, `${L}/codex`, `${L}/phase2f/prompt`, `${L}/phase2f/reference-sheet`, `${L}/phase2f-live/design-call`, `${L}/phase2f-live/ledger`, "./phase2f-live-cli"],
  // DEV-150: plus Chromium and the existing DOM prototype safety check for a page's picture (route P, before the
  // approval is used), and the facts pack schema the three-method lane re-exports (to rebuild the page's request)
  [IMAGE_CLI]: ["node:fs/promises", "node:os", "node:path", "playwright", `${L}/design-image/image-once`, `${L}/design-image/prompt`, `${L}/phase2f/prototype-safety`, `${L}/phase2f-live/image-call`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`, `${L}/three-methods/brief`, "./phase2f-live-cli"],
  [DIRECTION_CLI]: ["node:fs/promises", "node:path", `${L}/codex`, `${L}/three-methods/brief`, `${L}/three-methods/direction`, `${L}/phase2f-live/direction-call`, `${L}/phase2f-live/ledger`, "./phase2f-live-cli"],
  [TM_STEPS_CLI]: [
    "node:crypto",
    "node:fs/promises",
    "node:os",
    "node:path",
    "playwright",
    `${L}/identity/identity-lock`,
    `${L}/impl-lane/handoff`,
    `${L}/phase2f/prototype-safety`,
    `${L}/phase2f/render-prototype`,
    `${L}/phase2f/runner`,
    `${L}/phase2f-live/ledger`,
    `${L}/phase2f-live/steps`,
    `${L}/structure/observe`,
    `${L}/structure/references`,
    // owner approval A′: the pilot picture's own check (pure), instead of the Lock's full-design image audit
    `${L}/three-methods/asset-image-audit`,
    `${L}/three-methods/brief`,
    `${L}/three-methods/direction`,
    `${L}/three-methods/page-assets`,
    // review round 4 M1: the pilot's route C pin, rebuilt to bind a route C picture's design run to the facts pack
    `${L}/three-methods/visual-first`,
  ],
  [STEPS_CLI]: ["node:fs/promises", "node:os", "node:path", "playwright", `${L}/artifact/schema`, `${L}/phase2f/compare-sheet`, `${L}/phase2f/prompt`, `${L}/phase2f/runner`, `${L}/phase2f-live/image-call`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`],
};

describe("isolation of the Phase 2f-2 steps", () => {
  it("has exactly the expected files", () => {
    expect(git(["ls-files", "--cached", "--others", "--exclude-standard", "--", LIB, ...CLIS]).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only what it needs", (file, allowed) => {
    expect(specifiers(readFileSync(resolve(REPO, file), "utf8")).filter((s) => !allowed.includes(s))).toEqual([]);
  });

  it("the modules start no process and open no connection; from codex.ts they take only types and the two error classes", () => {
    for (const file of Object.keys(ALLOWED).filter((f) => f.startsWith(LIB))) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      expect(source, file).not.toMatch(/runCodexJson|prepareCodexSandbox|runBounded|generateImageOnce|\bfetch\(|node:https?|child_process|anthropic|openai|spawn\(|execFile/);
      const fromCodex = named(source, "../codex");
      for (const name of fromCodex) expect(["CodexAbortedError", "CodexError", "type CodexRunMeta"], `${file}: ${name}`).toContain(name);
    }
  });

  it("the design CLI calls Codex only for JSON, the image CLI only the image call; both only inside the sandbox the preflight prepared", () => {
    // DEV-150: the direction CLI exactly as the design CLI (JSON only, no image)
    for (const file of [DESIGN_CLI, DIRECTION_CLI]) {
      const design = readFileSync(resolve(REPO, file), "utf8");
      expect(design.match(/runCodexJson\w*\(/g), file).toEqual(["runCodexJsonWithMeta("]);
      expect(design, file).not.toMatch(/image_generation|generateImageOnce|design-image|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile/);
    }
    expect(readFileSync(resolve(REPO, DIRECTION_CLI), "utf8")).toMatch(/const sandbox = ctx\.sandbox\(\);\n\s*if \(sandbox === null\) throw new Error\("no sandbox"\);\n\s*return runCodexJsonWithMeta\(\{ sandbox, \.\.\.o \}\);/);
    const image = readFileSync(resolve(REPO, IMAGE_CLI), "utf8");
    expect(image).not.toMatch(/runCodexJson|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile|SR_POC_|poc-approval-used|run-wagashi/);
    expect(named(image, `${L}/design-image/image-once`)).toEqual(["cleanupActiveImageCalls", "generateImageOnce"]);
    expect(named(image, `${L}/design-image/prompt`)).toEqual(["buildMockupPrompt", "loadPocInputs"]);
    // DEV-150: from phase2f only the DOM safety check, from the lane only the facts pack schema
    expect(named(image, `${L}/phase2f/prototype-safety`)).toEqual(["PrototypeUnsafe", "checkPrototype"]);
    expect(named(image, `${L}/three-methods/brief`)).toEqual(["FactsPack"]);
    expect(readFileSync(resolve(REPO, CLI_SHARED), "utf8")).toMatch(/prepareCodexSandbox\(\{ env, protectedPaths \}\)/);
  });

  it("the offline steps CLIs never reach Codex, the image tool, the sandbox or a process", () => {
    // DEV-150: the three-method steps CLI too
    for (const file of [STEPS_CLI, TM_STEPS_CLI]) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      expect(source, file).not.toMatch(/\/codex["']|runCodexJson|generateImageOnce|prepareCodexSandbox|bounded-process|design-image|phase2f-live-cli|\bfetch\(|node:https?|child_process|spawn\(|execFile|anthropic|openai/);
    }
  });

  it("is imported by nobody else (the CLIs are entry points; the shared helper only by the real-call CLIs)", () => {
    expect(git(["grep", "--untracked", "-lE", "phase2f-live|phase2f-design|phase2f-image|phase2f-steps|phase2f-direction", "--", "lib", "app", "components", "scripts", `:!${LIB}`])).toEqual([DESIGN_CLI, IMAGE_CLI, CLI_SHARED, STEPS_CLI, DIRECTION_CLI, TM_STEPS_CLI].sort());
    expect(git(["grep", "--untracked", "-lE", "phase2f-live-cli", "--", "lib", "app", "components", "scripts"])).toEqual([DESIGN_CLI, IMAGE_CLI, DIRECTION_CLI].sort());
    // DEV-150: no package script, workflow, unit file or other script starts the new entries (run by hand only)
    expect(git(["grep", "--untracked", "-lE", "(tsx|node|npx|bun|sh)\\b[^\\n]*(phase2f-direction|three-methods-steps)", "--", ".", ":!tests/**", ":!docs/**", ":!.ai/**"])).toEqual([]);
  });

  it("only the image CLI names the image PoC's code; no file here names its approval, pin, ledger or output", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      if (file !== IMAGE_CLI) expect(source, file).not.toMatch(/design-image/);
      expect(source, file).not.toMatch(/sr-design-image-poc|poc-approval-used|design-library\/poc|wagashi-a-v4-20261025-01|4e34f760/);
    }
  });
});
