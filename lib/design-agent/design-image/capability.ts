/**
 * Whether Codex's built-in image tool could and did run (DEV-078), from local
 * facts only. Never a model call, never network, never any text kept.
 *
 * Why (HUMAN-019 / HUMAN-020 stopped with CODEX_NO_IMAGE, exit 0, a short text
 * answer): in Codex CLI 0.163.0 (openai/codex rust-v0.163.0) the image tool is
 * the extension function tool `image_gen.imagegen` (ext/image-generation), and
 * `codex exec --json` drops its items (exec/src/event_processor_with_jsonl_output.rs
 * maps unknown thread items to `None`), so the JSON stream can never show an
 * image call. A failed image call (`image generation failed: …`, including the
 * separate `image_gen` usage limit, ImageGenerationFailure::UsageLimitExceeded)
 * is returned to the MODEL as the tool's output, not as an error event: the
 * turn still completes with exit 0 and the model answers in text. The CLI's
 * own session log ($CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl, deleted by
 * the PoC's cleanup) does record the call (response_item function_call
 * name=imagegen namespace=image_gen), its output and, in the default legacy
 * history mode, an event_msg image_generation_end with status and failure.
 *
 * So, before the cleanup removes it, the session log is read IN MEMORY and only
 * fixed facts come out: counts, booleans, a validated CLI version and model
 * slug, and fixed failure codes. Text (the prompt, the answer, a tool output, a
 * path) is matched against fixed patterns in memory and never stored, returned
 * or printed. The same holds for the model's final answer (classifyAnswerText).
 *
 * Preflight (before the one model call): `codex --version` inside the same
 * jail (clap prints the version and exits: no config, no network, no model)
 * and whether $CODEX_HOME/.env exists (Codex loads it into its own
 * environment at start, filtering only CODEX_* keys — arg0/src/lib.rs
 * load_dotenv — so an OPENAI_API_KEY there would bypass the env allowlist; the
 * file is never opened). Whether the tool is offered to the model for a turn
 * (feature flag, ChatGPT plan not Free, provider capability, the model's image
 * input modality: core/src/tools/spec_plan.rs image_generation_available)
 * cannot be read locally without loading Codex's config, which can reach the
 * network (cloud config); that check stays a human, local step (HUMAN-021).
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

/** `codex --version` prints `codex-cli 0.163.0` (clap: the binary name and the version). */
const VERSION_LINE = /^codex(?:-cli)?\s+(\d{1,3}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4}){1,3})?)\s*$/m;
const VERSION = /^\d{1,3}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4}){1,3})?$/;
/** A model slug as Codex names OpenAI models (gpt-…, o3…, codex-…); anything else is recorded as "other". */
const MODEL = /^(?:gpt|o[0-9]|codex)[A-Za-z0-9._-]{0,48}$/;

/** The CLI version from `codex --version`'s stdout, or null when it is not in the expected shape. */
export function parseCodexVersion(stdout: string): string | null {
  return VERSION_LINE.exec(stdout.slice(0, 4096))?.[1] ?? null;
}

/** Whether $CODEX_HOME/.env exists in any form (never opened, never followed). */
export async function codexDotenvPresent(codexHome: string): Promise<boolean> {
  const info = await lstat(join(codexHome, ".env")).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" || error.code === "ENOTDIR" ? null : error));
  // unreadable (EACCES …): treated as present, fail closed
  return info !== null;
}

/** Fixed codes for why the image tool failed (from the CLI's own failure record and the tool's output, never the model's words). */
export const IMAGE_FAILURE_CODES = ["USAGE_LIMIT", "POLICY", "OTHER"] as const;
export type ImageFailureCode = (typeof IMAGE_FAILURE_CODES)[number];

const QUOTA_SIGN = /usage limit|usagelimitexceeded|rate limit|quota|too many requests|\b429\b/i;
const POLICY_SIGN = /content[ _-]?policy|safety|moderation|policy[ _-]?violation|refus/i;

