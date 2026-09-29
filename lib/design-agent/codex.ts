/**
 * Codex CLI as an art director (DEV-028). Same authentication and safety
 * design as the Kaii Dokuhon image worker (curiosity-media
 * `packages/automation/src/codex-image.ts`, D-139 / D-141 / D-143):
 *
 * - **No API key.** Only a Codex CLI signed in with a ChatGPT account.
 *   `codex login status` is checked first; an API-key sign-in is refused.
 *   `OPENAI_API_KEY` / `CODEX_API_KEY` / `OPENAI_BASE_URL` never reach the child.
 * - Codex runs with `--sandbox read-only` in an empty temporary directory
 *   that is deleted afterwards. It is asked for a JSON answer only; the answer
 *   shape is fixed with `--output-schema` and checked again with zod by the
 *   caller.
 * - Failures carry a code and a fixed short message. Codex's own words and
 *   stderr are never copied into messages or logs: the sandbox can still read
 *   files, so text steered by a prompt (or by words inside a screenshot) could
 *   otherwise leak what it read.
 * - Quota / rate limits are detected from stderr and the CLI's own error
 *   events only, never from the model's answer.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded, type BoundedResult } from "./bounded-process";

export const CODEX_BLOCKED_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"] as const;

export type CodexFailureCode =
  | "CODEX_NOT_INSTALLED"
  | "CODEX_NOT_SIGNED_IN"
  | "CODEX_API_KEY_AUTH"
  | "CODEX_EXEC_FAILED"
  | "CODEX_TIMEOUT"
  | "CODEX_QUOTA"
  | "CODEX_NO_JSON";

export class CodexError extends Error {
  readonly code: CodexFailureCode;
  constructor(code: CodexFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CodexError";
  }
}

/** Failures that mean "fix the machine" rather than "this answer was bad". */
export function isEnvironmentFailure(code: CodexFailureCode): boolean {
  return code === "CODEX_NOT_INSTALLED" || code === "CODEX_NOT_SIGNED_IN" || code === "CODEX_API_KEY_AUTH" || code === "CODEX_QUOTA";
}

/** The environment without any API-key route. */
export function codexEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of CODEX_BLOCKED_ENV) delete env[name];
  return env;
}

export async function assertChatGptSignIn(options: { codexBin: string; env: NodeJS.ProcessEnv; cwd: string }): Promise<void> {
  let result: BoundedResult;
  try {
    result = await runBounded(options.codexBin, ["login", "status"], { cwd: options.cwd, env: options.env, timeoutMs: 30_000 });
  } catch {
    throw new CodexError("CODEX_NOT_INSTALLED", "Codex CLI could not be started.");
  }
  const status = `${result.stdout}\n${result.stderr}`;
  if (/api key/i.test(status)) {
    throw new CodexError("CODEX_API_KEY_AUTH", "Codex is signed in with an API key. Sign in with ChatGPT instead.");
  }
  if (result.code !== 0 || !/ChatGPT/.test(status)) {
    throw new CodexError("CODEX_NOT_SIGNED_IN", "Codex is not signed in with ChatGPT. Run `codex login --device-auth` as the worker user.");
  }
}

const QUOTA_SIGN = /usage limit|rate limit|quota|too many requests|\b429\b/i;

export function codexLooksRateLimited(stdout: string, stderr: string): boolean {
  if (QUOTA_SIGN.test(stderr)) return true;
  for (const line of stdout.split("\n")) {
    let event: { type?: unknown; message?: unknown; error?: { message?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "error" && event.type !== "turn.failed") continue;
    if (QUOTA_SIGN.test(`${String(event.message ?? "")} ${String(event.error?.message ?? "")}`)) return true;
  }
  return false;
}

/** The thread id and the last agent message from `--json` output. */
export function readCodexEvents(stdout: string): { threadId?: string; lastMessage?: string } {
  let threadId: string | undefined;
  let lastMessage: string | undefined;
  for (const line of stdout.split("\n")) {
    let event: { type?: unknown; thread_id?: unknown; item?: { type?: unknown; text?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
    if (event.item?.type === "agent_message" && typeof event.item.text === "string") lastMessage = event.item.text;
  }
  return { ...(threadId === undefined ? {} : { threadId }), ...(lastMessage === undefined ? {} : { lastMessage }) };
}

/** One JSON object from an answer; a ```json fence is allowed. */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new CodexError("CODEX_NO_JSON", "Codex's answer has no JSON object.");
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    throw new CodexError("CODEX_NO_JSON", "Codex's answer is not valid JSON.");
  }
}

export interface CodexJsonOptions {
  /** The whole request. Sent on stdin, never as an argument (so it stays out of `ps`). */
  prompt: string;
  /** JSON Schema for the final answer (`--output-schema`). */
  schema: object;
  /** Absolute paths of reference images (`--image`). */
  images?: readonly string[];
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Asks Codex for one JSON answer and returns it parsed (not yet validated:
 * the caller checks it against its zod schema).
 */
export async function runCodexJson(options: CodexJsonOptions): Promise<unknown> {
  const codexBin = options.codexBin ?? "codex";
  const env = codexEnvironment(options.env ?? process.env);
  const cwd = await mkdtemp(join(tmpdir(), "sr-design-codex-"));
  try {
    await assertChatGptSignIn({ codexBin, env, cwd });
    const schemaPath = join(cwd, "schema.json");
    const answerPath = join(cwd, "answer.json");
    await writeFile(schemaPath, JSON.stringify(options.schema));
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "--cd",
      cwd,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      answerPath,
      ...(options.images ?? []).map((path) => `--image=${path}`),
      "-",
    ];
    let result: BoundedResult;
    try {
      result = await runBounded(codexBin, args, { cwd, env, input: options.prompt, timeoutMs: options.timeoutMs ?? 900_000 });
    } catch {
      throw new CodexError("CODEX_NOT_INSTALLED", "Codex CLI could not be started.");
    }
    if (result.timedOut) throw new CodexError("CODEX_TIMEOUT", "Codex did not finish in time.");
    if (result.code !== 0 && codexLooksRateLimited(result.stdout, result.stderr)) {
      throw new CodexError("CODEX_QUOTA", "Codex usage limit reached or the service is busy.");
    }
    if (result.code !== 0) throw new CodexError("CODEX_EXEC_FAILED", `Codex failed (exit ${String(result.code)}).`);
    const answer = await readFile(answerPath, "utf8").catch(() => readCodexEvents(result.stdout).lastMessage);
    if (answer === undefined || answer.trim() === "") throw new CodexError("CODEX_NO_JSON", "Codex returned no answer.");
    return extractJsonObject(answer);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
