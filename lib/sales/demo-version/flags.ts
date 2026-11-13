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
/**
 * DEV-196k (owner decision 2026-11-11, item 5): the quality-review WRITES have their own flag — approve, send back,
 * reject, withdraw, revoke and urgent revoke. Strict "true", default off, and it needs the preview flag too
 * (SALES_DEMO_VERSIONS_ENABLED alone is preview only: the pages, /demo-frame/a, compare, the Today badge).
 * Not to be enabled on Staging before DEV-196f.
 */
export const QUALITY_REVIEW_ENABLED_ENV = "SALES_DEMO_QUALITY_REVIEW_ENABLED";
export const VIEW_SIGNING_KEY_ENV = "SALES_DEMO_VIEW_SIGNING_KEY";
export const ARTIFACT_ORIGIN_ENV = "SALES_DEMO_ARTIFACT_ORIGIN";

export type Env = Readonly<Record<string, string | undefined>>;

/** Strict: only the exact string "true". Preview only (DEV-196k): reading, never writing. */
export function demoVersionsEnabled(env: Env): boolean {
  return env[DEMO_VERSIONS_ENABLED_ENV] === "true";
}

/** DEV-196k: every quality-review write. Strict "true" AND the preview flag. */
export function demoQualityReviewEnabled(env: Env): boolean {
  return demoVersionsEnabled(env) && env[QUALITY_REVIEW_ENABLED_ENV] === "true";
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

/**
 * DEV-196g (spec §6.4 step 1・§6.8・§12): versioned SHARING has its own flag. Strict "true", default off, and it needs
 * the preview flag too. Off → `/demo/[publicToken]` is exactly what it was before DEV-196g (the React demo; the share
 * resolver is not even called) and `/demo-frame/p/…` is the same 404 as every refusal. It is one half of the switch:
 * the database's sales_demo_share_settings (owner-only) must be on as well, or the resolver never answers "version".
 * With this flag off, a demo whose sent approval pinned a version is 404 (never the React demo instead; PR #267 M1), and
 * the app refuses versioned send approvals.
 *
 * Changing this flag, SALES_DEMO_ARTIFACT_ORIGIN or SALES_DEMO_APP_ORIGIN needs a REDEPLOY (PR #267 L5): the share
 * page's `frame-src` is a build-time header (next.config.ts). Until the redeploy the old header stays.
 */
export const SHARE_ENABLED_ENV = "SALES_DEMO_SHARE_ENABLED";
/**
 * DEV-196g (§6.7・§6.8): the app's own origin, named in the shared artifact's `frame-ancestors` (the artifact origin
 * serves the document; only the app's share page may frame it). Required for sharing; unset / malformed / equal to the
 * artifact origin → nothing is shared (fail closed).
 */
export const APP_ORIGIN_ENV = "SALES_DEMO_APP_ORIGIN";

/** Strict "true" for both the preview flag and the share flag. */
export function demoShareEnabled(env: Env): boolean {
  return demoVersionsEnabled(env) && env[SHARE_ENABLED_ENV] === "true";
}

export type DemoShareConfig =
  | { enabled: false }
  /** the flag is on but the key / artifact origin / app origin is missing or wrong: serve no version (never the React demo instead) */
  | { enabled: true; ready: false }
  | { enabled: true; ready: true; key: Uint8Array; artifactOrigin: string; appOrigin: string };

/** Everything sharing needs, read once. Fails closed: a version is served only when every setting is valid. */
export function demoShareConfig(env: Env): DemoShareConfig {
  if (!demoShareEnabled(env)) return { enabled: false };
  const key = viewSigningKey(env);
  const art = artifactOrigin(env);
  const app = normaliseOrigin(env[APP_ORIGIN_ENV] ?? null);
  if (!key || art.kind !== "set" || app === null || app === art.origin) return { enabled: true, ready: false };
  return { enabled: true, ready: true, key, artifactOrigin: art.origin, appOrigin: app };
}
