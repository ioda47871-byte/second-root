/**
 * DEV-303 §6.1 change 4 (docs/design/image-first-production-flow.md §2 principle 6): owner-approved Japanese renderings
 * of a shop's facts that exist only in another language (e.g. an English description). A private per-shop record
 * `sr_ja_renderings_v1` OUTSIDE the repository (e.g. ~/second-root-shops/<shop_id>/ja-renderings.json, next to the facts
 * pack):
 *
 *   { schema, shop_id, entries: [{ fact_key, source_text, ja_text, note? }],
 *     owner_confirmation?: { confirmed: true, confirmed_at, entries_sha256 } }
 *
 *   - source_text must equal the facts pack's value for fact_key exactly (one rendering per key);
 *   - ja_text is one line (no control character, markup, link, bidi control or soft hyphen) and may not ADD a fact: every
 *     digit run, and every invented-fact sign (copy-record INVENTED_FACT_SIGNS: money, dates, history, people, awards,
 *     reputation, reservation …) it shows must already be in source_text, and so must every Latin-letter word (a proper
 *     noun the source does not hold). A tripwire, not a translator's check: the owner's review still decides.
 *   - gate mode (request mode, the copy audit): owner_confirmation with entries_sha256 = SHA-256 of the canonical
 *     entries (JSON with sorted keys, in record order). Claude writes owner_confirmation only when the owner says so; it
 *     binds that statement to exactly these entries. It is NOT the owner's signature.
 *
 * Failures throw JaRenderingsStop with a fixed code and, for an added fact, the category, field and fact key (never the
 * text). Pure: bytes and the facts pack in, values out (no file, no process, no network).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { INVENTED_FACT_SIGNS } from "../quality-pipeline/copy-record";
import type { FactsPack } from "../quality-pipeline/facts-pack";

export const JA_RENDERINGS_SCHEMA = "sr_ja_renderings_v1";
/** The record is small text; anything bigger is refused before parsing. */
export const JA_RENDERINGS_MAX_BYTES = 64 * 1024;
export const JA_TEXT_MAX = 300;

