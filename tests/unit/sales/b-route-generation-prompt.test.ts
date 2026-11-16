import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBRouteGenerationPrompt, BRoutePromptStop } from "@/lib/sales/b-route/generation-prompt";
import { runDirectionSetCheck } from "../../../scripts/design-artifact/direction-set";

const BASE = "design-library/research/quality-pipeline/poc/bicycle";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const facts = read(`${BASE}/facts-pack.json`);
const set = read(`${BASE}/direction-set.json`) as { directions: Array<{ id: string }> };
const refs = read("design-library/phase2f/references/success-references-v1.json");

describe("B-route generation inputs use existing checked directions and pinned v2 prompt", () => {
  it("builds different designs for all three existing original directions, not one shared template", () => {
    const gate = runDirectionSetCheck(`${BASE}/direction-set.json`, `${BASE}/facts-pack.json`);
    expect(gate.status).toBe("READY_FOR_COMPS");
    const plans = set.directions.map((d) =>
      buildBRouteGenerationPrompt({ facts, directionSet: set, directionId: d.id, referenceManifest: refs }));
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p) => p.prompt_sha256)).size).toBe(3);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      expect(p.route).toBe("B_html_prototype");
      expect(p.prompt_version).toBe("v2");
      expect(p.direction.direction_id).toBe(set.directions[i]!.id);
      expect(p.executable_without_owner_approval).toBe(false);
      expect(p.prompt).toContain("架空自転車修理");
      expect(p.prompt).toContain("Use no images at all");
      expect(p.prompt).not.toContain("auto-send");
    }
  });
  it("does not turn a reference mentioned in text into permission to attach its image", () => {
    const p = buildBRouteGenerationPrompt({ facts, directionSet: set, directionId: "d1-wheel-hub", referenceManifest: refs });
    // The scoped file list only includes CP-003. This direction cites CP-016 and CP-018.
    expect(p.reference_ids).toEqual([]);
    expect(p.reference_count).toBe(0);
  });
  it("fails closed on missing directions or a mismatched shop", () => {
    expect(() => buildBRouteGenerationPrompt({ facts, directionSet: set, directionId: "does-not-exist", referenceManifest: refs }))
      .toThrowError(BRoutePromptStop);
    expect(() => buildBRouteGenerationPrompt({ facts: { ...(facts as object), shop_id: "another-shop" }, directionSet: set, directionId: "d1-wheel-hub", referenceManifest: refs }))
      .toThrowError(BRoutePromptStop);
  });
});
