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
 * the PoC's cleanup) records the call. DEV-080 (checked at rust-v0.159.0, the
 * version HUMAN-021a found on the machine, and rust-v0.163.0: the same here):
 *
 * - `codex exec` writes its rollout in the PAGINATED history mode, not legacy
 *   (exec/src/lib.rs `history_mode: (!config.ephemeral).then_some(Paginated)`;
 *   `session_meta.payload.history_mode`). Paginated drops `image_generation_end`
 *   (rollout/src/policy.rs) and keeps the tool's TurnItem instead:
 *   event_msg `item_completed` with `item.type = "Extension"`, `item.kind =
 *   "image_gen.generation"`, `item.id` = the call id, `status`
 *   (in_progress / completed / failed) and `failure` ({type: usageLimitExceeded …}).
 *   That item is the structured end record; `image_generation_end` is still read
 *   for a legacy-mode log.
 * - A model whose catalog entry says `tool_mode: code_mode_only` (every bundled
 *   model but gpt-5.5 in 0.159.0; the PoC passes no `-m`) never sees imagegen as
 *   a direct tool: it can only call `image_gen__imagegen` from JavaScript inside
 *   the `exec` custom tool (tools/src/code_mode.rs). The log then has
 *   `custom_tool_call` name=exec cells and NO `function_call` imagegen; only the
 *   Extension item shows the call, and a call refused before it started leaves
 *   no item at all. So "no image call seen" in code mode is inconclusive
 *   (TOOL_NOT_SEEN_CODE_MODE), never TOOL_NOT_CALLED.
 * - The tools offered to the model are not in a 0.159.0 log, so "not offered" is
 *   never read from it.

 * So, before the cleanup removes it, the session log is read IN MEMORY and only
 * fixed facts come out: counts, booleans, a validated CLI version and model
 * slug, and fixed failure codes. Text (the prompt, the answer, a tool output, a
 * path) is matched against fixed patterns in memory and never stored, returned
 * or printed. The same holds for the model's final answer (classifyAnswerText).
 *
 * Preflight (before the one model call), in this order: (1) whether
 * $CODEX_HOME/.env exists — lstat only, never opened — BEFORE any Codex
 * process, because every `codex` invocation (`--version` and `login status`
 * too) first runs arg0_dispatch: load_dotenv reads $CODEX_HOME/.env into its
 * own environment, filtering only CODEX_* keys (arg0/src/lib.rs), so an
 * an OpenAI API key or base URL there would bypass the env allowlist; and
 * the arg0 alias setup writes under CODEX_HOME. (2) `codex --version` inside
 * the same jail: after that arg0 setup clap prints the version and exits — no
 * config load, no sign-in, no network, no model. Whether the tool is offered to the model for a turn
 * (feature flag, ChatGPT plan not Free, provider capability, the model's image
 * input modality: core/src/tools/spec_plan.rs image_generation_available)
 * cannot be read locally without loading Codex's config, which can reach the
 * network (cloud config); that check stays a human, local step (HUMAN-021).
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/** `codex --version` prints `codex-cli 0.163.0` (clap: the binary name and the version). */
const VERSION_LINE = /^codex(?:-cli)?\s+(\d{1,3}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4}){1,3})?)\s*$/m;
const VERSION = /^\d{1,3}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4}){1,3})?$/;
/** A model slug as Codex names OpenAI models (gpt-…, o3…, codex-…), at most 32 characters; anything else is recorded as "other". */
const MODEL = /^(?:gpt|o[0-9]|codex)[A-Za-z0-9._-]{0,48}$/;
const MODEL_MAX_CHARS = 32;
const modelSlug = (m: string): string => (m.length <= MODEL_MAX_CHARS && MODEL.test(m) ? m : "other");

/** The CLI version from `codex --version`'s stdout, or null when it is not in the expected shape. */
export function parseCodexVersion(stdout: string): string | null {
  return VERSION_LINE.exec(stdout.slice(0, 4096))?.[1] ?? null;
}

