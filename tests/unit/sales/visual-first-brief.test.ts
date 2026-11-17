import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareVisualFirst, requirePrivateNewDir, VisualFirstStop } from "../../../scripts/sales/demo-version/prepare-visual-first";

const repo = resolve(__dirname, "../../..");
const factsPath = join(repo, "design-library/research/quality-pipeline/poc/bakery/facts-pack.json");
const directionsPath = join(repo, "design-library/research/quality-pipeline/poc/bakery/direction-set.json");
let temp: string | undefined;
const dir = () => (temp = mkdtempSync(join(tmpdir(), "sr-visual-first-")));
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = undefined; });

describe("sales visual-first work order (no model, photos, network or DB)", () => {
  it("does not invent photos for the previously photo-free Hoshigama d1", () => {
    const out = join(dir(), "plan");
    const result = prepareVisualFirst({ factsPath, directionsPath, directionId: "d1-kiln-clock", outDir: out });
    const brief = JSON.parse(readFileSync(join(out, "visual-first-brief.json"), "utf8"));
    expect(result.stage).toBe("PHOTO_SLOTS_REQUIRED");
    expect(result.photo_slot_count).toBe(0);
    expect(result.sendable).toBe(false);
    expect(brief.sections.length).toBeGreaterThan(3);
    expect(brief.pc_1440_full_page_plan.length).toBeGreaterThan(0);
    expect(brief.sp_390_full_page_plan.first_screen.length).toBeGreaterThan(0);
    expect(brief.sp_390_full_page_plan.reorder.length).toBeGreaterThan(0);
    expect(brief.human_gates.photo_generation).toBe("not_approved");
    expect(brief.human_gates.owner_final_quality).toBe("not_done");
  });

  it("carries each declared photo slot and the distinct PC/SP plans for a photo-rich direction", () => {
    const out = join(dir(), "plan");
    const result = prepareVisualFirst({ factsPath, directionsPath, directionId: "d2-hearth-floor", outDir: out });
    const brief = JSON.parse(readFileSync(join(out, "visual-first-brief.json"), "utf8"));
    expect(result.stage).toBe("PHOTO_ENHANCED_BRIEF_READY_FOR_DESIGN");
    expect(result.photo_slot_count).toBe(2);
    expect(brief.photo_slots.map((s: { role: string }) => s.role)).toEqual(["石窯の口", "田舎パン"]);
    expect(brief.photo_slots.every((s: { status: string }) => s.status === "needs_measured_pc_sp_slot")).toBe(true);
    expect(brief.pc_1440_full_page_plan).not.toBe(brief.sp_390_full_page_plan.reorder);
    expect(brief.image_policy.photos_generated).toBe(false);
    expect(brief.sendable).toBe(false);
    expect(readFileSync(join(out, "status.json"), "utf8")).toContain('"sendable": false');
  });

  it("refuses an unknown direction without creating an output", () => {
    const out = join(dir(), "plan");
    expect(() => prepareVisualFirst({ factsPath, directionsPath, directionId: "not-a-direction", outDir: out }))
      .toThrowError("DIRECTION_NOT_FOUND");
  });

  it("refuses changed facts with the original direction SHA", () => {
    const dirPath = dir();
    const changed = join(dirPath, "altered-facts.json");
    const facts = JSON.parse(readFileSync(factsPath, "utf8"));
    facts.facts[0].value = "架空パン店 名称変更";
    writeFileSync(changed, JSON.stringify(facts));
    expect(() => prepareVisualFirst({ factsPath: changed, directionsPath, directionId: "d2-hearth-floor", outDir: join(dirPath, "plan") }))
      .toThrowError("FACTS_IDENTITY_MISMATCH");
  });

  it("refuses an existing output and output under the source repository", () => {
    const dirPath = dir();
    expect(() => requirePrivateNewDir(dirPath)).toThrowError("OUTPUT_EXISTS");
    expect(() => requirePrivateNewDir(join(repo, "visual-first-should-not-be-created")))
      .toThrowError("OUTPUT_IN_REPO");
  });
});
