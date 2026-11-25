import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { addedFactCategory, checkJaRenderings, entriesSha256, jaRenderingDetailOf, JaRenderingsStop, type JaRenderingEntry } from "@/lib/design-agent/ja-renderings/ja-renderings";
import { checkCopyRecord } from "@/lib/design-agent/quality-pipeline/copy-record";
import { checkCopyQualityReview, reviewCopyQuality } from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import type { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { jaRenderingsMain } from "@/scripts/design-artifact/ja-renderings-check";
import { CompCopyError, readRenderingsFile } from "@/scripts/design-artifact/comp-copy";
import { fact, factsPack, idOf, proposal, shopFiles, type Item } from "../quality-pipeline/copy-quality-fixtures";

// DEV-303 §6.1 change 4 (docs/design/image-first-production-flow.md §2 principle 6): owner-approved Japanese renderings
// of facts the facts pack holds in another language. FICTIONAL data only (an invented shop with an invented English
// description). No network, no model.

vi.setConfig({ testTimeout: 60_000 });
const REPO = resolve(__dirname, "../../../..");
const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sr-ja-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const SHOP = "test-shop-ja";
const DESC = "A small fictional tea room by the river. Seasonal sweets are made in the kitchen every morning.";
const FACTS: FactsPack = {
  schema: "shop_facts_pack_v1",
  shop_id: SHOP,
  facts: [
    { id: "F1", key: "name", value: "架空茶房 かわせみ", source_id: "S1" },
    { id: "F2", key: "category", value: "cafe", source_id: "S1" },
    { id: "F3", key: "description", value: DESC, source_id: "S1" },
    { id: "F4", key: "statement_1", value: "Open since 1987.", source_id: "S1" },
    { id: "F5", key: "hours", value: "10:00〜18:00", source_id: "S1" },
  ],
};
const ENTRIES: JaRenderingEntry[] = [
  { fact_key: "description", source_text: DESC, ja_text: "川辺の小さな架空の茶房です。季節のお菓子を台所で作っています。" },
  { fact_key: "statement_1", source_text: "Open since 1987.", ja_text: "1987年から営業しています。" },
];
const record = (over: Record<string, unknown> = {}, entries: JaRenderingEntry[] = ENTRIES) => ({
  schema: "sr_ja_renderings_v1",
  shop_id: SHOP,
  entries,
  owner_confirmation: { confirmed: true, confirmed_at: "2026-11-25T03:00:00Z", entries_sha256: entriesSha256(entries) },
  ...over,
});
const bytesOf = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const stopOf = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (error) {
    return error instanceof JaRenderingsStop ? { code: error.code, detail: error.detail } : String(error);
  }
};

