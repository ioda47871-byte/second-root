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
 *
 * DEV-081 (HUMAN-021b: code mode, img_calls=1, img_failed=1, img_fail=OTHER; rust-v0.159.0 read as data): an Extension item
 * exists only after the tool's argument checks (`emit_started`, ext/image-generation/src/tool.rs:149-170), so a failed
 * item is a failure of the images request itself (tool.rs:171-221). Its `failure` is set only for a usage limit whose limit
 * id is `image_gen` (tool.rs:261-286); everything else — other 429s, 4xx, 5xx, timeout, connection, auth, "no image data"
 * — is `failure: null`, which DEV-080 could only call OTHER. The message (`image generation failed: <ApiError>`) goes to
 * the model as the tool's output (direct: function_call_output, core/src/tools/parallel.rs:303-327) or as the rejection in
 * the cell's JavaScript (code mode: code_mode/delegate.rs:461, code-mode-runtime/src/runtime/module_loader.rs:90-93), from
 * where it reaches the exec cell's custom_tool_call_output only if printed or uncaught (`Script error:`). So now: the
 * structured type from an allowlist, fixed reason codes / HTTP status / allowlisted API code from that text in memory, and
 * the models cache's facts about the model (readModelCatalog). Text is never kept.

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

/**
 * Fixed codes for why the image tool failed (from the CLI's own failure record and the tool's output, never the model's words).
 * DEV-081 adds UNSUPPORTED (the image endpoint said the model / plan / feature is not available) and TRANSIENT (a server or
 * network failure of this one call: 5xx, timeout, connection). Neither is ever retried.
 */
export const IMAGE_FAILURE_CODES = ["USAGE_LIMIT", "POLICY", "UNSUPPORTED", "TRANSIENT", "OTHER"] as const;
export type ImageFailureCode = (typeof IMAGE_FAILURE_CODES)[number];

/**
 * The structured `failure.type` of a failed image call (DEV-081), from a fixed allowlist. In Codex CLI 0.159.0
 * `ImageGenerationFailure` has exactly one variant, `UsageLimitExceeded` (serde `tag = "type"`, camelCase:
 * `{"type":"usageLimitExceeded","limitId":…,"resetsAt":…}`, ext/items/src/image_generation.rs:7-20), and the tool sets it only
 * for a usage-limit error whose limit id is `image_gen` (ext/image-generation/src/tool.rs:261-286); every other failure has
 * `failure: null`. So: `usageLimitExceeded`; `other` (a failure object of an unknown type, from a later CLI); `none` (the CLI's
 * end record says failed with `failure: null` — HUMAN-021b's case); `no_record` (failed known only from the tool output's shape,
 * with no end record: e.g. a direct-mode call refused before it started).
 */
export const IMAGE_FAILURE_TYPES = ["usageLimitExceeded", "other", "none", "no_record"] as const;
export type ImageFailureType = (typeof IMAGE_FAILURE_TYPES)[number];
const KNOWN_FAILURE_TYPES: ReadonlySet<string> = new Set(["usageLimitExceeded"]);

/**
 * Fixed reason codes from the TEXT of the tool's error, matched in memory only (DEV-081). The text is Codex's own
 * `image generation failed: <ApiError>` (tool.rs:175-181; ApiError / TransportError Display: codex-api/src/error.rs:9-52,
 * http-client/src/error.rs:10-33, e.g. `http 429 Too Many Requests: Some("{…}")`, `timeout`, `connection failed: …`), the
 * `image generation returned no image data` message (tool.rs:195-199), or an argument error from before the call started
 * (tool.rs:439-605). Never stored: only the code, an HTTP status in 400-599 and an allowlisted API error code come out.
 * NO_TEXT: a failed call whose error text was nowhere to be read (in code mode the cell's JavaScript may catch the rejection
 * and print nothing; core/src/tools/code_mode/mod.rs:286-289 adds `Script error:` only for an uncaught one).
 */
export const IMAGE_FAILURE_REASONS = [
  "USAGE_LIMIT",
  "HTTP_429",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "AUTH",
  "NOT_SUPPORTED",
  "POLICY",
  "BAD_REQUEST",
  "INVALID_ARGS",
  "NO_IMAGE_DATA",
  "BAD_RESPONSE",
  "OTHER",
  "NO_TEXT",
] as const;
export type ImageFailureReason = (typeof IMAGE_FAILURE_REASONS)[number];

