import "server-only";
/**
 * DEV-196d (spec §6.2・§6.4 step 1・§6.8・§12 DEV-196d, ARCHITECTURE §9): the three server settings of the versioned
 * demo screens. Only the NAMES live in code; no value is registered anywhere by this change (no Vercel env, no
 * committed .env, no workflow). Every setting fails closed:
 *
 *  - SALES_DEMO_VERSIONS_ENABLED: exactly "true" turns the admin preview screens and the `/demo-frame/a/…` route on.
 *    Anything else (unset, "TRUE", "1", " true") is off: the screens answer 404, nothing queries the version tables,
 *    and the Today card, the React demo and sending stay exactly as before.
 *  - SALES_DEMO_VIEW_SIGNING_KEY: the HMAC key of the view tokens (view-token.ts), as base64 / base64url of at least
 *    32 random bytes (e.g. `openssl rand -base64 32`). Missing or malformed → no token is issued and the screen shows
 *    no frame and no render (it says the key is not set). The key itself is never logged or shown.
 *  - SALES_DEMO_ARTIFACT_ORIGIN: the dedicated artifact origin (§6.8). Unset → the admin preview is served from the
 *    app origin (the admin-only interim). Set but not a valid origin (empty included) → nothing is served.
 *
 * The environment is an argument (callers pass the process environment), so this module stays inside the library's
 * "reads no env" rule (tests/unit/sales/demo-version/purity.test.ts). `server-only`: the key must never reach a
 * client bundle.
 */
import { normaliseOrigin } from "./csp";
import { VIEW_TOKEN_MIN_KEY_BYTES } from "./view-token";

export const DEMO_VERSIONS_ENABLED_ENV = "SALES_DEMO_VERSIONS_ENABLED";
export const VIEW_SIGNING_KEY_ENV = "SALES_DEMO_VIEW_SIGNING_KEY";
export const ARTIFACT_ORIGIN_ENV = "SALES_DEMO_ARTIFACT_ORIGIN";

export type Env = Readonly<Record<string, string | undefined>>;

/** Strict: only the exact string "true". */
export function demoVersionsEnabled(env: Env): boolean {
  return env[DEMO_VERSIONS_ENABLED_ENV] === "true";
}

/** A key longer than this is not a key someone generated for this purpose. */
const MAX_KEY_TEXT = 512;
const BASE64_TEXT = /^[A-Za-z0-9+/_-]+={0,2}$/;

export type SigningKeyResult = { ok: true; key: Uint8Array } | { ok: false; reason: "missing" | "invalid" };

/**
 * The view-token key. Accepts canonical base64 or base64url (padding optional) decoding to ≥ 32 bytes. No trimming:
 * a value with spaces or a newline is refused, not guessed at.
 */
export function readViewSigningKey(env: Env): SigningKeyResult {
  const raw = env[VIEW_SIGNING_KEY_ENV];
  if (raw === undefined || raw === "") return { ok: false, reason: "missing" };
  if (raw.length > MAX_KEY_TEXT || !BASE64_TEXT.test(raw)) return { ok: false, reason: "invalid" };
  const bare = raw.replace(/=+$/, "");
  // mixing the two alphabets is not a value anyone generated
  if (/[+/]/.test(bare) && /[-_]/.test(bare)) return { ok: false, reason: "invalid" };
  const bytes = Buffer.from(bare.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  // one spelling per key: what decodes must encode back to the same text (no ignored trailing bits)
  if (bytes.toString("base64").replace(/=+$/, "") !== bare.replace(/-/g, "+").replace(/_/g, "/")) return { ok: false, reason: "invalid" };
  if (bytes.byteLength < VIEW_TOKEN_MIN_KEY_BYTES) return { ok: false, reason: "invalid" };
  return { ok: true, key: new Uint8Array(bytes) };
}

/** The key, or null (missing or invalid: issue no token). */
export function viewSigningKey(env: Env): Uint8Array | null {
  const r = readViewSigningKey(env);
  return r.ok ? r.key : null;
}

export type ArtifactOriginSetting = { kind: "unset" } | { kind: "set"; origin: string } | { kind: "invalid" };

/** §6.8: the dedicated artifact origin. An empty or malformed value is "invalid" (serve nothing), never "unset". */
export function artifactOrigin(env: Env): ArtifactOriginSetting {
  const raw = env[ARTIFACT_ORIGIN_ENV];
  if (raw === undefined) return { kind: "unset" };
  const origin = normaliseOrigin(raw);
  return origin === null ? { kind: "invalid" } : { kind: "set", origin };
}

export type DemoVersionsConfig =
  | { enabled: false }
  | { enabled: true; key: Uint8Array | null; keyProblem: "missing" | "invalid" | null; artifactOrigin: ArtifactOriginSetting };

/** Everything a screen or route needs to decide, read once. Off → nothing else is read. */
export function demoVersionsConfig(env: Env): DemoVersionsConfig {
  if (!demoVersionsEnabled(env)) return { enabled: false };
  const k = readViewSigningKey(env);
  return { enabled: true, key: k.ok ? k.key : null, keyProblem: k.ok ? null : k.reason, artifactOrigin: artifactOrigin(env) };
}
