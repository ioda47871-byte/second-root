/**
 * Phase 2f-2 (DEV-117): the OFFLINE steps between and after the real calls. Never calls Codex or the image tool:
 * it reads what the design and image steps recorded, and uses an answer or a picture only when the step's output
 * folder AND the ledger both say it succeeded, with the same approval, run, prompt and commit (phase2f-live/steps.ts).
 *
 *   --prerender --route B|C --design <design-dir> --facts <pack.json> --out <new dir>
 *       Checks the recorded design answer and the prototype's safety and, on route C, renders it with placeholders:
 *       where each picture sits, whether it is essential, and its final image prompt. Writes one
 *       image-request-<asset>.json per picture and prerender.md, which shows the owner everything one image approval
 *       is for (design run, prompt in full, SHA, commit, placement, essential, the plan's calls so far).
 *
 *   --package --route A|B|C --facts <pack.json> --artifact-id <id> --shop-id <id> --shop-name <name> --out <new dir>
 *   --result <new file> [--brief <brief.json>] [--design <design-dir>] [--image <image-dir>]
 *       Builds the Design Artifact with the 2f-1 runner from the recorded steps, then the DEV-114 intake. The design
 *       prompt rebuilt from the facts and brief, and each image prompt rebuilt by the pre-render checks, must be the
 *       recorded ones. Route C without a picture (not approved, or failed) goes through the runner's own rules: a
 *       picture that is not essential falls back to B with the failure kept; an essential one stops for the owner.
 *
 *   --sheet --results <a.json,b.json,c.json> --out <new dir>
 *       The comparison sheet (sheet.json, sheet.md) from the package results. Scores are the owner's.
 *
 * Exit: 0 done (any verification state), 2 stopped or refused.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { FactsPack } from "../../lib/design-agent/artifact/schema";
import { sheetEntry, sheetMarkdown, type SheetCall, type SheetEntry } from "../../lib/design-agent/phase2f/compare-sheet";
import { DesignBrief } from "../../lib/design-agent/phase2f/prompt";
import { packageConceptRun, PortStop, prerenderRoute, runPrototypeRoute, type AssetPort, type DesignPort, type RunResult } from "../../lib/design-agent/phase2f/runner";
import type { ImageRequest } from "../../lib/design-agent/phase2f-live/image-call";
import { defaultLedgerDir, LIVE_LIMITS, openLedger, type Ledger } from "../../lib/design-agent/phase2f-live/ledger";
import { readStep, sha256, StepStop, type Step } from "../../lib/design-agent/phase2f-live/steps";

process.umask(0o077);
const FLAGS = new Set(["--prerender", "--package", "--sheet"]);
const VALUES = new Set(["--route", "--design", "--image", "--facts", "--brief", "--out", "--result", "--results", "--artifact-id", "--shop-id", "--shop-name"]);
const IMAGE_OUTCOMES = new Set(["IMAGE_SAVED", "NO_SESSION_LOG", "TOOL_NOT_CALLED", "TOOL_NOT_SEEN_CODE_MODE", "TOOL_FAILED_USAGE_LIMIT", "TOOL_FAILED_POLICY", "TOOL_FAILED_UNSUPPORTED", "TOOL_FAILED", "TOOL_FAILED_TRANSIENT", "TOOL_CALLED_NO_FILE"]);

function parseArgs(argv: string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (FLAGS.has(a) && !out.has(a)) out.set(a, "1");
    else if (VALUES.has(a) && !out.has(a) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) out.set(a, argv[++i]!);
    else return null;
  }
  return [...FLAGS].filter((f) => out.has(f)).length === 1 ? out : null;
}

const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string) => (say({ status: "refused", code }), 2);
const json = async <T>(p: string): Promise<T> => JSON.parse(await readFile(resolve(p), "utf8")) as T;
const routeOf = (r: string | undefined) => (r === "A" ? "A_image" : r === "B" ? "B_html_prototype" : r === "C" ? "C_hybrid" : null);
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const callOf = (s: Step): SheetCall => ({ kind: s.receipt.kind, approval_id: s.receipt.approval_id, run_id: s.receipt.run_id, prompt_sha256: s.receipt.prompt_sha256, slot: s.receipt.slot, status: s.result.status, code: s.result.code });

/** A succeeded design step: its answer, as recorded (output folder and ledger agree). */
async function designStep(dir: string, ledger: Ledger, route: "B_html_prototype" | "C_hybrid"): Promise<{ step: Step; answer: unknown }> {
  const step = await readStep(resolve(dir), ledger, { kind: "design", route });
  if (step.call.status !== "succeeded" || !step.generation) throw new StepStop("DESIGN_RUN_NOT_SUCCEEDED");
  return { step, answer: await json(join(step.dir, "answer.json")) };
}

