import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compCopyGate, compShowOwnerCodes } from "@/lib/design-agent/quality-pipeline/comp-copy-gate";
import { MAX_COPY_REVISION_ROUNDS, reviewCopyQuality } from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import { auditCompCopy, checkCompCopy, COPY_REVIEW_FILE, startCompCopyRevision } from "../../../../scripts/design-artifact/comp-copy";
import { checkReviewFile } from "../../../../scripts/design-artifact/comp-lane";
import { cleanRound0, ownerReviseChain } from "../../../support/copy-review-fixture";
import * as fx from "./copy-quality-fixtures";

// DEV-199b (Issue #258, 2/3): the copy quality gate of the comp lane. Synthetic fixtures and committed comps copied into
// a temporary directory; no network, no model, no browser.

type Files = ReturnType<typeof fx.shopFiles>;

/** A comp directory (its name is the direction id) with these files, and the facts pack beside it. */
function compDir(f: Files, name = "d1-test"): { dir: string; facts: string } {
  const root = mkdtempSync(join(tmpdir(), "comp-copy-"));
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "copy.json"), f.copyRecord);
  writeFileSync(join(dir, "index.html"), f.pageHtml);
  writeFileSync(join(dir, "style.css"), f.pageCss);
  writeFileSync(join(root, "facts-pack.json"), f.factsPack);
  return { dir, facts: join(root, "facts-pack.json") };
}

const edit = (dir: string, from: string, to: string) => {
  for (const f of ["copy.json", "index.html"]) {
    const s = readFileSync(join(dir, f), "utf8");
    if (!s.includes(from)) throw new Error(`${from} not in ${f}`);
    writeFileSync(join(dir, f), s.split(from).join(to));
  }
};

