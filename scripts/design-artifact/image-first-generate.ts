/**
 * Issue #293 P3 (prepared, NOT approved): the owner-run entry of ONE real IMAGE_FIRST generation. Nothing calls it: it
 * is started by hand by the owner, on the owner's WSL, only after the owner approved the per-run packet. One approval =
 * one Codex run = one batch of PC + SP section pictures of ONE direction (lib/design-agent/phase2f-live/full-page-call.ts).
 *
 *   npx tsx scripts/design-artifact/image-first-generate.ts --direction d1|d3|d4 --out <~/sr-runs/<run>>
 *     --plan-id <id> --approval-id <id> --approval-expires <YYYY-MM-DDTHH:MM:SSZ> --packet <approval packet in the repo>
 *     --expected-prompt-sha256 <sha> --expected-prompt-chars <n> --expected-plan-sha256 <sha>
 *     --expected-packet-sha256 <sha> --expected-commit <sha> --human-approval-confirmed
 *
 * Before the approval is used: the plan is rebuilt from the pinned inputs (image-first/prompt.ts) and must be the
 * approved one; the packet must be exactly the direction's own packet — d1 / d3: docs/design/image-first-hoshigama-p3-packet.md,
 * d4: docs/design/image-first-hoshigama-d4-packet.md (lib/design-agent/phase2f-live/approval-packets.ts; nothing else, never a test
 * fixture); after the commit pin, its bytes as committed at that commit (git show, never the working tree) must be the
 * approved bytes, and its own header and §10 are read: it
 * must be filled in and 承認済み, and its direction, approval id, expiry (UTC, at most 24 h ahead) and plan id must be the
 * ones given here (the commit is not in the packet: --expected-commit vs HEAD pins it); the run directory must be
 * outside the repository, new, under a real parent (phase2f-live-cli.ts liveContext); the commit pin, the sandbox
 * preflight and the ledger (one use per approval, 15 min a call, 2 h a plan). Then one generateImagesInOneRun in the
 * sandbox the preflight prepared; never retried. SIGTERM / SIGINT / SIGHUP stop the call (recorded as aborted).
 *
 * Afterwards, offline: the check CLI's --assemble on the run directory (docs/design/image-first-handoff.md §7).
 *
 * Exit: 0 every planned picture was saved, 2 refused before anything was used, 1 the approval was used and the run stopped.
 *
 * DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 A/B), request mode — started only by
 * the worker's request cycle (lib/design-agent/imagefirst-worker/request-cycle.ts), never by hand:
 *
 *   ... image-first-generate.ts --request-file <private dir>/<id>.json --request-id <id> --request-sha256 <sha>
 *     --out <~/sr-runs/<run>> --expected-commit <sha> --expected-plan-sha256 <sha> --expected-prompt-sha256 <sha>
 *     --expected-prompt-chars <n>
 *
 * The request (its SHA-256 and id), the facts pack it names (outside git, its SHA-256) and the shop's kind are read and
 * checked again here (imagefirst-worker/request.ts), the plan is rebuilt and must be the one the worker pinned, then
 * runRequestFullPageCall: the same checks before use (commit pin, sandbox preflight, ledger: the request id used once,
 * ever) and the same one Codex batch. Codex never sees ~/second-root-shops or the request's directory (protected paths).
 *
 * DEV-303 (owner decision 2026-11-24): by the request's stage (imagefirst-worker/request-run.ts): photo_materials makes
 * 1..6 picture materials (parts/photo-N.png); design may name a photo_materials run's pictures (photo_inputs), resolved
 * only inside that run under ~/sr-runs and attached to the one Codex run with --image (never copied into this run).
 */
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cleanupActiveImageCalls, generateImagesInOneRun } from "../../lib/design-agent/design-image/image-once";
import { buildPromptPlan, loadPromptInputs, PromptStop, type DirectionKey } from "../../lib/design-agent/image-first/prompt";
import { loadRequestRun, SHOPS_DIR } from "../../lib/design-agent/imagefirst-worker/request";
import { runLoadedRequest } from "../../lib/design-agent/imagefirst-worker/request-run";
import { packetOfDirection, runFullPageCall, type FullPageBatch } from "../../lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { fileAtCommit, liveContext, parseArgs, REPO, runMain, say, stopSignals } from "./phase2f-live-cli";

process.umask(0o077);
// first, so a signal that arrives during the checks is never lost
const { controller, stop } = stopSignals({ cleanup: cleanupActiveImageCalls });

