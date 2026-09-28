import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Meta webhook authentication (docs/INSTAGRAM_MESSAGING.md §7,
// .ai/research/meta-instagram-messaging-2026-09-27.md §3–4).
// The payload signature is `X-Hub-Signature-256: sha256=<hex>`: HMAC-SHA256
// of the RAW request body bytes with the app secret. The body must never be
// re-serialized before checking (Meta signs its own escaped JSON).

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/** Constant-time check of the signature header against the raw body. */
export function verifySignature(rawBody: Uint8Array, header: string | null, appSecret: string): boolean {
  const match = SIGNATURE.exec(header ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time comparison of the subscription verify token. */
export function verifyToken(given: string | null, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return given !== null && timingSafeEqual(digest(given), digest(expected));
}

export function sha256Hex(rawBody: Uint8Array): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
