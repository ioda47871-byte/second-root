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
 * process, after the cycle released its lock), and (b) by hand, `imagefirst-worker.ts --deliver-review <approval id>`,
 * to re-send the SAME sealed bundle after a failed hand-off (the manual path, which also requires the jailed Claude to be
 * stopped and disabled). A re-send never re-packs: the sealed bundle must still match the receipt byte for byte.
 *
 * Failures: ReviewStop with a fixed code (no path, no content), or a "not_delivered" result whose sealed bundle stays
 * for a re-send of the same bytes.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { BundleStop, packBundle, verifyBundleDir, type ExpectedRecord, type SealedBundle } from "./bundle";
import { checkRealApprovalId, IMAGEFIRST_ALLOWLIST, readApprovalAt, sha256, type CycleDeps, type CycleReport } from "./cycle";
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
  now?: () => number;
};
export type DeliverReviewDeps = Pick<CycleDeps, "fileAt">;
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
  counts?: { pc?: unknown; sp?: unknown; total?: unknown; stopped?: unknown } | null;
  timings?: { started_at?: unknown } | null;
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
async function checkReceipt(r: Receipt, approvalId: string, runDir: string, d: DeliverReviewDeps): Promise<ExpectedRecord> {
  const a = IMAGEFIRST_ALLOWLIST;
  if (!r || typeof r !== "object" || r.schema !== "imagefirst_worker_receipt_v1") stop("RECEIPT_INVALID");
  if (r.approval_id !== approvalId || typeof r.commit !== "string" || !/^[0-9a-f]{40}$/.test(r.commit) || typeof r.plan_id !== "string" || typeof r.packet_sha256 !== "string") stop("RECEIPT_INVALID");
  if (r.run_dir !== runDir) stop("RECEIPT_INVALID");
  const c = r.counts;
  if (r.status !== "succeeded" || r.stop_code !== null || r.interrupted !== false || r.verified !== true || !c || c.pc !== a.images.pc || c.sp !== a.images.sp || c.total !== a.images.pc + a.images.sp || c.stopped !== 0) stop("RECEIPT_NOT_SUCCEEDED");
  if (r.shop !== a.shop || r.direction !== a.direction || r.plan_sha256 !== a.planSha256 || r.prompt_sha256 !== a.promptSha256 || r.prompt_chars !== a.promptChars) stop("RECEIPT_ALLOWLIST_MISMATCH");
  const started = typeof r.timings?.started_at === "string" ? Date.parse(r.timings.started_at) : NaN;
  if (!Number.isFinite(started)) stop("RECEIPT_INVALID");
  // the owner's approval as committed at the receipt's commit (the same reader and checks as the worker's cycle)
  const at = await readApprovalAt(r.commit as string, d.fileAt, started);
  if ("code" in at) {
    if (at.code === "APPROVAL_NOT_VALID_AT_RUN") stop("RUN_NOT_IN_APPROVAL_WINDOW");
    return stop(at.code);
  }
  if (at.approvalId !== approvalId) stop("APPROVAL_MISMATCH");
  if (at.planId !== r.plan_id) stop("PLAN_MISMATCH");
  if (at.packetSha256 !== r.packet_sha256) stop("PACKET_MISMATCH");
  return { approval_id: at.approvalId, plan_id: at.planId, commit: r.commit as string };
}

/**
 * The bundle for this receipt: packed now (packBundle checks the run directory, every picture's SHA-256 against the
 * receipt, PC 2 + SP 4, no link), or — on a re-send — the one sealed earlier, verified again and required to come from
 * exactly these receipt bytes (never re-packed, never regenerated).
 */
async function sealedFor(o: { runDir: string; receiptPath: string; receiptBytes: Buffer; bundlesDir: string; expected: ExpectedRecord; now?: () => number }): Promise<{ sealed: SealedBundle; how: "sealed" | "existing" }> {
  const dir = join(o.bundlesDir, o.expected.approval_id);
  let sealed: SealedBundle;
  let how: "sealed" | "existing";
  if (await lstat(dir).then(() => true, () => false)) {
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
  const idCheck = checkRealApprovalId(o.approvalId);
  if (idCheck !== "ok") stop(idCheck);
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
    if (o.receiptPath !== undefined && o.receiptPath !== receiptPath) stop("RECEIPT_AMBIGUOUS");
    const runDir = join(runs, basename(receiptPath, ".receipt.json"));
    const receiptBytes = await readReceipt(receiptPath);
    let r: Receipt;
    try {
      r = JSON.parse(receiptBytes.toString("utf8")) as Receipt;
    } catch {
      return stop("RECEIPT_INVALID");
    }
    const expected = await checkReceipt(r, o.approvalId, runDir, d);
    const { sealed, how } = await sealedFor({ runDir, receiptPath, receiptBytes, bundlesDir: join(runs, BUNDLES), expected, ...(o.now ? { now: o.now } : {}) });
    const h = await handOffToLocalInbox({ sealed, stateDir: o.stateDir, inboxDir: o.inboxDir ?? join(runs, REVIEW_INBOX), expected, ...(o.now ? { now: o.now } : {}) }).catch(asReviewStop);
    const base = { approval_id: o.approvalId, bundle_sha256: sealed.bundle_sha256, bundle: how, sent: h.delivery.sent };
    if (h.delivery.state !== "delivered" || !h.previews) return { ...base, status: "not_delivered", code: h.delivery.code, previews: null, previews_dir: null };
    const duplicate = !h.delivery.sent || h.delivery.ack?.status === "duplicate";
    return { ...base, status: duplicate ? "duplicate" : "delivered", code: null, previews: h.previews.status, previews_dir: h.previews.dir };
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/** The review summary the worker adds to its one JSON line (codes only). */
export type ReviewSummary = { status: DeliverReviewResult["status"] | "refused" | "stopped"; code: string | null; bundle_sha256?: string };

/**
 * The automatic path, called by the worker CLI after its cycle: only a "succeeded" report with a receipt is delivered;
 * anything else returns null and touches nothing. Never throws: a refusal is a summary line, the run's result stands.
 */
export async function deliverAfterRun(report: CycleReport, o: Omit<DeliverReviewOptions, "approvalId" | "receiptPath" | "jailIdle">, d: DeliverReviewDeps): Promise<ReviewSummary | null> {
  if (report.status !== "succeeded" || !report.receipt || !report.approval_id) return null;
  try {
    const r = await deliverReview({ ...o, approvalId: report.approval_id, receiptPath: report.receipt }, d);
    return { status: r.status, code: r.code, bundle_sha256: r.bundle_sha256 };
  } catch (error) {
    return error instanceof ReviewStop ? { status: "refused", code: error.code } : { status: "stopped", code: "REVIEW_UNEXPECTED" };
  }
}
