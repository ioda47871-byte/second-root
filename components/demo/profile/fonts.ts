import { Archivo, M_PLUS_1, Playfair_Display, Shippori_Mincho_B1, Zen_Kaku_Gothic_New, Zen_Old_Mincho } from "next/font/google";

// Display faces for design profiles, self-hosted by next/font (no request to
// Google from the visitor). Latin: Playfair Display and Archivo. DEV-068:
// each display face has a Japanese face of its own, so a Japanese shop name
// (most names here) looks different per face, instead of every serif falling
// back to the site's Shippori Mincho and every sans to Noto Sans JP. All are
// SIL Open Font License fonts. Each static Japanese face loads two weights
// (the browser's weight matching maps light / regular to the lighter one and
// bold / black to the heavier: the light/heavy contrast the profile asks for at
// a third of the size of loading all four); M PLUS 1 is one variable file. The
// Japanese faces are not preloaded: the browser fetches only the unicode
// ranges a page uses.

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

/** editorial_serif: a classic high-contrast Mincho (Zen Old Mincho). */
export const editorialJa = Zen_Old_Mincho({
  weight: ["400", "900"],
  subsets: ["latin"],
  variable: "--font-ja-editorial",
  display: "swap",
  preload: false,
});

/** mincho: a crisp book Mincho (Shippori Mincho B1). */
export const minchoJa = Shippori_Mincho_B1({
  weight: ["400", "800"],
  subsets: ["latin"],
  variable: "--font-ja-mincho",
  display: "swap",
  preload: false,
});

/** condensed_grotesk: a tight, heavy gothic (Zen Kaku Gothic New). */
export const condensedJa = Zen_Kaku_Gothic_New({
  weight: ["400", "900"],
  subsets: ["latin"],
  variable: "--font-ja-condensed",
  display: "swap",
  preload: false,
});

/** light_grotesk: a wide, open gothic with light weights (M PLUS 1, variable). */
export const lightJa = M_PLUS_1({
  weight: "variable",
  subsets: ["latin"],
  variable: "--font-ja-light",
  display: "swap",
  preload: false,
});

/** The class names that define every display face's variable. */
export const displayFaceVariables = [editorial, grotesk, editorialJa, minchoJa, condensedJa, lightJa].map((f) => f.variable).join(" ");
