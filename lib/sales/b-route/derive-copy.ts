/**
 * DEV-139 P0-2b: derive the versioned sales copy record from an original B-route prototype.
 *
 * An exact visible text matching an immutable fact is marked as a fact; ALL other text is
 * an owner-reviewed proposal, never silently promoted to a shop fact. The existing server
 * HTML safety and copy-record validator are the single sources of truth.
 * Pure: no network, model, file system, database, template, approval or send action.
 */
import { createHash } from "node:crypto";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { CopyRecord, LABELS_BY_KEY, factParts, norm, isFictionalShop } from "@/lib/design-agent/quality-pipeline/copy-record";
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";

export type BRouteLane = "quality_research_fictional" | "real_shop_proposal";
export type DerivedCopy = {
  record: CopyRecord;
  stats: { fact_lines: number; proposed_lines: number; visible_texts: number };
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

  // These are the only free-standing labels allowed by the existing copy-record
  // contract. Bind them to a fact actually displayed on the same page.
  const labelToFact = new Map<string, typeof facts.facts[number]>();
  const allLabels = new Set(Object.values(LABELS_BY_KEY).flat());
  for (const [key, text] of uniqueTexts) {
    if (!allLabels.has(text) || factMatches.has(key)) continue;
    const sources = facts.facts.filter((f) => (LABELS_BY_KEY[f.key] ?? []).includes(text) &&
      [...factMatches.values()].some((ms) => ms.some((m) => m.id === f.id)));
    if (sources.length !== 1) throw new BRouteCopyStop("LABEL_WITHOUT_UNIQUE_DISPLAYED_FACT");
    labelToFact.set(key, sources[0]!);
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
    if (labelToFact.has(key)) {
      const f = labelToFact.get(key)!;
      add({ text: f.value, label: text, claim_type: "fact", source_fact_ids: [f.id], owner_review_needed: false });
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
      proposed_lines: items.filter((x) => x.claim_type !== "fact").length,
      visible_texts: htmlCheck.texts.length,
    },
    hashes: { facts_sha256: sha(input.factsBytes), html_sha256: sha(input.html), css_sha256: sha(input.css) },
  };
}
