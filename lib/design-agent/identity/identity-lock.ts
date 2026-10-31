/**
 * Phase 2c (DEV-126): Identity Lock, the fail-closed shop identity gate, ported to TypeScript from the research
 * script `design-library/intelligence/v02/identity-audit.mjs` (PR #142; policy `docs/design/identity-lock-research-policy.md`).
 *
 * Why: generated designs have shown ANOTHER shop (CP-014: a record shop request came back as a bakery; CP-015: a
 * spice café came back as a bookshop). The gate fixes the target before generation (name, aliases, category, source)
 * and checks the result after it:
 *
 * - auditIdentity: a generated IMAGE. Nothing here reads pixels or runs OCR: the after-check is a recorded visual
 *   inspection of the exact image (its SHA-256 must match). Same codes and verdicts as the research script.
 * - auditPageText: a generated HTML page (routes B / C). Its visible text can be checked mechanically: the target's
 *   name must appear, and no other shop's name (e.g. the success cases shown as references) may appear.
 *
 * What the page check can and cannot see: it compares against the names it is GIVEN (target, aliases, other shops),
 * after folding width, case, punctuation, zero-width characters and (page check only) hiragana/katakana; the image
 * check keeps the research script's comparison exactly. It does not know shops that are
 * not listed, abbreviations, or variant kanji (髙/高): those still need the owner's look at the page.
 *
 * Deliberately stricter than the research script: a name that cleans to nothing ("♪") is never accepted.
 *
 * PASS_IDENTITY_ONLY means only "this is the right shop": never a quality score, an owner approval, a commercial
 * clearance or a production gate. Pure: no I/O.
 */

export type IdentityStatus = "REJECT" | "HOLD" | "PASS_IDENTITY_ONLY";
export type IdentityResult = {
  case_id: string | null;
  attempt_id: string | null;
  status: IdentityStatus;
  errors: string[];
  pending: string[];
  can_show_as_target_design: boolean;
  counts_as_owner_success: false;
  note: string;
};

const NOTE = "PASS_IDENTITY_ONLY is not a quality score, owner approval, commercial clearance, or production gate; it relies on visual inspection of the correct image.";

const shaOK = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/i.test(x);
/** Names compare after NFKC, lower case and dropping everything but letters and digits ("imairo." = "IMAIRO"). */
export const cleanName = (s: unknown) => (typeof s === "string" ? s.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "") : "");
/** For the page check only: also hiragana → katakana (なごや = ナゴヤ). The image check keeps the research script's names. */
export const cleanPageName = (s: unknown) => cleanName(s).replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const filled = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const obj = (x: unknown): Record<string, unknown> => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

// a name that cleans to nothing ("♪") would match an empty label: it is dropped (and, if it was the only one, the target has no name)
const allowedNames = (target: Record<string, unknown>) => [target.official_name, ...(Array.isArray(target.allowed_aliases) ? target.allowed_aliases : [])].filter(filled).map(cleanName).filter((n) => n.length > 0);

const verdict = (a: Record<string, unknown>, errors: string[], pending: string[]): IdentityResult => {
  const status: IdentityStatus = errors.length ? "REJECT" : pending.length ? "HOLD" : "PASS_IDENTITY_ONLY";
  return {
    case_id: typeof a.case_id === "string" ? a.case_id : null,
    attempt_id: typeof a.attempt_id === "string" ? a.attempt_id : null,
    status,
    errors,
    pending,
    can_show_as_target_design: status === "PASS_IDENTITY_ONLY",
    counts_as_owner_success: false,
    note: NOTE,
  };
};

/** The before-generation checks shared by both after-checks: target identity, prompt identity, research only. */
function lockChecks(a: Record<string, unknown>, errors: string[]) {
  const target = obj(a.target);
  const input = obj(a.prompt);
  if (a.schema_version !== 1 || !/^CP-\d{3}$/.test(typeof a.case_id === "string" ? a.case_id : "")) errors.push("SCHEMA_OR_CASE_ID_INVALID");
  if (!filled(target.official_name) || !filled(target.category_code) || !filled(target.official_source_url)) errors.push("TARGET_IDENTITY_INCOMPLETE");
  const allowed = allowedNames(target);
  if (allowed.length === 0) errors.push("TARGET_NAME_MISSING");
  if (!allowed.includes(cleanName(input.shop_name))) errors.push("PROMPT_WRONG_SHOP");
  if (input.category_code !== target.category_code) errors.push("PROMPT_WRONG_CATEGORY");
  if (input.is_research_only !== true) errors.push("NOT_MARKED_RESEARCH_ONLY");
  return { target, allowed };
}

