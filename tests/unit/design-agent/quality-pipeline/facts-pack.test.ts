import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack as ArtifactFactsPack } from "@/lib/design-agent/artifact/schema";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";

// DEV-157: the quality-research CLIs read the facts pack with their own copy of the schema (they may not import the
// Design Artifact module). The copy must accept and refuse exactly what the artifact's schema does.
const REPO = resolve(__dirname, "../../../..");
const good = JSON.parse(readFileSync(resolve(REPO, "design-library/research/quality-pipeline/poc/tsugute/facts-pack.json"), "utf8"));
const fact = good.facts[0];
const variants: Array<[string, unknown]> = [
  ["the committed つぐ手 pack", good],
  ["wrong schema", { ...good, schema: "shop_facts_pack_v2" }],
  ["bad shop id", { ...good, shop_id: "Bad Shop" }],
  ["extra top field", { ...good, extra: 1 }],
  ["no facts", { ...good, facts: [] }],
  ["201 facts", { ...good, facts: Array.from({ length: 201 }, (_, i) => ({ ...fact, id: `F${i}` })) }],
  ["bad fact id", { ...good, facts: [{ ...fact, id: "X1" }] }],
  ["bad key", { ...good, facts: [{ ...fact, key: "Key" }] }],
  ["bad source id", { ...good, facts: [{ ...fact, source_id: "T1" }] }],
  ["extra fact field", { ...good, facts: [{ ...fact, note: "x" }] }],
  ["empty value", { ...good, facts: [{ ...fact, value: "  " }] }],
  ["401-char value", { ...good, facts: [{ ...fact, value: "あ".repeat(401) }] }],
  ["400-char value", { ...good, facts: [{ ...fact, value: "あ".repeat(400) }] }],
  ["control char", { ...good, facts: [{ ...fact, value: "a\u0001b" }] }],
  ["tag in value", { ...good, facts: [{ ...fact, value: "<b>x" }] }],
  ["<<< in value", { ...good, facts: [{ ...fact, value: "a<<<b" }] }],
  ["newline in value", { ...good, facts: [{ ...fact, value: "a\nb" }] }],
  ["not an object", "x"],
];

describe("DEV-157: the quality-pipeline facts pack schema matches the Design Artifact one", () => {
  it.each(variants)("%s: same verdict", (_name, pack) => {
    expect(FactsPack.safeParse(pack).success).toBe(ArtifactFactsPack.safeParse(pack).success);
  });
  it("accepts exactly the committed pack, the 400-char value and a newline, and refuses every other variant", () => {
    expect(variants.filter(([, p]) => FactsPack.safeParse(p).success).map(([n]) => n)).toEqual(["the committed つぐ手 pack", "400-char value", "newline in value"]);
  });
  it("parses the committed pack to the same value", () => {
    expect(FactsPack.parse(good)).toEqual(ArtifactFactsPack.parse(good));
  });
});
