import { describe, expect, it, vi } from "vitest";
import { CATEGORY_DEFAULT_PROFILES } from "@/lib/design-agent/defaults";
import { runDesignPipeline, type PipelineDeps } from "@/lib/design-agent/pipeline";
import type { DesignProfile } from "@/lib/design-agent/profile";
import { AMERICAN_EDITORIAL, review, SHOP } from "./fixtures";

// DEV-044, defensive branch: if the combined profile ever failed the profile check, the
// pipeline uses the plain category default, as before DEV-044. (With the real defaults the
// combination always passes; see brief-structure.test.ts.)
vi.mock("@/lib/design-agent/defaults", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/design-agent/defaults")>();
  return { ...real, briefStructureOnDefault: () => null };
});

describe("runDesignPipeline: a combined profile that fails the check", () => {
  it("falls back to the plain category default with a note", async () => {
    const answers: unknown[] = [{ ...AMERICAN_EDITORIAL, confidence: 0.3 }, review()];
    const profiles = new Map<string, DesignProfile>();
    const deps: PipelineDeps = {
      askCodex: async () => answers.shift(),
      writeProfile: async (name, profile) => void profiles.set(name, profile),
      writeRecord: async () => undefined,
      render: async (c) => ({ desktop: `/shots/${c}-d.png`, mobile: `/shots/${c}-m.png` }),
      log: () => undefined,
    };
    const report = await runDesignPipeline({ demo: SHOP, references: ["/refs/1.png"] }, deps);
    expect(report.profileSource).toBe("category_default");
    expect(report.notes).toEqual(["LOW_CONFIDENCE_CATEGORY_DEFAULT", "BRIEF_STRUCTURE_REJECTED"]);
    expect(profiles.get("candidate-0")).toEqual(CATEGORY_DEFAULT_PROFILES[SHOP.category]);
  });
});
