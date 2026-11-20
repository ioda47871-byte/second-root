import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #293 P1: the IMAGE_FIRST contract is offline. It never calls Codex, a model, the image tool, the network or a
// process; it never writes a file; only its own check CLI imports it; and each file imports exactly these modules.

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/image-first";
const CLI = "scripts/design-artifact/image-first-check.ts";
/** Issue #293 P3 (preparation): the read-only pin printer of the prompts (offline, like the check CLI). */
const PIN_CLI = "scripts/design-artifact/image-first-prompt.ts";
/** Issue #293 P3 (preparation, owner-run after approval only): the real-call entry and its step (checked by the phase2f-live isolation test). */
const GENERATE_IMPORTERS = ["lib/design-agent/phase2f-live/full-page-call.ts", "scripts/design-artifact/image-first-generate.ts"];
/** Issue #298 P1: the worker adapter rebuilds the d3 plan from the inputs at the approved commit (prompt.ts only; phase2f-live isolation test). */
const WORKER_IMPORTERS = [
  "lib/design-agent/imagefirst-worker/cycle.ts",
  // Issue #302 (exact path): the manual Claude CLI audit reads the facts pack and the d3 direction text through
  // loadPromptInputs only (every pin applies); it builds no plan and starts nothing (imagefirst-worker/claude-audit-rubric.test.ts)
  "lib/design-agent/imagefirst-worker/claude-audit.ts",
];

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

const ALLOWED: Record<string, string[]> = {
  [`${LIB}/record.ts`]: ["../design-image/capability", "zod"],
  [`${LIB}/pixels.ts`]: ["../worker/png-paint", "node:zlib"],
  [`${LIB}/composition.ts`]: ["../comp-impl/similarity", "./pixels", "./record"],
  [`${LIB}/owner-gate.ts`]: ["../comp-impl/bundle", "./record", "node:crypto", "zod"],
  [`${LIB}/validate.ts`]: ["../design-image/png", "../identity/identity-lock", "../quality-pipeline/copy-record", "../quality-pipeline/facts-pack", "./composition", "./owner-gate", "./pixels", "./record", "node:crypto"],
  [`${LIB}/builder.ts`]: ["../design-image/png", "../impl-lane/impl-compare", "./record", "./validate", "node:crypto", "node:fs/promises", "node:path"],
  [`${LIB}/adapter.ts`]: ["../impl-lane/compare", "../impl-lane/impl-compare", "./record", "./validate", "node:crypto", "playwright"],
  // P3 preparation: the deterministic prompt builder (pure apart from an injected reader)
  [`${LIB}/prompt.ts`]: ["../quality-pipeline/copy-record", "../quality-pipeline/facts-pack", "./record", "node:crypto"],
  [PIN_CLI]: ["../../lib/design-agent/image-first/prompt", "node:fs/promises", "node:path"],
  [CLI]: ["../../lib/design-agent/image-first/builder", "../../lib/design-agent/image-first/validate", "../../lib/design-agent/impl-lane/impl-compare", "node:fs/promises", "node:path"],
};

describe("isolation of the IMAGE_FIRST contract (offline, read only)", () => {
  it("every file of the module is listed, and each imports exactly its allowed modules", () => {
    expect(readdirSync(resolve(REPO, LIB)).sort()).toEqual(Object.keys(ALLOWED).filter((f) => f.startsWith(LIB)).map((f) => f.slice(LIB.length + 1)).sort());
    for (const [file, allowed] of Object.entries(ALLOWED)) expect([...new Set(specifiers(readFileSync(resolve(REPO, file), "utf8")))].sort(), file).toEqual([...allowed].sort());
  });

  it("from the image PoC's code it takes only the PNG check and the outcome vocabulary (never the image call)", () => {
    const named = (file: string, from: string) =>
      [...readFileSync(resolve(REPO, file), "utf8").matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].filter((m) => m[2] === from).flatMap((m) => m[1]!.split(",").map((s) => s.trim()).filter(Boolean)).sort();
    expect(named(`${LIB}/record.ts`, "../design-image/capability")).toEqual(["IMAGE_OUTCOMES"]);
    expect(named(`${LIB}/validate.ts`, "../design-image/png")).toEqual(["MOCKUP_PNG_LIMITS", "checkPng"]);
    expect(named(`${LIB}/builder.ts`, "../design-image/png")).toEqual(["MOCKUP_PNG_LIMITS", "checkPng"]);
    expect(named(`${LIB}/builder.ts`, "../impl-lane/impl-compare")).toEqual(["readInside"]);
    expect(named(`${LIB}/adapter.ts`, "../impl-lane/impl-compare")).toEqual(["SECTION_ATTRIBUTES", "renderImplementation", "type Implementation", "type SectionAttribute"]);
  });

  it("never calls a model, Codex, the image tool, the network or a process, and never writes, removes or renames a file", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/anthropic|openai|OPENAI|ANTHROPIC|\bfetch\(|node:https?|node:net|child_process|spawn|execFile|runCodexJson|generateImage|image-once|prepareCodexSandbox|\/codex["']|\/sandbox["']|bounded-process/);
      expect(source, file).not.toMatch(/\b(writeFile|appendFile|mkdir|mkdtemp|rmSync|rm\(|rename|copyFile|cp\(|unlink|createWriteStream|symlink|chmod|O_WRONLY|O_RDWR|O_CREAT)/);
    }
  });

  it("is imported only by its own check CLI (P3: and the pin printer and the gated real-call entry); no package script, workflow or other script starts that CLI", () => {
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "design-agent/image-first|image-first/(record|validate|builder|adapter|owner-gate|composition|pixels|prompt)", "--", "lib", "app", "components", "scripts", `:!${LIB}`], { cwd: REPO, encoding: "utf8" });
    expect(g.stdout.trim().split("\n").filter(Boolean)).toEqual([...GENERATE_IMPORTERS, ...WORKER_IMPORTERS, CLI, PIN_CLI].sort());
    const starts = spawnSync("git", ["grep", "--untracked", "-lE", "(tsx|node|npx|bun|sh)\\b[^\\n]*image-first-check", "--", ".", ":!tests/**", ":!docs/**", ":!.ai/**", `:!${CLI}`], { cwd: REPO, encoding: "utf8" });
    expect([starts.status, starts.stdout.trim()]).toEqual([1, ""]);
  });

  it("never names an earlier same-shop design, the sealed three-method mapping, or a used approval", () => {
    // the patterns are built here so that this file does not match itself
    const banned = new RegExp(
      [["hoshi", "gama"], ["ほし", "窯"], ["hea", "rth"], ["d2", "-v"], ["map", "ping.json"], ["map", "ping.tar"], ["wagashi-a-v4-", "20261025-01"], ["HOSHIGAMA_", "APPROVAL"]].map((p) => p.join("")).join("|"),
      "i",
    );
    for (const file of Object.keys(ALLOWED)) expect(readFileSync(resolve(REPO, file), "utf8"), file).not.toMatch(banned);
    // the runbook may name the shop for the later comparison, never the sealed mapping or a used approval
    const sealed = new RegExp([["map", "ping.json"], ["map", "ping.tar"], ["wagashi-a-v4-", "20261025-01"], ["HOSHIGAMA_", "APPROVAL"]].map((p) => p.join("")).join("|"), "i");
    expect(readFileSync(resolve(REPO, "docs/design/image-first-handoff.md"), "utf8")).not.toMatch(sealed);
  });
});
