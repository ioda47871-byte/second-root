/**
 * Issue #298 P1: one cycle of the IMAGE_FIRST worker adapter (lib/design-agent/imagefirst-worker/cycle.ts), run as the
 * worker user (sr-designgen) in the worker's clone on origin/develop. DEV-302: the approved one-shot paths are root's
 * one-shot pilot and its automatic start (scripts imagefirst-pilot and imagefirst-autostart), which start it outside
 * the requester jail with setpriv; the earlier manual run (docs/operations/imagefirst-worker-port.md §5) is refused from a jailed shell or `admin.sh run` (below), and
 * sr-designgen has no login shell outside the jail. Issue #302 P1: root's wrapper imagefirst-autostart.sh (pull
 * model, OFF by default; its unit and timer are NOT installed or enabled by anything in this repository), which passes
 * the approval id of root's one-use run marker in GRANT_ENV: its direction (d3 or d4, the id names it) selects the
 * allowlist row and that row's own packet (lib/design-agent/imagefirst-worker/run-directions.ts), whose approval id must
 * then be exactly that one (APPROVAL_NOT_GRANTED). Without a grant: d3 only. A malformed grant is refused (GRANT_INVALID)
 * before anything. Nothing else changes.
 *
 *   node --import tsx scripts/sales-design-worker/imagefirst-worker.ts
 *
 * (node with the tsx loader, not the tsx CLI: the CLI relays Ctrl-C / SIGTERM a second time, which would be a hard stop.)
 *
 * Takes no arguments: the job is the approval packet as committed at HEAD (= origin/develop), within the fixed
 * allowlist (ほし窯 d3). When it is approved and unused, the existing owner entry (GENERATE_ENTRY) is started
 * ONCE in its own process group, with the allowlisted environment (no API key or token), bounded by the entry's own
 * watchdog plus a margin. SIGTERM / SIGINT / SIGHUP are passed on (the entry records the call as aborted), and an
 * interrupted run always ends with a receipt (stop code WORKER_INTERRUPTED) and an audit line (WORKER_STOP in cycle.ts):
 * the entry gets its own 20 s + 10 s to stop, the worker kills it only after 35 s, and only if the worker itself is still
 * waiting at 50 s (or gets a second signal) does it kill everything and record the receipt from what is on disk.
 * The claim stays used either way; nothing is retried.
 *
 * Places (outside the repository, 0700): state ~/.local/state/sr-design-worker/imagefirst-worker (lock, claims,
 * audit.jsonl), runs ~/sr-runs/<approval>-<UTC> (+ .receipt.json), the entry's ledger (phase2f, unchanged).
 *
 * DEV-302: the run and `--precheck` are refused (RUN_INSIDE_JAIL_UNIT, OWN_CGROUP_UNREADABLE) inside a requester jail unit
 * (sr-jail-*.service: Remote Control, a jailed shell, `admin.sh run`), which a restart of Remote Control, of the jail's
 * network or of WSL kills with everything in it; root's pilot / automatic start run the worker outside the jail. It
 * prevents accidents (a run that would spend the approval and then be killed); it is not a security boundary: a jailed
 * process could get around it (NODE_OPTIONS, importing cycle.ts, the entry itself). The claim and the entry's ledger stay
 * the once-only gate. It reads the cgroup v2 line: on a cgroup-v1-only host there is none and the run goes through; where
 * /proc/self/cgroup does not exist (macOS, native Windows) the run is refused (OWN_CGROUP_UNREADABLE).
 *
 * One JSON line on stdout. Exit: 0 no job / locked / succeeded, 2 refused (nothing invoked), 1 invoked and stopped.
 * `--precheck`: every check of the cycle up to, not including, the claim, with no lock, audit line or write; exit 0 = it
 * would run now ("would_run"), 3 = no job, 2 = refused.
 * `--check-codex-auth-only` (Issue #302 pilot preflight): the Codex sign-in alone, with nothing used: the generation path's
 * .env rule and sandbox, then one sandboxed sign-in status read (phase2f-live-cli.ts codexSignInCheck); no claim, no
 * ledger, no model call. Exit 0 {"status":"codex_auth_ok"}, 2 refused with a fixed code only.
 *
 * Issue #302 P3 follow-up (docs/operations/imagefirst-review-handoff.md §4): after a cycle that ended "succeeded", the
 * same process hands that run to the local review inbox (~/sr-runs/review-inbox) with deliverAfterRun
 * (lib/design-agent/imagefirst-worker/deliver-review.ts: receipt checked against the packet at its commit → sealed private
 * bundle → inbox → previews + INDEX). The run's one JSON line is printed FIRST (PR #310 review M1: a stop during the
 * hand-off can never hide a run that succeeded); the hand-off is skipped when a stop was already requested and is
 * aborted by one; its own summary goes to stderr and the audit file only, so stdout stays exactly one line (the
 * automatic start reads its last line). It never changes the exit code and it can start nothing. A failed hand-off
 * leaves the sealed bundle (or, if it stopped before sealing, nothing sealed); the owner re-sends the SAME bundle (or,
 * when no bundle, delivery job or inbox copy exists, the first and only pack of the same run) through root's wrapper
 * scripts/sales-design-worker/imagefirst-deliver-review.sh, which runs this CLI with `--deliver-review <approval id>` as
 * the worker user outside the jail. That mode runs no cycle, claims nothing and starts nothing except read-only git and
 * systemctl; it requires HEAD = origin/develop and a clean tree, and (defense in depth; the wrapper is the gate) the
 * jailed Claude stopped and disabled or masked. Exit: 0 delivered / duplicate, 1 not delivered (the bundle stays sealed
 * for another re-send), 2 refused.
 *
 * DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 A/B), REQUEST mode, started by root's
 * pilot (outside the jail, as today) for one request root accepted from ~/sr-runs/requests/<id>.json:
 *
 *   SR_IMAGEFIRST_REQUEST_FILE=<fresh clone>.request/<id>.json \
 *   node --import tsx scripts/sales-design-worker/imagefirst-worker.ts --request <id> --request-sha256 <hex> [--precheck]
 *
 * (the options in any order, each once; nothing else; GRANT_ENV must not be set; the environment variable names root's
 * private copy of the request: an absolute real path, no link on it, a regular file named <id>.json, at most 16 KiB,
 * outside the clone, its SHA-256 = --request-sha256.) One cycle of
 * lib/design-agent/imagefirst-worker/request-cycle.ts: the request's SHA-256 and id, the facts pack it names (outside git),
 * the shop's kind, the plan, the one-use claim keyed by the request id, ONE invocation of the entry's request mode, the
 * receipt; then (succeeded) the same review hand-off with the request id as the bundle id
 * (~/sr-runs/review-inbox/<id>), the audit line as today and, for kind real_shop, the private run record
 * ~/second-root-shops/<shop_id>/runs/<id>.json (metadata only; a real shop never enters the repository). The same one
 * stdout line and exit codes as the run above; `--precheck`: 0 would run, 2 refused (nothing written). A request id
 * never runs twice (claim + ledger); `--deliver-review <request id>` re-sends its sealed bundle as for an approval id.
 *
 * `--validate-request <file>` (DEV-303, offline, side-effect-free; any shell, the jail included): the whole worker-side
 * check of a request before Claude drops it into ~/sr-runs/requests/ (request.ts validateRequestFile). One JSON line:
 * {"status":"valid","code":null,"request_id","kind","request_sha256","facts_sha256","plan_sha256"} exit 0, or
 * {"status":"refused","code":<fixed code>} exit 2 (CASE_STUDY_TEXT_HAS_FACT adds "detail": {category, field, case_id},
 * never the text). No claim, no ledger, no write, no network, no Codex.
 *
 * DEV-303 (owner decision 2026-11-24), two stages: a request with stage "photo_materials" makes 1..6 picture materials
 * in ONE Codex run (its line adds "stage" and, succeeded, "photo_files": [{name, sha256}]); they are sealed and handed to
 * the review inbox like a design (~/sr-runs/review-inbox/<id>, marked image_material / イメージ素材, at most 6 pictures).
 * A design request may name them (photo_inputs, resolved from the photo run's private output); they are attached to its one
 * Codex run and never copied into it. --validate-request adds "stage" and "photo_inputs": "checked" | "unchecked" | null.
 *
 * Issue #336 (docs/design/image-first-production-flow.md §1 stage 1, §6.1 row 2): a real_shop design request must name
 * its success-case analysis (case_study: {path, sha256}, next to the facts pack). --validate-request and the worker run
 * its gate check (every viewed original's SHA-256, ≥ 3 counted, owner-confirmed; case-study/case-study.ts) and refuse
 * with a CASE_STUDY_* code. The line adds "case_study": {sha256, counted} | null.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { runBounded } from "../../lib/design-agent/bounded-process";
import { appendFile } from "node:fs/promises";
import { deliverAfterRun, deliverReview, ReviewStop } from "../../lib/design-agent/imagefirst-worker/deliver-review";
import { jailIdle, ownJailUnit } from "../../lib/design-agent/imagefirst-worker/jail-state";
import { checkRealApprovalId, exitCodeOf, GENERATE_ENTRY, GRANT_ENV, gitCommitState, grantFromEnv, isRequestRunId, precheckExitOf, precheckImagefirstCycle, runImagefirstCycle, tsEntry, WORKER_STOP } from "../../lib/design-agent/imagefirst-worker/cycle";
import { REAL_SHOP_RECORD_SCHEMA, recordUseOf, refusalDetailOf, REQUEST_FILE_ENV, validateRequestFile, writeRealShopRecord } from "../../lib/design-agent/imagefirst-worker/request";
import { precheckRequestCycle, runRequestCycle, type RequestCycleResult } from "../../lib/design-agent/imagefirst-worker/request-cycle";
import { defaultLedgerDir, openLedger, WATCHDOG_MS } from "../../lib/design-agent/phase2f-live/ledger";
import { childEnvironment } from "../../lib/design-agent/worker/env";
import { codexSignInCheck, expand, fileAtCommit, insideRepo, liveContext, REPO, runMain, say, stopSignals } from "../design-artifact/phase2f-live-cli";

process.umask(0o077);
/** Set once the approval is claimed: ends the run with a WORKER_INTERRUPTED receipt and audit line (never invokes). */
let recordInterrupted: (() => Promise<void>) | null = null;
const { controller } = stopSignals({ hardStopMs: WORKER_STOP.hardStopMs, cleanup: async () => recordInterrupted?.(), repeatGraceMs: WORKER_STOP.repeatGraceMs });
/**
 * The entry's own watchdog plus a 2 min margin. When it is reached (or a stop signal arrives) the entry's group gets
 * SIGTERM, then WORKER_STOP.graceMs (35 s, more than the entry's 20 s hard stop + 10 s clean-up) to record the stop
 * itself before SIGKILL.
 */
