/**
 * Issue #298 P1: the thin WSL worker adapter for ONE owner-approved IMAGE_FIRST job (ほし窯 d3 only). Offline code: it
 * calls nothing by itself. One cycle:
 *
 *   exclusive lock → HEAD = origin/develop and a clean tree → the approval packet read AS COMMITTED at HEAD (never the
 *   working tree) → fixed allowlist (shop hoshigama, direction d3 alone), expiry within 24 h, the packet's §3 pins and
 *   the plan rebuilt from the inputs at HEAD equal the fixed SHAs, the approval unused in the phase2f ledger and never
 *   claimed by this worker → the one-use claim (O_EXCL) → the EXISTING entry (scripts/design-artifact/image-first-generate.ts)
 *   invoked ONCE through the injected `invoke` (the CLI spawns it; the entry re-checks every pin itself) → the private
 *   run directory read back: a receipt with codes, SHA-256 of every picture, counts and timings → unlock.
 *
 * Not approved / not hoshigama+d3 / expired / outside the window / used or claimed / a pin mismatch: a "no_job" or
 * "refused" line and nothing is invoked. Never retried: a claimed approval is never invoked again, whatever happened.
 * The receipt holds no prompt text and no secret. Pictures stay in the private run directory (0700, outside the repo).
 *
 * Ported from curiosity-media 2e7a673b10c1cc61ed60aeb60bd9be5f16701437 (docs/operations/imagefirst-worker-port.md):
 *   - the one-use claim: packages/automation/src/body-image-approvals.ts claimBodyImageApproval (an O_EXCL marker in
 *     the worker's state dir, made right before use; EEXIST = used, any other failure = refused, never "on");
 *   - the gate order: packages/automation/src/entry-image-worker.ts runImageWorker (lock → assertOnOriginMain → read the
 *     approval right after the pin) with origin/main → origin/develop.
 * The lock, the process bounding and the environment allowlist are Second Root's own ports (worker/state.ts,
 * bounded-process.ts, worker/env.ts) and are reused, not copied again.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runBounded, type BoundedResult } from "../bounded-process";
import { buildPromptPlan, loadPromptInputs, PromptStop } from "../image-first/prompt";
import { APPROVAL_PACKET_PATH, FULL_PAGE_KIND, FULL_PAGE_ROUTE, MAX_APPROVAL_WINDOW_MS, parseUtcInstant, readApprovalPacket } from "../phase2f-live/full-page-call";
import { LedgerStop, type Ledger } from "../phase2f-live/ledger";
import type { CommitState } from "../phase2f-live/steps";
import { acquireLock, WorkerStepError } from "../worker/state";

/** The existing entry this worker hands the job to (repository-relative). */
export const GENERATE_ENTRY = "scripts/design-artifact/image-first-generate.ts";

/**
 * The fixed allowlist: one shop, one direction, and the plan the packet's §3 pins for it (d3 column). Nothing here is
 * taken from a job file or an argument: a different shop, direction or plan needs a code change and its own review.
 */
export const IMAGEFIRST_ALLOWLIST = {
  shop: "hoshigama",
  shopId: "fictional-bakery-hoshigama",
  direction: "d3",
  planSha256: "a19b6896ffd50111df9ad7029f49ded5757999ddfb31943103a206f6a44072a8",
  promptSha256: "291475d9ae66b2308d147a7b56ae1a0c9c53822e44cd5425d60976513712e398",
  promptChars: 12338,
  images: { pc: 2, sp: 4 },
} as const;
const APPROVAL_ID = /^hoshigama-imagefirst-d3-\d{8}-\d{2}$/;
/**
 * The date part reserved for the dummy review PoC (review-poc.ts DUMMY_ID, hoshigama-imagefirst-d3-00000000-00). PR #308
 * review L4: enforced, not a convention: the worker's cycle and precheck, its claim, the automatic start's grant (and its
 * run marker) refuse it, so the dummy can never be a real run's approval. The local hand-off itself (local-inbox.ts)
 * accepts it on purpose: the dummy PoC delivers that ID.
 */