describe("sr_ja_renderings_v1: schema, source binding and the owner's confirmation", () => {
  it("a confirmed record passes in gate mode; its SHA-256s are the bytes' and the canonical entries'", () => {
    const b = bytesOf(record());
    const c = checkJaRenderings(b, FACTS, { mode: "gate" });
    expect(c).toMatchObject({ shop_id: SHOP, sha256: sha(b), entries_sha256: entriesSha256(ENTRIES), owner_confirmed: true });
    expect(c.entries.map((e) => e.fact_key)).toEqual(["description", "statement_1"]);
    // the canonical form ignores key order inside an entry, never the entry order
    const reordered = ENTRIES.map((e) => ({ ja_text: e.ja_text, source_text: e.source_text, fact_key: e.fact_key }));
    expect(entriesSha256(reordered as JaRenderingEntry[])).toBe(entriesSha256(ENTRIES));
    expect(entriesSha256([...ENTRIES].reverse())).not.toBe(entriesSha256(ENTRIES));
  });

  it("schema, unsafe text, a duplicate or unknown key, the category, another shop: fixed codes", () => {
    const code = (o: unknown) => (stopOf(() => checkJaRenderings(bytesOf(o), FACTS, { mode: "draft" })) as { code?: string }).code ?? "ok";
    expect(code({ ...record(), extra: 1 })).toBe("JA_RENDERINGS_INVALID");
    expect(code(record({}, []))).toBe("JA_RENDERINGS_INVALID");
    for (const bad of ["<b>川辺</b>", "https://example.com の茶房", "改行\nあり", "見えない­ハイフン", " 前に空白", "x".repeat(301)]) expect(code(record({}, [{ ...ENTRIES[0]!, ja_text: bad }])), JSON.stringify(bad)).toMatch(/^JA_RENDERINGS_(TEXT_UNSAFE|INVALID)$/);
    expect(code(record({}, [ENTRIES[0]!, ENTRIES[0]!]))).toBe("JA_RENDERINGS_DUPLICATE_KEY");
    expect(code(record({}, [{ ...ENTRIES[0]!, fact_key: "access" }]))).toBe("JA_RENDERINGS_FACT_UNKNOWN");
    expect(code(record({}, [{ fact_key: "category", source_text: "cafe", ja_text: "喫茶" }]))).toBe("JA_RENDERINGS_INVALID");
    expect(code(record({ shop_id: "test-shop-other" }))).toBe("JA_RENDERINGS_SHOP_MISMATCH");
    expect(stopOf(() => checkJaRenderings(Buffer.alloc(64 * 1024 + 1, 0x20), FACTS, { mode: "draft" }))).toMatchObject({ code: "JA_RENDERINGS_TOO_LARGE" });
  });

  it("source_text must equal the facts pack's value exactly", () => {
    for (const source of [`${DESC} `, DESC.replace("river", "lake"), DESC.toUpperCase()]) expect(stopOf(() => checkJaRenderings(bytesOf(record({}, [{ ...ENTRIES[0]!, source_text: source }])), FACTS, { mode: "draft" }))).toMatchObject({ code: "JA_RENDERINGS_SOURCE_MISMATCH" });
  });

  it("gate needs the owner's confirmation bound to these entries; draft does not", () => {
    const draft = record({ owner_confirmation: undefined });
    expect(stopOf(() => checkJaRenderings(bytesOf(draft), FACTS, { mode: "gate" }))).toMatchObject({ code: "JA_RENDERINGS_NOT_OWNER_CONFIRMED" });
    expect(checkJaRenderings(bytesOf(draft), FACTS, { mode: "draft" }).owner_confirmed).toBe(false);
    // edited after the confirmation: the binding breaks
    const edited = record({}, ENTRIES);
    (edited.entries as JaRenderingEntry[])[0] = { ...ENTRIES[0]!, ja_text: "川辺の架空の茶房です。" };
    expect(stopOf(() => checkJaRenderings(bytesOf(edited), FACTS, { mode: "gate" }))).toMatchObject({ code: "JA_RENDERINGS_SHA_MISMATCH" });
    expect(checkJaRenderings(bytesOf(edited), FACTS, { mode: "draft" }).owner_confirmed).toBe(false);
  });
});

