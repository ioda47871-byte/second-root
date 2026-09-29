// Unit-test stand-in for next/font/google (the real loader needs the Next.js
// compiler). Every font returns stable class and variable names.
const font = () => ({ className: "font", variable: "font-variable", style: { fontFamily: "serif" } });
export const Archivo = font;
export const Playfair_Display = font;
