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

// ---------------------------------------------------------------- unspaced names (DEV-034)
//
// A name without spaces (most Japanese shop names: "〇〇ベーカリー", a single
// Latin word) has no place where a line may break by itself; left to the
// browser it broke anywhere, in the middle of a word ("ベー / カリー"). The
// renderer now sets such a name from pieces that are never split: a run of
// kanji with the kana that follow it (okurigana, particles), a run of
// katakana, a Latin word or number. On phones it keeps the name on one line,
// sized to fit, when that line stays large; a longer name goes on two or
// three balanced lines that break only between pieces.

type Script = "kanji" | "hiragana" | "katakana" | "latin" | "other";

function scriptOf(ch: string): Script {
  if (/[\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/.test(ch)) return "katakana"; // incl. ー ・ and half-width
  if (/[\u3040-\u309F]/.test(ch)) return "hiragana";
  if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆〇ヶ]/.test(ch)) return "kanji";
  if (/[A-Za-z0-9\u00C0-\u024F\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A'’.&-]/.test(ch)) return "latin";
  return "other";
}

/** Marks that belong to the character before them: long vowel, iteration marks, small kana, ヶ. */
const JOINS_LEFT = /^[ーｰ〜～ゝゞヽヾ々ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿｧ-ｯﾞﾟ]$/;
/** Closing brackets and punctuation stay with what comes before them. */
const CLOSES = /^[」』）)】〉》］\]｝}”’"、。，．！？!?＆&]$/;
/** Opening brackets start a piece and stay with what follows. */
const OPENS = /^[「『（(【〈《［\[｛{“‘]$/;

/**
 * The pieces of an unspaced name that are never broken, in order; they join
 * back to the exact name. Hiragana stays with what comes before it (たまご
 * after 焼 stays "焼たまご"; の after a katakana word stays with it); a katakana
 * run, a kanji run after kana or katakana, a Latin word, an opening bracket,
 * and whatever follows a middle dot each start a piece. A long-vowel mark,
 * small kana, an iteration mark or ヶ, and a closing bracket stay with the
 * character before them ("らーめん", "霞ヶ関", "（テスト）"). One kanji after a
 * katakana word is its suffix and stays with it ("テスト店").
 */
export function nameTokens(name: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let prev: Script | null = null;
  for (const ch of [...name]) {
    if (current && (JOINS_LEFT.test(ch) || CLOSES.test(ch))) {
      current += ch; // the script of the run is the one before the mark
      continue;
    }
    const script = scriptOf(ch);
    const afterDot = /[・･]$/.test(current);
    const afterOpen = current !== "" && OPENS.test([...current].at(-1)!);
    const joins =
      afterOpen ||
      (!afterDot &&
        !OPENS.test(ch) &&
        (prev === null ||
          script === "other" ||
          prev === "other" ||
          (script === "hiragana" && prev !== "latin") ||
          (script === prev && script !== "hiragana")));
    if (!joins && current) {
      tokens.push(current);
      current = "";
    }
    current += ch;
    prev = script;
  }
  if (current) tokens.push(current);
  // One kanji right after a katakana word is its suffix (テスト店, カフェ堂): keep them together.
  return tokens.reduce<string[]>((out, t) => {
    const last = out[out.length - 1];
    const core = [...t].filter((ch) => !CLOSES.test(ch)).join(""); // "店）" counts as one kanji
    if (last && [...core].length === 1 && scriptOf(core) === "kanji" && scriptOf([...last].at(-1)!) === "katakana" && !/[・･]$/.test(last)) out[out.length - 1] = last + t;
    else out.push(t);
    return out;
  }, []);
}

/** Longest a phone line may be (em) and still be set large; longer names get more lines. */
export const PHONE_LINE_EM = 7.5;
const MAX_PHONE_LINES = 3;

/**
 * The name's lines on a phone: the whole name when it fits on one large line,
 * otherwise the split into 2–3 lines (between pieces only) whose longest line
 * is shortest. A name that is one piece stays one line (it is then sized to fit).
 */
const phoneLinesCache = new Map<string, string[]>();

export function phoneNameLines(name: string): string[] {
  const text = name.trim();
  const cached = phoneLinesCache.get(text);
  if (cached) return [...cached];
  const lines = planPhoneLines(text);
  if (phoneLinesCache.size > 500) phoneLinesCache.clear();
  phoneLinesCache.set(text, lines);
  return [...lines];
}

function planPhoneLines(text: string): string[] {
  const tokens = nameTokens(text);
  if (emWidth(text) <= PHONE_LINE_EM || tokens.length < 2) return [text];
  const want = Math.min(MAX_PHONE_LINES, tokens.length, Math.ceil(emWidth(text) / PHONE_LINE_EM));
  let best: string[] = [text];
  let bestWidth = Infinity;
  // Every way to cut the pieces into `want` lines (names are short: at most a few dozen pieces).
  const walk = (start: number, left: number, lines: string[]) => {
    if (left === 1) {
      const all = [...lines, tokens.slice(start).join("")];
      const width = Math.max(...all.map(emWidth));
      if (width < bestWidth) {
        best = all;
        bestWidth = width;
      }
      return;
    }
    for (let end = start + 1; end <= tokens.length - (left - 1); end++) walk(end, left - 1, [...lines, tokens.slice(start, end).join("")]);
  };
  walk(0, want, []);
  return best;
}

/** Whether the name is set from unbreakable pieces (it has no space of its own to break at). */
export function isUnspacedName(name: string): boolean {
  return !/\s/.test(name.trim());
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
    if (/[!-ɏ\uFF61-\uFF9F]/.test(ch)) return sum + 0.5; // incl. half-width katakana
    return sum + 1;
  }, 0);
}

/**
 * A safe upper bound of the width in em, for sizing a name so it can never
 * overflow (DEV-034): every Latin letter as wide as its capital (the profile
 * may set the name in capitals), the widest capitals at their widest, and
 * room for the widest display face (light_grotesk is set at 104% width).
 */
export function fitWidth(text: string): number {
  const latin = (w: number) => w * 1.04;
  return [...text].reduce((sum, ch) => {
    if (ch === " ") return sum + 0.3;
    if (/[MWmwＭＷｍｗ@%]/.test(ch)) return sum + latin(1.1);
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) return sum + latin(0.86);
    if (/[0-9&#]/.test(ch)) return sum + latin(0.76);
    if (/[!-~\u00A0-\u00BF\uFF61-\uFF9F]/.test(ch)) return sum + latin(0.6);
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
  const style: Record<string, number> = { "--units": units(emWidth(name)), "--line-units": units(Math.max(...lines.map(emWidth))) };
  if (isUnspacedName(name)) {
    // DEV-034: phone fit for an unspaced name, from its longest phone line;
    // --fit-chars lets the CSS add the profile's letter-spacing per character.
    // Sized from fitWidth (an upper bound), so no face or case overflows.
    const phone = phoneNameLines(name);
    const longest = phone.reduce((a, b) => (fitWidth(b) > fitWidth(a) ? b : a));
    style["--fit-units"] = Math.max(1, Math.round(fitWidth(longest) * 1.06 * 100) / 100);
    style["--fit-chars"] = [...longest].length;
    style["--name-units"] = Math.max(1, Math.round(fitWidth(name.trim()) * 1.06 * 100) / 100);
    style["--name-chars"] = [...name.trim()].length;
  }
  return style as CSSProperties;
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
