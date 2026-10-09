import { CodexError, type CodexFailureCode } from "../codex";

// Per-call Codex timing for report.json and the run log (DEV-029 stage 5).
// Fixed values only: a stage from the enum below, a whole-millisecond
// duration, the schema mode and "ok" or a fixed failure code. Never a
// prompt, Codex's output, a path, a shop fact or anything about the
// reference images.

export const TIMING_STAGES = [
  "profile_brief",
  "photo_analysis",
  "image_direction",
  "image_direction_revision",
  "visual_review",
  "visual_review_revision",
] as const;
export type TimingStage = (typeof TIMING_STAGES)[number];

export type CallTiming = {
  stage: TimingStage;
  duration_ms: number;
  schema: "strict" | "loose";
  /** "ok", a Codex failure code, or ERROR for anything else (the deadline). */
  result: "ok" | CodexFailureCode | "ERROR";
};

export type PipelineCallKind = "brief" | "review" | "photo_review" | "photo_analysis" | "image_direction";

/**
 * The stage of a pipeline call. A job's first direction / review is round 0;
 * every later one belongs to a revision round. (The DEV-028 review and the
 * photo-aware review are both visual_review.)
 */
export function stageOf(kind: PipelineCallKind, previous: number): TimingStage {
  switch (kind) {
    case "brief":
      return "profile_brief";
    case "photo_analysis":
      return "photo_analysis";
    case "image_direction":
      return previous === 0 ? "image_direction" : "image_direction_revision";
    case "review":
    case "photo_review":
      return previous === 0 ? "visual_review" : "visual_review_revision";
  }
}

export class CallTimer {
  readonly calls: CallTiming[] = [];
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** The stage of the next pipeline call of this kind (a schema retry is the same call: ask once per call). */
  next(kind: PipelineCallKind): TimingStage {
    const group = kind === "photo_review" ? "review" : kind;
    const previous = this.counts.get(group) ?? 0;
    this.counts.set(group, previous + 1);
    return stageOf(kind, previous);
  }

  /** Times one Codex exec. */
  async time<T>(stage: TimingStage, schema: "strict" | "loose", run: () => Promise<T>): Promise<T> {
    const start = this.clock();
    const done = (result: CallTiming["result"]) => {
      const entry: CallTiming = { stage, duration_ms: Math.max(0, Math.round(this.clock() - start)), schema, result };
      this.calls.push(entry);
      this.log(`codex ${entry.stage} ${entry.duration_ms} ms ${entry.schema} ${entry.result}`);
    };
    try {
      const value = await run();
      done("ok");
      return value;
    } catch (error) {
      done(error instanceof CodexError ? error.code : "ERROR");
      throw error;
    }
  }

  summary(): { calls: number; codex_ms: number; slowest: CallTiming | null; by_stage: Partial<Record<TimingStage, { calls: number; ms: number }>> } {
    const by_stage: Partial<Record<TimingStage, { calls: number; ms: number }>> = {};
    for (const c of this.calls) {
      const s = (by_stage[c.stage] ??= { calls: 0, ms: 0 });
      s.calls += 1;
      s.ms += c.duration_ms;
    }
    const slowest = this.calls.reduce<CallTiming | null>((a, b) => (a === null || b.duration_ms > a.duration_ms ? b : a), null);
    return { calls: this.calls.length, codex_ms: this.calls.reduce((n, c) => n + c.duration_ms, 0), slowest, by_stage };
  }
}
