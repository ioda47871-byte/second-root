import "server-only";
/**
 * DEV-196d-2 (spec §6.3・§6.4・§6.7・§6.8, SECURITY §12): the artifact route `/demo-frame/a/<view token>/<path>` — one
 * file of one demo version, for the admin preview only. Scope `p` (share) is not built: it is always the same 404.
 *
 * Every request is checked in this order, and any failure is the SAME 404 (same status, body and headers; no reason
 * is told, nothing is logged, and the token is never written anywhere):
 *
 *  1. the flag SALES_DEMO_VERSIONS_ENABLED is exactly "true", the view signing key is set, and this origin may serve
 *     scope `a` (§6.8: the app origin while no artifact origin is configured; a configured artifact origin is not
 *     served by this PR yet — fail closed until DEV-196g sets it up with its own approval);
 *  2. the token's shape, HMAC (constant time), expiry and scope (`a`, matching the path);
 *  5. the URL path maps to a manifest name (§5.2), with no query string and no percent-encoding;
 *  6. `Sec-Fetch-Dest` matches the file's role (checked before any database read; still the same 404);
 *  3. the database (service role): the version exists, belongs to the token's demo, is not revoked, its status is
 *     draft / approved / superseded and it is within expires_at; its demo is not disabled (disabled_at: an admin's
 *     decision or a DNC request — fail safe, the admin preview stops too, review of #247 L3);
 *     + every photo of the version has rights the admin preview allows now (§8.1 fail closed: one unusable image hides
 *     the whole version, the same rule as sales_demo_image_previewable and the screen's view model);
 *  5. the name is one of the version's files (the normalised copy of its manifest);
 *  7. the object is read from the private bucket and its size, sha256, UTF-8 / magic bytes, pixel size and metadata are
 *     checked against the manifest entry before a byte is returned.
 *
 * Cookies are never read (the route takes no cookie API, and proxy.ts's matcher does not include /demo-frame).
 */
import { ARTIFACT_LIMITS, checkFileBytes, roleOfName, urlPathToManifestName, type ArtifactContentType, type ArtifactRole } from "@/lib/sales/demo-version/manifest";
import { artifactResponseHeaders, fetchDestAllowed, servingOrigin } from "@/lib/sales/demo-version/csp";
import { demoVersionsConfig, type Env } from "@/lib/sales/demo-version/flags";
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

/** The reads the route needs. Each answers null / [] when there is nothing (or on any error). */
export interface FrameStore {
  version(id: string): Promise<FrameVersion | null>;
  /** the version's demo (disabled_at is set by an admin or by DNC) */
  demo(id: string): Promise<FrameDemo | null>;
  files(versionId: string): Promise<FrameFile[]>;
  images(ids: readonly string[]): Promise<FrameImage[]>;
  /** the object's bytes, or null (missing, larger than maxBytes, or any error) */
  object(key: string, maxBytes: number): Promise<Uint8Array | null>;
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

const PREFIX = "/demo-frame/a/";
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
export function splitFramePath(pathname: string): { token: string; urlPath: string } | null {
  if (typeof pathname !== "string" || !pathname.startsWith(PREFIX) || pathname.length > 600) return null;
  const rest = pathname.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { token: rest.slice(0, slash), urlPath: rest.slice(slash + 1) };
}

const asStatus = (s: string): VersionStatus | null => ((VERSION_STATUSES as readonly string[]).includes(s) ? (s as VersionStatus) : null);

/** Everything the route decides, with its reads injected. Never throws: anything unexpected is the same 404. */
export async function serveDemoFrame(req: FrameRequest, deps: { env: Env; now: Date; store: () => FrameStore }): Promise<Response> {
  try {
    return await decide(req, deps);
  } catch {
    return demoFrameNotFound();
  }
}

async function decide(req: FrameRequest, deps: { env: Env; now: Date; store: () => FrameStore }): Promise<Response> {
  // 1. the flag, the key and the serving origin
  const config = demoVersionsConfig(deps.env);
  if (!config.enabled || config.key === null) return demoFrameNotFound();
  if (req.method !== "GET") return demoFrameNotFound();
  // a configured artifact origin needs the app origin named for frame-ancestors (DEV-196g); until then: not served
  if (config.artifactOrigin.kind !== "unset") return demoFrameNotFound();
  const appOrigin = req.origin;
  const serving = servingOrigin({ scope: "a", requestOrigin: req.origin, appOrigin, artifactOrigin: null });
  if (serving === null) return demoFrameNotFound();

  // 5 (shape only). no query string at all; the path maps to a manifest name or nothing
  if (req.search !== "") return demoFrameNotFound();
  const split = splitFramePath(req.pathname);
  if (!split) return demoFrameNotFound();
  const name = urlPathToManifestName("a", split.urlPath);
  if (name === null) return demoFrameNotFound();
  const expected = roleOfName(name);
  if (!expected) return demoFrameNotFound();

  // 2. the token
  const verified = verifyViewToken({ token: split.token, pathScope: "a", now: deps.now, key: config.key });
  if (!verified.ok) return demoFrameNotFound();
  const { version_id: versionId, demo_id: demoId } = verified.payload;
  if (!UUID.test(versionId) || !UUID.test(demoId)) return demoFrameNotFound();

  // 6. what the browser is loading this for
  if (!fetchDestAllowed({ role: expected.role, scope: "a", secFetchDest: req.secFetchDest })) return demoFrameNotFound();

  // 3. the version, from the database (no cache: revocation takes effect on the next request)
  const store = deps.store();
  const v = await store.version(versionId);
  if (!v || v.id !== versionId || v.demo_id !== demoId) return demoFrameNotFound();
  const status = asStatus(v.status);
  const expiresAt = new Date(v.expires_at);
  if (status === null || Number.isNaN(expiresAt.getTime())) return demoFrameNotFound();
  const revokedAt = v.revoked_at === null ? null : new Date(v.revoked_at);
  if (!canAdminPreview({ id: v.id, demo_id: v.demo_id, status, revoked_at: revokedAt, expires_at: expiresAt }, deps.now)) return demoFrameNotFound();
  if (v.storage_prefix !== `v1/${v.demo_id}/${v.id}/`) return demoFrameNotFound();
  const demo = await store.demo(v.demo_id);
  if (!demo || demo.id !== v.demo_id || demo.disabled_at !== null) return demoFrameNotFound();

  // 5. the file is one of this version's files, with the role and type its name implies
  const files = await store.files(v.id);
  const entry = files.find((f) => f.path === name);
  if (!entry || entry.role !== expected.role || entry.content_type !== expected.contentType) return demoFrameNotFound();
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > ARTIFACT_LIMITS.fileBytes) return demoFrameNotFound();

  // 3+. every photo's rights allow the admin preview now (one unusable image hides the whole version)
  const photos = files.filter((f) => f.role === "photo");
  if (photos.some((p) => p.image_id === null)) return demoFrameNotFound();
  const images = photos.length ? await store.images([...new Set(photos.map((p) => p.image_id!))]) : [];
  const byId = new Map(images.map((i) => [i.id, i]));
  for (const p of photos) {
    const img = byId.get(p.image_id!);
    if (!img || img.sha256 !== p.sha256 || !effectiveRights(img, deps.now).previewable) return demoFrameNotFound();
  }

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

  const headers = artifactResponseHeaders({ role: expected.role, contentType: expected.contentType, scope: "a", servingOrigin: serving, appOrigin, token: split.token });
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
