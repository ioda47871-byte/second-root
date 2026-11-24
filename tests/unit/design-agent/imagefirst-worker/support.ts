// Shared by cycle.test.ts and the automatic start's fake worker (fixtures/fake-worker.ts, run as a process): the
// filled-in d3 packet (in memory / temporary repositories only), the temporary worker clone, the fake Codex (the
// image-once tests' in-process sandbox) and image-first-generate.ts main() replayed in-process. No vitest here, no
// Codex, no model, no image tool, no network. Relative imports only (the fake worker runs under plain tsx).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BoundedResult } from "../../../../lib/design-agent/bounded-process";
import { generateImagesInOneRun } from "../../../../lib/design-agent/design-image/image-once";
import { buildPromptPlan, DIRECTIONS, loadPromptInputs, PROMPT_INPUTS, PromptStop, type DirectionKey } from "../../../../lib/design-agent/image-first/prompt";
import { viewingPageSha256, type CaseStudy } from "../../../../lib/design-agent/case-study/case-study";
import { gitCommitState } from "../../../../lib/design-agent/imagefirst-worker/cycle";
import { APPROVAL_PACKET_PATH, D4_PACKET, PACKET_FIELDS, packetFieldsOf, packetOfDirection, runFullPageCall } from "../../../../lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "../../../../lib/design-agent/phase2f-live/ledger";
import type { CodexSandbox } from "../../../../lib/design-agent/sandbox";
import { childEnvironment } from "../../../../lib/design-agent/worker/env";
import { fileAtCommit, parseArgs } from "../../../../scripts/design-artifact/phase2f-live-cli";
import { colourPng } from "../phase2f/fixtures";
import { UNAPPROVED_D4_PACKET_FIXTURE, UNAPPROVED_PACKET_FIXTURE } from "../image-first/fixtures/unapproved-packet";

export const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
export const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
export const cleanupTemps = () => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
};
export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const NOW = Date.parse("2026-11-20T01:00:00Z");
export const ID = "hoshigama-imagefirst-d3-20261120-01";
export const PLAN_ID = "hoshigama-imagefirst-p3-20261120";
export const THREAD = "0f0e0d0c-0b0a-4908-8706-050403020100";
export const ENV = childEnvironment(process.env);

