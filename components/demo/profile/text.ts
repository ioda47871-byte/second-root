import type { CSSProperties } from "react";
import type { DemoView } from "@/lib/sales/demo-content";

// Text-derived pieces the profile renderer may show besides the verified
// facts. Each is a mechanical transformation of a fact (never new copy):
// name split into words, initials of the name, and the fixed romanisation of
// a verified Nagoya ward.

/** Fixed romanisation of Nagoya's 16 wards (a translation, not a claim). */
export const WARD_ROMAJI: Record<string, string> = {
  千種区: "CHIKUSA-KU",
  東区: "HIGASHI-KU",
  北区: "KITA-KU",
  西区: "NISHI-KU",
  中村区: "NAKAMURA-KU",
  中区: "NAKA-KU",
  昭和区: "SHOWA-KU",
  瑞穂区: "MIZUHO-KU",
  熱田区: "ATSUTA-KU",
  中川区: "NAKAGAWA-KU",
  港区: "MINATO-KU",
  南区: "MINAMI-KU",
  守山区: "MORIYAMA-KU",
  緑区: "MIDORI-KU",
  名東区: "MEITO-KU",
  天白区: "TEMPAKU-KU",
};

/** Small uppercase location labels: the ward (when verified and known) and the city. */
export function locationLabels(demo: Pick<DemoView, "ward">): string[] {
  const ward = demo.ward ? WARD_ROMAJI[demo.ward] : undefined;
  return ward ? [ward, "NAGOYA"] : ["NAGOYA"];
}

/** The name as lines for the hero: one per word; an unspaced name stays whole. */
export function nameLines(name: string): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length > 1 && words.length <= 4 ? words : [name.trim()];
}

/** Up to two letters taken from the name: "EXAMPLE BAKE" → "EB", "焼菓子店" → "焼". */
export function monogram(name: string): string {
  const words = name.split(/[\s・･·.\-_/&+]+/).filter(Boolean);
  const latin = words.filter((w) => /^[A-Za-z0-9]/.test(w));
  if (latin.length >= 2 && latin[0] === words[0]) return (latin[0][0] + latin[1][0]).toUpperCase();
  const first = [...name.trim()][0] ?? "";
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

/** Approximate width in em (full-width 1em, Latin narrower). */
export function emWidth(text: string): number {
  return [...text].reduce((sum, ch) => {
    if (ch === " ") return sum + 0.3;
    if (/[A-Z0-9]/.test(ch)) return sum + 0.72;
    if (/[a-z]/.test(ch)) return sum + 0.56;
    if (/[!-ɏ]/.test(ch)) return sum + 0.5;
    return sum + 1;
  }, 0);
}

const units = (em: number) => Math.min(40, Math.max(2.5, Math.round(em * 1.06 * 10) / 10));

/**
 * Custom properties the hero sizes the name from: --units (whole name on one
 * line), --line-units (the longest line in split layouts).
 */
export function nameSizing(name: string): CSSProperties {
  const lines = nameLines(name);
  return { "--units": units(emWidth(name)), "--line-units": units(Math.max(...lines.map(emWidth))) } as CSSProperties;
}

/**
 * A run of digits joined by hyphens, as in a street number or a phone number
 * ("1-2-3", "052-000-0000"; ASCII or full-width). Longer runs are left to wrap.
 */
const NUMBER_RUN = /[0-9０-９]+(?:[-‐‑–−－][0-9０-９]+)+/g;
export const KEEP_TOGETHER_MAX = 20;

/**
 * Splits a fact into segments for display: number runs are marked to stay on
 * one line, the rest wraps as usual. The segments join back to the exact text.
 */
export function keepTogether(text: string): { text: string; keep: boolean }[] {
  const parts: { text: string; keep: boolean }[] = [];
  let at = 0;
  for (const match of text.matchAll(NUMBER_RUN)) {
    if (match[0].length > KEEP_TOGETHER_MAX) continue;
    if (match.index > at) parts.push({ text: text.slice(at, match.index), keep: false });
    parts.push({ text: match[0], keep: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), keep: false });
  return parts;
}

export function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}
