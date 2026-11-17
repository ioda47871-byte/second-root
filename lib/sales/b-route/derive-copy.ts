/**
 * DEV-139 P0-2b: derive the versioned sales copy record from an original B-route prototype.
 *
 * An exact visible text matching an immutable fact is marked as a fact; ALL other text is
 * an owner-reviewed proposal, never silently promoted to a shop fact. The existing server
 * HTML safety and copy-record validator are the single sources of truth.
 * Pure: no network, model, file system, database, template, approval or send action.
 */
import { createHash } from "node:crypto";
import type { DefaultTreeAdapterTypes } from "parse5";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { CopyRecord, LABELS_BY_KEY, factParts, norm, isFictionalShop } from "@/lib/design-agent/quality-pipeline/copy-record";
import { boundedParse } from "@/lib/sales/demo-version/bounded-parse";
import { OpBudget } from "@/lib/sales/demo-version/budget";
import { checkArtifactHtml, trimAsciiWs } from "@/lib/sales/demo-version/html-safety";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";

export type BRouteLane = "quality_research_fictional" | "real_shop_proposal";
export type DerivedCopy = {
  record: CopyRecord;
  /**
   * label_bound_fact_lines (review of PR #279, L7): fact lines bound to a label by the parse tree only. CSS can still
   * hide or reorder such a pair, so the visual reviewer checks each label/value pair on the PC/SP renders.
   */
  stats: { fact_lines: number; label_bound_fact_lines: number; proposed_lines: number; visible_texts: number };
  hashes: { facts_sha256: string; html_sha256: string; css_sha256: string };
};

export class BRouteCopyStop extends Error {
  constructor(public readonly code: string, public readonly findings: readonly string[] = []) {
    super(code);
    this.name = "BRouteCopyStop";
  }
}
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const MAX_TEXTS = 120;

/**
 * Explicit lane is mandatory. "real_shop_proposal" is never a permission to publish:
 * facts still need the existing owner's immutable facts-store approval and copy review.
 */