function classifyToolFailure(text: string): ImageFailureCode {
  if (QUOTA_SIGN.test(text)) return "USAGE_LIMIT";
  if (POLICY_SIGN.test(text)) return "POLICY";
  return "OTHER";
}

/** Fixed codes for the model's final text answer (matched in memory; the text itself is never kept). */
export const ANSWER_TEXT_CODES = ["TEXT_NONE", "TEXT_TOOL_UNAVAILABLE", "TEXT_TOOL_ERROR", "TEXT_USAGE_LIMIT", "TEXT_REFUSAL", "TEXT_OTHER"] as const;
export type AnswerTextCode = (typeof ANSWER_TEXT_CODES)[number];

const TEXT_UNAVAILABLE = new RegExp(
  [
    String.raw`(?:image[ _-]?gen\w*|image tool|image generation(?: tool)?|imagegen)[^.\n]{0,40}?(?:not available|unavailable|not enabled|disabled|not found|missing|isn'?t available|not exposed|not provided|not accessible)`,
    String.raw`no (?:built-in |builtin )?image(?:[ _-]?generation)?(?: tool)?`,
    String.raw`(?:don'?t|do not|cannot|can'?t|unable to) (?:have (?:access to )?|access |use |find |call )(?:a |an |the |any )?(?:built-in |builtin )?image`,
    String.raw`(?:cannot|can'?t|unable to) generate (?:an |the )?images?`,
    String.raw`画像生成(?:ツール)?(?:は|が)?(?:使えません|利用できません|使用できません|ありません|見つかりません)`,
  ].join("|"),
  "i",
);
const TEXT_TOOL_ERROR = /image generation failed|\berror\b|failed|エラー/i;
const TEXT_REFUSAL = /\bsorry\b|can'?t (?:help|assist|comply)|cannot (?:help|assist|comply)|unable to (?:help|assist|comply)|\bwon'?t\b|not able to (?:help|comply)|\bpolicy\b|refus|申し訳/i;

/**
 * The model's final answer as one fixed code. Only a code comes out; the
 * caller must not keep or print the text. Informational only: a machine state
 * (quota, sign-in) is never decided from the model's words.
 */
export function classifyAnswerText(text: string | undefined): AnswerTextCode {
  if (text === undefined || text.trim() === "") return "TEXT_NONE";
  const t = text.slice(0, 64 * 1024);
  if (QUOTA_SIGN.test(t)) return "TEXT_USAGE_LIMIT";
  if (TEXT_UNAVAILABLE.test(t)) return "TEXT_TOOL_UNAVAILABLE";
  if (TEXT_TOOL_ERROR.test(t)) return "TEXT_TOOL_ERROR";
  if (TEXT_REFUSAL.test(t)) return "TEXT_REFUSAL";
  return "TEXT_OTHER";
}

/** What the CLI's own session log of this thread says (fixed values only). */
export interface SessionFacts {
  /** A session log of this thread was found (a regular file, not a link). */
  log_found: boolean;
  lines: number;
  unparsed_lines: number;
  /** session_meta.cli_version, when it has the shape of a version. */
  cli_version: string | null;
  /** turn_context.model as a slug, "other" when it does not look like an OpenAI model name, null when absent. */
  model: string | null;
  /** session_meta.model_provider is "openai" (null: not recorded). */
  model_provider_openai: boolean | null;
  /** Calls of the image tool (function_call imagegen / image_gen, or the older image_generation_call item). */
  image_tool_calls: number;
  image_tool_completed: number;
  image_tool_failed: number;
  /** Fixed codes of the failures (CLI failure record / tool output, never the model's answer). */
  image_failure_codes: ImageFailureCode[];
  /** Other tool calls (shell, apply_patch, MCP …), by count only. */
  other_tool_calls: number;
  /** The log was larger than the read cap and was not parsed. */
  truncated: boolean;
}

