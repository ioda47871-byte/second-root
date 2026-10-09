import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { aiDesignEnabled } from "./design";

// Bearer auth of the bridge API (DEV-030). A token only for claiming design
// jobs and submitting their results; never the Operational Claude ingest
// token, and never given to the design worker (sr-designgen).

const MIN_TOKEN_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison; fails closed when the step or the token is not configured. */
export function authorizeBridge(header: string | null, env: Record<string, string | undefined>): "ok" | "disabled" | "unconfigured" | "denied" {
  if (!aiDesignEnabled(env)) return "disabled";
  const expected = env.SALES_DESIGN_BRIDGE_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return "unconfigured";
  // One secret per caller: a bridge token equal to the ingest token would let either caller act as the other.
  if (env.SALES_AGENT_INGEST_TOKEN && timingSafeEqual(digest(env.SALES_AGENT_INGEST_TOKEN), digest(expected))) return "unconfigured";
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  if (!match) return "denied";
  return timingSafeEqual(digest(match[1]), digest(expected)) ? "ok" : "denied";
}
