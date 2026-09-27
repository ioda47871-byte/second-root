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

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/demo/:path*", headers: privateRouteHeaders },
      { source: "/admin/:path*", headers: privateRouteHeaders },
      { source: "/api/internal/:path*", headers: privateRouteHeaders },
    ];
  },
};

export default nextConfig;
