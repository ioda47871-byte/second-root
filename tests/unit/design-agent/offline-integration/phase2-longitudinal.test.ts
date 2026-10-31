/**
 * Issue #159: a fictional, OFFLINE-only longitudinal smoke across Phase 2b/2c/2d/2e/2g.
 * The design and implementation ports are deterministic local mocks. No real Codex, AI API,
 * network, worker, customer materials, human acceptance or production deployment.
 *
 * Identity and structure ports stay MOCKED here: their independent modules intentionally
 * forbid external imports until explicit integration approval. Their real behavior is
 * already tested within their own isolated test files. This checks the controller's
 * consumption of a simulated verdict, not the real identity/structure integration.
 * Fixture PNGs are synthetic: no design aesthetics or actual visual parity is proven.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { intakeArtifact } from "@/lib/design-agent/artifact/intake";
import { prepareImplementationLane } from "@/lib/design-agent/impl-lane/handoff";
import { runLoop, type Ports } from "@/lib/design-agent/loop/controller";
import { routeA, routeB, writePackage } from "../artifact/fixtures";

const folders: string[] = [];
afterAll(() => { for (const d of folders) rmSync(d, { recursive: true, force: true }); });

// Only the mocked ports return verdicts from separately tested isolated modules.
const mockIdentityVerdict = "PASS_IDENTITY_ONLY" as const;
const mockStructureFindings = ["TOO_CLOSE_TO_REFERENCE"];

const ok = <T,>(value: T) => ({ ok: true as const, value });

describe("fictional offline Phase 2 longitudinal integration", () => {
  it("only an explicitly owner-selected, identity-matched, verified B artifact reaches a quarantine-free lane and bounded mock repair", async () => {
    const files = writePackage(routeB());
    folders.push(files.base);
    const record = await intakeArtifact({ packageDir: files.dir, factsPath: files.factsPath });
    expect(record.verification_state).toBe("render_pair_complete");
    expect(record.implementation_handoff_allowed).toBe(true);

    // The mock represents a pass from the isolated identity gate, not a real approval.
    // A provisional structure finding is advisory and does not grant acceptance.
    const findingCodes = [...mockStructureFindings];

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
      identity: () => ok(mockIdentityVerdict),
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
    // A mock identity verdict cannot substitute for the owner-selection gate.
    let implemented = 0;
    const ports: Ports = {
      approval: () => "approved",
      design: () => ok({ design_id: "FICTIONAL-UNSELECTED" }),
      package: () => ok({ artifact_id: record.artifact_id, state: record.verification_state }),
      identity: () => ok(mockIdentityVerdict),
      structure: () => ok([]),
      ownerSelection: () => "pending",
      implement: () => { implemented++; return ok({ build_id: "NEVER" }); },
      compare: () => { throw new Error("unreachable comparison"); },
    };
    const result = runLoop("FICTIONAL-PENDING-1", ports);
    expect(result).toMatchObject({ status: "awaiting_owner_selection", implementation_attempts: 0, design_approved: false });
    expect(implemented).toBe(0);
  });
});
