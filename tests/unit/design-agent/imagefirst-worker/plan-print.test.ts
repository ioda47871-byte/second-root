import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { generateImagesInOneRun } from "@/lib/design-agent/design-image/image-once";
import { PromptStop } from "@/lib/design-agent/image-first/prompt";
import { REFERENCE_DIR_TOKEN } from "@/lib/design-agent/image-tool-limits";
import { gitCommitState } from "@/lib/design-agent/imagefirst-worker/cycle";
import { loadRequestRun, PLAN_PRINT_SCHEMA, printRequestPlan, STAGED_INPUTS_DIR, validateRequestFile } from "@/lib/design-agent/imagefirst-worker/request";
import { precheckRequestCycle, runRequestCycle } from "@/lib/design-agent/imagefirst-worker/request-cycle";
import { runLoadedRequest } from "@/lib/design-agent/imagefirst-worker/request-run";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { parseArgs } from "@/scripts/design-artifact/phase2f-live-cli";
import { CASE_STUDY_FILE, CASE_STUDY_REPO_FILES, caseStudyBytes, cleanupTemps, ENV, fakeCodex, NOW, REPO, sha, tmp, workerRepo } from "./support";

// DEV-303 (owner goal 2026-11-26): the offline plan print of a whole_page request (`imagefirst-worker.ts --print-plan`):
// the batch prompt, the reference ids with SHA-256 and staged paths, and plan_sha256 equal to --validate-request's and
// the worker's. FICTIONAL fixtures only: the "real_shop" pack and the case-study texts are invented for the test (the
// reference pictures are the repository's success-case images). No real Codex, no model, no image tool, no network: the
// last test runs the whole request cycle against the FAKE Codex to show that what it receives is what the print says.

vi.setConfig({ testTimeout: 90_000 });
afterAll(cleanupTemps);

const ID = "req-test-shop-p-1";
const SHOP = "test-shop-p";
const FACTS: FactsPack = {
  schema: "shop_facts_pack_v1",
  shop_id: SHOP,
  facts: [
    { id: "F1", key: "name", value: "架空雑貨 ことり舎", source_id: "S1" },
    { id: "F2", key: "category", value: "general_store", source_id: "S1" },
    { id: "F3", key: "description", value: "テスト用の架空の雑貨店です。実在しません。", source_id: "S1" },
    { id: "F4", key: "address", value: "架空市架空町4-5-6", source_id: "S1" },
    { id: "F5", key: "hours", value: "11:00〜18:00", source_id: "S1" },
    { id: "F6", key: "closed_days", value: "月曜", source_id: "S1" },
    { id: "F7", key: "statement_1", value: "架空の器を季節ごとに入れ替えます", source_id: "S1" },
    { id: "F8", key: "service_1", value: "架空の器", source_id: "S1" },
  ],
};
const FACTS_BYTES = Buffer.from(`${JSON.stringify(FACTS, null, 2)}\n`);
const CASE_STUDY = caseStudyBytes(SHOP);
const DIRECTION = {
  name: "棚の小鳥",
  concept: "小さな棚を眺めるように、余白の中に情報を少しずつ置く。",
  palette: "白い地に灰色と淡い黄。",
  typography: "丸みのあるゴシックの見出しと細い本文。",
  layout_pc: "中央に店名、左右に情報を分ける。",
  layout_sp: "一段。店名と営業時間を最初の画面に置く。",
  avoid: "写真風の表現と強い影。",
};
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const REQUEST = bytesOf({
  schema: "sr_imagefirst_request_v1",
  id: ID,
  shop_id: SHOP,
  kind: "real_shop",
  created_at: "2026-11-26T00:30:00Z",
  layout: "whole_page",
  direction: DIRECTION,
  case_study: { path: CASE_STUDY_FILE, sha256: sha(CASE_STUDY) },
  facts_ref: { root: "second-root-shops", shop_id: SHOP },
  facts_sha256: sha(FACTS_BYTES),
  max_images: 2,
  codex_runs: 1,
});
/** The counted cases' first image each, in the owner's order (request.ts selectReferences), as files of the repository. */
const REFS = ["CP-001", "CP-002", "CP-003"].map((case_id, n) => {
  const bytes = readFileSync(resolve(REPO, CASE_STUDY_REPO_FILES[n + 1]!));
  return { id: `ref-${n + 1}`, case_id, name: `ref-${n + 1}.webp`, sha256: sha(bytes), bytes: bytes.length };
});

