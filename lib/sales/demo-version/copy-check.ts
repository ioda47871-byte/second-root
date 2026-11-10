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

/** The longest page text a copy-record item can match (item text ≤ 300 chars, label ≤ 20, with room for spacing). */
export const MAX_RECORDED_TEXT = 400;

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
    // review round 3: the copy-record signs (e.g. `[一二…]+(年|代|…)`) backtrack on a long run, so only texts a record
    // item could hold reach them. A record item is at most 300 chars (plus a label), so a longer text is unverified
    // by its length alone.
    const short = o.texts.filter((t) => t.length <= MAX_RECORDED_TEXT);
    const long = o.texts.length - short.length;
    // counts only, never the texts themselves (they may be a real shop's words)
    const unverified = textsNotInRecord(short, parsed.data).length + long;
    if (unverified) findings.push({ code: "UNVERIFIED_COPY", detail: String(unverified) });
    const joined = joinedTextsLookingLikeFact(short, parsed.data);
    if (joined.length) findings.push({ code: "JOINED_TEXT_LOOKS_LIKE_FACT", detail: String(joined.length) });
  }
  return { ok: findings.length === 0, findings };
}
