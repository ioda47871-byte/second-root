/**
 * DEV-199e: copy review scenarios for the store and send-gate tests (unit and integration). Built only from the
 * DEV-199a synthetic fixtures (the made-up real-shop sample "パン店 見本"); no network, no model.
 */
import { reviewCopyQuality, type CopyQualityFiles, type CopyQualityReview } from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import type { CopyCandidate } from "@/lib/sales/copy-review/gate";
import * as fx from "../unit/design-agent/quality-pipeline/copy-quality-fixtures";

export { fx };

/** The review as a package holds it (pretty JSON + newline, like DEV-199d's tests). */
export const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export type Round = { files: CopyQualityFiles & { record: Record<string, unknown> }; review: CopyQualityReview };

const str = (b: string | Uint8Array) => (typeof b === "string" ? b : new TextDecoder().decode(b));

export const candidateOf = (r: Round): CopyCandidate => ({
  review: json(r.review),
  copyRecord: str(r.files.copyRecord),
  factsPack: str(r.files.factsPack),
  pageHtml: str(r.files.pageHtml),
  pageCss: str(r.files.pageCss),
});

const earlier = (...rs: Round[]) => rs.map((r) => ({ copyRecord: r.files.copyRecord, pageHtml: r.files.pageHtml, pageCss: r.files.pageCss }));

/** Real-shop page whose copy passes (copy verdict approve_candidate, verdict hold = COPY_APPROVAL_MISSING): owner review. */
export function cleanRound0(o: { css?: string } = {}): Round {
  const base = fx.realShop();
  const files = o.css ? { ...base, pageCss: o.css } : base;
  return { files, review: reviewCopyQuality(files) };
}

/** Real shop: round 0 asks for a revision (prose without a fact); round 1 rewords in place and passes (DEV-199a M1). */
export function auditReviseChain(): [Round, Round] {
  const f0 = fx.realShop({ prose: ["朝の棚に、焼きたてを。"] });
  const r0 = reviewCopyQuality(f0);
  const rec1 = { ...f0.record, items: (f0.record.items as fx.Item[]).filter((i) => i.id !== "p1") };
  const f1 = { ...f0, copyRecord: `${JSON.stringify(rec1, null, 2)}\n`, pageHtml: String(f0.pageHtml).replace("朝の棚に、焼きたてを。", "営業時間"), record: rec1 };
  const r1 = reviewCopyQuality(f1, { round: 1, previousCopySha256: r0.copy_sha256, earlierRounds: earlier({ files: f0, review: r0 }) });
  return [
    { files: f0, review: r0 },
    { files: f1, review: r1 },
  ];
}

/** Real shop: round 0 at owner review; round 1 is only appendable after the owner asks for a revision of round 0. */
export function ownerReviseChain(): [Round, Round] {
  const g0 = cleanRound0();
  const g1 = fx.realShop({ prose: ["クロワッサンをどうぞ"] });
  const p1 = reviewCopyQuality(g1, { round: 1, previousCopySha256: g0.review.copy_sha256, earlierRounds: earlier(g0) });
  return [g0, { files: g1, review: p1 }];
}

/** A second, different round 0 for the same shop and facts content (the replay a store must refuse). */
export function otherRound0(): Round {
  const f = fx.realShop({ prose: ["朝の棚に、焼きたてを。"] });
  return { files: f, review: reviewCopyQuality(f) };
}

/** The fictional research lane (never sendable). */
export function fictionalRound0(): Round {
  const f = fx.bakeryGood();
  return { files: f, review: reviewCopyQuality(f) };
}
