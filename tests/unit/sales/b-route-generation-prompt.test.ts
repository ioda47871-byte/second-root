import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBRouteGenerationInput, BRoutePromptStop, V2_DIRECTION_ID } from "@/lib/sales/b-route/generation-prompt";
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
  it("stops a direction id the v2 open-direction schema would refuse (direction-set allows 3 chars, v2 needs 4+)", () => {
    const short = JSON.parse(JSON.stringify(set)) as typeof set;
    short.directions[0]!.id = "d1x";
    let code = "";
    try {
      buildBRouteGenerationInput({ facts, directionSet: short, directionId: "d1x", referenceManifest: refs });
    } catch (e) {
      code = e instanceof BRoutePromptStop ? e.code : "other";
    }
    expect(code).toBe("DIRECTION_ID_NOT_V2");
    const ok = JSON.parse(JSON.stringify(set)) as typeof set;
    ok.directions[0]!.id = "d1xy";
    expect(buildBRouteGenerationInput({ facts, directionSet: ok, directionId: "d1xy", referenceManifest: refs }).direction.direction_id).toBe("d1xy");
  });
  it("keeps the copied v2 direction_id rule identical to the protected schema (read as text, not imported)", () => {
    const source = readFileSync("lib/design-agent/phase2f/open-direction.ts", "utf8");
    expect(source).toContain(`direction_id: z.string().regex(${V2_DIRECTION_ID.toString()})`);
  });
});