describe("the comp lane copy gate (pure)", () => {
  it("approve_candidate goes to the owner, and is never sendable (fictional research lane)", () => {
    const f = fx.bakeryGood();
    const g = compCopyGate({ files: f, review: reviewCopyQuality(f), previous: [] });
    expect(g.step).toBe("owner_review");
    expect(g.mayShowOwner).toBe(true);
    expect(g.sendable).toBe(false);
    expect(g.sendBlockers).toEqual(expect.arrayContaining(["FICTIONAL_RESEARCH_NOT_SENDABLE", "OWNER_APPROVAL_MISSING"]));
    expect(compShowOwnerCodes("show_owner", g)).toEqual([]);
  });

  it("a real-shop page at owner review goes to the owner but still needs the owner's own approval to be sent", () => {
    const r = cleanRound0();
    const g = compCopyGate({ files: r.files, review: r.review, previous: [] });
    expect(g.step).toBe("owner_review");
    expect(g.sendBlockers).toEqual(["OWNER_APPROVAL_MISSING"]);
  });

  it("revise and hold do not go to the owner; hold names its reasons; fail is terminal", () => {
    const c = fx.bakeryCliche();
    const revise = compCopyGate({ files: c, review: reviewCopyQuality(c), previous: [] });
    expect(revise.step).toBe("revise");
    expect(revise.mayShowOwner).toBe(false);
    expect(revise.codes).toContain("COPY_RHETORICAL_OVERUSE");
    expect(compShowOwnerCodes("show_owner", revise)).toEqual(expect.arrayContaining(["SHOW_WITHOUT_COPY_APPROVE_CANDIDATE", "COPY_REVISE", "COPY_COPY_RHETORICAL_OVERUSE"]));

    const m = fx.bakeryMissing();
    const hold = compCopyGate({ files: m, review: reviewCopyQuality(m), previous: [] });
    expect(hold.step).toBe("stop_hold");
    expect(hold.codes).toEqual(["COPY_INFORMATION_MISSING"]);
    expect(hold.findings.every((x) => x.severity === "hold" && x.reason.length > 0)).toBe(true);

    const bad = { ...fx.bakeryGood(), pageHtml: String(fx.bakeryGood().pageHtml).replace("</main>", "<p>新しい一文です。</p>\n</main>") };
    const fail = compCopyGate({ files: bad, review: reviewCopyQuality(bad), previous: [] });
    expect(fail.step).toBe("stop_fail");
    expect(fail.codes).toContain("COPY_FACT_UNSUPPORTED");
    expect(compShowOwnerCodes("show_owner", fail)).toContain("COPY_STOP_FAIL");
  });

  it("a missing, tampered or stale review is refused, and a refused review never goes to the owner", () => {
    const f = fx.bakeryGood();
    const review = reviewCopyQuality(f);
    expect(compCopyGate({ files: f, review: null, previous: [] })).toMatchObject({ step: "refused", codes: ["COPY_REVIEW_MISSING"], mayShowOwner: false });
    expect(compCopyGate({ files: f, review: { ...review, schema: "x" }, previous: [] }).codes).toEqual(["COPY_REVIEW_SCHEMA"]);
    // a cliché page with the good page's review: stale hashes and not the audit
    const c = fx.bakeryCliche();
    expect(compCopyGate({ files: c, review, previous: [] }).codes).toEqual(expect.arrayContaining(["REVIEW_STALE_COPY", "REVIEW_STALE_PAGE_HTML", "REVIEW_DOES_NOT_MATCH_AUDIT"]));
    // a cliché page's review with its findings taken out (and the verdict raised to match)
    const forged = { ...reviewCopyQuality(c), findings: [], unresolved: [], verdict: "approve_candidate" };
    const g = compCopyGate({ files: c, review: forged, previous: [] });
    expect(g.step).toBe("refused");
    expect(g.codes).toContain("REVIEW_DOES_NOT_MATCH_AUDIT");
    expect(compShowOwnerCodes("show_owner", g)).toEqual(expect.arrayContaining(["SHOW_WITHOUT_COPY_APPROVE_CANDIDATE", "COPY_REVIEW_REFUSED"]));
    expect(compShowOwnerCodes("show_owner", null)).toEqual(["SHOW_WITHOUT_COPY_REVIEW"]);
    expect(compShowOwnerCodes("revise", null)).toEqual([]);
  });

  it("a revision of a real-shop page at owner review is refused here (no owner store in the comp lane), even with an owner record handed in", () => {
    const [g0, g1] = ownerReviseChain();
    const ownerRevision = { shop_id: g0.review.shop_id, facts_sha256: g0.review.facts_sha256, copy_sha256: g0.review.copy_sha256, page_html_sha256: g0.review.page_html_sha256, page_css_sha256: g0.review.page_css_sha256, decision: "revise" as const };
    const g = compCopyGate({ files: g1.files, review: g1.review, previous: [{ review: g0.review, ...g0.files, ownerRevision }] });
    expect(g.step).toBe("refused");
    expect(g.codes).toContain("LAST_ROUND_DOES_NOT_ALLOW_REVISION");
  });
});

