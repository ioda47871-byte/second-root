import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CodexAbortedError, CodexError, runCodexJsonWithMeta, type CodexRunMeta } from "@/lib/design-agent/codex";
import { runDesignCall, type CommitState, type DesignCallInput, type DesignCodex } from "@/lib/design-agent/phase2f-live/design-call";
import { LIVE_LIMITS, openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { passthroughSandbox } from "../../../support/passthrough-sandbox";

// DEV-116: one real design call per owner approval. Fake Codex only (an injected function, or the fake CLI through
// the real runCodexJsonWithMeta); fictional data; the ledger in a temp directory.

const COMMIT = "a".repeat(40);
const PROMPT = "Design ONE original page for 架空菓庵 (fictional).";
const SHA = createHash("sha256").update(PROMPT, "utf8").digest("hex");
const META: CodexRunMeta = { threadId: "00000000-0000-4000-8000-000000000000", cliVersion: "0.200.0", modelReported: "gpt-fictional-5", redactions: [] };
const ANSWER = { schema: "codex_design_v1", prototype: { html: "<svg/>", css: "h1{writing-mode:vertical-rl}" } };

let base: string;
let n = 0;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dev116-"));
});

const input = (o: Partial<DesignCallInput> = {}): DesignCallInput => ({
  route: "B_html_prototype",
  prompt: PROMPT,
  schema: {},
  humanApprovalConfirmed: true,
  approvalId: `fictional-2f-b-${++n}`,
  planId: "plan-fictional-1",
  retryOf: null,
  expected: { promptSha256: SHA, promptChars: PROMPT.length, commit: COMMIT },
  outDir: join(base, `out-${n}`),
  ...o,
});
const clean = async (): Promise<CommitState> => ({ head: COMMIT, base: COMMIT, clean: true });
const deps = (codex: DesignCodex, o: { commit?: typeof clean; now?: () => number } = {}) => ({ ledger: openLedger(join(base, "state"), o.now), codex, commit: o.commit ?? clean, ...(o.now ? { now: o.now } : {}) });
const counting = (impl: DesignCodex = async () => ({ answer: ANSWER, meta: META })) => {
  const f = Object.assign(async (o: Parameters<DesignCodex>[0]) => ((f.calls += 1), impl(o)), { calls: 0 });
  return f;
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const ledgerFiles = () => (existsSync(join(base, "state", "approvals")) ? readdirSync(join(base, "state", "approvals")) : []);

describe("a normal call is not stopped by anything unnecessary", () => {
  it("records the answer, the generation facts and the receipt; the approval is used once", async () => {
    const codex = counting();
    const i = input();
    const r = await runDesignCall(i, deps(codex));
    expect(r.status).toBe("succeeded");
    expect(codex.calls).toBe(1);
    expect(json(join(i.outDir, "answer.json"))).toEqual(ANSWER);
    expect(json(join(i.outDir, "generation.json"))).toMatchObject({ status: "succeeded", tool: "codex_cli", tool_version: "0.200.0", model_reported: "gpt-fictional-5", approval_id: i.approvalId, prompt_sha256: SHA, worker_commit: COMMIT });
    expect(json(join(i.outDir, "call.json"))).toMatchObject({ status: "succeeded", warnings: [], receipt: { slot: "first-1", kind: "design", route: "B_html_prototype" } });
    expect(json(join(base, "state", "approvals", i.approvalId, "result.json"))).toMatchObject({ status: "succeeded", code: null });
  });

  it("an unknown model or CLI version, and redacted strings, are warnings: the answer is still delivered", async () => {
    const meta = { ...META, modelReported: null, cliVersion: null, redactions: [{ path: "prototype.css", count: 2 }] };
    const i = input();
    const r = await runDesignCall(i, deps(counting(async () => ({ answer: ANSWER, meta }))));
    expect(r.status === "succeeded" && r.warnings).toEqual(["generation_model_unknown", "generation_tool_version_unknown", "answer_redacted:prototype.css"]);
    expect(json(join(i.outDir, "call.json")).redactions).toEqual([{ path: "prototype.css", count: 2 }]);
    expect(existsSync(join(i.outDir, "answer.json"))).toBe(true);
  });

  it("the call gets the plan's time limit (15 minutes at most)", async () => {
    let timeout = 0;
    await runDesignCall(input(), deps(counting(async (o) => ((timeout = o.timeoutMs), { answer: ANSWER, meta: META }))));
    expect(timeout).toBe(LIVE_LIMITS.callTimeoutMs);
  });
});

describe("checked before the approval is used (a refusal uses nothing)", () => {
  it.each<[string, Partial<DesignCallInput>, string]>([
    ["no human approval", { humanApprovalConfirmed: false }, "HUMAN_APPROVAL_REQUIRED"],
    ["another prompt", { prompt: `${PROMPT} ` }, "PROMPT_PIN_MISMATCH"],
    ["the approved SHA with another length", { expected: { promptSha256: SHA, promptChars: 3, commit: COMMIT } }, "PROMPT_PIN_MISMATCH"],
    ["a malformed commit", { expected: { promptSha256: SHA, promptChars: PROMPT.length, commit: "abc" } }, "COMMIT_PIN_MISMATCH"],
    ["a malformed approval ID", { approvalId: "X" }, "APPROVAL_ID_INVALID"],
    ["a relative output dir", { outDir: "out" }, "OUT_DIR_INVALID"],
  ])("%s", async (_n, o, code) => {
    const codex = counting();
    expect(await runDesignCall(input(o), deps(codex))).toEqual({ status: "stopped", code, stage: "precheck", aborted: false });
    expect(codex.calls).toBe(0);
    expect(ledgerFiles()).toEqual([]);
  });

  it.each<[string, () => Promise<{ head: string | null; base: string | null; clean: boolean }>]>([
    ["HEAD is another commit", async () => ({ head: "b".repeat(40), base: COMMIT, clean: true })],
    ["origin/develop is another commit", async () => ({ head: COMMIT, base: "b".repeat(40), clean: true })],
    ["the tree has changes", async () => ({ head: COMMIT, base: COMMIT, clean: false })],
    ["git cannot be read", async () => Promise.reject(new Error("no git"))],
  ])("the commit pin: %s", async (_n, commit) => {
    const codex = counting();
    expect(await runDesignCall(input(), deps(codex, { commit }))).toMatchObject({ code: "COMMIT_PIN_MISMATCH", stage: "precheck" });
    expect(codex.calls).toBe(0);
    expect(ledgerFiles()).toEqual([]);
  });

  it("an existing output dir (a design step is never run twice into the same place)", async () => {
    const i = input();
    await runDesignCall(i, deps(counting()));
    const codex = counting();
    expect(await runDesignCall({ ...i, approvalId: "fictional-2f-b-new" }, deps(codex))).toMatchObject({ code: "OUT_DIR_EXISTS", stage: "precheck" });
    expect(codex.calls).toBe(0);
  });

  it("aborted before the start: no approval used, no call", async () => {
    const c = new AbortController();
    c.abort();
    const codex = counting();
    expect(await runDesignCall(input({ signal: c.signal }), deps(codex))).toEqual({ status: "stopped", code: "CODEX_ABORTED", stage: "precheck", aborted: true });
    expect(codex.calls).toBe(0);
    expect(ledgerFiles()).toEqual([]);
  });
});

describe("one approval, one call: never reused, never retried by itself", () => {
  it("an approval ID is used at most once, whatever the outcome", async () => {
    const i = input();
    await runDesignCall(i, deps(counting(async () => Promise.reject(new CodexError("CODEX_EXEC_FAILED", "x")))));
    const codex = counting();
    expect(await runDesignCall({ ...i, outDir: join(base, "again") }, deps(codex))).toMatchObject({ code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    expect(codex.calls).toBe(0);
  });

  it.each<[string, unknown, string]>([
    ["a Codex failure", new CodexError("CODEX_EXEC_FAILED", "x"), "CODEX_EXEC_FAILED"],
    ["a usage limit", new CodexError("CODEX_QUOTA", "x"), "CODEX_QUOTA"],
    ["a timeout", new CodexError("CODEX_TIMEOUT", "x"), "CODEX_TIMEOUT"],
    ["anything else", new Error("boom"), "CODEX_UNEXPECTED"],
  ])("%s is recorded as failed: no answer, no success, one call", async (_n, error, code) => {
    const codex = counting(async () => Promise.reject(error));
    const i = input();
    expect(await runDesignCall(i, deps(codex))).toEqual({ status: "stopped", code, stage: "call", aborted: false });
    expect(codex.calls).toBe(1);
    expect(existsSync(join(i.outDir, "answer.json"))).toBe(false);
    expect(existsSync(join(i.outDir, "generation.json"))).toBe(false);
    expect(json(join(i.outDir, "call.json"))).toMatchObject({ status: "failed", code });
    expect(json(join(base, "state", "approvals", i.approvalId, "result.json"))).toMatchObject({ status: "failed", code });
  });

  it("aborted during the call: recorded as aborted, no answer even if one comes back, no second call", async () => {
    const c = new AbortController();
    // Codex returns an answer, but the caller had already stopped the call
    const codex = counting(async () => (c.abort(), { answer: ANSWER, meta: META }));
    const i = input({ signal: c.signal });
    expect(await runDesignCall(i, deps(codex))).toEqual({ status: "stopped", code: "CODEX_ABORTED", stage: "call", aborted: true });
    expect(codex.calls).toBe(1);
    expect(existsSync(join(i.outDir, "answer.json"))).toBe(false);
    expect(json(join(base, "state", "approvals", i.approvalId, "result.json"))).toMatchObject({ status: "aborted", code: "CODEX_ABORTED" });
  });

  it("through the real runCodexJsonWithMeta: aborting stops the fake Codex, the ledger says aborted, nothing runs again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev116-fake-"));
    await writeFile(join(dir, "steps.json"), JSON.stringify([{ sleepMs: 30_000, answer: ANSWER }, { answer: ANSWER }]));
    const env = { ...process.env, CODEX_HOME: join(dir, "home"), FAKE_CODEX_STEPS: join(dir, "steps.json"), FAKE_CODEX_STATE: join(dir, "state"), FAKE_CODEX_RECORD: join(dir, "record.jsonl") };
    const c = new AbortController();
    const i = input({ signal: c.signal });
    const run = runDesignCall(i, deps((o) => runCodexJsonWithMeta({ sandbox: passthroughSandbox(join(process.cwd(), "tests/support/fake-codex.mjs"), env), ...o })));
    const until = Date.now() + 10_000;
    while (!existsSync(join(dir, "state")) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    c.abort();
    expect(await run).toMatchObject({ status: "stopped", code: "CODEX_ABORTED", stage: "call" });
    const execs = readFileSync(join(dir, "record.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[] }).filter((x) => x.args[0] === "exec");
    expect(execs).toHaveLength(1);
    expect(json(join(base, "state", "approvals", i.approvalId, "result.json")).status).toBe("aborted");
  }, 30_000);

  it("a CodexAbortedError from the port without the caller's signal is also aborted, never a success", async () => {
    const i = input();
    expect(await runDesignCall(i, deps(counting(async () => Promise.reject(new CodexAbortedError()))))).toMatchObject({ code: "CODEX_ABORTED", aborted: true });
  });
});

describe("the plan's limits: 4 first calls, 2 retries, 15 minutes each, 2 hours in all (each call its own approval)", () => {
  it("a fifth first call is refused before anything is used", async () => {
    for (let k = 0; k < 4; k++) expect((await runDesignCall(input(), deps(counting()))).status).toBe("succeeded");
    const codex = counting();
    expect(await runDesignCall(input(), deps(codex))).toMatchObject({ code: "RUN_LIMIT_FIRST_CALLS", stage: "precheck" });
    expect(codex.calls).toBe(0);
    // another plan has its own limits
    expect((await runDesignCall(input({ planId: "plan-fictional-2" }), deps(counting()))).status).toBe("succeeded");
  });

  it("a retry names a failed call of the same plan, route and kind; each failed call once; at most 2 retries", async () => {
    const fail = counting(async () => Promise.reject(new CodexError("CODEX_EXEC_FAILED", "x")));
    const a = input();
    const b = input();
    const c = input();
    for (const x of [a, b, c]) await runDesignCall(x, deps(fail));
    const ok = input();
    await runDesignCall(ok, deps(counting()));

    expect(await runDesignCall(input({ retryOf: "fictional-unknown" }), deps(counting()))).toMatchObject({ code: "RETRY_OF_UNKNOWN" });
    expect(await runDesignCall(input({ retryOf: ok.approvalId }), deps(counting()))).toMatchObject({ code: "RETRY_OF_SUCCEEDED" });
    expect(await runDesignCall(input({ retryOf: a.approvalId, route: "C_hybrid" }), deps(counting()))).toMatchObject({ code: "RETRY_OF_UNKNOWN" });
    expect(await runDesignCall(input({ retryOf: a.approvalId, planId: "plan-fictional-2" }), deps(counting()))).toMatchObject({ code: "RETRY_OF_UNKNOWN" });

    const r1 = input({ retryOf: a.approvalId });
    expect(await runDesignCall(r1, deps(counting()))).toMatchObject({ status: "succeeded", receipt: { slot: "retry-1", retry_of: a.approvalId } });
    expect(await runDesignCall(input({ retryOf: a.approvalId }), deps(counting()))).toMatchObject({ code: "RETRY_ALREADY_MADE" });
    expect((await runDesignCall(input({ retryOf: b.approvalId }), deps(counting()))).status).toBe("succeeded");
    const codex = counting();
    expect(await runDesignCall(input({ retryOf: c.approvalId }), deps(codex))).toMatchObject({ code: "RUN_LIMIT_RETRIES", stage: "precheck" });
    expect(codex.calls).toBe(0);
  });

  it("time: each call by the time it took, across separate steps; a call without a result counts as a full 15 minutes", async () => {
    let t = 0;
    const now = () => t;
    const taking = (ms: number, seen?: (o: { timeoutMs: number }) => void) => counting(async (o) => (seen?.(o), (t += ms), { answer: ANSWER, meta: META }));
    // two 50-minute calls (each step its own process: the ledger carries the time): 100 of 120 minutes used
    for (let k = 0; k < 2; k++) await runDesignCall(input(), deps(taking(50 * 60_000), { now }));
    const ledger = openLedger(join(base, "state"), now);
    expect(await ledger.usedMs("plan-fictional-1")).toBe(100 * 60_000);
    // the next call gets the time left, at most 15 minutes
    let timeout = 0;
    await runDesignCall(input(), deps(taking(19.5 * 60_000, (o) => (timeout = o.timeoutMs)), { now }));
    expect(timeout).toBe(15 * 60_000);
    // 119.5 minutes used: less than a minute left, nothing is started
    const codex = counting();
    expect(await runDesignCall(input(), deps(codex, { now }))).toMatchObject({ code: "RUN_TIME_BUDGET", stage: "precheck" });
    expect(codex.calls).toBe(0);

    // a crashed call (receipt, no result) counts as a full call
    const crashed = await ledger.reserve({ approval_id: "fictional-crashed", plan_id: "plan-fictional-3", route: "B_html_prototype", kind: "design", retry_of: null, prompt_sha256: SHA, prompt_chars: 1, commit: COMMIT, run_id: "p2f-crashed" });
    expect(crashed.slot).toBe("first-1");
    expect(await ledger.usedMs("plan-fictional-3")).toBe(LIVE_LIMITS.callTimeoutMs);
  });
});