async function prerender(args: Map<string, string>, ledger: Ledger): Promise<number> {
  const route = routeOf(args.get("--route"));
  const designDir = args.get("--design");
  const factsPath = args.get("--facts");
  const out = args.get("--out");
  if ((route !== "B_html_prototype" && route !== "C_hybrid") || !designDir || !factsPath || !out) return refuse("USAGE");
  const facts = FactsPack.safeParse(await json(factsPath));
  if (!facts.success) return refuse("FACTS_INVALID");
  const { step, answer } = await designStep(designDir, ledger, route);
  const browser = await launch();
  let pre;
  try {
    pre = await prerenderRoute({ route, browser, answer, facts: facts.data });
  } finally {
    await browser.close();
  }
  if (pre.status === "stopped") return (say({ status: "stopped", code: pre.code, stop_class: pre.stopClass, owner_check: pre.ownerCheck, recovery: pre.recovery }), 2);
  await mkdir(resolve(out), { recursive: false, mode: 0o700 });
  const design = { dir: step.dir, approval_id: step.receipt.approval_id, run_id: step.receipt.run_id, prompt_sha256: step.receipt.prompt_sha256, commit: step.receipt.commit, plan_id: step.receipt.plan_id };
  const calls = await ledger.calls(step.receipt.plan_id);
  const used = { first_calls: calls.filter((c) => c.receipt.retry_of === null).length, retries: calls.filter((c) => c.receipt.retry_of !== null).length, minutes: Math.round((await ledger.usedMs(step.receipt.plan_id)) / 60_000) };
  const files: string[] = [];
  for (const r of pre.requests) {
    const request: ImageRequest = { schema: "phase2f_image_request_v1", route: "C_hybrid", design, ...r };
    const file = join(resolve(out), `image-request-${r.asset_id}.json`);
    await writeFile(file, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    files.push(file);
  }
  const md = [
    "# 画像生成の承認依頼（1枚ごと）",
    "",
    `- 設計の実行ID: ${design.run_id}（承認ID ${design.approval_id}、計画 ${design.plan_id}）`,
    `- 設計の指示文SHA: ${design.prompt_sha256}`,
    `- 対象コミット（設計の実行時）: ${design.commit}`,
    `- この計画の呼び出し: 初回 ${used.first_calls}/${LIVE_LIMITS.firstCalls}、再試行 ${used.retries}/${LIVE_LIMITS.retries}、使った時間 約${used.minutes}分/120分`,
    "",
    ...(pre.requests.length === 0 ? ["この設計に画像はありません（画像の承認は不要）。"] : []),
    ...pre.requests.flatMap((r, i) => [
      `## 画像 ${r.asset_id}`,
      "",
      `- 使用位置: PC ${r.placement.desktop_1440.sections.join(", ") || "区画外"}（最初の画面: ${r.placement.desktop_1440.first_screen ? "入る" : "入らない"}）／ SP ${r.placement.mobile_390.sections.join(", ") || "区画外"}（最初の画面: ${r.placement.mobile_390.first_screen ? "入る" : "入らない"}）`,
      `- 主役画像: ${r.essential ? "はい（失敗したらオーナー確認で停止。勝手に削除しない）" : "いいえ（失敗したら失敗を記録して B へ切り替え）"}`,
      `- 指示文SHA-256: ${r.prompt_sha256}（${r.prompt_chars}文字）`,
      `- 依頼ファイル: ${files[i]}`,
      `- 画像の承認ID: （オーナーが決める。1回だけ使用）`,
      "",
      "指示文（全文）:",
      "",
      "```",
      r.prompt,
      "```",
      "",
    ]),
  ].join("\n");
  await writeFile(join(resolve(out), "prerender.md"), `${md}\n`, { mode: 0o600, flag: "wx" });
  say({ status: "ready", route, design_run_id: design.run_id, requests: pre.requests.map((r, i) => ({ asset_id: r.asset_id, essential: r.essential, prompt_sha256: r.prompt_sha256, prompt_chars: r.prompt_chars, file: files[i] })), presentation: join(resolve(out), "prerender.md") });
  return 0;
}

async function packageRun(args: Map<string, string>, ledger: Ledger): Promise<number> {
  const route = routeOf(args.get("--route"));
  const factsPath = args.get("--facts");
  const out = args.get("--out");
  const resultPath = args.get("--result");
  const artifactId = args.get("--artifact-id");
  const shop = { shop_id: args.get("--shop-id") ?? "", display_name: args.get("--shop-name") ?? "" };
  if (!route || !factsPath || !out || !resultPath || !artifactId || !shop.shop_id || !shop.display_name) return refuse("USAGE");
  const facts = FactsPack.safeParse(await json(factsPath));
  if (!facts.success) return refuse("FACTS_INVALID");
  const common = { facts: { path: resolve(factsPath), pack: facts.data }, shop, artifactId, outDir: resolve(out) };
  const calls: SheetCall[] = [];
  let result: RunResult;
  if (route === "A_image") {
    const imageDir = args.get("--image");
    if (!imageDir || args.has("--design")) return refuse("USAGE");
    const image = await readStep(resolve(imageDir), ledger, { kind: "concept_image", route: "A_image" });
    calls.push(callOf(image));
    if (image.call.status !== "succeeded" || !image.generation) return (say({ status: "stopped", code: "IMAGE_RUN_NOT_SUCCEEDED", image_code: image.call.code }), 2);
    result = await packageConceptRun({ ...common, pocDir: image.dir, generation: image.generation });
  } else {
    const designDir = args.get("--design");
    const briefPath = args.get("--brief");
    if (!designDir || !briefPath || (route === "B_html_prototype" && args.has("--image"))) return refuse("USAGE");
    const brief = DesignBrief.safeParse(await json(briefPath));
    if (!brief.success) return refuse("BRIEF_INVALID");
    const { step, answer } = await designStep(designDir, ledger, route);
    calls.push(callOf(step));
    const generation = step.generation!;
    // the recorded design answer stands in for Codex, only for the prompt it was made for
    const designPort: DesignPort = async (req) => {
      if (req.promptSha256 !== generation.prompt_sha256) throw new PortStop("RECORD_PROMPT_MISMATCH", "input");
      return { answer, generation };
    };
    let image: Step | null = null;
    if (args.get("--image")) {
      image = await readStep(resolve(args.get("--image")!), ledger, { kind: "image", route: "C_hybrid" });
      calls.push(callOf(image));
    }
    const assetPort: AssetPort = async (req) => {
      // no image step: the picture was not approved or not run; the runner decides (B fallback or an owner stop)
      if (!image) return { png: null, image_outcome: "TOOL_NOT_CALLED", stop_code: "IMAGE_NOT_RUN", approval_id: null };
      const link = (image.call.request ?? {}) as { design_run_id?: string; asset_id?: string };
      // the picture belongs to this design run and this asset, and was made from the prompt the checks rebuild now
      if (link.design_run_id !== step.receipt.run_id || link.asset_id !== req.assetId || image.receipt.prompt_sha256 !== req.promptSha256) throw new PortStop("RECORD_MISMATCH", "input");
      if (image.call.status === "aborted") throw new PortStop("CODEX_IMAGE_ABORTED", "interrupted");
      if (image.call.status === "succeeded") {
        const png = await readFile(join(image.dir, "image.png"));
        if (sha256(png) !== image.call.png_sha256) throw new PortStop("RECORD_MISMATCH", "input");
        return { png, image_outcome: "IMAGE_SAVED", stop_code: null, approval_id: image.receipt.approval_id };
      }
      // a failure as recorded; a call that never reached the image tool is "not called", its stop code kept
      const outcome = typeof image.call.outcome === "string" && IMAGE_OUTCOMES.has(image.call.outcome) ? image.call.outcome : "TOOL_NOT_CALLED";
      return { png: null, image_outcome: outcome as "TOOL_NOT_CALLED", stop_code: (image.call.stop_code as string | null) ?? image.call.code, approval_id: image.receipt.approval_id };
    };
    const browser = await launch();
    try {
      result = await runPrototypeRoute({ ...common, route, browser, brief: brief.data, designPort, ...(route === "C_hybrid" ? { assetPort } : {}) });
    } finally {
      await browser.close();
    }
  }
  await writeFile(resolve(resultPath), `${JSON.stringify({ schema: "phase2f_package_result_v1", route, result, calls }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  say({ mode: "recorded_steps", route, calls, ...result });
  return result.status === "done" ? 0 : 2;
}

async function sheet(args: Map<string, string>): Promise<number> {
  const list = args.get("--results")?.split(",").filter(Boolean) ?? [];
  const out = args.get("--out");
  if (list.length === 0 || !out) return refuse("USAGE");
  const entries: SheetEntry[] = [];
  for (const p of list) {
    const r = await json<{ schema: string; route: SheetEntry["route"]; result: RunResult; calls: SheetCall[] }>(p);
    if (r.schema !== "phase2f_package_result_v1") return refuse("RESULT_INVALID");
    entries.push(sheetEntry(r.route, r.result, r.calls));
  }
  await mkdir(resolve(out), { recursive: false, mode: 0o700 });
  await writeFile(join(resolve(out), "sheet.json"), `${JSON.stringify({ schema: "phase2f_comparison_sheet_v1", entries }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(join(resolve(out), "sheet.md"), sheetMarkdown(entries), { mode: 0o600, flag: "wx" });
  say({ status: "written", out: resolve(out), routes: entries.map((e) => e.route) });
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return refuse("USAGE");
  const ledger = openLedger(resolve(defaultLedgerDir(process.env, homedir())));
  try {
    if (args.has("--prerender")) return await prerender(args, ledger);
    if (args.has("--package")) return await packageRun(args, ledger);
    return await sheet(args);
  } catch (error) {
    if (error instanceof StepStop) return (say({ status: "stopped", code: error.code }), 2);
    throw error;
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    say({ status: "refused", code: "REFUSED" });
    process.exit(2);
  },
);
