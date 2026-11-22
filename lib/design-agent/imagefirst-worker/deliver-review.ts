/**
 * Issue #302 P3 follow-up: the post-processing entry that takes ONE finished, successful IMAGE_FIRST run (the private run
 * directory and the receipt cycle.ts wrote) to the owner's LOCAL review inbox: the receipt checked against the owner's
 * approval packet AS COMMITTED at the receipt's commit → packBundle (or, on a re-send, the bundle already sealed for it)
 * → handOffToLocalInbox (the receiver re-verifies, atomic rename) → previews + INDEX the jailed Claude reads.
 *
 * It reuses only existing parts: the approval reader and the fixed allowlist of the worker (cycle.ts, read only), the
 * bundle (bundle.ts), the local inbox and its delivery state machine (local-inbox.ts / transport.ts) and the worker's
 * lock. It has no runner and no approval parser of its own, and it cannot start anything: it imports no process
 * helper, no entry, no Codex, no image tool, and never calls the cycle (a test pins the imports). It never claims an
 * approval and never writes the entry's ledger. Nothing leaves the machine: no socket, no GitHub, no bridge spool.
 *
 * Called (a) by the worker CLI right after a cycle that ended "succeeded" (the automatic path: the same user, the same
 * process, after the cycle released its lock and after the run's result line was printed; skipped when a stop was
 * requested), and (b) through root's wrapper scripts/sales-design-worker/imagefirst-deliver-review.sh, which checks the
 * jailed Claude, the design cycle and the clone as root and then runs `imagefirst-worker.ts --deliver-review <approval id>`
 * as the worker user outside the jail, to re-send the SAME sealed bundle after a failed hand-off. A re-send packs only
 * the FIRST time (PR #310 re-review M-1): when the automatic hand-off stopped before sealing (REVIEW_LOCKED, a stop, a
 * transient git failure), so that there is no bundle directory, no delivery job and no inbox copy for the approval, the
 * re-send packs the bundle once from the same verified receipt and run, after every check above. Once any bundle or job
 * or inbox copy exists it never packs again: a missing bundle is then SEALED_BUNDLE_MISSING (a second pack would be
 * other bytes), an empty or partial one is refused, and the sealed bundle must still match the receipt byte for byte.
 * The worker's lock is released between the cycle and the hand-off (taken again here): a worker started by hand in that
 * moment makes the hand-off REVIEW_LOCKED, recovered by the same wrapper (PR #310 review L3).
 *
 * Before anything is sealed: the receipt's commit is on origin/develop in the trusted clone (injected git check) and the
 * worker's own claim marker for the approval exists and agrees with the receipt (read only). PR #310 review M2.
 *
 * Failures: ReviewStop with a fixed code (no path, no content), or a "not_delivered" result whose sealed bundle stays
 * for a re-send of the same bytes.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { BundleStop, packBundle, verifyBundleDir, type ExpectedRecord, type SealedBundle } from "./bundle";
import { checkRealApprovalId, isRequestRunId, readApprovalAt, runOfApprovalId, sha256, type CycleDeps, type CycleReport } from "./cycle";
import { handOffToLocalInbox, InboxStop, REVIEW_INBOX } from "./local-inbox";
import { PreviewStop } from "./preview";
import { DeliveryStop } from "./transport";
import { acquireLock } from "../worker/state";

export { REVIEW_INBOX };
/** Sealed bundles live next to the runs (~/sr-runs/bundles, 0700). */
export const BUNDLES = "bundles";
const RECEIPT_MAX = 256 * 1024;
const STAMP = "\\d{8}T\\d{6}Z";

