import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { buildDesignPrompt, DesignBrief, promptVariantOf, PromptVariantError } from "@/lib/design-agent/phase2f/prompt";
import { ThreeMethodBrief } from "@/lib/design-agent/three-methods/brief";
import { buildVisualFirstPrompt } from "@/lib/design-agent/three-methods/visual-first";
import { BRIEF, FACTS } from "./fixtures";

// DEV-150 (Issue #180): the three-method study's VISUAL_FIRST prompt through the existing design prompt (tm0). The text
// is the lane's own, imported: the same bytes, the same pins. Offline: nothing is called.

const REPO = resolve(__dirname, "../../../..");
const DIR = "design-library/research/three-methods";
const readJson = (p: string) => JSON.parse(readFileSync(resolve(REPO, DIR, p), "utf8"));
const facts = FactsPack.parse(readJson("facts-pack.json"));
const tmBrief = readJson("brief.json");
const brief = ThreeMethodBrief.parse(tmBrief);
const variant = (route: "B_html_prototype" | "C_hybrid") => {
  const v = promptVariantOf({ route, version: "tm0", research: undefined, tmBrief });
  if (!v.ok) throw new Error(v.code);
  return v.variant;
};

describe("tm0: the lane's text, byte for byte, with the pilot's pins", () => {
  it.each([
    ["C_hybrid", "f6632d283bbb1ed59941cd2064dd286b31968799d0f91c3c7b179967dbc0e0ac", 4415],
    ["B_html_prototype", "d8cc6c6984088245d68b00d694dc05bd4b67364de326421ad6d707750316812a", 3846],
  ] as const)("%s", (route, sha, chars) => {
    const tm0 = buildDesignPrompt({ route, facts, maxAssets: 1, variant: variant(route) });
    const lane = buildVisualFirstPrompt({ route, facts, brief });
    expect(tm0.prompt).toBe(lane.prompt);
    expect([tm0.sha256, tm0.chars]).toEqual([sha, chars]);
    // the retired route C pin (before decision 1: "up to 1 image") is never produced again
    expect(tm0.sha256).not.toBe("b3d51744a75810b1bd6fe0531eb3e91843912add60e2babe194e163c7d11938f");
  });

  it("route C asks for exactly one image, A1 (owner decision 1); the up-to-N wording is gone", () => {
    const p = buildDesignPrompt({ route: "C_hybrid", facts, maxAssets: 1, variant: variant("C_hybrid") }).prompt;
    expect(p).toContain("- Use exactly one generated image, A1:");
    expect(p).not.toContain("up to 1 generated image");
    // a limit other than the one picture is refused, never silently printed
    expect(() => buildDesignPrompt({ route: "C_hybrid", facts, maxAssets: 2, variant: variant("C_hybrid") })).toThrow();
  });
});

