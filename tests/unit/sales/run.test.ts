import { describe, expect, it } from "vitest";
import { canFinalize, checkpointEffect, isRunExpired, nextAction } from "@/lib/sales/run";

const now = new Date("2026-10-01T00:00:00Z");
const recent = new Date("2026-09-30T23:00:00Z");
const stale = new Date("2026-09-29T23:00:00Z");

describe("run phase transitions", () => {
  it("applies the same or next phase, ignores earlier phases, refuses skips", () => {
    expect(checkpointEffect("started", "discovered")).toBe("apply");
    expect(checkpointEffect("discovered", "discovered")).toBe("apply");
    expect(checkpointEffect("discovered", "verified")).toBe("apply");
    expect(checkpointEffect("started", "verified")).toBe("violation");
    expect(checkpointEffect("verified", "discovered")).toBe("noop");
    expect(checkpointEffect("persisting", "verified")).toBe("noop");
  });
});

describe("nextAction", () => {
  it.each([
    ["running", "started", "discover"],
    ["running", "discovered", "verify"],
    ["running", "verified", "persist"],
    ["running", "persisting", "persist"],
    ["completed", "completed", "none"],
    ["failed", "discovered", "start_new_run"],
  ] as const)("%s/%s → %s", (status, phase, expected) => {
    expect(nextAction({ status, phase, checkpointAt: recent }, now)).toBe(expected);
  });

  it("starts a new run when a running run has had no checkpoint for 24h", () => {
    expect(isRunExpired({ status: "running", checkpointAt: stale }, now)).toBe(true);
    expect(nextAction({ status: "running", phase: "verified", checkpointAt: stale }, now)).toBe("start_new_run");
  });
});

describe("finalize", () => {
  it("completes when every candidate is terminal", () => {
    expect(canFinalize(["outreach_ready", "rejected", "duplicate"], 1)).toEqual({ done: true, partial: false });
  });
  it("keeps going while errors remain and attempts are left", () => {
    expect(canFinalize(["outreach_ready", "error"], 2)).toEqual({ done: false, partial: false });
  });
  it("completes as partial after 3 attempts", () => {
    expect(canFinalize(["outreach_ready", "error"], 3)).toEqual({ done: true, partial: true });
  });
});
