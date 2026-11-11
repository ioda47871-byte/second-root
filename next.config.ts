import type { NextConfig } from "next";

// Sales Agent pages are never indexed, never leak their URL (which holds
// the demo token) to third parties through the Referer header, and can
// never be framed by another site (clickjacking on the admin actions).
const privateRouteHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** The admin demo version page: never framed itself, may frame only its own origin (lib/sales/demo-version/csp.ts outerFrameSrc). */
export const ADMIN_DEMO_PAGE_CSP = "frame-ancestors 'none'; frame-src 'self'";

const nextConfig: NextConfig = {
  // DEV-050: `next dev` logs every Server Function call with its arguments by
  // default. Admin actions receive shop emails (exclusion list), DM / email
  // text and reply drafts, so they must never reach the dev terminal or a
  // captured log. (Production never logs them; this only affects development.)
  logging: { serverFunctions: false },
  async headers() {
    return [
      { source: "/demo/:path*", headers: privateRouteHeaders },
      { source: "/design-preview/:path*", headers: privateRouteHeaders },
      { source: "/admin/:path*", headers: privateRouteHeaders },
      // DEV-196d-3 (spec §6.7・§6.8): the admin demo version page frames the version's page from the interim
      // /demo-frame/a/… on this same origin, so it may frame 'self' — and only that. The rule must stay AFTER
      // "/admin/:path*": for the same header key the last matching rule wins (Next "Header Overriding Behavior"), so
      // only the CSP changes here; X-Frame-Options DENY and every other admin header stay as above. When the
      // dedicated artifact origin is set up (DEV-196g, its own approval), 'self' is replaced by that origin.
      { source: "/admin/sales/demos/:path*", headers: [{ key: "Content-Security-Policy", value: ADMIN_DEMO_PAGE_CSP }] },
      { source: "/api/internal/:path*", headers: privateRouteHeaders },
      { source: "/api/webhooks/:path*", headers: privateRouteHeaders },
    ];
  },
};

export default nextConfig;