export const emptySessionFacts = (): SessionFacts => ({
  log_found: false,
  lines: 0,
  unparsed_lines: 0,
  cli_version: null,
  model: null,
  model_provider_openai: null,
  image_tool_calls: 0,
  image_tool_completed: 0,
  image_tool_failed: 0,
  image_failure_codes: [],
  other_tool_calls: 0,
  truncated: false,
});

/** The largest session log read (a successful image adds its base64 a few times). */
export const MAX_SESSION_LOG_BYTES = 64 * 1024 * 1024;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TOOL_NAME = "imagegen";
const IMAGE_TOOL_NAMESPACE = "image_gen";
const OTHER_CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call", "tool_search_call", "web_search_call"]);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Whether a function_call_output carries an image (the tool's success output) — by content item type only. */
function outputHasImage(output: unknown): boolean {
  const items = Array.isArray(output) ? output : Array.isArray(obj(output)?.content) ? (obj(output)!.content as unknown[]) : [];
  return items.some((i) => {
    const t = str(obj(i)?.type);
    return t === "input_image" || t === "image" || t === "output_image";
  });
}
/** The text of a function_call_output, for in-memory failure matching only. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  const items = Array.isArray(output) ? output : Array.isArray(obj(output)?.content) ? (obj(output)!.content as unknown[]) : [];
  return items.map((i) => str(obj(i)?.text) ?? "").join(" ");
}

/** The session log file(s) of a thread under sessions / archived_sessions (regular files only). */
async function sessionLogsOf(codexHome: string, threadId: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of ["sessions", "archived_sessions"]) {
    const root = join(codexHome, dir);
    let names: string[];
    try {
      names = await readdir(root, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      const base = name.split("/").pop() ?? "";
      if (!base.startsWith("rollout-") || !base.endsWith(`${threadId}.jsonl`)) continue;
      const info = await lstat(join(root, name)).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) found.push(join(root, name));
    }
  }
  return found;
}

async function readCapped(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SESSION_LOG_BYTES) return null;
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Reads this thread's session log in memory and returns fixed facts only.
 * Never throws; a missing or unreadable log is `log_found: false`.
 */
