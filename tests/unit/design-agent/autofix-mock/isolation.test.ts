import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-146 (Issue #177 D, MOCK ONLY, opt-in): the limited autofix lane is wired into nothing. Its render, checks and
// identity are ports its tests inject; it imports only its own files, and no code (lib, app, components, scripts)
// imports it. Using it for real (the Phase 2f runner, the worker, the repair loop) is a separate owner approval.

const REPO = resolve(__dirname, "../../../..");
const LANE = "lib/design-agent/autofix-mock";
const FILES: Record<string, string[]> = {
  "locate.ts": [],
  "patches.ts": [],
  "run.ts": ["./patches"],
};

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

describe("isolation of the limited autofix mock", () => {
  it("holds exactly its files, each importing only what it needs", () => {
    expect(readdirSync(resolve(REPO, LANE)).sort()).toEqual(Object.keys(FILES).sort());
    for (const [file, allowed] of Object.entries(FILES)) expect(specifiers(readFileSync(resolve(REPO, LANE, file), "utf8")), file).toEqual(allowed);
  });

  it("reaches no browser, process, network, file, model, Codex, worker or Phase 2f module", () => {
    for (const file of Object.keys(FILES)) {
      // the code, without its comments (which name what the lane refuses, e.g. a Codex prototype)
      const source = readFileSync(resolve(REPO, LANE, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/child_process|\bspawn\(|execFile|\bfetch\(|node:|playwright|codex|anthropic|openai|phase2f|worker\/|bridge|jail|process\.|writeFile|readFile|\brequire\(|\beval\(|new Function/i);
    }
  });

  it("is imported by no code: only its tests use it", () => {
    const g = spawnSync("git", ["grep", "--untracked", "-l", "autofix-mock", "--", "lib", "app", "components", "scripts", "proxy.ts", "supabase", `:!${LANE}/**`], { cwd: REPO, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
  });
});
