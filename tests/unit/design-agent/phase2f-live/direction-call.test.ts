import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CodexAbortedError, CodexError, type CodexRunMeta } from "@/lib/design-agent/codex";
import { runDirectionCall, type DirectionCallInput, type DirectionCodex } from "@/lib/design-agent/phase2f-live/direction-call";
import { KIND_ROUTES, LedgerStop, openLedger, type CallKind, type Route } from "@/lib/design-agent/phase2f-live/ledger";
import { readStep } from "@/lib/design-agent/phase2f-live/steps";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { ThreeMethodBrief } from "@/lib/design-agent/three-methods/brief";
import { buildDirectionPrompt, directionJsonSchema } from "@/lib/design-agent/three-methods/direction";

// DEV-150 (Issue #180): one real DIRECTION_FIRST call per owner approval, with the design step's guards. Fake Codex
// only (an injected function); the study's fictional shop; the ledger in a temp directory. Nothing calls Codex.

const REPO = resolve(__dirname, "../../../..");
const DIR = "design-library/research/three-methods";
const readJson = (p: string) => JSON.parse(readFileSync(resolve(REPO, DIR, p), "utf8"));
const facts = FactsPack.parse(readJson("facts-pack.json"));
const built = buildDirectionPrompt({ facts, brief: ThreeMethodBrief.parse(readJson("brief.json")) });
const COMMIT = "a".repeat(40);
const META: CodexRunMeta = { threadId: "00000000-0000-4000-8000-000000000000", cliVersion: "0.200.0", modelReported: "gpt-fictional-5", redactions: [] };
const DIRECTION = {
  schema: "three_method_direction_v0",
  concept: "朝の石窯の火から始まるページ。",
  dna: Object.fromEntries(["hero", "typography", "palette", "product_visual", "section_rhythm", "navigation", "mobile", "implementation"].map((p) => [p, { choice: `${p} の選択`, fact_refs: ["F1"] }])),
  avoid: ["カードの並び"],
};

