// Unit-test stand-in for next/font/local (the real loader needs the Next.js
// compiler). Every font returns stable class and variable names.
export default function localFont() {
  return { className: "font", variable: "font-variable", style: { fontFamily: "serif" } };
}
