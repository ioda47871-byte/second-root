import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Second Root — 事業に、もう一つの根を。",
  description: "地域のお店のホームページ制作。パン屋・カフェ・美容室・整体など、地域のお店を中心に、公開後の更新や相談まで一人で対応します。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
