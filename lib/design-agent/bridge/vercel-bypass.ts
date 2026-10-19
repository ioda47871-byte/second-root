/**
 * Vercel Protection Bypass for the local design bridge (DEV-059).
 * Design: docs/operations/design-bridge-access.md.
 *
 * The Staging bridge API sits behind Vercel Authentication. Instead of turning
 * Authentication off for each controlled run, the bridge may carry a dedicated
 * "Protection Bypass for Automation" secret (one created for the bridge only,
 * never the Operational Claude one) in the `x-vercel-protection-bypass` header.
 * The bypass only gets a request past Vercel's protection; the bridge API
 * still requires the bridge token.
 *
 * OFF by default: without both settings nothing is read and no header is
 * sent. When on:
 *   - the value comes from a file of this user only (regular file, not a link,
 *     owner = this user, no group / other bits, at most 512 bytes);
 *   - the header is sent only to one exact https origin on *.vercel.app, which
 *     must equal the bridge API URL's origin (so never to the Production custom
 *     domain or anywhere else);
 *   - redirects are never followed (the client uses `redirect: "error"`), so
 *     the header cannot be carried to another host;
 *   - the value is never logged or printed: errors carry fixed codes only.
 */
import { lstat, readFile } from "node:fs/promises";

export const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";
/** Vercel's secrets are 32 characters; anything visible, 16–256 characters, without spaces is accepted. */
const BYPASS_VALUE = /^[\x21-\x7e]{16,256}$/;
const MAX_FILE_BYTES = 512;

export type BypassCode = "BRIDGE_BYPASS_NOT_CONFIGURED" | "BRIDGE_BYPASS_UNSAFE";

export class BypassError extends Error {
  constructor(readonly code: BypassCode) {
    super(code);
  }
}

/** The one origin the header may go to, with the value. The value is never part of an error or a log line. */
export type VercelBypass = { readonly origin: string; readonly value: string };

/**
 * Checks the configured origin: exactly `https://<name>.vercel.app` (no port,
 * path, query, credentials or trailing slash), equal to the bridge API URL's
 * origin.
 */
export function bypassOrigin(configured: string, apiUrl: string): string {
  let url: URL;
  let api: URL;
  try {
    url = new URL(configured);
    api = new URL(apiUrl);
  } catch {
    throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    configured !== url.origin ||
    !/^[a-z0-9](?:[a-z0-9-]{0,251}[a-z0-9])?\.vercel\.app$/.test(host)
  ) {
    throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  }
  if (api.protocol !== "https:" || api.origin !== url.origin) throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  return url.origin;
}

/** Reads the bypass file: a regular file (no link) of this user, no group / other permission bits, one value. */
export async function readBypassFile(path: string, uid: number = process.getuid?.() ?? -1): Promise<string> {
  if (!path.startsWith("/")) throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  const info = await lstat(path).catch(() => null);
  if (!info) throw new BypassError("BRIDGE_BYPASS_NOT_CONFIGURED");
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size > MAX_FILE_BYTES) throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  }
  const value = text.trim();
  if (!BYPASS_VALUE.test(value)) throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  return value;
}

export type BypassSettings = {
  /** SR_DESIGN_BRIDGE_VERCEL_BYPASS_FILE */
  file?: string;
  /** SR_DESIGN_BRIDGE_VERCEL_BYPASS_ORIGIN */
  origin?: string;
  apiUrl: string;
  /** The bridge token: the bypass must be a different secret. */
  token: string;
  uid?: number;
};

/** null = off (neither setting). Both settings or neither; anything else stops with a fixed code. */
export async function loadVercelBypass(settings: BypassSettings): Promise<VercelBypass | null> {
  const file = settings.file ?? "";
  const origin = settings.origin ?? "";
  if (file === "" && origin === "") return null;
  if (file === "" || origin === "") throw new BypassError("BRIDGE_BYPASS_NOT_CONFIGURED");
  const checked = bypassOrigin(origin, settings.apiUrl);
  const value = await readBypassFile(file, settings.uid);
  // One secret per purpose: the bypass is never the bridge token.
  if (value === settings.token) throw new BypassError("BRIDGE_BYPASS_UNSAFE");
  return Object.freeze({ origin: checked, value });
}

/** The extra headers for one request: the bypass header only when the request URL's origin is exactly the configured one. */
export function bypassHeaders(bypass: VercelBypass | null | undefined, requestUrl: string): Record<string, string> {
  if (!bypass) return {};
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return {};
  }
  return origin === bypass.origin ? { [VERCEL_BYPASS_HEADER]: bypass.value } : {};
}
