/**
 * Phase 2f-2 (DEV-116): the design step, the ONLY entry that calls Codex for routes B and C.
 *
 * Two modes:
 *
 *   --print-pin --route B|C --facts <pack.json> --brief <brief.json> [--prompt-version v1|v1.1] [--research <section.json>]
 *       Offline. Prints the design prompt's SHA-256 and length (what the owner approves). Calls nothing.
 *
 *   DEV-122: --prompt-version v1.1 (route B only) adds the two technical rules; --research adds the owner-approved
 *   research block. Absent, the prompt is v1, unchanged. A run with research is refused while the section's text is
 *   not owner-approved (RESEARCH_TEXT_NOT_APPROVED); printing the pin is not a run.
 *
 *   --route B|C --facts <pack.json> --brief <brief.json> --out <dir> --plan-id <id> --approval-id <id>
 *   --expected-prompt-sha256 <sha> --expected-prompt-chars <n> --expected-commit <sha> --human-approval-confirmed
 *   [--retry-of <approval id>]
 *       One real Codex call under one owner approval (lib/design-agent/phase2f-live/design-call.ts): the prompt and
 *       the commit must be the approved ones, the approval is used once (ledger in the worker's state directory,
 *       outside the repository), at most 15 minutes, the plan's limits are kept. SIGTERM / SIGINT / SIGHUP stop
 *       Codex (and every process it started) and record the call as aborted; nothing is retried.
 *
 * The output directory (new, outside the repository) holds answer.json / generation.json / call.json for the
 * next steps (pre-render, image approval, packaging: DEV-117), which never call Codex for this design again.
 * Exit: 0 succeeded, 2 refused before anything was used, 1 the call was made (approval used) and did not succeed.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FactsPack } from "../../lib/design-agent/artifact/schema";
import { runCodexJsonWithMeta } from "../../lib/design-agent/codex";
import { buildDesignPrompt, codexDesignJsonSchema, DesignBrief, promptVariantOf } from "../../lib/design-agent/phase2f/prompt";
import { runDesignCall } from "../../lib/design-agent/phase2f-live/design-call";
import { openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { liveContext, parseArgs, runMain, say, stopSignals } from "./phase2f-live-cli";

process.umask(0o077);
// first, so a signal that arrives during the checks is never lost
const { controller, stop } = stopSignals();

/** The design prompt asks for at most this many generated images on route C (each needs its own approval later). */
const MAX_ASSETS = 1;

const FLAGS = new Set(["--human-approval-confirmed", "--print-pin"]);
const VALUES = new Set(["--route", "--facts", "--brief", "--out", "--plan-id", "--approval-id", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-commit", "--retry-of", "--prompt-version", "--research"]);

const routeOf = (r: string | undefined): "B_html_prototype" | "C_hybrid" | null => (r === "B" ? "B_html_prototype" : r === "C" ? "C_hybrid" : null);

async function promptFor(args: Map<string, string>) {
  const route = routeOf(args.get("--route"));
  const factsPath = args.get("--facts");
  const briefPath = args.get("--brief");
  if (!route || !factsPath || !briefPath) return null;
  const facts = FactsPack.safeParse(JSON.parse(await readFile(resolve(factsPath), "utf8")));
  const brief = DesignBrief.safeParse(JSON.parse(await readFile(resolve(briefPath), "utf8")));
  if (!facts.success || !brief.success) return null;
  const researchPath = args.get("--research");
  const research: unknown = researchPath === undefined ? undefined : JSON.parse(await readFile(resolve(researchPath), "utf8"));
  const v = promptVariantOf({ route, version: args.get("--prompt-version"), research });
  if (!v.ok) return { route, refused: v.code } as const;
  return { route, variant: v.variant, built: buildDesignPrompt({ route, facts: facts.data, brief: brief.data, maxAssets: MAX_ASSETS, variant: v.variant }) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS, VALUES);
  const p = args ? await promptFor(args).catch(() => null) : null;
  if (!args || !p) {
    say({ status: "refused", code: "USAGE" });
    return 2;
  }
  if ("refused" in p) return (say({ status: "refused", code: p.refused }), 2);
  const research = p.variant.version === "v1.1" ? p.variant.research : null;
  if (args.has("--print-pin")) {
    const optional = ["--prompt-version", "--research"].filter((f) => args.has(f)).length;
    if (args.size !== 4 + optional) return (say({ status: "refused", code: "USAGE" }), 2);
    say({
      mode: "print_pin",
      route: p.route,
      prompt_version: p.variant.version,
      research_section: research ? { section_id: research.section_id, case_ids: research.source.case_ids, owner_text_approval: research.owner_text_approval.status } : null,
      prompt_sha256: p.built.sha256,
      prompt_chars: p.built.chars,
    });
    return 0;
  }
  // research text goes into a real call only once the owner has approved it word for word
  if (research && research.owner_text_approval.status !== "approved") return (say({ status: "refused", code: "RESEARCH_TEXT_NOT_APPROVED" }), 2);
  const out = args.get("--out");
  const chars = Number(args.get("--expected-prompt-chars"));
  if (!out || !Number.isInteger(chars)) return (say({ status: "refused", code: "USAGE" }), 2);
  const ctx = await liveContext(out, stop);
  if ("code" in ctx) return (say({ status: "refused", code: ctx.code }), 2);
  const result = await runDesignCall(
    {
      route: p.route,
      prompt: p.built.prompt,
      schema: codexDesignJsonSchema(),
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
