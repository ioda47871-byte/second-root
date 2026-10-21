// A strict tokenizer and component-value parser for per-shop CSS (DEV-072,
// Stage 3). It follows the CSS Syntax Level 3 tokenization for the small
// subset the guard allows and fails closed on everything else: no escapes
// (a backslash anywhere is rejected before tokenizing: escapes are the classic
// way past a keyword filter), no `<` (so the stylesheet can never close its
// <style> element or open an HTML comment), no non-ASCII outside comments, no
// control characters, no exponent numbers, no unterminated strings or
// comments, no url tokens. Every token keeps its source offsets so the
// An+B microsyntax of :nth-child() can be read from the source.

export class CssSyntaxError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type Tok =
  | { t: "ws"; s: number; e: number }
  | { t: "ident"; v: string; s: number; e: number }
  | { t: "function"; v: string; s: number; e: number }
  | { t: "at"; v: string; s: number; e: number }
  | { t: "hash"; v: string; s: number; e: number }
  | { t: "string"; v: string; s: number; e: number }
  | { t: "num"; v: number; raw: string; s: number; e: number }
  | { t: "pct"; v: number; raw: string; s: number; e: number }
  | { t: "dim"; v: number; raw: string; unit: string; s: number; e: number }
  | { t: "delim"; v: string; s: number; e: number }
  | { t: ":" | ";" | "," | "[" | "]" | "(" | ")" | "{" | "}"; s: number; e: number };

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isNameStart = (c: string | undefined) => isLetter(c) || c === "_";
const isName = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === "-";
const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** The input-level checks, before any tokenizing. */
export function precheck(css: string): void {
  if (css.includes("\\")) throw new CssSyntaxError("escape");
  if (css.includes("<")) throw new CssSyntaxError("angle_bracket");
  for (let i = 0; i < css.length; i++) {
    const code = css.charCodeAt(i);
    // tab, LF, FF, CR only; no NUL, no other C0 control, no DEL
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || code === 0x7f) throw new CssSyntaxError("control_char");
  }
}

export function tokenize(css: string): Tok[] {
  precheck(css);
  const out: Tok[] = [];
  let i = 0;
  const startsIdent = (at: number) => {
    const c = css[at];
    if (isNameStart(c)) return true;
    if (c === "-") return isNameStart(css[at + 1]) || css[at + 1] === "-";
    return false;
  };
  const startsNumber = (at: number) => {
    const c = css[at];
    if (c === "+" || c === "-") return isDigit(css[at + 1]) || (css[at + 1] === "." && isDigit(css[at + 2]));
    if (c === ".") return isDigit(css[at + 1]);
    return isDigit(c);
  };
  const name = (at: number) => {
    let j = at;
    while (isName(css[j])) j++;
    return j;
  };
  while (i < css.length) {
    const c = css[i]!;
    const s = i;
    if (c.charCodeAt(0) > 0x7e) throw new CssSyntaxError("non_ascii");
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) throw new CssSyntaxError("unterminated_comment");
      i = end + 2;
      continue;
    }
    if (isWs(c)) {
      while (isWs(css[i])) i++;
      const last = out[out.length - 1];
      if (last?.t !== "ws") out.push({ t: "ws", s, e: i });
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) {
        if (css[j] === "\n" || css[j] === "\r" || css[j] === "\f") throw new CssSyntaxError("unterminated_string");
        if (css.charCodeAt(j) > 0x7e) throw new CssSyntaxError("non_ascii");
        j++;
      }
      if (j >= css.length) throw new CssSyntaxError("unterminated_string");
      out.push({ t: "string", v: css.slice(i + 1, j), s, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (startsNumber(i)) {
      let j = i;
      if (css[j] === "+" || css[j] === "-") j++;
      while (isDigit(css[j])) j++;
      if (css[j] === "." && isDigit(css[j + 1])) {
        j++;
        while (isDigit(css[j])) j++;
      }
      // exponent notation (1e3) is never needed here and hides magnitudes: fail closed
      if ((css[j] === "e" || css[j] === "E") && (isDigit(css[j + 1]) || ((css[j + 1] === "+" || css[j + 1] === "-") && isDigit(css[j + 2])))) throw new CssSyntaxError("number_format");
      const raw = css.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v) || raw.length > 12) throw new CssSyntaxError("number_format");
      if (css[j] === "%") {
        out.push({ t: "pct", v, raw, s, e: j + 1 });
        i = j + 1;
      } else if (startsIdent(j)) {
        const k = name(j);
        out.push({ t: "dim", v, raw, unit: css.slice(j, k).toLowerCase(), s, e: k });
        i = k;
      } else {
        out.push({ t: "num", v, raw, s, e: j });
        i = j;
      }
      continue;
    }
    if (startsIdent(i)) {
      const k = name(i);
      const v = css.slice(i, k);
      if (v.toLowerCase() === "url" && css[k] === "(") throw new CssSyntaxError("url");
      if (css[k] === "(") {
        out.push({ t: "function", v: v.toLowerCase(), s, e: k + 1 });
        i = k + 1;
      } else {
        out.push({ t: "ident", v, s, e: k });
        i = k;
      }
      continue;
    }
    if (c === "#" && isName(css[i + 1])) {
      const k = name(i + 1);
      out.push({ t: "hash", v: css.slice(i + 1, k), s, e: k });
      i = k;
      continue;
    }
    if (c === "@" && startsIdent(i + 1)) {
      const k = name(i + 1);
      out.push({ t: "at", v: css.slice(i + 1, k).toLowerCase(), s, e: k });
      i = k;
      continue;
    }
    if (c === ":" || c === ";" || c === "," || c === "[" || c === "]" || c === "(" || c === ")" || c === "{" || c === "}") {
      out.push({ t: c, s, e: i + 1 });
      i++;
      continue;
    }
    out.push({ t: "delim", v: c, s, e: i + 1 });
    i++;
  }
  return out;
}

/** A component value: a preserved token, a simple block or a function with its arguments. */
export type CV = Exclude<Tok, { t: "function" | "(" | ")" | "[" | "]" | "{" | "}" }> | { t: "block"; open: "(" | "[" | "{"; items: CV[]; s: number; e: number } | { t: "fn"; name: string; args: CV[]; s: number; e: number };

const CLOSE = { "(": ")", "[": "]", "{": "}" } as const;
const MAX_DEPTH = 8;

/** Component values from tokens; any unmatched bracket rejects the stylesheet (no error recovery). */
export function componentValues(tokens: Tok[]): CV[] {
  let i = 0;
  const list = (close: ")" | "]" | "}" | null, depth: number): CV[] => {
    if (depth > MAX_DEPTH) throw new CssSyntaxError("too_deep");
    const items: CV[] = [];
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.t === ")" || tok.t === "]" || tok.t === "}") {
        if (tok.t !== close) throw new CssSyntaxError("unbalanced");
        return items;
      }
      i++;
      if (tok.t === "(" || tok.t === "[" || tok.t === "{") {
        const inner = list(CLOSE[tok.t], depth + 1);
        const end = tokens[i];
        i++;
        items.push({ t: "block", open: tok.t, items: inner, s: tok.s, e: end ? end.e : tok.e });
      } else if (tok.t === "function") {
        const args = list(")", depth + 1);
        const end = tokens[i];
        i++;
        items.push({ t: "fn", name: tok.v, args, s: tok.s, e: end ? end.e : tok.e });
      } else {
        items.push(tok);
      }
    }
    if (close !== null) throw new CssSyntaxError("unbalanced");
    return items;
  };
  return list(null, 0);
}
