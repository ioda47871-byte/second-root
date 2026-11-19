/**
 * Issue #293 P3 (prepared, NOT approved): the owner-run entry of ONE real IMAGE_FIRST generation. Nothing calls it: it
 * is started by hand by the owner, on the owner's WSL, only after the owner approved the per-run packet. One approval =
 * one Codex run = one batch of PC + SP section pictures of ONE direction (lib/design-agent/phase2f-live/full-page-call.ts).
 *
 *   npx tsx scripts/design-artifact/image-first-generate.ts --direction d1|d3 --out <~/sr-runs/<run>>
 *     --plan-id <id> --approval-id <id> --approval-expires <YYYY-MM-DD> --packet <approval packet in the repo>
 *     --expected-prompt-sha256 <sha> --expected-prompt-chars <n> --expected-plan-sha256 <sha>
 *     --expected-packet-sha256 <sha> --expected-commit <sha> --human-approval-confirmed
 *
 * Before the approval is used: the plan is rebuilt from the pinned inputs (image-first/prompt.ts) and must be the
 * approved one; the packet must be a tracked file of the repository with the approved bytes; the run directory must be
 * outside the repository, new, under a real parent (phase2f-live-cli.ts liveContext); the commit pin, the sandbox
 * preflight and the ledger (one use per approval, 15 min a call, 2 h a plan). Then one generateImagesInOneRun in the
 * sandbox the preflight prepared; never retried. SIGTERM / SIGINT / SIGHUP stop the call (recorded as aborted).
 *
 * Afterwards, offline: the check CLI's --assemble on the run directory (docs/design/image-first-handoff.md §7).
 *
 * Exit: 0 every planned picture was saved, 2 refused before anything was used, 1 the approval was used and the run stopped.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cleanupActiveImageCalls, generateImagesInOneRun } from "../../lib/design-agent/design-image/image-once";
import { buildPromptPlan, loadPromptInputs, PromptStop, type DirectionKey } from "../../lib/design-agent/image-first/prompt";
import { runFullPageCall } from "../../lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { liveContext, parseArgs, REPO, runMain, say, stopSignals, trackedInRepo } from "./phase2f-live-cli";

process.umask(0o077);
// first, so a signal that arrives during the checks is never lost
const { controller, stop } = stopSignals({ cleanup: cleanupActiveImageCalls });

const FLAGS = new Set(["--human-approval-confirmed"]);
const VALUES = new Set(["--direction", "--out", "--plan-id", "--approval-id", "--approval-expires", "--packet", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-plan-sha256", "--expected-packet-sha256", "--expected-commit"]);
const REQUIRED = [...VALUES];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS, VALUES);
  const chars = Number(args?.get("--expected-prompt-chars"));
  const key = args?.get("--direction");
  if (!args || REQUIRED.some((f) => !args.has(f)) || !Number.isInteger(chars) || (key !== "d1" && key !== "d3")) return (say({ status: "refused", code: "USAGE" }), 2);
  let plan;
  let inputs;
  try {
    inputs = await loadPromptInputs((p) => readFile(resolve(REPO, p)), key as DirectionKey);
    plan = buildPromptPlan(inputs);
  } catch (error) {
    return (say({ status: "refused", code: error instanceof PromptStop ? error.code : "INPUT_UNREADABLE" }), 2);
  }
  // the packet the owner approved: a tracked file of this repository (its bytes are pinned by runFullPageCall)
  const packet = resolve(args.get("--packet")!);
  const packetBytes = (await trackedInRepo([packet])) ? await readFile(packet).catch(() => null) : null;
  const ctx = await liveContext(args.get("--out")!, stop);
  if ("code" in ctx) return (say({ status: "refused", code: ctx.code }), 2);
  const result = await runFullPageCall(
    {
      plan,
      inputs,
      packetBytes,
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
      preflight: ctx.preflight,
      batch: async (o) => {
        const sandbox = ctx.sandbox();
        if (sandbox === null) throw new Error("no sandbox");
        const r = await generateImagesInOneRun({ sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: tmpdir(), maxImages: o.maxImages, ...(o.signal === undefined ? {} : { signal: o.signal }) });
        return { images: r.images, outcome: r.outcome, stopCode: r.stopCode, imageCalls: r.imageCalls, imageFailed: r.imageFailed, imageCallIds: r.imageCallIds ?? [], threadId: r.threadId, cliVersion: r.cliVersion, model: r.model };
      },
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
