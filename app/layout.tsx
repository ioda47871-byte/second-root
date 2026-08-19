import type { Metadata } from "next";
import { Zen_Old_Mincho, Noto_Sans_JP, Inter } from "next/font/google";
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

export const metadata: Metadata = {
  metadataBase: new URL("https://secondroot.jp"),
  title: siteTitle,
  description: siteDescription,
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    type: "website",
    locale: "ja_JP",
    images: [{ url: "/screenshots-source/home-desktop.png", width: 1903, height: 900 }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${zenOldMincho.variable} ${notoSansJP.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
