import type { NextConfig } from "next";

// Sales Agent pages are never indexed and never leak their URL (which holds
// the demo token) to third parties through the Referer header.
const privateRouteHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" },
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
