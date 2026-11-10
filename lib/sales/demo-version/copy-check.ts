/**
 * DEV-196b (spec §7.4・T14): the artifact's visible words against its copy record and the shop's facts pack. Reuses
 * the copy-record rules (lib/design-agent/quality-pipeline/copy-record.ts) unchanged: every fact line must come from
 * the facts pack, creative copy needs the owner's review and stays in the fictional research lane, and the page may
 * show no text the record does not hold (`UNVERIFIED_COPY`).
 *
 * Pure. The caller reads the copy record (delivered beside the package, not served) and the facts from the DB.
 */
import { checkCopyRecord, CopyRecord, joinedTextsLookingLikeFact, textsNotInRecord, type CopyFinding } from "@/lib/design-agent/quality-pipeline/copy-record";

export type ArtifactCopyResult = { ok: boolean; findings: CopyFinding[] };

export function checkArtifactCopy(o: {
  /** visible texts of the page (`checkArtifactHtml(...).texts`) */
  texts: readonly string[];
  copyRecord: unknown;
  shopId: string;
  factsSha256: string;
  facts: ReadonlyArray<{ id: string; key?: string; value: string }>;
}): ArtifactCopyResult {
  const base = checkCopyRecord(o.copyRecord, { shopId: o.shopId, factsSha256: o.factsSha256, facts: o.facts });
  const findings = [...base.findings];
  const parsed = CopyRecord.safeParse(o.copyRecord);
  if (parsed.success) {
    // counts only, never the texts themselves (they may be a real shop's words)
    const unverified = textsNotInRecord(o.texts, parsed.data);
    if (unverified.length) findings.push({ code: "UNVERIFIED_COPY", detail: String(unverified.length) });
    const joined = joinedTextsLookingLikeFact(o.texts, parsed.data);
    if (joined.length) findings.push({ code: "JOINED_TEXT_LOOKS_LIKE_FACT", detail: String(joined.length) });
  }
  return { ok: findings.length === 0, findings };
}
