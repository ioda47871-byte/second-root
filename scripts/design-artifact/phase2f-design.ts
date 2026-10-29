/**
 * Phase 2f-2 (DEV-116): the design step, the ONLY entry that calls Codex for routes B and C.
 *
 * Two modes:
 *
 *   --print-pin --route B|C --facts <pack.json> --brief <brief.json>
 *       Offline. Prints the design prompt's SHA-256 and length (what the owner approves). Calls nothing.
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
import { readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FactsPack } from "../../lib/design-agent/artifact/schema";
import { killAllBoundedChildren, runBounded } from "../../lib/design-agent/bounded-process";
import { runCodexJsonWithMeta } from "../../lib/design-agent/codex";
import { buildDesignPrompt, codexDesignJsonSchema, DesignBrief } from "../../lib/design-agent/phase2f/prompt";
import { runDesignCall } from "../../lib/design-agent/phase2f-live/design-call";
import { LIVE_LIMITS, openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { workerProtectedPaths } from "../../lib/design-agent/protected-paths";
import { prepareCodexSandbox, type CodexSandbox } from "../../lib/design-agent/sandbox";
import { childEnvironment } from "../../lib/design-agent/worker/env";

const REPO = resolve(__dirname, "../..");
process.umask(0o077);
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** A path with links resolved as far as it exists (the part that does not exist yet is kept as written). */
async function real(p: string): Promise<string> {
  const abs = resolve(p);
  const r = await realpath(abs).catch(() => null);
  if (r !== null) return r;
  const up = dirname(abs);
  return up === abs ? abs : join(await real(up), abs.slice(up.length + (up.endsWith("/") ? 0 : 1)));
}
const insideRepo = async (p: string) => within(await real(p), await real(REPO));

/**
 * The output dir's parent is hidden from Codex (it holds every run's results). Hiding it must not hide what the
 * sandbox needs (Codex's home, the temp dir its work dir is made in, the home dir) or the repository: such a
 * parent is refused before the approval is used.
 */
async function outParentProblem(out: string): Promise<string | null> {
  const parent = await realpath(dirname(resolve(out))).catch(() => null);
  if (parent === null) return "OUT_DIR_PARENT_MISSING";
  const codexHome = process.env.CODEX_HOME ? expand(process.env.CODEX_HOME) : join(homedir(), ".codex");
  for (const needed of [await real(REPO), await real(tmpdir()), await real(homedir()), await real(codexHome)]) {
    if (within(needed, parent)) return "OUT_DIR_PARENT_UNSAFE";
  }
  return null;
}
/** The design prompt asks for at most this many generated images on route C (each needs its own approval later). */
const MAX_ASSETS = 1;