/** A home with the shop's private files, and the request outside the repository (where Claude writes it before validating). */
function world() {
  const home = tmp("sr-plan-home-");
  const shopDir = join(home, "second-root-shops", SHOP);
  mkdirSync(shopDir, { recursive: true });
  writeFileSync(join(shopDir, "facts-pack.json"), FACTS_BYTES);
  writeFileSync(join(shopDir, CASE_STUDY_FILE), CASE_STUDY);
  const file = join(tmp("sr-plan-req-"), `${ID}.json`);
  writeFileSync(file, REQUEST);
  return { home, file };
}

describe("DEV-303 --print-plan: exactly what the one Codex run of a whole_page request would be sent (offline)", () => {
  it("the prompt, the references (ids, SHA-256, staged paths) and the pins; plan_sha256 is --validate-request's", async () => {
    const w = world();
    const p = await printRequestPlan({ file: w.file, home: w.home, repo: REPO });
    const v = await validateRequestFile({ file: w.file, home: w.home, repo: REPO });
    expect(p).toMatchObject({ schema: PLAN_PRINT_SCHEMA, codex_invoked: false, ...v });
    expect(p.plan_sha256).toBe(v.plan_sha256);
    expect(p.plan.plan_sha256).toBe(v.plan_sha256);
    expect(v).toMatchObject({ request_id: ID, kind: "real_shop", stage: "design", layout: "whole_page", request_sha256: sha(REQUEST), facts_sha256: sha(FACTS_BYTES) });
    // one run, PC 1 + SP 1, the batch prompt with its SHA-256 and length, and the entry's pins (request-cycle.ts requestArgv)
    expect(p.sent).toMatchObject({ codex_runs: 1, max_images: 2, prompt_sha256: sha(p.sent.prompt), prompt_chars: p.sent.prompt.length, reference_dir_token: REFERENCE_DIR_TOKEN, staged_dir: STAGED_INPUTS_DIR, attachments_complete: true });
    expect(p.sent.prompt).toBe(p.plan.batch.prompt);
    expect(p.entry_pins).toEqual({ expected_plan_sha256: v.plan_sha256, expected_prompt_sha256: p.sent.prompt_sha256, expected_prompt_chars: p.sent.prompt_chars });
    // the attachments in exec order, each the repository file's SHA-256, staged under the run's temporary inputs dir
    expect(p.sent.attachments).toEqual(REFS.map((r, n) => ({ order: n + 1, kind: "reference", id: r.id, case_id: r.case_id, name: r.name, staged_name: r.name, staged_path: `${STAGED_INPUTS_DIR}/${r.name}`, sha256: r.sha256, media_type: "image/webp", bytes: r.bytes })));
    expect(v.reference_images).toEqual(REFS.map((r) => ({ id: r.id, case_id: r.case_id, sha256: r.sha256 })));
    // the prompt names each reference exactly once by its staged token path, and carries the facts values
    for (const r of REFS) expect(p.sent.prompt.split(`${REFERENCE_DIR_TOKEN}/${r.name}`).length - 1, r.name).toBe(1);
    expect(p.sent.prompt.split(REFERENCE_DIR_TOKEN).length - 1).toBe(REFS.length);
    expect(p.sent.prompt).toContain("架空雑貨 ことり舎");
    // the per-picture prompts are in the plan (PC 1 + SP 1)
    const plan = p.plan as { viewports: Record<string, { parts: { name: string; prompt: string }[] }> };
    expect(Object.values(plan.viewports).flatMap((vp) => vp.parts.map((x) => x.name))).toEqual(["pc-1", "sp-1"]);
    // deterministic, and nothing was written
    expect((await printRequestPlan({ file: w.file, home: w.home, repo: REPO })).plan_sha256).toBe(p.plan_sha256);
    expect(readdirSync(w.home)).toEqual(["second-root-shops"]);
    expect(readdirSync(join(w.home, "second-root-shops", SHOP)).sort()).toEqual([CASE_STUDY_FILE, "facts-pack.json"].sort());
  });

  it("refuses with the same fixed codes as --validate-request", async () => {
    const w = world();
    const codeOf = (q: Promise<unknown>) => q.then(() => "resolved", (e: unknown) => (e instanceof PromptStop ? e.code : String(e)));
    const misnamed = join(dirname(w.file), "req-test-shop-p-2.json");
    writeFileSync(misnamed, REQUEST);
    expect(await codeOf(printRequestPlan({ file: misnamed, home: w.home, repo: REPO }))).toBe("REQUEST_ID_MISMATCH");
    expect(await codeOf(printRequestPlan({ file: w.file, home: tmp("sr-plan-empty-"), repo: REPO }))).toBe("FACTS_MISSING");
  });

  it("the CLI (inside a requester jail unit too): pretty JSON, plan_sha256 = --validate-request's; refusals as one line; nothing written", () => {
    const w = world();
    const ENTRY = join(REPO, "tests/unit/design-agent/imagefirst-worker/fixtures/worker-cli-entry.ts");
    const cli = (args: string[], home = w.home) => spawnSync(process.execPath, ["--import", "tsx", ENTRY, "0::/system.slice/sr-jail-claude.service\n", ...args], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } as unknown as NodeJS.ProcessEnv, timeout: 60_000 });
    const printed = cli(["--print-plan", w.file]);
    expect(printed.status).toBe(0);
    const p = JSON.parse(printed.stdout) as { status: string; code: null; plan_sha256: string; codex_invoked: boolean; sent: { prompt: string; attachments: { id: string; sha256: string; staged_path: string }[] } };
    expect([p.status, p.code, p.codex_invoked]).toEqual(["plan", null, false]);
    const validated = cli(["--validate-request", w.file]);
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout.trim())).toMatchObject({ status: "valid", plan_sha256: p.plan_sha256 });
    expect(p.sent.attachments.map((a) => [a.id, a.sha256, a.staged_path])).toEqual(REFS.map((r) => [r.id, r.sha256, `${STAGED_INPUTS_DIR}/${r.name}`]));
    expect(readdirSync(w.home)).toEqual(["second-root-shops"]);
    // USAGE and a refusal: one line, exit 2
    for (const args of [["--print-plan"], ["--print-plan", w.file, "extra"]]) expect([cli(args).status, JSON.parse(cli(args).stdout.trim()).code]).toEqual([2, "USAGE"]);
    const empty = tmp("sr-plan-cli-empty-");
    const refused = cli(["--print-plan", w.file], empty);
    expect([refused.status, JSON.parse(refused.stdout.trim())]).toEqual([2, { status: "refused", code: "FACTS_MISSING" }]);
    expect(readdirSync(empty)).toEqual([]);
  });

  it("the worker's precheck pins the same plan_sha256, and the FAKE Codex receives exactly the printed prompt and attachments", async () => {
    const w = world();
    const p = await printRequestPlan({ file: w.file, home: w.home, repo: REPO });
    // the worker side: a clone on origin/develop, root's private copy of the request, the private dirs
    const repo = workerRepo();
    const runsDir = join(w.home, "sr-runs");
    mkdirSync(runsDir, { mode: 0o700 });
    const privateDir = join(runsDir, "requests-private", ID);
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const requestFile = join(privateDir, `${ID}.json`);
    writeFileSync(requestFile, REQUEST);
    const stateDir = join(w.home, "state");
    const ledgerDir = join(w.home, "ledger");
    const opts = { repoRoot: repo, stateDir, runsDir, home: w.home, requestId: ID, requestSha256: sha(REQUEST), requestFile };
    const pre = await precheckRequestCycle(opts, { commit: () => gitCommitState(repo, ENV), ledger: openLedger(ledgerDir), now: () => NOW });
    expect(pre.report).toMatchObject({ status: "would_run", approval_id: ID });
    expect(pre.run!.planSha256).toBe(p.plan_sha256);

    // the fake Codex records its stdin and `--image` files (with their SHA-256 while they are staged)
    const fake = fakeCodex("two");
    const seen: { input?: string; images: { path: string; sha256: string }[] } = { images: [] };
    const run = fake.sandbox.run.bind(fake.sandbox);
    fake.sandbox.run = async (a, o) => {
      if (a[0] === "exec") {
        seen.input = o.input;
        seen.images = a.filter((x) => x.startsWith("--image=")).map((x) => x.slice("--image=".length)).map((path) => ({ path, sha256: sha(readFileSync(path)) }));
      }
      return run(a, o);
    };
    const invoked: string[][] = [];
    const entry = async (argv: string[]): Promise<BoundedResult> => {
      invoked.push(argv);
      const args = parseArgs(argv, new Set(), new Set(["--request-file", "--request-id", "--request-sha256", "--out", "--expected-commit", "--expected-plan-sha256", "--expected-prompt-sha256", "--expected-prompt-chars"]))!;
      const loaded = await loadRequestRun({ requestFile: args.get("--request-file")!, requestSha256: args.get("--request-sha256")!, requestId: args.get("--request-id")!, home: w.home, repo });
      const r = await runLoadedRequest(
        { run: loaded, expected: { promptSha256: args.get("--expected-prompt-sha256")!, promptChars: Number(args.get("--expected-prompt-chars")), commit: args.get("--expected-commit")!, planSha256: args.get("--expected-plan-sha256")! }, outDir: args.get("--out")!, repoRoot: repo },
        {
          ledger: openLedger(ledgerDir),
          commit: () => gitCommitState(repo, ENV),
          preflight: async () => null,
          now: () => NOW,
          batch: async (o) => {
            const g = await generateImagesInOneRun({ sandbox: fake.sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: fake.tmpBase, maxImages: o.maxImages, ...(o.inputImages ? { inputImages: o.inputImages } : {}), ...(o.referenceImages ? { referenceImages: o.referenceImages } : {}) });
            return { images: g.images, outcome: g.outcome, stopCode: g.stopCode, imageCalls: g.imageCalls, imageFailed: g.imageFailed, imageCallIds: g.imageCallIds ?? [], threadId: g.threadId, cliVersion: g.cliVersion, model: g.model };
          },
        },
      );
      return { code: r.status === "succeeded" ? 0 : 1, signal: null, stdout: `${JSON.stringify({ status: r.status })}\n`, stderr: "", timedOut: false };
    };
    const { report } = await runRequestCycle(opts, { commit: () => gitCommitState(repo, ENV), ledger: openLedger(ledgerDir), now: () => NOW, invoke: entry });
    expect(report).toMatchObject({ status: "succeeded", invoked: true });
    expect(fake.execs).toBe(1);
    // the worker passed the printed pins
    const argv = invoked[0]!;
    const value = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect([value("--expected-plan-sha256"), value("--expected-prompt-sha256"), value("--expected-prompt-chars")]).toEqual([p.entry_pins.expected_plan_sha256, p.entry_pins.expected_prompt_sha256, String(p.entry_pins.expected_prompt_chars)]);
    // the attachments: the printed staged names, order and SHA-256 under one temporary inputs dir
    expect(seen.images.map((i) => [basename(i.path), i.sha256])).toEqual(p.sent.attachments.map((a) => [a.staged_name, a.sha256]));
    const stagedDir = dirname(seen.images[0]!.path);
    expect(basename(stagedDir)).toBe("inputs");
    expect(seen.images.every((i) => dirname(i.path) === stagedDir)).toBe(true);
    // the stdin: the printed prompt with the token replaced by that dir, nothing else
    expect(seen.input).toBe(p.sent.prompt.split(REFERENCE_DIR_TOKEN).join(stagedDir));
    const receipt = JSON.parse(readFileSync(report.receipt!, "utf8")) as { plan_sha256: string; prompt_sha256: string };
    expect([receipt.plan_sha256, receipt.prompt_sha256]).toEqual([p.plan_sha256, p.sent.prompt_sha256]);
  });
});
