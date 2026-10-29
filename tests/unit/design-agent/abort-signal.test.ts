import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runBounded } from "@/lib/design-agent/bounded-process";
import { CodexAbortedError, CodexError, findRedactions, parseCliVersion, runCodexJson, runCodexJsonWithMeta } from "@/lib/design-agent/codex";
import { passthroughSandbox } from "../../support/passthrough-sandbox";

// DEV-116: an optional AbortSignal through runBounded -> sandbox.run -> runCodexJson, and the call's own facts.
// Without a signal nothing changes (the worker never passes one). Fake processes only: no Codex, no network.

const FAKE = join(process.cwd(), "tests/support/fake-codex.mjs");
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abort-test-"));
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
};
const pidFrom = async (path: string) => (await waitFor(() => existsSync(path)) ? Number(await readFile(path, "utf8")) : NaN);
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv;

describe("runBounded with an AbortSignal", () => {
  it("without a signal: unchanged (exit code, output, no abort field)", async () => {
    const r = await runBounded("sh", ["-c", "echo hi; exit 3"], { env, timeoutMs: 5_000 });
    expect(r).toEqual({ code: 3, signal: null, stdout: "hi\n", stderr: "", timedOut: false });
  });

  it("a signal that never fires changes nothing", async () => {
    const r = await runBounded("sh", ["-c", "echo hi"], { env, timeoutMs: 5_000, signal: new AbortController().signal });
    expect(r).toEqual({ code: 0, signal: null, stdout: "hi\n", stderr: "", timedOut: false });
  });

  it("already aborted: nothing is started", async () => {
    const marker = join(dir, "started");
    const c = new AbortController();
    c.abort();
    const r = await runBounded("sh", ["-c", `touch ${marker}`], { env, timeoutMs: 5_000, signal: c.signal });
    expect(r).toMatchObject({ aborted: true, code: null, timedOut: false });
    await new Promise((r2) => setTimeout(r2, 200));
    expect(existsSync(marker)).toBe(false);
  });

  it("aborting a running process stops it and every process it started (the whole group)", async () => {
    const pidFile = join(dir, "child.pid");
    const c = new AbortController();
    const run = runBounded("sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], { env, timeoutMs: 60_000, graceMs: 500, signal: c.signal });
    const child = await pidFrom(pidFile);
    expect(alive(child)).toBe(true);
    const t = Date.now();
    c.abort();
    const r = await run;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(await waitFor(() => !alive(child))).toBe(true);
  }, 15_000);

  it("SIGTERM first; SIGKILL after the grace period when SIGTERM is ignored", async () => {
    const ready = join(dir, "ready");
    const c = new AbortController();
    const run = runBounded(process.execPath, ["-e", `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(ready)},"1");setInterval(()=>{},1000)`], { env, timeoutMs: 60_000, graceMs: 400, signal: c.signal });
    expect(await waitFor(() => existsSync(ready))).toBe(true);
    const t = Date.now();
    c.abort();
    const r = await run;
    expect(r).toMatchObject({ aborted: true, signal: "SIGKILL" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);

    // a process that honours SIGTERM ends with it, before any SIGKILL
    const c2 = new AbortController();
    const ready2 = join(dir, "ready2");
    const run2 = runBounded(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(ready2)},"1");setInterval(()=>{},1000)`], { env, timeoutMs: 60_000, graceMs: 5_000, signal: c2.signal });
    expect(await waitFor(() => existsSync(ready2))).toBe(true);
    c2.abort();
    expect(await run2).toMatchObject({ aborted: true, signal: "SIGTERM" });
  }, 15_000);
});

describe("runCodexJson / runCodexJsonWithMeta with an AbortSignal (fake Codex)", () => {
  async function setup(steps: unknown[], extra: Record<string, string> = {}) {
    await writeFile(join(dir, "steps.json"), JSON.stringify(steps));
    return { ...process.env, CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_STEPS: join(dir, "steps.json"), FAKE_CODEX_STATE: join(dir, "state"), FAKE_CODEX_RECORD: join(dir, "record.jsonl"), ...extra };
  }
  const calls = async () => (await readFile(join(dir, "record.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; cwd: string });

  it("already aborted: throws CODEX_ABORTED and starts nothing (not even the sign-in check)", async () => {
    const env2 = await setup([{ answer: { a: 1 } }]);
    const c = new AbortController();
    c.abort();
    const e = await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2), signal: c.signal }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CodexAbortedError);
    expect((e as CodexAbortedError).code).toBe("CODEX_ABORTED");
    expect(await calls()).toEqual([]);
  });

  it("aborting a running call stops Codex and its child process, gives no answer, removes its work dir, and does not run again", async () => {
    const childPid = join(dir, "codex-child.pid");
    const env2 = await setup([{ sleepMs: 30_000, childPidFile: childPid, answer: { a: 1 } }, { answer: { second: true } }]);
    const c = new AbortController();
    const call = runCodexJsonWithMeta({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2), signal: c.signal, timeoutMs: 60_000 }).catch((x: unknown) => x);
    const child = await pidFrom(childPid);
    expect(alive(child)).toBe(true);
    c.abort();
    const e = await call;
    expect(e).toBeInstanceOf(CodexAbortedError);
    // its own error class: callers that never pass a signal (worker, image PoC) cannot see a new CodexFailureCode
    expect(e).not.toBeInstanceOf(CodexError);
    expect(await waitFor(() => !alive(child))).toBe(true);
    const execs = (await calls()).filter((x) => x.args[0] === "exec");
    expect(execs).toHaveLength(1);
    expect(await readdir(execs[0]!.cwd).catch(() => "gone")).toBe("gone");
    // the thread's session log is removed as on any other end
    expect(await readdir(join(dir, "codex-home", "sessions", "2026", "09", "29")).catch(() => [])).not.toContainEqual(expect.stringContaining("00000000-0000-4000-8000-000000000000"));
  }, 30_000);

  it("a Codex that ignores SIGTERM is killed after the grace period and the call is aborted, never answered", async () => {
    const env2 = await setup([{ sleepMs: 60_000, ignoreTerm: true, answer: { a: 1 } }]);
    const c = new AbortController();
    const call = runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2), signal: c.signal, timeoutMs: 120_000 }).catch((x: unknown) => x);
    await waitFor(() => existsSync(join(dir, "state")));
    c.abort();
    expect(await call).toBeInstanceOf(CodexAbortedError);
  }, 30_000);

  it("without a signal: same answer and same failures as before", async () => {
    const env2 = await setup([{ answer: { a: 1 } }, { exit: 1, stderr: "x" }]);
    expect(await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2) })).toEqual({ a: 1 });
    const e = await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2) }).catch((x: unknown) => x);
    expect((e as CodexError).code).toBe("CODEX_EXEC_FAILED");
    // runCodexJson runs no `--version` (only the WithMeta variant does)
    expect((await calls()).map((x) => x.args[0])).toEqual(["login", "exec", "login", "exec"]);
  });
});

describe("runCodexJsonWithMeta: the call's own facts (unknown = null, a warning for the caller, never a failure)", () => {
  async function setup(answer: unknown, extra: Record<string, string> = {}) {
    await writeFile(join(dir, "steps.json"), JSON.stringify([{ answer }]));
    return { ...process.env, CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_STEPS: join(dir, "steps.json"), FAKE_CODEX_STATE: join(dir, "state"), ...extra };
  }

  it("reads the CLI version and the model from the session log before it is deleted", async () => {
    const env2 = await setup({ a: 1 }, { FAKE_CODEX_VERSION: "codex-cli 0.200.0", FAKE_CODEX_MODEL: "gpt-fictional-5" });
    const r = await runCodexJsonWithMeta({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2) });
    expect(r).toEqual({ answer: { a: 1 }, meta: { threadId: "00000000-0000-4000-8000-000000000000", cliVersion: "0.200.0", modelReported: "gpt-fictional-5", redactions: [] } });
  });

  it("a log without a model, or an odd version line, gives null (the answer is still returned)", async () => {
    const env2 = await setup({ a: 1 }, { FAKE_CODEX_VERSION: "?? not a version ??" });
    const r = await runCodexJsonWithMeta({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2) });
    expect(r.answer).toEqual({ a: 1 });
    expect(r.meta).toMatchObject({ cliVersion: null, modelReported: null });
  });

  it("redaction is unchanged (secret-looking runs are still removed) and is recorded with its JSON path", async () => {
    const long = "M".repeat(30) + "0123456789abcdef0123";
    const answer = { prototype: { html: "<svg><path d='M0 0 L10 10'/></svg>", css: `.x{--k:${long}}` }, other: "ok" };
    const env2 = await setup(answer);
    const r = await runCodexJsonWithMeta({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2) });
    expect((r.answer as typeof answer).prototype.css).toBe(".x{--k:[removed]}");
    expect((r.answer as typeof answer).prototype.html).toBe(answer.prototype.html);
    expect(r.meta.redactions).toEqual([{ path: "prototype.css", count: 1 }]);
    expect(findRedactions({ a: ["x", long] })).toEqual([{ path: "a.1", count: 1 }]);
    // a key that is not a plain name is quoted, so the path stays unambiguous
    expect(findRedactions({ "a.b": long })).toEqual([{ path: '["a.b"]', count: 1 }]);
    // a key that looks like a token is scrubbed before it is written into the path
    expect(findRedactions({ [long]: long })).toEqual([{ path: '["[removed]"]', count: 1 }]);
  });

  it("parses `codex --version`", () => {
    expect(parseCliVersion("codex-cli 0.200.0\n")).toBe("0.200.0");
    expect(parseCliVersion("")).toBeNull();
    expect(parseCliVersion("codex-cli <script>")).toBeNull();
  });
});
