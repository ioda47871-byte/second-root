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
  [`${LIB}/render-prototype.ts`]: ["playwright", "../comp-impl/page", "../comp-impl/render"],
  [`${LIB}/decode-check.ts`]: ["../worker/png-paint"],
  [`${LIB}/prompt.ts`]: ["node:crypto", "zod", "../artifact/schema", "../profile"],
  [`${LIB}/runner.ts`]: ["node:crypto", "node:fs/promises", "node:path", "node:zlib", "playwright", "../artifact/intake", "../artifact/schema", "./decode-check", "./prompt", "./prototype-safety", "./render-prototype"],
  [`${LIB}/compare-sheet.ts`]: ["../artifact/intake", "./runner"],
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
    expect(git(["grep", "--untracked", "-lE", "design-agent/phase2f([\"'`/]|$)|[\"'`]\\.{1,2}/phase2f[\"'`/]", "--", "lib", "app", "components", "scripts", `:!${LIB}`])).toEqual([CLI, DESIGN_STEP, STEPS].sort());
    const source = readFileSync(resolve(REPO, DESIGN_STEP), "utf8");
    const fromPhase2f = [...source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']([^"']*\/phase2f\/[^"']*)["']/g)].map((m) => [m[3], m[2]!.split(",").map((n) => n.trim()).filter(Boolean).sort()]);
    expect(fromPhase2f).toEqual([["../../lib/design-agent/phase2f/prompt", ["DesignBrief", "buildDesignPrompt", "codexDesignJsonSchema"]]]);
    expect(specifiers(source).filter((s) => s.includes("/phase2f/"))).toEqual(["../../lib/design-agent/phase2f/prompt"]);
  });

  it("the offline steps CLI (DEV-117, owner-approved exact path) takes only these names from phase2f", () => {
    const source = readFileSync(resolve(REPO, STEPS), "utf8");
    const fromPhase2f = [...source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']([^"']*\/phase2f\/[^"']*)["']/g)].map((m) => [m[3], m[2]!.split(",").map((n) => n.trim()).filter(Boolean).sort()]);
    expect(fromPhase2f).toEqual([
      ["../../lib/design-agent/phase2f/compare-sheet", ["sheetEntry", "sheetMarkdown", "type SheetCall", "type SheetEntry"]],
      ["../../lib/design-agent/phase2f/prompt", ["DesignBrief"]],
      ["../../lib/design-agent/phase2f/runner", ["PortStop", "packageConceptRun", "prerenderRoute", "runPrototypeRoute", "type AssetPort", "type DesignPort", "type RunResult"]],
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
