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
 *   DEV-150 (Issue #180): --route P --page-request <asset-request.json> --page-root <dir> --facts <pack.json>
 *   and the same real-call flags: a picture asked for by a page Claude wrote (three-method study, LAYOUT_FIRST /
 *   DIRECTION_FIRST; kind page_image, route claude_page). The request comes from the offline
 *   scripts/design-artifact/three-methods-steps.ts --page-request; its page lives under --page-root (the study's
 *   directory in the repository) and must be tracked there. Before the approval is used, the page goes through the
 *   existing DOM prototype safety check (Chromium, JavaScript off, network shut) and the request is rebuilt from it.
 *   --print-pin --page-request <json> --page-root <dir> --facts <pack.json> runs the same checks offline and prints
 *   the pin. P cannot be combined with --request or --concept-v4. P requires --expect-cli-version <v>
 *   [--previous-steps <dir>,<dir>] (DEV-150, owner approval A′); C and A take them optionally (the three-method pilot's
 *   C1-c procedure gives them), and are unchanged without them. For P, the processes started before the approval
 *   is used are only Chromium (the DOM check: JavaScript off, every outside request refused) and one bounded
 *   `git ls-files` (the tracked check, in phase2f-live-cli.ts); the image tool still runs only in the sandbox.
 *
 * Exit: 0 a picture was saved, 2 refused before anything was used, 1 the call was made and saved no picture.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { cleanupActiveImageCalls, generateImageOnce } from "../../lib/design-agent/design-image/image-once";
import { buildMockupPrompt, loadPocInputs } from "../../lib/design-agent/design-image/prompt";
import { checkPrototype, PrototypeUnsafe } from "../../lib/design-agent/phase2f/prototype-safety";
import { checkPageImageRequest, runImageCall, type ImageCallInput, type ImageRequest, type PageDomCheck } from "../../lib/design-agent/phase2f-live/image-call";
import { openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { sha256 } from "../../lib/design-agent/phase2f-live/steps";
import { FactsPack } from "../../lib/design-agent/three-methods/brief";
import { generationPinOf, liveContext, modelWarning, parseArgs, REPO, runMain, say, stopSignals, trackedInRepo } from "./phase2f-live-cli";

process.umask(0o077);
// first, so a signal that arrives during the checks is never lost
const { controller, stop } = stopSignals({ cleanup: cleanupActiveImageCalls });

const FLAGS = new Set(["--human-approval-confirmed", "--print-pin", "--concept-v4"]);
const VALUES = new Set(["--route", "--request", "--out", "--plan-id", "--approval-id", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-commit", "--retry-of", "--page-request", "--page-root", "--facts", "--expect-cli-version", "--previous-steps"]);
const PAGE_FLAGS = ["--page-request", "--page-root", "--facts"] as const;

/** DEV-150: the existing DOM prototype safety check on Claude's page, in a Chromium started only for route P. */
const pageDom: PageDomCheck = async (page, assetPaths) => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    return { ok: true, alts: (await checkPrototype(browser, page, assetPaths)).alts };
  } catch (e) {
    if (e instanceof PrototypeUnsafe) return { ok: false, code: "PROTOTYPE_UNSAFE" };
    throw e;
  } finally {
    await browser.close();
  }
};

/** DEV-150: route P's request, page root and facts, as read from the flags (before anything else is checked). */
async function pageInput(args: Map<string, string>): Promise<Pick<Extract<ImageCallInput, { route: "claude_page" }>, "request" | "page" | "facts"> | null> {
  const request = await readFile(resolve(args.get("--page-request")!), "utf8").then((t) => JSON.parse(t) as Extract<ImageCallInput, { route: "claude_page" }>["request"], () => null);
  const facts = await readFile(resolve(args.get("--facts")!), "utf8").then((t) => FactsPack.safeParse(JSON.parse(t)), () => null);
  if (!request || !facts?.success) return null;
  return { request, page: { root: resolve(args.get("--page-root")!) }, facts: facts.data };
}

/** Route A's concept prompt: the image PoC's own v4 prompt, built by its own code (never copied here). */
const conceptPrompt = async () => buildMockupPrompt(await loadPocInputs(REPO, "v4"));

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS, VALUES);
  if (!args) return (say({ status: "refused", code: "USAGE" }), 2);
  const page = PAGE_FLAGS.some((f) => args.has(f));
  if (args.has("--print-pin") && page) {
    // DEV-150: a page's picture: the same checks as a real call, offline (Chromium, git ls-files), then its pin
    if (args.size !== 4 || PAGE_FLAGS.some((f) => !args.has(f))) return (say({ status: "refused", code: "USAGE" }), 2);
    const p = await pageInput(args);
    if (!p) return (say({ status: "refused", code: "IMAGE_REQUEST_INVALID" }), 2);
    const checked = await checkPageImageRequest(p, { pageDom, tracked: trackedInRepo });
    if (!checked.ok) return (say({ status: "refused", code: checked.code }), 2);
    say({ mode: "print_pin", route: "claude_page", method: p.request.method, page: p.request.page, asset_id: p.request.asset_id, essential: p.request.essential, prompt_sha256: p.request.prompt_sha256, prompt_chars: p.request.prompt_chars });
    return 0;
  }
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
  const routeOk =
    (route === "C" && requestPath !== undefined && !args.has("--concept-v4") && !page) ||
    (route === "A" && requestPath === undefined && args.has("--concept-v4") && !page) ||
    // DEV-150: a page's picture takes its own three flags, never --request or --concept-v4
    (route === "P" && requestPath === undefined && !args.has("--concept-v4") && PAGE_FLAGS.every((f) => args.has(f)));
  // DEV-150 (owner approval A′): the generation pin is required for route P, optional (unchanged without it) for C and A
  const pin = generationPinOf(args, route === "P");
  if (!routeOk || !out || !Number.isInteger(chars) || pin === "USAGE") return (say({ status: "refused", code: "USAGE" }), 2);
  let request: ImageRequest | null = null;
  if (route === "C") {
    request = await readFile(resolve(requestPath!), "utf8").then((t) => JSON.parse(t) as ImageRequest, () => null);
    if (!request) return (say({ status: "refused", code: "IMAGE_REQUEST_INVALID" }), 2);
  }
  const pageIn = route === "P" ? await pageInput(args) : null;
  if (route === "P" && !pageIn) return (say({ status: "refused", code: "IMAGE_REQUEST_INVALID" }), 2);
  const ctx = await liveContext(out, stop, pin);
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
  const input: ImageCallInput = pageIn ? { route: "claude_page", ...pageIn, common } : request ? { route: "C_hybrid", request, common } : { route: "A_image", prompt: await conceptPrompt(), common };
  const result = await runImageCall(input, {
    ledger: openLedger(ctx.ledgerDir),
    commit: ctx.commit,
    preflight: ctx.preflight,
    ...(pageIn ? { pageDom, tracked: trackedInRepo } : {}),
    image: async (o) => {
      const sandbox = ctx.sandbox();
      if (sandbox === null) throw new Error("no sandbox");
      const r = await generateImageOnce({ sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: tmpdir(), ...(o.signal === undefined ? {} : { signal: o.signal }) });
      return { png: r.png, width: r.width, height: r.height, outcome: r.outcome, stopCode: r.stopCode, cliVersion: r.cliVersion, model: r.model, threadId: r.threadId };
    },
  });
  if (result.status === "succeeded") {
    say({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.generation.run_id, slot: result.receipt.slot, width: result.width, height: result.height, warnings: [...result.warnings, ...modelWarning(ctx.previousModel(), result.generation.model_reported)] });
    return 0;
  }
  say({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call", ...(result.outcome ? { image_outcome: result.outcome } : {}) });
  return result.stage === "precheck" ? 2 : 1;
}

runMain(main);
