import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BoundedResult } from "@/lib/design-agent/bounded-process";
import { CodexAbortedError } from "@/lib/design-agent/codex";
import { cleanupActiveImageCalls, generateImageOnce, imageStopCode } from "@/lib/design-agent/design-image/image-once";
import { SandboxError, type CodexSandbox } from "@/lib/design-agent/sandbox";
import { colourPng } from "../phase2f/fixtures";

// DEV-117: the research test's one image call for an arbitrary approved prompt, against an in-process fake sandbox
// that plays the Codex CLI (as the image PoC's own tests do). No Codex, no bubblewrap, no network, no image quota.

const THREAD = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER = "11111111-2222-4333-8444-555555555555";
let root: string;
let codexHome: string;
let tmpBase: string;
let calls: string[][];
let prompts: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dev117-img-"));
  codexHome = join(root, "home", ".codex");
  tmpBase = join(root, "tmp");
  for (const d of [codexHome, tmpBase]) mkdirSync(d, { recursive: true });
  calls = [];
  prompts = [];
});

const ok = (stdout = ""): BoundedResult => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const thread = `${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`;
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

/** What the real CLI leaves: a session log (with the model, and image-tool records) and the thread's image dir. */
function leave(cwd: string, records: unknown[] = [], images: Record<string, Buffer> = {}) {
  const sessions = join(codexHome, "sessions", "2026", "10", "29");
  mkdirSync(sessions, { recursive: true });
  const head = [
    { timestamp: "t", type: "session_meta", payload: { id: THREAD, cwd, cli_version: "0.163.0", originator: "codex_exec", model_provider: "openai" } },
    { timestamp: "t", type: "turn_context", payload: { cwd, model: "gpt-5.5-codex", approval_policy: "never", sandbox_policy: { type: "read-only" } } },
  ];
  writeFileSync(join(sessions, `rollout-2026-10-29T10-00-00-${THREAD}.jsonl`), [...head, ...records].map(line).join(""));
  const dir = join(codexHome, "generated_images", THREAD);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(images)) writeFileSync(join(dir, name), bytes);
}
const imageCall = { timestamp: "t", type: "response_item", payload: { type: "function_call", name: "imagegen", namespace: "image_gen", arguments: "{}", call_id: "call_1" } };
const failedOutput = (text: string) => ({ timestamp: "t", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: text } });

type Exec = (ctx: { cwd: string; signal?: AbortSignal }) => Promise<Partial<BoundedResult>> | Partial<BoundedResult>;
function sandbox(exec: Exec, login = "Logged in using ChatGPT\n"): CodexSandbox {
  return {
    env: { HOME: join(root, "home"), CODEX_HOME: codexHome },
    async run(args, o) {
      calls.push([...args]);
      if (args[0] === "login") return ok(login);
      if (args[0] === "--version") return ok("codex-cli 0.163.0\n");
      prompts.push(o.input ?? "");
      return { ...ok(), ...(await exec({ cwd: o.workDir, ...(o.signal ? { signal: o.signal } : {}) })) };
    },
  };
}
const once = (exec: Exec, o: { signal?: AbortSignal; login?: string } = {}) => generateImageOnce({ sandbox: sandbox(exec, o.login), prompt: "One wrapped dorayaki on rice paper.", timeoutMs: 60_000, tmpBase, ...(o.signal ? { signal: o.signal } : {}) });
const leftovers = () => ({
  images: existsSync(join(codexHome, "generated_images")) ? readdirSync(join(codexHome, "generated_images")) : [],
  logs: existsSync(join(codexHome, "sessions")) ? (readdirSync(join(codexHome, "sessions"), { recursive: true }) as string[]).filter((n) => n.endsWith(".jsonl")) : [],
  work: readdirSync(tmpBase),
});

