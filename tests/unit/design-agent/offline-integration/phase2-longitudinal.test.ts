/**
 * Issue #159: a fictional, OFFLINE-only longitudinal smoke across Phase 2b/2c/2d/2e/2g.
 * The design and implementation ports are deterministic local mocks. No real Codex, AI API,
 * network, worker, customer materials, human acceptance or production deployment.
 *
 * The fixture PNGs are synthetic: this exercises hand-off and gating, not design aesthetics
 * or a live Codex/Chromium visual equivalence judgment.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { auditPageText } from "@/lib/design-agent/identity/identity-lock";
import { StructureDescriptor, structureFindings } from "@/lib/design-agent/structure/descriptor";
import { intakeArtifact } from "@/lib/design-agent/artifact/intake";
import { prepareImplementationLane } from "@/lib/design-agent/impl-lane/handoff";
import { runLoop, type Ports } from "@/lib/design-agent/loop/controller";
import { HTML, routeA, routeB, writePackage } from "../artifact/fixtures";

const folders: string[] = [];
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }); });

const fictionalIdentity = {
  schema_version: 1,
  case_id: "CP-900",
  attempt_id: "fictional-bakery-mock-only",
  target: {
    official_name: "架空ベーカリー",
    allowed_aliases: [],
    category_code: "fictional_bakery",
    official_source_url: "https://example.invalid/fictional-test-only",
  },
  prompt: { shop_name: "架空ベーカリー", category_code: "fictional_bakery", is_research_only: true },
  other_shop_names: ["別の架空店舗"],
};

// Provisional eight-aspect metadata; actual browser measurement is tested separately
// by DEV-125's Chromium tests, not claimed by this fixture-only longitudinal smoke.
const descriptor = StructureDescriptor.parse({
  schema: "structure_descriptor_v0",
  hero: { value: "type_led", source: "declared" },
  flow: { value: "one_continuous_surface", source: "declared" },
  navigation: { value: "inline", source: "declared" },
  reading_path: { value: "radial", source: "declared" },
  section_layouts: { value: ["overlap_collage", "diagram"], source: "declared" },
  transitions: { value: ["overlap"], source: "declared" },
  text_direction: { value: "mixed", source: "declared" },
  imagery: { value: "drawn", source: "declared" },
});

const ok = <T,>(value: T) => ({ ok: true as const, value });

describe("fictional offline Phase 2 longitudinal integration", () => {
  it("only an explicitly owner-selected, identity-matched, verified B artifact reaches a quarantine-free lane and bounded mock repair", async () => {
    const files = writePackage(routeB());
    folders.push(files.base);
    const record = await intakeArtifact({ packageDir: files.dir, factsPath: files.factsPath });
    expect(record.verification_state).toBe("render_pair_complete");
    expect(record.implementation_handoff_allowed).toBe(true);

    const visibleText = "架空ベーカリー";
    expect(HTML).toContain(visibleText);
    const identity = auditPageText(fictionalIdentity, visibleText);
    expect(identity.status).toBe("PASS_IDENTITY_ONLY");
    expect(identity.counts_as_owner_success).toBe(false);

    const findings = structureFindings(descriptor, { references: { mock_reference: descriptor } });
    expect(findings.some((f) => f.code === "TOO_CLOSE_TO_REFERENCE")).toBe(true);
    // Structural similarity alone neither grants approval nor stops the deterministic loop.
    const findingCodes = findings.map((f) => f.code);

    const laneDir = join(files.base, "implementation-lane");
    // In this test, the "owner" explicitly selects the fictional fixture before the lane is prepared.
    const ownerSelected = true;
    expect(ownerSelected).toBe(true);
    const lane = await prepareImplementationLane({ packageDir: files.dir, factsPath: files.factsPath, laneDir });
    expect(lane.schema).toBe("implementation_lane_v1");
    expect(lane.files.map((f) => f.path).sort()).toEqual([
      "artifact.json", "originals/desktop_1440.png", "originals/mobile_390.png",
    ]);
    expect(lane.files.some((f) => f.path.startsWith("quarantine/"))).toBe(false);
    expect(readFileSync(join(laneDir, "originals/desktop_1440.png")).subarray(0, 4).toString("hex")).toBe("89504e47");

    const implemented: Array<string | null> = [];
    let compared = 0;
    const ports: Ports = {
      approval: () => "approved", // explicit fictional mock only; no paid call
      design: () => ok({ design_id: "FICTIONAL-DESIGN-1" }),
      package: () => ok({ artifact_id: record.artifact_id, state: record.verification_state }),
      identity: () => ok(identity.status),
      structure: () => ok(findingCodes),
      ownerSelection: () => "selected", // mock of a human choice, not a genuine owner sign-off
      implement: (_artifact, fix) => {
        implemented.push(fix);
        return ok({ build_id: "MOCK-BUILD-" + implemented.length });
      },
      compare: () => ok({ differences: ++compared === 1 ? ["MOBILE_SPACING"] : [] }),
    };
    const result = runLoop("FICTIONAL-LOCAL-1", ports);
    expect(result).toMatchObject({
      status: "owner_review", code: null, owner_check: false,
      implementation_attempts: 2, design_approved: false,
    });
    expect(implemented).toEqual([null, "MOBILE_SPACING"]);
    expect(result.events).toContain("structure:TOO_CLOSE_TO_REFERENCE");
    expect(result.events.some((x) => x === "fix:MOBILE_SPACING:1")).toBe(true);
  });

  it("a concept image package never reaches the isolated implementation lane or mock implement port", async () => {
    const files = writePackage(routeA());
    folders.push(files.base);
    const record = await intakeArtifact({ packageDir: files.dir, factsPath: files.factsPath });
    expect(record.verification_state).toBe("concept_only");
    expect(record.implementation_handoff_allowed).toBe(false);

    const laneDir = join(files.base, "not-allowed-lane");
    await expect(prepareImplementationLane({ packageDir: files.dir, factsPath: files.factsPath, laneDir }))
      .rejects.toMatchObject({ code: "LANE_NOT_ALLOWED" });

    let reachedImplement = false;
    const ports: Ports = {
      approval: () => "approved",
      design: () => ok({ design_id: "FICTIONAL-CONCEPT" }),
      package: () => ok({ artifact_id: record.artifact_id, state: record.verification_state }),
      identity: () => { throw new Error("identity must not run for concept-only artifact"); },
      structure: () => { throw new Error("structure must not run for concept-only artifact"); },
      ownerSelection: () => "pending",
      implement: () => { reachedImplement = true; return ok({ build_id: "NEVER" }); },
      compare: () => { throw new Error("compare must not run"); },
    };
    const result = runLoop("FICTIONAL-CONCEPT-1", ports);
    expect(result).toMatchObject({ status: "stopped", code: "ARTIFACT_CONCEPT_ONLY", implementation_attempts: 0, design_approved: false });
    expect(reachedImplement).toBe(false);
  });

  it("even a valid local B artifact cannot be implemented before an owner-selection decision", async () => {
    const files = writePackage(routeB());
    folders.push(files.base);
    const record = await intakeArtifact({ packageDir: files.dir, factsPath: files.factsPath });
    const visibleText = "架空ベーカリー";
    expect(HTML).toContain(visibleText);
    const identity = auditPageText(fictionalIdentity, visibleText);
    expect(identity.status).toBe("PASS_IDENTITY_ONLY");

    let implemented = 0;
    const ports: Ports = {
      approval: () => "approved",
      design: () => ok({ design_id: "FICTIONAL-UNSELECTED" }),
      package: () => ok({ artifact_id: record.artifact_id, state: record.verification_state }),
      identity: () => ok(identity.status),
      structure: () => ok(structureFindings(descriptor).map((f) => f.code)),
      ownerSelection: () => "pending",
      implement: () => { implemented++; return ok({ build_id: "NEVER" }); },
      compare: () => { throw new Error("unreachable comparison"); },
    };
    const result = runLoop("FICTIONAL-PENDING-1", ports);
    expect(result).toMatchObject({ status: "awaiting_owner_selection", implementation_attempts: 0, design_approved: false });
    expect(implemented).toBe(0);
  });
});
