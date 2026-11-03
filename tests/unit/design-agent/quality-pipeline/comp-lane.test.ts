import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCompReview, type ReviewInputs } from "../../../../lib/design-agent/quality-pipeline/comp-review";
import { checkCopyRecord, CopyRecord, textsNotInRecord } from "../../../../lib/design-agent/quality-pipeline/copy-record";
import { checkReviewFile } from "../../../../scripts/design-artifact/comp-lane";

// DEV-159 (Issue #193): the comp lane. Every word a comp shows has a claim type and a source; Claude's review of the
// renders is tied to its own VISUAL_VERIFIED reads. A pass is never a quality verdict.

const REPO = resolve(__dirname, "../../../..");
const POC = join(REPO, "design-library/research/quality-pipeline/poc/tsugute");
const COMP = join(POC, "comps/d1-seam-across");
const factsRaw = readFileSync(join(POC, "facts-pack.json"));
const facts = JSON.parse(factsRaw.toString("utf8")) as { shop_id: string; facts: Array<{ id: string; value: string }> };
const factsOpts = { shopId: facts.shop_id, factsSha256: createHash("sha256").update(factsRaw).digest("hex"), facts: facts.facts };
const copy = () => JSON.parse(readFileSync(join(COMP, "copy.json"), "utf8"));
const copyCodes = (r: unknown) => checkCopyRecord(r, factsOpts).findings.map((f) => f.code);

describe("copy record (DEV-159, Issue #193 T5)", () => {
  it("the つぐ手 copy passes: facts come from the pack, creative lines carry no fact-like claim and wait for the owner", () => {
    expect(checkCopyRecord(copy(), factsOpts)).toEqual({ ok: true, findings: [] });
    const c = CopyRecord.parse(copy());
    expect(c.items.filter((i) => i.claim_type !== "fact").every((i) => i.owner_review_needed)).toBe(true);
  });

  it("a fact must be the pack's words (or a part of them); nothing may be added to it", () => {
    const r = copy();
    r.items.find((i: { id: string }) => i.id === "hours").text = "10:00〜18:00";
    expect(copyCodes(r)).toContain("FACT_TEXT_NOT_FROM_FACTS");
    const s = copy();
    s.items.find((i: { id: string }) => i.id === "month").source_fact_ids = [];
    expect(copyCodes(s)).toContain("FACT_WITHOUT_SOURCE");
    const t = copy();
    t.items.find((i: { id: string }) => i.id === "month").source_fact_ids = ["F99"];
    expect(copyCodes(t)).toEqual(expect.arrayContaining(["COPY_FACT_UNKNOWN"]));
  });

  it("creative lines may not invent facts: numbers, prices, history, awards, reputation, efficacy, stock", () => {
    for (const text of ["創業百年の技で直します", "受賞歴のある職人", "人気の工房", "料金は3000円から", "器が長持ちする効果", "予約は不要です", "伝統の技"]) {
      const r = copy();
      r.items.find((i: { id: string }) => i.id === "tagline").text = text;
      expect(copyCodes(r), text).toContain("CREATIVE_LOOKS_LIKE_FACT");
    }
  });

  it("creative copy needs the owner's review, belongs to the fictional research lane, and carries no label", () => {
    const r = copy();
    r.items.find((i: { id: string }) => i.id === "tagline").owner_review_needed = false;
    expect(copyCodes(r)).toContain("CREATIVE_WITHOUT_OWNER_REVIEW");
    const s = copy();
    s.lane = "real_shop_proposal";
    expect(copyCodes(s)).toContain("CREATIVE_OUTSIDE_RESEARCH_LANE");
    const t = copy();
    t.items.find((i: { id: string }) => i.id === "tagline").label = "見出し";
    expect(copyCodes(t)).toContain("LABEL_ON_NON_FACT");
    const u = copy();
    u.facts_sha256 = "0".repeat(64);
    u.shop_id = "other";
    expect(copyCodes(u)).toEqual(expect.arrayContaining(["COPY_FACTS_SHA_MISMATCH", "COPY_SHOP_MISMATCH"]));
  });

  it("a page may show only the record's texts and labels", () => {
    const c = CopyRecord.parse(copy());
    expect(textsNotInRecord(["つぐ手", "所在地", " 架空市架空区架空町一丁目3-2 "], c)).toEqual([]);
    expect(textsNotInRecord(["つぐ手", "創業百年"], c)).toEqual(["創業百年"]);
  });
});

