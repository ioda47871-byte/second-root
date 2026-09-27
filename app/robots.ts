import type { MetadataRoute } from "next";

const baseUrl = "https://secondroot.jp";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Sales Agent pages are private (they also send noindex headers).
      disallow: ["/demo/", "/admin/", "/api/"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
