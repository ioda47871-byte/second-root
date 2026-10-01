/**
 * Codex CLI as an art director (DEV-028). Same authentication and safety
 * design as the Kaii Dokuhon image worker (curiosity-media
 * `packages/automation/src/codex-image.ts`, D-139 / D-141 / D-143):
 *
 * - **No API key.** Only a Codex CLI signed in with a ChatGPT account.
 *   `codex login status` is checked first; an API-key sign-in is refused.
 *   `OPENAI_API_KEY` / `CODEX_API_KEY` / `OPENAI_BASE_URL` never reach the child.
 * - Codex never runs directly: every process (the sign-in check too) runs
 *   inside the OS sandbox of sandbox.ts (bubblewrap: the user's files, the
 *   Instagram browser profile and the results are not visible at all; a probe
 *   checks that before each call, fail closed). Reference images reach it only
 *   as copies in <work dir>/inputs.
 * - Inside, Codex runs with `--sandbox read-only` in an empty temporary directory
 *   that is deleted afterwards. It is asked for a JSON answer only; the answer
 *   shape is fixed with `--output-schema` and checked again with zod by the
 *   caller.
 * - Failures carry a code and a fixed short message. Codex's own words and
 *   stderr are never copied into messages or logs: the sandbox can still read
 *   files, so text steered by a prompt (or by words inside a screenshot) could
 *   otherwise leak what it read.
 * - Quota / rate limits are detected from stderr and the CLI's own error
 *   events only, never from the model's answer.
 * - The CLI keeps a session log per call ($CODEX_HOME/sessions/.../
 *   rollout-*-<thread id>.jsonl) that can hold the attached images. After
 *   each call that log is deleted, so reference screenshots do not outlive
 *   the run.
 */
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundedResult } from "./bounded-process";
import { SandboxError, stageInputs, type CodexSandbox } from "./sandbox";

export const CODEX_BLOCKED_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"] as const;

export type CodexFailureCode =
  | "CODEX_NOT_INSTALLED"
  | "CODEX_NOT_SIGNED_IN"
  | "CODEX_API_KEY_AUTH"
  | "CODEX_EXEC_FAILED"
  | "CODEX_TIMEOUT"
  | "CODEX_QUOTA"
  | "CODEX_NO_JSON"
  | "CODEX_SANDBOX_UNAVAILABLE"
  | "CODEX_SANDBOX_LEAK"
  | "CODEX_SANDBOX_CONFIG"
  | "CODEX_INPUT_REJECTED"
  | "CODEX_ANSWER_REJECTED";

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
  return (
    code === "CODEX_NOT_INSTALLED" ||
    code === "CODEX_NOT_SIGNED_IN" ||
    code === "CODEX_API_KEY_AUTH" ||
    code === "CODEX_QUOTA" ||
    code === "CODEX_SANDBOX_UNAVAILABLE" ||
    code === "CODEX_SANDBOX_LEAK" ||
    code === "CODEX_SANDBOX_CONFIG"
  );
}

const SANDBOX_MESSAGES: Record<SandboxError["code"], string> = {
  CODEX_NOT_INSTALLED: "Codex CLI could not be started.",
  CODEX_SANDBOX_UNAVAILABLE: "The Codex sandbox (bubblewrap) is not available; Codex was not started.",
  CODEX_SANDBOX_LEAK: "The Codex sandbox would show protected files; Codex was not started.",
  CODEX_SANDBOX_CONFIG: "The Codex sandbox could not be set up safely; Codex was not started.",
  CODEX_INPUT_REJECTED: "A reference image was not a regular PNG file; Codex was not started.",
};

/** A sandbox failure as a CodexError (fixed message). */
export function fromSandboxError(error: unknown): unknown {
  return error instanceof SandboxError ? new CodexError(error.code, SANDBOX_MESSAGES[error.code]) : error;
}