describe("a rendering never adds a fact (category, field and key reported; never the text)", () => {
  it("digits, money, years, history, people, awards, reputation, reservation or a Latin word the source lacks", () => {
    for (const [ja, category] of [
      ["川辺の小さな茶房です。3種類のお菓子があります。", "number"],
      ["川辺の茶房です。お菓子は500円です。", "number"],
      ["川辺の茶房です。お菓子は円で買えます。", "money_or_menu"],
      ["創業の歴史がある川辺の茶房です。", "history"],
      ["職人が作る季節のお菓子です。", "people"],
      ["受賞したお菓子を作っています。", "award_or_certification"],
      ["人気の川辺の茶房です。", "superlative_or_reputation"],
      ["予約できる川辺の茶房です。", "reservation_or_stock"],
      ["川辺の茶房 Kawasemi です。", "proper_noun"],
    ] as const) {
      expect(addedFactCategory(DESC, ja), ja).toBe(category);
      const s = stopOf(() => checkJaRenderings(bytesOf(record({}, [{ ...ENTRIES[0]!, ja_text: ja }])), FACTS, { mode: "draft" }));
      expect(s, ja).toEqual({ code: "JA_RENDERING_ADDS_FACT", detail: { category, field: "ja_text", fact_key: "description" } });
      expect(JSON.stringify(s)).not.toContain(ja);
    }
  });
  it("what the source holds may be rendered: its digits (with a unit), its words", () => {
    expect(addedFactCategory("Open since 1987.", "1987年から営業しています。")).toBeNull();
    expect(addedFactCategory("Open since 1987.", "1988年から営業しています。")).toBe("number");
    expect(addedFactCategory("Made by the Kawasemi family.", "Kawasemi の家族が作っています。")).toBeNull();
    expect(addedFactCategory(DESC, ENTRIES[0]!.ja_text)).toBeNull();
  });
  it("review M1: kanji numerals (a run, 十数, or one with a counter) are numbers unless the source holds the same", () => {
    const BAKERY = "A small bakery making sourdough bread every morning.";
    for (const ja of ["三十種類のパンを焼く小さな店です。", "二十席のある小さなパン屋です。", "十数種のパンを焼いています。", "午前七時に開店する小さなパン屋です。", "電話〇三ーの小さなパン屋です。", "三種のパンを焼いています。"]) expect(addedFactCategory(BAKERY, ja), ja).toBe("number");
    expect(addedFactCategory(BAKERY, "毎朝サワードウのパンを焼く小さなパン屋です。")).toBeNull();
    expect(addedFactCategory("三十種類のパン", "三十種類のパンがあります。")).toBeNull();
  });
  it("review M2: letters of another script are refused (script)", () => {
    for (const ja of ["Мария のパン屋です。", "ΑΒΓ パン屋です。", "빵집입니다。"]) {
      expect(addedFactCategory(DESC, ja), ja).toBe("script");
      expect(stopOf(() => checkJaRenderings(bytesOf(record({}, [{ ...ENTRIES[0]!, ja_text: ja }])), FACTS, { mode: "draft" }))).toEqual({ code: "JA_RENDERING_ADDS_FACT", detail: { category: "script", field: "ja_text", fact_key: "description" } });
    }
    expect(addedFactCategory(DESC, "川辺の茶房（カワセミ）です。々ー")).toBeNull();
  });
  it("review L2: Latin words are compared as whole words of the source", () => {
    expect(addedFactCategory("A sourdough bakery.", "sour なパン屋です。")).toBe("proper_noun");
    expect(addedFactCategory("Start early.", "art のある店です。")).toBe("proper_noun");
    expect(addedFactCategory("A sourdough bakery.", "sourdough のパン屋です。")).toBeNull();
    expect(addedFactCategory("A Sourdough bakery.", "SOURDOUGH のパン屋です。")).toBeNull();
  });
  it("the detail a refusal may print is allowlisted", () => {
    expect(jaRenderingDetailOf(new JaRenderingsStop("JA_RENDERING_ADDS_FACT", { category: "people", field: "ja_text", fact_key: "description" }))).toEqual({ category: "people", field: "ja_text", fact_key: "description" });
    expect(jaRenderingDetailOf(new JaRenderingsStop("JA_RENDERING_ADDS_FACT", { category: "free text", field: "ja_text", fact_key: "description" }))).toBeNull();
    expect(jaRenderingDetailOf(new JaRenderingsStop("JA_RENDERINGS_INVALID"))).toBeNull();
  });
});

