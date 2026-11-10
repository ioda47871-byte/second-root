/**
 * DEV-196b (spec §6.7・§6.8・T1・T3・T12・T13・T23, owner decision 2026-11-10): the response headers of the artifact
 * route `/demo-frame/{a|p}/<token>/<path>`, the HTML's CSP (with the `sandbox` directive), the `frame-src` of the
 * trusted outer pages, and which origin may serve which scope.
 *
 * Pure: origins and the token are arguments; nothing is read from the environment.
 */
import type { ArtifactRole, ViewScope } from "./manifest";
import { VIEW_TOKEN_SHAPE } from "./view-token";

/**
 * An origin the headers may name: `https://host[:port]`, or `http://localhost|127.0.0.1[:port]` for local runs and CI.
 * Returns the normalised origin, or null (the caller then serves nothing: 404).
 */
export function normaliseOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
  if (u.origin !== raw.replace(/\/$/, "")) return null;
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.origin;
  return null;
}

/**
 * §6.8: where a scope may be served.
 * - scope `p` (share) only from a configured artifact origin that differs from the app origin; without one → not served
 *   (T23: the share route is 404 until the DNS / Vercel setup is approved).
 * - scope `a` (admin preview) from the artifact origin once there is one; until then, from the app origin
 *   (the admin-only interim: cookie-free route + CSP sandbox + iframe sandbox).
 * Returns the origin that serves this request, or null (404).
 */
export function servingOrigin(o: { scope: ViewScope; requestOrigin: string; appOrigin: string; artifactOrigin: string | null }): string | null {
  const app = normaliseOrigin(o.appOrigin);
  const req = normaliseOrigin(o.requestOrigin);
  const art = o.artifactOrigin === null ? null : normaliseOrigin(o.artifactOrigin);
  if (!app || !req) return null;
  if (o.artifactOrigin !== null && (!art || art === app)) return null; // misconfigured: fail closed
  if (o.scope === "p") return art !== null && req === art ? art : null;
  const expected = art ?? app;
  return req === expected ? expected : null;
}

/**
 * The trusted outer pages' `frame-src` (§6.8): the artifact origin when there is one. Only while no artifact origin is
 * configured, the ADMIN preview page gets `'self'` (the interim `/demo-frame/a/…` is on the app origin). The SHARE
 * page never gets `'self'`: without an artifact origin it frames nothing (null → keep `frame-src 'none'`).
 * Everything else about the outer pages' headers stays as next.config.ts sets it.
 */
export function outerFrameSrc(o: { page: "admin_preview" | "share"; appOrigin: string; artifactOrigin: string | null }): string | null {
  const app = normaliseOrigin(o.appOrigin);
  if (!app) return null;
  if (o.artifactOrigin === null) return o.page === "admin_preview" ? "frame-src 'self'" : null;
  const art = normaliseOrigin(o.artifactOrigin);
  return art && art !== app ? `frame-src ${art}` : null;
}

/** §6.7: the HTML's CSP. `'self'` is not used (its meaning in an opaque origin varied by browser): host and path. */
export function buildArtifactHtmlCsp(o: { scope: ViewScope; servingOrigin: string; appOrigin: string; token: string }): string {
  const serving = normaliseOrigin(o.servingOrigin);
  const app = normaliseOrigin(o.appOrigin);
  if (!serving || !app) throw new Error("CSP origins must be https origins (or local http)");
  if (o.scope !== "a" && o.scope !== "p") throw new Error("CSP scope must be a or p");
  // the token is inside a header value: only its own alphabet may get there
  if (!VIEW_TOKEN_SHAPE.test(o.token)) throw new Error("CSP token has an unexpected shape");
  const base = `${serving}/demo-frame/${o.scope}/${o.token}/`;
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "manifest-src 'none'",
    "font-src 'none'",
    "prefetch-src 'none'",
    `style-src ${base}style.css`,
    `img-src ${base}photos/`,
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${app}`,
    "sandbox",
  ].join("; ");
}

export const ARTIFACT_PERMISSIONS_POLICY = [
  "accelerometer=()", "autoplay=()", "camera=()", "display-capture=()", "encrypted-media=()", "fullscreen=()", "geolocation=()",
  "gyroscope=()", "magnetometer=()", "microphone=()", "midi=()", "payment=()", "picture-in-picture=()", "publickey-credentials-get=()",
  "screen-wake-lock=()", "usb=()", "xr-spatial-tracking=()", "clipboard-read=()", "clipboard-write=()",
].join(", ");

/**
 * §6.7: every header of one artifact response. No `X-Frame-Options` (it must go in an iframe; `frame-ancestors` names
 * the app), no `Cross-Origin-Resource-Policy` (an opaque-origin document must still load its images), no cookie.
 */
export function artifactResponseHeaders(o: {
  role: ArtifactRole;
  /** for images: the manifest's content type, after the magic bytes were checked */
  contentType: "text/html" | "text/css" | "image/webp" | "image/jpeg";
  scope: ViewScope;
  servingOrigin: string;
  appOrigin: string;
  token: string;
}): Record<string, string> {
  const expected = o.role === "html" ? "text/html" : o.role === "css" ? "text/css" : null;
  if (expected ? o.contentType !== expected : o.contentType !== "image/webp" && o.contentType !== "image/jpeg") throw new Error("content type does not match the role");
  if (o.role === "render" && (o.scope !== "a" || o.contentType !== "image/webp")) throw new Error("renders are WebP and admin-only");
  const common: Record<string, string> = {
    "Content-Type": o.role === "html" || o.role === "css" ? `${o.contentType}; charset=utf-8` : o.contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
  if (o.role !== "html") return { ...common, "Content-Security-Policy": "default-src 'none'" };
  return {
    ...common,
    "Content-Security-Policy": buildArtifactHtmlCsp(o),
    "Permissions-Policy": ARTIFACT_PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** §6.4 step 6: the `Sec-Fetch-Dest` a request for this role may carry. HTML in scope `p` only inside an iframe. */
export function fetchDestAllowed(o: { role: ArtifactRole; scope: ViewScope; secFetchDest: string | null }): boolean {
  const d = o.secFetchDest?.trim().toLowerCase() ?? null;
  if (o.role === "css") return d === "style";
  if (o.role === "photo" || o.role === "render") return d === "image";
  // html
  if (o.scope === "p") return d === "iframe";
  return d === null || d === "iframe";
}
