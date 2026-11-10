import { describe, expect, it } from "vitest";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";

const FACTS_SHA = "a".repeat(64);
const facts = [
  { id: "F1", key: "name", value: "例示パン店" },
  { id: "F2", key: "address", value: "東京都例示区1-2-3" },
];
const record = {
  schema: "comp_copy_v1",
  shop_id: "prospect-example",
  facts_sha256: FACTS_SHA,
  lane: "real_shop_proposal",
  items: [
    { id: "name", text: "例示パン店", claim_type: "fact", source_fact_ids: ["F1"], owner_review_needed: false },
    { id: "addr", text: "東京都例示区1-2-3", claim_type: "fact", source_fact_ids: ["F2"], owner_review_needed: false, label: "所在地" },
  ],
};
const html = (body: string) => `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
const texts = (body: string) => checkArtifactHtml(html(body), "body{}", new Set()).texts;

describe("checkArtifactCopy (§7.4・T14)", () => {
  it("accepts a page that shows only the record's facts and labels", () => {
    const r = checkArtifactCopy({ texts: texts("<h1>例示パン店</h1><dl><dt>所在地</dt><dd>東京都例示区1-2-3</dd></dl>"), copyRecord: record, shopId: "prospect-example", factsSha256: FACTS_SHA, facts });
    expect(r).toEqual({ ok: true, findings: [] });
  });

  it("refuses a page text the record does not hold (UNVERIFIED_COPY), without echoing the text", () => {
    const r = checkArtifactCopy({ texts: texts("<h1>例示パン店</h1><p>創業100年の老舗</p>"), copyRecord: record, shopId: "prospect-example", factsSha256: FACTS_SHA, facts });
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual({ code: "UNVERIFIED_COPY", detail: "1" });
    expect(JSON.stringify(r)).not.toContain("老舗");
  });

  it("refuses a fact line that is not from the facts pack and a facts hash mismatch", () => {
    const bad = { ...record, items: [{ ...record.items[0]!, text: "例示パン店 本店" }] };
    const r = checkArtifactCopy({ texts: ["例示パン店 本店"], copyRecord: bad, shopId: "prospect-example", factsSha256: "b".repeat(64), facts });
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["FACT_TEXT_NOT_FROM_FACTS", "COPY_FACTS_SHA_MISMATCH"]));
  });

  it("refuses creative copy on a real shop's version", () => {
    const creative = { ...record, items: [...record.items, { id: "tag", text: "光の入る店", claim_type: "creative_expression", source_fact_ids: [], owner_review_needed: true }] };
    const r = checkArtifactCopy({ texts: ["光の入る店"], copyRecord: creative, shopId: "prospect-example", factsSha256: FACTS_SHA, facts });
    expect(r.findings.map((f) => f.code)).toContain("CREATIVE_OUTSIDE_RESEARCH_LANE");
  });

  it("refuses a malformed record", () => {
    expect(checkArtifactCopy({ texts: [], copyRecord: { schema: "x" }, shopId: "s", factsSha256: FACTS_SHA, facts }).findings[0]!.code).toBe("COPY_SCHEMA");
  });
});