/** The entry's flag sets, read from its source (a drift between the adapter's arguments and the entry fails here). */
const ENTRY = readFileSync(resolve(REPO, "scripts/design-artifact/image-first-generate.ts"), "utf8");
const setOf = (name: string) => new Set([...(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(ENTRY)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
export const FLAGS = setOf("FLAGS");
export const VALUES = setOf("VALUES");

// ---- the filled-in packet (in memory; written only into the temporary repository) ----------------------------------
export type Fill = Record<keyof typeof PACKET_FIELDS, string>;
export const D3: Fill = { status: "`承認済み`", directions: "`d3`", d1: "`なし`", d3: `\`${ID}\``, expires: "`2026-11-20T09:00:00Z`", planId: `\`${PLAN_ID}\``, approvedBy: "2026-11-20 owner (test)" };
export function filledPacket(values: Partial<Fill> = {}, edit: (t: string) => string = (t) => t): Buffer {
  let text = readFileSync(UNAPPROVED_PACKET_FIXTURE, "utf8").replace("**状態: 未承認。**", "**状態: 承認済み。**");
  const at = text.indexOf("## 10. 承認欄");
  let section = text.slice(at);
  for (const [k, label] of Object.entries(PACKET_FIELDS) as [keyof Fill, string][]) {
    const re = new RegExp(`^(\\| ${label}(?:（[^|]*)? \\| ).*( \\|)$`, "m");
    if (!re.test(section)) throw new Error(`packet row missing: ${label}`);
    section = section.replace(re, `$1${values[k] ?? D3[k]}$2`);
  }
  text = text.slice(0, at) + section;
  return Buffer.from(edit(text));
}

// ---- the filled-in d4 packet (in memory; from the unapproved d4 fixture, never the real packet) ---------------------
export const D4_ID = "hoshigama-imagefirst-d4-20261120-01";
export const D4_PLAN_ID = "hoshigama-imagefirst-p4-20261120";
export type D4Fill = { status: string; directions: string; d4: string; expires: string; planId: string; approvedBy: string };
export const D4: D4Fill = { status: "`承認済み`", directions: "`d4`", d4: `\`${D4_ID}\``, expires: "`2026-11-20T09:00:00Z`", planId: `\`${D4_PLAN_ID}\``, approvedBy: "2026-11-20 owner (test)" };
/** The unapproved d4 fixture filled exactly as its own §10 says (header line rewritten, every §10 row given a value). */
export function filledD4Packet(values: Partial<D4Fill> = {}, edit: (t: string) => string = (t) => t): Buffer {
  let text = readFileSync(UNAPPROVED_D4_PACKET_FIXTURE, "utf8");
  if (!text.includes("**状態: 未承認。**")) throw new Error("d4 fixture header changed");
  text = text.replace("**状態: 未承認。**", "**状態: 承認済み。**");
  const at = text.indexOf("## 10. 承認欄");
  let section = text.slice(at);
  for (const [k, label] of Object.entries(packetFieldsOf(D4_PACKET)) as [keyof D4Fill, string][]) {
    const re = new RegExp(`^(\\| ${label}(?:（[^|]*)? \\| ).*( \\|)$`, "m");
    if (!re.test(section)) throw new Error(`d4 packet row missing: ${label}`);
    section = section.replace(re, `$1${values[k] ?? D4[k]}$2`);
  }
  return Buffer.from(edit(text.slice(0, at) + section));
}

// ---- the temporary worker clone ----------------------------------------------------------------------------------
export const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
export function commitFiles(repo: string, files: Record<string, Buffer>, msg: string) {
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), bytes);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}
// ---- Issue #336: the success-case analysis a real_shop design request names (fictional content only) --------------
export const CASE_STUDY_REPO_FILES = [
  "design-library/success-cases/originals-index.json",
  "design-library/success-cases/assets/CP-001_Mond.webp",
  "design-library/success-cases/assets/CP-002_Sissi.webp",
  "design-library/success-cases/assets/CP-003_NagoyaBeans_v4_desktop.webp",
  // the recorded SHA-256s of category B (case-study.ts readOriginalsIndex)
  "design-library/success-cases/manifest.json",
];
const caseOf = (id: string, path: string) => ({
  id,
  evidence_kind: "image",
  files: [{ path, sha256: sha(readFileSync(resolve(REPO, path))) }],
  observations: { composition: "試験用の観察（構図）", information_design: "試験用の観察（情報設計）", shop_character: "試験用の観察（店らしさ）", pc_sp: "試験用の観察（PC/SP）" },
  principles_to_bring: ["試験用の原理"],
  do_not_copy: ["試験用の写さないこと"],
});
/**
 * The SHA-256 of the viewing page a record renders to, when every case listed counts and every file is a repository
 * file (what the checker rebuilds; case-study.ts viewingPageSha256).
 */
export function pageShaOf(record: Record<string, unknown>): string {
  const cases = record.cases as { id: string; files: { path: string; sha256: string }[] }[];
  const files = cases.flatMap((c) => c.files.map((f) => ({ case_id: c.id, path: f.path, sha256: f.sha256, bytes: readFileSync(resolve(REPO, f.path)) })));
  return viewingPageSha256({ shop_id: record.shop_id as string, case_study_sha256: "", counted: cases.map((c) => c.id), not_counted: [], owner_confirmed: false, record: record as unknown as CaseStudy, files });
}
/** An owner-confirmed case study for `shopId` that counts CP-001..003 (the repository's images; the text is invented). */
export function caseStudyObject(shopId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    schema: "sr_case_study_v1",
    shop_id: shopId,
    cases: [caseOf("CP-001", CASE_STUDY_REPO_FILES[1]!), caseOf("CP-002", CASE_STUDY_REPO_FILES[2]!), caseOf("CP-003", CASE_STUDY_REPO_FILES[3]!)],
    shop_specific_principles: ["試験用の店固有の原理"],
    ...over,
  };
  if (!("owner_confirmation" in over)) record.owner_confirmation = { confirmed: true, confirmed_at: "2026-11-20T00:00:00Z", selected_ids: ["CP-001", "CP-002", "CP-003"], page_sha256: pageShaOf(record) };
  return record;
}
export const caseStudyBytes = (shopId: string, over: Record<string, unknown> = {}) => Buffer.from(`${JSON.stringify(caseStudyObject(shopId, over), null, 2)}\n`);
export const CASE_STUDY_FILE = "case-study.json";