describe("generateImageOnce: one call, every outcome as observed", () => {
  it("a saved picture: returned in memory with its size, model and CLI version; nothing left behind", async () => {
    const r = await once(({ cwd }) => (leave(cwd, [], { "ig_1.png": colourPng(1024, 1024) }), ok(thread)));
    expect(r).toMatchObject({ outcome: "IMAGE_SAVED", stopCode: null, width: 1024, height: 1024, threadId: THREAD, cliVersion: "0.163.0", model: "gpt-5.5-codex" });
    expect(r.png?.length).toBeGreaterThan(0);
    // the PoC's command line: image feature pinned on, read-only, the prompt on stdin only
    const exec = calls.find((c) => c[0] === "exec")!;
    expect(exec).toEqual(expect.arrayContaining(["--sandbox", "read-only", "features.image_generation=true"]));
    expect(exec.at(-1)).toBe("-");
    expect(exec.join(" ")).not.toContain("dorayaki");
    expect(prompts).toEqual(["One wrapped dorayaki on rice paper."]);
    expect(leftovers()).toEqual({ images: [], logs: [], work: [] });
  });

  it("an image dir another thread made before the call is not touched", async () => {
    mkdirSync(join(codexHome, "generated_images", OTHER), { recursive: true });
    writeFileSync(join(codexHome, "generated_images", OTHER, "keep.png"), colourPng(600, 600));
    await once(({ cwd }) => (leave(cwd, [], { "ig_1.png": colourPng(1024, 1024) }), ok(thread)));
    expect(leftovers().images).toEqual([OTHER]);
  });

  it("a policy refusal by the image tool: TOOL_FAILED_POLICY with its fixed code, no picture (never retried, never bypassed)", async () => {
    const r = await once(({ cwd }) => (leave(cwd, [imageCall, failedOutput("image generation failed: rejected by the safety system")]), ok(thread)));
    expect(r).toMatchObject({ png: null, outcome: "TOOL_FAILED_POLICY", stopCode: "CODEX_IMAGE_TOOL_FAILED" });
    expect(calls.filter((c) => c[0] === "exec")).toHaveLength(1);
  });

  it("the tool not called, no picture: CODEX_NO_IMAGE with the observed outcome", async () => {
    const r = await once(({ cwd }) => (leave(cwd), ok(thread)));
    expect(r).toMatchObject({ png: null, outcome: "TOOL_NOT_CALLED", stopCode: "CODEX_NO_IMAGE" });
  });

  it.each<[string, Partial<BoundedResult>, string]>([
    ["a failed exec", { code: 1, stderr: "boom" }, "CODEX_EXEC_FAILED"],
    ["a usage limit", { code: 1, stderr: "You've hit your usage limit" }, "CODEX_QUOTA"],
    ["a timeout", { code: null, timedOut: true }, "CODEX_TIMEOUT"],
    ["a revoked sign-in", { code: 1, stderr: "401 Unauthorized" }, "CODEX_NOT_SIGNED_IN"],
  ])("%s is recorded with its fixed code, no picture", async (_n, res, code) => {
    const r = await once(({ cwd }) => (leave(cwd), { ...ok(thread), ...res }));
    expect(r).toMatchObject({ png: null, stopCode: code });
  });

  it("a picture in another format, or not a valid PNG, is never accepted", async () => {
    expect(await once(({ cwd }) => (leave(cwd, [], { "ig_1.webp": Buffer.from("RIFF0000WEBP") }), ok(thread)))).toMatchObject({ png: null, stopCode: "CODEX_IMAGE_UNSUPPORTED_FORMAT" });
    expect(await once(({ cwd }) => (leave(cwd, [], { "ig_1.png": Buffer.from("not a png") }), ok(thread)))).toMatchObject({ png: null, stopCode: "CODEX_IMAGE_INVALID" });
  });

  it("an unknown model or CLI version is null, the picture is still delivered", async () => {
    const box = sandbox(({ cwd }) => {
      // a session log without a turn context (no model), and the picture
      const sessions = mkdirP(join(codexHome, "sessions", "2026", "10", "29"));
      writeFileSync(join(sessions, `rollout-2026-10-29T10-00-00-${THREAD}.jsonl`), line({ timestamp: "t", type: "session_meta", payload: { id: THREAD, cwd } }));
      writeFileSync(join(mkdirP(join(codexHome, "generated_images", THREAD)), "ig_1.png"), colourPng(800, 800));
      return ok(thread);
    });
    const run = box.run;
    box.run = async (args, o) => (args[0] === "--version" ? ok("?? not a version\n") : run(args, o));
    const r = await generateImageOnce({ sandbox: box, prompt: "p", timeoutMs: 60_000, tmpBase });
    expect(r).toMatchObject({ outcome: "IMAGE_SAVED", model: null, cliVersion: null, width: 800 });
  });

  it("a .env in Codex's home: no Codex process at all", async () => {
    writeFileSync(join(codexHome, ".env"), "OPENAI_API_KEY=x");
    const r = await once(({ cwd }) => (leave(cwd, [], { "ig_1.png": colourPng(1024, 1024) }), ok(thread)));
    expect(r).toMatchObject({ png: null, stopCode: "CODEX_DOTENV_PRESENT" });
    expect(calls).toEqual([]);
  });

  it("aborted: never a picture, even when one was written; the image dir and logs are removed; nothing runs again", async () => {
    const c = new AbortController();
    await expect(once(({ cwd }) => (leave(cwd, [], { "ig_1.png": colourPng(1024, 1024) }), c.abort(), { ...ok(thread), aborted: true }), { signal: c.signal })).rejects.toBeInstanceOf(CodexAbortedError);
    expect(calls.filter((x) => x[0] === "exec")).toHaveLength(1);
    expect(leftovers()).toEqual({ images: [], logs: [], work: [] });
    // already aborted: nothing starts
    const c2 = new AbortController();
    c2.abort();
    calls = [];
    await expect(once(() => ok(thread), { signal: c2.signal })).rejects.toBeInstanceOf(CodexAbortedError);
    expect(calls).toEqual([]);
  });

  it("no picture and the CLI's own usage-limit words: CODEX_QUOTA (as the PoC)", async () => {
    const r = await once(({ cwd }) => (leave(cwd), { ...ok(`${thread}${line({ type: "error", message: "You've hit your usage limit" })}`) }));
    expect(r).toMatchObject({ png: null, stopCode: "CODEX_QUOTA" });
  });

  it("a cut-off earlier call's leftovers (its session log and image dir) are removed before the call; others are kept", async () => {
    const STALE = "99999999-8888-4777-8666-555555555555";
    const sessions = mkdirP(join(codexHome, "sessions", "2026", "10", "28"));
    writeFileSync(join(sessions, `rollout-2026-10-28T10-00-00-${STALE}.jsonl`), line({ type: "session_meta", payload: { cwd: join(tmpBase, "sr-design-codex-AbCdEf") } }));
    writeFileSync(join(mkdirP(join(codexHome, "generated_images", STALE)), "old.png"), colourPng(600, 600));
    writeFileSync(join(sessions, `rollout-2026-10-28T11-00-00-${OTHER}.jsonl`), line({ type: "session_meta", payload: { cwd: "/home/someone/project" } }));
    writeFileSync(join(mkdirP(join(codexHome, "generated_images", OTHER)), "keep.png"), colourPng(600, 600));
    await once(({ cwd }) => (leave(cwd, [], { "ig_1.png": colourPng(1024, 1024) }), ok(thread)));
    expect(leftovers().images).toEqual([OTHER]);
    expect(leftovers().logs).toEqual([join("2026", "10", "28", `rollout-2026-10-28T11-00-00-${OTHER}.jsonl`)]);
  });

  it("a .env found after Codex ran: the result is discarded with its own code (Codex did run: never 'not called')", async () => {
    const r = await once(({ cwd }) => {
      leave(cwd, [], { "ig_1.png": colourPng(1024, 1024) });
      throw new SandboxError("CODEX_DOTENV_PRESENT", true);
    });
    expect(r).toMatchObject({ png: null, stopCode: "CODEX_RESULT_DISCARDED_DOTENV" });
    expect(leftovers().work).toEqual([]);
  });

  it("a hard stop can clean up a running call (its image dir and logs) before the CLI exits", async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const call = once(async ({ cwd }) => {
      leave(cwd, [], { "ig_1.png": colourPng(1024, 1024) });
      started();
      await new Promise<void>((r) => (release = r));
      return ok(thread);
    });
    await running;
    // the thread is not known yet (no stdout): the call's own work dir and new image dirs are what it can find
    await cleanupActiveImageCalls();
    expect(leftovers()).toEqual({ images: [], logs: [], work: [] });
    release();
    await call;
  });

  it("maps outcomes to fixed stop codes", () => {
    expect(imageStopCode("TOOL_FAILED_USAGE_LIMIT")).toBe("CODEX_QUOTA");
    expect(imageStopCode("TOOL_FAILED_POLICY")).toBe("CODEX_IMAGE_TOOL_FAILED");
    expect(imageStopCode("TOOL_NOT_CALLED")).toBe("CODEX_NO_IMAGE");
  });
});

function mkdirP(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}