export const RESERVED_APPROVAL_DATE = "00000000";
export type ApprovalIdCheck = "ok" | "APPROVAL_ID_INVALID" | "APPROVAL_ID_RESERVED";
/** A ほし窯 d3 approval id a REAL run may use: the shape, never the reserved dummy date, and a real calendar date (UTC). */
export function checkRealApprovalId(id: string): ApprovalIdCheck {
  if (!APPROVAL_ID.test(id)) return "APPROVAL_ID_INVALID";
  const date = id.split("-")[3]!;
  if (date === RESERVED_APPROVAL_DATE) return "APPROVAL_ID_RESERVED";
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6, 8))];
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? "ok" : "APPROVAL_ID_INVALID";
}
/** Fail closed before claiming: malformed values must never spend a valid one-use approval. */
const PLAN_ID = /^hoshigama-imagefirst-p3-\d{8}$/;
const STOP_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * How an interrupted run still ends with a receipt (PR #301 review L1). On SIGTERM / SIGINT / SIGHUP the worker aborts
 * the invocation: the entry's group gets SIGTERM; the entry stops its call, hard-stops 20 s later and cleans up for at
 * most 10 s more (stopSignals in the shared CLI helper). The worker waits `graceMs` (longer than that) before SIGKILL, then
 * writes the receipt and the audit line. Only if the worker is still waiting at `hardStopMs` (or gets a second signal)
 * does it kill every group and write the receipt from what is on disk (`recordInterrupted`), for at most `recordMs`.
 */
export const WORKER_STOP = { entryStopMs: 20_000 + 10_000, graceMs: 35_000, hardStopMs: 50_000, recordMs: 10_000, repeatGraceMs: 1_000 } as const;
/** The precheck says "would run" only with at least this much of the approval left (Issue #302 review L5). */
export const PRECHECK_MIN_LEFT_MS = 5 * 60_000;
/**
 * How the worker starts a TypeScript entry: node itself with the tsx loader (`node --import tsx <file>`, cwd = the clone),
 * never the tsx CLI. The CLI is a parent process that relays signals with a 30 ms window and then sends another
 * TERM / SIGKILL, so one stop could reach the entry twice (a hard stop) or kill it (Issue #302 review M4). With node as
 * the process-group leader, runBounded's one SIGTERM to the group reaches the entry once.
 */
export const tsEntry = (file: string, argv: readonly string[] = []) => ({ bin: process.execPath, args: ["--import=tsx", file, ...argv] });

/** would_run: only from precheckImagefirstCycle (every check up to the claim passed; nothing was written). */
export type CycleStatus = "no_job" | "locked" | "refused" | "succeeded" | "stopped" | "would_run";
export type CycleReport = { status: CycleStatus; code: string | null; invoked: boolean; approval_id?: string; run_dir?: string; receipt?: string };
export const exitCodeOf = (s: CycleStatus) => (s === "refused" ? 2 : s === "stopped" ? 1 : 0);
/** The precheck's exit: 0 = would run, 3 = no job (not approved), 2 = refused; nothing was claimed or written either way. */
export const precheckExitOf = (s: CycleStatus) => (s === "would_run" ? 0 : s === "no_job" ? 3 : s === "refused" ? 2 : 1);

export type ReceiptImage = { file: string; sha256: string; bytes: number };
export type WorkerReceipt = {
  schema: "imagefirst_worker_receipt_v1";
  status: "succeeded" | "stopped";
  stop_code: string | null;
  stage: "precheck" | "call" | "verify" | null;
  /** The worker was stopped by a signal while the entry ran (stop_code WORKER_INTERRUPTED unless the run completed). */
  interrupted: boolean;
  cli_exit: number | null;
  cli_timed_out: boolean;
  shop: string;
  direction: string;
  approval_id: string;
  plan_id: string;
  commit: string;
  packet_sha256: string;
  plan_sha256: string;
  prompt_sha256: string;
  prompt_chars: number;
  run_dir: string;
  images: ReceiptImage[];
  stopped_images: ReceiptImage[];
  counts: { pc: number; sp: number; total: number; stopped: number };
  /** Every picture's SHA-256 on disk equals the one the entry recorded in call.json. */
  verified: boolean;
  timings: { started_at: string; finished_at: string; elapsed_ms: number };
};

export type CycleOptions = {
  /** The worker's clone (its real path). */
  repoRoot: string;
  /** The worker's state dir (lock, claims, audit). Outside the repository. */
  stateDir: string;
  /** Where the private run directories go (0700). Outside the repository. */
  runsDir: string;
  signal?: AbortSignal;
  /**
   * Called once, right before the claim (it waits for the claim; no claim, nothing recorded), with a function that ends the run with a receipt
   * (stop code WORKER_INTERRUPTED) and an audit line from what is on disk. The worker calls it when it must exit before
   * the invocation returns; when the run has already ended it waits for that receipt instead. It never invokes anything.
   */
  onInvoking?: (recordInterrupted: () => Promise<void>) => void;
  /**
   * Issue #302 P1 (automatic start): the approval id root's one-use run marker names. When given, the packet's d3
   * approval id must be exactly this one (APPROVAL_NOT_GRANTED otherwise), checked before the claim. It only narrows:
   * the packet, its §10, the pins, the claim and the entry's ledger decide as before. Absent (a run by hand): unchanged.
   */
  expectApprovalId?: string;
};

/** The automatic start's grant, as root passes it to the worker (environment, set only by imagefirst-autostart.sh). */
export const GRANT_ENV = "SR_IMAGEFIRST_EXPECT_APPROVAL_ID";
/** undefined = no grant (a run by hand); null = a grant that is not a ほし窯 d3 approval id (refused before anything). */
export function grantFromEnv(env: NodeJS.ProcessEnv): string | null | undefined {
  const v = env[GRANT_ENV];
  if (v === undefined) return undefined;
  return checkRealApprovalId(v) === "ok" ? v : null;
}
export type CycleDeps = {
  commit: () => Promise<CommitState>;
  /** A file's bytes as committed (`git show <commit>:<path>`); null when unreadable. */
  fileAt: (commit: string, repoRelativePath: string) => Promise<Buffer | null>;
  /** The phase2f ledger the entry itself uses (read only here: precheck). */
  ledger: Ledger;
  /** Starts the existing entry with these arguments, once. */
  invoke: (argv: string[], signal?: AbortSignal) => Promise<BoundedResult>;
  now?: () => number;
};

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** HEAD, origin/develop and whether the tree is clean (the same three git reads as the entry's own commit pin). */
export async function gitCommitState(repo: string, env: NodeJS.ProcessEnv): Promise<CommitState> {
  const git = (a: string[]) => runBounded("git", a, { cwd: repo, env, timeoutMs: 60_000 }).then((r) => (r.code === 0 ? r.stdout : null), () => null);
  const [head, base, status] = await Promise.all([git(["rev-parse", "HEAD"]), git(["rev-parse", "origin/develop"]), git(["status", "--porcelain", "--untracked-files=all"])]);
  return { head: head?.trim() ?? null, base: base?.trim() ?? null, clean: status === "" };
}

/** The d3 column of the packet's §3 pin table (計画 SHA, バッチ SHA, バッチ文字数); null unless each row is there exactly once. */
export function packetPins(bytes: Buffer): { planSha256: string; promptSha256: string; promptChars: number } | null {
  const rows = new Map<string, string[]>();
  let fence = false;
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    if (fence || !line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const label = (cells[0] ?? "").split("（")[0]!.trim();
    if (!["計画 SHA", "バッチ SHA", "バッチ文字数"].includes(label) || cells.length !== 3) continue;
    if (rows.has(label)) return null;
    rows.set(label, cells.map((c) => c.replace(/^`([^`]*)`$/, "$1").trim()));
  }
  const d3 = (label: string) => rows.get(label)?.[2] ?? null;
  const plan = d3("計画 SHA");
  const prompt = d3("バッチ SHA");
  const chars = d3("バッチ文字数");
  if (!plan || !prompt || !chars || !/^\d{1,6}$/.test(chars)) return null;
  return { planSha256: plan, promptSha256: prompt, promptChars: Number(chars) };
}

/** The entry's arguments for this job: every value from the packet at the pinned commit or the fixed allowlist. */
export function generateArgv(o: { repoRoot: string; outDir: string; planId: string; approvalId: string; expires: string; packetSha256: string; commit: string }): string[] {
  const a = IMAGEFIRST_ALLOWLIST;
  return [
    "--direction", a.direction,
    "--out", o.outDir,
    "--plan-id", o.planId,
    "--approval-id", o.approvalId,
    "--approval-expires", o.expires,
    "--packet", join(o.repoRoot, APPROVAL_PACKET_PATH),
    "--expected-prompt-sha256", a.promptSha256,
    "--expected-prompt-chars", String(a.promptChars),
    "--expected-plan-sha256", a.planSha256,
    "--expected-packet-sha256", o.packetSha256,
    "--expected-commit", o.commit,
    // the owner's confirmation is the filled-in §10 of the packet at the approved commit, which the entry reads itself
    "--human-approval-confirmed",
  ];
}

/** A directory we may write in: a real directory, owned by this user, closed to group and others. */
const ours = (info: { isDirectory(): boolean; uid: number; mode: number }) => info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** A name inside an open directory, reached through that handle (Linux /proc: the same object as openat(fd, name)). */
const under = (dir: { fd: number }, name: string) => `/proc/self/fd/${dir.fd}/${name}`;
type ClaimResult = "claimed" | "APPROVAL_ALREADY_CLAIMED" | "CLAIMS_DIR_UNSAFE" | "CLAIM_FAILED" | "APPROVAL_ID_INVALID" | "APPROVAL_ID_RESERVED";

/**
 * One-use claim (ported: body-image-approvals.ts claimBodyImageApproval): "claimed" only when this call created the
 * marker. Race-free (PR #303 review L1): `stateDir` is opened once with O_DIRECTORY|O_NOFOLLOW and checked on that
 * handle; `claims` is made and opened the same way relative to the handle; the marker is created relative to the
 * `claims` handle with O_EXCL|O_NOFOLLOW. A path swapped after the earlier lstat checks cannot redirect it any more.
 * Without /proc (not Linux) nothing is created: CLAIM_FAILED, never "claimed".
 */
export async function claimApproval(stateDir: string, approvalId: string, at: number): Promise<ClaimResult> {
  // nothing is created for an id a real run may not use (the dummy PoC's reserved date included)
  const idCheck = checkRealApprovalId(approvalId);
  if (idCheck !== "ok") return idCheck;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const unsafe = (code: string | undefined) => code === "ELOOP" || code === "ENOTDIR";
  try {
    const state = await open(stateDir, DIR_FLAGS);
    handles.push(state);
    if (!ours(await state.stat())) return "CLAIMS_DIR_UNSAFE";
    await mkdir(under(state, "claims"), { mode: 0o700 }).catch((e: { code?: string }) => {
      if (e.code !== "EEXIST") throw e;
    });
    const claims = await open(under(state, "claims"), DIR_FLAGS);
    handles.push(claims);
    if (!ours(await claims.stat())) return "CLAIMS_DIR_UNSAFE";
    const h = await open(under(claims, `${approvalId}.used`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await h.writeFile(`${JSON.stringify({ approval_id: approvalId, claimed_at: new Date(at).toISOString() })}\n`);
    } finally {
      await h.close();
    }
    return "claimed";
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "EEXIST" ? "APPROVAL_ALREADY_CLAIMED" : unsafe(code) ? "CLAIMS_DIR_UNSAFE" : "CLAIM_FAILED";
  } finally {
    for (const h of handles.reverse()) await h.close().catch(() => undefined);
  }
}
const claimed = (stateDir: string, approvalId: string) => lstat(join(stateDir, "claims", `${approvalId}.used`)).then(() => true, (e: { code?: string }) => e.code !== "ENOENT");

/** Read only (the precheck): missing is fine (it would be created 0700); an existing one must be a private directory of ours. */
async function privateOrMissing(path: string): Promise<boolean> {
  const info = await lstat(path).catch((e: { code?: string }) => (e.code === "ENOENT" ? "missing" : null));
  if (info === "missing") return true;
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

/** A directory of ours: real (not a link), owned by this user, closed to group and others. Created 0700 if missing. */
async function privateDir(path: string): Promise<boolean> {
  await mkdir(path, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const info = await lstat(path).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

async function hashFiles(runDir: string, sub: string): Promise<ReceiptImage[]> {
  const names = (await readdir(join(runDir, sub)).catch(() => [] as string[])).filter((n) => /^[a-z0-9-]{1,40}\.png$/.test(n)).sort();
  const out: ReceiptImage[] = [];
  for (const n of names) {
    const bytes = await readFile(join(runDir, sub, n));
    out.push({ file: `${sub}/${n}`, sha256: sha256(bytes), bytes: bytes.length });
  }
  return out;
}

/** The entry's last stdout line (one JSON object of codes; never the prompt). */
function lastJson(stdout: string): { status?: unknown; code?: unknown; stage?: unknown } | null {
  const line = stdout.trim().split("\n").pop();
  try {
    const v = line ? (JSON.parse(line) as unknown) : null;
    return v && typeof v === "object" ? (v as { status?: unknown; code?: unknown; stage?: unknown }) : null;
  } catch {
    return null;
  }
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export async function runImagefirstCycle(o: CycleOptions, d: CycleDeps): Promise<CycleReport> {
  const now = d.now ?? Date.now;
  // one audit line per report (the run's end may be recorded early by recordInterrupted)
  const audited = new WeakSet<CycleReport>();
  const audit = async (r: CycleReport) => {
    if (audited.has(r)) return r;
    audited.add(r);
    await appendFile(join(o.stateDir, "audit.jsonl"), `${JSON.stringify({ at: new Date(now()).toISOString(), ...r })}\n`, { mode: 0o600 }).catch(() => undefined);
    return r;
  };
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(o.stateDir, new Date(now()), "imagefirst.lock");
  } catch (error) {
    return audit({ status: "refused", code: error instanceof WorkerStepError ? error.code : "WORKER_LOCK_FAILED", invoked: false });
  }
  if (lock === undefined) return audit({ status: "locked", code: "WORKER_LOCKED", invoked: false });
  try {
    return await audit(await locked(o, d, now, audit));
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/**
 * Issue #302 P1: the automatic start's precheck. Every check of the cycle up to, NOT including, the claim — HEAD =
 * origin/develop and clean, readApprovalPacket at that commit, scope, the grant, plan ID, expiry window, pins, the plan
 * rebuilt, never claimed, the entry's ledger precheck, the places — with no lock, no audit line and no write at all.
 * "would_run" only when the real cycle would claim and invoke now. It invokes nothing and uses nothing.
 */
export async function precheckImagefirstCycle(o: Pick<CycleOptions, "repoRoot" | "stateDir" | "runsDir" | "expectApprovalId">, d: Omit<CycleDeps, "invoke">): Promise<CycleReport> {
  const deps: CycleDeps = { ...d, invoke: async () => Promise.reject(new Error("the precheck never invokes")) };
  return locked(o, deps, d.now ?? Date.now, async (r) => r, true);
}

async function locked(o: CycleOptions, d: CycleDeps, now: () => number, audit: (r: CycleReport) => Promise<CycleReport>, precheckOnly = false): Promise<CycleReport> {
  const refuse = (code: string, approvalId?: string): CycleReport => ({ status: "refused", code, invoked: false, ...(approvalId ? { approval_id: approvalId } : {}) });
  const a = IMAGEFIRST_ALLOWLIST;

  // ---- the approved commit: HEAD = origin/develop, nothing changed (ported: assertOnOriginMain) ----
  const c = await d.commit().catch(() => null);
  if (!c?.head || !c.base || !/^[0-9a-f]{40}$/.test(c.head)) return refuse("COMMIT_UNREADABLE");
  if (c.head !== c.base) return refuse("NOT_ON_ORIGIN_DEVELOP");
  if (!c.clean) return refuse("TREE_DIRTY");
  const commit = c.head;

  // ---- the packet as committed at that commit (never the working tree) ----
  const packetBytes = await d.fileAt(commit, APPROVAL_PACKET_PATH).catch(() => null);
  if (!packetBytes) return refuse("PACKET_UNREADABLE");
  const packet = readApprovalPacket(packetBytes);
  if (!packet) return { status: "no_job", code: "PACKET_NOT_APPROVED", invoked: false };
  const approvalId = packet.approvalIds.d3;
  // the fixed scope: d3 alone (d1, d1,d3 refuse), and the shop's own approval id
  if (packet.directions.join(",") !== a.direction) return refuse("SCOPE_NOT_ALLOWED");
  if (!APPROVAL_ID.test(approvalId)) return refuse("SHOP_NOT_ALLOWED");
  const idCheck = checkRealApprovalId(approvalId);
  if (idCheck !== "ok") return refuse(idCheck, approvalId);
  if (o.expectApprovalId !== undefined && approvalId !== o.expectApprovalId) return refuse("APPROVAL_NOT_GRANTED", approvalId);
  if (!PLAN_ID.test(packet.planId)) return refuse("PLAN_ID_INVALID", approvalId);
  const expires = parseUtcInstant(packet.expires);
  if (expires === null) return refuse("APPROVAL_EXPIRY_INVALID", approvalId);
  if (now() > expires) return refuse("APPROVAL_EXPIRED", approvalId);
  // the precheck leaves room for the run that follows it (else the marker could be used just before the expiry)
  if (precheckOnly && expires - now() < PRECHECK_MIN_LEFT_MS) return refuse("APPROVAL_EXPIRES_SOON", approvalId);
  if (expires - now() > MAX_APPROVAL_WINDOW_MS) return refuse("APPROVAL_EXPIRY_TOO_FAR", approvalId);

  // ---- the pins: the packet's §3 and the plan rebuilt from the inputs at the same commit equal the fixed SHAs ----
  const pins = packetPins(packetBytes);
  if (!pins || pins.planSha256 !== a.planSha256 || pins.promptSha256 !== a.promptSha256 || pins.promptChars !== a.promptChars) return refuse("PACKET_PIN_MISMATCH", approvalId);
  let plan;
  try {
    const inputs = await loadPromptInputs(async (p) => {
      const b = await d.fileAt(commit, p);
      if (!b) throw new PromptStop("INPUT_UNREADABLE");
      return b;
    }, "d3");
    plan = buildPromptPlan(inputs);
  } catch (error) {
    return refuse(error instanceof PromptStop ? `PLAN_${error.code}`.slice(0, 64) : "PLAN_INPUT_UNREADABLE", approvalId);
  }
  if (plan.plan_sha256 !== a.planSha256 || plan.batch.sha256 !== a.promptSha256 || plan.batch.chars !== a.promptChars || plan.batch.images !== a.images.pc + a.images.sp || plan.shop.shop_id !== a.shopId) return refuse("PLAN_PIN_MISMATCH", approvalId);

  // ---- one use: never claimed here, unused in the entry's ledger (read only) ----
  if (await claimed(o.stateDir, approvalId)) return refuse("APPROVAL_ALREADY_CLAIMED", approvalId);
  try {
    await d.ledger.precheck({ approvalId, planId: packet.planId, route: FULL_PAGE_ROUTE, kind: FULL_PAGE_KIND, retryOf: null });
  } catch (error) {
    return refuse(error instanceof LedgerStop ? error.code : "LEDGER_UNREADABLE", approvalId);
  }
  if (precheckOnly) {
    if (!(await privateOrMissing(o.stateDir)) || !(await privateOrMissing(join(o.stateDir, "claims")))) return refuse("CLAIMS_DIR_UNSAFE", approvalId);
    if (!(await privateOrMissing(o.runsDir))) return refuse("RUNS_DIR_UNSAFE", approvalId);
    return { status: "would_run", code: null, invoked: false, approval_id: approvalId };
  }
  // Keep both the claim marker and its parents private: O_NOFOLLOW guards only the final file.
  if (!(await privateDir(o.stateDir)) || !(await privateDir(join(o.stateDir, "claims")))) return refuse("CLAIMS_DIR_UNSAFE", approvalId);
  if (!(await privateDir(o.runsDir))) return refuse("RUNS_DIR_UNSAFE", approvalId);
  if (o.signal?.aborted) return refuse("WORKER_ABORTED", approvalId);

  // ---- the claim, then ONE invocation (never retried, whatever it returns) ----
  const started = now();
  const runDir = join(o.runsDir, `${approvalId}-${stamp(started)}`);
  const packetSha256 = sha256(packetBytes);
  const planId = packet.planId;

  // ---- the end of the run, exactly once: the receipt and the audit line (also when the worker is interrupted) ----
  let ending: Promise<CycleReport> | null = null;
  const end = (res: BoundedResult | null, interrupted: boolean) => (ending ??= settle(res, interrupted).then(audit));
  // registered before the claim (PR #305 review L1): a hard stop during the claim waits for it, and a made claim always
  // ends with a receipt; no claim, nothing to record
  const claiming = claimApproval(o.stateDir, approvalId, now());
  o.onInvoking?.(async () => {
    if ((await claiming) === "claimed") await end(null, true);
  });
  const got = await claiming;
  if (got !== "claimed") return refuse(got, approvalId);

  let res: BoundedResult | null;
  try {
    res = await d.invoke(generateArgv({ repoRoot: o.repoRoot, outDir: runDir, planId, approvalId, expires: packet.expires, packetSha256, commit }), o.signal);
  } catch {
    res = null;
  }
  return end(res, o.signal?.aborted === true || res?.aborted === true);

  // ---- read the private run back: every picture hashed on disk and compared with what the entry recorded ----
  async function settle(res: BoundedResult | null, interrupted: boolean): Promise<CycleReport> {
    const finished = now();
    const out = res ? lastJson(res.stdout) : null;
    const images = await hashFiles(runDir, "parts");
    const stopped = await hashFiles(runDir, "stopped");
    const call = await readFile(join(runDir, "call.json"), "utf8").then((t) => JSON.parse(t) as { status?: string; images?: unknown }, () => null);
    // a stopped call.json records only a count of pictures (never parts): nothing to compare
    const recorded = new Map((Array.isArray(call?.images) ? (call.images as { file?: string; sha256?: string }[]) : []).map((i) => [i.file, i.sha256]));
    const verified = images.length > 0 && images.length === recorded.size && images.every((i) => recorded.get(i.file) === i.sha256);
    const pc = images.filter((i) => i.file.startsWith("parts/pc-")).length;
    const sp = images.filter((i) => i.file.startsWith("parts/sp-")).length;
    const cliOk = res?.code === 0 && !res.timedOut && out?.status === "succeeded" && call?.status === "succeeded";
    const complete = cliOk && verified && pc === a.images.pc && sp === a.images.sp;
    let stopCode: string | null = null;
    let stage: WorkerReceipt["stage"] = null;
    if (!complete) {
      if (interrupted) [stopCode, stage] = ["WORKER_INTERRUPTED", "call"];
      else if (cliOk) [stopCode, stage] = ["BUNDLE_VERIFY_FAILED", "verify"];
      else if (!res) [stopCode, stage] = ["CLI_NOT_STARTED", "precheck"];
      else if (res.timedOut) [stopCode, stage] = ["CLI_TIMEOUT", "call"];
      else {
        stopCode = typeof out?.code === "string" && STOP_CODE.test(out.code) ? out.code : res.code === null ? "CLI_KILLED" : "CLI_RESULT_INVALID";
        stage = out?.stage === "precheck" || res.code === 2 ? "precheck" : "call";
      }
    }
    const receipt: WorkerReceipt = {
      schema: "imagefirst_worker_receipt_v1",
      status: complete ? "succeeded" : "stopped",
      stop_code: stopCode,
      stage,
      interrupted,
      cli_exit: res?.code ?? null,
      cli_timed_out: res?.timedOut ?? false,
      shop: a.shop,
      direction: a.direction,
      approval_id: approvalId,
      plan_id: planId,
      commit,
      packet_sha256: packetSha256,
      plan_sha256: a.planSha256,
      prompt_sha256: a.promptSha256,
      prompt_chars: a.promptChars,
      run_dir: runDir,
      images,
      stopped_images: stopped,
      counts: { pc, sp, total: images.length, stopped: stopped.length },
      verified,
      timings: { started_at: new Date(started).toISOString(), finished_at: new Date(finished).toISOString(), elapsed_ms: finished - started },
    };
    const receiptPath = join(o.runsDir, `${approvalId}-${stamp(started)}.receipt.json`);
    const written = await open(receiptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .then(async (h) => {
        try {
          await h.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
        } finally {
          await h.close();
        }
        return true;
      })
      .catch(() => false);
    // runBounded aborted before the start: nothing ran (PR #305 review L2); the approval stays claimed all the same
    const notStarted = res?.aborted === true && res.code === null && res.signal === null && res.stdout === "" && res.stderr === "";
    const base = { invoked: !notStarted, approval_id: approvalId, run_dir: runDir, ...(written ? { receipt: receiptPath } : {}) };
    if (!written) return { status: "stopped", code: "RECEIPT_UNWRITABLE", ...base };
    return complete ? { status: "succeeded", code: null, ...base } : { status: "stopped", code: stopCode, ...base };
  }
}
