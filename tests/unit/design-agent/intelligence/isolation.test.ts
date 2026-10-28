import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-112: the Design Intelligence adapter is read-only research tooling. Only
// its own CLI imports it, and it imports only what reading JSON needs: no sales
// code, worker, pipeline, Codex, model API, network, database client, asset
// store, comp→site or design-image PoC, and no file writes or processes.

const REPO = resolve(__dirname, "../../../..");
const ADAPTER = "lib/design-agent/intelligence";
const CLI = "scripts/design-intelligence/brief.ts";

const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ADAPTER, "scripts/design-intelligence"]).filter((f) => /\.(ts|tsx|mts|cts|js|mjs)$/.test(f));

/** Every module specifier a file names: static, side-effect, re-export, dynamic import and require. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

/** The only modules the adapter and its CLI may name. */
const ALLOWED: Record<string, string[]> = {
  [`${ADAPTER}/corpus.ts`]: ["node:crypto", "node:fs/promises", "node:path", "zod"],
  [`${ADAPTER}/brief.ts`]: ["zod", "./corpus"],
  [CLI]: ["node:fs/promises", "node:path", "../../lib/design-agent/intelligence/brief", "../../lib/design-agent/intelligence/corpus"],
};

describe("isolation of the Design Intelligence adapter", () => {
  it("has exactly the expected files", () => {
    expect(files).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only what reading JSON needs", (file, allowed) => {
    const named = specifiers(readFileSync(resolve(REPO, file), "utf8"));
    expect(named.filter((s) => !allowed.includes(s))).toEqual([]);
  });

  it("reads files only (readFile), never writes, renames, copies, removes or opens for writing", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs\/promises["']/g)) {
        expect(m[1]!.split(",").map((s) => s.trim()).filter(Boolean), file).toEqual(["readFile"]);
      }
      expect(source, file).not.toMatch(/\b(writeFile|appendFile|mkdir|rmSync|rm\(|rename|copyFile|cp\(|unlink|createWriteStream|open\(|fetch\(|spawn|exec)\w*/);
    }
  });

  it("is imported only by its own CLI (nothing else in lib, app, components or scripts names it)", () => {
    const hits = git(["grep", "--untracked", "-lE", "design-agent/intelligence|[\"'`]\\.{1,2}/intelligence[\"'`/]", "--", "lib", "app", "components", "scripts", `:!${ADAPTER}`]);
    expect(hits).toEqual([CLI]);
  });
});
