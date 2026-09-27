import { LIMITS } from "./types";

// Operational run phases and resume logic (docs/ARCHITECTURE.md §7).

export const RUN_PHASES = ["started", "discovered", "verified", "persisting", "completed"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export type RunStatus = "running" | "completed" | "failed";

export const CANDIDATE_STAGES = ["pending", "outreach_ready", "rejected", "duplicate", "error"] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export function isTerminalStage(stage: CandidateStage): boolean {
  return stage === "outreach_ready" || stage === "rejected" || stage === "duplicate";
}

const rank = (phase: RunPhase) => RUN_PHASES.indexOf(phase);

/**
 * What a checkpoint request for `target` does when the run is at `current`:
 * apply it (same or next phase), ignore it (late re-send of an earlier
 * phase), or refuse it (skipping a phase).
 */
export function checkpointEffect(current: RunPhase, target: "discovered" | "verified"): "apply" | "noop" | "violation" {
  if (rank(current) > rank(target)) return "noop";
  if (rank(current) < rank(target) - 1) return "violation";
  return "apply";
}

export type NextAction = "discover" | "verify" | "persist" | "none" | "start_new_run";

export function isRunExpired(run: { status: RunStatus; checkpointAt: Date }, now: Date): boolean {
  return run.status === "running" && now.getTime() - run.checkpointAt.getTime() > LIMITS.runExpiryHours * 3600_000;
}

export function nextAction(run: { status: RunStatus; phase: RunPhase; checkpointAt: Date }, now: Date): NextAction {
  if (run.status === "completed") return "none";
  if (run.status === "failed" || isRunExpired(run, now)) return "start_new_run";
  switch (run.phase) {
    case "started":
      return "discover";
    case "discovered":
      return "verify";
    case "verified":
    case "persisting":
      return "persist";
    case "completed":
      return "none";
  }
}

/** Whether a run can be completed now (all terminal, or the attempt limit reached). */
export function canFinalize(stages: CandidateStage[], persistAttempts: number): { done: boolean; partial: boolean } {
  const open = stages.filter((s) => !isTerminalStage(s)).length;
  if (open === 0) return { done: true, partial: false };
  if (persistAttempts >= LIMITS.maxPersistAttempts) return { done: true, partial: true };
  return { done: false, partial: false };
}
