import { describe, expect, it } from "vitest";
import { classifyByCopyRecord } from "@/lib/sales/demo-version/copy-lines";

// DEV-196p: the compare page's line kinds come from the copy record stored with the version, and the server's copy
// check is re-run on the stored bytes. A line is a fact only when its record item is a fact with no finding.

const FACTS_SHA = "a".repeat(64);
const factsPack = JSON.stringify({
  schema: "shop_facts_pack_v1",
  shop_id: "fictional-example",
  facts: [
    { id: "F1", key: "name", value: "架空の例示パン店", source_id: "S1" },
    { id: "F2", key: "address", value: "東京都例示区1-2-3", source_id: "S1" },
  ],
});
const items = [
  { id: "name", text: "架空の例示パン店", claim_type: "fact", source_fact_ids: ["F1"], owner_review_needed: false },
  { id: "addr", text: "東京都例示区1-2-3", claim_type: "fact", source_fact_ids: ["F2"], owner_review_needed: false, label: "所在地" },
  { id: "head", text: "朝の光で焼く", claim_type: "creative_expression", source_fact_ids: [], owner_review_needed: true },
];
const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: "comp_copy_v1", shop_id: "fictional-example", facts_sha256: FACTS_SHA, lane: "quality_research_fictional", items, ...over });
const basis = (over: Partial<{ copyRecordText: string; factsPackText: string; factsSha256: string }> = {}) => ({ copyRecordText: record(), factsPackText: factsPack, factsSha256: FACTS_SHA, ...over });
const run = (lines: string[], b = basis()) => classifyByCopyRecord({ lines, checkedTexts: lines, basis: b });

describe("classifyByCopyRecord (DEV-196p)", () => {
  it("marks fact lines, creative headings and the rest; the stored check passes", () => {
    const r = run(["架空の例示パン店", "朝の光で焼く", "所在地", "東京都例示区1-2-3"])!;
    expect(r.lines.map((l) => l.kind)).toEqual(["fact", "creative", "unknown", "fact"]);
    expect(r.check).toEqual({ ok: true, codes: [] });
  });

  it("a line not in the record is unknown and the check says UNVERIFIED_COPY (codes only, never the text)", () => {
    const r = run(["架空の例示パン店", "創業100年"])!;
    expect(r.lines[1]).toEqual({ text: "創業100年", kind: "unknown" });
    expect(r.check.ok).toBe(false);
    expect(r.check.codes).toContain("UNVERIFIED_COPY");
    expect(JSON.stringify(r.check)).not.toContain("創業");
  });

  it("a fact item whose text is not from the facts pack is never a fact", () => {
    const bad = record({ items: [{ ...items[0], text: "架空の例示パン店 本店" }] });
    const r = run(["架空の例示パン店 本店"], basis({ copyRecordText: bad }))!;
    expect(r.lines[0]!.kind).toBe("unknown");
    expect(r.check.codes).toContain("FACT_TEXT_NOT_FROM_FACTS");
  });

  it("a record for other facts (facts hash mismatch) makes no line a fact", () => {
    const r = run(["架空の例示パン店"], basis({ factsSha256: "b".repeat(64) }))!;
    expect(r.lines[0]!.kind).toBe("unknown");
    expect(r.check.codes).toContain("COPY_FACTS_SHA_MISMATCH");
  });

  it("creative copy on a real shop's record is still a heading, and the check refuses it", () => {
    const r = run(["朝の光で焼く"], basis({ copyRecordText: record({ lane: "real_shop_proposal" }) }))!;
    expect(r.lines[0]!.kind).toBe("creative");
    expect(r.check.codes).toContain("CREATIVE_OUTSIDE_RESEARCH_LANE");
  });

  it("an email-holding line is hidden and never a fact", () => {
    const r = run(["info@example.com"])!;
    expect(r.lines[0]!.kind).toBe("unknown");
    expect(r.lines[0]!.text).not.toContain("@");
  });

  it("an unreadable record or facts pack gives null (the caller says so, never 'no problem')", () => {
    expect(run(["x"], basis({ copyRecordText: "{" }))).toBeNull();
    expect(run(["x"], basis({ factsPackText: JSON.stringify({ schema: "x" }) }))).toBeNull();
  });
});
