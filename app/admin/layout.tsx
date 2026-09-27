import type { Metadata } from "next";

// Everything under /admin is private (headers in next.config.ts also send
// X-Robots-Tag: noindex, nofollow).
export const metadata: Metadata = {
  title: { absolute: "Second Root 営業管理" },
  robots: { index: false, follow: false, nocache: true },
  description: null,
  keywords: null,
  alternates: { canonical: null },
  openGraph: null,
  twitter: null,
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return children;
}
