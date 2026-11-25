import "./fonts-fallback.css";
import { condensedJa, editorial, editorialJa, grotesk, lightJa } from "./fonts.generated";

// Display faces for design profiles, self-hosted by next/font (no request to
// Google from the visitor). Latin: Playfair Display and Archivo. DEV-068:
// a Japanese shop name (most names here) looks different per face, instead of
// every serif falling back to the site's Shippori Mincho and every sans to
// Noto Sans JP. editorial_serif, condensed_grotesk and light_grotesk have a
// Japanese face of their own; mincho keeps the site's Shippori Mincho (a second
// book Mincho drew almost the same glyphs at 400, for 10MB more). All are SIL
// Open Font License fonts. Each static Japanese face loads two weights, a
// lighter and a heavier one (the browser maps light / regular to the lighter and
// bold / black to the heavier: half the files of loading all four); M PLUS 1 is
// one variable file. The Japanese faces are not preloaded: the browser fetches
// only the unicode ranges a page uses.
//
// DEV-303: the files next/font/google downloaded are committed (fonts/, see
// fonts/PROVENANCE.md) and loaded with next/font/local, so the build needs no
// network. fonts.generated.ts declares them exactly as next/font/google did:
// one @font-face per unicode-range subset, the same families, weights, styles,
// width axis and preloads (only the latin subsets of Playfair Display and
// Archivo), and the same CSS variable values.

/** editorial_serif (Latin): Playfair Display, normal and italic, weight axis 400–900. */
export { editorial };

/** condensed_grotesk / light_grotesk (Latin): Archivo, weight and width axes. */
export { grotesk };

/** editorial_serif: a classic high-contrast Mincho (Zen Old Mincho, 400 and 900). */
export { editorialJa };

/** condensed_grotesk: a tight, heavy gothic (Zen Kaku Gothic New, 400 and 900). */
export { condensedJa };

/** light_grotesk: a wide, open gothic with light weights (M PLUS 1, variable). */
export { lightJa };

/** The class names that define every display face's variable. */
export const displayFaceVariables = [editorial, grotesk, editorialJa, condensedJa, lightJa].map((f) => f.variable).join(" ");