/**
 * Fixed codes only: this module's own (APPROVAL_ID_INVALID, APPROVAL_ID_RESERVED, JAIL_ACTIVE, JAIL_STATE_UNKNOWN,
 * REVIEW_LOCKED, REVIEW_LOCK_FAILED, RUNS_DIR_UNSAFE, RECEIPT_MISSING, RECEIPT_AMBIGUOUS, RECEIPT_UNSAFE, RECEIPT_INVALID,
 * RECEIPT_NOT_SUCCEEDED, RECEIPT_ALLOWLIST_MISMATCH, RUN_NOT_IN_APPROVAL_WINDOW, APPROVAL_MISMATCH, PLAN_MISMATCH,
 * PACKET_MISMATCH, SEALED_BUNDLE_MISMATCH), the approval reader's (PACKET_UNREADABLE, PACKET_NOT_APPROVED, ...), and the
 * reused modules' (bundle.ts BundleStop, local-inbox.ts InboxStop, preview.ts PreviewStop, transport.ts DeliveryStop).
 */
export type ReviewCode = string;
export class ReviewStop extends Error {
  constructor(readonly code: ReviewCode) {
    super(code);
    this.name = "ReviewStop";
  }
}
const stop = (code: ReviewCode): never => {
  throw new ReviewStop(code);
};

export type DeliverReviewOptions = {
  approvalId: string;
  /** The worker's private runs directory (~/sr-runs): the receipt and its run directory are found here. */
  runsDir: string;
  /** The worker's state directory: its lock, and the delivery jobs (<state>/deliveries). */
  stateDir: string;
  /** The review inbox (default <runsDir>/review-inbox); its parent must be ours and 0700. */
  inboxDir?: string;
  /** The automatic path: the receipt the cycle just reported (must be the one found for this approval). */
  receiptPath?: string;
  /**
   * The manual path: true only when the jailed Claude (sr-jail-claude.service) is stopped AND disabled or masked, as the
   * automatic start requires; false = running / enabled, null = cannot tell (both refuse, nothing written).
   */
  jailIdle?: () => Promise<boolean | null>;
  /**
   * The manual re-send (PR #310 review L2, re-review M-1): the bundle sealed earlier goes again. When nothing was ever
   * sealed or sent for this approval (no bundle, no delivery job, no inbox copy), it packs once from the same verified
   * receipt and run; otherwise a missing or empty sealed bundle is refused (SEALED_BUNDLE_MISSING), never packed again.
   */
  resend?: boolean;
  /** A stop requested (the worker got SIGTERM / SIGINT): nothing starts after it, and the delivery attempt is aborted. */
  signal?: AbortSignal;
  now?: () => number;
};
export type DeliverReviewDeps = Pick<CycleDeps, "fileAt"> & {
  /**
   * PR #310 review M2: true only when `commit` is an ancestor of (or equal to) origin/develop in the worker's trusted
   * clone (`git merge-base --is-ancestor <commit> origin/develop`). The cycle only ever runs on origin/develop, so a
   * receipt naming any other commit is refused (COMMIT_NOT_ON_ORIGIN_DEVELOP). Injected: this module starts no process.
   */
  onOriginDevelop: (commit: string) => Promise<boolean>;
};
export type DeliverReviewResult = {
  status: "delivered" | "duplicate" | "not_delivered";
  code: string | null;
  approval_id: string;
  bundle_sha256: string;
  /** "sealed" = packed now; "existing" = the bundle sealed earlier for this receipt (a re-send). */
  bundle: "sealed" | "existing";
  previews: "built" | "duplicate" | null;
  previews_dir: string | null;
  sent: boolean;
};

type Receipt = {
  schema?: unknown;
  status?: unknown;
  stop_code?: unknown;
  interrupted?: unknown;
  verified?: unknown;
  shop?: unknown;
  direction?: unknown;
  approval_id?: unknown;
  plan_id?: unknown;
  commit?: unknown;
  packet_sha256?: unknown;
  plan_sha256?: unknown;
  prompt_sha256?: unknown;
  prompt_chars?: unknown;
  run_dir?: unknown;
  mode?: unknown;
  kind?: unknown;
  request_id?: unknown;
  request_sha256?: unknown;
  images_total?: unknown;
  counts?: { pc?: unknown; sp?: unknown; total?: unknown; stopped?: unknown } | null;
  timings?: { started_at?: unknown; finished_at?: unknown } | null;
};

