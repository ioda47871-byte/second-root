// Deterministic normalisation for dedupe keys (MVP_SPEC §3.5).
// Merging two different shops is worse than missing a duplicate (the shop
// would silently never be contacted), so keys stay conservative.

const NAME_PUNCTUATION = /[\s　・･,，、。.．'’"“”()（）［］\[\]「」『』【】〈〉《》!！?？~〜～\-‐‑‒–—―－_＿/／]/g;
const COMPANY_WORDS = /(株式会社|有限会社|合同会社|\(株\)|\(有\))/g;

function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function normalizeName(name: string): string {
  const nfkc = name.normalize("NFKC").toLowerCase();
  const withoutCompany = katakanaToHiragana(nfkc.replace(COMPANY_WORDS, "")).replace(NAME_PUNCTUATION, "");
  // A name that is only a company word keeps its full text rather than "".
  return withoutCompany || katakanaToHiragana(nfkc).replace(NAME_PUNCTUATION, "");
}

const KANJI_DIGITS: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** Kanji numerals as used in Japanese addresses (一〜九千九百九十九, or digit-by-digit like 一〇一). */
export function kanjiToNumber(s: string): number | null {
  if (!/^[〇一二三四五六七八九十百千]+$/.test(s)) return null;
  if (!/[十百千]/.test(s)) return Number([...s].map((c) => KANJI_DIGITS[c]).join(""));
  let total = 0;
  let digit = 0;
  for (const c of s) {
    if (c in KANJI_DIGITS) digit = KANJI_DIGITS[c];
    else {
      total += (digit || 1) * KANJI_UNITS[c];
      digit = 0;
    }
  }
  return total + digit;
}

/**
 * Address key: NFKC, kanji block numbers → digits, 丁目/番地/番/号 → "-",
 * everything after the block number (building, floor, room) dropped, spaces
 * removed, "愛知県" prefixed for Nagoya addresses written without it.
 */
export function normalizeAddress(address: string): string {
  let s = address.normalize("NFKC").replace(/　/g, " ").trim();
  s = s.replace(/^〒?\s*\d{3}-?\d{4}\s*/, "");
  s = s.replace(/[〇一二三四五六七八九十百千]+(?=\s*(丁目|番地|番|号))/g, (m) => String(kanjiToNumber(m) ?? m));
  s = s.replace(/\s*(丁目|番地の?|番の?)\s*/g, "-");
  // 号 ends the block number (and 号室 is a room, dropped below).
  s = s.replace(/(\d)\s*号(?!室)/g, "$1 ");
  s = s.replace(/[‐‑‒–—―ー－−]/g, "-");
  // "3 - 4 - 5" and "3の4の5" are the same block number as "3-4-5".
  s = s.replace(/(\d)\s*[-の]\s*(?=\d)/g, "$1-");
  // Keep up to the block number. The prefix may contain spaces; the block
  // number is digits joined by "-" only, so a following " 1F" / "101号室" /
  // building name is never glued onto it.
  const block = s.match(/^(\D*?\d+(?:-\d+)*)/);
  if (block) s = block[1];
  s = s.replace(/\s+/g, "").replace(/-+/g, "-").replace(/-$/, "");
  if (s.startsWith("名古屋市")) s = `愛知県${s}`;
  return s;
}

export function isNagoyaAddress(address: string): boolean {
  return normalizeAddress(address).startsWith("愛知県名古屋市");
}

const NAGOYA_WARDS = [
  "千種区", "東区", "北区", "西区", "中村区", "中区", "昭和区", "瑞穂区",
  "熱田区", "中川区", "港区", "南区", "守山区", "緑区", "名東区", "天白区",
] as const;

export function nagoyaWard(address: string): string | null {
  const s = normalizeAddress(address);
  if (!s.startsWith("愛知県名古屋市")) return null;
  const rest = s.slice("愛知県名古屋市".length);
  // Longest match first so 中村区 is not read as 中区.
  return [...NAGOYA_WARDS].sort((a, b) => b.length - a.length).find((w) => rest.startsWith(w)) ?? null;
}

const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeEmail(email: string): string | null {
  const s = email.normalize("NFKC").trim().toLowerCase();
  if (s.length > 254 || !EMAIL_PATTERN.test(s)) return null;
  const local = s.split("@")[0];
  if (local.length > 64 || s.includes("..") || local.startsWith(".") || local.endsWith(".")) return null;
  return s;
}