describe("Claude's review of the comp renders (DEV-159)", () => {
  const review = () => JSON.parse(readFileSync(join(COMP, "review.json"), "utf8"));
  const base: ReviewInputs = (() => {
    const learn = (p: string) => (JSON.parse(readFileSync(join(REPO, p), "utf8")) as { observation: { learn: string[] } }).observation.learn;
    const R = "design-library/research/quality-pipeline/visual-reads/";
    const sha = (f: string) => createHash("sha256").update(readFileSync(join(COMP, f))).digest("hex");
    return {
      renders: null,
      verifiedReads: Object.fromEntries(["CP-001/concept", "CP-002/concept", "CP-003/desktop", "CP-003/mobile"].map((k) => [`${R}${k}.read.json`, learn(`${R}${k}.read.json`)])),
      failureCodes: ["IMAGE_TYPE_RELATION_WEAK", "READABLE_BUT_FLAT"],
      comp: { html_sha256: sha("index.html"), css_sha256: sha("style.css"), copy_sha256: sha("copy.json") },
    };
  })();
  const codes = (r: unknown, o: ReviewInputs = base) => checkCompReview(r, o).codes;

  it("the committed review passes against this comp and Claude's VISUAL_VERIFIED reads, and its verdict is to revise", () => {
    expect(checkReviewFile(COMP)).toEqual({ ok: true, codes: [] });
    expect(review().verdict).toBe("revise");
    expect(review().remaining.length).toBeGreaterThan(0);
  });

  it("references must be Claude's VISUAL_VERIFIED reads, quoting their own learn lines", () => {
    const r = review();
    r.references[0].read = "design-library/research/quality-pipeline/visual-reads/CP-009/desktop.read.json";
    expect(codes(r)).toContain("REFERENCE_NOT_VISUAL_VERIFIED");
    const s = review();
    s.references[0].learn = "ChatGPT の要約: 豆の弧が良い";
    expect(codes(s)).toContain("REFERENCE_LEARN_NOT_IN_READ");
  });

  it("the review must be of this comp, cover the renders, and place its observations over them", () => {
    expect(codes(review(), { ...base, comp: { ...base.comp, css_sha256: "0".repeat(64) } })).toContain("REVIEW_OF_ANOTHER_COMP");
    const r = review();
    r.viewed_crops.mobile = [{ x: 0, y: 0, w: 390, h: 1308 }];
    expect(codes(r)).toContain("CROPS_DO_NOT_COVER_MOBILE");
    const s = review();
    for (const o of s.observations.desktop) o.box = { ...o.box, y: 10, h: 40 };
    expect(codes(s)).toContain("OBSERVATIONS_NOT_SPREAD_DESKTOP");
    const t = review();
    expect(codes(t, { ...base, renders: { desktop: { ...t.renders.desktop, sha256: "a".repeat(64) }, mobile: t.renders.mobile } })).toContain("RENDER_MISMATCH_DESKTOP");
  });

  it("at most 2 rounds, in order; no quality verdict; known failure codes only", () => {
    const r = review();
    r.rounds.push({ ...r.rounds[1], n: 3 });
    expect(codes(r)).toEqual(["REVIEW_SCHEMA"]);
    const s = review();
    s.verdict = "success";
    expect(codes(s)).toEqual(["REVIEW_SCHEMA"]);
    const t = review();
    t.rounds.reverse();
    expect(codes(t)).toContain("ROUNDS_OUT_OF_ORDER");
    const u = review();
    u.failure_codes = ["LOOKS_GREAT"];
    expect(codes(u)).toContain("FAILURE_CODE_UNKNOWN");
  });

  it("the CLI checks and renders the comp offline (copy, safety, unrecorded text, PC/SP) and checks the review", () => {
    const cli = join(REPO, "scripts/design-artifact/comp-lane.ts");
    const out = mkdtempSync(join(tmpdir(), "comp-"));
    const r = JSON.parse(execFileSync("npx", ["tsx", cli, "--dir", COMP, "--facts", join(POC, "facts-pack.json"), "--out", out], { encoding: "utf8" })) as {
      status: string;
      renders: Record<string, { width: number }>;
    };
    expect(r.status).toBe("OK");
    expect(r.renders.desktop_1440!.width).toBe(1440);
    expect(r.renders.mobile_390!.width).toBe(390);
    expect(JSON.parse(execFileSync("npx", ["tsx", cli, "--check-review", COMP], { encoding: "utf8" }))).toEqual({ ok: true, codes: [] });
  }, 120_000);
});
