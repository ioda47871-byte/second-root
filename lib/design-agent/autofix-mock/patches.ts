/**
 * DEV-146 (Issue #177 D, MOCK ONLY, opt-in, unwired): the limited automatic fixes, as pure functions.
 *
 * Only measurable phone problems are in scope (docs/design/limited-autofix.md): a page wider than the phone, text cut
 * off by a box with a fixed height, a tap target smaller than 44 px, text smaller than 12 px. A fix is a small,
 * deterministic CSS override, appended to the IMPLEMENTATION's CSS inside an SP-only media query, for the selectors the
 * locator found. It never touches HTML, text or facts, and its declarations come from the fixed table below (no free
 * text). Nothing here applies a patch to a file: it returns strings.
 */

/** The SP codes (DEV-134) and the page-width measure this lane may act on, by cause. Everything else is out of scope. */
export const CAUSE_OF_CODE = {
  PAGE_HORIZONTAL_OVERFLOW: "HORIZONTAL_OVERFLOW",
  SP_TEXT_CLIPPED: "TEXT_CLIPPED",
  SP_TAP_TARGET_BELOW_44: "TAP_TARGET",
  SP_TAP_TARGET_TOO_SMALL: "TAP_TARGET",
  SP_TEXT_TOO_SMALL: "TEXT_TOO_SMALL",
} as const;
export type InScopeCode = keyof typeof CAUSE_OF_CODE;
export type Cause = (typeof CAUSE_OF_CODE)[InScopeCode];
/** The page-width code this lane derives from the SP render's scrollWidth (the SP checks do not name it). */
export const OVERFLOW_CODE = "PAGE_HORIZONTAL_OVERFLOW" as const;
export const SP_WIDTH = 390;

export const isInScope = (code: string): code is InScopeCode => Object.prototype.hasOwnProperty.call(CAUSE_OF_CODE, code);
export const causeOf = (code: string): Cause | null => (isInScope(code) ? CAUSE_OF_CODE[code] : null);

/**
 * The patch variants per cause, in the order they are tried (variant n for the n-th fix of that cause). Each is a fixed
 * declaration list: sizes, wrapping and the removal of a fixed height. Never colour, type face, visibility, content,
 * position or anything that hides or moves text.
 */
export const VARIANTS: Record<Cause, readonly (readonly string[])[]> = {
  HORIZONTAL_OVERFLOW: [
    ["max-width: 100%", "box-sizing: border-box"],
    ["max-width: 100%", "box-sizing: border-box", "flex-wrap: wrap", "overflow-wrap: anywhere"],
  ],
  TEXT_CLIPPED: [
    ["height: auto", "max-height: none"],
    ["height: auto", "max-height: none", "overflow: visible"],
  ],
  TAP_TARGET: [
    ["min-width: 44px", "min-height: 44px", "box-sizing: border-box"],
    ["min-width: 44px", "min-height: 44px", "box-sizing: border-box", "display: inline-block"],
  ],
  TEXT_TOO_SMALL: [["font-size: 12px"]],
};
/** Every property a patch may set (the tests pin that no variant leaves this list). */
export const PATCH_PROPERTIES = ["max-width", "box-sizing", "flex-wrap", "overflow-wrap", "height", "max-height", "overflow", "min-width", "min-height", "display", "font-size"] as const;

/** The media query every patch sits in: the PC 1440 page never sees it. */
export const SP_MEDIA = "(max-width: 480px)";

/**
 * A selector the locator may name: element names, #id, .class and :nth-of-type(n) joined by " > ". Nothing that could
 * close a rule, open a comment or carry a string.
 */
const STEP = String.raw`(?:[a-z][a-z0-9-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*(?::nth-of-type\([1-9][0-9]{0,2}\))?|#[A-Za-z_][A-Za-z0-9_-]*)`;
export const SELECTOR = new RegExp(`^${STEP}(?: > ${STEP}){0,24}$`);
export const isSelector = (s: unknown): s is string => typeof s === "string" && s.length <= 300 && SELECTOR.test(s);

export type Patch = { cause: Cause; variant: number; selectors: string[]; declarations: readonly string[]; css: string };

/** The n-th (1-based) patch for a cause, for these selectors; null when the cause has no n-th variant or a selector is not one. */
export function candidatePatch(cause: Cause, selectors: readonly string[], n: number): Patch | null {
  const declarations = VARIANTS[cause][n - 1];
  const list = [...new Set(selectors)].sort();
  if (!declarations || list.length === 0 || !list.every(isSelector)) return null;
  const css = [`/* sr-autofix-mock DEV-146: ${cause} v${n} (SP only, proposal) */`, `@media ${SP_MEDIA} {`, `  ${list.join(", ")} { ${declarations.join("; ")}; }`, `}`, ``].join("\n");
  return { cause, variant: n, selectors: list, declarations, css };
}

/** The CSS with the patch appended (append-only: the original bytes stay a prefix). */
export const applyPatch = (css: string, patch: Patch): string => `${css}${css === "" || css.endsWith("\n") ? "" : "\n"}${patch.css}`;

/** Lines with their terminators ("" has none). */
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * A unified diff (one hunk, 3 lines of context) between two texts that differ in one contiguous run of lines, which is
 * all an append-only patch produces. Texts that are equal give "".
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const a = lines(before);
  const b = lines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ctx = 3;
  const start = Math.max(0, pre - ctx);
  const endA = Math.min(a.length, a.length - suf + ctx);
  const endB = Math.min(b.length, b.length - suf + ctx);
  const out = [`--- a/${path}\n`, `+++ b/${path}\n`];
  const range = (s: number, e: number) => `${e - s === 0 ? s : s + 1},${e - s}`;
  out.push(`@@ -${range(start, endA)} +${range(start, endB)} @@\n`);
  const emit = (mark: string, l: string) => out.push(`${mark}${l}${l.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`);
  for (let i = start; i < pre; i++) emit(" ", a[i]!);
  for (let i = pre; i < a.length - suf; i++) emit("-", a[i]!);
  for (let i = pre; i < b.length - suf; i++) emit("+", b[i]!);
  for (let i = a.length - suf; i < endA; i++) emit(" ", a[i]!);
  return out.join("");
}
