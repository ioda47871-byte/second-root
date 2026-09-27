import { LIMITS } from "./types";

// Checkpoint content rules (docs/SECURITY.md §3.1): bounded size and no raw
// HTML, embedded images, secrets or tokens.

export type CheckpointProblem = "too_large" | "raw_html" | "embedded_data" | "secret";

const FORBIDDEN: Array<[RegExp, CheckpointProblem]> = [
  [/\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i, "embedded_data"],
  [/<\s*\/?\s*[a-z][a-z0-9-]*(\s+[a-z-]+\s*=|\s*\/?>)/i, "raw_html"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i, "secret"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, "secret"],
  [/\b(sb_secret_|sb_publishable_)[A-Za-z0-9_-]{16,}/, "secret"],
  [/\bsk-(ant-(api\d+-)?|proj-)[A-Za-z0-9_-]{20,}/, "secret"],
  [/\bsk-[A-Za-z0-9]{40,}/, "secret"],
  [/\bre_(?=[A-Za-z0-9_]*[A-Z0-9])[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}/, "secret"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "secret"],
  [/\bvercel_[A-Za-z0-9]{20,}/i, "secret"],
  [/postgres(ql)?:\/\/[^\s:/@]+:[^\s@]+@/i, "secret"],
  [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|ROLE_KEY|API_KEY)[A-Z0-9_]*\s*[=:]/, "secret"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "secret"],
];

export function checkpointBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function checkpointProblem(value: unknown, limit: number = LIMITS.checkpointBytes): CheckpointProblem | null {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > limit) return "too_large";
  for (const [pattern, problem] of FORBIDDEN) {
    if (pattern.test(json)) return problem;
  }
  return null;
}
