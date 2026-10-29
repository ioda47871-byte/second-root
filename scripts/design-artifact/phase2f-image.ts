/**
 * Phase 2f-2 (DEV-117): the image step, the research test's ONLY entry that calls the image tool. One picture per
 * owner approval. Separate from the image PoC's entry (whose v4 approval, prompt pin and used-approval record are
 * untouched); it reuses only the PoC's common image-call parts (design-image/image-once.ts).
 *
 *   --print-pin --concept-v4
 *       Offline. Route A's concept prompt (the PoC's v4 prompt for the fictional wagashi shop): its SHA-256 and length.
 *
 *   --route C --request <image-request.json> | --route A --concept-v4
 *   --out <dir> --plan-id <id> --approval-id <id> --expected-prompt-sha256 <sha> --expected-prompt-chars <n>
 *   --expected-commit <sha> --human-approval-confirmed [--retry-of <approval id>]
 *       One real image call (lib/design-agent/phase2f-live/image-call.ts). Route C's request comes from the
 *       pre-render step (scripts/design-artifact/phase2f-steps.ts --prerender) and is checked against its design run
 *       (output folder and ledger both "succeeded"). Everything else as the design step: checked before the approval
 *       is used, the approval used once, at most 15 minutes, the plan's limits kept, never retried; SIGTERM / SIGINT /
 *       SIGHUP stop the call and record it as aborted.
 *
 * Exit: 0 a picture was saved, 2 refused before anything was used, 1 the call was made and saved no picture.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cleanupActiveImageCalls, generateImageOnce } from "../../lib/design-agent/design-image/image-once";
import { buildMockupPrompt, loadPocInputs } from "../../lib/design-agent/design-image/prompt";
import { runImageCall, type ImageRequest } from "../../lib/design-agent/phase2f-live/image-call";
import { openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { sha256 } from "../../lib/design-agent/phase2f-live/steps";
import { liveContext, parseArgs, REPO, runMain, say, stopSignals } from "./phase2f-live-cli";

process.umask(0o077);
// first, so a signal that arrives during the checks is never lost
const { controller, stop } = stopSignals({ cleanup: cleanupActiveImageCalls });

const FLAGS = new Set(["--human-approval-confirmed", "--print-pin", "--concept-v4"]);
const VALUES = new Set(["--route", "--request", "--out", "--plan-id", "--approval-id", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-commit", "--retry-of"]);

/** Route A's concept prompt: the image PoC's own v4 prompt, built by its own code (never copied here). */
const conceptPrompt = async () => buildMockupPrompt(await loadPocInputs(REPO, "v4"));

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS, VALUES);
  if (!args) return (say({ status: "refused", code: "USAGE" }), 2);
  if (args.has("--print-pin")) {
    if (args.size !== 2 || !args.has("--concept-v4")) return (say({ status: "refused", code: "USAGE" }), 2);
    const prompt = await conceptPrompt();
    say({ mode: "print_pin", route: "A_image", prompt_sha256: sha256(Buffer.from(prompt, "utf8")), prompt_chars: prompt.length });
    return 0;
  }
  const route = args.get("--route");
  const out = args.get("--out");
  const chars = Number(args.get("--expected-prompt-chars"));
  const requestPath = args.get("--request");
  const routeOk = (route === "C" && requestPath !== undefined && !args.has("--concept-v4")) || (route === "A" && requestPath === undefined && args.has("--concept-v4"));
  if (!routeOk || !out || !Number.isInteger(chars)) return (say({ status: "refused", code: "USAGE" }), 2);
  let request: ImageRequest | null = null;
  if (route === "C") {
    request = await readFile(resolve(requestPath!), "utf8").then((t) => JSON.parse(t) as ImageRequest, () => null);
    if (!request) return (say({ status: "refused", code: "IMAGE_REQUEST_INVALID" }), 2);
  }
  const ctx = await liveContext(out, stop);
  if ("code" in ctx) return (say({ status: "refused", code: ctx.code }), 2);
  const common = {
    humanApprovalConfirmed: args.has("--human-approval-confirmed"),
    approvalId: args.get("--approval-id") ?? "",
    planId: args.get("--plan-id") ?? "",
    retryOf: args.get("--retry-of") ?? null,
    expected: { promptSha256: args.get("--expected-prompt-sha256") ?? "", promptChars: chars, commit: args.get("--expected-commit") ?? "" },
    outDir: ctx.outDir,
    signal: controller.signal,
  };
  const result = await runImageCall(request ? { route: "C_hybrid", request, common } : { route: "A_image", prompt: await conceptPrompt(), common }, {
    ledger: openLedger(ctx.ledgerDir),
    commit: ctx.commit,
    preflight: ctx.preflight,
    image: async (o) => {
      const sandbox = ctx.sandbox();
      if (sandbox === null) throw new Error("no sandbox");
      const r = await generateImageOnce({ sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: tmpdir(), ...(o.signal === undefined ? {} : { signal: o.signal }) });
      return { png: r.png, width: r.width, height: r.height, outcome: r.outcome, stopCode: r.stopCode, cliVersion: r.cliVersion, model: r.model, threadId: r.threadId };
    },
  });
  if (result.status === "succeeded") {
    say({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.generation.run_id, slot: result.receipt.slot, width: result.width, height: result.height, warnings: result.warnings });
    return 0;
  }
  say({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call", ...(result.outcome ? { image_outcome: result.outcome } : {}) });
  return result.stage === "precheck" ? 2 : 1;
}

runMain(main);
