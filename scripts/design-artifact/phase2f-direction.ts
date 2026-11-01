/**
 * DEV-150 (Issue #180): the direction step of the three-method study, the ONLY entry that calls Codex for
 * DIRECTION_FIRST (a visual direction in words: three_method_direction_v0; no page, no image).
 *
 *   --print-pin --facts <pack.json> --tm-brief <brief.json>
 *       Offline. Prints the direction prompt's SHA-256 and length, the answer schema's SHA-256 and the inputs' SHA-256
 *       (what the owner approves). Calls nothing.
 *
 *   --facts <pack.json> --tm-brief <brief.json> --out <dir> --plan-id <id> --approval-id <id>
 *   --expected-prompt-sha256 <sha> --expected-prompt-chars <n> --expected-commit <sha> --human-approval-confirmed
 *   [--retry-of <approval id>]
 *       One real Codex call under one owner approval (lib/design-agent/phase2f-live/direction-call.ts), with exactly the
 *       design step's guards: the prompt and the commit must be the approved ones, the approval is used once (the same
 *       ledger, outside the repository), at most 15 minutes, the plan's limits are kept, Codex runs only inside the
 *       sandbox the preflight prepared. SIGTERM / SIGINT / SIGHUP stop Codex and record the call as aborted; nothing is
 *       retried.
 *
 * The prompt is the three-method lane's (lib/design-agent/three-methods/direction.ts), built from the facts pack and
 * the common brief, which must be the same shop and name only its facts. Exit: 0 succeeded, 2 refused before anything
 * was used, 1 the call was made (approval used) and did not succeed.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCodexJsonWithMeta } from "../../lib/design-agent/codex";
import { checkBrief, sha256 } from "../../lib/design-agent/three-methods/brief";
import { buildDirectionPrompt, directionJsonSchema } from "../../lib/design-agent/three-methods/direction";
import { runDirectionCall } from "../../lib/design-agent/phase2f-live/direction-call";
import { openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { liveContext, parseArgs, runMain, say, stopSignals } from "./phase2f-live-cli";

process.umask(0o077);
// first, so a signal that arrives during the checks is never lost
const { controller, stop } = stopSignals();

const FLAGS = new Set(["--human-approval-confirmed", "--print-pin"]);
const VALUES = new Set(["--facts", "--tm-brief", "--out", "--plan-id", "--approval-id", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-commit", "--retry-of"]);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS, VALUES);
  const factsPath = args?.get("--facts");
  const briefPath = args?.get("--tm-brief");
  if (!args || !factsPath || !briefPath) return (say({ status: "refused", code: "USAGE" }), 2);
  let factsText: string, briefText: string, facts: unknown, brief: unknown;
  try {
    factsText = await readFile(resolve(factsPath), "utf8");
    briefText = await readFile(resolve(briefPath), "utf8");
    facts = JSON.parse(factsText);
    brief = JSON.parse(briefText);
  } catch {
    return (say({ status: "refused", code: "INPUT_UNREADABLE" }), 2);
  }
  const c = checkBrief(brief, facts);
  if (!c.ok) return (say({ status: "refused", code: c.code }), 2);
  const built = buildDirectionPrompt({ facts: c.facts, brief: c.brief });
  const schema = directionJsonSchema();
  if (args.has("--print-pin")) {
    if (args.size !== 3) return (say({ status: "refused", code: "USAGE" }), 2);
    say({ mode: "print_pin", kind: "direction", route: "direction_text", answer_schema: "three_method_direction_v0", answer_schema_sha256: sha256(JSON.stringify(schema)), facts_pack_sha256: sha256(factsText), tm_brief_sha256: sha256(briefText), prompt_sha256: built.sha256, prompt_chars: built.chars });
    return 0;
  }
  const out = args.get("--out");
  const chars = Number(args.get("--expected-prompt-chars"));
  if (!out || !Number.isInteger(chars)) return (say({ status: "refused", code: "USAGE" }), 2);
  const ctx = await liveContext(out, stop);
  if ("code" in ctx) return (say({ status: "refused", code: ctx.code }), 2);
  const result = await runDirectionCall(
    {
      prompt: built.prompt,
      schema,
      facts: c.facts,
      humanApprovalConfirmed: args.has("--human-approval-confirmed"),
      approvalId: args.get("--approval-id") ?? "",
      planId: args.get("--plan-id") ?? "",
      retryOf: args.get("--retry-of") ?? null,
      expected: { promptSha256: args.get("--expected-prompt-sha256") ?? "", promptChars: chars, commit: args.get("--expected-commit") ?? "" },
      outDir: ctx.outDir,
      signal: controller.signal,
    },
    {
      ledger: openLedger(ctx.ledgerDir),
      commit: ctx.commit,
      preflight: ctx.preflight,
      codex: async (o) => {
        const sandbox = ctx.sandbox();
        if (sandbox === null) throw new Error("no sandbox");
        return runCodexJsonWithMeta({ sandbox, ...o });
      },
    },
  );
  if (result.status === "succeeded") {
    say({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.generation.run_id, slot: result.receipt.slot, warnings: result.warnings });
    return 0;
  }
  say({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call", ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
  return result.stage === "precheck" ? 2 : 1;
}

runMain(main);