/** The environment without any API-key route. */
export function codexEnvironment(base: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...base } as NodeJS.ProcessEnv;
  for (const name of CODEX_BLOCKED_ENV) delete env[name];
  return env;
}

export async function assertChatGptSignIn(options: { sandbox: CodexSandbox }): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "sr-design-codex-"));
  let result: BoundedResult;
  try {
    result = await options.sandbox.run(["login", "status"], { workDir, timeoutMs: 30_000 });
  } catch (error) {
    if (error instanceof SandboxError) throw fromSandboxError(error);
    throw new CodexError("CODEX_SANDBOX_UNAVAILABLE", SANDBOX_MESSAGES.CODEX_SANDBOX_UNAVAILABLE);
  } finally {
    await rm(workDir, { recursive: true, force: true });
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

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deletes the CLI's session log(s) of one thread. Returns how many files were removed. */
export async function removeCodexSession(threadId: string, env: Record<string, string | undefined>): Promise<number> {
  if (!THREAD_ID.test(threadId)) return 0;
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  let removed = 0;
  for (const dir of ["sessions", "archived_sessions"]) {
    const root = join(home, dir);
    let names: string[];
    try {
      names = await readdir(root, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      const base = name.split("/").pop() ?? "";
      if (!base.startsWith("rollout-") || !base.endsWith(`${threadId}.jsonl`)) continue;
      const path = join(root, name);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** A path segment naming one of the design agent's temp directories (codex.ts and the worker's temp root). */
const DESIGN_DIR = /^sr-design-(codex|worker)-[A-Za-z0-9]{6}$/;

/** Whether a session's working directory was a design-agent temp directory. */
export function isDesignAgentCwd(cwd: unknown): boolean {
  return typeof cwd === "string" && cwd.startsWith("/") && cwd.split("/").some((segment) => DESIGN_DIR.test(segment));
}

/**
 * Deletes session logs of design-agent Codex calls that were cut off before
 * removeCodexSession ran (a signal, a crash). A log belongs to the design
 * agent when the working directory in its first line (the session metadata,
 * parsed as JSON; only `cwd` / `payload.cwd` is looked at) lies in one of the
 * design agent's temp directories. Other Codex sessions of the user are not
 * touched.
 */
export async function removeStaleCodexSessions(env: Record<string, string | undefined>): Promise<number> {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  let removed = 0;
  for (const dir of ["sessions", "archived_sessions"]) {
    const root = join(home, dir);
    let names: string[];
    try {
      names = await readdir(root, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      const base = name.split("/").pop() ?? "";
      if (!base.startsWith("rollout-") || !base.endsWith(".jsonl")) continue;
      const path = join(root, name);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile()) continue;
      const head = await readFile(path, "utf8").then((t) => t.slice(0, 256 * 1024), () => "");
      type Meta = { cwd?: unknown; payload?: { cwd?: unknown } } | null;
      let meta: Meta;
      try {
        meta = JSON.parse(head.split("\n")[0] ?? "") as Meta;
      } catch {
        continue;
      }
      if (!isDesignAgentCwd(meta?.payload?.cwd ?? meta?.cwd)) continue;
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** The answer file Codex wrote in its work dir: not a link, a regular file of ours, at most 1 MiB. */
async function readAnswerFile(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024 || info.uid !== process.getuid?.()) return undefined;
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Token-like strings are removed from every string in an answer before it is
 * stored (rationale, review notes ...): words in a screenshot could steer the
 * model to copy its own sign-in token (readable in CODEX_HOME) into the JSON.
 */
const TOKEN_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]*|\b(?:sk|rt|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{8,}|[A-Za-z0-9+/_-]{40,}={0,2}/g;
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TOKEN_LIKE, "[removed]");
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(v)]));
  return value;
}

/** The long secret strings of Codex's sign-in (auth.json), letters and digits only. Read on the host, never sent anywhere. */
async function signInTokens(codexHome: string): Promise<string[]> {
  const text = await readAnswerFile(join(codexHome, "auth.json")).catch(() => undefined);
  if (!text) return [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const t = v.replace(/[^A-Za-z0-9]/g, "");
      if (t.length >= 20) out.push(t);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    /* not JSON: nothing to compare */
  }
  return out;
}

const WINDOW = 12;
/** Whether the answer holds any 12-character piece of a token (ignoring separators), forwards or reversed. */
export function leaksTokens(answer: string, tokens: readonly string[]): boolean {
  const flat = answer.replace(/[^A-Za-z0-9]/g, "");
  const reversed = [...flat].reverse().join("");
  for (const token of tokens) {
    for (let i = 0; i + WINDOW <= token.length; i += 4) {
      const piece = token.slice(i, i + WINDOW);
      if (flat.includes(piece) || reversed.includes(piece)) return true;
    }
  }
  return false;
}

export interface CodexJsonOptions {
  /** The OS sandbox every Codex process runs in (prepareCodexSandbox). */
  sandbox: CodexSandbox;
  /** The whole request. Sent on stdin, never as an argument (so it stays out of `ps`). */
  prompt: string;
  /** JSON Schema for the final answer (`--output-schema`). */
  schema: object;
  /** Absolute paths of privacy-processed reference PNGs; Codex sees copies only. */
  images?: readonly string[];
  timeoutMs?: number;
}

/**
 * Asks Codex for one JSON answer and returns it parsed (not yet validated:
 * the caller checks it against its zod schema).
 */
export async function runCodexJson(options: CodexJsonOptions): Promise<unknown> {
  const { sandbox } = options;
  const cwd = await mkdtemp(join(tmpdir(), "sr-design-codex-"));
  try {
    await assertChatGptSignIn({ sandbox });
    const images = await stageInputs(cwd, options.images ?? []).catch((error: unknown) => {
      throw fromSandboxError(error);
    });
    const schemaPath = join(cwd, "schema.json");
    const answerPath = join(cwd, "answer.json");
    await writeFile(schemaPath, JSON.stringify(options.schema));
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      // The built-in provider only (a config.toml provider could use an API key).
      "-c",
      'model_provider="openai"',
      "--cd",
      cwd,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      answerPath,
      ...images.map((path) => `--image=${path}`),
      "-",
    ];
    let result: BoundedResult;
    try {
      result = await sandbox.run(args, { workDir: cwd, input: options.prompt, timeoutMs: options.timeoutMs ?? 900_000 });
    } catch (error) {
      if (error instanceof SandboxError) throw fromSandboxError(error);
      throw new CodexError("CODEX_SANDBOX_UNAVAILABLE", SANDBOX_MESSAGES.CODEX_SANDBOX_UNAVAILABLE);
    }
    const threadId = readCodexEvents(result.stdout).threadId;
    if (threadId !== undefined) await removeCodexSession(threadId, sandbox.env).catch(() => 0);
    if (result.timedOut) throw new CodexError("CODEX_TIMEOUT", "Codex did not finish in time.");
    if (result.code !== 0 && codexLooksRateLimited(result.stdout, result.stderr)) {
      throw new CodexError("CODEX_QUOTA", "Codex usage limit reached or the service is busy.");
    }
    if (result.code !== 0) throw new CodexError("CODEX_EXEC_FAILED", `Codex failed (exit ${String(result.code)}).`);
    const answer = (await readAnswerFile(answerPath)) ?? readCodexEvents(result.stdout).lastMessage;
    if (answer === undefined || answer.trim() === "") throw new CodexError("CODEX_NO_JSON", "Codex returned no answer.");
    // An answer that carries any piece of Codex's own sign-in tokens (forwards or backwards, split or not) is thrown away.
    if (leaksTokens(answer, await signInTokens(sandbox.env.CODEX_HOME ?? join(sandbox.env.HOME ?? homedir(), ".codex")))) {
      throw new CodexError("CODEX_ANSWER_REJECTED", "Codex's answer was rejected.");
    }
    return redactSecrets(extractJsonObject(answer));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