const INVOKE_TIMEOUT_MS = WATCHDOG_MS + 2 * 60_000;

/** PR #310 review M2: the receipt's commit is on origin/develop in this (the worker's own) clone. Read only. */
const onOriginDevelop = (env: NodeJS.ProcessEnv) => async (commit: string) =>
  /^[0-9a-f]{40}$/.test(commit) && (await runBounded("git", ["merge-base", "--is-ancestor", commit, "origin/develop"], { cwd: REPO, env, timeoutMs: 60_000 }).then((r) => r.code === 0, () => false));

/**
 * DEV-303: the request mode's options (each once, any order) plus an optional --precheck, and root's private copy named
 * by SR_IMAGEFIRST_REQUEST_FILE (absolute; the strict checks are request.ts readRequestFile's); null = not request mode.
 */
type RequestArgs = { id: string; sha256: string; file: string; precheck: boolean };
function requestArgs(argv: readonly string[], env: NodeJS.ProcessEnv): RequestArgs | "USAGE" | null {
  if (!argv.includes("--request")) return null;
  const want = new Set(["--request", "--request-sha256"]);
  const got = new Map<string, string>();
  let precheck = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--precheck" && !precheck) precheck = true;
    else if (want.has(a) && !got.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) got.set(a, argv[++i]!);
    else return "USAGE";
  }
  if (got.size !== want.size) return "USAGE";
  const id = got.get("--request")!;
  const sha256 = got.get("--request-sha256")!;
  const file = env[REQUEST_FILE_ENV];
  if (!isRequestRunId(id) || !/^[0-9a-f]{64}$/.test(sha256) || typeof file !== "string" || !file.startsWith("/")) return "USAGE";
  return { id, sha256, file, precheck };
}