/** A generated image, after a recorded visual inspection of exactly that image (the research script, unchanged in meaning). */
export function auditIdentity(input: unknown): IdentityResult {
  const a = obj(input);
  const errors: string[] = [];
  const pending: string[] = [];
  const { target, allowed } = lockChecks(a, errors);
  const output = obj(a.output);
  const check = obj(a.visual_inspection);
  if (!shaOK(output.image_sha256)) pending.push("OUTPUT_IMAGE_HASH_MISSING");
  // explicitly NOT automated OCR: the observations were taken while viewing the exact output whose SHA is checked
  if (check.status !== "completed" || typeof check.method !== "string" || !["assistant_visual", "human_visual"].includes(check.method)) {
    pending.push("VISUAL_INSPECTION_REQUIRED");
  } else {
    if (!shaOK(check.inspected_image_sha256) || check.inspected_image_sha256 !== output.image_sha256) errors.push("INSPECTION_IMAGE_NOT_MATCHED");
    if (!filled(check.reviewer_note)) pending.push("VISUAL_INSPECTION_NOTE_REQUIRED");
    const labels = check.visible_site_identity_labels;
    if (!Array.isArray(labels) || labels.length === 0) pending.push("VISIBLE_SITE_IDENTITY_UNCONFIRMED");
    else if (labels.some((label) => !allowed.includes(cleanName(label)) || cleanName(label) === "")) errors.push("VISIBLE_WRONG_OR_EXTRA_SHOP_NAME");
    if (check.category_code !== target.category_code) errors.push("VISUAL_WRONG_CATEGORY");
    if (check.unreadable_site_identity === true) pending.push("BRAND_TEXT_UNREADABLE");
    else if (check.unreadable_site_identity !== false) pending.push("BRAND_READABILITY_NOT_RECORDED");
    if (check.image_looks_like_unrelated_shop === true) errors.push("VISUAL_UNRELATED_SHOP");
    else if (check.image_looks_like_unrelated_shop !== false) pending.push("UNRELATED_SHOP_CHECK_MISSING");
  }
  return verdict(a, errors, pending);
}

/**
 * A generated HTML page: its visible text (the caller extracts it from the render) must name the target and no other
 * shop. `other_shop_names` lists the names that must never appear: the shops of the references shown to the
 * generator and any known mix-up. A name shorter than 2 characters after cleaning (Japanese shop names are often 2) is too ambiguous to search for and
 * is refused as input (TARGET_NAME_TOO_SHORT / OTHER_NAME_TOO_SHORT), never silently skipped.
 */
export function auditPageText(input: unknown, visibleText: string): IdentityResult {
  const a = obj(input);
  const errors: string[] = [];
  const pending: string[] = [];
  const allowed = lockChecks(a, errors).allowed.map(cleanPageName);
  const text = cleanPageName(visibleText);
  if (allowed.some((n) => n.length < 2)) errors.push("TARGET_NAME_TOO_SHORT");
  const raw = a.other_shop_names;
  // Array.from fills holes, so a sparse array is checked element by element (a hole is not a name)
  const list = Array.isArray(raw) ? Array.from(raw as unknown[]) : null;
  const others = list && list.every(filled) ? list.map(cleanPageName) : null;
  // never silently skipped: a malformed list is an error, an absent or empty one leaves the page unconfirmed
  if (raw !== undefined && !Array.isArray(raw)) errors.push("OTHER_SHOP_NAMES_INVALID");
  else if (list && !list.every(filled)) errors.push("OTHER_SHOP_NAMES_INVALID");
  if (others === null || others.length === 0) {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) pending.push("OTHER_SHOP_NAMES_NOT_GIVEN");
  } else {
    if (others.some((n) => n.length < 2)) errors.push("OTHER_NAME_TOO_SHORT");
    // an "other" name that contains or is contained in the target's would make the check meaningless
    if (others.some((o) => allowed.some((n) => o.includes(n) || n.includes(o)))) errors.push("OTHER_NAME_OVERLAPS_TARGET");
    else if (others.some((o) => o.length >= 2 && text.includes(o))) errors.push("VISIBLE_WRONG_OR_EXTRA_SHOP_NAME");
  }
  if (!text) pending.push("PAGE_TEXT_EMPTY");
  else if (!allowed.some((n) => n.length >= 2 && text.includes(n))) errors.push("TARGET_NAME_NOT_ON_PAGE");
  return verdict(a, errors, pending);
}
