/**
 * Runs an external process (Codex CLI, the local Next.js server) with a hard
 * time limit. Ported from curiosity-media `packages/automation/src/
 * bounded-process.ts` (Kaii Dokuhon image worker, D-142/D-143), where the
 * same Codex CLI integration runs unattended.
 *
 * - Each child runs in its own process group (`detached`); on timeout the
 *   whole group gets SIGTERM, then SIGKILL after a grace period.
 * - Never waits forever for pipes a grandchild may still hold.
 * - `killAllBoundedChildren` ends every live group when the CLI is stopped.
 */
import { spawn } from "node:child_process";

export interface BoundedResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface BoundedOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin and closed; without it stdin is ignored. */
  input?: string;
  timeoutMs: number;
  /** Grace period (see KILL_GRACE_MS). */
  graceMs?: number;
}

/** Grace between SIGTERM and SIGKILL (and between exit and cutting the pipes). */
export const KILL_GRACE_MS = 5_000;

/** Cap on captured stdout / stderr; the rest is dropped. */
const MAX_CAPTURE = 64 * 1024 * 1024;

/** Process groups (= child pids) still running. */
const liveGroups = new Set<number>();

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

/** SIGKILL every live group (used when the CLI itself is stopped). */
export function killAllBoundedChildren(): void {
  for (const pid of liveGroups) {
    signalGroup(pid, "SIGKILL");
  }
  liveGroups.clear();
}

/** Runs once with a time limit. Rejects only when the binary cannot start. */
export function runBounded(
  bin: string,
  args: readonly string[],
  options: BoundedOptions,
): Promise<BoundedResult> {
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      if (pid !== undefined) {
        /* On timeout, end the whole group including grandchildren. */
        if (timedOut) {
          signalGroup(pid, "SIGKILL");
        }
        liveGroups.delete(pid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: exit?.code ?? null, signal: exit?.signal ?? null, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (pid === undefined) {
        return;
      }
      signalGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup(pid, "SIGKILL");
        /* If the pipes still do not close (a grandchild left the group), cut them. */
        drainTimer = setTimeout(finish, graceMs);
      }, graceMs);
    }, options.timeoutMs);

    if (pid !== undefined) {
      liveGroups.add(pid);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      if (pid !== undefined) {
        liveGroups.delete(pid);
      }
      reject(error);
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      /* A grandchild holding a pipe blocks "close"; cut after the grace period. */
      if (!settled && drainTimer === undefined) {
        drainTimer = setTimeout(finish, graceMs);
      }
    });
    child.on("close", finish);
    if (options.input !== undefined && child.stdin !== null) {
      /* Writing to a child that already exited raises EPIPE; judge by the exit instead. */
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
  });
}

/** A run's deadline: each outside wait uses min(its own limit, time left). */
export class RunDeadline {
  constructor(
    readonly endsAt: number,
    private readonly nowMs: () => number = Date.now,
  ) {}

  remainingMs(): number {
    return this.endsAt - this.nowMs();
  }

  /** The shorter of `defaultMs` and the time left; throws when less than `minMs` is left. */
  timeoutFor(defaultMs: number, minMs = 1): number {
    const left = this.remainingMs();
    if (left < Math.max(1, minMs)) throw new DeadlineError();
    return Math.min(defaultMs, left);
  }
}

export class DeadlineError extends Error {
  readonly code = "RUN_TIME_BUDGET";
  constructor() {
    super("No time left in this run.");
    this.name = "DeadlineError";
  }
}