describe("the comp lane copy files (scripts/design-artifact/comp-copy.ts)", () => {
  it("audit, revise, audit: the chain is checked at every round and the cap stops it", () => {
    const { dir, facts } = compDir(fx.bakeryCliche());
    expect(checkCompCopy(dir, facts).codes).toEqual(["COPY_REVIEW_MISSING"]);
    expect(() => startCompCopyRevision(dir, facts)).toThrow("COPY_REVIEW_REFUSED");
    expect(auditCompCopy(dir, facts)).toMatchObject({ step: "revise", round: 0 });
    // the audit is deterministic: auditing the same files again changes nothing
    const first = readFileSync(join(dir, COPY_REVIEW_FILE), "utf8");
    auditCompCopy(dir, facts);
    expect(readFileSync(join(dir, COPY_REVIEW_FILE), "utf8")).toBe(first);
    // the page edited without starting a revision: never re-audited in place as a new round 0
    edit(dir, "特別な朝へ。", "特別な朝を。");
    expect(checkCompCopy(dir, facts).codes).toEqual(expect.arrayContaining(["REVIEW_STALE_COPY"]));
    expect(() => auditCompCopy(dir, facts)).toThrow("COPY_REVIEW_EXISTS_FOR_OTHER_FILES");
    edit(dir, "特別な朝を。", "特別な朝へ。");

    for (let round = 1; round <= MAX_COPY_REVISION_ROUNDS; round++) {
      expect(startCompCopyRevision(dir, facts)).toEqual({ round });
      expect(existsSync(join(dir, COPY_REVIEW_FILE))).toBe(false);
      edit(dir, round === 1 ? "特別な朝へ。" : "特別な朝を。", round === 1 ? "特別な朝を。" : "特別な朝に。");
      const g = auditCompCopy(dir, facts);
      expect(g.round).toBe(round);
      expect(g.mayShowOwner).toBe(false);
      expect(checkCompCopy(dir, facts)).toEqual(g);
      if (round < MAX_COPY_REVISION_ROUNDS) expect(g.step).toBe("revise");
      else expect(g).toMatchObject({ step: "stop_hold", codes: expect.arrayContaining(["COPY_REVISION_CAP_REACHED"]) });
    }
    expect(() => startCompCopyRevision(dir, facts)).toThrow("COPY_NOT_REVISABLE_STOP_HOLD");
    // an earlier round tampered with: the chain is refused
    const r0 = join(dir, "copy-rounds/0/copy.json");
    writeFileSync(r0, readFileSync(r0, "utf8").replace("特別な朝へ。", "特別な朝。"));
    expect(checkCompCopy(dir, facts)).toMatchObject({ step: "refused", codes: expect.arrayContaining(["PREVIOUS_COPY_DOES_NOT_MATCH_REVIEW"]) });
  });

  it("a revision that launders a fact into prose fails, and nothing follows a fail", () => {
    const { dir, facts } = compDir(fx.bakeryCliche());
    auditCompCopy(dir, facts);
    startCompCopyRevision(dir, facts);
    // the fact 「クロワッサンは毎朝焼きます。」 rewritten as prose of a creative line
    const rec = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8")) as { items: Array<{ id: string; text: string; claim_type: string; source_fact_ids: string[] }> };
    const item = rec.items.find((i) => i.id === "croissant-how")!;
    Object.assign(item, { text: "毎朝クロワッサンを焼いています。", claim_type: "creative_expression", source_fact_ids: [] });
    writeFileSync(join(dir, "copy.json"), `${JSON.stringify(rec, null, 2)}\n`);
    writeFileSync(join(dir, "index.html"), readFileSync(join(dir, "index.html"), "utf8").replace("クロワッサンは毎朝焼きます。", "毎朝クロワッサンを焼いています。"));
    const g = auditCompCopy(dir, facts);
    expect(g.step).toBe("stop_fail");
    expect(() => startCompCopyRevision(dir, facts)).toThrow("COPY_NOT_REVISABLE_STOP_FAIL");
  });

  it("a hold stops with its reasons and is not revised", () => {
    const { dir, facts } = compDir(fx.bakeryMissing());
    expect(auditCompCopy(dir, facts)).toMatchObject({ step: "stop_hold", codes: ["COPY_INFORMATION_MISSING"] });
    expect(() => startCompCopyRevision(dir, facts)).toThrow("COPY_NOT_REVISABLE_STOP_HOLD");
  });
});

