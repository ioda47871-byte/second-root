import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack, Generation } from "@/lib/design-agent/artifact/schema";
import { BaselineError, checkBaseline } from "@/lib/design-agent/phase2f/baseline";
import { buildDesignPrompt, DesignBrief } from "@/lib/design-agent/phase2f/prompt";

// DEV-121: the route B baseline for the fictional wagashi shop, without research. A record of one run, not an artifact.

const REPO = resolve(__dirname, "../../../..");
const FILE = "design-library/phase2f/baselines/wagashi-b-noresearch-20261029-02.json";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as Json;
const baseline = () => read(FILE);
const codeOf = (j: unknown) => {
  try {
    checkBaseline(j);
    return "ok";
  } catch (e) {
    return e instanceof BaselineError ? e.code : String(e);
  }
};

describe("the wagashi route B baseline (no research)", () => {
  it("records the run as reported: generated, package stopped, no artifact, provisional fail, owner pending", () => {
    expect(checkBaseline(baseline())).toEqual({
      baseline_id: "wagashi-b-noresearch-20261029-02",
      research_used: false,
      formal_artifact_passed: false,
      owner_decision: "pending",
      mobile_overflow_px: 23,
    });
    const b = baseline();
    expect(b.generation).toMatchObject({ approval_id: "wagashi-b-design-20261029-02", run_id: "p2f-6976521272bcf864", tool_version: "0.159.0", model_reported: "gpt-6.1-sol", worker_commit: "f8ebaf734522e31305b138748ed381fc91c9f983", status: "succeeded" });
    expect(b.package).toEqual({ status: "stopped", code: "CODEX_ASSETS_ON_ROUTE_B", class: "output", artifact_created: false });
    expect(b.preview.images.desktop_1440).toMatchObject({ width: 1440, height: 2240, bytes: 129373, sha256: "2e1c3da2a9acad767657e839310f50027a18385154c6487d9cf9af13102c1b61" });
    expect(b.preview.images.mobile_390).toMatchObject({ width: 390, height: 2590, bytes: 86618, sha256: "ec79cca85148f0388223f6d96b677204757e5d91e16a2dc3ea6c4666e6774cae", scroll_width: 413 });
    expect(b.preview).toMatchObject({ kind: "manual_preview_not_an_artifact_render", answer_modified: false, preview_only_changes: ["tel_links_disabled"] });
    expect(b.quality.provisional_evaluation).toEqual({ by: "chatgpt", verdict: "fail", issues: ["vertical_text_overlap", "insufficient_product_expression", "mobile_horizontal_overflow"] });
  });

  it("agrees with the Design Artifact and the inputs on the repository", () => {
    const b = baseline();
    // the generation facts are the Design Artifact's own Generation (same meaning, same checks)
    expect(Generation.safeParse(b.generation).success).toBe(true);
    // the recorded prompt is the one the facts pack and brief on the repository build today
    const built = buildDesignPrompt({ route: "B_html_prototype", facts: FactsPack.parse(read(b.inputs.facts_pack)), brief: DesignBrief.parse(read(b.inputs.brief)), maxAssets: 1 });
    expect([built.sha256, built.chars]).toEqual([b.inputs.prompt_sha256, b.inputs.prompt_chars]);
    // the stop code is one the runner really uses for route B
    expect(readFileSync(resolve(REPO, "lib/design-agent/phase2f/runner.ts"), "utf8")).toContain(`stopped("${b.package.code}", "${b.package.class}"`);
  });

  it("never lets a provisional verdict, a hand-made preview or a stopped package pass for more than it is", () => {
    const set = (path: string[], value: unknown) => {
      const j = baseline();
      let o = j;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path.at(-1)!] = value;
      return j;
    };
    // a stopped package made no artifact and cannot pass
    expect(codeOf(set(["formal_artifact_passed"], true))).toBe("BASELINE_INVALID");
    expect(codeOf(set(["package", "artifact_created"], true))).toBe("BASELINE_INVALID");
    expect(codeOf(set(["package", "code"], null))).toBe("BASELINE_INVALID");
    // the hand-made preview is not the artifact's render
    expect(codeOf(set(["preview", "kind"], "artifact_render"))).toBe("BASELINE_INVALID");
    expect(codeOf(set(["preview", "answer_modified"], true))).toBe("BASELINE_INVALID");
    // the owner's decision is pending, or a decision with the owner's own words
    expect(codeOf(set(["quality", "owner_final_decision"], { status: "rejected", quote_verbatim: null, decided_on: null }))).toBe("BASELINE_INVALID");
    expect(codeOf(set(["quality", "owner_final_decision"], { status: "pending", quote_verbatim: "x", decided_on: null }))).toBe("BASELINE_INVALID");
    expect(codeOf(set(["quality", "owner_final_decision"], { status: "rejected", quote_verbatim: "不採用", decided_on: "2026-10-30" }))).toBe("ok");
    // a provisional verdict is not the owner's: there is no "owner" evaluator for it
    expect(codeOf(set(["quality", "provisional_evaluation", "by"], "owner"))).toBe("BASELINE_INVALID");
    // research flag and role agree; the run used the recorded prompt; the overflow is among the issues
    expect(codeOf(set(["research_used"], true))).toBe("BASELINE_INVALID");
    expect(codeOf(set(["generation", "prompt_sha256"], "b".repeat(64)))).toBe("BASELINE_INVALID");
    expect(codeOf(set(["quality", "provisional_evaluation", "issues"], ["vertical_text_overlap"]))).toBe("BASELINE_INVALID");
    // the viewports are the artifact's 1440 / 390
    expect(codeOf(set(["preview", "images", "mobile_390", "width"], 375))).toBe("BASELINE_INVALID");
  });
});
