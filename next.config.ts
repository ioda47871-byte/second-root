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

// Concept Works are separate static-export builds copied into
// public/works/<slug>/ (docs/WORKS.md). Their pages are exported as
// <page>.html, which public/ only serves with the extension, so the
// extension-less URLs are rewritten to those files.
const staticWorks = [
  { slug: "yasashii-beauty-salon", pages: ["about", "access", "first", "menu", "staff"] },
  { slug: "midori-seitai", pages: ["about", "access", "approach", "faq", "first", "menu", "staff"] },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/demo/:path*", headers: privateRouteHeaders },
      { source: "/admin/:path*", headers: privateRouteHeaders },
      { source: "/api/internal/:path*", headers: privateRouteHeaders },
      { source: "/api/webhooks/:path*", headers: privateRouteHeaders },
      // Content-hashed build files of the Concept Works.
      ...staticWorks.map(({ slug }) => ({
        source: `/works/${slug}/_next/static/:path*`,
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      })),
    ];
  },
  async rewrites() {
    return staticWorks.flatMap(({ slug, pages }) => [
      { source: `/works/${slug}`, destination: `/works/${slug}/index.html` },
      // Next 15's router fetches the home page's RSC payload as `<basePath>.txt`
      // (without a basePath that is /index.txt, which the export writes).
      { source: `/works/${slug}.txt`, destination: `/works/${slug}/index.txt` },
      { source: `/works/${slug}/:page(${pages.join("|")})`, destination: `/works/${slug}/:page.html` },
    ]);
  },
};

export default nextConfig;