/**
 * The CLI. `readCgroup` is for the test entry only (tests/unit/design-agent/imagefirst-worker/fixtures/worker-cli-entry.ts):
 * the production entry below passes nothing, so the guard reads this process's own /proc/self/cgroup, and no environment
 * variable or argument reaches it.
 */
export async function main(readCgroup?: () => Promise<string>): Promise<number> {
  // the arguments: none, --precheck (Issue #302 P1, the automatic start asks before it uses root's marker), or
  // --deliver-review <approval id> (Issue #302 P3 follow-up: re-send a finished run's sealed bundle to the review inbox)
  // DEV-303: the offline request validator (reads only; before every place, lock and guard)
  if (process.argv[2] === "--validate-request") {
    if (process.argv.length !== 4) return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
    try {
      const v = await validateRequestFile({ file: process.argv[3]!, home: homedir(), repo: REPO });
      say({ status: "valid", code: null, ...v });
      return 0;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // review Q5 follow-up: a case-study text refusal names its category, field and case (never the text)
      const detail = refusalDetailOf(error);
      say({ status: "refused", code: typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "REQUEST_UNREADABLE", ...(detail ? { detail } : {}) });
      return 2;
    }
  }
  const request = requestArgs(process.argv.slice(2), process.env);
  if (request === "USAGE" || (request !== null && process.env[GRANT_ENV] !== undefined)) return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  const precheck = process.argv.length === 3 && process.argv[2] === "--precheck";
  const deliver = process.argv[2] === "--deliver-review";
  // Issue #302 (the owner's one-shot pilot's read-only preflight, review H1): the Codex sign-in alone, before anything is used
  const codexAuth = process.argv.length === 3 && process.argv[2] === "--check-codex-auth-only";
  if (deliver && process.argv.length !== 4) return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  if (request === null && process.argv.length > 2 && !precheck && !deliver && !codexAuth) return (say({ status: "refused", code: "USAGE", invoked: false }), 2);
  if (codexAuth) {
    // the generation path's own context (places, protected paths, environment) for a run directory under ~/sr-runs that is
    // never created; then its .env rule, its sandbox set-up and ONE sandboxed sign-in status read (the shared helper's
    // codexSignInCheck). No claim, no ledger
    // write, no model call; only a code is printed
    const ctx = await liveContext(join(homedir(), "sr-runs", ".codex-sign-in-check"), () => undefined);
    const code = "code" in ctx ? ctx.code : await codexSignInCheck(ctx, controller.signal);
    say(code === null ? { status: "codex_auth_ok", code: null, invoked: false } : { status: "refused", code, invoked: false });
    return code === null ? 0 : 2;
  }
  const deliverId = deliver ? process.argv[3]! : null;
  // DEV-303: a request run's id re-sends the same way (its bundle id is the request id)
  if (deliverId !== null && !isRequestRunId(deliverId) && checkRealApprovalId(deliverId) !== "ok") return (say({ status: "refused", code: checkRealApprovalId(deliverId), invoked: false }), 2);
  const grant = grantFromEnv(process.env);
  if (grant === null) return (say({ status: "refused", code: "GRANT_INVALID", invoked: false }), 2);
  const env = childEnvironment(process.env);
  const stateDir = join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker", "imagefirst-worker");
  const runsDir = join(homedir(), "sr-runs");
  // the same ledger the entry opens (it sees only the allowlisted environment)
  const ledgerDir = defaultLedgerDir(env, homedir());
  for (const p of [stateDir, runsDir, ledgerDir]) if (await insideRepo(p)) return (say({ status: "refused", code: "PLACE_INSIDE_REPO", invoked: false }), 2);
  if (deliver) {
    // the manual re-send: no cycle, no claim, no ledger, nothing started; the same sealed bundle (or its first pack when
    // nothing was ever sealed or sent), from the worker's
    // own clean clone on origin/develop (PR #310 review M3)
    const c = await gitCommitState(REPO, env).catch(() => null);
    if (!c?.head || c.head !== c.base) return (say({ status: "refused", code: "NOT_ON_ORIGIN_DEVELOP", invoked: false }), 2);
    if (!c.clean) return (say({ status: "refused", code: "TREE_DIRTY", invoked: false }), 2);
    try {
      const r = await deliverReview({ approvalId: deliverId!, runsDir, stateDir, resend: true, signal: controller.signal, jailIdle: () => jailIdle(env) }, { fileAt: (commit, rel) => fileAtCommit(commit, rel), onOriginDevelop: onOriginDevelop(env) });
      say({ ...r, invoked: false });
      return r.status === "not_delivered" ? 1 : 0;
    } catch (error) {
      say({ status: "refused", code: error instanceof ReviewStop ? error.code : "REVIEW_UNEXPECTED", invoked: false });
      return 2;
    }
  }
  // DEV-302: never a one-shot run (or its precheck) inside a requester jail unit, where a restart of Remote Control, of the
  // jail's network or of WSL would kill it after the claim (KillMode=control-group). Root's pilot / automatic start run
  // the worker outside the jail. Unreadable: refused as well. Before the lock, the claim and anything written.
  const jailUnit = await ownJailUnit(readCgroup);
  if (jailUnit !== null) return (say({ status: "refused", code: jailUnit === "unknown" ? "OWN_CGROUP_UNREADABLE" : "RUN_INSIDE_JAIL_UNIT", invoked: false }), 2);
  // DEV-303: a request run (after the same jail guard, places and environment)
  if (request !== null) return requestMode(request, { env, stateDir, runsDir, ledgerDir });
  if (precheck) {
    // every check up to the claim; no lock, no audit, no write, nothing invoked
    const r = await precheckImagefirstCycle({ repoRoot: REPO, stateDir, runsDir, ...(grant ? { expectApprovalId: grant } : {}) }, { commit: () => gitCommitState(REPO, env), fileAt: (commit, rel) => fileAtCommit(commit, rel), ledger: openLedger(ledgerDir) });
    say(r);
    return precheckExitOf(r.status);
  }
  const report = await runImagefirstCycle(
    { repoRoot: REPO, stateDir, runsDir, signal: controller.signal, onInvoking: (record) => (recordInterrupted = record), ...(grant ? { expectApprovalId: grant } : {}) },
    {
      commit: () => gitCommitState(REPO, env),
      fileAt: (commit, rel) => fileAtCommit(commit, rel),
      ledger: openLedger(ledgerDir),
      invoke: (argv, signal) => runBounded(tsEntry(join(REPO, GENERATE_ENTRY), argv).bin, tsEntry(join(REPO, GENERATE_ENTRY), argv).args, { cwd: REPO, env, timeoutMs: INVOKE_TIMEOUT_MS, graceMs: WORKER_STOP.graceMs, ...(signal ? { signal } : {}) }),
    },
  );
  // the run's result first (the one stdout line), then the hand-off (PR #310 review M1)
  say(report);
  const review = await deliverAfterRun(report, { runsDir, stateDir, signal: controller.signal }, { fileAt: (commit, rel) => fileAtCommit(commit, rel), onOriginDevelop: onOriginDevelop(env) });
  if (review) {
    process.stderr.write(`imagefirst-worker: review ${JSON.stringify(review)}\n`);
    await appendFile(join(stateDir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), approval_id: report.approval_id, review })}\n`, { mode: 0o600 }).catch(() => undefined);
  }
  return exitCodeOf(report.status);
}

/** DEV-303: one request run (see the header). */
async function requestMode(r: RequestArgs, places: { env: NodeJS.ProcessEnv; stateDir: string; runsDir: string; ledgerDir: string }): Promise<number> {
  const { env, stateDir, runsDir, ledgerDir } = places;
  if (await insideRepo(join(homedir(), "second-root-shops"))) return (say({ status: "refused", code: "PLACE_INSIDE_REPO", invoked: false }), 2);
  const o = { repoRoot: REPO, stateDir, runsDir, home: homedir(), requestId: r.id, requestSha256: r.sha256, requestFile: r.file };
  if (r.precheck) {
    const p = await precheckRequestCycle(o, { commit: () => gitCommitState(REPO, env), ledger: openLedger(ledgerDir) });
    say(p.report);
    return precheckExitOf(p.report.status);
  }
  const result = await runRequestCycle(
    { ...o, signal: controller.signal, onInvoking: (record) => (recordInterrupted = record) },
    {
      commit: () => gitCommitState(REPO, env),
      ledger: openLedger(ledgerDir),
      invoke: (argv, signal) => runBounded(tsEntry(join(REPO, GENERATE_ENTRY), argv).bin, tsEntry(join(REPO, GENERATE_ENTRY), argv).args, { cwd: REPO, env, timeoutMs: INVOKE_TIMEOUT_MS, graceMs: WORKER_STOP.graceMs, ...(signal ? { signal } : {}) }),
    },
  );
  const report = result.report;
  say(report);
  const review = await deliverAfterRun(report, { runsDir, stateDir, signal: controller.signal }, { fileAt: (commit, rel) => fileAtCommit(commit, rel), onOriginDevelop: onOriginDevelop(env) });
  if (review) {
    process.stderr.write(`imagefirst-worker: review ${JSON.stringify(review)}\n`);
    await appendFile(join(stateDir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), approval_id: report.approval_id, mode: "request", review })}\n`, { mode: 0o600 }).catch(() => undefined);
  }
  await recordRealShop(result, review);
  return exitCodeOf(report.status);
}

