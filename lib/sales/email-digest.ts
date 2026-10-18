import { createHash } from "node:crypto";

// DEV-050: the only form in which an email is kept for the exclusion check.
// SHA-256 over a fixed, versioned prefix + the normalised email (normalizeEmail).
// The prefix (domain separation) keeps these digests from matching generic
// precomputed sha256(email) tables. It does not stop someone who can read the
// admin-only rows from confirming a guessed address (an unsalted, unkeyed
// hash); a keyed HMAC with a server secret is the next step and needs human
// approval (docs/ARCHITECTURE.md, sales_exclusions). Server-side only.
// The SQL fallback in sales_persist_candidate builds the same value.

export const EMAIL_DIGEST_PREFIX = "second-root/exclusion-email/v1\n";
export const EMAIL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function emailDigest(normalizedEmail: string): string {
  return createHash("sha256").update(EMAIL_DIGEST_PREFIX + normalizedEmail, "utf8").digest("hex");
}