export async function readSessionFacts(codexHome: string, threadId: string | undefined): Promise<SessionFacts> {
  const f = emptySessionFacts();
  if (!threadId || !THREAD_ID.test(threadId)) return f;
  const paths = await sessionLogsOf(codexHome, threadId).catch(() => [] as string[]);
  if (paths.length === 0) return f;
  f.log_found = true;
  /** Image calls by call id: their outcome and failure code (the CLI's structured record wins over the tool output's text). */
  type Call = { status: "pending" | "completed" | "failed"; failure?: ImageFailureCode; structured?: boolean };
  const calls = new Map<string, Call>();
  let anonymous = 0;
  const settle = (id: string | undefined, status: "completed" | "failed", failure?: { code: ImageFailureCode; structured: boolean }) => {
    const key = id ?? `anon-${anonymous++}`;
    const now = calls.get(key) ?? { status: "pending" };
    // a recorded failure is never overwritten by a later "completed" of the same call
    if (now.status !== "failed") now.status = status;
    if (status === "failed" && failure && (now.failure === undefined || (failure.structured && !now.structured))) {
      now.failure = failure.code;
      now.structured = failure.structured;
    }
    if (status === "failed" && now.failure === undefined) now.failure = "OTHER";
    calls.set(key, now);
  };
  for (const path of paths) {
    const text = await readCapped(path).catch(() => null);
    if (text === null) {
      f.truncated = true;
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      f.lines += 1;
      let rec: Json | undefined;
      try {
        rec = obj(JSON.parse(line));
      } catch {
        rec = undefined;
      }
      if (!rec) {
        f.unparsed_lines += 1;
        continue;
      }
      const type = str(rec.type);
      const p = obj(rec.payload) ?? {};
      if (type === "session_meta") {
        const v = str(p.cli_version);
        if (v !== undefined && VERSION.test(v)) f.cli_version = v;
        const provider = str(p.model_provider);
        if (provider !== undefined) f.model_provider_openai = provider === "openai";
      } else if (type === "turn_context") {
        const m = str(p.model);
        if (m !== undefined) f.model = MODEL.test(m) ? m : "other";
      } else if (type === "response_item") {
        const t = str(p.type);
        const name = str(p.name);
        const ns = str(p.namespace);
        const isImageCall = t === "function_call" && (name === IMAGE_TOOL_NAME || name === `${IMAGE_TOOL_NAMESPACE}.${IMAGE_TOOL_NAME}`) && (ns === undefined || ns === IMAGE_TOOL_NAMESPACE);
        if (isImageCall) {
          const id = str(p.call_id) ?? `anon-${anonymous++}`;
          if (!calls.has(id)) calls.set(id, { status: "pending" });
        } else if (t === "image_generation_call") {
          // the older hosted image tool: its own item carries the status
          const status = str(p.status);
          settle(str(p.id), status === "completed" ? "completed" : status === "failed" ? "failed" : "completed");
        } else if (t === "function_call_output") {
          const id = str(p.call_id);
          if (id !== undefined && calls.has(id)) {
            if (outputHasImage(p.output)) settle(id, "completed");
            else settle(id, "failed", { code: classifyToolFailure(outputText(p.output)), structured: false });
          }
        } else if (t !== undefined && OTHER_CALL_TYPES.has(t)) {
          f.other_tool_calls += 1;
        }
      } else if (type === "event_msg") {
        const t = str(p.type);
        const item = t === "item_completed" ? obj(p.item) : undefined;
        const record = t === "image_generation_end" ? p : item && /image_?generation/i.test(str(item.type) ?? "") ? item : undefined;
        if (record) {
          const id = str(record.call_id) ?? str(record.id);
          const failure = obj(record.failure);
          const status = str(record.status);
          if (failure) settle(id, "failed", { code: /usage ?limit/i.test(str(failure.type) ?? "") ? "USAGE_LIMIT" : "OTHER", structured: true });
          else if (status === "failed") settle(id, "failed");
          else if (status === "completed") settle(id, "completed");
          else if (id !== undefined && !calls.has(id)) calls.set(id, { status: "pending" });
        }
      }
    }
  }
  const all = [...calls.values()];
  f.image_tool_calls = all.length;
  f.image_tool_completed = all.filter((c) => c.status === "completed").length;
  f.image_tool_failed = all.filter((c) => c.status === "failed").length;
  f.image_failure_codes = IMAGE_FAILURE_CODES.filter((code) => all.some((c) => c.status === "failed" && c.failure === code));
  return f;
}

/** How the image step ended, as one fixed code. */
export const IMAGE_OUTCOMES = ["IMAGE_SAVED", "NO_SESSION_LOG", "TOOL_NOT_CALLED", "TOOL_FAILED_USAGE_LIMIT", "TOOL_FAILED_POLICY", "TOOL_FAILED", "TOOL_CALLED_NO_FILE"] as const;
export type ImageOutcome = (typeof IMAGE_OUTCOMES)[number];

export function deriveImageOutcome(facts: SessionFacts, imageSaved: boolean): ImageOutcome {
  if (imageSaved) return "IMAGE_SAVED";
  if (!facts.log_found || facts.truncated) return "NO_SESSION_LOG";
  if (facts.image_tool_calls === 0) return "TOOL_NOT_CALLED";
  if (facts.image_tool_failed > 0) {
    if (facts.image_failure_codes.includes("USAGE_LIMIT")) return "TOOL_FAILED_USAGE_LIMIT";
    if (facts.image_failure_codes.includes("POLICY")) return "TOOL_FAILED_POLICY";
    return "TOOL_FAILED";
  }
  return "TOOL_CALLED_NO_FILE";
}