describe("the checker CLI (offline; the record outside the repository)", () => {
  const files = (o: unknown) => {
    const d = tmp();
    writeFileSync(join(d, "ja-renderings.json"), bytesOf(o));
    writeFileSync(join(d, "facts-pack.json"), bytesOf(FACTS));
    return { file: join(d, "ja-renderings.json"), facts: join(d, "facts-pack.json") };
  };
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    try {
      const code = await jaRenderingsMain(argv);
      return { code, out: JSON.parse(out.join("")) as Record<string, unknown> };
    } finally {
      spy.mockRestore();
    }
  };
  it("gate passes and prints the SHA-256s and keys; draft skips the confirmation; a refusal names code and detail", async () => {
    const ok = files(record());
    expect(await run(["--check", ok.file, "--facts", ok.facts])).toMatchObject({ code: 0, out: { status: "passed", mode: "gate", entries_sha256: entriesSha256(ENTRIES), keys: ["description", "statement_1"], owner_confirmed: true } });
    const draft = files(record({ owner_confirmation: undefined }));
    expect((await run(["--check", draft.file, "--facts", draft.facts])).out).toMatchObject({ status: "stopped", code: "JA_RENDERINGS_NOT_OWNER_CONFIRMED" });
    expect(await run(["--check", draft.file, "--facts", draft.facts, "--draft"])).toMatchObject({ code: 0, out: { status: "passed", mode: "draft", owner_confirmed: false } });
    const adds = files(record({ owner_confirmation: undefined }, [{ ...ENTRIES[0]!, ja_text: "職人が作るお菓子です。" }]));
    const r = await run(["--check", adds.file, "--facts", adds.facts, "--draft"]);
    expect(r).toEqual({ code: 1, out: { status: "stopped", code: "JA_RENDERING_ADDS_FACT", detail: { category: "people", field: "ja_text", fact_key: "description" } } });
  });
  it("bad arguments and a record inside the repository are refused (exit 2)", async () => {
    expect((await run(["--check", "x"])).out).toMatchObject({ status: "refused", code: "ARGS_INVALID" });
    const inRepo = resolve(REPO, "package.json");
    expect(await run(["--check", inRepo, "--facts", inRepo])).toMatchObject({ code: 2, out: { code: "JA_RENDERINGS_RECORD_IN_REPO" } });
  });
});

