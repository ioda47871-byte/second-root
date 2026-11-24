import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 2f-2 (DEV-116, DEV-117): the real-call steps. The modules start no process and open no connection: Codex and
// the image tool are reached only through the functions the two real-call CLIs pass in. The offline steps CLI never
// reaches Codex, the image tool or the sandbox. Only the image CLI touches the image PoC's code, and only its common
// image call and prompt builder. Nothing else imports any of it. DEV-150 (Issue #180, owner-approved exact paths): the
// three-method pilot's direction step (the design step's guards, the lane's direction prompt and check) and its offline
// steps CLI (no Codex, no image tool, no sandbox, no process).

const REPO = resolve(__dirname, "../../../..");
const LIB = "lib/design-agent/phase2f-live";
const DESIGN_CLI = "scripts/design-artifact/phase2f-design.ts";
const IMAGE_CLI = "scripts/design-artifact/phase2f-image.ts";
const STEPS_CLI = "scripts/design-artifact/phase2f-steps.ts";
const CLI_SHARED = "scripts/design-artifact/phase2f-live-cli.ts";
/** DEV-150 (Issue #180, owner-approved exact paths): the three-method pilot's direction step and its offline steps. */
const DIRECTION_CLI = "scripts/design-artifact/phase2f-direction.ts";
const TM_STEPS_CLI = "scripts/design-artifact/three-methods-steps.ts";
/** Issue #293 P3 (preparation; owner-run only after a per-run approval packet): one IMAGE_FIRST batch of section pictures. */
const FULL_PAGE_CLI = "scripts/design-artifact/image-first-generate.ts";
/**
 * Issue #298 P1 (owner-approved scope): the WSL worker adapter that hands ONE owner-approved IMAGE_FIRST job (ほし窯 d3)
 * to FULL_PAGE_CLI. It reads the packet, the ledger and the pins (full-page-call, ledger, steps types) and starts the
 * entry as a process; it never takes the image call, the sandbox or Codex itself (checked below).
 */
const WORKER_LIB = "lib/design-agent/imagefirst-worker/cycle.ts";
/** Issue #302 (d4 run path): the worker's per-direction allowlist (d3 / d4), which reads only the packet table. */
const RUN_DIRECTIONS = "lib/design-agent/imagefirst-worker/run-directions.ts";
const WORKER_CLI = "scripts/sales-design-worker/imagefirst-worker.ts";
/**
 * DEV-303 (owner direction 2026-11-23, docs/operations/first-client-pipeline.md §2 A/B): the worker's request mode — its
 * cycle (ledger precheck, the claim, ONE invocation of the entry's request mode through the injected `invoke`) and the
 * request's files (read only; the real shop's private record). Neither takes the image call, the sandbox or Codex.
 */
const REQUEST_CYCLE = "lib/design-agent/imagefirst-worker/request-cycle.ts";
/** Issue #302 P1: root's automatic start (OFF by default; its unit and timer are never installed or enabled here). */
const WORKER_AUTOSTART = "scripts/sales-design-worker/imagefirst-autostart.sh";
/**
 * Issue #302 P3 follow-up (PR #310 review H1, owner instruction 2026-11-20, exact path): root's review re-send wrapper,
 * run by hand only; it starts the adapter's --deliver-review mode once (no cycle; tests/unit/design-agent/imagefirst-worker/deliver-review-wrapper.test.ts).
 */
const WORKER_DELIVER = "scripts/sales-design-worker/imagefirst-deliver-review.sh";
/**
 * Issue #302 (owner pre-approval 2026-11-21, exact paths): root's one-shot pilot, run by hand once, which starts the
 * adapter ONCE with the automatic start's own line, and its read-only preflight, which starts only the adapter's
 * --precheck (tests/unit/design-agent/imagefirst-worker/pilot.test.ts). Never installed, enabled or scheduled.
 */
const WORKER_PILOT = "scripts/sales-design-worker/imagefirst-pilot.sh";
const WORKER_PILOT_PREFLIGHT = "scripts/sales-design-worker/imagefirst-pilot-preflight.sh";
/**
 * Issue #302 (PR #325, docs/operations/imagefirst-autorun.md): the owner's approval command, which starts only the
 * adapter's read-only --precheck (the automatic start's line), and only while the worker user is idle; it never starts the
 * run (tests/unit/design-agent/imagefirst-worker/approve.test.ts). The automatic run itself names no adapter line.
 */
