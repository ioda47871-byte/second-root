import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveBRouteCopy, BRouteCopyStop } from "@/lib/sales/b-route/derive-copy";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";

type F = { id: string; key: string; value: string; source_id: "S1" };
const fact = (id: string, key: string, value: string): F => ({ id, key, value, source_id: "S1" });
const pack = (shopId: string, facts: F[]) =>
  Buffer.from(JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: shopId, facts }), "utf8");

const css = "html{font-family:serif}body{margin:0}main{max-width:70rem;margin:auto}section{padding:5rem}h1{font-size:4rem}";
const page = (name: string, service: string, headline: string, shape: "rail" | "type" | "poster") =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${name}</title><link rel="stylesheet" href="style.css"></head><body>
   <main class="${shape}"><section><h1>${name}</h1><p>${headline}</p></section><section><h2>ご案内</h2><p>${service}</p></section></main>
   </body></html>`;

describe("B-route sales comp: no factual promotion from a generated design", () => {
  const shops = [
    { category: "bakery", id: "fictional-bakery-lamp", name: "架空パン工房 灯", service: "角食パン", headline: "小麦色の余白をたどる", shape: "rail" as const },
    { category: "cafe", id: "fictional-cafe-rain", name: "架空喫茶 雨匙", service: "ドリップコーヒー", headline: "雨の間に席をつくる", shape: "type" as const },
    { category: "baked_goods", id: "fictional-bakes-garden", name: "架空焼菓子 庭", service: "レモンの焼菓子", headline: "包みを開く楽しみ", shape: "poster" as const },
  ];

  it.each(shops)("$category: binds exact words to its own evidence, other words remain creative", (s) => {
    const factsBytes = pack(s.id, [
      fact("F1", "name", s.name),
      fact("F2", "category", s.category),
      fact("F3", "address", "架空市架空区"),
      fact("F4", "description", "架空の動作検証用店舗です。"),
      fact("F5", "service_1", s.service),
    ]);
    const html = page(s.name, s.service, s.headline, s.shape);
    const derived = deriveBRouteCopy({ factsBytes, html, css, lane: "quality_research_fictional" });
    expect(derived.record.shop_id).toBe(s.id);
    expect(derived.record.facts_sha256).toBe(createHash("sha256").update(factsBytes).digest("hex"));
    expect(derived.record.items.find((i) => i.text === s.name)).toMatchObject({
      claim_type: "fact", source_fact_ids: ["F1"], owner_review_needed: false,
    });
    expect(derived.record.items.find((i) => i.text === s.headline)).toMatchObject({
      claim_type: "creative_expression", source_fact_ids: [], owner_review_needed: true,
    });
    const extracted = checkArtifactHtml(html, css, new Set());
    expect(extracted.ok).toBe(true);
    expect(checkArtifactCopy({
      texts: extracted.texts, copyRecord: derived.record, shopId: s.id,
      factsSha256: derived.record.facts_sha256, facts: JSON.parse(factsBytes.toString("utf8")).facts,
    }).ok).toBe(true);
    expect(derived.stats.fact_lines).toBeGreaterThan(0);
    expect(derived.stats.proposed_lines).toBeGreaterThan(0);
  });

  it("real-shop content is only a proposal, not a fictional research expression", () => {
    const factsBytes = pack("actual-like-test-shop", [
      fact("F1", "name", "サンプル茶房"),
      fact("F2", "category", "cafe"),
      fact("F3", "address", "仮想市一区"),
      fact("F4", "description", "サンプルの喫茶店です。"),
    ]);
    const d = deriveBRouteCopy({ factsBytes, html: page("サンプル茶房", "サンプルの喫茶店です。", "街の途中にある一席", "rail"), css, lane: "real_shop_proposal" });
    const proposed = d.record.items.find((i) => i.text === "街の途中にある一席");
    expect(proposed?.claim_type).toBe("proposal_pending_review");
    expect(proposed?.owner_review_needed).toBe(true);
    expect(d.record.items.every((i) => i.claim_type !== "creative_expression")).toBe(true);
  });

  it("never calls a new hour or price a verified fact", () => {
    const factsBytes = pack("actual-like-test-shop", [
      fact("F1", "name", "サンプル茶房"),
      fact("F2", "category", "cafe"),
      fact("F3", "address", "仮想市一区"),
      fact("F4", "description", "サンプルの喫茶店です。"),
    ]);
    expect(() => deriveBRouteCopy({
      factsBytes, html: page("サンプル茶房", "営業時間は9時から", "街の途中にある一席", "type"),
      css, lane: "real_shop_proposal",
    })).toThrowError(BRouteCopyStop);
  });

  it("an hours label only maps to a displayed, exact source fact", () => {
    const factsBytes = pack("actual-like-test-shop", [
      fact("F1", "name", "サンプル茶房"),
      fact("F2", "category", "cafe"),
      fact("F3", "address", "仮想市一区"),
      fact("F4", "description", "サンプルの喫茶店です。"),
      fact("F5", "hours", "10:00〜19:00"),
    ]);
    const html = page("サンプル茶房", "10:00〜19:00", "街の途中にある一席", "rail").replace("<h2>ご案内</h2>", "<h2>営業時間</h2>");
    const d = deriveBRouteCopy({ factsBytes, html, css, lane: "real_shop_proposal" });
    expect(d.record.items.find((i) => i.label === "営業時間")).toMatchObject({
      text: "10:00〜19:00", claim_type: "fact", source_fact_ids: ["F5"],
    });
  });

  it("rejects labels with no corresponding fact and rejects script/external links", () => {
    const factsBytes = pack("fictional-bakery-lamp", [
      fact("F1", "name", "架空パン工房 灯"),
      fact("F2", "category", "bakery"),
    ]);
    expect(() => deriveBRouteCopy({ factsBytes, html: page("架空パン工房 灯", "営業時間", "余白をたどる", "rail"), css, lane: "quality_research_fictional" })).toThrowError(BRouteCopyStop);
    expect(() => deriveBRouteCopy({ factsBytes, html: page("架空パン工房 灯", "角食パン", "余白をたどる", "rail").replace("</body>", "<script>alert('x')</script></body>"), css, lane: "quality_research_fictional" })).toThrowError(BRouteCopyStop);
  });

  it("rejects a research lane for a real shop", () => {
    const factsBytes = pack("another-shop", [fact("F1", "name", "サンプル茶房")]);
    expect(() => deriveBRouteCopy({ factsBytes, html: page("サンプル茶房", "いろいろ", "いろいろ", "rail"), css, lane: "quality_research_fictional" })).toThrowError(BRouteCopyStop);
  });
});
