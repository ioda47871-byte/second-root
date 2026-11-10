/**
 * DEV-196b review round 1 (M1・M3): a string-aware CSS token scan for the server's check.
 *
 * The Chromium check (Phase 2f prototype-safety) runs its CSS rules twice: on the text as written and on Chromium's own
 * re-serialisation of every stylesheet. The server has no Chromium, so the rule-core copy (first pass) alone missed
 * a live `url()` hidden behind a comment marker inside a string, escaped comment markers (`\2f\2a`, which a browser
 * reads as identifier characters, never as a comment) and a backslash-newline line continuation inside a quoted URL.
 * This scan replaces the second pass: it tokenises as CSS Syntax §4 does —
 *
 *  - comments only outside strings, and only from a literal `/` `*` (an escaped one is part of an identifier)
 *  - strings with escapes decoded at the token level, a backslash-newline is a line continuation, an unescaped
 *    newline makes a bad string
 *  - identifiers, at-keywords and function names with escapes decoded (so `u\72l(` is the function `url`)
 *  - `url(` followed by an unquoted value is a url token (escapes decoded, a bad url is reported)
 *
 * — and reports what the rules refuse. Bad strings, bad urls and a backslash-newline outside a string are refused
 * (fail closed): a page that needs them is not a page we serve. The CSP (`script-src 'none'`, `img-src` / `style-src`
 * bound to the token path, `sandbox`) stays the backstop.
 *
 * Linear: every character is consumed once; each token spends one unit of the validation budget when one is given.
 *
 * Pure: strings only.
 */
import type { OpBudget } from "./budget";

export type CssToken =
  | { t: "ident"; v: string }
  | { t: "function"; v: string }
  | { t: "at"; v: string }
  | { t: "string"; v: string }
  | { t: "url"; v: string }
  | { t: "bad"; v: "string" | "url" | "escape" }
  | { t: "delim"; v: string }
  | { t: "ws" };

const isHex = (c: string | undefined) => c !== undefined && /[0-9a-fA-F]/.test(c);
const isNewline = (c: string | undefined) => c === "\n" || c === "\r" || c === "\f";
const isWs = (c: string | undefined) => c === " " || c === "\t" || isNewline(c);
const isNameStart = (c: string | undefined) => c !== undefined && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => c !== undefined && (isNameStart(c) || /[0-9-]/.test(c));
/** A valid escape starts at `\` not followed by a newline (CSS Syntax §4.3.8). */
const validEscape = (s: string, i: number) => s[i] === "\\" && i + 1 < s.length && !isNewline(s[i + 1]);

/** Consumes an escape at s[i] === "\\" (valid); returns [decoded char, next index]. */
function escape(s: string, i: number): [string, number] {
  let j = i + 1;
  if (isHex(s[j])) {
    let hex = "";
    while (hex.length < 6 && isHex(s[j])) hex += s[j++];
    if (s[j] === "\r" && s[j + 1] === "\n") j += 2;
    else if (isWs(s[j])) j++;
    const cp = parseInt(hex, 16);
    return [String.fromCodePoint(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp), j];
  }
  if (j >= s.length) return ["�", j];
  const cp = s.codePointAt(j)!;
  const ch = String.fromCodePoint(cp);
  return [ch, j + ch.length];
}

function ident(s: string, i: number): [string, number] {
  let out = "";
  while (i < s.length) {
    if (validEscape(s, i)) {
      const [c, j] = escape(s, i);
      out += c;
      i = j;
    } else if (isName(s[i])) out += s[i++];
    else break;
  }
  return [out, i];
}

const startsIdent = (s: string, i: number) =>
  isNameStart(s[i]) || validEscape(s, i) || (s[i] === "-" && (isNameStart(s[i + 1]) || s[i + 1] === "-" || validEscape(s, i + 1)));