/** A reused module's fixed-code stop becomes a ReviewStop with the same code; anything else is rethrown. */
const asReviewStop = (error: unknown): never => {
  const code = (error as { code?: unknown } | null)?.code;
  if ((error instanceof BundleStop || error instanceof InboxStop || error instanceof PreviewStop || error instanceof DeliveryStop) && typeof code === "string") stop(code);
  throw error;
};

const ownPrivateDir = async (p: string) => {
  const info = await lstat(p).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
};

/** The receipt bytes: a regular file of ours, 0600, no link, one name, small; read on the same handle that was checked. */
async function readReceipt(path: string): Promise<Buffer> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return stop("RECEIPT_UNSAFE");
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > RECEIPT_MAX) stop("RECEIPT_UNSAFE");
    return await h.readFile();
  } finally {
    await h.close();
  }
}

/** The one receipt the worker wrote for this approval (<id>-<UTC stamp>.receipt.json): the claim is one-use, so one. */
async function findReceipt(runs: string, approvalId: string): Promise<string> {
  const re = new RegExp(`^${approvalId}-${STAMP}\\.receipt\\.json$`);
  const found = (await readdir(runs)).filter((n) => re.test(n));
  if (found.length === 0) stop("RECEIPT_MISSING");
  if (found.length > 1) stop("RECEIPT_AMBIGUOUS");
  return join(runs, found[0]!);
}

/**
 * The receipt is a finished, verified, complete run of exactly this approval within the fixed allowlist, and the
 * approval packet at the receipt's commit is the owner's approval of exactly this run (approval ID, plan ID, packet SHA,
 * §3 pins), and the run started inside that approval's window. Returns the record the bundle must match.
 */
async function checkReceipt(r: Receipt, approvalId: string, runDir: string, stateDir: string, d: DeliverReviewDeps): Promise<ExpectedRecord> {
  // the allowlist row the approval id names (d3 or d4): its pins, its packet; never another direction's
  const a = runOfApprovalId(approvalId);
  if (a === null) return stop("APPROVAL_ID_INVALID");
  if (!r || typeof r !== "object" || r.schema !== "imagefirst_worker_receipt_v1") stop("RECEIPT_INVALID");
  if (r.approval_id !== approvalId || typeof r.commit !== "string" || !/^[0-9a-f]{40}$/.test(r.commit) || typeof r.plan_id !== "string" || typeof r.packet_sha256 !== "string") stop("RECEIPT_INVALID");
  // PR #310 review L1: compared by real path (the worker names ~/sr-runs as written; a home reached through a link is fine)
  if (typeof r.run_dir !== "string" || (await realpath(r.run_dir).catch(() => null)) !== runDir) stop("RECEIPT_INVALID");
  const c = r.counts;
  if (r.status !== "succeeded" || r.stop_code !== null || r.interrupted !== false || r.verified !== true || !c || c.pc !== a.images.pc || c.sp !== a.images.sp || c.total !== a.images.pc + a.images.sp || c.stopped !== 0) stop("RECEIPT_NOT_SUCCEEDED");
  if (r.shop !== a.shop || r.direction !== a.direction || r.plan_sha256 !== a.planSha256 || r.prompt_sha256 !== a.promptSha256 || r.prompt_chars !== a.promptChars) stop("RECEIPT_ALLOWLIST_MISMATCH");
  const started = typeof r.timings?.started_at === "string" ? Date.parse(r.timings.started_at) : NaN;
  if (!Number.isFinite(started)) stop("RECEIPT_INVALID");
  const finished = typeof r.timings?.finished_at === "string" ? Date.parse(r.timings.finished_at) : NaN;
  if (!Number.isFinite(finished) || finished < started) stop("RECEIPT_INVALID");
  // PR #310 review M2: the commit is on origin/develop (the cycle runs nowhere else); below, the worker's own one-use
  // claim for this approval exists and agrees with the receipt (read only: never created, changed or removed here)
  if (!(await d.onOriginDevelop(r.commit as string).catch(() => false))) stop("COMMIT_NOT_ON_ORIGIN_DEVELOP");
  // the owner's approval as committed at the receipt's commit (the same reader and checks as the worker's cycle)
  const at = await readApprovalAt(r.commit as string, d.fileAt, started, a);
  if ("code" in at) {
    if (at.code === "APPROVAL_NOT_VALID_AT_RUN") stop("RUN_NOT_IN_APPROVAL_WINDOW");
    return stop(at.code);
  }
  if (at.approvalId !== approvalId) stop("APPROVAL_MISMATCH");
  if (at.planId !== r.plan_id) stop("PLAN_MISMATCH");
  if (at.packetSha256 !== r.packet_sha256) stop("PACKET_MISMATCH");
  await checkClaim(stateDir, approvalId, started, finished);
  return { approval_id: at.approvalId, plan_id: at.planId, commit: r.commit as string };
}

