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
 *   DEV-150 (Issue #180): --prompt-version tm0 --tm-brief <three-method brief.json> (no --brief) builds the
 *   three-method study's VISUAL_FIRST prompt (the three-method lane's own builder, imported by prompt.ts).
 *   The brief must be the facts pack's shop and name only its facts. --print-pin also prints the brief's SHA-256.
 *   A real tm0 run goes through exactly the same checks as any other (approval, pins, commit, sandbox), and it also
 *   requires --expect-cli-version <v> [--previous-steps <dir>,<dir>] (DEV-150, owner approval A′; optional for the
 *   other versions, unchanged without them): the Codex CLI version and the earlier calls are checked before the
 *   approval is used (phase2f-live-cli.ts).
 *
 *   DEV-124: --prompt-version v2 --direction <direction.json> --references <manifest.json> (no --brief) builds the
 *   open-direction prompt. A real v2 run also takes --reference-dir <dir> holding the registered WebP files the
 *   direction names (by their file name); each must have the manifest's SHA-256 (also in the prompt). They are cut
 *   into PNG sheets and attached as Codex image input. All of this happens before the approval is used.
 *
 * The output directory (new, outside the repository) holds answer.json / generation.json / call.json for the
 * next steps (pre-render, image approval, packaging: DEV-117), which never call Codex for this design again.
 * Exit: 0 succeeded, 2 refused before anything was used, 1 the call was made (approval used) and did not succeed.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright";
import { FactsPack } from "../../lib/design-agent/artifact/schema";
import { runCodexJsonWithMeta } from "../../lib/design-agent/codex";
import { buildDesignPrompt, codexDesignJsonSchema, DesignBrief, promptVariantOf, type PromptVariant } from "../../lib/design-agent/phase2f/prompt";
import { referenceSheet, ReferenceStop } from "../../lib/design-agent/phase2f/reference-sheet";
import { runDesignCall } from "../../lib/design-agent/phase2f-live/design-call";
import { openLedger } from "../../lib/design-agent/phase2f-live/ledger";
import { generationPinOf, liveContext, modelWarning, parseArgs, runMain, say, stopSignals } from "./phase2f-live-cli";

process.umask(0o077);
// first, so a signal that arrives during the checks is never lost
const { controller, stop } = stopSignals();

/** The design prompt asks for at most this many generated images on route C (each needs its own approval later). */
const MAX_ASSETS = 1;

const FLAGS = new Set(["--human-approval-confirmed", "--print-pin"]);
const VALUES = new Set(["--route", "--facts", "--brief", "--out", "--plan-id", "--approval-id", "--expected-prompt-sha256", "--expected-prompt-chars", "--expected-commit", "--retry-of", "--prompt-version", "--research", "--direction", "--references", "--reference-dir", "--tm-brief", "--expect-cli-version", "--previous-steps"]);

const routeOf = (r: string | undefined): "B_html_prototype" | "C_hybrid" | null => (r === "B" ? "B_html_prototype" : r === "C" ? "C_hybrid" : null);

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const readJson = async (path: string | undefined): Promise<unknown> => (path === undefined ? undefined : JSON.parse(await readFile(resolve(path), "utf8")));

async function promptFor(args: Map<string, string>) {
  const route = routeOf(args.get("--route"));
  const factsPath = args.get("--facts");
  const briefPath = args.get("--brief");
  // DEV-124: v2 has no brief; DEV-150: neither has tm0 (it takes --tm-brief); the others need one
  const noBrief = args.get("--prompt-version") === "v2" || args.get("--prompt-version") === "tm0";
  if (!route || !factsPath || (noBrief ? briefPath !== undefined : !briefPath)) return null;
  const facts = FactsPack.safeParse(await readJson(factsPath));
  const brief = briefPath === undefined ? null : DesignBrief.safeParse(await readJson(briefPath));
  if (!facts.success || (brief && !brief.success)) return null;
  // DEV-150 review L4: an unreadable or non-JSON three-method brief is refused by name (nothing is used)
  let tmBriefText: string | undefined;
  let tmBrief: unknown;
  if (args.has("--tm-brief")) {
    try {
      tmBriefText = await readFile(resolve(args.get("--tm-brief")!), "utf8");
      tmBrief = JSON.parse(tmBriefText);
    } catch {
      return { route, refused: "INPUT_UNREADABLE" } as const;
    }
  }
  const v = promptVariantOf({ route, version: args.get("--prompt-version"), research: await readJson(args.get("--research")), direction: await readJson(args.get("--direction")), references: await readJson(args.get("--references")), ...(tmBriefText === undefined ? {} : { tmBrief }) });
  if (!v.ok) return { route, refused: v.code } as const;
  let built;
  try {
    built = buildDesignPrompt({ route, facts: facts.data, ...(brief?.success ? { brief: brief.data } : {}), maxAssets: MAX_ASSETS, variant: v.variant });
  } catch (e) {
    // DEV-150: a tm0 brief of another shop, or naming a fact the pack does not have, is refused by the prompt builder
    if (v.variant.version === "tm0" && e instanceof Error && e.message === "PROMPT_VARIANT_BRIEF") return { route, refused: "TM_BRIEF_FACTS_MISMATCH" } as const;
    throw e;
  }
  return { route, variant: v.variant, tmBriefSha256: tmBriefText === undefined ? null : sha256(tmBriefText), built };
}

