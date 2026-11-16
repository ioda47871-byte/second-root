import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBRouteGenerationInput, BRoutePromptStop } from "@/lib/sales/b-route/generation-prompt";
import { runDirectionSetCheck } from "../../../scripts/design-artifact/direction-set";

const BASE = "design-library/research/quality-pipeline/poc/bicycle";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const facts = read(`${BASE}/facts-pack.json`);
const set = read(`${BASE}/direction-set.json`) as {
  directions: Array<{ id: string; composition: { hero: string; flow: string } }>;
};
const refs = read("design-library/phase2f/references/success-references-v1.json");

describe("B-route design preparation preserves the isolated model-call entry", () => {
  it("creates three distinct shop-specific v2 direction inputs, but NO prompt or approval", () => {
    const gate = runDirectionSetCheck(`${BASE}/direction-set.json`, `${BASE}/facts-pack.json`);
    expect(gate.status).toBe("READY_FOR_COMPS");
    const plans = set.directions.map((d) =>
      buildBRouteGenerationInput({ facts, directionSet: set, directionId: d.id, referenceManifest: refs }));
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p) => JSON.stringify(p.direction))).size).toBe(3);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      expect(p.route).toBe("B_html_prototype");
      expect(p.prompt_version).toBe("v2");
      expect(p.direction.direction_id).toBe(set.directions[i]!.id);
      expect(p.direction.composition).toEqual(set.directions[i]!.composition);
      expect(p.executable_without_owner_approval).toBe(false);
      expect(p.prompt_pin_required).toBe(true);
      expect(p).not.toHaveProperty("prompt");
      expect(p).not.toHaveProperty("prompt_sha256");
    }
  });
  it("cannot escalate case citations to an unapproved image asset", () => {
    const p = buildBRouteGenerationInput({ facts, directionSet: set, directionId: "d1-wheel-hub", referenceManifest: refs });
    // The owner-scoped list only includes CP-003. The selected design cites other cases.
    expect(p.reference_ids).toEqual([]);
    expect(p.reference_count).toBe(0);
  });
  it("refuses missing directions, mismatched shops and invalid owner scope", () => {
    expect(() => buildBRouteGenerationInput({ facts, directionSet: set, directionId: "does-not-exist", referenceManifest: refs }))
      .toThrowError(BRoutePromptStop);
    expect(() => buildBRouteGenerationInput({ facts: { ...(facts as object), shop_id: "another-shop" }, directionSet: set, directionId: "d1-wheel-hub", referenceManifest: refs }))
      .toThrowError(BRoutePromptStop);
    expect(() => buildBRouteGenerationInput({ facts, directionSet: set, directionId: "d1-wheel-hub", referenceManifest: { ...(refs as object), owner_scope: null } }))
      .toThrowError(BRoutePromptStop);
  });
});