/**
 * DEV-303: a request run's receipt. There is no packet: the request (its SHA-256 is the receipt's packet_sha256, which
 * the worker checked against root's) was the run's approval. The receipt is a finished, verified, complete run of exactly
 * this request id (PC 2 + SP 4), its commit is on origin/develop and the worker's own claim for the id agrees with it.
 */
async function checkRequestReceipt(r: Receipt, id: string, runDir: string, stateDir: string, d: DeliverReviewDeps): Promise<ExpectedRecord> {
  if (!r || typeof r !== "object" || r.schema !== "imagefirst_worker_receipt_v1" || r.mode !== "request") stop("RECEIPT_INVALID");
  if (r.approval_id !== id || r.request_id !== id || r.plan_id !== id || typeof r.commit !== "string" || !/^[0-9a-f]{40}$/.test(r.commit)) stop("RECEIPT_INVALID");
  if (typeof r.request_sha256 !== "string" || r.request_sha256 !== r.packet_sha256 || (r.kind !== "real_shop" && r.kind !== "fictional") || r.direction !== "request") stop("RECEIPT_INVALID");
  if (typeof r.run_dir !== "string" || (await realpath(r.run_dir).catch(() => null)) !== runDir) stop("RECEIPT_INVALID");
  const c = r.counts;
  if (r.status !== "succeeded" || r.stop_code !== null || r.interrupted !== false || r.verified !== true || !c || c.pc !== 2 || c.sp !== 4 || c.total !== 6 || c.stopped !== 0 || r.images_total !== 6) stop("RECEIPT_NOT_SUCCEEDED");
  const started = typeof r.timings?.started_at === "string" ? Date.parse(r.timings.started_at) : NaN;
  const finished = typeof r.timings?.finished_at === "string" ? Date.parse(r.timings.finished_at) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) stop("RECEIPT_INVALID");
  if (!(await d.onOriginDevelop(r.commit as string).catch(() => false))) stop("COMMIT_NOT_ON_ORIGIN_DEVELOP");
  await checkClaim(stateDir, id, started, finished);
  return { approval_id: id, plan_id: id, commit: r.commit as string };
}