/**
 * DEV-124: the reference sheets of a v2 run, made before the approval is used: each named WebP from --reference-dir,
 * checked against the manifest's SHA-256, cut into one PNG sheet in a new private temporary directory.
 */
async function referenceImages(variant: PromptVariant, dir: string | undefined): Promise<{ paths: string[]; record: object[]; tmp: string | null } | { code: string }> {
  if (variant.version !== "v2" || variant.references.length === 0) return dir === undefined ? { paths: [], record: [], tmp: null } : { code: "USAGE" };
  if (dir === undefined) return { code: "REFERENCE_DIR_REQUIRED" };
  const out = await mkdtemp(join(tmpdir(), "sr-p2f-refs-"));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const paths: string[] = [];
    const record: object[] = [];
    for (const ref of variant.references) {
      const bytes = await readFile(join(resolve(dir), basename(ref.source.path))).catch(() => null);
      if (!bytes) return (await rm(out, { recursive: true, force: true }), { code: "REFERENCE_FILE_MISSING" });
      const sheet = await referenceSheet(browser, bytes, ref);
      const path = join(out, `${ref.id}.png`);
      await writeFile(path, sheet.png, { mode: 0o600, flag: "wx" });
      paths.push(path);
      record.push({ id: ref.id, webp_sha256: ref.webp_sha256, png_sha256: sheet.png_sha256, columns: sheet.columns, sheet: sheet.sheet });
    }
    return { paths, record, tmp: out };
  } catch (e) {
    await rm(out, { recursive: true, force: true });
    if (e instanceof ReferenceStop) return { code: e.code };
    throw e;
  } finally {
    await browser.close();
  }
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
    // --route --facts and (--brief, or for v2 --direction --references, or for tm0 --tm-brief), plus the optional version and research
    const optional = ["--prompt-version", "--research", "--brief", "--direction", "--references", "--tm-brief"].filter((f) => args.has(f)).length;
    if (args.size !== 3 + optional) return (say({ status: "refused", code: "USAGE" }), 2);
    say({
      mode: "print_pin",
      route: p.route,
      prompt_version: p.variant.version,
      research_section: research ? { section_id: research.section_id, case_ids: research.source.case_ids, owner_text_approval: research.owner_text_approval.status } : null,
      ...(p.variant.version === "v2" ? { direction: { direction_id: p.variant.direction.direction_id, composition: p.variant.direction.composition }, references: p.variant.references.map((r) => ({ id: r.id, webp_sha256: r.webp_sha256 })) } : {}),
      ...(p.variant.version === "tm0" ? { tm_brief_sha256: p.tmBriefSha256 } : {}),
      prompt_sha256: p.built.sha256,
      prompt_chars: p.built.chars,
    });
    return 0;
  }
  // research text goes into a real call only once the owner has approved it word for word
  if (research && research.owner_text_approval.status !== "approved") return (say({ status: "refused", code: "RESEARCH_TEXT_NOT_APPROVED" }), 2);
  const out = args.get("--out");
  const chars = Number(args.get("--expected-prompt-chars"));
  // DEV-150 (owner approval A′): the generation pin is required for the three-method prompt (tm0), optional otherwise
  const pin = generationPinOf(args, p.variant.version === "tm0");
  if (!out || !Number.isInteger(chars) || pin === "USAGE") return (say({ status: "refused", code: "USAGE" }), 2);
  // the reference images are checked (and their sheets made) first: a wrong file never reaches the approval
  const refs = await referenceImages(p.variant, args.get("--reference-dir"));
  if ("code" in refs) return (say({ status: "refused", code: refs.code }), 2);
  // the sheets are copies Codex was given; they are not kept (their SHA-256 is printed with the result)
  const cleanup = () => (refs.tmp ? rm(refs.tmp, { recursive: true, force: true }) : Promise.resolve());
  const ctx = await liveContext(out, stop, pin);
  if ("code" in ctx) return (await cleanup(), say({ status: "refused", code: ctx.code }), 2);
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
      images: refs.paths,
      // DEV-150 (owner approval A′): recorded in call.json, so the pilot's route C image step requires its generation pin
      promptVersion: p.variant.version,
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
  ).finally(cleanup);
  if (result.status === "succeeded") {
    say({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.generation.run_id, slot: result.receipt.slot, warnings: [...result.warnings, ...modelWarning(ctx.previousModel(), result.generation.model_reported)], references: refs.record });
    return 0;
  }
  say({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call", ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}), references: refs.record });
  return result.stage === "precheck" ? 2 : 1;
}

runMain(main);