const FLAGS = new Set(["--human-approval-confirmed"]);
const VALUES = new Set(["--direction", "--out", "--plan-id", "--approval-id", "--approval-expires", "--packet", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-plan-sha256", "--expected-packet-sha256", "--expected-commit"]);
const REQUIRED = [...VALUES];
/** DEV-303: request mode's arguments (all required; no flag). */
const REQUEST_VALUES = new Set(["--request-file", "--request-id", "--request-sha256", "--out", "--expected-commit", "--expected-plan-sha256", "--expected-prompt-sha256", "--expected-prompt-chars"]);

type Ctx = Exclude<Awaited<ReturnType<typeof liveContext>>, { code: string }>;
/** The one batch call, only in the sandbox the preflight prepared. */
function batchIn(ctx: Ctx): FullPageBatch {
  return async (o) => {
    const sandbox = ctx.sandbox();
    if (sandbox === null) throw new Error("no sandbox");
    const r = await generateImagesInOneRun({ sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: tmpdir(), maxImages: o.maxImages, ...(o.inputImages ? { inputImages: o.inputImages } : {}), ...(o.signal === undefined ? {} : { signal: o.signal }) });
    return { images: r.images, outcome: r.outcome, stopCode: r.stopCode, imageCalls: r.imageCalls, imageFailed: r.imageFailed, imageCallIds: r.imageCallIds ?? [], threadId: r.threadId, cliVersion: r.cliVersion, model: r.model };
  };
}

/** DEV-303: one request run (see the header). */
async function requestMain(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), new Set(), REQUEST_VALUES);
  const chars = Number(args?.get("--expected-prompt-chars"));
  if (!args || [...REQUEST_VALUES].some((f) => !args.has(f)) || !Number.isInteger(chars)) return (say({ status: "refused", code: "USAGE" }), 2);
  const requestFile = resolve(args.get("--request-file")!);
  let run;
  try {
    run = await loadRequestRun({ requestFile, requestSha256: args.get("--request-sha256")!, requestId: args.get("--request-id")!, home: homedir(), repo: REPO });
  } catch (error) {
    return (say({ status: "refused", code: error instanceof PromptStop ? error.code : "REQUEST_UNREADABLE" }), 2);
  }
  const ctx = await liveContext(args.get("--out")!, stop, null, [join(homedir(), SHOPS_DIR), dirname(requestFile)]);
  if ("code" in ctx) return (say({ status: "refused", code: ctx.code }), 2);
  const result = await runLoadedRequest(
    {
      run,
      expected: { promptSha256: args.get("--expected-prompt-sha256")!, promptChars: chars, commit: args.get("--expected-commit")!, planSha256: args.get("--expected-plan-sha256")! },
      outDir: ctx.outDir,
      repoRoot: REPO,
      signal: controller.signal,
    },
    { ledger: openLedger(ctx.ledgerDir), commit: ctx.commit, preflight: ctx.preflight, batch: batchIn(ctx) },
  );
  if (result.status === "succeeded") {
    say({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.runId, images: result.images, warnings: result.warnings });
    return 0;
  }
  say({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call", ...(result.outcome ? { image_outcome: result.outcome } : {}) });
  return result.stage === "precheck" ? 2 : 1;
}

async function main(): Promise<number> {
  if (process.argv[2] === "--request-file") return requestMain();
  const args = parseArgs(process.argv.slice(2), FLAGS, VALUES);
  const chars = Number(args?.get("--expected-prompt-chars"));
  const key = args?.get("--direction");
  // only a direction with an approval packet of its own (d1 / d3: the P3 packet; d4: the d4 packet)
  if (!args || REQUIRED.some((f) => !args.has(f)) || !Number.isInteger(chars) || key === undefined || packetOfDirection(key) === null) return (say({ status: "refused", code: "USAGE" }), 2);
  let plan;
  let inputs;
  try {
    inputs = await loadPromptInputs((p) => readFile(resolve(REPO, p)), key as DirectionKey);
    plan = buildPromptPlan(inputs);
  } catch (error) {
    return (say({ status: "refused", code: error instanceof PromptStop ? error.code : "INPUT_UNREADABLE" }), 2);
  }
  // the packet the owner approved: its path must be the one packet path; its bytes are read by runFullPageCall as
  // committed at the approved commit, after the commit pin held (never from the working tree)
  const packet = resolve(args.get("--packet")!);
  const ctx = await liveContext(args.get("--out")!, stop);
  if ("code" in ctx) return (say({ status: "refused", code: ctx.code }), 2);
  const result = await runFullPageCall(
    {
      plan,
      inputs,
      packetPath: packet,
      humanApprovalConfirmed: args.has("--human-approval-confirmed"),
      approvalId: args.get("--approval-id")!,
      planId: args.get("--plan-id")!,
      approvalExpires: args.get("--approval-expires")!,
      expected: { promptSha256: args.get("--expected-prompt-sha256")!, promptChars: chars, commit: args.get("--expected-commit")!, planSha256: args.get("--expected-plan-sha256")!, packetSha256: args.get("--expected-packet-sha256")! },
      outDir: ctx.outDir,
      repoRoot: REPO,
      signal: controller.signal,
    },
    {
      ledger: openLedger(ctx.ledgerDir),
      commit: ctx.commit,
      packetAt: (commit, rel) => fileAtCommit(commit, rel),
      preflight: ctx.preflight,
      batch: batchIn(ctx),
    },
  );
  if (result.status === "succeeded") {
    say({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.runId, images: result.images, warnings: result.warnings, next: "assemble the record offline (docs/design/image-first-handoff.md)" });
    return 0;
  }
  say({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call", ...(result.outcome ? { image_outcome: result.outcome } : {}) });
  return result.stage === "precheck" ? 2 : 1;
}

runMain(main);
