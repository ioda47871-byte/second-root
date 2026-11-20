/**
 * Issue #302 P2: delivering ONE sealed private bundle (bundle.ts) — the delivery state machine, the transport interface
 * and a FAKE transport + receiver for tests. No real service: nothing here opens a socket, calls an API, spawns a
 * process, or imports the worker, the entry, Codex or the image tool (a test pins the import list).
 *
 *   sealed ──deliver()──▶ delivering ──receiver confirms the SAME bundle SHA──▶ delivered (final; deliver() is a no-op)
 *      ▲                      │
 *      └── send failed / ack wrong / interrupted (a "delivering" job found on load counts as sealed)
 *
 * A re-send is allowed only of the same sealed bundle: before every attempt the bundle directory is verified from scratch
 * and its SHA must equal the one recorded when the job was registered (otherwise BUNDLE_CHANGED and nothing is sent). A
 * failed delivery never regenerates anything: this module cannot reach the worker or Codex. Attempts are capped.
 *
 * The receiver is idempotent: the same bundle ID with the same SHA again = "duplicate" (no-op, same ack); the same ID with
 * different bytes = BUNDLE_ID_CONFLICT. It re-verifies everything (verifyBundleDir) against the record it EXPECTS (from the
 * owner's approval, not from the bundle), issues a short-lived retrieval grant, and deletes bundles past retention. Grant
 * expiry and deletion are computed from the receiver's own receive time and constants (RECEIVER_TERMS), never from the
 * sender's manifest.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { APPROVAL_ID_RE, BUNDLE_ACCESS, BUNDLE_LIMITS, BundleStop, isBundleFilePath, verifyBundleDir, writeEntries, type BundleEntry, type BundleLimits, type ExpectedRecord, type SealedBundle } from "./bundle";

export type BundlePayload = { bundle_id: string; bundle_sha256: string; entries: BundleEntry[] };
export type DeliveryAck = { bundle_id: string; bundle_sha256: string; status: "accepted" | "duplicate"; retrieval: { token: string; expires_at: string } };

/** A transport moves one payload to a receiver and returns the receiver's acknowledgement (or throws). */
export interface BundleTransport {
  send(payload: BundlePayload, signal?: AbortSignal): Promise<DeliveryAck>;
}

export type DeliveryState = "sealed" | "delivering" | "delivered";
export type DeliveryJob = {
  schema: "imagefirst_bundle_delivery_v1";
  bundle_id: string;
  bundle_sha256: string;
  state: DeliveryState;
  attempts: number;
  last_error: string | null;
  sealed_at: string;
  delivered_at: string | null;
};
export const MAX_DELIVERY_ATTEMPTS = 5;

export type DeliveryCode = "JOB_EXISTS_DIFFERENT" | "JOB_MISSING" | "JOB_UNREADABLE" | "ATTEMPTS_EXHAUSTED" | "BUNDLE_CHANGED" | "TRANSPORT_FAILED" | "RECEIVER_SHA_MISMATCH" | "DELIVERY_ABORTED";
export class DeliveryStop extends Error {
  constructor(readonly code: DeliveryCode) {
    super(code);
    this.name = "DeliveryStop";
  }
}

const jobPath = (stateDir: string, id: string) => join(stateDir, "deliveries", `${id}.json`);

