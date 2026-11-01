import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { auditPageText } from "@/lib/design-agent/identity/identity-lock";

// DEV-141 (Issue #180): the shared inputs of the three-method study (VISUAL_FIRST / LAYOUT_FIRST / DIRECTION_FIRST).
// Fictional only; nothing here calls a model.

const REPO = resolve(__dirname, "../../../..");
const DIR = "design-library/research/three-methods";
const read = (p: string) => readFileSync(resolve(REPO, DIR, p), "utf8");
const pack = FactsPack.parse(JSON.parse(read("facts-pack.json")));
const lock = JSON.parse(read("identity-lock.json"));
const doc = readFileSync(resolve(REPO, "docs/design/three-methods-study.md"), "utf8");

describe("the three-method study's shared inputs", () => {
  it("is one fictional bakery with sourced facts, marked as not a real shop", () => {
    expect(pack.shop_id).toBe("fictional-bakery-komugi");
    const by = Object.fromEntries(pack.facts.map((f) => [f.key, f.value]));
    expect(by.category).toBe("bakery");
    expect(by.description).toContain("実在の店舗ではありません");
    // every named thing carries 架空, so nothing can be taken for a real shop, product or place
    for (const k of ["name", "address", "access", ...Object.keys(by).filter((k) => k.startsWith("menu_item_"))]) expect(by[k], k).toContain("架空");
    // a phone number in the fictional 000 exchange, like the other fixtures
    expect(by.phone).toMatch(/^052-000-\d{4}$/);
    const sources = JSON.parse(read("sources.json"));
    for (const f of pack.facts) expect(Object.keys(sources.sources), f.id).toContain(f.source_id);
  });

  it("has a research-only identity lock that a page with every fact passes, and another shop's name fails", () => {
    expect(lock.prompt.is_research_only).toBe(true);
    expect(lock.target.official_name).toBe(pack.facts.find((f) => f.key === "name")!.value);
    expect(lock.target.official_source_url).toMatch(/\.invalid\//);
    const page = pack.facts.map((f) => f.value).join("\n");
    expect(auditPageText(lock, page).status).toBe("PASS_IDENTITY_ONLY");
    expect(auditPageText(lock, `${page}\n架空菓庵`).status).not.toBe("PASS_IDENTITY_ONLY");
  });

  it("is a shop never handed to Codex before (not one of the earlier fixtures)", () => {
    for (const other of lock.other_shop_names as string[]) expect(pack.facts.map((f) => f.value).join("")).not.toContain(other);
    expect(lock.other_shop_names).toEqual(expect.arrayContaining(["架空菓庵", "月見湯", "紙縁堂", "ひびや継工房"]));
  });

  it("records runs in one shape, and the design keeps mock and live apart and names the three methods", () => {
    const t = JSON.parse(read("run-record-template.json"));
    expect(t.schema).toBe("three_method_run_v0");
    expect(t.run_kind).toBe("mock | live");
    for (const k of ["codex_calls", "images", "claude", "artifacts", "checks", "stops"]) expect(t, k).toHaveProperty(k);
    for (const m of ["VISUAL_FIRST", "LAYOUT_FIRST", "DIRECTION_FIRST"]) expect(doc).toContain(m);
    expect(doc).toContain("模擬の画像や数値は、方式の優劣の証拠にしない");
    expect(read("review-sheet.md")).toContain("模擬 (`MOCK`) の画像では評価しない");
  });

  it("pins the shared inputs by hash in the design (a later change shows)", () => {
    for (const f of ["facts-pack.json", "identity-lock.json"]) {
      const sha = createHash("sha256").update(read(f)).digest("hex");
      expect(doc, f).toContain(sha);
    }
  });
});
