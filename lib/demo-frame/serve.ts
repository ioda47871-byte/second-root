import "server-only";
/**
 * DEV-196d-2 (spec §6.3・§6.4・§6.7・§6.8, SECURITY §12): the artifact routes — one file of one demo version.
 *  - scope `a` `/demo-frame/a/<view token>/<path>`: the admin preview (DEV-196d-2).
 *  - scope `p` `/demo-frame/p/<view token>/<path>`: the share page's frame (DEV-196g), only from the dedicated artifact
 *    origin, only the version a `sent` approval pinned (the database's sales_resolve_demo_share decides), only with
 *    shareable rights now, and never renders.
 *
 * Every request is checked in this order, and any failure is the SAME 404 (same status, body and headers; no reason
 * is told, nothing is logged, and the token is never written anywhere):
 *
 *  1. the flags and settings, and that this origin may serve the scope (§6.8):
 *     - `a`: SALES_DEMO_VERSIONS_ENABLED is exactly "true", the view signing key is set; served from the APP origin
 *       (the admin-only interim, spec §6.8: also while an artifact origin is configured for sharing — moving the admin
 *       preview to that origin is a later step); a malformed artifact origin serves nothing; a request that arrives on
 *       the configured artifact origin is refused (that origin serves only scope `p`);
 *     - `p`: SALES_DEMO_SHARE_ENABLED too (flags.ts demoShareConfig: key, artifact origin and app origin all valid and
 *       different), and the request came to the artifact origin;
 *  2. the token's shape, HMAC (constant time), expiry and scope (matching the path);
 *  5. the URL path maps to a manifest name (§5.2), with no query string and no percent-encoding (scope `p`: no renders);
 *  6. `Sec-Fetch-Dest` matches the file's role (scope `p` HTML: only an iframe) — before any database read;
 *  3. the database (service role): the version exists, belongs to the token's demo, is not revoked; its demo is not
 *     disabled; scope `a`: draft / approved / superseded within expires_at, every photo previewable now;
 *  4. scope `p`: sales_resolve_demo_share for the demo's share token answers exactly this version (the demo is public,
 *     every sent approval pinned this one version, the database switch is on, the version is shareable — rights
 *     re-derived), and every photo is shareable now in this process too (§8.3: no AI image; photos not yet at all);
 *  5. the name is one of the version's files (the normalised copy of its manifest);
 *  7. the object is read from the private bucket and its size, sha256, UTF-8 / magic bytes, pixel size and metadata are
 *     checked against the manifest entry before a byte is returned.
 *
 * Cookies are never read (the route takes no cookie API, and proxy.ts's matcher does not include /demo-frame).
 */
import { ARTIFACT_LIMITS, checkFileBytes, roleOfName, urlPathToManifestName, type ArtifactContentType, type ArtifactRole, type ViewScope } from "@/lib/sales/demo-version/manifest";
import { artifactResponseHeaders, fetchDestAllowed, servingOrigin } from "@/lib/sales/demo-version/csp";
import { demoShareConfig, demoVersionsConfig, type Env } from "@/lib/sales/demo-version/flags";
import { shareEligible, type RightsStatus } from "@/lib/sales/demo-version/rights";
import { canAdminPreview, VERSION_STATUSES, type VersionStatus } from "@/lib/sales/demo-version/version-state";
import { verifyViewToken } from "@/lib/sales/demo-version/view-token";
import { effectiveRights } from "@/lib/sales/demo-version/view-model";

export const DEMO_FRAME_BUCKET = "sales-demo-versions";

/** The one 404 every refusal answers with. A new Response each time; the content never varies. */
export function demoFrameNotFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

export type FrameVersion = { id: string; demo_id: string; status: string; revoked_at: string | null; expires_at: string; storage_prefix: string };
export type FrameFile = { path: string; role: string; sha256: string; bytes: number; content_type: string; width: number | null; height: number | null; image_id: string | null };
export type FrameDemo = { id: string; disabled_at: string | null };
export type FrameImage = { id: string; sha256: string; rights_status: string; rights_expiry: string | null; revoked_at: string | null };
/** sales_resolve_demo_share's answer for a demo (null: could not be read) */
export type FrameShare = { mode: string; version_id?: string };