const WORKER_APPROVE = "scripts/sales-design-worker/imagefirst-approve.sh";
const CLIS = [DESIGN_CLI, IMAGE_CLI, STEPS_CLI, CLI_SHARED, DIRECTION_CLI, TM_STEPS_CLI, FULL_PAGE_CLI, WORKER_LIB, WORKER_CLI, REQUEST_CYCLE];
const git = (args: string[]) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|(?<!@)\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}
const named = (source: string, from: string) =>
  [...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].filter((m) => m[2] === from).flatMap((m) => m[1]!.split(",").map((s) => s.trim()).filter(Boolean)).sort();

const L = "../../lib/design-agent";
const ALLOWED: Record<string, string[]> = {
  [`${LIB}/ledger.ts`]: ["node:fs", "node:fs/promises", "node:path"],
  [`${LIB}/steps.ts`]: ["node:crypto", "node:fs", "node:fs/promises", "node:path", "./ledger"],
  [`${LIB}/design-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../codex", "./ledger", "./steps"],
  // DEV-150: plus the three-method lane's page requests (pure), for a page's picture (route claude_page)
  [`${LIB}/image-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../three-methods/page-assets", "../codex", "./ledger", "./steps"],
  // DEV-150: one DIRECTION_FIRST call; the answer checked by the three-method lane (pure)
  [`${LIB}/direction-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../three-methods/direction", "../codex", "./ledger", "./steps"],
  // Issue #293 P3: one IMAGE_FIRST batch under one approval; the batch call is passed in by its CLI
  // Issue #302 (d4 run path): plus the per-direction packet table (data only, no import)
  // DEV-303: plus the request id rule (request-prompt.ts isRequestId) for a request run
  [`${LIB}/full-page-call.ts`]: ["node:crypto", "node:fs/promises", "node:path", "../codex", "../image-first/prompt", "../image-first/record", "../image-first/request-prompt", "./approval-packets", "./ledger", "./steps"],
  [`${LIB}/approval-packets.ts`]: [],
  // DEV-303: plus the request's files (request mode rebuilds and re-checks the request, the facts and the plan itself)
  [FULL_PAGE_CLI]: ["node:fs/promises", "node:os", "node:path", `${L}/design-image/image-once`, `${L}/image-first/prompt`, `${L}/imagefirst-worker/request`, `${L}/phase2f-live/full-page-call`, `${L}/phase2f-live/ledger`, "./phase2f-live-cli"],
  // Issue #302 (d4 run path): plus the per-direction allowlist (run-directions.ts: data and pure lookups)
  [WORKER_LIB]: ["node:crypto", "node:fs", "node:fs/promises", "node:path", "../bounded-process", "../image-first/prompt", "../phase2f-live/full-page-call", "../phase2f-live/ledger", "../phase2f-live/steps", "../worker/state", "./run-directions"],
  // Issue #302 P3 follow-up (owner instruction 2026-11-20, exact path): plus the review delivery of a finished run
  // (deliver-review.ts: bundle + local inbox + previews; starts nothing, claims nothing; its imports are pinned in
  // tests/unit/design-agent/imagefirst-worker/deliver-review.test.ts)
  // PR #310 review H1 / L5 (exact paths): plus the worker side's read-only jail state (jail-state.ts: /usr/bin/systemctl
  // by absolute path) and node:fs/promises for the review summary's audit line
  // DEV-303: plus the request cycle and the request's files (the real shop's private record)
  [WORKER_CLI]: ["node:fs/promises", "node:os", "node:path", `${L}/bounded-process`, `${L}/imagefirst-worker/cycle`, `${L}/imagefirst-worker/deliver-review`, `${L}/imagefirst-worker/jail-state`, `${L}/imagefirst-worker/request`, `${L}/imagefirst-worker/request-cycle`, `${L}/phase2f-live/ledger`, `${L}/worker/env`, "../design-artifact/phase2f-live-cli"],
  [REQUEST_CYCLE]: ["node:fs/promises", "node:path", "../bounded-process", "../image-first/prompt", "../image-first/request-prompt", "../phase2f-live/full-page-call", "../phase2f-live/ledger", "../phase2f-live/steps", "../worker/state", "./cycle", "./request"],
  [CLI_SHARED]: ["node:fs/promises", "node:os", "node:path", `${L}/bounded-process`, `${L}/codex`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`, `${L}/protected-paths`, `${L}/sandbox`, `${L}/worker/env`],
  // DEV-124: node:os, playwright and the reference sheet make the v2 reference images before the approval is used
  // DEV-150: node:crypto for the SHA-256 of the tm0 brief that --print-pin shows
  [DESIGN_CLI]: ["node:crypto", "node:fs/promises", "node:os", "node:path", "playwright", `${L}/artifact/schema`, `${L}/codex`, `${L}/phase2f/prompt`, `${L}/phase2f/reference-sheet`, `${L}/phase2f-live/design-call`, `${L}/phase2f-live/ledger`, "./phase2f-live-cli"],
  // DEV-150: plus Chromium and the existing DOM prototype safety check for a page's picture (route P, before the
  // approval is used), and the facts pack schema the three-method lane re-exports (to rebuild the page's request)
  [IMAGE_CLI]: ["node:fs/promises", "node:os", "node:path", "playwright", `${L}/design-image/image-once`, `${L}/design-image/prompt`, `${L}/phase2f/prototype-safety`, `${L}/phase2f-live/image-call`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`, `${L}/three-methods/brief`, "./phase2f-live-cli"],
  [DIRECTION_CLI]: ["node:fs/promises", "node:path", `${L}/codex`, `${L}/three-methods/brief`, `${L}/three-methods/direction`, `${L}/phase2f-live/direction-call`, `${L}/phase2f-live/ledger`, "./phase2f-live-cli"],
  [TM_STEPS_CLI]: [
    "node:crypto",
    "node:fs/promises",
    "node:os",
    "node:path",
    "playwright",
    `${L}/identity/identity-lock`,
    `${L}/impl-lane/handoff`,
    `${L}/phase2f/prototype-safety`,
    `${L}/phase2f/render-prototype`,
    `${L}/phase2f/runner`,
    `${L}/phase2f-live/ledger`,
    `${L}/phase2f-live/steps`,
    `${L}/structure/observe`,
    `${L}/structure/references`,
    // owner approval A′: the pilot picture's own check (pure), instead of the Lock's full-design image audit
    `${L}/three-methods/asset-image-audit`,
    `${L}/three-methods/brief`,
    `${L}/three-methods/direction`,
    `${L}/three-methods/page-assets`,
    // review round 4 M1: the pilot's route C pin, rebuilt to bind a route C picture's design run to the facts pack
    `${L}/three-methods/visual-first`,
  ],
  [STEPS_CLI]: ["node:fs/promises", "node:os", "node:path", "playwright", `${L}/artifact/schema`, `${L}/phase2f/compare-sheet`, `${L}/phase2f/prompt`, `${L}/phase2f/runner`, `${L}/phase2f-live/image-call`, `${L}/phase2f-live/ledger`, `${L}/phase2f-live/steps`],
};

describe("isolation of the Phase 2f-2 steps", () => {
  it("has exactly the expected files", () => {
    expect(git(["ls-files", "--cached", "--others", "--exclude-standard", "--", LIB, ...CLIS]).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only what it needs", (file, allowed) => {
    expect(specifiers(readFileSync(resolve(REPO, file), "utf8")).filter((s) => !allowed.includes(s))).toEqual([]);
  });

  it("the modules start no process and open no connection; from codex.ts they take only types and the two error classes", () => {
    for (const file of Object.keys(ALLOWED).filter((f) => f.startsWith(LIB))) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      expect(source, file).not.toMatch(/runCodexJson|prepareCodexSandbox|runBounded|generateImageOnce|\bfetch\(|node:https?|child_process|anthropic|openai|spawn\(|execFile/);
      const fromCodex = named(source, "../codex");
      for (const name of fromCodex) expect(["CodexAbortedError", "CodexError", "type CodexRunMeta"], `${file}: ${name}`).toContain(name);
    }
  });

  it("the design CLI calls Codex only for JSON, the image CLI only the image call; both only inside the sandbox the preflight prepared", () => {
    // DEV-150: the direction CLI exactly as the design CLI (JSON only, no image)
    for (const file of [DESIGN_CLI, DIRECTION_CLI]) {
      const design = readFileSync(resolve(REPO, file), "utf8");
      expect(design.match(/runCodexJson\w*\(/g), file).toEqual(["runCodexJsonWithMeta("]);
      expect(design, file).not.toMatch(/image_generation|generateImageOnce|design-image|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile/);
    }
    expect(readFileSync(resolve(REPO, DIRECTION_CLI), "utf8")).toMatch(/const sandbox = ctx\.sandbox\(\);\n\s*if \(sandbox === null\) throw new Error\("no sandbox"\);\n\s*return runCodexJsonWithMeta\(\{ sandbox, \.\.\.o \}\);/);
    const image = readFileSync(resolve(REPO, IMAGE_CLI), "utf8");
    expect(image).not.toMatch(/runCodexJson|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile|SR_POC_|poc-approval-used|run-wagashi/);
    expect(named(image, `${L}/design-image/image-once`)).toEqual(["cleanupActiveImageCalls", "generateImageOnce"]);
    expect(named(image, `${L}/design-image/prompt`)).toEqual(["buildMockupPrompt", "loadPocInputs"]);
    // DEV-150: from phase2f only the DOM safety check, from the lane only the facts pack schema
    expect(named(image, `${L}/phase2f/prototype-safety`)).toEqual(["PrototypeUnsafe", "checkPrototype"]);
    expect(named(image, `${L}/three-methods/brief`)).toEqual(["FactsPack"]);
    expect(readFileSync(resolve(REPO, CLI_SHARED), "utf8")).toMatch(/prepareCodexSandbox\(\{ env, protectedPaths \}\)/);
    // Issue #293 P3: the IMAGE_FIRST entry takes only the batch call, and calls it only in the sandbox the preflight prepared
    const fullPage = readFileSync(resolve(REPO, FULL_PAGE_CLI), "utf8");
    expect(fullPage).not.toMatch(/runCodexJson|generateImageOnce|\bfetch\(|anthropic|openai|child_process|spawn\(|execFile|SR_POC_|poc-approval-used/);
    expect(named(fullPage, `${L}/design-image/image-once`)).toEqual(["cleanupActiveImageCalls", "generateImagesInOneRun"]);
    expect(fullPage).toMatch(/const sandbox = ctx\.sandbox\(\);\n\s*if \(sandbox === null\) throw new Error\("no sandbox"\);\n\s*const r = await generateImagesInOneRun\(\{ sandbox,/);
  });

  it("the offline steps CLIs never reach Codex, the image tool, the sandbox or a process", () => {
    // DEV-150: the three-method steps CLI too
    for (const file of [STEPS_CLI, TM_STEPS_CLI]) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      expect(source, file).not.toMatch(/\/codex["']|runCodexJson|generateImageOnce|prepareCodexSandbox|bounded-process|design-image|phase2f-live-cli|\bfetch\(|node:https?|child_process|spawn\(|execFile|anthropic|openai/);
    }
  });

  it("is imported by nobody else (the CLIs are entry points; the shared helper only by the real-call CLIs)", () => {
    // Issue #302 (d4 run path): plus the per-direction allowlist, which takes only the packet table (data, no import)
    expect(git(["grep", "--untracked", "-lE", "phase2f-live|phase2f-design|phase2f-image|phase2f-steps|phase2f-direction", "--", "lib", "app", "components", "scripts", `:!${LIB}`])).toEqual([DESIGN_CLI, IMAGE_CLI, CLI_SHARED, STEPS_CLI, DIRECTION_CLI, TM_STEPS_CLI, FULL_PAGE_CLI, WORKER_LIB, WORKER_CLI, RUN_DIRECTIONS, REQUEST_CYCLE].sort());
    expect(specifiers(readFileSync(resolve(REPO, RUN_DIRECTIONS), "utf8"))).toEqual(["../phase2f-live/approval-packets"]);
    expect(git(["grep", "--untracked", "-lE", "phase2f-live-cli", "--", "lib", "app", "components", "scripts"])).toEqual([DESIGN_CLI, IMAGE_CLI, DIRECTION_CLI, FULL_PAGE_CLI, WORKER_CLI].sort());
    // Issue #293 P3: nothing starts the IMAGE_FIRST entry (run by hand by the owner only). Issue #298 P1: except the worker
    // adapter, which names it once (GENERATE_ENTRY) and is itself started by hand only (nothing starts the adapter)
    expect(git(["grep", "--untracked", "-lE", "(tsx|node|npx|bun|sh)\\b.*image-first-generate", "--", ".", ":!tests/**", ":!docs/**", ":!.ai/**", `:!${FULL_PAGE_CLI}`])).toEqual([]);
    expect(git(["grep", "--untracked", "-lF", "image-first-generate", "--", "lib", "app", "components", "scripts", ".github", "package.json", `:!${FULL_PAGE_CLI}`])).toEqual([WORKER_LIB]);
    // Issue #302 P1 (owner-approved scope): one exception, root's automatic start (WORKER_AUTOSTART), which starts the
    // adapter once per root-owned one-use marker; its unit names only that script (tests/unit/design-agent/imagefirst-worker/autostart.test.ts)
    expect(git(["grep", "--untracked", "-lE", "(tsx|node|npx|bun|sh|ExecStart)\\b.*imagefirst-worker\\.ts", "--", ".", ":!tests/**", ":!docs/**", ":!.ai/**", `:!${WORKER_CLI}`])).toEqual([WORKER_APPROVE, WORKER_AUTOSTART, WORKER_DELIVER, WORKER_PILOT, WORKER_PILOT_PREFLIGHT].sort());
    // Issue #302: the pilot starts the adapter's run once, its preflight only the --precheck; neither names the entry or a model API (code lines)
    const codeOf = (f: string) => readFileSync(resolve(REPO, f), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    // (PR #325) plus, in --autorun only, the same no-generation re-send as the wrapper's (--deliver-review), from the fresh clone
    // (DEV-303) plus a standing request's one run: --request <id> --request-sha256 <hex> instead of the approval grant
    expect(codeOf(WORKER_PILOT).match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &', 'imagefirst-worker.ts --request "$APPROVAL" --request-sha256 "$REQUEST_SHA" >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &', 'imagefirst-worker.ts --deliver-review "$APPROVAL" >"$WORK/deliver" 2>/dev/null 8>&- 9>&-']);
    // the approval command: the --precheck only
    expect(codeOf(WORKER_APPROVE).match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 7>&- 8>&- 9>&-']);
    expect(codeOf(WORKER_APPROVE)).not.toMatch(/image-first-generate|generateImage|anthropic|openai/i);
    // the preflight: the --precheck, and (review H1) the read-only Codex sign-in check, which uses nothing
    // (DEV-303) plus a standing request's precheck (the worker's --request ... --precheck: writes nothing)
    expect(codeOf(WORKER_PILOT_PREFLIGHT).match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts --precheck >"$WORK/precheck" 2>/dev/null 8>&- 9>&-', 'imagefirst-worker.ts --request "$APPROVAL" --request-sha256 "$REQUEST_SHA" --precheck >"$WORK/precheck" 2>/dev/null 8>&- 9>&-', 'imagefirst-worker.ts --check-codex-auth-only >"$WORK/codex" 2>/dev/null 8>&- 9>&-']);
    for (const f of [WORKER_PILOT, WORKER_PILOT_PREFLIGHT]) expect(codeOf(f), f).not.toMatch(/image-first-generate|generateImage|anthropic|openai/i);
    // Issue #302 (PR #316 round 2 review L4): the adapter's only route to a Codex process is the read-only sign-in check:
    // codexSignInCheck and liveContext are each called exactly once, both inside the argv-gated `if (codexAuth) {` block,
    // which returns before the grant, the places, the precheck and the cycle
    const tsCode = (f: string) => readFileSync(resolve(REPO, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const cli = tsCode(WORKER_CLI);
    expect(cli.match(/\bcodexSignInCheck\(/g)).toHaveLength(1);
    expect(cli.match(/\bliveContext\(/g)).toHaveLength(1);
    const gate = cli.indexOf("  if (codexAuth) {\n");
    expect(gate).toBeGreaterThan(0);
    const block = cli.slice(gate, cli.indexOf("\n  }\n", gate));
    expect(block).toMatch(/\bliveContext\(join\(homedir\(\), "sr-runs", "\.codex-sign-in-check"\), \(\) => undefined\)/);
    expect(block).toMatch(/\bcodexSignInCheck\(ctx, controller\.signal\)/);
    expect(block).toMatch(/return code === null \? 0 : 2;$/);
    expect(block).not.toMatch(/claimApproval|openLedger|ledger\.|\binvoke\(|runImagefirstCycle|precheckImagefirstCycle|deliverReview|deliverAfterRun|GENERATE_ENTRY|tsEntry/);
    expect(cli.indexOf("const codexAuth = process.argv.length === 3 && process.argv[2] === \"--check-codex-auth-only\";")).toBeGreaterThan(0);
    // and the helper runs only the sandboxed sign-in status read: its preflight (the .env rule + the sandbox set-up) and
    // assertChatGptSignIn, nothing else that could start Codex
    const shared = tsCode(CLI_SHARED);
    const at = shared.indexOf("export async function codexSignInCheck(");
    expect(at).toBeGreaterThan(0);
    const body = shared.slice(at, shared.indexOf("\n}\n", at) + 2);
    expect(body.match(/assertChatGptSignIn\(/g)).toHaveLength(1);
    expect(body.match(/ctx\.preflight\(\)/g)).toHaveLength(1);
    expect(body).not.toMatch(/\.run\(|exec|runCodexJson|generateImage|image-once|probeCliVersion|checkGeneration|runBounded|ledger|spawn/);
    // the automatic start never names the entry, Codex or a model itself: it only starts the adapter
    expect(readFileSync(resolve(REPO, WORKER_AUTOSTART), "utf8")).not.toMatch(/image-first-generate|codex|anthropic|openai|generateImage/i);
    // the re-send wrapper names the adapter only in its --deliver-review mode, and never the entry, Codex or a model (code lines)
    const deliver = readFileSync(resolve(REPO, WORKER_DELIVER), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(deliver).not.toMatch(/image-first-generate|codex|anthropic|openai|generateImage/i);
    expect(deliver.match(/imagefirst-worker\.ts[^\n]*/g)).toEqual(['imagefirst-worker.ts --deliver-review "$APPROVAL" >"$WORK/out" 2>"$WORK/err" 8>&- 9>&- &']);
    // the adapter never takes the image call, the sandbox or Codex: it starts the entry (its one process) and reads files
    for (const file of [WORKER_LIB, WORKER_CLI, REQUEST_CYCLE, "lib/design-agent/imagefirst-worker/request.ts"]) expect(readFileSync(resolve(REPO, file), "utf8"), file).not.toMatch(/generateImage|image-once|prepareCodexSandbox|\/sandbox["']|runCodexJson|\/codex["']|\bfetch\(|node:https?|child_process|anthropic|openai/);
    // DEV-150: no package script, workflow, unit file or other script starts the new entries (run by hand only)
    expect(git(["grep", "--untracked", "-lE", "(tsx|node|npx|bun|sh)\\b.*(phase2f-direction|three-methods-steps)", "--", ".", ":!tests/**", ":!docs/**", ":!.ai/**"])).toEqual([]);
  });

  it("only the image CLI names the image PoC's code; no file here names its approval, pin, ledger or output", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(resolve(REPO, file), "utf8");
      // Issue #293 P3: the IMAGE_FIRST entry names only the batch call (checked above)
      if (file !== IMAGE_CLI && file !== FULL_PAGE_CLI) expect(source, file).not.toMatch(/design-image/);
      expect(source, file).not.toMatch(/sr-design-image-poc|poc-approval-used|design-library\/poc|wagashi-a-v4-20261025-01|4e34f760/);
    }
  });
});
