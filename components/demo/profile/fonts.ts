import { Archivo, Playfair_Display } from "next/font/google";

// Latin display faces for design profiles, self-hosted by next/font (no
// request to Google from the visitor). Japanese falls back to the site's
// Shippori Mincho / Noto Sans JP.

export const editorial = Playfair_Display({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-editorial",
  display: "swap",
});

export const grotesk = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-grotesk",
  display: "swap",
});