/** The reads the route needs. Each answers null / [] when there is nothing (or on any error). */
export interface FrameStore {
  version(id: string): Promise<FrameVersion | null>;
  /** the version's demo (disabled_at is set by an admin or by DNC) */
  demo(id: string): Promise<FrameDemo | null>;
  files(versionId: string): Promise<FrameFile[]>;
  images(ids: readonly string[]): Promise<FrameImage[]>;
  /** the object's bytes, or null (missing, larger than maxBytes, or any error) */
  object(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** DEV-196g: what the demo's share URL may show now (sales_resolve_demo_share of its public token). Missing → scope p serves nothing. */
  share?(demoId: string): Promise<FrameShare | null>;
}

export type FrameRequest = {
  method: string;
  /** the raw (still percent-encoded) path of the request URL */
  pathname: string;
  /** the raw query string including "?", or "" */
  search: string;
  /** the request's own origin (scheme + host as the browser sent it) */
  origin: string;
  secFetchDest: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The origin the browser asked for: `Host` and the forwarded protocol (Vercel sets `x-forwarded-proto`; `next start`
 * reports its own configured hostname in nextUrl, which can differ from what the browser used — e.g. localhost vs
 * 127.0.0.1 — and would make `frame-ancestors` refuse the real parent). The value only shapes this one, uncached
 * response; servingOrigin / normaliseOrigin still refuse anything that is not a plain https (or local http) origin.
 * Returns "" when it cannot be told (→ 404).
 */
export function requestOrigin(o: { host: string | null; forwardedProto: string | null; urlProtocol: string }): string {
  const proto = o.forwardedProto ?? o.urlProtocol.replace(/:$/, "");
  if (proto !== "https" && proto !== "http") return "";
  if (!o.host || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o.host)) return "";
  return `${proto}://${o.host.toLowerCase()}`;
}

/** The token and the path after it, or null. Taken from the raw path, so an encoded "/" or "%" never gets through. */
export function splitFramePath(pathname: string, scope: ViewScope = "a"): { token: string; urlPath: string } | null {
  const prefix = `/demo-frame/${scope}/`;
  if (typeof pathname !== "string" || !pathname.startsWith(prefix) || pathname.length > 600) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { token: rest.slice(0, slash), urlPath: rest.slice(slash + 1) };
}

const asStatus = (s: string): VersionStatus | null => ((VERSION_STATUSES as readonly string[]).includes(s) ? (s as VersionStatus) : null);

type Deps = { env: Env; now: Date; store: () => FrameStore };

/** Everything the route decides, with its reads injected. Never throws: anything unexpected is the same 404. */
export async function serveDemoFrame(req: FrameRequest, deps: Deps, scope: ViewScope = "a"): Promise<Response> {
  try {
    if (scope !== "a" && scope !== "p") return demoFrameNotFound();
    return await decide(req, deps, scope);
  } catch {
    return demoFrameNotFound();
  }
}

/** Step 1: the key, the app origin named in frame-ancestors and the origin serving this request, or null (404). */
function settings(req: FrameRequest, env: Env, scope: ViewScope): { key: Uint8Array; appOrigin: string; serving: string } | null {
  if (scope === "p") {
    const share = demoShareConfig(env);
    if (!share.enabled || !share.ready) return null;
    const serving = servingOrigin({ scope: "p", requestOrigin: req.origin, appOrigin: share.appOrigin, artifactOrigin: share.artifactOrigin });
    return serving === null ? null : { key: share.key, appOrigin: share.appOrigin, serving };
  }
  const config = demoVersionsConfig(env);
  if (!config.enabled || config.key === null) return null;
  // a malformed artifact origin serves nothing; the configured artifact origin serves only scope p
  if (config.artifactOrigin.kind === "invalid") return null;
  if (config.artifactOrigin.kind === "set" && req.origin === config.artifactOrigin.origin) return null;
  // the admin-only interim (§6.8): the app origin, i.e. the origin the request came to
  const serving = servingOrigin({ scope: "a", requestOrigin: req.origin, appOrigin: req.origin, artifactOrigin: null });
  return serving === null ? null : { key: config.key, appOrigin: req.origin, serving };
}

async function decide(req: FrameRequest, deps: Deps, scope: ViewScope): Promise<Response> {
  // 1. the flags, the key and the serving origin
  const s = settings(req, deps.env, scope);
  if (!s) return demoFrameNotFound();
  if (req.method !== "GET") return demoFrameNotFound();

  // 5 (shape only). no query string at all; the path maps to a manifest name or nothing
  if (req.search !== "") return demoFrameNotFound();
  const split = splitFramePath(req.pathname, scope);
  if (!split) return demoFrameNotFound();
  const name = urlPathToManifestName(scope, split.urlPath);
  if (name === null) return demoFrameNotFound();
  const expected = roleOfName(name);
  if (!expected) return demoFrameNotFound();
  if (scope === "p" && expected.role === "render") return demoFrameNotFound();

  // 2. the token
  const verified = verifyViewToken({ token: split.token, pathScope: scope, now: deps.now, key: s.key });
  if (!verified.ok) return demoFrameNotFound();
  const { version_id: versionId, demo_id: demoId } = verified.payload;
  if (!UUID.test(versionId) || !UUID.test(demoId)) return demoFrameNotFound();

  // 6. what the browser is loading this for
  if (!fetchDestAllowed({ role: expected.role, scope, secFetchDest: req.secFetchDest })) return demoFrameNotFound();

  // 3. the version, from the database (no cache: revocation takes effect on the next request)
  const store = deps.store();
  const v = await store.version(versionId);
  if (!v || v.id !== versionId || v.demo_id !== demoId) return demoFrameNotFound();
  const status = asStatus(v.status);
  const expiresAt = new Date(v.expires_at);
  if (status === null || Number.isNaN(expiresAt.getTime())) return demoFrameNotFound();
  const revokedAt = v.revoked_at === null ? null : new Date(v.revoked_at);
  if (revokedAt !== null) return demoFrameNotFound();
  if (scope === "a" && !canAdminPreview({ id: v.id, demo_id: v.demo_id, status, revoked_at: revokedAt, expires_at: expiresAt }, deps.now)) return demoFrameNotFound();
  if (v.storage_prefix !== `v1/${v.demo_id}/${v.id}/`) return demoFrameNotFound();
  const demo = await store.demo(v.demo_id);
  if (!demo || demo.id !== v.demo_id || demo.disabled_at !== null) return demoFrameNotFound();

  // 4. scope p: the database's share decision names exactly this version (no other version, no React fallback)
  if (scope === "p") {
    const share = store.share ? await store.share(v.demo_id) : null;
    if (!share || share.mode !== "version" || share.version_id !== v.id) return demoFrameNotFound();
  }

  // 5. the file is one of this version's files, with the role and type its name implies
  const files = await store.files(v.id);
  const entry = files.find((f) => f.path === name);
  if (!entry || entry.role !== expected.role || entry.content_type !== expected.contentType) return demoFrameNotFound();
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > ARTIFACT_LIMITS.fileBytes) return demoFrameNotFound();

