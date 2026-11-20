/**
 * Issue #302: ONE headless, tool-less call of the owner's signed-in `claude` CLI that looks at image bytes the caller
 * already verified. No Remote Control, no API key, no SDK, no network code of our own: the CLI is an external binary.
 *
 * Copied from curiosity-media `packages/automation/src/entry-image-claude.ts` (main @ 2e7a673b, the Kaii Dokuhon image
 * worker: `CLAUDE_BLOCKED_ENV`, `ClaudeCallError`, `assertClaudeSignedIn`, `CLAUDE_AUTH_FAILURE_SIGN`, the quota pattern,
 * `runClaudeWithoutTools`, `extractJsonObject`, `asMaterial`), with these changes only:
 *   - the environment starts from Second Root's allowlist (worker/env.ts childEnvironment) and then drops
 *     CLAUDE_BLOCKED_ENV and every ANTHROPIC_* / CLAUDE_CODE_OAUTH_* name (defence in depth; no token mode here);
 *   - Second Root's runBounded (own process group, timeout, AbortSignal → SIGTERM then SIGKILL);
 *   - each image is preceded by a short text label (which preview it is), and the caller passes several images;
 *   - the reported model is read from the stream's `system/init` event (recorded, never chosen: no `--model` flag);
 *   - an aborted run is CLAUDE_ABORTED.
 *
 * The flags (CLAUDE_PRINT_ARGS): `-p` with stream-json in and out, `--tools ""` (no Read, no Bash, no web: text hidden
 * in an image or the material has nowhere to go), `--strict-mcp-config` without any `--mcp-config` (no MCP server),
 * `--no-session-persistence` (no transcript), `--setting-sources ""` (no user / project / local settings). The caller
 * runs it with cwd = an empty private directory outside the repository, so no CLAUDE.md or skill is picked up.
 *
 * Failures are classified from stderr and the CLI's own `is_error` text only, never from the model's answer, and are
 * reported as fixed codes: no answer text and no stderr ever goes into an error message.
 */
import { runBounded, type BoundedResult } from "../bounded-process";
import { childEnvironment } from "../worker/env";

/** Never passed to the child, whatever the parent had (curiosity-media's list). */
export const CLAUDE_BLOCKED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"] as const;
const BLOCKED_PREFIX = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_)/;

/** The exact arguments of one call (no model flag: the account's default model answers). */
export const CLAUDE_PRINT_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""] as const;

export type ClaudeFailureCode = "CLAUDE_NOT_INSTALLED" | "CLAUDE_NOT_SIGNED_IN" | "CLAUDE_API_KEY_AUTH" | "CLAUDE_AUTH_METHOD_REFUSED" | "CLAUDE_EXEC_FAILED" | "CLAUDE_TIMEOUT" | "CLAUDE_NO_JSON" | "CLAUDE_QUOTA" | "CLAUDE_ABORTED";

export class ClaudeCallError extends Error {
  constructor(readonly code: ClaudeFailureCode) {
    super(code);
    this.name = "ClaudeCallError";
  }
}

/** The allowlisted environment, minus every Anthropic / Claude credential name. */
export function claudeEnvironment(base: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = childEnvironment(base);
  for (const name of CLAUDE_BLOCKED_ENV) delete env[name];
  for (const name of Object.keys(env)) if (BLOCKED_PREFIX.test(name)) delete env[name];
  return env;
}