describe("the copy audit accepts an approved rendering bound to its fact, and still refuses any other text", () => {
  const facts = factsPack(SHOP, [["name", "架空茶房 かわせみ"], ["category", "cafe"], ["description", DESC], ["hours", "10:00〜18:00"], ["address", "架空市架空町1-1"]]);
  const pack = JSON.parse(facts) as FactsPack;
  const jaBytes = bytesOf(record({}, [ENTRIES[0]!]));
  const JA = ENTRIES[0]!.ja_text;
  const rendering = (text: string, sources = [idOf(facts, "description")]): Item => ({ id: "desc-ja", text, claim_type: "approved_rendering" as unknown as Item["claim_type"], source_fact_ids: sources, owner_review_needed: false });
  const files = (desc: Item, extra: Item[] = []) =>
    shopFiles({
      facts,
      lane: "real_shop_proposal",
      items: [fact("name", "架空茶房 かわせみ", [idOf(facts, "name")]), desc, fact("hours", "10:00〜18:00", [idOf(facts, "hours")], "営業時間"), fact("address", "架空市架空町1-1", [idOf(facts, "address")], "住所"), ...extra],
      sections: [
        { id: "hero", blocks: [["h1", "name"]] },
        { id: "intro", blocks: [["p", "desc-ja"], ...extra.map((e) => ["p", e.id] as ["p", string])] },
        { id: "info", blocks: [["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] },
      ],
    });
  const baseCodes = (f: ReturnType<typeof files>, ja?: Buffer) => reviewCopyQuality({ factsPack: f.factsPack, copyRecord: f.copyRecord, pageHtml: f.pageHtml, pageCss: f.pageCss, ...(ja ? { jaRenderings: ja } : {}) }).base_checks.codes;

  it("checkCopyRecord: the approved ja_text of the fact's key passes; another text, another fact, two facts or no renderings do not", () => {
    const rec = (i: Item) => ({ schema: "comp_copy_v1", shop_id: SHOP, facts_sha256: sha(facts), lane: "real_shop_proposal", items: [i] });
    const o = { shopId: SHOP, factsSha256: sha(facts), facts: pack.facts, renderings: [{ fact_key: "description", ja_text: JA }] };
    expect(checkCopyRecord(rec(rendering(JA)), o)).toEqual({ ok: true, findings: [] });
    expect(checkCopyRecord(rec(rendering("川辺の茶房です。")), o).findings).toContainEqual({ code: "RENDERING_NOT_APPROVED", item: "desc-ja" });
    expect(checkCopyRecord(rec(rendering(JA, [idOf(facts, "hours")])), o).findings).toContainEqual({ code: "RENDERING_NOT_APPROVED", item: "desc-ja" });
    expect(checkCopyRecord(rec(rendering(JA, [idOf(facts, "description"), idOf(facts, "hours")])), o).findings).toContainEqual({ code: "RENDERING_WITHOUT_ONE_FACT", item: "desc-ja" });
    expect(checkCopyRecord(rec(rendering(JA)), { ...o, renderings: undefined }).findings).toContainEqual({ code: "RENDERING_NOT_APPROVED", item: "desc-ja" });
  });

  it("the audit: with the checked renderings the page passes its base checks; without them, or with another text, it fails", () => {
    expect(baseCodes(files(rendering(JA)), jaBytes)).toEqual([]);
    expect(baseCodes(files(rendering(JA)))).toContain("RENDERING_NOT_APPROVED");
    expect(baseCodes(files(rendering("川辺の小さな茶房です。")), jaBytes)).toContain("RENDERING_NOT_APPROVED");
    // an unconfirmed record is refused by the audit's gate check
    expect(baseCodes(files(rendering(JA)), bytesOf(record({ owner_confirmation: undefined }, [ENTRIES[0]!])))).toContain("JA_RENDERINGS_NOT_OWNER_CONFIRMED");
    // other non-fact text is refused as before (a proposal line on a real shop still needs the owner)
    const v = reviewCopyQuality({ ...files(rendering(JA), [proposal("extra", "季節を感じる時間をどうぞ。")]), jaRenderings: jaBytes });
    expect(v.base_checks.codes).toEqual([]);
    expect(v.unresolved).toContain("COPY_APPROVAL_MISSING");
    expect(v.sections.flatMap((s) => s.entries).find((e) => e.copy_item_id === "desc-ja")?.kind).toBe("fact");
  });

  it("the review binds the renderings' SHA-256: other renderings make it stale", () => {
    const f = files(rendering(JA));
    const withJa = { factsPack: f.factsPack, copyRecord: f.copyRecord, pageHtml: f.pageHtml, pageCss: f.pageCss, jaRenderings: jaBytes };
    const review = reviewCopyQuality(withJa);
    expect(review.ja_renderings_sha256).toBe(sha(jaBytes));
    expect(checkCopyQualityReview(review, withJa).ok).toBe(true);
    const other = bytesOf(record({ owner_confirmation: { confirmed: true, confirmed_at: "2026-11-25T04:00:00Z", entries_sha256: entriesSha256([ENTRIES[0]!]) } }, [ENTRIES[0]!]));
    expect(checkCopyQualityReview(review, { ...withJa, jaRenderings: other }).codes).toContain("REVIEW_STALE_JA_RENDERINGS");
    expect(checkCopyQualityReview(review, { factsPack: f.factsPack, copyRecord: f.copyRecord, pageHtml: f.pageHtml, pageCss: f.pageCss }).codes).toContain("REVIEW_STALE_JA_RENDERINGS");
  });
});

describe("review L5: comp-copy reads the renderings record as the checker does", () => {
  const codeOf = (f: () => unknown) => {
    try {
      f();
      return "ok";
    } catch (error) {
      return error instanceof CompCopyError ? error.code : String(error);
    }
  };
  it("outside the repository, a regular file, no link, within the size cap", async () => {
    const { symlinkSync } = await import("node:fs");
    const d = tmp();
    const file = join(d, "ja-renderings.json");
    writeFileSync(file, bytesOf(record()));
    expect(readRenderingsFile(file).equals(bytesOf(record()))).toBe(true);
    expect(codeOf(() => readRenderingsFile(resolve(REPO, "package.json")))).toBe("JA_RENDERINGS_RECORD_IN_REPO");
    symlinkSync(file, join(d, "link.json"));
    expect(codeOf(() => readRenderingsFile(join(d, "link.json")))).toBe("JA_RENDERINGS_RECORD_UNSAFE");
    writeFileSync(join(d, "big.json"), Buffer.alloc(64 * 1024 + 1, 0x20));
    expect(codeOf(() => readRenderingsFile(join(d, "big.json")))).toBe("JA_RENDERINGS_TOO_LARGE");
    expect(codeOf(() => readRenderingsFile(join(d, "absent.json")))).toBe("JA_RENDERINGS_RECORD_MISSING");
  });
});
