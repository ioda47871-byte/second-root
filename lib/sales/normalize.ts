// Deterministic normalisation for dedupe keys (MVP_SPEC §3.5).

const PUNCTUATION = /[\s　・･,，、。.．'’"“”()（）［］\[\]「」『』【】〈〉《》!！?？~〜～\-‐‑‒–—―ー－_＿/／&＆+＋]/g;
const COMPANY_WORDS = /(株式会社|有限会社|合同会社|\(株\)|（株）|\(有\)|（有）)/g;

function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function normalizeName(name: string): string {
  const nfkc = name.normalize("NFKC").toLowerCase().replace(COMPANY_WORDS, "");
  return katakanaToHiragana(nfkc).replace(PUNCTUATION, "");
}

const KANJI_DIGITS: Record<string, string> = { 〇: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

function kanjiNumber(s: string): string {
  // Handles the forms used in addresses: 一〜九十九 (e.g. 十二 → 12, 三十 → 30).
  const m = s.match(/^([一二三四五六七八九]?)(十?)([一二三四五六七八九]?)$/);
  if (!m || s === "") return s;
  const [, tens, ten, ones] = m;
  if (!ten) return KANJI_DIGITS[tens] ?? s;
  const t = tens ? Number(KANJI_DIGITS[tens]) : 1;
  const o = ones ? Number(KANJI_DIGITS[ones]) : 0;
  return String(t * 10 + o);
}

/**
 * Address key: NFKC, no spaces, 丁目/番地/番/号 → "-", kanji block numbers →
 * digits, building names after the block number dropped, "愛知県" prefixed.
 */
export function normalizeAddress(address: string): string {
  let s = address.normalize("NFKC").replace(/[\s　]/g, "");
  s = s.replace(/^〒?\d{3}-?\d{4}/, "");
  s = s.replace(/([一二三四五六七八九十]+)(?=丁目)/g, (m) => kanjiNumber(m));
  s = s.replace(/丁目|番地の?|番の?|号/g, "-");
  s = s.replace(/[‐‑‒–—―ー－−]/g, "-");
  // Keep up to the last block number (drops building / floor names).
  const block = s.match(/^(.*?\d+(?:-\d+)*)/);
  if (block) s = block[1];
  s = s.replace(/-+/g, "-").replace(/-$/, "");
  if (!s.startsWith("愛知県")) s = `愛知県${s}`;
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
  return NAGOYA_WARDS.find((w) => rest.startsWith(w)) ?? null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string | null {
  const s = email.normalize("NFKC").trim().toLowerCase();
  if (s.length > 254 || !EMAIL_PATTERN.test(s)) return null;
  return s;
}
