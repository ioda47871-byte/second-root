/**
 * DEV-196b review round 3 (M1.1): parse5, bounded from inside.
 *
 * Round 2 put a hand-written tag scanner in front of parse5; it disagreed with parse5 on comments (`<!-->`,
 * `--!>`), raw-text elements (`<textarea>`) and unquoted values containing quotes, so 30–60k nested elements got
 * through. Now the limits are enforced by the parser that builds the tree, so no construct can be counted differently:
 *
 *  - open-element depth: `Parser.onItemPush` is the hook the open-element stack calls on every push (and insertAfter);
 *    past `ARTIFACT_PARSE_LIMITS.depth` the parse stops (the slow paths of parse5 are scans of that stack);
 *  - created elements: the tree adapter's `createElement` (every element parse5 makes, including the ones the
 *    adoption agency and formatting reconstruction make);
 *  - attributes per start tag: the tokenizer's `_leaveAttrName` (parse5's duplicate-attribute check is quadratic in
 *    the attributes of one tag), through a Tokenizer subclass;
 *  - every token, element, push and attribute spends from the validation budget (budget.ts).
 *
 * `Parser` is exported by parse5 (marked internal) and pinned at exactly 8.0.1 (package.json); the hooks are covered by
 * tests (review-round-3.test.ts) that fail if a parse5 update renames them (the probes would no longer be refused).
 *
 * Pure: parse5 only.
 */
import { defaultTreeAdapter, Parser, Tokenizer, type DefaultTreeAdapterMap, type DefaultTreeAdapterTypes, type ParserOptions, type Token } from "parse5";
import { BudgetExceeded, type OpBudget } from "./budget";

export const ARTIFACT_PARSE_LIMITS = {
  /** chars (the manifest allows 384 KiB of bytes; a UTF-8 page never has more chars than bytes) */
  htmlChars: 384 * 1024,
  /** open-element stack depth (the research pages stay under 20) */
  depth: 512,
  /** elements created by the parser (the research pages have under 400) */
  elements: 8000,
  /** attributes in one start tag */
  attributesPerTag: 64,
} as const;

export type ParseLimitCode = "HTML_TOO_LARGE" | "HTML_TOO_DEEP" | "HTML_TOO_MANY_ELEMENTS" | "HTML_TOO_MANY_ATTRIBUTES";

class ParseLimit extends Error {
  constructor(readonly code: ParseLimitCode) {
    super(code);
  }
}

type TagToken = { attrs: unknown[] };

class BoundedTokenizer extends Tokenizer {
  constructor(options: ConstructorParameters<typeof Tokenizer>[0], handler: ConstructorParameters<typeof Tokenizer>[1], private readonly budget: OpBudget) {
    super(options, handler);
  }
  protected override _leaveAttrName(): void {
    const token = this.currentToken as unknown as TagToken | null;
    if (token && Array.isArray(token.attrs) && token.attrs.length >= ARTIFACT_PARSE_LIMITS.attributesPerTag) throw new ParseLimit("HTML_TOO_MANY_ATTRIBUTES");
    this.budget.spend(1);
    super._leaveAttrName();
  }
}

class BoundedParser extends Parser<DefaultTreeAdapterMap> {
  constructor(options: ParserOptions<DefaultTreeAdapterMap>, private readonly budget: OpBudget) {
    super(options);
    // the tokenizer made by the base constructor has not read anything yet; replace it and redo the context modes
    this.tokenizer = new BoundedTokenizer(this.options, this, budget);
    this._setContextModes(this.document, this.fragmentContextID);
  }
  override onItemPush(node: DefaultTreeAdapterTypes.ParentNode, tid: number, isTop: boolean): void {
    if (this.openElements.stackTop + 1 > ARTIFACT_PARSE_LIMITS.depth) throw new ParseLimit("HTML_TOO_DEEP");
    this.budget.spend(1);
    super.onItemPush(node, tid, isTop);
  }
  override onStartTag(token: Token.TagToken): void {
    this.budget.spend(1);
    super.onStartTag(token);
  }
  override onEndTag(token: Token.TagToken): void {
    this.budget.spend(1);
    super.onEndTag(token);
  }
  override onCharacter(token: Token.CharacterToken): void {
    this.budget.scan(token.chars);
    super.onCharacter(token);
  }
  override onWhitespaceCharacter(token: Token.CharacterToken): void {
    this.budget.scan(token.chars);
    super.onWhitespaceCharacter(token);
  }
  override onComment(token: Token.CommentToken): void {
    this.budget.scan(token.data);
    super.onComment(token);
  }
}

export type BoundedParseResult = { ok: true; document: DefaultTreeAdapterTypes.Document } | { ok: false; code: ParseLimitCode | "VALIDATION_BUDGET_EXCEEDED" };

/** Parses the artifact's HTML with parse5, stopping at the first limit. Never throws for a limit; rethrows anything else. */
export function boundedParse(html: string, budget: OpBudget): BoundedParseResult {
  if (html.length > ARTIFACT_PARSE_LIMITS.htmlChars) return { ok: false, code: "HTML_TOO_LARGE" };
  let elements = 0;
  const treeAdapter: typeof defaultTreeAdapter = {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      if (++elements > ARTIFACT_PARSE_LIMITS.elements) throw new ParseLimit("HTML_TOO_MANY_ELEMENTS");
      budget.spend(1);
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
  };
  try {
    const parser = new BoundedParser({ treeAdapter }, budget);
    parser.tokenizer.write(html, true);
    return { ok: true, document: parser.document };
  } catch (e) {
    if (e instanceof ParseLimit) return { ok: false, code: e.code };
    if (e instanceof BudgetExceeded) return { ok: false, code: e.code };
    throw e;
  }
}
