import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { codexEnvironment, CodexError, runCodexJson } from "@/lib/design-agent/codex";
import { designProfileJsonSchema } from "@/lib/design-agent/profile";
import { passthroughSandbox } from "../../support/passthrough-sandbox";
import { PNG } from "./worker-support";
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
    await writeFile(join(dir, "a.png"), PNG);
    await writeFile(join(dir, "b.png"), PNG);
    const answer = await runCodexJson({ prompt: "Verified facts: x", schema: designProfileJsonSchema(), images: [join(dir, "a.png"), join(dir, "b.png")], sandbox: passthroughSandbox(FAKE, env) });
    expect(answer).toEqual(AMERICAN_EDITORIAL);
    const [login, exec] = await calls();
    expect(login.args).toEqual(["login", "status"]);
    expect(exec.args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json"]);
    expect(exec.args).toContain("--output-schema");
    expect(exec.args.join(" ")).toContain('-c model_provider="openai"');
    // Codex is given copies inside its own work directory, never the caller's paths
    expect(exec.args.filter((a) => a.startsWith("--image="))).toEqual([`--image=${join(exec.cwd, "inputs", "ref-1.png")}`, `--image=${join(exec.cwd, "inputs", "ref-2.png")}`]);
    expect(exec.args.at(-1)).toBe("-");
    expect(exec.args.join(" ")).not.toContain("Verified facts");
    expect(exec.stdinLength).toBeGreaterThan(0);
  });

  it("never passes API-key variables to Codex", async () => {
    const env = await setup([{ answer: {} }]);
    await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env) });
    for (const call of await calls()) expect(call.apiKeyVars).toEqual([]);
    expect(codexEnvironment({ OPENAI_API_KEY: "x", CODEX_API_KEY: "y", OPENAI_BASE_URL: "z", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  it("refuses an API-key sign-in and a missing sign-in before running exec", async () => {
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, await setup([{ answer: {} }], "apikey")) }))).toBe("CODEX_API_KEY_AUTH");
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, await setup([{ answer: {} }], "none")) }))).toBe("CODEX_NOT_SIGNED_IN");
    expect((await calls()).some((c) => c.args[0] === "exec")).toBe(false);
    // a sandbox that cannot start anything: no Codex, a fixed code
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(join(dir, "no-such-codex"), process.env) }))).toBe("CODEX_SANDBOX_UNAVAILABLE");
  });

  it("reads a fenced answer from the event stream when no file was written", async () => {
    const env = await setup([{ text: 'Here:\n```json\n{"a":1}\n```', noFile: true }]);
    expect(await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env) })).toEqual({ a: 1 });
  });

  it("reports failures by code only, never with Codex's words", async () => {
    const env = await setup([{ exit: 1, stderr: "secret-looking stderr text" }, { exit: 1, stderr: "You've hit your usage limit" }, { text: "no json here" }]);
    const failed = await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env) }).catch((e: CodexError) => e);
    expect(failed).toBeInstanceOf(CodexError);
    expect((failed as CodexError).code).toBe("CODEX_EXEC_FAILED");
    expect((failed as CodexError).message).not.toContain("secret-looking");
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env) }))).toBe("CODEX_QUOTA");
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env) }))).toBe("CODEX_NO_JSON");
  });

  it("times out and removes its temporary directory", async () => {
    const env = await setup([{ sleepMs: 20_000, answer: {} }]);
    expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env), timeoutMs: 800 }))).toBe("CODEX_TIMEOUT");
    const exec = (await calls()).find((c) => c.args[0] === "exec");
    expect(await readdir(exec!.cwd).catch(() => "gone")).toBe("gone");
  }, 20_000);
});

describe("Codex's own sign-in token never comes back in an answer", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.QWxhZGRpbjpvcGVuIHNlc2FtZQ9xK3mZpQ7vR2sT8uW1yB4cD6eF0gH";
  it("rejects answers that carry a piece of it (plain, split, with separators, reversed); keeps normal answers", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-home-"));
    await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: TOKEN, refresh_token: "rt_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c" }, last_refresh: "2026-09-30T12:34:56.123456789Z" }));
    const flat = TOKEN.replace(/[^A-Za-z0-9]/g, "");
    const leaks = [
      { rationale: [TOKEN] },
      { rationale: [flat.slice(10, 40), flat.slice(40, 70)] },
      { rationale: [flat.slice(20, 50).split("").join("-")] },
      { rationale: [[...flat.slice(30, 60)].reverse().join("")] },
      { rationale: [flat.slice(12, 44).toUpperCase()] }, // case changed
    ];
    for (const answer of leaks) {
      const env = { ...(await setup([{ answer }])), CODEX_HOME: home };
      expect(await codeOf(runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env) })), JSON.stringify(answer)).toBe("CODEX_ANSWER_REJECTED");
    }
    const env = { ...(await setup([{ answer: AMERICAN_EDITORIAL }])), CODEX_HOME: home };
    expect(await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env) })).toEqual(AMERICAN_EDITORIAL);
    // the sign-in time is not a secret: its digits in an answer are fine
    const digits = { ...AMERICAN_EDITORIAL, rationale: ["since 20260930 123456123456789"] };
    const env2 = { ...(await setup([{ answer: digits }])), CODEX_HOME: home };
    expect(await runCodexJson({ prompt: "p", schema: {}, sandbox: passthroughSandbox(FAKE, env2) })).toEqual(digits);
  });
});
