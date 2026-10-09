import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { aiDesignEnabled } from "./design";

// Bearer auth of the bridge API (DEV-030; hash-only since DEV-032). The
// server never holds the bridge token itself: it holds only the SHA-256 of
// it (SALES_DESIGN_BRIDGE_TOKEN_SHA256, 64 hex digits). The raw token lives
// only in the 0600 file of the local bridge user (sr-designbridge). It is a
// token for claiming design jobs and submitting their results only; never
// the Operational Claude ingest token, and never given to the design worker.
//
// Fails closed (503): the step off, the digest missing or malformed, a raw
// SALES_DESIGN_BRIDGE_TOKEN configured on the server (it must not be there),
// or the digest equal to the ingest token's (one secret per caller).

export const BRIDGE_TOKEN_SHA256 = /^[0-9a-f]{64}$/;
/** What a bridge token looks like: 32–512 visible ASCII characters. */
const BRIDGE_TOKEN = /^[\x21-\x7e]{32,512}$/;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export type BridgeAuth = "ok" | "disabled" | "unconfigured" | "denied";

export function authorizeBridge(header: string | null, env: Record<string, string | undefined>): BridgeAuth {
  if (!aiDesignEnabled(env)) return "disabled";
  if (env.SALES_DESIGN_BRIDGE_TOKEN !== undefined && env.SALES_DESIGN_BRIDGE_TOKEN !== "") return "unconfigured";
  const configured = (env.SALES_DESIGN_BRIDGE_TOKEN_SHA256 ?? "").trim().toLowerCase();
  if (!BRIDGE_TOKEN_SHA256.test(configured)) return "unconfigured";
  const expected = Buffer.from(configured, "hex");
  // A bridge token equal to the ingest token would let either caller act as the other.
  if (env.SALES_AGENT_INGEST_TOKEN && timingSafeEqual(digest(env.SALES_AGENT_INGEST_TOKEN), expected)) return "unconfigured";
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  if (!match || !BRIDGE_TOKEN.test(match[1]!)) return "denied";
  // The configured value is the token itself (a 64-hex token pasted as its own digest):
  // the raw token is on the server, which is a configuration error, not a wrong token.
  if (BRIDGE_TOKEN_SHA256.test(match[1]!.toLowerCase()) && timingSafeEqual(Buffer.from(match[1]!.toLowerCase(), "hex"), expected)) return "unconfigured";
  return timingSafeEqual(digest(match[1]!), expected) ? "ok" : "denied";
}