/** A claim is made right after the run's start time is taken and before the entry starts (cycle.ts): it lies in the run. */
const CLAIM_SLACK_MS = 5 * 60_000;
/** The worker's claim marker <state>/claims/<id>.used: a regular file of ours, no link, naming this approval, made during this run. */
async function checkClaim(stateDir: string, approvalId: string, started: number, finished: number): Promise<void> {
  let h;
  try {
    h = await open(join(stateDir, "claims", `${approvalId}.used`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return stop((error as { code?: string }).code === "ENOENT" ? "CLAIM_MISSING" : "CLAIM_MISMATCH");
  }
  let c: { approval_id?: unknown; claimed_at?: unknown };
  try {
    const st = await h.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 4096) stop("CLAIM_MISMATCH");
    c = JSON.parse((await h.readFile()).toString("utf8")) as typeof c;
  } catch (error) {
    if (error instanceof ReviewStop) throw error;
    return stop("CLAIM_MISMATCH");
  } finally {
    await h.close();
  }
  const at = typeof c?.claimed_at === "string" ? Date.parse(c.claimed_at) : NaN;
  if (c?.approval_id !== approvalId || !Number.isFinite(at) || at < started - CLAIM_SLACK_MS || at > finished) stop("CLAIM_MISMATCH");
}

/**
 * The bundle for this receipt: packed now (packBundle checks the run directory, every picture's SHA-256 against the
 * receipt, PC 2 + SP 4, no link), or — on a re-send — the one sealed earlier, verified again and required to come from
 * exactly these receipt bytes. A re-send packs only when nothing was ever sealed or sent for this approval; it never
 * packs a second time and never regenerates.
 */
async function sealedFor(o: { runDir: string; receiptPath: string; receiptBytes: Buffer; bundlesDir: string; stateDir: string; inboxDir: string; expected: ExpectedRecord; resend: boolean; now?: () => number }): Promise<{ sealed: SealedBundle; how: "sealed" | "existing" }> {
  const id = o.expected.approval_id;
  const dir = join(o.bundlesDir, id);
  let sealed: SealedBundle;
  let how: "sealed" | "existing";
  const present = (p: string) => lstat(p).then(() => true, () => false);
  const exists = await present(dir);
  if (o.resend) {
    // an empty bundle directory is never a bundle (PR #310 review L2)
    if (exists && (await readdir(dir).then((n) => n.length === 0, () => true))) stop("SEALED_BUNDLE_MISSING");
    // no bundle: the first pack only when nothing was ever sealed or sent for this approval (PR #310 re-review M-1)
    if (!exists && ((await present(join(o.stateDir, "deliveries", `${id}.json`))) || (await present(join(o.inboxDir, id))))) stop("SEALED_BUNDLE_MISSING");
  }
  if (exists) {
    const v = await verifyBundleDir(dir, { expected: o.expected }).catch(asReviewStop);
    sealed = { dir, bundle_id: v.manifest.bundle_id, bundle_sha256: v.bundle_sha256, manifest: v.manifest };
    how = "existing";
  } else {
    sealed = await packBundle({ runDir: o.runDir, receiptPath: o.receiptPath, bundlesDir: o.bundlesDir, ...(o.now ? { now: o.now } : {}) }).catch(asReviewStop);
    how = "sealed";
  }
  // the bytes packed (or packed earlier) are the receipt that was checked above, and the record is the approval's
  const m = sealed.manifest;
  if (m.receipt_original_sha256 !== sha256(o.receiptBytes) || m.approval_id !== o.expected.approval_id || m.plan_id !== o.expected.plan_id || m.commit !== o.expected.commit) stop("SEALED_BUNDLE_MISMATCH");
  return { sealed, how };
}

/** One review delivery for one finished run (see the header). Takes the worker's lock; never claims, invokes or retries. */
export async function deliverReview(o: DeliverReviewOptions, d: DeliverReviewDeps): Promise<DeliverReviewResult> {
  // DEV-303: a request run's id, or a real run's approval id
  const request = isRequestRunId(o.approvalId);
  const idCheck = request ? "ok" : checkRealApprovalId(o.approvalId);
  if (idCheck !== "ok") stop(idCheck);
  if (o.signal?.aborted) stop("REVIEW_ABORTED");
  if (o.jailIdle) {
    const idle = await o.jailIdle().catch(() => null);
    if (idle === null) stop("JAIL_STATE_UNKNOWN");
    if (idle !== true) stop("JAIL_ACTIVE");
  }
  if (!(await ownPrivateDir(o.runsDir))) stop("RUNS_DIR_UNSAFE");
  const runs = await realpath(o.runsDir);
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(o.stateDir, new Date((o.now ?? Date.now)()), "imagefirst.lock");
  } catch {
    return stop("REVIEW_LOCK_FAILED");
  }
  if (lock === undefined) return stop("REVIEW_LOCKED");
  try {
    const receiptPath = await findReceipt(runs, o.approvalId);
    // PR #310 review L1: the cycle's report names the receipt as written; compare real paths
    if (o.receiptPath !== undefined && (await realpath(o.receiptPath).catch(() => null)) !== receiptPath) stop("RECEIPT_AMBIGUOUS");
    const runDir = join(runs, basename(receiptPath, ".receipt.json"));
    const receiptBytes = await readReceipt(receiptPath);
    let r: Receipt;
    try {
      r = JSON.parse(receiptBytes.toString("utf8")) as Receipt;
    } catch {
      return stop("RECEIPT_INVALID");
    }
    const expected = request ? await checkRequestReceipt(r, o.approvalId, runDir, o.stateDir, d) : await checkReceipt(r, o.approvalId, runDir, o.stateDir, d);
    if (o.signal?.aborted) stop("REVIEW_ABORTED");
    const inboxDir = o.inboxDir ?? join(runs, REVIEW_INBOX);
    const { sealed, how } = await sealedFor({ runDir, receiptPath, receiptBytes, bundlesDir: join(runs, BUNDLES), stateDir: o.stateDir, inboxDir, expected, resend: o.resend === true, ...(o.now ? { now: o.now } : {}) });
    if (o.signal?.aborted) stop("REVIEW_ABORTED");
    const h = await handOffToLocalInbox({ sealed, stateDir: o.stateDir, inboxDir, expected, ...(o.now ? { now: o.now } : {}), ...(o.signal ? { signal: o.signal } : {}) }).catch(asReviewStop);
    const base = { approval_id: o.approvalId, bundle_sha256: sealed.bundle_sha256, bundle: how, sent: h.delivery.sent };
    if (h.delivery.state !== "delivered" || !h.previews) return { ...base, status: "not_delivered", code: h.delivery.code, previews: null, previews_dir: null };
    const duplicate = !h.delivery.sent || h.delivery.ack?.status === "duplicate";
    return { ...base, status: duplicate ? "duplicate" : "delivered", code: null, previews: h.previews.status, previews_dir: h.previews.dir };
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/** The review summary (codes only). The worker writes it to stderr and its audit file, never to the run's stdout line. */
export type ReviewSummary = { status: DeliverReviewResult["status"] | "refused" | "stopped"; code: string | null; bundle_sha256?: string };

/**
 * The automatic path, called by the worker CLI after its cycle: only a "succeeded" report with a receipt is delivered;
 * anything else returns null and touches nothing. Never throws: a refusal is a summary line, the run's result stands.
 */
export async function deliverAfterRun(report: CycleReport, o: Omit<DeliverReviewOptions, "approvalId" | "receiptPath" | "jailIdle" | "resend">, d: DeliverReviewDeps): Promise<ReviewSummary | null> {
  if (report.status !== "succeeded" || !report.receipt || !report.approval_id) return null;
  // a stop was requested: no hand-off at all (the sealed-or-not run is recovered later by the root wrapper's re-send)
  if (o.signal?.aborted) return { status: "refused", code: "REVIEW_ABORTED" };
  try {
    const r = await deliverReview({ ...o, approvalId: report.approval_id, receiptPath: report.receipt }, d);
    return { status: r.status, code: r.code, bundle_sha256: r.bundle_sha256 };
  } catch (error) {
    return error instanceof ReviewStop ? { status: "refused", code: error.code } : { status: "stopped", code: "REVIEW_UNEXPECTED" };
  }
}
