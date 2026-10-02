import { describe, expect, it } from "vitest";
import { CodexError } from "@/lib/design-agent/codex";
import { CallTimer, stageOf, TIMING_STAGES } from "@/lib/design-agent/worker/timing";

// DEV-029 stage 5: the per-call Codex timing in report.json and the log.
// Fixed values only: stage enum, whole milliseconds, schema mode, ok / code.

function fakeClock(steps: number[]) {
  let t = 0;
  let i = 0;
  return () => {
    const now = t;
    t += steps[i++ % steps.length] ?? 0;
    return now;
  };
}

describe("call timing", () => {
  it("names the first call of a kind round 0 and later ones revision", () => {
    expect(stageOf("brief", 0)).toBe("profile_brief");
    expect(stageOf("photo_analysis", 0)).toBe("photo_analysis");
    expect(stageOf("image_direction", 0)).toBe("image_direction");
    expect(stageOf("image_direction", 2)).toBe("image_direction_revision");
    expect(stageOf("review", 0)).toBe("visual_review");
    expect(stageOf("photo_review", 1)).toBe("visual_review_revision");
    const t = new CallTimer();
    expect(["brief", "photo_analysis", "image_direction", "photo_review", "image_direction", "photo_review"].map((k) => t.next(k as never))).toEqual([
      "profile_brief",
      "photo_analysis",
      "image_direction",
      "visual_review",
      "image_direction_revision",
      "visual_review_revision",
    ]);
  });

  it("records each exec with its duration, schema and ok or a fixed code; logs only those", async () => {
    const lines: string[] = [];
    const t = new CallTimer(fakeClock([1234.4, 0, 5000.6, 0, 7, 0]), (l) => lines.push(l));
    await t.time("profile_brief", "strict", async () => ({ answer: "a prompt-like secret text" }));
    await expect(t.time("visual_review", "strict", async () => Promise.reject(new CodexError("CODEX_TIMEOUT", "codex said something private")))).rejects.toThrow();
    await expect(t.time("visual_review", "loose", async () => Promise.reject(new Error("/home/x/asset.png")))).rejects.toThrow();
    expect(t.calls).toEqual([
      { stage: "profile_brief", duration_ms: 1234, schema: "strict", result: "ok" },
      { stage: "visual_review", duration_ms: 5001, schema: "strict", result: "CODEX_TIMEOUT" },
      { stage: "visual_review", duration_ms: 7, schema: "loose", result: "ERROR" },
    ]);
    expect(lines).toEqual(["codex profile_brief 1234 ms strict ok", "codex visual_review 5001 ms strict CODEX_TIMEOUT", "codex visual_review 7 ms loose ERROR"]);
    const s = t.summary();
    expect(s).toMatchObject({ calls: 3, codex_ms: 6242, slowest: { stage: "visual_review", duration_ms: 5001 }, by_stage: { profile_brief: { calls: 1, ms: 1234 }, visual_review: { calls: 2, ms: 5008 } } });
    const text = JSON.stringify({ s, calls: t.calls, lines });
    for (const leak of ["secret", "private", "/home", "asset.png"]) expect(text).not.toContain(leak);
    for (const c of t.calls) {
      expect(Object.keys(c).sort()).toEqual(["duration_ms", "result", "schema", "stage"]);
      expect(TIMING_STAGES).toContain(c.stage);
    }
  });
});