async function readJob(stateDir: string, id: string): Promise<DeliveryJob | null> {
  if (!APPROVAL_ID_RE.test(id)) throw new DeliveryStop("JOB_UNREADABLE");
  let h;
  try {
    h = await open(jobPath(stateDir, id), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new DeliveryStop("JOB_UNREADABLE");
  }
  try {
    const j = JSON.parse((await h.readFile()).toString("utf8")) as DeliveryJob;
    if (j?.schema !== "imagefirst_bundle_delivery_v1" || j.bundle_id !== id || !/^[0-9a-f]{64}$/.test(j.bundle_sha256) || !["sealed", "delivering", "delivered"].includes(j.state)) throw new Error("shape");
    // a missing or invalid attempt count never reads as "fewer attempts": the job is unreadable (refused)
    if (!Number.isSafeInteger(j.attempts) || j.attempts < 0 || j.attempts > MAX_DELIVERY_ATTEMPTS || (j.last_error !== null && typeof j.last_error !== "string")) throw new Error("shape");
    return j;
  } catch {
    throw new DeliveryStop("JOB_UNREADABLE");
  } finally {
    await h.close();
  }
}

/** Atomic replace (write a temporary 0600 file, then rename over the job). */
async function writeJob(stateDir: string, job: DeliveryJob): Promise<void> {
  const dir = join(stateDir, "deliveries");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${job.bundle_id}.${randomBytes(6).toString("hex")}.tmp`);
  const h = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(`${JSON.stringify(job, null, 2)}\n`);
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(tmp, jobPath(stateDir, job.bundle_id));
}

/** Records a sealed bundle as a delivery job (state "sealed"). Registering the same bundle again returns the existing job. */
export async function registerSealed(stateDir: string, sealed: SealedBundle, now: () => number = Date.now): Promise<DeliveryJob> {
  const existing = await readJob(stateDir, sealed.bundle_id);
  if (existing) {
    if (existing.bundle_sha256 !== sealed.bundle_sha256) throw new DeliveryStop("JOB_EXISTS_DIFFERENT");
    return existing;
  }
  const job: DeliveryJob = { schema: "imagefirst_bundle_delivery_v1", bundle_id: sealed.bundle_id, bundle_sha256: sealed.bundle_sha256, state: "sealed", attempts: 0, last_error: null, sealed_at: new Date(now()).toISOString(), delivered_at: null };
  await writeJob(stateDir, job);
  return job;
}

export type DeliverOptions = { stateDir: string; bundleDir: string; bundleId: string; transport: BundleTransport; now?: () => number; signal?: AbortSignal; limits?: BundleLimits; maxAttempts?: number };
export type DeliverResult = { state: DeliveryState; sent: boolean; code: DeliveryCode | null; job: DeliveryJob; ack?: DeliveryAck };

/**
 * One delivery attempt of the registered bundle. "delivered" only when the receiver acknowledged this bundle's ID and
 * SHA. Any failure leaves the job "sealed" (with last_error) for a later re-send of the same bytes.
 */
export async function deliverBundle(o: DeliverOptions): Promise<DeliverResult> {
  const now = o.now ?? Date.now;
  const loaded = await readJob(o.stateDir, o.bundleId);
  if (!loaded) throw new DeliveryStop("JOB_MISSING");
  if (loaded.state === "delivered") return { state: "delivered", sent: false, code: null, job: loaded };
  // a job left "delivering" by an interrupted process is sealed again: the receiver decides by SHA whether it already has it
  const job: DeliveryJob = { ...loaded, state: "sealed" };
  const back = async (code: DeliveryCode): Promise<DeliverResult> => {
    const j: DeliveryJob = { ...job, state: "sealed", last_error: code };
    await writeJob(o.stateDir, j);
    return { state: "sealed", sent: code !== "BUNDLE_CHANGED" && code !== "ATTEMPTS_EXHAUSTED" && code !== "DELIVERY_ABORTED", code, job: j };
  };
  // a caller may lower the cap, never raise it
  if (job.attempts >= Math.min(o.maxAttempts ?? MAX_DELIVERY_ATTEMPTS, MAX_DELIVERY_ATTEMPTS)) return back("ATTEMPTS_EXHAUSTED");
  if (o.signal?.aborted) return back("DELIVERY_ABORTED");

  // the same sealed bytes, verified again from disk (never re-packed, never regenerated)
  let payload: BundlePayload;
  try {
    const v = await verifyBundleDir(o.bundleDir, { limits: o.limits });
    if (v.bundle_sha256 !== job.bundle_sha256 || v.manifest.bundle_id !== job.bundle_id) return back("BUNDLE_CHANGED");
    payload = { bundle_id: job.bundle_id, bundle_sha256: v.bundle_sha256, entries: v.entries };
  } catch (error) {
    if (error instanceof BundleStop) return back("BUNDLE_CHANGED");
    throw error;
  }

  job.state = "delivering";
  job.attempts += 1;
  await writeJob(o.stateDir, job);
  let ack: DeliveryAck;
  try {
    ack = await o.transport.send(payload, o.signal);
  } catch {
    return back("TRANSPORT_FAILED");
  }
  if (!ack || ack.bundle_id !== job.bundle_id || ack.bundle_sha256 !== job.bundle_sha256) return back("RECEIVER_SHA_MISMATCH");
  const done: DeliveryJob = { ...job, state: "delivered", last_error: null, delivered_at: new Date(now()).toISOString() };
  await writeJob(o.stateDir, done);
  return { state: "delivered", sent: true, code: null, job: done, ack };
}

// ---------------------------------------------------------------------------------------------------------------------
// FAKE receiver and transport (stands in for a remote private endpoint that does not exist yet — see
// docs/operations/imagefirst-private-return.md). Issue #302 P3: the receiver is also the far end of local-inbox.ts,
// where the same-machine review inbox IS the endpoint (only filesystem work; its retrieval grant is unused there).

export type ReceiverCode = "PAYLOAD_INVALID" | "BUNDLE_ID_CONFLICT" | "NOT_EXPECTED" | "GRANT_INVALID" | "GRANT_EXPIRED" | "INBOX_UNSAFE";
export class ReceiverStop extends Error {
  constructor(readonly code: ReceiverCode | BundleStop["code"]) {
    super(code);
    this.name = "ReceiverStop";
  }
}

export type FakeReceiverOptions = {
  /** The receiver's private store (0700). */
  inboxDir: string;
  /** The record each bundle ID must match (the owner's approval: approval / plan / commit); null = not expected. */
  expected: (bundleId: string) => ExpectedRecord | null;
  now?: () => number;
  limits?: BundleLimits;
};

/**
 * The receiver's own terms. Deletion and grant expiry come from the receiver's clock at receive time and these constants,
 * never from the sender's manifest (whose declared terms verifyBundleDir only checks for exactness).
 */
export const RECEIVER_TERMS = { retainMs: BUNDLE_ACCESS.retainDays * 86_400_000, grantMs: BUNDLE_ACCESS.retrievalTtlSeconds * 1000 } as const;
type ReceivedRecord = { bundle_id: string; bundle_sha256: string; received_at: string; delete_after: string };
const RECORDS = ".records";

export function createFakeReceiver(o: FakeReceiverOptions) {
  const now = o.now ?? Date.now;
  const limits = o.limits ?? BUNDLE_LIMITS;
  const grants = new Map<string, { bundle_id: string; bundle_sha256: string; expires: number }>();
  const issue = (bundle_id: string, bundle_sha256: string) => {
    const token = randomBytes(24).toString("hex");
    const expires = now() + RECEIVER_TERMS.grantMs;
    grants.set(token, { bundle_id, bundle_sha256, expires });
    return { token, expires_at: new Date(expires).toISOString() };
  };
  const inbox = async () => {
    await mkdir(o.inboxDir, { recursive: true, mode: 0o700 });
    const info = await lstat(o.inboxDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new ReceiverStop("INBOX_UNSAFE");
    return realpath(o.inboxDir);
  };
  const asStop = (error: unknown): never => {
    if (error instanceof BundleStop) throw new ReceiverStop(error.code);
    throw error;
  };
  /** The receiver's own record of when it took a bundle in (written once, 0600). */
  const writeRecord = async (root: string, rec: ReceivedRecord) => {
    await mkdir(join(root, RECORDS), { recursive: true, mode: 0o700 });
    const h = await open(join(root, RECORDS, `${rec.bundle_id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(`${JSON.stringify(rec)}\n`);
    } finally {
      await h.close();
    }
  };
  const readRecord = async (root: string, id: string): Promise<ReceivedRecord | null> => {
    const t = await readFile(join(root, RECORDS, `${id}.json`), "utf8").catch(() => null);
    try {
      const r = t ? (JSON.parse(t) as ReceivedRecord) : null;
      return r && r.bundle_id === id && typeof r.delete_after === "string" && Number.isFinite(Date.parse(r.delete_after)) ? r : null;
    } catch {
      return null;
    }
  };
  /** The same ID already kept: same SHA = duplicate, anything else = conflict. */
  const existing = async (final: string, p: BundlePayload): Promise<DeliveryAck> => {
    const have = await verifyBundleDir(final, { limits: o.limits }).catch(() => null);
    if (!have || have.bundle_sha256 !== p.bundle_sha256) throw new ReceiverStop("BUNDLE_ID_CONFLICT");
    return { bundle_id: p.bundle_id, bundle_sha256: p.bundle_sha256, status: "duplicate", retrieval: issue(p.bundle_id, p.bundle_sha256) };
  };
  const capOf = (path: string) =>
    path === "manifest.json" ? limits.manifestBytes : path === "SHA256SUMS" ? limits.sumsBytes : path === "receipt.json" ? limits.receiptBytes : path.startsWith("composites/") ? limits.composite.maxBytes : limits.part.maxBytes;

  return {
    /** Receives one payload: sizes first, then a fresh staging dir, verify it all, then keep it (or no-op / refuse by ID + SHA). */
    async receive(p: BundlePayload): Promise<DeliveryAck> {
      if (!p || typeof p.bundle_id !== "string" || !APPROVAL_ID_RE.test(p.bundle_id) || typeof p.bundle_sha256 !== "string" || !Array.isArray(p.entries)) throw new ReceiverStop("PAYLOAD_INVALID");
      const paths = p.entries.map((e) => e?.path);
      if (paths.some((x) => typeof x !== "string" || !(x === "manifest.json" || x === "SHA256SUMS" || isBundleFilePath(x))) || new Set(paths).size !== paths.length) throw new ReceiverStop("PAYLOAD_INVALID");
      if (p.entries.some((e) => !Buffer.isBuffer(e.bytes))) throw new ReceiverStop("PAYLOAD_INVALID");
      // sizes before anything touches the disk
      if (p.entries.some((e) => e.bytes.length > capOf(e.path))) throw new ReceiverStop("BUNDLE_FILE_TOO_LARGE");
      if (p.entries.reduce((n, e) => n + e.bytes.length, 0) > limits.totalBytes + limits.manifestBytes + limits.sumsBytes) throw new ReceiverStop("BUNDLE_FILE_TOO_LARGE");
      const expected = o.expected(p.bundle_id);
      if (!expected) throw new ReceiverStop("NOT_EXPECTED");
      const root = await inbox();
      const staging = await mkdtemp(join(root, ".staging-"));
      try {
        await writeEntries(staging, p.entries).catch(asStop);
        const v = await verifyBundleDir(staging, { limits: o.limits, expected: { ...expected, bundle_sha256: p.bundle_sha256 } }).catch(asStop);
        if (v.manifest.bundle_id !== p.bundle_id) throw new ReceiverStop("PAYLOAD_INVALID");
        const final = join(root, p.bundle_id);
        if (await lstat(final).then(() => true, () => false)) return await existing(final, p);
        try {
          await rename(staging, final);
        } catch (error) {
          // a concurrent receive of the same ID won the rename: decide by SHA like any other repeat
          const code = (error as { code?: string }).code;
          if (code === "ENOTEMPTY" || code === "EEXIST") return await existing(final, p);
          throw error;
        }
        const at = now();
        await writeRecord(root, { bundle_id: p.bundle_id, bundle_sha256: p.bundle_sha256, received_at: new Date(at).toISOString(), delete_after: new Date(at + RECEIVER_TERMS.retainMs).toISOString() });
        return { bundle_id: p.bundle_id, bundle_sha256: p.bundle_sha256, status: "accepted", retrieval: issue(p.bundle_id, p.bundle_sha256) };
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    /** What the owner's chat would read: the verified files, only with an unexpired grant for that bundle and SHA. */
    async read(bundleId: string, token: string): Promise<BundleEntry[]> {
      const g = grants.get(token);
      if (!g || g.bundle_id !== bundleId) throw new ReceiverStop("GRANT_INVALID");
      if (now() > g.expires) {
        grants.delete(token);
        throw new ReceiverStop("GRANT_EXPIRED");
      }
      const v = await verifyBundleDir(join(await inbox(), bundleId), { limits: o.limits, expected: { ...(o.expected(bundleId) ?? { approval_id: "", plan_id: "", commit: "" }), bundle_sha256: g.bundle_sha256 } }).catch(asStop);
      return v.entries;
    },

    /**
     * Deletes every kept bundle whose RECEIVER record says its time is up (received_at + the receiver's own retention).
     * Fail closed: a kept bundle without a readable record of ours is deleted too. The manifest's dates are never read.
     */
    async purgeExpired(): Promise<string[]> {
      const root = await inbox();
      const gone: string[] = [];
      for (const name of await readdir(root)) {
        if (!APPROVAL_ID_RE.test(name)) continue;
        const rec = await readRecord(root, name);
        if (!rec || now() > Date.parse(rec.delete_after)) {
          await rm(join(root, name), { recursive: true, force: true });
          await rm(join(root, RECORDS, `${name}.json`), { force: true });
          for (const [t, g] of grants) if (g.bundle_id === name) grants.delete(t);
          gone.push(name);
        }
      }
      return gone;
    },
  };
}
export type FakeReceiver = ReturnType<typeof createFakeReceiver>;

/**
 * A fake transport over a FakeReceiver. `fail` lets a test break the link: "before" = the connection drops before the
 * receiver sees anything; "after" = the receiver stored it but the ack was lost.
 */
export function fakeTransport(receiver: FakeReceiver, script: { fail?: ("before" | "after" | null)[]; tamperAck?: boolean } = {}): BundleTransport & { calls: number } {
  const t = {
    calls: 0,
    async send(payload: BundlePayload, signal?: AbortSignal): Promise<DeliveryAck> {
      const mode = script.fail?.[t.calls] ?? null;
      t.calls += 1;
      if (signal?.aborted) throw new Error("aborted");
      if (mode === "before") throw new Error("connection reset");
      // the bytes cross a boundary: copy them so the receiver cannot alias the sender's buffers
      const ack = await receiver.receive({ ...payload, entries: payload.entries.map((e) => ({ path: e.path, bytes: Buffer.from(e.bytes) })) });
      if (mode === "after") throw new Error("ack lost");
      return script.tamperAck ? { ...ack, bundle_sha256: "0".repeat(64) } : ack;
    },
  };
  return t;
}
