import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-147 (Issue #177 E, MOCK ONLY, offline, report-only): the integration check lives in tests only. Its report helper
// imports nothing but node:crypto and the existing phases' types, and nothing outside this directory imports it (no
// lib, app, components or scripts). Wiring it into the runner, the worker or the loop is a separate owner approval.

const REPO = resolve(__dirname, "../../../..");
const DIR = "tests/unit/design-agent/integration-check";

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

describe("isolation of the integration check (MOCK)", () => {
  it("holds exactly its files", () => {
    expect(readdirSync(resolve(REPO, DIR)).sort()).toEqual(["integration-check.test.ts", "integration-check.ts", "isolation.test.ts"]);
  });

  it("the report helper imports only node:crypto and types, and reaches no browser, process, network, file or model", () => {
    const source = readFileSync(resolve(REPO, DIR, "integration-check.ts"), "utf8");
    expect(specifiers(source)).toEqual(["node:crypto", "@/lib/design-agent/autofix-mock/run", "@/lib/design-agent/impl-lane/impl-compare", "@/lib/design-agent/phase2f/mobile-quality"]);
    // only type imports from lib: the helper runs none of the phases itself
    for (const line of source.split("\n").filter((l) => /^import .*@\/lib\//.test(l))) expect(line).toMatch(/^import type /);
    // the code, without its comments and string literals (the report's notes name what it never uses, e.g. Codex);
    // the import specifiers are pinned above
    const code = source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    // a name read through a string (globalThis["process"], x["readFile"]) would hide from the word check: none at all
    expect(code).not.toMatch(/\[\s*""\s*\]|\[\s*'|\[\s*`/);
    expect(code).not.toMatch(/child_process|\bspawn\(|execFile|\bfetch\(|node:(fs|https?|net|os|path)|playwright|codex|anthropic|openai|worker\/|bridge|jail|process\.|writeFile|readFile|\beval\(|new Function/i);
  });

  it("is imported by no code: only its own tests use it", () => {
    const g = spawnSync("git", ["grep", "--untracked", "-l", "integration-check", "--", "lib", "app", "components", "scripts", "proxy.ts", "supabase"], { cwd: REPO, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
  });
});
