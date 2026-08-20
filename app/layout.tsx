import type { Metadata } from "next";
import { Zen_Old_Mincho, Noto_Sans_JP, Inter } from "next/font/google";
import GoogleAnalytics from "@/components/GoogleAnalytics";
import "./globals.css";

const zenOldMincho = Zen_Old_Mincho({
  weight: ["400", "600"],
  subsets: ["latin"],
  variable: "--font-serif-jp",
  display: "swap",
});

const notoSansJP = Noto_Sans_JP({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-sans-jp",
  display: "swap",
});

const inter = Inter({
  weight: ["500", "600"],
  subsets: ["latin"],
  variable: "--font-label",
  display: "swap",
});

const siteTitle = "Second Root — 事業に、もう一つの根を。";
const siteDescription =
  "地域のお店のホームページ制作。パン屋・カフェ・美容室・整体など、地域のお店を中心に、公開後の更新や相談まで一人で対応します。";
const siteUrl = "https://secondroot.jp";
// Temporary brand-photo composite (scripts/generate-ogp.mjs) — swap for
// real photography by replacing public/og-image.jpg and re-running the
// script, no metadata changes needed.
const ogImagePath = "/og-image.jpg";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: "%s | Second Root",
  },
  description: siteDescription,
  keywords: [
    "ホームページ制作",
    "地域のお店 ホームページ",
    "パン屋 ホームページ制作",
    "カフェ ホームページ制作",
    "美容室 ホームページ制作",
    "整体 ホームページ制作",
    "個人事業主 ホームページ",
    "Second Root",
  ],
  alternates: {
    canonical: siteUrl,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
    },
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: siteUrl,
    siteName: "Second Root",
    type: "website",
    locale: "ja_JP",
    images: [{ url: ogImagePath, width: 1200, height: 630, alt: siteTitle }],
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: [ogImagePath],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${zenOldMincho.variable} ${notoSansJP.variable} ${inter.variable}`}>
      <body>
        {children}
        <GoogleAnalytics />
      </body>
    </html>
  );
}
