import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-116: the Phase 2f-2 design step. Its modules start no process and open no connection: Codex is reached only
// through the function its one CLI passes in. Only that CLI imports them, and nothing here reaches the image PoC,
// the production worker's job code, the Phase 2f runner or the network.

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/phase2f-live";
const CLI = "scripts/design-artifact/phase2f-design.ts";
const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

const ALLOWED: Record<string, string[]> = {
  [`${LIB}/ledger.ts`]: ["node:fs", "node:fs/promises", "node:path"],
  [`${LIB}/design-call.ts`]: ["node:crypto", "node:fs", "node:fs/promises", "node:path", "../codex", "./ledger"],
  [CLI]: [
    "node:fs/promises",
    "node:os",
    "node:path",
    "../../lib/design-agent/artifact/schema",
    "../../lib/design-agent/bounded-process",
    "../../lib/design-agent/codex",
    "../../lib/design-agent/phase2f/prompt",
    "../../lib/design-agent/phase2f-live/design-call",
    "../../lib/design-agent/phase2f-live/ledger",
    "../../lib/design-agent/protected-paths",
    "../../lib/design-agent/sandbox",
    "../../lib/design-agent/worker/env",
  ],
};

describe("isolation of the Phase 2f-2 design step", () => {
  it("has exactly the expected files", () => {
    expect(git(["ls-files", "--cached", "--others", "--exclude-standard", "--", LIB, CLI]).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only what it needs", (file, allowed) => {
    expect(specifiers(readFileSync(resolve(REPO, file), "utf8")).filter((s) => !allowed.includes(s))).toEqual([]);
  });

  it("the modules start no process and open no connection (Codex is the function the CLI passes in)", () => {
    for (const file of [`${LIB}/ledger.ts`, `${LIB}/design-call.ts`]) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      expect(source, file).not.toMatch(/runCodexJson|prepareCodexSandbox|runBounded|\bfetch\(|node:https?|child_process|anthropic|openai|spawn\(|execFile/);
    }
    // the design call takes only types and the two error classes from codex.ts
    const call = readFileSync(resolve(REPO, `${LIB}/design-call.ts`), "utf8");
    expect([...call.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/codex["']/g)].map((m) => m[1]!.split(",").map((s) => s.trim()).sort())).toEqual([["CodexAbortedError", "CodexError", "type CodexRunMeta"]]);
  });

  it("the CLI calls Codex only for JSON (no image tool, no other entry) and only from inside the sandbox", () => {
    const source = readFileSync(resolve(REPO, CLI), "utf8");
    expect(source.match(/runCodexJson\w*\(/g)).toEqual(["runCodexJsonWithMeta("]);
    expect(source).toMatch(/prepareCodexSandbox\(\{ env, protectedPaths \}\)/);
    expect(source).not.toMatch(/image_generation|features\.|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile/);
  });

  it("is imported by nobody (the CLI is an entry point; its modules only by it)", () => {
    expect(git(["grep", "--untracked", "-lE", "phase2f-live|phase2f-design", "--", "lib", "app", "components", "scripts", `:!${LIB}`])).toEqual([CLI]);
  });

  it("never names the image PoC or its output", () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(readFileSync(resolve(REPO, file), "utf8"), file).not.toMatch(/design-image|sr-design-image-poc|poc-approval-used|design-library\/poc/);
    }
  });
});
