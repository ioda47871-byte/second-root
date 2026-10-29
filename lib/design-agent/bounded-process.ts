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
  /** Set (true) only when the caller's AbortSignal stopped the run, or it was aborted before the start (nothing ran). */
  aborted?: boolean;
}

export interface BoundedOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin and closed; without it stdin is ignored. */
  input?: string;
  timeoutMs: number;
  /** Grace period (see KILL_GRACE_MS). */
  graceMs?: number;
  /**
   * Observer of stdout as it arrives (the design-image PoC's diagnostics time
   * the first event from it). It MUST be synchronous and only read: it changes
   * nothing that is captured; an exception it throws (or a promise it returns
   * by mistake, and that promise's rejection) is ignored. It sees exactly the
   * captured stdout: once MAX_CAPTURE is reached it is not called any more.
   */
  onStdout?: (chunk: string) => void;
  /**
   * Optional: aborting it stops the run exactly like a timeout (the whole group gets SIGTERM, then SIGKILL after
   * the grace period). Already aborted: nothing is started. Without it the behaviour is unchanged.
   */
  signal?: AbortSignal;
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
  const { signal } = options;
  if (signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true });
  }
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
    let aborted = false;
    let stopping = false;
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
      signal?.removeEventListener("abort", onAbort);
      if (pid !== undefined) {
        /* On timeout or abort, end the whole group including grandchildren. */
        if (timedOut || aborted) {
          signalGroup(pid, "SIGKILL");
        }
        liveGroups.delete(pid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: exit?.code ?? null, signal: exit?.signal ?? null, stdout, stderr, timedOut, ...(aborted ? { aborted: true } : {}) });
    };

    /* Timeout and abort stop the group the same way: SIGTERM, then SIGKILL after the grace period. */
    const stop = (): void => {
      if (stopping || pid === undefined) {
        return;
      }
      stopping = true;
      signalGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup(pid, "SIGKILL");
        /* If the pipes still do not close (a grandchild left the group), cut them. */
        drainTimer = setTimeout(finish, graceMs);
      }, graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    function onAbort(): void {
      if (settled) {
        return;
      }
      aborted = true;
      stop();
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    if (pid !== undefined) {
      liveGroups.add(pid);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= MAX_CAPTURE) {
        return;
      }
      const text = chunk.toString("utf8");
      stdout += text;
      if (options.onStdout !== undefined) {
        try {
          const returned: unknown = options.onStdout(text);
          if (returned !== null && typeof returned === "object" && typeof (returned as { then?: unknown }).then === "function") {
            (returned as Promise<unknown>).then(undefined, () => undefined);
          }
        } catch {
          /* an observer never changes the run */
        }
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
      signal?.removeEventListener("abort", onAbort);
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
