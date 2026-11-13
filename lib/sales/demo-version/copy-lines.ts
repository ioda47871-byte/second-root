/**
 * DEV-196p (spec §7.4・T14, owner decision 2026-11-11: required before sharing): a version's visible lines against the
 * copy record stored with it (sales_demo_copy_reviews.copy_record_text, linked by sales_demo_version_copy_links) and
 * the facts pack stored with that record.
 *
 *  - The check is the server's own (checkArtifactCopy, unchanged): every visible line must be a record line or label
 *    (`UNVERIFIED_COPY`), every fact line must come from the facts pack (`FACT_TEXT_NOT_FROM_FACTS`), creative copy
 *    needs the owner (`CREATIVE_WITHOUT_OWNER_REVIEW`), and so on. Re-run here on the stored bytes, so what the compare
 *    page shows is what the import checked, not a cached verdict.
 *  - Each line gets a kind: "fact" — a record line of claim_type fact whose record item has no finding (so it equals
 *    a facts-pack value); "creative" — a record line of claim_type creative_expression / proposal_pending_review (a
 *    heading the owner must judge, quality item 2); "unknown" — anything else (a label, a line not in the record, or a
 *    fact line whose item has a finding). Never "fact" by resemblance alone.
 *
 * Pure. Only counts and fixed codes leave this module besides the page's own visible lines (the admin already sees
 * them in the frame); an email-holding line is replaced by the hidden label and is never a fact.
 */
import { CopyRecord, norm } from "@/lib/design-agent/quality-pipeline/copy-record";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { containsEmail, HIDDEN_EMAIL_LABEL } from "./admin-messages";
import { checkArtifactCopy } from "./copy-check";
import type { CopyLine } from "./compare";

export type StoredCopyBasis = { copyRecordText: string; factsPackText: string; factsSha256: string };

export type CopyRecordCheck = { ok: boolean; codes: string[] };

export type CopyLinesByRecord = { lines: CopyLine[]; check: CopyRecordCheck };

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** null when the stored record or facts pack does not parse (the caller then says the record is unreadable). */
export function classifyByCopyRecord(o: {
  /** the page's visible body lines (the diff's lines) */
  lines: readonly string[];
  /** the texts the server's HTML check gives (checkArtifactHtml(...).texts): what the import's copy check ran on */
  checkedTexts: readonly string[];
  basis: StoredCopyBasis;
}): CopyLinesByRecord | null {
  const { lines: texts, basis } = o;
  const record = CopyRecord.safeParse(parse(basis.copyRecordText));
  const facts = FactsPack.safeParse(parse(basis.factsPackText));
  if (!record.success || !facts.success) return null;
  const result = checkArtifactCopy({ texts: o.checkedTexts, copyRecord: record.data, shopId: facts.data.shop_id, factsSha256: basis.factsSha256, facts: facts.data.facts });
  const flagged = new Set(result.findings.map((f) => f.item).filter((x): x is string => typeof x === "string"));
  // a finding on the whole record (shop, facts hash, schema) makes no fact line trustworthy
  const recordLevel = result.findings.some((f) => f.item === undefined && f.code !== "UNVERIFIED_COPY" && f.code !== "JOINED_TEXT_LOOKS_LIKE_FACT");
  const kindOf = new Map<string, CopyLine["kind"]>();
  for (const i of record.data.items) {
    const key = norm(i.text);
    if (i.claim_type === "fact") {
      if (!recordLevel && !flagged.has(i.id)) kindOf.set(key, "fact");
      else if (!kindOf.has(key)) kindOf.set(key, "unknown");
    } else if (kindOf.get(key) !== "fact") kindOf.set(key, "creative");
  }
  const lines = texts.map((text): CopyLine => (containsEmail(text) ? { text: HIDDEN_EMAIL_LABEL, kind: "unknown" } : { text, kind: kindOf.get(norm(text)) ?? "unknown" }));
  return { lines, check: { ok: result.ok, codes: [...new Set(result.findings.map((f) => f.code))].sort() } };
}
