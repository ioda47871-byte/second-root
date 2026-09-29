/**
 * Business Discovery PoC (DEV-028): can our own Instagram professional
 * account read a target's public profile through Meta's official API?
 *
 * Read-only check, run by hand on the WSL design user:
 *   npm run -s sales:design-worker -- meta-check --ig-user-id <our IG user id> --username <target>
 *
 * - API: Instagram API with Facebook Login (graph.facebook.com). Business
 *   Discovery is not available through Instagram Login, so this is a separate
 *   Meta App from the Messaging one (docs/INSTAGRAM_SETUP.md), which this
 *   code never touches.
 * - Token: a file only the worker user can read (default
 *   ~/.config/sr-design-worker/meta-token, 0600, owned by the user, not a
 *   link, outside the repository). It is sent only in the Authorization
 *   header of requests to the fixed Graph host — never in a URL, a child
 *   process, a log line or a report.
 * - Output: codes, and for a found target only field names and counts. No
 *   profile text, captions, URLs, usernames or Meta error messages.
 * - Nothing is downloaded or stored: no media, no profile data.
 */
import { createHmac } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { USERNAME } from "./source-url";

export const GRAPH_HOST = "https://graph.facebook.com";
export const DEFAULT_API_VERSION = "v26.0";
export const API_VERSION = /^v[1-9][0-9]\.0$/;
export const IG_USER_ID = /^[0-9]{5,25}$/;
const TOKEN = /^[A-Za-z0-9._|-]{20,2048}$/;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY = 1024 * 1024;

export const TARGET_FIELDS = [
  "username",
  "name",
  "biography",
  "website",
  "profile_picture_url",
  "followers_count",
  "follows_count",
  "media_count",
] as const;
export const MEDIA_FIELDS = ["id", "media_type", "media_url", "thumbnail_url", "caption", "permalink", "timestamp"] as const;
export const MEDIA_LIMIT = 12;

export type MetaCode =
  | "AUTH_OK"
  | "CALLER_OK"
  | "TARGET_FOUND"
  | "TARGET_UNSUPPORTED"
  | "CALLER_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  | "PERMISSION_ERROR"
  | "RATE_LIMITED"
  | "META_TRANSIENT_ERROR"
  | "META_UNKNOWN_ERROR";

export class MetaSetupError extends Error {
  constructor(readonly code: "TOKEN_FILE_MISSING" | "TOKEN_FILE_UNSAFE" | "TOKEN_FILE_INVALID" | "SECRET_FILE_UNSAFE") {
    super(code);
  }
}

/** Reads a secret file only if it is a private regular file of this user. */
export async function readSecretFile(path: string, kind: "token" | "secret", uid: number | undefined = process.getuid?.()): Promise<string> {
  const info = await lstat(path).catch(() => null);
  if (!info) throw new MetaSetupError(kind === "token" ? "TOKEN_FILE_MISSING" : "SECRET_FILE_UNSAFE");
  const unsafe = info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid) || info.size > 4096;
  if (unsafe) throw new MetaSetupError(kind === "token" ? "TOKEN_FILE_UNSAFE" : "SECRET_FILE_UNSAFE");
  const value = (await readFile(path, "utf8")).trim();
  if (!TOKEN.test(value)) throw new MetaSetupError(kind === "token" ? "TOKEN_FILE_INVALID" : "SECRET_FILE_UNSAFE");
  return value;
}

type GraphError = { code?: unknown; error_subcode?: unknown; is_transient?: unknown };

/** Maps a Graph API failure to a code. Only numbers are looked at, never the message. */
export function classifyGraphError(status: number, error: GraphError | undefined, stage: "auth" | "caller" | "target"): { code: MetaCode; graphCode: number | null; subcode: number | null } {
  const graphCode = typeof error?.code === "number" ? error.code : null;
  const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : null;
  const out = (code: MetaCode) => ({ code, graphCode, subcode });
  if (graphCode === 190) return out(subcode === 463 ? "TOKEN_EXPIRED" : "TOKEN_INVALID");
  if (graphCode === 102) return out("TOKEN_INVALID");
  if (graphCode === 4 || graphCode === 17 || graphCode === 32 || graphCode === 613 || (graphCode !== null && graphCode >= 80001 && graphCode <= 80014)) return out("RATE_LIMITED");
  if (graphCode === 10 || (graphCode !== null && graphCode >= 200 && graphCode <= 299)) return out("PERMISSION_ERROR");
  if (graphCode === 1 || graphCode === 2 || error?.is_transient === true || status >= 500) return out("META_TRANSIENT_ERROR");
  // "Cannot find User" for the target: missing, personal, or otherwise not discoverable.
  if (stage === "target" && (subcode === 2207013 || graphCode === 110)) return out("TARGET_UNSUPPORTED");
  if (stage === "caller" && (graphCode === 100 || graphCode === 110)) return out("CALLER_INVALID");
  return out("META_UNKNOWN_ERROR");
}

export interface MetaCheckOptions {
  token: string;
  /** Adds appsecret_proof when the app requires it. */
  appSecret?: string;
  igUserId: string;
  username: string;
  apiVersion?: string;
  /** Tests only: a local mock of the Graph host. Production uses GRAPH_HOST. */
  graphHost?: string;
  fetchImpl?: typeof fetch;
}