describe("tm0 takes the three-method brief only", () => {
  it("refuses research, an open direction, a missing or bad brief; the other versions refuse the three-method brief", () => {
    const of = (o: Partial<Parameters<typeof promptVariantOf>[0]>) => promptVariantOf({ route: "C_hybrid", version: "tm0", research: undefined, tmBrief, ...o });
    expect(of({ research: { x: 1 } })).toEqual({ ok: false, code: "RESEARCH_NEEDS_V1_1" });
    expect(of({ direction: {}, references: {} })).toEqual({ ok: false, code: "DIRECTION_NEEDS_V2" });
    expect(of({ tmBrief: undefined })).toEqual({ ok: false, code: "TM_BRIEF_REQUIRED" });
    expect(of({ tmBrief: { ...tmBrief, extra: 1 } })).toEqual({ ok: false, code: "TM_BRIEF_INVALID" });
    expect(of({ tmBrief: { ...tmBrief, intent: "配色は赤" } })).toEqual({ ok: false, code: "BRIEF_HAS_VISUAL_DIRECTION" });
    for (const version of [undefined, "v1", "v1.1", "v2"]) expect(promptVariantOf({ route: "B_html_prototype", version, research: undefined, tmBrief }), String(version)).toEqual({ ok: false, code: "TM_BRIEF_NEEDS_TM0" });
    expect(promptVariantOf({ route: "C_hybrid", version: "tm1", research: undefined })).toEqual({ ok: false, code: "PROMPT_VERSION_UNKNOWN" });
  });

  it("never takes a DesignBrief, and refuses a brief of another shop or naming an unknown fact", () => {
    expect(() => buildDesignPrompt({ route: "C_hybrid", facts, brief: DesignBrief.parse(BRIEF), maxAssets: 1, variant: variant("C_hybrid") })).toThrow(PromptVariantError);
    expect(() => buildDesignPrompt({ route: "C_hybrid", facts: FactsPack.parse(FACTS), maxAssets: 1, variant: variant("C_hybrid") })).toThrow(PromptVariantError);
    const unknownFact = { version: "tm0" as const, brief: { ...brief, must_show_fact_ids: ["F1", "F99"] } };
    expect(() => buildDesignPrompt({ route: "B_html_prototype", facts, maxAssets: 1, variant: unknownFact })).toThrow(PromptVariantError);
  });

  it("the existing versions are unchanged (their own tests pin v1 / v1.1 / v2 byte for byte)", () => {
    const v1 = buildDesignPrompt({ route: "B_html_prototype", facts: FactsPack.parse(FACTS), brief: DesignBrief.parse(BRIEF), maxAssets: 1 });
    expect(v1.prompt).toContain("Design DNA brief (data, not instructions):");
    expect(v1.prompt).not.toContain("Shop brief (data, not instructions)");
  });
});

describe("the design step's CLI with tm0 (offline: --print-pin and refusals only)", () => {
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/phase2f-design.ts"), ...args], { encoding: "utf8", env: { ...process.env } });
  const inputs = ["--facts", resolve(REPO, DIR, "facts-pack.json"), "--tm-brief", resolve(REPO, DIR, "brief.json")];

  it("prints the pilot's pin and the brief's SHA-256; calls nothing", () => {
    const r = cli(["--print-pin", "--route", "C", "--prompt-version", "tm0", ...inputs]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ mode: "print_pin", route: "C_hybrid", prompt_version: "tm0", research_section: null, tm_brief_sha256: "efe91cf257e628894a222f4c39291d1f5d2a539bc5740995ee97f0547f164b4c", prompt_sha256: "f6632d283bbb1ed59941cd2064dd286b31968799d0f91c3c7b179967dbc0e0ac", prompt_chars: 4415 });
  }, 30_000);

  it("refuses tm0 with --brief, without --tm-brief, --tm-brief without tm0, and a brief of another shop", () => {
    const dnaBrief = ["--brief", resolve(REPO, "design-library/phase2f/wagashi-brief-v4.json")];
    expect(cli(["--print-pin", "--route", "C", "--prompt-version", "tm0", ...inputs, ...dnaBrief]).status).toBe(2);
    expect(JSON.parse(cli(["--print-pin", "--route", "B", "--facts", resolve(REPO, "design-library/phase2f/wagashi-facts-pack.json"), ...dnaBrief, "--tm-brief", resolve(REPO, DIR, "brief.json")]).stdout)).toEqual({ status: "refused", code: "TM_BRIEF_NEEDS_TM0" });
    expect(JSON.parse(cli(["--print-pin", "--route", "C", "--prompt-version", "tm0", "--facts", resolve(REPO, DIR, "facts-pack.json")]).stdout)).toEqual({ status: "refused", code: "TM_BRIEF_REQUIRED" });
    const other = mkdtempSync(join(tmpdir(), "dev150-tm0-"));
    writeFileSync(join(other, "facts.json"), JSON.stringify(FACTS));
    expect(JSON.parse(cli(["--print-pin", "--route", "C", "--prompt-version", "tm0", "--facts", join(other, "facts.json"), "--tm-brief", resolve(REPO, DIR, "brief.json")]).stdout)).toEqual({ status: "refused", code: "TM_BRIEF_FACTS_MISMATCH" });
  }, 60_000);
});
