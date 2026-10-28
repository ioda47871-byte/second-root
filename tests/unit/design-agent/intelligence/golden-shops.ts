// DEV-113: fictional shop inputs whose Phase 1 outputs are pinned byte for byte (phase1-compat.golden.json).
const base = {
  schema: "shop_research_input_v1",
  shop_key: "fictional-bakery",
  display_name: "架空ベーカリー",
  facts_verified: true,
  traits: [
    { id: "T1", quote: "木の棚に毎朝のパンを並べる", source_id: "S1" },
    { id: "T2", quote: "季節の枝物を入口に飾る", source_id: "S2" },
  ],
};
export const GOLDEN_SHOPS = [
  { ...base, category: "bakery", keywords: [{ term: "shelf", trait_ids: ["T1"] }, { term: "rail", trait_ids: ["T2"] }] },
  { ...base, category: "florist", keywords: [] },
  { ...base, category: null, facts_verified: false, traits: [], keywords: [] },
];