/**
 * Where a failed call's code came from (review F1): `struct` the CLI's structured failure; `fn_output` the call's own
 * function_call_output (direct mode, written by Codex); `cell_error` Codex's uncaught-error item of a failed code-mode
 * cell (failedCellError); `cell_print` only text a cell printed (the model's script: advisory, the code stays OTHER);
 * `none` no text at all.
 */
export const IMAGE_FAILURE_SOURCES = ["struct", "fn_output", "cell_error", "cell_print", "none"] as const;
export type ImageFailureSource = (typeof IMAGE_FAILURE_SOURCES)[number];

/**
 * DEV-084: how long one image call took, as a fixed bucket. The duration is Codex's own `completed_at_ms - started_at_ms` of the
 * call's ItemCompleted event (core/src/session/mod.rs:2584-2640 at rust-v0.159.0: started = right before the images request,
 * ext/image-generation/src/tool.rs:153-181; completed = when the request returned or failed). `140-170s` is the band of
 * HUMAN-018/019/020/21b's failures (155.6-157.8 s): five HTTP attempts (request_max_retries 4, model-provider-info/src/lib.rs:65,
 * :446-452) of about 30-31 s each plus about 3 s of backoff (codex-client/src/retry.rs:43-52) — see
 * docs/operations/imagegen-timeout-investigation.md. `unknown`: no usable timestamps (a legacy log, out of range, or exactly 0 —
 * Codex writes `started_at_ms = completed_at_ms` when it has no recorded start, core/src/session/mod.rs:2618-2630).
 */
export const IMAGE_FAIL_TIMINGS = ["<5s", "5-60s", "60-140s", "140-170s", ">170s", "unknown"] as const;
export type ImageFailTiming = (typeof IMAGE_FAIL_TIMINGS)[number];
/** The longest duration recorded (a day); anything else is not a duration of one call. */
const MAX_CALL_MS = 24 * 60 * 60 * 1000;
/** At most this many per-call durations / timing buckets are recorded. */
export const MAX_IMAGE_CALL_TIMINGS = 16;

export function failTimingOf(ms: number | null | undefined): ImageFailTiming {
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0 || ms > MAX_CALL_MS) return "unknown";
  if (ms < 5_000) return "<5s";
  if (ms < 60_000) return "5-60s";
  if (ms < 140_000) return "60-140s";
  if (ms < 170_000) return "140-170s";
  return ">170s";
}

/** `completed_at_ms - started_at_ms` of an ItemCompleted event payload (protocol/src/protocol.rs:1948-1960), or undefined. */
function callMs(payload: Json): number | undefined {
  const a = payload.started_at_ms;
  const b = payload.completed_at_ms;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a <= 0 || b <= 0) return undefined;
  const ms = b - a;
  // 0: Codex's fallback when the start was not recorded (started_at_ms = completed_at_ms), not a measured duration
  return ms > 0 && ms <= MAX_CALL_MS ? ms : undefined;
}

/** API error codes / types that may be recorded (anything else found is "other"; none found: not recorded). */
export const IMAGE_API_ERROR_CODES = [
  "usage_limit_reached",
  "usage_not_included",
  "insufficient_quota",
  "rate_limit_exceeded",
  "slow_down",
  "server_is_overloaded",
  "server_error",
  "flex_unavailable",
  "moderation_blocked",
  "content_policy_violation",
  "image_generation_user_error",
  "invalid_prompt",
  "invalid_request_error",
  "unsupported_parameter",
  "invalid_value",
  "model_not_found",
  "unsupported_model",
  "not_found_error",
  "authentication_error",
  "permission_error",
  "account_deactivated",
] as const;
export type ImageApiErrorCode = (typeof IMAGE_API_ERROR_CODES)[number] | "other";
const API_ERROR_CODES: ReadonlySet<string> = new Set(IMAGE_API_ERROR_CODES);

const QUOTA_SIGN = /usage limit|usagelimitexceeded|rate limit|quota|too many requests|\b429\b/i;
const POLICY_SIGN = /content[ _-]?policy|safety|moderation|policy[ _-]?violation|refus/i;