describe("the comp review's show_owner needs the copy at owner review (comp-lane.ts checkReviewFile)", () => {
  const POC = join(fx.REPO, "design-library/research/quality-pipeline/poc/tsugute");
  const copyComp = () => {
    const root = mkdtempSync(join(tmpdir(), "comp-show-"));
    const dir = join(root, "d1-seam-across-v9");
    cpSync(join(POC, "comps/d1-seam-across-v9"), dir, { recursive: true });
    return dir;
  };
  it("a committed show_owner comp is held back: without the facts pack, and with its copy audit (which fails)", () => {
    const dir = copyComp();
    expect(checkReviewFile(dir)).toEqual({ ok: false, codes: ["SHOW_WITHOUT_COPY_REVIEW", "COPY_FACTS_PACK_REQUIRED"] });
    const facts = join(POC, "facts-pack.json");
    expect(checkReviewFile(dir, null, facts).codes).toEqual(expect.arrayContaining(["SHOW_WITHOUT_COPY_APPROVE_CANDIDATE", "COPY_REVIEW_REFUSED", "COPY_COPY_REVIEW_MISSING"]));
    expect(auditCompCopy(dir, facts).step).toBe("stop_fail");
    const r = checkReviewFile(dir, null, facts);
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(expect.arrayContaining(["SHOW_WITHOUT_COPY_APPROVE_CANDIDATE", "COPY_STOP_FAIL"]));
  });
  it("a revise comp review is not held back by its copy (it is not shown to the owner)", () => {
    expect(checkReviewFile(join(POC, "comps/d1-seam-across"))).toEqual({ ok: true, codes: [] });
  });
});

// DEV-263a: PR #264's review Lows
describe("PR #264 review Lows", () => {
  it("checkReviewFile: malformed earlier rounds are a refusal code (COPY_ROUNDS_MALFORMED), not an input error", () => {
    const POC = join(fx.REPO, "design-library/research/quality-pipeline/poc/tsugute");
    const dir = join(mkdtempSync(join(tmpdir(), "comp-show-")), "d1-seam-across-v9");
    cpSync(join(POC, "comps/d1-seam-across-v9"), dir, { recursive: true });
    mkdirSync(join(dir, "copy-rounds", "1"), { recursive: true });
    const r = checkReviewFile(dir, null, join(POC, "facts-pack.json"));
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(expect.arrayContaining(["SHOW_WITHOUT_COPY_APPROVE_CANDIDATE", "COPY_REVIEW_REFUSED", "COPY_ROUNDS_MALFORMED"]));
  });

  it("an honest fail is excused only when it is appendable and every earlier round re-checks cleanly", () => {
    const { dir, facts } = compDir(fx.bakeryCliche());
    auditCompCopy(dir, facts);
    startCompCopyRevision(dir, facts);
    const rec = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8")) as { items: Array<{ id: string; text: string; claim_type: string; source_fact_ids: string[] }> };
    Object.assign(rec.items.find((i) => i.id === "croissant-how")!, { text: "毎朝クロワッサンを焼いています。", claim_type: "creative_expression", source_fact_ids: [] });
    writeFileSync(join(dir, "copy.json"), `${JSON.stringify(rec, null, 2)}\n`);
    writeFileSync(join(dir, "index.html"), readFileSync(join(dir, "index.html"), "utf8").replace("クロワッサンは毎朝焼きます。", "毎朝クロワッサンを焼いています。"));
    expect(auditCompCopy(dir, facts).step).toBe("stop_fail");
    const files = { factsPack: readFileSync(facts), copyRecord: readFileSync(join(dir, "copy.json")), pageHtml: readFileSync(join(dir, "index.html")), pageCss: readFileSync(join(dir, "style.css")) };
    const head = JSON.parse(readFileSync(join(dir, COPY_REVIEW_FILE), "utf8"));
    // appended at the wrong place (no earlier round): refused, never stop_fail
    expect(compCopyGate({ files, review: head, previous: [] }).step).toBe("refused");
    // the earlier round's review no longer matches its own files: the fail is not excused
    const prior = join(dir, "copy-rounds", "0", COPY_REVIEW_FILE);
    const r0 = JSON.parse(readFileSync(prior, "utf8"));
    r0.findings = [];
    writeFileSync(prior, `${JSON.stringify(r0, null, 2)}\n`);
    expect(checkCompCopy(dir, facts).step).toBe("refused");
  });
});