const FLAGS = new Set(["--human-approval-confirmed", "--print-pin"]);
const VALUES = new Set(["--route", "--facts", "--brief", "--out", "--plan-id", "--approval-id", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-commit", "--retry-of"]);

function parseArgs(argv: string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (FLAGS.has(a) && !out.has(a)) out.set(a, "1");
    else if (VALUES.has(a) && !out.has(a) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) out.set(a, argv[++i]!);
    else return null;
  }
  return out;
}

const routeOf = (r: string | undefined): "B_html_prototype" | "C_hybrid" | null => (r === "B" ? "B_html_prototype" : r === "C" ? "C_hybrid" : null);

async function promptFor(args: Map<string, string>) {
  const route = routeOf(args.get("--route"));
  const factsPath = args.get("--facts");
  const briefPath = args.get("--brief");
  if (!route || !factsPath || !briefPath) return null;
  const facts = FactsPack.safeParse(JSON.parse(await readFile(resolve(factsPath), "utf8")));
  const brief = DesignBrief.safeParse(JSON.parse(await readFile(resolve(briefPath), "utf8")));
  if (!facts.success || !brief.success) return null;
  return { route, built: buildDesignPrompt({ route, facts: facts.data, brief: brief.data, maxAssets: MAX_ASSETS }) };
}

const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

// created first, so a signal that arrives during the checks is never lost (the call then does not start)
const controller = new AbortController();
let stopping = false;
function stop(): void {
  if (stopping) {
    // a second signal: end every process now
    killAllBoundedChildren();
    process.exit(1);
  }
  stopping = true;
  controller.abort();
  // the call records itself as aborted; if it does not end soon, end it hard
  setTimeout(() => {
    killAllBoundedChildren();
    process.exit(1);
  }, 20_000).unref();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const p = args ? await promptFor(args).catch(() => null) : null;
  if (!args || !p) {
    say({ status: "refused", code: "USAGE" });
    return 2;
  }
  if (args.has("--print-pin")) {
    if (args.size !== 4) return (say({ status: "refused", code: "USAGE" }), 2);
    say({ mode: "print_pin", route: p.route, prompt_sha256: p.built.sha256, prompt_chars: p.built.chars });
    return 0;
  }
  const out = args.get("--out");
  const chars = Number(args.get("--expected-prompt-chars"));
  if (!out || !isAbsolute(out) || !Number.isInteger(chars)) return (say({ status: "refused", code: "USAGE" }), 2);
  if (await insideRepo(out)) return (say({ status: "refused", code: "OUT_DIR_INSIDE_REPO" }), 2);
  const parentProblem = await outParentProblem(out);
  if (parentProblem) return (say({ status: "refused", code: parentProblem }), 2);

  const stateDir = join(expand(process.env.XDG_STATE_HOME ?? "~/.local/state"), "sr-design-worker");
  const ledgerDir = expand(process.env.SR_PHASE2F_STATE ?? join(stateDir, "phase2f-live"));
  if (await insideRepo(ledgerDir)) return (say({ status: "refused", code: "LEDGER_INSIDE_REPO" }), 2);
  const workerPaths = { stateDir, queueRoot: expand(process.env.SR_DESIGN_JOBS ?? "~/sr-design-jobs"), outRoot: expand("~/.local/share/second-root-design") };
  const env = childEnvironment(process.env);

  // the call's own 15 minutes are enforced by the process runner around Codex; this only ends a run that does not
  // stop by itself (it also covers the sign-in check, the version and the sandbox probes before the call)
  setTimeout(() => stop(), LIVE_LIMITS.callTimeoutMs + 5 * 60_000).unref();
  // Codex never sees the worker's directories, the ledger or where the results go
  const protectedPaths = [...new Set([...workerProtectedPaths({ ...workerPaths, env: process.env }), ledgerDir, dirname(resolve(out))])];
  let sandbox: CodexSandbox | null = null;
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
      outDir: resolve(out),
      signal: controller.signal,
    },
    {
      ledger: openLedger(ledgerDir),
      commit: async () => {
        const git = (a: string[]) => runBounded("git", a, { cwd: REPO, env, timeoutMs: 60_000 }).then((r) => (r.code === 0 ? r.stdout : null), () => null);
        const [head, base, status] = await Promise.all([git(["rev-parse", "HEAD"]), git(["rev-parse", "origin/develop"]), git(["status", "--porcelain", "--untracked-files=all"])]);
        return { head: head?.trim() ?? null, base: base?.trim() ?? null, clean: status === "" };
      },
      // the sandbox is prepared (no Codex started) before the approval is used: a refusal there uses nothing
      preflight: async () => {
        sandbox = await prepareCodexSandbox({ env, protectedPaths }).catch(() => null);
        return sandbox === null ? "CODEX_SANDBOX_UNAVAILABLE" : null;
      },
      codex: async (o) => {
        if (sandbox === null) throw new Error("no sandbox");
        return runCodexJsonWithMeta({ sandbox, ...o });
      },
    },
  );
  if (result.status === "succeeded") {
    say({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.generation.run_id, slot: result.receipt.slot, warnings: result.warnings });
    return 0;
  }
  say({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call" });
  return result.stage === "precheck" ? 2 : 1;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);

main().then(
  (code) => process.exit(code),
  () => {
    say({ status: "stopped", code: "UNEXPECTED" });
    killAllBoundedChildren();
    process.exit(1);
  },
);
