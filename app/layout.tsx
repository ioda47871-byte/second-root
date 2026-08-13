import type { Metadata } from "next";
import "./globals.css";

const siteTitle = "Second Root — 事業に、もう一つの根を。";
const siteDescription =
  "地域のお店のホームページ制作。パン屋・カフェ・美容室・整体など、地域のお店を中心に、公開後の更新や相談まで一人で対応します。";

export const metadata: Metadata = {
  // TODO: replace with the real production domain once it's decided.
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
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
