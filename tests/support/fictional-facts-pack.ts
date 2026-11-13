/**
 * DEV-263h: a FICTIONAL shop's facts pack for the onboarding tests (never a real shop). Every key the demo content maps;
 * services out of order (service_10 sorts after service_2).
 */
type Fact = { id: string; key: string; value: string; source_id: string };
export const BASE_FACTS: [string, string][] = [
  ["name", "架空の店 試験"],
  ["category", "fictional_test"],
  ["ward", "架空区"],
  ["address", "架空市架空区試験町1-2-3"],
  ["hours", "10:00〜18:00"],
  ["closed_days", "月曜"],
  ["access", "架空駅から徒歩5分"],
  ["phone", "000-0000-0000"],
  ["description", "動作確認用の架空の店です。実在しません。"],
  ["workshop", "架空の講座"],
  ["service_2", "二番目の品"],
  ["service_10", "十番目の品"],
  ["service_1", "一番目の品"],
  ["statement_1", "架空の文"],
];
export function fictionalPack(o: { shopId?: string; facts?: [string, string][]; extra?: Record<string, unknown> } = {}): string {
  const facts: Fact[] = (o.facts ?? BASE_FACTS).map(([key, value], i) => ({ id: `F${i + 1}`, key, value, source_id: "S1" }));
  return JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: o.shopId ?? "fictional-onboarding-h1", facts, ...(o.extra ?? {}) }, null, 2);
}