/** Whether $CODEX_HOME/.env exists in any form (never opened, never followed). Shared since DEV-079 (../codex-dotenv.ts). */
export { codexDotenvPresent } from "../codex-dotenv";

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

/** session_meta.history_mode as a fixed value ("other": any other string; null: not recorded). */
export const HISTORY_MODES = ["legacy", "paginated", "other"] as const;
export type HistoryMode = (typeof HISTORY_MODES)[number];

/**
 * How the model sees the image tool, from its slug only (a hint; the catalog is never read at runtime).
 * From the bundled catalog of Codex CLI 0.159.0 (codex-rs/models-manager/models.json at rust-v0.159.0):
 * gpt-5.5 has no `tool_mode` (so the features decide; `code_mode` / `code_mode_only` are off by default,
 * features/src/lib.rs) and every other bundled slug has `"tool_mode": "code_mode_only"`. A model's own
 * tool_mode takes precedence over the features (core/src/tools/mod.rs requested_tool_mode).
 */
export const TOOL_MODES = ["direct", "code_mode_only", "unknown"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];
const DIRECT_MODELS: ReadonlySet<string> = new Set(["gpt-5.5"]);
const CODE_MODE_ONLY_MODELS: ReadonlySet<string> = new Set([
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest",
  "codex-auto-review",
]);
export function toolModeOf(model: string | null): ToolMode {
  if (model === null) return "unknown";
  if (DIRECT_MODELS.has(model)) return "direct";
  if (CODE_MODE_ONLY_MODELS.has(model)) return "code_mode_only";
  return "unknown";
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
  /** session_meta.history_mode (DEV-080: `codex exec` writes "paginated"). */
  history_mode: HistoryMode | null;
  /** toolModeOf(model): whether imagegen is a direct tool for this model or only reachable from a code-mode `exec` cell. */
  tool_mode: ToolMode;
  /** Code-mode cells: response_item custom_tool_call name=exec (not counted in other_tool_calls). */
  code_mode_cells: number;
  /** Some exec cell's input names `image_gen__imagegen` (matched in memory; the input is never kept). */
  code_mode_imagegen_ref: boolean;
  /**
   * Image tool calls: distinct call ids seen in a function_call imagegen (direct mode), an event_msg
   * item_completed Extension item of kind image_gen.generation (paginated history, also from a code-mode cell),
   * an image_generation_end (legacy history) or the older image_generation_call item.
   */
  image_tool_calls: number;
  image_tool_completed: number;
  image_tool_failed: number;
  /** Fixed codes of the failures (CLI failure record / tool output, never the model's answer). */
  image_failure_codes: ImageFailureCode[];
  /** Other tool calls (shell, apply_patch, MCP …), by count only. */
  other_tool_calls: number;
  /** A log was larger than the read cap, or the walk of the session dirs hit its entry cap (facts are incomplete). */
  truncated: boolean;
  /** A matching log could not be opened or read (not a regular file, a link, outside CODEX_HOME, an I/O error). */
  unreadable: boolean;
}

export const emptySessionFacts = (): SessionFacts => ({
  log_found: false,
  lines: 0,
  unparsed_lines: 0,
  cli_version: null,
  model: null,
  model_provider_openai: null,
  history_mode: null,
  tool_mode: "unknown",
  code_mode_cells: 0,
  code_mode_imagegen_ref: false,
  image_tool_calls: 0,
  image_tool_completed: 0,
  image_tool_failed: 0,
  image_failure_codes: [],
  other_tool_calls: 0,
  truncated: false,
  unreadable: false,
});

/** The largest session log read (a successful image adds its base64 a few times). */
export const MAX_SESSION_LOG_BYTES = 64 * 1024 * 1024;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** At most this many entries are looked at per session dir (a huge CODEX_HOME cannot stall the run), as diagnostics.ts. */
export const SESSION_WALK_LIMIT = 20_000;
/** The head read to find a log's cwd (its first line, the session metadata), as the cleanup does. */
const HEAD_BYTES = 256 * 1024;
const IMAGE_TOOL_NAME = "imagegen";
const IMAGE_TOOL_NAMESPACE = "image_gen";
/** The image tool's TurnItem in a paginated rollout: TurnItem::Extension (`type`), ExtensionItem kind (`kind`). */
const EXTENSION_ITEM_TYPE = "Extension";
const IMAGE_EXTENSION_KIND = "image_gen.generation";
/** The code-mode custom tool, and how a cell's JavaScript names the image tool (tools/src/code_mode.rs). */
const CODE_MODE_TOOL = "exec";
const CODE_MODE_IMAGEGEN = `${IMAGE_TOOL_NAMESPACE}__${IMAGE_TOOL_NAME}`;
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

