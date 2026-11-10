/**
 * DEV-196b (spec §6.2・§6.4 step 2・§6.6・T7・T19, owner decision 2026-11-10): the short-lived view token in the
 * artifact route's path, `/demo-frame/<scope>/<token>/<path>`.
 *
 *   token   = base64url(payload) "." base64url(HMAC-SHA256(key, DOMAIN || base64url(payload)))
 *   payload = {"v":1,"scope":"a"|"p","version_id":uuid,"demo_id":uuid,"exp":unix seconds}
 *
 * Scope `a` (admin preview) lives 15 minutes, scope `p` (share) 30 minutes. A token is bound to its scope: the scope
 * in the path must equal the scope in the payload. A token whose exp is further away than its scope's lifetime is
 * refused too (no long-lived token even with the key). Revocation is NOT in the token: the route checks the DB on
 * every request (§6.4 step 3–4). Rotating the key invalidates every issued token.
 *
 * The key is an argument (≥ 32 bytes). This module never reads the environment.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ViewScope } from "./manifest";

export const VIEW_TOKEN_TTL_SECONDS: Readonly<Record<ViewScope, number>> = { a: 15 * 60, p: 30 * 60 };
export const VIEW_TOKEN_MIN_KEY_BYTES = 32;
/** Clock skew tolerated between the signer and the verifier on the lifetime cap only (never on expiry). */
export const VIEW_TOKEN_SIGNER_SKEW_SECONDS = 5;
export const VIEW_TOKEN_MAX_LENGTH = 400;
/** Domain separation: an HMAC made with the same key for another purpose cannot be replayed as a view token. */
const DOMAIN = "second-root/demo-view-token/v1.";
/** The shape of a token in a URL path segment (also what a CSP may carry: no quote, space, semicolon or comma). */
export const VIEW_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,300}\.[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ViewTokenPayload = { v: 1; scope: ViewScope; version_id: string; demo_id: string; exp: number };

export type ViewTokenFailure = "TOKEN_MALFORMED" | "TOKEN_BAD_SIGNATURE" | "TOKEN_EXPIRED" | "TOKEN_SCOPE_MISMATCH" | "TOKEN_LIFETIME_TOO_LONG";
/** The route answers every failure with the same 404; the reason is for tests and internal counters only. */
export type ViewTokenResult = { ok: true; payload: ViewTokenPayload } | { ok: false; reason: ViewTokenFailure };

function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength < VIEW_TOKEN_MIN_KEY_BYTES) throw new Error("view token key must be at least 32 bytes");
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const mac = (key: Uint8Array, payloadB64: string) => createHmac("sha256", key).update(DOMAIN).update(payloadB64).digest();

export function signViewToken(o: { scope: ViewScope; versionId: string; demoId: string; now: Date; key: Uint8Array }): string {
  checkKey(o.key);
  if (o.scope !== "a" && o.scope !== "p") throw new Error("view token scope must be a or p");
  if (!UUID.test(o.versionId) || !UUID.test(o.demoId)) throw new Error("view token ids must be lowercase uuids");
  const exp = Math.floor(o.now.getTime() / 1000) + VIEW_TOKEN_TTL_SECONDS[o.scope];
  // fixed key order: the payload bytes are canonical
  const payload: ViewTokenPayload = { v: 1, scope: o.scope, version_id: o.versionId, demo_id: o.demoId, exp };
  const p = b64url(JSON.stringify(payload));
  return `${p}.${b64url(mac(o.key, p))}`;
}

/**
 * Verifies a token from the path against the scope of the path (`/demo-frame/<pathScope>/…`). Constant-time on the
 * signature; the payload is parsed only after the signature matched.
 */
export function verifyViewToken(o: { token: string; pathScope: ViewScope; now: Date; key: Uint8Array }): ViewTokenResult {
  checkKey(o.key);
  if (typeof o.token !== "string" || o.token.length > VIEW_TOKEN_MAX_LENGTH || !VIEW_TOKEN_SHAPE.test(o.token)) return { ok: false, reason: "TOKEN_MALFORMED" };
  const [p, s] = o.token.split(".") as [string, string];
  const given = Buffer.from(s, "base64url");
  // a non-canonical encoding (trailing bits) of the same bytes is refused, so one token has one spelling
  if (given.length !== 32 || given.toString("base64url") !== s) return { ok: false, reason: "TOKEN_MALFORMED" };
  if (!timingSafeEqual(given, mac(o.key, p))) return { ok: false, reason: "TOKEN_BAD_SIGNATURE" };
  const raw = Buffer.from(p, "base64url");
  if (raw.toString("base64url") !== p) return { ok: false, reason: "TOKEN_MALFORMED" };
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, reason: "TOKEN_MALFORMED" };
  }
  if (!isPayload(payload)) return { ok: false, reason: "TOKEN_MALFORMED" };
  if (payload.scope !== o.pathScope) return { ok: false, reason: "TOKEN_SCOPE_MISMATCH" };
  const now = Math.floor(o.now.getTime() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "TOKEN_EXPIRED" };
  // a signer a few seconds ahead must not break a fresh token (review round 1 L2); expiry itself stays strict
  if (payload.exp - now > VIEW_TOKEN_TTL_SECONDS[payload.scope] + VIEW_TOKEN_SIGNER_SKEW_SECONDS) return { ok: false, reason: "TOKEN_LIFETIME_TOO_LONG" };
  return { ok: true, payload };
}

function isPayload(x: unknown): x is ViewTokenPayload {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  return (
    keys === "demo_id,exp,scope,v,version_id" &&
    o.v === 1 &&
    (o.scope === "a" || o.scope === "p") &&
    typeof o.version_id === "string" &&
    UUID.test(o.version_id) &&
    typeof o.demo_id === "string" &&
    UUID.test(o.demo_id) &&
    typeof o.exp === "number" &&
    Number.isSafeInteger(o.exp) &&
    o.exp > 0
  );
}