/** DEV-303: a used real-shop request leaves its private record under ~/second-root-shops (never the repository). */
async function recordRealShop(result: RequestCycleResult, review: Awaited<ReturnType<typeof deliverAfterRun>>): Promise<void> {
  const { report, run } = result;
  if (run === null || run.request.kind !== "real_shop" || (report.status !== "succeeded" && report.status !== "stopped")) return;
  try {
    await writeRealShopRecord({
      home: homedir(),
      repo: REPO,
      record: {
        schema: REAL_SHOP_RECORD_SCHEMA,
        request_id: run.request.id,
        shop_id: run.request.shop_id,
        kind: "real_shop",
        request_sha256: run.requestSha256,
        facts_sha256: run.factsSha256,
        plan_sha256: run.planSha256,
        case_study_sha256: run.caseStudySha256,
        ...(run.referenceImages ? { design_layout: "whole_page" as const, reference_images: run.referenceImages } : {}),
        ...(run.approvedDesign && run.materialsSha256 ? { approved_design: run.approvedDesign, materials_sha256: run.materialsSha256 } : {}),
        commit: run.commit,
        run: { status: report.status, code: report.code, invoked: report.invoked, receipt_written: report.receipt !== undefined },
        review: review ? { status: review.status, code: review.code, bundle_sha256: review.bundle_sha256 ?? null } : null,
        use: recordUseOf(run.request),
        recorded_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    process.stderr.write(`imagefirst-worker: shop record ${JSON.stringify({ code: (error as { code?: unknown }).code ?? "RECORD_UNWRITABLE" })}\n`);
  }
}

// the production entry: started as a script (never when imported, e.g. by the test entry)
if (require.main === module) runMain(() => main());
