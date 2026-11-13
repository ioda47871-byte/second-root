/**
 * DEV-196d-5: the parts of the quality decision the admin's browser needs, with NO imports (the form is a client
 * component; the manifest / quality modules pull in node:crypto and the file system). The checklist order is a copy of
 * quality.ts QUALITY_CHECKLIST_ITEMS / EMPHASISED_ITEMS; tests/unit/admin/demo-review.test.tsx pins them equal.
 *
 * Pure.
 */

/** §7.2: the 7 items in the order the screen shows them (= quality.ts QUALITY_CHECKLIST_ITEMS). */
export const REVIEW_ITEMS = ["identity_lock", "facts_confirmed", "shop_specific_structure", "no_generic_lp_regression", "full_page_information", "photos_truthful", "not_a_copy"] as const;
export type ReviewItem = (typeof REVIEW_ITEMS)[number];
/** 3, 4 and 5: weighed most (= quality.ts EMPHASISED_ITEMS). */
export const REVIEW_EMPHASISED: readonly ReviewItem[] = ["shop_specific_structure", "no_generic_lp_regression", "full_page_information"];

/**
 * DEV-196c Low (a): sales_demo_note_valid, mirrored so the form can say what is wrong before sending (the database
 * stays the judge). Trims and turns an empty note into null; refuses a URL, a domain-like word ("style.css",
 * "example.com") or an email address, and more than 500 characters.
 */
/** The note limit of sales_demo_note_valid (characters, after trimming): the form and the input schema use it too. */
export const NOTE_MAX_CHARS = 500;

export function normaliseNote(raw: string | null | undefined): { ok: true; note: string | null } | { ok: false } {
  const n = (raw ?? "").trim();
  if (n === "") return { ok: true, note: null };
  if ([...n].length > NOTE_MAX_CHARS) return { ok: false };
  const k = n.normalize("NFKC");
  const lower = k.toLowerCase();
  if (/([a-z][a-z0-9+.-]*:\/\/|https?:|www\.)/.test(lower)) return { ok: false };
  // Postgres \M (end of word) after the top-level part: the next character is not a word character. In the
  // database's UTF-8 locale a word character is any letter or digit — Japanese included — or "_" (review of #250 L1:
  // 「style.cssを直す」 passes in the database, so it passes here). The rule has no start anchor, so what precedes the
  // word does not matter. tests/integration/demo-review.test.ts compares this with the real function.
  if (/[a-z0-9_-]+(\.[a-z0-9_-]+)*\.[a-z]{2,}(?=[/:]|[^\p{L}\p{N}_]|$)/u.test(lower)) return { ok: false };
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(k)) return { ok: false };
  return { ok: true, note: n };
}

