// Fixed messages for the design worker's codes (DEV-028 worker, as in the
// Kaii Dokuhon worker's PUBLIC_MESSAGES / H1). Logs, the ledger, job result
// records and report.json carry these codes and messages only: never Codex's
// words, a child's stdout / stderr, an exception message or a source URL.

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SYSTEM_ERROR_CODE = /^E[A-Z0-9]{2,}$/;

export const PUBLIC_MESSAGES: Readonly<Record<string, string>> = {
  CODEX_NOT_INSTALLED: "Codex CLI could not be started.",
  CODEX_NOT_SIGNED_IN: "Codex is not signed in with ChatGPT (codex login --device-auth as the worker user).",
  CODEX_API_KEY_AUTH: "Codex is signed in with an API key; sign in with ChatGPT instead.",
  CODEX_QUOTA: "Codex usage limit reached or the service is busy.",
  CODEX_EXEC_FAILED: "Codex failed.",
  CODEX_TIMEOUT: "Codex did not finish in time.",
  CODEX_NO_JSON: "Codex returned no usable JSON.",
  CODEX_SANDBOX_UNAVAILABLE: "The Codex sandbox (bubblewrap) is not available; Codex was not started (sudo apt install bubblewrap).",
  CODEX_SANDBOX_LEAK: "The Codex sandbox would show protected files; Codex was not started.",
  CODEX_SANDBOX_CONFIG: "The Codex sandbox could not be set up safely; Codex was not started.",
  CODEX_INPUT_REJECTED: "A reference image was not a regular PNG file; Codex was not started.",
  CODEX_ANSWER_REJECTED: "Codex's answer carried a piece of its own sign-in token and was thrown away.",
  PUBLIC_SOURCE_UNAVAILABLE: "The public Instagram profile could not be read without logging in.",
  JOB_INVALID: "The job file is not a valid design job.",
  SOURCE_URL_INVALID: "The job's source is not a public Instagram profile URL.",
  FACTS_INVALID: "The job's facts do not pass the demo fact filter.",
  DUPLICATE_JOB_ID: "A job with this id already has a result; nothing new was made.",
  SOURCE_CAPTURE_FAILED: "The profile page could not be loaded (network or browser error); the job is tried again.",
  REFERENCE_CHECK_FAILED: "A captured screenshot failed the file checks.",
  WORKER_JOB_STALE: "The job was left in processing by a stopped worker too many times.",
  WORKER_JOB_FAILED: "The job failed twice and is not retried automatically.",
  WORKER_LOCK_FAILED: "The worker lock could not be created.",
  WORKER_QUEUE_INVALID: "The job queue directory is not usable.",
  WORKER_NOT_ON_REF: "The worker's code is not the expected origin commit.",
  WORKER_TREE_DIRTY: "The worker's checkout has local changes.",
  WORKER_ENV_FILE_PRESENT: "The worker's checkout has a .env file; the worker runs without any.",
  WORKER_BUILD_FAILED: "npm run build failed.",
  PREVIEW_SERVER_FAILED: "The local preview server did not start.",
  PREVIEW_RENDER_FAILED: "The local preview did not render.",
  WORKER_RUN_TIME_BUDGET: "The run used up its time.",
  WORKER_STOPPED_BY_SIGNAL: "The worker was stopped (signal); the next run recovers the job.",
  WORKER_SYSTEM_ERROR: "A file or process operation failed (disk, permissions).",
  WORKER_UNEXPECTED: "The worker stopped at an unexpected step.",
};

export function normalizeCode(raw: unknown): string {
  if (typeof raw !== "string" || !SAFE_CODE.test(raw)) return "WORKER_UNEXPECTED";
  return SYSTEM_ERROR_CODE.test(raw) ? "WORKER_SYSTEM_ERROR" : raw;
}

export const codeOf = (error: unknown): string => normalizeCode((error as { code?: unknown } | null | undefined)?.code);

export function publicMessage(code: string): string {
  return PUBLIC_MESSAGES[code] ?? `The design worker stopped (${normalizeCode(code)}).`;
}

/** Codes that stop the whole run without counting against the job. */
export const ENVIRONMENT_CODES = new Set([
  "CODEX_NOT_INSTALLED",
  "CODEX_NOT_SIGNED_IN",
  "CODEX_API_KEY_AUTH",
  "CODEX_QUOTA",
  "CODEX_SANDBOX_UNAVAILABLE",
  "CODEX_SANDBOX_LEAK",
  "CODEX_SANDBOX_CONFIG",
  "WORKER_LOCK_FAILED",
  "WORKER_QUEUE_INVALID",
  "WORKER_BUILD_FAILED",
  "PREVIEW_SERVER_FAILED",
  "WORKER_RUN_TIME_BUDGET",
  "RUN_TIME_BUDGET",
  "WORKER_SYSTEM_ERROR",
]);
