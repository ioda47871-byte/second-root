import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 2f-2 (DEV-116, DEV-117): the real-call steps. The modules start no process and open no connection: Codex and
// the image tool are reached only through the functions the two real-call CLIs pass in. The offline steps CLI never
// reaches Codex, the image tool or the sandbox. Only the image CLI touches the image PoC's code, and only its common
// image call and prompt builder. Nothing else imports any of it.

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/phase2f-live";
const DESIGN_CLI = "scripts/design-artifact/phase2f-design.ts";
const IMAGE_CLI = "scripts/design-artifact/phase2f-image.ts";
const STEPS_CLI = "scripts/design-artifact/phase2f-steps.ts";
const CLI_SHARED = "scripts/design-artifact/phase2f-live-cli.ts";
const CLIS = [DESIGN_CLI, IMAGE_CLI, STEPS_CLI, CLI_SHARED];
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
  [`${LIB}/image-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../codex", "./ledger", "./steps"],
  [CLI_SHARED]: ["node:fs/promises", "node:os", "node:path", `${L}/bounded-process`, `${L}/codex`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`, `${L}/protected-paths`, `${L}/sandbox`, `${L}/worker/env`],
  [DESIGN_CLI]: ["node:fs/promises", "node:path", `${L}/artifact/schema`, `${L}/codex`, `${L}/phase2f/prompt`, `${L}/phase2f-live/design-call`, `${L}/phase2f-live/ledger`, "./phase2f-live-cli"],
  [IMAGE_CLI]: ["node:fs/promises", "node:os", "node:path", `${L}/design-image/image-once`, `${L}/design-image/prompt`, `${L}/phase2f-live/image-call`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`, "./phase2f-live-cli"],
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
    const design = readFileSync(resolve(REPO, DESIGN_CLI), "utf8");
    expect(design.match(/runCodexJson\w*\(/g)).toEqual(["runCodexJsonWithMeta("]);
    expect(design).not.toMatch(/image_generation|generateImageOnce|design-image|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile/);
    const image = readFileSync(resolve(REPO, IMAGE_CLI), "utf8");
    expect(image).not.toMatch(/runCodexJson|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile|SR_POC_|poc-approval-used|run-wagashi/);
    expect(named(image, `${L}/design-image/image-once`)).toEqual(["cleanupActiveImageCalls", "generateImageOnce"]);
    expect(named(image, `${L}/design-image/prompt`)).toEqual(["buildMockupPrompt", "loadPocInputs"]);
    expect(readFileSync(resolve(REPO, CLI_SHARED), "utf8")).toMatch(/prepareCodexSandbox\(\{ env, protectedPaths \}\)/);
  });

  it("the offline steps CLI never reaches Codex, the image tool, the sandbox or a process", () => {
    const source = readFileSync(resolve(REPO, STEPS_CLI), "utf8");
    expect(source).not.toMatch(/\/codex["']|runCodexJson|generateImageOnce|prepareCodexSandbox|bounded-process|design-image|\bfetch\(|node:https?|child_process|spawn\(|execFile|anthropic|openai/);
  });

  it("is imported by nobody else (the three CLIs are entry points; the shared helper only by the two real-call CLIs)", () => {
    expect(git(["grep", "--untracked", "-lE", "phase2f-live|phase2f-design|phase2f-image|phase2f-steps", "--", "lib", "app", "components", "scripts", `:!${LIB}`])).toEqual([DESIGN_CLI, IMAGE_CLI, CLI_SHARED, STEPS_CLI].sort());
    expect(git(["grep", "--untracked", "-lE", "phase2f-live-cli", "--", "lib", "app", "components", "scripts"])).toEqual([DESIGN_CLI, IMAGE_CLI].sort());
  });

  it("only the image CLI names the image PoC's code; no file here names its approval, pin, ledger or output", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      if (file !== IMAGE_CLI) expect(source, file).not.toMatch(/design-image/);
      expect(source, file).not.toMatch(/sr-design-image-poc|poc-approval-used|design-library\/poc|wagashi-a-v4-20261025-01|4e34f760/);
    }
  });
});
