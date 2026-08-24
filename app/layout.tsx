import type { Metadata } from "next";
import { Shippori_Mincho, Noto_Sans_JP, Zen_Maru_Gothic } from "next/font/google";
import GoogleAnalytics from "@/components/GoogleAnalytics";
import "./globals.css";

const shipporiMincho = Shippori_Mincho({
  weight: ["400", "600"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const notoSansJP = Noto_Sans_JP({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const zenMaruGothic = Zen_Maru_Gothic({
  weight: ["500", "700"],
  subsets: ["latin"],
  variable: "--font-label",
  display: "swap",
});

const siteTitle = "Second Root — 名古屋・金山の地域店舗向けホームページ制作";
const siteDescription =
  "名古屋・金山を拠点に、パン屋・カフェなど地域のお店のホームページを制作します。買い切りが基本、通常3〜5週間。文章整理から公開後の対応まで一人で担当。全国オンライン対応・無料診断受付中。";
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
    "ホームページ制作 名古屋",
    "金山 ホームページ制作",
    "パン屋 ホームページ制作",
    "カフェ ホームページ制作",
    "地域のお店 ホームページ",
    "小規模店舗 ホームページ制作",
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
    <html lang="ja" className={`${shipporiMincho.variable} ${notoSansJP.variable} ${zenMaruGothic.variable}`}>
      <body>
        {children}
        <GoogleAnalytics />
        {/* ProfessionalService — area served and service type only. No
            street address or phone number is published. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "ProfessionalService",
              name: "Second Root",
              url: siteUrl,
              description: siteDescription,
              image: `${siteUrl}${ogImagePath}`,
              email: "info@secondroot.jp",
              serviceType: "ホームページ制作",
              areaServed: [
                { "@type": "City", name: "名古屋市" },
                { "@type": "Country", name: "日本" },
              ],
              address: {
                "@type": "PostalAddress",
                addressLocality: "名古屋市",
                addressRegion: "愛知県",
                addressCountry: "JP",
              },
            }),
          }}
        />
      </body>
    </html>
  );
}