export const JA_RENDERINGS_CODES = [
  "JA_RENDERINGS_TOO_LARGE",
  "JA_RENDERINGS_INVALID",
  "JA_RENDERINGS_TEXT_UNSAFE",
  "JA_RENDERINGS_DUPLICATE_KEY",
  "JA_RENDERINGS_SHOP_MISMATCH",
  "JA_RENDERINGS_FACT_UNKNOWN",
  "JA_RENDERINGS_SOURCE_MISMATCH",
  "JA_RENDERING_ADDS_FACT",
  "JA_RENDERINGS_NOT_OWNER_CONFIRMED",
  "JA_RENDERINGS_SHA_MISMATCH",
] as const;
export type JaRenderingsCode = (typeof JA_RENDERINGS_CODES)[number];
/** What an added fact is reported as (never the text). */
export type JaRenderingDetail = { category: string; field: "ja_text"; fact_key: string };
export class JaRenderingsStop extends Error {
  constructor(
    readonly code: JaRenderingsCode,
    readonly detail: JaRenderingDetail | null = null,
  ) {
    super(code);
    this.name = "JaRenderingsStop";
  }
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** One plain line: no control character, markup, prompt fence, link, bidi control or soft hyphen. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u2028\u2029\u00ad\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]|[<>`{}]|https?:|ftp:|:\/\/|www\./i;
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0 && s === s.trim() && !UNSAFE_TEXT.test(s), "ja_text_unsafe");
const FACT_KEY = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);

export const JaRenderingEntry = z.strictObject({
  fact_key: FACT_KEY.refine((k) => k !== "category", "category_not_rendered"),
  source_text: z.string().min(1).max(2000),
  ja_text: Text(JA_TEXT_MAX),
  note: Text(300).optional(),
});
export type JaRenderingEntry = z.infer<typeof JaRenderingEntry>;

export const JaRenderingsRecord = z.strictObject({
  schema: z.literal(JA_RENDERINGS_SCHEMA),
  shop_id: z.string().regex(/^[a-z0-9_-]{2,41}$/),
  entries: z.array(JaRenderingEntry).min(1).max(40),
  owner_confirmation: z
    .strictObject({
      confirmed: z.literal(true),
      confirmed_at: z.string().regex(UTC).refine((s) => Number.isFinite(Date.parse(s)), "confirmed_at_invalid"),
      entries_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
});
export type JaRenderingsRecord = z.infer<typeof JaRenderingsRecord>;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
/** The SHA-256 owner_confirmation.entries_sha256 must equal: the entries as canonical JSON (sorted keys, record order). */
export const entriesSha256 = (entries: readonly JaRenderingEntry[]) => sha256(canonical(entries));

const nfkc = (s: string) => s.normalize("NFKC");
/** The units a number may carry in a rendering when its digits are the source's (1987 → 1987年). */
const NUMBER_UNIT = /^[0-9]+[年時月日]?$/;

/** Kanji numerals (common and formal); a run of two or more (or one with 数: 十数) is a number. */
const KANJI_NUMERALS = "〇零一二三四五六七八九十百千万億壱弐参肆伍陸漆捌玖拾廿卅";
const KANJI_NUMBER_RUN = new RegExp(`[${KANJI_NUMERALS}]{2,}|[${KANJI_NUMERALS}]数`, "gu");
/** One kanji numeral followed by a counter (三種, 七時, 二十席 is caught as a run) is a number too. */
const KANJI_NUMBER_COUNTED = new RegExp(`[${KANJI_NUMERALS}](?=[種席名個品時分日週月回杯店階号番人冊枚本台軒年歳才円割度件皿つ])`, "gu");
/** Any numeral that is not an ASCII digit after NFKC (Arabic-Indic, Devanagari, ①-like signs, Roman numerals …). */
const OTHER_NUMERAL = /(?![0-9])\p{N}/u;
/** Letters a Japanese rendering may use: Han, Hiragana, Katakana (with ー), ASCII Latin. Any other letter is another script. */
const OTHER_SCRIPT_LETTER = /(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ーA-Za-z])\p{L}/gu;
/** A word of letters that is not all Han / kana (it holds a Latin or other-script letter, e.g. Café). */
const NON_JAPANESE_WORD = /(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])[\p{L}\p{M}](?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])[\p{L}\p{M}'&.-])*/gu;
const latinWords = (s: string) => s.match(/[a-z][a-z'&.-]*[a-z]|[a-z]/g) ?? [];

/**
 * The first fact a rendering adds to its source, as a category (never the text). A tripwire for numbers, fact markers,
 * other scripts and Latin words only (names, places and wording without a marker are the owner's review):
 *   - `script`: a letter outside Han, Hiragana, Katakana and ASCII Latin (Мария, ΑΒΓ), unless its whole word is one of
 *     the source's words (Café);
 *   - `number`: any numeral but an ASCII digit (Arabic-Indic, Devanagari …) the source lacks, a digit run, a kanji-numeral
 *     run (三十, 十数, 〇三, formal 弐拾) or a kanji numeral with a counter (七時) the source lacks. Strict: everyday words
 *     (一つ, 一番, 一人, 十分, 八百屋) are refused too, and a number the source spells in words cannot become a numeral;
 *   - an invented-fact sign (copy-record INVENTED_FACT_SIGNS) whose matched words the source lacks (a number with a unit
 *     is allowed when its digits are the source's);
 *   - `proper_noun`: a Latin word that is not one of the source's words (whole words: "sour" is not "sourdough").
 * null when it adds nothing.
 */
export function addedFactCategory(source: string, ja: string): string | null {
  const src = nfkc(source).toLowerCase();
  const t = nfkc(ja);
  // a letter of another script is allowed only inside a word the source holds whole (Café); Latin words are checked below
  const sourceWordsAll = new Set((src.match(NON_JAPANESE_WORD) ?? []).map((w) => w.toLowerCase()));
  for (const m of t.matchAll(NON_JAPANESE_WORD)) {
    const word = m[0];
    if (word.match(OTHER_SCRIPT_LETTER) && !sourceWordsAll.has(word.toLowerCase())) return "script";
  }
  for (const m of t.matchAll(new RegExp(OTHER_NUMERAL.source, "gu"))) if (!src.includes(m[0])) return "number";
  const sourceRuns: string[] = src.match(/[0-9]+/g) ?? [];
  for (const run of t.match(/[0-9]+/g) ?? []) if (!sourceRuns.includes(run)) return "number";
  for (const m of [...t.matchAll(KANJI_NUMBER_RUN), ...t.matchAll(KANJI_NUMBER_COUNTED)]) if (!src.includes(m[0])) return "number";
  for (const [category, re] of INVENTED_FACT_SIGNS) {
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
      const w = m[0];
      if (src.includes(w.toLowerCase())) continue;
      // digits already matched against the source above; the unit alone adds no fact
      if (NUMBER_UNIT.test(w) && /[0-9]/.test(w)) continue;
      return category;
    }
  }
  const sourceWords = new Set(latinWords(src));
  for (const word of latinWords(t.toLowerCase())) if (word.length >= 2 && !sourceWords.has(word)) return "proper_noun";
  return null;
}

export type CheckedJaRenderings = {
  shop_id: string;
  /** The record bytes' SHA-256 (what a request names and a plan / receipt records). */
  sha256: string;
  entries_sha256: string;
  entries: JaRenderingEntry[];
  owner_confirmed: boolean;
};

/**
 * The record's bytes against the facts pack: schema, one entry per key, each key a fact of the pack (not its category)
 * whose value is source_text exactly, no rendering adding a fact; in "gate" mode also the owner's confirmation bound to
 * these entries. Throws JaRenderingsStop.
 */
export function checkJaRenderings(bytes: Buffer, facts: FactsPack, o: { mode: "draft" | "gate" }): CheckedJaRenderings {
  if (bytes.length > JA_RENDERINGS_MAX_BYTES) throw new JaRenderingsStop("JA_RENDERINGS_TOO_LARGE");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new JaRenderingsStop("JA_RENDERINGS_INVALID");
  }
  const r = JaRenderingsRecord.safeParse(json);
  if (!r.success) throw new JaRenderingsStop(r.error.issues.some((i) => i.message === "ja_text_unsafe") ? "JA_RENDERINGS_TEXT_UNSAFE" : "JA_RENDERINGS_INVALID");
  const rec = r.data;
  if (rec.shop_id !== facts.shop_id) throw new JaRenderingsStop("JA_RENDERINGS_SHOP_MISMATCH");
  if (new Set(rec.entries.map((e) => e.fact_key)).size !== rec.entries.length) throw new JaRenderingsStop("JA_RENDERINGS_DUPLICATE_KEY");
  for (const e of rec.entries) {
    const fact = facts.facts.find((f) => f.key === e.fact_key);
    if (!fact) throw new JaRenderingsStop("JA_RENDERINGS_FACT_UNKNOWN");
    if (fact.value !== e.source_text) throw new JaRenderingsStop("JA_RENDERINGS_SOURCE_MISMATCH");
    const category = addedFactCategory(e.source_text, e.ja_text);
    if (category) throw new JaRenderingsStop("JA_RENDERING_ADDS_FACT", { category, field: "ja_text", fact_key: e.fact_key });
  }
  const es = entriesSha256(rec.entries);
  if (o.mode === "gate") {
    if (!rec.owner_confirmation) throw new JaRenderingsStop("JA_RENDERINGS_NOT_OWNER_CONFIRMED");
    if (rec.owner_confirmation.entries_sha256 !== es) throw new JaRenderingsStop("JA_RENDERINGS_SHA_MISMATCH");
  }
  return { shop_id: rec.shop_id, sha256: sha256(bytes), entries_sha256: es, entries: rec.entries, owner_confirmed: rec.owner_confirmation?.entries_sha256 === es };
}

/** What `--validate-request` and the checker CLI may print of a refusal's detail (allowlisted; never the text). */
export function jaRenderingDetailOf(error: unknown): JaRenderingDetail | null {
  if (!(error instanceof JaRenderingsStop) || !error.detail) return null;
  const d = error.detail;
  const categories = [...INVENTED_FACT_SIGNS.map(([n]) => n), "number", "proper_noun", "script"];
  if (!categories.includes(d.category) || d.field !== "ja_text" || !/^[a-z][a-z0-9_]{0,40}$/.test(d.fact_key)) return null;
  return { category: d.category, field: "ja_text", fact_key: d.fact_key };
}
