import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-114: the Design Artifact intake is offline checking only. It imports what reading files, hashing and
// checking PNGs needs: no Codex, model, browser, network, worker, pipeline, comp-impl, sales or database code,
// no writes and no processes. Only its own CLI imports it.

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/artifact";
const CLI = "scripts/design-artifact/intake.ts";

const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", LIB, CLI]).filter((f) => /\.(ts|tsx|mts|cts|js|mjs)$/.test(f));

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

const ALLOWED: Record<string, string[]> = {
  [`${LIB}/schema.ts`]: ["zod"],
  [`${LIB}/intake.ts`]: ["node:crypto", "node:fs", "node:fs/promises", "node:path", "node:zlib", "./schema"],
  [CLI]: ["node:path", "../../lib/design-agent/artifact/intake"],
};

describe("isolation of the Design Artifact intake", () => {
  it("has exactly the expected files", () => {
    expect(files).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only what offline checking needs", (file, allowed) => {
    const named = specifiers(readFileSync(resolve(REPO, file), "utf8"));
    expect(named.filter((s) => !allowed.includes(s))).toEqual([]);
  });

  it("opens files read-only and never writes, removes, renames, spawns or fetches", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs\/promises["']/g)) {
        expect(m[1]!.split(",").map((s) => s.trim()).filter(Boolean).sort(), file).toEqual(["lstat", "open", "readdir", "readlink", "realpath"]);
      }
      expect(source, file).not.toMatch(/\b(writeFile|appendFile|mkdir|rmSync|rm\(|rename|copyFile|cp\(|unlink|createWriteStream|symlink|chmod|fetch\(|spawn|exec\w*\(|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND)/);
      for (const m of source.matchAll(/\bopen\(([^)]*)\)/g)) expect(m[1], file).toMatch(/O_RDONLY/);
    }
  });

  it("is imported only by its own CLI and the Phase 2f runner files (exact paths)", () => {
    const hits = git(["grep", "--untracked", "-lE", "design-agent/artifact|[\"'`]\\.{1,2}/artifact[\"'`/]", "--", "lib", "app", "components", "scripts", `:!${LIB}`]);
    expect(hits).toEqual(
      [
        CLI,
        "scripts/design-artifact/phase2f.ts",
        // DEV-116 (owner-approved exact path): the design step reads the facts pack with its schema
        "scripts/design-artifact/phase2f-design.ts",
        // DEV-117 (owner-approved exact path): the offline steps read the facts pack with its schema
        "scripts/design-artifact/phase2f-steps.ts",
        // DEV-121: the comparison baseline checker reuses the artifact's Generation, Text and VIEWPORTS (pure, no I/O)
        "lib/design-agent/phase2f/baseline.ts",
        // DEV-128 (Issue #159, Phase 2e research): the implementation lane runs the intake and copies its hand-off only
        "lib/design-agent/impl-lane/handoff.ts",
        // DEV-139 (Issue #177 A): the offline comparison parses the lane's artifact record with the schema only (no intake)
        "lib/design-agent/impl-lane/impl-compare.ts",
        "lib/design-agent/phase2f/compare-sheet.ts",
        "lib/design-agent/phase2f/prompt.ts",
        "lib/design-agent/phase2f/runner.ts",
      ].sort(),
    );
  });
});
