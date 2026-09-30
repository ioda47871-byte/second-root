// Worker lock, process identity and ledger (DEV-028 worker). Ported from the
// Kaii Dokuhon image worker (curiosity-media entry-image-worker.ts, D-141)
// and made safe across WSL restarts: a holder is identified by pid plus the
// kernel boot id and the process start time, so a reused pid after a reboot
// never looks like a live worker.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A lock (or a job claim) older than this is taken over even if its holder seems alive. */
export const LOCK_STALE_MS = 3 * 60 * 60 * 1000;

export const UNREADABLE_LOCK_STALE_MS = 60 * 1000;

export type Holder = { pid: number; token: string; at: string; bootId: string | null; startTime: string | null };

async function readProc(path: string): Promise<string | null> {
  return readFile(path, "utf8").then(
    (text) => text.trim(),
    () => null,
  );
}

export async function bootId(): Promise<string | null> {
  return readProc("/proc/sys/kernel/random/boot_id");
}

/** Field 22 of /proc/<pid>/stat (start time in clock ticks since boot). */
export async function processStartTime(pid: number): Promise<string | null> {
  const stat = await readProc(`/proc/${pid}/stat`);
  if (stat === null) return null;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] ?? null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export async function currentHolder(token: string = randomUUID(), now: Date = new Date()): Promise<Holder> {
  return { pid: process.pid, token, at: now.toISOString(), bootId: await bootId(), startTime: await processStartTime(process.pid) };
}

export function parseHolder(value: unknown): Holder | null {
  const v = value as Partial<Holder> | null;
  if (!v || typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0 || typeof v.token !== "string" || typeof v.at !== "string") return null;
  return { pid: v.pid, token: v.token, at: v.at, bootId: typeof v.bootId === "string" ? v.bootId : null, startTime: typeof v.startTime === "string" ? v.startTime : null };
}

/** Whether the process that wrote this holder record is still running. */
export async function holderAlive(holder: Holder): Promise<boolean> {
  const boot = await bootId();
  if (holder.bootId !== null && boot !== null && holder.bootId !== boot) return false;
  if (!pidAlive(holder.pid)) return false;
  if (holder.startTime !== null) {
    const start = await processStartTime(holder.pid);
    if (start !== null && start !== holder.startTime) return false;
  }
  return true;
}

export class WorkerStepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Takes the worker lock. Returns the holder and a release function, or
 * undefined when another live worker holds it. A lock whose holder is gone is
 * taken over at once; a live holder's lock only after LOCK_STALE_MS.
 */
export async function acquireLock(stateDir: string, now: Date, name = "worker.lock"): Promise<{ holder: Holder; release: () => Promise<void> } | undefined> {
  const lockPath = join(stateDir, name);
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
  } catch {
    throw new WorkerStepError("WORKER_LOCK_FAILED", "cannot create the state directory");
  }
  for (let tries = 0; tries < 2; tries += 1) {
    const holder = await currentHolder(randomUUID(), now);
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(holder)}\n`);
      } finally {
        await handle.close();
      }
      return {
        holder,
        release: async () => {
          const current = await readFile(lockPath, "utf8").catch(() => "");
          if (current.includes(holder.token)) await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw new WorkerStepError("WORKER_LOCK_FAILED", "cannot create the lock");
      const existing = parseHolder(await readFile(lockPath, "utf8").then((t) => JSON.parse(t) as unknown).catch(() => null));
      const age = await stat(lockPath).then(
        (info) => now.getTime() - info.mtimeMs,
        () => 0,
      );
      // An unreadable lock (a worker killed between creating and writing it)
      // is stale after a minute; a readable one when its holder is gone.
      const gone = existing === null ? age > UNREADABLE_LOCK_STALE_MS : !(await holderAlive(existing));
      if (age < LOCK_STALE_MS && !gone) return undefined;
      await rm(lockPath, { force: true });
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ ledger

export type LedgerEntry = { attempts: number; lastCode: string; lastAt: string };
export type Ledger = { schemaVersion: 1; jobs: Record<string, LedgerEntry> };

export async function readLedger(stateDir: string): Promise<Ledger> {
  try {
    const value = JSON.parse(await readFile(join(stateDir, "ledger.json"), "utf8")) as Ledger;
    if (value.schemaVersion === 1 && typeof value.jobs === "object" && value.jobs !== null) return value;
  } catch {
    /* start empty */
  }
  return { schemaVersion: 1, jobs: {} };
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function writeLedger(stateDir: string, ledger: Ledger): Promise<void> {
  await writeJsonAtomic(join(stateDir, "ledger.json"), ledger);
}
