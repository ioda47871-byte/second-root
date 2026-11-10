/**
 * DEV-196b (spec §7.3・T2): the B方式 rule core, parser-free, for the server's check.
 *
 * WHY A COPY: the source of these rules is the Phase 2f prototype-safety module (FORBIDDEN_ELEMENTS, URL_ATTRIBUTES,
 * cssUrls, decodeEscapes, outsideStringsAndComments, cssProblems, allowedUrl) and the font lists of the comp-impl
 * page-css module (PAGE_FONT_FAMILIES and the generic families). Both directories are behind owner-approved import
 * boundaries (their isolation tests under tests/unit/design-agent pin the exact importers), and DEV-196b's approval
 * does not extend them. So the rules are copied here VERBATIM, and
 * tests/unit/sales/demo-version/rule-core-parity.test.ts fails the moment either copy drifts from its source (it
 * compares the lists and runs both CSS checks over the same corpus). If the owner approves lib/sales/demo-version as
 * an importer, this file becomes re-exports.
 *
 * Pure: strings only.
 */

/** = prototype-safety FORBIDDEN_ELEMENTS */
export const FORBIDDEN_ELEMENTS = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "base", "portal", "foreignobject", "animate", "set", "animatemotion", "animatetransform", "noscript"];
/** = prototype-safety URL_ATTRIBUTES */
export const URL_ATTRIBUTES = ["href", "src", "srcset", "poster", "data", "action", "formaction", "background", "xlink:href", "ping", "cite", "longdesc", "manifest", "icon", "lowsrc", "dynsrc", "codebase", "archive"];
/** = prototype-safety PROTOTYPE_STYLESHEET */
export const PROTOTYPE_STYLESHEET = "style.css";

/** = page-css PAGE_FONT_FAMILIES */
export const PAGE_FONT_FAMILIES = [
  "Noto Sans JP", "Noto Serif JP", "Noto Sans CJK JP", "Noto Serif CJK JP", "IPAGothic", "IPAPGothic", "IPAMincho", "IPAPMincho",
  "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Hiragino Mincho ProN", "Yu Gothic", "YuGothic", "Yu Mincho", "YuMincho", "Meiryo",
  "BIZ UDPGothic", "BIZ UDPMincho", "Zen Kaku Gothic New", "Zen Old Mincho", "Shippori Mincho",
  "Inter", "DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif", "Helvetica Neue", "Helvetica", "Arial", "Georgia", "Times New Roman",
] as const;
/** = page-css GENERIC (the generic families a page may name) */
export const PAGE_FONT_GENERIC_FAMILIES = ["serif", "sans-serif", "system-ui", "ui-serif", "ui-sans-serif"];

/** = prototype-safety cssUrls: url() targets in a CSS text, quoted strings understood. */
export function cssUrls(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"')\s]*))\s*\)/gi)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1").trim());
  }
  return out;
}

/** = prototype-safety allowedUrl: a declared asset, or an in-page reference (#id). */
export const allowedUrl = (target: string, assets: ReadonlySet<string>) => assets.has(target) || /^#[A-Za-z0-9_-]+$/.test(target);

/** = prototype-safety decodeEscapes */
export const decodeEscapes = (css: string) =>
  css.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n0-9a-fA-F])/g, (_m, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : (ch ?? ""),
  );

/** = prototype-safety outsideStringsAndComments */
export function outsideStringsAndComments(css: string): string {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") {
      out += css.slice(i, i + 2);
      i++;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? css.length : end + 1;
    } else if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c && css[i] !== "\n"; i++) if (css[i] === "\\") i++;
      out += " ";
    } else out += c;
  }
  return out;
}

/** = prototype-safety cssProblems (the non-canonical branch: the server has no Chromium re-serialisation). */
export function cssProblems(css: string, assets: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const decoded = decodeEscapes(css);
  const flat = decoded.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/@import/i.test(decodeEscapes(outsideStringsAndComments(css)))) out.push("css @import");
  if (/expression\s*\(|(?<!scroll-)behavior\s*:|-moz-binding|javascript:/i.test(flat)) out.push("css code execution");
  for (const target of cssUrls(flat)) if (!allowedUrl(target, assets)) out.push(`css url: ${target.slice(0, 80)}`);
  if (/image-set\(|image\(|src\(/i.test(flat)) out.push("css image function other than url()");
  return out;
}
