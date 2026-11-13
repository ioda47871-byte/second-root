import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildPackage, checkPackageCopy, PackageError } from "@/lib/demo-version-package/package";
import type { OwnerCopyApproval } from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import { json, otherRound0, ownerReviseChain, type Round } from "../../support/copy-review-fixture";

// DEV-199e: a package whose chain continues after a real-shop round at owner review. The owner's revise request lives
// only in the owner's store: the importer passes the store's records (`ownerRevisions`), strictly; build and read do not
// consult a store and check such a chain as if asked (the importer and the database decide).

const png = async (w: number, h: number) => new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer());
const pkgOf = async (r: Round, earlier: Round[]) =>
  buildPackage({
    html: String(r.files.pageHtml),
    css: String(r.files.pageCss),
    renders: { desktop_1440: await png(1440, 900), mobile_390: await png(390, 900) },
    source: "test",
    copy: { factsPack: r.files.factsPack, copyRecord: r.files.copyRecord, review: json(r.review), rounds: earlier.map((e) => ({ copyRecord: e.files.copyRecord, pageHtml: e.files.pageHtml, pageCss: e.files.pageCss, review: json(e.review) })) },
  });
const codes = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof PackageError) return [e.code, ...e.details];
    throw e;
  }
  return [];
};

describe("verifyPackageCopy with the owner's revise requests", () => {
  it("built and read without a store (as if asked); imported only with the matching record from the store", async () => {
    const [g0, g1] = ownerReviseChain();
    const pkg = await pkgOf(g1, [g0]);
    expect(checkPackageCopy(pkg)).toMatchObject({ status: "checked", round: 1 });
    // the store consulted: none, an approve, or a revise of other hashes → refused
    const ask = (decision: OwnerCopyApproval["decision"], copy = g0.review.copy_sha256): OwnerCopyApproval => ({ shop_id: g0.review.shop_id, facts_sha256: g0.review.facts_sha256, copy_sha256: copy, page_html_sha256: g0.review.page_html_sha256, page_css_sha256: g0.review.page_css_sha256, decision });
    for (const ownerRevisions of [[], [ask("approve")], [ask("revise", "4".repeat(64))]])
      expect(codes(() => checkPackageCopy(pkg, { ownerRevisions })).slice(0, 3)).toEqual(["COPY_INVALID", "COPY_REVIEW_CHAIN_INVALID", "LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
    expect(checkPackageCopy(pkg, { ownerRevisions: [ask("revise")] })).toMatchObject({ status: "checked", round: 1 });
  });

  // The fictional lane never takes the 'as if asked' reading (no owner): copy-package.test.ts "broken chains" still
  // refuses an approve_candidate fictional round 0 followed by a round 1 with LAST_ROUND_DOES_NOT_ALLOW_REVISION.
  it("a second round 0 inside one package is still refused, store or not", async () => {
    const [g0] = ownerReviseChain();
    await expect(pkgOf(g0, [otherRound0()])).rejects.toThrow(/COPY_INVALID/);
  });
});