/** At most this much of one output's text is matched (in memory). */
const MAX_MATCH_CHARS = 64 * 1024;
/** Codex's own prefixes of a failed image call's message (tool.rs:177, :196). */
const FAILED_PREFIX = /image generation failed:|image generation returned no image data/i;
/** `http 429 Too Many Requests` (TransportError::Http) or `api error 400 Bad Request` (ApiError::Api). */
const HTTP_STATUS = /\b(?:http|api error) ([45]\d\d)\b/i;
/** `"code":"x"` / `"type":"x"` in the error body, also as Rust's Debug of a string (`\"code\": \"x\"`). */
const API_CODE = /\\?"(?:code|type)\\?"\s*:\s*\\?"([A-Za-z0-9_.-]{1,64})\\?"/g;
/** Argument errors the tool returns before it starts (no Extension item): tool.rs:439-605, code_mode/mod.rs:419-428. */
const INVALID_ARGS_SIGN =
  /`referenced_image_paths` must contain at most|referenced image paths are unavailable|`num_last_images_to_include` must be between|provide only one of `referenced_image_paths`|conversation images, but only \d+ were available|unable to (?:read|process) referenced image|expects a JSON object for arguments|unknown field `|missing field `prompt`|invalid type: [a-z ]+, expected/i;

const USAGE_CODES: ReadonlySet<string> = new Set(["usage_limit_reached", "insufficient_quota"]);
const POLICY_CODES: ReadonlySet<string> = new Set(["moderation_blocked", "content_policy_violation", "invalid_prompt"]);
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set(["usage_not_included", "model_not_found", "unsupported_model", "not_found_error"]);
const AUTH_CODES: ReadonlySet<string> = new Set(["authentication_error", "permission_error", "account_deactivated"]);
const RATE_CODES: ReadonlySet<string> = new Set(["rate_limit_exceeded", "slow_down"]);
const SERVER_CODES: ReadonlySet<string> = new Set(["server_is_overloaded", "server_error", "flex_unavailable"]);
const BAD_REQUEST_CODES: ReadonlySet<string> = new Set(["invalid_request_error", "unsupported_parameter", "invalid_value", "image_generation_user_error"]);

/** One classified error text: fixed values only. */
export interface ImageFailureText {
  reason: ImageFailureReason;
  /** The HTTP status in the text (400-599), else null. */
  http: number | null;
  /** The first allowlisted API error code / type in the text ("other": some code, not allowlisted; null: none). */
  api_code: ImageApiErrorCode | null;
}

/**
 * Classifies one error text of the image tool in memory (DEV-081). Only fixed values come out; the caller must not keep
 * the text. Order: policy (wins over a usage limit, review F1), usage limit, not supported (allowlisted code / 403 / 404), auth, 429,
 * 5xx, timeout, network (never for a 4xx, review F2), a bad response, no image data,
 * a bad request, argument errors, other.
 */
export function classifyImageFailureText(raw: string): ImageFailureText {
  const text = raw.slice(0, MAX_MATCH_CHARS);
  const statusMatch = HTTP_STATUS.exec(text);
  const http = statusMatch ? Number(statusMatch[1]) : null;
  let api_code: ImageApiErrorCode | null = null;
  for (const m of text.matchAll(API_CODE)) {
    const c = m[1]!.toLowerCase();
    if (API_ERROR_CODES.has(c)) {
      api_code = c as ImageApiErrorCode;
      break;
    }
    // a JSON "type" that is not an error code (e.g. `"type":"input_text"`) is not a finding
    if (/error|limit|quota|policy|blocked|denied|forbidden|not_found|unsupported|invalid/.test(c)) api_code ??= "other";
  }
  const code = api_code ?? "";
  const reason = ((): ImageFailureReason => {
    const is4xx = http !== null && http >= 400 && http < 500;
    // review F1: a policy refusal wins over a usage limit whenever the text names both
    if (POLICY_CODES.has(code) || /content[ _-]?policy|safety system|moderation|(?:cyber|bio|misalignment) policy|policy[ _-]?violation/i.test(text)) return "POLICY";
    if (USAGE_CODES.has(code) || /usage limit|usagelimitexceeded|quota exceeded|insufficient[ _]quota/i.test(text)) return "USAGE_LIMIT";
    // review F2: "not supported" only from an allowlisted code, a 403 / 404, or (without any HTTP status) ApiError's own
    // `usage not included` (codex-api/src/error.rs:21-22) — never from the words of a 400 body
    if (UNSUPPORTED_CODES.has(code)) return "NOT_SUPPORTED";
    if (AUTH_CODES.has(code) || http === 401) return "AUTH";
    if (http === 403 || http === 404) return "NOT_SUPPORTED";
    if (http === null && /usage not included/i.test(text)) return "NOT_SUPPORTED";
    if (http === null && /unauthori[sz]ed|not logged in|sign in again|refresh token|invalid_grant/i.test(text)) return "AUTH";
    if (RATE_CODES.has(code) || http === 429 || (http === null && /rate limit|too many requests/i.test(text))) return "HTTP_429";
    if (SERVER_CODES.has(code) || (http !== null && http >= 500)) return "HTTP_5XX";
    // review F2: a 4xx is never transient, whatever its body says
    if (!is4xx && /server overloaded|retry limit reached|internal server error/i.test(text)) return "HTTP_5XX";
    if (!is4xx && /\btimeout\b|timed out/i.test(text)) return "TIMEOUT";
    if (!is4xx && /connection failed|network error|request build error|connection (?:refused|reset|closed)|dns error/i.test(text)) return "NETWORK";
    if (/failed to (?:decode|encode) image (?:generation|edit) (?:response|request)/i.test(text)) return "BAD_RESPONSE";
    if (/returned no image data/i.test(text)) return "NO_IMAGE_DATA";
    if (BAD_REQUEST_CODES.has(code) || is4xx || /invalid request/i.test(text)) return "BAD_REQUEST";
    if (INVALID_ARGS_SIGN.test(text)) return "INVALID_ARGS";
    return "OTHER";
  })();
  return { reason, http, api_code };
}

/** The coarse failure code of a reason (a generic 429 stays USAGE_LIMIT, as DEV-078 read it: wait, never re-run the same day). */
export function failureCodeOfReason(reason: ImageFailureReason): ImageFailureCode {
  switch (reason) {
    case "USAGE_LIMIT":
    case "HTTP_429":
      return "USAGE_LIMIT";
    case "POLICY":
      return "POLICY";
    case "NOT_SUPPORTED":
      return "UNSUPPORTED";
    case "HTTP_5XX":
    case "TIMEOUT":
    case "NETWORK":
      return "TRANSIENT";
    default:
      return "OTHER";
  }
}

function classifyToolFailure(text: string): ImageFailureCode {
  // review F1: policy before a usage limit when the text names both
  if (POLICY_SIGN.test(text)) return "POLICY";
  if (QUOTA_SIGN.test(text)) return "USAGE_LIMIT";
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
export const TOOL_MODES = ["direct", "code_mode", "code_mode_only", "unknown"] as const;
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
/** Where `tool_mode` came from: the slug hint above, or (DEV-081) the model's entry in CODEX_HOME/models_cache.json. */
export type ToolModeSource = "slug" | "cache";

/** turn_context.effort (ReasoningEffort, protocol/src/openai_models.rs:59-72, lowercase on the wire); any other value is "other". */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent", "other"] as const;
export type ReasoningEffortCode = (typeof REASONING_EFFORTS)[number];
const effortOf = (v: string): ReasoningEffortCode => ((REASONING_EFFORTS as readonly string[]).includes(v) && v !== "other" ? (v as ReasoningEffortCode) : "other");

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
  /** turn_context.effort, the reasoning effort the turn ran with (null: not recorded). */
  effort: ReasoningEffortCode | null;
  /** toolModeOf(model), or the models cache's entry (DEV-081, applyModelCatalog): whether imagegen is a direct tool for this model or only reachable from a code-mode `exec` cell. */
  tool_mode: ToolMode;
  tool_mode_source: ToolModeSource;
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
  /** DEV-081: the failed calls' structured `failure.type` (allowlist; see IMAGE_FAILURE_TYPES). */
  image_failure_types: ImageFailureType[];
  /** DEV-081: fixed reasons from the error text (matched in memory, never kept; see classifyImageFailureText). */
  image_failure_reasons: ImageFailureReason[];
  /** Review F1: where each failed call's code came from (see IMAGE_FAILURE_SOURCES). */
  image_failure_sources: ImageFailureSource[];
  /** DEV-081: HTTP statuses (400-599) named in that text. */
  image_failure_http: number[];
  /** DEV-081: allowlisted API error codes named in that text. */
  image_failure_api_codes: ImageApiErrorCode[];
  /** DEV-081: an output of an exec cell that named image_gen__imagegen carries one of the tool's argument errors (a call refused before it started leaves no Extension item). */
  code_mode_arg_error: boolean;
  /**
   * DEV-084: each ended image call's duration in ms (ItemCompleted `completed_at_ms - started_at_ms`), in the order the calls
   * were first seen, at most MAX_IMAGE_CALL_TIMINGS. Only calls with usable timestamps (a paginated log); a legacy
   * image_generation_end has none (protocol/src/protocol.rs:2796-2812).
   */
  image_call_ms: number[];
  /** DEV-084: one fixed bucket per failed call (failTimingOf; `unknown` without timestamps), in call order. */
  image_fail_timings: ImageFailTiming[];
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
  effort: null,
  tool_mode: "unknown",
  tool_mode_source: "slug",
  code_mode_cells: 0,
  code_mode_imagegen_ref: false,
  image_tool_calls: 0,
  image_tool_completed: 0,
  image_tool_failed: 0,
  image_failure_codes: [],
  image_failure_types: [],
  image_failure_reasons: [],
  image_failure_sources: [],
  image_failure_http: [],
  image_failure_api_codes: [],
  code_mode_arg_error: false,
  image_call_ms: [],
  image_fail_timings: [],
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
/** The code-mode wait tool (a function tool): a yielded cell's later output, the tool's rejection included, comes back through it. */
const CODE_MODE_WAIT_TOOL = "wait";
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

/**
 * Codex's own error text of a FAILED code-mode cell (review F1), or undefined. The rollout does not keep the output's
 * `success` flag (FunctionCallOutputPayload serializes the body only, protocol/src/models.rs:2178, :2253-2262), so the
 * failure is read from the shape Codex gives it: item 0 is the header Codex inserts, `Script failed\nWall time …`
 * (code_mode/output.rs:27-33, status from code_mode/mod.rs:300-312), and the LAST item is the one Codex appends after the
 * script's own items, `Script error:\n<text>` (code_mode/mod.rs:286-289). Text the script prints can occupy neither
 * position. When Codex merged the items for size (utils/output-truncation/src/lib.rs:58-81) the shape is gone and the text
 * only counts as printed. Residual: a script that throws a string of its own leaves that string in this item.
 */
function failedCellError(output: unknown): string | undefined {
  const items = Array.isArray(output) ? output : Array.isArray(obj(output)?.content) ? (obj(output)!.content as unknown[]) : [];
  if (items.length < 2) return undefined;
  const first = obj(items[0]);
  const last = obj(items[items.length - 1]);
  const head = str(first?.text);
  const tail = str(last?.text);
  if (str(first?.type) !== "input_text" || str(last?.type) !== "input_text" || head === undefined || tail === undefined) return undefined;
  if (!head.startsWith("Script failed\n") || !tail.startsWith("Script error:\n")) return undefined;
  return tail.slice(0, MAX_MATCH_CHARS);
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
  type Call = {
    endStatus?: Status;
    endFailure?: ImageFailureCode;
    failureType?: ImageFailureType;
    shapeStatus?: Status;
    textFailure?: ImageFailureCode;
    text?: ImageFailureText;
    /** DEV-084: the end record's duration (ItemCompleted timestamps). */
    ms?: number;
  };
  const calls = new Map<string, Call>();
  let anonymous = 0;
  const callOf = (id: string | undefined): Call => {
    const key = id ?? `anon-${anonymous++}`;
    let c = calls.get(key);
    if (!c) calls.set(key, (c = {}));
    return c;
  };
  /** Code-mode cells by call id (true: the cell's JavaScript names image_gen__imagegen), and wait calls. */
  const cells = new Map<string, boolean>();
  const waits = new Set<string>();
  /**
   * The image tool's failure texts seen in code-mode outputs (classified at once; the text is dropped). `cell_error`: Codex's
   * own uncaught-error item of a failed cell (authoritative); `cell_print`: anywhere else in a cell's output, which the
   * model's script writes (advisory: recorded as a reason, never decides the code — review F1).
   */
  const cellFailures: Array<{ src: "cell_error" | "cell_print"; t: ImageFailureText }> = [];
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
        const effort = str(p.effort);
        if (effort !== undefined) f.effort = effortOf(effort);
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
              // direct mode: this output IS the tool's error (core/src/tools/parallel.rs:303-327), matched in memory
              const text = outputText(p.output);
              c.text = classifyImageFailureText(text);
              const byReason = failureCodeOfReason(c.text.reason);
              const code = byReason !== "OTHER" ? byReason : classifyToolFailure(text);
              if (code !== "OTHER") c.textFailure = code;
            }
          } else if (id !== undefined && waits.has(id)) {
            cellOutput(p.output, [...cells.values()].some(Boolean));
          }
        } else if (t === "custom_tool_call" && name === CODE_MODE_TOOL) {
          // a code-mode cell: counted, its JavaScript matched in memory for the image tool's name only
          f.code_mode_cells += 1;
          const refs = str(p.input)?.includes(CODE_MODE_IMAGEGEN) ?? false;
          if (refs) f.code_mode_imagegen_ref = true;
          const id = str(p.call_id);
          if (id !== undefined) cells.set(id, refs || (cells.get(id) ?? false));
        } else if (t === "custom_tool_call_output") {
          const id = str(p.call_id);
          if (id !== undefined && cells.has(id)) cellOutput(p.output, cells.get(id)!);
        } else if (t !== undefined && OTHER_CALL_TYPES.has(t)) {
          f.other_tool_calls += 1;
          const id = str(p.call_id);
          if (t === "function_call" && name === CODE_MODE_WAIT_TOOL && id !== undefined) waits.add(id);
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
            const ft = str(failure.type) ?? "";
            c.failureType = KNOWN_FAILURE_TYPES.has(ft) ? (ft as ImageFailureType) : "other";
            c.endFailure = /usage ?limit/i.test(ft) ? "USAGE_LIMIT" : "OTHER";
          } else if (c.endFailure === undefined && (status === "failed" || status === "completed")) {
            c.endStatus = status;
            // tool.rs:202-221: every failure but an `image_gen` usage limit is written with `failure: null`
            if (status === "failed") c.failureType = "none";
          }
          // DEV-084: the ItemCompleted event's own timestamps (on the payload, not the item); in_progress is not an end
          if (record === item && (failure || status === "failed" || status === "completed")) {
            const ms = callMs(p);
            if (ms !== undefined) c.ms = ms;
          }
        }
      }
    }
  }
  /**
   * One code-mode output (exec cell / wait), matched in memory. The image tool's failure message reaches the cell's
   * JavaScript as the rejection (code_mode/delegate.rs:461 → runtime/module_loader.rs:90-93); the script may print anything,
   * Codex's prefix included, so only Codex's own uncaught-error item of a failed cell (failedCellError) is `cell_error` and
   * may decide the code; text found anywhere else is `cell_print`, a recorded reason only (review F1). An argument error only
   * counts in a cell that named the tool. The text is then dropped.
   */
  function cellOutput(output: unknown, namedTool: boolean): void {
    const error = failedCellError(output);
    if (error !== undefined) {
      const at = error.search(FAILED_PREFIX);
      if (at >= 0) cellFailures.push({ src: "cell_error", t: classifyImageFailureText(error.slice(at, at + 4096)) });
      else if (namedTool && INVALID_ARGS_SIGN.test(error)) f.code_mode_arg_error = true;
      if (at >= 0) return;
    }
    const text = outputText(output).slice(0, MAX_MATCH_CHARS);
    const at = text.search(FAILED_PREFIX);
    if (at >= 0) cellFailures.push({ src: "cell_print", t: classifyImageFailureText(text.slice(at, at + 4096)) });
    else if (namedTool && INVALID_ARGS_SIGN.test(text)) f.code_mode_arg_error = true;
  }
  // POLICY first: a refusal wins over a usage limit among text-derived codes (review F1)
  const CODE_ORDER: readonly ImageFailureCode[] = ["POLICY", "USAGE_LIMIT", "UNSUPPORTED", "OTHER", "TRANSIENT"];
  const worst = (codes: ImageFailureCode[]): ImageFailureCode | undefined => CODE_ORDER.find((c) => codes.includes(c));
  const cellErrors = cellFailures.filter((x) => x.src === "cell_error");
  const cellCode = worst(cellErrors.map((x) => failureCodeOfReason(x.t.reason)));
  const sources = new Set<ImageFailureSource>();
  const reasons = new Set<ImageFailureReason>();
  const http = new Set<number>();
  const apiCodes = new Set<ImageApiErrorCode>();
  const types = new Set<ImageFailureType>();
  const note = (t: ImageFailureText): void => {
    reasons.add(t.reason);
    if (t.http !== null) http.add(t.http);
    if (t.api_code !== null) apiCodes.add(t.api_code);
  };
  const settled = [...calls.values()].map((c) => {
    const status: Status | "pending" = c.endFailure ? "failed" : (c.endStatus ?? c.shapeStatus ?? "pending");
    if (status !== "failed") return { status, failure: undefined, ms: c.ms };
    types.add(c.failureType ?? "no_record");
    // the call's own text (direct mode); else, with no function output at all (code mode), the cells' failure texts
    // (Codex's uncaught-error items decide; text the script printed is only recorded as a reason)
    const texts = c.text ? [c.text] : cellFailures.map((x) => x.t);
    if (texts.length === 0) reasons.add("NO_TEXT");
    for (const t of texts) note(t);
    const fromCells = c.text ? undefined : cellCode;
    const failure: ImageFailureCode = c.endFailure ?? c.textFailure ?? fromCells ?? "OTHER";
    sources.add(
      c.endFailure !== undefined ? "struct" : c.text ? "fn_output" : cellErrors.length > 0 ? "cell_error" : cellFailures.length > 0 ? "cell_print" : "none",
    );
    return { status, failure, ms: c.ms };
  });
  if (f.tool_mode_source === "slug") f.tool_mode = toolModeOf(f.model);
  f.image_tool_calls = settled.length;
  f.image_tool_completed = settled.filter((c) => c.status === "completed").length;
  f.image_tool_failed = settled.filter((c) => c.status === "failed").length;
  f.image_failure_codes = IMAGE_FAILURE_CODES.filter((code) => settled.some((c) => c.failure === code));
  f.image_failure_types = IMAGE_FAILURE_TYPES.filter((t) => types.has(t));
  f.image_failure_reasons = IMAGE_FAILURE_REASONS.filter((r) => reasons.has(r));
  f.image_failure_sources = IMAGE_FAILURE_SOURCES.filter((x) => sources.has(x));
  f.image_failure_http = [...http].sort((a, b) => a - b);
  f.image_failure_api_codes = [...IMAGE_API_ERROR_CODES, "other" as const].filter((c) => apiCodes.has(c));
  f.image_call_ms = settled.flatMap((c) => (c.ms !== undefined && c.status !== "pending" ? [c.ms] : [])).slice(0, MAX_IMAGE_CALL_TIMINGS);
  f.image_fail_timings = settled.filter((c) => c.status === "failed").map((c) => failTimingOf(c.ms)).slice(0, MAX_IMAGE_CALL_TIMINGS);
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
  "TOOL_FAILED_UNSUPPORTED",
  "TOOL_FAILED",
  "TOOL_FAILED_TRANSIENT",
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
  if (facts.image_tool_calls === 0) return facts.code_mode_cells > 0 || facts.tool_mode === "code_mode_only" || facts.tool_mode === "code_mode" ? "TOOL_NOT_SEEN_CODE_MODE" : "TOOL_NOT_CALLED";
  if (facts.image_tool_failed > 0) {
    const codes = facts.image_failure_codes;
    if (codes.includes("USAGE_LIMIT")) return "TOOL_FAILED_USAGE_LIMIT";
    if (codes.includes("POLICY")) return "TOOL_FAILED_POLICY";
    if (codes.includes("UNSUPPORTED")) return "TOOL_FAILED_UNSUPPORTED";
    // DEV-081: transient only when every failure was a server / network one
    if (codes.length > 0 && codes.every((c) => c === "TRANSIENT")) return "TOOL_FAILED_TRANSIENT";
    return "TOOL_FAILED";
  }
  return "TOOL_CALLED_NO_FILE";
}

/**
 * DEV-081: what Codex's own models cache says about the model the turn ran with. `$CODEX_HOME/models_cache.json`
 * (models-manager/src/manager.rs:31 MODEL_CACHE_FILE, written by FileModelsCache::store, cache.rs:150-155 / 238-243, with
 * serde_json pretty JSON of ModelsCacheEntry: `fetched_at` (RFC 3339), `etag`, `client_version`, `identity` (a hash of the
 * account), `models`: ModelInfo[] (cache.rs:63-84)) is rewritten on every remote catalog fetch (TTL 300 s, manager.rs:32;
 * manager.rs:519-545), so after a run it is the catalog that run used. Read in memory, never written, no network, no model:
 * only `client_version` (validated), the age of `fetched_at`, the number of models, and for the model's own entry its
 * `tool_mode` (protocol/src/openai_models.rs:344-350, snake_case; absent / null: "none", i.e. the features decide, which
 * are off by default) and whether `input_modalities` has "image" (absent: Codex's default text + image,
 * openai_models.rs:186-192). Never the identity, the ETag, a description, an instruction text or any other field.
 */
/** `stale` (review F3): found, but written by another CLI version than the session's, so it is not applied. */
export const CATALOG_STATES = ["found", "stale", "absent", "unreadable", "too_large", "invalid"] as const;
export type CatalogState = (typeof CATALOG_STATES)[number];
export const CATALOG_TOOL_MODES = ["direct", "code_mode", "code_mode_only", "none", "other"] as const;
export type CatalogToolMode = (typeof CATALOG_TOOL_MODES)[number];

export interface ModelCatalogFacts {
  cache: CatalogState;
  /** client_version of the cache entry (validated; Codex ignores an entry for another version, cache.rs:200-208). */
  client_version: string | null;
  /** Seconds between fetched_at and when it was read (null: absent or not a date). */
  age_s: number | null;
  models: number | null;
  /** The turn's model is listed (null: no cache, or no usable model slug). */
  model_listed: boolean | null;
  tool_mode: CatalogToolMode | null;
  image_input: boolean | null;
}

export const emptyModelCatalogFacts = (cache: CatalogState = "absent"): ModelCatalogFacts => ({
  cache,
  client_version: null,
  age_s: null,
  models: null,
  model_listed: null,
  tool_mode: null,
  image_input: null,
});

/** The largest models cache read (the 0.159.0 bundled catalog is about 100 KiB). */
export const MAX_MODELS_CACHE_BYTES = 8 * 1024 * 1024;
const MODELS_CACHE_FILE = "models_cache.json";

/** Reads CODEX_HOME/models_cache.json in memory (a regular file directly in CODEX_HOME, never a link). Never throws. */
export async function readModelCatalog(codexHome: string, model: string | null, now: () => number = Date.now): Promise<ModelCatalogFacts> {
  try {
    const home = await realpath(codexHome).catch(() => null);
    if (!home) return emptyModelCatalogFacts("absent");
    const path = join(home, MODELS_CACHE_FILE);
    const info = await lstat(path).catch(() => null);
    if (!info) return emptyModelCatalogFacts("absent");
    if (info.isSymbolicLink() || !info.isFile()) return emptyModelCatalogFacts("unreadable");
    const read = await readCapped(path, MAX_MODELS_CACHE_BYTES);
    if (!read.ok) return emptyModelCatalogFacts(read.why === "too_large" ? "too_large" : "unreadable");
    let entry: Json | undefined;
    try {
      entry = obj(JSON.parse(read.buf.toString("utf8")));
    } catch {
      entry = undefined;
    }
    const list = entry && Array.isArray(entry.models) ? (entry.models as unknown[]) : undefined;
    if (!entry || !list) return emptyModelCatalogFacts("invalid");
    const facts = emptyModelCatalogFacts("found");
    const version = str(entry.client_version);
    if (version !== undefined && VERSION.test(version)) facts.client_version = version;
    const fetched = Date.parse(str(entry.fetched_at) ?? "");
    if (Number.isFinite(fetched)) facts.age_s = Math.max(0, Math.round((now() - fetched) / 1000));
    facts.models = list.length;
    if (model === null || model === "other") return facts;
    const own = list.map(obj).find((m) => str(m?.slug) === model);
    facts.model_listed = own !== undefined;
    if (!own) return facts;
    const mode = own.tool_mode;
    facts.tool_mode = mode === undefined || mode === null ? "none" : mode === "direct" || mode === "code_mode" || mode === "code_mode_only" ? mode : "other";
    const modalities = own.input_modalities;
    facts.image_input = modalities === undefined ? true : Array.isArray(modalities) ? modalities.includes("image") : false;
    return facts;
  } catch {
    return emptyModelCatalogFacts("unreadable");
  }
}

/**
 * The cache's tool_mode replaces the slug hint (tool_mode_source "cache") when the model is listed: a model's own tool_mode
 * wins over the features (core/src/tools/mod.rs:75-85), and "none" means the features decide (code mode off by default:
 * direct). Returns new facts; the session facts given are not changed.
 */
export function applyModelCatalog(facts: SessionFacts, catalog: ModelCatalogFacts): SessionFacts {
  if (catalog.cache !== "found" || catalog.client_version === null || catalog.client_version !== facts.cli_version) return facts;
  if (catalog.model_listed !== true || catalog.tool_mode === null || catalog.tool_mode === "other") return facts;
  const tool_mode: ToolMode = catalog.tool_mode === "none" ? "direct" : catalog.tool_mode;
  return { ...facts, tool_mode, tool_mode_source: "cache" };
}

/**
 * Review F3: the cache's model facts count only when the cache was written by the session's own CLI version (Codex itself
 * ignores an entry for another version, models-manager/src/cache.rs:200-208). Otherwise the catalog is recorded as `stale`
 * with no tool_mode / image_input, and the session keeps the slug hint.
 */
export function reconcileModelCatalog(facts: SessionFacts, catalog: ModelCatalogFacts): { session: SessionFacts; catalog: ModelCatalogFacts } {
  if (catalog.cache !== "found") return { session: facts, catalog };
  if (catalog.client_version === null || catalog.client_version !== facts.cli_version) {
    return { session: facts, catalog: { ...catalog, cache: "stale", tool_mode: null, image_input: null } };
  }
  return { session: applyModelCatalog(facts, catalog), catalog };
}
