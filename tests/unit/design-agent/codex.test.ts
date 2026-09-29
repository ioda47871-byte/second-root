import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { codexEnvironment, CodexError, runCodexJson } from "@/lib/design-agent/codex";
import { designProfileJsonSchema } from "@/lib/design-agent/profile";
import { AMERICAN_EDITORIAL } from "./fixtures";

// The Codex CLI wrapper against a fake `codex` with the real entry points
// (tests/support/fake-codex.mjs). No sign-in, no network.

const FAKE = join(process.cwd(), "tests/support/fake-codex.mjs");
let dir: string;

async function setup(steps: unknown[], login = "chatgpt") {
  await writeFile(join(dir, "steps.json"), JSON.stringify(steps));
  return {
    ...process.env,
    FAKE_CODEX_LOGIN: login,
    FAKE_CODEX_STEPS: join(dir, "steps.json"),
    FAKE_CODEX_STATE: join(dir, "state"),
    FAKE_CODEX_RECORD: join(dir, "record.jsonl"),
    OPENAI_API_KEY: "sk-should-never-reach-codex",
    CODEX_API_KEY: "never",
    OPENAI_BASE_URL: "https://example.invalid",
  };
}

async function calls(): Promise<Array<{ args: string[]; apiKeyVars: string[]; stdinLength?: number; cwd: string }>> {
  const text = await readFile(join(dir, "record.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof CodexError ? e.code : String(e)));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fake-codex-test-"));
});

describe("runCodexJson", () => {
  it("returns the answer, read-only sandbox, schema, images, prompt on stdin", async () => {
    const env = await setup([{ answer: AMERICAN_EDITORIAL }]);
    const answer = await runCodexJson({ prompt: "Verified facts: x", schema: designProfileJsonSchema(), images: ["/tmp/a.png", "/tmp/b.png"], codexBin: FAKE, env });
    expect(answer).toEqual(AMERICAN_EDITORIAL);
    const [login, exec] = await calls();
    expect(login.args).toEqual(["login", "status"]);
    expect(exec.args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json"]);
    expect(exec.args).toContain("--output-schema");
    expect(exec.args.join(" ")).toContain('-c model_provider="openai"');
    expect(exec.args.filter((a) => a.startsWith("--image="))).toEqual(["--image=/tmp/a.png", "--image=/tmp/b.png"]);
    expect(exec.args.at(-1)).toBe("-");
    expect(exec.args.join(" ")).not.toContain("Verified facts");
    expect(exec.stdinLength).toBeGreaterThan(0);
  });

  it("never passes API-key variables to Codex", async () => {
    const env = await setup([{ answer: {} }]);
    await runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env });
    for (const call of await calls()) expect(call.apiKeyVars).toEqual([]);
    expect(codexEnvironment({ OPENAI_API_KEY: "x", CODEX_API_KEY: "y", OPENAI_BASE_URL: "z", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  it("refuses an API-key sign-in and a missing sign-in before running exec", async () => {
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env: await setup([{ answer: {} }], "apikey") }))).toBe("CODEX_API_KEY_AUTH");
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env: await setup([{ answer: {} }], "none") }))).toBe("CODEX_NOT_SIGNED_IN");
    expect((await calls()).some((c) => c.args[0] === "exec")).toBe(false);
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, codexBin: join(dir, "no-such-codex"), env: process.env }))).toBe("CODEX_NOT_INSTALLED");
  });

  it("reads a fenced answer from the event stream when no file was written", async () => {
    const env = await setup([{ text: 'Here:\n```json\n{"a":1}\n```', noFile: true }]);
    expect(await runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env })).toEqual({ a: 1 });
  });

  it("reports failures by code only, never with Codex's words", async () => {
    const env = await setup([{ exit: 1, stderr: "secret-looking stderr text" }, { exit: 1, stderr: "You've hit your usage limit" }, { text: "no json here" }]);
    const failed = await runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env }).catch((e: CodexError) => e);
    expect(failed).toBeInstanceOf(CodexError);
    expect((failed as CodexError).code).toBe("CODEX_EXEC_FAILED");
    expect((failed as CodexError).message).not.toContain("secret-looking");
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env }))).toBe("CODEX_QUOTA");
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env }))).toBe("CODEX_NO_JSON");
  });

  it("times out and removes its temporary directory", async () => {
    const env = await setup([{ sleepMs: 20_000, answer: {} }]);
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, codexBin: FAKE, env, timeoutMs: 800 }))).toBe("CODEX_TIMEOUT");
    const exec = (await calls()).find((c) => c.args[0] === "exec");
    expect(await readdir(exec!.cwd).catch(() => "gone")).toBe("gone");
  }, 20_000);
});
