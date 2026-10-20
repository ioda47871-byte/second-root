// Unit-test stand-in for next/font/google (the real loader needs the Next.js
// compiler). Every font returns stable class and variable names.
const font = () => ({ className: "font", variable: "font-variable", style: { fontFamily: "serif" } });
export const Archivo = font;
export const Playfair_Display = font;
// DEV-068: the Japanese display faces.
export const Zen_Old_Mincho = font;
export const Zen_Kaku_Gothic_New = font;
export const M_PLUS_1 = font;
