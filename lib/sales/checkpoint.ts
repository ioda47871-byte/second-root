import { LIMITS } from "./types";

// Checkpoint content rules (docs/SECURITY.md §3.1): bounded size and no raw
// HTML, embedded images, secrets or tokens.

const FORBIDDEN: Array<[RegExp, string]> = [
  [/<\s*(html|body|script|style|iframe|div|img)\b/i, "raw_html"],
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,/i, "embedded_data"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/, "secret"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, "secret"],
  [/\b(sb_secret_|sk-ant-|sk-)[A-Za-z0-9_-]{20,}/, "secret"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "secret"],
];

export function checkpointBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export type CheckpointProblem = "too_large" | "raw_html" | "embedded_data" | "secret";

export function checkpointProblem(value: unknown, limit: number = LIMITS.checkpointBytes): CheckpointProblem | null {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > limit) return "too_large";
  for (const [pattern, problem] of FORBIDDEN) {
    if (pattern.test(json)) return problem as CheckpointProblem;
  }
  return null;
}