/** Tokenises a stylesheet (or one declaration value / attribute value). */
export function cssTokens(s: string, budget?: OpBudget): CssToken[] {
  const out: CssToken[] = [];
  let i = 0;
  while (i < s.length) {
    budget?.spend(1);
    const c = s[i]!;
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (isWs(c)) {
      while (isWs(s[i])) i++;
      out.push({ t: "ws" });
      continue;
    }
    if (c === '"' || c === "'") {
      let v = "";
      let bad = false;
      i++;
      while (i < s.length && s[i] !== c) {
        if (isNewline(s[i])) {
          bad = true;
          break;
        }
        if (s[i] === "\\") {
          if (i + 1 >= s.length) {
            i++;
            continue;
          }
          if (isNewline(s[i + 1])) {
            // line continuation: the backslash and the newline vanish
            i += s[i + 1] === "\r" && s[i + 2] === "\n" ? 3 : 2;
            continue;
          }
          const [ch, j] = escape(s, i);
          v += ch;
          i = j;
          continue;
        }
        v += s[i++];
      }
      if (bad) out.push({ t: "bad", v: "string" });
      else {
        i++;
        out.push({ t: "string", v });
      }
      continue;
    }
    if (c === "@" && startsIdent(s, i + 1)) {
      const [v, j] = ident(s, i + 1);
      out.push({ t: "at", v: v.toLowerCase() });
      i = j;
      continue;
    }
    if (startsIdent(s, i)) {
      const [v, j] = ident(s, i);
      i = j;
      if (s[i] !== "(") {
        out.push({ t: "ident", v });
        continue;
      }
      i++;
      const name = v.toLowerCase();
      if (name !== "url") {
        out.push({ t: "function", v: name });
        continue;
      }
      let k = i;
      while (isWs(s[k])) k++;
      if (s[k] === '"' || s[k] === "'") {
        out.push({ t: "function", v: "url" });
        i = k;
        continue;
      }
      // an unquoted url token
      i = k;
      let u = "";
      let bad = false;
      while (i < s.length && s[i] !== ")") {
        if (isWs(s[i])) {
          while (isWs(s[i])) i++;
          if (s[i] !== ")" && i < s.length) bad = true;
          continue;
        }
        if (s[i] === '"' || s[i] === "'" || s[i] === "(" || s.charCodeAt(i) < 0x20 || s.charCodeAt(i) === 0x7f) {
          bad = true;
          i++;
          continue;
        }
        if (s[i] === "\\") {
          if (!validEscape(s, i)) {
            bad = true;
            i++;
            continue;
          }
          const [ch, j] = escape(s, i);
          u += ch;
          i = j;
          continue;
        }
        u += s[i++];
      }
      i++;
      out.push(bad ? { t: "bad", v: "url" } : { t: "url", v: u.trim() });
      continue;
    }
    if (c === "\\") {
      // a backslash that cannot start an escape (backslash-newline outside a string)
      out.push({ t: "bad", v: "escape" });
      i += 1;
      continue;
    }
    out.push({ t: "delim", v: c });
    i++;
  }
  return out;
}

export type CssScanCode = "CSS_IMPORT" | "CSS_FONT_FACE" | "CSS_AT_RULE_NOT_ALLOWED" | "CSS_URL_NOT_ALLOWED" | "CSS_IMAGE_FUNCTION" | "CSS_CODE_EXECUTION" | "CSS_SYNTAX_SUSPICIOUS";

const IMAGE_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "image", "src", "cross-fade", "-webkit-cross-fade", "element", "-moz-element", "paint", "-webkit-canvas"]);
/** at-rules that load something or draw text from CSS */
const REFUSED_AT_RULES = new Set(["namespace", "counter-style", "document", "-moz-document", "font-feature-values", "font-palette-values", "view-transition"]);

/**
 * What the token scan refuses in a stylesheet (or an attribute parsed as CSS): @import, @font-face and other loading
 * at-rules, url() / url token to anything but a declared photo or `#id`, image functions other than url(),
 * expression() / behavior / -moz-binding / javascript:, and bad strings / bad urls / stray escapes.
 */
export function cssScanProblems(css: string, allowedUrl: (target: string) => boolean, budget?: OpBudget): Array<{ code: CssScanCode; detail?: string }> {
  const out: Array<{ code: CssScanCode; detail?: string }> = [];
  const toks = cssTokens(css, budget);
  const next = (k: number) => {
    let j = k + 1;
    while (toks[j]?.t === "ws") j++;
    return toks[j];
  };
  toks.forEach((tok, k) => {
    if (tok.t === "bad") out.push({ code: "CSS_SYNTAX_SUSPICIOUS", detail: tok.v });
    else if (tok.t === "at") {
      if (tok.v === "import") out.push({ code: "CSS_IMPORT" });
      else if (tok.v === "font-face") out.push({ code: "CSS_FONT_FACE" });
      else if (REFUSED_AT_RULES.has(tok.v)) out.push({ code: "CSS_AT_RULE_NOT_ALLOWED", detail: tok.v });
    } else if (tok.t === "url") {
      if (!allowedUrl(tok.v)) out.push({ code: "CSS_URL_NOT_ALLOWED", detail: tok.v });
    } else if (tok.t === "function") {
      if (tok.v === "url") {
        const arg = next(k);
        if (arg?.t !== "string" || !allowedUrl(arg.v)) out.push({ code: "CSS_URL_NOT_ALLOWED", detail: arg?.t === "string" ? arg.v : "?" });
      } else if (IMAGE_FUNCTIONS.has(tok.v)) out.push({ code: "CSS_IMAGE_FUNCTION", detail: tok.v });
      else if (tok.v === "expression") out.push({ code: "CSS_CODE_EXECUTION", detail: tok.v });
    } else if (tok.t === "ident") {
      const lower = tok.v.toLowerCase();
      if (lower === "-moz-binding" || (lower === "behavior" && next(k)?.t === "delim" && (next(k) as { v: string }).v === ":")) out.push({ code: "CSS_CODE_EXECUTION", detail: lower });
    } else if (tok.t === "string") {
      if (/javascript:|vbscript:/i.test(tok.v)) out.push({ code: "CSS_CODE_EXECUTION", detail: "javascript:" });
    }
  });
  return out;
}

/**
 * The non-empty strings of a CSS value (escape-aware), e.g. the text a `content:` would draw. The argument of
 * `url("…")` is a URL, not text (the url rule checks it), so it is left out.
 */
export function cssStrings(value: string): string[] {
  const toks = cssTokens(value).filter((t) => t.t !== "ws");
  return toks.flatMap((t, k) => (t.t === "string" && t.v.length > 0 && !(toks[k - 1]?.t === "function" && toks[k - 1]!.v === "url") ? [t.v] : []));
}