/** Which session log(s) to read: this thread's (by the file name), or — when the thread id never came (a signal mid-call) — those whose cwd is this run's work dir (as the cleanup finds them). */
export interface SessionSelector {
  threadId?: string;
  cwds?: ReadonlySet<string>;
}

type Read = { ok: true; buf: Buffer } | { ok: false; why: "too_large" | "unreadable" };

/** Reads at most `max` bytes (`max + 1` to detect overflow): never through a link, regular files only, never to EOF of a huge file. */
async function readCapped(path: string, max: number): Promise<Read> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, why: "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, why: "unreadable" };
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = 1024 * 1024;
    while (total <= max) {
      const want = Math.min(chunkSize, max + 1 - total);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buf, 0, want, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === want ? buf : buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > max) return { ok: false, why: "too_large" };
    return { ok: true, buf: Buffer.concat(chunks, total) };
  } catch {
    return { ok: false, why: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The cwd in a log's first line (session_meta), as the cleanup reads it; undefined when absent. */
async function cwdOf(path: string): Promise<string | undefined> {
  const head = await readCapped(path, HEAD_BYTES);
  // a head over the cap still has a complete first line in practice; only the first line is parsed
  const text = head.ok ? head.buf.toString("utf8") : "";
  try {
    const meta = obj(JSON.parse(text.split("\n")[0] ?? ""));
    return str(obj(meta?.payload)?.cwd) ?? str(meta?.cwd);
  } catch {
    return undefined;
  }
}

/**
 * The session log file(s) selected under CODEX_HOME/sessions and archived_sessions. Each session dir must be a
 * real directory (not a link); at most SESSION_WALK_LIMIT entries are looked at; a file must be a regular file
 * whose real path lies inside CODEX_HOME's real path.
 */
async function sessionLogs(codexHome: string, select: SessionSelector, f: SessionFacts): Promise<string[]> {
  const threadId = select.threadId && THREAD_ID.test(select.threadId) ? select.threadId : undefined;
  if (!threadId && !(select.cwds && select.cwds.size > 0)) return [];
  const home = await realpath(codexHome).catch(() => null);
  if (!home) return [];
  const found: string[] = [];
  for (const dir of ["sessions", "archived_sessions"]) {
    const root = join(codexHome, dir);
    const info = await lstat(root).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    let names: string[];
    try {
      names = await readdir(root, { recursive: true });
    } catch {
      continue;
    }
    if (names.length > SESSION_WALK_LIMIT) {
      f.truncated = true;
      names = names.slice(0, SESSION_WALK_LIMIT);
    }
    for (const name of names) {
      const base = name.split("/").pop() ?? "";
      if (!base.startsWith("rollout-") || !base.endsWith(".jsonl")) continue;
      if (threadId && !base.endsWith(`${threadId}.jsonl`)) continue;
      const path = join(root, name);
      const entry = await lstat(path).catch(() => null);
      if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
      const real = await realpath(path).catch(() => null);
      if (!real || !(real.startsWith(`${home}${sep}`))) {
        f.unreadable = true;
        continue;
      }
      if (!threadId) {
        const cwd = await cwdOf(path);
        if (cwd === undefined || !select.cwds!.has(cwd)) continue;
      }
      found.push(path);
    }
  }
  return found;
}

/**
 * Reads the selected session log(s) in memory and returns fixed facts only.
 * Never throws; no log is `log_found: false`.
 *
 * Per image call (keyed by call id), the evidence is weighed in this order:
 * 1. the CLI's structured failure object (`failure` on the paginated Extension item_completed, or on the legacy
 *    image_generation_end) decides failed + its code
 *    (usageLimitExceeded → USAGE_LIMIT, any other type → OTHER); nothing overrides it;
 * 2. else the CLI's structured end status (completed / failed; in_progress is ignored) decides the status — it wins over the shape of
 *    the tool's output (so end(completed) + an output without an image is completed: TOOL_CALLED_NO_FILE);
 * 3. else the output's shape decides (an image content item → completed, none → failed);
 * a failed call without a structured failure takes its code from the tool output's text when that text names a
 * usage / rate limit (USAGE_LIMIT) or a policy refusal (POLICY), whatever the order of the records; every failed
 * call still without a code is OTHER, assigned only at the end. The model's own words are never read here.
 *
 * Several calls (mixed results): `image_failure_codes` lists every failed call's code; the outcome
 * (deriveImageOutcome) is IMAGE_SAVED whenever a PNG was taken, else any failed call makes it TOOL_FAILED_*
 * with USAGE_LIMIT before POLICY before OTHER, even if another call completed.
 */
export async function readSessionFacts(codexHome: string, select: SessionSelector | string | undefined): Promise<SessionFacts> {
  const f = emptySessionFacts();
  const selector: SessionSelector = typeof select === "string" ? { threadId: select } : (select ?? {});
  if (selector.threadId !== undefined && !THREAD_ID.test(selector.threadId)) return f;
  const paths = await sessionLogs(codexHome, selector, f).catch(() => [] as string[]);
  if (paths.length === 0) return f;
  f.log_found = true;
  type Status = "completed" | "failed";
  type Call = { endStatus?: Status; endFailure?: ImageFailureCode; shapeStatus?: Status; textFailure?: ImageFailureCode };
  const calls = new Map<string, Call>();
  let anonymous = 0;
  const callOf = (id: string | undefined): Call => {
    const key = id ?? `anon-${anonymous++}`;
    let c = calls.get(key);
    if (!c) calls.set(key, (c = {}));
    return c;
  };
  for (const path of paths) {
    const read = await readCapped(path, MAX_SESSION_LOG_BYTES);
    if (!read.ok) {
      if (read.why === "too_large") f.truncated = true;
      else f.unreadable = true;
      continue;
    }
    // Line by line over the buffer (never one 64 MiB string split into an array of every line): a successful
    // image's line can carry its base64 a few times; only that one line is decoded and parsed at a time.
    const buf = read.buf;
    for (let start = 0; start < buf.length; ) {
      let stop = buf.indexOf(0x0a, start);
      if (stop === -1) stop = buf.length;
      const line = buf.toString("utf8", start, stop).trim();
      start = stop + 1;
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
        const history = str(p.history_mode);
        if (history !== undefined) f.history_mode = history === "legacy" || history === "paginated" ? history : "other";
      } else if (type === "turn_context") {
        const m = str(p.model);
        if (m !== undefined) f.model = modelSlug(m);
      } else if (type === "response_item") {
        const t = str(p.type);
        const name = str(p.name);
        const ns = str(p.namespace);
        const isImageCall = t === "function_call" && (name === IMAGE_TOOL_NAME || name === `${IMAGE_TOOL_NAMESPACE}.${IMAGE_TOOL_NAME}`) && (ns === undefined || ns === IMAGE_TOOL_NAMESPACE);
        if (isImageCall) {
          callOf(str(p.call_id));
        } else if (t === "image_generation_call") {
          // the older hosted image tool: its own item carries the status (structured)
          const status = str(p.status);
          callOf(str(p.id)).endStatus = status === "failed" ? "failed" : "completed";
        } else if (t === "function_call_output") {
          const id = str(p.call_id);
          if (id !== undefined && calls.has(id)) {
            const c = callOf(id);
            if (outputHasImage(p.output)) c.shapeStatus = "completed";
            else {
              c.shapeStatus = "failed";
              const code = classifyToolFailure(outputText(p.output));
              if (code !== "OTHER") c.textFailure = code;
            }
          }
        } else if (t === "custom_tool_call" && name === CODE_MODE_TOOL) {
          // a code-mode cell: counted, its JavaScript matched in memory for the image tool's name only
          f.code_mode_cells += 1;
          if (str(p.input)?.includes(CODE_MODE_IMAGEGEN)) f.code_mode_imagegen_ref = true;
        } else if (t !== undefined && OTHER_CALL_TYPES.has(t)) {
          f.other_tool_calls += 1;
        }
      } else if (type === "event_msg") {
        const t = str(p.type);
        const item = t === "item_completed" ? obj(p.item) : undefined;
        // legacy history: image_generation_end; paginated history: item_completed with the Extension item
        // (in_progress is not an end status and is ignored below); an older image-generation TurnItem spelling too
        const isExtension = !!item && str(item.type) === EXTENSION_ITEM_TYPE && str(item.kind) === IMAGE_EXTENSION_KIND;
        const record = t === "image_generation_end" ? p : item && (isExtension || /image_?generation/i.test(str(item.type) ?? "")) ? item : undefined;
        if (record) {
          const c = callOf(str(record.call_id) ?? str(record.id));
          const failure = obj(record.failure);
          const status = str(record.status);
          if (failure) {
            c.endStatus = "failed";
            c.endFailure = /usage ?limit/i.test(str(failure.type) ?? "") ? "USAGE_LIMIT" : "OTHER";
          } else if (c.endFailure === undefined && (status === "failed" || status === "completed")) {
            c.endStatus = status;
          }
        }
      }
    }
  }
  const settled = [...calls.values()].map((c) => {
    const status: Status | "pending" = c.endFailure ? "failed" : (c.endStatus ?? c.shapeStatus ?? "pending");
    const failure: ImageFailureCode | undefined = status === "failed" ? (c.endFailure ?? c.textFailure ?? "OTHER") : undefined;
    return { status, failure };
  });
  f.tool_mode = toolModeOf(f.model);
  f.image_tool_calls = settled.length;
  f.image_tool_completed = settled.filter((c) => c.status === "completed").length;
  f.image_tool_failed = settled.filter((c) => c.status === "failed").length;
  f.image_failure_codes = IMAGE_FAILURE_CODES.filter((code) => settled.some((c) => c.failure === code));
  return f;
}

/** How the image step ended, as one fixed code. */
export const IMAGE_OUTCOMES = [
  "IMAGE_SAVED",
  "NO_SESSION_LOG",
  "TOOL_NOT_CALLED",
  "TOOL_NOT_SEEN_CODE_MODE",
  "TOOL_FAILED_USAGE_LIMIT",
  "TOOL_FAILED_POLICY",
  "TOOL_FAILED",
  "TOOL_CALLED_NO_FILE",
] as const;
export type ImageOutcome = (typeof IMAGE_OUTCOMES)[number];

/**
 * No image call seen means "not called" (TOOL_NOT_CALLED) only when imagegen was a direct tool, as far as the
 * log shows: no code-mode cell ran and the model is not a code_mode_only one. Otherwise (DEV-080) a call from
 * inside an exec cell that failed before the tool started leaves no record, so it is TOOL_NOT_SEEN_CODE_MODE:
 * inconclusive, never read as "the model chose text".
 */
export function deriveImageOutcome(facts: SessionFacts, imageSaved: boolean): ImageOutcome {
  if (imageSaved) return "IMAGE_SAVED";
  if (!facts.log_found || facts.truncated || facts.unreadable) return "NO_SESSION_LOG";
  if (facts.image_tool_calls === 0) return facts.code_mode_cells > 0 || facts.tool_mode === "code_mode_only" ? "TOOL_NOT_SEEN_CODE_MODE" : "TOOL_NOT_CALLED";
  if (facts.image_tool_failed > 0) {
    if (facts.image_failure_codes.includes("USAGE_LIMIT")) return "TOOL_FAILED_USAGE_LIMIT";
    if (facts.image_failure_codes.includes("POLICY")) return "TOOL_FAILED_POLICY";
    return "TOOL_FAILED";
  }
  return "TOOL_CALLED_NO_FILE";
}