type RunOptions = { env: NodeJS.ProcessEnv; cwd: string; input?: string; timeoutMs: number; signal?: AbortSignal };
async function run(bin: string, args: readonly string[], o: RunOptions): Promise<BoundedResult> {
  try {
    return await runBounded(bin, args, { env: o.env, cwd: o.cwd, input: o.input ?? "", timeoutMs: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
  } catch {
    throw new ClaudeCallError("CLAUDE_NOT_INSTALLED");
  }
}

/**
 * The only `authMethod` accepted (fail closed, PR #311 review L3): the claude.ai subscription login, the value
 * curiosity-media's worker sees for a subscription sign-in. Any other or unknown method (api_key_helper, oauth_token,
 * third_party, none, ...) is CLAUDE_AUTH_METHOD_REFUSED; an API-key method is CLAUDE_API_KEY_AUTH.
 *
 * PR #311 re-review M-a: the CLI also reports a Console login (a managed API key, billed per token) as "claude.ai",
 * adding `apiKeySource`. Any `apiKeySource` is therefore an API key: CLAUDE_API_KEY_AUTH.
 */
export const CLAUDE_ALLOWED_AUTH_METHODS = ["claude.ai"] as const;
/**
 * Plain `auth status`, as curiosity-media runs it (PR #311 re-review H1: the subcommand accepts only --json / --text and
 * rejects --setting-sources). Same scrubbed environment and private cwd as the call; a settings file that injects a key
 * (apiKeyHelper) shows up here as api_key_helper and is refused.
 */
export const CLAUDE_AUTH_STATUS_ARGS = ["auth", "status"] as const;

/**
 * Signed in with the subscription (`claude auth status`), never with an API key. A pass does not prove the login still
 * works (an expired login may still read loggedIn: true); the first call then fails with CLAUDE_NOT_SIGNED_IN.
 */
export async function assertClaudeSignedIn(o: { claudeBin: string; env: NodeJS.ProcessEnv; cwd: string; signal?: AbortSignal }): Promise<void> {
  const r = await run(o.claudeBin, CLAUDE_AUTH_STATUS_ARGS, { env: o.env, cwd: o.cwd, timeoutMs: 30_000, ...(o.signal ? { signal: o.signal } : {}) });
  if (r.aborted) throw new ClaudeCallError("CLAUDE_ABORTED");
  let status: { loggedIn?: unknown; authMethod?: unknown; apiKeySource?: unknown } = {};
  try {
    status = JSON.parse(r.stdout) as typeof status;
  } catch {
    /* unreadable = the login cannot be confirmed */
  }
  if (!status || typeof status !== "object") status = {};
  if (typeof status.authMethod === "string" && /api[_-]?key/i.test(status.authMethod)) throw new ClaudeCallError("CLAUDE_API_KEY_AUTH");
  if (r.code !== 0 || status.loggedIn !== true) throw new ClaudeCallError("CLAUDE_NOT_SIGNED_IN");
  if (status.apiKeySource !== undefined && status.apiKeySource !== null) throw new ClaudeCallError("CLAUDE_API_KEY_AUTH");
  if (!(CLAUDE_ALLOWED_AUTH_METHODS as readonly unknown[]).includes(status.authMethod)) throw new ClaudeCallError("CLAUDE_AUTH_METHOD_REFUSED");
}

/** The CLI's own wording for a login that has expired or cannot be confirmed (curiosity-media DEV-139, review M3). */
export const CLAUDE_AUTH_FAILURE_SIGN =
  /please run \/login|not logged in|invalid api key|oauth token (?:has )?(?:expired|been revoked)|oauth token revoked|token (?:has been|was) revoked|api error: 401\b|"type"\s*:\s*"authentication_error"/i;
export const CLAUDE_QUOTA_SIGN = /usage limit|rate limit|quota|too many requests|overloaded|\b429\b/i;

export type ClaudeImage = { label: string; bytes: Buffer; mediaType: "image/png" | "image/jpeg" };
export type ClaudeAnswer = { answer: string; model: string | null; cliVersion: string | null };

/** The one stream-json user message: for each image a text label then the image, then the request text. */
export function buildUserMessage(images: readonly ClaudeImage[], text: string): string {
  const content: unknown[] = [];
  for (const image of images) {
    content.push({ type: "text", text: `[image] ${image.label}` });
    content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.bytes.toString("base64") } });
  }
  content.push({ type: "text", text });
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** Asks once with no tools and returns the last answer's text (plus the model the CLI reported, if any). */
export async function runClaudeWithoutTools(o: { claudeBin: string; env: NodeJS.ProcessEnv; cwd: string; images: readonly ClaudeImage[]; text: string; timeoutMs: number; signal?: AbortSignal }): Promise<ClaudeAnswer> {
  const r = await run(o.claudeBin, CLAUDE_PRINT_ARGS, { env: o.env, cwd: o.cwd, input: buildUserMessage(o.images, o.text), timeoutMs: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
  if (r.aborted) throw new ClaudeCallError("CLAUDE_ABORTED");
  if (r.timedOut) throw new ClaudeCallError("CLAUDE_TIMEOUT");
  let answer: string | undefined;
  let isError = false;
  let model: string | null = null;
  let cliVersion: string | null = null;
  for (const line of r.stdout.split("\n")) {
    let event: { type?: unknown; subtype?: unknown; result?: unknown; is_error?: unknown; model?: unknown; claude_code_version?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string" && /^[A-Za-z0-9._:\[\]-]{1,80}$/.test(event.model)) model = event.model;
      if (typeof event.claude_code_version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(event.claude_code_version)) cliVersion = event.claude_code_version;
    }
    if (event.type === "result") {
      answer = typeof event.result === "string" ? event.result : undefined;
      isError = event.is_error === true;
    }
  }
  const failed = r.code !== 0 || isError;
  const cliText = `${r.stderr}\n${isError ? (answer ?? "") : ""}`;
  if (failed && CLAUDE_AUTH_FAILURE_SIGN.test(cliText)) throw new ClaudeCallError("CLAUDE_NOT_SIGNED_IN");
  if (failed && CLAUDE_QUOTA_SIGN.test(cliText)) throw new ClaudeCallError("CLAUDE_QUOTA");
  if (failed || answer === undefined) throw new ClaudeCallError("CLAUDE_EXEC_FAILED");
  return { answer, model, cliVersion };
}

/** One JSON object out of an answer (a ```json fence is preferred). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ClaudeCallError("CLAUDE_NO_JSON");
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    throw new ClaudeCallError("CLAUDE_NO_JSON");
  }
}

/** Text placed into a request as material: `<` and `>` become full-width, so material cannot close its tag. */
export const asMaterial = (value: string): string => value.replace(/</g, "＜").replace(/>/g, "＞");