/** A temporary worker clone: the prompt inputs (d4's direction file included) and the given packets, committed. */
export function workerRepo(packet: Buffer = filledPacket(), extra: Record<string, Buffer> = {}): string {
  const repo = tmp("sr-ifw-repo-");
  git(repo, "init", "-q");
  // Issue #336: the originals index and the category-A images a request's case study names (case-study.ts)
  const inputs = [PROMPT_INPUTS.factsPack.path, PROMPT_INPUTS.directionSet.path, PROMPT_INPUTS.principles.path, DIRECTIONS.d4.set, ...CASE_STUDY_REPO_FILES];
  for (const p of inputs) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    cpSync(resolve(REPO, p), join(repo, p));
  }
  const head = commitFiles(repo, { [APPROVAL_PACKET_PATH]: packet, ...extra }, "approved packet (test)");
  git(repo, "update-ref", "refs/remotes/origin/develop", head);
  return repo;
}
export const pointOrigin = (repo: string) => git(repo, "update-ref", "refs/remotes/origin/develop", git(repo, "rev-parse", "HEAD"));

// ---- the fake Codex (the image-once tests' in-process sandbox) ----------------------------------------------------
export type Fake = { execs: number; codexHome: string; tmpBase: string; sandbox: CodexSandbox };
export const ok = (stdout = ""): BoundedResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
export function fakeCodex(mode: "six" | "fail" | "hang", root: string = tmp("sr-ifw-codex-"), onExec: () => void = () => undefined, stopDelayMs = 0, stopHold?: string): Fake {
  const codexHome = join(root, "home", ".codex");
  const tmpBase = join(root, "tmp");
  for (const d of [codexHome, tmpBase]) mkdirSync(d, { recursive: true });
  const f: Fake = {
    execs: 0,
    codexHome,
    tmpBase,
    sandbox: {
      env: { HOME: join(root, "home"), CODEX_HOME: codexHome },
      async run(a, o) {
        if (a[0] === "login") return ok("Logged in using ChatGPT\n");
        if (a[0] === "--version") return ok("codex-cli 0.163.0\n");
        f.execs += 1;
        onExec();
        if (mode === "hang") {
          // a CLI that runs until it is stopped (the worker's stop signal reaches it through the entry's abort); the
          // interval keeps the process alive meanwhile, as the real CLI's child process does
          const alive = setInterval(() => undefined, 1_000);
          await new Promise<void>((resolve) => (o.signal?.aborted ? resolve() : o.signal?.addEventListener("abort", () => resolve(), { once: true })));
          // a CLI (and an entry) that takes a while to stop, as the real one may (the entry has 20 s + 10 s)
          if (stopDelayMs > 0) await new Promise((r) => setTimeout(r, stopDelayMs));
          // or until the test lets it finish (a stop that cannot end before the test has looked)
          for (let i = 0; stopHold && existsSync(stopHold) && i < 1_200; i++) await new Promise((r) => setTimeout(r, 50));
          clearInterval(alive);
          return { code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, aborted: true };
        }
        if (mode === "fail") return { ...ok(), code: 1, stderr: "fake failure" };
        // what the CLI leaves: a session log with one completed image call per picture, and the pictures (PC 2 + SP 4)
        const sessions = join(codexHome, "sessions", "2026", "11", "20");
        mkdirSync(sessions, { recursive: true });
        const recs = [
          { type: "session_meta", payload: { id: THREAD, cwd: o.workDir, cli_version: "0.163.0", model_provider: "fake" } },
          { type: "turn_context", payload: { cwd: o.workDir, model: "fake-session" } },
          ...Array.from({ length: 6 }, (_, i) => ({ type: "response_item", payload: { type: "image_generation_call", id: `ig_${i}`, status: "completed" } })),
        ];
        writeFileSync(join(sessions, `rollout-2026-11-20T01-00-00-${THREAD}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
        const dir = join(codexHome, "generated_images", THREAD);
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 6; i++) {
          const p = join(dir, `ig_${i}.png`);
          writeFileSync(p, colourPng(1024 + i, 1536));
          const t = new Date(Date.UTC(2026, 10, 20, 1, 0, i));
          utimesSync(p, t, t);
        }
        return ok(`${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`);
      },
    },
  };
  return f;
}

/** image-first-generate.ts main(), in-process: the same flags, checks, runFullPageCall and batch mapping; exit 0 / 2 / 1. */
export async function entryInProcess(argv: string[], w: { repo: string; ledgerDir: string; fake: Fake; signal?: AbortSignal }): Promise<BoundedResult> {
  const line = (o: object, code: number): BoundedResult => ({ code, signal: null, stdout: `${JSON.stringify(o)}\n`, stderr: "", timedOut: false });
  const args = parseArgs(argv, FLAGS, VALUES);
  const chars = Number(args?.get("--expected-prompt-chars"));
  const key = args?.get("--direction");
  if (!args || [...VALUES].some((f) => !args.has(f)) || !Number.isInteger(chars) || key === undefined || packetOfDirection(key) === null) return line({ status: "refused", code: "USAGE" }, 2);
  let inputs;
  let plan;
  try {
    inputs = await loadPromptInputs((p) => readFile(resolve(w.repo, p)), key as DirectionKey);
    plan = buildPromptPlan(inputs);
  } catch (error) {
    return line({ status: "refused", code: error instanceof PromptStop ? error.code : "INPUT_UNREADABLE" }, 2);
  }
  const result = await runFullPageCall(
    {
      plan,
      inputs,
      packetPath: resolve(args.get("--packet")!),
      humanApprovalConfirmed: args.has("--human-approval-confirmed"),
      approvalId: args.get("--approval-id")!,
      planId: args.get("--plan-id")!,
      approvalExpires: args.get("--approval-expires")!,
      expected: { promptSha256: args.get("--expected-prompt-sha256")!, promptChars: chars, commit: args.get("--expected-commit")!, planSha256: args.get("--expected-plan-sha256")!, packetSha256: args.get("--expected-packet-sha256")! },
      outDir: args.get("--out")!,
      repoRoot: w.repo,
      ...(w.signal ? { signal: w.signal } : {}),
    },
    {
      ledger: openLedger(w.ledgerDir),
      commit: () => gitCommitState(w.repo, ENV),
      packetAt: (commit, rel) => fileAtCommit(commit, rel, w.repo),
      preflight: async () => null,
      now: () => NOW,
      batch: async (o) => {
        const r = await generateImagesInOneRun({ sandbox: w.fake.sandbox, prompt: o.prompt, timeoutMs: o.timeoutMs, tmpBase: w.fake.tmpBase, maxImages: o.maxImages, ...(o.signal === undefined ? {} : { signal: o.signal }) });
        return { images: r.images, outcome: r.outcome, stopCode: r.stopCode, imageCalls: r.imageCalls, imageFailed: r.imageFailed, imageCallIds: r.imageCallIds ?? [], threadId: r.threadId, cliVersion: r.cliVersion, model: r.model };
      },
    },
  );
  if (result.status === "succeeded") return line({ status: "succeeded", out: result.outDir, approval_id: result.receipt.approval_id, run_id: result.runId, images: result.images }, 0);
  return line({ status: "stopped", code: result.code, stage: result.stage, approval_used: result.stage === "call" }, result.stage === "precheck" ? 2 : 1);
}