export function deriveBRouteCopy(input: {
  factsBytes: Uint8Array;
  html: string;
  css: string;
  lane: BRouteLane;
}): DerivedCopy {
  if (!["quality_research_fictional", "real_shop_proposal"].includes(input.lane))
    throw new BRouteCopyStop("LANE_INVALID");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.factsBytes)); }
  catch { throw new BRouteCopyStop("FACTS_JSON_INVALID"); }
  const parsed = FactsPack.safeParse(raw);
  if (!parsed.success) throw new BRouteCopyStop("FACTS_SCHEMA");
  const facts = parsed.data;
  if (new Set(facts.facts.map((f) => f.id)).size !== facts.facts.length)
    throw new BRouteCopyStop("FACT_IDS_DUPLICATED");
  if (input.lane === "quality_research_fictional" && !isFictionalShop({ shopId: facts.shop_id, facts: facts.facts }))
    throw new BRouteCopyStop("RESEARCH_LANE_NOT_FICTIONAL");

  // Run precisely the HTML/CSS safety validator used by the hosted demo package.
  // No photos: image slots remain only CSS shapes, not guessed merchandise.
  const htmlCheck = checkArtifactHtml(input.html, input.css, new Set<string>());
  if (!htmlCheck.ok) throw new BRouteCopyStop("ARTIFACT_HTML_UNSAFE", htmlCheck.findings.map((x) => x.code));
  const uniqueTexts = new Map<string, string>();
  for (const text of htmlCheck.texts) {
    const key = norm(text);
    if (key && !uniqueTexts.has(key)) uniqueTexts.set(key, text);
  }
  if (!uniqueTexts.size || uniqueTexts.size > MAX_TEXTS) throw new BRouteCopyStop("VISIBLE_TEXT_COUNT");
  if ([...uniqueTexts.values()].some((x) => x.length > 300))
    throw new BRouteCopyStop("VISIBLE_TEXT_TOO_LONG");

  const factMatches = new Map<string, typeof facts.facts>();
  for (const [key] of uniqueTexts) {
    const matches = facts.facts.filter((f) => factParts(f.value).has(key));
    if (matches.length) factMatches.set(key, matches);
  }

  // These are the only free-standing labels allowed by the existing copy-record contract. A label is bound to a
  // fact ONLY when the parse tree shows them side by side (see adjacentValue); a label merely somewhere on the same
  // page as a fact of its key is never promoted to a verified fact line.
  type Fact = typeof facts.facts[number];
  const labelBindings = new Map<string, { text: string; facts: Fact[] }>();
  const allLabels = new Set(Object.values(LABELS_BY_KEY).flat());
  const labelKeys = [...uniqueTexts].filter(([key, text]) => allLabels.has(text) && !factMatches.has(key)).map(([key]) => key);
  if (labelKeys.length) {
    const parsedTree = boundedParse(input.html, new OpBudget());
    if (!parsedTree.ok) throw new BRouteCopyStop("ARTIFACT_HTML_UNSAFE", [parsedTree.code]);
    const occurrences = labelOccurrences(parsedTree.document, new Set(labelKeys));
    for (const key of labelKeys) {
      const label = uniqueTexts.get(key)!;
      const nodes = occurrences.get(key) ?? [];
      // a label only in an attribute (alt, title ...) has no neighbour in the tree
      if (!nodes.length) throw new BRouteCopyStop("LABEL_NOT_ADJACENT_TO_FACT");
      let bound: { text: string; facts: Fact[] } | undefined;
      for (const node of nodes) {
        const value = adjacentValue(node, key);
        const valueKey = value === undefined ? "" : norm(value);
        const sources = (factMatches.get(valueKey) ?? []).filter((f) => (LABELS_BY_KEY[f.key] ?? []).includes(label));
        if (!sources.length) throw new BRouteCopyStop("LABEL_NOT_ADJACENT_TO_FACT");
        // the record holds one item per label: every occurrence must introduce the same displayed fact
        if (bound && (norm(bound.text) !== valueKey || bound.facts.map((f) => f.id).join() !== sources.map((f) => f.id).join()))
          throw new BRouteCopyStop("LABEL_BINDING_AMBIGUOUS");
        bound = { text: uniqueTexts.get(valueKey)!, facts: sources };
      }
      labelBindings.set(key, bound!);
    }
  }

  const items: CopyRecord["items"] = [];
  let i = 0;
  const add = (part: Omit<CopyRecord["items"][number], "id">) => {
    items.push({ id: `line-${String(++i).padStart(3, "0")}`, ...part });
  };
  for (const [key, text] of uniqueTexts) {
    const factsFor = factMatches.get(key);
    if (factsFor) {
      // Equal texts from different facts can have multiple attributions. Do not guess
      // which of two different factual meanings the author intended.
      if (new Set(factsFor.map((f) => f.value)).size > 1) throw new BRouteCopyStop("FACT_SOURCE_AMBIGUOUS");
      if (factsFor.length > 8) throw new BRouteCopyStop("FACT_SOURCES_OVER_LIMIT");
      add({ text, claim_type: "fact", source_fact_ids: factsFor.map((f) => f.id), owner_review_needed: false });
      continue;
    }
    const binding = labelBindings.get(key);
    if (binding) {
      // the displayed (matched) text, not the whole fact value: the page may show only part of the fact
      if (binding.facts.length > 8) throw new BRouteCopyStop("FACT_SOURCES_OVER_LIMIT");
      // review round 2 L5: CSS (display:none by class, order, grid placement, off-screen, row-reverse ...) can still
      // hide or reorder a label/value pair the HTML shows side by side, and HTML-only parsing cannot settle that. A
      // label binding is therefore never a clean "no review" fact: the visual review and the owner check it.
      add({ text: binding.text, label: text, claim_type: "fact", source_fact_ids: binding.facts.map((f) => f.id), owner_review_needed: true });
      continue;
    }
    add({ text, claim_type: input.lane === "quality_research_fictional" ? "creative_expression" : "proposal_pending_review",
      source_fact_ids: [], owner_review_needed: true });
  }

  const record = CopyRecord.safeParse({
    schema: "comp_copy_v1", shop_id: facts.shop_id, facts_sha256: sha(input.factsBytes),
    lane: input.lane, items,
  });
  if (!record.success) throw new BRouteCopyStop("COPY_SCHEMA");
  const checked = checkArtifactCopy({
    texts: htmlCheck.texts, copyRecord: record.data, shopId: facts.shop_id,
    factsSha256: sha(input.factsBytes), facts: facts.facts,
  });
  if (!checked.ok) throw new BRouteCopyStop("COPY_UNSUPPORTED", checked.findings.map((x) => x.code));
  return {
    record: record.data,
    stats: {
      fact_lines: items.filter((x) => x.claim_type === "fact").length,
      label_bound_fact_lines: items.filter((x) => x.claim_type === "fact" && x.label !== undefined).length,
      proposed_lines: items.filter((x) => x.claim_type !== "fact").length,
      visible_texts: htmlCheck.texts.length,
    },
    hashes: { facts_sha256: sha(input.factsBytes), html_sha256: sha(input.html), css_sha256: sha(input.css) },
  };
}

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;
const isElement = (n: Node): n is Element => "tagName" in n;
const visible = (t: string) => trimAsciiWs(t).trim();

