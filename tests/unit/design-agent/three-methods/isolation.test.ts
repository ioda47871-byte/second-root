import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pilotPins } from "@/lib/design-agent/three-methods/pins";

// DEV-143 (Issue #180): the three-method lane is EXPERIMENTAL and opt-in. It is pure (no file access except its CLI's
// reads, no process, no network, no Codex, no image tool, no ledger, no real port) and nothing imports it except its
// own offline pin CLI (exact path). Wiring it into a real entry is a separate owner approval.

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/three-methods";
const CLI = "scripts/research/three-methods-pins.ts";
const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
const lines = (s: string) => s.trim().split("\n").filter(Boolean).sort();

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

const ALLOWED: Record<string, string[]> = {
  // the one import from an existing module: the facts pack schema, the DNA part names and the safe text rule (pure)
  [`${LIB}/brief.ts`]: ["node:crypto", "zod", "../artifact/schema"],
  [`${LIB}/visual-first.ts`]: ["./brief"],
  [`${LIB}/direction.ts`]: ["zod", "./brief", "./ledger-proposal"],
  [`${LIB}/ledger-proposal.ts`]: ["zod", "./brief"],
  [`${LIB}/page-assets.ts`]: ["./brief"],
  [`${LIB}/pins.ts`]: ["./brief", "./direction", "./page-assets", "./visual-first"],
  [CLI]: ["node:fs/promises", "node:path", "../../lib/design-agent/three-methods/brief", "../../lib/design-agent/three-methods/pins"],
};
/** Module paths and calls that would reach Codex, a process, the network, a browser, a model, the image tool, the sandbox, the ledger or a live entry. */
const FORBIDDEN = /["'`][^"'`]*\/codex["'`]|runCodex\w*|prepareCodexSandbox|generateImageOnce|openLedger|child_process|\bfetch\(|node:(?:https?|net|dgram|worker_threads)|(?<!\.)\bspawn\w*\(|(?<!\.)\bexec(?:File|Sync)?\(|playwright|anthropic|openai|phase2f(?:-live)?\/|phase2f-(?:design|image|steps|live-cli)|design-image\/|\/sandbox["'`]|bounded-process|\/worker\/|systemctl/i;

describe("isolation of the three-method lane (experimental, opt-in)", () => {
  it("has exactly the expected files", () => {
    const files = lines(git(["ls-files", "--cached", "--others", "--exclude-standard", "--", LIB, "scripts/research"]).stdout).filter((f) => /\.(ts|tsx|mts|cts|js|mjs)$/.test(f));
    expect(files).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only what it needs, statically", (file, allowed) => {
    const source = readFileSync(resolve(REPO, file), "utf8");
    expect(specifiers(source).sort()).toEqual([...allowed].sort());
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(|export\s*\*|^\s*import\s*["'`]/m);
  });

  it("names no Codex, process, network, browser, model, image tool, sandbox, worker, ledger file or real entry (code, comments removed)", () => {
    for (const file of Object.keys(ALLOWED)) {
      const code = readFileSync(resolve(REPO, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(FORBIDDEN);
      expect(code, file).not.toMatch(/process\.env/);
    }
  });

  it("writes nothing: the lane has no file access at all; the CLI only reads (readFile)", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      expect(source, file).not.toMatch(/\b(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|truncate|open|createWriteStream|symlink|chmod)\w*\(/);
      if (file !== CLI) expect(specifiers(source).some((s) => s.startsWith("node:fs")), file).toBe(false);
    }
    const cli = readFileSync(resolve(REPO, CLI), "utf8");
    expect([...cli.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs\/promises["']/g)].map((m) => m[1]!.trim())).toEqual(["readFile"]);
  });

  it("is imported by nothing in lib, app, components, scripts, proxy.ts or supabase except its own CLI (exact path)", () => {
    // any importer, absolute or relative; git grep exits 1 when nothing matches (an error is 128, never a pass)
    const g = git(["grep", "--untracked", "-lE", "design-agent/three-methods|[\"'`]\\.{1,2}/three-methods[\"'`/]|three-methods-pins", "--", "lib", "app", "components", "scripts", "proxy.ts", "supabase", `:!${LIB}/**`]);
    expect([g.status, g.stdout.trim()]).toEqual([0, CLI]);
    // and no package script, workflow or unit file starts the CLI (it is run by hand only)
    const h = git(["grep", "--untracked", "-lE", "three-methods-pins", "--", "package.json", ".github", "ops", "scripts", `:!${CLI}`]);
    expect([h.status, h.stdout.trim()]).toEqual([1, ""]);
  });
});

describe("the offline pin CLI", () => {
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, CLI), ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv });
  const readJson = (p: string) => JSON.parse(readFileSync(resolve(REPO, "design-library/research/three-methods", p), "utf8"));

  it("prints the same pins as the lane, says it called nothing, and exits 0", () => {
    const r = cli(["--print-pin"]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    const p = pilotPins({ facts: readJson("facts-pack.json"), brief: readJson("brief.json") });
    if (!p.ok) throw new Error(p.code);
    expect(out).toMatchObject({ mode: "print_pin", lane: "three_methods_experimental", calls_made: 0, pins: p.pins });
    expect(out.inputs.facts_pack_sha256).toBe("e63d925a1e1cdae46502d9e2a1fc2745eb69a47e65df7ba51fdd9036d04597c0");
  }, 60_000);

  it("prints a page's picture pin", () => {
    const r = cli(["--print-pin", "--layout-page", "tests/unit/design-agent/three-methods/fixtures/mock-layout-page.html"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).pins.map((p: { id: string }) => p.id)).toContain("LAYOUT_FIRST.asset.A1");
  }, 60_000);

  it("refuses anything but printing pins (no flag can make a call), with exit 2", () => {
    for (const args of [[], ["--print-pin", "--print-pin"], ["--print-pin", "--approval-id", "x"], ["--print-pin", "--human-approval-confirmed"], ["--print-pin", "--out", "x"], ["--print-pin", "--layout-page"], ["--print-pin", "--layout-page", "a", "--layout-page", "b"], ["--route", "B"]]) {
      const r = cli(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(JSON.parse(r.stdout), args.join(" ")).toEqual({ status: "refused", code: "USAGE" });
    }
    expect(JSON.parse(cli(["--print-pin", "--direction-page", "/nonexistent/page.html"]).stdout)).toEqual({ status: "refused", code: "INPUT_UNREADABLE" });
  }, 120_000);
});