  // 3+ / 4+. every photo's rights now (one unusable image hides the whole version): previewable (a) / shareable (p)
  const photos = files.filter((f) => f.role === "photo");
  if (photos.some((p) => p.image_id === null)) return demoFrameNotFound();
  const images = photos.length ? await store.images([...new Set(photos.map((p) => p.image_id!))]) : [];
  const byId = new Map(images.map((i) => [i.id, i]));
  const rights: RightsStatus[] = [];
  for (const p of photos) {
    const img = byId.get(p.image_id!);
    if (!img || img.sha256 !== p.sha256) return demoFrameNotFound();
    const r = effectiveRights(img, deps.now);
    if (!r.previewable) return demoFrameNotFound();
    rights.push(r.status);
  }
  if (scope === "p" && !shareEligible(rights)) return demoFrameNotFound();

  // 7. the bytes, checked against the manifest entry
  const bytes = await store.object(`${v.storage_prefix}${name}`, entry.bytes);
  if (!bytes) return demoFrameNotFound();
  const checked = checkFileBytes(
    {
      name,
      role: entry.role as ArtifactRole,
      sha256: entry.sha256,
      bytes: entry.bytes,
      content_type: entry.content_type as ArtifactContentType,
      ...(entry.width !== null ? { width: entry.width } : {}),
      ...(entry.height !== null ? { height: entry.height } : {}),
    },
    bytes,
  );
  if (!checked.ok) return demoFrameNotFound();

  const headers = artifactResponseHeaders({ role: expected.role, contentType: expected.contentType, scope, servingOrigin: s.serving, appOrigin: s.appOrigin, token: split.token });
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