let base: string;
let n = 0;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dev150-direction-"));
});
const input = (o: Partial<DirectionCallInput> = {}): DirectionCallInput => ({
  prompt: built.prompt,
  schema: directionJsonSchema(),
  facts,
  humanApprovalConfirmed: true,
  approvalId: `fictional-tm-df-${++n}`,
  planId: "plan-fictional-tm-df",
  retryOf: null,
  expected: { promptSha256: built.sha256, promptChars: built.chars, commit: COMMIT },
  outDir: join(base, `out-${n}`),
  ...o,
});
const clean = async () => ({ head: COMMIT, base: COMMIT, clean: true });
const deps = (codex: DirectionCodex, commit = clean) => ({ ledger: openLedger(join(base, "state")), codex, commit });
const counting = (impl: DirectionCodex = async () => ({ answer: DIRECTION, meta: META })) => {
  const f = Object.assign(async (o: Parameters<DirectionCodex>[0]) => ((f.calls += 1), f.seen.push(o), impl(o)), { calls: 0, seen: [] as Parameters<DirectionCodex>[0][] });
  return f;
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const ledgerFiles = () => (existsSync(join(base, "state", "approvals")) ? readdirSync(join(base, "state", "approvals")) : []);

describe("a direction call", () => {
  it("records the checked answer, the generation facts and a direction × direction_text receipt; Codex once, with the direction schema", async () => {
    const codex = counting();
    const i = input();
    const r = await runDirectionCall(i, deps(codex));
    expect(r.status).toBe("succeeded");
    expect(codex.calls).toBe(1);
    expect(codex.seen[0]).toMatchObject({ prompt: built.prompt, schema: directionJsonSchema(), timeoutMs: 15 * 60_000 });
    expect(json(join(i.outDir, "answer.json"))).toEqual(DIRECTION);
    expect(json(join(i.outDir, "generation.json"))).toMatchObject({ status: "succeeded", tool_version: "0.200.0", model_reported: "gpt-fictional-5", approval_id: i.approvalId, prompt_sha256: built.sha256, worker_commit: COMMIT });
    expect(json(join(i.outDir, "call.json"))).toMatchObject({ status: "succeeded", receipt: { kind: "direction", route: "direction_text", slot: "first-1" } });
    // a later step reads it only through readStep, as a direction step
    const step = await readStep(i.outDir, openLedger(join(base, "state")), { kind: "direction", route: "direction_text" });
    expect(step.result.status).toBe("succeeded");
    await expect(readStep(i.outDir, openLedger(join(base, "state")), { kind: "design", route: "B_html_prototype" })).rejects.toMatchObject({ code: "RECORD_WRONG_STEP" });
  });

  it("an answer that does not check is a failed call: kept as received, the approval used, never retried or repaired", async () => {
    for (const [answer, code] of [
      [{ ...DIRECTION, html: "<p>" }, "DIRECTION_ANSWER_INVALID"],
      [{ ...DIRECTION, dna: { ...DIRECTION.dna, hero: { choice: "x", fact_refs: ["F99"] } } }, "DIRECTION_FACT_UNKNOWN"],
    ] as const) {
      const codex = counting(async () => ({ answer, meta: META }));
      const i = input();
      expect(await runDirectionCall(i, deps(codex))).toEqual({ status: "stopped", code, stage: "call", aborted: false });
      expect(codex.calls).toBe(1);
      expect(json(join(i.outDir, "answer.json"))).toEqual(answer);
      expect(existsSync(join(i.outDir, "generation.json"))).toBe(false);
      // the CLI version and model are kept for the owner's version check (decision 5)
      expect(json(join(i.outDir, "call.json"))).toMatchObject({ status: "failed", code, cli_version: "0.200.0", model_reported: "gpt-fictional-5" });
      expect(json(join(base, "state", "approvals", i.approvalId, "result.json"))).toMatchObject({ status: "failed", code });
    }
  });

  it("a Codex failure or an abort is recorded as it was", async () => {
    const i = input();
    expect(await runDirectionCall(i, deps(counting(async () => Promise.reject(new CodexError("CODEX_TIMEOUT", "x")))))).toMatchObject({ status: "stopped", code: "CODEX_TIMEOUT", stage: "call" });
    expect(json(join(i.outDir, "call.json"))).toMatchObject({ status: "failed", code: "CODEX_TIMEOUT" });
    const j = input();
    expect(await runDirectionCall(j, deps(counting(async () => Promise.reject(new CodexAbortedError()))))).toMatchObject({ status: "stopped", code: "CODEX_ABORTED", aborted: true });
  });
});

describe("checked before the approval is used (a refusal uses nothing)", () => {
  it.each<[string, Partial<DirectionCallInput>, string]>([
    ["no human approval", { humanApprovalConfirmed: false }, "HUMAN_APPROVAL_REQUIRED"],
    ["another prompt", { prompt: `${built.prompt} ` }, "PROMPT_PIN_MISMATCH"],
    ["the approved SHA with another length", { expected: { promptSha256: built.sha256, promptChars: 3, commit: COMMIT } }, "PROMPT_PIN_MISMATCH"],
    ["a malformed commit", { expected: { promptSha256: built.sha256, promptChars: built.chars, commit: "abc" } }, "COMMIT_PIN_MISMATCH"],
    ["a malformed approval ID", { approvalId: "X" }, "APPROVAL_ID_INVALID"],
    ["a relative output dir", { outDir: "out" }, "OUT_DIR_INVALID"],
  ])("%s", async (_n, o, code) => {
    const codex = counting();
    expect(await runDirectionCall(input(o), deps(codex))).toEqual({ status: "stopped", code, stage: "precheck", aborted: false });
    expect(codex.calls).toBe(0);
    expect(ledgerFiles()).toEqual([]);
  });

  it("the commit pin (HEAD = origin/develop = approved, clean tree)", async () => {
    const codex = counting();
    expect(await runDirectionCall(input(), deps(codex, async () => ({ head: COMMIT, base: COMMIT, clean: false })))).toMatchObject({ code: "COMMIT_PIN_MISMATCH", stage: "precheck" });
    expect(codex.calls).toBe(0);
    expect(ledgerFiles()).toEqual([]);
  });

  it("one use per approval; a retry only of a call that did not succeed (a succeeded one is refused: RETRY_OF_SUCCEEDED)", async () => {
    const ok = input();
    await runDirectionCall(ok, deps(counting()));
    const codex = counting();
    expect(await runDirectionCall(input({ approvalId: ok.approvalId }), deps(codex))).toMatchObject({ code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    expect(await runDirectionCall(input({ retryOf: ok.approvalId }), deps(codex))).toMatchObject({ code: "RETRY_OF_SUCCEEDED", stage: "precheck" });
    expect(codex.calls).toBe(0);
    const bad = input();
    await runDirectionCall(bad, deps(counting(async () => ({ answer: { schema: "x" }, meta: META }))));
    expect(await runDirectionCall(input({ retryOf: bad.approvalId }), deps(counting()))).toMatchObject({ status: "succeeded", receipt: { slot: "retry-1", retry_of: bad.approvalId } });
  });
});

describe("DEV-150: the ledger refuses a kind with another kind's route, before anything is used", () => {
  const all: [CallKind, Route][] = (Object.keys(KIND_ROUTES) as CallKind[]).flatMap((k) => (["A_image", "B_html_prototype", "C_hybrid", "direction_text", "claude_page"] as Route[]).map((r) => [k, r] as [CallKind, Route]));

  it("precheck and reserve accept exactly the existing pairs and one route per new kind", async () => {
    const ledger = openLedger(join(base, "state"));
    for (const [kind, route] of all) {
      const ok = KIND_ROUTES[kind].includes(route);
      const pre = await ledger.precheck({ approvalId: `fictional-pair-${kind.replace("_", "-")}-${route.replace("_", "-").toLowerCase()}`, planId: "plan-fictional-pairs", route, kind, retryOf: null }).then(() => "ok", (e: unknown) => (e instanceof LedgerStop ? e.code : "?"));
      expect(pre, `${kind} × ${route}`).toBe(ok ? "ok" : "KIND_ROUTE_MISMATCH");
    }
    expect(Object.fromEntries(Object.entries(KIND_ROUTES))).toEqual({ design: ["B_html_prototype", "C_hybrid"], image: ["C_hybrid"], concept_image: ["A_image"], direction: ["direction_text"], page_image: ["claude_page"] });
    // reserve checks the pair first: nothing is created for a wrong pair (the approval stays unused)
    await expect(ledger.reserve({ approval_id: "fictional-pair-wrong", plan_id: "plan-fictional-pairs", route: "C_hybrid", kind: "direction", retry_of: null, prompt_sha256: "a".repeat(64), prompt_chars: 1, commit: COMMIT, run_id: "p2f-x" })).rejects.toMatchObject({ code: "KIND_ROUTE_MISMATCH" });
    expect(ledgerFiles()).toEqual([]);
    expect(await ledger.reserve({ approval_id: "fictional-pair-right", plan_id: "plan-fictional-pairs", route: "C_hybrid", kind: "image", retry_of: null, prompt_sha256: "a".repeat(64), prompt_chars: 1, commit: COMMIT, run_id: "p2f-x" })).toMatchObject({ kind: "image", route: "C_hybrid", slot: "first-1" });
  });
});

describe("the direction CLI (offline paths only)", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/phase2f-direction.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const inputs = ["--facts", resolve(REPO, DIR, "facts-pack.json"), "--tm-brief", resolve(REPO, DIR, "brief.json")];

  it("--print-pin prints the pilot's direction pin and calls nothing", () => {
    const r = cli(["--print-pin", ...inputs]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ mode: "print_pin", kind: "direction", route: "direction_text", answer_schema: "three_method_direction_v0", answer_schema_sha256: "e9050605def92bb9556a25e7a2bc88657c41a3fb21b2d70ed1521a97bfa555ef", facts_pack_sha256: "e63d925a1e1cdae46502d9e2a1fc2745eb69a47e65df7ba51fdd9036d04597c0", tm_brief_sha256: "efe91cf257e628894a222f4c39291d1f5d2a539bc5740995ee97f0547f164b4c", prompt_sha256: "641d01f91d85bfd0005effd08b2ec9c0767a384878fd6f2accaeed730dc6d3ad", prompt_chars: 3353 });
  }, 30_000);

  it("refuses bad usage and a call without the owner's confirmation, before the ledger is touched", () => {
    for (const args of [[], ["--print-pin"], ["--print-pin", ...inputs, "--out", "x"], [...inputs, "--codex"], ["--print-pin", "--facts", resolve(REPO, DIR, "facts-pack.json")]]) expect(cli(args).status, args.join(" ")).toBe(2);
    const state = mkdtempSync(join(tmpdir(), "dev150-cli-"));
    const out = join(mkdtempSync(join(tmpdir(), "dev150-out-")), "run");
    const r = cli([...inputs, "--out", out, "--plan-id", "plan-fictional-tm-df", "--approval-id", "fictional-tm-df-cli", "--expected-prompt-sha256", "0".repeat(64), "--expected-prompt-chars", "10", "--expected-commit", "a".repeat(40)], { SR_PHASE2F_STATE: state });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "stopped", code: "HUMAN_APPROVAL_REQUIRED", approval_used: false });
    expect(readdirSync(state)).toEqual([]);
    // the output and ledger place rules of the design step hold here too
    const inRepo = cli([...inputs, "--out", join(REPO, "tmp-dev150-run"), "--plan-id", "plan-fictional-tm-df", "--approval-id", "fictional-tm-df-cli2", "--expected-prompt-sha256", built.sha256, "--expected-prompt-chars", String(built.chars), "--expected-commit", "a".repeat(40), "--human-approval-confirmed"], { SR_PHASE2F_STATE: state });
    expect(JSON.parse(inRepo.stdout)).toMatchObject({ code: "OUT_DIR_INSIDE_REPO" });
    expect(readdirSync(state)).toEqual([]);
  }, 60_000);
});
