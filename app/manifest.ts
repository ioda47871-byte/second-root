import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Second Root",
    short_name: "Second Root",
    description: "地域のお店のホームページ制作 — 事業に、もう一つの根を。",
    start_url: "/",
    display: "standalone",
    background_color: "#FBFAF6",
    theme_color: "#355E4C",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