/** Children to walk, including <template> content (as the HTML safety check walks it). */
function children(n: Node): Node[] {
  const out: Node[] = "childNodes" in n ? [...(n as ParentNode).childNodes] : [];
  if (isElement(n) && n.tagName === "template") out.push(...(n as DefaultTreeAdapterTypes.Template).content.childNodes);
  return out;
}

/** The text a reader sees in a node: its text nodes, in document order, joined (iterative: no stack overflow). */
function textOf(n: Node): string {
  let out = "";
  const stack: Node[] = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (x.nodeName === "#text") out += (x as DefaultTreeAdapterTypes.TextNode).value;
    else stack.push(...children(x).reverse());
  }
  return out;
}

/** Every text node whose visible text is one of the label keys. */
function labelOccurrences(doc: Node, keys: ReadonlySet<string>): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  const stack: Node[] = [doc];
  while (stack.length) {
    const x = stack.pop()!;
    if (x.nodeName === "#text") {
      const key = norm(visible((x as DefaultTreeAdapterTypes.TextNode).value));
      if (keys.has(key)) out.set(key, [...(out.get(key) ?? []), x]);
      continue;
    }
    stack.push(...children(x).reverse());
  }
  return out;
}

/** `hidden` (any value) or aria-hidden="true": the element and everything in it are not shown (review round 2 M2). */
function hiddenElement(n: Node): boolean {
  if (!isElement(n)) return false;
  return n.attrs.some((a) => a.name === "hidden" || (a.name === "aria-hidden" && trimAsciiWs(a.value).toLowerCase() === "true"));
}

/** True when the node or an ancestor is hidden, or it lives in <template> content (never rendered). */
function hiddenOrInHidden(n: Node): boolean {
  for (let x: Node | null = n; x; x = (x as DefaultTreeAdapterTypes.ChildNode).parentNode as Node | null) {
    if (x.nodeName === "#document") return false;
    if (x.nodeName === "#document-fragment") return true; // template content
    if (hiddenElement(x)) return true;
  }
  return true; // detached: not shown
}

/** True when the node or anything inside it is hidden (its text would include words the reader does not see). */
function containsHidden(n: Node): boolean {
  const stack: Node[] = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (hiddenElement(x)) return true;
    stack.push(...children(x));
  }
  return false;
}

/**
 * The next sibling that shows something. Whitespace, comments, <br>/<wbr> and hidden elements are skipped; any
 * other element counts, even an empty one (a CSS shape between the label and what follows breaks the adjacency).
 */
function nextShownSibling(n: Node): Node | undefined {
  const parent = (n as DefaultTreeAdapterTypes.ChildNode).parentNode as ParentNode | null;
  if (!parent) return undefined;
  const sibs = parent.childNodes;
  for (let i = sibs.indexOf(n as DefaultTreeAdapterTypes.ChildNode) + 1; i < sibs.length; i++) {
    const s = sibs[i]!;
    if (s.nodeName === "#comment") continue;
    if (isElement(s)) {
      if (s.tagName === "br" || s.tagName === "wbr" || hiddenElement(s)) continue;
      return s;
    }
    if (visible(textOf(s))) return s;
  }
  return undefined;
}

/**
 * The text the parse tree shows right beside a label text node, or undefined. The label's carrier is the highest
 * element (below <body>) whose whole text is the label (<dt><span>営業時間</span></dt> → the dt). Then:
 *   dt → the immediately following dd; th → the immediately following td (same row);
 *   any other carrier → its immediately following shown sibling (an element, or a text node in the same parent).
 * Anything else (a dd further down, a value in another section) is not adjacent. Hidden elements (`hidden`,
 * aria-hidden="true", <template> content) are not shown: a hidden label or a value with hidden parts never binds.
 * CSS can still hide or reorder what the HTML shows side by side, so every binding keeps the owner's review.
 */
function adjacentValue(textNode: Node, key: string): string | undefined {
  // a hidden label introduces nothing the reader sees
  if (hiddenOrInHidden(textNode)) return undefined;
  let carrier: Node = textNode;
  for (;;) {
    const parent = (carrier as DefaultTreeAdapterTypes.ChildNode).parentNode as Node | null;
    if (!parent || !isElement(parent) || ["body", "html", "head"].includes(parent.tagName)) break;
    if (norm(visible(textOf(parent))) !== key) break;
    carrier = parent;
  }
  const next = nextShownSibling(carrier);
  if (!next) return undefined;
  const tag = isElement(carrier) ? carrier.tagName : "";
  if (tag === "dt" && !(isElement(next) && next.tagName === "dd")) return undefined;
  if (tag === "th" && !(isElement(next) && next.tagName === "td")) return undefined;
  if (isElement(next) && (next.tagName === "dt" || next.tagName === "th")) return undefined;
  // a value with hidden parts shows other words than its text: never bind it
  if (containsHidden(next)) return undefined;
  return visible(textOf(next));
}