export type MetaCheckStep = { code: MetaCode; graphCode?: number | null; subcode?: number | null };

export type MetaCheckResult = {
  steps: MetaCheckStep[];
  final: MetaCode;
  /** Only for TARGET_FOUND: which fields came back (names only) and media counts. */
  target?: {
    fields: string[];
    media: number;
    mediaFields: string[];
    mediaWithUrl: number;
    mediaTypes: Record<string, number>;
  };
};

async function graphGet(options: MetaCheckOptions, path: string, fields: string): Promise<{ status: number; body: Record<string, unknown> | null } | "NETWORK"> {
  const host = options.graphHost ?? GRAPH_HOST;
  const version = options.apiVersion ?? DEFAULT_API_VERSION;
  const params = new URLSearchParams({ fields });
  if (options.appSecret) params.set("appsecret_proof", createHmac("sha256", options.appSecret).update(options.token).digest("hex"));
  try {
    const res = await (options.fetchImpl ?? fetch)(`${host}/${version}/${path}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${options.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, MAX_BODY);
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return "NETWORK";
  }
}

export async function runMetaCheck(options: MetaCheckOptions): Promise<MetaCheckResult> {
  if (!IG_USER_ID.test(options.igUserId) || !USERNAME.test(options.username) || (options.apiVersion !== undefined && !API_VERSION.test(options.apiVersion))) {
    throw new Error("invalid meta-check input");
  }
  const steps: MetaCheckStep[] = [];
  const fail = (stage: "auth" | "caller" | "target", r: Awaited<ReturnType<typeof graphGet>>): MetaCheckResult => {
    const step: MetaCheckStep =
      r === "NETWORK" ? { code: "META_TRANSIENT_ERROR" } : classifyGraphError(r.status, (r.body?.error ?? undefined) as GraphError | undefined, stage);
    steps.push(step);
    return { steps, final: step.code };
  };

  // 1. the token works at all
  const me = await graphGet(options, "me", "id");
  if (me === "NETWORK" || me.status !== 200 || typeof me.body?.id !== "string") return fail("auth", me);
  steps.push({ code: "AUTH_OK" });

  // 2. our own IG professional account is reachable with this token
  const caller = await graphGet(options, options.igUserId, "id");
  if (caller === "NETWORK" || caller.status !== 200 || caller.body?.id !== options.igUserId) return fail("caller", caller);
  steps.push({ code: "CALLER_OK" });

  // 3. Business Discovery for the target (metadata only)
  const fields = `business_discovery.username(${options.username}){${TARGET_FIELDS.join(",")},media.limit(${MEDIA_LIMIT}){${MEDIA_FIELDS.join(",")}}}`;
  const target = await graphGet(options, options.igUserId, fields);
  if (target === "NETWORK" || target.status !== 200) return fail("target", target);
  const discovered = target.body?.business_discovery as Record<string, unknown> | undefined;
  if (!discovered || typeof discovered !== "object") {
    steps.push({ code: "TARGET_UNSUPPORTED" });
    return { steps, final: "TARGET_UNSUPPORTED" };
  }
  const media = ((discovered.media as { data?: unknown } | undefined)?.data ?? []) as Array<Record<string, unknown>>;
  const items = Array.isArray(media) ? media.filter((m) => m && typeof m === "object") : [];
  const mediaFields = new Set<string>();
  const mediaTypes: Record<string, number> = {};
  for (const item of items) {
    for (const key of Object.keys(item)) if ((MEDIA_FIELDS as readonly string[]).includes(key)) mediaFields.add(key);
    const type = typeof item.media_type === "string" && /^[A-Z_]{1,20}$/.test(item.media_type) ? item.media_type : "OTHER";
    mediaTypes[type] = (mediaTypes[type] ?? 0) + 1;
  }
  steps.push({ code: "TARGET_FOUND" });
  return {
    steps,
    final: "TARGET_FOUND",
    target: {
      fields: Object.keys(discovered)
        .filter((k) => (TARGET_FIELDS as readonly string[]).includes(k) || k === "media")
        .sort(),
      media: items.length,
      mediaFields: [...mediaFields].sort(),
      mediaWithUrl: items.filter((m) => typeof m.media_url === "string").length,
      mediaTypes,
    },
  };
}

/** The lines meta-check prints. Codes, numbers and field names only. */
export function formatMetaCheck(result: MetaCheckResult): string[] {
  const lines = result.steps.map((s) =>
    s.graphCode !== undefined && s.graphCode !== null ? `${s.code} (graph code ${s.graphCode}${s.subcode ? `, subcode ${s.subcode}` : ""})` : s.code,
  );
  if (result.target) {
    const t = result.target;
    lines.push(`  fields: ${t.fields.join(", ") || "-"}`);
    lines.push(`  media: ${t.media} (media_url on ${t.mediaWithUrl}; types ${Object.entries(t.mediaTypes).map(([k, v]) => `${k} ${v}`).join(", ") || "-"})`);
    lines.push(`  media fields: ${t.mediaFields.join(", ") || "-"}`);
  }
  return lines;
}
